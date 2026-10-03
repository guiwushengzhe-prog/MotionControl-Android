package cn.motioncontrol.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SensorBridge")
public class SensorBridgePlugin extends Plugin implements SensorEventListener {
    private SensorManager manager;
    private final SensorSampleState samples = new SensorSampleState();
    private final float[] androidQuaternion = new float[4];
    private final float[] quaternion = new float[4];
    private boolean running = false;
    private boolean accelerationIncludesGravity = false;
    private boolean destroyed;

    @PluginMethod
    public synchronized void start(PluginCall call) {
        if (destroyed) {
            call.reject("传感器会话已结束", "SENSOR_DESTROYED");
            return;
        }
        stopSensors();
        manager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        if (manager == null) {
            call.reject("当前手机没有传感器服务");
            return;
        }
        boolean shooter = "shooter".equals(call.getString("mode", "gamepad"));
        // 手柄只使用相对持握姿态，优先不依赖磁力计的游戏姿态。
        // 鼠标保留原姿态参考，避免已保存的校准四元数跨参考系失效。
        Sensor rotation = shooter ? null : manager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (rotation == null) rotation = manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        Sensor gyroscope = manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        Sensor linear = manager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
        Sensor accelerometer = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (gyroscope == null || (!shooter && (rotation == null || (linear == null && accelerometer == null)))) {
            call.reject("当前手机缺少手持体感所需传感器");
            return;
        }
        synchronized (this) { samples.reset(SystemClock.elapsedRealtimeNanos()); }
        boolean rotationRegistered = registerSensor(rotation);
        if (!shooter && !rotationRegistered && rotation != null
                && rotation.getType() == Sensor.TYPE_GAME_ROTATION_VECTOR) {
            rotationRegistered = registerSensor(manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR));
        }
        if (!shooter && !rotationRegistered) {
            stopSensors();
            call.reject("无法启动手机姿态传感器");
            return;
        }
        if (!registerSensor(gyroscope)) {
            stopSensors();
            call.reject("无法启动手机陀螺仪");
            return;
        }
        // 射击校准使用含重力的加速度；原网络手柄继续使用去重力的加速度。
        Sensor accelerationSensor = shooter ? accelerometer : (linear != null ? linear : accelerometer);
        boolean accelerationRegistered = registerSensor(accelerationSensor);
        if (!shooter && !accelerationRegistered) {
            stopSensors();
            call.reject("无法启动手机加速度传感器");
            return;
        }
        synchronized (this) {
            accelerationIncludesGravity = accelerationRegistered && accelerationSensor.getType() == Sensor.TYPE_ACCELEROMETER;
            running = true;
        }
        call.resolve();
    }

    @PluginMethod
    public void getLatest(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (this) {
            long now = SystemClock.elapsedRealtimeNanos();
            result.put("qx", samples.quaternion[0]); result.put("qy", samples.quaternion[1]);
            result.put("qz", samples.quaternion[2]); result.put("qw", samples.quaternion[3]);
            result.put("gx", samples.gyro[0]); result.put("gy", samples.gyro[1]); result.put("gz", samples.gyro[2]);
            result.put("ax", samples.acceleration[0]); result.put("ay", samples.acceleration[1]); result.put("az", samples.acceleration[2]);
            result.put("timestamp", samples.gyroTimestamp); result.put("running", running);
            result.put("accelerationIncludesGravity", accelerationIncludesGravity);
            result.put("rotationAvailable", running && samples.rotationTimestamp > 0);
            result.put("gyroAvailable", running && samples.gyroTimestamp > 0);
            result.put("accelerationAvailable", running && samples.accelerationTimestamp > 0);
            result.put("sample_age_ms", SensorSampleState.ageMs(samples.gyroTimestamp, now));
            result.put("gyro_age_ms", SensorSampleState.ageMs(samples.gyroTimestamp, now));
            result.put("rotation_age_ms", SensorSampleState.ageMs(samples.rotationTimestamp, now));
            result.put("acceleration_age_ms", SensorSampleState.ageMs(samples.accelerationTimestamp, now));
        }
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopSensors();
        call.resolve();
    }

    private synchronized void stopSensors() {
        synchronized (this) {
            running = false;
            accelerationIncludesGravity = false;
            samples.reset(SystemClock.elapsedRealtimeNanos());
        }
        if (manager != null) manager.unregisterListener(this);
    }

    private boolean registerSensor(Sensor sensor) {
        if (sensor == null) return false;
        try { return manager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME); }
        catch (RuntimeException error) { return false; }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        synchronized (this) {
            if (!running) return;
            if (event.sensor.getType() == Sensor.TYPE_ROTATION_VECTOR
                    || event.sensor.getType() == Sensor.TYPE_GAME_ROTATION_VECTOR) {
                SensorManager.getQuaternionFromVector(androidQuaternion, event.values);
                quaternion[0] = androidQuaternion[1]; quaternion[1] = androidQuaternion[2];
                quaternion[2] = androidQuaternion[3]; quaternion[3] = androidQuaternion[0];
                samples.setQuaternion(quaternion, event.timestamp);
            } else if (event.sensor.getType() == Sensor.TYPE_GYROSCOPE) {
                // 鼠标积分只使用陀螺仪采样的时间，避免其他传感器重复计入同一角速度。
                samples.setGyro(event.values, event.timestamp);
            } else if (event.sensor.getType() == Sensor.TYPE_ACCELEROMETER
                    || event.sensor.getType() == Sensor.TYPE_LINEAR_ACCELERATION) {
                samples.setAcceleration(event.values, event.timestamp);
            }
        }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    protected synchronized void handleOnDestroy() {
        destroyed = true;
        stopSensors();
        super.handleOnDestroy();
    }
}
