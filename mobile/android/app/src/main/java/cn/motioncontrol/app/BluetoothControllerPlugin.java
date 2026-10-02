package cn.motioncontrol.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothHidDevice;
import android.bluetooth.BluetoothHidDeviceAppSdpSettings;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** 使用手机系统提供的蓝牙输入设备接口，不依赖电脑体感服务。 */
@CapacitorPlugin(name = "BluetoothController", permissions = {
        @Permission(alias = "bluetooth", strings = {
                Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE
        })
})
@SuppressLint("MissingPermission") // 每个蓝牙入口均通过系统版本和运行时权限检查。
public class BluetoothControllerPlugin extends Plugin {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private BluetoothAdapter adapter;
    private BluetoothHidDevice hid;
    private BluetoothDevice connectedDevice;
    private BluetoothDevice connectingDevice;
    private BluetoothDevice selectedDevice;
    private boolean registered;
    private boolean starting;
    private boolean requested;
    private boolean foreground = true;
    private boolean visible = true;
    private boolean systemPrompt;
    private long promptEpoch;
    private long activePromptEpoch;
    private boolean profileUnavailable;
    private boolean receiverRegistered;
    private byte protocol = BluetoothHidDevice.PROTOCOL_REPORT_MODE;
    private byte keyboardLeds;
    private volatile int sessionId;
    private volatile long reportEpoch;
    private long profileEpoch;
    private long registrationEpoch;
    private long connectionEpoch;
    private String message = "蓝牙输入尚未开启";
    private final byte[][] reports = new byte[4][];

    private final BroadcastReceiver bluetoothChanges = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (BluetoothAdapter.ACTION_STATE_CHANGED.equals(intent.getAction()) && !isEnabled()) {
                stopInternal("蓝牙已关闭，开启后将自动恢复连接", requested);
            } else {
                if (BluetoothAdapter.ACTION_STATE_CHANGED.equals(intent.getAction())
                        && requested && foreground && !systemPrompt && isEnabled()) beginProfile();
                emitState();
            }
        }
    };

    @Override
    public void load() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager != null ? manager.getAdapter() : null;
        resetReports();
        IntentFilter filter = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
        filter.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(bluetoothChanges, filter, Context.RECEIVER_EXPORTED);
        } else {
            getContext().registerReceiver(bluetoothChanges, filter);
        }
        receiverRegistered = true;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        ui.post(() -> call.resolve(status()));
    }

    @PluginMethod
    public void start(PluginCall call) {
        ui.post(() -> {
            if (!basicSupport()) {
                message = unsupportedMessage();
                call.resolve(status());
                return;
            }
            if (systemPrompt) {
                call.reject("请先完成当前蓝牙系统对话框");
                return;
            }
            if (!hasPermissions()) {
                systemPrompt = true;
                activePromptEpoch = promptEpoch;
                requestPermissionForAlias("bluetooth", call, "startAfterPermission");
                return;
            }
            startAfterPermissions(call);
        });
    }

    @PermissionCallback
    private void startAfterPermission(PluginCall call) {
        systemPrompt = false;
        if (call == null) return;
        if (activePromptEpoch != promptEpoch) {
            call.resolve(status());
            return;
        }
        if (!hasPermissions()) {
            message = "需要允许附近设备权限才能使用蓝牙输入";
            call.resolve(status());
            emitState();
            return;
        }
        startAfterPermissions(call);
    }

    private void startAfterPermissions(PluginCall call) {
        if (!isEnabled()) {
            systemPrompt = true;
            activePromptEpoch = promptEpoch;
            try {
                startActivityForResult(call, new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), "afterEnable");
            } catch (RuntimeException error) {
                systemPrompt = false;
                call.reject("无法打开系统蓝牙开关，请在手机设置中开启蓝牙");
            }
            return;
        }
        beginProfile();
        call.resolve(status());
    }

    @ActivityCallback
    private void afterEnable(PluginCall call, ActivityResult result) {
        systemPrompt = false;
        if (activePromptEpoch != promptEpoch) {
            if (call != null) call.resolve(status());
            return;
        }
        if (isEnabled() && hasPermissions()) {
            beginProfile();
        } else {
            message = "蓝牙尚未开启";
            emitState();
        }
        if (call != null) call.resolve(status());
    }

    @PluginMethod
    public void requestDiscoverable(PluginCall call) {
        ui.post(() -> {
            if (!basicSupport() || !hasPermissions() || !isEnabled()) {
                call.reject("请先开启蓝牙输入并允许附近设备权限");
                return;
            }
            if (!registered || systemPrompt) {
                call.reject("请等待蓝牙输入设备就绪后再配对");
                return;
            }
            if (!releaseReports()) {
                recoverInput("蓝牙输入释放失败，正在重新建立连接");
                call.reject("输入释放未送达，请等待蓝牙恢复后再配对");
                return;
            }
            systemPrompt = true;
            activePromptEpoch = promptEpoch;
            Intent intent = new Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE);
            intent.putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, 120);
            try {
                startActivityForResult(call, intent, "afterDiscoverable");
            } catch (RuntimeException error) {
                systemPrompt = false;
                call.reject("无法打开系统蓝牙配对入口，请在手机蓝牙设置中配对");
            }
        });
    }

    @ActivityCallback
    private void afterDiscoverable(PluginCall call, ActivityResult result) {
        systemPrompt = false;
        if (activePromptEpoch != promptEpoch) {
            if (call != null) call.resolve(status());
            return;
        }
        if (requested && isEnabled() && hasPermissions()) {
            // 系统配对对话框可能撤销前台注册；重新创建代理以隔离旧回调。
            stopInternal("正在恢复蓝牙输入设备", true);
            beginProfile();
        }
        message = result.getResultCode() == Activity.RESULT_CANCELED
                ? "已取消配对入口" : "请在电脑蓝牙设置中添加这台手机，完成后选择已配对电脑";
        emitState();
        if (call != null) call.resolve(status());
    }

    private void beginProfile() {
        if (!requested) {
            requested = true;
            sessionId++;
            reportEpoch++;
        }
        if (!foreground) {
            message = "请返回应用后开启蓝牙输入";
            emitState();
            return;
        }
        if (registered || starting) return;
        profileUnavailable = false;
        if (hid != null) {
            registerHid();
            return;
        }
        starting = true;
        message = "正在检查系统蓝牙输入设备支持";
        final long generation = ++profileEpoch;
        try {
            boolean accepted = adapter.getProfileProxy(getContext(), new BluetoothProfile.ServiceListener() {
                @Override
                public void onServiceConnected(int profile, BluetoothProfile proxy) {
                    ui.post(() -> {
                        if (generation != profileEpoch || !requested || !foreground) {
                            adapter.closeProfileProxy(BluetoothProfile.HID_DEVICE, proxy);
                            return;
                        }
                        hid = (BluetoothHidDevice) proxy;
                        registerHid();
                    });
                }

                @Override
                public void onServiceDisconnected(int profile) {
                    ui.post(() -> {
                        if (generation != profileEpoch) return;
                        recoverInput("系统蓝牙输入服务已断开，正在自动恢复");
                    });
                }
            }, BluetoothProfile.HID_DEVICE);
            if (!accepted) {
                profileUnavailable = true;
                stopInternal("当前系统未提供蓝牙输入设备接口", false);
            } else {
                ui.postDelayed(() -> {
                    if (generation != profileEpoch || hid != null || !requested) return;
                    profileUnavailable = true;
                    stopInternal("系统未能启用蓝牙输入设备接口，可改用网络连接", false);
                }, 8000);
            }
        } catch (RuntimeException error) {
            profileUnavailable = true;
            stopInternal("系统不允许启用蓝牙输入设备接口", false);
        }
        emitState();
    }

    private void registerHid() {
        starting = true;
        message = "正在注册蓝牙鼠标和手柄";
        final long generation = ++registrationEpoch;
        BluetoothHidDeviceAppSdpSettings description = new BluetoothHidDeviceAppSdpSettings(
                "MotionControl", "手机鼠标与通用手柄", "MotionControl",
                (byte) (BluetoothHidDevice.SUBCLASS1_COMBO | BluetoothHidDevice.SUBCLASS2_GAMEPAD),
                HidReportCodec.descriptor());
        try {
            if (!hid.registerApp(description, null, null, command -> ui.post(command), callback(generation))) {
                stopInternal("系统拒绝蓝牙输入设备注册，请关闭其他蓝牙手柄应用后重试", false);
            } else {
                ui.postDelayed(() -> {
                    if (generation != registrationEpoch || registered || !starting || !requested) return;
                    stopInternal("系统未完成蓝牙输入注册，请重新开启或改用网络连接", false);
                }, 8000);
            }
        } catch (RuntimeException error) {
            stopInternal("蓝牙输入设备注册失败，请检查附近设备权限", false);
        }
        emitState();
    }

    private BluetoothHidDevice.Callback callback(long generation) {
        return new BluetoothHidDevice.Callback() {
            private boolean current() {
                return generation == registrationEpoch && requested && hid != null;
            }

            @Override
            public void onAppStatusChanged(BluetoothDevice pluggedDevice, boolean ready) {
                if (!current()) return;
                boolean wasRegistered = registered;
                registered = ready;
                starting = false;
                if (!ready) {
                    if (wasRegistered) recoverInput("蓝牙输入注册已停止，正在自动恢复");
                    else stopInternal("系统未接受蓝牙输入注册，请重新开启或改用网络连接", false);
                    return;
                } else {
                    message = "蓝牙输入已就绪，请配对或选择电脑连接";
                    // 系统可能恢复旧的虚拟连接；它不等于用户选中了接收电脑。
                    if (pluggedDevice != null) {
                        if (!visible || !acceptsHost(pluggedDevice)) {
                            rejectHost(pluggedDevice);
                        } else if (hid.getConnectionState(pluggedDevice) == BluetoothProfile.STATE_CONNECTED) {
                            onConnectionStateChanged(pluggedDevice, BluetoothProfile.STATE_CONNECTED);
                            return;
                        }
                    }
                }
                emitState();
            }

            @Override
            public void onConnectionStateChanged(BluetoothDevice device, int state) {
                if (!current()) return;
                if ((state == BluetoothProfile.STATE_CONNECTED || state == BluetoothProfile.STATE_CONNECTING)
                        && (!visible || !registered || !acceptsHost(device))) {
                    rejectHost(device);
                    emitState();
                    return;
                }
                if (state == BluetoothProfile.STATE_CONNECTED) {
                    if (!visible || !registered || (connectingDevice != null && !connectingDevice.equals(device))
                            || (connectedDevice != null && !connectedDevice.equals(device))) {
                        hid.disconnect(device);
                        return;
                    }
                    connectedDevice = device;
                    connectingDevice = null;
                    connectionEpoch++;
                    protocol = BluetoothHidDevice.PROTOCOL_REPORT_MODE;
                    sessionId++;
                    if (!releaseReports()) {
                        recoverInput("蓝牙输入初始状态发送失败，正在自动恢复");
                        return;
                    }
                    message = "已连接 " + deviceName(device);
                } else if (state == BluetoothProfile.STATE_CONNECTING) {
                    if (connectedDevice == null && connectingDevice == null) {
                        connectingDevice = device;
                        watchConnectionTimeout(device);
                    }
                    message = "正在连接 " + deviceName(device);
                } else if ((connectedDevice != null && connectedDevice.equals(device))
                        || (connectingDevice != null && connectingDevice.equals(device))) {
                    releaseReports();
                    connectedDevice = null;
                    connectingDevice = null;
                    sessionId++;
                    message = "蓝牙连接已断开，请重新连接";
                }
                emitState();
            }

            @Override
            public void onGetReport(BluetoothDevice device, byte type, byte id, int bufferSize) {
                if (!current() || !isConnectedHost(device)) return;
                try {
                    byte[] report = null;
                    if (type == BluetoothHidDevice.REPORT_TYPE_INPUT && id > 0 && id < reports.length) {
                        report = reports[id];
                    } else if (type == BluetoothHidDevice.REPORT_TYPE_OUTPUT && id == HidReportCodec.KEYBOARD_ID) {
                        report = new byte[]{keyboardLeds};
                    }
                    if (report == null) {
                        hid.reportError(device, BluetoothHidDevice.ERROR_RSP_INVALID_RPT_ID);
                    } else {
                        hid.replyReport(device, type, id, report);
                    }
                } catch (RuntimeException error) {
                    recoverInput("蓝牙输入连接已失效，正在自动恢复");
                }
            }

            @Override
            public void onSetReport(BluetoothDevice device, byte type, byte id, byte[] data) {
                if (!current() || !isConnectedHost(device)) return;
                if (type == BluetoothHidDevice.REPORT_TYPE_OUTPUT && id == HidReportCodec.KEYBOARD_ID
                        && data != null && data.length == 1) {
                    keyboardLeds = data[0];
                    hid.reportError(device, BluetoothHidDevice.ERROR_RSP_SUCCESS);
                } else {
                    hid.reportError(device, BluetoothHidDevice.ERROR_RSP_INVALID_PARAM);
                }
            }

            @Override
            public void onInterruptData(BluetoothDevice device, byte id, byte[] data) {
                if (current() && isConnectedHost(device) && id == HidReportCodec.KEYBOARD_ID
                        && data != null && data.length == 1) {
                    keyboardLeds = data[0];
                }
            }

            @Override
            public void onSetProtocol(BluetoothDevice device, byte nextProtocol) {
                if (!current() || !isConnectedHost(device)) return;
                if (!releaseReports()) {
                    recoverInput("蓝牙输入释放失败，正在自动恢复");
                    return;
                }
                protocol = nextProtocol;
                message = nextProtocol == BluetoothHidDevice.PROTOCOL_REPORT_MODE
                        ? "已连接 " + deviceName(device) : "电脑当前使用启动输入协议，请进入正常系统后重连";
                emitState();
            }

            @Override
            public void onVirtualCableUnplug(BluetoothDevice device) {
                if (!current() || !isConnectedHost(device)) return;
                releaseReports();
                connectedDevice = null;
                connectingDevice = null;
                sessionId++;
                message = "电脑已移除蓝牙输入连接，请重新配对或连接";
                emitState();
            }
        };
    }

    @PluginMethod
    public void connect(PluginCall call) {
        ui.post(() -> {
            if (!registered || hid == null || !hasPermissions() || !foreground) {
                call.reject("蓝牙输入设备尚未就绪");
                return;
            }
            String address = call.getString("address", "");
            BluetoothDevice selected = null;
            for (BluetoothDevice device : pairedDevices()) {
                if (device.getAddress().equalsIgnoreCase(address)) selected = device;
            }
            if (selected == null) {
                call.reject("请选择已配对的接收电脑，手表、耳机和其他外设不能接收输入");
                return;
            }
            if (connectedDevice != null) {
                if (connectedDevice.equals(selected)) call.resolve(status());
                else call.reject("请先关闭当前蓝牙输入，再连接另一台电脑");
                return;
            }
            if (connectingDevice != null) {
                call.reject("正在建立蓝牙连接，请稍候");
                return;
            }
            releaseReports();
            sessionId++;
            selectedDevice = selected;
            connectingDevice = selected;
            message = "正在连接 " + deviceName(selected);
            try {
                if (!hid.connect(selected)) {
                    connectingDevice = null;
                    message = "电脑未接受连接，请确认电脑支持蓝牙输入设备并已配对";
                } else {
                    watchConnectionTimeout(selected);
                }
            } catch (RuntimeException error) {
                connectingDevice = null;
                message = "蓝牙连接失败，请检查电脑和手机蓝牙设置";
            }
            emitState();
            call.resolve(status());
        });
    }

    private void watchConnectionTimeout(BluetoothDevice device) {
        final long attempt = ++connectionEpoch;
        final long registration = registrationEpoch;
        ui.postDelayed(() -> {
            if (attempt != connectionEpoch || registration != registrationEpoch
                    || connectingDevice == null || !connectingDevice.equals(device)
                    || connectedDevice != null) return;
            connectingDevice = null;
            sessionId++;
            try { if (hid != null) hid.disconnect(device); } catch (RuntimeException ignored) {}
            message = "电脑连接超时，将自动重试；首次连接请保持手机页面在前台";
            emitState();
        }, 12000);
    }

    @PluginMethod
    public void sendMouse(PluginCall call) {
        send(call, HidReportCodec.MOUSE_ID, HidReportCodec.mouse(call.getInt("buttons", 0),
                call.getDouble("dx", 0.0), call.getDouble("dy", 0.0)));
    }

    @PluginMethod
    public void sendKeyboard(PluginCall call) {
        JSArray values = call.getArray("keys", new JSArray());
        int[] keys = new int[values.length()];
        for (int index = 0; index < keys.length; index++) keys[index] = values.optInt(index, 0);
        send(call, HidReportCodec.KEYBOARD_ID, HidReportCodec.keyboard(keys));
    }

    @PluginMethod
    public void sendGamepad(PluginCall call) {
        send(call, HidReportCodec.GAMEPAD_ID, HidReportCodec.gamepad(call.getInt("buttons", 0),
                call.getDouble("x", 0.0), call.getDouble("y", 0.0),
                call.getDouble("rx", 0.0), call.getDouble("ry", 0.0),
                call.getDouble("lt", 0.0), call.getDouble("rt", 0.0)));
    }

    private void send(PluginCall call, int id, byte[] report) {
        final int expectedSession = call.getInt("sessionId", sessionId);
        final long expectedEpoch = reportEpoch;
        // 所有报告与连接回调都排在同一主线程；释放、断线后旧任务不能进入新会话。
        ui.post(() -> {
            boolean sent = false;
            if (expectedSession == sessionId && expectedEpoch == reportEpoch && foreground
                    && registered && connectedDevice != null && hid != null && hasPermissions()
                    && acceptsHost(connectedDevice)
                    && protocol == BluetoothHidDevice.PROTOCOL_REPORT_MODE) {
                try {
                    sent = hid.sendReport(connectedDevice, id, report);
                    if (sent) {
                        // 相对鼠标位移不能在电脑读取当前状态时重播。
                        reports[id] = id == HidReportCodec.MOUSE_ID
                                ? HidReportCodec.mouse(report[0], 0, 0) : report;
                    } else {
                        recoverInput("蓝牙输入发送失败，正在自动恢复");
                    }
                } catch (RuntimeException error) {
                    recoverInput("蓝牙输入连接已失效，正在自动恢复");
                }
            }
            call.resolve(new JSObject().put("sent", sent).put("sessionId", sessionId));
        });
    }

    @PluginMethod
    public void releaseAll(PluginCall call) {
        ui.post(() -> {
            boolean released = releaseReports();
            if (!released) recoverInput("蓝牙输入释放失败，连接已关闭，正在自动恢复");
            call.resolve(status().put("released", released));
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ui.post(() -> {
            stopInternal("蓝牙输入已关闭", false);
            call.resolve(status());
        });
    }

    private void resetReports() {
        for (int id = 1; id < reports.length; id++) reports[id] = HidReportCodec.neutral(id);
        keyboardLeds = 0;
    }

    private boolean releaseReports() {
        reportEpoch++;
        resetReports();
        if (hid == null || connectedDevice == null) return true;
        if (!hasPermissions() || !acceptsHost(connectedDevice)
                || protocol != BluetoothHidDevice.PROTOCOL_REPORT_MODE) return false;
        return ReportRelease.sendAll(reports, (id, report) -> hid.sendReport(connectedDevice, id, report));
    }

    private void recoverInput(String reason) {
        // 断开蓝牙时，服务或发送失败可能先于开关广播到达，不能清掉用户的连接意图。
        stopInternal(reason, requested);
        final long generation = profileEpoch;
        ui.postDelayed(() -> {
            if (generation == profileEpoch && requested && foreground && !systemPrompt
                    && hasPermissions() && isEnabled()) beginProfile();
        }, 1000);
    }

    private void stopInternal(String reason, boolean keepRequested) {
        releaseReports();
        profileEpoch++;
        registrationEpoch++;
        connectionEpoch++;
        sessionId++;
        if (!keepRequested) promptEpoch++;
        BluetoothHidDevice previous = hid;
        hid = null;
        registered = false;
        starting = false;
        connectedDevice = null;
        connectingDevice = null;
        if (!keepRequested) selectedDevice = null;
        requested = keepRequested;
        if (previous != null) {
            try { previous.unregisterApp(); } catch (RuntimeException ignored) {}
            try { adapter.closeProfileProxy(BluetoothProfile.HID_DEVICE, previous); } catch (RuntimeException ignored) {}
        }
        message = reason;
        emitState();
    }

    private boolean basicSupport() {
        return Build.VERSION.SDK_INT >= 28 && adapter != null;
    }

    private String unsupportedMessage() {
        return Build.VERSION.SDK_INT < 28 ? "蓝牙鼠标和手柄需要安卓 9 或以上系统"
                : "当前手机没有可用的蓝牙硬件";
    }

    private boolean hasPermissions() {
        return Build.VERSION.SDK_INT < 31 || (ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_ADVERTISE)
                == PackageManager.PERMISSION_GRANTED);
    }

    private boolean isEnabled() {
        try { return adapter != null && hasPermissions() && adapter.isEnabled(); }
        catch (RuntimeException ignored) { return false; }
    }

    private List<BluetoothDevice> pairedDevices() {
        List<BluetoothDevice> devices = new ArrayList<>();
        if (adapter != null && hasPermissions()) {
            try {
                for (BluetoothDevice device : adapter.getBondedDevices()) {
                    if (isHostCandidate(device)) devices.add(device);
                }
            } catch (RuntimeException ignored) {}
        }
        devices.sort(Comparator.comparing(this::deviceName).thenComparing(BluetoothDevice::getAddress));
        return devices;
    }

    private boolean isComputerHost(BluetoothDevice device) {
        try {
            BluetoothClass kind = device.getBluetoothClass();
            if (kind == null) return false;
            // 电脑大类也包含穿戴式电脑、掌上机和平板，不能直接全部当成接收电脑。
            int value = kind.getDeviceClass();
            return value == BluetoothClass.Device.COMPUTER_UNCATEGORIZED
                    || value == BluetoothClass.Device.COMPUTER_DESKTOP
                    || value == BluetoothClass.Device.COMPUTER_LAPTOP
                    || value == BluetoothClass.Device.COMPUTER_SERVER;
        } catch (RuntimeException ignored) { return false; }
    }

    private boolean isHostCandidate(BluetoothDevice device) {
        if (device == null || !hasPermissions()) return false;
        try {
            if (device.getBondState() != BluetoothDevice.BOND_BONDED
                    || device.getType() == BluetoothDevice.DEVICE_TYPE_LE) return false;
            BluetoothClass kind = device.getBluetoothClass();
            return isComputerHost(device) || kind == null
                    || kind.getMajorDeviceClass() == BluetoothClass.Device.Major.MISC
                    || kind.getMajorDeviceClass() == BluetoothClass.Device.Major.UNCATEGORIZED;
        } catch (RuntimeException ignored) { return false; }
    }

    private boolean acceptsHost(BluetoothDevice device) {
        if (!isHostCandidate(device)) return false;
        // 未报类型的电脑可以兼容，但只能在用户明确点选后接收输入。
        return selectedDevice != null ? selectedDevice.equals(device) : isComputerHost(device);
    }

    private boolean isConnectedHost(BluetoothDevice device) {
        return visible && registered && connectedDevice != null
                && connectedDevice.equals(device) && acceptsHost(device);
    }

    private void rejectHost(BluetoothDevice device) {
        if ((connectedDevice != null && connectedDevice.equals(device))
                || (connectingDevice != null && connectingDevice.equals(device))) {
            reportEpoch++;
            resetReports();
            connectedDevice = null;
            connectingDevice = null;
            sessionId++;
        }
        try { if (hid != null && device != null) hid.disconnect(device); }
        catch (RuntimeException ignored) {}
        if (connectedDevice == null) message = "已拒绝未经选择的接收设备，请选择电脑连接";
    }

    private String deviceName(BluetoothDevice device) {
        try {
            String name = device.getName();
            return name == null || name.trim().isEmpty() ? device.getAddress() : name;
        } catch (RuntimeException ignored) { return "已配对设备"; }
    }

    private JSObject status() {
        JSArray devices = new JSArray();
        for (BluetoothDevice device : pairedDevices()) {
            String name = deviceName(device) + (isComputerHost(device) ? "" : "（类型未知，请确认是电脑）");
            devices.put(new JSObject().put("address", device.getAddress()).put("name", name));
        }
        return new JSObject().put("supported", basicSupport() && !profileUnavailable)
                .put("enabled", isEnabled()).put("registered", registered)
                .put("connected", connectedDevice != null).put("connecting", connectingDevice != null)
                .put("deviceName", connectedDevice != null ? deviceName(connectedDevice) : "")
                .put("devices", devices).put("sessionId", sessionId)
                .put("message", basicSupport() ? message : unsupportedMessage());
    }

    private void emitState() {
        notifyListeners("controllerState", status());
    }

    @Override
    protected void handleOnStart() {
        visible = true;
        super.handleOnStart();
    }

    @Override
    protected void handleOnPause() {
        foreground = false;
        // 系统配对弹窗也会暂停活动；可见时保留服务，先释放全部输入。
        if (!releaseReports()) {
            stopInternal("蓝牙输入释放失败，连接已关闭；返回后自动恢复", requested);
        }
        super.handleOnPause();
    }

    @Override
    protected void handleOnStop() {
        visible = false;
        if (!systemPrompt) {
            stopInternal("应用已暂停，蓝牙输入已释放；返回后自动恢复", requested);
        }
        super.handleOnStop();
    }

    @Override
    protected void handleOnResume() {
        foreground = true;
        if (requested && !systemPrompt && hasPermissions() && isEnabled()) beginProfile();
        super.handleOnResume();
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal("蓝牙输入已关闭", false);
        if (receiverRegistered) {
            getContext().unregisterReceiver(bluetoothChanges);
            receiverRegistered = false;
        }
        super.handleOnDestroy();
    }
}
