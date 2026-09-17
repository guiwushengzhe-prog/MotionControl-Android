package cn.motioncontrol.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

public class CameraDiscoveryPolicyTest {
    @Test public void singleCameraDoesNotInventVendorSpecificIds() {
        LinkedHashSet<String> ids = CameraDiscoveryPolicy.candidates(new String[]{"0"}, Collections.emptySet());
        assertEquals(Collections.singleton("0"), ids);
    }

    @Test public void nonNumericCameraIdsAreNeverInvented() {
        LinkedHashSet<String> ids = CameraDiscoveryPolicy.candidates(new String[]{"rear"}, Collections.emptySet());
        assertEquals(Collections.singleton("rear"), ids);
    }

    @Test public void physicalIdsFromLogicalMultiCameraAreIncludedWithoutVendorKnowledge() {
        LinkedHashSet<String> ids = CameraDiscoveryPolicy.candidates(new String[]{"logical"}, Set.of("wide", "tele"));
        assertTrue(ids.contains("wide")); assertTrue(ids.contains("tele")); assertFalse(ids.contains("0"));
    }
}
