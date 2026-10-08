import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ plugins: {} as Record<string, any>, createPose: vi.fn(), createHand: vi.fn(), createWorker: vi.fn(), scan: vi.fn(),
  shooterChange: null as null | ((state: any) => void) }));
vi.mock("./qr-scanner", () => ({ scanConnectionCode: mocks.scan }));
vi.mock("./vision.worker?worker", () => ({ default: class { constructor() { return mocks.createWorker(); } } }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true },
  registerPlugin: (name: string) => mocks.plugins[name],
}));
vi.mock("@capacitor/app", () => ({ App: {
  getInfo: async () => ({ version: "2.3.0" }), exitApp: async () => {}, addListener: async () => ({ remove: async () => {} }),
} }));
vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  PoseLandmarker: { createFromOptions: mocks.createPose, POSE_CONNECTIONS: [] },
  HandLandmarker: { createFromOptions: mocks.createHand },
  DrawingUtils: class { drawConnectors() {} drawLandmarks() {} },
}));
vi.mock("./shooter-controls", () => ({ SHOOTER_CONTROLS_HTML: "", createShooterControls: (_element: unknown, change: (state: any) => void) => {
  mocks.shooterChange = change; return { reset() {}, destroy() {} };
} }));

// A small event/element harness exercises the production module's real buttons,
// asynchronous startup and socket listeners without requesting physical devices.
class ElementStub extends EventTarget {
  value = ""; textContent = ""; innerHTML = ""; className = ""; title = "";
  disabled = false; checked = false; hidden = false; open = false;
  width = 480; height = 640; videoWidth = 480; videoHeight = 640;
  currentTime = 0; readyState = 2; srcObject: unknown = null;
  dataset: Record<string, string> = {}; style: Record<string, string> = {};
  options: ElementStub[] = [];
  min = "0"; max = "9999";
  classes = new Set<string>();
  classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    toggle: (name: string, enabled?: boolean) => {
      const on = enabled ?? !this.classes.has(name);
      if (on) this.classes.add(name); else this.classes.delete(name); return on;
    },
    contains: (name: string) => this.classes.has(name),
  };
  private children = new Map<string, ElementStub>();
  querySelector(selector: string): ElementStub {
    if (!this.children.has(selector)) this.children.set(selector, new ElementStub());
    return this.children.get(selector)!;
  }
  querySelectorAll(): ElementStub[] { return []; }
  closest(selector: string): ElementStub { return this.querySelector(selector); }
  setAttribute() {} removeAttribute() {} replaceChildren() {} appendChild() {} pause() {}
  load() { this.readyState = 0; this.currentTime = 0; }
  async play() { this.readyState = 2; }
  getContext() { return new Proxy({}, { get: (_, key) => key === "measureText" ? () => ({ width: 10 }) : () => {} }); }
  getBoundingClientRect() { return { width: 480, height: 640, left: 0, top: 0 }; }
}

class SocketStub extends EventTarget {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  static sockets: SocketStub[] = [];
  readyState = 0; bufferedAmount = 0; sent: string[] = [];
  constructor(readonly url: string) { super(); SocketStub.sockets.push(this); }
  send(body: string) { this.sent.push(body); }
  close() { this.readyState = 3; } // Deliberately deliver close separately, like TCP callbacks.
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(body: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(body) })); }
}
class VisionWorkerStub extends EventTarget {
  messages: any[] = []; terminate = vi.fn();
  postMessage(message: unknown) { this.messages.push(message); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
  ready() { this.receive({ type: "ready", delegate: "GPU", fallbackError: null }); }
  result(id: number) {
    const points = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: 1 }));
    this.receive({ type: "result", id, landmarks: [points], worldLandmarks: [points],
      hands: ["Left", "Right"].map(handedness => ({ handedness, points: Array.from({ length: 21 }, () => [.5, .5, 0, 1]) })),
      timings: { copyMs: 1, poseMs: 20, handsMs: 10, totalMs: 31 } });
  }
}
function workerPlatform() {
  vi.stubGlobal("Worker", VisionWorkerStub); vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 384, height: 512, close: vi.fn() })));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function cameraStream() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn(), applyConstraints: async () => {}, getSettings: () => ({ deviceId: "front", facingMode: "user" }) });
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream, track };
}
const emptyModel = () => ({ close: vi.fn(), detectForVideo: vi.fn(() => ({ landmarks: [], worldLandmarks: [] })) });

let elements: Map<string, ElementStub>;
let documentEvents: EventTarget;
let getUserMedia: ReturnType<typeof vi.fn>;
let animationFrames: Map<number, FrameRequestCallback>;
const element = (selector: string) => {
  if (!elements.has(selector)) elements.set(selector, new ElementStub());
  return elements.get(selector)!;
};
const click = (selector: string) => element(selector).dispatchEvent(new Event("click"));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function videoFrame() {
  const callbacks = [...animationFrames.values()]; animationFrames.clear();
  callbacks.forEach(callback => callback(performance.now()));
}
async function enterCamera() { click("#cameraRole"); await flush(); }
async function beginCamera() { click("#startButton"); await flush(); await vi.advanceTimersByTimeAsync(110); await flush(); }

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  elements = new Map(); documentEvents = new EventTarget(); animationFrames = new Map(); SocketStub.sockets = [];
  const storage = new Map([["motionbridge-voice-auto", "0"]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("HTMLSelectElement", ElementStub); vi.stubGlobal("HTMLInputElement", ElementStub);
  vi.stubGlobal("Option", ElementStub); vi.stubGlobal("__WEB_VERSION__", "2.3.0");
  vi.stubGlobal("document", {
    hidden: false, body: new ElementStub(), documentElement: new ElementStub(),
    querySelector: element, querySelectorAll: () => [], createElement: () => new ElementStub(),
    createTextNode: (text: string) => ({ textContent: text }),
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  });
  const windowEvents = new EventTarget();
  vi.stubGlobal("window", {
    setTimeout, clearTimeout, setInterval, clearInterval, innerWidth: 480, innerHeight: 640, devicePixelRatio: 1,
    addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { animationFrames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => animationFrames.delete(id));
  vi.stubGlobal("WebSocket", SocketStub); vi.stubGlobal("screen", { orientation: { angle: 0 } });
  vi.stubGlobal("location", { href: "http://localhost/", hostname: "localhost", protocol: "http:", host: "localhost", search: "" });
  getUserMedia = vi.fn(async () => cameraStream().stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, enumerateDevices: async () => [{ kind: "videoinput", deviceId: "front", label: "front" }] } });
  mocks.createPose.mockReset().mockImplementation(async () => emptyModel()); mocks.createHand.mockReset();
  mocks.createWorker.mockReset().mockImplementation(() => new VisionWorkerStub());
  mocks.scan.mockReset().mockResolvedValue(null);
  mocks.plugins = {
    LocalNetwork: { interfaces: async () => ({ interfaces: [] }), probe: async () => ({ ok: true }), discover: async () => ({ servers: [] }) },
    NativeAudio: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })), start: vi.fn(async () => ({ audioReady: true, recognizerReady: true })), stop: vi.fn(async () => {}) },
    Display: { setOrientation: async () => {}, setBars: async () => {} },
    WebUpdate: { bootOk: vi.fn(async () => {}), sync: vi.fn(async () => ({ state: "current" })), getCapabilities: async () => ({ capabilities: {} }) },
    AppUpdate: { check: vi.fn(async () => ({ state: "current" })), download: vi.fn(async () => ({ state: "ready", version: "2.4.0" })),
      install: vi.fn(async () => ({ state: "installing" })), addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })) },
    BluetoothController: { releaseAll: async () => {}, stop: async () => {} },
    HeartRate: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })), start: vi.fn(async () => ({ state: "scanning", message: "", device: "", wanted: true })),
      stop: vi.fn(async () => ({ state: "off", message: "", device: "", wanted: false })), getStatus: vi.fn(async () => ({ state: "off", message: "", device: "", wanted: false })) },
    SensorBridge: { start: async () => {}, stop: async () => {}, getLatest: async () => ({ qx: 0, qy: 0, qz: 0, qw: 1,
      gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 0, timestamp: 1, running: true,
      rotationAvailable: true, rotation_age_ms: 40, sample_age_ms: 40 }) },
  };
  element("#serverUrl").value = "192.168.1.2:8765";
  element("#handheldMode").value = "gamepad"; element("#handheldTransport").value = "network";
  await import("./main"); await flush();
  element("#serverUrl").value = "192.168.1.2:8765";
});

afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("camera lifecycle through actual UI events", () => {
  it("扫码选机保存电脑，停止按钮取消离线自动重试", async () => {
    const instance = "0123456789ab";
    mocks.plugins.LocalNetwork.probe = vi.fn(async () => ({ ok: false, instance }));
    mocks.scan.mockResolvedValue(JSON.stringify({ type: "motioncontrol-connect", version: 1, instance,
      name: "我的电脑", candidates: [{ host: "192.168.1.2", port: 8765, kind: "lan" }] }));
    await enterCamera(); click("#scanComputerCamera"); await vi.dynamicImportSettled(); await flush();
    expect(JSON.parse(localStorage.getItem("motionbridge-remembered-computer")!).instance).toBe(instance);
    expect(getUserMedia).not.toHaveBeenCalled();
    click("#stopButton"); await flush();
    const probes = mocks.plugins.LocalNetwork.probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.plugins.LocalNetwork.probe.mock.calls.length).toBe(probes);
  });
  it("运行中取消扫码会恢复原来的摄像头，扫码前已释放原镜头", async () => {
    const first = cameraStream(); getUserMedia.mockResolvedValueOnce(first.stream);
    await enterCamera(); await beginCamera();
    mocks.scan.mockImplementation(async () => { expect(first.track.stop).toHaveBeenCalledOnce(); return null; });
    click("#scanComputerCamera"); await vi.dynamicImportSettled(); await flush();
    await vi.advanceTimersByTimeAsync(110); await flush();
    expect(mocks.scan).toHaveBeenCalledOnce(); expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
  it("扫码选机后无人入镜也能持续保持电脑心跳", async () => {
    const instance = "0123456789ab";
    mocks.plugins.LocalNetwork.probe = vi.fn(async () => ({ ok: true, instance }));
    mocks.scan.mockResolvedValue(JSON.stringify({ type: "motioncontrol-connect", version: 1, instance,
      name: "我的电脑", candidates: [{ host: "192.168.1.2", port: 8765, kind: "lan" }] }));
    await enterCamera(); click("#scanComputerCamera"); await vi.dynamicImportSettled(); await flush();
    await vi.advanceTimersByTimeAsync(110); await flush();
    const ws = SocketStub.sockets[0];
    const send = ws.send.bind(ws);
    ws.send = body => { send(body); const message = JSON.parse(body); if (message.type === "clock_sync") ws.message({ ...message, server_ms: Date.now() }); };
    ws.open();
    const frames = setInterval(() => { element("#camera").currentTime += .5; videoFrame(); }, 500);
    await vi.advanceTimersByTimeAsync(30000); await flush(); clearInterval(frames);
    expect(SocketStub.sockets).toHaveLength(1);
    expect(ws.readyState).toBe(SocketStub.OPEN);
    expect(element("#runtimeCard").dataset.link).toBe("online");
    expect(ws.sent.map(body => JSON.parse(body)).filter(message => message.type === "clock_sync").length).toBeGreaterThanOrEqual(10);
  });
  it("蓝牙手柄也能扫码并改用同一台电脑的网络连接", async () => {
    const instance = "0123456789ab";
    mocks.plugins.LocalNetwork.probe = vi.fn(async () => ({ ok: true, instance }));
    mocks.scan.mockResolvedValue(JSON.stringify({ type: "motioncontrol-connect", version: 1, instance,
      name: "我的电脑", candidates: [{ host: "192.168.1.2", port: 8765, kind: "lan" }] }));
    Object.assign(mocks.plugins.BluetoothController, {
      start: async () => ({ supported: true, enabled: true, registered: true, connected: false, connecting: false,
        devices: [], sessionId: 1, message: "等待蓝牙连接" }),
      addListener: async () => ({ remove: async () => {} }),
    });
    element("#handheldTransport").value = "bluetooth";
    click("#handheldRole"); await flush();
    expect(SocketStub.sockets).toHaveLength(0);
    expect(element("#scanComputerHandheld").hidden).toBe(false);
    expect(element("#centerSensor").hidden).toBe(true);
    click("#scanComputerHandheld"); await vi.dynamicImportSettled(); await flush();
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(element("#handheldTransport").value).toBe("network");
    expect(SocketStub.sockets).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("motionbridge-remembered-computer")!).instance).toBe(instance);
    const ws = SocketStub.sockets[0]; ws.open();
    await vi.advanceTimersByTimeAsync(16); await flush();
    expect(ws.sent.map(body => JSON.parse(body)).some(message => message.type === "sensor_frame")).toBe(true);
    expect(element("#handheldConnection b").textContent).toContain("已连接");
    expect(element("#scanComputerHandheld").hidden).toBe(true);
    expect(element("#centerSensor").hidden).toBe(false);
  });
  it("扫码存下配对钥匙，每次连接带上；电脑说没配对时状态牌写明请扫码", async () => {
    const instance = "0123456789ab", key = "AbCdEfGhIjKlMnOpQrStUv";
    mocks.plugins.LocalNetwork.probe = vi.fn(async () => ({ ok: true, instance }));
    mocks.scan.mockResolvedValue(JSON.stringify({ type: "motioncontrol-connect", version: 1, instance, key,
      name: "我的电脑", candidates: [{ host: "192.168.1.2", port: 8765, kind: "lan" }] }));
    click("#handheldRole"); await flush();
    click("#scanComputerHandheld"); await vi.dynamicImportSettled(); await flush();
    expect(JSON.parse(localStorage.getItem("motionbridge-remembered-computer")!).key).toBe(key);
    const ws = SocketStub.sockets.at(-1)!;
    expect(new URL(ws.url).searchParams.get("key")).toBe(key);
    ws.open(); await flush();
    ws.message({ type: "error", code: "pairing_required", message: "这台手机还没和电脑配对" }); await flush();
    expect(element("#handheldConnection b").textContent).toBe("未配对，请扫码连接");
    expect(element("#sensorState").textContent).toBe("这台手机还没和电脑配对");
  });
  it("蓝牙鼠标扫码后走网络发送鼠标帧，不会误发成手柄", async () => {
    const instance = "0123456789ab";
    const { GyroMouse } = await import("./gyro-mouse");
    vi.spyOn(GyroMouse.prototype, "update").mockReturnValue({ dx: 5, dy: -3, calibrating: false });
    mocks.plugins.LocalNetwork.probe = vi.fn(async () => ({ ok: true, instance }));
    mocks.scan.mockResolvedValue(JSON.stringify({ type: "motioncontrol-connect", version: 1, instance,
      name: "我的电脑", candidates: [{ host: "192.168.1.2", port: 8765, kind: "lan" }] }));
    Object.assign(mocks.plugins.BluetoothController, {
      start: async () => ({ supported: true, enabled: true, registered: true, connected: false, connecting: false,
        devices: [], sessionId: 1, message: "等待蓝牙连接" }),
      addListener: async () => ({ remove: async () => {} }), sendMouse: vi.fn(async () => ({ sent: true })),
    });
    element("#handheldTransport").value = "bluetooth"; element("#handheldMode").value = "shooter";
    click("#handheldRole"); await flush();
    click("#scanComputerHandheld"); await vi.dynamicImportSettled(); await flush();
    expect(element("#handheldTransport").value).toBe("network");
    const ws = SocketStub.sockets.at(-1)!; ws.open();
    await vi.advanceTimersByTimeAsync(16); await flush();
    const messages = ws.sent.map(body => JSON.parse(body));
    const mouse = messages.find(message => message.type === "mouse_frame");
    expect(mouse).toMatchObject({ role: "mouse", dx: 5, dy: -3, buttons: 0 });
    expect(mouse.sent_at_ms - mouse.captured_at_ms).toBe(40);
    expect(messages.some(message => message.type === "sensor_frame")).toBe(false);
    expect(mocks.plugins.BluetoothController.sendMouse).not.toHaveBeenCalled();
  });
  it("网络鼠标的开始和暂停按钮经手持连接请求电脑开关", async () => {
    element("#handheldMode").value = "shooter";
    click("#handheldRole"); await flush();
    const ws = SocketStub.sockets[0]; ws.open();
    expect(element("#handheldGameControlButton").classes.has("hidden")).toBe(false);
    expect(element("#handheldGameControlButton").disabled).toBe(true);
    ws.message({ type: "game_output_state_v1", enabled: false });
    expect(element("#handheldGameControlButton").textContent).toBe("开始控制");
    click("#handheldGameControlButton");
    let requests = ws.sent.map(body => JSON.parse(body)).filter(message => message.type === "game_output_control");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ role: "mouse", enabled: true });
    expect(element("#handheldGameControlButton").disabled).toBe(true);
    ws.message({ type: "game_output_state_v1", enabled: true });
    expect(element("#handheldGameControlButton").textContent).toBe("暂停控制");
    click("#handheldGameControlButton");
    requests = ws.sent.map(body => JSON.parse(body)).filter(message => message.type === "game_output_control");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ role: "mouse", enabled: false });
    ws.close(); ws.dispatchEvent(new Event("close")); await flush();
    expect(element("#handheldGameControlButton").disabled).toBe(true);
    expect(element("#handheldGameControlButton").textContent).toBe("连接电脑中");
  });
  it("网络手柄也显示开始控制并使用同一电脑输出开关", async () => {
    click("#handheldRole"); await flush();
    const ws = SocketStub.sockets[0]; ws.open();
    ws.message({ type: "game_output_state_v1", enabled: false });
    expect(element("#handheldGameControlButton").classes.has("hidden")).toBe(false);
    expect(element("#handheldGameControlButton").textContent).toBe("开始控制");
    click("#handheldGameControlButton");
    expect(ws.sent.map(body => JSON.parse(body)).filter(message => message.type === "game_output_control"))
      .toEqual([expect.objectContaining({ role: "sensor", enabled: true })]);
    ws.message({ type: "game_output_state_v1", enabled: true });
    expect(element("#handheldGameControlButton").textContent).toBe("暂停控制");
  });
  it("切换手柄鼠标保留网络连接及控制状态，旧采样不进入新模式", async () => {
    const delayedStart = deferred<void>();
    mocks.plugins.SensorBridge.start = vi.fn(async ({ mode }) => { if (mode === "shooter") await delayedStart.promise; });
    click("#handheldRole"); await flush();
    const ws = SocketStub.sockets[0]; ws.open(); ws.message({ type: "game_output_state_v1", enabled: true });
    const lateSample = deferred<any>();
    const fresh = await mocks.plugins.SensorBridge.getLatest();
    mocks.plugins.SensorBridge.getLatest = vi.fn().mockReturnValueOnce(lateSample.promise).mockResolvedValue(fresh);
    await vi.advanceTimersByTimeAsync(16); await flush();
    element("#handheldMode").value = "shooter";
    element("#handheldMode").dispatchEvent(new Event("change")); await flush();
    expect(element("#scanComputerHandheld").hidden).toBe(true);
    expect(element("#centerSensor").hidden).toBe(false);
    expect(element("#handheldGameControlButton").textContent).toBe("暂停控制");
    expect(SocketStub.sockets).toHaveLength(1); expect(ws.readyState).toBe(SocketStub.OPEN);
    const released = ws.sent.map(body => JSON.parse(body)).filter(message => message.type === "sensor_frame");
    expect(released).toEqual([expect.objectContaining({ touches: [], recenter: true,
      quaternion: { x: 0, y: 0, z: 0, w: 1 }, rotation_rate: { x: 0, y: 0, z: 0 } })]);
    delayedStart.resolve(); await flush(); lateSample.resolve(fresh); await flush();
    await vi.advanceTimersByTimeAsync(16); await flush();
    expect(ws.sent.map(body => JSON.parse(body)).filter(message => message.type === "sensor_frame")).toHaveLength(1);
    expect(ws.sent.map(body => JSON.parse(body)).some(message => message.type === "mouse_frame")).toBe(true);
    mocks.shooterChange!({ stick: { x: 0, y: 0 }, stickPressed: false, mouseButtons: 1 });
    expect(ws.sent.map(body => JSON.parse(body)).at(-1)).toMatchObject({ type: "mouse_frame", buttons: 1 });
    element("#handheldMode").value = "gamepad";
    element("#handheldMode").dispatchEvent(new Event("change")); await flush();
    expect(ws.sent.map(body => JSON.parse(body)).filter(message => message.type === "mouse_frame").at(-1))
      .toMatchObject({ dx: 0, dy: 0, buttons: 0 });
    expect(element("#handheldGameControlButton").textContent).toBe("暂停控制");
    expect(SocketStub.sockets).toHaveLength(1);
    ws.close(); ws.dispatchEvent(new Event("close")); await flush();
    expect(element("#scanComputerHandheld").hidden).toBe(false);
    expect(element("#handheldGameControlButton").disabled).toBe(true);
  });
  it("蓝牙切换模式保留配对连接与开关，暂停后不再发送手柄或鼠标报告", async () => {
    const state = { supported: true, enabled: true, registered: true, connected: true, connecting: false,
      devices: [], sessionId: 1, message: "已连接" };
    Object.assign(mocks.plugins.BluetoothController, {
      start: vi.fn(async () => state), stop: vi.fn(async () => state),
      releaseAll: vi.fn(async () => state), addListener: async () => ({ remove: async () => {} }),
      sendGamepad: vi.fn(async () => ({ sent: true })), sendMouse: vi.fn(async () => ({ sent: true })),
    });
    element("#handheldTransport").value = "bluetooth";
    click("#handheldRole"); await flush();
    expect(element("#handheldGameControlButton").textContent).toBe("开始控制");
    await vi.advanceTimersByTimeAsync(16); await flush();
    expect(mocks.plugins.BluetoothController.sendGamepad).not.toHaveBeenCalled();
    click("#handheldGameControlButton"); await vi.advanceTimersByTimeAsync(16); await flush();
    expect(mocks.plugins.BluetoothController.sendGamepad).toHaveBeenCalledOnce();
    element("#handheldMode").value = "shooter";
    element("#handheldMode").dispatchEvent(new Event("change"));
    expect(element("#scanComputerHandheld").hidden).toBe(true);
    await flush(); await vi.advanceTimersByTimeAsync(16); await flush();
    expect(element("#handheldGameControlButton").textContent).toBe("暂停控制");
    expect(mocks.plugins.BluetoothController.start).toHaveBeenCalledOnce();
    expect(mocks.plugins.BluetoothController.stop).not.toHaveBeenCalled();
    expect(mocks.plugins.BluetoothController.releaseAll).toHaveBeenCalledOnce();
    expect(mocks.plugins.BluetoothController.sendMouse).toHaveBeenCalledOnce();
    click("#handheldGameControlButton"); await flush();
    const count = mocks.plugins.BluetoothController.sendMouse.mock.calls.length;
    mocks.shooterChange!({ stick: { x: 0, y: 0 }, stickPressed: false, mouseButtons: 1 });
    await vi.advanceTimersByTimeAsync(32); await flush();
    expect(mocks.plugins.BluetoothController.sendMouse).toHaveBeenCalledTimes(count);
    expect(mocks.plugins.BluetoothController.releaseAll).toHaveBeenCalledTimes(2);
    expect(element("#handheldGameControlButton").textContent).toBe("开始控制");
    element("#handheldMode").value = "gamepad";
    element("#handheldMode").dispatchEvent(new Event("change")); await flush();
    await vi.advanceTimersByTimeAsync(16); await flush();
    expect(mocks.plugins.BluetoothController.sendGamepad).toHaveBeenCalledOnce();
    expect(element("#handheldGameControlButton").textContent).toBe("开始控制");
  });
  it("蓝牙真正连接后顶栏显示校准，未连接时显示扫码", async () => {
    let stateListener!: (state: unknown) => void;
    const state = { supported: true, enabled: true, registered: true, connected: true, connecting: false,
      devices: [], sessionId: 1, message: "已连接" };
    Object.assign(mocks.plugins.BluetoothController, {
      start: async () => state,
      addListener: async (_event: string, listener: (state: unknown) => void) => { stateListener = listener; return { remove: async () => {} }; },
      sendGamepad: async () => ({ sent: true }),
    });
    element("#handheldTransport").value = "bluetooth";
    click("#handheldRole"); await flush();
    expect(element("#scanComputerHandheld").hidden).toBe(true);
    expect(element("#centerSensor").hidden).toBe(false);
    stateListener({ ...state, connected: false, message: "电脑已断开" }); await flush();
    expect(element("#scanComputerHandheld").hidden).toBe(false);
    expect(element("#centerSensor").hidden).toBe(true);
  });
  it("取消扫码会恢复蓝牙手柄，不会被已记住的电脑改成网络", async () => {
    const instance = "0123456789ab";
    mocks.plugins.LocalNetwork.probe = vi.fn(async () => ({ ok: true, instance }));
    mocks.scan.mockResolvedValueOnce(JSON.stringify({ type: "motioncontrol-connect", version: 1, instance,
      name: "我的电脑", candidates: [{ host: "192.168.1.2", port: 8765, kind: "lan" }] })).mockResolvedValue(null);
    await enterCamera(); click("#scanComputerCamera"); await vi.dynamicImportSettled(); await flush();
    await vi.advanceTimersByTimeAsync(110); await flush();
    const startBluetooth = vi.fn(async () => ({ supported: true, enabled: true, registered: true,
      connected: true, connecting: false, devices: [], sessionId: 1, message: "已连接" }));
    Object.assign(mocks.plugins.BluetoothController, {
      start: startBluetooth,
      addListener: async () => ({ remove: async () => {} }), sendGamepad: async () => ({ sent: true }),
    });
    element("#handheldTransport").value = "bluetooth";
    click("#handheldRole"); await flush();
    expect(startBluetooth).toHaveBeenCalledOnce();
    click("#scanComputerHandheld"); await vi.dynamicImportSettled(); await flush();
    expect(mocks.scan).toHaveBeenCalledTimes(2);
    expect(element("#handheldTransport").value).toBe("bluetooth");
    expect(startBluetooth).toHaveBeenCalledTimes(2);
    expect(element("#handheldConnection b").textContent).toContain("蓝牙已连接");
  });
  it("扫码手柄断线后持续重试，电脑恢复就能重连", async () => {
    const instance = "0123456789ab";
    let online = true;
    mocks.plugins.LocalNetwork.probe = vi.fn(async () => ({ ok: online, instance }));
    mocks.scan.mockResolvedValue(JSON.stringify({ type: "motioncontrol-connect", version: 1, instance,
      name: "我的电脑", candidates: [{ host: "192.168.1.2", port: 8765, kind: "lan" }] }));
    click("#handheldRole"); await flush();
    click("#scanComputerHandheld"); await vi.dynamicImportSettled(); await flush();
    const ws = SocketStub.sockets.at(-1)!; ws.open();
    online = false; ws.close(); ws.dispatchEvent(new Event("close")); await flush();
    expect(element("#scanComputerHandheld").hidden).toBe(false);
    expect(element("#centerSensor").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(6000); await flush();
    const beforeRecovery = SocketStub.sockets.length;
    online = true; await vi.advanceTimersByTimeAsync(3000); await flush();
    expect(SocketStub.sockets.length).toBeGreaterThan(beforeRecovery);
    const replacement = SocketStub.sockets.at(-1)!; replacement.open();
    await vi.advanceTimersByTimeAsync(16); await flush();
    expect(replacement.sent.map(body => JSON.parse(body)).some(message => message.type === "sensor_frame")).toBe(true);
    click("#stopHandheld"); await flush();
    const stopped = SocketStub.sockets.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(SocketStub.sockets).toHaveLength(stopped);
  });
  it("stops a late camera open after the user returns home", async () => {
    const pending = deferred<MediaStream>(); const late = cameraStream(); getUserMedia.mockReturnValueOnce(pending.promise);
    await enterCamera(); await beginCamera(); click("#cameraHome"); await flush();
    pending.resolve(late.stream); await flush();
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(document.body.dataset.role).toBe("home");
    expect(mocks.createPose).not.toHaveBeenCalled(); expect(SocketStub.sockets).toHaveLength(0);
  });
  it("closes a model loaded after stop, without putting the UI back into running", async () => {
    const pending = deferred<ReturnType<typeof emptyModel>>(); const late = emptyModel(); mocks.createPose.mockReturnValueOnce(pending.promise);
    await enterCamera(); await beginCamera(); click("#stopButton"); await flush();
    pending.resolve(late); await flush();
    expect(late.close).toHaveBeenCalledOnce();
    expect(window.__motionDebug.modelState).toBe("idle"); expect(element("#runtimeCard").classes.has("hidden")).toBe(true);
  });
  it("old socket events and a late model cannot overwrite a restarted session", async () => {
    const pending = deferred<ReturnType<typeof emptyModel>>(); const oldModel = emptyModel(); mocks.createPose.mockReturnValueOnce(pending.promise);
    await enterCamera(); await beginCamera(); const old = SocketStub.sockets[0];
    click("#stopButton"); await flush(); await beginCamera();
    const replacement = SocketStub.sockets[1]; replacement.open(); await flush();
    old.dispatchEvent(new Event("close")); old.message({ type: "game_output_state_v1", enabled: false });
    pending.resolve(oldModel); await flush();
    expect(oldModel.close).toHaveBeenCalledOnce();
    expect(element("#runtimeCard").dataset.link).toBe("online"); expect(window.__motionDebug.modelState).toBe("ready");
    expect(replacement.readyState).toBe(SocketStub.OPEN);
  });
  it("clears control and trigger state immediately when stopping a camera session", async () => {
    await enterCamera(); await beginCamera(); const ws = SocketStub.sockets[0]; ws.open();
    ws.message({ type: "game_output_state_v1", enabled: true, ok: false, error: "previous output error" });
    ws.message({ type: "trigger_state_v1", held: [{ id: "jump", name: "跳跃" }], fired: [{ id: "jump", name: "跳跃" }] });
    expect(element("#gameControlButton").disabled).toBe(false);
    expect(element("#gameControlButton").classes.has("enabled")).toBe(true);
    expect(element("#cameraTriggerBoard").classes.has("idle")).toBe(false);
    click("#stopButton"); await flush();
    expect(element("#gameControlButton").disabled).toBe(true);
    expect(element("#gameControlButton").textContent).toBe("连接电脑中");
    expect(element("#gameControlButton").classes.has("enabled")).toBe(false);
    expect(element("#gameControlButton").title).toBe("");
    expect(element("#cameraTriggerBoard").classes.has("idle")).toBe(true);
    expect(element("#cameraTriggerBoard").classes.has("hidden")).toBe(true);
    await beginCamera(); const replacement = SocketStub.sockets[1]; replacement.open();
    click("#gameControlButton");
    expect(replacement.sent.map(body => JSON.parse(body)).some(message => message.type === "game_output_control")).toBe(false);
  });
  it("invalidates camera work when backgrounding during startup, then resumes once", async () => {
    const pending = deferred<MediaStream>(); const late = cameraStream(); getUserMedia.mockReturnValueOnce(pending.promise);
    await enterCamera(); await beginCamera();
    (document as unknown as { hidden: boolean }).hidden = true; documentEvents.dispatchEvent(new Event("visibilitychange")); await flush();
    pending.resolve(late.stream); await flush();
    expect(late.track.stop).toHaveBeenCalledOnce(); expect(mocks.createPose).not.toHaveBeenCalled();
    (document as unknown as { hidden: boolean }).hidden = false; documentEvents.dispatchEvent(new Event("visibilitychange")); await flush();
    await vi.advanceTimersByTimeAsync(110); await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(2); expect(mocks.createPose).toHaveBeenCalledOnce();
  });
  it("reopens an ended camera track once and ignores events from the old track", async () => {
    const first = cameraStream(); const replacement = cameraStream();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(replacement.stream);
    await enterCamera(); await beginCamera();
    first.track.dispatchEvent(new Event("ended")); await vi.advanceTimersByTimeAsync(110); await flush();
    first.track.dispatchEvent(new Event("ended")); await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(2); expect(window.__motionDebug.cameraRecoveries).toBe(1);
    expect(element("#camera").srcObject).toBe(replacement.stream);
  });
  it("falls back to CPU on runtime inference errors and stops after two recovery attempts", async () => {
    const broken = () => ({ close: vi.fn(), detectForVideo() { throw new Error("GPU context lost"); } });
    mocks.createPose.mockImplementation(async () => broken());
    await enterCamera(); await beginCamera(); SocketStub.sockets[0].open();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(500); element("#camera").currentTime += 0.5; videoFrame(); await flush();
    }
    expect(mocks.createPose).toHaveBeenCalledTimes(3);
    expect(mocks.createPose.mock.calls[1][1].baseOptions.delegate).toBe("CPU");
    expect(window.__motionDebug.modelRecoveries).toBe(2);
    expect(element("#runtimeCard").classes.has("hidden")).toBe(true);
    expect(element("#securityWarning").textContent).toContain("连续出错");
  });
  it("counts new video frames instead of 60 Hz display callbacks", async () => {
    await enterCamera(); await beginCamera();
    for (let frame = 0; frame < 60; frame++) {
      if (frame % 2 === 0) element("#camera").currentTime += 1 / 30;
      await vi.advanceTimersByTimeAsync(1000 / 60); videoFrame();
    }
    await vi.advanceTimersByTimeAsync(40); element("#camera").currentTime += 1 / 30; videoFrame();
    expect(Number.parseInt(element("#cameraFps").textContent)).toBeLessThanOrEqual(32);
    expect(Number.parseInt(element("#cameraFps").textContent)).toBeGreaterThanOrEqual(29);
  });
  it("recovers a blackholed OPEN socket within the application response deadline", async () => {
    await enterCamera(); await beginCamera(); const old = SocketStub.sockets[0]; old.open();
    const frames = setInterval(() => { element("#camera").currentTime += 0.5; videoFrame(); }, 500);
    await vi.advanceTimersByTimeAsync(10000); await flush(); clearInterval(frames);
    expect(old.readyState).toBe(SocketStub.CLOSED); expect(SocketStub.sockets.length).toBeGreaterThan(1);
    expect(old.sent.some(body => JSON.parse(body).type === "clock_sync")).toBe(true);
  });
  it("ignores late legacy audio startup and closes its recorder after stop", async () => {
    await enterCamera(); await beginCamera(); SocketStub.sockets[0].open();
    const pending = deferred<{ audioReady: boolean; recognizerReady: boolean }>(); mocks.plugins.NativeAudio.start.mockReturnValueOnce(pending.promise);
    element("#voiceToggle").checked = true; element("#voiceToggle").dispatchEvent(new Event("change")); await flush();
    expect(mocks.plugins.NativeAudio.start).toHaveBeenCalledOnce(); click("#stopButton"); await flush();
    const stopCalls = mocks.plugins.NativeAudio.stop.mock.calls.length;
    pending.resolve({ audioReady: true, recognizerReady: true }); await flush();
    expect(mocks.plugins.NativeAudio.stop.mock.calls.length).toBeGreaterThan(stopCalls);
    expect(element("#voiceState").textContent).toBe("关闭");
  });
  it("drops congested sensor frames and preserves their real native sample age", async () => {
    click("#handheldRole"); await flush();
    const ws = SocketStub.sockets[0]; ws.open(); ws.bufferedAmount = 8193;
    await vi.advanceTimersByTimeAsync(100);
    expect(ws.sent.filter(body => JSON.parse(body).type === "sensor_frame")).toHaveLength(0);
    expect(window.__motionDebug.sensorDroppedFrames).toBeGreaterThan(0);
    ws.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(20);
    const frames = ws.sent.map(body => JSON.parse(body)).filter(frame => frame.type === "sensor_frame");
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].sent_at_ms - frames[0].captured_at_ms).toBe(40);
    expect(frames[0].sequence).toBeGreaterThan(0);
  });
  it("omits unavailable or invalid optional samples before gyro calibration", async () => {
    const { GyroMouse } = await import("./gyro-mouse");
    const update = vi.spyOn(GyroMouse.prototype, "update").mockReturnValue({ dx: 0, dy: 0, calibrating: true });
    let sample = { qx: 0, qy: 0, qz: 0, qw: 1, gx: 0, gy: 0, gz: 0, ax: 0, ay: 9.8, az: 0,
      running: true, timestamp: 1, sample_age_ms: 0, accelerationIncludesGravity: true,
      accelerationAvailable: true as boolean | undefined, rotationAvailable: true,
      acceleration_age_ms: -1 as number | undefined, rotation_age_ms: -1 as number | undefined };
    mocks.plugins.SensorBridge.getLatest = async () => sample;
    Object.assign(mocks.plugins.BluetoothController, {
      start: async () => ({ supported: true, enabled: true, registered: true, connected: true, connecting: false,
        devices: [], sessionId: 1, message: "已连接" }),
      addListener: async () => ({ remove: async () => {} }), sendMouse: async () => ({ sent: true }),
    });
    element("#handheldMode").value = "shooter"; element("#handheldTransport").value = "bluetooth";
    click("#handheldRole"); await flush();
    for (const age of [-1, NaN, Infinity, 151]) {
      sample = { ...sample, acceleration_age_ms: age, rotation_age_ms: age };
      await vi.advanceTimersByTimeAsync(16); await flush();
      const input = update.mock.calls.at(-1)![0];
      expect([input.ax, input.ay, input.az, input.qx, input.qy, input.qz, input.qw]).toEqual(Array(7).fill(undefined));
    }
    sample = { ...sample, acceleration_age_ms: 0, rotation_age_ms: 0, accelerationAvailable: false };
    await vi.advanceTimersByTimeAsync(16); await flush();
    expect(update.mock.calls.at(-1)![0].ay).toBeUndefined();
    expect(update.mock.calls.at(-1)![0].qw).toBe(1);
    // A legacy APK omits ages/availability; retain its optional data behavior.
    sample = { ...sample, acceleration_age_ms: undefined, rotation_age_ms: undefined, accelerationAvailable: undefined };
    await vi.advanceTimersByTimeAsync(16); await flush();
    expect(update.mock.calls.at(-1)![0].ay).toBe(9.8);
    expect(update.mock.calls.at(-1)![0].qw).toBe(1);
  });
  it.each(["shooter", "gamepad"])("ignores a late %s output completion after starting a new controller session", async mode => {
    const pending = deferred<{ sent: boolean }>();
    const send = vi.fn(() => pending.promise);
    Object.assign(mocks.plugins.BluetoothController, {
      start: async () => ({ supported: true, enabled: true, registered: true, connected: true, connecting: false,
        devices: [], sessionId: 1, message: "已连接" }),
      addListener: async () => ({ remove: async () => {} }), sendMouse: send, sendGamepad: send,
    });
    element("#handheldMode").value = mode; element("#handheldTransport").value = "bluetooth";
    click("#handheldRole"); await flush(); click("#handheldGameControlButton");
    await vi.advanceTimersByTimeAsync(16); await flush();
    expect(send).toHaveBeenCalledOnce();
    click("#stopHandheld"); await flush();
    element("#handheldMode").value = "gamepad"; element("#handheldTransport").value = "network";
    click("#handheldRole"); await flush(); const replacement = SocketStub.sockets[0]; replacement.open();
    // An old native promise must not block polling for the new generation.
    await vi.advanceTimersByTimeAsync(16); await flush();
    expect(replacement.sent.map(body => JSON.parse(body)).some(message => message.type === "sensor_frame")).toBe(true);
    click("#centerSensor");
    pending.resolve({ sent: true }); await flush();
    expect(element("#sensorState").textContent).toBe("正在居中");
    await vi.advanceTimersByTimeAsync(16); await flush();
    const frames = replacement.sent.map(body => JSON.parse(body)).filter(message => message.type === "sensor_frame");
    expect(frames.at(-1).recenter).toBe(true);
  });
  it("retries a failed web update while keeping a responsive camera connection", async () => {
    mocks.plugins.WebUpdate.sync.mockResolvedValueOnce({ state: "failed" }).mockResolvedValue({ state: "current" });
    await enterCamera(); await beginCamera(); const ws = SocketStub.sockets[0];
    ws.open();
    const send = ws.send.bind(ws);
    ws.send = body => { send(body); const message = JSON.parse(body); if (message.type === "clock_sync") ws.message({ ...message, server_ms: Date.now() }); };
    ws.message({ type: "control_config_v1" }); await flush();
    expect(mocks.plugins.WebUpdate.sync).toHaveBeenCalledOnce();
    const frames = setInterval(() => { element("#camera").currentTime += 0.5; videoFrame(); }, 500);
    await vi.advanceTimersByTimeAsync(30050); await flush(); clearInterval(frames);
    expect(mocks.plugins.WebUpdate.sync).toHaveBeenCalledTimes(2);
    expect(ws.readyState).toBe(SocketStub.OPEN);
  });
  it("网页需要新壳子时马上问新版 APK：功能更新弹一次，以后再说记住版本，按钮下载后交给系统安装", async () => {
    expect(mocks.plugins.AppUpdate.check).toHaveBeenCalledOnce();
    expect(element("#appUpdateButton").hidden).toBe(true);
    element("#releaseNotes").hidden = true; element("#appUpdateDialog").hidden = true;
    mocks.plugins.AppUpdate.check.mockResolvedValue({ state: "available", version: "2.4.0", kind: "feature", size: 1048576,
      sections: [{ title: "新增", items: ["App 内更新"] }] });
    mocks.plugins.WebUpdate.sync.mockResolvedValue({ state: "incompatible" });
    await enterCamera(); await beginCamera(); const ws = SocketStub.sockets[0];
    ws.open(); ws.message({ type: "control_config_v1" }); await flush();
    expect(mocks.plugins.AppUpdate.check).toHaveBeenCalledTimes(2);
    expect(element("#appUpdateDialog").hidden).toBe(false);
    expect(element("#appUpdateTitle").textContent).toBe("新版 App 2.4.0");
    expect(element("#appUpdateLine").textContent).toBe("新版 App 2.4.0 可以更新，1.0 MB");
    click("#appUpdateLater");
    expect(element("#appUpdateDialog").hidden).toBe(true);
    expect(localStorage.getItem("motionbridge-app-update-dismissed")).toBe("2.4.0");
    click("#appUpdateButton"); await flush();
    expect(mocks.plugins.AppUpdate.download).toHaveBeenCalledOnce();
    expect(mocks.plugins.AppUpdate.install).toHaveBeenCalledOnce();
    expect(element("#appUpdateLine").textContent).toBe("正在打开系统安装…");
    expect(element("#appUpdateButton").hidden).toBe(true);
  });
});

describe("worker inference through actual camera events", () => {
  it("terminates a worker immediately when stopping before its model is ready", async () => {
    workerPlatform(); await enterCamera(); await beginCamera();
    const worker = mocks.createWorker.mock.results[0].value as VisionWorkerStub;
    expect(worker.messages[0]).toMatchObject({ type: "init", poseModelUrl: "http://localhost/models/pose_landmarker_full.task" });
    click("#stopButton"); await flush(); expect(worker.terminate).toHaveBeenCalledOnce();
    worker.ready(); await flush(); expect(window.__motionDebug.modelState).toBe("idle");
    expect(mocks.createPose).not.toHaveBeenCalled();
  });
  it("uses same-frame pose and both hands with the captured frame time while inference is asynchronous", async () => {
    workerPlatform(); await enterCamera(); await beginCamera();
    const worker = mocks.createWorker.mock.results[0].value as VisionWorkerStub;
    worker.ready(); await flush(); const ws = SocketStub.sockets[0]; ws.open();
    ws.message({ type: "control_config_v1", hand_tracking: { enabled: true, hands: ["left", "right"] } });
    await vi.advanceTimersByTimeAsync(35); element("#camera").currentTime = .035; videoFrame(); await flush();
    const frame = worker.messages.find(message => message.type === "frame");
    expect(frame.hands).toEqual(["left", "right"]); expect(frame.inferenceSide).toBe(512);
    expect(mocks.createPose).not.toHaveBeenCalled(); expect(mocks.createHand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60); worker.result(frame.id); await flush();
    const sent = ws.sent.map(body => JSON.parse(body)).find(message => message.type === "pose_features_v1");
    expect(sent.captured_at_ms).toBe(frame.capturedAtMs); expect(sent.sent_at_ms - sent.captured_at_ms).toBe(60);
    expect(sent.width).toBe(480); expect(sent.height).toBe(640); expect(sent.points).toHaveLength(33);
    expect(sent.world_points).toHaveLength(33); expect(sent.hands.map((hand: any) => hand.handedness)).toEqual(["Left", "Right"]);
    expect(window.__motionDebug.inferenceBackend).toBe("worker");
    click("#stopButton"); await flush();
  });
  it("discards a completed inference from the old lens after switching the camera", async () => {
    workerPlatform(); await enterCamera(); await beginCamera();
    const worker = mocks.createWorker.mock.results[0].value as VisionWorkerStub;
    worker.ready(); await flush(); const ws = SocketStub.sockets[0]; ws.open();
    await vi.advanceTimersByTimeAsync(35); element("#camera").currentTime = .035; videoFrame(); await flush();
    const old = worker.messages.find(message => message.type === "frame");
    click("#flipCameraButton"); await vi.advanceTimersByTimeAsync(110); await flush();
    worker.result(old.id); await flush();
    expect(ws.sent.map(body => JSON.parse(body)).filter(message => message.type === "pose_features_v1")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(35); element("#camera").currentTime = .2; videoFrame(); await flush();
    const replacement = worker.messages.filter(message => message.type === "frame").at(-1);
    worker.result(replacement.id); await flush();
    expect(ws.sent.map(body => JSON.parse(body)).filter(message => message.type === "pose_features_v1")).toHaveLength(1);
    expect(mocks.createWorker).toHaveBeenCalledOnce(); click("#stopButton"); await flush();
  });
  it("closes a bitmap captured after stop without sending it to the terminated worker", async () => {
    workerPlatform(); const pending = deferred<ImageBitmap>(); const bitmap = { width: 384, height: 512, close: vi.fn() } as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockReturnValueOnce(pending.promise);
    await enterCamera(); await beginCamera(); const worker = mocks.createWorker.mock.results[0].value as VisionWorkerStub;
    worker.ready(); await flush(); SocketStub.sockets[0].open();
    await vi.advanceTimersByTimeAsync(35); element("#camera").currentTime = .035; videoFrame(); await flush();
    click("#stopButton"); await flush(); pending.resolve(bitmap); await flush();
    expect(bitmap.close).toHaveBeenCalledOnce(); expect(worker.messages.filter(message => message.type === "frame")).toHaveLength(0);
  });
  it("falls back once to the main-thread CPU path after a worker runtime failure", async () => {
    workerPlatform(); await enterCamera(); await beginCamera();
    const worker = mocks.createWorker.mock.results[0].value as VisionWorkerStub;
    worker.ready(); await flush(); worker.receive({ type: "error", message: "worker GPU context lost" }); await flush();
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(mocks.createWorker).toHaveBeenCalledOnce();
    expect(mocks.createPose).toHaveBeenCalledOnce(); expect(mocks.createPose.mock.calls[0][1].baseOptions.delegate).toBe("CPU");
    expect(window.__motionDebug.inferenceBackend).toBe("main");
    expect(window.__motionDebug.workerFallbackError).toContain("context lost");
    expect(window.__motionDebug.modelRecoveries).toBe(1); click("#stopButton"); await flush();
  });
});
