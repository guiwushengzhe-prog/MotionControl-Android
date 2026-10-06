package cn.motioncontrol.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ApkUpdatePolicyTest {
    @Test
    public void versionCodeMatchesTheGradleFormula() {
        assertEquals(20302, ApkUpdatePolicy.versionCodeOf("2.3.2"));
        assertEquals(20400, ApkUpdatePolicy.versionCodeOf("2.4.0"));
        assertEquals(31012, ApkUpdatePolicy.versionCodeOf("3.10.12"));
    }

    @Test
    public void malformedVersionsAreRejected() {
        assertEquals(-1, ApkUpdatePolicy.versionCodeOf(null));
        assertEquals(-1, ApkUpdatePolicy.versionCodeOf("2.4"));
        assertEquals(-1, ApkUpdatePolicy.versionCodeOf("2.4.0-beta"));
        assertEquals(-1, ApkUpdatePolicy.versionCodeOf("2.400.0"));
    }

    @Test
    public void onlyStrictlyNewerPackagesInstall() {
        assertTrue(ApkUpdatePolicy.isNewer(20400, 20302));
        assertFalse(ApkUpdatePolicy.isNewer(20302, 20302));
        assertFalse(ApkUpdatePolicy.isNewer(20300, 20302));
        assertFalse(ApkUpdatePolicy.isNewer(-1, 0));
    }

    @Test
    public void onlyFeatureReleasesCountAsFeatures() {
        assertTrue(ApkUpdatePolicy.isFeature("feature"));
        assertFalse(ApkUpdatePolicy.isFeature("system"));
        assertFalse(ApkUpdatePolicy.isFeature(null));
    }
}
