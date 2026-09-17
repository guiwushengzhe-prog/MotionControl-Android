package cn.motioncontrol.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
}
