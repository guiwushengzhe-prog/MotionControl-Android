package cn.motionbridge.camera;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Process;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * v0.9.4: Fully local phone speech recognition — single-stage full-phrase KWS.
 *
 * AudioRecord -> sherpa KWS ("体感截图"/"体感加速"/...) -> JS voiceCommand.
 * Raw PCM never leaves the phone. No wake window, no second-stage ASR, no VAD.
 */
@CapacitorPlugin(name = "NativeAudio", permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class NativeAudioPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16_000;
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private static final int FRAME_SAMPLES = 1_600; // 100 ms
    private static final int QUEUE_FRAMES = 12;

    private final Object lock = new Object();
    private final ArrayBlockingQueue<short[]> queue = new ArrayBlockingQueue<>(QUEUE_FRAMES);
    private volatile boolean running;
    private AudioRecord recorder;
    private Thread captureThread;
    private Thread processingThread;
    private LocalVoiceEngine engine;

    @PluginMethod
    public void start(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("microphone", call, "startAfterPermission");
            return;
        }
        startLocalRecognition(call);
    }

    @PermissionCallback
    public void startAfterPermission(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("麦克风未授权");
            return;
        }
        startLocalRecognition(call);
    }

    private void startLocalRecognition(PluginCall call) {
        synchronized (lock) {
            if (running && recorder != null && engine != null) {
                call.resolve(formatResult());
                return;
            }
            try {
                engine = new LocalVoiceEngine(getContext().getAssets());
                int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT);
                if (minimum <= 0) throw new IllegalStateException("麦克风缓冲区不可用");
                int bufferBytes = Math.max(minimum * 2, FRAME_SAMPLES * 2 * 4);
                recorder = new AudioRecord(
                        MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT, bufferBytes
                );
                if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                    throw new IllegalStateException("AudioRecord 初始化失败");
                }
                queue.clear();
                running = true;
                recorder.startRecording();
                processingThread = new Thread(this::processingLoop, "motionbridge-local-voice");
                captureThread = new Thread(this::captureLoop, "motionbridge-audio-capture");
                processingThread.start();
                captureThread.start();
                notifyVoiceState("listening", "语音识别已就绪");
                call.resolve(formatResult());
            } catch (Throwable error) {
                stopCapture();
                call.reject("手机本地语音启动失败: " + safeMessage(error), error instanceof Exception ? (Exception) error : null);
            }
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopCapture();
        call.resolve();
    }

    private JSObject formatResult() {
        return new JSObject()
                .put("sampleRate", SAMPLE_RATE)
                .put("channels", 1)
                .put("format", "pcm16le")
                .put("source", "sherpa-phrase-kws-v094")
                .put("recognizerReady", running && recorder != null && engine != null)
                .put("audioReady", running && recorder != null);
    }

    private void captureLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        short[] buffer = new short[FRAME_SAMPLES];
        while (running) {
            AudioRecord active = recorder;
            if (active == null) break;
            int count;
            try {
                count = active.read(buffer, 0, buffer.length, AudioRecord.READ_BLOCKING);
            } catch (Throwable error) {
                if (running) notifyAudioError("麦克风读取失败: " + safeMessage(error));
                break;
            }
            if (count <= 0) {
                if ((count == AudioRecord.ERROR_DEAD_OBJECT || count == AudioRecord.ERROR_INVALID_OPERATION) && running) {
                    notifyAudioError("麦克风读取中断: " + count);
                    break;
                }
                continue;
            }
            short[] frame = count == buffer.length ? Arrays.copyOf(buffer, buffer.length) : Arrays.copyOf(buffer, count);
            if (!queue.offer(frame)) {
                queue.poll();
                queue.offer(frame);
            }
        }
    }

    private void processingLoop() {
        LocalVoiceEngine local = engine;
        if (local == null) return;
        while (running || !queue.isEmpty()) {
            try {
                short[] frame = queue.poll(200, TimeUnit.MILLISECONDS);
                if (frame == null) continue;
                LocalVoiceEngine.EngineEvent event = local.acceptFrame(frame);
                if (event == null) continue;
                if ("command".equals(event.getKind())) {
                    String phrase = event.getPhrase();
                    String commandId = event.getCommandId();
                    String label = event.getLabel();
                    JSObject payload = new JSObject()
                            .put("commandId", commandId)
                            .put("phrase", phrase)
                            .put("label", label)
                            .put("recognizer", "sherpa-phrase-kws-v094")
                            .put("recognizedAtMs", System.currentTimeMillis());
                    notifyListeners("voiceCommand", payload);
                    notifyVoiceState("command", "识别：" + (label.isEmpty() ? phrase : label));
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                break;
            } catch (Throwable error) {
                if (running) notifyAudioError("本地语音识别失败: " + safeMessage(error));
                queue.clear();
            }
        }
    }

    private void notifyVoiceState(String state, String message) {
        notifyListeners("voiceState", new JSObject().put("state", state).put("message", message));
    }

    private void notifyAudioError(String message) {
        notifyListeners("audioError", new JSObject().put("message", message));
    }

    private void stopCapture() {
        AudioRecord active;
        Thread capture;
        Thread processing;
        LocalVoiceEngine local;
        synchronized (lock) {
            running = false;
            active = recorder;
            recorder = null;
            capture = captureThread;
            captureThread = null;
            processing = processingThread;
            processingThread = null;
            local = engine;
            engine = null;
        }
        if (active != null) {
            try { active.stop(); } catch (Throwable ignored) { }
            try { active.release(); } catch (Throwable ignored) { }
        }
        if (capture != null && capture != Thread.currentThread()) {
            try { capture.join(1000); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        }
        if (processing != null && processing != Thread.currentThread()) {
            try { processing.join(5000); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        }
        queue.clear();
        if (local != null && (processing == null || !processing.isAlive())) {
            try { local.release(); } catch (Throwable ignored) { }
        }
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }

    @Override
    protected void handleOnPause() {
        stopCapture();
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        stopCapture();
        super.handleOnDestroy();
    }
}
