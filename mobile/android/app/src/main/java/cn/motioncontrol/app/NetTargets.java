package cn.motioncontrol.app;

import java.util.ArrayList;
import java.util.List;

/**
 * Where to send a discovery probe, worked out from this phone's own address.
 *
 * <p>Pure arithmetic, deliberately separate from the plugin so it can be unit
 * tested without a device. Every value here is one the app would otherwise have
 * to guess, and a wrong guess costs a timeout the player reads as 连不上.
 *
 * <p>The broadcast address is always computed rather than read from
 * {@link java.net.InterfaceAddress#getBroadcast()}. That call is allowed to
 * return null, and on a USB tether the value comes from whatever the vendor's
 * rndis driver chose to put in IFA_BROADCAST -- not something to depend on.
 * Computing it costs a shift and an or, and it is right on every prefix.
 * The system's answer is still worth sending to when it exists and differs;
 * it is added as an extra target, never as a replacement.
 */
final class NetTargets {

    private NetTargets() {
    }

    /** Longest prefix that still leaves host addresses to talk to. */
    private static final int MAX_USABLE_PREFIX = 30;

    /**
     * The directed broadcast address for {@code ipv4/prefix}, or null if that
     * pair has no host range worth probing.
     */
    static String broadcastFor(String ipv4, int prefix) {
        if (prefix < 1 || prefix > MAX_USABLE_PREFIX) {
            return null;
        }
        long address = toLong(ipv4);
        if (address < 0) {
            return null;
        }
        long mask = (0xFFFFFFFFL << (32 - prefix)) & 0xFFFFFFFFL;
        return toDotted((address | (~mask & 0xFFFFFFFFL)) & 0xFFFFFFFFL);
    }

    /**
     * Addresses a fallback scan should try, in order.
     *
     * <p>Clamped to the /24 around this phone's own address even when the real
     * subnet is larger. The old rule was to skip anything wider than a /24
     * entirely, which meant a /20 or /16 office network got no scan at all --
     * the one place where the cheap paths are most likely to have failed.
     * A fixed 254 probes is a bounded cost, and DHCP hands out addresses in a
     * contiguous pool, so two devices on the same AP usually land in the same
     * /24. It is not a guarantee; it is much better than doing nothing.
     */
    static List<String> scanWindow(String ipv4, int prefix, int cap) {
        List<String> hosts = new ArrayList<>();
        if (prefix < 1 || prefix > MAX_USABLE_PREFIX || cap <= 0) {
            return hosts;
        }
        long address = toLong(ipv4);
        if (address < 0) {
            return hosts;
        }
        int width = Math.max(prefix, 24);
        long mask = (0xFFFFFFFFL << (32 - width)) & 0xFFFFFFFFL;
        long base = address & mask;
        long span = (~mask & 0xFFFFFFFFL);
        for (long offset = 1; offset < span && hosts.size() < cap; offset++) {
            long candidate = base + offset;
            if (candidate != address) {
                hosts.add(toDotted(candidate));
            }
        }
        return hosts;
    }

    /** Whether two addresses share a subnet of the given prefix. */
    static boolean sameSubnet(String a, String b, int prefix) {
        if (prefix < 0 || prefix > 32) {
            return false;
        }
        long left = toLong(a);
        long right = toLong(b);
        if (left < 0 || right < 0) {
            return false;
        }
        if (prefix == 0) {
            return true;
        }
        long mask = (0xFFFFFFFFL << (32 - prefix)) & 0xFFFFFFFFL;
        return (left & mask) == (right & mask);
    }

    /** Dotted quad to a 32-bit value, or -1 when it is not one. */
    static long toLong(String ipv4) {
        if (ipv4 == null) {
            return -1;
        }
        String[] parts = ipv4.trim().split("\\.");
        if (parts.length != 4) {
            return -1;
        }
        long value = 0;
        for (String part : parts) {
            int octet;
            try {
                octet = Integer.parseInt(part);
            } catch (NumberFormatException exc) {
                return -1;
            }
            if (octet < 0 || octet > 255) {
                return -1;
            }
            value = (value << 8) | octet;
        }
        return value;
    }

    private static String toDotted(long value) {
        return ((value >> 24) & 0xFF) + "." + ((value >> 16) & 0xFF) + "."
                + ((value >> 8) & 0xFF) + "." + (value & 0xFF);
    }
}
