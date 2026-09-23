package cn.motioncontrol.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import java.io.File;

public class MainActivity extends BridgeActivity {
    /** 正在用的网页包；没有它时一切照旧从 APK 读。 */
    static final String WEB_UPDATE_DIR = "web";
    /** 上一次用这个包启动时留下的记号，网页跑起来就会被清掉。 */
    static final String BOOT_MARK = "web.booting";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SensorBridgePlugin.class);
        registerPlugin(NativeAudioPlugin.class);
        registerPlugin(LocalNetworkPlugin.class);
        registerPlugin(WebUpdatePlugin.class);
        // 换包只在这里发生：此刻还没有页面在跑，换掉它脚下的文件才是安全的。
        File live = promoteStagedBundle();
        // 必须在 super.onCreate() 之前：那一句里 bridgeBuilder 就被用来建 Bridge 了。
        bridgeBuilder.setRouteProcessor(new WebUpdateRoutes(live));
        super.onCreate(savedInstanceState);
    }

    /**
     * Swap a finished download into place, and return the bundle to serve.
     *
     * <p>Returns null when there is nothing usable, which makes WebUpdateRoutes
     * fall back to the APK for every request. A directory without its
     * completion marker is exactly that case: a download that never finished
     * must not be served one file at a time.
     */
    private File promoteStagedBundle() {
        File files = getFilesDir();
        File live = new File(files, WEB_UPDATE_DIR);
        File staged = new File(files, WebUpdatePlugin.STAGING_DIR);
        if (!ManifestSync.readMarker(staged).isEmpty()) {
            deleteTree(live);
            if (!staged.renameTo(live)) {
                // 换不过去就当没更新：APK 里那份永远是好的。
                deleteTree(staged);
            }
        }
        // 验过签才会有 .issued，所以它的存在就是"这份包验过"的证据。少了它就
        // 不提供——包括验签功能加进来之前装上的那些。旧的信任不能自动延续。
        long issued = BundleSignature.readIssued(live);
        if (ManifestSync.readMarker(live).isEmpty() || issued <= 0) {
            return null;
        }

        // 装了一个更新的 APK，就把手上这份热更包丢掉。
        //
        // 它优先级比 APK 里那份高，这在平时是对的——热更就是为了盖过去。但覆盖
        // 安装一个新 APK 的时候就反了：新 APK 自带的网页是更新的，却被一份旧的
        // 热更包压着，装了等于没装。真踩过：手机上明明是新版本号，跑的还是上一
        // 版的页面，而且从版本号上完全看不出来。
        //
        // issued 是电脑签发时的 Unix 秒，lastUpdateTime 是毫秒。
        if (issued * 1000L < apkInstalledAt()) {
            deleteTree(live);
            return null;
        }

        // 上一次带着这个包启动，网页没能跑到"我起来了"那一步。签名只证明包是你
        // 发的，不证明它跑得起来——一个能让页面白屏的改动照样签得好好的。而修它
        // 的补丁要走的正是这条通道，所以必须能自己退回去。
        File mark = new File(files, BOOT_MARK);
        if (mark.isFile()) {
            mark.delete();
            deleteTree(live);
            return null;
        }
        try {
            mark.createNewFile();
        } catch (java.io.IOException error) {
            // 记不上号就不敢用它：宁可少一次更新，也不能失去退回的能力。
            return null;
        }
        return live;
    }

    /** When this APK was installed or last overwritten, in milliseconds. */
    private long apkInstalledAt() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
        } catch (Exception error) {
            // Unknown means "do not throw the bundle away": a hot fix that cannot be
            // installed is worse than one that lingers a version too long.
            return 0L;
        }
    }

    private static void deleteTree(File path) {
        File[] children = path.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        path.delete();
    }
}
