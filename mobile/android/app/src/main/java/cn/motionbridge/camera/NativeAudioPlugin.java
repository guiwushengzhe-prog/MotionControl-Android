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

import android.util.Base64;

/** Captures native 16 kHz mono PCM16LE so WebView resampling is only a fallback. */
@CapacitorPlugin(name = "NativeAudio", permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class NativeAudioPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16_000;
    private static final int CHANNEL = AudioFormat.CHANNEL_IN_MONO;
    private static final int ENCODING = AudioFormat.ENCODING_PCM_16BIT;
    private final Object lock = new Object();
    private AudioRecord recorder;
    private Thread captureThread;
    private volatile boolean running;

    @PluginMethod
    public void start(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("microphone", call, "startAfterPermission");
            return;
        }
        startRecorder(call);
    }

    @PermissionCallback
    public void startAfterPermission(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("麦克风未授权");
            return;
        }
        startRecorder(call);
    }

    private void startRecorder(PluginCall call) {
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
            int bufferSize = Math.max(minimum * 2, 3_200);
            try {
                recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE, CHANNEL, ENCODING, bufferSize);
                if (recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("AudioRecord 初始化失败");
                recorder.startRecording();
                running = true;
                captureThread = new Thread(() -> captureLoop(Math.max(minimum, 1_600)), "MotionBridgeAudioRecord");
                captureThread.start();
                call.resolve(formatResult());
            } catch (Exception error) {
                stopRecorder();
                call.reject("原生麦克风启动失败: " + error.getMessage(), error);
            }
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopRecorder();
        call.resolve();
    }

    private JSObject formatResult() {
        return new JSObject().put("sampleRate", SAMPLE_RATE).put("channels", 1).put("format", "pcm16le").put("source", "native_audiorecord");
    }

    private void captureLoop(int bufferSize) {
        byte[] buffer = new byte[bufferSize - (bufferSize % 2)];
        while (running) {
            AudioRecord active = recorder;
            if (active == null) break;
            int read = active.read(buffer, 0, buffer.length, AudioRecord.READ_BLOCKING);
            if (read > 0) {
                if ((read & 1) == 1) read--;
                if (read <= 0) continue;
                double sum = 0.0;
                for (int index = 0; index < read; index += 2) {
                    short sample = (short) ((buffer[index] & 0xff) | (buffer[index + 1] << 8));
                    sum += (double) sample * sample;
                }
                double rms = Math.sqrt(sum / (read / 2.0));
                String pcm = Base64.encodeToString(java.util.Arrays.copyOf(buffer, read), Base64.NO_WRAP);
                notifyListeners("audioData", new JSObject().put("pcm", pcm).put("byteLength", read).put("rms", rms));
            } else if (read < 0) {
                notifyListeners("audioError", new JSObject().put("message", "AudioRecord 读取失败: " + read));
                break;
            }
        }
    }

    private void stopRecorder() {
        running = false;
        AudioRecord active;
        Thread thread;
        synchronized (lock) {
            active = recorder;
            recorder = null;
            thread = captureThread;
            captureThread = null;
        }
        if (active != null) {
            try { active.stop(); } catch (IllegalStateException ignored) {}
            active.release();
        }
        if (thread != null && thread != Thread.currentThread()) {
            try { thread.join(400); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }
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
