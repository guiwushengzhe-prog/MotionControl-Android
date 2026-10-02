package cn.motioncontrol.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class SensorSampleStateTest {
    @Test
    public void restartClearsOldPoseAndDiscardsEventsFromPreviousRun() {
        SensorSampleState state = new SensorSampleState();
        state.reset(1_000_000);
        state.setQuaternion(new float[]{0f, 0f, 1f, 0f}, 2_000_000);
        state.setGyro(new float[]{1f, 2f, 3f}, 2_000_000);
        state.setAcceleration(new float[]{0f, 9.8f, 0f}, 2_000_000);
        state.reset(3_000_000);
        state.setGyro(new float[]{9f, 9f, 9f}, 2_500_000);
        state.setQuaternion(new float[]{0f, 0f, 1f, 0f}, 2_500_000);
        assertEquals(0, state.gyroTimestamp);
        assertEquals(0, state.rotationTimestamp);
        assertEquals(0, state.accelerationTimestamp);
        assertArrayEquals(new float[]{0f, 0f, 0f}, state.gyro, 0f);
        assertArrayEquals(new float[]{0f, 0f, 0f, 1f}, state.quaternion, 0f);
        assertArrayEquals(new float[]{0f, 0f, 0f}, state.acceleration, 0f);
    }

    @Test
    public void eachSensorKeepsItsOwnAgeAndGyroIntegrationClock() {
        SensorSampleState state = new SensorSampleState();
        state.reset(1_000_000);
        state.setGyro(new float[]{1f, 2f, 3f}, 2_000_000);
        state.setQuaternion(new float[]{0f, 0f, 0f, 1f}, 4_000_000);
        state.setAcceleration(new float[]{0f, 9.8f, 0f}, 5_000_000);
        assertEquals(2_000_000, state.gyroTimestamp);
        assertEquals(8.0, SensorSampleState.ageMs(state.gyroTimestamp, 10_000_000), 0);
        assertEquals(6.0, SensorSampleState.ageMs(state.rotationTimestamp, 10_000_000), 0);
        assertEquals(5.0, SensorSampleState.ageMs(state.accelerationTimestamp, 10_000_000), 0);
        assertEquals(-1.0, SensorSampleState.ageMs(0, 10_000_000), 0);
    }

    @Test
    public void malformedAndOutOfOrderEventsCannotReplaceValidSamples() {
        SensorSampleState state = new SensorSampleState();
        state.reset(1);
        state.setGyro(new float[]{1f, 2f, 3f}, 3);
        state.setGyro(new float[]{9f, 9f, 9f}, 2);
        state.setGyro(new float[]{Float.NaN, 2f, 3f}, 4);
        state.setQuaternion(new float[]{0f, 0f, 0f, 0f}, 4);
        assertEquals(3, state.gyroTimestamp);
        assertEquals(0, state.rotationTimestamp);
        assertArrayEquals(new float[]{1f, 2f, 3f}, state.gyro, 0f);
    }
}
