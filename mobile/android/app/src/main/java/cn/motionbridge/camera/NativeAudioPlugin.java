package cn.motionbridge.camera;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

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

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Camera-role-only offline Chinese recognition. Audio never leaves the phone;
 * JavaScript receives final text events and sends the small voice_text frame.
 */
@CapacitorPlugin(name = "NativeAudio", permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class NativeAudioPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16_000;
    private static final int CHANNEL = AudioFormat.CHANNEL_IN_MONO;
    private static final int ENCODING = AudioFormat.ENCODING_PCM_16BIT;
    private static final String MODEL_ASSET = "vosk-model-small-cn-0.22.complete.zip";
    private static final String MODEL_DIR_NAME = "vosk-model-small-cn-0.22";
    private static final String MODEL_MARKER = ".complete";
    private static final String COMMAND_GRAMMAR = "[\"体感\",\"体感 紧急停止\",\"体感 开始\",\"体感 停止\","
            + "\"体感 向上\",\"体感 向下\",\"体感 向左\",\"体感 向右\","
            + "\"体感 加速\",\"体感 刹车\",\"体感 攻击\",\"体感 闪避\","
            + "\"体感 确认\",\"体感 返回\",\"[unk]\"]";

    private final Object lock = new Object();
    private AudioRecord recorder;
    private Thread captureThread;
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
            int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING);
            if (minimum <= 0) {
                call.reject("手机不支持 16kHz 单声道 PCM16 录音");
                return;
            }
            try {
                File modelDirectory = prepareModel();
                model = new Model(modelDirectory.getAbsolutePath());
                recognizer = new Recognizer(model, SAMPLE_RATE, COMMAND_GRAMMAR);
                int bufferSize = Math.max(minimum * 2, 3_200);
                recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        SAMPLE_RATE, CHANNEL, ENCODING, bufferSize);
                if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                    throw new IllegalStateException("AudioRecord 初始化失败");
                }
                recorder.startRecording();
                running = true;
                captureThread = new Thread(() -> captureLoop(Math.max(minimum, 1_600)),
                        "MotionBridgeOfflineVoice");
                captureThread.start();
                call.resolve(formatResult());
            } catch (Exception error) {
                stopRecorder();
                call.reject("语音模型错误: " + safeMessage(error), error);
            }
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopRecorder();
        call.resolve();
    }

    private JSObject formatResult() {
        return new JSObject()
                .put("sampleRate", SAMPLE_RATE)
                .put("channels", 1)
                .put("format", "pcm16le")
                .put("source", "native_vosk")
                .put("recognizerReady", model != null && recognizer != null);
    }

    private void captureLoop(int requestedBufferSize) {
        byte[] buffer = new byte[requestedBufferSize - (requestedBufferSize % 2)];
        while (running) {
            AudioRecord activeRecorder = recorder;
            Recognizer activeRecognizer = recognizer;
            if (activeRecorder == null || activeRecognizer == null) break;
            int read = activeRecorder.read(buffer, 0, buffer.length, AudioRecord.READ_BLOCKING);
            if (read > 0) {
                if ((read & 1) == 1) read--;
                if (read <= 0) continue;
                try {
                    if (activeRecognizer.acceptWaveForm(buffer, read)) {
                        emitFinalText(activeRecognizer.getResult());
                    }
                } catch (Exception error) {
                    notifyListeners("audioError", new JSObject().put("message", "语音识别错误: " + safeMessage(error)));
                    running = false;
                    break;
                }
            } else if (read < 0) {
                notifyListeners("audioError", new JSObject().put("message", "AudioRecord 读取失败: " + read));
                running = false;
                break;
            }
        }
    }

    private void emitFinalText(String resultJson) {
        try {
            JSONObject result = new JSONObject(resultJson == null ? "{}" : resultJson);
            String text = result.optString("text", "").trim();
            if (text.isEmpty()) return;
            JSObject event = new JSObject().put("text", text).put("final", true);
            double confidence = result.optDouble("confidence", -1.0);
            if (confidence >= 0.0 && confidence <= 1.0) event.put("confidence", confidence);
            notifyListeners("voiceText", event);
        } catch (Exception error) {
            notifyListeners("audioError", new JSObject().put("message", "语音结果解析失败"));
        }
    }

    private void stopRecorder() {
        running = false;
        AudioRecord activeRecorder;
        Thread activeThread;
        synchronized (lock) {
            activeRecorder = recorder;
            recorder = null;
            activeThread = captureThread;
            captureThread = null;
            if (recognizer != null) {
                try { recognizer.close(); } catch (Exception ignored) { }
                recognizer = null;
            }
            if (model != null) {
                try { model.close(); } catch (Exception ignored) { }
                model = null;
            }
        }
        if (activeRecorder != null) {
            try { activeRecorder.stop(); } catch (IllegalStateException ignored) { }
            activeRecorder.release();
        }
        if (activeThread != null && activeThread != Thread.currentThread()) {
            try { activeThread.join(400); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }
    }

    private File prepareModel() throws IOException {
        File filesRoot = getContext().getFilesDir().getCanonicalFile();
        File modelDirectory = new File(filesRoot, MODEL_DIR_NAME).getCanonicalFile();
        String rootPath = filesRoot.getPath() + File.separator;
        if (!modelDirectory.getPath().startsWith(rootPath)) {
            throw new IOException("语音模型路径无效");
        }
        File marker = new File(modelDirectory, MODEL_MARKER);
        if (marker.isFile() && new File(modelDirectory, "am/final.mdl").isFile()
                && new File(modelDirectory, "conf/model.conf").isFile()) {
            return modelDirectory;
        }
        deleteTree(modelDirectory);
        if (!modelDirectory.mkdirs() && !modelDirectory.isDirectory()) {
            throw new IOException("无法创建语音模型目录");
        }
        try (InputStream asset = getContext().getAssets().open(MODEL_ASSET);
             ZipInputStream zip = new ZipInputStream(asset)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName().replace('\\', '/');
                String relative = name;
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
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                        throw new IOException("无法创建模型子目录");
                    }
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
        // This is only called for the exact app-private model directory.
        if (!target.delete()) target.deleteOnExit();
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }

    @Override
    protected void handleOnPause() {
        stopRecorder();
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        stopRecorder();
        super.handleOnDestroy();
    }
}
