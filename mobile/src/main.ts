import { DrawingUtils, FilesetResolver, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { App } from "@capacitor/app";
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
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
  <header class="app-header"><div class="mobile-brand"><p>MOTIONCONTROL 1.00</p><h1 id="pageTitle">手机控制端</h1><small>固定摄像头 · 手持控制器</small></div><div id="connectionBadge" class="badge"><i></i><b>未连接电脑</b></div></header>
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
      <label class="technical">识别模型<select id="modelSelect"><option value="full">Full（精度）</option><option value="lite">Lite（流畅）</option></select></label>
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
let modelChoice: ModelChoice = localStorage.getItem("motionbridge-model") === "lite" ? "lite" : "full";
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
// mc27-v2 keeps the original compact body set and adds MediaPipe indices 1/4
// (inner eyes), which the PC frozen22 11-point face signature requires.
const CONTROL_POINT_INDICES = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32] as const;
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

function getDeviceId(): string { let value = localStorage.getItem("motionbridge-device-id"); if (!value) { value = `camera-${crypto.randomUUID()}`; localStorage.setItem("motionbridge-device-id", value); } return value; }
const deviceId = getDeviceId();
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

async function start(): Promise<void> { try { overlayRenderingEnabled = true; lastSendStateText = ""; const socketUrl = normalizeSocketUrl(serverInput.value); serverInput.value = socketUrl; localStorage.setItem("motionbridge-server", socketUrl); setConnection("connecting"); await startCamera(); await loadPoseModel(); running = true; activeRole = "camera"; setupCard.classList.add("hidden"); runtimeCard.classList.remove("hidden"); showStatus.classList.add("hidden"); voiceControl.classList.remove("hidden"); document.querySelector("#guide")!.classList.remove("hidden"); connectSocket(socketUrl); wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; schedulePredict(); } catch (error) { setConnection("error"); alert(error instanceof Error ? error.message : String(error)); await stop(); } }
function connectSocket(url: string): void { if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); setConnection("connecting"); socket = new WebSocket(url); socket.addEventListener("open", () => { setConnection("online"); syncClock(); if (voiceToggle.checked && !voiceEnabled) void startVoiceControl(); else if (voiceEnabled) setVoiceStatus("listening", "正在听"); }); socket.addEventListener("close", () => { setConnection("offline"); markControlConfigCached(); if (voiceEnabled) void stopVoiceControl(false); if (running) reconnectTimer = window.setTimeout(() => connectSocket(url), 1500); }); socket.addEventListener("error", () => setConnection("error")); socket.addEventListener("message", (event) => { const received = performance.now(); let message: any; try { message = JSON.parse(event.data); } catch { return; } if (message.type === "control_config_v1") applyControlConfig(message); if (message.type === "clock_sync") { const sent = Number(message.client_sent_ms); serverClockOffsetMs = Number(message.server_ms) - (Date.now() - (received - sent) / 2); } if (message.type === "ack") { lastServerPoseCount = Number(message.pose_count || 0); document.querySelector("#sendState")!.textContent = poseStatusText(Boolean(message.players?.some((player: any) => player.signals?.pose_visible))); } if (message.type === "error") document.querySelector("#sendState")!.textContent = message.message || "数据错误"; if (message.type === "scene_snapshot_request") void sendSceneSnapshot(message); if (message.type === "scene_snapshot_result") { document.querySelector("#sendState")!.textContent = message.ok === false ? (message.message || "场景截图失败") : "场景截图已发送"; } }); }
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

    const firstPose = poseResult.landmarks[0];
    if (firstPose && socket?.readyState === WebSocket.OPEN) {
      // Sequence is allocated before congestion handling so the PC can observe
      // gaps as dropped real-time frames instead of mistaking them for a slower
      // camera.
      const frameSequence = sequence++;
      if (socket.bufferedAmount <= MAX_SOCKET_BUFFERED_BYTES) {
        const worldPoints = packWorldPoints(poseResult.worldLandmarks?.[0]);
        const frame: Record<string, unknown> = {
          type: "pose_features_v1", role: "camera", layout: "mc27-v2",
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

async function stop(): Promise<void> { running = false; overlayRenderingEnabled = true; lastSendStateText = ""; cameraFrameLoop = false; if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); socket = null; poseLandmarker?.close(); poseLandmarker = null; clearWebCamera(); motionDebug.videoReady = false; motionDebug.videoWidth = 0; motionDebug.videoHeight = 0; await stopVoiceControl(); await wakeLock?.release().catch(() => {}); wakeLock = null; context.clearRect(0, 0, canvas.width, canvas.height); setupCard.classList.remove("hidden"); runtimeCard.classList.add("hidden"); showStatus.classList.add("hidden"); document.querySelector("#guide")!.classList.add("hidden"); setConnection("offline"); }
async function chooseCamera(cameraId: string): Promise<void> { selectedCameraDeviceId = cameraId; cameraDeviceSelect.value = cameraId; if (running) await startCamera(); applyMirror(); }
async function chooseFacing(target: "user" | "environment"): Promise<void> { if (!running || facingMode === target) { updateCameraButtons(); return; } const previousFacing = facingMode; const previousDevice = selectedCameraDeviceId; facingMode = target; selectedCameraDeviceId = "__auto__"; cameraDeviceSelect.value = "__auto__"; cameraSwitchState.textContent = "切换中"; try { await startCamera(); cameraSwitchState.textContent = `当前${target === "user" ? "前置镜头" : "后置镜头"}`; } catch (error) { facingMode = previousFacing; selectedCameraDeviceId = previousDevice; cameraSwitchState.textContent = `切换失败：${error instanceof Error ? error.message : "无法打开镜头"}`; try { await startCamera(); } catch { cameraSwitchState.textContent += "；原镜头恢复失败"; } updateCameraButtons(); } }
function showRole(role: "home" | "camera" | "handheld"): void { activeRole = role; roleCard.classList.toggle("hidden", role !== "home"); setupCard.classList.toggle("hidden", role !== "camera"); handheldCard.classList.toggle("hidden", role !== "handheld"); voiceControl.classList.toggle("hidden", role !== "camera"); document.querySelector("#pageTitle")!.textContent = role === "handheld" ? "手持手柄" : role === "camera" ? "固定摄像头" : "手机控制端"; renderControlConfig(); }

async function sendHandheldFrame(): Promise<void> { if (sensorPolling || handheldSocket?.readyState !== WebSocket.OPEN) return; sensorPolling = true; try { const sample = await SensorBridge.getLatest(); const touches: Record<string, unknown>[] = [...padState].map((control) => ({ control, pressed: true })); if (Math.abs(stickState.x) > 0.02 || Math.abs(stickState.y) > 0.02) touches.push({ control: "stick", x: stickState.x, y: stickState.y }); handheldSocket.send(JSON.stringify({ type: "sensor_frame", role: "sensor", device_id: deviceId, sequence: handheldSequence++, captured_at_ms: Date.now(), player_slot: Number(document.querySelector<HTMLSelectElement>("#handheldSlot")!.value), quaternion: { x: sample.qx, y: sample.qy, z: sample.qz, w: sample.qw }, orientation: {}, rotation_rate: { x: sample.gx, y: sample.gy, z: sample.gz }, acceleration: { x: sample.ax, y: sample.ay, z: sample.az }, touches, recenter: handheldRecenter })); if (handheldRecenter) { handheldRecenter = false; document.querySelector("#sensorState")!.textContent = "已居中"; } handheldFrames++; const now = performance.now(); if (now - handheldFpsStarted >= 1000) { document.querySelector("#sensorFps")!.textContent = `${Math.round(handheldFrames * 1000 / (now - handheldFpsStarted))} FPS`; handheldFrames = 0; handheldFpsStarted = now; } } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器异常"; } finally { sensorPolling = false; } }
function clearTouches(): void { padState.clear(); stickState = { x: 0, y: 0 }; document.querySelector<HTMLElement>("#stick i")!.style.transform = "translate(0,0)"; document.querySelectorAll("[data-pad]").forEach((element) => element.classList.remove("pressed")); void sendHandheldFrame(); }
async function startHandheld(): Promise<void> { showRole("handheld"); try { await SensorBridge.start(); wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; const address = handheldServerInput.value.trim() || serverInput.value.trim(); if (!address) throw new Error("请填写电脑服务器地址"); serverInput.value = address; localStorage.setItem("motionbridge-server", address); handheldSocket = new WebSocket(normalizeSocketUrl(address)); handheldSocket.addEventListener("open", () => { document.querySelector("#handheldConnection")!.className = "badge online"; document.querySelector("#handheldConnection b")!.textContent = "已连接电脑"; document.querySelector("#sensorState")!.textContent = "自然持握 1 秒"; window.setTimeout(() => { handheldRecenter = true; }, 1000); }); handheldSocket.addEventListener("message", (event) => { try { const message = JSON.parse(event.data); if (message.type === "control_config_v1") applyControlConfig(message); if (message.type === "error") document.querySelector("#sensorState")!.textContent = message.message || "连接失败"; } catch { /* ignore malformed bridge messages */ } }); handheldSocket.addEventListener("close", () => { markControlConfigCached(); clearTouches(); document.querySelector("#handheldConnection")!.className = "badge error"; document.querySelector("#handheldConnection b")!.textContent = "电脑已断开"; }); handheldTimer = window.setInterval(() => void sendHandheldFrame(), 16); } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器不可用"; } }
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
