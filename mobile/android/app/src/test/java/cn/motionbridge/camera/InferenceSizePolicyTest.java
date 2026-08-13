package cn.motionbridge.camera;

import static org.junit.Assert.assertEquals;

import android.util.Size;

import org.junit.Test;

public class InferenceSizePolicyTest {
    private static final Size[] COMMON = {
            new Size(1920, 1080), new Size(1280, 720), new Size(960, 540),
            new Size(640, 480), new Size(640, 360), new Size(480, 270), new Size(320, 240)
    };

    @Test public void balancedPrefersSupported640By360() {
        assertEquals(new Size(640, 360), InferenceSizePolicy.chooseBalanced(COMMON));
    }

    @Test public void weakDeviceFallbackPrefersSupported480By270() {
        assertEquals(new Size(480, 270), InferenceSizePolicy.chooseFallback(COMMON));
    }

    @Test public void relocalizeIsBoundedBelow720p() {
        assertEquals(new Size(960, 540), InferenceSizePolicy.chooseRelocalize(COMMON, new Size(640, 360)));
    }

    @Test public void noHigherRelocalizeSizeKeepsBalanced() {
        Size[] supported = { new Size(640, 360), new Size(480, 270) };
        assertEquals(new Size(640, 360), InferenceSizePolicy.chooseRelocalize(supported, new Size(640, 360)));
    }
}
