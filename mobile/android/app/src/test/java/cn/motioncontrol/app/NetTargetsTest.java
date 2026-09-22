package cn.motioncontrol.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

/**
 * Where the discovery probe gets sent, and where a fallback scan looks.
 *
 * <p>Both answers are arithmetic on this phone's own address, and both are
 * invisible when wrong: a probe sent to the wrong broadcast address reaches
 * nobody and a scan over the wrong range finds nobody, and each of those looks
 * exactly like "the PC is not running".
 */
public class NetTargetsTest {

    @Test public void broadcastIsComputedForCommonPrefixes() {
        assertEquals("192.168.42.255", NetTargets.broadcastFor("192.168.42.7", 24));
        assertEquals("10.119.231.255", NetTargets.broadcastFor("10.119.231.59", 24));
        assertEquals("10.0.15.255", NetTargets.broadcastFor("10.0.5.9", 20));
        assertEquals("10.0.255.255", NetTargets.broadcastFor("10.0.5.9", 16));
        assertEquals("192.168.42.7", NetTargets.broadcastFor("192.168.42.7", 30));
    }

    @Test public void prefixesWithNoHostRangeHaveNoBroadcast() {
        // /31 and /32 address a single link or a single host; there is nothing
        // to broadcast to, and inventing an address would send the probe to a
        // machine that is not on this link.
        assertNull(NetTargets.broadcastFor("192.168.1.5", 31));
        assertNull(NetTargets.broadcastFor("192.168.1.5", 32));
        assertNull(NetTargets.broadcastFor("192.168.1.5", 0));
        assertNull(NetTargets.broadcastFor("192.168.1.5", -1));
    }

    @Test public void rubbishAddressesGetNoTarget() {
        assertNull(NetTargets.broadcastFor("not an address", 24));
        assertNull(NetTargets.broadcastFor("192.168.1", 24));
        assertNull(NetTargets.broadcastFor("192.168.1.999", 24));
        assertNull(NetTargets.broadcastFor(null, 24));
    }

    @Test public void aWideSubnetIsClampedToOwnSlashTwentyFour() {
        // The rule this replaces was "skip anything wider than /24", which left
        // office and campus networks with no scan at all.
        List<String> hosts = NetTargets.scanWindow("10.4.7.33", 16, 254);
        assertTrue(hosts.size() <= 254);
        assertTrue(hosts.contains("10.4.7.1"));
        assertTrue(hosts.contains("10.4.7.254"));
        assertFalse("不该跨出自己那个 /24", hosts.contains("10.4.8.1"));
        assertFalse("自己的地址不用探", hosts.contains("10.4.7.33"));
    }

    @Test public void aNormalSubnetScansItself() {
        List<String> hosts = NetTargets.scanWindow("192.168.1.10", 24, 254);
        assertEquals(253, hosts.size());
        assertTrue(hosts.contains("192.168.1.1"));
        assertFalse(hosts.contains("192.168.1.10"));
    }

    @Test public void aSmallSubnetScansOnlyWhatExists() {
        List<String> hosts = NetTargets.scanWindow("192.168.1.9", 30, 254);
        assertTrue(hosts.size() <= 3);
        assertFalse(hosts.contains("192.168.1.9"));
    }

    @Test public void theCapIsRespected() {
        assertEquals(10, NetTargets.scanWindow("192.168.1.10", 24, 10).size());
        assertTrue(NetTargets.scanWindow("192.168.1.10", 24, 0).isEmpty());
    }

    @Test public void sameSubnetKnowsWhereTheBoundaryIs() {
        assertTrue(NetTargets.sameSubnet("192.168.1.5", "192.168.1.200", 24));
        assertFalse(NetTargets.sameSubnet("192.168.1.5", "192.168.2.5", 24));
        assertTrue(NetTargets.sameSubnet("10.4.7.5", "10.4.200.5", 16));
        assertFalse(NetTargets.sameSubnet("10.4.7.5", "10.5.7.5", 16));
        assertFalse(NetTargets.sameSubnet("bad", "10.4.7.5", 24));
    }
}
