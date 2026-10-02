package cn.motioncontrol.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

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
    // 这个模型以前是打进 APK 的：41.5 MB，整个安装包的一半，而那些文件跟连着的
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
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final NativeSessionGate sessions = new NativeSessionGate();
    private final ExecutorService modelWorker = Executors.newSingleThreadExecutor(command -> new Thread(command, "voice-model"));
    private final ExecutorService cleanupWorker = Executors.newSingleThreadExecutor(command -> new Thread(command, "voice-cleanup"));
    private AudioStart pendingStart;
    private long activeGeneration;
    private SpeechService speechService;
    private Model model;
    private Recognizer recognizer;
    private volatile boolean running;
    private volatile AudioRecord remoteAudioRecord;
    private Thread remoteAudioThread;
    private volatile boolean remoteRunning;

    private static final class AudioStart {
        final PluginCall call;
        final long generation;
        final boolean remote;
        final AtomicBoolean settled = new AtomicBoolean();
        volatile Future<?> task;
        boolean awaitingPermission;
        boolean permissionReady;

        AudioStart(PluginCall call, long generation) {
            this.call = call;
            this.generation = generation;
            this.remote = Boolean.TRUE.equals(call.getBoolean("remote", false));
        }

        void cancel() {
            if (task != null) task.cancel(true);
            if (settled.compareAndSet(false, true)) call.reject("语音启动已取消", "START_CANCELLED");
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        ui.post(() -> beginStart(call));
    }

    private void beginStart(PluginCall call) {
        boolean remote = Boolean.TRUE.equals(call.getBoolean("remote", false));
        synchronized (lock) {
            if ((remote && remoteRunning) || (!remote && running)) {
                call.resolve(formatResult());
                return;
            }
        }
        cancelStart();
        stopRecognizer();
        stopRemoteAudio();
        AudioStart start = new AudioStart(call, sessions.begin());
        synchronized (lock) { pendingStart = start; }
        if (!isCurrent(start)) {
            cancelStart();
            return;
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            start.awaitingPermission = true;
            requestPermissionForAlias("microphone", call, "startAfterPermission");
            return;
        }
        continueStart(start);
    }

    @PermissionCallback
    public void startAfterPermission(PluginCall call) {
        ui.post(() -> {
            AudioStart start;
            synchronized (lock) { start = pendingStart; }
            if (call == null || start == null || start.call != call || !sessions.isGeneration(start.generation)) return;
            start.awaitingPermission = false;
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                rejectStart(start, "麦克风未授权", "MICROPHONE_DENIED", null);
                return;
            }
            start.permissionReady = true;
            continueStart(start);
        });
    }

    private void continueStart(AudioStart start) {
        if (!isCurrent(start)) return;
        start.permissionReady = false;
        // Wait asynchronously for the previous microphone owner to release it.
        queueCleanup(() -> ui.post(() -> {
            if (!isCurrent(start)) return;
            if (start.remote) startRemoteAudio(start);
            else startRecognizer(start);
        }));
    }

    private boolean isCurrent(AudioStart start) {
        synchronized (lock) { return pendingStart == start && sessions.isCurrent(start.generation); }
    }

    private void cancelStart() {
        AudioStart previous;
        synchronized (lock) { previous = pendingStart; pendingStart = null; }
        if (previous != null) previous.cancel();
    }

    private void resolveStart(AudioStart start) {
        synchronized (lock) { if (pendingStart == start) pendingStart = null; }
        if (start.settled.compareAndSet(false, true)) start.call.resolve(formatResult());
    }

    private void rejectStart(AudioStart start, String message, String code, Exception error) {
        synchronized (lock) { if (pendingStart == start) pendingStart = null; }
        if (start.settled.compareAndSet(false, true)) start.call.reject(message, code, error);
    }

    private void startRemoteAudio(AudioStart start) {
        // 远程模式只把原始音频发给电脑，不准备手机语音模型。
        stopRecognizer();
        synchronized (lock) {
            if (remoteRunning) {
                resolveStart(start);
                return;
            }
            int minimum = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) {
                rejectStart(start, "手机不支持 16kHz 单声道录音", "AUDIO_UNSUPPORTED", null);
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
                activeGeneration = start.generation;
                remoteAudioThread = new Thread(() -> captureRemoteAudio(activeRecorder, start.generation), "remote-audio");
                remoteAudioThread.start();
                notifyVoiceState("listening", "远程语音采集已就绪");
                resolveStart(start);
            } catch (Exception error) {
                if (recorder != null) {
                    try { recorder.release(); } catch (Exception ignored) { }
                }
                remoteAudioRecord = null;
                remoteRunning = false;
                rejectStart(start, "远程语音采集失败: " + safeMessage(error), "AUDIO_START_FAILED", error);
            }
        }
    }

    private void captureRemoteAudio(AudioRecord recorder, long generation) {
        byte[] chunk = new byte[REMOTE_CHUNK_BYTES];
        int filled = 0;
        try {
            while (remoteRunning && remoteAudioRecord == recorder && sessions.isCurrent(generation)) {
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
                if (remoteAudioRecord != recorder || !sessions.isCurrent(generation)) break;
                JSObject event = new JSObject()
                        .put("audio_base64", Base64.encodeToString(chunk, Base64.NO_WRAP))
                        .put("sample_rate", SAMPLE_RATE)
                        .put("channels", 1)
                        .put("format", "pcm16le")
                        .put("captured_at_ms", System.currentTimeMillis());
                ui.post(() -> {
                    if (remoteRunning && remoteAudioRecord == recorder && sessions.isCurrent(generation)) {
                        notifyListeners("audioChunk", event);
                    }
                });
                filled = 0;
            }
        } catch (Exception error) {
            if (remoteRunning && remoteAudioRecord == recorder && sessions.isCurrent(generation)) {
                ui.post(() -> {
                    if (activeGeneration == generation && sessions.isCurrent(generation)) {
                        notifyListeners("audioError", new JSObject().put("message", "远程语音采集错误: " + safeMessage(error)));
                    }
                });
            }
        } finally {
            // A delayed old reader must never stop a replacement recorder.
            stopRemoteAudio(recorder);
        }
    }

    private void startRecognizer(AudioStart start) {
        stopRemoteAudio();
        final String baseUrl = start.call.getString("baseUrl", "");
        final String tokens = grammarFromTokens(start.call.getArray("grammar", null));
        final String grammar = tokens != null ? tokens : grammarFrom(start.call.getArray("phrases", null));
        start.task = modelWorker.submit(() -> {
            Model loadedModel = null;
            Recognizer loadedRecognizer = null;
            boolean handedOff = false;
            try {
                File modelDirectory = prepareModel(baseUrl, start);
                if (!isCurrent(start)) return;
                loadedModel = new Model(modelDirectory.getAbsolutePath());
                if (!isCurrent(start)) return;
                loadedRecognizer = new Recognizer(loadedModel, SAMPLE_RATE, grammar);
                if (!isCurrent(start)) return;
                final Model readyModel = loadedModel;
                final Recognizer readyRecognizer = loadedRecognizer;
                handedOff = true;
                ui.post(() -> startWithModel(start, readyModel, readyRecognizer));
            } catch (Exception error) {
                ui.post(() -> {
                    if (!isCurrent(start)) return;
                    notifyVoiceState("error", safeMessage(error));
                    rejectStart(start, safeMessage(error), "VOICE_MODEL_FAILED", error);
                });
            } catch (LinkageError error) {
                IOException failure = new IOException("手机语音库无法加载: " + safeMessage(error), error);
                ui.post(() -> {
                    if (!isCurrent(start)) return;
                    notifyVoiceState("error", failure.getMessage());
                    rejectStart(start, failure.getMessage(), "VOICE_LIBRARY_UNAVAILABLE", failure);
                });
            } finally {
                if (!handedOff) closeModel(loadedRecognizer, loadedModel);
            }
        });
    }

    private void startWithModel(AudioStart start, Model loadedModel, Recognizer loadedRecognizer) {
        if (!isCurrent(start)) {
            queueCleanup(() -> closeModel(loadedRecognizer, loadedModel));
            return;
        }
        boolean installed = false;
        synchronized (lock) {
            try {
                // Keep SpeechService's creation and start on the UI thread; the
                // expensive model/recognizer loading is already complete.
                speechService = new SpeechService(loadedRecognizer, SAMPLE_RATE);
                model = loadedModel;
                recognizer = loadedRecognizer;
                installed = true;
                activeGeneration = start.generation;
                running = true;
                if (!speechService.startListening(new VoiceListener(start.generation))) {
                    throw new IOException("语音服务已经在运行");
                }
                notifyVoiceState("listening", "Vosk 受限语法已就绪");
                resolveStart(start);
            } catch (Exception error) {
                stopRecognizer();
                if (!installed) queueCleanup(() -> closeModel(loadedRecognizer, loadedModel));
                rejectStart(start, "语音模型错误: " + safeMessage(error), "VOICE_START_FAILED", error);
            }
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ui.post(() -> {
            sessions.cancel();
            cancelStart();
            stopRecognizer();
            stopRemoteAudio();
            call.resolve();
        });
    }

    /**
     * Build the constrained grammar from the phrase list the desktop sent.
     *
     * The desktop owns the list, so a phrase added there is heard here without
     * a new build; COMMAND_GRAMMAR stays as the fallback for the first run and
     * for a phone that connects before any config arrives.  Tokens are single
     * characters joined by spaces, which is what the small Chinese model wants
     * for most phrases.  A desktop that sends the ready-split grammar is used
     * through grammarFromTokens instead; this stays for older desktops.
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

    /**
     * 电脑已经按模型词表拆好的 grammar，照原样用，不再逐字拆。
     *
     * 小模型的词表里单字不全：「堡」只在「城堡」里。逐字拆成「城 堡」，那个字会被
     * Vosk 悄悄丢掉，这句口令电脑听得到、手机永远听不到。电脑手上有同一个模型，
     * 拆好了发过来，两边就是同一份。没有这份（电脑是旧版）时返回 null，退回 grammarFrom。
     */
    private static String grammarFromTokens(JSArray grammar) {
        if (grammar == null) {
            return null;
        }
        List<String> entries = new ArrayList<>();
        try {
            for (Object item : grammar.toList()) {
                String entry = String.valueOf(item).trim().replaceAll("\\s+", " ");
                if (!entry.isEmpty()) {
                    entries.add(JSONObject.quote(entry));
                }
            }
        } catch (org.json.JSONException error) {
            return null;
        }
        if (entries.isEmpty()) {
            return null;
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
        private final long generation;

        VoiceListener(long generation) { this.generation = generation; }

        private boolean current() {
            synchronized (lock) { return running && activeGeneration == generation && sessions.isCurrent(generation); }
        }
        @Override
        public void onPartialResult(String hypothesis) {
            // Partial hypotheses never become commands.
        }

        @Override
        public void onResult(String hypothesis) {
            if (current()) emitFinalText(hypothesis);
        }

        @Override
        public void onFinalResult(String hypothesis) {
            if (current()) emitFinalText(hypothesis);
        }

        @Override
        public void onError(Exception error) {
            if (!current()) return;
            stopRecognizer();
            notifyListeners("audioError", new JSObject().put("message", "语音识别错误: " + safeMessage(error)));
        }

        @Override
        public void onTimeout() {
            if (!current()) return;
            stopRecognizer();
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
        synchronized (lock) {
            running = false;
            activeService = speechService;
            speechService = null;
            activeRecognizer = recognizer;
            recognizer = null;
            activeModel = model;
            model = null;
        }
        if (activeService != null || activeRecognizer != null || activeModel != null) queueCleanup(() -> {
            if (activeService != null) {
                try { activeService.stop(); } catch (Exception ignored) { }
                try { activeService.shutdown(); } catch (Exception ignored) { }
            }
            closeModel(activeRecognizer, activeModel);
        });
    }

    private static void closeModel(Recognizer activeRecognizer, Model activeModel) {
        if (activeRecognizer != null) try { activeRecognizer.close(); } catch (Exception | LinkageError ignored) { }
        if (activeModel != null) try { activeModel.close(); } catch (Exception | LinkageError ignored) { }
    }

    private void queueCleanup(Runnable task) {
        try { cleanupWorker.execute(task); }
        catch (RejectedExecutionException error) {
            // A model may finish loading just after activity destruction.
            new Thread(task, "voice-final-cleanup").start();
        }
    }

    private void stopRemoteAudio() {
        stopRemoteAudio(null);
    }

    private void stopRemoteAudio(AudioRecord expected) {
        AudioRecord activeRecord;
        Thread activeThread;
        synchronized (lock) {
            if (expected != null && remoteAudioRecord != expected) return;
            remoteRunning = false;
            activeRecord = remoteAudioRecord;
            remoteAudioRecord = null;
            activeThread = remoteAudioThread;
            remoteAudioThread = null;
            // Enqueue release before another start can enqueue its microphone
            // barrier. The reader's finally block also runs off the UI thread.
            if (activeRecord != null) queueCleanup(() -> {
                try { activeRecord.stop(); } catch (Exception ignored) { }
                try { activeRecord.release(); } catch (Exception ignored) { }
            });
        }
        if (activeThread != null && activeThread != Thread.currentThread()) activeThread.interrupt();
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
    private File prepareModel(String baseUrl, AudioStart start) throws IOException {
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

        JSONObject manifest = ManifestSync.manifest(base, MANIFEST_ROUTE, () -> !isCurrent(start));
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
        String settled = ManifestSync.sync(manifest, modelDirectory,
                modelDirectory.getPath() + File.separator, base, FILE_ROUTE,
                (done, total) -> {
                    ui.post(() -> {
                        if (isCurrent(start)) notifyVoiceState("connecting", progressText(done, total));
                    });
                }, () -> !isCurrent(start));
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

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }

    @Override
    protected void handleOnPause() {
        AudioStart start;
        synchronized (lock) { start = pendingStart; }
        if (start != null && start.awaitingPermission) sessions.suspend();
        else {
            sessions.pause();
            cancelStart();
        }
        stopRecognizer();
        stopRemoteAudio();
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        sessions.resume();
        AudioStart start;
        synchronized (lock) { start = pendingStart; }
        if (start != null && start.permissionReady) continueStart(start);
        super.handleOnResume();
    }

    @Override
    protected void handleOnStop() {
        sessions.pause();
        cancelStart();
        stopRecognizer();
        stopRemoteAudio();
        super.handleOnStop();
    }

    @Override
    protected void handleOnDestroy() {
        sessions.destroy();
        cancelStart();
        stopRecognizer();
        stopRemoteAudio();
        modelWorker.shutdownNow();
        cleanupWorker.shutdown();
        super.handleOnDestroy();
    }
}
