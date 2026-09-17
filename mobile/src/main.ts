import { DrawingUtils, FilesetResolver, HandLandmarker, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { App } from "@capacitor/app";
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { PairingSession, isPairingMessage } from "./pairing-session";
import type { PairRole } from "./pairing-crypto";
import "./style.css";

type ConnectionState = "offline" | "connecting" | "online" | "error";
type VoiceStatus = "off" | "connecting" | "listening" | "error" | "unauthorized";
type ModelChoice = "full" | "lite";
type SyncedAction = { type?: string; target?: string; behavior?: string };
type SyncedBinding = { label?: string; action?: SyncedAction; disabled?: boolean };
type ControlConfigV1 = {
  type: "control_config_v1";
  version?: string;
  game?: { id?: string; name?: string; appid?: number | null };
  bindings?: { zones?: Record<string, SyncedBinding>; motions?: Record<string, SyncedBinding>; poses?: Record<string, SyncedBinding>; voice?: Record<string, SyncedBinding> };
  zones?: Record<string, unknown>;
  vertical_look?: Record<string, unknown>;
  // Every phrase the desktop can act on.  The recognizer here is built from
  // this list, so the two sides cannot drift apart.
  voice_phrases?: string[];
  // Whether to run the hand model, and on which hand.  The desktop asks only
  // while it is actually steering with a hand -- see the hand joint section.
  hand_tracking?: { enabled?: boolean; hand?: string };
  // Every address the desktop can be reached at, best link first.
  server_candidates?: { host?: string; port?: number; kind?: string }[];
};
type SensorSample = { qx: number; qy: number; qz: number; qw: number; gx: number; gy: number; gz: number; ax: number; ay: number; az: number; timestamp: number; running: boolean };
type MotionDebug = {
  videoReady: boolean;
  videoWidth: number;
  videoHeight: number;
  facingMode: "user" | "environment";
  modelState: "idle" | "loading" | "ready" | "error";
  modelUrl: string;
  actualModel: ModelChoice;
  delegate: "GPU" | "CPU" | "unknown";
  fallbackError: string | null;
  detectCalls: number;
  lastDetectError: string | null;
  lastPoseCount: number;
  lastInferenceMs: number;
};
declare global { interface Window { __motionDebug: MotionDebug; } }
type LocalVoiceText = { text: string; confidence?: number; final: boolean; recognizer: string; recognizedAtMs: number };
type NativeAudioApi = {
  start(options?: { phrases?: string[] }): Promise<{ sampleRate: number; channels: number; format: string; source: string; recognizerReady: boolean; audioReady: boolean }>;
  stop(): Promise<void>;
  addListener(eventName: "voiceText", listener: (event: LocalVoiceText) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "voiceState", listener: (event: { state: string; message: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "audioError", listener: (event: { message: string }) => void): Promise<PluginListenerHandle>;
};
const NativeAudio = registerPlugin<NativeAudioApi>("NativeAudio");
const SensorBridge = registerPlugin<{ start(): Promise<void>; getLatest(): Promise<SensorSample>; stop(): Promise<void> }>("SensorBridge");

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div id="cameraStage"><video id="camera" autoplay playsinline muted></video><canvas id="overlay"></canvas><div class="shade"></div><canvas id="inferenceCanvas" aria-hidden="true"></canvas></div>
  <header class="app-header"><div class="mobile-brand"><p>MOTIONCONTROL 2.0.0</p><h1 id="pageTitle">手机控制端</h1><small>固定摄像头 · 手持控制器</small></div><div id="connectionBadge" class="badge"><i></i><b>未连接电脑</b></div></header>
  <main>
    <section class="setup-card role-card" id="roleCard">
      <span class="eyebrow">开始</span><h2>这台手机要做什么？</h2><p class="role-lead">固定在玩家前方时选“摄像头”；拿在手里时选“手持手柄”。</p>
      <div class="role-grid"><button id="cameraRole" class="role-option recommended"><span class="role-symbol">●</span><strong>固定摄像头</strong><small>推荐 · 识别人和动作</small></button><button id="handheldRole" class="role-option"><span class="role-symbol">◆</span><strong>手持手柄</strong><small>陀螺仪 + 虚拟按键</small></button></div>
    </section>
    <section class="setup-card hidden" id="setupCard">
      <div class="card-head"><div><span class="eyebrow">摄像头模式</span><h2>连接电脑</h2></div><button id="cameraHome" class="text-button">返回</button></div>
      <p class="setup-help">电脑端保持 MotionControl 打开，填写它显示的局域网地址即可。以后会自动记住。</p>
      <label>电脑地址<input id="serverUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑IP:8765/ws/input"></label>
      <label>使用镜头<select id="cameraDeviceSelect"><option value="__auto__">自动选择</option></select></label>
      <label class="technical">识别模型<select id="modelSelect"><option value="full">Full（精度）</option></select></label>
      <div class="actions"><button id="startButton" class="start-primary">连接并开始</button></div><p class="warning" id="securityWarning"></p>
    </section>
    <section class="runtime-card hidden" id="runtimeCard">
      <div class="runtime-primary"><div><span class="eyebrow">识别状态</span><strong id="sendState">等待完整人体</strong></div><span class="runtime-link">电脑 <b id="panelConnection">未连接</b></span></div>
      <div class="profile-sync" id="cameraProfileSync"><div class="profile-sync-head"><span>当前游戏</span><b id="cameraProfileGame">等待电脑同步</b><small id="cameraProfileState">未同步</small></div><div id="cameraProfileCoverage" class="profile-coverage">等待映射</div><div class="profile-sync-bindings" id="cameraProfileBindings"></div></div>
      <div class="technical runtime-tech"><span>摄像头 <b id="cameraFps">0 FPS</b></span><span>识别 <b id="localFps">0 FPS</b></span><span id="modelStatus">Full33</span><span id="delegateStatus">—</span><small id="modelError"></small></div>
      <div class="runtime-camera-choice"><span class="control-label">镜头方向</span><div class="camera-buttons" role="group" aria-label="选择镜头"><button id="frontCameraButton" type="button" aria-pressed="false">前置</button><button id="backCameraButton" type="button" aria-pressed="false">后置</button></div><small id="cameraSwitchState" class="camera-switch-state"></small></div>
      <div class="runtime-actions"><div class="runtime-voice" id="voiceControl"><label><input id="voiceToggle" type="checkbox"><span>语音控制</span></label><span id="voiceState">关闭</span></div><button id="hideStatus" class="status-hide" type="button">沉浸显示</button><button id="stopButton" class="stop">停止</button></div>
    </section>
    <button id="showStatus" class="status-show hidden" type="button">显示控制</button>
    <section class="handheld-card hidden" id="handheldCard">
      <div class="handheld-top handheld-connection-row"><span id="handheldConnection" class="badge"><i></i><b>未连接电脑</b></span><label>电脑地址<input id="handheldServerUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑IP:8765/ws/input"></label></div>
      <div class="profile-sync handheld-profile-sync" id="handheldProfileSync"><div class="profile-sync-head"><span>当前游戏</span><b id="handheldProfileGame">等待电脑同步</b><small id="handheldProfileState">未同步</small></div><div id="handheldProfileCoverage" class="profile-coverage">等待映射</div><div class="profile-sync-bindings" id="handheldProfileBindings"></div></div>
      <div class="handheld-top"><label>玩家<select id="handheldSlot"><option value="0">玩家一</option><option value="1">玩家二</option></select></label><span><b id="sensorFps">0 FPS</b><small id="sensorState">等待传感器</small></span><button id="centerSensor">重新居中</button><button id="stopHandheld" class="stop">停止</button></div>
      <div class="shoulders"><button data-pad="l">LB</button><button data-pad="zl">LT</button><button data-pad="zr">RT</button><button data-pad="r">RB</button></div><div class="gamepad"><div id="stick" class="stick"><i></i></div><div class="middle-buttons"><button data-pad="select">选择</button><button data-pad="start">开始</button></div><div class="face-buttons"><button data-pad="y">Y</button><button data-pad="x">X</button><button data-pad="b">B</button><button data-pad="a">A</button></div></div>
    </section>
  </main>
  <div class="pairing hidden" id="pairingDialog">
      <div class="pairing-box">
        <h2>首次配对</h2>
        <p class="pairing-help">在电脑的 MotionControl 里点“配对新设备”，把屏幕上的 8 位数字填在这里。配对码 2 分钟内有效。</p>
        <input id="pairingCode" inputmode="numeric" maxlength="8" placeholder="8 位配对码" autocomplete="off">
        <p class="pairing-status" id="pairingStatus"></p>
        <div class="actions"><button id="pairingSubmit" class="start-primary">完成配对</button><button id="pairingCancel" class="text-button">稍后</button></div>
      </div>
    </div>
  <div class="guide hidden" id="guide"></div><div class="loading hidden" id="loading"><i></i><b id="loadingText">正在打开摄像头</b></div>`;

const video = document.querySelector<HTMLVideoElement>("#camera")!;
const canvas = document.querySelector<HTMLCanvasElement>("#overlay")!;
const context = canvas.getContext("2d")!;
const inferenceCanvas = document.querySelector<HTMLCanvasElement>("#inferenceCanvas")!;
const inferenceContext = inferenceCanvas.getContext("2d", { alpha: false })!;
const serverInput = document.querySelector<HTMLInputElement>("#serverUrl")!;
const handheldServerInput = document.querySelector<HTMLInputElement>("#handheldServerUrl")!;
const cameraDeviceSelect = document.querySelector<HTMLSelectElement>("#cameraDeviceSelect")!;
const modelSelect = document.querySelector<HTMLSelectElement>("#modelSelect")!;
const modelStatus = document.querySelector<HTMLElement>("#modelStatus")!;
const roleCard = document.querySelector<HTMLElement>("#roleCard")!;
const setupCard = document.querySelector<HTMLElement>("#setupCard")!;
const runtimeCard = document.querySelector<HTMLElement>("#runtimeCard")!;
const handheldCard = document.querySelector<HTMLElement>("#handheldCard")!;
const badge = document.querySelector<HTMLElement>("#connectionBadge")!;
const voiceControl = document.querySelector<HTMLElement>("#voiceControl")!;
const voiceToggle = document.querySelector<HTMLInputElement>("#voiceToggle")!;
voiceToggle.checked = localStorage.getItem("motionbridge-voice-auto") !== "0";
const voiceStateLabel = document.querySelector<HTMLElement>("#voiceState")!;
const hideStatus = document.querySelector<HTMLButtonElement>("#hideStatus")!;
const showStatus = document.querySelector<HTMLButtonElement>("#showStatus")!;
const frontCameraButton = document.querySelector<HTMLButtonElement>("#frontCameraButton")!;
const backCameraButton = document.querySelector<HTMLButtonElement>("#backCameraButton")!;
const cameraSwitchState = document.querySelector<HTMLElement>("#cameraSwitchState")!;

let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let poseLandmarker: PoseLandmarker | null = null;
let stream: MediaStream | null = null;
let socket: WebSocket | null = null;
let handheldSocket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let handheldTimer: number | null = null;
let wakeLock: WakeLockSentinel | null = null;
let nativeVoiceTextListener: PluginListenerHandle | null = null;
let nativeVoiceStateListener: PluginListenerHandle | null = null;
let nativeAudioErrorListener: PluginListenerHandle | null = null;
let running = false;
let activeRole: "home" | "camera" | "handheld" = "home";
let facingMode: "user" | "environment" = "environment";
let selectedCameraDeviceId = "__auto__";
// Only the Full model ships: Lite saved 5.5 MB of build but nothing chose it,
// and a stale "lite" in storage would ask for a file that is no longer there.
let modelChoice: ModelChoice = "full";
let cameraDevices: MediaDeviceInfo[] = [];
let voiceEnabled = false;
let voiceState: VoiceStatus = "off";
let sequence = 0;
let lastVideoTime = -1;
let lastInferenceAt = 0;
let inferenceBusy = false;
let fpsCounter = 0;
let fpsStarted = performance.now();
let cameraFrameCount = 0;
let cameraFpsStarted = performance.now();
let cameraFrameLoop = false;
let serverClockOffsetMs = 0;
let lastClockSyncAt = 0;
let lastServerPoseCount = 0;
let handheldSequence = 0;
let handheldRecenter = false;
let handheldFrames = 0;
let handheldFpsStarted = performance.now();
let sensorPolling = false;
let stickState = { x: 0, y: 0 };
const CONTROL_CONFIG_STORAGE_KEY = "motionbridge-control-config-v1";
let syncedControlConfig: ControlConfigV1 | null = loadCachedControlConfig();
let controlConfigFresh = false;
const ZONE_SYNC_ORDER = [
  ["leftHandUpper", "左手上", "Y"],
  ["leftHandLower", "左手下", "X"],
  ["rightHandUpper", "右手上", "B"],
  ["rightHandLower", "右手下", "A"],
  ["leftFoot", "左脚", "LB"],
  ["rightFoot", "右脚", "RB"],
] as const;
function loadCachedControlConfig(): ControlConfigV1 | null {
  try {
    const raw = localStorage.getItem(CONTROL_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ControlConfigV1;
    return parsed?.type === "control_config_v1" ? parsed : null;
  } catch { return null; }
}
function actionText(action: SyncedAction | undefined, fallback: string): string {
  const type = String(action?.type || "");
  const target = String(action?.target || "").toUpperCase();
  if (!type || !target) return `默认 ${fallback}`;
  if (type === "keyboard") return `键盘 ${target}`;
  if (type === "mouse_button") return `鼠标 ${{ LEFT: "左键", RIGHT: "右键", MIDDLE: "中键", X1: "侧键1", X2: "侧键2" }[target as "LEFT" | "RIGHT" | "MIDDLE" | "X1" | "X2"] || target}`;
  if (type === "mouse_wheel") return `滚轮 ${target.includes("UP") ? "↑" : target.includes("DOWN") ? "↓" : target}`;
  if (type === "gamepad_axis") return `左摇杆 ${target.endsWith("UP") ? "↑" : target.endsWith("DOWN") ? "↓" : target.endsWith("LEFT") ? "←" : target.endsWith("RIGHT") ? "→" : target}`;
  if (type === "gamepad_trigger") return `Xbox ${target}`;
  if (type === "gamepad") return `Xbox ${target}`;
  return `${type} ${target}`;
}
function renderControlConfig(): void {
  const config = syncedControlConfig;
  const gameName = config?.game?.name || config?.game?.id || "等待电脑同步";
  const state = config ? (controlConfigFresh ? "已同步" : "缓存") : "未同步";
  const zones = config?.bindings?.zones || {};
  const motionCount = Object.keys(config?.bindings?.motions || {}).length;
  const poseCount = Object.keys(config?.bindings?.poses || {}).length;
  const voiceCount = Object.keys(config?.bindings?.voice || {}).length;
  const zoneCount = Object.keys(zones).length;
  const coverageText = config ? `${zoneCount} 区域 · ${motionCount + poseCount} 动作 · ${voiceCount} 语音` : "等待映射";
  const bindingHtml = ZONE_SYNC_ORDER.map(([id, label, fallback]) => {
    const binding = zones[id];
    const text = binding?.disabled ? "关闭" : actionText(binding?.action, fallback);
    return `<span><i>${label}</i><b>${text}</b></span>`;
  }).join("");
  for (const [gameId, stateId, bindingsId, coverageId] of [["cameraProfileGame", "cameraProfileState", "cameraProfileBindings", "cameraProfileCoverage"], ["handheldProfileGame", "handheldProfileState", "handheldProfileBindings", "handheldProfileCoverage"]] as const) {
    const game = document.querySelector<HTMLElement>(`#${gameId}`);
    const stateEl = document.querySelector<HTMLElement>(`#${stateId}`);
    const bindings = document.querySelector<HTMLElement>(`#${bindingsId}`);
    const coverage = document.querySelector<HTMLElement>(`#${coverageId}`);
    if (game) game.textContent = gameName;
    if (stateEl) { stateEl.textContent = state; stateEl.className = controlConfigFresh ? "fresh" : config ? "cached" : ""; }
    if (coverage) coverage.textContent = coverageText;
    if (bindings) bindings.innerHTML = bindingHtml;
  }
}
let activeVoicePhrases = "";
function voicePhrases(): string[] {
  const list = syncedControlConfig?.voice_phrases;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}
function applyControlConfig(message: unknown): void {
  if (!message || typeof message !== "object" || (message as { type?: string }).type !== "control_config_v1") return;
  syncedControlConfig = message as ControlConfigV1;
  controlConfigFresh = true;
  // 只在电脑真的发来配置时才动手部模型。缓存下来的那份不算数：刚启动、还没连
  // 上电脑就先加载 7.8 MB 的模型，是白占内存。
  syncHandTracking();
  rememberCandidates(syncedControlConfig.server_candidates);
  try { localStorage.setItem(CONTROL_CONFIG_STORAGE_KEY, JSON.stringify(syncedControlConfig)); } catch { /* Cache is optional. */ }
  renderControlConfig();
  // The grammar is fixed when the recognizer is built, so a phrase edited on
  // the desktop only becomes audible after a rebuild.  Restart just for a real
  // change: config arrives on every edit and on every reconnect.
  const phrases = voicePhrases().join(" ");
  if (voiceEnabled && phrases && phrases !== activeVoicePhrases) {
    void (async () => { await stopVoiceControl(false); await startVoiceControl(); })();
  }
}
function markControlConfigCached(): void {
  if (!syncedControlConfig) return;
  controlConfigFresh = false;
  renderControlConfig();
}

const CAMERA_TARGET_FPS = 30;
const MAX_INFERENCE_FPS = 28;
const MIN_INFERENCE_INTERVAL_MS = 1000 / MAX_INFERENCE_FPS;
const OVERLAY_INTERVAL_MS = 100; // 10 FPS visual skeleton; control data stays high-rate.
const MAX_SOCKET_BUFFERED_BYTES = 8 * 1024;
// mc33-v3 sends the whole skeleton. The earlier compact sets skipped indices
// 17-22 -- pinky, index and thumb on both hands -- to save bandwidth. Those six
// points are exactly what a fist looks like: the pose model has no finger
// joints, so the PC reads "closed" from how far those tips sit from the wrist.
// Hand-steered mouse control is impossible without them, and six extra points
// per frame is a small price next to the 27 already being sent.
const POSE_LAYOUT = "mc33-v3";
const CONTROL_POINT_INDICES = Array.from({ length: 33 }, (_, index) => index);
let inferenceMaxSide = 512;
let inferenceEwmaMs = 0;
let lastInferenceResizeAt = 0;
let lastOverlayAt = 0;
let drawingUtils: DrawingUtils | null = null;
let networkDroppedFrames = 0;
let overlayRenderingEnabled = true;
let lastSendStateText = "";
const padState = new Set<string>();
const motionDebug: MotionDebug = window.__motionDebug = {
  videoReady: false,
  videoWidth: 0,
  videoHeight: 0,
  facingMode: "environment",
  modelState: "idle",
  modelUrl: new URL(`./models/pose_landmarker_${modelChoice}.task`, location.href).href,
  actualModel: modelChoice,
  delegate: "unknown",
  fallbackError: null,
  detectCalls: 0,
  lastDetectError: null,
  lastPoseCount: 0,
  lastInferenceMs: 0,
};

// --- device pairing -------------------------------------------------------
// One session per socket: the PC binds an identity to the connection, not to
// the device, so the camera and handheld sockets authenticate independently.
const pairingDialog = document.querySelector<HTMLDivElement>("#pairingDialog")!;
const pairingCodeInput = document.querySelector<HTMLInputElement>("#pairingCode")!;
const pairingStatus = document.querySelector<HTMLParagraphElement>("#pairingStatus")!;
let activePairingSession: PairingSession | null = null;
let cameraPairing: PairingSession | null = null;
let handheldPairing: PairingSession | null = null;

function setPairingStatus(text: string, kind: "info" | "error" = "info"): void {
  pairingStatus.textContent = text;
  pairingStatus.className = kind === "error" ? "pairing-status error" : "pairing-status";
}

function openPairingDialog(session: PairingSession): void {
  activePairingSession = session;
  pairingCodeInput.value = "";
  setPairingStatus("");
  pairingDialog.classList.remove("hidden");
  pairingCodeInput.focus();
}

function closePairingDialog(): void {
  pairingDialog.classList.add("hidden");
}

document.querySelector("#pairingSubmit")!.addEventListener("click", () => {
  void activePairingSession?.submitCode(pairingCodeInput.value);
});
document.querySelector("#pairingCancel")!.addEventListener("click", closePairingDialog);

function makePairingSession(role: PairRole, send: (message: unknown) => void): PairingSession {
  // Declared first so the callbacks can close over the same object the caller
  // gets back; they only ever run after construction has finished.
  const session: PairingSession = new PairingSession(getDeviceId(), role, send, {
    onNeedCode: () => openPairingDialog(session),
    onStatus: (text, kind) => setPairingStatus(text, kind ?? "info"),
    onReady: closePairingDialog,
  });
  return session;
}

function getDeviceId(): string { let value = localStorage.getItem("motionbridge-device-id"); if (!value) { value = `camera-${crypto.randomUUID()}`; localStorage.setItem("motionbridge-device-id", value); } return value; }
const deviceId = getDeviceId();
// ==== 电脑在哪 =============================================================
// 地址是会变的：换个 WiFi 变一次，插上数据线又多一个。让人去记、去填，是这个
// 项目里最常见的一种"坏了"。
//
// 所以电脑一连上就把自己所有能被连到的地址发过来，这边存下来；下次连接挨个试,
// 谁先答应用谁。有线排在最前面——实测手机到电脑，数据线 4.4ms、WiFi 8.3ms，抖
// 动也只有一半。拔了线下次自动落回 WiFi，不用管。
const SERVER_CANDIDATES_KEY = "motionbridge-server-candidates";
// 电脑那边设备口固定在这个端口上。扫描时没有别的线索可用，只能按它来。
const DEVICE_PORT = 8765;
// 一个够到的地址在局域网里几毫秒就答应了。这个时限是留给"根本不通"的那些：
// 超过就别等了，后面还有别的要试。
const SERVER_PROBE_TIMEOUT_MS = 800;
type ServerCandidate = { host: string; port: number; kind: string };

function readCandidates(): ServerCandidate[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SERVER_CANDIDATES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const host = typeof item?.host === "string" ? item.host.trim() : "";
      const port = Number(item?.port);
      if (!host || !Number.isFinite(port) || port <= 0) return [];
      return [{ host, port, kind: typeof item?.kind === "string" ? item.kind : "lan" }];
    });
  } catch {
    return [];
  }
}

function rememberCandidates(list: unknown): void {
  if (!Array.isArray(list) || !list.length) return;
  try { localStorage.setItem(SERVER_CANDIDATES_KEY, JSON.stringify(list)); } catch { /* 存不下就下次再说 */ }
}

// 只问"有没有人在这个地址上应答"。回应是 no-cors 的不透明响应，读不到内容，也
// 不需要读：这些地址本来就是电脑自己报上来的。
async function answers(candidate: ServerCandidate, timeoutMs = SERVER_PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    await fetch(`http://${candidate.host}:${candidate.port}/`, {
      mode: "no-cors", cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

// ---- 一个地址都还没有的时候 ----------------------------------------------
// 电脑连上之后会把地址报过来，那覆盖了以后每一次连接。没覆盖的是第一次，以及
// 报过来的地址后来变了的情况——这时候手里什么都没有，只能自己找。
//
// 找需要网段，网段需要手机自己的地址，而网页里拿不到：WebRTC 以前能从 ICE 候
// 选里漏出来，现代 Chrome 换成 mDNS 名字就是为了堵住这条。所以走原生插件问
// Java 要。
//
// 数据线这条路上这招最有用：USB 网络共享把手机和电脑单独放在一个小网段里，扫
// 一遍又快又必中。但网段是厂商定的，不是标准——AOSP 给 192.168.42.x，写这段时
// 手上这台荣耀给的是 10.119.231.x。硬猜会猜错。
type LocalInterface = { name: string; address: string; prefix: number };
const LocalNetwork = registerPlugin<{
  interfaces(): Promise<{ interfaces: LocalInterface[] }>;
}>("LocalNetwork");

// 只扫 /24 和更小的网段。USB 网络共享永远是 /24，254 个地址，几秒扫得完；学校
// 和公司的 WiFi 常常是 /20 起步，几千个地址，扫它没有意义也扫不完。
const SCAN_MIN_PREFIX = 24;
const SCAN_BATCH = 64;
// 同网段内几毫秒就该有回应，实测数据线上是 4ms。这个时限是留给"那个地址上根本
// 没有机器"的——254 个地址里 253 个都是这种。
const SCAN_TIMEOUT_MS = 400;

function tetherFirst(items: LocalInterface[]): LocalInterface[] {
  const wired = (item: LocalInterface) => /^(rndis|usb|ncm)/i.test(item.name);
  return [...items].sort((a, b) => Number(wired(b)) - Number(wired(a)));
}

async function scanOwnSubnets(): Promise<ServerCandidate | null> {
  let own: LocalInterface[] = [];
  try {
    own = (await LocalNetwork.interfaces()).interfaces || [];
  } catch {
    return null;   // 插件不在（旧壳子），当作找不到
  }
  for (const item of tetherFirst(own)) {
    if (Number(item.prefix) < SCAN_MIN_PREFIX) continue;
    const octets = item.address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isFinite(value))) continue;
    const hosts: string[] = [];
    for (let last = 1; last <= 254; last++) {
      if (last === octets[3]) continue;   // 自己
      hosts.push(`${octets[0]}.${octets[1]}.${octets[2]}.${last}`);
    }
    for (let at = 0; at < hosts.length; at += SCAN_BATCH) {
      const batch = hosts.slice(at, at + SCAN_BATCH);
      const hits = await Promise.all(batch.map(async (host) =>
        (await answers({ host, port: DEVICE_PORT, kind: "usb" }, SCAN_TIMEOUT_MS)) ? host : null));
      const found = hits.find((host) => host !== null);
      if (found) return { host: found, port: DEVICE_PORT, kind: "usb" };
    }
  }
  return null;
}

async function pickServer(typed: string): Promise<string> {
  // 按电脑给的顺序一个个试，而不是一起赛跑：顺序本身带着"哪条更好"的信息，赛
  // 跑会让恰好快那么几毫秒的 WiFi 赢掉数据线。
  for (const candidate of readCandidates()) {
    if (await answers(candidate)) return normalizeSocketUrl(`${candidate.host}:${candidate.port}`);
  }
  // 手填的那个排在缓存后面：它是上一次的，最容易过期，今天就是它把人卡住的。
  const typedCandidate = typed.trim();
  if (typedCandidate) {
    try {
      const parsed = new URL(normalizeSocketUrl(typedCandidate));
      const port = Number(parsed.port) || DEVICE_PORT;
      if (await answers({ host: parsed.hostname, port, kind: "lan" })) {
        return normalizeSocketUrl(typedCandidate);
      }
    } catch { /* 填得不成样子，当作没填 */ }
  }
  // 什么都没答应：自己找一遍。找到就记下来，下次不用再扫。
  const found = await scanOwnSubnets();
  if (found) {
    rememberCandidates([found]);
    return normalizeSocketUrl(`${found.host}:${found.port}`);
  }
  // 都不行：把手填的那个原样交回去，让原来的报错路径去说话。
  return normalizeSocketUrl(typed);
}
// ==== 电脑在哪，到此为止 ===================================================

function normalizeSocketUrl(value: string, path = "/ws/input"): string { const trimmed = value.trim().replace(/\/$/, ""); const parsed = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`); parsed.protocol = ["https:", "wss:"].includes(parsed.protocol) ? "wss:" : "ws:"; parsed.pathname = path; parsed.search = ""; parsed.hash = ""; return parsed.href; }
function getSuggestedServer(): string { const parameter = new URLSearchParams(location.search).get("server"); if (parameter) return normalizeSocketUrl(parameter); if (location.hostname && location.hostname !== "localhost") return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/input`; return ""; }
serverInput.value = localStorage.getItem("motionbridge-server") || getSuggestedServer(); handheldServerInput.value = localStorage.getItem("motionbridge-server") || getSuggestedServer();
handheldServerInput.addEventListener("change", () => { const value = handheldServerInput.value.trim(); if (value) { serverInput.value = value; localStorage.setItem("motionbridge-server", value); } });

function setConnection(state: ConnectionState): void { const text = ({ offline: "未连接电脑", connecting: "连接中", online: "已连接电脑", error: "连接异常" })[state]; badge.className = `badge ${state}`; badge.querySelector("b")!.textContent = text; const panel = document.querySelector<HTMLElement>("#panelConnection"); if (panel) panel.textContent = text; }
function setVoiceStatus(status: VoiceStatus, detail?: string): void { voiceState = status; voiceStateLabel.textContent = detail || ({ off: "关闭", connecting: "连接中", listening: "正在听", error: "错误", unauthorized: "未授权" })[status]; voiceStateLabel.className = `voice-state ${status}`; }
function poseVoiceState(): "not_connected" | "connected" | "enabled" | "unauthorized" | "failed" { return voiceState === "off" ? "not_connected" : voiceState === "connecting" ? "connected" : voiceState === "listening" ? "enabled" : voiceState === "unauthorized" ? "unauthorized" : "failed"; }
function clearWebCamera(): void { cameraFrameLoop = false; stream?.getTracks().forEach((track) => track.stop()); stream = null; video.pause(); video.srcObject = null; video.removeAttribute("src"); video.load(); video.style.display = "none"; }
async function openWebStream(constraints: MediaStreamConstraints): Promise<MediaStream> { return await new Promise<MediaStream>((resolve, reject) => { let finished = false; const timer = window.setTimeout(() => { if (!finished) { finished = true; reject(new Error("摄像头打开超时")); } }, 5000); navigator.mediaDevices.getUserMedia(constraints).then((value) => { if (finished) { value.getTracks().forEach((track) => track.stop()); return; } finished = true; window.clearTimeout(timer); resolve(value); }, (error) => { if (finished) return; finished = true; window.clearTimeout(timer); reject(error); }); }); }
async function getVision() { vision ||= await FilesetResolver.forVisionTasks(new URL("./wasm", location.href).href); return vision; }
async function createPose(): Promise<PoseLandmarker> { const files = await getVision(); const options = (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: motionDebug.modelUrl, delegate }, runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: .55, minPosePresenceConfidence: .55, minTrackingConfidence: .55 }); try { motionDebug.delegate = "GPU"; return await options("GPU"); } catch (error) { motionDebug.fallbackError = error instanceof Error ? error.message : String(error); motionDebug.delegate = "CPU"; return await options("CPU"); } }
function updateModelLabel(): void { modelStatus.textContent = modelChoice === "lite" ? "Lite33" : "Full33"; modelSelect.value = modelChoice; }
async function loadPoseModel(): Promise<void> { document.querySelector("#loading")!.classList.remove("hidden"); motionDebug.modelState = "loading"; motionDebug.actualModel = modelChoice; motionDebug.modelUrl = new URL(`./models/pose_landmarker_${modelChoice}.task`, location.href).href; updateModelLabel(); motionDebug.delegate = "unknown"; motionDebug.fallbackError = null; motionDebug.detectCalls = 0; motionDebug.lastPoseCount = 0; motionDebug.lastInferenceMs = 0; motionDebug.lastDetectError = null; try { poseLandmarker?.close(); poseLandmarker = await createPose(); motionDebug.modelState = "ready"; document.querySelector("#delegateStatus")!.textContent = motionDebug.fallbackError ? "CPU·GPU回退" : motionDebug.delegate; document.querySelector("#modelError")!.textContent = motionDebug.fallbackError ? `GPU回退：${motionDebug.fallbackError}` : ""; document.querySelector("#loading")!.classList.add("hidden"); } catch (error) { motionDebug.modelState = "error"; motionDebug.lastDetectError = error instanceof Error ? error.message : String(error); document.querySelector("#delegateStatus")!.textContent = "模型错误"; document.querySelector("#modelError")!.textContent = motionDebug.lastDetectError; document.querySelector("#loadingText")!.textContent = `模型错误：${motionDebug.lastDetectError}`; document.querySelector("#loading")!.classList.add("hidden"); throw error; } }

function updateCameraButtons(): void { const front = facingMode === "user"; frontCameraButton.classList.toggle("selected", front); backCameraButton.classList.toggle("selected", !front); frontCameraButton.setAttribute("aria-pressed", String(front)); backCameraButton.setAttribute("aria-pressed", String(!front)); }
async function refreshCameraDevices(): Promise<void> { cameraDevices = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === "videoinput"); const options = ["<option value=\"__auto__\">自动</option>", ...cameraDevices.map((item, index) => { const lower = item.label.toLowerCase(); const name = lower.includes("front") || lower.includes("user") || lower.includes("前") ? "前置" : lower.includes("back") || lower.includes("environment") || lower.includes("后") ? "后置" : item.label || `镜头 ${index + 1}`; return `<option value=\"${item.deviceId}\">${name}</option>`; })].join(""); cameraDeviceSelect.innerHTML = options; if (!cameraDevices.some((item) => item.deviceId === selectedCameraDeviceId)) selectedCameraDeviceId = "__auto__"; cameraDeviceSelect.value = selectedCameraDeviceId; }
type CameraRatioProfile = { width: number; height: number; ratio: number };
function cameraRatioProfiles(): CameraRatioProfile[] { return [{ width: 480, height: 854, ratio: 9 / 16 }, { width: 480, height: 640, ratio: 3 / 4 }]; }
async function startCamera(): Promise<void> { clearWebCamera(); await new Promise((resolve) => setTimeout(resolve, 100)); const source = selectedCameraDeviceId !== "__auto__" ? { deviceId: { exact: selectedCameraDeviceId } } : { facingMode: { ideal: facingMode } }; stream = null; for (const profile of cameraRatioProfiles()) { try { stream = await openWebStream({ audio: false, video: { ...source, width: { ideal: profile.width, max: profile.width }, height: { ideal: profile.height, max: profile.height }, aspectRatio: { exact: profile.ratio }, frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS } } }); break; } catch { /* Try the 4:3 fallback, then the device default below. */ } } if (!stream) stream = await openWebStream({ audio: false, video: { ...source, width: { ideal: 480 }, height: { ideal: 854 }, frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS } } }); const track = stream.getVideoTracks()[0]; try { await track.applyConstraints({ frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS } }); } catch { /* Some WebView camera providers ignore frame-rate constraints; keep the real value. */ } const settings = track.getSettings(); if (settings.deviceId) selectedCameraDeviceId = settings.deviceId; if (settings.facingMode === "user" || settings.facingMode === "environment") facingMode = settings.facingMode; motionDebug.facingMode = facingMode; updateCameraButtons(); video.style.display = "block"; video.srcObject = stream; await video.play(); if (!video.videoWidth || !video.videoHeight) throw new Error("摄像头画面无效"); motionDebug.videoReady = video.readyState >= 2; motionDebug.videoWidth = video.videoWidth; motionDebug.videoHeight = video.videoHeight; await refreshCameraDevices(); resizeCanvas(); applyMirror(); startCameraFrameCounter(); }

async function start(): Promise<void> { try { overlayRenderingEnabled = true; lastSendStateText = ""; const socketUrl = await pickServer(serverInput.value); serverInput.value = socketUrl; localStorage.setItem("motionbridge-server", socketUrl); setConnection("connecting"); await startCamera(); await loadPoseModel(); running = true; activeRole = "camera"; setupCard.classList.add("hidden"); runtimeCard.classList.remove("hidden"); showStatus.classList.add("hidden"); voiceControl.classList.remove("hidden"); document.querySelector("#guide")!.classList.remove("hidden"); connectSocket(socketUrl); wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; schedulePredict(); } catch (error) { setConnection("error"); alert(error instanceof Error ? error.message : String(error)); await stop(); } }
function connectSocket(url: string): void { if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); setConnection("connecting"); socket = new WebSocket(url); cameraPairing = makePairingSession("camera", (message) => socket?.send(JSON.stringify(message))); socket.addEventListener("open", () => { setConnection("online"); syncClock(); if (voiceToggle.checked && !voiceEnabled) void startVoiceControl(); else if (voiceEnabled) setVoiceStatus("listening", "正在听"); }); socket.addEventListener("close", () => { setConnection("offline"); markControlConfigCached(); if (voiceEnabled) void stopVoiceControl(false); if (running) reconnectTimer = window.setTimeout(() => { void reconnectToBestServer(); }, 1500); }); socket.addEventListener("error", () => setConnection("error")); socket.addEventListener("message", (event) => { const received = performance.now(); let message: any; try { message = JSON.parse(event.data); } catch { return; } if (isPairingMessage(message.type)) { void cameraPairing?.handle(message); return; } if (message.type === "control_config_v1") applyControlConfig(message); if (message.type === "clock_sync") { const sent = Number(message.client_sent_ms); serverClockOffsetMs = Number(message.server_ms) - (Date.now() - (received - sent) / 2); } if (message.type === "ack") { lastServerPoseCount = Number(message.pose_count || 0); document.querySelector("#sendState")!.textContent = poseStatusText(Boolean(message.players?.some((player: any) => player.signals?.pose_visible))); } if (message.type === "error") document.querySelector("#sendState")!.textContent = message.message || "数据错误"; if (message.type === "scene_snapshot_request") void sendSceneSnapshot(message); if (message.type === "scene_snapshot_result") { document.querySelector("#sendState")!.textContent = message.ok === false ? (message.message || "场景截图失败") : "场景截图已发送"; } }); }
// 重连时重新挑一次，而不是死守断掉的那个地址：拔掉数据线就该自动落回 WiFi，
// 换了网段也该自己找回来。
async function reconnectToBestServer(): Promise<void> {
  if (!running) return;
  const url = await pickServer(serverInput.value);
  if (!running) return;
  serverInput.value = url;
  try { localStorage.setItem("motionbridge-server", url); } catch { /* 存不下不影响连接 */ }
  connectSocket(url);
}

function syncClock(): void { if (socket?.readyState !== WebSocket.OPEN) return; lastClockSyncAt = performance.now(); socket.send(JSON.stringify({ type: "clock_sync", client_sent_ms: lastClockSyncAt })); }

function jpegPayloadBytes(base64: string): number {
  return Math.floor(base64.length * 3 / 4);
}

async function sendSceneSnapshot(request: any): Promise<void> {
  if (!running || video.readyState < 2 || !video.videoWidth || !video.videoHeight || socket?.readyState !== WebSocket.OPEN) {
    return;
  }
  const maxWidth = Math.max(320, Math.min(1280, Number(request?.max_width || 960)));
  let quality = Math.max(0.55, Math.min(0.95, Number(request?.jpeg_quality || 88) / 100));
  let scale = Math.min(1, maxWidth / Math.max(video.videoWidth, video.videoHeight));
  let jpeg = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const snapshot = document.createElement("canvas");
    snapshot.width = width;
    snapshot.height = height;
    snapshot.getContext("2d", { alpha: false })!.drawImage(video, 0, 0, width, height);
    jpeg = snapshot.toDataURL("image/jpeg", quality).split(",", 2)[1] || "";
    if (jpeg && jpegPayloadBytes(jpeg) <= 700_000) break;
    scale *= 0.84;
    quality = Math.max(0.60, quality - 0.07);
  }
  if (!jpeg) return;
  socket.send(JSON.stringify({
    type: "scene_snapshot",
    role: "camera",
    device_id: deviceId,
    purpose: request?.purpose || "capture",
    captured_at_ms: Date.now() + serverClockOffsetMs,
    width: video.videoWidth,
    height: video.videoHeight,
    camera_facing: facingMode,
    preview_mirrored: facingMode === "user",
    coordinates_mirrored: false,
    jpeg_base64: jpeg,
  }));
}

function roundPose(value: number): number { return Math.round(value * 10000) / 10000; }
function packControlLandmarks(points: NormalizedLandmark[]): number[][] {
  if (points.length < 33) return [];
  return CONTROL_POINT_INDICES.map((index) => {
    const p = points[index];
    return [roundPose(p.x), roundPose(p.y), roundPose(p.z), roundPose(p.visibility ?? 1)];
  });
}
type WorldPoseLandmark = { x: number; y: number; z: number; visibility?: number };
function packWorldPoints(points: readonly WorldPoseLandmark[] | undefined): number[][] {
  if (!points || points.length < 33) return [];
  return points.slice(0, 33).map((point) => [
    roundPose(point.x),
    roundPose(point.y),
    roundPose(point.z),
    roundPose(point.visibility ?? 1),
  ]);
}
function resizeInferenceCanvas(): void { const sourceWidth = video.videoWidth; const sourceHeight = video.videoHeight; if (!sourceWidth || !sourceHeight) return; const scale = Math.min(1, inferenceMaxSide / Math.max(sourceWidth, sourceHeight)); const width = Math.max(1, Math.round(sourceWidth * scale)); const height = Math.max(1, Math.round(sourceHeight * scale)); if (inferenceCanvas.width !== width || inferenceCanvas.height !== height) { inferenceCanvas.width = width; inferenceCanvas.height = height; } inferenceContext.drawImage(video, 0, 0, width, height); }
function updateInferenceBudget(elapsed: number, now: number): void {
  inferenceEwmaMs = inferenceEwmaMs ? inferenceEwmaMs * 0.86 + elapsed * 0.14 : elapsed;
  if (now - lastInferenceResizeAt < 2500) return;
  let next = inferenceMaxSide;
  if (inferenceEwmaMs > 55) next = 384;
  else if (inferenceEwmaMs > 42) next = Math.min(next, 448);
  else if (inferenceEwmaMs < 27) next = Math.min(512, next + 64);
  if (next !== inferenceMaxSide) { inferenceMaxSide = next; lastInferenceResizeAt = now; }
}
function currentInferenceIntervalMs(): number { return Math.max(MIN_INFERENCE_INTERVAL_MS, inferenceEwmaMs > 0 ? inferenceEwmaMs * 1.08 : 0); }
// ==== 手部关节 =============================================================
// 姿态模型每只手只给手腕和三个指尖，判断握没握拳只能拿指尖到手腕的距离去猜，
// 真实环境下认不出来。专用手部模型给 21 个点，看得见每根手指的关节。
//
// 代价在这台手机上量过：手部模型每帧 23 毫秒，帧率 15.3 掉到 13.9。所以只有
// 电脑说"正在用手控鼠标"的时候才加载和运行它，平时一分钱不花。
//
// 喂给它的不是整幅画面，而是按电脑指定的那只手腕裁出来的一小块。裁不裁中位
// 耗时一样（那两个网络内部本来就把输入缩到固定大小），但最慢的一帧从 70 毫秒
// 降到 36——整幅画面偶尔要满图重新找手，裁过之后搜索范围只有巴掌大。另外裁
// 哪里是电脑说了算的，所以不存在把左右手认反。
type HandSide = "left" | "right";
const POSE_WRIST: Record<HandSide, number> = { left: 15, right: 16 };
const POSE_ELBOW: Record<HandSide, number> = { left: 13, right: 14 };
const HAND_CROP_SIDE = 256;
type PackedHand = { handedness: "Left" | "Right"; points: number[][] };
let handTrackingSide: HandSide | null = null;
let handLandmarker: HandLandmarker | null = null;
let handModelLoading = false;
const handCropCanvas = document.createElement("canvas");
handCropCanvas.width = HAND_CROP_SIDE;
handCropCanvas.height = HAND_CROP_SIDE;
const handCropContext = handCropCanvas.getContext("2d")!;

function syncHandTracking(): void {
  const request = syncedControlConfig?.hand_tracking;
  const hand = request?.hand;
  handTrackingSide = request?.enabled && (hand === "left" || hand === "right") ? hand : null;
  if (!handTrackingSide) { releaseHandModel(); return; }
  if (handLandmarker || handModelLoading) return;
  handModelLoading = true;
  void loadHandModel().finally(() => { handModelLoading = false; });
}

function releaseHandModel(): void {
  handLandmarker?.close();
  handLandmarker = null;
}

async function loadHandModel(): Promise<void> {
  const files = await getVision();
  const options = (delegate: "GPU" | "CPU") => HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: new URL("./models/hand_landmarker.task", location.href).href, delegate },
    // IMAGE 而不是 VIDEO。VIDEO 模式会记住上一帧手在画面里的位置，靠这个省掉
    // 重新找手的开销——那个前提是喂进去的是一段连续的视频。这里喂的是按手腕
    // 裁出来的一小块，位置和大小每帧都在变，它记住的坐标下一帧指向的已经是别
    // 的地方了。实测后果：一只静止的手，读数在 0.8 和 1.8 之间逐帧翻，握拳判
    // 定随之乱跳。每帧独立识别就没有可以被搞坏的跨帧状态，代价是每帧都要重新
    // 找一次手，但找的范围只有 256x256。
    runningMode: "IMAGE", numHands: 1,
  });
  try {
    handLandmarker = await options("GPU");
  } catch {
    // 和姿态模型同一条回退路线：这台机器的 GPU 代理不可用就退到 CPU，而不是
    // 让手控鼠标整个失效。
    try { handLandmarker = await options("CPU"); } catch { handLandmarker = null; }
  }
  // 加载期间电脑可能已经把手控鼠标关掉了。
  if (!handTrackingSide) releaseHandModel();
}

// 手掌在手腕之外，所以框心要沿着"手肘指向手腕"这个方向再往外推一点；框的大小
// 跟着前臂长度走，人离摄像头远近就不影响它。
function handCropBox(points: NormalizedLandmark[], side: HandSide, width: number, height: number):
    { sx: number; sy: number; side: number } | null {
  const elbow = points[POSE_ELBOW[side]];
  const wrist = points[POSE_WRIST[side]];
  if (!elbow || !wrist) return null;
  const dx = (wrist.x - elbow.x) * width;
  const dy = (wrist.y - elbow.y) * height;
  const forearm = Math.hypot(dx, dy);
  if (forearm < 8) return null;
  const box = Math.min(Math.max(forearm * 1.5, 48), Math.min(width, height));
  const centerX = wrist.x * width + dx * 0.35;
  const centerY = wrist.y * height + dy * 0.35;
  return {
    sx: Math.min(Math.max(centerX - box / 2, 0), width - box),
    sy: Math.min(Math.max(centerY - box / 2, 0), height - box),
    side: box,
  };
}

function detectHand(points: NormalizedLandmark[]): PackedHand | null {
  const side = handTrackingSide;
  if (!side || !handLandmarker) return null;
  const box = handCropBox(points, side, inferenceCanvas.width, inferenceCanvas.height);
  if (!box) return null;
  handCropContext.drawImage(inferenceCanvas, box.sx, box.sy, box.side, box.side,
                            0, 0, HAND_CROP_SIDE, HAND_CROP_SIDE);
  const landmarks = handLandmarker.detect(handCropCanvas).landmarks[0];
  if (!landmarks || landmarks.length !== 21) return null;
  return {
    handedness: side === "left" ? "Left" : "Right",
    // 坐标换算回整幅画面，电脑那边只认整幅画面的归一化坐标。
    // 第四个数是置信度：手部模型不给每个点单独的置信度，一只手要通过检测和跟踪
    // 两道门槛才会出现在结果里，所以它返回的点是同一个置信度。电脑靠"点得在画
    // 面里"这条硬规矩过滤，不靠这个数。
    points: landmarks.map((point) => [
      roundPose((box.sx + point.x * box.side) / inferenceCanvas.width),
      roundPose((box.sy + point.y * box.side) / inferenceCanvas.height),
      roundPose(point.z * box.side / inferenceCanvas.width),
      1,
    ]),
  };
}
// ==== 手部关节到此为止 =====================================================

function schedulePredict(): void {
  if (!running) return;
  // requestVideoFrameCallback is driven by the cameraFrame loop below.  Keep
  // one callback per decoded frame instead of registering a second callback
  // chain just for inference.  The rAF path also owns the camera counter when
  // older WebViews do not expose requestVideoFrameCallback.
  if (cameraFrameLoop) return;
  requestAnimationFrame((now) => {
    if (!running) return;
    recordCameraFrame(now);
    predict(now);
  });
}
function predict(now: number): void {
  if (!running) return;
  schedulePredict();
  if (inferenceBusy || !poseLandmarker || video.readyState < 2 || video.currentTime === lastVideoTime || now - lastInferenceAt < currentInferenceIntervalMs()) return;
  lastVideoTime = video.currentTime;
  lastInferenceAt = now;
  inferenceBusy = true;
  const started = performance.now();
  motionDebug.detectCalls++;
  try {
    resizeInferenceCanvas();
    const poseResult = poseLandmarker.detectForVideo(inferenceCanvas, now);
    const firstPose = poseResult.landmarks[0];
    // 手部关节只在电脑正用手控鼠标、并且连着的时候才跑：断开时这些点没地方去，
    // 白费一次推理和一份电。
    const packedHand = firstPose && socket?.readyState === WebSocket.OPEN
      ? detectHand(firstPose) : null;
    const elapsed = performance.now() - started;
    updateInferenceBudget(elapsed, now);
    motionDebug.lastInferenceMs = elapsed;
    motionDebug.lastPoseCount = poseResult.landmarks.length;
    motionDebug.lastDetectError = null;

    // Drawing is presentation only.  Throttle it so canvas work cannot steal
    // the frame budget from control inference.  When the user hides the mobile
    // control overlay during gameplay, stop skeleton rendering entirely.
    if (overlayRenderingEnabled && now - lastOverlayAt >= OVERLAY_INTERVAL_MS) {
      draw(poseResult.landmarks);
      lastOverlayAt = now;
    }

    if (firstPose && socket?.readyState === WebSocket.OPEN) {
      // Sequence is allocated before congestion handling so the PC can observe
      // gaps as dropped real-time frames instead of mistaking them for a slower
      // camera.
      const frameSequence = sequence++;
      if (socket.bufferedAmount <= MAX_SOCKET_BUFFERED_BYTES) {
        const worldPoints = packWorldPoints(poseResult.worldLandmarks?.[0]);
        const frame: Record<string, unknown> = {
          type: "pose_features_v1", role: "camera", layout: POSE_LAYOUT,
          device_id: deviceId, sequence: frameSequence,
          captured_at_ms: Date.now() + serverClockOffsetMs,
          sent_at_ms: Date.now() + serverClockOffsetMs,
          width: video.videoWidth, height: video.videoHeight,
          camera_facing: facingMode,
          camera_id: selectedCameraDeviceId === "__auto__" ? "logical" : selectedCameraDeviceId,
          preview_mirrored: facingMode === "user", coordinates_mirrored: false,
          actual_model: modelChoice, voice_state: poseVoiceState(),
          points: packControlLandmarks(firstPose), inference_ms: Math.round(elapsed * 10) / 10,
        };
        // 保持紧凑控制载荷不变，同时为新版电脑携带可选的米制世界坐标。
        if (worldPoints.length === 33) frame.world_points = worldPoints;
        if (packedHand) frame.hands = [packedHand];
        socket.send(JSON.stringify(frame));
      } else {
        // Real-time control must prefer freshness over completeness. Never add
        // another stale pose to a congested WebSocket queue.
        networkDroppedFrames++;
      }
    }
    const nextSendState = firstPose ? "人体已识别" : "等待完整人体";
    if (nextSendState !== lastSendStateText) {
      document.querySelector("#sendState")!.textContent = nextSendState;
      lastSendStateText = nextSendState;
    }
    fpsCounter++;
    if (performance.now() - fpsStarted >= 1000) {
      const fps = Math.round(fpsCounter * 1000 / (performance.now() - fpsStarted));
      document.querySelector("#localFps")!.textContent = `${fps} FPS`;
      fpsCounter = 0; fpsStarted = performance.now();
    }
    if (performance.now() - lastClockSyncAt > 5000) syncClock();
  } catch (error) {
    motionDebug.lastDetectError = error instanceof Error ? error.message : String(error);
    document.querySelector("#sendState")!.textContent = `模型错误：${motionDebug.lastDetectError}`;
  } finally { inferenceBusy = false; }
}
function poseStatusText(playerLocked: boolean): string { if (lastServerPoseCount > 0) return playerLocked ? "已识别" : "人体已识别·动作模型准备中"; return "相机正常·未发现完整人体"; }
function draw(poses: NormalizedLandmark[][]): void { resizeCanvas(); context.clearRect(0, 0, canvas.width, canvas.height); drawingUtils ||= new DrawingUtils(context); const pose = poses[0]; if (!pose) return; drawingUtils.drawConnectors(pose, PoseLandmarker.POSE_CONNECTIONS, { color: "#c8ff38", lineWidth: 2 }); drawingUtils.drawLandmarks(pose, { color: "#fff", fillColor: "#0b1014", radius: 2 }); }
function resizeCanvas(): void { const width = video.videoWidth || 960; const height = video.videoHeight || 540; if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; } }
function recordCameraFrame(now: number): void { cameraFrameCount++; if (now - cameraFpsStarted >= 1000) { document.querySelector("#cameraFps")!.textContent = `${Math.round(cameraFrameCount * 1000 / (now - cameraFpsStarted))} FPS`; cameraFrameCount = 0; cameraFpsStarted = now; } }
function cameraFrame(now: number): void { if (!cameraFrameLoop || !stream) return; recordCameraFrame(now); if (cameraFrameLoop && stream) video.requestVideoFrameCallback(cameraFrame); if (running) predict(now); }
function startCameraFrameCounter(): void { cameraFrameLoop = typeof video.requestVideoFrameCallback === "function"; cameraFrameCount = 0; cameraFpsStarted = performance.now(); if (cameraFrameLoop) video.requestVideoFrameCallback(cameraFrame); }
function applyMirror(): void { document.querySelector<HTMLElement>("#cameraStage")?.classList.toggle("front-mirror", facingMode === "user"); }

async function stopVoiceControl(showOff = true): Promise<void> { voiceEnabled = false; activeVoicePhrases = ""; await nativeVoiceTextListener?.remove().catch(() => {}); await nativeVoiceStateListener?.remove().catch(() => {}); await nativeAudioErrorListener?.remove().catch(() => {}); nativeVoiceTextListener = null; nativeVoiceStateListener = null; nativeAudioErrorListener = null; await NativeAudio.stop().catch(() => {}); if (showOff) { voiceToggle.checked = false; setVoiceStatus("off"); } }
async function startVoiceControl(): Promise<void> { if (activeRole !== "camera") { voiceToggle.checked = false; setVoiceStatus("error", "仅摄像头可用"); return; } if (voiceEnabled) return; if (socket?.readyState !== WebSocket.OPEN) { setVoiceStatus("error", "请先连接电脑"); return; } setVoiceStatus("connecting", "加载手机语音模型"); try { const phrases = voicePhrases(); activeVoicePhrases = phrases.join(" "); const ready = await NativeAudio.start(phrases.length ? { phrases } : undefined); if (!ready.recognizerReady) throw new Error("语音模型错误"); voiceEnabled = true; nativeVoiceTextListener = await NativeAudio.addListener("voiceText", (event) => { const text = (event.text || "").trim(); if (!voiceEnabled || !event.final || !text) return; setVoiceStatus("listening", `识别：${text.replace(/\s+/g, "")}`); if (socket?.readyState !== WebSocket.OPEN) { setVoiceStatus("error", "电脑已断开"); return; } const frame: Record<string, unknown> = { type: "voice_text", role: "camera", device_id: deviceId, sequence: sequence++, captured_at_ms: Date.now() + serverClockOffsetMs, text, confidence: event.confidence, final: true, source: "android_vosk_speech_service_v100" }; socket.send(JSON.stringify(frame)); }); nativeVoiceStateListener = await NativeAudio.addListener("voiceState", (event) => { if (!voiceEnabled) return; const detail = event.message || (event.state === "command" ? "已识别命令" : event.state === "listening" ? "语音识别已就绪" : "等待语音"); setVoiceStatus(event.state === "connecting" ? "connecting" : "listening", detail); }); nativeAudioErrorListener = await NativeAudio.addListener("audioError", (event) => { setVoiceStatus("error", event.message || "手机语音错误"); void stopVoiceControl(false); }); setVoiceStatus("listening", "Vosk 受限语法已就绪"); } catch (error) { const message = error instanceof Error ? error.message : String(error); const denied = /未授权|permission|denied/i.test(message); await stopVoiceControl(false); voiceToggle.checked = false; setVoiceStatus(denied ? "unauthorized" : "error", denied ? "未授权" : /模型|model|recognizer|vosk/i.test(message) ? "模型错误" : message || "错误"); } }

async function stop(): Promise<void> { running = false; overlayRenderingEnabled = true; lastSendStateText = ""; cameraFrameLoop = false; if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); socket = null; poseLandmarker?.close(); poseLandmarker = null; releaseHandModel(); handTrackingSide = null; clearWebCamera(); motionDebug.videoReady = false; motionDebug.videoWidth = 0; motionDebug.videoHeight = 0; await stopVoiceControl(); await wakeLock?.release().catch(() => {}); wakeLock = null; context.clearRect(0, 0, canvas.width, canvas.height); setupCard.classList.remove("hidden"); runtimeCard.classList.add("hidden"); showStatus.classList.add("hidden"); document.querySelector("#guide")!.classList.add("hidden"); setConnection("offline"); }
async function chooseCamera(cameraId: string): Promise<void> { selectedCameraDeviceId = cameraId; cameraDeviceSelect.value = cameraId; if (running) await startCamera(); applyMirror(); }
async function chooseFacing(target: "user" | "environment"): Promise<void> { if (!running || facingMode === target) { updateCameraButtons(); return; } const previousFacing = facingMode; const previousDevice = selectedCameraDeviceId; facingMode = target; selectedCameraDeviceId = "__auto__"; cameraDeviceSelect.value = "__auto__"; cameraSwitchState.textContent = "切换中"; try { await startCamera(); cameraSwitchState.textContent = `当前${target === "user" ? "前置镜头" : "后置镜头"}`; } catch (error) { facingMode = previousFacing; selectedCameraDeviceId = previousDevice; cameraSwitchState.textContent = `切换失败：${error instanceof Error ? error.message : "无法打开镜头"}`; try { await startCamera(); } catch { cameraSwitchState.textContent += "；原镜头恢复失败"; } updateCameraButtons(); } }
function showRole(role: "home" | "camera" | "handheld"): void { activeRole = role; roleCard.classList.toggle("hidden", role !== "home"); setupCard.classList.toggle("hidden", role !== "camera"); handheldCard.classList.toggle("hidden", role !== "handheld"); voiceControl.classList.toggle("hidden", role !== "camera"); document.querySelector("#pageTitle")!.textContent = role === "handheld" ? "手持手柄" : role === "camera" ? "固定摄像头" : "手机控制端"; renderControlConfig(); }

async function sendHandheldFrame(): Promise<void> { if (sensorPolling || handheldSocket?.readyState !== WebSocket.OPEN) return; sensorPolling = true; try { const sample = await SensorBridge.getLatest(); const touches: Record<string, unknown>[] = [...padState].map((control) => ({ control, pressed: true })); if (Math.abs(stickState.x) > 0.02 || Math.abs(stickState.y) > 0.02) touches.push({ control: "stick", x: stickState.x, y: stickState.y }); handheldSocket.send(JSON.stringify({ type: "sensor_frame", role: "sensor", device_id: deviceId, sequence: handheldSequence++, captured_at_ms: Date.now(), player_slot: Number(document.querySelector<HTMLSelectElement>("#handheldSlot")!.value), quaternion: { x: sample.qx, y: sample.qy, z: sample.qz, w: sample.qw }, orientation: {}, rotation_rate: { x: sample.gx, y: sample.gy, z: sample.gz }, acceleration: { x: sample.ax, y: sample.ay, z: sample.az }, touches, recenter: handheldRecenter })); if (handheldRecenter) { handheldRecenter = false; document.querySelector("#sensorState")!.textContent = "已居中"; } handheldFrames++; const now = performance.now(); if (now - handheldFpsStarted >= 1000) { document.querySelector("#sensorFps")!.textContent = `${Math.round(handheldFrames * 1000 / (now - handheldFpsStarted))} FPS`; handheldFrames = 0; handheldFpsStarted = now; } } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器异常"; } finally { sensorPolling = false; } }
function clearTouches(): void { padState.clear(); stickState = { x: 0, y: 0 }; document.querySelector<HTMLElement>("#stick i")!.style.transform = "translate(0,0)"; document.querySelectorAll("[data-pad]").forEach((element) => element.classList.remove("pressed")); void sendHandheldFrame(); }
async function startHandheld(): Promise<void> { showRole("handheld"); try { await SensorBridge.start(); wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; const address = handheldServerInput.value.trim() || serverInput.value.trim(); if (!address) throw new Error("请填写电脑服务器地址"); serverInput.value = address; localStorage.setItem("motionbridge-server", address); handheldSocket = new WebSocket(normalizeSocketUrl(address)); handheldPairing = makePairingSession("sensor", (message) => handheldSocket?.send(JSON.stringify(message))); handheldSocket.addEventListener("open", () => { document.querySelector("#handheldConnection")!.className = "badge online"; document.querySelector("#handheldConnection b")!.textContent = "已连接电脑"; document.querySelector("#sensorState")!.textContent = "自然持握 1 秒"; window.setTimeout(() => { handheldRecenter = true; }, 1000); }); handheldSocket.addEventListener("message", (event) => { try { const message = JSON.parse(event.data); if (isPairingMessage(message.type)) { void handheldPairing?.handle(message); return; } if (message.type === "control_config_v1") applyControlConfig(message); if (message.type === "error") document.querySelector("#sensorState")!.textContent = message.message || "连接失败"; } catch { /* ignore malformed bridge messages */ } }); handheldSocket.addEventListener("close", () => { markControlConfigCached(); clearTouches(); document.querySelector("#handheldConnection")!.className = "badge error"; document.querySelector("#handheldConnection b")!.textContent = "电脑已断开"; }); handheldTimer = window.setInterval(() => void sendHandheldFrame(), 16); } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器不可用"; } }
async function stopHandheld(): Promise<void> { clearTouches(); if (handheldTimer != null) window.clearInterval(handheldTimer); handheldTimer = null; await new Promise((resolve) => setTimeout(resolve, 35)); handheldSocket?.close(); handheldSocket = null; await SensorBridge.stop().catch(() => {}); await wakeLock?.release().catch(() => {}); wakeLock = null; showRole("home"); setConnection("offline"); }
async function suspendHandheld(): Promise<void> { clearTouches(); if (handheldTimer != null) window.clearInterval(handheldTimer); handheldTimer = null; await new Promise((resolve) => setTimeout(resolve, 35)); handheldSocket?.close(); handheldSocket = null; await SensorBridge.stop().catch(() => {}); document.querySelector("#sensorState")!.textContent = "已暂停"; }
async function handleBackButton(): Promise<void> { if (activeRole === "home") { await App.exitApp(); return; } if (activeRole === "camera") { await stop(); showRole("home"); return; } await stopHandheld(); }
function updateStick(event: PointerEvent): void { const stick = document.querySelector<HTMLElement>("#stick")!; const rect = stick.getBoundingClientRect(); const x = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.38))); const y = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height * 0.38))); stickState = { x, y }; stick.querySelector<HTMLElement>("i")!.style.transform = `translate(${x * 34}px,${y * 34}px)`; }

renderControlConfig();
document.querySelector("#cameraRole")!.addEventListener("click", () => { void (running ? stop() : Promise.resolve()).then(() => { showRole("camera"); return refreshCameraDevices(); }).catch((error) => { document.querySelector("#securityWarning")!.textContent = error instanceof Error ? error.message : String(error); }); });
document.querySelector("#handheldRole")!.addEventListener("click", () => { void (running || voiceEnabled ? stop() : Promise.resolve()).then(() => startHandheld()); });
document.querySelector("#cameraHome")!.addEventListener("click", () => { void stop().then(() => showRole("home")); });
document.querySelector("#startButton")!.addEventListener("click", () => void start()); document.querySelector("#stopButton")!.addEventListener("click", () => void stop());
hideStatus.addEventListener("click", () => { runtimeCard.classList.add("hidden"); showStatus.classList.remove("hidden"); overlayRenderingEnabled = false; context.clearRect(0, 0, canvas.width, canvas.height); });
showStatus.addEventListener("click", () => { if (!running) return; runtimeCard.classList.remove("hidden"); showStatus.classList.add("hidden"); overlayRenderingEnabled = true; lastOverlayAt = 0; });
modelSelect.value = modelChoice;
modelSelect.addEventListener("change", () => { modelChoice = modelSelect.value === "lite" ? "lite" : "full"; localStorage.setItem("motionbridge-model", modelChoice); updateModelLabel(); });
cameraDeviceSelect.addEventListener("change", () => void chooseCamera(cameraDeviceSelect.value));
frontCameraButton.addEventListener("click", () => void chooseFacing("user")); backCameraButton.addEventListener("click", () => void chooseFacing("environment")); voiceToggle.addEventListener("change", () => { localStorage.setItem("motionbridge-voice-auto", voiceToggle.checked ? "1" : "0"); void (voiceToggle.checked ? startVoiceControl() : stopVoiceControl()); });
document.querySelector("#centerSensor")!.addEventListener("click", () => { handheldRecenter = true; document.querySelector("#sensorState")!.textContent = "正在居中"; }); document.querySelector("#stopHandheld")!.addEventListener("click", () => void stopHandheld());
document.querySelectorAll<HTMLElement>("[data-pad]").forEach((button) => { button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); padState.add(button.dataset.pad!); button.classList.add("pressed"); }); const release = () => { padState.delete(button.dataset.pad!); button.classList.remove("pressed"); }; button.addEventListener("pointerup", release); button.addEventListener("pointercancel", release); button.addEventListener("lostpointercapture", release); });
const stick = document.querySelector<HTMLElement>("#stick")!; stick.addEventListener("pointerdown", (event) => { stick.setPointerCapture(event.pointerId); updateStick(event); }); stick.addEventListener("pointermove", (event) => { if (stick.hasPointerCapture(event.pointerId)) updateStick(event); }); const releaseStick = () => { stickState = { x: 0, y: 0 }; stick.querySelector<HTMLElement>("i")!.style.transform = "translate(0,0)"; }; stick.addEventListener("pointerup", releaseStick); stick.addEventListener("pointercancel", releaseStick);
window.addEventListener("resize", resizeCanvas);
document.addEventListener("visibilitychange", () => { if (document.hidden && voiceEnabled) void stopVoiceControl(); if (document.hidden && activeRole === "handheld") void suspendHandheld(); if (document.visibilityState === "visible" && activeRole === "handheld" && handheldTimer == null) void startHandheld(); if (document.visibilityState === "visible" && (running || activeRole === "handheld") && !wakeLock) void navigator.wakeLock?.request("screen").then((lock) => { wakeLock = lock; }).catch(() => {}); });
window.addEventListener("beforeunload", () => { clearTouches(); void stopVoiceControl(); });
void App.addListener("backButton", () => { void handleBackButton(); });
