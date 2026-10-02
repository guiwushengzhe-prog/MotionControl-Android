package cn.motioncontrol.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeCapabilitiesTest {
    @Test
    public void legacyRequirementsRemainCompatible() {
        assertTrue(NativeCapabilities.supports(1, 1));
        assertTrue(NativeCapabilities.supports(2, 1));
    }

    @Test
    public void newerOrInvalidRequirementsAreRefused() {
        assertFalse(NativeCapabilities.supports(3, 1));
        assertFalse(NativeCapabilities.supports(2, 2));
        assertFalse(NativeCapabilities.supports(0, 1));
        assertFalse(NativeCapabilities.supports(1, -1));
    }

    @Test
    public void missingMetadataDefaultsToLegacyButMalformedMetadataDoesNot() {
        assertEquals(1, NativeCapabilities.minimum(null));
        assertEquals(2, NativeCapabilities.minimum("2"));
        assertEquals(0, NativeCapabilities.minimum("unknown"));
        assertEquals(0, NativeCapabilities.minimum(1.5));
        assertEquals(0, NativeCapabilities.minimum(Double.NaN));
        assertEquals(0, NativeCapabilities.minimum(4_294_967_297L));
        assertEquals(0, NativeCapabilities.minimum("99999999999999"));
    }
}
