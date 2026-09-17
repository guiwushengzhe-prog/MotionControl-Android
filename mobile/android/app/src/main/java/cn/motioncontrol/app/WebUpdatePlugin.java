package cn.motioncontrol.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;

/**
 * Fetches the web bundle the paired PC is carrying.
 *
 * <p>Roughly half the changes to this app touch only web code -- 200 KB of the
 * 28.8 MB package. Making everyone sideload a new APK for those is why small
 * fixes never reach anyone. The PC release already has to be updated, so it
 * carries the phone's web bundle too and hands it over on the local link.
 *
 * <p>The download goes to a staging directory, not to the one being served.
 * Rewriting files under a page that is currently running is a good way to get
 * a half-old, half-new app; instead the swap happens at the next launch, in
 * {@link MainActivity}, where nothing is loaded yet.
 *
 * <p>Whether a bundle may run is decided by {@link BundleSignature}, before a
 * single byte is downloaded. An unsigned one is not an error to work around --
 * it is simply not installed, and the APK's own copy keeps running.
 */
@CapacitorPlugin(name = "WebUpdate")
public class WebUpdatePlugin extends Plugin {

    static final String STAGING_DIR = "web_next";
    private static final String MANIFEST_ROUTE = "/api/bundle/phone-web";
    private static final String FILE_ROUTE = "/api/bundle/phone-web/file?path=";

    /**
     * The web app reached the point where it runs, so this bundle is not a
     * brick. Clears the mark {@link MainActivity} leaves at launch; if that
     * mark is ever still there at the next launch, the bundle is dropped and
     * the APK's own copy takes over.
     */
    @PluginMethod
    public void bootOk(PluginCall call) {
        new File(getContext().getFilesDir(), MainActivity.BOOT_MARK).delete();
        call.resolve();
    }

    /**
     * Download the PC's bundle if it differs from what is already staged or
     * running. Resolves with what happened so the UI can say something true.
     */
    @PluginMethod
    public void sync(PluginCall call) {
        final String raw = call.getString("baseUrl", "");
        new Thread(() -> {
            try {
                call.resolve(run(raw));
            } catch (Exception error) {
                // 更新失败不该拦住任何事：手机继续用 APK 里那份，照样能玩。
                JSObject result = new JSObject();
                result.put("state", "failed");
                result.put("message", error.getMessage() == null ? "更新失败" : error.getMessage());
                call.resolve(result);
            }
        }, "web-update").start();
    }

    private JSObject run(String raw) throws IOException {
        JSObject result = new JSObject();
        String base = raw == null ? "" : raw.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        if (base.isEmpty()) {
            result.put("state", "skipped");
            return result;
        }

        JSONObject manifest = ManifestSync.manifest(base, MANIFEST_ROUTE);
        if (!manifest.optBoolean("available", false)) {
            // 从仓库直接跑的电脑端没有这一份，那不是错误，只是没有更新可拿。
            result.put("state", "none");
            return result;
        }
        String digest = manifest.optString("digest", "");
        result.put("digest", digest);

        File files = getContext().getFilesDir().getCanonicalFile();
        File live = new File(files, MainActivity.WEB_UPDATE_DIR);
        if (!digest.isEmpty() && digest.equals(ManifestSync.readMarker(live))) {
            result.put("state", "current");
            return result;
        }

        // 验签排在下载之前：连一个字节都不该为没签名的包花出去。
        long issuedAt = BundleSignature.accept(manifest, digest, BundleSignature.readIssued(live));
        if (issuedAt < 0) {
            result.put("state", "unsigned");
            return result;
        }

        File staging = new File(files, STAGING_DIR).getCanonicalFile();
        if (!digest.isEmpty() && digest.equals(ManifestSync.readMarker(staging))) {
            // 文件已经在了，但验签结果还是要记上：上一次可能是验签功能加进来之前
            // 下的，那样的包不会被提供，等于白下一次。
            BundleSignature.writeIssued(staging, issuedAt);
            result.put("state", "ready");
            return result;
        }
        if (!staging.mkdirs() && !staging.isDirectory()) {
            throw new IOException("无法创建更新目录");
        }
        ManifestSync.clearMarker(staging);
        String settled = ManifestSync.sync(manifest, staging,
                staging.getPath() + File.separator, base, FILE_ROUTE,
                (done, total) -> notifyListeners("webUpdateProgress",
                        new JSObject().put("done", done).put("total", total)));
        BundleSignature.writeIssued(staging, issuedAt);
        ManifestSync.writeMarker(staging, settled);
        result.put("state", "ready");
        return result;
    }
}
