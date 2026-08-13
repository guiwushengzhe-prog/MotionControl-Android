package cn.motionbridge.camera;

import java.util.LinkedHashSet;
import java.util.Set;

/** Pure candidate policy kept separate so vendor-neutral fallback cases are unit-testable. */
final class CameraDiscoveryPolicy {
    private CameraDiscoveryPolicy() { }

    static LinkedHashSet<String> candidates(String[] exposedIds, Set<String> physicalIds) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        java.util.Collections.addAll(result, exposedIds);
        result.addAll(physicalIds);
        return result;
    }
}
