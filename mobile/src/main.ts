import { DrawingUtils, FilesetResolver, HandLandmarker, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  candidatesOf, dedupeServers, forgetFailures, lastOctetHint, mergeCandidates,
  pickBest, rankCandidates, parseCandidates, replaceCandidates, type Discovered, type ProbeResult, type ServerCandidate,
} from "./discovery";
import { BluetoothController, bluetoothButtons, relativeTilt, StickMouse, type BluetoothState } from "./bluetooth-controller";
import { GyroMouse } from "./gyro-mouse";
import { SHOOTER_CONTROLS_HTML, createShooterControls, type ShooterControlState } from "./shooter-controls";
import { SessionCancelled, SessionGeneration, SocketLiveness, isSessionCancelled, optionalSensorFresh, sampleCapturedAt, sensorSampleFresh } from "./session";
import VisionWorker from "./vision.worker?worker";
import { VisionWorkerClient, supportsVisionWorker } from "./vision-worker-client";
import { HAND_CROP_SIDE, handCropBox, inferenceSize, packHandCrop, type HandSide, type PackedHand } from "./vision-core";
import type { VisionResult } from "./vision-protocol";
import "./style.css";
import { ComputerReconnect, matchesComputer, parseConnectionCode, probeCanIdentify, readComputer, saveComputer } from "./connection-code";
import { SEEN_WEB_VERSION_KEY, compareVersions, pendingReleases, readReleaseNotes, renderReleases, webUpdateLine } from "./release-notes";

type ConnectionState = "offline" | "connecting" | "online" | "error";
type VoiceStatus = "off" | "connecting" | "listening" | "error" | "unauthorized";
type ModelChoice = "full" | "lite";
type VoiceRecognitionMode = "computer" | "phone";
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
  // 同一份口令按模型词表拆好的样子，空格隔开。有它就照它建 grammar，和电脑听到的
  // 一样；「城堡」这种只能按整词认的口令，逐字拆会被模型丢掉一个字。
  voice_grammar?: string[];
  // Whether to run the hand model, and on which hand.  The desktop asks only
  // while it is actually steering with a hand -- see the hand joint section.
  hand_tracking?: { enabled?: boolean; hand?: string; hands?: string[] };
  // Every address the desktop can be reached at, best link first.
  server_candidates?: { host?: string; port?: number; kind?: string }[];
};
type SensorSample = { qx: number; qy: number; qz: number; qw: number; gx: number; gy: number; gz: number; ax: number; ay: number; az: number; timestamp: number; running: boolean; accelerationIncludesGravity?: boolean; rotationAvailable?: boolean; sample_age_ms?: number; gyro_age_ms?: number; rotation_age_ms?: number; acceleration_age_ms?: number; accelerationAvailable?: boolean };
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
  inferenceBackend: "main" | "worker" | "unknown";
  workerFallbackError: string | null;
  workerDroppedFrames: number;
  workerQueueMs: number;
  mainBusyMs: number;
  timings: { cameraOpenMs: number; modelLoadMs: number; copyMs: number; poseMs: number; handsMs: number; overlayMs: number; encodeMs: number; frameToSendMs: number; totalMs: number };
  networkDroppedFrames: number;
  sensorDroppedFrames: number;
  modelRecoveries: number;
  cameraRecoveries: number;
  nativeApi: number;
  webUpdateState: string;
  bootHealthError: string | null;
  timingSamples: { atMs: number; copyMs: number; poseMs: number; handsMs: number; overlayMs: number; encodeMs: number; frameToSendMs: number; totalMs: number }[];
};
declare global { interface Window { __motionDebug: MotionDebug; } }
type LocalVoiceText = { text: string; confidence?: number; final: boolean; recognizer: string; recognizedAtMs: number };
type NativeAudioApi = {
  start(options?: { remote?: boolean; phrases?: string[]; grammar?: string[]; baseUrl?: string }): Promise<{ sampleRate: number; channels: number; format: string; source: string; recognizerReady: boolean; audioReady: boolean }>;
  stop(): Promise<void>;
  addListener(eventName: "voiceText", listener: (event: LocalVoiceText) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "voiceState", listener: (event: { state: string; message: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "audioChunk", listener: (event: { audio_base64: string; sample_rate: number; channels: number; format: string; captured_at_ms: number }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "audioError", listener: (event: { message: string }) => void): Promise<PluginListenerHandle>;
};
const NativeAudio = registerPlugin<NativeAudioApi>("NativeAudio");
const SensorBridge = registerPlugin<{ start(options?: { mode: string }): Promise<void>; getLatest(): Promise<SensorSample>; stop(): Promise<void> }>("SensorBridge");
// 倒过来放和状态栏图标颜色只有原生能改；电脑上预览时没有这个插件，调用失败就算了。
const Display = registerPlugin<{ setOrientation(options: { reverse: boolean }): Promise<void>; setBars(options: { light: boolean }): Promise<void> }>("Display");
// 网页包会热更到旧 APK 上，而旧 APK 里没有 Display：白天模式下状态栏图标还是白的，
// 浅色页面上看不见；「倒过来」按了也没反应。所以那种手机上只用深色、不给「倒过来」，
// 装了新 APK 才全开。电脑上预览不是原生，照常跟随系统。
const displayNative = !Capacitor.isNativePlatform() || Capacitor.isPluginAvailable("Display");
if (!displayNative) document.documentElement.classList.add("dark-only");

const app = document.querySelector<HTMLDivElement>("#app")!;
document.body.dataset.role = "home";
// 界面上的线条图标，颜色跟着文字走。
const icon = (body: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICONS = {
  camera: icon('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  gamepad: icon('<path d="M7 8h10a4 4 0 0 1 3.9 4.9l-1 4.3a2 2 0 0 1-3.4.9L14.6 16H9.4l-1.9 2.1a2 2 0 0 1-3.4-.9l-1-4.3A4 4 0 0 1 7 8z"/><path d="M8 11v3M6.5 12.5h3M15.5 11.5h.01M17.5 13.5h.01"/>'),
  chevron: icon('<path d="M9 6l6 6-6 6"/>'),
  back: icon('<path d="M15 6l-6 6 6 6"/>'),
  mic: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  flip: icon('<path d="M20 11a8 8 0 0 0-14.5-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.6L20 16"/><path d="M20 20v-4h-4"/>'),
  upsideDown: icon('<rect x="8" y="2.5" width="8" height="13" rx="2"/><path d="M11 5h2"/><path d="M4.5 16.5a8.5 8.5 0 0 0 15 0"/><path d="M19.5 20.5v-4h-4"/>'),
  frame: icon('<path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/>'),
  collapse: icon('<path d="M6 9l6 6 6-6"/>'),
  expand: icon('<path d="M6 15l6-6 6 6"/>'),
  stop: icon('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
};
app.innerHTML = `
  <div id="cameraStage"><video id="camera" autoplay playsinline muted poster="data:image/gif;base64,R0lGODlhAQABAIAAAAAAACH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></video><canvas id="overlay"></canvas><div class="shade"></div><canvas id="inferenceCanvas" aria-hidden="true"></canvas></div>
  <header class="app-header"><div class="brand"><h1>MotionControl</h1><span id="brandVersion">${__WEB_VERSION__}</span></div><div id="connectionBadge" class="badge"><i></i><b>未连接电脑</b></div></header>
  <main>
    <section class="page role-page" id="roleCard">
      <h2>这台手机用来做什么</h2>
      <div class="role-list">
        <button id="cameraRole" class="role-option" type="button"><em class="role-tag">推荐</em><span class="role-icon">${ICONS.camera}</span><span class="role-text"><strong>固定摄像头</strong><small>立在面前，识别身体动作</small></span></button>
        <button id="handheldRole" class="role-option" type="button"><span class="role-icon">${ICONS.gamepad}</span><span class="role-text"><strong>手持控制器</strong><small>拿在手里，当手柄或鼠标用</small></span></button>
      </div>
    </section>
    <section class="page setup-page hidden" id="setupCard">
      <button id="cameraHome" class="back-button" type="button">${ICONS.back}返回</button>
      <h2>固定摄像头</h2>
      <div class="setup-hero"><span aria-hidden="true">${ICONS.camera}</span><p>电脑上先打开 MotionControl</p></div>
      <div class="link-state" id="linkState" hidden><p id="linkLine"></p><div class="link-actions" id="linkActions"></div></div>
      <button id="startButton" class="start-primary" type="button">连接并开始</button>
      <button id="scanComputerCamera" class="scan-computer" type="button">扫码连接电脑</button>
      <p class="warning" id="securityWarning"></p>
      <details class="more" id="setupMore"><summary>更多设置</summary>
        <label class="field">电脑地址<input id="serverUrl" inputmode="url" autocomplete="url" placeholder="自动查找"></label>
        <label class="field">镜头<select id="cameraDeviceSelect"><option value="__auto__">自动</option></select></label>
        <label class="field">语音识别<select id="voiceRecognitionLocation"><option value="computer">电脑识别（用手机麦克风）</option><option value="phone">手机识别</option></select></label>
        <label class="field technical">识别模型<select id="modelSelect"><option value="full">Full（精度）</option></select></label>
        <p class="web-update-line" id="webUpdateLine" hidden></p>
      </details>
    </section>
    <section class="hud hidden" id="runtimeCard" data-link="offline">
      <div class="hud-status"><div class="hud-recognition"><i class="dot"></i><strong id="sendState">等待完整人体</strong></div><div class="hud-connection"><span id="voiceState" class="voice-state off">关闭</span><b id="panelConnection">未连接</b></div><button id="hideStatus" class="hud-collapse" type="button" aria-label="收起摄像头控制" aria-controls="runtimeCard" aria-expanded="true">${ICONS.collapse}</button></div>
      <button id="gameControlButton" class="game-control" type="button" disabled>连接电脑中</button>
      <div class="hud-tools">
        <label class="tool" id="voiceControl"><input id="voiceToggle" type="checkbox">${ICONS.mic}<span>语音</span></label>
        <button id="flipCameraButton" class="tool" type="button" aria-label="换镜头">${ICONS.flip}<span>换镜头</span></button>
        <button id="upsideDownButton" class="tool" type="button" aria-pressed="false" aria-label="倒过来放，充电口朝上">${ICONS.upsideDown}<span>倒过来</span></button>
        <button id="toggleZonesButton" class="tool" type="button" aria-pressed="true">${ICONS.frame}<span>区域框</span></button>
        <button id="stopButton" class="tool danger" type="button">${ICONS.stop}<span>停止</span></button>
      </div>
      <small id="cameraSwitchState" class="camera-switch-state"></small>
      <div class="technical"><span>摄像头 <b id="cameraFps">0 FPS</b></span><span>识别 <b id="localFps">0 FPS</b></span><span id="modelStatus">Full33</span><span id="delegateStatus">—</span><small id="modelError"></small></div>
    </section>
    <div class="trigger-board camera-trigger-board hidden" id="cameraTriggerBoard" aria-live="polite"><b class="trigger-board-key">—</b><span class="trigger-board-name">做个动作或者说句口令试试</span></div>
    <button id="showStatus" class="status-show hidden" type="button" aria-label="展开摄像头控制" aria-controls="runtimeCard" aria-expanded="false">${ICONS.expand}</button>
    <section class="handheld-card hidden" id="handheldCard">
      <div class="pad-bar handheld-connection-row"><button id="stopHandheld" class="back-button" type="button">${ICONS.back}停止</button><button id="handheldConnection" class="badge" type="button" aria-label="连接设置" aria-controls="handheldMore" aria-expanded="false"><i></i><b>未连接电脑</b></button><div class="handheld-primary-action"><button id="scanComputerHandheld" class="pill-button" type="button">扫码连接</button><button id="centerSensor" class="pill-button" type="button" hidden>重新居中</button></div></div>
      <div class="pad-mode"><div class="seg" id="modeSeg" role="group" aria-label="用法"><button type="button" data-mode="gamepad">手柄</button><button type="button" data-mode="shooter">鼠标</button></div><select id="handheldMode" hidden><option value="gamepad">手柄</option><option value="shooter">鼠标</option></select></div>
      <button id="handheldGameControlButton" class="game-control hidden" type="button" disabled>连接电脑中</button>
      <small id="sensorState">等待传感器</small>
      <div class="shoulders"><button data-pad="l">LB</button><button data-pad="zl">LT</button><button data-pad="zr">RT</button><button data-pad="r">RB</button></div>
      <div class="gamepad"><div id="stick" class="stick"><i></i></div><div class="face-buttons"><button data-pad="y">Y</button><button data-pad="x">X</button><button data-pad="b">B</button><button data-pad="a">A</button></div><div class="middle-buttons"><button data-pad="select" aria-label="手柄返回键，具体功能由游戏决定">返回键</button><button data-pad="start" aria-label="手柄菜单键，具体功能由游戏决定">菜单键</button></div></div>
      ${SHOOTER_CONTROLS_HTML}
      <details id="handheldMore" class="panel handheld-more"><summary>更多</summary><div class="handheld-more-body"><div id="shooterSettings" class="shooter-settings hidden"><label>陀螺仪灵敏度<input id="gyroSensitivity" type="range" min="0.1" max="2" step="0.1" value="0.5"></label><label>摇杆灵敏度<input id="stickSensitivity" type="range" min="400" max="3600" step="200" value="1800"></label></div><label class="field">连接方式<select id="handheldTransport" aria-label="连接方式"><option value="network">网络连接</option><option value="bluetooth">蓝牙连接</option></select></label><button id="scanComputerHandheldMore" class="connection-scan" type="button">扫码连接 / 换电脑</button><details id="bluetoothPanel" class="bluetooth-panel hidden" open><summary>蓝牙设置</summary><p id="bluetoothStatus">先在电脑的蓝牙设置里添加这台手机，再选电脑连接。</p><div class="bluetooth-actions"><button id="bluetoothPair" type="button">允许电脑配对</button><button id="bluetoothRefresh" type="button">刷新设备</button><select id="bluetoothDevice" aria-label="已配对电脑"></select><button id="bluetoothConnect" type="button">连接电脑</button></div><small>蓝牙模拟的是通用手柄；只认 Xbox 手柄的游戏请用网络连接。</small></details><label class="field hidden" id="handheldAddressField">电脑地址<input id="handheldServerUrl" inputmode="url" autocomplete="url" placeholder="自动查找"></label><label class="field">玩家<select id="handheldSlot"><option value="0">玩家一</option><option value="1">玩家二</option></select></label><span>传感器 <b id="sensorFps">0 次/秒</b></span><div class="trigger-board handheld-trigger-board" id="handheldTriggerBoard" aria-live="polite"><strong class="feedback-title">电脑动作反馈</strong><p class="feedback-help">显示电脑识别的动作、口令和对应按键，不影响手动操作。</p><b class="trigger-board-key">—</b><span class="trigger-board-name">暂无动作或口令触发</span></div></div></details>
    </section>
  </main>
  <div class="guide hidden" id="guide"><span>全身站进画面</span></div><div class="loading hidden" id="loading"><i></i><b id="loadingText">正在打开摄像头</b></div>
  <div class="release-notes" id="releaseNotes" role="dialog" aria-modal="true" aria-labelledby="releaseNotesTitle" hidden><section><h2 id="releaseNotesTitle"></h2><div class="release-notes-body" id="releaseNotesBody"></div><button id="releaseNotesOk" class="start-primary" type="button">知道了</button></section></div>`;

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
const voiceRecognitionSelect = document.querySelector<HTMLSelectElement>("#voiceRecognitionLocation")!;
voiceToggle.checked = localStorage.getItem("motionbridge-voice-auto") !== "0";
const voiceStateLabel = document.querySelector<HTMLElement>("#voiceState")!;
const hideStatus = document.querySelector<HTMLButtonElement>("#hideStatus")!;
const showStatus = document.querySelector<HTMLButtonElement>("#showStatus")!;
const gameControlButton = document.querySelector<HTMLButtonElement>("#gameControlButton")!;
const handheldGameControlButton = document.querySelector<HTMLButtonElement>("#handheldGameControlButton")!;
const toggleZonesButton = document.querySelector<HTMLButtonElement>("#toggleZonesButton")!;
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
const flipCameraButton = document.querySelector<HTMLButtonElement>("#flipCameraButton")!;
const upsideDownButton = document.querySelector<HTMLButtonElement>("#upsideDownButton")!;
upsideDownButton.classList.toggle("hidden", !displayNative);
const cameraSwitchState = document.querySelector<HTMLElement>("#cameraSwitchState")!;

let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let visionTask: Promise<Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>> | null = null;
let poseLandmarker: PoseLandmarker | null = null;
type CameraInferenceFrame = { session: number; source: number; model: number; connection: number;
  timestampMs: number; capturedAtMs: number; startedAt: number; width: number; height: number;
  facing: "user" | "environment"; cameraId: string; inferenceSide: number; captureMs: number; captureMainMs: number };
let visionWorker: VisionWorkerClient<CameraInferenceFrame> | null = null;
let workerFailed = false;
let workerCaptureToken: object | null = null;
let stream: MediaStream | null = null;
let socket: WebSocket | null = null;
let handheldSocket: WebSocket | null = null;
// 主动停止和断线重连要分得开：停了之后还在后台重连，是最难查的那种「关不掉」。
let handheldRunning = false;
let handheldConnected = false;
let reconnectTimer: number | null = null;
let handheldTimer: number | null = null;
let wakeLock: WakeLockSentinel | null = null;
let nativeVoiceTextListener: PluginListenerHandle | null = null;
let nativeVoiceStateListener: PluginListenerHandle | null = null;
let nativeAudioChunkListener: PluginListenerHandle | null = null;
let nativeAudioErrorListener: PluginListenerHandle | null = null;
let running = false;
let activeRole: "home" | "camera" | "handheld" = "home";
let scannerAbort: AbortController | null = null;
let connectionTouched = false;
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
let voiceRecognitionMode: VoiceRecognitionMode = localStorage.getItem("motionbridge-voice-recognition") === "phone" ? "phone" : "computer";
voiceRecognitionSelect.value = voiceRecognitionMode;
let voiceState: VoiceStatus = "off";
let sequence = 0;
let voiceSequence = 0;
let lastVideoTime = -1;
let lastInferenceAt = 0;
let inferenceBusy = false;
let fpsCounter = 0;
let fpsStarted = performance.now();
let cameraFrameCount = 0;
let cameraFpsStarted = performance.now();
let cameraFrameLoop = false;
const cameraSession = new SessionGeneration();
const cameraSource = new SessionGeneration();
const poseModelSession = new SessionGeneration();
const handModelSession = new SessionGeneration();
const voiceSession = new SessionGeneration();
const cameraSocketSession = new SessionGeneration();
let cameraStartTask: Promise<void> | null = null;
let cameraStopTask: Promise<void> | null = null;
let voiceStartTask: Promise<void> | null = null;
let voiceStopTask: Promise<void> | null = null;
let nativeVoiceStartBarrier: Promise<void> = Promise.resolve();
let cameraFrameCallback: number | null = null;
let predictAnimationFrame: number | null = null;
let cameraHealthTimer: number | null = null;
let socketHealthTimer: number | null = null;
let handheldHealthTimer: number | null = null;
let lastCameraVideoTime = -1;
let lastCameraFrameAt = 0;
let lastCameraCapturedAtMs = 0;
let modelRecoveryTask: Promise<void> | null = null;
let cameraRecoveryTask: Promise<void> | null = null;
let forceCpuDelegate = false;
let modelRecoveryAttempts = 0;
let cameraRecoveryAttempts = 0;
let sensorDroppedFrames = 0;
let sensorStaleSince = 0;
let serverClockOffsetMs = 0;
let lastClockSyncAt = 0;
let lastServerPoseCount = 0;
let handheldSequence = 0;
let handheldRecenter = false;
let handheldFrames = 0;
let handheldFpsStarted = performance.now();
let sensorPollingGeneration: { controller: number; mode: number } | null = null;
let stickState = { x: 0, y: 0 };
const modeInput = document.querySelector<HTMLSelectElement>("#handheldMode")!;
const transportInput = document.querySelector<HTMLSelectElement>("#handheldTransport")!;
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("#modeSeg [data-mode]")];
for (const button of modeButtons) button.addEventListener("click", () => {
  if (modeInput.disabled || modeInput.value === button.dataset.mode) return;
  modeInput.value = button.dataset.mode!;
  modeInput.dispatchEvent(new Event("change"));
});
const handheldSettingIds = ["handheldMode", "handheldTransport", "gyroSensitivity", "stickSensitivity", "handheldSlot"];
for (const id of handheldSettingIds) {
  const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
  const key = `motionbridge-setting-${id}`;
  const saved = localStorage.getItem(key);
  if (saved != null) {
    if (input instanceof HTMLSelectElement && [...input.options].some(option => option.value === saved)) input.value = saved;
    else if (input instanceof HTMLInputElement && Number.isFinite(Number(saved))
        && Number(saved) >= Number(input.min) && Number(saved) <= Number(input.max)) input.value = saved;
  }
  const save = () => { try { localStorage.setItem(key, input.value); } catch { /* 保留本次设置。 */ } };
  input.addEventListener("change", save);
  if (input instanceof HTMLInputElement) input.addEventListener("input", save);
}
function saveHandheldSettings(): void {
  for (const id of handheldSettingIds) {
    try { localStorage.setItem(`motionbridge-setting-${id}`, document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value); }
    catch { /* 保留本次设置。 */ }
  }
}
let controllerGeneration = 0;
let controllerModeGeneration = 0;
let controllerModeChanging = false;
let controllerModeTask: Promise<void> | null = null;
let controllerSensorMode = modeInput.value;
let controllerSensorFault = false;
let controllerStarting = false;
let controllerStartTask: Promise<void> | null = null;
let controllerSuspendTask: Promise<void> | null = null;
let bluetoothSystemDialog = false;
let bluetoothState: BluetoothState | null = null;
let bluetoothListener: PluginListenerHandle | null = null;
let bluetoothReconnectTimer: number | null = null;
let bluetoothReconnectAttempt = 0;
let bluetoothConnectGeneration = -1;
let bluetoothSelectionPending = false;
let bluetoothOutputEnabled = false;
let controllerAppActive = true;
let tiltBaseline: number[] | null = null;
let shooterState: ShooterControlState = { stick: { x: 0, y: 0 }, stickPressed: false, mouseButtons: 0 };
const gyroMouse = new GyroMouse();
const gyroCalibrationKey = "motionbridge-gyro-calibration-v1";
let savedGyroCalibration: unknown = null;
let gyroCalibrationPending = false;
let gyroCalibrationSaved = false;
try { savedGyroCalibration = JSON.parse(localStorage.getItem(gyroCalibrationKey) || "null"); } catch { /* 首次使用重新校准。 */ }
gyroCalibrationSaved = savedGyroCalibration != null;
function resetGyroSession(): void {
  gyroMouse.reset();
  if (!gyroCalibrationPending && !gyroMouse.restoreCalibration(savedGyroCalibration)) {
    savedGyroCalibration = null;
    gyroCalibrationSaved = false;
  }
}
resetGyroSession();
const stickMouse = new StickMouse();
const shooterControls = createShooterControls(document.querySelector<HTMLElement>("#shooterControls")!, (state) => {
  const buttonsChanged = state.mouseButtons !== shooterState.mouseButtons;
  if (state.stickPressed && !shooterState.stickPressed) gyroMouse.pause();
  shooterState = state;
  if (!state.stickPressed) stickMouse.reset();
  // 按键变化直接发送，短点击也不必等下一次传感器轮询。
  if (buttonsChanged && modeInput.value === "shooter") {
    if (transportInput.value === "bluetooth" && bluetoothState?.connected && bluetoothOutputEnabled && !controllerModeChanging && !controllerSensorFault) {
      void BluetoothController.sendMouse({ buttons: state.mouseButtons, dx: 0, dy: 0, sessionId: bluetoothState.sessionId }).catch(controllerError);
    } else if (transportInput.value === "network" && !controllerModeChanging && !controllerSensorFault) sendNetworkMouse(0, 0, state.mouseButtons);
  }
});
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
type TriggerStateV1 = { type: "trigger_state_v1"; held?: TriggerBrief[]; fired?: TriggerBrief[]; zones?: Record<string, unknown>; at?: number };
type GameOutputStateV1 = { type: "game_output_state_v1"; enabled?: boolean; ok?: boolean; error?: string };
/** 打中之后大字亮多久。太短了人还没把视线从游戏挪过来就灭了。 */
const TRIGGER_HOLD_MS = 2500;
let triggerHeld: TriggerBrief[] = [];
let triggerLast: TriggerBrief | null = null;
let triggerLastAt = 0;
let triggerFadeTimer: number | null = null;
let runtimeZones: Record<string, unknown> = {};
type ZoneGeometry =
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "rect"; x1: number; y1: number; x2: number; y2: number };
const animatedZones: Record<string, ZoneGeometry> = {};
let lastZoneAnimationAt = performance.now();

function zoneGeometry(raw: unknown): ZoneGeometry | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as { circle?: Record<string, unknown>; rect?: Record<string, unknown>; shape?: string; cx?: number; cy?: number; r?: number };
  const circle = state.circle || (state.shape === "circle" ? state : undefined);
  if (circle && [circle.cx, circle.cy, circle.r].every((value) => Number.isFinite(Number(value)))) {
    return { kind: "circle", cx: Number(circle.cx), cy: Number(circle.cy), r: Number(circle.r) };
  }
  const rect = state.rect;
  if (rect && [rect.x1, rect.y1, rect.x2, rect.y2].every((value) => Number.isFinite(Number(value)))) {
    return { kind: "rect", x1: Number(rect.x1), y1: Number(rect.y1), x2: Number(rect.x2), y2: Number(rect.y2) };
  }
  return null;
}

function smoothZone(from: ZoneGeometry, to: ZoneGeometry, amount: number): ZoneGeometry {
  if (from.kind !== to.kind) return to;
  const mix = (a: number, b: number) => a + (b - a) * amount;
  return from.kind === "circle"
    ? { kind: "circle", cx: mix(from.cx, (to as typeof from).cx), cy: mix(from.cy, (to as typeof from).cy), r: mix(from.r, (to as typeof from).r) }
    : { kind: "rect", x1: mix(from.x1, (to as typeof from).x1), y1: mix(from.y1, (to as typeof from).y1), x2: mix(from.x2, (to as typeof from).x2), y2: mix(from.y2, (to as typeof from).y2) };
}

function applyTriggerState(message: TriggerStateV1): void {
  const released = triggerHeld;
  triggerHeld = Array.isArray(message.held) ? message.held : [];
  if (message.zones && typeof message.zones === "object") runtimeZones = message.zones;
  const fired = Array.isArray(message.fired) ? message.fired : [];
  if (fired.length) {
    triggerLast = fired[fired.length - 1];
    triggerLastAt = performance.now();
  } else if (released.length && !triggerHeld.length) {
    // 松手这一刻重新计时。按住很久再松开时，按下那一刻早就过了停留时间，
    // 不这样的话牌子一松手就没了，人来不及看。
    triggerLast = released[released.length - 1];
    triggerLastAt = performance.now();
  }
  renderTriggerBoards();
}

/** 断线时把"按着"清掉。不清的话最后按着的那个键会一直亮着，像是卡住了。 */
function clearTriggerState(): void {
  triggerHeld = [];
  runtimeZones = {};
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
  // 里也写着，不缺它。一断线标题栏就回来——那一变本身就是在提醒人出问题了。只在
  // 摄像头模式下动标题栏，手柄模式有自己的规矩（showRole 里）。
  //
  // 牌子只在刚触发过时出现，停一会儿就淡出。一直挂着的话它压在头顶区那个框上，
  // 没东西可看的时候就是一块挡画面的黑牌子。
  const cameraLive = activeRole === "camera" && socket?.readyState === WebSocket.OPEN;
  const cameraBoard = document.querySelector<HTMLElement>("#cameraTriggerBoard");
  if (cameraBoard) {
    cameraBoard.classList.toggle("hidden", !cameraLive);
    cameraBoard.classList.toggle("idle", !live);
  }
  if (activeRole === "camera") document.querySelector<HTMLElement>("header")?.classList.toggle("hidden", cameraLive);

  for (const board of document.querySelectorAll<HTMLElement>(".trigger-board")) {
    // 正在淡出的那块保持原样，别在淡出途中变回灰色的占位字。
    if (board === cameraBoard && !live) continue;
    const key = board.querySelector<HTMLElement>(".trigger-board-key");
    const name = board.querySelector<HTMLElement>(".trigger-board-name");
    if (key) key.textContent = keyText;
    if (name) name.textContent = board === cameraBoard || shown.length ? nameText : "暂无动作或口令触发";
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
  if (!zoneOverlayEnabled) return;
  const zones: Record<string, unknown> = { ...(syncedControlConfig?.zones || {}), ...runtimeZones };
  const heldIds = new Set(triggerHeld.map((item) => String(item.id || "")));
  const width = canvas.width, height = canvas.height;
  if (!width || !height) return;
  const px = overlayCssPx;
  const mirrored = facingMode === "user";
  const now = performance.now();
  const amount = Math.min(1, 1 - Math.exp(-(now - lastZoneAnimationAt) / 120));
  lastZoneAnimationAt = now;
  for (const id of ["leftHand", "rightHand", "leftFoot", "rightFoot", "headJump", "lookGate"]) {
    const raw = zones[id];
    // 上下视角那道闸只在电脑端开着「抬头低头」时才发过来；没发就是关了，别留着旧的框。
    if (id === "lookGate" && !raw) { delete animatedZones[id]; continue; }
    const target = zoneGeometry(raw);
    const current = animatedZones[id];
    // Keep the last valid geometry when a low-rate update omits a zone.  This
    // prevents a one-frame disappearance while the next snapshot arrives.
    if (target) animatedZones[id] = current ? smoothZone(current, target, amount) : target;
    const geometry = animatedZones[id];
    if (!geometry) continue;
    const state = (raw && typeof raw === "object" ? raw : {}) as { pressed?: boolean };
    // 键位牌挂在框的上沿正中。挂在中间，前置镜头整块镜像时它也还在原位。
    let labelCx: number, labelCy: number;
    context.beginPath();
    if (geometry.kind === "circle") {
      const radius = Math.max(2, geometry.r * Math.min(width, height));
      const cx = geometry.cx * width, cy = geometry.cy * height;
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      labelCx = cx; labelCy = cy - radius;
    } else {
      const x = geometry.x1 * width, y = geometry.y1 * height;
      const w = (geometry.x2 - geometry.x1) * width, h = (geometry.y2 - geometry.y1) * height;
      if (w <= 0 || h <= 0) continue;
      context.rect(x, y, w, h);
      labelCx = x + w / 2; labelCy = y;
    }
    const active = Boolean(state.pressed) || heldIds.has(id) || heldIds.has(`zone.${id}`);
    const color = active ? "#54f29a" : "#ffb52e";
    context.lineJoin = "round";
    context.fillStyle = active ? "rgba(84,242,154,.28)" : "rgba(255,181,46,.10)";
    context.fill();
    // 先描一圈深色的底，再描彩色的线。墙是白的、衣服是黑的，只有一种颜色的线总有
    // 一种背景上看不清；垫了这圈底，什么背景上都是一条清楚的边。
    context.strokeStyle = "rgba(0,0,0,.6)";
    context.lineWidth = (active ? 10 : 8) * px;
    context.stroke();
    context.strokeStyle = color;
    context.lineWidth = (active ? 6 : 4) * px;
    context.stroke();

    // 键位牌用框的颜色实心填、深色字：几米外看得清，也一眼知道是哪个框的。
    const mappedKey = shortKey(zoneAction(id));
    const pillHeight = 44 * px, margin = 6 * px;
    context.font = `800 ${28 * px}px sans-serif`;
    const pillWidth = Math.max(pillHeight * 1.6, context.measureText(mappedKey).width + 30 * px);
    const pillX = Math.max(margin, Math.min(width - pillWidth - margin, labelCx - pillWidth / 2));
    const pillY = Math.max(margin, Math.min(height - pillHeight - margin, labelCy - pillHeight / 2));
    context.beginPath();
    if (typeof context.roundRect === "function") context.roundRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2);
    else context.rect(pillX, pillY, pillWidth, pillHeight);
    context.fillStyle = color;
    context.fill();
    context.strokeStyle = "rgba(0,0,0,.6)";
    context.lineWidth = 3 * px;
    context.stroke();
    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#0b1014";
    context.translate(pillX + pillWidth / 2, pillY + pillHeight / 2);
    // 前置镜头时整块画面是镜像的，字要翻回来才读得出。后置不镜像，原来这里也照翻，
    // 换到后置字就成了反的。
    if (mirrored) context.scale(-1, 1);
    context.fillText(mappedKey, 0, 0);
    context.restore();
  }
}
let gameOutputEnabled: boolean | null = null;
function applyGameOutputState(message: GameOutputStateV1): void {
  if (typeof message.enabled !== "boolean") return;
  gameOutputEnabled = message.enabled;
  for (const button of [gameControlButton, ...(transportInput.value === "network" ? [handheldGameControlButton] : [])]) {
    button.disabled = false;
    button.textContent = message.enabled ? "暂停控制" : "开始控制";
    button.classList.toggle("enabled", message.enabled);
    button.title = message.ok === false && message.error ? message.error : "";
  }
  if (activeRole === "handheld") renderHandheldGameOutput();
}
function requestGameOutput(enabled: boolean): void {
  const handheld = activeRole === "handheld";
  if (handheld && transportInput.value === "bluetooth") {
    if (!handheldConnected || controllerModeChanging || controllerSensorFault) return;
    bluetoothOutputEnabled = false;
    clearTouches(); resetGyroSession(); tiltBaseline = null; handheldRecenter = true;
    bluetoothOutputEnabled = enabled;
    renderHandheldGameOutput();
    const generation = controllerGeneration;
    const sessionId = bluetoothState?.sessionId;
    if (!enabled) void BluetoothController.releaseAll().then((state) => {
      if (generation === controllerGeneration && sessionId === bluetoothState?.sessionId
          && activeRole === "handheld" && transportInput.value === "bluetooth") applyBluetoothState(state);
    }).catch((error) => { if (generation === controllerGeneration) controllerError(error); });
    return;
  }
  const ws = handheld ? handheldSocket : socket;
  if (ws?.readyState !== WebSocket.OPEN || gameOutputEnabled === null) return;
  (handheld ? handheldGameControlButton : gameControlButton).disabled = true;
  ws.send(JSON.stringify({ type: "game_output_control", role: handheld ? (modeInput.value === "shooter" ? "mouse" : "sensor") : "camera", device_id: deviceId, enabled }));
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
function voiceGrammar(): string[] {
  const list = syncedControlConfig?.voice_grammar;
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
  const phrases = [...voicePhrases(), ...voiceGrammar()].join("\u0000");
  if ((voiceEnabled || voiceStartTask) && voiceRecognitionMode === "phone" && phrases !== activeVoicePhrases) {
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
// 叠加层按屏幕上的真实像素开画布，不按摄像头分辨率：摄像头只有 480 宽，拉满一块
// 1080 宽的屏幕要放大两倍多，框线和字全是糊的。上限 2 倍，再高肉眼分不出，只是
// 白多画像素。
const OVERLAY_MAX_PIXEL_RATIO = 2;
/** 画布上几个像素等于屏幕上 1 个 CSS 像素。框线、字号都按它乘，换手机粗细不变。 */
let overlayCssPx = 1;
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
let zoneOverlayEnabled = localStorage.getItem("motionbridge-zone-overlay") !== "0";
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
  inferenceBackend: "unknown", workerFallbackError: null, workerDroppedFrames: 0, workerQueueMs: 0, mainBusyMs: 0,
  timings: { cameraOpenMs: 0, modelLoadMs: 0, copyMs: 0, poseMs: 0, handsMs: 0, overlayMs: 0, encodeMs: 0, frameToSendMs: 0, totalMs: 0 },
  networkDroppedFrames: 0,
  sensorDroppedFrames: 0,
  modelRecoveries: 0,
  cameraRecoveries: 0,
  nativeApi: 1,
  webUpdateState: "idle",
  bootHealthError: null,
  timingSamples: [],
};

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
let rememberedComputer = readComputer();
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
  try { return parseCandidates(JSON.parse(localStorage.getItem(SERVER_CANDIDATES_KEY) || "[]")); }
  catch { return []; }
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
  saveCandidates(replaceCandidates(readCandidates(), list));
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
    if (probeCanIdentify(result, rememberedComputer)) return matchesComputer(result, rememberedComputer);
  } catch { /* 旧壳子，往下走 */ }
  try {
    if (rememberedComputer) {
      const response = await fetch(`http://${candidate.host}:${candidate.port}/api/models`, {
        cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
      });
      const identity = await response.json();
      return matchesComputer({ ok: response.ok && Array.isArray(identity.models), instance: identity.instance }, rememberedComputer);
    }
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
    Promise<{ ok: boolean; version?: string; instance?: string; name?: string; rttMs: number }>;
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
type WebUpdateResult = { state: "skipped" | "none" | "current" | "ready" | "failed" | "incompatible"; message?: string };
const WebUpdate = registerPlugin<{
  sync(options: { baseUrl: string }): Promise<WebUpdateResult>;
  bootOk(): Promise<void>;
  getCapabilities(): Promise<{ native_api: number; protocol: number; capabilities: Record<string, boolean> }>;
}>("WebUpdate");
// 脚本跑到这里，说明这份网页包至少不是砖。壳子在启动时留了个记号，这一句把它
// 清掉；记号要是活到下次启动，壳子就把这个包丢掉、退回 APK 自带的那份。
let nativeCapabilities: Record<string, boolean> = {};
const nativeCapabilitiesReady = WebUpdate.getCapabilities().then(info => {
  nativeCapabilities = info.capabilities ?? {};
  motionDebug.nativeApi = info.native_api ?? 1;
}).catch(() => { /* Legacy APKs retain their existing feature fallbacks. */ });
let webUpdateChecked = false;
let webUpdateBase = "";
let webUpdateTask: Promise<void> | null = null;
let webUpdateRetryTimer: number | null = null;

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
    return dedupeServers(result?.servers ?? []).filter(server => !rememberedComputer || server.instance === rememberedComputer.instance);
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
  let cached = mergeCandidates(rememberedComputer?.candidates ?? [], readCandidates());

  // 一、上次能连上的地址。网段没变的话这一步就结束了，约一百多毫秒。
  if (cached.length) {
    onPhase(rememberedComputer ? `正在连接 ${rememberedComputer.name}…` : "正在试上次的地址…");
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
    const best = pickBest(await probeAll(rankCandidates(flat, links))) ?? (!rememberedComputer ? flat[0] : null);
    if (best) return { url: normalizeSocketUrl(`${best.host}:${best.port}`), found: true, servers, udpSilent: false };
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

function setConnection(state: ConnectionState): void { const text = ({ offline: "未连接电脑", connecting: "连接中", online: "已连接电脑", error: "连接异常" })[state]; badge.className = `badge ${state}`; badge.querySelector("b")!.textContent = text; runtimeCard.dataset.link = state; const panel = document.querySelector<HTMLElement>("#panelConnection"); if (panel) panel.textContent = text; }
function setVoiceStatus(status: VoiceStatus, detail?: string): void { voiceState = status; voiceStateLabel.textContent = detail || ({ off: "关闭", connecting: "连接中", listening: "正在听", error: "错误", unauthorized: "未授权" })[status]; voiceStateLabel.className = `voice-state ${status}`; }
function poseVoiceState(): "not_connected" | "connected" | "enabled" | "unauthorized" | "failed" { return voiceState === "off" ? "not_connected" : voiceState === "connecting" ? "connected" : voiceState === "listening" ? "enabled" : voiceState === "unauthorized" ? "unauthorized" : "failed"; }
function clearWebCamera(): void {
  cameraSource.next();
  visionWorker?.clearPending(); workerCaptureToken = null;
  cameraFrameLoop = false;
  if (cameraFrameCallback != null) video.cancelVideoFrameCallback?.(cameraFrameCallback);
  cameraFrameCallback = null;
  if (cameraHealthTimer != null) window.clearInterval(cameraHealthTimer);
  cameraHealthTimer = null;
  const oldStream = stream; stream = null;
  oldStream?.getTracks().forEach(track => track.stop());
  video.pause(); video.srcObject = null; video.removeAttribute("src"); video.load(); video.style.display = "none";
  lastCameraVideoTime = lastVideoTime = -1;
}
async function openWebStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return await new Promise<MediaStream>((resolve, reject) => {
    let finished = false;
    const timer = window.setTimeout(() => { if (!finished) { finished = true; reject(new Error("摄像头打开超时")); } }, 5000);
    navigator.mediaDevices.getUserMedia(constraints).then(value => {
      if (finished) { value.getTracks().forEach(track => track.stop()); return; }
      finished = true; window.clearTimeout(timer); resolve(value);
    }, error => { if (!finished) { finished = true; window.clearTimeout(timer); reject(error); } });
  });
}
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

async function getVision() {
  if (vision) return vision;
  visionTask ??= FilesetResolver.forVisionTasks(new URL("./wasm", location.href).href);
  const task = visionTask;
  try { return vision = await task; } finally { if (visionTask === task) visionTask = null; }
}
async function createPose(modelUrl: string, cpuOnly: boolean, generation: number): Promise<{ model: PoseLandmarker; delegate: "GPU" | "CPU"; fallbackError: string | null }> {
  const files = await getVision();
  poseModelSession.assertCurrent(generation);
  const options = (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: modelUrl, delegate }, runningMode: "VIDEO", numPoses: 1,
    minPoseDetectionConfidence: .55, minPosePresenceConfidence: .55, minTrackingConfidence: .55,
  });
  let fallbackError: string | null = null;
  if (!cpuOnly) {
    try { return { model: await options("GPU"), delegate: "GPU", fallbackError }; }
    catch (error) { fallbackError = error instanceof Error ? error.message : String(error); }
  }
  poseModelSession.assertCurrent(generation);
  return { model: await options("CPU"), delegate: "CPU", fallbackError };
}
function updateModelLabel(): void { modelStatus.textContent = modelChoice === "lite" ? "Lite33" : "Full33"; modelSelect.value = modelChoice; }
async function loadPoseModel(session = cameraSession.current): Promise<void> {
  const modelGeneration = poseModelSession.next();
  const started = performance.now();
  document.querySelector("#loading")!.classList.remove("hidden");
  motionDebug.modelState = "loading"; motionDebug.actualModel = modelChoice;
  motionDebug.modelUrl = new URL(`./models/pose_landmarker_${modelChoice}.task`, location.href).href;
  updateModelLabel(); motionDebug.delegate = "unknown";
  if (!forceCpuDelegate) motionDebug.fallbackError = null;
  motionDebug.detectCalls = 0; motionDebug.lastPoseCount = 0; motionDebug.lastInferenceMs = 0; motionDebug.lastDetectError = null;
  const previous = poseLandmarker; poseLandmarker = null; previous?.close();
  const previousWorker = visionWorker; visionWorker = null; previousWorker?.close();
  let loaded: PoseLandmarker | null = null;
  try {
    if (!workerFailed && supportsVisionWorker()) {
      let worker: VisionWorkerClient<CameraInferenceFrame> | null = null;
      try {
        worker = new VisionWorkerClient(new VisionWorker(), { type: "init", wasmBaseUrl: new URL("./wasm", location.href).href,
          poseModelUrl: motionDebug.modelUrl, handModelUrl: new URL("./models/hand_landmarker.task", location.href).href,
          cpuOnly: forceCpuDelegate },
          (frame, result, queueMs) => {
            if (currentInferenceFrame(frame)) {
              motionDebug.workerQueueMs = queueMs;
              consumeVisionResult(frame, result, frame.captureMs + result.timings.copyMs, frame.captureMainMs);
            }
          }, error => {
            if (!cameraSession.isCurrent(session) || !poseModelSession.isCurrent(modelGeneration) || !running) return;
            workerFailed = true; motionDebug.workerFallbackError = error.message;
            void recoverModel(error);
          });
        // Keep ownership during initialization so stop can terminate immediately.
        visionWorker = worker;
        const ready = await worker.ready;
        cameraSession.assertCurrent(session); poseModelSession.assertCurrent(modelGeneration);
        visionWorker = worker; worker = null; releaseHandModel();
        motionDebug.inferenceBackend = "worker"; motionDebug.delegate = ready.delegate;
        motionDebug.fallbackError = ready.fallbackError;
      } catch (error) {
        if (visionWorker === worker) visionWorker = null;
        worker?.close();
        cameraSession.assertCurrent(session); poseModelSession.assertCurrent(modelGeneration);
        if (isSessionCancelled(error)) throw error;
        workerFailed = true; motionDebug.workerFallbackError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!visionWorker) {
      const result = await poseModelSession.resolveResource(modelGeneration, createPose(motionDebug.modelUrl, forceCpuDelegate, modelGeneration), result => result.model.close());
      loaded = result.model;
      cameraSession.assertCurrent(session); poseModelSession.assertCurrent(modelGeneration);
      poseLandmarker = loaded; loaded = null;
      motionDebug.delegate = result.delegate;
      motionDebug.inferenceBackend = "main";
      if (result.fallbackError) motionDebug.fallbackError = result.fallbackError;
    }
    motionDebug.timings.modelLoadMs = performance.now() - started;
    motionDebug.modelState = "ready";
    if (!visionWorker) syncHandTracking();
    document.querySelector("#delegateStatus")!.textContent = motionDebug.fallbackError ? "CPU·GPU回退" : motionDebug.delegate;
    document.querySelector("#modelError")!.textContent = motionDebug.fallbackError ? `GPU回退：${motionDebug.fallbackError}` : "";
  } catch (error) {
    loaded?.close();
    if (!cameraSession.isCurrent(session) || !poseModelSession.isCurrent(modelGeneration)) throw new SessionCancelled();
    motionDebug.modelState = "error";
    motionDebug.lastDetectError = error instanceof Error ? error.message : String(error);
    document.querySelector("#delegateStatus")!.textContent = "模型错误";
    document.querySelector("#modelError")!.textContent = motionDebug.lastDetectError;
    throw error;
  } finally {
    if (cameraSession.isCurrent(session) && poseModelSession.isCurrent(modelGeneration)) document.querySelector("#loading")!.classList.add("hidden");
  }
}

function updateCameraButtons(): void { flipCameraButton.setAttribute("aria-label", facingMode === "user" ? "换成后置镜头" : "换成前置镜头"); }
async function refreshCameraDevices(current: () => boolean = () => true): Promise<void> { const devices = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === "videoinput"); if (!current()) return; cameraDevices = devices; const options = ["<option value=\"__auto__\">自动</option>", ...cameraDevices.map((item, index) => { const lower = item.label.toLowerCase(); const name = lower.includes("front") || lower.includes("user") || lower.includes("前") ? "前置" : lower.includes("back") || lower.includes("environment") || lower.includes("后") ? "后置" : item.label || `镜头 ${index + 1}`; return `<option value=\"${item.deviceId}\">${name}</option>`; })].join(""); cameraDeviceSelect.innerHTML = options; if (!cameraDevices.some((item) => item.deviceId === selectedCameraDeviceId)) selectedCameraDeviceId = "__auto__"; cameraDeviceSelect.value = selectedCameraDeviceId; }
type CameraRatioProfile = { width: number; height: number; ratio: number };
function cameraRatioProfiles(): CameraRatioProfile[] { return [{ width: 480, height: 854, ratio: 9 / 16 }, { width: 480, height: 640, ratio: 3 / 4 }]; }
async function startCamera(session = cameraSession.current): Promise<void> {
  cameraSession.assertCurrent(session);
  clearWebCamera();
  const sourceGeneration = cameraSource.current;
  const current = () => cameraSession.isCurrent(session) && cameraSource.isCurrent(sourceGeneration);
  const assertCurrent = () => { if (!current()) throw new SessionCancelled(); };
  const started = performance.now();
  let opened: MediaStream | null = null;
  try {
    await new Promise(resolve => setTimeout(resolve, 100)); assertCurrent();
    const source = selectedCameraDeviceId !== "__auto__" ? { deviceId: { exact: selectedCameraDeviceId } } : { facingMode: { ideal: facingMode } };
    for (const profile of cameraRatioProfiles()) {
      try {
        opened = await cameraSource.resolveResource(sourceGeneration, openWebStream({ audio: false, video: { ...source,
          width: { ideal: profile.width, max: profile.width }, height: { ideal: profile.height, max: profile.height },
          aspectRatio: { exact: profile.ratio }, frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS } } }), value => value.getTracks().forEach(track => track.stop()));
        assertCurrent(); break;
      } catch (error) { if (!current()) throw new SessionCancelled(); if (isSessionCancelled(error)) throw error; }
    }
    if (!opened) {
      opened = await cameraSource.resolveResource(sourceGeneration, openWebStream({ audio: false, video: { ...source, width: { ideal: 480 }, height: { ideal: 854 }, frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS } } }), value => value.getTracks().forEach(track => track.stop()));
      assertCurrent();
    }
    const track = opened.getVideoTracks()[0];
    if (!track) throw new Error("摄像头画面无效");
    try { await track.applyConstraints({ frameRate: { ideal: CAMERA_TARGET_FPS, max: CAMERA_TARGET_FPS } }); } catch { /* Provider may ignore frame-rate constraints. */ }
    assertCurrent();
    const settings = track.getSettings();
    if (settings.deviceId) selectedCameraDeviceId = settings.deviceId;
    if (settings.facingMode === "user" || settings.facingMode === "environment") facingMode = settings.facingMode;
    motionDebug.facingMode = facingMode; updateCameraButtons();
    stream = opened; video.style.display = "block"; video.srcObject = opened;
    await playVideo(); assertCurrent();
    if (!video.videoWidth || !video.videoHeight) throw new Error("摄像头画面无效");
    motionDebug.videoReady = video.readyState >= 2; motionDebug.videoWidth = video.videoWidth; motionDebug.videoHeight = video.videoHeight;
    await refreshCameraDevices(current); assertCurrent();
    motionDebug.timings.cameraOpenMs = performance.now() - started;
    resizeCanvas(); applyMirror(); startCameraFrameCounter(sourceGeneration);
    const failed = () => { if (current() && running && !document.hidden) void recoverCamera(session); };
    track.addEventListener("ended", failed);
    lastCameraFrameAt = performance.now();
    cameraHealthTimer = window.setInterval(() => {
      if (current() && running && !document.hidden && performance.now() - lastCameraFrameAt > 4000) failed();
    }, 1000);
    if (running) schedulePredict();
  } catch (error) {
    opened?.getTracks().forEach(track => track.stop());
    const ownedSource = current();
    if (current()) clearWebCamera();
    if (!ownedSource) throw new SessionCancelled();
    throw error;
  }
}

async function recoverCamera(session: number): Promise<void> {
  if (cameraRecoveryTask || !cameraSession.isCurrent(session) || !running || document.hidden) return;
  if (cameraRecoveryAttempts >= 2) {
    document.querySelector("#securityWarning")!.textContent = "摄像头暂停了，请确认未被占用后重新开始";
    await stop(); return;
  }
  cameraRecoveryAttempts++; motionDebug.cameraRecoveries = cameraRecoveryAttempts;
  cameraSwitchState.textContent = "正在恢复摄像头…";
  const task = (async () => {
    try { await startCamera(session); if (cameraSession.isCurrent(session)) cameraSwitchState.textContent = ""; }
    catch (error) {
      if (cameraSession.isCurrent(session) && !isSessionCancelled(error)) {
        document.querySelector("#securityWarning")!.textContent = "摄像头恢复失败，请确认未被占用后重新开始";
        await stop();
      }
    }
  })();
  cameraRecoveryTask = task;
  try { await task; } finally { if (cameraRecoveryTask === task) cameraRecoveryTask = null; }
}

async function start(): Promise<void> {
  if (cameraStartTask || running || activeRole !== "camera" || document.hidden) return;
  const intent = cameraSession.current;
  await cameraStopTask;
  if (!cameraSession.isCurrent(intent) || cameraStartTask || running || activeRole !== "camera" || document.hidden) return;
  const session = cameraSession.next();
  modelRecoveryAttempts = cameraRecoveryAttempts = 0; forceCpuDelegate = false;
  workerFailed = false; motionDebug.workerFallbackError = null; motionDebug.workerDroppedFrames = 0;
  motionDebug.modelRecoveries = motionDebug.cameraRecoveries = 0;
  setStartBusy("正在找电脑…"); setConnection("connecting");
  document.querySelector("#securityWarning")!.textContent = "";
  const task = (async () => {
    try {
      overlayRenderingEnabled = true; lastSendStateText = "";
      const picked = await pickServer(serverInput.value, phase => { if (cameraSession.isCurrent(session)) setStartBusy(phase); });
      cameraSession.assertCurrent(session);
      if (activeRole !== "camera" || document.hidden) throw new SessionCancelled();
      if (!picked.found) { await refreshLinkState(true); cameraSession.assertCurrent(session); throw new Error("没找到电脑"); }
      const socketUrl = picked.url; serverInput.value = socketUrl;
      try { localStorage.setItem("motionbridge-server", socketUrl); } catch { /* Storage is optional. */ }
      setStartBusy("正在打开摄像头…"); await startCamera(session); cameraSession.assertCurrent(session);
      running = true; setupCard.classList.add("hidden"); runtimeCard.classList.remove("hidden");
      hideStatus.setAttribute("aria-expanded", "true");
      showStatus.classList.add("hidden"); voiceControl.classList.remove("hidden"); document.querySelector("#guide")!.classList.remove("hidden"); syncScreen();
      connectSocket(socketUrl, session);
      await loadPoseModel(session); cameraSession.assertCurrent(session);
      const lock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null;
      if (!cameraSession.isCurrent(session)) { await lock?.release().catch(() => {}); throw new SessionCancelled(); }
      wakeLock = lock; schedulePredict();
    } catch (error) {
      if (cameraSession.isCurrent(session) && !isSessionCancelled(error)) { showStartError(error); await stop(); }
    } finally {
      if (cameraSession.isCurrent(session)) setStartBusy(null);
    }
  })();
  cameraStartTask = task;
  try { await task; } finally { if (cameraStartTask === task) cameraStartTask = null; }
}

function showStartError(error: unknown): void {
  const raw = error instanceof Error ? error.message : String(error);
  // 浏览器抛出来的话是英文的，而且常常带一条谷歌短链。原样弹给玩家等于没说。
  const hint = /permission|NotAllowed/i.test(raw) ? "摄像头没有授权，去系统设置里允许"
    : /NotFound|NotReadable|device/i.test(raw) ? "摄像头打不开，可能被别的应用占着"
    : /超时/.test(raw) ? "摄像头打开超时，重试一次"
    : /模型/.test(raw) ? raw
    : /没找到电脑/.test(raw) ? ""  // 上面的连接提示已经说了原因和办法
    : "启动失败，重试一次";
  document.querySelector("#securityWarning")!.textContent = hint;
  setupCard.classList.remove("hidden");
  runtimeCard.classList.add("hidden");
}
function startSocketHealth(ws: WebSocket, onTimeout: () => void, current: () => boolean): number {
  const liveness = new SocketLiveness(performance.now());
  ws.addEventListener("open", () => { if (current()) liveness.open(performance.now()); });
  ws.addEventListener("message", () => { if (current()) liveness.response(performance.now()); });
  return window.setInterval(() => {
    if (!current()) return;
    const action = liveness.check(performance.now());
    if (action === "timeout") onTimeout();
    else if (action === "ping" && ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) { onTimeout(); return; }
      try { ws.send(JSON.stringify({ type: "clock_sync", client_sent_ms: performance.now() })); }
      catch { onTimeout(); }
    }
  }, 250);
}

function connectSocket(url: string, session = cameraSession.current): void {
  if (!cameraSession.isCurrent(session) || !running) return;
  const connection = cameraSocketSession.next();
  if (reconnectTimer != null) window.clearTimeout(reconnectTimer); reconnectTimer = null;
  if (socketHealthTimer != null) window.clearInterval(socketHealthTimer); socketHealthTimer = null;
  const previous = socket; socket = null; previous?.close();
  setConnection("connecting");
  const ws = new WebSocket(url); socket = ws;
  const current = () => cameraSession.isCurrent(session) && cameraSocketSession.isCurrent(connection) && socket === ws && running;
  let failed = false;
  const disconnected = () => {
    if (!current() || failed) return;
    failed = true;
    if (socketHealthTimer != null) window.clearInterval(socketHealthTimer); socketHealthTimer = null;
    socket = null; ws.close();
    gameOutputEnabled = null; gameControlButton.disabled = true; gameControlButton.textContent = "重新连接中";
    setConnection("offline"); markControlConfigCached(); clearTriggerState();
    void stopVoiceControl(false);
    reconnectTimer = window.setTimeout(() => { reconnectTimer = null; void reconnectToBestServer(session, connection); }, 1500);
  };
  ws.addEventListener("open", () => {
    if (!current()) { ws.close(); return; }
    setConnection("online"); syncClock();
    if (voiceToggle.checked && !voiceEnabled) void startVoiceControl();
  });
  ws.addEventListener("close", disconnected);
  ws.addEventListener("error", disconnected);
  ws.addEventListener("message", event => { if (current()) handleCameraMessage(event); });
  socketHealthTimer = startSocketHealth(ws, disconnected, current);
}

function handleCameraMessage(event: MessageEvent): void { const received = performance.now(); let message: any; try { message = JSON.parse(event.data); } catch { return; } if (message.type === "control_config_v1") applyControlConfig(message); if (message.type === "trigger_state_v1") applyTriggerState(message); if (message.type === "game_output_state_v1") applyGameOutputState(message); if (message.type === "clock_sync") applyClockSync(message, received); if (message.type === "ack") { if (message.runtime_zones && typeof message.runtime_zones === "object") runtimeZones = message.runtime_zones; else runtimeZones = {}; lastServerPoseCount = Number(message.pose_count || 0); document.querySelector("#sendState")!.textContent = poseStatusText(Boolean(message.players?.some((player: any) => player.signals?.pose_visible))); } if (message.type === "voice_result" && voiceEnabled) { const text = String(message.final || message.partial || message.text || "").trim(); const command = String(message.command || message.result?.command || "").trim(); if (command) setVoiceStatus("listening", `已执行：${command}`); else if (text) setVoiceStatus("listening", `识别：${text.replace(/\s+/g, "")}`); else if (message.matched === false) setVoiceStatus("listening", "语音未匹配到电脑口令"); } if (message.type === "error") document.querySelector("#sendState")!.textContent = message.message || "数据错误"; if (message.type === "scene_snapshot_request") void sendSceneSnapshot(message); if (message.type === "scene_snapshot_result") { document.querySelector("#sendState")!.textContent = message.ok === false ? (message.message || "场景截图失败") : "场景截图已发送"; } }

async function reconnectToBestServer(session = cameraSession.current, connection = cameraSocketSession.current): Promise<void> {
  const current = () => cameraSession.isCurrent(session) && cameraSocketSession.isCurrent(connection) && running && !document.hidden;
  if (!current()) return;
  try {
    const picked = await pickServer(serverInput.value);
    if (!current()) return;
    if (picked.url) {
      serverInput.value = picked.url;
      if (picked.found) { try { localStorage.setItem("motionbridge-server", picked.url); } catch { /* Optional cache. */ } }
      connectSocket(picked.url, session);
      return;
    }
  } catch { /* A transient discovery failure must not end the retry loop. */ }
  if (current()) reconnectTimer = window.setTimeout(() => { reconnectTimer = null; void reconnectToBestServer(session, connection); }, 1500);
}

// 语音模型从连着的那台电脑取，走的是同一个设备口，只是把 ws:// 换成 http://。
function deviceHttpBase(): string {
  try {
    const parsed = new URL(serverInput.value);
    return `${parsed.protocol === "wss:" ? "https" : "http"}://${parsed.host}`;
  } catch {
    return "";
  }
}

function showWebUpdateLine(text: string): void {
  const line = document.querySelector<HTMLElement>("#webUpdateLine");
  if (!line || !text) return;
  line.textContent = text; line.hidden = false;
}

// 换上了新网页：功能更新弹一次说明，系统维护只在「更多设置」里留一句。
async function announceWebUpdate(): Promise<void> {
  let seen = "";
  try { seen = localStorage.getItem(SEEN_WEB_VERSION_KEY) ?? ""; } catch { /* 读不到就按新装算 */ }
  const remember = () => { try { localStorage.setItem(SEEN_WEB_VERSION_KEY, __WEB_VERSION__); } catch { /* 下次再记 */ } };
  if (seen && compareVersions(seen, __WEB_VERSION__) >= 0) return;
  // 头一回带着这个功能：APK 自带的网页就是 APK 那个版本，比它新说明是热更来的。
  if (!seen) seen = (await App.getInfo().then(info => info?.version ?? "").catch(() => "")) || __WEB_VERSION__;
  if (compareVersions(seen, __WEB_VERSION__) >= 0) { remember(); return; }
  showWebUpdateLine(`已更新到网页 ${__WEB_VERSION__}`);
  const releases = pendingReleases(await readReleaseNotes(), seen, __WEB_VERSION__);
  const overlay = document.querySelector<HTMLElement>("#releaseNotes");
  if (!releases.length || !overlay) { remember(); return; }
  document.querySelector<HTMLElement>("#releaseNotesTitle")!.textContent = `已更新到网页 ${__WEB_VERSION__}`;
  renderReleases(document.querySelector<HTMLElement>("#releaseNotesBody")!, releases);
  overlay.hidden = false;
  document.querySelector<HTMLButtonElement>("#releaseNotesOk")!.addEventListener("click", () => { overlay.hidden = true; remember(); }, { once: true });
}

// 一次连接只问一次。失败不拦任何事：APK 里那份永远是好的，照样能玩。
async function checkWebUpdate(): Promise<void> {
  const base = deviceHttpBase();
  if (!base || socket?.readyState !== WebSocket.OPEN) return;
  if (base !== webUpdateBase) { webUpdateBase = base; webUpdateChecked = false; }
  if (webUpdateChecked || webUpdateTask || webUpdateRetryTimer != null) return;
  const session = cameraSession.current;
  const task = (async () => {
    let retry = false;
    try {
      const result = await WebUpdate.sync({ baseUrl: base });
      if (webUpdateBase !== base || !cameraSession.isCurrent(session)) return;
      motionDebug.webUpdateState = result.state;
      showWebUpdateLine(webUpdateLine(result.state, result.message));
      webUpdateChecked = result.state !== "failed";
      retry = result.state === "failed";
    } catch { retry = Capacitor.isPluginAvailable("WebUpdate"); }
    if (retry && cameraSession.isCurrent(session)) webUpdateRetryTimer = window.setTimeout(() => {
      webUpdateRetryTimer = null; void checkWebUpdate();
    }, 30000);
  })();
  webUpdateTask = task;
  try { await task; } finally {
    if (webUpdateTask === task) {
      webUpdateTask = null;
      if (!cameraSession.isCurrent(session) && socket?.readyState === WebSocket.OPEN && !webUpdateChecked) void checkWebUpdate();
    }
  }
}

function applyClockSync(message: { client_sent_ms?: unknown; server_ms?: unknown }, received: number): void {
  const sent = Number(message.client_sent_ms); const server = Number(message.server_ms);
  const rtt = received - sent;
  if (!Number.isFinite(sent) || !Number.isFinite(server) || rtt < 0 || rtt > 8000) return;
  serverClockOffsetMs = server - (Date.now() - rtt / 2);
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
function resizeInferenceCanvas(): void { const sourceWidth = video.videoWidth; const sourceHeight = video.videoHeight; if (!sourceWidth || !sourceHeight) return; const { width, height } = inferenceSize(sourceWidth, sourceHeight, inferenceMaxSide); if (inferenceCanvas.width !== width || inferenceCanvas.height !== height) { inferenceCanvas.width = width; inferenceCanvas.height = height; } inferenceContext.drawImage(video, 0, 0, width, height); }
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
let handTrackingSides: HandSide[] = [];
let handLandmarker: HandLandmarker | null = null;
let handModelLoading = false;
const handCropCanvas = document.createElement("canvas");
handCropCanvas.width = HAND_CROP_SIDE;
handCropCanvas.height = HAND_CROP_SIDE;
const handCropContext = handCropCanvas.getContext("2d")!;

function syncHandTracking(): void {
  const request = syncedControlConfig?.hand_tracking;
  const requested = request?.hands ?? [request?.hand];
  handTrackingSides = request?.enabled ? [...new Set(requested.filter((hand): hand is HandSide => hand === "left" || hand === "right"))] : [];
  if (!handTrackingSides.length) { releaseHandModel(); return; }
  if (visionWorker) return;
  if (handLandmarker || handModelLoading || !running) return;
  void loadHandModel(cameraSession.current);
}
function releaseHandModel(): void {
  handModelSession.next(); handModelLoading = false;
  const model = handLandmarker; handLandmarker = null; model?.close();
}
async function loadHandModel(session: number): Promise<void> {
  const generation = handModelSession.next(); handModelLoading = true;
  let loaded: HandLandmarker | null = null;
  try {
    const files = await getVision();
    if (!cameraSession.isCurrent(session) || !handModelSession.isCurrent(generation) || !handTrackingSides.length) return;
    const options = (delegate: "GPU" | "CPU") => HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: new URL("./models/hand_landmarker.task", location.href).href, delegate },
      // Each crop changes position and size; IMAGE mode avoids stale VIDEO tracking.
      runningMode: "IMAGE", numHands: 1,
    });
    if (forceCpuDelegate) loaded = await options("CPU");
    else { try { loaded = await options("GPU"); } catch { loaded = await options("CPU"); } }
    if (!cameraSession.isCurrent(session) || !handModelSession.isCurrent(generation) || !handTrackingSides.length) { loaded.close(); return; }
    handLandmarker = loaded; loaded = null;
  } catch (error) {
    loaded?.close();
    if (cameraSession.isCurrent(session) && handModelSession.isCurrent(generation)) document.querySelector("#modelError")!.textContent = "手部模型暂不可用，身体识别仍可使用";
  } finally { if (handModelSession.isCurrent(generation)) handModelLoading = false; }
}

// 手掌在手腕之外，所以框心要沿着"手肘指向手腕"这个方向再往外推一点；框的大小
// 跟着前臂长度走，人离摄像头远近就不影响它。
function detectHand(points: NormalizedLandmark[], side: HandSide): PackedHand | null {
  if (!handLandmarker) return null;
  const box = handCropBox(points, side, inferenceCanvas.width, inferenceCanvas.height);
  if (!box) return null;
  handCropContext.drawImage(inferenceCanvas, box.sx, box.sy, box.side, box.side,
                            0, 0, HAND_CROP_SIDE, HAND_CROP_SIDE);
  return packHandCrop(handLandmarker.detect(handCropCanvas).landmarks[0], side, box, inferenceCanvas.width, inferenceCanvas.height);
}
// ==== 手部关节到此为止 =====================================================

function schedulePredict(): void {
  if (!running || cameraFrameLoop || predictAnimationFrame != null) return;
  const session = cameraSession.current;
  predictAnimationFrame = requestAnimationFrame(now => {
    predictAnimationFrame = null;
    if (!running || !cameraSession.isCurrent(session)) return;
    recordCameraFrame(now); predict(now);
  });
}
async function recoverModel(error: unknown): Promise<void> {
  if (modelRecoveryTask || !running) return;
  const session = cameraSession.current;
  const message = error instanceof Error ? error.message : String(error);
  if (modelRecoveryAttempts >= 2) {
    document.querySelector("#securityWarning")!.textContent = "模型连续出错，请重新开始";
    await stop(); return;
  }
  modelRecoveryAttempts++; motionDebug.modelRecoveries = modelRecoveryAttempts;
  forceCpuDelegate = true; motionDebug.fallbackError = message;
  const task = (async () => {
    try {
      releaseHandModel(); await loadPoseModel(session);
      if (cameraSession.isCurrent(session)) { syncHandTracking(); schedulePredict(); }
    } catch (recoveryError) {
      if (!cameraSession.isCurrent(session) || isSessionCancelled(recoveryError)) return;
      document.querySelector("#securityWarning")!.textContent = "模型恢复失败，请重新开始";
      await stop();
    }
  })();
  modelRecoveryTask = task;
  try { await task; } finally { if (modelRecoveryTask === task) modelRecoveryTask = null; }
}

function currentInferenceFrame(frame: CameraInferenceFrame): boolean {
  return running && cameraSession.isCurrent(frame.session) && cameraSource.isCurrent(frame.source)
    && poseModelSession.isCurrent(frame.model) && cameraSocketSession.isCurrent(frame.connection);
}
function inferenceFrame(now: number): CameraInferenceFrame {
  return { session: cameraSession.current, source: cameraSource.current, model: poseModelSession.current,
    connection: cameraSocketSession.current, timestampMs: now, capturedAtMs: lastCameraCapturedAtMs,
    startedAt: performance.now(), width: video.videoWidth, height: video.videoHeight,
    facing: facingMode, cameraId: selectedCameraDeviceId === "__auto__" ? "logical" : selectedCameraDeviceId,
    inferenceSide: inferenceMaxSide, captureMs: 0, captureMainMs: 0 };
}
async function captureWorkerFrame(worker: VisionWorkerClient<CameraInferenceFrame>, frame: CameraInferenceFrame): Promise<void> {
  const token = {}; workerCaptureToken = token;
  let bitmap: ImageBitmap | null = null;
  try {
    // Transfer a snapshot without resizing on the UI thread. The worker uses
    // the same 2D drawImage scaling as the original inference canvas.
    const pending = createImageBitmap(video);
    frame.captureMainMs = performance.now() - frame.startedAt;
    bitmap = await pending; frame.captureMs = performance.now() - frame.startedAt;
    if (!currentInferenceFrame(frame) || visionWorker !== worker) return;
    worker.submit({ bitmap, timestampMs: frame.timestampMs, capturedAtMs: frame.capturedAtMs, width: frame.width,
      height: frame.height, inferenceSide: frame.inferenceSide,
      hands: socket?.readyState === WebSocket.OPEN ? [...handTrackingSides] : [] }, frame);
    bitmap = null; motionDebug.workerDroppedFrames = worker.droppedFrames;
  } catch (error) {
    if (currentInferenceFrame(frame) && visionWorker === worker) {
      workerFailed = true; motionDebug.workerFallbackError = error instanceof Error ? error.message : String(error);
      void recoverModel(error);
    }
  } finally {
    bitmap?.close();
    if (workerCaptureToken === token) workerCaptureToken = null;
  }
}
function predict(now: number): void {
  if (!running) return;
  schedulePredict();
  if (inferenceBusy || (!poseLandmarker && !visionWorker) || motionDebug.modelState !== "ready"
      || video.readyState < 2 || video.currentTime === lastVideoTime || now - lastInferenceAt < currentInferenceIntervalMs()) return;
  if (visionWorker && workerCaptureToken) return;
  lastVideoTime = video.currentTime; lastInferenceAt = now;
  const frame = inferenceFrame(now);
  if (visionWorker) { void captureWorkerFrame(visionWorker, frame); return; }
  inferenceBusy = true;
  let stage: "copy" | "pose" | "hands" = "copy";
  try {
    resizeInferenceCanvas(); const copyMs = performance.now() - frame.startedAt;
    stage = "pose"; const poseStarted = performance.now();
    const poseResult = poseLandmarker!.detectForVideo(inferenceCanvas, now);
    const poseMs = performance.now() - poseStarted;
    stage = "hands"; const handsStarted = performance.now();
    const packedHands = poseResult.landmarks[0] && socket?.readyState === WebSocket.OPEN
      ? handTrackingSides.map(side => detectHand(poseResult.landmarks[0], side)).filter((hand): hand is PackedHand => hand !== null) : [];
    consumeVisionResult(frame, { type: "result", id: 0, landmarks: poseResult.landmarks, worldLandmarks: poseResult.worldLandmarks,
      hands: packedHands, timings: { copyMs, poseMs, handsMs: performance.now() - handsStarted, totalMs: performance.now() - frame.startedAt } }, copyMs, copyMs + poseMs + performance.now() - handsStarted);
  } catch (error) {
    motionDebug.lastDetectError = error instanceof Error ? error.message : String(error);
    document.querySelector("#sendState")!.textContent = `模型错误：${motionDebug.lastDetectError}`;
    if (stage === "pose" || stage === "hands") void recoverModel(error);
  } finally { inferenceBusy = false; }
}
function consumeVisionResult(frame: CameraInferenceFrame, result: VisionResult, copyMs: number, captureMainMs: number): void {
  if (!currentInferenceFrame(frame)) return;
  const mainStarted = performance.now();
  motionDebug.timings.copyMs = copyMs; motionDebug.timings.poseMs = result.timings.poseMs;
  motionDebug.timings.handsMs = result.timings.handsMs;
  motionDebug.timings.encodeMs = motionDebug.timings.frameToSendMs = 0;
  motionDebug.detectCalls++;
  const elapsed = copyMs + result.timings.poseMs + result.timings.handsMs;
  updateInferenceBudget(elapsed, performance.now()); motionDebug.lastInferenceMs = elapsed;
  motionDebug.lastPoseCount = result.landmarks.length; motionDebug.lastDetectError = null;
  if (result.handError) document.querySelector("#modelError")!.textContent = result.handError;
  const firstPose = result.landmarks[0];
  const overlayStarted = performance.now();
  if ((overlayRenderingEnabled || zoneOverlayEnabled) && overlayStarted - lastOverlayAt >= OVERLAY_INTERVAL_MS) {
    draw(result.landmarks, overlayRenderingEnabled); lastOverlayAt = overlayStarted;
  }
  motionDebug.timings.overlayMs = performance.now() - overlayStarted;
  const encodeStarted = performance.now();
  if (firstPose && socket?.readyState === WebSocket.OPEN) {
    const frameSequence = sequence++;
    if (socket.bufferedAmount <= MAX_SOCKET_BUFFERED_BYTES) {
      const worldPoints = packWorldPoints(result.worldLandmarks?.[0]);
      const payload: Record<string, unknown> = {
        type: "pose_features_v1", role: "camera", layout: POSE_LAYOUT, device_id: deviceId, sequence: frameSequence,
        captured_at_ms: frame.capturedAtMs + serverClockOffsetMs, sent_at_ms: Date.now() + serverClockOffsetMs,
        width: frame.width, height: frame.height, camera_facing: frame.facing, camera_id: frame.cameraId,
        preview_mirrored: frame.facing === "user", coordinates_mirrored: false,
        actual_model: modelChoice, voice_state: poseVoiceState(), delegate: motionDebug.delegate,
        inference_side: frame.inferenceSide, points: packControlLandmarks(firstPose), inference_ms: Math.round(elapsed * 10) / 10,
      };
      if (worldPoints.length === 33) payload.world_points = worldPoints;
      const hands = result.hands.filter(hand => handTrackingSides.includes(hand.handedness === "Left" ? "left" : "right"));
      if (hands.length) payload.hands = hands;
      const encoded = JSON.stringify(payload); motionDebug.timings.encodeMs = performance.now() - encodeStarted;
      motionDebug.timings.frameToSendMs = Math.max(0, Date.now() - frame.capturedAtMs); socket.send(encoded);
    } else motionDebug.networkDroppedFrames = ++networkDroppedFrames;
  }
  motionDebug.timings.totalMs = performance.now() - frame.startedAt;
  motionDebug.mainBusyMs = captureMainMs + performance.now() - mainStarted;
  motionDebug.timingSamples.push({ atMs: Date.now(), copyMs, poseMs: result.timings.poseMs, handsMs: result.timings.handsMs,
    overlayMs: motionDebug.timings.overlayMs, encodeMs: motionDebug.timings.encodeMs,
    frameToSendMs: motionDebug.timings.frameToSendMs, totalMs: motionDebug.timings.totalMs });
  if (motionDebug.timingSamples.length > 300) motionDebug.timingSamples.shift();
  const nextSendState = firstPose ? "人体已识别" : "等待完整人体";
  if (nextSendState !== lastSendStateText) {
    document.querySelector("#sendState")!.textContent = nextSendState; lastSendStateText = nextSendState;
    document.querySelector("#guide")!.classList.toggle("hidden", !!firstPose);
  }
  fpsCounter++;
  if (performance.now() - fpsStarted >= 1000) {
    document.querySelector("#localFps")!.textContent = `${Math.round(fpsCounter * 1000 / (performance.now() - fpsStarted))} FPS`;
    fpsCounter = 0; fpsStarted = performance.now();
  }
  if (performance.now() - lastClockSyncAt > 5000) syncClock();
}
function poseStatusText(playerLocked: boolean): string { if (lastServerPoseCount > 0) return playerLocked ? "已识别" : "人体已识别·动作模型准备中"; return "相机正常·未发现完整人体"; }
function draw(poses: NormalizedLandmark[][], showSkeleton = true): void { resizeCanvas(); context.clearRect(0, 0, canvas.width, canvas.height); drawingUtils ||= new DrawingUtils(context); const pose = poses[0]; if (showSkeleton && pose) { drawingUtils.drawConnectors(pose, PoseLandmarker.POSE_CONNECTIONS, { color: "#c8ff38", lineWidth: 2 * overlayCssPx }); drawingUtils.drawLandmarks(pose, { color: "#fff", fillColor: "#0b1014", radius: 2 * overlayCssPx }); } renderZoneOverlay(); }
function resizeCanvas(): void {
  const videoWidth = video.videoWidth || 960, videoHeight = video.videoHeight || 540;
  // 画面是 object-fit: contain 铺进整块屏幕的，这是它实际占的 CSS 像素比例。
  // 画布保持和摄像头同一比例，归一化坐标照旧能直接乘。
  const shown = Math.min(window.innerWidth / videoWidth, window.innerHeight / videoHeight) || 1;
  overlayCssPx = Math.min(window.devicePixelRatio || 1, OVERLAY_MAX_PIXEL_RATIO);
  const width = Math.round(videoWidth * shown * overlayCssPx), height = Math.round(videoHeight * shown * overlayCssPx);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
}
function recordCameraFrame(now: number, metadata?: VideoFrameCallbackMetadata): void {
  const mediaTime = metadata?.mediaTime ?? video.currentTime;
  if (video.readyState < 2 || mediaTime === lastCameraVideoTime) return;
  lastCameraVideoTime = mediaTime; lastCameraFrameAt = performance.now();
  const captureTime = (metadata as VideoFrameCallbackMetadata & { captureTime?: number } | undefined)?.captureTime;
  // Some providers expose captureTime; otherwise this measures frame arrival.
  const capturedAt = typeof captureTime === "number" && Number.isFinite(captureTime) && captureTime >= 0 && captureTime <= now ? captureTime : now;
  lastCameraCapturedAtMs = Date.now() - Math.max(0, performance.now() - capturedAt);
  cameraFrameCount++;
  if (now - cameraFpsStarted >= 1000) {
    document.querySelector("#cameraFps")!.textContent = `${Math.round(cameraFrameCount * 1000 / (now - cameraFpsStarted))} FPS`;
    cameraFrameCount = 0; cameraFpsStarted = now;
  }
}
function startCameraFrameCounter(sourceGeneration: number): void {
  cameraFrameLoop = typeof video.requestVideoFrameCallback === "function";
  cameraFrameCount = 0; cameraFpsStarted = performance.now(); lastCameraVideoTime = -1;
  if (!cameraFrameLoop) return;
  const frame = (now: number, metadata: VideoFrameCallbackMetadata) => {
    if (!cameraSource.isCurrent(sourceGeneration) || !cameraFrameLoop || !stream) return;
    cameraFrameCallback = null; recordCameraFrame(now, metadata);
    cameraFrameCallback = video.requestVideoFrameCallback(frame);
    if (running) predict(now);
  };
  cameraFrameCallback = video.requestVideoFrameCallback(frame);
}
function applyMirror(): void { document.querySelector<HTMLElement>("#cameraStage")?.classList.toggle("front-mirror", facingMode === "user"); }

// 复选框保存用户偏好；后台停止或启动报错只更新状态，不能把偏好改成关闭。
async function stopVoiceControl(showOff = true): Promise<void> {
  voiceSession.next(); voiceStartTask = null;
  voiceEnabled = false; activeVoicePhrases = "";
  const handles = [nativeVoiceTextListener, nativeVoiceStateListener, nativeAudioChunkListener, nativeAudioErrorListener];
  nativeVoiceTextListener = nativeVoiceStateListener = nativeAudioChunkListener = nativeAudioErrorListener = null;
  if (showOff) setVoiceStatus("off");
  const previousStop = voiceStopTask;
  const task = (async () => {
    await previousStop;
    await Promise.all(handles.map(handle => handle?.remove().catch(() => {})));
    await NativeAudio.stop().catch(() => {});
  })();
  voiceStopTask = task;
  try { await task; } finally { if (voiceStopTask === task) voiceStopTask = null; }
}

async function startVoiceControl(): Promise<void> {
  if (voiceStartTask) return voiceStartTask;
  if (voiceEnabled || activeRole !== "camera" || !running || !voiceToggle.checked || socket?.readyState !== WebSocket.OPEN) return;
  const generation = voiceSession.next();
  const session = cameraSession.current;
  const ws = socket;
  const remote = voiceRecognitionMode === "computer";
  const current = () => voiceSession.isCurrent(generation) && cameraSession.isCurrent(session) && activeRole === "camera"
    && running && !document.hidden && voiceToggle.checked && socket === ws && ws.readyState === WebSocket.OPEN;
  const assertCurrent = () => { if (!current()) throw new SessionCancelled(); };
  const handles: PluginListenerHandle[] = [];
  const listen = async (event: "voiceState" | "voiceText" | "audioChunk" | "audioError", callback: (value: any) => void) => {
    // Overloads share the same native event API; callbacks are guarded by the session.
    const handle = await (NativeAudio.addListener as (event: string, callback: (value: any) => void) => Promise<PluginListenerHandle>)(event, callback);
    handles.push(handle); assertCurrent(); return handle;
  };
  const task = (async () => {
    try {
      await voiceStopTask; await nativeVoiceStartBarrier; await nativeCapabilitiesReady; assertCurrent();
      setVoiceStatus("connecting", remote ? "准备电脑识别" : "准备手机语音模型");
      const phrases = voicePhrases(); const grammar = voiceGrammar();
      activeVoicePhrases = remote ? "" : [...phrases, ...grammar].join("\u0000");
      nativeVoiceStateListener = await listen("voiceState", event => {
        if (!current() || (!voiceEnabled && event.state !== "connecting")) return;
        const detail = event.message?.replace(/^Vosk\s+/, "手机语音") || (event.state === "command" ? "已识别命令" : "语音识别已就绪");
        setVoiceStatus(event.state === "connecting" ? "connecting" : "listening", detail);
      });
      nativeAudioErrorListener = await listen("audioError", event => {
        if (!current()) return;
        setVoiceStatus("error", event.message || "手机语音错误"); void stopVoiceControl(false);
      });
      if (remote) {
        nativeAudioChunkListener = await listen("audioChunk", event => {
          if (!current() || !voiceEnabled) return;
          const frameSequence = voiceSequence++; const audioBase64 = String(event.audio_base64 || "");
          if (!audioBase64 || ws.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) return;
          ws.send(JSON.stringify({ type: "voice_audio", role: "camera", device_id: deviceId, sequence: frameSequence,
            captured_at_ms: Number(event.captured_at_ms || Date.now()) + serverClockOffsetMs,
            sample_rate: Number(event.sample_rate || 16000), channels: Number(event.channels || 1), format: event.format || "pcm16le", audio_base64: audioBase64 }));
        });
      } else {
        nativeVoiceTextListener = await listen("voiceText", event => {
          const text = (event.text || "").trim();
          if (!current() || !voiceEnabled || !event.final || !text) return;
          setVoiceStatus("listening", `识别：${text.replace(/\s+/g, "")}`);
          ws.send(JSON.stringify({ type: "voice_text", role: "camera", device_id: deviceId, sequence: sequence++,
            captured_at_ms: Number(event.recognizedAtMs || Date.now()) + serverClockOffsetMs, text, confidence: event.confidence,
            final: true, source: "android_vosk_speech_service_v100" }));
        });
      }
      assertCurrent();
      const nativeStart = (async () => {
        const ready = await NativeAudio.start({ remote, phrases: phrases.length ? phrases : undefined,
          grammar: grammar.length ? grammar : undefined, baseUrl: deviceHttpBase() });
        if (!current() && !nativeCapabilities.audio_start_cancellation) {
          // Older APKs cannot cancel a download. Serialize replacement starts,
          // then close the late recorder before the next native session begins.
          await NativeAudio.stop().catch(() => {});
        }
        return ready;
      })();
      nativeVoiceStartBarrier = nativeStart.then(() => {}, () => {});
      const ready = await nativeStart; assertCurrent();
      if (remote ? !ready.audioReady : !ready.recognizerReady) throw new Error(remote ? "手机麦克风采集未就绪" : "手机语音模型错误");
      voiceEnabled = true; setVoiceStatus("listening", remote ? "电脑识别已就绪" : "手机识别已就绪");
    } catch (error) {
      if (!current() || isSessionCancelled(error)) {
        await Promise.all(handles.map(handle => handle.remove().catch(() => {}))); return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const denied = /未授权|permission|denied/i.test(message);
      await stopVoiceControl(false);
      // A subsequent start owns its own status, even if this cleanup finishes later.
      if (!voiceStartTask) setVoiceStatus(denied ? "unauthorized" : "error", denied ? "未授权" : message || "语音启动失败");
    }
  })();
  voiceStartTask = task;
  try { await task; } finally { if (voiceStartTask === task) voiceStartTask = null; }
}

async function stop(): Promise<void> {
  cameraSession.next(); cameraSocketSession.next(); poseModelSession.next();
  cameraStartTask = null;
  cameraRecoveryTask = modelRecoveryTask = null;
  running = false; setStartBusy(null);
  if (predictAnimationFrame != null) cancelAnimationFrame(predictAnimationFrame); predictAnimationFrame = null;
  if (reconnectTimer != null) window.clearTimeout(reconnectTimer); reconnectTimer = null;
  if (socketHealthTimer != null) window.clearInterval(socketHealthTimer); socketHealthTimer = null;
  if (webUpdateRetryTimer != null) window.clearTimeout(webUpdateRetryTimer); webUpdateRetryTimer = null;
  webUpdateChecked = false;
  const ws = socket; socket = null; ws?.close();
  gameOutputEnabled = null; gameControlButton.disabled = true;
  gameControlButton.textContent = "连接电脑中"; gameControlButton.classList.remove("enabled"); gameControlButton.title = "";
  triggerLast = null; triggerLastAt = 0; clearTriggerState(); markControlConfigCached();
  const model = poseLandmarker; poseLandmarker = null; model?.close();
  const worker = visionWorker; visionWorker = null; worker?.close(); workerCaptureToken = null;
  releaseHandModel(); handTrackingSides = []; clearWebCamera();
  motionDebug.videoReady = false; motionDebug.videoWidth = motionDebug.videoHeight = 0;
  motionDebug.modelState = "idle";
  motionDebug.inferenceBackend = "unknown";
  overlayRenderingEnabled = true; lastSendStateText = "";
  const lock = wakeLock; wakeLock = null;
  context.clearRect(0, 0, canvas.width, canvas.height);
  setupCard.classList.remove("hidden"); runtimeCard.classList.add("hidden"); showStatus.classList.add("hidden");
  document.querySelector("#guide")!.classList.add("hidden"); document.querySelector("#loading")!.classList.add("hidden");
  setConnection("offline"); syncScreen();
  const task = (async () => { await stopVoiceControl(); await lock?.release().catch(() => {}); await refreshLinkState(); })();
  cameraStopTask = task;
  try { await task; } finally { if (cameraStopTask === task) cameraStopTask = null; }
}
async function chooseCamera(cameraId: string): Promise<void> {
  if (cameraRecoveryTask) return;
  const session = cameraSession.current;
  selectedCameraDeviceId = cameraId; cameraDeviceSelect.value = cameraId;
  try { if (running) await startCamera(session); if (cameraSession.isCurrent(session)) applyMirror(); }
  catch (error) { if (!isSessionCancelled(error) && cameraSession.isCurrent(session)) cameraSwitchState.textContent = `切换失败：${error instanceof Error ? error.message : "无法打开镜头"}`; }
}
async function chooseFacing(target: "user" | "environment"): Promise<void> {
  if (!running || facingMode === target || cameraRecoveryTask) { updateCameraButtons(); return; }
  const session = cameraSession.current;
  const previousFacing = facingMode; const previousDevice = selectedCameraDeviceId;
  facingMode = target; selectedCameraDeviceId = "__auto__"; cameraDeviceSelect.value = "__auto__";
  cameraSwitchState.textContent = "切换中";
  try {
    await startCamera(session); cameraSession.assertCurrent(session); cameraSwitchState.textContent = "";
    try { localStorage.setItem("motionbridge-facing", facingMode); } catch { /* Optional preference. */ }
  } catch (error) {
    if (isSessionCancelled(error) || !cameraSession.isCurrent(session)) return;
    facingMode = previousFacing; selectedCameraDeviceId = previousDevice;
    cameraSwitchState.textContent = `切换失败：${error instanceof Error ? error.message : "无法打开镜头"}`;
    try { await startCamera(session); } catch (restoreError) { if (!isSessionCancelled(restoreError) && cameraSession.isCurrent(session)) cameraSwitchState.textContent += "；原镜头恢复失败"; }
    if (cameraSession.isCurrent(session)) updateCameraButtons();
  }
}

function showRole(role: "home" | "camera" | "handheld"): void { activeRole = role; document.body.dataset.role = role; roleCard.classList.toggle("hidden", role !== "home"); setupCard.classList.toggle("hidden", role !== "camera"); handheldCard.classList.toggle("hidden", role !== "handheld"); voiceControl.classList.toggle("hidden", role !== "camera");
  // 手柄模式下把页头藏起来。两个理由：卡片自己就有连接状态徽标，页头那个是重复的；
  // 而且两者都是固定定位，横屏时版本号折成两行会把页头撑高压到卡片上——标题整个
  // 被盖住，看着像渲染坏了。
  document.querySelector<HTMLElement>("header")?.classList.toggle("hidden", role === "handheld");
  renderControlConfig(); syncScreen(); }

// 屏幕跟着用法走。摄像头开着时整屏是画面，控件一律深色；其余页面跟随系统的白天 / 夜间，
// 状态栏图标的深浅也要跟着换，不然浅色页面上白图标就看不见了。
// 「倒过来」只管固定摄像头：立着放时充电口在下面会挡着，倒过来充电口就朝上。拿在手里
// 的手柄、鼠标不用它——陀螺仪按正着拿算方向。
const prefersLight = window.matchMedia("(prefers-color-scheme: light)");
let upsideDown = localStorage.getItem("motionbridge-upside-down") === "1";
let screenApplied = "";
function syncScreen(): void {
  const cameraLive = running && activeRole === "camera";
  document.body.classList.toggle("camera-live", cameraLive);
  const reverse = displayNative && activeRole === "camera" && upsideDown;
  const light = displayNative && !cameraLive && prefersLight.matches;
  upsideDownButton.setAttribute("aria-pressed", String(upsideDown));
  const next = `${reverse}|${light}`;
  if (next === screenApplied) return;
  screenApplied = next;
  void Display.setOrientation({ reverse }).catch(() => {});
  void Display.setBars({ light }).catch(() => {});
}
prefersLight.addEventListener("change", syncScreen);
syncScreen();

function controllerError(error: unknown): void {
  document.querySelector("#sensorState")!.textContent = Capacitor.isNativePlatform() ? (error instanceof Error ? error.message : "控制器异常") : "手持控制请使用安卓安装包";
}
/** 手柄每 16 毫秒发一帧，状态字大多数时候没变——没变就不碰，免得每帧重排版。 */
function setSensorState(text: string): void {
  const el = document.querySelector<HTMLElement>("#sensorState")!;
  if (el.textContent !== text) el.textContent = text;
}
function controllerBadge(online: boolean, text: string): void {
  handheldConnected = online;
  if (!online) {
    gameOutputEnabled = null;
    bluetoothOutputEnabled = false;
    handheldGameControlButton.disabled = true;
    handheldGameControlButton.textContent = "连接电脑中";
    handheldGameControlButton.classList.remove("enabled"); handheldGameControlButton.title = "";
  }
  document.querySelector("#handheldConnection")!.className = `badge ${online ? "online" : "connecting"}`;
  document.querySelector("#handheldConnection b")!.textContent = text;
  renderHandheldPrimaryAction();
  renderHandheldGameOutput();
}
function renderHandheldGameOutput(): void {
  const enabled = transportInput.value === "bluetooth" ? bluetoothOutputEnabled : gameOutputEnabled;
  handheldGameControlButton.disabled = !handheldConnected || controllerModeChanging || controllerSensorFault || enabled === null;
  handheldGameControlButton.textContent = !handheldConnected || enabled === null ? "连接电脑中" : enabled ? "暂停控制" : "开始控制";
  handheldGameControlButton.classList.toggle("enabled", handheldConnected && enabled === true);
}
function renderHandheldPrimaryAction(): void {
  const scan = document.querySelector<HTMLButtonElement>("#scanComputerHandheld")!;
  const center = document.querySelector<HTMLButtonElement>("#centerSensor")!;
  scan.hidden = handheldConnected;
  center.hidden = !handheldConnected;
  center.textContent = modeInput.value === "shooter" ? "校准" : "重新居中";
  center.setAttribute("aria-label", modeInput.value === "shooter" ? "校准陀螺仪" : "重新居中");
}
function renderControllerMode(): void {
  const shooter = modeInput.value === "shooter";
  const bluetooth = transportInput.value === "bluetooth";
  handheldGameControlButton.classList.remove("hidden");
  handheldCard.classList.toggle("shooter-mode", shooter);
  for (const button of modeButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === modeInput.value));
  handheldCard.classList.toggle("bluetooth-mode", bluetooth);
  document.querySelector("#shooterControls")!.classList.toggle("hidden", !shooter);
  document.querySelector("#shooterSettings")!.classList.toggle("hidden", !shooter);
  document.querySelector("#bluetoothPanel")!.classList.toggle("hidden", !bluetooth);
  document.querySelector("#handheldProfileSync")?.classList.toggle("hidden", bluetooth);
  document.querySelectorAll(".shoulders,.gamepad").forEach((el) => el.classList.toggle("hidden", shooter));
  handheldServerInput.closest("label")!.classList.toggle("hidden", bluetooth);
  renderHandheldPrimaryAction();
  renderHandheldGameOutput();
  document.querySelector<HTMLSelectElement>("#handheldSlot")!.closest("label")!.classList.toggle("hidden", bluetooth);
  document.querySelector<HTMLElement>("header")!.classList.toggle("hidden", activeRole === "handheld");
}
function applyBluetoothState(state: BluetoothState): void {
  if (activeRole !== "handheld" || transportInput.value !== "bluetooth") return;
  if (bluetoothState && state.sessionId < bluetoothState.sessionId) return;
  const changed = bluetoothState?.sessionId !== state.sessionId || bluetoothState?.connected !== state.connected;
  bluetoothState = state;
  if (changed) { clearTouches(); resetGyroSession(); tiltBaseline = null; }
  document.querySelector("#bluetoothStatus")!.textContent = state.message;
  controllerBadge(state.connected, state.connected ? `蓝牙已连接 ${state.deviceName || "电脑"}` : "等待蓝牙连接");
  const select = document.querySelector<HTMLSelectElement>("#bluetoothDevice")!;
  const saved = localStorage.getItem("motionbridge-bluetooth-host") || "";
  const previous = bluetoothSelectionPending ? select.value : select.value || saved;
  select.replaceChildren(new Option("请选择接收电脑", ""), ...state.devices.map((device) => new Option(device.name || device.address, device.address)));
  if (state.devices.some((device) => device.address === previous)) select.value = previous;
  document.querySelector<HTMLButtonElement>("#bluetoothConnect")!.disabled = !state.enabled || !state.registered
    || state.connected || state.connecting || bluetoothConnectGeneration === controllerGeneration || !select.value;
  document.querySelector<HTMLButtonElement>("#bluetoothPair")!.disabled = !state.registered;
  if (state.connected) document.querySelector<HTMLDetailsElement>("#bluetoothPanel")!.open = false;
  else if (state.enabled && state.registered && !state.devices.length) {
    document.querySelector("#bluetoothStatus")!.textContent = "请先在电脑蓝牙设置中添加这台手机，配对后点击刷新设备。";
  } else if (state.enabled && state.registered && saved && !state.devices.some((device) => device.address === saved)
      && !bluetoothSelectionPending) {
    document.querySelector("#bluetoothStatus")!.textContent = "上次选择的电脑尚未配对，请先在电脑重新配对，再刷新设备或选择另一台电脑。";
  }
  scheduleBluetoothReconnect();
}
function cancelBluetoothReconnect(): void {
  if (bluetoothReconnectTimer != null) window.clearTimeout(bluetoothReconnectTimer);
  bluetoothReconnectTimer = null;
}
function bluetoothControllerActive(): boolean {
  return activeRole === "handheld" && transportInput.value === "bluetooth"
    && controllerAppActive && !document.hidden && !bluetoothSystemDialog && (handheldRunning || controllerStarting);
}
function scheduleBluetoothReconnect(): void {
  const state = bluetoothState;
  if (state?.connected) bluetoothReconnectAttempt = 0;
  const address = localStorage.getItem("motionbridge-bluetooth-host") || "";
  if (!bluetoothControllerActive() || !state?.enabled || !state.registered || state.connected || state.connecting
      || bluetoothConnectGeneration === controllerGeneration || bluetoothSelectionPending
      || !address || !state.devices.some((device) => device.address === address)) {
    cancelBluetoothReconnect();
    return;
  }
  // 普通状态刷新不重置已排好的等待；失败越多，重试间隔越长。
  if (bluetoothReconnectTimer != null) return;
  const generation = controllerGeneration;
  const delay = Math.min(10000, 1000 * 2 ** Math.min(bluetoothReconnectAttempt, 4));
  document.querySelector("#bluetoothStatus")!.textContent = `${state.message} · ${delay / 1000} 秒后自动连接已选电脑`;
  bluetoothReconnectTimer = window.setTimeout(() => {
    bluetoothReconnectTimer = null;
    if (generation === controllerGeneration && !bluetoothSelectionPending
        && localStorage.getItem("motionbridge-bluetooth-host") === address) void connectBluetooth(address, true);
  }, delay);
}
async function connectBluetooth(address: string, automatic = false): Promise<void> {
  const generation = controllerGeneration;
  const state = bluetoothState;
  if (!bluetoothControllerActive() || !state?.enabled || !state.registered || state.connected || state.connecting
      || bluetoothConnectGeneration === generation || !state.devices.some((device) => device.address === address)) return;
  cancelBluetoothReconnect();
  bluetoothConnectGeneration = generation;
  if (automatic) bluetoothReconnectAttempt++;
  document.querySelector<HTMLButtonElement>("#bluetoothConnect")!.disabled = true;
  try {
    const connected = await BluetoothController.connect({ address });
    if (generation === controllerGeneration && bluetoothControllerActive()) applyBluetoothState(connected);
  } catch (error) {
    if (generation === controllerGeneration && bluetoothControllerActive()) controllerError(error);
  } finally {
    if (bluetoothConnectGeneration === generation) bluetoothConnectGeneration = -1;
    if (generation === controllerGeneration && bluetoothControllerActive() && bluetoothState) applyBluetoothState(bluetoothState);
  }
}
function sendNetworkMouse(dx: number, dy: number, buttons: number, sample?: SensorSample): boolean {
  const ws = handheldSocket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) { ws.close(); return false; }
  const sentAt = Date.now();
  try {
    ws.send(JSON.stringify({ type: "mouse_frame", role: "mouse", device_id: deviceId, sequence: handheldSequence++,
      captured_at_ms: sampleCapturedAt(sentAt, sample?.sample_age_ms ?? sample?.gyro_age_ms) + serverClockOffsetMs,
      sent_at_ms: sentAt + serverClockOffsetMs, dx, dy, buttons }));
    return true;
  } catch { ws.close(); return false; }
}
async function sendHandheldFrame(): Promise<void> {
  const bluetooth = transportInput.value === "bluetooth";
  const generation = controllerGeneration;
  const modeGeneration = controllerModeGeneration;
  if (document.hidden || bluetoothSystemDialog || controllerModeChanging
      || (sensorPollingGeneration?.controller === generation && sensorPollingGeneration.mode === modeGeneration)
      || handheldTimer == null || (bluetooth ? !bluetoothState?.connected : handheldSocket?.readyState !== WebSocket.OPEN)) return;
  const polling = { controller: generation, mode: modeGeneration };
  sensorPollingGeneration = polling;
  try {
    const sample = await SensorBridge.getLatest();
    if (generation !== controllerGeneration || modeGeneration !== controllerModeGeneration || handheldTimer == null) return;
    if (!sensorSampleFresh(sample, modeInput.value !== "shooter")) {
      if (!sensorStaleSince) {
        sensorStaleSince = performance.now();
        if (bluetooth) void BluetoothController.releaseAll().catch(() => {});
        else if (modeInput.value === "shooter") sendNetworkMouse(0, 0, 0);
      }
      setSensorState("等待有效体感采样，请保持手机前台");
      // A stalled native stream must not keep the network source alive with old data.
      if (!bluetooth && performance.now() - sensorStaleSince > 1500) handheldSocket?.close();
      return;
    }
    sensorStaleSince = 0;
    if (modeInput.value === "shooter") {
        const hasGravity = sample.accelerationIncludesGravity && optionalSensorFresh(sample.accelerationAvailable, sample.acceleration_age_ms);
        const hasRotation = sample.rotationAvailable && optionalSensorFresh(sample.rotationAvailable, sample.rotation_age_ms);
        const gyroSample = {
          ...sample,
          ax: hasGravity ? sample.ax : undefined,
          ay: hasGravity ? sample.ay : undefined,
          az: hasGravity ? sample.az : undefined,
          qx: hasRotation ? sample.qx : undefined,
          qy: hasRotation ? sample.qy : undefined,
          qz: hasRotation ? sample.qz : undefined,
          qw: hasRotation ? sample.qw : undefined,
        };
        const gyro = gyroMouse.update(gyroSample, !shooterState.stickPressed, {
          sensitivity: Number(document.querySelector<HTMLInputElement>("#gyroSensitivity")!.value),
          orientation: screen.orientation?.angle ?? 0,
        });
        if (!gyro.calibrating && (gyroCalibrationPending || !savedGyroCalibration)) {
          savedGyroCalibration = gyroMouse.getCalibration();
          gyroCalibrationPending = false;
          gyroCalibrationSaved = false;
          try { localStorage.setItem(gyroCalibrationKey, JSON.stringify(savedGyroCalibration)); gyroCalibrationSaved = true; }
          catch { /* 当前校准仍可使用。 */ }
        }
        const coarse = stickMouse.update(shooterState.stick, shooterState.stickPressed, performance.now(), Number(document.querySelector<HTMLInputElement>("#stickSensitivity")!.value));
        // 按实际握持反馈，两轴沿用陀螺仪计算方向。
        const dx = coarse.dx + gyro.dx, dy = coarse.dy + gyro.dy;
        const sent = bluetooth && bluetoothState?.connected
          ? !bluetoothOutputEnabled || (await BluetoothController.sendMouse({ buttons: shooterState.mouseButtons, dx, dy, sessionId: bluetoothState.sessionId })).sent
          : sendNetworkMouse(dx, dy, shooterState.mouseButtons, sample);
        if (generation !== controllerGeneration || modeGeneration !== controllerModeGeneration || handheldTimer == null) return;
        if (!sent && (!bluetooth || bluetoothOutputEnabled)) throw new Error("鼠标输出未送达，请检查连接");
        setSensorState(shooterState.stickPressed ? "摇杆大移动 · 陀螺仪暂停" : gyro.calibrating ? "请静握 1 秒，校准陀螺仪" : gyroCalibrationSaved ? "陀螺仪微调" : "陀螺仪微调 · 校准没存上，下次要重新校准");
    } else if (bluetooth && bluetoothState?.connected) {
        const sessionId = bluetoothState.sessionId;
        const quaternion = [sample.qx, sample.qy, sample.qz, sample.qw];
        if (!tiltBaseline || handheldRecenter) tiltBaseline = quaternion;
        const tilt = relativeTilt(tiltBaseline, quaternion);
        const result = !bluetoothOutputEnabled ? { sent: true } : await BluetoothController.sendGamepad({ buttons: bluetoothButtons(padState), x: stickState.x, y: stickState.y, ...tilt, lt: padState.has("zl") ? 1 : 0, rt: padState.has("zr") ? 1 : 0, sessionId });
        if (generation !== controllerGeneration || modeGeneration !== controllerModeGeneration || handheldTimer == null) return;
        if (!result.sent && bluetoothOutputEnabled) throw new Error("蓝牙手柄输出未送达，请检查连接");
        setSensorState("触摸控制左摇杆 · 转动控制右摇杆");
    } else if (!bluetooth && handheldSocket?.readyState === WebSocket.OPEN) {
      const frameSequence = handheldSequence++;
      if (handheldSocket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
        motionDebug.sensorDroppedFrames = ++sensorDroppedFrames;
        return;
      }
      const touches: Record<string, unknown>[] = [...padState].map((control) => ({ control, pressed: true }));
      if (Math.abs(stickState.x) > 0.02 || Math.abs(stickState.y) > 0.02) touches.push({ control: "stick", x: stickState.x, y: stickState.y });
      const sentAt = Date.now();
      handheldSocket.send(JSON.stringify({ type: "sensor_frame", role: "sensor", device_id: deviceId, sequence: frameSequence,
        captured_at_ms: sampleCapturedAt(sentAt, sample.sample_age_ms ?? sample.gyro_age_ms) + serverClockOffsetMs,
        sent_at_ms: sentAt + serverClockOffsetMs,
        player_slot: Number(document.querySelector<HTMLSelectElement>("#handheldSlot")!.value), quaternion: { x: sample.qx, y: sample.qy, z: sample.qz, w: sample.qw }, orientation: {}, rotation_rate: { x: sample.gx, y: sample.gy, z: sample.gz }, acceleration: { x: sample.ax, y: sample.ay, z: sample.az }, touches, recenter: handheldRecenter }));
      setSensorState("触摸控制左摇杆 · 转动控制右摇杆");
    }
    handheldRecenter = false;
    handheldFrames++;
    const now = performance.now();
    if (now - handheldFpsStarted >= 1000) { document.querySelector("#sensorFps")!.textContent = `${Math.round(handheldFrames * 1000 / (now - handheldFpsStarted))} 次/秒`; handheldFrames = 0; handheldFpsStarted = now; }
    if (bluetooth && !bluetoothOutputEnabled) setSensorState("已暂停控制");
  } catch (error) { if (generation === controllerGeneration && modeGeneration === controllerModeGeneration) controllerError(error); }
  finally { if (sensorPollingGeneration === polling) sensorPollingGeneration = null; }
}
function clearTouches(): void {
  padState.clear(); stickState = { x: 0, y: 0 }; shooterControls.reset(); stickMouse.reset();
  document.querySelector<HTMLElement>("#stick i")!.style.transform = "translate(0,0)";
  document.querySelectorAll("[data-pad]").forEach((element) => element.classList.remove("pressed"));
}
async function startHandheld(): Promise<void> {
  if (controllerStartTask) return controllerStartTask;
  controllerStartTask = startController();
  try { await controllerStartTask; } finally { controllerStartTask = null; }
}
async function startController(): Promise<void> {
  if (controllerStarting || handheldTimer != null) return;
  controllerStarting = true;
  modeInput.disabled = transportInput.disabled = true;
  const generation = ++controllerGeneration;
  controllerSensorFault = false;
  showRole("handheld"); renderControllerMode(); saveHandheldSettings(); resetGyroSession(); tiltBaseline = null;
  controllerBadge(false, transportInput.value === "bluetooth" ? "正在准备蓝牙" : "连接中");
  try {
    controllerSensorMode = modeInput.value;
    await SensorBridge.start({ mode: controllerSensorMode });
    if (generation !== controllerGeneration) return;
    wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null;
    if (generation !== controllerGeneration) return;
    if (transportInput.value === "bluetooth") {
      controllerBadge(false, "正在准备蓝牙");
      document.querySelector<HTMLDetailsElement>("#bluetoothPanel")!.open = true;
      document.querySelector<HTMLButtonElement>("#bluetoothPair")!.disabled = true;
      const listener = await BluetoothController.addListener("controllerState", (state) => {
        if (generation === controllerGeneration) applyBluetoothState(state);
      });
      if (generation !== controllerGeneration) { await listener.remove(); return; }
      bluetoothListener = listener;
      bluetoothSystemDialog = true;
      try {
        const state = await BluetoothController.start();
        if (generation === controllerGeneration) applyBluetoothState(state);
      } finally {
        if (generation === controllerGeneration) { bluetoothSystemDialog = false; scheduleBluetoothReconnect(); }
      }
    } else {
      const picked = await pickServer(handheldServerInput.value.trim() || serverInput.value.trim(), (phase) => { if (generation === controllerGeneration) setSensorState(phase); });
      if (generation !== controllerGeneration) return;
      if (!picked.found) throw new Error("没找到电脑");
      const address = picked.url; handheldServerInput.value = address;
      serverInput.value = address; localStorage.setItem("motionbridge-server", address);
      const ws = new WebSocket(normalizeSocketUrl(address)); handheldSocket = ws;
      ws.addEventListener("open", () => {
        if (generation !== controllerGeneration) return;
        controllerBadge(true, "已连接电脑"); document.querySelector("#sensorState")!.textContent = "自然持握 1 秒";
        window.setTimeout(() => { if (generation === controllerGeneration) handheldRecenter = true; }, 1000);
      });
      ws.addEventListener("message", (event) => {
        if (generation !== controllerGeneration) return;
        try { const message = JSON.parse(event.data); if (message.type === "control_config_v1") applyControlConfig(message); if (message.type === "trigger_state_v1") applyTriggerState(message); if (message.type === "game_output_state_v1") applyGameOutputState(message); if (message.type === "clock_sync") applyClockSync(message, performance.now()); if (message.type === "error") document.querySelector("#sensorState")!.textContent = message.message || "连接失败"; } catch { /* 忽略无法解析的消息 */ }
      });
      const disconnected = () => { if (generation === controllerGeneration && handheldSocket === ws) {
        handheldSocket = null;
        if (handheldHealthTimer != null) window.clearInterval(handheldHealthTimer); handheldHealthTimer = null;
        ws.close(); markControlConfigCached(); clearTouches(); controllerBadge(false, "电脑已断开");
        if (handheldRunning) window.setTimeout(() => {
          if (!handheldRunning || generation !== controllerGeneration) return;
          void (async () => {
            const retryGeneration = controllerGeneration + 1;
            await suspendHandheld();
            if (controllerGeneration !== retryGeneration || activeRole !== "handheld" || scannerAbort) return;
            if (rememberedComputer) computerReconnect.activate("handheld");
            else await startHandheld();
          })();
        }, 1500);
      } };
      ws.addEventListener("close", disconnected);
      ws.addEventListener("error", disconnected);
      handheldHealthTimer = startSocketHealth(ws, disconnected, () => generation === controllerGeneration && handheldSocket === ws);
    }
    if (generation === controllerGeneration) { handheldRunning = true; handheldTimer = window.setInterval(() => void sendHandheldFrame(), 16); }
  } catch (error) { if (generation === controllerGeneration) { controllerError(error); await SensorBridge.stop().catch(() => {}); } }
  finally { controllerStarting = false; modeInput.disabled = transportInput.disabled = false; }
}
async function suspendHandheld(): Promise<void> {
  handheldRunning = false;
  ++controllerGeneration;
  ++controllerModeGeneration;
  controllerModeChanging = false;
  cancelBluetoothReconnect();
  bluetoothReconnectAttempt = 0;
  bluetoothConnectGeneration = -1;
  bluetoothSystemDialog = false;
  if (handheldTimer != null) window.clearInterval(handheldTimer);
  handheldTimer = null;
  if (handheldHealthTimer != null) window.clearInterval(handheldHealthTimer); handheldHealthTimer = null;
  sensorStaleSince = 0;
  clearTouches(); resetGyroSession(); tiltBaseline = null;
  if (handheldSocket && handheldSocket.readyState <= WebSocket.OPEN) {
    // 断线由电脑收回该来源，尚未建立的连接也要取消。
    handheldSocket.close();
  }
  handheldSocket = null;
  controllerBadge(false, "未连接电脑");
  const listener = bluetoothListener; bluetoothListener = null;
  await listener?.remove().catch(() => {});
  await BluetoothController.releaseAll().catch(() => {});
  await BluetoothController.stop().catch(() => {});
  bluetoothState = null;
  await SensorBridge.stop().catch(() => {});
  await wakeLock?.release().catch(() => {}); wakeLock = null;
  document.querySelector("#sensorState")!.textContent = "已暂停";
}
async function stopHandheld(): Promise<void> { computerReconnect.cancel(); await suspendHandheld(); showRole("home"); document.querySelector<HTMLElement>("header")!.classList.remove("hidden"); setConnection("offline"); }
async function handleBackButton(): Promise<void> {
  connectionTouched = true;
  if (scannerAbort) { scannerAbort.abort(); return; }
  computerReconnect.cancel();
  if (activeRole === "home") { await App.exitApp(); return; }
  if (activeRole === "camera") { await stop(); showRole("home"); return; }
  await stopHandheld();
}

const computerReconnect = new ComputerReconnect(
  () => !document.hidden && controllerAppActive && !scannerAbort,
  role => role === "camera" ? running : handheldRunning,
  async (role, current) => {
    if (!current()) return;
    if (role === "camera") { showRole("camera"); await start(); }
    else if (transportInput.value === "network") {
      await controllerSuspendTask; await controllerStartTask;
      if (current()) await startHandheld();
    }
  },
);
function rememberRole(role: "camera" | "handheld"): void {
  if (!rememberedComputer || (role === "handheld" && transportInput.value !== "network")) return;
  rememberedComputer = { ...rememberedComputer, role }; saveComputer(rememberedComputer);
}
async function openComputerScanner(role: "camera" | "handheld"): Promise<void> {
  if (scannerAbort) return;
  const controller = new AbortController(); scannerAbort = controller;
  connectionTouched = true;
  const wasRunning = role === "camera" ? running || Boolean(cameraStartTask) : handheldRunning || Boolean(controllerStartTask);
  computerReconnect.cancel();
  let selected = false;
  try {
    if (role === "camera") { await stop(); await cameraStartTask; }
    else { await suspendHandheld(); await controllerStartTask; }
    if (controller.signal.aborted || document.hidden || !controllerAppActive) return;
    const { scanConnectionCode } = await import("./qr-scanner");
    const text = await scanConnectionCode(controller.signal);
    if (!text || controller.signal.aborted || document.hidden || !controllerAppActive) return;
    const computer = parseConnectionCode(text);
    if (role === "handheld") {
      transportInput.value = "network";
      saveHandheldSettings(); renderControllerMode();
      document.querySelector<HTMLDetailsElement>("#handheldMore")!.open = false;
    }
    rememberedComputer = { ...computer, role }; saveComputer(rememberedComputer);
    saveCandidates(computer.candidates);
    const first = computer.candidates[0];
    const address = normalizeSocketUrl(`${first.host}:${first.port}`);
    serverInput.value = handheldServerInput.value = address;
    try { localStorage.setItem("motionbridge-server", address); } catch { /* 本次仍可连接。 */ }
    selected = true;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const hint = /permission|NotAllowed/i.test(raw) ? "请在系统设置中允许摄像头扫码" : raw;
    document.querySelector(role === "camera" ? "#securityWarning" : "#sensorState")!.textContent = hint;
  } finally {
    if (scannerAbort === controller) scannerAbort = null;
    if (controller.signal.reason !== "unload" && activeRole === role && (selected || wasRunning)) {
      if (rememberedComputer && (role === "camera" || transportInput.value === "network")) computerReconnect.activate(role);
      else if (!document.hidden && controllerAppActive) { if (role === "camera") void start(); else void startHandheld(); }
      else if (role === "camera") resumeCameraOnReturn = true;
    }
  }
}
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
    text = "现在只有移动数据，连不到电脑。连上电脑所在的 Wi-Fi，或插数据线并打开「USB 网络共享」。";
    buttons.push({ label: "打开网络共享", which: "tether" }, { label: "连 WiFi", which: "wifi" });
  } else if (failed && !state.known) {
    text = "没找到电脑。手机和电脑要连同一个 Wi-Fi，或插数据线并打开「USB 网络共享」。";
    buttons.push({ label: "打开网络共享", which: "tether" }, { label: "连 WiFi", which: "wifi" });
  } else if (failed && state.usb) {
    text = "数据线已接通，但没找到电脑。确认电脑上 MotionControl 开着，摄像头来源选的是「手机摄像头」。";
  } else if (failed) {
    text = "这个 Wi-Fi 里没找到电脑，可能不在同一个路由器下。插数据线最省事。";
    buttons.push({ label: "换成数据线", which: "tether" });
  }
  if (failed) {
    // 自动找不到时最后一招：让人照着电脑屏幕填。但完整 IP 有十五个字符，错一个
    // 就白填一次——而手机已经知道自己在哪个网段了，真正缺的只有最后一段。
    const hint = lastOctetHint(state.links ?? []);
    if (hint && !serverInput.value.includes(hint.prefix)) {
      serverInput.value = hint.prefix;
      text += `\n也可以手填：在下面「更多设置」的电脑地址里补上最后一段（比如 ${hint.example}）。`;
      document.querySelector<HTMLDetailsElement>("#setupMore")!.open = true;
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
        line.textContent = "这台手机打不开那一页，请到系统设置里找「网络共享」或 Wi-Fi。";
      });
    });
    return button;
  }));
}

async function refreshLinkState(failed = false): Promise<void> {
  renderLinkState(await readLinkState(), failed);
}

renderControlConfig();
document.querySelector("#cameraRole")!.addEventListener("click", () => { connectionTouched = true; computerReconnect.cancel(); void (running ? stop() : Promise.resolve()).then(() => { showRole("camera"); rememberRole("camera"); void refreshLinkState(); return refreshCameraDevices(); }).catch((error) => { document.querySelector("#securityWarning")!.textContent = error instanceof Error ? error.message : String(error); }); });
document.querySelector("#handheldRole")!.addEventListener("click", () => { connectionTouched = true; computerReconnect.cancel(); void (running || voiceEnabled ? stop() : Promise.resolve()).then(() => { rememberRole("handheld"); if (rememberedComputer && transportInput.value === "network") computerReconnect.activate("handheld"); else return startHandheld(); }); });
const restartController = async () => { await suspendHandheld(); await controllerModeTask; await controllerStartTask; await startHandheld(); };
async function switchControllerMode(): Promise<void> {
  if (controllerModeTask) return;
  if (!handheldRunning || !handheldConnected) { await restartController(); return; }
  const generation = controllerGeneration;
  const previousMode = controllerSensorMode;
  const nextMode = modeInput.value;
  controllerModeChanging = true;
  ++controllerModeGeneration;
  modeInput.disabled = transportInput.disabled = true;
  renderControllerMode();
  controllerModeTask = (async () => {
    // 连接与输出开关不变，只释放旧输入并更新手机传感器模式。
    clearTouches(); resetGyroSession(); tiltBaseline = null; sensorStaleSince = 0;
    if (transportInput.value === "bluetooth") await BluetoothController.releaseAll();
    else if (previousMode === "shooter") sendNetworkMouse(0, 0, 0);
    else if (handheldSocket?.readyState === WebSocket.OPEN) {
      const sentAt = Date.now() + serverClockOffsetMs;
      handheldSocket.send(JSON.stringify({ type: "sensor_frame", role: "sensor", device_id: deviceId, sequence: handheldSequence++,
        captured_at_ms: sentAt, sent_at_ms: sentAt, player_slot: Number(document.querySelector<HTMLSelectElement>("#handheldSlot")!.value),
        quaternion: { x: 0, y: 0, z: 0, w: 1 }, orientation: {}, rotation_rate: { x: 0, y: 0, z: 0 },
        acceleration: { x: 0, y: 0, z: 0 }, touches: [], recenter: true }));
    }
    if (generation !== controllerGeneration) return;
    await SensorBridge.start({ mode: nextMode });
    if (generation !== controllerGeneration) return;
    controllerSensorMode = nextMode;
    saveHandheldSettings();
    controllerSensorFault = false;
    if (handheldTimer == null) handheldTimer = window.setInterval(() => void sendHandheldFrame(), 16);
    handheldRecenter = true;
    setSensorState(nextMode === "shooter" ? "陀螺仪微调" : "触摸控制左摇杆 · 转动控制右摇杆");
  })();
  try { await controllerModeTask; }
  catch (error) {
    if (generation === controllerGeneration) {
      // 新模式传感器启动失败时，恢复刚才已工作的模式，电脑连接不受影响。
      modeInput.value = previousMode; saveHandheldSettings();
      try {
        await SensorBridge.start({ mode: previousMode });
        if (generation !== controllerGeneration) return;
        controllerSensorMode = previousMode; controllerSensorFault = false;
        handheldRecenter = true;
      } catch {
        if (generation !== controllerGeneration) return;
        controllerSensorFault = true;
        if (handheldTimer != null) window.clearInterval(handheldTimer);
        handheldTimer = null;
      }
      controllerError(error);
    }
  }
  finally {
    controllerModeTask = null;
    if (generation === controllerGeneration) {
      controllerModeChanging = false;
      modeInput.disabled = transportInput.disabled = false;
      renderControllerMode();
    }
  }
}
modeInput.addEventListener("change", () => { void switchControllerMode(); });
transportInput.addEventListener("change", () => { computerReconnect.cancel(); rememberRole("handheld"); void restartController(); });
document.querySelector("#scanComputerCamera")!.addEventListener("click", () => void openComputerScanner("camera"));
document.querySelector("#scanComputerHandheld")!.addEventListener("click", () => void openComputerScanner("handheld"));
document.querySelector("#scanComputerHandheldMore")!.addEventListener("click", () => void openComputerScanner("handheld"));
const handheldMore = document.querySelector<HTMLDetailsElement>("#handheldMore")!;
document.querySelector("#handheldConnection")!.addEventListener("click", () => {
  handheldMore.open = true;
  handheldMore.querySelector<HTMLElement>("summary")?.focus?.();
  handheldMore.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
});
handheldMore.addEventListener("toggle", () => document.querySelector("#handheldConnection")!.setAttribute("aria-expanded", String(handheldMore.open)));
document.querySelector("#bluetoothRefresh")!.addEventListener("click", () => {
  const generation = controllerGeneration;
  void BluetoothController.getStatus().then((state) => { if (generation === controllerGeneration) applyBluetoothState(state); })
    .catch((error) => { if (generation === controllerGeneration) controllerError(error); });
});
document.querySelector("#bluetoothDevice")!.addEventListener("change", () => {
  bluetoothSelectionPending = document.querySelector<HTMLSelectElement>("#bluetoothDevice")!.value
    !== (localStorage.getItem("motionbridge-bluetooth-host") || "");
  if (bluetoothSelectionPending) cancelBluetoothReconnect();
  if (bluetoothState) applyBluetoothState(bluetoothState);
});
document.querySelector("#bluetoothPair")!.addEventListener("click", () => {
  void (async () => {
    const generation = controllerGeneration;
    cancelBluetoothReconnect();
    bluetoothSystemDialog = true;
    try {
      clearTouches(); await BluetoothController.requestDiscoverable();
      if (generation !== controllerGeneration) return;
      const state = await BluetoothController.getStatus();
      if (generation === controllerGeneration) applyBluetoothState(state);
    } catch (error) { if (generation === controllerGeneration) controllerError(error); }
    finally {
      if (generation === controllerGeneration) { bluetoothSystemDialog = false; scheduleBluetoothReconnect(); }
    }
  })();
});
document.querySelector("#bluetoothConnect")!.addEventListener("click", () => {
  const address = document.querySelector<HTMLSelectElement>("#bluetoothDevice")!.value;
  if (address) {
    localStorage.setItem("motionbridge-bluetooth-host", address);
    bluetoothSelectionPending = false; cancelBluetoothReconnect(); bluetoothReconnectAttempt = 0;
    void connectBluetooth(address);
  }
});
document.querySelector("#cameraHome")!.addEventListener("click", () => { computerReconnect.cancel(); void stop().then(() => showRole("home")); });
document.querySelector("#startButton")!.addEventListener("click", () => { rememberRole("camera"); if (rememberedComputer) computerReconnect.activate("camera"); else void start(); }); document.querySelector("#stopButton")!.addEventListener("click", () => { computerReconnect.cancel(); void stop(); });
gameControlButton.addEventListener("click", () => { if (gameOutputEnabled !== null) requestGameOutput(!gameOutputEnabled); });
handheldGameControlButton.addEventListener("click", () => {
  const enabled = transportInput.value === "bluetooth" ? bluetoothOutputEnabled : gameOutputEnabled;
  if (enabled !== null) requestGameOutput(!enabled);
});
function updateZoneToggle(): void {
  toggleZonesButton.setAttribute("aria-pressed", String(zoneOverlayEnabled));
  toggleZonesButton.classList.toggle("selected", zoneOverlayEnabled);
}
updateZoneToggle();
toggleZonesButton.addEventListener("click", () => {
  zoneOverlayEnabled = !zoneOverlayEnabled;
  localStorage.setItem("motionbridge-zone-overlay", zoneOverlayEnabled ? "1" : "0");
  updateZoneToggle();
  if (!zoneOverlayEnabled) context.clearRect(0, 0, canvas.width, canvas.height);
  lastOverlayAt = 0;
});
hideStatus.addEventListener("click", () => { runtimeCard.classList.add("hidden"); showStatus.classList.remove("hidden"); hideStatus.setAttribute("aria-expanded", "false"); overlayRenderingEnabled = false; });
showStatus.addEventListener("click", () => { if (!running) return; runtimeCard.classList.remove("hidden"); showStatus.classList.add("hidden"); hideStatus.setAttribute("aria-expanded", "true"); overlayRenderingEnabled = true; lastOverlayAt = 0; });
modelSelect.value = modelChoice;
modelSelect.addEventListener("change", () => { modelChoice = modelSelect.value === "lite" ? "lite" : "full"; localStorage.setItem("motionbridge-model", modelChoice); updateModelLabel(); });
cameraDeviceSelect.addEventListener("change", () => void chooseCamera(cameraDeviceSelect.value));
voiceRecognitionSelect.addEventListener("change", () => {
  voiceRecognitionMode = voiceRecognitionSelect.value === "phone" ? "phone" : "computer";
  localStorage.setItem("motionbridge-voice-recognition", voiceRecognitionMode);
  if (voiceEnabled || voiceStartTask) void (async () => { await stopVoiceControl(false); await startVoiceControl(); })();
});
flipCameraButton.addEventListener("click", () => void chooseFacing(facingMode === "user" ? "environment" : "user"));
upsideDownButton.addEventListener("click", () => {
  upsideDown = !upsideDown;
  try { localStorage.setItem("motionbridge-upside-down", upsideDown ? "1" : "0"); } catch { /* 存不下只影响下次打开 */ }
  syncScreen();
}); voiceToggle.addEventListener("change", () => { localStorage.setItem("motionbridge-voice-auto", voiceToggle.checked ? "1" : "0"); void (voiceToggle.checked ? startVoiceControl() : stopVoiceControl()); });
document.querySelector("#centerSensor")!.addEventListener("click", () => { if (!handheldConnected) return; handheldRecenter = true; gyroCalibrationPending = modeInput.value === "shooter"; gyroMouse.reset(); document.querySelector("#sensorState")!.textContent = modeInput.value === "shooter" ? "请静握 1 秒，校准陀螺仪" : "正在居中"; }); document.querySelector("#stopHandheld")!.addEventListener("click", () => void stopHandheld());
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
    computerReconnect.pause(); scannerAbort?.abort();
    cancelBluetoothReconnect();
    if ((running || cameraStartTask) && activeRole === "camera") {
      resumeCameraOnReturn = true;
      cameraSuspending = stop();
    } else if (voiceEnabled) {
      void stopVoiceControl(false);
    }
    if (activeRole === "handheld") {
      if (bluetoothSystemDialog) { clearTouches(); void BluetoothController.releaseAll().catch(() => {}); }
      else controllerSuspendTask = suspendHandheld();
    }
    return;
  }
  if (activeRole === "handheld" && handheldTimer == null && !bluetoothSystemDialog) void (async () => { await controllerSuspendTask; controllerSuspendTask = null; await controllerStartTask; if (activeRole === "handheld" && !document.hidden) await startHandheld(); })();
  else if (activeRole === "handheld") scheduleBluetoothReconnect();
  if (resumeCameraOnReturn && activeRole === "camera") {
    resumeCameraOnReturn = false;
    // 等进后台时那次停止真的走完再开。停止里有几步是异步的，要是回来得快，它的
    // 收尾（把界面切回设置页）会落在重新开始之后，界面就和实际状态对不上了。
    void (async () => {
      await cameraSuspending;
      cameraSuspending = null;
      if (!running && activeRole === "camera" && !document.hidden) await start();
    })();
  }
  if ((running || activeRole === "handheld") && !wakeLock) void navigator.wakeLock?.request("screen").then((lock) => { wakeLock = lock; }).catch(() => {});
  computerReconnect.resume();
}
document.addEventListener("visibilitychange", onVisibilityChange);
window.addEventListener("beforeunload", () => { computerReconnect.cancel(); scannerAbort?.abort("unload"); cancelBluetoothReconnect(); ++controllerGeneration; clearTouches(); void BluetoothController.releaseAll().catch(() => {}); void BluetoothController.stop().catch(() => {}); void stop(); });
void // 装的 APK 是一个版本，跑的网页可能是另一个。一半的修复走热更，APK 不会
// 跟着变，所以只报 APK 版本的话，"我这版有没有那个修复"就只能靠猜——而反馈
// 表单里恰好要填这个数。两个一样时只写一个，不一样才把网页那个也写出来。
void App.getInfo().then((info) => {
  const el = document.querySelector<HTMLElement>("#brandVersion");
  if (!el || !info?.version) return;
  el.textContent = info.version === __WEB_VERSION__
    ? info.version
    : `${info.version} · 网页 ${__WEB_VERSION__}`;
}).catch(() => { /* 浏览器里没有原生信息，维持网页版本就行 */ });
App.addListener("backButton", () => { void handleBackButton(); });
// 从系统设置页回来的时候再看一眼。上面那两个按钮把人送出去，
// 他在那边把开关打开再按返回——这一路全在 App 外面发生，不听一下的话
// 那行字会停在"两条路都没开"，而他刚刚照做了。
void App.addListener("appStateChange", ({ isActive }) => {
  controllerAppActive = isActive;
  if (!isActive) {
    computerReconnect.pause(); scannerAbort?.abort();
    if (activeRole === "handheld" && !bluetoothSystemDialog) controllerSuspendTask = suspendHandheld();
  }
  else computerReconnect.resume();
  if (!isActive) cancelBluetoothReconnect();
  else if (activeRole === "handheld") scheduleBluetoothReconnect();
  // Some WebViews delay visibilitychange; the native Activity is authoritative.
  if (!isActive && activeRole === "camera" && (running || cameraStartTask)) {
    resumeCameraOnReturn = true; cameraSuspending = stop();
  } else if (isActive && !document.hidden && resumeCameraOnReturn) onVisibilityChange();
  if (isActive && !running && activeRole === "camera") void refreshLinkState();
});

// A boot is healthy after controls and lifecycle listeners have initialized.
void nativeCapabilitiesReady.then(async () => {
  await WebUpdate.bootOk();
  if (!connectionTouched && activeRole === "home" && rememberedComputer?.role && !scannerAbort) {
    if (rememberedComputer.role === "camera" || transportInput.value === "network") {
      showRole(rememberedComputer.role); computerReconnect.activate(rememberedComputer.role);
    }
  }
  void announceWebUpdate();
}).catch(error => {
  if (Capacitor.isPluginAvailable("WebUpdate")) motionDebug.bootHealthError = error instanceof Error ? error.message : String(error);
});
