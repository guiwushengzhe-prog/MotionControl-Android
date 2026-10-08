package cn.motioncontrol.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;
import java.util.UUID;

/**
 * 读手环、心率带的「心率广播」：标准蓝牙心率服务（0x180D），谁都能连，不用厂商协议。
 *
 * <p>只做标准心率这一件事：找到正在广播心率的设备，订阅心率测量（0x2A37），收到就交给网页。
 * 不碰手环和原厂应用之间的连接，不写厂商的特征，不配对。手环停止广播或走远了就断开，
 * 网页还开着就接着找。
 */
@CapacitorPlugin(name = "HeartRate", permissions = {
        // 安卓 12 起：附近的设备。清单里写了 neverForLocation，不拿扫描结果定位。
        @Permission(alias = "nearby", strings = {
                Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT
        }),
        // 安卓 11 及以下系统规定低功耗蓝牙扫描要位置权限，没有别的办法。
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION })
})
@SuppressLint("MissingPermission") // 每个蓝牙入口都先过 hasPermissions()。
public class HeartRatePlugin extends Plugin {
    static final UUID HEART_RATE_SERVICE = uuid16(0x180D);
    static final UUID HEART_RATE_MEASUREMENT = uuid16(0x2A37);
    static final UUID CLIENT_CONFIG = uuid16(0x2902);
    private static final ParcelUuid HEART_RATE_PARCEL = new ParcelUuid(HEART_RATE_SERVICE);
    /** 连上了却一直没有心率进来，多半是连错了设备，换一个。 */
    private static final long SILENT_LIMIT_MS = 8000;
    private static final long RETRY_MS = 1500;
    /** 找了这么久还没找到（手环没开广播），改成省电的慢扫，玩一整局也不怎么耗电。 */
    private static final long EAGER_SCAN_MS = 30000;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private String deviceName = "";
    private String deviceAddress = "";
    /** 网页要不要心率。要的时候断了就接着找，不要了就全部停下。 */
    private boolean wanted;
    private boolean scanning;
    private boolean subscribed;
    private String state = "off";
    private String message = "";
    private long lastBeatAt;
    /** 这一轮从什么时候开始找；连上收到心率就清零。 */
    private long searchingSince;
    private int epoch;
    private final Runnable beginTask = this::begin;

    static UUID uuid16(int value) {
        return UUID.fromString(String.format("0000%04x-0000-1000-8000-00805f9b34fb", value));
    }

    @Override
    public void load() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager != null ? manager.getAdapter() : null;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        ui.post(() -> call.resolve(status()));
    }

    @PluginMethod
    public void start(PluginCall call) {
        ui.post(() -> {
            wanted = true;
            if (!hasPermissions()) {
                requestPermissionForAlias(Build.VERSION.SDK_INT >= 31 ? "nearby" : "location", call, "afterPermission");
                return;
            }
            begin();
            call.resolve(status());
        });
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (!hasPermissions()) {
            wanted = false;
            setState("permission", Build.VERSION.SDK_INT >= 31 ? "需要允许「附近的设备」才能读手环心率" : "需要允许位置权限才能找到手环（安卓 11 及以下系统的规定）");
        } else if (wanted) {
            begin();
        }
        if (call != null) call.resolve(status());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ui.post(() -> {
            wanted = false;
            halt();
            setState("off", "");
            call.resolve(status());
        });
    }

    @Override
    protected void handleOnDestroy() {
        wanted = false;
        halt();
    }

    private void begin() {
        if (!wanted || gatt != null || scanning) return;
        if (adapter == null || !getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            setState("unsupported", "这台手机不支持低功耗蓝牙");
            return;
        }
        if (!isEnabled()) {
            setState("bluetooth_off", "打开手机蓝牙后才能读手环心率");
            later(3000);
            return;
        }
        if (Build.VERSION.SDK_INT < 31 && !locationOn()) {
            setState("location_off", "安卓 11 及以下要打开定位才能找到手环");
            later(3000);
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            later(3000);
            return;
        }
        long now = System.currentTimeMillis();
        if (searchingSince == 0) searchingSince = now;
        boolean eager = now - searchingSince < EAGER_SCAN_MS;
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(eager ? ScanSettings.SCAN_MODE_LOW_LATENCY : ScanSettings.SCAN_MODE_LOW_POWER).build();
        try {
            // 不加过滤：有的设备把心率服务写在扫描应答里，过滤器只看广播包会漏掉。
            // 结果在回调里按服务编号挑，别的设备看一眼就丢。
            scanner.startScan(null, settings, scanCallback);
            scanning = true;
            setState("scanning", "在手环上打开「心率广播」");
            if (eager) ui.postDelayed(() -> {
                // 还在找：停下来按省电的方式重新开始。
                if (scanning && gatt == null) { stopScan(); begin(); }
            }, searchingSince + EAGER_SCAN_MS - now);
        } catch (RuntimeException exc) {
            setState("error", "找手环失败：" + exc.getMessage());
            later(3000);
        }
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            ui.post(() -> consider(result));
        }

        @Override
        public void onScanFailed(int errorCode) {
            ui.post(() -> {
                scanning = false;
                setState("error", "找手环失败（" + errorCode + "），稍后重试");
                later(3000);
            });
        }
    };

    private void consider(ScanResult result) {
        if (!wanted || !scanning || gatt != null || result == null) return;
        ScanRecord record = result.getScanRecord();
        List<ParcelUuid> services = record != null ? record.getServiceUuids() : null;
        if (services == null || !services.contains(HEART_RATE_PARCEL)) return;
        String remembered = prefs().getString("address", "");
        BluetoothDevice device = result.getDevice();
        // 认识的那只优先；没见过别的心率设备就用眼前这一只。
        if (!remembered.isEmpty() && !remembered.equals(device.getAddress()) && result.getRssi() < -80) return;
        stopScan();
        connect(device, record.getDeviceName());
    }

    private void connect(BluetoothDevice device, String advertisedName) {
        int mine = ++epoch;
        deviceAddress = device.getAddress();
        String name = advertisedName;
        if (name == null || name.isEmpty()) {
            try { name = device.getName(); } catch (RuntimeException ignored) { name = null; }
        }
        deviceName = name == null || name.isEmpty() ? "心率设备" : name;
        subscribed = false;
        lastBeatAt = 0;
        setState("connecting", "正在连接 " + deviceName);
        try {
            gatt = device.connectGatt(getContext(), false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        } catch (RuntimeException exc) {
            gatt = null;
        }
        if (gatt == null) {
            retry();
            return;
        }
        ui.postDelayed(() -> {
            // 连上了却一直没有心率：可能是别人家的设备，或者广播刚好关了。断开重新找。
            if (mine == epoch && gatt != null && lastBeatAt == 0) {
                closeGatt();
                retry();
            }
        }, SILENT_LIMIT_MS);
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            ui.post(() -> {
                if (g != gatt) return;
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    if (!g.discoverServices()) {
                        closeGatt();
                        retry();
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    closeGatt();
                    retry();
                }
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            ui.post(() -> {
                if (g != gatt) return;
                BluetoothGattService service = g.getService(HEART_RATE_SERVICE);
                BluetoothGattCharacteristic measurement = service != null ? service.getCharacteristic(HEART_RATE_MEASUREMENT) : null;
                BluetoothGattDescriptor config = measurement != null ? measurement.getDescriptor(CLIENT_CONFIG) : null;
                if (config == null || !g.setCharacteristicNotification(measurement, true)) {
                    closeGatt();
                    retry();
                    return;
                }
                boolean written;
                if (Build.VERSION.SDK_INT >= 33) {
                    written = g.writeDescriptor(config, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == 0;
                } else {
                    config.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    written = g.writeDescriptor(config);
                }
                if (!written) {
                    closeGatt();
                    retry();
                    return;
                }
                subscribed = true;
                setState("connected", deviceName);
            });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic characteristic, byte[] value) {
            beat(g, characteristic, value);
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic characteristic) {
            // 安卓 13 起走上面那个，这里不再处理，免得一次心率报两遍。
            if (Build.VERSION.SDK_INT < 33) beat(g, characteristic, characteristic.getValue());
        }
    };

    private void beat(BluetoothGatt g, BluetoothGattCharacteristic characteristic, byte[] value) {
        if (!HEART_RATE_MEASUREMENT.equals(characteristic.getUuid())) return;
        int bpm = HeartRateMeasurement.bpm(value);
        boolean off = HeartRateMeasurement.offSkin(value);
        long at = System.currentTimeMillis();
        ui.post(() -> {
            if (g != gatt || bpm < 0) return;
            if (lastBeatAt == 0) prefs().edit().putString("address", deviceAddress).apply();
            searchingSince = 0;
            lastBeatAt = at;
            if (off) return;
            JSObject data = new JSObject();
            data.put("bpm", bpm);
            data.put("at", at);
            data.put("device", deviceName);
            notifyListeners("heartRate", data);
        });
    }

    private void retry() {
        if (!wanted) return;
        setState("scanning", "在手环上打开「心率广播」");
        later(RETRY_MS);
    }

    /** 过一会儿再试。只排一个，重复叫不会越积越多。 */
    private void later(long delayMs) {
        ui.removeCallbacks(beginTask);
        ui.postDelayed(beginTask, delayMs);
    }

    private void stopScan() {
        if (!scanning) return;
        scanning = false;
        try {
            if (scanner != null && isEnabled()) scanner.stopScan(scanCallback);
        } catch (RuntimeException ignored) {
            // 蓝牙正好关了：扫描本来也停了。
        }
    }

    private void closeGatt() {
        epoch++;
        subscribed = false;
        BluetoothGatt old = gatt;
        gatt = null;
        if (old == null) return;
        try {
            old.disconnect();
            old.close();
        } catch (RuntimeException ignored) {
            // 已经断了。
        }
    }

    private void halt() {
        searchingSince = 0;
        ui.removeCallbacksAndMessages(null);
        stopScan();
        closeGatt();
    }

    private void setState(String next, String text) {
        state = next;
        message = text;
        notifyListeners("heartRateState", status());
    }

    private JSObject status() {
        JSObject data = new JSObject();
        data.put("state", state);
        data.put("message", message);
        data.put("device", subscribed ? deviceName : "");
        data.put("wanted", wanted);
        return data;
    }

    private boolean hasPermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return granted(Manifest.permission.BLUETOOTH_SCAN) && granted(Manifest.permission.BLUETOOTH_CONNECT);
        }
        return granted(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isEnabled() {
        try { return adapter != null && adapter.isEnabled(); }
        catch (RuntimeException ignored) { return false; }
    }

    private boolean locationOn() {
        LocationManager manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return true;
        if (Build.VERSION.SDK_INT >= 28) return manager.isLocationEnabled();
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences("heart_rate", Context.MODE_PRIVATE);
    }
}
