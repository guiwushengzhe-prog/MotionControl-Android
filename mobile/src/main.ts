import { DrawingUtils, FilesetResolver, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import "./style.css";

type ConnectionState = "offline" | "connecting" | "online" | "error";
type VoiceStatus = "off" | "connecting" | "listening" | "error" | "unauthorized";
type ModelGrade = "lite" | "full" | "heavy";
type PrecisionMode = "auto" | ModelGrade;
type SensorSample = { qx: number; qy: number; qz: number; qw: number; gx: number; gy: number; gz: number; ax: number; ay: number; az: number; timestamp: number; running: boolean };
type NativeAudioApi = {
  start(): Promise<{ sampleRate: number; channels: number; format: string; source: string; recognizerReady: boolean }>;
  stop(): Promise<void>;
  addListener(eventName: "voiceText", listener: (event: { text: string; confidence?: number; final: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "audioError", listener: (event: { message: string }) => void): Promise<PluginListenerHandle>;
};
const NativeAudio = registerPlugin<NativeAudioApi>("NativeAudio");
const SensorBridge = registerPlugin<{ start(): Promise<void>; getLatest(): Promise<SensorSample>; stop(): Promise<void> }>("SensorBridge");

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div id="cameraStage"><video id="camera" autoplay playsinline muted></video><canvas id="overlay"></canvas><div class="shade"></div></div>
  <header><div><p>MOTIONBRIDGE 0.7.5</p><h1 id="pageTitle">体感控制</h1></div><div id="connectionBadge" class="badge"><i></i><b>未连接电脑</b></div></header>
  <main>
    <section class="setup-card role-card" id="roleCard"><h2>选择角色</h2><div class="role-grid"><button id="cameraRole">摄像头</button><button id="handheldRole">手持手柄</button></div></section>
    <section class="setup-card hidden" id="setupCard">
      <div class="card-head"><h2>摄像头</h2><button id="cameraHome" class="text-button">返回首页</button></div>
      <label>电脑服务器地址<input id="serverUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑地址:8765/ws/input"></label>
      <label>镜头<select id="cameraDeviceSelect"><option value="__auto__">自动</option></select></label>
      <label>识别精度<select id="precisionSelect"><option value="auto">自动</option><option value="lite">流畅</option><option value="full">均衡</option><option value="heavy">精确</option></select></label>
      <div class="actions"><button id="startButton">开始识别</button></div><p class="warning" id="securityWarning"></p>
    </section>
    <section class="runtime-card hidden" id="runtimeCard">
      <div class="runtime-state"><strong id="sendState">等待完整人体</strong><small>识别状态</small></div>
      <label class="runtime-select">镜头<select id="runtimeCameraDevice"><option value="__auto__">自动</option></select></label>
      <label class="runtime-select">识别精度<select id="runtimePrecision"><option value="auto">自动</option><option value="lite">流畅</option><option value="full">均衡</option><option value="heavy">精确</option></select></label>
      <div class="runtime-metrics"><span>相机 <b id="cameraFps">0</b></span><span>识别 <b id="localFps">0</b></span><span>模型 <b id="modelGrade">—</b></span></div>
      <button id="runtimeFlip" class="text-button">切换镜头</button><button id="stopButton" class="stop">停止识别</button>
    </section>
    <section class="handheld-card hidden" id="handheldCard">
      <div class="handheld-top handheld-connection-row"><span id="handheldConnection" class="badge"><i></i><b>未连接电脑</b></span><label>电脑服务器地址<input id="handheldServerUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑地址:8765/ws/input"></label></div>
      <div class="handheld-top"><label>绑定玩家<select id="handheldSlot"><option value="0">玩家一</option><option value="1">玩家二</option></select></label><span><b id="sensorFps">0 FPS</b><small id="sensorState">等待传感器</small></span><button id="centerSensor">重新居中</button><button id="stopHandheld" class="stop">停止手柄</button></div>
      <div class="shoulders"><button data-pad="l">LB</button><button data-pad="zl">LT</button><button data-pad="zr">RT</button><button data-pad="r">RB</button></div><div class="gamepad"><div id="stick" class="stick"><i></i></div><div class="middle-buttons"><button data-pad="select">选择</button><button data-pad="start">开始</button></div><div class="face-buttons"><button data-pad="y">Y</button><button data-pad="x">X</button><button data-pad="b">B</button><button data-pad="a">A</button></div></div>
    </section>
  </main>
  <div class="voice-control hidden" id="voiceControl"><label><input id="voiceToggle" type="checkbox">语音控制</label><span id="voiceState">关闭</span></div>
  <div class="guide hidden" id="guide"></div><div class="loading hidden" id="loading"><i></i><b id="loadingText">正在打开摄像头</b></div>`;

const video = document.querySelector<HTMLVideoElement>("#camera")!;
const canvas = document.querySelector<HTMLCanvasElement>("#overlay")!;
const context = canvas.getContext("2d")!;
const serverInput = document.querySelector<HTMLInputElement>("#serverUrl")!;
const handheldServerInput = document.querySelector<HTMLInputElement>("#handheldServerUrl")!;
const cameraDeviceSelect = document.querySelector<HTMLSelectElement>("#cameraDeviceSelect")!;
const runtimeCameraDevice = document.querySelector<HTMLSelectElement>("#runtimeCameraDevice")!;
const precisionSelect = document.querySelector<HTMLSelectElement>("#precisionSelect")!;
const runtimePrecision = document.querySelector<HTMLSelectElement>("#runtimePrecision")!;
const roleCard = document.querySelector<HTMLElement>("#roleCard")!;
const setupCard = document.querySelector<HTMLElement>("#setupCard")!;
const runtimeCard = document.querySelector<HTMLElement>("#runtimeCard")!;
const handheldCard = document.querySelector<HTMLElement>("#handheldCard")!;
const badge = document.querySelector<HTMLElement>("#connectionBadge")!;
const voiceControl = document.querySelector<HTMLElement>("#voiceControl")!;
const voiceToggle = document.querySelector<HTMLInputElement>("#voiceToggle")!;
const voiceStateLabel = document.querySelector<HTMLElement>("#voiceState")!;

let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let poseLandmarker: PoseLandmarker | null = null;
let stream: MediaStream | null = null;
let socket: WebSocket | null = null;
let handheldSocket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let handheldTimer: number | null = null;
let wakeLock: WakeLockSentinel | null = null;
let nativeVoiceTextListener: PluginListenerHandle | null = null;
let nativeAudioErrorListener: PluginListenerHandle | null = null;
let running = false;
let activeRole: "home" | "camera" | "handheld" = "home";
let facingMode: "user" | "environment" = "environment";
let selectedCameraDeviceId = "__auto__";
let cameraDevices: MediaDeviceInfo[] = [];
let currentModel: ModelGrade = "full";
let voiceEnabled = false;
let voiceState: VoiceStatus = "off";
let lastVoiceText = "";
let sequence = 0;
let lastVideoTime = -1;
let lastInferenceAt = 0;
let inferenceBusy = false;
let fpsCounter = 0;
let fpsStarted = performance.now();
let serverClockOffsetMs = 0;
let lastClockSyncAt = 0;
let lastServerPoseCount = 0;
let handheldSequence = 0;
let handheldRecenter = false;
let handheldFrames = 0;
let handheldFpsStarted = performance.now();
let sensorPolling = false;
let stickState = { x: 0, y: 0 };
const padState = new Set<string>();

function getDeviceId(): string { let value = localStorage.getItem("motionbridge-device-id"); if (!value) { value = `camera-${crypto.randomUUID()}`; localStorage.setItem("motionbridge-device-id", value); } return value; }
const deviceId = getDeviceId();
function normalizeSocketUrl(value: string, path = "/ws/input"): string { const trimmed = value.trim().replace(/\/$/, ""); const parsed = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`); parsed.protocol = ["https:", "wss:"].includes(parsed.protocol) ? "wss:" : "ws:"; parsed.pathname = path; parsed.search = ""; parsed.hash = ""; return parsed.href; }
function getSuggestedServer(): string { const parameter = new URLSearchParams(location.search).get("server"); if (parameter) return normalizeSocketUrl(parameter); if (location.hostname && location.hostname !== "localhost") return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/input`; return ""; }
serverInput.value = localStorage.getItem("motionbridge-server") || getSuggestedServer(); handheldServerInput.value = localStorage.getItem("motionbridge-server") || getSuggestedServer();
handheldServerInput.addEventListener("change", () => { const value = handheldServerInput.value.trim(); if (value) { serverInput.value = value; localStorage.setItem("motionbridge-server", value); } });

function setConnection(state: ConnectionState): void { badge.className = `badge ${state}`; badge.querySelector("b")!.textContent = ({ offline: "未连接电脑", connecting: "连接中", online: "已连接电脑", error: "连接异常" })[state]; }
function setVoiceStatus(status: VoiceStatus, detail?: string): void { voiceState = status; voiceStateLabel.textContent = detail || ({ off: "关闭", connecting: "连接中", listening: "正在听", error: "错误", unauthorized: "未授权" })[status]; voiceStateLabel.className = `voice-state ${status}`; }
function poseVoiceState(): "not_connected" | "connected" | "enabled" | "unauthorized" | "failed" { return voiceState === "off" ? "not_connected" : voiceState === "connecting" ? "connected" : voiceState === "listening" ? "enabled" : voiceState === "unauthorized" ? "unauthorized" : "failed"; }
function selectedPrecision(): PrecisionMode { return (precisionSelect.value || localStorage.getItem(`motionbridge-model-${deviceId}-mode`) || "auto") as PrecisionMode; }
function syncPrecisionControls(value: PrecisionMode): void { precisionSelect.value = value; runtimePrecision.value = value; }
function modelCacheKey(): string { return `motionbridge-model-${deviceId}-${selectedCameraDeviceId || facingMode}`; }

function clearWebCamera(): void { stream?.getTracks().forEach((track) => track.stop()); stream = null; video.pause(); video.srcObject = null; video.removeAttribute("src"); video.load(); video.style.display = "none"; }
async function openWebStream(constraints: MediaStreamConstraints): Promise<MediaStream> { return await new Promise<MediaStream>((resolve, reject) => { let finished = false; const timer = window.setTimeout(() => { if (!finished) { finished = true; reject(new Error("摄像头打开超时")); } }, 5000); navigator.mediaDevices.getUserMedia(constraints).then((value) => { if (finished) { value.getTracks().forEach((track) => track.stop()); return; } finished = true; window.clearTimeout(timer); resolve(value); }, (error) => { if (finished) return; finished = true; window.clearTimeout(timer); reject(error); }); }); }
async function getVision() { vision ||= await FilesetResolver.forVisionTasks(new URL("./wasm", location.href).href); return vision; }
async function createPose(grade: ModelGrade): Promise<PoseLandmarker> { const files = await getVision(); const options = (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: new URL(`./models/pose_landmarker_${grade}.task`, location.href).href, delegate }, runningMode: "VIDEO", numPoses: 2, minPoseDetectionConfidence: .55, minPosePresenceConfidence: .55, minTrackingConfidence: .55 }); try { return await options("GPU"); } catch { return options("CPU"); } }
async function selectPoseModel(requested?: PrecisionMode): Promise<void> { document.querySelector("#loading")!.classList.remove("hidden"); const mode = requested || selectedPrecision(); localStorage.setItem(`${modelCacheKey()}-mode`, mode); syncPrecisionControls(mode); const grade: ModelGrade = mode === "auto" ? "full" : mode; poseLandmarker?.close(); poseLandmarker = await createPose(grade); currentModel = grade; document.querySelector("#modelGrade")!.textContent = ({ lite: "流畅", full: "均衡", heavy: "精确" })[grade]; document.querySelector("#loading")!.classList.add("hidden"); }

async function refreshCameraDevices(): Promise<void> { cameraDevices = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === "videoinput"); const options = ["<option value=\"__auto__\">自动</option>", ...cameraDevices.map((item, index) => { const lower = item.label.toLowerCase(); const name = lower.includes("front") || lower.includes("user") || lower.includes("前") ? "前置" : lower.includes("back") || lower.includes("environment") || lower.includes("后") ? "后置" : item.label || `镜头 ${index + 1}`; return `<option value=\"${item.deviceId}\">${name}</option>`; })].join(""); cameraDeviceSelect.innerHTML = options; runtimeCameraDevice.innerHTML = options; if (!cameraDevices.some((item) => item.deviceId === selectedCameraDeviceId)) selectedCameraDeviceId = "__auto__"; cameraDeviceSelect.value = selectedCameraDeviceId; runtimeCameraDevice.value = selectedCameraDeviceId; }
async function startCamera(): Promise<void> { clearWebCamera(); await new Promise((resolve) => setTimeout(resolve, 100)); const source = selectedCameraDeviceId !== "__auto__" ? { deviceId: { exact: selectedCameraDeviceId } } : { facingMode: { ideal: facingMode } }; stream = await openWebStream({ audio: false, video: { ...source, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30, max: 30 } } }); const track = stream.getVideoTracks()[0]; const settings = track.getSettings(); if (settings.deviceId) selectedCameraDeviceId = settings.deviceId; if (settings.facingMode === "user" || settings.facingMode === "environment") facingMode = settings.facingMode; video.style.display = "block"; video.srcObject = stream; await video.play(); if (!video.videoWidth || !video.videoHeight) throw new Error("摄像头画面无效"); await refreshCameraDevices(); resizeCanvas(); applyMirror(); }

async function start(): Promise<void> { try { const socketUrl = normalizeSocketUrl(serverInput.value); serverInput.value = socketUrl; localStorage.setItem("motionbridge-server", socketUrl); setConnection("connecting"); await startCamera(); await selectPoseModel(); running = true; activeRole = "camera"; setupCard.classList.add("hidden"); runtimeCard.classList.remove("hidden"); voiceControl.classList.remove("hidden"); document.querySelector("#guide")!.classList.remove("hidden"); connectSocket(socketUrl); wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; requestAnimationFrame(predict); } catch (error) { setConnection("error"); alert(error instanceof Error ? error.message : String(error)); await stop(); } }
function connectSocket(url: string): void { if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); setConnection("connecting"); socket = new WebSocket(url); socket.addEventListener("open", () => { setConnection("online"); if (voiceEnabled) setVoiceStatus("listening", "正在听"); syncClock(); }); socket.addEventListener("close", () => { setConnection("offline"); if (voiceEnabled) void stopVoiceControl(); if (running) reconnectTimer = window.setTimeout(() => connectSocket(url), 1500); }); socket.addEventListener("error", () => setConnection("error")); socket.addEventListener("message", (event) => { const received = performance.now(); let message: any; try { message = JSON.parse(event.data); } catch { return; } if (message.type === "clock_sync") { const sent = Number(message.client_sent_ms); serverClockOffsetMs = Number(message.server_ms) - (Date.now() - (received - sent) / 2); } if (message.type === "ack") { lastServerPoseCount = Number(message.pose_count || 0); document.querySelector("#sendState")!.textContent = poseStatusText(Boolean(message.players?.some((player: any) => player.signals?.pose_visible))); } if (message.type === "error") document.querySelector("#sendState")!.textContent = message.message || "数据错误"; }); }
function syncClock(): void { if (socket?.readyState !== WebSocket.OPEN) return; lastClockSyncAt = performance.now(); socket.send(JSON.stringify({ type: "clock_sync", client_sent_ms: lastClockSyncAt })); }

function compactLandmarks(points: NormalizedLandmark[]): NormalizedLandmark[] { return points.map(({ x, y, z, visibility }) => ({ x, y, z, visibility: visibility ?? 1 })); }
function predict(now: number): void { if (!running) return; requestAnimationFrame(predict); if (inferenceBusy || !poseLandmarker || video.readyState < 2 || video.currentTime === lastVideoTime || now - lastInferenceAt < 32) return; lastVideoTime = video.currentTime; lastInferenceAt = now; inferenceBusy = true; const started = performance.now(); try { const poseResult = poseLandmarker.detectForVideo(video, now); const elapsed = performance.now() - started; draw(poseResult.landmarks); if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256000) socket.send(JSON.stringify({ type: "pose_frame_v2", role: "camera", device_id: deviceId, sequence: sequence++, captured_at_ms: Date.now() + serverClockOffsetMs, sent_at_ms: Date.now() + serverClockOffsetMs, width: video.videoWidth, height: video.videoHeight, camera_facing: facingMode, camera_id: selectedCameraDeviceId === "__auto__" ? "logical" : selectedCameraDeviceId, orientation_degrees: 0, preview_mirrored: facingMode === "user", coordinates_mirrored: false, actual_model: currentModel, voice_state: poseVoiceState(), poses: poseResult.landmarks.map((pose, index) => ({ detection_id: null, pose: compactLandmarks(pose), world_pose: poseResult.worldLandmarks[index] ? compactLandmarks(poseResult.worldLandmarks[index]) : null })), hands: [], inference_ms: elapsed })); document.querySelector("#sendState")!.textContent = poseResult.landmarks.length ? `已识别 ${poseResult.landmarks.length} 人` : "等待完整人体"; fpsCounter++; if (performance.now() - fpsStarted >= 1000) { const fps = Math.round(fpsCounter * 1000 / (performance.now() - fpsStarted)); document.querySelector("#cameraFps")!.textContent = String(fps); document.querySelector("#localFps")!.textContent = String(fps); fpsCounter = 0; fpsStarted = performance.now(); } if (performance.now() - lastClockSyncAt > 5000) syncClock(); } finally { inferenceBusy = false; } }
function poseStatusText(playerLocked: boolean): string { if (lastServerPoseCount > 0) return playerLocked ? "已识别" : "人体已识别·动作模型准备中"; return "相机正常·未发现完整人体"; }
function draw(poses: NormalizedLandmark[][]): void { resizeCanvas(); context.clearRect(0, 0, canvas.width, canvas.height); const drawing = new DrawingUtils(context); const colors = ["#c8ff38", "#ff8bd8"]; poses.forEach((pose, index) => { drawing.drawConnectors(pose, PoseLandmarker.POSE_CONNECTIONS, { color: colors[index] || colors[0], lineWidth: 3 }); drawing.drawLandmarks(pose, { color: "#fff", fillColor: "#0b1014", radius: 3 }); }); }
function resizeCanvas(): void { const width = video.videoWidth || 960; const height = video.videoHeight || 540; if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; } }
function applyMirror(): void { document.querySelector<HTMLElement>("#cameraStage")?.classList.toggle("front-mirror", facingMode === "user"); }

async function stopVoiceControl(showOff = true): Promise<void> { voiceEnabled = false; await nativeVoiceTextListener?.remove().catch(() => {}); await nativeAudioErrorListener?.remove().catch(() => {}); nativeVoiceTextListener = null; nativeAudioErrorListener = null; lastVoiceText = ""; await NativeAudio.stop().catch(() => {}); if (showOff) { voiceToggle.checked = false; setVoiceStatus("off"); } }
async function startVoiceControl(): Promise<void> { if (activeRole !== "camera") { voiceToggle.checked = false; setVoiceStatus("error", "仅摄像头可用"); return; } if (voiceEnabled) return; setVoiceStatus("connecting"); try { const ready = await NativeAudio.start(); if (!ready.recognizerReady) throw new Error("语音模型错误"); voiceEnabled = true; nativeVoiceTextListener = await NativeAudio.addListener("voiceText", (event) => { if (!event.text) return; lastVoiceText = event.text; setVoiceStatus("listening", event.text); if (event.final && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256000) { const frame: Record<string, unknown> = { type: "voice_text", role: "camera", device_id: deviceId, sequence: sequence++, captured_at_ms: Date.now() + serverClockOffsetMs, text: event.text }; if (event.confidence != null) frame.confidence = event.confidence; socket.send(JSON.stringify(frame)); } }); nativeAudioErrorListener = await NativeAudio.addListener("audioError", (event) => { setVoiceStatus("error", event.message || "语音错误"); void stopVoiceControl(false); }); setVoiceStatus("listening", socket?.readyState === WebSocket.OPEN ? "正在听" : "未连接电脑"); } catch (error) { const message = error instanceof Error ? error.message : String(error); const denied = /未授权|permission|denied/i.test(message); await stopVoiceControl(false); voiceToggle.checked = false; setVoiceStatus(denied ? "unauthorized" : "error", denied ? "未授权" : /模型|model|recognizer|vosk/i.test(message) ? "模型错误" : message || "错误"); } }

async function stop(): Promise<void> { running = false; if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); socket = null; poseLandmarker?.close(); poseLandmarker = null; clearWebCamera(); await stopVoiceControl(); await wakeLock?.release().catch(() => {}); wakeLock = null; context.clearRect(0, 0, canvas.width, canvas.height); setupCard.classList.remove("hidden"); runtimeCard.classList.add("hidden"); document.querySelector("#guide")!.classList.add("hidden"); setConnection("offline"); }
async function chooseCamera(cameraId: string): Promise<void> { selectedCameraDeviceId = cameraId; const item = cameraDevices.find((device) => device.deviceId === cameraId); const label = item?.label.toLowerCase() || ""; if (label.includes("front") || label.includes("user") || label.includes("前")) facingMode = "user"; else if (label.includes("back") || label.includes("environment") || label.includes("后")) facingMode = "environment"; cameraDeviceSelect.value = cameraId; runtimeCameraDevice.value = cameraId; if (running) { await startCamera(); await selectPoseModel(selectedPrecision()); } applyMirror(); }
async function flipCamera(): Promise<void> { const desired = facingMode === "environment" ? "user" : "environment"; const target = cameraDevices.find((item) => { const label = item.label.toLowerCase(); return desired === "user" ? label.includes("front") || label.includes("user") || label.includes("前") : label.includes("back") || label.includes("environment") || label.includes("后"); }); if (!target) { facingMode = desired; selectedCameraDeviceId = "__auto__"; } else selectedCameraDeviceId = target.deviceId; if (running) { await startCamera(); await selectPoseModel(selectedPrecision()); } applyMirror(); }
function showRole(role: "home" | "camera" | "handheld"): void { activeRole = role; roleCard.classList.toggle("hidden", role !== "home"); setupCard.classList.toggle("hidden", role !== "camera"); handheldCard.classList.toggle("hidden", role !== "handheld"); voiceControl.classList.toggle("hidden", role !== "camera"); document.querySelector("#pageTitle")!.textContent = role === "handheld" ? "手持手柄" : role === "camera" ? "摄像头" : "体感控制"; }

async function sendHandheldFrame(): Promise<void> { if (sensorPolling || handheldSocket?.readyState !== WebSocket.OPEN) return; sensorPolling = true; try { const sample = await SensorBridge.getLatest(); const touches: Record<string, unknown>[] = [...padState].map((control) => ({ control, pressed: true })); if (Math.abs(stickState.x) > 0.02 || Math.abs(stickState.y) > 0.02) touches.push({ control: "stick", x: stickState.x, y: stickState.y }); handheldSocket.send(JSON.stringify({ type: "sensor_frame", role: "sensor", device_id: deviceId, sequence: handheldSequence++, captured_at_ms: Date.now(), player_slot: Number(document.querySelector<HTMLSelectElement>("#handheldSlot")!.value), quaternion: { x: sample.qx, y: sample.qy, z: sample.qz, w: sample.qw }, orientation: {}, rotation_rate: { x: sample.gx, y: sample.gy, z: sample.gz }, acceleration: { x: sample.ax, y: sample.ay, z: sample.az }, touches, recenter: handheldRecenter })); if (handheldRecenter) { handheldRecenter = false; document.querySelector("#sensorState")!.textContent = "已居中"; } handheldFrames++; const now = performance.now(); if (now - handheldFpsStarted >= 1000) { document.querySelector("#sensorFps")!.textContent = `${Math.round(handheldFrames * 1000 / (now - handheldFpsStarted))} FPS`; handheldFrames = 0; handheldFpsStarted = now; } } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器异常"; } finally { sensorPolling = false; } }
function clearTouches(): void { padState.clear(); stickState = { x: 0, y: 0 }; document.querySelector<HTMLElement>("#stick i")!.style.transform = "translate(0,0)"; document.querySelectorAll("[data-pad]").forEach((element) => element.classList.remove("pressed")); void sendHandheldFrame(); }
async function startHandheld(): Promise<void> { showRole("handheld"); try { await SensorBridge.start(); wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; const address = handheldServerInput.value.trim() || serverInput.value.trim(); if (!address) throw new Error("请填写电脑服务器地址"); serverInput.value = address; localStorage.setItem("motionbridge-server", address); handheldSocket = new WebSocket(normalizeSocketUrl(address)); handheldSocket.addEventListener("open", () => { document.querySelector("#handheldConnection")!.className = "badge online"; document.querySelector("#handheldConnection b")!.textContent = "已连接电脑"; document.querySelector("#sensorState")!.textContent = "自然持握 1 秒"; window.setTimeout(() => { handheldRecenter = true; }, 1000); }); handheldSocket.addEventListener("message", (event) => { try { const message = JSON.parse(event.data); if (message.type === "error") document.querySelector("#sensorState")!.textContent = message.message || "连接失败"; } catch { /* ignore malformed bridge messages */ } }); handheldSocket.addEventListener("close", () => { clearTouches(); document.querySelector("#handheldConnection")!.className = "badge error"; document.querySelector("#handheldConnection b")!.textContent = "电脑已断开"; }); handheldTimer = window.setInterval(() => void sendHandheldFrame(), 16); } catch (error) { document.querySelector("#sensorState")!.textContent = error instanceof Error ? error.message : "传感器不可用"; } }
async function stopHandheld(): Promise<void> { clearTouches(); if (handheldTimer != null) window.clearInterval(handheldTimer); handheldTimer = null; await new Promise((resolve) => setTimeout(resolve, 35)); handheldSocket?.close(); handheldSocket = null; await SensorBridge.stop().catch(() => {}); await wakeLock?.release().catch(() => {}); wakeLock = null; showRole("home"); setConnection("offline"); }
async function suspendHandheld(): Promise<void> { clearTouches(); if (handheldTimer != null) window.clearInterval(handheldTimer); handheldTimer = null; await new Promise((resolve) => setTimeout(resolve, 35)); handheldSocket?.close(); handheldSocket = null; await SensorBridge.stop().catch(() => {}); document.querySelector("#sensorState")!.textContent = "已暂停"; }
function updateStick(event: PointerEvent): void { const stick = document.querySelector<HTMLElement>("#stick")!; const rect = stick.getBoundingClientRect(); const x = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.38))); const y = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height * 0.38))); stickState = { x, y }; stick.querySelector<HTMLElement>("i")!.style.transform = `translate(${x * 34}px,${y * 34}px)`; }

document.querySelector("#cameraRole")!.addEventListener("click", () => { void (running ? stop() : Promise.resolve()).then(() => { showRole("camera"); return refreshCameraDevices(); }).catch((error) => { document.querySelector("#securityWarning")!.textContent = error instanceof Error ? error.message : String(error); }); });
document.querySelector("#handheldRole")!.addEventListener("click", () => { void (running || voiceEnabled ? stop() : Promise.resolve()).then(() => startHandheld()); });
document.querySelector("#cameraHome")!.addEventListener("click", () => { void stop().then(() => showRole("home")); });
document.querySelector("#startButton")!.addEventListener("click", () => void start()); document.querySelector("#stopButton")!.addEventListener("click", () => void stop());
for (const select of [cameraDeviceSelect, runtimeCameraDevice]) select.addEventListener("change", () => void chooseCamera(select.value));
for (const select of [precisionSelect, runtimePrecision]) select.addEventListener("change", () => { syncPrecisionControls(select.value as PrecisionMode); if (running) void selectPoseModel(select.value as PrecisionMode); });
document.querySelector("#runtimeFlip")!.addEventListener("click", () => void flipCamera()); voiceToggle.addEventListener("change", () => void (voiceToggle.checked ? startVoiceControl() : stopVoiceControl()));
document.querySelector("#centerSensor")!.addEventListener("click", () => { handheldRecenter = true; document.querySelector("#sensorState")!.textContent = "正在居中"; }); document.querySelector("#stopHandheld")!.addEventListener("click", () => void stopHandheld());
document.querySelectorAll<HTMLElement>("[data-pad]").forEach((button) => { button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); padState.add(button.dataset.pad!); button.classList.add("pressed"); }); const release = () => { padState.delete(button.dataset.pad!); button.classList.remove("pressed"); }; button.addEventListener("pointerup", release); button.addEventListener("pointercancel", release); button.addEventListener("lostpointercapture", release); });
const stick = document.querySelector<HTMLElement>("#stick")!; stick.addEventListener("pointerdown", (event) => { stick.setPointerCapture(event.pointerId); updateStick(event); }); stick.addEventListener("pointermove", (event) => { if (stick.hasPointerCapture(event.pointerId)) updateStick(event); }); const releaseStick = () => { stickState = { x: 0, y: 0 }; stick.querySelector<HTMLElement>("i")!.style.transform = "translate(0,0)"; }; stick.addEventListener("pointerup", releaseStick); stick.addEventListener("pointercancel", releaseStick);
window.addEventListener("resize", resizeCanvas);
document.addEventListener("visibilitychange", () => { if (document.hidden && voiceEnabled) void stopVoiceControl(); if (document.hidden && activeRole === "handheld") void suspendHandheld(); if (document.visibilityState === "visible" && activeRole === "handheld" && handheldTimer == null) void startHandheld(); if (document.visibilityState === "visible" && (running || activeRole === "handheld") && !wakeLock) void navigator.wakeLock?.request("screen").then((lock) => { wakeLock = lock; }).catch(() => {}); });
window.addEventListener("beforeunload", () => { clearTouches(); void stopVoiceControl(); });
