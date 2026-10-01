package cn.motioncontrol.app;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Two things about the screen the page cannot do by itself.
 *
 * <p>Upside-down portrait. Stood up as a camera, the phone rests on its bottom
 * edge, which is where the charging port is -- with a cable in, it does not
 * stand at all. Turned over, the port is on top, but the manifest locks the
 * app to plain portrait, so the page would be upside down. Only the activity
 * can ask for the other portrait.
 *
 * <p>Status bar icon colour. The app draws edge to edge, so the bar sits on the
 * page's own background. On the light theme the default white icons vanish;
 * the page knows which background it is showing, the window does not.
 */
@CapacitorPlugin(name = "Display")
public class DisplayPlugin extends Plugin {

    @PluginMethod
    public void setOrientation(PluginCall call) {
        boolean reverse = Boolean.TRUE.equals(call.getBoolean("reverse", false));
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            activity.setRequestedOrientation(reverse
                ? ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
                : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            call.resolve();
        });
    }

    @PluginMethod
    public void setBars(PluginCall call) {
        boolean light = Boolean.TRUE.equals(call.getBoolean("light", false));
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
            // light = 浅色背景，要深色图标。
            bars.setAppearanceLightStatusBars(light);
            bars.setAppearanceLightNavigationBars(light);
            call.resolve();
        });
    }
}
