package cn.motioncontrol.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Updates the APK itself from inside the app.
 *
 * <p>The web half of the app hot-updates through the PC; the native half (plugins,
 * permissions, Capacitor itself) can only change with a new APK, and asking people
 * to find and sideload a file is why native fixes reached almost nobody. This finds
 * the signed APK the update server is offering, downloads it, and hands it to the
 * system installer. Android never installs silently: the person still confirms,
 * and the system refuses any package not signed with this app's key.
 *
 * <p>Same trust model as the web bundle: one public key ({@link BundleSignature})
 * vouches for the listing before a single byte of the APK is fetched, every file is
 * checked against its digest, and only a strictly newer versionCode of this exact
 * package is handed to the installer.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    static final String DEFAULT_BASE = "https://motioncontrol.guiwu-aware.icu";
    private static final String MANIFEST_ROUTE = "/api/v1/app-update/android";
    private static final String FILE_ROUTE = "/api/v1/app-update/android/file?path=";
    private static final String DIRECTORY = "apk_update";

    private volatile boolean downloading;

    /** What the server offers, compared with what is installed. Downloads only apk.json. */
    @PluginMethod
    public void check(PluginCall call) {
        final String base = base(call);
        new Thread(() -> {
            try {
                call.resolve(checkNow(base));
            } catch (Exception error) {
                call.resolve(failed(error));
            }
        }, "app-update-check").start();
    }

    /** Download the APK into the cache, verify it, and report it ready to install. */
    @PluginMethod
    public void download(PluginCall call) {
        if (downloading) {
            call.reject("正在下载新版", "BUSY");
            return;
        }
        downloading = true;
        final String base = base(call);
        new Thread(() -> {
            try {
                call.resolve(downloadNow(base));
            } catch (Exception error) {
                call.resolve(failed(error));
            } finally {
                downloading = false;
            }
        }, "app-update-download").start();
    }

    /** Open the system installer for the downloaded APK, or the permission page first. */
    @PluginMethod
    public void install(PluginCall call) {
        try {
            File apk = new File(directory(), ApkUpdatePolicy.APK_NAME);
            if (!apk.isFile()) {
                call.reject("新版还没下载", "NOT_READY");
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !getContext().getPackageManager().canRequestPackageInstalls()) {
                // 安卓 8 起要用户亲手允许"这个 App 可以安装应用"，回来再点一次更新。
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
                call.resolve(new JSObject().put("state", "permission"));
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("state", "installing"));
        } catch (Exception error) {
            call.resolve(failed(error));
        }
    }

    private JSObject checkNow(String base) throws Exception {
        JSObject result = new JSObject();
        JSONObject manifest = ManifestSync.manifest(base, MANIFEST_ROUTE);
        if (!manifest.optBoolean("available", false)) {
            result.put("state", "none");
            return result;
        }
        // 验签排在下载之前：没签名或签错的清单，连说明文件都不取。
        if (BundleSignature.accept(manifest, manifest.optString("digest", ""), 0L) < 0) {
            result.put("state", "unsigned");
            return result;
        }
        JSONObject infoEntry = entry(manifest, ApkUpdatePolicy.INFO_NAME);
        JSONObject apkEntry = entry(manifest, ApkUpdatePolicy.APK_NAME);
        if (infoEntry == null || apkEntry == null || infoEntry.optLong("size", -1L) > ApkUpdatePolicy.INFO_LIMIT) {
            throw new IOException("更新清单不完整");
        }
        File directory = directory();
        File infoFile = new File(directory, ApkUpdatePolicy.INFO_NAME + ".check");
        ManifestSync.fetchEntry(base, FILE_ROUTE, infoEntry, infoFile, () -> false);
        JSONObject info = new JSONObject(readSmall(infoFile));
        infoFile.delete();

        String version = info.optString("version_name", "");
        long code = info.optLong("version_code", ApkUpdatePolicy.versionCodeOf(version));
        if (!ApkUpdatePolicy.isNewer(code, installedVersionCode())) {
            // 已经装上了（或者服务器上是旧的）：上次下的安装包没用了，不白占 30 MB。
            deleteApk(directory);
            result.put("state", "current");
            return result;
        }
        result.put("state", "available");
        result.put("version", version);
        result.put("size", apkEntry.optLong("size", 0L));
        result.put("kind", ApkUpdatePolicy.isFeature(info.optString("kind", "")) ? "feature" : "system");
        JSONArray sections = info.optJSONArray("sections");
        result.put("sections", sections == null ? new JSONArray() : sections);
        result.put("downloaded", isDownloaded(directory, manifest));
        return result;
    }

    private JSObject downloadNow(String base) throws Exception {
        JSONObject manifest = ManifestSync.manifest(base, MANIFEST_ROUTE);
        if (!manifest.optBoolean("available", false)
                || BundleSignature.accept(manifest, manifest.optString("digest", ""), 0L) < 0) {
            throw new IOException("服务器上的新版签名不对，没有下载");
        }
        File directory = directory();
        String prefix = directory.getCanonicalPath() + File.separator;
        ManifestSync.clearMarker(directory);
        String settled = ManifestSync.sync(manifest, directory, prefix, base, FILE_ROUTE,
                (done, total) -> notifyListeners("appUpdateProgress",
                        new JSObject().put("done", done).put("total", total)));
        File apk = new File(directory, ApkUpdatePolicy.APK_NAME);
        PackageInfo archive = getContext().getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
        if (archive == null || !getContext().getPackageName().equals(archive.packageName)) {
            deleteApk(directory);
            throw new IOException("下载的不是这个 App 的安装包");
        }
        if (!ApkUpdatePolicy.isNewer(versionCode(archive), installedVersionCode())) {
            deleteApk(directory);
            throw new IOException("下载的安装包不比现在装着的新");
        }
        ManifestSync.writeMarker(directory, settled);
        JSObject result = new JSObject();
        result.put("state", "ready");
        result.put("version", archive.versionName);
        return result;
    }

    private boolean isDownloaded(File directory, JSONObject manifest) {
        String digest = manifest.optString("digest", "");
        return !digest.isEmpty() && digest.equals(ManifestSync.readMarker(directory))
                && new File(directory, ApkUpdatePolicy.APK_NAME).isFile();
    }

    private static JSONObject entry(JSONObject manifest, String path) {
        JSONArray files = manifest.optJSONArray("files");
        if (files == null) return null;
        for (int index = 0; index < files.length(); index++) {
            JSONObject item = files.optJSONObject(index);
            if (item != null && path.equals(item.optString("path"))) return item;
        }
        return null;
    }

    private File directory() throws IOException {
        File directory = new File(getContext().getCacheDir(), DIRECTORY).getCanonicalFile();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建下载目录");
        return directory;
    }

    private static void deleteApk(File directory) {
        new File(directory, ApkUpdatePolicy.APK_NAME).delete();
        ManifestSync.clearMarker(directory);
    }

    private long installedVersionCode() throws PackageManager.NameNotFoundException {
        return versionCode(getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0));
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private static String readSmall(File file) throws IOException {
        if (file.length() > ApkUpdatePolicy.INFO_LIMIT) throw new IOException("说明文件异常地大");
        byte[] buffer = new byte[(int) file.length()];
        try (FileInputStream stream = new FileInputStream(file)) {
            int offset = 0;
            while (offset < buffer.length) {
                int count = stream.read(buffer, offset, buffer.length - offset);
                if (count < 0) break;
                offset += count;
            }
            return new String(buffer, 0, offset, StandardCharsets.UTF_8);
        }
    }

    private static String base(PluginCall call) {
        String raw = call.getString("baseUrl", DEFAULT_BASE);
        String base = raw == null || raw.trim().isEmpty() ? DEFAULT_BASE : raw.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base;
    }

    private static JSObject failed(Exception error) {
        JSObject result = new JSObject();
        result.put("state", "failed");
        result.put("message", error.getMessage() == null ? "更新失败" : error.getMessage());
        return result;
    }
}
