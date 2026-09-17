package cn.motioncontrol.app;

import com.getcapacitor.ProcessedRoute;
import com.getcapacitor.RouteProcessor;

import java.io.File;
import java.io.IOException;

/**
 * Decides, per request, whether a file comes from the APK or from an update.
 *
 * <p>Capacitor's own way to run updated web code is setServerBasePath, which
 * switches the <em>whole</em> served root to a writable directory. That cannot
 * work here: the pose model, the hand model and the MediaPipe WASM live under
 * the same root and weigh 25 MB. Switching the root would orphan them unless
 * all 25 MB were copied into the writable directory first, and copying them is
 * the thing worth avoiding.
 *
 * <p>So the split is per path instead. Everything under /models/ and /wasm/ is
 * always read from the APK; everything else prefers the update directory and
 * falls back to the APK when it is not there. An update therefore carries only
 * the 200 KB of web code that actually changes.
 *
 * <p>Falling back rather than failing is what makes a partial update harmless:
 * a file the update did not include is simply served from the APK.
 */
public class WebUpdateRoutes implements RouteProcessor {

    /** Where Capacitor keeps the built web app inside the APK. */
    private static final String ASSET_ROOT = "public";

    private final File updateRoot;
    private final String updatePrefix;

    public WebUpdateRoutes(File updateRoot) {
        File resolved = null;
        String prefix = null;
        try {
            if (updateRoot != null) {
                resolved = updateRoot.getCanonicalFile();
                prefix = resolved.getPath() + File.separator;
            }
        } catch (IOException error) {
            resolved = null;
        }
        this.updateRoot = resolved;
        this.updatePrefix = prefix;
    }

    @Override
    public ProcessedRoute process(String basePath, String path) {
        String wanted = path == null || path.isEmpty() ? "/index.html" : path;
        File updated = resolve(wanted);
        ProcessedRoute route = new ProcessedRoute();
        if (updated != null) {
            route.setPath(updated.getAbsolutePath());
            route.setAsset(false);
            return route;
        }
        route.setPath(ASSET_ROOT + wanted);
        route.setAsset(true);
        route.setIgnoreAssetPath(true);
        return route;
    }

    /** The updated file for this request, or null to fall back to the APK. */
    private File resolve(String path) {
        if (updateRoot == null || fromApkOnly(path)) {
            return null;
        }
        try {
            File candidate = new File(updateRoot, path.replaceFirst("^/+", "")).getCanonicalFile();
            // 请求是 WebView 发来的字符串，不能因为"应该是我们自己的页面发的"就免检。
            if (!candidate.getPath().startsWith(updatePrefix) || !candidate.isFile()) {
                return null;
            }
            return candidate;
        } catch (IOException error) {
            return null;
        }
    }

    /** 模型和 WASM 有 25 MB，永远留在 APK 里，不进更新包也不复制出来。 */
    private static boolean fromApkOnly(String path) {
        return path.startsWith("/models/") || path.startsWith("/wasm/");
    }
}
