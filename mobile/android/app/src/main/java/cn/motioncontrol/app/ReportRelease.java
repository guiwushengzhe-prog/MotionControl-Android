package cn.motioncontrol.app;

/** Try every report even if one send fails; callers decide how to recover. */
final class ReportRelease {
    interface Sender { boolean send(int id, byte[] report); }

    static boolean sendAll(byte[][] reports, Sender sender) {
        boolean released = true;
        for (int id = 1; id < reports.length; id++) {
            try {
                if (!sender.send(id, reports[id])) released = false;
            } catch (RuntimeException error) {
                released = false;
            }
        }
        return released;
    }
}
