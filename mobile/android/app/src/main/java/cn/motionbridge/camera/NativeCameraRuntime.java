package cn.motionbridge.camera;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;
import android.util.Range;
import android.view.Surface;
import android.view.WindowManager;

import androidx.annotation.NonNull;
import androidx.camera.viewfinder.core.ImplementationMode;
import androidx.camera.viewfinder.core.TransformationInfo;
import androidx.camera.viewfinder.core.ViewfinderSurfaceRequest;
import androidx.camera.viewfinder.core.ViewfinderSurfaceSession;
import androidx.camera.viewfinder.core.camera2.Camera2TransformationInfo;
import androidx.camera.viewfinder.view.ViewfinderView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.google.mediapipe.framework.image.MPImage;
import com.google.mediapipe.framework.image.BitmapImageBuilder;
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
import java.util.concurrent.atomic.AtomicBoolean;

/** Camera2 YUV capture and MediaPipe inference. Only landmarks cross the Capacitor bridge. */
final class NativeCameraRuntime {
    interface Listener {
        void onStarted(JSObject state);
        void onFrame(JSObject frame);
        void onError(String message);
    }

    private final Context context;
    private final CameraManager cameraManager;
    private final ViewfinderView viewfinderView;
    private final Listener listener;
    private final HandlerThread cameraThread = new HandlerThread("MotionBridgeNativeCamera");
    private final HandlerThread inferenceThread = new HandlerThread("MotionBridgeNativeInference");
    private Handler cameraHandler;
    private Handler inferenceHandler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    private Surface previewSurface;
    private ViewfinderSurfaceSession viewfinderSurfaceSession;
    private PoseLandmarker poseLandmarker;
    private YuvToRgbConverter yuvConverter;
    private final AtomicBoolean inferenceBusy = new AtomicBoolean(false);
    private volatile boolean running;
    private String cameraId;
    private String facing = "back";
    private String modelGrade = "full";
    private int sensorOrientation;
    private int rotationDegrees;
    private Size captureSize = new Size(1280, 720);
    private Size inferenceSize = new Size(640, 360);
    private Size balancedInferenceSize = new Size(640, 360);
    private Size fallbackInferenceSize = new Size(480, 270);
    private Size relocalizeInferenceSize = new Size(960, 540);
    private Range<Integer> targetFpsRange;
    private long frameCount;
    private long fpsStartedMs;
    private float captureFps;
    private long previewFrameCount;
    private long previewFpsStartedMs;
    private float previewFps;
    private long inferenceFrameCount;
    private long inferenceFpsStartedMs;
    private float inferenceFps;
    private JSArray cachedHands = new JSArray();
    private long inferenceSequence;
    private long imageReaderFrameCount;
    private long submittedFrameCount;
    private long detectCallCount;
    private long detectErrorCount;
    private long emptyPoseStreak;
    private long lastPoseDetectedMs;
    private long lastDiagnosticLogMs;
    private long sizeProfileChangedMs;
    private float minimumPoseVisibility;
    private String analysisProfile = "balanced";
    private String lastInferenceError = "";
    private boolean analysisResizePending;
    private volatile long cameraGeneration;
    private volatile boolean inferenceEnabled;

    NativeCameraRuntime(Context context, ViewfinderView viewfinderView, Listener listener) {
        this.context = context;
        this.cameraManager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        this.viewfinderView = viewfinderView;
        this.listener = listener;
        cameraThread.start();
        inferenceThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
        inferenceHandler = new Handler(inferenceThread.getLooper());
    }

    void start(String requestedCameraId, String requestedGrade, boolean enableInference) {
        stopCameraOnly();
        cameraGeneration++;
        cameraId = requestedCameraId;
        modelGrade = normalizeGrade(requestedGrade);
        inferenceEnabled = enableInference;
        running = true;
        inferenceHandler.post(() -> {
            try {
                if (inferenceEnabled) loadModels(modelGrade); else closeModels();
                cameraHandler.post(this::requestViewfinderSurface);
            } catch (Exception error) {
                running = false;
                listener.onError("原生识别模型加载失败: " + shortError(error));
            }
        });
    }

    void setModel(String grade) {
        final String next = normalizeGrade(grade);
        if (next.equals(modelGrade) && poseLandmarker != null) return;
        modelGrade = next;
        inferenceHandler.post(() -> {
            try {
                loadModels(next);
                JSObject status = new JSObject();
                status.put("actualModel", modelGrade);
                listener.onStarted(status);
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
                            // A slightly permissive first acquisition lets a distant full body be found.
                            // Presence/tracking stay stricter to avoid keeping a weak false detection alive.
                            .setMinPoseDetectionConfidence(.45f).setMinPosePresenceConfidence(.5f)
                            .setMinTrackingConfidence(.55f).build());
        } catch (Exception gpuError) {
            if (delegate == Delegate.CPU) throw gpuError;
            BaseOptions base = BaseOptions.builder()
                    .setModelAssetPath("public/models/pose_landmarker_" + grade + ".task")
                    .setDelegate(Delegate.CPU).build();
            return PoseLandmarker.createFromOptions(context,
                    PoseLandmarker.PoseLandmarkerOptions.builder().setBaseOptions(base)
                            .setRunningMode(RunningMode.VIDEO).setNumPoses(2)
                            .setMinPoseDetectionConfidence(.45f).setMinPosePresenceConfidence(.5f)
                            .setMinTrackingConfidence(.55f).build());
        }
    }

    private void requestViewfinderSurface() {
        try {
            if (!running) return;
            final long generation = cameraGeneration;
            final CameraCharacteristics chars = cameraManager.getCameraCharacteristics(cameraId);
            Integer lensFacing = chars.get(CameraCharacteristics.LENS_FACING);
            facing = lensFacing != null && lensFacing == CameraCharacteristics.LENS_FACING_FRONT ? "front" : "back";
            sensorOrientation = valueOr(chars.get(CameraCharacteristics.SENSOR_ORIENTATION), 0);
            captureSize = choosePreviewSize(chars);
            configureInferenceSizes(chars);
            resetDiagnostics();
            targetFpsRange = choose30FpsRange(chars);
            rotationDegrees = relativeRotation(sensorOrientation, facing.equals("front"));
            createImageReader(inferenceSize);
            viewfinderView.post(() -> {
                if (!running || generation != cameraGeneration) return;
                TransformationInfo transformation = Camera2TransformationInfo.createFromCharacteristics(
                        chars, 0f, 0f, captureSize.getWidth(), captureSize.getHeight());
                viewfinderView.setTransformationInfo(transformation);
                ViewfinderSurfaceRequest request = new ViewfinderSurfaceRequest(
                        captureSize.getWidth(), captureSize.getHeight(),
                        ImplementationMode.EMBEDDED, cameraId + "-" + generation);
                ListenableFuture<ViewfinderSurfaceSession> future = viewfinderView.requestSurfaceSessionAsync(request);
                future.addListener(() -> {
                    try {
                        ViewfinderSurfaceSession surfaceSession = future.get();
                        cameraHandler.post(() -> openCamera(surfaceSession, generation));
                    } catch (Exception error) {
                        listener.onError("取景画面建立失败: " + shortError(error));
                    }
                }, ContextCompat.getMainExecutor(context));
            });
        } catch (Exception error) {
            listener.onError("镜头 " + cameraId + " 初始化失败: " + shortError(error));
        }
    }

    @SuppressWarnings("MissingPermission")
    private void openCamera(ViewfinderSurfaceSession surfaceSession, long generation) {
        try {
            if (!running || generation != cameraGeneration) { surfaceSession.close(); return; }
            viewfinderSurfaceSession = surfaceSession;
            previewSurface = surfaceSession.getSurface();
            cameraManager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(@NonNull CameraDevice opened) { camera = opened; createSession(); }
                @Override public void onDisconnected(@NonNull CameraDevice disconnected) { disconnected.close(); if (camera == disconnected) camera = null; listener.onError("镜头已断开"); }
                @Override public void onError(@NonNull CameraDevice failed, int error) { failed.close(); if (camera == failed) camera = null; listener.onError("镜头打开失败 Camera2 error=" + error); }
            }, cameraHandler);
        } catch (Exception error) {
            try { surfaceSession.close(); } catch (Exception ignored) { }
            listener.onError("镜头 " + cameraId + " 打开失败: " + shortError(error));
        }
    }

    private void createSession() {
        if (!running || camera == null || reader == null || previewSurface == null) return;
        try {
            CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            request.addTarget(previewSurface);
            request.addTarget(reader.getSurface());
            request.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
            if (targetFpsRange != null) request.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, targetFpsRange);
            createCaptureSession(request, true);
        } catch (Exception error) { listener.onError("创建镜头会话失败: " + shortError(error)); }
    }

    private void createImageReader(Size size) {
        inferenceSize = size;
        reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), android.graphics.ImageFormat.YUV_420_888, 3);
        reader.setOnImageAvailableListener(this::onImageAvailable, cameraHandler);
    }

    private void createCaptureSession(CaptureRequest.Builder request, boolean dualSurface) {
        if (camera == null || reader == null || previewSurface == null) return;
        List<Surface> surfaces = dualSurface
                ? Arrays.asList(previewSurface, reader.getSurface())
                : Arrays.asList(reader.getSurface());
        try {
            camera.createCaptureSession(surfaces, new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(@NonNull CameraCaptureSession configured) {
                    if (!running || camera == null) { configured.close(); return; }
                    session = configured;
                    try {
                        CaptureRequest.Builder activeRequest = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                        for (Surface surface : surfaces) activeRequest.addTarget(surface);
                        activeRequest.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
                        if (targetFpsRange != null) activeRequest.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, targetFpsRange);
                        session.setRepeatingRequest(activeRequest.build(), new CameraCaptureSession.CaptureCallback() {
                            @Override public void onCaptureCompleted(@NonNull CameraCaptureSession captureSession,
                                    @NonNull CaptureRequest request, @NonNull android.hardware.camera2.TotalCaptureResult result) {
                                if (dualSurface) countPreviewFrame();
                            }
                        }, cameraHandler);
                        fpsStartedMs = android.os.SystemClock.elapsedRealtime(); frameCount = 0;
                        previewFpsStartedMs = fpsStartedMs; previewFrameCount = 0; previewFps = 0f;
                        inferenceFpsStartedMs = fpsStartedMs; inferenceFrameCount = 0; inferenceFps = 0f;
                        analysisResizePending = false;
                        JSObject state = new JSObject();
                        state.put("cameraId", cameraId); state.put("facing", facing);
                        state.put("width", orientedWidth()); state.put("height", orientedHeight());
                        state.put("previewMirrored", facing.equals("front")); state.put("actualModel", modelGrade);
                        state.put("previewWidth", captureSize.getWidth()); state.put("previewHeight", captureSize.getHeight());
                        state.put("inferenceWidth", inferenceSize.getWidth()); state.put("inferenceHeight", inferenceSize.getHeight());
                        state.put("rotationDegrees", rotationDegrees); state.put("analysisProfile", analysisProfile);
                        state.put("dualSurface", dualSurface);
                        android.util.Log.i("MotionBridgePose", "camera_started preview=" + captureSize
                                + " inference=" + inferenceSize + " rotation=" + rotationDegrees
                                + " facing=" + facing + " dualSurface=" + dualSurface);
                        listener.onStarted(state);
                    } catch (Exception error) { listener.onError("启动连续预览失败: " + shortError(error)); }
                }
                @Override public void onConfigureFailed(@NonNull CameraCaptureSession failed) {
                    failed.close();
                    if (dualSurface && running) {
                        android.util.Log.w("MotionBridgeCamera", "Dual Surface capture failed; retrying inference-only safe mode");
                        createCaptureSession(request, false);
                    } else listener.onError("镜头捕获会话建立失败");
                }
            }, cameraHandler);
        } catch (Exception error) { listener.onError("创建镜头会话失败: " + shortError(error)); }
    }

    private void countPreviewFrame() {
        if (!running) return;
        previewFrameCount++;
        long now = android.os.SystemClock.elapsedRealtime();
        long span = now - previewFpsStartedMs;
        if (span >= 1000) {
            previewFps = previewFrameCount * 1000f / span;
            previewFrameCount = 0; previewFpsStartedMs = now;
        }
    }

    private void onImageAvailable(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null || !running) return;
            imageReaderFrameCount++;
            frameCount++;
            long now = android.os.SystemClock.elapsedRealtime();
            long span = now - fpsStartedMs;
            if (span >= 1000) { captureFps = frameCount * 1000f / span; frameCount = 0; fpsStartedMs = now; }
            if (!inferenceBusy.compareAndSet(false, true)) return;
            submittedFrameCount++;
            final Image owned = image; image = null;
            final long generation = cameraGeneration;
            inferenceHandler.post(() -> infer(owned, generation));
        } finally {
            if (image != null) image.close();
        }
    }

    private void infer(Image image, long generation) {
        MPImage mpImage = null;
        try {
            if (!running || generation != cameraGeneration) return;
            long capturedAt = System.currentTimeMillis();
            long timestamp = android.os.SystemClock.uptimeMillis();
            long started = android.os.SystemClock.elapsedRealtimeNanos();
            if (yuvConverter == null) yuvConverter = new YuvToRgbConverter(context);
            Bitmap bitmap = yuvConverter.convert(image);
            if (!inferenceEnabled || poseLandmarker == null) return;
            mpImage = new BitmapImageBuilder(bitmap).build();
            ImageProcessingOptions processing = ImageProcessingOptions.builder().setRotationDegrees(rotationDegrees).build();
            PoseLandmarkerResult pose;
            detectCallCount++;
            try {
                pose = poseLandmarker.detectForVideo(mpImage, processing, timestamp);
                lastInferenceError = "";
            } catch (Exception detectError) {
                detectErrorCount++;
                lastInferenceError = shortError(detectError);
                throw detectError;
            }
            float inferenceMs = (android.os.SystemClock.elapsedRealtimeNanos() - started) / 1_000_000f;
            inferenceFrameCount++;
            long fpsNow = android.os.SystemClock.elapsedRealtime();
            long inferenceSpan = fpsNow - inferenceFpsStartedMs;
            if (inferenceSpan >= 1000) {
                inferenceFps = inferenceFrameCount * 1000f / inferenceSpan;
                inferenceFrameCount = 0; inferenceFpsStartedMs = fpsNow;
            }
            JSObject frame = new JSObject();
            frame.put("capturedAtMs", capturedAt); frame.put("cameraId", cameraId); frame.put("facing", facing);
            frame.put("width", orientedWidth()); frame.put("height", orientedHeight());
            frame.put("inferenceWidth", inferenceSize.getWidth()); frame.put("inferenceHeight", inferenceSize.getHeight());
            frame.put("previewMirrored", facing.equals("front")); frame.put("coordinatesMirrored", false);
            frame.put("actualModel", modelGrade); frame.put("inferenceMs", inferenceMs); frame.put("captureFps", captureFps);
            frame.put("previewFps", previewFps); frame.put("inferenceFps", inferenceFps);
            addPoseDiagnostics(frame, pose, bitmap);
            if (generation != cameraGeneration) return;
            frame.put("poses", encodePoses(pose)); frame.put("hands", cachedHands);
            listener.onFrame(frame);
            updateAnalysisProfile(pose, android.os.SystemClock.elapsedRealtime(), inferenceMs);
        } catch (Exception error) {
            android.util.Log.e("MotionBridgePose", "detect_failed calls=" + detectCallCount
                    + " bitmap=" + image.getWidth() + "x" + image.getHeight()
                    + " rotation=" + rotationDegrees, error);
            listener.onError("原生推理失败: " + shortError(error));
        } finally {
            // BitmapImageContainer.close() recycles the caller-owned Bitmap in Tasks 0.10.14.
            // detectForVideo is synchronous, so drop the small wrapper and keep the reusable frame Bitmap alive.
            mpImage = null;
            image.close(); inferenceBusy.set(false);
        }
    }

    private JSArray encodePoses(PoseLandmarkerResult result) {
        JSArray poses = new JSArray();
        for (int i = 0; i < result.landmarks().size(); i++) {
            JSObject item = new JSObject(); item.put("detection_id", null);
            item.put("pose", encodeNormalized(result.landmarks().get(i)));
            item.put("world_pose", i < result.worldLandmarks().size() ? encodeWorld(result.worldLandmarks().get(i)) : null);
            poses.put(item);
        }
        return poses;
    }

    private JSArray encodeNormalized(List<NormalizedLandmark> points) {
        JSArray output = new JSArray();
        for (NormalizedLandmark point : points) {
            // ImageProcessingOptions already rotates the input for MediaPipe. Its normalized
            // output is in that upright coordinate system; rotating here again corrupts it.
            JSObject value = new JSObject(); value.put("x", point.x()); value.put("y", point.y()); value.put("z", point.z());
            value.put("visibility", point.visibility().orElse(1f)); output.put(value);
        }
        return output;
    }

    private JSArray encodeWorld(List<Landmark> points) {
        JSArray output = new JSArray();
        for (Landmark point : points) {
            JSObject value = new JSObject(); value.put("x", point.x()); value.put("y", point.y()); value.put("z", point.z());
            value.put("visibility", point.visibility().orElse(1f)); output.put(value);
        }
        return output;
    }

    private void resetDiagnostics() {
        imageReaderFrameCount = 0; submittedFrameCount = 0; detectCallCount = 0; detectErrorCount = 0;
        emptyPoseStreak = 0; lastPoseDetectedMs = 0; lastDiagnosticLogMs = 0;
        minimumPoseVisibility = 0f; lastInferenceError = ""; analysisResizePending = false;
        sizeProfileChangedMs = android.os.SystemClock.elapsedRealtime();
    }

    private void addPoseDiagnostics(JSObject frame, PoseLandmarkerResult result, Bitmap bitmap) {
        int poseCount = result.landmarks().size();
        if (poseCount == 0) minimumPoseVisibility = 0f;
        JSObject diagnostics = new JSObject();
        diagnostics.put("imageReaderFrames", imageReaderFrameCount);
        diagnostics.put("submittedFrames", submittedFrameCount);
        diagnostics.put("detectCalls", detectCallCount);
        diagnostics.put("detectErrors", detectErrorCount);
        diagnostics.put("poseCount", poseCount);
        diagnostics.put("bitmapWidth", bitmap.getWidth()); diagnostics.put("bitmapHeight", bitmap.getHeight());
        diagnostics.put("rotationDegrees", rotationDegrees); diagnostics.put("analysisProfile", analysisProfile);
        diagnostics.put("minimumPoseVisibility", minimumPoseVisibility);
        diagnostics.put("lastError", lastInferenceError);
        if (poseCount > 0 && !result.landmarks().get(0).isEmpty()) {
            List<NormalizedLandmark> points = result.landmarks().get(0);
            minimumPoseVisibility = minimumVisibility(points);
            NormalizedLandmark raw = points.get(0);
            JSObject rawPoint = pointDiagnostic(raw.x(), raw.y(), raw.visibility().orElse(1f));
            // Kept separately so a future encoder transform regression is visible on-device.
            JSObject encodedPoint = pointDiagnostic(raw.x(), raw.y(), raw.visibility().orElse(1f));
            diagnostics.put("minimumPoseVisibility", minimumPoseVisibility);
            diagnostics.put("rawFirstPoint", rawPoint); diagnostics.put("encodedFirstPoint", encodedPoint);
        }
        frame.put("poseCount", poseCount); frame.put("poseDiagnostics", diagnostics);

        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastDiagnosticLogMs >= 2000) {
            lastDiagnosticLogMs = now;
            android.util.Log.i("MotionBridgePose", "reader=" + imageReaderFrameCount
                    + " submitted=" + submittedFrameCount + " detect=" + detectCallCount
                    + " errors=" + detectErrorCount + " poseCount=" + poseCount
                    + " minVisibility=" + minimumPoseVisibility + " bitmap=" + bitmap.getWidth() + "x" + bitmap.getHeight()
                    + " rotation=" + rotationDegrees + " profile=" + analysisProfile);
        }
    }

    private JSObject pointDiagnostic(float x, float y, float visibility) {
        return new JSObject().put("x", x).put("y", y).put("visibility", visibility);
    }

    private float minimumVisibility(List<NormalizedLandmark> points) {
        float minimum = 1f;
        // Head, shoulders, wrists, hips, knees and ankles are enough to describe full-body confidence.
        int[] body = {0, 7, 8, 11, 12, 15, 16, 23, 24, 25, 26, 27, 28};
        for (int index : body) if (index < points.size()) minimum = Math.min(minimum, points.get(index).visibility().orElse(1f));
        return minimum;
    }

    private void updateAnalysisProfile(PoseLandmarkerResult result, long now, float inferenceMs) {
        if (!result.landmarks().isEmpty()) {
            emptyPoseStreak = 0; lastPoseDetectedMs = now;
            if (!"balanced".equals(analysisProfile) && now - sizeProfileChangedMs >= 2500) requestAnalysisSize(balancedInferenceSize, "balanced");
            return;
        }
        emptyPoseStreak++;
        long noPoseFor = lastPoseDetectedMs == 0 ? now - sizeProfileChangedMs : now - lastPoseDetectedMs;
        if ("balanced".equals(analysisProfile) && noPoseFor >= 4000 && !relocalizeInferenceSize.equals(balancedInferenceSize)) {
            requestAnalysisSize(relocalizeInferenceSize, "relocalize");
        } else if ("relocalize".equals(analysisProfile) && now - sizeProfileChangedMs >= 2500) {
            requestAnalysisSize(inferenceMs > 95f ? fallbackInferenceSize : balancedInferenceSize,
                    inferenceMs > 95f ? "fallback" : "balanced");
        } else if ("balanced".equals(analysisProfile) && inferenceFps > 0f && inferenceFps < 9f && now - sizeProfileChangedMs >= 5000) {
            requestAnalysisSize(fallbackInferenceSize, "fallback");
        } else if ("fallback".equals(analysisProfile) && noPoseFor >= 5000 && !relocalizeInferenceSize.equals(fallbackInferenceSize)) {
            requestAnalysisSize(relocalizeInferenceSize, "relocalize");
        }
    }

    private void requestAnalysisSize(Size next, String profile) {
        if (analysisResizePending || next.equals(inferenceSize) || !running) return;
        analysisResizePending = true;
        cameraHandler.post(() -> switchAnalysisSize(next, profile));
    }

    private void switchAnalysisSize(Size next, String profile) {
        if (!running || camera == null || previewSurface == null) { analysisResizePending = false; return; }
        try {
            if (session != null) { try { session.stopRepeating(); session.abortCaptures(); } catch (Exception ignored) { } session.close(); session = null; }
            if (reader != null) { reader.close(); reader = null; }
            createImageReader(next); analysisProfile = profile;
            sizeProfileChangedMs = android.os.SystemClock.elapsedRealtime();
            analysisResizePending = false;
            android.util.Log.i("MotionBridgePose", "analysis_size_switch profile=" + profile + " size=" + next);
            createSession();
        } catch (Exception error) {
            analysisResizePending = false;
            listener.onError("切换人体分析尺寸失败: " + shortError(error));
        }
    }

    private int orientedWidth() { return rotationDegrees == 90 || rotationDegrees == 270 ? captureSize.getHeight() : captureSize.getWidth(); }
    private int orientedHeight() { return rotationDegrees == 90 || rotationDegrees == 270 ? captureSize.getWidth() : captureSize.getHeight(); }

    private int relativeRotation(int sensor, boolean front) {
        WindowManager wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        int display = wm.getDefaultDisplay().getRotation();
        int degrees = display == Surface.ROTATION_90 ? 90 : display == Surface.ROTATION_180 ? 180 : display == Surface.ROTATION_270 ? 270 : 0;
        // Camera2 reports clockwise rotation from the sensor's native landscape buffer
        // into the current display orientation.
        return front ? (sensor + degrees) % 360 : (sensor - degrees + 360) % 360;
    }

    private Size choosePreviewSize(CameraCharacteristics chars) {
        StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] sizes = map == null ? null : map.getOutputSizes(SurfaceTexture.class);
        if (sizes == null || sizes.length == 0) return new Size(1280, 720);
        return Arrays.stream(sizes).min((a, b) -> Long.compare(score(a), score(b))).orElse(sizes[0]);
    }

    private void configureInferenceSizes(CameraCharacteristics chars) {
        StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] sizes = map == null ? null : map.getOutputSizes(android.graphics.ImageFormat.YUV_420_888);
        Size[] supported = sizes == null ? new Size[0] : sizes;
        balancedInferenceSize = InferenceSizePolicy.chooseBalanced(supported);
        fallbackInferenceSize = InferenceSizePolicy.chooseFallback(supported);
        relocalizeInferenceSize = InferenceSizePolicy.chooseRelocalize(supported, balancedInferenceSize);
        inferenceSize = balancedInferenceSize; analysisProfile = "balanced";
    }

    private Range<Integer> choose30FpsRange(CameraCharacteristics chars) {
        Range<Integer>[] ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (ranges == null) return null;
        Range<Integer> best = null;
        for (Range<Integer> range : ranges) if (range.contains(30)) {
            if (best == null || range.getLower() > best.getLower()) best = range;
        }
        return best;
    }

    private long score(Size size) {
        long area = (long) size.getWidth() * size.getHeight();
        return Math.abs(area - 1280L * 720L) + Math.abs(size.getWidth() * 9L - size.getHeight() * 16L) * 1000L;
    }

    void stop() {
        running = false; cameraGeneration++; stopCameraOnly();
        inferenceHandler.post(this::closeModels);
        viewfinderView.post(() -> viewfinderView.setVisibility(android.view.View.GONE));
    }

    private void stopCameraOnly() {
        cameraHandler.post(() -> {
            if (session != null) { try { session.stopRepeating(); session.abortCaptures(); } catch (Exception ignored) { } session.close(); session = null; }
            if (camera != null) { camera.close(); camera = null; }
            if (reader != null) { reader.close(); reader = null; }
            previewSurface = null;
            if (viewfinderSurfaceSession != null) {
                try { viewfinderSurfaceSession.close(); } catch (Exception ignored) { }
                viewfinderSurfaceSession = null;
            }
            inferenceBusy.set(false); cachedHands = new JSArray(); inferenceSequence = 0;
        });
    }

    private void closeModels() {
        if (poseLandmarker != null) { poseLandmarker.close(); poseLandmarker = null; }
    }

    void destroy() {
        running = false; cameraGeneration++; stopCameraOnly(); closeModels();
        if (yuvConverter != null) { yuvConverter.close(); yuvConverter = null; }
        cameraThread.quitSafely(); inferenceThread.quitSafely();
    }

    private int valueOr(Integer value, int fallback) { return value == null ? fallback : value; }
    private String shortError(Throwable error) {
        String message = error.getMessage();
        return error.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }
}
