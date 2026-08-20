package cn.motionbridge.camera;

import android.content.Context;
import android.media.Image;
import android.os.SystemClock;
import android.view.Surface;

import androidx.annotation.NonNull;
import androidx.camera.core.AspectRatio;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mediapipe.framework.image.MPImage;
import com.google.mediapipe.framework.image.MediaImageBuilder;
import com.google.mediapipe.tasks.components.containers.Landmark;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.core.Delegate;
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions;
import com.google.mediapipe.tasks.vision.core.RunningMode;
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker;
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * CameraX Preview + ImageAnalysis and the native MediaPipe Pose pipeline.
 * CameraX owns the lifecycle and display transform; ImageProxy supplies the
 * frame rotation used once by MediaPipe. Only landmarks cross the Capacitor bridge.
 */
final class NativeCameraRuntime {
    interface Listener {
        void onStarted(JSObject state);
        void onFrame(JSObject frame);
        void onError(String message);
    }

    private final Context context;
    private final PreviewView previewView;
    private final LifecycleOwner lifecycleOwner;
    private final Listener listener;
    private final ExecutorService cameraExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "MotionBridgeCameraX");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean inferenceBusy = new AtomicBoolean(false);

    private ProcessCameraProvider cameraProvider;
    private Camera camera;
    private Preview preview;
    private ImageAnalysis analysis;
    private PoseLandmarker poseLandmarker;
    private String cameraId = "back";
    private String facing = "back";
    private String modelGrade = "full";
    private volatile boolean inferenceEnabled;
    private volatile long generation;
    private long lastPoseTimestampMs;
    private long analyzedFrames;
    private long inferredFrames;
    private long fpsWindowStartedMs;
    private float captureFps;
    private float inferenceFps;

    NativeCameraRuntime(Context context, PreviewView previewView, LifecycleOwner lifecycleOwner, Listener listener) {
        this.context = context;
        this.previewView = previewView;
        this.lifecycleOwner = lifecycleOwner;
        this.listener = listener;
    }

    void start(String requestedCameraId, String requestedGrade, boolean enableInference) {
        stop();
        cameraId = "front".equals(requestedCameraId) ? "front" : "back";
        facing = cameraId;
        modelGrade = normalizeGrade(requestedGrade);
        inferenceEnabled = enableInference;
        final long startGeneration = ++generation;
        running.set(true);
        cameraExecutor.execute(() -> {
            try {
                if (inferenceEnabled) loadModels(modelGrade); else closeModels();
                ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(context);
                future.addListener(() -> {
                    try {
                        cameraProvider = future.get();
                        bindCamera(startGeneration);
                    } catch (Exception error) {
                        running.set(false);
                        listener.onError("CameraX 初始化失败: " + shortError(error));
                    }
                }, ContextCompat.getMainExecutor(context));
            } catch (Exception error) {
                running.set(false);
                listener.onError("原生识别模型加载失败: " + shortError(error));
            }
        });
    }

    void setModel(String grade) {
        final String next = normalizeGrade(grade);
        if (next.equals(modelGrade) && poseLandmarker != null) return;
        modelGrade = next;
        cameraExecutor.execute(() -> {
            try {
                if (inferenceEnabled) loadModels(next);
                JSObject state = new JSObject();
                state.put("actualModel", modelGrade);
                listener.onStarted(state);
            } catch (Exception error) {
                listener.onError("切换识别模型失败: " + shortError(error));
            }
        });
    }

    void enableInference(String grade) {
        inferenceEnabled = true;
        setModel(grade);
    }

    private String normalizeGrade(String value) {
        return Arrays.asList("lite", "full", "heavy").contains(value) ? value : "full";
    }

    private void loadModels(String grade) {
        closeModels();
        poseLandmarker = createPose(grade, Delegate.GPU);
    }

    private PoseLandmarker createPose(String grade, Delegate delegate) {
        try {
            BaseOptions base = BaseOptions.builder()
                    .setModelAssetPath("public/models/pose_landmarker_" + grade + ".task")
                    .setDelegate(delegate).build();
            return PoseLandmarker.createFromOptions(context,
                    PoseLandmarker.PoseLandmarkerOptions.builder().setBaseOptions(base)
                            .setRunningMode(RunningMode.VIDEO).setNumPoses(2)
                            .setMinPoseDetectionConfidence(.55f).setMinPosePresenceConfidence(.55f)
                            .setMinTrackingConfidence(.55f).build());
        } catch (Exception gpuError) {
            if (delegate == Delegate.CPU) throw gpuError;
            BaseOptions base = BaseOptions.builder()
                    .setModelAssetPath("public/models/pose_landmarker_" + grade + ".task")
                    .setDelegate(Delegate.CPU).build();
            return PoseLandmarker.createFromOptions(context,
                    PoseLandmarker.PoseLandmarkerOptions.builder().setBaseOptions(base)
                            .setRunningMode(RunningMode.VIDEO).setNumPoses(2)
                            .setMinPoseDetectionConfidence(.55f).setMinPosePresenceConfidence(.55f)
                            .setMinTrackingConfidence(.55f).build());
        }
    }

    private void bindCamera(long startGeneration) {
        if (!running.get() || startGeneration != generation || cameraProvider == null) return;
        try {
            CameraSelector selector = "front".equals(facing)
                    ? CameraSelector.DEFAULT_FRONT_CAMERA : CameraSelector.DEFAULT_BACK_CAMERA;
            if (!cameraProvider.hasCamera(selector)) {
                throw new IllegalStateException("没有可用的" + ("front".equals(facing) ? "前置" : "后置") + "镜头");
            }
            int targetRotation = displayRotation();
            preview = new Preview.Builder()
                    .setTargetAspectRatio(AspectRatio.RATIO_16_9)
                    .setTargetRotation(targetRotation)
                    .build();
            analysis = new ImageAnalysis.Builder()
                    .setTargetAspectRatio(AspectRatio.RATIO_16_9)
                    .setTargetRotation(targetRotation)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                    .build();
            previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
            previewView.setScaleType(PreviewView.ScaleType.FIT_CENTER);
            // PreviewView applies CameraX's standard front-camera display mirror.
            // ImageAnalysis and the coordinates sent to the PC remain unmirrored.
            previewView.setScaleX(1f);
            preview.setSurfaceProvider(previewView.getSurfaceProvider());
            analysis.setAnalyzer(cameraExecutor, image -> analyze(image, startGeneration));
            cameraProvider.unbindAll();
            camera = cameraProvider.bindToLifecycle(lifecycleOwner, selector, preview, analysis);
            analyzedFrames = 0;
            inferredFrames = 0;
            captureFps = 0f;
            inferenceFps = 0f;
            fpsWindowStartedMs = SystemClock.elapsedRealtime();
            lastPoseTimestampMs = 0;
            JSObject state = new JSObject();
            state.put("cameraId", cameraId);
            state.put("facing", facing);
            state.put("width", 0);
            state.put("height", 0);
            state.put("previewMirrored", "front".equals(facing));
            state.put("actualModel", modelGrade);
            state.put("previewWidth", 0);
            state.put("previewHeight", 0);
            state.put("inferenceWidth", 0);
            state.put("inferenceHeight", 0);
            state.put("rotationDegrees", 0);
            state.put("analysisProfile", "camerax");
            listener.onStarted(state);
        } catch (Exception error) {
            listener.onError("CameraX 捕获失败: " + shortError(error));
        }
    }

    private int displayRotation() {
        if (previewView.getDisplay() == null) return Surface.ROTATION_0;
        return previewView.getDisplay().getRotation();
    }

    private void analyze(ImageProxy imageProxy, long frameGeneration) {
        Image image = null;
        MPImage mpImage = null;
        try {
            if (!running.get() || frameGeneration != generation) return;
            image = imageProxy.getImage();
            if (image == null) return;
            analyzedFrames++;
            long now = SystemClock.elapsedRealtime();
            long span = now - fpsWindowStartedMs;
            if (span >= 1000) {
                captureFps = analyzedFrames * 1000f / span;
                inferenceFps = inferredFrames * 1000f / span;
                analyzedFrames = 0;
                inferredFrames = 0;
                fpsWindowStartedMs = now;
            }
            if (!inferenceEnabled || poseLandmarker == null || !inferenceBusy.compareAndSet(false, true)) return;
            long timestamp = imageProxy.getImageInfo().getTimestamp() > 0
                    ? imageProxy.getImageInfo().getTimestamp() / 1_000_000L
                    : SystemClock.uptimeMillis();
            if (timestamp <= lastPoseTimestampMs) timestamp = lastPoseTimestampMs + 1;
            lastPoseTimestampMs = timestamp;
            long started = SystemClock.elapsedRealtimeNanos();
            int rotation = imageProxy.getImageInfo().getRotationDegrees();
            mpImage = new MediaImageBuilder(image).build();
            ImageProcessingOptions processing = ImageProcessingOptions.builder()
                    .setRotationDegrees(rotation).build();
            PoseLandmarkerResult pose = poseLandmarker.detectForVideo(mpImage, processing, timestamp);
            float inferenceMs = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000f;
            inferredFrames++;
            int width = imageProxy.getWidth();
            int height = imageProxy.getHeight();
            boolean quarterTurn = rotation == 90 || rotation == 270;
            JSObject frame = new JSObject();
            frame.put("capturedAtMs", System.currentTimeMillis());
            frame.put("cameraId", cameraId);
            frame.put("facing", facing);
            frame.put("width", quarterTurn ? height : width);
            frame.put("height", quarterTurn ? width : height);
            frame.put("inferenceWidth", width);
            frame.put("inferenceHeight", height);
            frame.put("previewMirrored", "front".equals(facing));
            frame.put("coordinatesMirrored", false);
            frame.put("actualModel", modelGrade);
            frame.put("inferenceMs", inferenceMs);
            frame.put("captureFps", captureFps);
            frame.put("previewFps", captureFps);
            frame.put("inferenceFps", inferenceFps);
            frame.put("poseCount", pose.landmarks().size());
            frame.put("poses", encodePoses(pose));
            frame.put("hands", new JSArray());
            listener.onFrame(frame);
        } catch (Exception error) {
            listener.onError("原生姿态识别失败: " + shortError(error));
        } finally {
            inferenceBusy.set(false);
            imageProxy.close();
        }
    }

    private JSArray encodePoses(PoseLandmarkerResult result) {
        JSArray poses = new JSArray();
        for (int i = 0; i < result.landmarks().size(); i++) {
            JSObject item = new JSObject();
            item.put("detection_id", null);
            item.put("pose", encodeNormalized(result.landmarks().get(i)));
            item.put("world_pose", i < result.worldLandmarks().size()
                    ? encodeWorld(result.worldLandmarks().get(i)) : null);
            poses.put(item);
        }
        return poses;
    }

    private JSArray encodeNormalized(List<NormalizedLandmark> points) {
        JSArray output = new JSArray();
        for (NormalizedLandmark point : points) {
            JSObject value = new JSObject();
            value.put("x", point.x());
            value.put("y", point.y());
            value.put("z", point.z());
            value.put("visibility", point.visibility().orElse(1f));
            output.put(value);
        }
        return output;
    }

    private JSArray encodeWorld(List<Landmark> points) {
        JSArray output = new JSArray();
        for (Landmark point : points) {
            JSObject value = new JSObject();
            value.put("x", point.x());
            value.put("y", point.y());
            value.put("z", point.z());
            value.put("visibility", point.visibility().orElse(1f));
            output.put(value);
        }
        return output;
    }

    void stop() {
        running.set(false);
        generation++;
        cameraExecutor.execute(() -> closeModels());
        ContextCompat.getMainExecutor(context).execute(() -> {
            if (cameraProvider != null) cameraProvider.unbindAll();
            camera = null;
            preview = null;
            analysis = null;
            previewView.setScaleX(1f);
        });
    }

    private void closeModels() {
        if (poseLandmarker != null) {
            poseLandmarker.close();
            poseLandmarker = null;
        }
    }

    void destroy() {
        stop();
        cameraExecutor.shutdownNow();
    }

    private String shortError(Throwable error) {
        String message = error.getMessage();
        return error.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }
}
