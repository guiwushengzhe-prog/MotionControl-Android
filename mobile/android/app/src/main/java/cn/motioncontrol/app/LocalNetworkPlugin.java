package cn.motioncontrol.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.ComponentName;
import android.content.Intent;
import android.provider.Settings;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;

/**
 * This phone's own IPv4 addresses, which the WebView cannot see.
 *
 * <p>The app has to find the PC by itself. The PC announces its addresses once
 * connected, and that covers every later connection -- but not the first one,
 * and not the case where the address it announced has since changed. Then
 * there is nothing cached to try, and the only thing left is to look.
 *
 * <p>Looking needs a subnet, and a subnet needs this phone's own address. No
 * web API exposes it: WebRTC used to leak it through ICE candidates and modern
 * Chrome replaces those with mDNS names precisely to stop that. Java has it.
 *
 * <p>This matters most over a USB cable. Tethering puts the phone and the PC
 * alone on a small private network, so a scan of it is short and certain to
 * find the right machine -- but the subnet is the vendor's choice, not a
 * standard. AOSP hands out 192.168.42.x; the Honor device this was written
 * against uses 10.119.231.x. Guessing would have been wrong.
 */
@CapacitorPlugin(name = "LocalNetwork")
public class LocalNetworkPlugin extends Plugin {

    /**
     * Tethering screens, most likely first. There is no public Intent action for this page.
     *
     * <p>A list rather than one name because vendors moved it. Measured on the Honor device this
     * was written against: the AOSP-era {@code .TetherSettings} resolves but never comes to the
     * front, {@code android.settings.TETHER_SETTINGS} does not resolve at all, and only
     * {@code Settings$TetherSettingsActivity} actually opens. Resolving each one first is what
     * keeps a name that is wrong here from swallowing the tap -- startActivity does not throw
     * when the component exists and then finishes itself.
     */
    private static final String[] TETHER_SCREENS = {
        "com.android.settings/com.android.settings.Settings$TetherSettingsActivity",
        "com.android.settings/com.android.settings.TetherSettings",
    };
    private static final String TETHER_ACTION = "android.settings.TETHER_SETTINGS";

    @PluginMethod
    public void interfaces(PluginCall call) {
        JSArray found = new JSArray();
        try {
            List<NetworkInterface> all = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface item : all) {
                if (item.isLoopback() || !item.isUp()) {
                    continue;
                }
                for (InterfaceAddress entry : item.getInterfaceAddresses()) {
                    InetAddress address = entry.getAddress();
                    if (!(address instanceof Inet4Address) || address.isLinkLocalAddress()) {
                        continue;
                    }
                    JSObject row = new JSObject();
                    row.put("name", item.getName());
                    row.put("address", address.getHostAddress());
                    row.put("prefix", entry.getNetworkPrefixLength());
                    found.put(row);
                }
            }
        } catch (Exception error) {
            // A phone with no usable interface is the same answer as a phone
            // this call failed on: there is nothing to scan. Reporting an
            // empty list keeps the caller on one path.
            call.resolve(new JSObject().put("interfaces", new JSArray()));
            return;
        }
        call.resolve(new JSObject().put("interfaces", found));
    }

    /**
     * Open the system page the player has to visit, because an app cannot go there for them.
     *
     * <p>There are exactly two ways this phone can reach the PC: the same wireless network, or
     * a USB cable with tethering switched on. Neither can be enabled programmatically -- tethering
     * is guarded by a system permission no ordinary app is granted, and joining a network needs
     * the user to pick it. So the most an app can do is put them one tap from the right screen
     * instead of describing where it is and hoping.
     *
     * <p>The tethering screen has no public Intent action, so this walks TETHER_SCREENS and falls
     * through to the wireless settings page, which is public API and always exists. Landing one
     * level up still beats landing nowhere.
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String which = call.getString("which", "tether");
        if ("wifi".equals(which)) {
            if (startSettings(new Intent(Settings.ACTION_WIFI_SETTINGS))) {
                call.resolve(new JSObject().put("opened", "wifi"));
            } else {
                call.reject("打不开 WiFi 设置页");
            }
            return;
        }
        for (String component : TETHER_SCREENS) {
            Intent tether = new Intent(Intent.ACTION_MAIN, null);
            int slash = component.indexOf('/');
            tether.setComponent(new ComponentName(component.substring(0, slash),
                    component.substring(slash + 1)));
            if (resolves(tether) && startSettings(tether)) {
                call.resolve(new JSObject().put("opened", "tether"));
                return;
            }
        }
        Intent action = new Intent(TETHER_ACTION);
        if (resolves(action) && startSettings(action)) {
            call.resolve(new JSObject().put("opened", "tether"));
            return;
        }
        if (startSettings(new Intent(Settings.ACTION_WIRELESS_SETTINGS))) {
            call.resolve(new JSObject().put("opened", "wireless"));
            return;
        }
        call.reject("打不开网络共享设置页");
    }

    private boolean resolves(Intent intent) {
        try {
            return getContext().getPackageManager().resolveActivity(intent, 0) != null;
        } catch (Exception error) {
            return false;
        }
    }

    private boolean startSettings(Intent intent) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception error) {
            return false;
        }
    }
}
