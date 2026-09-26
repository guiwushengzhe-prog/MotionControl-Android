package cn.motioncontrol.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import com.getcapacitor.JSArray;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * MotionControl 1.00 audio bridge.  The default mode keeps the older Vosk
 * command recognizer; remote mode emits raw PCM chunks for computer recognition.
 */
@CapacitorPlugin(name = "NativeAudio", permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class NativeAudioPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16_000;
    private static final int REMOTE_CHUNK_BYTES = SAMPLE_RATE / 10 * 2;
    private static final String MODEL_DIR_NAME = "vosk-model-small-cn-0.22";
    // 这个模型以前是打进 APK 的：41.5 MB，整个安装包的一半，而那些文件跟配对的
    // 电脑上的逐字节一样。手机本来就必须有一台电脑才能用（识别出来的文字要发过
    // 去），所以第一次开语音时从电脑取，谁的流量都不用花，走的还是局域网。
    private static final String MANIFEST_ROUTE = "/api/model/voice-cn";
    private static final String FILE_ROUTE = "/api/model/voice-cn/file?path=";
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 30000;
    // The Chinese small model expects character-separated grammar tokens.  The
    // PC parser removes spaces before matching the configured wake word,
    // mappings and synonyms.
    private static final String COMMAND_GRAMMAR = "["
            + "\"体 感\",\"体 感 紧 急 停 止\","
            + "\"体 感 开 始 校 准\",\"体 感 校 准 头 控\",\"体 感 自 动 校 准\","
            + "\"体 感 开 始\",\"体 感 启 动\",\"体 感 继 续\","
            + "\"体 感 停 止\",\"体 感 暂 停\","
            + "\"体 感 上\",\"体 感 上 移\",\"体 感 向 上\",\"体 感 往 上\","
            + "\"体 感 下\",\"体 感 下 移\",\"体 感 向 下\",\"体 感 往 下\","
            + "\"体 感 左\",\"体 感 左 移\",\"体 感 向 左\",\"体 感 往 左\","
            + "\"体 感 右\",\"体 感 右 移\",\"体 感 向 右\",\"体 感 往 右\","
            + "\"体 感 加 速\",\"体 感 快 一 点\",\"体 感 刹 车\",\"体 感 减 速\","
            + "\"体 感 攻 击\",\"体 感 打 击\",\"体 感 闪 避\",\"体 感 躲 避\","
            + "\"体 感 确 认\",\"体 感 确 定\",\"体 感 返 回\",\"体 感 退 回\","
            + "\"体 感 地 图\",\"体 感 打 开 地 图\",\"体 感 显 示 地 图\","
            + "\"体 感 截 图\",\"体 感 记 录 场 景\",\"体 感 场 景 截 图\","
            + "\"体 感 重 新 匹 配\",\"体 感 重 新 适 配\",\"体 感 匹 配 场 景\","
            + "\"体 感 开 始 输 出\",\"体 感 开 启 输 出\",\"体 感 停 止 输 出\",\"体 感 关 闭 输 出\","
            + "\"体 感 设 置 中 心\",\"体 感 立 即 设 置 中 心\",\"[unk]\"]";

    private final Object lock = new Object();
    private SpeechService speechService;
    private Model model;
    private Recognizer recognizer;
    private volatile boolean running;
    private AudioRecord remoteAudioRecord;
    private Thread remoteAudioThread;
    private volatile boolean remoteRunning;

    @PluginMethod
    public void start(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("microphone", call, "startAfterPermission");
            return;
        }
        if (Boolean.TRUE.equals(call.getBoolean("remote", false))) {
            startRemoteAudio(call);
        } else {
            startRecognizer(call);
        }
    }

    @PermissionCallback
    public void startAfterPermission(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("麦克风未授权");
            return;
        }
        if (Boolean.TRUE.equals(call.getBoolean("remote", false))) {
            startRemoteAudio(call);
        } else {
            startRecognizer(call);
        }
    }

    private void startRemoteAudio(PluginCall call) {
        // 远程模式只把原始音频发给电脑，不准备手机语音模型。
        stopRecognizer();
        synchronized (lock) {
            if (remoteRunning) {
                call.resolve(formatResult());
                return;
            }
            int minimum = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) {
                call.reject("手机不支持 16kHz 单声道录音");
                return;
            }
            int bufferSize = Math.max(minimum, REMOTE_CHUNK_BYTES * 2);
            AudioRecord recorder = null;
            try {
                recorder = new AudioRecord(
                        MediaRecorder.AudioSource.DEFAULT,
                        SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                        bufferSize);
                if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                    throw new IOException("手机录音设备初始化失败");
                }
                recorder.startRecording();
                final AudioRecord activeRecorder = recorder;
                remoteAudioRecord = activeRecorder;
                remoteRunning = true;
                remoteAudioThread = new Thread(() -> captureRemoteAudio(activeRecorder), "remote-audio");
                remoteAudioThread.start();
                notifyVoiceState("listening", "远程语音采集已就绪");
                call.resolve(formatResult());
            } catch (Exception error) {
                if (recorder != null) {
                    try { recorder.release(); } catch (Exception ignored) { }
                }
                remoteAudioRecord = null;
                remoteRunning = false;
                call.reject("远程语音采集失败: " + safeMessage(error), error);
            }
        }
    }

    private void captureRemoteAudio(AudioRecord recorder) {
        byte[] chunk = new byte[REMOTE_CHUNK_BYTES];
        int filled = 0;
        try {
            while (remoteRunning && remoteAudioRecord == recorder) {
                int count = recorder.read(chunk, filled, chunk.length - filled);
                if (count < 0) {
                    throw new IOException("手机录音读取失败: " + count);
                }
                if (count == 0) {
                    continue;
                }
                filled += count;
                if (filled < chunk.length) {
                    continue;
                }
                JSObject event = new JSObject()
                        .put("audio_base64", Base64.encodeToString(chunk, Base64.NO_WRAP))
                        .put("sample_rate", SAMPLE_RATE)
                        .put("channels", 1)
                        .put("format", "pcm16le")
                        .put("captured_at_ms", System.currentTimeMillis());
                notifyListeners("audioChunk", event);
                filled = 0;
            }
        } catch (Exception error) {
            if (remoteRunning) {
                notifyListeners("audioError", new JSObject().put("message", "远程语音采集错误: " + safeMessage(error)));
            }
        } finally {
            stopRemoteAudio();
        }
    }

    private void startRecognizer(PluginCall call) {
        synchronized (lock) {
            if (running) {
                call.resolve(formatResult());
                return;
            }
        }
        // 准备模型要下载几十兆再落盘。插件方法跑在主线程上，在这里做就是 ANR
        // ——解压那版其实已经在卡主线程了，只是没人量过。Vosk 那几步仍然回到
        // 原来的线程做，不去动它的线程假设。
        final String baseUrl = call.getString("baseUrl", "");
        new Thread(() -> {
            final File modelDirectory;
            try {
                modelDirectory = prepareModel(baseUrl);
            } catch (Exception error) {
                notifyVoiceState("error", safeMessage(error));
                call.reject(safeMessage(error), error);
                return;
            }
            getActivity().runOnUiThread(() -> startWithModel(call, modelDirectory));
        }, "voice-model").start();
    }

    private void startWithModel(PluginCall call, File modelDirectory) {
        synchronized (lock) {
            if (running) {
                call.resolve(formatResult());
                return;
            }
            try {
                model = new Model(modelDirectory.getAbsolutePath());
                recognizer = new Recognizer(model, SAMPLE_RATE, grammarFrom(call.getArray("phrases", null)));
                speechService = new SpeechService(recognizer, SAMPLE_RATE);
                running = true;
                if (!speechService.startListening(new VoiceListener())) {
                    throw new IOException("语音服务已经在运行");
                }
                notifyVoiceState("listening", "Vosk 受限语法已就绪");
                call.resolve(formatResult());
            } catch (Exception error) {
                stopRecognizer();
                call.reject("语音模型错误: " + safeMessage(error), error);
            }
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopRecognizer();
        stopRemoteAudio();
        call.resolve();
    }

    /**
     * Build the constrained grammar from the phrase list the desktop sent.
     *
     * The desktop owns the list, so a phrase added there is heard here without
     * a new build; COMMAND_GRAMMAR stays as the fallback for the first run and
     * for a phone that connects before any config arrives.  Tokens are single
     * characters joined by spaces, matching what the small Chinese model wants
     * and what the desktop recognizer does with the very same list.
     */
    private static String grammarFrom(JSArray phrases) {
        if (phrases == null) {
            return COMMAND_GRAMMAR;
        }
        List<String> entries = new ArrayList<>();
        try {
            for (Object item : phrases.toList()) {
                String phrase = String.valueOf(item).replaceAll("\\s+", "");
                if (phrase.isEmpty()) {
                    continue;
                }
                StringBuilder spaced = new StringBuilder(phrase.length() * 2);
                for (int index = 0; index < phrase.length(); index++) {
                    if (spaced.length() > 0) {
                        spaced.append(' ');
                    }
                    spaced.append(phrase.charAt(index));
                }
                entries.add(JSONObject.quote(spaced.toString()));
            }
        } catch (org.json.JSONException error) {
            return COMMAND_GRAMMAR;
        }
        if (entries.isEmpty()) {
            return COMMAND_GRAMMAR;
        }
        entries.add(JSONObject.quote("[unk]"));
        return "[" + android.text.TextUtils.join(",", entries) + "]";
    }

    private JSObject formatResult() {
        return new JSObject()
                .put("sampleRate", SAMPLE_RATE)
                .put("channels", 1)
                .put("format", "pcm16le")
                .put("source", remoteRunning ? "android_audio_record_remote_v100" : "native_vosk_speech_service_v100")
                .put("recognizerReady", running && model != null && recognizer != null && speechService != null)
                .put("audioReady", remoteRunning || (running && speechService != null));
    }

    private final class VoiceListener implements RecognitionListener {
        @Override
        public void onPartialResult(String hypothesis) {
            // Partial hypotheses never become commands.
        }

        @Override
        public void onResult(String hypothesis) {
            emitFinalText(hypothesis);
        }

        @Override
        public void onFinalResult(String hypothesis) {
            emitFinalText(hypothesis);
        }

        @Override
        public void onError(Exception error) {
            running = false;
            notifyListeners("audioError", new JSObject().put("message", "语音识别错误: " + safeMessage(error)));
        }

        @Override
        public void onTimeout() {
            running = false;
            notifyListeners("audioError", new JSObject().put("message", "语音识别超时"));
        }
    }

    private void emitFinalText(String resultJson) {
        try {
            JSONObject result = new JSONObject(resultJson == null ? "{}" : resultJson);
            String text = result.optString("text", "").trim();
            if (text.isEmpty()) return;
            JSObject event = new JSObject()
                    .put("text", text)
                    .put("final", true)
                    .put("recognizer", "native_vosk_speech_service_v100")
                    .put("recognizedAtMs", System.currentTimeMillis());
            double confidence = result.optDouble("confidence", -1.0);
            if (confidence >= 0.0 && confidence <= 1.0) event.put("confidence", confidence);
            notifyListeners("voiceText", event);
            notifyVoiceState("command", "识别：" + text.replace(" ", ""));
        } catch (Exception error) {
            notifyListeners("audioError", new JSObject().put("message", "语音结果解析失败"));
        }
    }

    private void notifyVoiceState(String state, String message) {
        notifyListeners("voiceState", new JSObject().put("state", state).put("message", message));
    }

    /** Stop the official service before closing its recognizer and model. */
    private void stopRecognizer() {
        SpeechService activeService;
        Recognizer activeRecognizer;
        Model activeModel;
        running = false;
        synchronized (lock) {
            activeService = speechService;
            speechService = null;
            activeRecognizer = recognizer;
            recognizer = null;
            activeModel = model;
            model = null;
        }
        if (activeService != null) {
            try { activeService.stop(); } catch (Exception ignored) { }
            try { activeService.shutdown(); } catch (Exception ignored) { }
        }
        if (activeRecognizer != null) {
            try { activeRecognizer.close(); } catch (Exception ignored) { }
        }
        if (activeModel != null) {
            try { activeModel.close(); } catch (Exception ignored) { }
        }
    }

    private void stopRemoteAudio() {
        AudioRecord activeRecord;
        Thread activeThread;
        synchronized (lock) {
            remoteRunning = false;
            activeRecord = remoteAudioRecord;
            remoteAudioRecord = null;
            activeThread = remoteAudioThread;
            remoteAudioThread = null;
        }
        if (activeRecord != null) {
            try { activeRecord.stop(); } catch (Exception ignored) { }
            try { activeRecord.release(); } catch (Exception ignored) { }
        }
        if (activeThread != null && activeThread != Thread.currentThread()) {
            activeThread.interrupt();
            try { activeThread.join(250L); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        }
    }

    /**
     * The unpacked model directory, following whatever the PC is offering.
     *
     * <p>The manifest carries a digest of the whole listing, and that digest is
     * what the completion marker holds. So the question asked here is not "do I
     * have a model" but "do I have <em>this</em> model" -- the day the PC is
     * given a bigger or better one, the phone notices instead of quietly using
     * the copy it downloaded months ago.
     *
     * <p>The directory name comes from the manifest too, so switching models is
     * a change on the PC alone.
     */
    private File prepareModel(String baseUrl) throws IOException {
        File filesRoot = getContext().getFilesDir().getCanonicalFile();
        String rootPath = filesRoot.getPath() + File.separator;
        String base = baseUrl == null ? "" : baseUrl.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);

        if (base.isEmpty()) {
            // 防御性分支：打开语音本来就要求先连上电脑，所以正常走不到这里。
            File existing = new File(filesRoot, MODEL_DIR_NAME).getCanonicalFile();
            if (isUsableModel(existing)) return existing;
            throw new IOException("语音模型还没下载。先连上电脑，再打开语音控制。");
        }

        JSONObject manifest = ManifestSync.manifest(base, MANIFEST_ROUTE);
        if (!manifest.optBoolean("available", false)) {
            throw new IOException("电脑上没有中文语音模型。检查电脑端的 models/vosk-model-small-cn-0.22。");
        }
        String digest = manifest.optString("digest", "");
        File modelDirectory = new File(filesRoot, safeName(manifest.optString("name", MODEL_DIR_NAME)))
                .getCanonicalFile();
        if (!modelDirectory.getPath().startsWith(rootPath)) throw new IOException("语音模型路径无效");
        if (!digest.isEmpty() && digest.equals(ManifestSync.readMarker(modelDirectory))
                && isUsableModel(modelDirectory)) {
            return modelDirectory;
        }

        if (!modelDirectory.mkdirs() && !modelDirectory.isDirectory()) {
            throw new IOException("无法创建语音模型目录");
        }
        ManifestSync.clearMarker(modelDirectory);   // 换模型中途被打断，残局不能看着像下好了
        final long[] seen = {0L, 0L};
        String settled = ManifestSync.sync(manifest, modelDirectory,
                modelDirectory.getPath() + File.separator, base, FILE_ROUTE,
                (done, total) -> {
                    seen[0] = done; seen[1] = total;
                    notifyVoiceState("connecting", progressText(done, total));
                });
        if (!isUsableModel(modelDirectory)) {
            deleteTree(modelDirectory);
            throw new IOException("语音模型文件不完整");
        }
        ManifestSync.writeMarker(modelDirectory, settled);
        return modelDirectory;
    }

    private static boolean isUsableModel(File directory) {
        return new File(directory, "am/final.mdl").isFile()
                && new File(directory, "conf/model.conf").isFile();
    }

    /** 模型名字是电脑给的，所以它只能是一个名字，不能是一条路径。 */
    private static String safeName(String name) throws IOException {
        String value = name == null ? "" : name.trim();
        if (!value.matches("[A-Za-z0-9._-]{1,80}") || value.contains("..")) {
            throw new IOException("语音模型名字无效：" + value);
        }
        return value;
    }

    private String progressText(long done, long total) {
        return String.format(Locale.US, "正在从电脑下载语音模型 %d%%（%.0f/%.0f MB）",
                Math.min(100L, done * 100 / total), done / 1048576.0, total / 1048576.0);
    }

    private static void deleteTree(File target) {
        if (!target.exists()) return;
        File[] children = target.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        if (!target.delete()) target.deleteOnExit();
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }

    @Override
    protected void handleOnPause() {
        stopRecognizer();
        stopRemoteAudio();
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        stopRecognizer();
        stopRemoteAudio();
        super.handleOnDestroy();
    }
}
