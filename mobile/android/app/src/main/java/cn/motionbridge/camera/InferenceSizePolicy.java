package cn.motionbridge.camera;

import android.util.Size;

import java.util.Arrays;

/** Device-neutral analysis size policy used by the native pose pipeline. */
final class InferenceSizePolicy {
    private static final Size BALANCED = new Size(640, 360);
    private static final Size FALLBACK = new Size(480, 270);
    private static final Size RELOCALIZE = new Size(960, 540);

    private InferenceSizePolicy() { }

    static Size chooseBalanced(Size[] supported) { return choose(supported, BALANCED); }

    static Size chooseFallback(Size[] supported) { return choose(supported, FALLBACK); }

    static Size chooseRelocalize(Size[] supported, Size balanced) {
        if (supported == null || supported.length == 0) return balanced;
        Size selected = choose(supported, RELOCALIZE);
        long balancedArea = area(balanced);
        // Relocalization must add useful detail, but never default to a full 720p analysis stream.
        return area(selected) > balancedArea && area(selected) <= 960L * 540L ? selected : balanced;
    }

    private static Size choose(Size[] supported, Size target) {
        if (supported == null || supported.length == 0) return target;
        return Arrays.stream(supported)
                .min((left, right) -> Long.compare(score(left, target), score(right, target)))
                .orElse(supported[0]);
    }

    private static long score(Size size, Size target) {
        long aspectPenalty = Math.abs(size.getWidth() * 9L - size.getHeight() * 16L) * 10_000L;
        long areaPenalty = Math.abs(area(size) - area(target));
        return aspectPenalty + areaPenalty;
    }

    private static long area(Size size) { return (long) size.getWidth() * size.getHeight(); }
}
