package cn.motioncontrol.app;

/** Native bridge contract; independent of the APK or web version string. */
final class NativeCapabilities {
    static final int API = 2;
    static final int PROTOCOL = 1;

    static int minimum(Object value) {
        if (value == null) return 1;
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            return Double.isFinite(number) && number >= 1 && number <= Integer.MAX_VALUE
                    && number == Math.floor(number) ? (int) number : 0;
        }
        if (value instanceof String && ((String) value).matches("[0-9]+")) {
            try { return Integer.parseInt((String) value); }
            catch (NumberFormatException error) { return 0; }
        }
        return 0;
    }

    static boolean supports(int minimumApi, int minimumProtocol) {
        return minimumApi >= 1 && minimumProtocol >= 1
                && minimumApi <= API && minimumProtocol <= PROTOCOL;
    }
}
