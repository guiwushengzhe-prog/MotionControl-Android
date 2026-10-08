package cn.motioncontrol.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class HeartRateMeasurementTest {
    @Test
    public void readsOneAndTwoByteHeartRates() {
        assertEquals(72, HeartRateMeasurement.bpm(new byte[] {0x00, 72}));
        assertEquals(180, HeartRateMeasurement.bpm(new byte[] {0x00, (byte) 180}));
        assertEquals(130, HeartRateMeasurement.bpm(new byte[] {0x01, (byte) 130, 0x00}));
        // 后面跟着能量、RR 间期也照样只读心率。
        assertEquals(95, HeartRateMeasurement.bpm(new byte[] {0x10, 95, 0x20, 0x03}));
    }

    @Test
    public void refusesTruncatedOrImpossibleValues() {
        assertEquals(-1, HeartRateMeasurement.bpm(null));
        assertEquals(-1, HeartRateMeasurement.bpm(new byte[] {0x00}));
        assertEquals(-1, HeartRateMeasurement.bpm(new byte[] {0x01, 100}));
        assertEquals(-1, HeartRateMeasurement.bpm(new byte[] {0x00, 0}));
        assertEquals(-1, HeartRateMeasurement.bpm(new byte[] {0x01, (byte) 0xff, 0x01}));
    }

    @Test
    public void knowsWhenTheBandIsNotOnTheSkin() {
        assertTrue(HeartRateMeasurement.offSkin(new byte[] {0x04, 80}));
        assertFalse(HeartRateMeasurement.offSkin(new byte[] {0x06, 80}));
        assertFalse(HeartRateMeasurement.offSkin(new byte[] {0x00, 80}));
    }
}
