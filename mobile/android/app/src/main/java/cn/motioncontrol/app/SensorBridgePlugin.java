package cn.motioncontrol.app;

import android.content.Context;
import android.content.pm.ActivityInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SensorBridge")
public class SensorBridgePlugin extends Plugin implements SensorEventListener {
    private SensorManager manager;
    private final float[] quaternion = new float[]{0f, 0f, 0f, 1f};
    private final float[] gyro = new float[]{0f, 0f, 0f};
    private final float[] acceleration = new float[]{0f, 0f, 1f};
    private long latestTimestamp = 0;
    private boolean running = false;

    @PluginMethod
    public void start(PluginCall call) {
        manager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        Sensor rotation = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        Sensor gyroscope = manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        Sensor linear = manager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
        Sensor accelerometer = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (rotation == null || gyroscope == null || (linear == null && accelerometer == null)) {
            call.reject("当前手机缺少手持体感所需传感器");
            return;
        }
        manager.registerListener(this, rotation, SensorManager.SENSOR_DELAY_GAME);
        manager.registerListener(this, gyroscope, SensorManager.SENSOR_DELAY_GAME);
        manager.registerListener(this, linear != null ? linear : accelerometer, SensorManager.SENSOR_DELAY_GAME);
        running = true;
        getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        call.resolve();
    }

    @PluginMethod
    public void getLatest(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (this) {
            result.put("qx", quaternion[0]); result.put("qy", quaternion[1]);
            result.put("qz", quaternion[2]); result.put("qw", quaternion[3]);
            result.put("gx", gyro[0]); result.put("gy", gyro[1]); result.put("gz", gyro[2]);
            result.put("ax", acceleration[0]); result.put("ay", acceleration[1]); result.put("az", acceleration[2]);
            result.put("timestamp", latestTimestamp); result.put("running", running);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopSensors();
        getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        call.resolve();
    }

    private void stopSensors() {
        if (manager != null) manager.unregisterListener(this);
        running = false;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        synchronized (this) {
            if (event.sensor.getType() == Sensor.TYPE_ROTATION_VECTOR) {
                float[] q = new float[4];
                SensorManager.getQuaternionFromVector(q, event.values);
                quaternion[0] = q[1]; quaternion[1] = q[2]; quaternion[2] = q[3]; quaternion[3] = q[0];
            } else if (event.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
                System.arraycopy(event.values, 0, gyro, 0, 3);
            } else {
                System.arraycopy(event.values, 0, acceleration, 0, 3);
            }
            latestTimestamp = event.timestamp;
        }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    protected void handleOnDestroy() {
        stopSensors();
        super.handleOnDestroy();
    }
}
