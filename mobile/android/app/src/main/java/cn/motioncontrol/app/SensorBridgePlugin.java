package cn.motioncontrol.app;

import android.content.Context;
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
    private boolean accelerationIncludesGravity = false;
    private boolean rotationAvailable = false;

    @PluginMethod
    public void start(PluginCall call) {
        stopSensors();
        manager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        if (manager == null) {
            call.reject("当前手机没有传感器服务");
            return;
        }
        boolean shooter = "shooter".equals(call.getString("mode", "gamepad"));
        Sensor rotation = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        Sensor gyroscope = manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        Sensor linear = manager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
        Sensor accelerometer = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (gyroscope == null || (!shooter && (rotation == null || (linear == null && accelerometer == null)))) {
            call.reject("当前手机缺少手持体感所需传感器");
            return;
        }
        synchronized (this) { latestTimestamp = 0; }
        if (rotation != null) manager.registerListener(this, rotation, SensorManager.SENSOR_DELAY_GAME);
        if (!manager.registerListener(this, gyroscope, SensorManager.SENSOR_DELAY_GAME)) {
            stopSensors();
            call.reject("无法启动手机陀螺仪");
            return;
        }
        // 射击校准使用含重力的加速度；原网络手柄继续使用去重力的加速度。
        Sensor accelerationSensor = shooter ? accelerometer : (linear != null ? linear : accelerometer);
        boolean accelerationRegistered = accelerationSensor != null && manager.registerListener(this, accelerationSensor, SensorManager.SENSOR_DELAY_GAME);
        accelerationIncludesGravity = accelerationRegistered && accelerationSensor.getType() == Sensor.TYPE_ACCELEROMETER;
        running = true;
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
            result.put("accelerationIncludesGravity", accelerationIncludesGravity);
            result.put("rotationAvailable", rotationAvailable);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopSensors();
        call.resolve();
    }

    private void stopSensors() {
        if (manager != null) manager.unregisterListener(this);
        synchronized (this) {
            running = false;
            rotationAvailable = false;
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        synchronized (this) {
            if (event.sensor.getType() == Sensor.TYPE_ROTATION_VECTOR) {
                float[] q = new float[4];
                SensorManager.getQuaternionFromVector(q, event.values);
                quaternion[0] = q[1]; quaternion[1] = q[2]; quaternion[2] = q[3]; quaternion[3] = q[0];
                rotationAvailable = true;
            } else if (event.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
                System.arraycopy(event.values, 0, gyro, 0, 3);
                // 鼠标积分只使用陀螺仪采样的时间，避免其他传感器重复计入同一角速度。
                latestTimestamp = event.timestamp;
            } else {
                System.arraycopy(event.values, 0, acceleration, 0, 3);
            }
        }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    protected void handleOnDestroy() {
        stopSensors();
        super.handleOnDestroy();
    }
}
