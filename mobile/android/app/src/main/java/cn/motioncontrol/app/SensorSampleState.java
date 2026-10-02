package cn.motioncontrol.app;

import java.util.Arrays;

/** Sample validity uses the same monotonic nanosecond clock as SensorEvent. */
final class SensorSampleState {
    final float[] quaternion = new float[]{0f, 0f, 0f, 1f};
    final float[] gyro = new float[3];
    final float[] acceleration = new float[3];
    long gyroTimestamp;
    long rotationTimestamp;
    long accelerationTimestamp;
    private long startedAt;

    void reset(long now) {
        startedAt = now;
        gyroTimestamp = rotationTimestamp = accelerationTimestamp = 0;
        Arrays.fill(quaternion, 0f);
        quaternion[3] = 1f;
        Arrays.fill(gyro, 0f);
        Arrays.fill(acceleration, 0f);
    }

    void setGyro(float[] values, long timestamp) {
        if (!valid(values, 3, timestamp) || timestamp < gyroTimestamp) return;
        System.arraycopy(values, 0, gyro, 0, 3);
        gyroTimestamp = timestamp;
    }

    void setAcceleration(float[] values, long timestamp) {
        if (!valid(values, 3, timestamp) || timestamp < accelerationTimestamp) return;
        System.arraycopy(values, 0, acceleration, 0, 3);
        accelerationTimestamp = timestamp;
    }

    void setQuaternion(float[] values, long timestamp) {
        if (!valid(values, 4, timestamp) || timestamp < rotationTimestamp) return;
        double norm = Math.sqrt(values[0] * values[0] + values[1] * values[1]
                + values[2] * values[2] + values[3] * values[3]);
        if (!Double.isFinite(norm) || norm < 0.5 || norm > 1.5) return;
        for (int index = 0; index < 4; index++) quaternion[index] = (float) (values[index] / norm);
        rotationTimestamp = timestamp;
    }

    private boolean valid(float[] values, int count, long timestamp) {
        if (timestamp <= 0 || timestamp < startedAt || values == null || values.length < count) return false;
        for (int index = 0; index < count; index++) if (!Float.isFinite(values[index])) return false;
        return true;
    }

    static double ageMs(long timestamp, long now) {
        return timestamp <= 0 ? -1 : Math.max(0, (now - timestamp) / 1_000_000.0);
    }
}
