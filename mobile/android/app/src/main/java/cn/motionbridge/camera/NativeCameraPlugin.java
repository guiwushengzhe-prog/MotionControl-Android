package cn.motionbridge.camera;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;
import android.util.Range;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.camera.viewfinder.core.ScaleType;
import androidx.camera.viewfinder.view.ViewfinderView;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

@CapacitorPlugin(name = "NativeCamera", permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
})
public class NativeCameraPlugin extends Plugin {
    private CameraManager cameraManager;
    private HandlerThread cameraThread;
    private Handler cameraHandler;
    private ViewfinderView previewView;
    private NativeCameraRuntime runtime;
    private final AtomicReference<PluginCall> pendingStart = new AtomicReference<>();
    private static final String CAMERA_CACHE = "native_camera_discovery";

    @Override
    public void load() {
        cameraManager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
        cameraThread = new HandlerThread("MotionBridgeCameraProbe");
        cameraThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
    }

    @Override
    protected void handleOnDestroy() {
        if (runtime != null) runtime.destroy();
        if (cameraThread != null) cameraThread.quitSafely();
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnPause() {
        if (runtime != null) runtime.stop();
        notifyListeners("cameraLifecycle", new JSObject().put("active", false));
        super.handleOnPause();
    }

    @PluginMethod
    public void listCameras(PluginCall call) {
        new Thread(() -> {
            try {
                JSArray cameras = new JSArray();
                for (String cameraId : cameraManager.getCameraIdList()) cameras.put(describe(cameraId));
                JSObject result = new JSObject();
                result.put("cameras", cameras);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Camera2 枚举失败: " + error.getMessage(), error);
            }
        }, "MotionBridgeCameraList").start();
    }

    @PluginMethod
    public void probeCameras(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            call.reject("摄像头未授权");
            return;
        }
        new Thread(() -> {
            try {
                Map<String, String> physicalParents = physicalParents();
                JSArray cameras = new JSArray();
                for (String cameraId : cameraManager.getCameraIdList()) {
                    JSObject item = describe(cameraId);
                    ProbeResult probe;
                    try { cameraManager.getCameraCharacteristics(cameraId); probe = probeDirect(cameraId); }
                    catch (Exception invalidId) {
                        probe = new ProbeResult(); probe.openMode = "direct";
                        probe.errorMessage = "getCameraCharacteristics: " + invalidId.getClass().getSimpleName() + ": " + invalidId.getMessage();
                    }
                    if (!probe.available && Build.VERSION.SDK_INT >= 28 && physicalParents.containsKey(cameraId)) {
                        ProbeResult routed = probePhysical(physicalParents.get(cameraId), cameraId);
                        if (routed.available) probe = routed;
                        else probe.errorMessage += "; physical-route=" + routed.errorMessage;
                    }
                    item.put("available", probe.available);
                    item.put("openMode", probe.openMode);
                    item.put("errorCode", probe.errorCode);
                    item.put("errorMessage", probe.errorMessage);
                    item.put("width", probe.width);
                    item.put("height", probe.height);
                    item.put("previewFps", probe.fps);
                    cameras.put(item);
                }
                JSObject result = new JSObject();
                result.put("cameras", cameras);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Camera2 实开探测失败: " + error.getMessage(), error);
            }
        }, "MotionBridgeCameraProbeRunner").start();
    }

    /** Enumerates candidates dynamically and keeps only devices that produce a real frame. */
    @PluginMethod
    public void discoverCameras(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            call.reject("摄像头未授权"); return;
        }
        new Thread(() -> {
            try {
                String cacheKey = discoveryCacheKey();
                SharedPreferences preferences = getContext().getSharedPreferences(CAMERA_CACHE, Context.MODE_PRIVATE);
                boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
                String cached = force ? null : preferences.getString(cacheKey, null);
                if (cached != null) { call.resolve(new JSObject(cached)); return; }

                String[] exposedIds = cameraManager.getCameraIdList();
                Map<String, String> parents = physicalParents();
                // Candidates come only from Camera2's runtime logical/physical lists. No vendor IDs are invented.
                LinkedHashSet<String> candidates = CameraDiscoveryPolicy.candidates(exposedIds, parents.keySet());
                JSArray cameras = new JSArray();
                for (String cameraId : candidates) {
                    JSObject item;
                    boolean characteristicsKnown = true;
                    try { item = describe(cameraId); }
                    catch (Exception inaccessible) {
                        characteristicsKnown = false;
                        item = new JSObject(); item.put("cameraId", cameraId); item.put("facing", "unknown");
                        item.put("focalLengths", new JSArray()); item.put("physicalCameraIds", new JSArray());
                    }
                    ProbeResult probe = probeDirect(cameraId);
                    if (!probe.available && Build.VERSION.SDK_INT >= 28 && parents.containsKey(cameraId)) {
                        ProbeResult routed = probePhysical(parents.get(cameraId), cameraId);
                        if (routed.available) probe = routed;
                        else probe.errorMessage += "; physical-route=" + routed.errorMessage;
                    }
                    item.put("available", probe.available); item.put("openMode", probe.openMode);
                    item.put("errorCode", probe.errorCode); item.put("errorMessage", probe.errorMessage);
                    item.put("width", probe.width); item.put("height", probe.height); item.put("previewFps", probe.fps);
                    // Only expose a lens after openCamera + capture session + a real YUV frame.
                    if (probe.available) cameras.put(item);
                }
                JSObject result = new JSObject(); result.put("cameras", cameras);
                result.put("deviceKey", android.os.Build.FINGERPRINT + "|" + android.os.Build.VERSION.INCREMENTAL);
                result.put("manufacturer", android.os.Build.MANUFACTURER); result.put("model", android.os.Build.MODEL);
                result.put("androidApi", android.os.Build.VERSION.SDK_INT);
                preferences.edit().clear().putString(cacheKey, result.toString()).apply();
                call.resolve(result);
            } catch (Exception error) { call.reject("原生镜头探测失败: " + error.getMessage(), error); }
        }, "MotionBridgeCameraDiscovery").start();
    }

    @PluginMethod
    public void startCamera(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            call.reject("摄像头未授权"); return;
        }
        String cameraId = call.getString("cameraId");
        if (cameraId == null || cameraId.isEmpty()) { call.reject("请选择镜头"); return; }
        String model = call.getString("model", "full");
        Boolean inference = call.getBoolean("inference", true);
        pendingStart.set(call);
        getActivity().runOnUiThread(() -> {
            ensureRuntime();
            // AndroidX Viewfinder owns the high-resolution GPU preview transform.
            previewView.setVisibility(View.VISIBLE);
            getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
            runtime.start(cameraId, model, inference == null || inference);
        });
    }

    @PluginMethod
    public void setModel(PluginCall call) {
        if (runtime == null) { call.reject("原生摄像头尚未启动"); return; }
        runtime.setModel(call.getString("model", "full")); call.resolve();
    }

    @PluginMethod
    public void enableInference(PluginCall call) {
        if (runtime == null) { call.reject("原生摄像头尚未启动"); return; }
        runtime.enableInference(call.getString("model", "full"));
        call.resolve();
    }

    @PluginMethod
    public void setDisplayMode(PluginCall call) {
        String role = call.getString("role", "home");
        int orientation = "handheld".equals(role)
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
        getActivity().runOnUiThread(() -> {
            getActivity().setRequestedOrientation(orientation);
            call.resolve();
        });
    }

    @PluginMethod
    public void stopCamera(PluginCall call) {
        pendingStart.set(null);
        if (runtime != null) runtime.stop();
        getActivity().runOnUiThread(() -> {
            if (previewView != null) previewView.setVisibility(View.GONE);
            getBridge().getWebView().setBackgroundColor(Color.rgb(8, 11, 15));
        });
        call.resolve();
    }

    private void ensureRuntime() {
        if (previewView == null) {
            previewView = new ViewfinderView(getContext());
            // Runtime framing prioritizes seeing the complete body. The model analyzes the
            // full sensor stream too, so FIT_CENTER keeps preview and analysis coverage honest.
            previewView.setScaleType(ScaleType.FIT_CENTER);
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            ViewGroup content = getActivity().findViewById(android.R.id.content);
            content.addView(previewView, 0, params);
        }
        if (runtime == null) runtime = new NativeCameraRuntime(getContext(), previewView, new NativeCameraRuntime.Listener() {
            @Override public void onStarted(JSObject state) {
                PluginCall call = pendingStart.getAndSet(null); if (call != null) call.resolve(state);
                notifyListeners("cameraStatus", state);
            }
            @Override public void onFrame(JSObject frame) { notifyListeners("poseResult", frame); }
            @Override public void onError(String message) {
                getContext().getSharedPreferences(CAMERA_CACHE, Context.MODE_PRIVATE).edit().clear().apply();
                PluginCall call = pendingStart.getAndSet(null);
                if (call != null) call.reject(message);
                notifyListeners("cameraError", new JSObject().put("message", message));
            }
        });
    }

    private String discoveryCacheKey() {
        String appVersion = "unknown";
        try {
            android.content.pm.PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            appVersion = info.versionName + "|" + (Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode);
        } catch (Exception ignored) { }
        return "camera-map|" + android.os.Build.FINGERPRINT + "|" + android.os.Build.VERSION.INCREMENTAL + "|" + appVersion;
    }

    private Map<String, String> physicalParents() throws CameraAccessException {
        Map<String, String> parents = new HashMap<>();
        if (Build.VERSION.SDK_INT < 28) return parents;
        for (String logicalId : cameraManager.getCameraIdList()) {
            Set<String> physicalIds = cameraManager.getCameraCharacteristics(logicalId).getPhysicalCameraIds();
            for (String physicalId : physicalIds) parents.put(physicalId, logicalId);
        }
        return parents;
    }

    private JSObject describe(String cameraId) throws Exception {
        CameraCharacteristics characteristics = cameraManager.getCameraCharacteristics(cameraId);
        JSObject result = new JSObject();
        result.put("cameraId", cameraId);
        Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
        result.put("facing", facingName(facing));
        result.put("sensorOrientation", valueOr(characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION), 0));
        android.util.SizeF sensor = characteristics.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
        if (sensor != null) {
            result.put("sensorWidthMm", sensor.getWidth());
            result.put("sensorHeightMm", sensor.getHeight());
        }
        float[] focals = characteristics.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        JSArray focalValues = new JSArray();
        if (focals != null) for (float focal : focals) focalValues.put(focal);
        result.put("focalLengths", focalValues);
        int[] capabilities = characteristics.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        boolean logicalMulti = false;
        if (capabilities != null) for (int value : capabilities) {
            if (value == CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA) logicalMulti = true;
        }
        result.put("logicalMultiCamera", logicalMulti);
        JSArray physical = new JSArray();
        if (Build.VERSION.SDK_INT >= 28) for (String value : characteristics.getPhysicalCameraIds()) physical.put(value);
        result.put("physicalCameraIds", physical);
        Range<Integer>[] fpsRanges = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        int maxFps = 0; boolean supports30Fps = false;
        if (fpsRanges != null) for (Range<Integer> range : fpsRanges) {
            maxFps = Math.max(maxFps, range.getUpper());
            if (range.getLower() <= 30 && range.getUpper() >= 30) supports30Fps = true;
        }
        result.put("maxFps", maxFps); result.put("supports30Fps", supports30Fps);
        return result;
    }

    private ProbeResult probeDirect(String cameraId) {
        return probe(cameraId, null, "direct");
    }

    private ProbeResult probePhysical(String logicalId, String physicalId) {
        return probe(logicalId, physicalId, "logical-physical");
    }

    private ProbeResult probe(String openId, String physicalId, String mode) {
        ProbeResult result = new ProbeResult();
        result.openMode = mode;
        AtomicReference<CameraDevice> deviceRef = new AtomicReference<>();
        AtomicReference<CameraCaptureSession> sessionRef = new AtomicReference<>();
        AtomicReference<ImageReader> readerRef = new AtomicReference<>();
        AtomicReference<String> failure = new AtomicReference<>("");
        AtomicInteger errorCode = new AtomicInteger(-1);
        AtomicInteger frames = new AtomicInteger(0);
        AtomicLong firstNs = new AtomicLong(0);
        AtomicLong lastNs = new AtomicLong(0);
        CountDownLatch firstFrame = new CountDownLatch(1);
        try {
            Size size;
            try {
                CameraCharacteristics characteristics = cameraManager.getCameraCharacteristics(physicalId == null ? openId : physicalId);
                size = chooseProbeSize(characteristics);
            } catch (Exception characteristicsError) {
                size = new Size(640, 480);
                failure.set("getCameraCharacteristics: " + characteristicsError.getClass().getSimpleName() + ": " + characteristicsError.getMessage());
            }
            result.width = size.getWidth(); result.height = size.getHeight();
            ImageReader reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.YUV_420_888, 3);
            readerRef.set(reader);
            reader.setOnImageAvailableListener(source -> {
                Image image = null;
                try {
                    image = source.acquireLatestImage();
                    if (image == null) return;
                    long now = System.nanoTime();
                    if (firstNs.compareAndSet(0, now)) firstFrame.countDown();
                    lastNs.set(now); frames.incrementAndGet();
                } finally {
                    if (image != null) image.close();
                }
            }, cameraHandler);
            cameraManager.openCamera(openId, new CameraDevice.StateCallback() {
                @Override public void onOpened(@NonNull CameraDevice camera) {
                    deviceRef.set(camera);
                    try {
                        CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                        request.addTarget(reader.getSurface());
                        CameraCaptureSession.StateCallback callback = new CameraCaptureSession.StateCallback() {
                            @Override public void onConfigured(@NonNull CameraCaptureSession session) {
                                sessionRef.set(session);
                                try { session.setRepeatingRequest(request.build(), null, cameraHandler); }
                                catch (Exception error) { failure.set("setRepeatingRequest: " + error); firstFrame.countDown(); }
                            }
                            @Override public void onConfigureFailed(@NonNull CameraCaptureSession session) {
                                failure.set("onConfigureFailed"); firstFrame.countDown();
                            }
                        };
                        if (physicalId != null && Build.VERSION.SDK_INT >= 28) {
                            OutputConfiguration output = new OutputConfiguration(reader.getSurface());
                            output.setPhysicalCameraId(physicalId);
                            camera.createCaptureSessionByOutputConfigurations(Collections.singletonList(output), callback, cameraHandler);
                        } else {
                            camera.createCaptureSession(Collections.singletonList(reader.getSurface()), callback, cameraHandler);
                        }
                    } catch (Exception error) { failure.set("createSession: " + error); firstFrame.countDown(); }
                }
                @Override public void onDisconnected(@NonNull CameraDevice camera) {
                    failure.set("onDisconnected"); camera.close(); firstFrame.countDown();
                }
                @Override public void onError(@NonNull CameraDevice camera, int code) {
                    errorCode.set(code); failure.set("onError(" + code + ")"); camera.close(); firstFrame.countDown();
                }
            }, cameraHandler);
            boolean signaled = firstFrame.await(2500, TimeUnit.MILLISECONDS);
            if (signaled && firstNs.get() > 0) {
                Thread.sleep(350);
                result.available = true;
                long duration = lastNs.get() - firstNs.get();
                result.fps = duration > 0 ? Math.round((frames.get() - 1) * 1_000_000_000f / duration * 10f) / 10f : 0f;
            } else {
                result.errorMessage = failure.get().isEmpty() ? "timeout-no-frame" : failure.get();
            }
        } catch (SecurityException error) {
            result.errorMessage = "SecurityException: " + error.getMessage();
        } catch (Exception error) {
            result.errorMessage = error.getClass().getSimpleName() + ": " + error.getMessage();
        } finally {
            result.errorCode = errorCode.get();
            CameraCaptureSession session = sessionRef.get(); if (session != null) session.close();
            CameraDevice device = deviceRef.get(); if (device != null) device.close();
            ImageReader reader = readerRef.get(); if (reader != null) reader.close();
        }
        return result;
    }

    private Size chooseProbeSize(CameraCharacteristics characteristics) {
        StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] sizes = map == null ? null : map.getOutputSizes(ImageFormat.YUV_420_888);
        if (sizes == null || sizes.length == 0) return new Size(640, 480);
        return Arrays.stream(sizes).min((a, b) -> Long.compare(score(a), score(b))).orElse(sizes[0]);
    }

    private long score(Size size) {
        long area = (long) size.getWidth() * size.getHeight();
        long target = 1280L * 720L;
        long aspectPenalty = Math.abs(size.getWidth() * 9L - size.getHeight() * 16L) * 1000L;
        return Math.abs(area - target) + aspectPenalty;
    }

    private String facingName(Integer facing) {
        if (facing == null) return "unknown";
        if (facing == CameraCharacteristics.LENS_FACING_FRONT) return "front";
        if (facing == CameraCharacteristics.LENS_FACING_BACK) return "back";
        if (facing == CameraCharacteristics.LENS_FACING_EXTERNAL) return "external";
        return "unknown";
    }

    private int valueOr(Integer value, int fallback) { return value == null ? fallback : value; }

    private static class ProbeResult {
        boolean available = false;
        String openMode = "";
        int errorCode = -1;
        String errorMessage = "";
        int width = 0;
        int height = 0;
        float fps = 0;
    }
}
