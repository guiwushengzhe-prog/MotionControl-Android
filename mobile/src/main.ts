import { DrawingUtils, FilesetResolver, HandLandmarker, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { App } from "@capacitor/app";
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { PairingSession, isPairingMessage } from "./pairing-session";
import type { PairRole } from "./pairing-crypto";
import {
  candidatesOf, dedupeServers, forgetFailures, lastOctetHint, mergeCandidates,
  pickBest, rankCandidates, type Discovered, type ProbeResult, type ServerCandidate,
} from "./discovery";
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
  // 绑定里的宏是按编号引用的，没有这份就只能在圈上显示一串编号。
  // 只在配置变化时随推送来一次，不是实时数据。
  macros?: { id?: string; name?: string; repeat?: boolean }[];
  // 真正会生效的绑定（含区域的内置兜底）。框上写的键以它为准。
  effective_bindings?: Record<string, SyncedBinding>;
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
  start(options?: { phrases?: string[]; baseUrl?: string }): Promise<{ sampleRate: number; channels: number; format: string; source: string; recognizerReady: boolean; audioReady: boolean }>;
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
  <header class="app-header"><div class="mobile-brand"><p id="brandVersion">MOTIONCONTROL ${__WEB_VERSION__}</p><h1 id="pageTitle">手机控制端</h1><small>固定摄像头 · 手持控制器</small></div><div id="connectionBadge" class="badge"><i></i><b>未连接电脑</b></div></header>
  <main>
    <section class="setup-card role-card" id="roleCard">
      <span class="eyebrow">开始</span><h2>这台手机要做什么？</h2><p class="role-lead">固定在玩家前方时选“摄像头”；拿在手里时选“手持手柄”。</p>
      <div class="role-grid"><button id="cameraRole" class="role-option recommended"><span class="role-symbol">●</span><strong>固定摄像头</strong><small>推荐 · 识别人和动作</small></button><button id="handheldRole" class="role-option"><span class="role-symbol">◆</span><strong>手持手柄</strong><small>陀螺仪 + 虚拟按键</small></button></div>
    </section>
    <section class="setup-card hidden" id="setupCard">
      <div class="card-head"><div><span class="eyebrow">摄像头模式</span><h2>连接电脑</h2></div><button id="cameraHome" class="text-button">返回</button></div>
      <p class="setup-help">电脑端保持 MotionControl 打开。地址不用自己填，点「连接并开始」它会自己找。第一次几十秒都正常，以后几秒。</p>
      <div class="link-state" id="linkState" hidden><p id="linkLine"></p><div class="link-actions" id="linkActions"></div></div>
      <label>电脑地址<input id="serverUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑IP:8765/ws/input"></label>
      <label>使用镜头<select id="cameraDeviceSelect"><option value="__auto__">自动选择</option></select></label>
      <label class="technical">识别模型<select id="modelSelect"><option value="full">Full（精度）</option></select></label>
      <div class="actions"><button id="startButton" class="start-primary">连接并开始</button></div><p class="warning" id="securityWarning"></p>
    </section>
    <section class="runtime-card hidden" id="runtimeCard">
      <div class="runtime-primary"><div><span class="eyebrow">识别状态</span><strong id="sendState">等待完整人体</strong></div><span class="runtime-link">电脑 <b id="panelConnection">未连接</b></span></div>
      <div class="technical runtime-tech"><span>摄像头 <b id="cameraFps">0 FPS</b></span><span>识别 <b id="localFps">0 FPS</b></span><span id="modelStatus">Full33</span><span id="delegateStatus">—</span><small id="modelError"></small></div>
      <div class="runtime-camera-choice"><span class="control-label">镜头方向</span><div class="camera-buttons" role="group" aria-label="选择镜头"><button id="frontCameraButton" type="button" aria-pressed="false">前置</button><button id="backCameraButton" type="button" aria-pressed="false">后置</button></div><small id="cameraSwitchState" class="camera-switch-state"></small></div>
      <div class="runtime-actions"><div class="runtime-voice" id="voiceControl"><label><input id="voiceToggle" type="checkbox"><span>语音控制</span></label><span id="voiceState">关闭</span></div><button id="gameControlButton" class="game-control" type="button" disabled>等待电脑状态</button><button id="hideStatus" class="status-hide" type="button">沉浸显示</button><button id="stopButton" class="stop">停止</button></div>
    </section>
    <div class="trigger-board camera-trigger-board hidden" id="cameraTriggerBoard" aria-live="polite"><b class="trigger-board-key">—</b><span class="trigger-board-name">做个动作或者说句口令试试</span></div>
    <button id="showStatus" class="status-show hidden" type="button">显示控制</button>
    <section class="handheld-card hidden" id="handheldCard">
      <div class="trigger-board handheld-trigger-board" id="handheldTriggerBoard" aria-live="polite"><b class="trigger-board-key">—</b><span class="trigger-board-name">做个动作或者说句口令试试</span></div>
      <div class="handheld-top handheld-connection-row"><span id="handheldConnection" class="badge"><i></i><b>未连接电脑</b></span><label class="hidden" id="handheldAddressField">电脑地址<input id="handheldServerUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑IP:8765/ws/input"></label><small id="sensorState">等待传感器</small><button id="centerSensor">重新居中</button><button id="stopHandheld" class="stop">停止</button></div>
      <div class="shoulders"><button data-pad="l">LB</button><button data-pad="zl">LT</button><button data-pad="zr">RT</button><button data-pad="r">RB</button></div><div class="gamepad"><div id="stick" class="stick"><i></i></div><div class="middle-buttons"><button data-pad="select">选择</button><button data-pad="start">开始</button></div><div class="face-buttons"><button data-pad="y">Y</button><button data-pad="x">X</button><button data-pad="b">B</button><button data-pad="a">A</button></div></div>
      <details class="handheld-more"><summary>更多</summary><div class="handheld-more-body"><label>玩家<select id="handheldSlot"><option value="0">玩家一</option><option value="1">玩家二</option></select></label><span>传感器 <b id="sensorFps">0 FPS</b></span></div></details>
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
const gameControlButton = document.querySelector<HTMLButtonElement>("#gameControlButton")!;
const startButton = document.querySelector<HTMLButtonElement>("#startButton")!;
const START_LABEL = startButton.textContent || "连接并开始";
// 从按下去到画面出来最长要三四秒：缓存地址 800ms、输入框里那个过期地址 800ms、
// 扫一遍子网四批各 400ms，再加打开摄像头。原来这整段时间界面一个字都不变，
// 点上了和没点上长得一模一样，人只会再点一次——而两次 start 会叠着跑，各开一路
// 摄像头。按钮自己就是最好的反馈位：手指刚离开的地方变了字，就说明点上了。
function setStartBusy(label: string | null): void {
  startButton.disabled = label !== null;
  startButton.textContent = label ?? START_LABEL;
}
const frontCameraButton = document.querySelector<HTMLButtonElement>("#frontCameraButton")!;
const backCameraButton = document.querySelector<HTMLButtonElement>("#backCameraButton")!;
const cameraSwitchState = document.querySelector<HTMLElement>("#cameraSwitchState")!;

let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let poseLandmarker: PoseLandmarker | null = null;
let stream: MediaStream | null = null;
let socket: WebSocket | null = null;
let handheldSocket: WebSocket | null = null;
// 主动停止和断线重连要分得开：停了之后还在后台重连，是最难查的那种「关不掉」。
let handheldRunning = false;
let reconnectTimer: number | null = null;
let handheldTimer: number | null = null;
let wakeLock: WakeLockSentinel | null = null;
let nativeVoiceTextListener: PluginListenerHandle | null = null;
let nativeVoiceStateListener: PluginListenerHandle | null = null;
let nativeAudioErrorListener: PluginListenerHandle | null = null;
let running = false;
let activeRole: "home" | "camera" | "handheld" = "home";
// 前置是默认。这个模式叫「固定摄像头」：手机架在玩家前方，屏幕朝着玩家，所以
// 对着人的那个镜头就是前置。默认后置的话，第一次用的人看到的是身后的墙，
// 界面一直写「等待完整人体」——他看不出是没装好还是镜头反了。
// 选过一次就记住，换回后置的人不会被推回来。
let facingMode: "user" | "environment" =
  localStorage.getItem("motionbridge-facing") === "environment" ? "environment" : "user";
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
// 电脑早就把手部四个区合成了两个（左手、右手）。这里以前还按老的四个查，于是手部
// 那四个框查的名字根本不存在——永远写「未映射」，也永远不会亮。
const ZONE_SYNC_ORDER = [
  ["leftHand", "左手"],
  ["rightHand", "右手"],
  ["leftFoot", "左脚"],
  ["rightFoot", "右脚"],
  ["headJump", "头顶"],
] as const;
function loadCachedControlConfig(): ControlConfigV1 | null {
  try {
    const raw = localStorage.getItem(CONTROL_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ControlConfigV1;
    return parsed?.type === "control_config_v1" ? parsed : null;
  } catch { return null; }
}
function macroLabel(id: string): string {
  const found = (syncedControlConfig?.macros || []).find((item) => String(item.id || "") === id);
  // 电脑上删了那条宏、而这边还拿着旧缓存时会走到这里。照实说，别编一个名字。
  if (!found) return "宏已丢失";
  return found.repeat ? `${found.name}（循环）` : String(found.name || "");
}
function escapeText(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[ch]);
}
/** 一个键的短写法，给大字用。"Xbox B" 太长了，几米外只看得清一个"B"。 */
function shortKey(action: SyncedAction | undefined): string {
  const type = String(action?.type || "");
  const rawTarget = action?.target as unknown;
  const raw = Array.isArray(rawTarget) ? rawTarget.join("+") : String(rawTarget || "");
  const target = raw.toUpperCase();
  if (!type || !raw) return "未映射";
  if (type === "macro") return macroLabel(raw.toLowerCase());
  if (type === "mouse_button") return ({ LEFT: "左键", RIGHT: "右键", MIDDLE: "中键", X1: "侧键1", X2: "侧键2" } as Record<string, string>)[target] || target;
  if (type === "mouse_wheel") return target.includes("UP") ? "滚轮↑" : "滚轮↓";
  if (type === "gamepad_axis") return ({ LS_UP: "摇杆↑", LS_DOWN: "摇杆↓", LS_LEFT: "摇杆←", LS_RIGHT: "摇杆→" } as Record<string, string>)[target] || target;
  return target.replace("LS_UP", "↑").replace("LS_DOWN", "↓").replace("LS_LEFT", "←").replace("LS_RIGHT", "→");
}
/**
 * 区域真正会按下去的那个键。
 *
 * 先看电脑算好的 effective_bindings：区域有一层内置兜底，配置里没有 zone.headJump 时
 * 它照样按 A。只看 bindings 的话这里会写「未映射」，而游戏里明明有反应——电脑那边
 * 就是在「靶场」上看见大字写「头顶区 → A」、旁边的框却写「未映射」才发现的。
 */
function zoneAction(id: string): SyncedAction | undefined {
  const effective = syncedControlConfig?.effective_bindings?.[`zone.${id}`];
  if (effective?.action) return effective.action;
  const binding = syncedControlConfig?.bindings?.zones?.[id];
  return binding?.disabled ? undefined : binding?.action;
}

/* --- 触发牌 ------------------------------------------------------------------
 * 打游戏时游戏是全屏的，人看不到电脑上的「靶场」，只看得见手机。所以"刚才到底
 * 触发了什么、按的是哪个键"要在手机上用大字写出来——区域、动作、姿势、语音都算。
 *
 * 电脑只在"按着的集合"变了的时候推一次（trigger_state_v1），不是每帧推。手机这
 * 边也不轮询，收到才画。唯一的定时器是"过几秒把它调暗"的那一次性的，不是循环。
 */
type TriggerBrief = { id?: string; name?: string; action?: SyncedAction | null };
type TriggerStateV1 = { type: "trigger_state_v1"; held?: TriggerBrief[]; fired?: TriggerBrief[]; at?: number };
type GameOutputStateV1 = { type: "game_output_state_v1"; enabled?: boolean; ok?: boolean; error?: string };
/** 打中之后大字亮多久。太短了人还没把视线从游戏挪过来就灭了。 */
const TRIGGER_HOLD_MS = 2500;
let triggerHeld: TriggerBrief[] = [];
let triggerLast: TriggerBrief | null = null;
let triggerLastAt = 0;
let triggerFadeTimer: number | null = null;

function applyTriggerState(message: TriggerStateV1): void {
  triggerHeld = Array.isArray(message.held) ? message.held : [];
  const fired = Array.isArray(message.fired) ? message.fired : [];
  if (fired.length) {
    triggerLast = fired[fired.length - 1];
    triggerLastAt = performance.now();
  }
  renderTriggerBoards();
}

/** 断线时把"按着"清掉。不清的话最后按着的那个键会一直亮着，像是卡住了。 */
function clearTriggerState(): void {
  triggerHeld = [];
  renderTriggerBoards();
}

function renderTriggerBoards(): void {
  const now = performance.now();
  const recent = !!triggerLast && now - triggerLastAt < TRIGGER_HOLD_MS;
  const shown = triggerHeld.length ? triggerHeld : (triggerLast ? [triggerLast] : []);
  const live = triggerHeld.length > 0 || recent;
  const keyText = shown.length ? shown.map((item) => shortKey(item.action ?? undefined)).join(" + ") : "—";
  const nameText = shown.length
    ? shown.map((item) => item.name || String(item.id || "")).join(" + ")
    : "做个动作或者说句口令试试";

  // 摄像头那块浮在画面最上面，「沉浸显示」时也在——那正是打游戏时的样子。
  //
  // 它占的就是标题栏的位置，所以连上之后标题栏收起来：「已连接电脑」下面的运行卡片
  // 里也写着，不缺它。一断线标题栏就回来，而触发牌消失——那一变本身就是在提醒人
  // 出问题了。只在摄像头模式下动标题栏，手柄模式有自己的规矩（showRole 里）。
  const cameraLive = activeRole === "camera" && socket?.readyState === WebSocket.OPEN;
  const cameraBoard = document.querySelector<HTMLElement>("#cameraTriggerBoard");
  if (cameraBoard) cameraBoard.classList.toggle("hidden", !cameraLive);
  if (activeRole === "camera") document.querySelector<HTMLElement>("header")?.classList.toggle("hidden", cameraLive);

  for (const board of document.querySelectorAll<HTMLElement>(".trigger-board")) {
    const key = board.querySelector<HTMLElement>(".trigger-board-key");
    const name = board.querySelector<HTMLElement>(".trigger-board-name");
    if (key) key.textContent = keyText;
    if (name) name.textContent = nameText;
    board.classList.toggle("on", live);
  }

  // 区域框也跟着亮：按着的那个框变绿。
  const heldIds = new Set(triggerHeld.map((item) => String(item.id || "")));
  for (const box of document.querySelectorAll<HTMLElement>(".profile-sync-bindings [data-trigger]")) {
    box.classList.toggle("lit", heldIds.has(box.dataset.trigger || ""));
  }

  // 过一会儿调暗。一次性的，下一次触发会把它重排。
  if (triggerFadeTimer != null) window.clearTimeout(triggerFadeTimer);
  triggerFadeTimer = recent && !triggerHeld.length
    ? window.setTimeout(renderTriggerBoards, TRIGGER_HOLD_MS - (now - triggerLastAt) + 30)
    : null;
}
function renderZoneOverlay(): void {
  const zones = syncedControlConfig?.zones || {};
  const heldIds = new Set(triggerHeld.map((item) => String(item.id || "")));
  const width = canvas.width, height = canvas.height;
  if (!width || !height) return;
  for (const [id, raw] of Object.entries(zones)) {
    const zone = raw as { shape?: string; cx?: number; cy?: number; r?: number };
    if (zone.shape !== "circle" || !Number.isFinite(zone.cx) || !Number.isFinite(zone.cy) || !Number.isFinite(zone.r)) continue;
    const radius = Math.max(2, Number(zone.r) * Math.min(width, height));
    context.beginPath();
    context.arc(Number(zone.cx) * width, Number(zone.cy) * height, radius, 0, Math.PI * 2);
    const active = heldIds.has(id);
    context.lineWidth = active ? 4 : 2;
    context.strokeStyle = active ? "#6ef0a2" : "rgba(107,168,255,.82)";
    context.fillStyle = active ? "rgba(90,220,140,.20)" : "rgba(80,150,230,.07)";
    context.fill(); context.stroke();
  }
}
let gameOutputEnabled: boolean | null = null;
function applyGameOutputState(message: GameOutputStateV1): void {
  if (typeof message.enabled !== "boolean") return;
  gameOutputEnabled = message.enabled;
  gameControlButton.disabled = false;
  gameControlButton.textContent = message.enabled ? "停止游戏控制" : "开始游戏控制";
  gameControlButton.classList.toggle("enabled", message.enabled);
  if (message.ok === false && message.error) gameControlButton.title = message.error;
}
function requestGameOutput(enabled: boolean): void {
  if (socket?.readyState !== WebSocket.OPEN || gameOutputEnabled === null) return;
  gameControlButton.disabled = true;
  socket.send(JSON.stringify({ type: "game_output_control", role: "camera", device_id: deviceId, enabled }));
}
function actionText(action: SyncedAction | undefined, fallback: string): string {
  const type = String(action?.type || "");
  const target = String(action?.target || "").toUpperCase();
  if (!type || !target) return fallback ? `默认 ${fallback}` : "未映射";
  // 宏的编号是小写的，而且对人没意义——圈上要写它的名字。
  if (type === "macro") return `宏 ${macroLabel(String(action?.target || "").toLowerCase())}`;
  if (type === "keyboard") return `键盘 ${target}`;
  if (type === "mouse_button") return `鼠标 ${{ LEFT: "左键", RIGHT: "右键", MIDDLE: "中键", X1: "侧键1", X2: "侧键2" }[target as "LEFT" | "RIGHT" | "MIDDLE" | "X1" | "X2"] || target}`;
  if (type === "mouse_wheel") return `滚轮 ${target.includes("UP") ? "↑" : target.includes("DOWN") ? "↓" : target}`;
  if (type === "gamepad_axis") return `左摇杆 ${target.endsWith("UP") ? "↑" : target.endsWith("DOWN") ? "↓" : target.endsWith("LEFT") ? "←" : target.endsWith("RIGHT") ? "→" : target}`;
  if (type === "gamepad_trigger") return `Xbox ${target}`;
  if (type === "gamepad") return `Xbox ${target}`;
  return `${type} ${target}`;
}
function renderControlConfig(): void {
  // Config remains synced for recognition and voice; the phone runtime page shows only status.
  renderTriggerBoards();
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
  void checkWebUpdate();
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
// 这个上限必须比摄像头帧率高，不能"留点余量"设得比它低。
//
// 摄像头 30 帧 = 每 33.3ms 一帧，而推理只在有新一帧时才跑。上限设 28 时最短间隔
// 是 35.7ms，比帧距还长：下一帧到的时候只过了 33.3ms，不够；再下一帧 66.7ms 才
// 够。于是每两帧只算一帧，永远卡在摄像头的一半。实测正是 15.7 帧/秒。
//
// 真正的节流是下面 currentInferenceIntervalMs 里的 ewma × 1.08——机器慢下来它
// 自己会拉长间隔。这个常数只该拦住"比摄像头还快地空转"，所以取在帧距之上。
const MAX_INFERENCE_FPS = 32;
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
  facingMode: "user",
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
// 并行探测时给单条的时限。原来是串行，所以每条 800ms 会一条条叠加——五条过期的
// 缓存地址就是四秒纯浪费。现在一起发，总时间等于最慢的那一条。
const PARALLEL_PROBE_TIMEOUT_MS = 600;
// 先到的不算数，等这么久收齐几个再按链路挑。实测数据线 4.4ms、无线 8.3ms，差几
// 毫秒，谁先到基本随机；宽限窗远大于这个差值，数据线在场就必定落在窗内。
const PROBE_GRACE_MS = 150;
const DISCOVER_TIMEOUT_MS = 900;

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

/** 原样写下去，包括写成空的——淘汰完最后一条死地址时要用到。 */
function saveCandidates(list: ServerCandidate[]): void {
  try { localStorage.setItem(SERVER_CANDIDATES_KEY, JSON.stringify(list)); } catch { /* 存不下就下次再说 */ }
}

/**
 * 电脑连上时报过来的那份是权威全表，整体替换。
 *
 * 空的不写：那多半是电脑那边一次异常的空载荷，照着它清空等于把手上唯一的线索
 * 扔掉。真正要清空的场合走 saveCandidates。
 */
function rememberCandidates(list: unknown): void {
  if (!Array.isArray(list) || !list.length) return;
  saveCandidates(list as ServerCandidate[]);
}

/** 自己找到的是单条线索，只能往里加——覆盖会把电脑报的那份完整地址表冲掉。 */
function addCandidates(found: ServerCandidate[]): void {
  saveCandidates(mergeCandidates(readCandidates(), found));
}

/**
 * 这个地址上是不是真有一台 MotionControl。
 *
 * 优先走原生：WebView 的源是 http://localhost，电脑端没有 CORS 头，所以网页里的
 * fetch 只能用 no-cors——拿到的是不透明响应，读不到状态码也读不到内容，于是 8765
 * 上任何 HTTP 服务都算命中（路由器管理页、打印机、别的开发服务器）。原生能读到
 * 内容，才分得出来。
 *
 * 旧壳子没有这个方法，退回原来那套 no-cors。会误判，但比连不上强。
 */
async function answers(candidate: ServerCandidate, timeoutMs = SERVER_PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const result = await LocalNetwork.probe({
      host: candidate.host, port: candidate.port, timeoutMs,
    });
    return Boolean(result?.ok);
  } catch { /* 旧壳子，往下走 */ }
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
  openSettings(options: { which: "tether" | "wifi" }): Promise<{ opened: string }>;
  // 下面两个只有新壳子有。网页包能热更而 APK 不能，所以装着旧 APK 的人也会收到
  // 这份新网页——调用处必须接住"没有这个方法"，退回原来那套，不能崩在这里。
  discover(options: { timeoutMs?: number }): Promise<{ servers: Discovered[] }>;
  probe(options: { host: string; port: number; timeoutMs?: number }):
    Promise<{ ok: boolean; version?: string; rttMs: number }>;
}>("LocalNetwork");

// ---- 这台手机现在有没有一条能到电脑的路 ------------------------------------
// 手机连电脑只有两种走法：同一个无线网，或者插数据线 + 打开「USB 网络共享」。
// 两个都没开的时候，无论按多少次「连接并开始」都不会成功——而以前的表现就是
// 按下去、转一会儿、说连不上，用户不知道是地址错了、电脑没开，还是自己这边
// 少开了一个开关。
//
// 判断不需要新的权限：网卡名字就说明了一切。rndis0/usb0/ncm0 是网络共享起来
// 之后才会出现的口，wlan0 是 WiFi，rmnet_data* 是移动数据。看得见哪块口在，
// 就知道用户开了哪一个。
type LinkState = { usb: boolean; wifi: boolean; known: boolean; links?: LocalInterface[] };

const WIRED_INTERFACE = /^(rndis|usb|ncm)/i;
const WIFI_INTERFACE = /^(wlan|ap)/i;

async function readLinkState(): Promise<LinkState> {
  try {
    const own = (await LocalNetwork.interfaces()).interfaces || [];
    return {
      usb: own.some((item) => WIRED_INTERFACE.test(item.name)),
      wifi: own.some((item) => WIFI_INTERFACE.test(item.name)),
      known: true,
      links: own,
    };
  } catch {
    // 插件不在（旧壳子）。说不出所以然的时候就别说，免得把一句猜测摆成结论。
    return { usb: false, wifi: false, known: false };
  }
}

// 网页包更新。下到暂存目录，下次启动才换上去——不在页面跑着的时候动它脚下的文件。
type WebUpdateResult = { state: "skipped" | "none" | "current" | "ready" | "failed"; message?: string };
const WebUpdate = registerPlugin<{
  sync(options: { baseUrl: string }): Promise<WebUpdateResult>;
  bootOk(): Promise<void>;
}>("WebUpdate");
// 脚本跑到这里，说明这份网页包至少不是砖。壳子在启动时留了个记号，这一句把它
// 清掉；记号要是活到下次启动，壳子就把这个包丢掉、退回 APK 自带的那份。
void WebUpdate.bootOk().catch(() => {});
let webUpdateChecked = false;

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

async function scanOwnSubnets(onPhase: (text: string) => void = () => {}): Promise<ServerCandidate | null> {
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
    // 报网段而不是百分比：扫到第几台对人没有意义，但"正在扫 10.119.231.x"能让
    // 人看出它找的是数据线那条网，还是无线那条。
    onPhase(`正在扫 ${octets[0]}.${octets[1]}.${octets[2]}.x …`);
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

// found=false 的意思是"一个地址都没答应"。以前这里照样把地址交回去，于是页面
// 切到运行态，摄像头跑起来，右上角一直是灰的「未连接电脑」，没有任何一处说得出
// 为什么。调用方拿到这个标记，才有机会在那之前把原因讲出来。
// onPhase 报的是"现在在试哪一步"。这几步各自都可能空跑将近一秒，合起来是人
// 唯一会怀疑程序死了的那段时间；不往外说一声，它就只是一段静止。
/**
 * 一起探一批地址，等第一个答应之后再多收一小会儿，然后按链路挑。
 *
 * 不用串行是因为一条过期地址就要空烧 800ms，五条就是四秒纯浪费。不用"谁先答应用
 * 谁"是因为数据线和无线只差几毫秒，先到基本随机，那样数据线会随机地输掉。
 */
async function probeAll(candidates: ServerCandidate[]): Promise<ProbeResult[]> {
  if (!candidates.length) return [];
  const results: ProbeResult[] = [];
  let firstHitAt = 0;
  const everyone = Promise.all(candidates.map(async (candidate) => {
    const started = Date.now();
    const ok = await answers(candidate, PARALLEL_PROBE_TIMEOUT_MS);
    results.push({ candidate, ok, rttMs: Date.now() - started });
    if (ok && !firstHitAt) firstHitAt = Date.now();
  }));
  // 有人答应了就在宽限窗后收口，不必陪着最慢那条等满超时；一个都没答应才等满。
  const graceOver = new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (firstHitAt && Date.now() - firstHitAt >= PROBE_GRACE_MS) { clearInterval(tick); resolve(); }
    }, 25);
    setTimeout(() => { clearInterval(tick); resolve(); }, PARALLEL_PROBE_TIMEOUT_MS + 100);
  });
  await Promise.race([everyone, graceOver]);
  return [...results];
}

/** 广播喊一声。旧壳子没有这个方法，当作没找到继续往下走。 */
async function broadcastFind(): Promise<Discovered[]> {
  try {
    const result = await LocalNetwork.discover({ timeoutMs: DISCOVER_TIMEOUT_MS });
    return dedupeServers(result?.servers ?? []);
  } catch {
    return [];
  }
}

// found=false 的意思是"一个地址都没答应"。以前这里照样把地址交回去，于是页面
// 切到运行态，摄像头跑起来，右上角一直是灰的「未连接电脑」，没有任何一处说得出
// 为什么。调用方拿到这个标记，才有机会在那之前把原因讲出来。
async function pickServer(typed: string, onPhase: (text: string) => void = () => {}):
    Promise<{ url: string; found: boolean; servers: Discovered[]; udpSilent: boolean }> {
  const links = await ownLinks();
  let cached = readCandidates();

  // 一、上次能连上的地址。网段没变的话这一步就结束了，约一百多毫秒。
  if (cached.length) {
    onPhase("正在试上次的地址…");
    const ranked = rankCandidates(cached, links);
    const results = await probeAll(ranked);
    const best = pickBest(results);
    if (best) {
      addCandidates([best]);
      return { url: normalizeSocketUrl(`${best.host}:${best.port}`), found: true, servers: [], udpSilent: false };
    }
    // 没人应答：给它们记一笔。攒够次数才丢，因为一次不通可能只是电脑还没开。
    cached = forgetFailures(cached, results.map((item) => item.candidate));
    saveCandidates(cached);
  }

  // 二、广播喊一声。它不依赖任何记住的东西，网段整个变了也照样找得到——而共享
  // 网络的网段确实会整个变，这一步就是为那件事存在的。
  onPhase("正在找电脑…");
  const servers = await broadcastFind();
  if (servers.length) {
    const flat = servers.flatMap(candidatesOf);
    addCandidates(flat);
    const best = pickBest(await probeAll(rankCandidates(flat, links))) ?? flat[0];
    return { url: normalizeSocketUrl(`${best.host}:${best.port}`), found: true, servers, udpSilent: false };
  }

  // 三、手填的地址。排在广播后面：广播拿到的是此刻的真相，比任何存下来的都新鲜。
  const typedCandidate = typed.trim();
  if (typedCandidate) {
    onPhase("正在试填的地址…");
    try {
      const parsed = new URL(normalizeSocketUrl(typedCandidate));
      const port = Number(parsed.port) || DEVICE_PORT;
      if (await answers({ host: parsed.hostname, port, kind: "lan" })) {
        addCandidates([{ host: parsed.hostname, port, kind: "lan" }]);
        return { url: normalizeSocketUrl(typedCandidate), found: true, servers: [], udpSilent: true };
      }
    } catch { /* 填得不成样子，当作没填 */ }
  }

  // 四、挨个敲。广播没人应答但这里敲得到，说明 UDP 被单独挡住了——这两者唯一的
  // 差别就是协议，所以它是分辨防火墙问题最干净的信号。扫描因此不只是兜底，
  // 它还是诊断。
  const found = await scanOwnSubnets(onPhase);
  if (found) {
    addCandidates([found]);
    return { url: normalizeSocketUrl(`${found.host}:${found.port}`), found: true, servers: [], udpSilent: true };
  }
  return { url: typed.trim(), found: false, servers: [], udpSilent: true };
}

/** 这台手机现在有哪些网卡。拿不到就当作没有，调用方自己会退化。 */
async function ownLinks(): Promise<LocalInterface[]> {
  try {
    return (await LocalNetwork.interfaces()).interfaces || [];
  } catch {
    return [];
  }
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
// 重开摄像头时，上一次的 play() 还没落定就被 clearWebCamera 的 pause() 打断，
// 浏览器把这个 promise reject 成 AbortError。画面本身没问题——下面那句
// videoWidth 检查才是真正判断能不能用的地方。原来这个 reject 一路冒到 start()
// 的 catch，弹出一句英文原文加一个谷歌短链，然后把整个启动流程停掉。
async function playVideo(): Promise<void> {
  try {
    await video.play();
  } catch (error) {
    if ((error as DOMException)?.name !== "AbortError") throw error;
  }
}

async function getVision() { vision ||= await FilesetResolver.forVisionTasks(new URL("./wasm", location.href).href); return vision; }
async function createPose(): Promise<PoseLandmarker> { const files = await getVision(); const options = (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: motionDebug.modelUrl, delegate }, runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: .55, minPosePresenceConfidence: .55, minTrackingConfidence: .55 }); try { motionDebug.delegate = "GPU"; return await options("GPU"); } catch (error) { motionDebug.fallbackError = error instanceof Error ? error.message : String(error); motionDebug.delegate = "CPU"; return await options("CPU"); } }
function updateModelLabel(): void { modelStatus.textContent = modelChoice === "lite" ? "Lite33" : "Full33"; modelSelect.value = modelChoice; }
async function loadPoseModel(): Promise<void> { document.querySelector("#loading")!.classList.remove("hidden"); motionDebug.modelState = "loading"; motionDebug.actualModel = modelChoice; motionDebug.modelUrl = new URL(`./models/pose_landmarker_${modelChoice}.task`, location.href).href; updateModelLabel(); motionDebug.delegate = "unknown"; motionDebug.fallbackError = null; motionDebug.detectCalls = 0; motionDebug.lastPoseCount = 0; motionDebug.lastInferenceMs = 0; motionDebug.lastDetectError = null; try { poseLandmarker?.close(); poseLandmarker = await createPose(); motionDebug.modelState = "ready"; document.querySelector("#delegateStatus")!.textContent = motionDebug.fallbackError ? "CPU·GPU回退" : motionDebug.delegate; document.querySelector("#modelError")!.textContent = motionDebug.fallbackError ? `GPU回退：${motionDebug.fallbackError}` : ""; document.querySelector("#loading")!.classList.add("hidden"); } catch (error) { motionDebug.modelState = "error"; motionDebug.lastDetectError = error instanceof Error ? error.message : String(error); document.querySelector("#delegateStatus")!.textContent = "模型错误"; document.querySelector("#modelError")!.textContent = motionDebug.lastDetectError; document.querySelector("#loadingText")!.textContent = `模型错误：${motionDebug.lastDetectError}`; document.querySelector("#loading")!.classList.add("hidden"); throw error; } }

function updateCameraButtons(): void { const front = facingMode === "user"; frontCameraButton.classList.toggle("selected", front); backCameraButton.classList.toggle("selected", !front); frontCameraButton.setAttribute("aria-pressed", String(front)); backCameraButton.setAttribute("aria-pressed", String(!front)); }
async function refreshCameraDevices(): Promise<void> { cameraDevices = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === "videoinput"); const options = ["<option value=\"__auto__\">自动</option>", ...cameraDevices.map((item, index) => { const lower = item.label.toLowerCase(); const name = lower.includes("front") || lower.includes("user") || lower.includes("前") ? "前置" : lower.includes("back") || lower.includes("environment") || lower.includes("后") ? "后置" : item.label || `镜头 ${index + 1}`; return `<option value=\"${item.deviceId}\">${name}</option>`; })].join(""); cameraDeviceSelect.innerHTML = options; if (!cameraDevices.some((item) => item.deviceId === selectedCameraDeviceId)) selectedCameraDeviceId = "__auto__"; cameraDeviceSelect.value = selectedCameraDeviceId; }
type CameraRatioProfile = { width: number; height: number; ratio: number };
function cameraRatioProfiles(): CameraRatioProfile[] { return [{ width: 480, height: 854, ratio: 9 / 16 }, { width: 480, height: 640, ratio: 3 / 4 }]; }
async function startCamera(): Promise<void> { clearWebCamera(); await new Promise((resolve) => setTimeout(resolve, 100)); const source = selectedCameraDeviceId !== "__auto__" ? { deviceId: { exact: selectedCameraDeviceId } } : { facingMode: { ideal: facingMode } }; stream = null; for (const profile of cameraRatioProfiles()) { try { stream = await openWebStream({ audio: false, video: { ...source, width: { ideal: profile.width, max: profile.width }, height: { ideal: profile.height, max: profile.height }, aspectRatio: { exact: profile.ratio }, frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS } } }); break; } catch { /* Try the 4:3 fallback, then the device default below. */ } } if (!stream) stream = await openWebStream({ audio: false, video: { ...source, width: { ideal: 480 }, height: { ideal: 854 }, frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS } } }); const track = stream.getVideoTracks()[0]; try { await track.applyConstraints({ frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS } }); } catch { /* Some WebView camera providers ignore frame-rate constraints; keep the real value. */ } const settings = track.getSettings(); if (settings.deviceId) selectedCameraDeviceId = settings.deviceId; if (settings.facingMode === "user" || settings.facingMode === "environment") facingMode = settings.facingMode; motionDebug.facingMode = facingMode; updateCameraButtons(); video.style.display = "block"; video.srcObject = stream; await playVideo(); if (!video.videoWidth || !video.videoHeight) throw new Error("摄像头画面无效"); motionDebug.videoReady = video.readyState >= 2; motionDebug.videoWidth = video.videoWidth; motionDebug.videoHeight = video.videoHeight; await refreshCameraDevices(); resizeCanvas(); applyMirror(); startCameraFrameCounter(); }

async function start(): Promise<void> {
  // 徽标和按钮都要在找电脑之前就变。原来 setConnection("connecting") 排在
  // pickServer 后面，于是全程最慢的那几秒，恰好是唯一没有任何提示的几秒。
  if (startButton.disabled) return;   // 已经在跑了，别叠第二路
  setStartBusy("正在找电脑…"); setConnection("connecting");
  try { overlayRenderingEnabled = true; lastSendStateText = ""; const picked = await pickServer(serverInput.value, setStartBusy);
    if (!picked.found) { await refreshLinkState(true); throw new Error("没找到电脑"); }
    const socketUrl = picked.url; serverInput.value = socketUrl; localStorage.setItem("motionbridge-server", socketUrl); setStartBusy("正在打开摄像头…"); await startCamera(); running = true; activeRole = "camera"; setupCard.classList.add("hidden"); runtimeCard.classList.remove("hidden"); showStatus.classList.add("hidden"); voiceControl.classList.remove("hidden"); document.querySelector("#guide")!.classList.remove("hidden");
    // 先握手，再加载模型。模型要好几秒，那几秒原来是干等；现在连接和加载并行，
    // 等模型就绪时链路通常已经通了，控制配置（要不要跑手部模型）也到了。
    connectSocket(socketUrl);
    await loadPoseModel();
    wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; schedulePredict(); } catch (error) { setConnection("error"); showStartError(error); await stop(); } finally { setStartBusy(null); } }

function showStartError(error: unknown): void {
  const raw = error instanceof Error ? error.message : String(error);
  // 浏览器抛出来的话是英文的，而且常常带一条谷歌短链。原样弹给玩家等于没说。
  const hint = /permission|NotAllowed/i.test(raw) ? "摄像头没有授权，去系统设置里允许"
    : /NotFound|NotReadable|device/i.test(raw) ? "摄像头打不开，可能被别的应用占着"
    : /超时/.test(raw) ? "摄像头打开超时，重试一次"
    : /模型/.test(raw) ? raw
    : /没找到电脑/.test(raw) ? "没找到电脑。看下面这行字。"
    : "启动失败，重试一次";
  showStatus.textContent = hint;
  showStatus.classList.remove("hidden");
  setupCard.classList.remove("hidden");
  runtimeCard.classList.add("hidden");
}
function connectSocket(url: string): void { if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); setConnection("connecting"); socket = new WebSocket(url); cameraPairing = makePairingSession("camera", (message) => socket?.send(JSON.stringify(message))); socket.addEventListener("open", () => { setConnection("online"); syncClock(); if (voiceToggle.checked && !voiceEnabled) void startVoiceControl(); else if (voiceEnabled) setVoiceStatus("listening", "正在听"); }); socket.addEventListener("close", () => { setConnection("offline"); markControlConfigCached(); clearTriggerState(); if (voiceEnabled) void stopVoiceControl(false); if (running) reconnectTimer = window.setTimeout(() => { void reconnectToBestServer(); }, 1500); }); socket.addEventListener("error", () => setConnection("error")); socket.addEventListener("message", (event) => { const received = performance.now(); let message: any; try { message = JSON.parse(event.data); } catch { return; } if (isPairingMessage(message.type)) { void cameraPairing?.handle(message); return; } if (message.type === "control_config_v1") applyControlConfig(message); if (message.type === "trigger_state_v1") applyTriggerState(message); if (message.type === "game_output_state_v1") applyGameOutputState(message); if (message.type === "clock_sync") { const sent = Number(message.client_sent_ms); serverClockOffsetMs = Number(message.server_ms) - (Date.now() - (received - sent) / 2); } if (message.type === "ack") { lastServerPoseCount = Number(message.pose_count || 0); document.querySelector("#sendState")!.textContent = poseStatusText(Boolean(message.players?.some((player: any) => player.signals?.pose_visible))); } if (message.type === "error") document.querySelector("#sendState")!.textContent = message.message || "数据错误"; if (message.type === "scene_snapshot_request") void sendSceneSnapshot(message); if (message.type === "scene_snapshot_result") { document.querySelector("#sendState")!.textContent = message.ok === false ? (message.message || "场景截图失败") : "场景截图已发送"; } }); }
// 重连时重新挑一次，而不是死守断掉的那个地址：拔掉数据线就该自动落回 WiFi，
// 换了网段也该自己找回来。
async function reconnectToBestServer(): Promise<void> {
  if (!running) return;
  const picked = await pickServer(serverInput.value);
  if (!running) return;
  // 重连时找不到也要接着试：线可能只是松了一下。但地址不该存下来——
  // 存一个没人应答的地址，下次开机只会把人卡在同一个地方。
  const url = picked.url;
  serverInput.value = url;
  if (picked.found) {
    try { localStorage.setItem("motionbridge-server", url); } catch { /* 存不下不影响连接 */ }
  }
  if (url) connectSocket(url);
}

// 语音模型从配对的那台电脑取，走的是同一个设备口，只是把 ws:// 换成 http://。
function deviceHttpBase(): string {
  try {
    const parsed = new URL(serverInput.value);
    return `${parsed.protocol === "wss:" ? "https" : "http"}://${parsed.host}`;
  } catch {
    return "";
  }
}

// 一次连接只问一次。失败不拦任何事：APK 里那份永远是好的，照样能玩。
async function checkWebUpdate(): Promise<void> {
  if (webUpdateChecked) return;
  webUpdateChecked = true;
  const base = deviceHttpBase();
  if (!base) return;
  try {
    const result = await WebUpdate.sync({ baseUrl: base });
    if (result.state === "ready") setConnection("online");
  } catch { /* 旧壳子没有这个插件，当作没有更新 */ }
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
// 档位要瞄准的是"整帧塞进摄像头的帧距"，不是某个绝对毫秒数。
//
// 摄像头 30 帧 = 每 33.3ms 一帧，推理只在有新一帧时才跑：一旦整帧超过 33.3ms，
// 下一帧就赶不上，只能等再下一帧——帧率直接砍半，没有中间状态。所以慢一点点和
// 慢一半的后果是一样的。
//
// 原来的门槛是 55 / 42 / 27，瞄的不是这条线：实测 46ms 卡在 448 这档，降不到
// 384，而 384 那档只要 28.7ms——正好是塞得进和塞不进的分界。
// 实测：边长 320（62 个采样，中位 46.3ms）和 448 基本一样快。MediaPipe 内部会
// 把输入缩到它自己的尺寸，喂多大对推理耗时没影响——降档只是白白丢骨骼点精度。
// 所以下限留在 384，不再往下降；档位存在的意义只剩"别喂得比必要更大"。
const INFERENCE_SIDES = [384, 448, 512];
const INFERENCE_SLOW_MS = 30;
const INFERENCE_FAST_MS = 20;
function updateInferenceBudget(elapsed: number, now: number): void {
  inferenceEwmaMs = inferenceEwmaMs ? inferenceEwmaMs * 0.86 + elapsed * 0.14 : elapsed;
  if (now - lastInferenceResizeAt < 2500) return;
  const step = INFERENCE_SIDES.indexOf(inferenceMaxSide);
  const at = step < 0 ? INFERENCE_SIDES.length - 1 : step;
  let next = at;
  if (inferenceEwmaMs > INFERENCE_SLOW_MS) next = Math.max(0, at - 1);
  else if (inferenceEwmaMs < INFERENCE_FAST_MS) next = Math.min(INFERENCE_SIDES.length - 1, at + 1);
  if (INFERENCE_SIDES[next] !== inferenceMaxSide) {
    inferenceMaxSide = INFERENCE_SIDES[next];
    lastInferenceResizeAt = now;
  }
}
// 没连上电脑时推理结果没有地方去。还是跑一点，好让人看见骨架、确认自己在画面
// 里；但不必按满帧烧电——断线重连的那几秒里满帧空跑，正是手机发烫变卡的来源。
const IDLE_INFERENCE_INTERVAL_MS = 500;
function currentInferenceIntervalMs(): number {
  if (socket?.readyState !== WebSocket.OPEN) return IDLE_INFERENCE_INTERVAL_MS;
  // 这里不再按 ewma 拉长间隔。一帧只可能被算一次——inferenceBusy 和"这一帧处理
  // 过没有"那两道检查已经保证了，速率天然封顶在摄像头的 30 帧。再叠一道按耗时
  // 拉长的闸，效果只是把等待向上取整到下一个摄像头帧：推理 33.7ms 时 ewma×1.08
  // 是 36.4ms，比帧距 33.3ms 多一点点，于是每两帧丢一帧，帧率直接砍半。
  // 实测就是这样：Lite 把推理从 45ms 降到 33.7ms，帧率却纹丝不动，仍是 15.2。
  return MIN_INFERENCE_INTERVAL_MS;
}
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
          delegate: motionDebug.delegate,
          // 自适应档位走到了哪一档。降档到底有没有让推理变快，不报出来只能猜。
          inference_side: inferenceMaxSide,
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
function draw(poses: NormalizedLandmark[][]): void { resizeCanvas(); context.clearRect(0, 0, canvas.width, canvas.height); drawingUtils ||= new DrawingUtils(context); const pose = poses[0]; if (pose) { drawingUtils.drawConnectors(pose, PoseLandmarker.POSE_CONNECTIONS, { color: "#c8ff38", lineWidth: 2 }); drawingUtils.drawLandmarks(pose, { color: "#fff", fillColor: "#0b1014", radius: 2 }); } renderZoneOverlay(); }
function resizeCanvas(): void { const width = video.videoWidth || 960; const height = video.videoHeight || 540; if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; } }
function recordCameraFrame(now: number): void { cameraFrameCount++; if (now - cameraFpsStarted >= 1000) { document.querySelector("#cameraFps")!.textContent = `${Math.round(cameraFrameCount * 1000 / (now - cameraFpsStarted))} FPS`; cameraFrameCount = 0; cameraFpsStarted = now; } }
function cameraFrame(now: number): void { if (!cameraFrameLoop || !stream) return; recordCameraFrame(now); if (cameraFrameLoop && stream) video.requestVideoFrameCallback(cameraFrame); if (running) predict(now); }
function startCameraFrameCounter(): void { cameraFrameLoop = typeof video.requestVideoFrameCallback === "function"; cameraFrameCount = 0; cameraFpsStarted = performance.now(); if (cameraFrameLoop) video.requestVideoFrameCallback(cameraFrame); }
function applyMirror(): void { document.querySelector<HTMLElement>("#cameraStage")?.classList.toggle("front-mirror", facingMode === "user"); }

// 复选框保存用户偏好；后台停止或启动报错只更新状态，不能把偏好改成关闭。
async function stopVoiceControl(showOff = true): Promise<void> { voiceEnabled = false; activeVoicePhrases = ""; await nativeVoiceTextListener?.remove().catch(() => {}); await nativeVoiceStateListener?.remove().catch(() => {}); await nativeAudioErrorListener?.remove().catch(() => {}); nativeVoiceTextListener = null; nativeVoiceStateListener = null; nativeAudioErrorListener = null; await NativeAudio.stop().catch(() => {}); if (showOff) setVoiceStatus("off"); }
async function startVoiceControl(): Promise<void> { if (activeRole !== "camera") { setVoiceStatus("error", "仅摄像头可用"); return; } if (voiceEnabled) return; if (socket?.readyState !== WebSocket.OPEN) { setVoiceStatus("error", "请先连接电脑"); return; } setVoiceStatus("connecting", "准备语音模型"); try { const phrases = voicePhrases(); activeVoicePhrases = phrases.join(" ");
    // 状态监听必须在 start 之前挂上。第一次开语音要从电脑下载 65 MB，进度是在
    // start 还没返回的那段时间里发出来的——挂晚了一条都收不到，界面看着像卡死。
    nativeVoiceStateListener = await NativeAudio.addListener("voiceState", (event) => { if (!voiceEnabled && event.state !== "connecting") return; const detail = event.message || (event.state === "command" ? "已识别命令" : event.state === "listening" ? "语音识别已就绪" : "等待语音"); setVoiceStatus(event.state === "connecting" ? "connecting" : "listening", detail); });
    const ready = await NativeAudio.start({ phrases: phrases.length ? phrases : undefined, baseUrl: deviceHttpBase() }); if (!ready.recognizerReady) throw new Error("语音模型错误"); voiceEnabled = true; nativeVoiceTextListener = await NativeAudio.addListener("voiceText", (event) => { const text = (event.text || "").trim(); if (!voiceEnabled || !event.final || !text) return; setVoiceStatus("listening", `识别：${text.replace(/\s+/g, "")}`); if (socket?.readyState !== WebSocket.OPEN) { setVoiceStatus("error", "电脑已断开"); return; } const frame: Record<string, unknown> = { type: "voice_text", role: "camera", device_id: deviceId, sequence: sequence++, captured_at_ms: Date.now() + serverClockOffsetMs, text, confidence: event.confidence, final: true, source: "android_vosk_speech_service_v100" }; socket.send(JSON.stringify(frame)); }); nativeAudioErrorListener = await NativeAudio.addListener("audioError", (event) => { setVoiceStatus("error", event.message || "手机语音错误"); void stopVoiceControl(false); }); setVoiceStatus("listening", "Vosk 受限语法已就绪"); } catch (error) { const message = error instanceof Error ? error.message : String(error); const denied = /未授权|permission|denied/i.test(message); await stopVoiceControl(false); // 插件报上来的话本来就是给人看的（"先连上电脑"、"电脑上没有中文语音模型"），
    // 压成一句"模型错误"等于把唯一有用的线索丢掉。
    setVoiceStatus(denied ? "unauthorized" : "error", denied ? "未授权" : message || "错误"); } }

async function stop(): Promise<void> { running = false; overlayRenderingEnabled = true; lastSendStateText = ""; cameraFrameLoop = false; if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); socket = null; poseLandmarker?.close(); poseLandmarker = null; releaseHandModel(); handTrackingSide = null; clearWebCamera(); motionDebug.videoReady = false; motionDebug.videoWidth = 0; motionDebug.videoHeight = 0; await stopVoiceControl(); await wakeLock?.release().catch(() => {}); wakeLock = null; context.clearRect(0, 0, canvas.width, canvas.height); setupCard.classList.remove("hidden"); runtimeCard.classList.add("hidden"); showStatus.classList.add("hidden"); document.querySelector("#guide")!.classList.add("hidden"); setConnection("offline");
  // 回到这一页就重新读一遍。人很可能就是刚刚按着上面那个按钮去把网络共享
  // 打开了再回来的——还给他看一句"两条路都没开"，那句话就从提示变成了错误。
  await refreshLinkState(); }
async function chooseCamera(cameraId: string): Promise<void> { selectedCameraDeviceId = cameraId; cameraDeviceSelect.value = cameraId; if (running) await startCamera(); applyMirror(); }
async function chooseFacing(target: "user" | "environment"): Promise<void> { if (!running || facingMode === target) { updateCameraButtons(); return; } const previousFacing = facingMode; const previousDevice = selectedCameraDeviceId; facingMode = target;
  try { localStorage.setItem("motionbridge-facing", target); } catch { /* 存不下不影响这次切换 */ } selectedCameraDeviceId = "__auto__"; cameraDeviceSelect.value = "__auto__"; cameraSwitchState.textContent = "切换中"; try { await startCamera(); cameraSwitchState.textContent = `当前${target === "user" ? "前置镜头" : "后置镜头"}`; } catch (error) { facingMode = previousFacing; selectedCameraDeviceId = previousDevice; cameraSwitchState.textContent = `切换失败：${error instanceof Error ? error.message : "无法打开镜头"}`; try { await startCamera(); } catch { cameraSwitchState.textContent += "；原镜头恢复失败"; } updateCameraButtons(); } }
function showRole(role: "home" | "camera" | "handheld"): void { activeRole = role; roleCard.classList.toggle("hidden", role !== "home"); setupCard.classList.toggle("hidden", role !== "camera"); handheldCard.classList.toggle("hidden", role !== "handheld"); voiceControl.classList.toggle("hidden", role !== "camera"); document.querySelector("#pageTitle")!.textContent = role === "handheld" ? "手持手柄" : role === "camera" ? "固定摄像头" : "手机控制端";
  // 手柄模式下把页头藏起来。两个理由：卡片自己就有连接状态徽标，页头那个是重复的；
  // 而且两者都是固定定位，横屏时版本号折成两行会把页头撑高压到卡片上——标题整个
  // 被盖住，看着像渲染坏了。
  document.querySelector<HTMLElement>("header")?.classList.toggle("hidden", role === "handheld");
  renderControlConfig(); }

async function sendHandheldFrame(): Promise<void> { if (sensorPolling || handheldSocket?.readyState !== WebSocket.OPEN) return; sensorPolling = true; try { const sample = await SensorBridge.getLatest(); const touches: Record<string, unknown>[] = [...padState].map((control) => ({ control, pressed: true })); if (Math.abs(stickState.x) > 0.02 || Math.abs(stickState.y) > 0.02) touches.push({ control: "stick", x: stickState.x, y: stickState.y }); handheldSocket.send(JSON.stringify({ type: "sensor_frame", role: "sensor", device_id: deviceId, sequence: handheldSequence++, captured_at_ms: Date.now(), player_slot: Number(document.querySelector<HTMLSelectElement>("#handheldSlot")!.value), quaternion: { x: sample.qx, y: sample.qy, z: sample.qz, w: sample.qw }, orientation: {}, rotation_rate: { x: sample.gx, y: sample.gy, z: sample.gz }, acceleration: { x: sample.ax, y: sample.ay, z: sample.az }, touches, recenter: handheldRecenter })); if (handheldRecenter) { handheldRecenter = false; document.querySelector("#sensorState")!.textContent = "已居中"; } handheldFrames++; const now = performance.now(); if (now - handheldFpsStarted >= 1000) { document.querySelector("#sensorFps")!.textContent = `${Math.round(handheldFrames * 1000 / (now - handheldFpsStarted))} FPS`; handheldFrames = 0; handheldFpsStarted = now; } } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器异常"; } finally { sensorPolling = false; } }
function clearTouches(): void { padState.clear(); stickState = { x: 0, y: 0 }; document.querySelector<HTMLElement>("#stick i")!.style.transform = "translate(0,0)"; document.querySelectorAll("[data-pad]").forEach((element) => element.classList.remove("pressed")); void sendHandheldFrame(); }
async function startHandheld(): Promise<void> { showRole("handheld");
  // 重连会再走一遍这里，旧的定时器不清就会越攒越多。
  if (handheldTimer != null) { window.clearInterval(handheldTimer); handheldTimer = null; }
  try { await SensorBridge.start(); wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; const sensorLine = document.querySelector("#sensorState")!;
    // 原来这里只认输入框里的地址，填错或者换了网段就直接报「请填写电脑服务器地址」。
    // 手柄模式其实比摄像头模式更需要自动发现：握着手柄的人眼睛在电视上。
    const picked = await pickServer(handheldServerInput.value.trim() || serverInput.value.trim(),
                                    (phase) => { sensorLine.textContent = phase; });
    if (!picked.found) throw new Error("没找到电脑");
    const address = picked.url; serverInput.value = address; handheldServerInput.value = address;
    localStorage.setItem("motionbridge-server", address); handheldRunning = true;
    handheldSocket = new WebSocket(normalizeSocketUrl(address)); handheldPairing = makePairingSession("sensor", (message) => handheldSocket?.send(JSON.stringify(message))); handheldSocket.addEventListener("open", () => { document.querySelector("#handheldConnection")!.className = "badge online"; document.querySelector("#handheldConnection b")!.textContent = "已连接电脑"; document.querySelector("#sensorState")!.textContent = "自然持握 1 秒"; window.setTimeout(() => { handheldRecenter = true; }, 1000); }); handheldSocket.addEventListener("message", (event) => { try { const message = JSON.parse(event.data); if (isPairingMessage(message.type)) { void handheldPairing?.handle(message); return; } if (message.type === "control_config_v1") applyControlConfig(message); if (message.type === "trigger_state_v1") applyTriggerState(message); if (message.type === "game_output_state_v1") applyGameOutputState(message); if (message.type === "error") document.querySelector("#sensorState")!.textContent = message.message || "连接失败"; } catch { /* ignore malformed bridge messages */ } }); handheldSocket.addEventListener("close", () => { markControlConfigCached(); clearTriggerState(); clearTouches(); document.querySelector("#handheldConnection")!.className = "badge error"; document.querySelector("#handheldConnection b")!.textContent = "电脑已断开";
      // 摄像头模式早就这么做了，手柄模式一直没有：断了就是断了，要人再来一次。
      if (handheldRunning) window.setTimeout(() => { if (handheldRunning) void startHandheld(); }, 1500); }); handheldTimer = window.setInterval(() => void sendHandheldFrame(), 16); } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器不可用";
    // 地址框平时收着——自动找得到的话它一辈子用不上。只有真找不到时才露出来，
    // 这时它从"一个要填的空"变成"最后一条出路"。
    document.querySelector("#handheldAddressField")?.classList.remove("hidden"); } }
async function stopHandheld(): Promise<void> { handheldRunning = false; clearTouches(); if (handheldTimer != null) window.clearInterval(handheldTimer); handheldTimer = null; await new Promise((resolve) => setTimeout(resolve, 35)); handheldSocket?.close(); handheldSocket = null; await SensorBridge.stop().catch(() => {}); await wakeLock?.release().catch(() => {}); wakeLock = null; showRole("home"); setConnection("offline"); }
async function suspendHandheld(): Promise<void> { handheldRunning = false; clearTouches(); if (handheldTimer != null) window.clearInterval(handheldTimer); handheldTimer = null; await new Promise((resolve) => setTimeout(resolve, 35)); handheldSocket?.close(); handheldSocket = null; await SensorBridge.stop().catch(() => {}); document.querySelector("#sensorState")!.textContent = "已暂停"; }
async function handleBackButton(): Promise<void> { if (activeRole === "home") { await App.exitApp(); return; } if (activeRole === "camera") { await stop(); showRole("home"); return; } await stopHandheld(); }
function updateStick(event: PointerEvent): void { const stick = document.querySelector<HTMLElement>("#stick")!; const rect = stick.getBoundingClientRect(); const x = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.38))); const y = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height * 0.38))); stickState = { x, y }; stick.querySelector<HTMLElement>("i")!.style.transform = `translate(${x * 34}px,${y * 34}px)`; }

// 把上面那个判断说给用户听——但只在有话说的时候。
//
// 正常的时候什么都不显示。一行「数据线已接通」对已经接通的人没有用处，它只是
// 在本来就够满的一页上又占一格，还让真正要紧的那句话看起来和它一样重要。
// 会显示的只有两种：两条路都没开（按多少次都不会成功），和按过之后确实没找到。
//
// 打不开网络共享是系统的规矩（要系统权限），能做到的极限是替他跳过去。
function renderLinkState(state: LinkState, failed = false): void {
  const line = document.querySelector<HTMLElement>("#linkLine");
  const actions = document.querySelector<HTMLElement>("#linkActions");
  const box = document.querySelector<HTMLElement>("#linkState");
  if (!line || !actions || !box) return;

  const buttons: { label: string; which: "tether" | "wifi" }[] = [];
  let text = "";
  if (state.known && !state.usb && !state.wifi) {
    text = "两条路都没开：现在只有移动数据，连不到电脑。二选一——连上电脑那个 WiFi，或者插数据线再打开「USB 网络共享」。";
    buttons.push({ label: "打开网络共享", which: "tether" }, { label: "连 WiFi", which: "wifi" });
  } else if (failed && !state.known) {
    text = "没找到电脑。手机和电脑要连同一个 WiFi，或者插数据线并打开「USB 网络共享」。";
    buttons.push({ label: "打开网络共享", which: "tether" }, { label: "连 WiFi", which: "wifi" });
  } else if (failed && state.usb) {
    text = "数据线这条路是通的，但没找到电脑。确认电脑上 MotionControl 开着，并且「摄像头来源」已经选了手机摄像头。";
  } else if (failed) {
    text = "这个 WiFi 里没找到电脑。多半是两边不在同一个路由器下——换成插数据线最省事。";
    buttons.push({ label: "换成数据线", which: "tether" });
  }
  if (failed) {
    // 自动找不到时最后一招：让人照着电脑屏幕填。但完整 IP 有十五个字符，错一个
    // 就白填一次——而手机已经知道自己在哪个网段了，真正缺的只有最后一段。
    const hint = lastOctetHint(state.links ?? []);
    if (hint && !serverInput.value.includes(hint.prefix)) {
      serverInput.value = hint.prefix;
      text += `\n实在找不到就手填：电脑上那个地址的最后一段（比如 ${hint.example}），补在上面的「电脑地址」里。前面几位已经替你填好了。`;
    }
  }

  box.hidden = !text;
  if (!text) { actions.replaceChildren(); return; }
  line.textContent = text;
  actions.replaceChildren(...buttons.map(({ label, which }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = label;
    button.addEventListener("click", () => {
      void LocalNetwork.openSettings({ which }).catch(() => {
        line.textContent = "这台手机打不开那一页，请自己去系统设置里找「网络共享」或者 WiFi。";
      });
    });
    return button;
  }));
}

async function refreshLinkState(failed = false): Promise<void> {
  renderLinkState(await readLinkState(), failed);
}

renderControlConfig();
document.querySelector("#cameraRole")!.addEventListener("click", () => { void (running ? stop() : Promise.resolve()).then(() => { showRole("camera"); void refreshLinkState(); return refreshCameraDevices(); }).catch((error) => { document.querySelector("#securityWarning")!.textContent = error instanceof Error ? error.message : String(error); }); });
document.querySelector("#handheldRole")!.addEventListener("click", () => { void (running || voiceEnabled ? stop() : Promise.resolve()).then(() => startHandheld()); });
document.querySelector("#cameraHome")!.addEventListener("click", () => { void stop().then(() => showRole("home")); });
document.querySelector("#startButton")!.addEventListener("click", () => void start()); document.querySelector("#stopButton")!.addEventListener("click", () => void stop());
gameControlButton.addEventListener("click", () => { if (gameOutputEnabled !== null) requestGameOutput(!gameOutputEnabled); });
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
// 进后台 / 回前台。
//
// 摄像头模式以前在这里什么都不做：进后台时系统把摄像头收走、画面循环停了，界面却还
// 以为在跑；回来就卡在那儿，只能手动停止再开始。现在进后台就干净地停掉，回来自动
// 重新连上开始——半死不活的状态修补起来总会漏一处，整个停掉再起一遍是确定的。
//
// 语音开关要记住。以前进后台会顺手把它取消勾选，回来就再也不自己开了。
let resumeCameraOnReturn = false;
let cameraSuspending: Promise<void> | null = null;
function onVisibilityChange(): void {
  if (document.hidden) {
    if (running && activeRole === "camera") {
      resumeCameraOnReturn = true;
      cameraSuspending = stop();
    } else if (voiceEnabled) {
      void stopVoiceControl(false);
    }
    if (activeRole === "handheld") void suspendHandheld();
    return;
  }
  if (activeRole === "handheld" && handheldTimer == null) void startHandheld();
  if (resumeCameraOnReturn && activeRole === "camera") {
    resumeCameraOnReturn = false;
    // 等进后台时那次停止真的走完再开。停止里有几步是异步的，要是回来得快，它的
    // 收尾（把界面切回设置页）会落在重新开始之后，界面就和实际状态对不上了。
    void (async () => {
      await cameraSuspending;
      cameraSuspending = null;
      if (!running) await start();
    })();
  }
  if ((running || activeRole === "handheld") && !wakeLock) void navigator.wakeLock?.request("screen").then((lock) => { wakeLock = lock; }).catch(() => {});
}
document.addEventListener("visibilitychange", onVisibilityChange);
window.addEventListener("beforeunload", () => { clearTouches(); void stopVoiceControl(); });
void // 装的 APK 是一个版本，跑的网页可能是另一个。一半的修复走热更，APK 不会
// 跟着变，所以只报 APK 版本的话，"我这版有没有那个修复"就只能靠猜——而反馈
// 表单里恰好要填这个数。两个一样时只写一个，不一样才把网页那个也写出来。
void App.getInfo().then((info) => {
  const el = document.querySelector<HTMLElement>("#brandVersion");
  if (!el || !info?.version) return;
  el.textContent = info.version === __WEB_VERSION__
    ? `MOTIONCONTROL ${info.version}`
    : `MOTIONCONTROL ${info.version} · 网页 ${__WEB_VERSION__}`;
}).catch(() => { /* 浏览器里没有原生信息，维持网页版本就行 */ });
App.addListener("backButton", () => { void handleBackButton(); });
// 从系统设置页回来的时候再看一眼。上面那两个按钮把人送出去，
// 他在那边把开关打开再按返回——这一路全在 App 外面发生，不听一下的话
// 那行字会停在"两条路都没开"，而他刚刚照做了。
void App.addListener("appStateChange", ({ isActive }) => {
  if (isActive && !running && activeRole === "camera") void refreshLinkState();
});
