package cn.motioncontrol.app;

/** Makes delayed native work belong to one foreground session. */
final class NativeSessionGate {
    private long generation;
    private boolean foreground = true;
    private boolean destroyed;

    synchronized long begin() { return ++generation; }
    synchronized void cancel() { generation++; }
    synchronized void pause() { foreground = false; generation++; }
    synchronized void suspend() { foreground = false; }
    synchronized void resume() { if (!destroyed) foreground = true; }
    synchronized void destroy() { destroyed = true; foreground = false; generation++; }
    synchronized boolean isCurrent(long expected) {
        return !destroyed && foreground && expected == generation;
    }
    synchronized boolean isGeneration(long expected) { return !destroyed && expected == generation; }
}
