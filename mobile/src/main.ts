import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import "./style.css";

type ConnectionState = "offline" | "connecting" | "online" | "error";
type VoiceStatus = "off" | "connecting" | "listening" | "error" | "unauthorized";
type ModelGrade = "lite" | "full" | "heavy";
type NormalizedLandmark = { x: number; y: number; z: number; visibility?: number };
type GestureCache = unknown[];
type SensorSample = { qx: number; qy: number; qz: number; qw: number; gx: number; gy: number; gz: number; ax: number; ay: number; az: number; timestamp: number; running: boolean };

type NativeCameraDescriptor = { cameraId: string; facing: "front" | "back"; available?: boolean };
type NativePose = { detection_id: string | null; pose: NormalizedLandmark[]; world_pose: NormalizedLandmark[] | null };
type NativePoseFrame = {
  capturedAtMs: number; cameraId: string; facing: "front" | "back"; width: number; height: number;
  inferenceWidth: number; inferenceHeight: number; previewMirrored: boolean; coordinatesMirrored: false;
  actualModel: ModelGrade; inferenceMs: number; captureFps: number; previewFps: number; inferenceFps: number;
  poseCount: number; poses: NativePose[]; hands: GestureCache;
};
type NativeCameraApi = {
  discoverCameras(options?: { force?: boolean }): Promise<{ cameras: NativeCameraDescriptor[] }>;
  startCamera(options: { cameraId: string; model: ModelGrade; inference?: boolean }): Promise<{ cameraId: string; facing: "front" | "back"; width: number; height: number; previewMirrored: boolean; actualModel: ModelGrade }>;
  enableInference(options: { model: ModelGrade }): Promise<void>;
  setDisplayMode(options: { role: "home" | "camera" | "handheld" }): Promise<void>;
  stopCamera(): Promise<void>;
  checkPermissions(): Promise<{ camera: string }>;
  requestPermissions(): Promise<{ camera: string }>;
  addListener(eventName: "poseResult", listener: (frame: NativePoseFrame) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "cameraError", listener: (event: { message: string }) => void): Promise<PluginListenerHandle>;
};
type NativeAudioApi = {
  start(): Promise<{ sampleRate: number; channels: number; format: string; source: string; recognizerReady: boolean }>;
  stop(): Promise<void>;
  addListener(eventName: "voiceText", listener: (event: { text: string; confidence?: number; final: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "audioError", listener: (event: { message: string }) => void): Promise<PluginListenerHandle>;
};

const NativeCamera = registerPlugin<NativeCameraApi>("NativeCamera");
const NativeAudio = registerPlugin<NativeAudioApi>("NativeAudio");
const SensorBridge = registerPlugin<{ start(): Promise<void>; getLatest(): Promise<SensorSample>; stop(): Promise<void> }>("SensorBridge");
const nativeCameraEnabled = Capacitor.isNativePlatform();
const POSE_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19], [12, 14],
  [14, 16], [16, 18], [16, 20], [16, 22], [18, 20], [11, 23], [12, 24], [23, 24],
  [23, 25], [24, 26], [25, 27], [26, 28], [27, 29], [28, 30], [27, 31], [28, 32], [29, 31], [30, 32],
];

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <canvas id="overlay"></canvas><div class="shade"></div>
  <header><div><p>MOTIONBRIDGE 0.7.5</p><h1 id="pageTitle">体感控制</h1></div><div id="connectionBadge" class="badge"><i></i><b>未连接电脑</b></div></header>
  <main>
    <section class="setup-card role-card" id="roleCard"><h2>选择角色</h2><div class="role-grid"><button id="cameraRole">摄像头</button><button id="handheldRole">手持手柄</button></div></section>
    <section class="setup-card hidden" id="setupCard">
      <div class="card-head"><h2>摄像头</h2><button id="cameraHome" class="text-button">返回首页</button></div>
      <label>电脑服务器地址<input id="serverUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑地址:8765/ws/input"></label>
      <label>镜头<select id="cameraDeviceSelect"><option value="__auto__">自动</option></select></label>
      <div class="actions"><button id="startButton">开始识别</button></div><p class="warning" id="securityWarning"></p>
    </section>
    <section class="runtime-card hidden" id="runtimeCard">
      <div class="runtime-state"><strong id="sendState">等待完整人体</strong><small>识别状态</small></div>
      <label class="runtime-select">镜头<select id="runtimeCameraDevice"><option value="__auto__">自动</option></select></label>
      <div class="runtime-metrics"><span>相机 <b id="cameraFps">0</b></span><span>识别 <b id="localFps">0</b></span></div><button id="stopButton" class="stop">停止识别</button>
    </section>
    <section class="handheld-card hidden" id="handheldCard">
      <div class="handheld-top handheld-connection-row"><span id="handheldConnection" class="badge"><i></i><b>未连接电脑</b></span><label>电脑服务器地址<input id="handheldServerUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑地址:8765/ws/input"></label></div>
      <div class="handheld-top"><label>绑定玩家<select id="handheldSlot"><option value="0">玩家一</option><option value="1">玩家二</option></select></label><span><b id="sensorFps">0 FPS</b><small id="sensorState">等待传感器</small></span><button id="centerSensor">重新居中</button><button id="stopHandheld" class="stop">停止手柄</button></div>
      <div class="shoulders"><button data-pad="l">LB</button><button data-pad="zl">LT</button><button data-pad="zr">RT</button><button data-pad="r">RB</button></div><div class="gamepad"><div id="stick" class="stick"><i></i></div><div class="middle-buttons"><button data-pad="select">选择</button><button data-pad="start">开始</button></div><div class="face-buttons"><button data-pad="y">Y</button><button data-pad="x">X</button><button data-pad="b">B</button><button data-pad="a">A</button></div></div>
    </section>
  </main>
  <div class="voice-control hidden" id="voiceControl"><label><input id="voiceToggle" type="checkbox">语音控制</label><span id="voiceState">关闭</span></div>
  <div class="guide hidden" id="guide"></div><div class="loading hidden" id="loading"><i></i><b id="loadingText">正在打开摄像头</b></div>`;

const canvas = document.querySelector<HTMLCanvasElement>("#overlay")!;
const context = canvas.getContext("2d")!;
const serverInput = document.querySelector<HTMLInputElement>("#serverUrl")!;
const handheldServerInput = document.querySelector<HTMLInputElement>("#handheldServerUrl")!;
const cameraDeviceSelect = document.querySelector<HTMLSelectElement>("#cameraDeviceSelect")!;
const runtimeCameraDevice = document.querySelector<HTMLSelectElement>("#runtimeCameraDevice")!;
const roleCard = document.querySelector<HTMLElement>("#roleCard")!;
const setupCard = document.querySelector<HTMLElement>("#setupCard")!;
const runtimeCard = document.querySelector<HTMLElement>("#runtimeCard")!;
const handheldCard = document.querySelector<HTMLElement>("#handheldCard")!;
const badge = document.querySelector<HTMLElement>("#connectionBadge")!;
const voiceControl = document.querySelector<HTMLElement>("#voiceControl")!;
const voiceToggle = document.querySelector<HTMLInputElement>("#voiceToggle")!;
const voiceStateLabel = document.querySelector<HTMLElement>("#voiceState")!;

let activeRole: "home" | "camera" | "handheld" = "home";
let activeNativeCamera = false;
let running = false;
let cameraSwitching = false;
let facingMode: "user" | "environment" = "environment";
let selectedCameraDeviceId = "__auto__";
let activeNativeCameraId = "";
let nativeCameras: NativeCameraDescriptor[] = [];
let nativeFrameWidth = 1280;
let nativeFrameHeight = 720;
let currentModel: ModelGrade = "full";
let socket: WebSocket | null = null;
let handheldSocket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let handheldTimer: number | null = null;
let wakeLock: WakeLockSentinel | null = null;
let nativeVoiceTextListener: PluginListenerHandle | null = null;
let nativeAudioErrorListener: PluginListenerHandle | null = null;
let voiceEnabled = false;
let voiceState: VoiceStatus = "off";
let lastVoiceText = "";
let sequence = 0;
let handheldSequence = 0;
let handheldRecenter = false;
let handheldFrames = 0;
let handheldFpsStarted = performance.now();
let sensorPolling = false;
let stickState = { x: 0, y: 0 };
let serverClockOffsetMs = 0;
let lastClockSyncAt = 0;
let lastNativePoseCount = 0;
let lastServerPoseCount = 0;
const padState = new Set<string>();

function setNativePreview(active: boolean): void { document.documentElement.classList.toggle("native-preview", active); document.body.classList.toggle("native-preview", active); }
function getDeviceId(): string { let value = localStorage.getItem("motionbridge-device-id"); if (!value) { value = `camera-${crypto.randomUUID()}`; localStorage.setItem("motionbridge-device-id", value); } return value; }
const deviceId = getDeviceId();
function normalizeSocketUrl(value: string, path = "/ws/input"): string { const trimmed = value.trim().replace(/\/$/, ""); const parsed = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`); parsed.protocol = ["https:", "wss:"].includes(parsed.protocol) ? "wss:" : "ws:"; parsed.pathname = path; parsed.search = ""; parsed.hash = ""; return parsed.href; }
function getSuggestedServer(): string { const parameter = new URLSearchParams(location.search).get("server"); if (parameter) return normalizeSocketUrl(parameter); if (location.hostname && location.hostname !== "localhost") return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/input`; return ""; }
serverInput.value = localStorage.getItem("motionbridge-server") || getSuggestedServer(); handheldServerInput.value = localStorage.getItem("motionbridge-server") || getSuggestedServer();
handheldServerInput.addEventListener("change", () => { const value = handheldServerInput.value.trim(); if (value) { serverInput.value = value; localStorage.setItem("motionbridge-server", value); } });
function setConnection(state: ConnectionState): void { badge.className = `badge ${state}`; badge.querySelector("b")!.textContent = ({ offline: "未连接电脑", connecting: "连接中", online: "已连接电脑", error: "连接异常" })[state]; }
function setVoiceStatus(status: VoiceStatus, detail?: string): void { voiceState = status; voiceStateLabel.textContent = detail || ({ off: "关闭", connecting: "连接中", listening: "正在听", error: "错误", unauthorized: "未授权" })[status]; voiceStateLabel.className = `voice-state ${status}`; }
function poseVoiceState(): "not_connected" | "connected" | "enabled" | "unauthorized" | "failed" { return voiceState === "off" ? "not_connected" : voiceState === "connecting" ? "connected" : voiceState === "listening" ? "enabled" : voiceState === "unauthorized" ? "unauthorized" : "failed"; }
function setNativeCameraState(facing: "front" | "back", cameraId: string): void { facingMode = facing === "front" ? "user" : "environment"; activeNativeCameraId = cameraId; selectedCameraDeviceId = cameraId; cameraDeviceSelect.value = cameraId; runtimeCameraDevice.value = cameraId; canvas.style.transform = facingMode === "user" ? "scaleX(-1)" : "scaleX(1)"; }

async function refreshCameraDevices(): Promise<void> {
  if (!nativeCameraEnabled) { nativeCameras = []; cameraDeviceSelect.innerHTML = "<option value=\"\">请使用 Android 应用</option>"; runtimeCameraDevice.innerHTML = cameraDeviceSelect.innerHTML; throw new Error("请使用 Android 应用使用摄像头"); }
  let permission = await NativeCamera.checkPermissions(); if (permission.camera !== "granted") permission = await NativeCamera.requestPermissions(); if (permission.camera !== "granted") throw new Error("相机未授权");
  const result = await NativeCamera.discoverCameras({ force: false }); nativeCameras = (result.cameras || []).filter((item) => item.available !== false && (item.facing === "front" || item.facing === "back"));
  const options = ["<option value=\"__auto__\">自动</option>", ...nativeCameras.map((item) => `<option value=\"${item.cameraId}\">${item.facing === "front" ? "前置" : "后置"}</option>`)].join(""); cameraDeviceSelect.innerHTML = options; runtimeCameraDevice.innerHTML = options;
  if (!nativeCameras.some((item) => item.cameraId === selectedCameraDeviceId)) selectedCameraDeviceId = "__auto__"; cameraDeviceSelect.value = selectedCameraDeviceId; runtimeCameraDevice.value = selectedCameraDeviceId;
}
function preferredCamera(): NativeCameraDescriptor | undefined { if (selectedCameraDeviceId !== "__auto__") return nativeCameras.find((item) => item.cameraId === selectedCameraDeviceId); return nativeCameras.find((item) => item.facing === "back") || nativeCameras[0]; }
function nativeCameraOperational(): boolean { return nativeCameraEnabled; }
async function startCamera(): Promise<void> {
  if (!nativeCameraOperational()) throw new Error("请使用 Android 应用使用摄像头"); if (!nativeCameras.length) await refreshCameraDevices(); const descriptor = preferredCamera(); if (!descriptor) throw new Error("没有可用摄像头"); setNativePreview(true);
  const state = await NativeCamera.startCamera({ cameraId: descriptor.cameraId, model: currentModel, inference: true }); activeNativeCamera = true; nativeFrameWidth = state.width || nativeFrameWidth; nativeFrameHeight = state.height || nativeFrameHeight; currentModel = state.actualModel || currentModel; setNativeCameraState(state.facing, state.cameraId); resizeCanvas();
}
async function startFramingPreview(): Promise<void> { if (!nativeCameraOperational()) return; if (!nativeCameras.length) await refreshCameraDevices(); const descriptor = preferredCamera(); if (!descriptor) throw new Error("没有可用摄像头"); setNativePreview(true); const state = await NativeCamera.startCamera({ cameraId: descriptor.cameraId, model: "lite", inference: false }); activeNativeCamera = true; nativeFrameWidth = state.width || nativeFrameWidth; nativeFrameHeight = state.height || nativeFrameHeight; setNativeCameraState(state.facing, state.cameraId); resizeCanvas(); }
async function start(): Promise<void> {
  try { const socketUrl = normalizeSocketUrl(serverInput.value); serverInput.value = socketUrl; localStorage.setItem("motionbridge-server", socketUrl); setConnection("connecting"); if (!activeNativeCamera) await startCamera(); await NativeCamera.enableInference({ model: currentModel }); running = true; activeRole = "camera"; setupCard.classList.add("hidden"); runtimeCard.classList.remove("hidden"); document.querySelector("#guide")!.classList.remove("hidden"); connectSocket(socketUrl); wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; } catch (error) { setConnection("error"); alert(error instanceof Error ? error.message : String(error)); await stop(); }
}
function connectSocket(url: string): void {
  if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); setConnection("connecting"); socket = new WebSocket(url);
  socket.addEventListener("open", () => { setConnection("online"); if (voiceEnabled) setVoiceStatus("listening", "正在听"); syncClock(); });
  socket.addEventListener("close", () => { setConnection("offline"); if (voiceEnabled) void stopVoiceControl(); if (running) reconnectTimer = window.setTimeout(() => connectSocket(url), 1500); }); socket.addEventListener("error", () => setConnection("error"));
  socket.addEventListener("message", (event) => { const received = performance.now(); let message: any; try { message = JSON.parse(event.data); } catch { return; } if (message.type === "clock_sync") { const sent = Number(message.client_sent_ms); serverClockOffsetMs = Number(message.server_ms) - (Date.now() - (received - sent) / 2); } if (message.type === "ack") { lastServerPoseCount = Number(message.pose_count || 0); document.querySelector("#sendState")!.textContent = poseStatusText(Boolean(message.players?.some((player: any) => player.signals?.pose_visible))); } if (message.type === "error") document.querySelector("#sendState")!.textContent = message.message || "数据错误"; });
}
function syncClock(): void { if (socket?.readyState !== WebSocket.OPEN) return; lastClockSyncAt = performance.now(); socket.send(JSON.stringify({ type: "clock_sync", client_sent_ms: lastClockSyncAt })); }

function handleNativePoseFrame(frame: NativePoseFrame): void {
  if (!running) return; nativeFrameWidth = frame.width || nativeFrameWidth; nativeFrameHeight = frame.height || nativeFrameHeight; currentModel = frame.actualModel; setNativeCameraState(frame.facing, frame.cameraId); lastNativePoseCount = frame.poseCount ?? frame.poses.length; draw(frame.poses.map((item) => item.pose));
  document.querySelector<HTMLElement>("#cameraFps")!.textContent = String(Math.round(frame.previewFps || frame.captureFps || 0)); document.querySelector<HTMLElement>("#localFps")!.textContent = String(Math.round(frame.inferenceFps || 0)); document.querySelector("#sendState")!.textContent = poseStatusText(false);
  if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256000) socket.send(JSON.stringify({ type: "pose_frame_v2", role: "camera", device_id: deviceId, sequence: sequence++, captured_at_ms: frame.capturedAtMs + serverClockOffsetMs, sent_at_ms: Date.now() + serverClockOffsetMs, width: frame.width, height: frame.height, camera_facing: frame.facing === "front" ? "user" : "environment", camera_id: frame.cameraId, orientation_degrees: 0, preview_mirrored: frame.previewMirrored, coordinates_mirrored: false, actual_model: frame.actualModel, voice_state: poseVoiceState(), poses: frame.poses, hands: frame.hands, inference_ms: frame.inferenceMs }));
  if (performance.now() - lastClockSyncAt > 5000) syncClock();
}
function poseStatusText(playerLocked: boolean): string { if (lastNativePoseCount > 0 || lastServerPoseCount > 0) return playerLocked ? "已识别" : "人体已识别·动作模型准备中"; return "相机正常·未发现完整人体"; }
function draw(poses: NormalizedLandmark[][]): void { resizeCanvas(); context.clearRect(0, 0, canvas.width, canvas.height); const colors = ["#c8ff38", "#ff8bd8"]; poses.forEach((pose, index) => { context.strokeStyle = colors[index] || colors[0]; context.lineWidth = 3; context.beginPath(); for (const [from, to] of POSE_CONNECTIONS) { const a = pose[from]; const b = pose[to]; if (!a || !b) continue; context.moveTo(a.x * canvas.width, a.y * canvas.height); context.lineTo(b.x * canvas.width, b.y * canvas.height); } context.stroke(); context.fillStyle = "#fff"; for (const point of pose) { context.beginPath(); context.arc(point.x * canvas.width, point.y * canvas.height, 3, 0, Math.PI * 2); context.fill(); } }); }
function resizeCanvas(): void { const width = nativeFrameWidth || 1280; const height = nativeFrameHeight || 720; if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; } }

async function stopVoiceControl(showOff = true): Promise<void> { voiceEnabled = false; await nativeVoiceTextListener?.remove().catch(() => {}); await nativeAudioErrorListener?.remove().catch(() => {}); nativeVoiceTextListener = null; nativeAudioErrorListener = null; lastVoiceText = ""; await NativeAudio.stop().catch(() => {}); if (showOff) { voiceToggle.checked = false; setVoiceStatus("off"); } }
async function startVoiceControl(): Promise<void> {
  if (activeRole !== "camera") { voiceToggle.checked = false; setVoiceStatus("error", "仅摄像头可用"); return; } if (voiceEnabled) return; setVoiceStatus("connecting");
  try { const ready = await NativeAudio.start(); if (!ready.recognizerReady) throw new Error("语音模型错误"); voiceEnabled = true; nativeVoiceTextListener = await NativeAudio.addListener("voiceText", (event) => { if (!event.text) return; lastVoiceText = event.text; setVoiceStatus("listening", event.text); if (event.final && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256000) { const frame: Record<string, unknown> = { type: "voice_text", role: "camera", device_id: deviceId, sequence: sequence++, captured_at_ms: Date.now() + serverClockOffsetMs, text: event.text }; if (event.confidence != null) frame.confidence = event.confidence; socket.send(JSON.stringify(frame)); } }); nativeAudioErrorListener = await NativeAudio.addListener("audioError", (event) => { setVoiceStatus("error", event.message || "语音错误"); void stopVoiceControl(false); }); setVoiceStatus("listening", socket?.readyState === WebSocket.OPEN ? "正在听" : "未连接电脑"); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); const denied = /未授权|permission|denied/i.test(message); await stopVoiceControl(false); voiceToggle.checked = false; setVoiceStatus(denied ? "unauthorized" : "error", denied ? "未授权" : /模型|model|recognizer|vosk/i.test(message) ? "模型错误" : message || "错误"); }
}
async function stop(): Promise<void> { running = false; if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); socket = null; if (nativeCameraEnabled) await NativeCamera.stopCamera().catch(() => {}); activeNativeCamera = false; activeNativeCameraId = ""; setNativePreview(false); await stopVoiceControl(); await wakeLock?.release().catch(() => {}); wakeLock = null; context.clearRect(0, 0, canvas.width, canvas.height); setupCard.classList.remove("hidden"); runtimeCard.classList.add("hidden"); document.querySelector("#guide")!.classList.add("hidden"); setConnection("offline"); }
async function chooseCamera(cameraId: string): Promise<void> { if (cameraSwitching) return; cameraSwitching = true; const previous = selectedCameraDeviceId; try { selectedCameraDeviceId = cameraId; const descriptor = preferredCamera(); if (descriptor) facingMode = descriptor.facing === "front" ? "user" : "environment"; cameraDeviceSelect.value = cameraId; runtimeCameraDevice.value = cameraId; if (running) await startCamera(); else if (activeNativeCamera) await startFramingPreview(); } catch (error) { selectedCameraDeviceId = previous; cameraDeviceSelect.value = previous; runtimeCameraDevice.value = previous; document.querySelector("#securityWarning")!.textContent = error instanceof Error ? error.message : String(error); } finally { cameraSwitching = false; } }
async function flipCamera(): Promise<void> { const desired = facingMode === "environment" ? "front" : "back"; const descriptor = nativeCameras.find((item) => item.facing === desired); if (descriptor) await chooseCamera(descriptor.cameraId); }
function showRole(role: "home" | "camera" | "handheld"): void { activeRole = role; if (role !== "camera" && !activeNativeCamera) setNativePreview(false); roleCard.classList.toggle("hidden", role !== "home"); setupCard.classList.toggle("hidden", role !== "camera"); handheldCard.classList.toggle("hidden", role !== "handheld"); voiceControl.classList.toggle("hidden", role !== "camera"); document.querySelector("#pageTitle")!.textContent = role === "handheld" ? "手持手柄" : role === "camera" ? "摄像头" : "体感控制"; }

async function sendHandheldFrame(): Promise<void> { if (sensorPolling || handheldSocket?.readyState !== WebSocket.OPEN) return; sensorPolling = true; try { const sample = await SensorBridge.getLatest(); const touches: Record<string, unknown>[] = [...padState].map((control) => ({ control, pressed: true })); if (Math.abs(stickState.x) > 0.02 || Math.abs(stickState.y) > 0.02) touches.push({ control: "stick", x: stickState.x, y: stickState.y }); handheldSocket.send(JSON.stringify({ type: "sensor_frame", role: "sensor", device_id: deviceId, sequence: handheldSequence++, captured_at_ms: Date.now(), player_slot: Number(document.querySelector<HTMLSelectElement>("#handheldSlot")!.value), quaternion: { x: sample.qx, y: sample.qy, z: sample.qz, w: sample.qw }, orientation: {}, rotation_rate: { x: sample.gx, y: sample.gy, z: sample.gz }, acceleration: { x: sample.ax, y: sample.ay, z: sample.az }, touches, recenter: handheldRecenter })); if (handheldRecenter) { handheldRecenter = false; document.querySelector("#sensorState")!.textContent = "已居中"; } handheldFrames++; const now = performance.now(); if (now - handheldFpsStarted >= 1000) { document.querySelector("#sensorFps")!.textContent = `${Math.round(handheldFrames * 1000 / (now - handheldFpsStarted))} FPS`; handheldFrames = 0; handheldFpsStarted = now; } } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器异常"; } finally { sensorPolling = false; } }
function clearTouches(): void { padState.clear(); stickState = { x: 0, y: 0 }; document.querySelector<HTMLElement>("#stick i")!.style.transform = "translate(0,0)"; document.querySelectorAll("[data-pad]").forEach((element) => element.classList.remove("pressed")); void sendHandheldFrame(); }
async function startHandheld(): Promise<void> { showRole("handheld"); try { await SensorBridge.start(); wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; const address = handheldServerInput.value.trim() || serverInput.value.trim(); if (!address) throw new Error("请填写电脑服务器地址"); serverInput.value = address; localStorage.setItem("motionbridge-server", address); handheldSocket = new WebSocket(normalizeSocketUrl(address)); handheldSocket.addEventListener("open", () => { document.querySelector("#handheldConnection")!.className = "badge online"; document.querySelector("#handheldConnection b")!.textContent = "已连接电脑"; document.querySelector("#sensorState")!.textContent = "自然持握 1 秒"; window.setTimeout(() => { handheldRecenter = true; }, 1000); }); handheldSocket.addEventListener("message", (event) => { try { const message = JSON.parse(event.data); if (message.type === "error") document.querySelector("#sensorState")!.textContent = message.message || "连接失败"; } catch { /* ignore malformed bridge messages */ } }); handheldSocket.addEventListener("close", () => { clearTouches(); document.querySelector("#handheldConnection")!.className = "badge error"; document.querySelector("#handheldConnection b")!.textContent = "电脑已断开"; }); handheldTimer = window.setInterval(() => void sendHandheldFrame(), 16); } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器不可用"; } }
async function stopHandheld(): Promise<void> { clearTouches(); if (handheldTimer != null) window.clearInterval(handheldTimer); handheldTimer = null; await new Promise((resolve) => setTimeout(resolve, 35)); handheldSocket?.close(); handheldSocket = null; await SensorBridge.stop().catch(() => {}); await wakeLock?.release().catch(() => {}); wakeLock = null; await NativeCamera.setDisplayMode({ role: "home" }).catch(() => {}); showRole("home"); setConnection("offline"); }
async function suspendHandheld(): Promise<void> { clearTouches(); if (handheldTimer != null) window.clearInterval(handheldTimer); handheldTimer = null; await new Promise((resolve) => setTimeout(resolve, 35)); handheldSocket?.close(); handheldSocket = null; await SensorBridge.stop().catch(() => {}); document.querySelector("#sensorState")!.textContent = "已暂停"; }
function updateStick(event: PointerEvent): void { const stick = document.querySelector<HTMLElement>("#stick")!; const rect = stick.getBoundingClientRect(); const x = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.38))); const y = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height * 0.38))); stickState = { x, y }; stick.querySelector<HTMLElement>("i")!.style.transform = `translate(${x * 34}px,${y * 34}px)`; }

document.querySelector("#cameraRole")!.addEventListener("click", () => { void NativeCamera.setDisplayMode({ role: "camera" }).catch(() => {}).then(() => { showRole("camera"); return refreshCameraDevices(); }).then(() => startFramingPreview()).catch((error) => { document.querySelector("#securityWarning")!.textContent = error instanceof Error ? error.message : String(error); }); });
document.querySelector("#handheldRole")!.addEventListener("click", () => { void (running || activeNativeCamera || voiceEnabled ? stop() : Promise.resolve()).then(() => NativeCamera.setDisplayMode({ role: "handheld" }).catch(() => {})).then(() => startHandheld()); });
document.querySelector("#cameraHome")!.addEventListener("click", () => { void stop().then(() => NativeCamera.setDisplayMode({ role: "home" }).catch(() => {})).then(() => showRole("home")); });
document.querySelector("#startButton")!.addEventListener("click", () => void start()); document.querySelector("#stopButton")!.addEventListener("click", () => void stop());
for (const select of [cameraDeviceSelect, runtimeCameraDevice]) select.addEventListener("change", () => void chooseCamera(select.value));
document.querySelector("#runtimeFlip")?.addEventListener("click", () => void flipCamera()); voiceToggle.addEventListener("change", () => void (voiceToggle.checked ? startVoiceControl() : stopVoiceControl()));
document.querySelector("#centerSensor")!.addEventListener("click", () => { handheldRecenter = true; document.querySelector("#sensorState")!.textContent = "正在居中"; }); document.querySelector("#stopHandheld")!.addEventListener("click", () => void stopHandheld());
document.querySelectorAll<HTMLElement>("[data-pad]").forEach((button) => { button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); padState.add(button.dataset.pad!); button.classList.add("pressed"); }); const release = () => { padState.delete(button.dataset.pad!); button.classList.remove("pressed"); }; button.addEventListener("pointerup", release); button.addEventListener("pointercancel", release); button.addEventListener("lostpointercapture", release); });
const stick = document.querySelector<HTMLElement>("#stick")!; stick.addEventListener("pointerdown", (event) => { stick.setPointerCapture(event.pointerId); updateStick(event); }); stick.addEventListener("pointermove", (event) => { if (stick.hasPointerCapture(event.pointerId)) updateStick(event); }); const releaseStick = () => { stickState = { x: 0, y: 0 }; stick.querySelector<HTMLElement>("i")!.style.transform = "translate(0,0)"; }; stick.addEventListener("pointerup", releaseStick); stick.addEventListener("pointercancel", releaseStick);
window.addEventListener("resize", resizeCanvas);
document.addEventListener("visibilitychange", () => { if (document.hidden && voiceEnabled) void stopVoiceControl(); if (document.hidden && activeRole === "handheld") void suspendHandheld(); if (document.visibilityState === "visible" && activeRole === "handheld" && handheldTimer == null) void startHandheld(); if (document.visibilityState === "visible" && (running || activeRole === "handheld") && !wakeLock) void navigator.wakeLock?.request("screen").then((lock) => { wakeLock = lock; }).catch(() => {}); });
window.addEventListener("beforeunload", () => { clearTouches(); void stopVoiceControl(); });
if (nativeCameraEnabled) { void NativeCamera.addListener("poseResult", handleNativePoseFrame); void NativeCamera.addListener("cameraError", (event) => { document.querySelector("#sendState")!.textContent = event.message; activeNativeCamera = false; setNativePreview(false); if (running) void NativeCamera.stopCamera().catch(() => {}); }); }
if (nativeCameraEnabled) void NativeCamera.setDisplayMode({ role: "home" }).catch(() => {});
if ("serviceWorker" in navigator && location.protocol !== "file:") void navigator.serviceWorker.register("./sw.js").catch(() => {});
