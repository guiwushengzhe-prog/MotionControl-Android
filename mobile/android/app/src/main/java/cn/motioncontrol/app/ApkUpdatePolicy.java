package cn.motioncontrol.app;

/**
 * Pure rules for in-app APK updates, kept free of Android types so they can be
 * unit-tested on the JVM.
 */
final class ApkUpdatePolicy {
    /** 云端更新包里固定的两个文件名：安装包本身和它的说明。 */
    static final String APK_NAME = "MotionControl.apk";
    static final String INFO_NAME = "apk.json";
    /** 说明文件只有版本号和更新日志，几 KB；比这大得多就不是我们发的。 */
    static final int INFO_LIMIT = 64 * 1024;

    private ApkUpdatePolicy() {
    }

    /**
     * Same formula as app/build.gradle: MAJOR*10000 + MINOR*100 + PATCH.
     * Returns -1 for anything that is not a plain x.y.z version.
     */
    static long versionCodeOf(String versionName) {
        if (versionName == null || !versionName.matches("\\d{1,4}\\.\\d{1,2}\\.\\d{1,2}")) return -1;
        String[] parts = versionName.split("\\.");
        return Long.parseLong(parts[0]) * 10000 + Long.parseLong(parts[1]) * 100 + Long.parseLong(parts[2]);
    }

    /** versionCode 只能往上走：同版本或更旧的包一律不装，挡住降级。 */
    static boolean isNewer(long candidate, long installed) {
        return candidate > 0 && candidate > installed;
    }

    /** 更新日志里写了新增、变更或移除的才算功能更新（规则见电脑端 changelog.py）。 */
    static boolean isFeature(String kind) {
        return "feature".equals(kind);
    }
}
