package cn.motionbridge.camera;

import android.Manifest;
import android.content.pm.PackageManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * MotionControl 1.00 offline command recognition.  Vosk SpeechService owns
 * microphone capture and buffering; raw PCM is never handled by this plugin.
 * Only final text leaves the recognizer.
 */
@CapacitorPlugin(name = "NativeAudio", permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class NativeAudioPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16_000;
    private static final String MODEL_ASSET = "vosk-model-small-cn-0.22.complete.zip";
    private static final String MODEL_DIR_NAME = "vosk-model-small-cn-0.22";
    private static final String MODEL_MARKER = ".complete";
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

    @PluginMethod
    public void start(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("microphone", call, "startAfterPermission");
            return;
        }
        startRecognizer(call);
    }

    @PermissionCallback
    public void startAfterPermission(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("麦克风未授权");
            return;
        }
        startRecognizer(call);
    }

    private void startRecognizer(PluginCall call) {
        synchronized (lock) {
            if (running) {
                call.resolve(formatResult());
                return;
            }
            try {
                File modelDirectory = prepareModel();
                model = new Model(modelDirectory.getAbsolutePath());
                recognizer = new Recognizer(model, SAMPLE_RATE, COMMAND_GRAMMAR);
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
        call.resolve();
    }

    private JSObject formatResult() {
        return new JSObject()
                .put("sampleRate", SAMPLE_RATE)
                .put("channels", 1)
                .put("format", "pcm16le")
                .put("source", "native_vosk_speech_service_v100")
                .put("recognizerReady", running && model != null && recognizer != null && speechService != null)
                .put("audioReady", running && speechService != null);
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

    private File prepareModel() throws IOException {
        File filesRoot = getContext().getFilesDir().getCanonicalFile();
        File modelDirectory = new File(filesRoot, MODEL_DIR_NAME).getCanonicalFile();
        String rootPath = filesRoot.getPath() + File.separator;
        if (!modelDirectory.getPath().startsWith(rootPath)) throw new IOException("语音模型路径无效");
        File marker = new File(modelDirectory, MODEL_MARKER);
        if (marker.isFile() && new File(modelDirectory, "am/final.mdl").isFile()
                && new File(modelDirectory, "conf/model.conf").isFile()) return modelDirectory;

        deleteTree(modelDirectory);
        if (!modelDirectory.mkdirs() && !modelDirectory.isDirectory()) throw new IOException("无法创建语音模型目录");
        try (InputStream asset = getContext().getAssets().open(MODEL_ASSET);
             ZipInputStream zip = new ZipInputStream(asset)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String relative = entry.getName().replace('\\', '/');
                String rootPrefix = MODEL_DIR_NAME + "/";
                if (relative.equals(MODEL_DIR_NAME)) continue;
                if (relative.startsWith(rootPrefix)) relative = relative.substring(rootPrefix.length());
                if (relative.isEmpty()) continue;
                File output = new File(modelDirectory, relative).getCanonicalFile();
                if (!output.getPath().startsWith(rootPath + MODEL_DIR_NAME + File.separator)) {
                    throw new IOException("语音模型压缩包路径无效");
                }
                if (entry.isDirectory()) {
                    if (!output.mkdirs() && !output.isDirectory()) throw new IOException("无法创建模型目录");
                } else {
                    File parent = output.getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法创建模型子目录");
                    try (FileOutputStream file = new FileOutputStream(output)) {
                        byte[] buffer = new byte[8192];
                        int count;
                        while ((count = zip.read(buffer)) != -1) file.write(buffer, 0, count);
                    }
                }
                zip.closeEntry();
            }
        }
        if (!new File(modelDirectory, "am/final.mdl").isFile()
                || !new File(modelDirectory, "conf/model.conf").isFile()) {
            deleteTree(modelDirectory);
            throw new IOException("语音模型文件不完整");
        }
        if (!marker.createNewFile()) throw new IOException("无法写入模型完成标记");
        return modelDirectory;
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
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        stopRecognizer();
        super.handleOnDestroy();
    }
}
