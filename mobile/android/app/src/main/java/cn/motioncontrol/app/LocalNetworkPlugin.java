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

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
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

    /** Wire format, shared with the PC's motioncontrol/discovery.py. */
    private static final byte[] MAGIC_QUERY = "MC-DISCOVER-1".getBytes(StandardCharsets.UTF_8);
    private static final String MAGIC_REPLY = "mc-here-1";
    /**
     * The probe is padded to this and the PC caps its reply at the same number.
     * A reply that can never be longer than the query is what stops the PC from
     * being usable as a DDoS amplifier, so the padding is not decoration -- the
     * PC drops anything shorter.
     */
    private static final int QUERY_BYTES = 512;
    private static final int DISCOVERY_PORT = 8765;
    private static final String LIMITED_BROADCAST = "255.255.255.255";
    /**
     * A Wi-Fi broadcast frame goes out at the lowest basic rate and is never
     * acknowledged, so losing one is ordinary. A second round costs a few
     * hundred bytes and removes most of that.
     */
    private static final long SECOND_ROUND_MS = 300;

    /**
     * Ask every link this phone is on whether a MotionControl PC is there.
     *
     * <p>One packet per interface instead of knocking on 254 doors. The reply
     * carries the PC's own address list, so discovery stops depending on
     * remembering anything -- which matters because the subnet itself moves.
     * Measured over one session on a phone hotspot it went 10.246.192.18 ->
     * 10.57.177.18 -> 10.245.40.245, so a remembered address was not merely
     * stale, its whole network was gone.
     *
     * <p>Broadcast rather than mDNS because mDNS answers are multicast too, and
     * receiving multicast on Android needs a MulticastLock and the permission
     * behind it. Here the question is broadcast and the answer is unicast, and
     * a unicast frame is addressed to this device, so the Wi-Fi chip's
     * power-save filter never drops it. That is what keeps this at zero new
     * permissions.
     *
     * <p>Each interface gets its own socket bound to its own address. A single
     * socket sending to 255.255.255.255 would leave by whichever interface the
     * routing table picked, and the case worth caring about is exactly the one
     * where there are two: a cable plugged in while Wi-Fi is also up.
     */
    @PluginMethod
    public void discover(PluginCall call) {
        final int timeoutMs = clamp(call.getInt("timeoutMs", 900), 200, 5000);
        new Thread(() -> {
            JSArray servers = new JSArray();
            try {
                for (JSObject row : found(collect(timeoutMs))) {
                    servers.put(row);
                }
            } catch (Exception error) {
                // 找不到不是错误，是一个要继续往下走的答案。
            }
            call.resolve(new JSObject().put("servers", servers));
        }, "local-discover").start();
    }

    /**
     * Is a MotionControl PC really listening at this address?
     *
     * <p>The WebView cannot answer this. Its origin is http://localhost and the
     * PC sends no CORS headers, so a fetch there has to be mode:"no-cors",
     * which resolves to an opaque response: no status, no body. Every HTTP
     * server on port 8765 then looks like a hit -- a router admin page, a
     * printer, another dev server. Reading the body is the only way to tell one
     * from the other, and only native code can read it.
     *
     * <p>Three conditions together, because any one alone still lets an
     * impostor through: HTTP 200, a body that parses as JSON, and that JSON
     * carrying both a version string and a models array.
     */
    @PluginMethod
    public void probe(PluginCall call) {
        final String host = call.getString("host", "");
        final int port = clamp(call.getInt("port", DISCOVERY_PORT), 1, 65535);
        final int timeoutMs = clamp(call.getInt("timeoutMs", 600), 100, 5000);
        new Thread(() -> {
            long started = System.nanoTime();
            JSObject answer = new JSObject();
            String version = identify(host, port, timeoutMs);
            answer.put("ok", version != null);
            if (version != null) {
                answer.put("version", version);
            }
            answer.put("rttMs", (System.nanoTime() - started) / 1_000_000);
            call.resolve(answer);
        }, "local-probe").start();
    }

    private static int clamp(Integer value, int low, int high) {
        int raw = value == null ? low : value;
        return Math.max(low, Math.min(high, raw));
    }

    /** GET /api/models and decide whether the answer is ours. Null when it is not. */
    private static String identify(String host, int port, int timeoutMs) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL("http://" + host + ":" + port + "/api/models");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(timeoutMs);
            connection.setReadTimeout(timeoutMs);
            connection.setRequestMethod("GET");
            if (connection.getResponseCode() != 200) {
                return null;
            }
            ByteArrayOutputStream sink = new ByteArrayOutputStream();
            try (InputStream body = connection.getInputStream()) {
                byte[] chunk = new byte[4096];
                int read;
                // 装成 MotionControl 的服务可以回无限长的 body，所以读多少要有
                // 上限——探测不该能把内存吃光。
                while ((read = body.read(chunk)) > 0 && sink.size() < 64 * 1024) {
                    sink.write(chunk, 0, read);
                }
            }
            JSONObject parsed = new JSONObject(sink.toString("UTF-8"));
            if (!(parsed.opt("version") instanceof String) || parsed.optJSONArray("models") == null) {
                return null;
            }
            return parsed.getString("version");
        } catch (Exception error) {
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    /** One probe packet. The nonce lets a reply be matched to this round. */
    private static byte[] probeQuery(String nonce) {
        byte[] body = ("{\"nonce\":\"" + nonce + "\"}").getBytes(StandardCharsets.UTF_8);
        byte[] packet = new byte[Math.max(QUERY_BYTES, MAGIC_QUERY.length + body.length)];
        System.arraycopy(MAGIC_QUERY, 0, packet, 0, MAGIC_QUERY.length);
        System.arraycopy(body, 0, packet, MAGIC_QUERY.length, body.length);
        return packet;   // 其余保持 0：既是填充，也是 JSON 的终止符
    }

    /** Send on every interface, gather whatever answers before the deadline. */
    private static List<JSONObject> collect(int timeoutMs) {
        String nonce = Long.toHexString(System.nanoTime() & 0xFFFFFFFFL);
        byte[] query = probeQuery(nonce);
        List<DatagramSocket> sockets = new ArrayList<>();
        List<Thread> readers = new ArrayList<>();
        List<JSONObject> replies = Collections.synchronizedList(new ArrayList<JSONObject>());
        long deadline = System.currentTimeMillis() + timeoutMs;
        List<JSObject> links = localLinks();
        try {
            for (JSObject link : links) {
                String own = link.getString("address");
                Integer prefix = link.getInteger("prefix");
                DatagramSocket socket;
                try {
                    socket = new DatagramSocket(null);
                    socket.setReuseAddress(false);
                    socket.bind(new InetSocketAddress(InetAddress.getByName(own), 0));
                    socket.setBroadcast(true);
                    socket.setSoTimeout(120);
                } catch (Exception skip) {
                    continue;
                }
                sockets.add(socket);
                Thread reader = new Thread(() -> read(socket, nonce, replies, deadline),
                        "local-discover-rx");
                reader.setDaemon(true);
                reader.start();
                readers.add(reader);
                for (String target : targetsFor(own, prefix == null ? 24 : prefix, link)) {
                    send(socket, query, target);
                }
            }
            sleepUntil(Math.min(deadline, System.currentTimeMillis() + SECOND_ROUND_MS));
            if (replies.isEmpty()) {
                // 第二轮：WiFi 广播不重传也不确认，丢一个包是常事。
                for (int index = 0; index < sockets.size() && index < links.size(); index++) {
                    JSObject link = links.get(index);
                    Integer prefix = link.getInteger("prefix");
                    for (String target : targetsFor(link.getString("address"),
                            prefix == null ? 24 : prefix, link)) {
                        send(sockets.get(index), query, target);
                    }
                }
            }
            sleepUntil(deadline);
        } finally {
            for (Thread reader : readers) {
                reader.interrupt();
            }
            for (DatagramSocket socket : sockets) {
                socket.close();
            }
        }
        return new ArrayList<>(replies);
    }

    private static List<String> targetsFor(String own, int prefix, JSObject link) {
        LinkedHashSet<String> targets = new LinkedHashSet<>();
        String computed = NetTargets.broadcastFor(own, prefix);
        if (computed != null) {
            targets.add(computed);
        }
        if (link != null) {
            String reported = link.getString("broadcast");
            if (reported != null && !reported.isEmpty()) {
                targets.add(reported);
            }
        }
        targets.add(LIMITED_BROADCAST);
        return new ArrayList<>(targets);
    }

    private static void send(DatagramSocket socket, byte[] query, String target) {
        try {
            socket.send(new DatagramPacket(query, query.length,
                    InetAddress.getByName(target), DISCOVERY_PORT));
        } catch (Exception ignored) {
            // 某个目标发不出去很正常（接口刚断之类），别的目标照发。
        }
    }

    private static void read(DatagramSocket socket, String nonce,
                             List<JSONObject> replies, long deadline) {
        byte[] buffer = new byte[2048];
        while (System.currentTimeMillis() < deadline && !socket.isClosed()) {
            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
            try {
                socket.receive(packet);
            } catch (Exception timeoutOrClosed) {
                continue;
            }
            try {
                JSONObject parsed = new JSONObject(new String(packet.getData(), 0,
                        packet.getLength(), StandardCharsets.UTF_8));
                if (!MAGIC_REPLY.equals(parsed.optString("magic"))
                        || !nonce.equals(parsed.optString("nonce"))) {
                    continue;
                }
                // 这个包刚刚走通了这条路，所以它的源地址是实测可达的，比应答
                // 内容里那份"电脑声称可达"的列表更值得信。
                parsed.put("via", packet.getAddress().getHostAddress());
                replies.add(parsed);
            } catch (JSONException ignored) {
                // 不是我们的包。
            }
        }
    }

    private static void sleepUntil(long when) {
        long left = when - System.currentTimeMillis();
        if (left > 0) {
            try {
                Thread.sleep(left);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /** Same filter as interfaces(), so both views of this phone agree. */
    private static List<JSObject> localLinks() {
        List<JSObject> links = new ArrayList<>();
        try {
            for (NetworkInterface item : Collections.list(NetworkInterface.getNetworkInterfaces())) {
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
                    row.put("prefix", (int) entry.getNetworkPrefixLength());
                    if (entry.getBroadcast() != null) {
                        row.put("broadcast", entry.getBroadcast().getHostAddress());
                    }
                    links.add(row);
                }
            }
        } catch (Exception ignored) {
            // 枚举不到就没有目标可发，和没有接口是同一个结果。
        }
        return links;
    }

    /** Fold the raw replies into one row per PC, decided by its instance id. */
    private static List<JSObject> found(List<JSONObject> replies) {
        LinkedHashMap<String, JSObject> byInstance = new LinkedHashMap<>();
        for (JSONObject reply : replies) {
            String instance = reply.optString("instance", reply.optString("via", ""));
            if (byInstance.containsKey(instance)) {
                continue;   // 双网卡的电脑会从两个接口各回一份，那是同一台机器
            }
            JSObject row = new JSObject();
            row.put("host", reply.optString("via"));
            row.put("port", reply.optInt("port", DISCOVERY_PORT));
            row.put("name", reply.optString("name"));
            row.put("version", reply.optString("version"));
            row.put("instance", instance);
            JSONArray listed = reply.optJSONArray("candidates");
            JSArray candidates = new JSArray();
            if (listed != null) {
                for (int index = 0; index < listed.length(); index++) {
                    JSONObject entry = listed.optJSONObject(index);
                    if (entry == null) {
                        continue;
                    }
                    JSObject candidate = new JSObject();
                    candidate.put("host", entry.optString("host"));
                    candidate.put("port", entry.optInt("port", DISCOVERY_PORT));
                    candidate.put("kind", entry.optString("kind", "lan"));
                    candidates.put(candidate);
                }
            }
            row.put("candidates", candidates);
            byInstance.put(instance, row);
        }
        return new ArrayList<>(byInstance.values());
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
