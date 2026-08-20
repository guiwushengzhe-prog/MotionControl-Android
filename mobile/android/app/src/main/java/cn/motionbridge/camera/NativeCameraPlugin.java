package cn.motionbridge.camera;

import android.Manifest;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.camera.core.CameraSelector;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.google.common.util.concurrent.ListenableFuture;

/** Capacitor bridge for the two standard CameraX camera selectors. */
@CapacitorPlugin(name = "NativeCamera", permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
})
public class NativeCameraPlugin extends Plugin {
    private PreviewView previewView;
    private NativeCameraRuntime runtime;
    private PluginCall pendingStart;

    @Override
    protected void handleOnDestroy() {
        if (runtime != null) runtime.destroy();
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
        discoverCameras(call);
    }

    @PluginMethod
    public void probeCameras(PluginCall call) {
        discoverCameras(call);
    }

    /** CameraX exposes only selectors that the current device can bind. */
    @PluginMethod
    public void discoverCameras(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("摄像头未授权");
            return;
        }
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(getContext());
        future.addListener(() -> {
            try {
                ProcessCameraProvider provider = future.get();
                JSArray cameras = new JSArray();
                if (provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
                    cameras.put(cameraDescriptor("back", "back"));
                }
                if (provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)) {
                    cameras.put(cameraDescriptor("front", "front"));
                }
                JSObject result = new JSObject();
                result.put("cameras", cameras);
                result.put("deviceKey", "camerax|" + android.os.Build.FINGERPRINT
                        + "|" + android.os.Build.VERSION.INCREMENTAL);
                result.put("manufacturer", android.os.Build.MANUFACTURER);
                result.put("model", android.os.Build.MODEL);
                result.put("androidApi", android.os.Build.VERSION.SDK_INT);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("CameraX 镜头发现失败: " + shortError(error), error);
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }

    @PluginMethod
    public void startCamera(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("摄像头未授权");
            return;
        }
        String cameraId = call.getString("cameraId", "back");
        if (!"front".equals(cameraId) && !"back".equals(cameraId)) {
            call.reject("请选择前置或后置镜头");
            return;
        }
        String model = call.getString("model", "full");
        Boolean inference = call.getBoolean("inference", true);
        pendingStart = call;
        getActivity().runOnUiThread(() -> {
            ensureRuntime();
            previewView.setVisibility(View.VISIBLE);
            getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
            runtime.start(cameraId, model, inference == null || inference);
        });
    }

    @PluginMethod
    public void setModel(PluginCall call) {
        if (runtime == null) {
            call.reject("原生摄像头尚未启动");
            return;
        }
        runtime.setModel(call.getString("model", "full"));
        call.resolve();
    }

    @PluginMethod
    public void enableInference(PluginCall call) {
        if (runtime == null) {
            call.reject("原生摄像头尚未启动");
            return;
        }
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
        pendingStart = null;
        if (runtime != null) runtime.stop();
        getActivity().runOnUiThread(() -> {
            if (previewView != null) previewView.setVisibility(View.GONE);
            getBridge().getWebView().setBackgroundColor(Color.rgb(8, 11, 15));
        });
        call.resolve();
    }

    private void ensureRuntime() {
        if (previewView == null) {
            previewView = new PreviewView(getContext());
            previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
            previewView.setScaleType(PreviewView.ScaleType.FIT_CENTER);
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            ViewGroup content = getActivity().findViewById(android.R.id.content);
            content.addView(previewView, 0, params);
        }
        if (runtime == null) {
            runtime = new NativeCameraRuntime(getContext(), previewView,
                    (LifecycleOwner) getActivity(), new NativeCameraRuntime.Listener() {
                @Override public void onStarted(JSObject state) {
                    PluginCall call = pendingStart;
                    pendingStart = null;
                    if (call != null) call.resolve(state);
                    notifyListeners("cameraStatus", state);
                }

                @Override public void onFrame(JSObject frame) {
                    notifyListeners("poseResult", frame);
                }

                @Override public void onError(String message) {
                    PluginCall call = pendingStart;
                    pendingStart = null;
                    if (call != null) call.reject(message);
                    notifyListeners("cameraError", new JSObject().put("message", message));
                }
            });
        }
    }

    private JSObject cameraDescriptor(String id, String facing) {
        return new JSObject()
                .put("cameraId", id)
                .put("facing", facing)
                .put("available", true)
                .put("openMode", "camerax")
                .put("errorCode", -1)
                .put("errorMessage", "")
                .put("width", 0)
                .put("height", 0)
                .put("previewFps", 0)
                .put("focalLengths", new JSArray())
                .put("physicalCameraIds", new JSArray())
                .put("sensorOrientation", 0)
                .put("logicalMultiCamera", false)
                .put("supports30Fps", true);
    }

    private String shortError(Throwable error) {
        String message = error.getMessage();
        return error.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }
}
