import {
  DrawingUtils,
  FilesetResolver,
  GestureRecognizer,
  PoseLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import "./style.css";

type ConnectionState = "offline" | "connecting" | "online" | "error";
type GestureCache = { handedness: "Left" | "Right" | "Unknown"; landmarks: NormalizedLandmark[]; gesture?: string; gesture_score?: number }[];
type ModelGrade = "lite" | "full" | "heavy";
type PrecisionMode = "auto" | ModelGrade;
type SensorSample = { qx: number; qy: number; qz: number; qw: number; gx: number; gy: number; gz: number; ax: number; ay: number; az: number; timestamp: number; running: boolean };
const SensorBridge = registerPlugin<{ start(): Promise<void>; getLatest(): Promise<SensorSample>; stop(): Promise<void> }>("SensorBridge");
type NativeAudioApi = {
  start(): Promise<{sampleRate:number;channels:number;format:string;source:string;recognizerReady:boolean}>; stop(): Promise<void>;
  addListener(eventName:"voiceText", listener:(event:{text:string;confidence?:number;final:boolean})=>void):Promise<PluginListenerHandle>;
  addListener(eventName:"audioError", listener:(event:{message:string})=>void):Promise<PluginListenerHandle>;
};
const NativeAudio = registerPlugin<NativeAudioApi>("NativeAudio");
type VoiceStatus = "off" | "connecting" | "listening" | "error" | "unauthorized";
type NativeCameraDescriptor = { cameraId: string; facing: string; focalLengths: number[]; sensorWidthMm?: number; sensorHeightMm?: number; sensorOrientation: number; logicalMultiCamera: boolean; physicalCameraIds: string[]; available?: boolean; openMode?: string; errorCode?: number; errorMessage?: string; width?: number; height?: number; previewFps?: number; maxFps?:number; supports30Fps?:boolean };
type PoseDiagnostics = { imageReaderFrames:number;submittedFrames:number;detectCalls:number;detectErrors:number;poseCount:number;bitmapWidth:number;bitmapHeight:number;rotationDegrees:number;analysisProfile:string;minimumPoseVisibility:number;lastError?:string;rawFirstPoint?:{x:number;y:number;visibility:number};encodedFirstPoint?:{x:number;y:number;visibility:number} };
type NativePoseFrame = { capturedAtMs: number; cameraId: string; facing: "front" | "back"; width: number; height: number; inferenceWidth:number; inferenceHeight:number; previewMirrored: boolean; coordinatesMirrored: false; actualModel: ModelGrade; inferenceMs: number; captureFps: number; previewFps: number; inferenceFps: number; poseCount:number; poseDiagnostics:PoseDiagnostics; poses: {detection_id:null;pose:NormalizedLandmark[];world_pose:NormalizedLandmark[]|null}[]; hands: GestureCache };
type NativeCameraApi = {
  listCameras(): Promise<{cameras: NativeCameraDescriptor[]}>; probeCameras(): Promise<{cameras: NativeCameraDescriptor[]}>;
  discoverCameras(options?:{force?:boolean}): Promise<{cameras: NativeCameraDescriptor[];deviceKey:string;manufacturer:string;model:string;androidApi:number}>; startCamera(options:{cameraId:string;model:ModelGrade;inference?:boolean}):Promise<{cameraId:string;facing:"front"|"back";width:number;height:number;previewMirrored:boolean;actualModel:ModelGrade}>;
  setModel(options:{model:ModelGrade}):Promise<void>; enableInference(options:{model:ModelGrade}):Promise<void>; setDisplayMode(options:{role:"home"|"camera"|"handheld"}):Promise<void>; stopCamera():Promise<void>; checkPermissions():Promise<{camera:string}>; requestPermissions():Promise<{camera:string}>;
  addListener(eventName:"poseResult", listener:(frame:NativePoseFrame)=>void):Promise<PluginListenerHandle>;
  addListener(eventName:"cameraError", listener:(event:{message:string})=>void):Promise<PluginListenerHandle>;
};
const NativeCamera = registerPlugin<NativeCameraApi>("NativeCamera");
(window as any).MotionBridgeNativeCamera = NativeCamera;
const nativeCameraEnabled = Capacitor.isNativePlatform();
// Android 默认使用 Camera2 + Viewfinder + 原生 MediaPipe；浏览器仍保留兼容回退。
let nativeCameraOperational = nativeCameraEnabled;
let activeNativeCamera = false;
let cameraSwitching = false;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <video id="camera" autoplay playsinline muted></video><canvas id="overlay"></canvas><div class="shade"></div>
  <header><div><p>MOTIONBRIDGE 0.7.5</p><h1 id="pageTitle">体感桥</h1></div><div id="connectionBadge" class="badge"><i></i><b>未连接电脑</b></div></header>
  <main>
    <section class="setup-card role-card" id="roleCard"><h2>选择角色</h2><div class="role-grid"><button id="cameraRole">摄像头</button><button id="handheldRole">手持手柄</button></div></section>
    <section class="setup-card hidden" id="setupCard">
      <div class="card-head"><h2>摄像头</h2><button id="cameraHome" class="text-button">返回首页</button></div>
      <label>电脑服务器地址<input id="serverUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑地址:8765/ws/input"></label>
      <label>镜头<select id="cameraDeviceSelect"><option value="__auto__">自动</option></select></label>
      <div class="actions"><button id="startButton">开始识别</button></div>
      <p class="warning" id="securityWarning"></p>
    </section>
    <section class="runtime-card hidden" id="runtimeCard">
      <div class="runtime-state"><strong id="sendState">等待完整人体</strong><small>识别状态</small></div>
      <label class="runtime-select">镜头<select id="runtimeCameraDevice"><option value="__auto__">自动</option></select></label>
      <button id="stopButton" class="stop">停止识别</button>
    </section>
    <section class="handheld-card hidden" id="handheldCard">
      <div class="handheld-top handheld-connection-row"><span id="handheldConnection" class="badge"><i></i><b>未连接电脑</b></span><label>电脑服务器地址<input id="handheldServerUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑地址:8765/ws/input"></label></div>
      <div class="handheld-top"><label>绑定玩家<select id="handheldSlot"><option value="0">玩家一</option><option value="1">玩家二</option></select></label><span><b id="sensorFps">0 FPS</b><small id="sensorState">等待传感器</small></span><button id="centerSensor">重新居中</button><button id="stopHandheld" class="stop">停止手柄</button></div>
      <div class="shoulders"><button data-pad="l">LB</button><button data-pad="zl">LT</button><button data-pad="zr">RT</button><button data-pad="r">RB</button></div><div class="gamepad"><div id="stick" class="stick"><i></i></div><div class="middle-buttons"><button data-pad="select">选择</button><button data-pad="start">开始</button></div><div class="face-buttons"><button data-pad="y">Y</button><button data-pad="x">X</button><button data-pad="b">B</button><button data-pad="a">A</button></div></div>
    </section>
  </main>
  <div class="voice-control hidden" id="voiceControl"><label><input id="voiceToggle" type="checkbox">语音控制</label><span id="voiceState">关闭</span></div>
  <div class="guide hidden" id="guide"></div>
  <div class="loading hidden" id="loading"><i></i><b id="loadingText">正在打开摄像头…</b></div>`;

const video = document.querySelector<HTMLVideoElement>("#camera")!;
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

function setNativePreview(active: boolean): void {
  document.documentElement.classList.toggle("native-preview", active);
  document.body.classList.toggle("native-preview", active);
}

let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let poseLandmarker: PoseLandmarker | null = null;
let gestureRecognizer: GestureRecognizer | null = null;
let stream: MediaStream | null = null;
let socket: WebSocket | null = null;
let nativeVoiceTextListener: PluginListenerHandle | null = null;
let nativeAudioErrorListener: PluginListenerHandle | null = null;
let running = false;
let facingMode: "user" | "environment" = "environment";
let selectedCameraDeviceId = "";
let activeNativeCameraId = "";
let cameraDevices: MediaDeviceInfo[] = [];
let nativeCameras: NativeCameraDescriptor[] = [];
let nativeFrameWidth = 720;
let nativeFrameHeight = 1280;
let nativeAutoStartedAt = 0;
let nativeAutoFallbackDone = false;
let nativeModelBenchmark: {grade:ModelGrade;started:number;samples:number[]} | null = null;
let currentModel: ModelGrade | null = null;
let voiceEnabled = false;
let voiceState: VoiceStatus = "off";
let lastVoiceText = "";
let activeRole: "home" | "camera" | "handheld" = "home";
let handheldSocket: WebSocket | null = null;
let handheldTimer: number | null = null;
let handheldSequence = 0;
let handheldRecenter = false;
let handheldFrames = 0;
let handheldFpsStarted = performance.now();
const padState = new Set<string>();
let stickState = { x: 0, y: 0 };
let sequence = 0;
let frameCounter = 0;
let fpsCounter = 0;
let fpsStarted = performance.now();
let lastVideoTime = -1;
let lastInferenceAt = 0;
let gestureCache: GestureCache = [];
let reconnectTimer: number | null = null;
let wakeLock: WakeLockSentinel | null = null;
let serverClockOffsetMs = 0;
let lastClockSyncAt = 0;
let lastNativePoseCount = 0;
let lastServerPoseCount = 0;
let lastPoseDiagnostics: PoseDiagnostics | null = null;

function clearWebCamera(): void {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.pause();
  video.srcObject = null;
  video.removeAttribute("src");
  video.load();
  video.style.display = "none";
}

function cameraLog(message: string): void {
  console.log(`[camera] ${message}`);
}

async function openWebStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return await new Promise<MediaStream>((resolve, reject) => {
    let finished = false;
    const timer = window.setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error("摄像头打开超时（5 秒）"));
    }, 5000);
    navigator.mediaDevices.getUserMedia(constraints).then(
      (streamValue) => {
        if (finished) {
          streamValue.getTracks().forEach((track) => track.stop());
          return;
        }
        finished = true;
        window.clearTimeout(timer);
        resolve(streamValue);
      },
      (error) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const deviceId = getDeviceId();
serverInput.value = localStorage.getItem("motionbridge-server") || getSuggestedServer();
handheldServerInput.value = localStorage.getItem("motionbridge-server") || getSuggestedServer();
handheldServerInput.addEventListener("change", () => {
  const value = handheldServerInput.value.trim();
  if (value) { serverInput.value = value; localStorage.setItem("motionbridge-server", value); }
});
if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
  document.querySelector("#securityWarning")!.textContent = "当前页面不是可信 HTTPS，浏览器可能禁止摄像头或麦克风；Android 安装包不受此限制。";
}

function getSuggestedServer(): string {
  const parameter = new URLSearchParams(location.search).get("server");
  if (parameter) return normalizeSocketUrl(parameter);
  if (location.hostname && location.hostname !== "localhost") return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/input`;
  return "";
}

function normalizeSocketUrl(value: string, path = "/ws/input"): string {
  const trimmed = value.trim().replace(/\/$/, "");
  const parsed = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`);
  parsed.protocol = ["https:", "wss:"].includes(parsed.protocol) ? "wss:" : "ws:";
  parsed.pathname = path; parsed.search = ""; parsed.hash = "";
  return parsed.href;
}

function getDeviceId(): string {
  let value = localStorage.getItem("motionbridge-device-id");
  if (!value) { value = `camera-${crypto.randomUUID()}`; localStorage.setItem("motionbridge-device-id", value); }
  return value;
}

async function getVision() {
  vision ||= await FilesetResolver.forVisionTasks(new URL("./wasm", location.href).href);
  return vision;
}

async function createPose(grade: ModelGrade): Promise<PoseLandmarker> {
  const files = await getVision();
  const options = (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: new URL(`./models/pose_landmarker_${grade}.task`, location.href).href, delegate },
    runningMode: "VIDEO", numPoses: 2, minPoseDetectionConfidence: .55, minPosePresenceConfidence: .55, minTrackingConfidence: .55,
  });
  try { return await options("GPU"); } catch { return options("CPU"); }
}

async function loadGesture(): Promise<void> {
  if (gestureRecognizer) return;
  const files = await getVision();
  const options = (delegate: "GPU" | "CPU") => GestureRecognizer.createFromOptions(files, {
    baseOptions: { modelAssetPath: new URL("./models/gesture_recognizer.task", location.href).href, delegate },
    runningMode: "VIDEO", numHands: 4, minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5,
    cannedGesturesClassifierOptions: { scoreThreshold: .5 },
  });
  try { gestureRecognizer = await options("GPU"); } catch { gestureRecognizer = await options("CPU"); }
}

function modelCacheKey(): string { return `motionbridge-model-${deviceId}-${activeNativeCameraId || selectedCameraDeviceId || facingMode}`; }
function selectedPrecision(): PrecisionMode { return "auto"; }
function syncPrecisionControls(value: PrecisionMode): void {
  const first = document.querySelector<HTMLSelectElement>("#precisionSelect");
  const second = document.querySelector<HTMLSelectElement>("#runtimePrecision");
  if (first) first.value = value;
  if (second) second.value = value;
}

async function selectPoseModel(force = false, requested?: PrecisionMode): Promise<void> {
  if (activeNativeCamera) {
    const mode = requested || selectedPrecision(); localStorage.setItem(`${modelCacheKey()}-mode`, mode); syncPrecisionControls(mode);
    const grade = mode === "auto" ? ((localStorage.getItem(`${modelCacheKey()}-native-auto`) as ModelGrade | null) || "full") : mode;
    await NativeCamera.setModel({model:grade}); showGrade(grade, mode === "auto" ? "自动选择" : "手动选择"); return;
  }
  document.querySelector("#loading")!.classList.remove("hidden");
  const mode = requested || selectedPrecision(); localStorage.setItem(`${modelCacheKey()}-mode`, mode); syncPrecisionControls(mode);
  const grade = mode === "auto" ? "full" : mode;
  poseLandmarker?.close(); poseLandmarker = await createPose(grade); showGrade(grade, mode === "auto" ? "自动（均衡）" : "手动选择");
  document.querySelector("#loading")!.classList.add("hidden");
}

function showGrade(grade: ModelGrade, title: string): void {
  currentModel = grade;
  const label = document.querySelector<HTMLElement>("#modelGrade");
  if (label) { label.textContent = ({ lite: "流畅", full: "均衡", heavy: "精确" })[grade]; label.title = title; }
}

async function start(): Promise<void> {
  try {
    const socketUrl = normalizeSocketUrl(serverInput.value); serverInput.value = socketUrl; localStorage.setItem("motionbridge-server", socketUrl);
    setConnection("connecting");
    if(activeNativeCamera){
      const mode=selectedPrecision();const grade=mode==="auto"?((localStorage.getItem(`${modelCacheKey()}-native-auto`) as ModelGrade|null)||"full"):mode;
      await NativeCamera.enableInference({model:grade});showGrade(grade,mode==="auto"?"自动选择":"手动选择");
    }else{await startCamera();if(!activeNativeCamera)await selectPoseModel();}
    running = true; activeRole = "camera"; setupCard.classList.add("hidden"); runtimeCard.classList.remove("hidden"); document.querySelector("#guide")!.classList.remove("hidden"); applyMirror();
    // 语音在摄像头手机本地离线识别，只通过 /ws/input 发送短文本。
    connectSocket(socketUrl);
    wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null; if (!activeNativeCamera) requestAnimationFrame(predict);
  } catch (error) { setConnection("error"); alert(error instanceof Error ? error.message : String(error)); await stop(); }
}

async function startFramingPreview(): Promise<void> {
  if (!nativeCameraOperational) return;
  if (!nativeCameras.some((item)=>item.available)) await refreshCameraDevices();
  const available=nativeCameras.filter((item)=>item.available);
  const descriptor=(selectedCameraDeviceId!=="__auto__"&&available.find((item)=>item.cameraId===selectedCameraDeviceId))||widestStableBack(available.filter((item)=>item.facing==="back"))||available[0];
  if (!descriptor) return;
  facingMode=descriptor.facing==="front"?"user":"environment";
  setNativePreview(true);
  await NativeCamera.startCamera({cameraId:descriptor.cameraId,model:"lite",inference:false});
  activeNativeCameraId=descriptor.cameraId;activeNativeCamera=true;applyMirror();
}

async function startCamera(): Promise<void> {
  if (nativeCameraOperational) {
    if (!nativeCameras.some((item) => item.available)) await refreshCameraDevices();
    const available=nativeCameras.filter((item)=>item.available); const backs=available.filter((item)=>item.facing==="back");
    let descriptor=selectedCameraDeviceId!=="__auto__"?available.find((item)=>item.cameraId===selectedCameraDeviceId):undefined;
    descriptor||=widestStableBack(backs)||available.find((item)=>item.facing===(facingMode==="user"?"front":"back"))||available[0];
    if (!descriptor) { if (nativeCameraEnabled) throw new Error("没有可用的原生镜头"); nativeCameraOperational=false; } else {
      const sameFacing=available.filter((item)=>item.facing===descriptor!.facing);
      const candidates=[descriptor,...sameFacing.slice().sort((a,b)=>Math.abs(horizontalFov(a)-65)-Math.abs(horizontalFov(b)-65))].filter((item,index,list)=>list.findIndex((other)=>other.cameraId===item.cameraId)===index);
      const mode=selectedPrecision();let lastError:unknown;
      for(const candidate of candidates.slice(0,2)){
        try{
          activeNativeCameraId=candidate.cameraId;const grade=mode==="auto"?((localStorage.getItem(`${modelCacheKey()}-native-auto`) as ModelGrade|null)||"full"):mode;
          clearWebCamera();
          setNativePreview(true);const state=await NativeCamera.startCamera({cameraId:candidate.cameraId,model:grade});
          activeNativeCamera=true;facingMode=state.facing==="front"?"user":"environment";nativeFrameWidth=state.width;nativeFrameHeight=state.height;showGrade(state.actualModel,mode==="auto"?"自动选择":"手动选择");
          nativeModelBenchmark=mode==="auto"&&!localStorage.getItem(`${modelCacheKey()}-native-auto`)?{grade:state.actualModel,started:performance.now(),samples:[]}:null;
          cameraDeviceSelect.value=runtimeCameraDevice.value=selectedCameraDeviceId;nativeAutoStartedAt=performance.now();nativeAutoFallbackDone=false;resizeCanvas();applyMirror();return;
        }catch(error){lastError=error;await NativeCamera.stopCamera().catch(()=>{});setNativePreview(false);}
      }
      if (nativeCameraEnabled) throw (lastError instanceof Error ? lastError : new Error("原生相机捕获会话建立失败"));
      document.querySelector("#securityWarning")!.textContent=`原生相机不可用，已切换兼容模式${lastError instanceof Error?`：${lastError.message}`:""}`;nativeCameraOperational=false;
    }
  }
  activeNativeCamera=false;activeNativeCameraId="";setNativePreview(false);
  clearWebCamera();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const source = selectedCameraDeviceId ? { deviceId: { exact: selectedCameraDeviceId } } : { facingMode: { ideal: facingMode } };
  cameraLog(`getUserMedia requested source=${JSON.stringify(source)}`);
  stream = await openWebStream({ audio: false, video: { ...source, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30, max: 30 } } });
  const track = stream.getVideoTracks()[0]; const settings = track.getSettings();
  if (settings.deviceId) selectedCameraDeviceId = settings.deviceId;
  if (settings.facingMode === "user" || settings.facingMode === "environment") facingMode = settings.facingMode;
  video.style.display = "block"; video.srcObject = stream; await video.play();
  if (!video.videoWidth || !video.videoHeight) throw new Error("摄像头画面无效");
  cameraLog(`camera opened deviceId=${selectedCameraDeviceId} facing=${facingMode} size=${video.videoWidth}x${video.videoHeight}`);
  await refreshCameraDevices(); resizeCanvas(); applyMirror();
}

async function refreshCameraDevices(): Promise<void> {
  if (nativeCameraOperational) {
    document.querySelector("#loading")!.classList.remove("hidden"); document.querySelector("#loadingText")!.textContent = "正在检测可用镜头…";
    try {
      let permission = await NativeCamera.checkPermissions();
      if (permission.camera !== "granted") permission = await NativeCamera.requestPermissions();
      if (permission.camera !== "granted") throw new Error("摄像头未授权");
      nativeCameras = (await NativeCamera.discoverCameras({force:true})).cameras.filter((item)=>item.available);
      const available = nativeCameras;
      const back = available.filter((item) => item.facing === "back").sort((a,b)=>horizontalFov(b)-horizontalFov(a));
      const labelFor = (item:NativeCameraDescriptor):string => {
        if(item.facing==="front")return "前置";
        const reliable=Number.isFinite(horizontalFov(item));const index=back.findIndex((entry)=>entry.cameraId===item.cameraId);
        if(!reliable)return `后置镜头 ${index+1}`;
        const kind=back.length>=3?(index===0?"超广角":index===back.length-1?"长焦":"广角主摄"):(back.length===2?(index===0?"超广角":"广角主摄"):"广角主摄");
        return `后置${kind}`;
      };
      const options=`<option value="__auto__">自动</option>`+available.map((item)=>`<option value="${item.cameraId}">${labelFor(item)}</option>`).join("");
      const saved=localStorage.getItem("motionbridge-native-camera-last");if(!selectedCameraDeviceId)selectedCameraDeviceId=saved&&available.some((item)=>item.cameraId===saved)?saved:"__auto__";
      if(selectedCameraDeviceId!=="__auto__"&&!available.some((item)=>item.cameraId===selectedCameraDeviceId))selectedCameraDeviceId="__auto__";
      const selected=nativeCameras.find((item)=>item.cameraId===selectedCameraDeviceId); if(selected)facingMode=selected.facing==="front"?"user":"environment";
      for(const select of [cameraDeviceSelect,runtimeCameraDevice]){select.innerHTML=options||'<option value="">无可用镜头</option>';select.value=selectedCameraDeviceId;}
      document.querySelector("#securityWarning")!.textContent="";
      return;
    } catch(error){
      if (nativeCameraEnabled) throw error;
      nativeCameraOperational=false;
      document.querySelector("#securityWarning")!.textContent=`原生相机不可用，使用兼容模式${error instanceof Error?`：${error.message}`:""}`;
    }
    finally { document.querySelector("#loading")!.classList.add("hidden"); }
  }
  cameraDevices = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === "videoinput");
  const options = cameraDevices.map((item, index) => {
    const lower = item.label.toLowerCase();
    const name = lower.includes("front") ? "前置镜头" : lower.includes("back") ? "后置镜头" : item.label || `镜头 ${index + 1}`;
    return `<option value="${item.deviceId}">${name}</option>`;
  }).join("");
  for (const select of [cameraDeviceSelect, runtimeCameraDevice]) { select.innerHTML = options || '<option value="">系统默认镜头</option>'; select.value = selectedCameraDeviceId; }
}

function horizontalFov(camera:NativeCameraDescriptor):number{const focal=camera.focalLengths[0],width=camera.sensorWidthMm;return focal&&width?2*Math.atan(width/(2*focal))*180/Math.PI:Number.NaN;}
function widestStableBack(cameras:NativeCameraDescriptor[]):NativeCameraDescriptor|undefined{const stable=cameras.filter((item)=>(item.width||0)*(item.height||0)>=1280*720&&item.supports30Fps!==false);return(stable.length?stable:cameras).slice().sort((a,b)=>(Number.isFinite(horizontalFov(b))?horizontalFov(b):-1)-(Number.isFinite(horizontalFov(a))?horizontalFov(a):-1))[0];}

function connectSocket(url: string): void {
  if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); setConnection("connecting"); socket = new WebSocket(url);
  socket.addEventListener("open", () => { setConnection("online"); if (voiceEnabled) setVoiceStatus("listening", "正在听"); syncClock(); });
  socket.addEventListener("close", () => { setConnection("offline"); if (voiceEnabled) void stopVoiceControl(); if (running) reconnectTimer = window.setTimeout(() => connectSocket(url), 1500); });
  socket.addEventListener("error", () => setConnection("error"));
  socket.addEventListener("message", (event) => {
    const received = performance.now(); const message = JSON.parse(event.data) as any;
    if (message.type === "clock_sync") { const sent = Number(message.client_sent_ms); serverClockOffsetMs = Number(message.server_ms) - (Date.now() - (received - sent) / 2); }
    if (message.type === "ack") {
      lastServerPoseCount=Number(message.pose_count||0);
      const playerLocked=message.players?.some((p:any)=>p.signals?.pose_visible);
      document.querySelector("#sendState")!.textContent=poseStatusText(playerLocked);
    }
    if (message.type === "error") document.querySelector("#sendState")!.textContent = message.message || "数据错误";
  });
}

function syncClock(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  lastClockSyncAt = performance.now(); socket.send(JSON.stringify({ type: "clock_sync", client_sent_ms: lastClockSyncAt }));
}

function setVoiceStatus(status: VoiceStatus, detail?: string): void {
  voiceState = status;
  voiceStateLabel.textContent = detail || ({off: "关闭", connecting: "连接中", listening: "正在听", error: "错误", unauthorized: "未授权"}[status]);
  voiceStateLabel.className = `voice-state ${status}`;
}

function poseVoiceState(): "not_connected" | "connected" | "enabled" | "unauthorized" | "failed" {
  return voiceState === "off" ? "not_connected" : voiceState === "connecting" ? "connected" :
    voiceState === "listening" ? "enabled" : voiceState === "unauthorized" ? "unauthorized" : "failed";
}

async function stopVoiceControl(showOff = true): Promise<void> {
  voiceEnabled = false;
  await nativeVoiceTextListener?.remove().catch(() => {});
  await nativeAudioErrorListener?.remove().catch(() => {});
  nativeVoiceTextListener = null;
  nativeAudioErrorListener = null;
  lastVoiceText = "";
  await NativeAudio.stop().catch(() => {});
  if (showOff) {
    voiceToggle.checked = false;
    setVoiceStatus("off");
  }
}

async function startVoiceControl(): Promise<void> {
  if (activeRole !== "camera") {
    voiceToggle.checked = false;
    setVoiceStatus("error", "仅摄像头可用");
    return;
  }
  if (voiceEnabled) return;
  setVoiceStatus("connecting");
  try {
    const ready = await NativeAudio.start();
    if (!ready.recognizerReady) throw new Error("语音模型错误");
    voiceEnabled = true;
    nativeVoiceTextListener = await NativeAudio.addListener("voiceText", (event) => {
      if (!event.text) return;
      lastVoiceText = event.text;
      setVoiceStatus("listening", event.text);
      if (event.final && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256000) {
        const frame: Record<string, unknown> = {
          type: "voice_text", role: "camera", device_id: deviceId,
          sequence: sequence++, captured_at_ms: Date.now() + serverClockOffsetMs,
          text: event.text,
        };
        if (event.confidence != null) frame.confidence = event.confidence;
        socket.send(JSON.stringify(frame));
      }
    });
    nativeAudioErrorListener = await NativeAudio.addListener("audioError", (event) => {
      setVoiceStatus("error", event.message || "语音错误");
      void stopVoiceControl(false);
    });
    setVoiceStatus("listening", socket?.readyState === WebSocket.OPEN ? "正在听" : "未连接");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const denied = /未授权|permission|denied/i.test(message);
    await stopVoiceControl(false);
    voiceToggle.checked = false;
    const modelError = /模型|model|recognizer|vosk/i.test(message);
    setVoiceStatus(denied ? "unauthorized" : "error", denied ? "未授权" : modelError ? "模型错误" : message || "错误");
  }
}

function predict(now: number): void {
  if (!running) return; requestAnimationFrame(predict);
  if (!poseLandmarker || video.readyState < 2 || video.currentTime === lastVideoTime || now - lastInferenceAt < 32) return;
  lastVideoTime = video.currentTime; lastInferenceAt = now; const started = performance.now(); const poseResult = poseLandmarker.detectForVideo(video, now);
  if (frameCounter % 2 === 0 && gestureRecognizer) {
    const result = gestureRecognizer.recognizeForVideo(video, now);
    gestureCache = result.landmarks.map((landmarks, index) => ({ handedness: (result.handedness[index]?.[0]?.categoryName as any) || "Unknown", landmarks, gesture: result.gestures[index]?.[0]?.categoryName, gesture_score: result.gestures[index]?.[0]?.score || 0 }));
  }
  const elapsed = performance.now() - started; draw(poseResult.landmarks, gestureCache);
  if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256000) {
    const compact = (points: NormalizedLandmark[]) => compactLandmarks(points, false);
    socket.send(JSON.stringify({ type: "pose_frame_v2", role: "camera", device_id: deviceId, sequence: sequence++, captured_at_ms: Date.now() + serverClockOffsetMs, sent_at_ms: Date.now() + serverClockOffsetMs,
      width: video.videoWidth, height: video.videoHeight, camera_facing: facingMode, camera_id: selectedCameraDeviceId||"logical", orientation_degrees: 0, preview_mirrored: facingMode === "user", coordinates_mirrored: false, actual_model: currentModel, voice_state: poseVoiceState(),
      poses: poseResult.landmarks.map((pose, index) => ({ detection_id: null, pose: compact(pose), world_pose: poseResult.worldLandmarks[index] ? compactLandmarks(poseResult.worldLandmarks[index], false) : null })),
      hands: [], inference_ms: elapsed }));
    document.querySelector("#sendState")!.textContent = poseResult.landmarks.length ? `发送 ${poseResult.landmarks.length} 人` : "等待人体";
  } else if (!poseResult.landmarks.length) document.querySelector("#sendState")!.textContent = "等待人体";
  if (performance.now() - lastClockSyncAt > 5000) syncClock(); frameCounter++; fpsCounter++;
  if (now - fpsStarted >= 1000) { const fps=Math.round(fpsCounter * 1000 / (now - fpsStarted));document.querySelector<HTMLElement>("#cameraFps")?.replaceChildren(document.createTextNode(String(fps)));document.querySelector<HTMLElement>("#localFps")?.replaceChildren(document.createTextNode(String(fps))); fpsCounter = 0; fpsStarted = now; }
}

function handleNativePoseFrame(frame: NativePoseFrame): void {
  if (!running) return;
  nativeFrameWidth=frame.width;nativeFrameHeight=frame.height;facingMode=frame.facing==="front"?"user":"environment";currentModel=frame.actualModel;
  lastNativePoseCount=frame.poseCount??frame.poses.length;lastPoseDiagnostics=frame.poseDiagnostics;
  draw(frame.poses.map((item)=>item.pose),frame.hands); const cameraFps=document.querySelector<HTMLElement>("#cameraFps");const localFps=document.querySelector<HTMLElement>("#localFps");if(cameraFps)cameraFps.textContent=String(Math.round(frame.previewFps||frame.captureFps));if(localFps)localFps.textContent=String(Math.round(frame.inferenceFps||0));
  if(socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount<256000){
    socket.send(JSON.stringify({type:"pose_frame_v2",role:"camera",device_id:deviceId,sequence:sequence++,captured_at_ms:frame.capturedAtMs+serverClockOffsetMs,sent_at_ms:Date.now()+serverClockOffsetMs,width:frame.width,height:frame.height,camera_facing:facingMode,camera_id:frame.cameraId,orientation_degrees:0,preview_mirrored:frame.previewMirrored,coordinates_mirrored:false,actual_model:frame.actualModel,voice_state:poseVoiceState(),pose_diagnostics:frame.poseDiagnostics,poses:frame.poses,hands:frame.hands,inference_ms:frame.inferenceMs}));
    document.querySelector("#sendState")!.textContent=poseStatusText(false);
  }else if(!frame.poses.length){
    document.querySelector("#sendState")!.textContent=poseStatusText(false);
  }
  if(performance.now()-lastClockSyncAt>5000)syncClock();
  runNativeModelBenchmark(frame);
  if(selectedCameraDeviceId==="__auto__"&&!nativeAutoFallbackDone&&performance.now()-nativeAutoStartedAt>8000&&(frame.captureFps>0&&frame.captureFps<15||frame.inferenceMs>90)){
    nativeAutoFallbackDone=true;const backs=nativeCameras.filter((item)=>item.available&&item.facing==="back"&&item.cameraId!==activeNativeCameraId);const main=backs.sort((a,b)=>Math.abs(horizontalFov(a)-65)-Math.abs(horizontalFov(b)-65))[0];
    if(main){document.querySelector("#securityWarning")!.textContent="当前镜头性能不足，已回退广角主摄";selectedCameraDeviceId=main.cameraId;void startCamera();}
  }
}

function poseStatusText(playerLocked:boolean):string{
  if(lastNativePoseCount>0||lastServerPoseCount>0){
    if(playerLocked)return "已识别";
    return "人体已识别·动作模型准备中";
  }
  if(lastPoseDiagnostics?.detectErrors)return "相机正常·人体推理异常";
  if((lastPoseDiagnostics?.detectCalls||0)>0)return "相机正常·未发现完整人体";
  return "相机正常·识别准备中";
}

function runNativeModelBenchmark(frame:NativePoseFrame):void{
  const benchmark=nativeModelBenchmark;if(!benchmark||benchmark.grade!==frame.actualModel)return;benchmark.samples.push(frame.inferenceMs);
  const elapsed=performance.now()-benchmark.started;if(elapsed<4000)return;
  const sorted=benchmark.samples.slice().sort((a,b)=>a-b);const p95=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]||999;const fps=benchmark.samples.length*1000/elapsed;const valid=fps>=15&&p95<=60;
  let next:ModelGrade|null=null,chosen:ModelGrade|null=null;
  if(benchmark.grade==="full")next=valid?"heavy":"lite";else if(benchmark.grade==="heavy")chosen=valid?"heavy":"full";else chosen="lite";
  if(chosen){localStorage.setItem(`${modelCacheKey()}-native-auto`,chosen);nativeModelBenchmark=null;showGrade(chosen,`自动测速 ${fps.toFixed(0)} FPS / P95 ${p95.toFixed(0)}ms`);if(chosen!==frame.actualModel)void NativeCamera.setModel({model:chosen});return;}
  nativeModelBenchmark={grade:next!,started:performance.now()+800,samples:[]};showGrade(next!,"自动测速");void NativeCamera.setModel({model:next!});
}

function compactLandmarks(points: NormalizedLandmark[], mirror: boolean) { return points.map(({ x, y, z, visibility }) => ({ x: mirror ? 1 - x : x, y, z, visibility: visibility ?? 1 })); }
function draw(poses: NormalizedLandmark[][], hands: GestureCache): void { resizeCanvas(); context.clearRect(0, 0, canvas.width, canvas.height); const drawing = new DrawingUtils(context); const colors = ["#c8ff38", "#ff8bd8"];
  poses.forEach((pose, index) => { drawing.drawConnectors(pose, PoseLandmarker.POSE_CONNECTIONS, { color: colors[index], lineWidth: 3 }); drawing.drawLandmarks(pose, { color: "#fff", fillColor: "#0b1014", radius: 3 }); });
  for (const hand of hands) { drawing.drawLandmarks(hand.landmarks, { color: "#52e6e8", radius: 2 }); }
}
function resizeCanvas(): void { const width=activeNativeCamera?nativeFrameWidth:(video.videoWidth||960);const height=activeNativeCamera?nativeFrameHeight:(video.videoHeight||540);if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;} }
function applyMirror(): void { const transform = facingMode === "user" ? "scaleX(-1)" : "scaleX(1)"; video.style.transform = transform; canvas.style.transform = transform; }
function setConnection(state: ConnectionState): void { badge.className = `badge ${state}`; badge.querySelector("b")!.textContent = ({ offline: "未连接", connecting: "连接中", online: "已连接电脑", error: "连接异常" })[state]; }

async function stop(): Promise<void> { running = false; if (reconnectTimer != null) window.clearTimeout(reconnectTimer); socket?.close(); socket = null;
  if(nativeCameraEnabled){await NativeCamera.stopCamera().catch(()=>{});setNativePreview(false);activeNativeCamera=false;}
  clearWebCamera(); await stopVoiceControl();
  await wakeLock?.release().catch(() => {}); wakeLock = null; context.clearRect(0, 0, canvas.width, canvas.height); setupCard.classList.remove("hidden"); runtimeCard.classList.add("hidden"); document.querySelector("#guide")!.classList.add("hidden"); setConnection("offline"); }

async function flipCamera(): Promise<void> {
  if (cameraSwitching) return;
  cameraSwitching = true;
  const flipButton = document.querySelector<HTMLButtonElement>("#runtimeFlip")!;
  flipButton.disabled = true;
  const previousFacing = facingMode, previousId = selectedCameraDeviceId;
  const desired: "user" | "environment" = previousFacing === "environment" ? "user" : "environment";
  cameraLog(`switch start from=${previousFacing}/${previousId} to=${desired}`);
  try {
    facingMode = desired; selectedCameraDeviceId = "";
    if (running) { await startCamera(); }
    applyMirror();
    cameraLog(`switch finished facing=${facingMode} deviceId=${selectedCameraDeviceId}`);
  } catch (error) {
    facingMode = previousFacing; selectedCameraDeviceId = previousId;
    const message = error instanceof Error ? error.message : String(error);
    document.querySelector("#securityWarning")!.textContent = `切换镜头失败：${message}`;
    cameraLog(`switch failed: ${message}`);
    if (running) {
      try { await startCamera(); } catch (recoverError) {
        document.querySelector("#securityWarning")!.textContent = `切换失败且恢复失败：${recoverError instanceof Error ? recoverError.message : String(recoverError)}`;
      }
    }
    applyMirror();
  } finally {
    cameraSwitching = false;
    flipButton.disabled = false;
  }
}
function showRole(role: "home" | "camera" | "handheld"): void { activeRole = role;if(role!=="camera"||!activeNativeCamera)setNativePreview(false);roleCard.classList.toggle("hidden", role !== "home"); setupCard.classList.toggle("hidden", role !== "camera"); handheldCard.classList.toggle("hidden", role !== "handheld"); voiceControl.classList.toggle("hidden", role !== "camera"); document.querySelector("#pageTitle")!.textContent = role === "handheld" ? "手持手柄" : role === "camera" ? "摄像头" : "体感桥"; }

let sensorPolling = false;
async function sendHandheldFrame(): Promise<void> { if (sensorPolling || handheldSocket?.readyState !== WebSocket.OPEN) return; sensorPolling = true; try { const sample = await SensorBridge.getLatest(); const touches: Record<string, unknown>[] = [...padState].map((control) => ({control, pressed:true})); if (Math.abs(stickState.x) > .02 || Math.abs(stickState.y) > .02) touches.push({control:"stick",x:stickState.x,y:stickState.y}); handheldSocket.send(JSON.stringify({type:"sensor_frame",role:"sensor",device_id:deviceId,sequence:handheldSequence++,captured_at_ms:Date.now(),player_slot:Number(document.querySelector<HTMLSelectElement>("#handheldSlot")!.value),quaternion:{x:sample.qx,y:sample.qy,z:sample.qz,w:sample.qw},orientation:{},rotation_rate:{x:sample.gx,y:sample.gy,z:sample.gz},acceleration:{x:sample.ax,y:sample.ay,z:sample.az},touches,recenter:handheldRecenter})); if (handheldRecenter) { handheldRecenter=false; document.querySelector("#sensorState")!.textContent="已居中"; } handheldFrames++; const now=performance.now(); if(now-handheldFpsStarted>=1000){document.querySelector("#sensorFps")!.textContent=`${Math.round(handheldFrames*1000/(now-handheldFpsStarted))} FPS`;handheldFrames=0;handheldFpsStarted=now;} } catch (error) { document.querySelector("#sensorState")!.textContent=error instanceof Error?error.message:"传感器异常"; } finally { sensorPolling=false; } }
function clearTouches(): void { padState.clear(); stickState={x:0,y:0}; document.querySelector<HTMLElement>("#stick i")!.style.transform="translate(0,0)"; document.querySelectorAll("[data-pad]").forEach((el)=>el.classList.remove("pressed")); void sendHandheldFrame(); }
async function startHandheld(): Promise<void> { showRole("handheld"); try { await SensorBridge.start(); wakeLock=await navigator.wakeLock?.request("screen").catch(()=>null)??null; const address=handheldServerInput.value.trim()||serverInput.value.trim(); if(!address) throw new Error("请填写电脑服务器地址"); serverInput.value=address; localStorage.setItem("motionbridge-server",address); const url=normalizeSocketUrl(address); handheldSocket=new WebSocket(url); handheldSocket.addEventListener("open",()=>{document.querySelector("#handheldConnection")!.className="badge online";document.querySelector("#handheldConnection b")!.textContent="已连接电脑";document.querySelector("#sensorState")!.textContent="自然持握 1 秒";window.setTimeout(()=>{handheldRecenter=true;},1000);}); handheldSocket.addEventListener("message",(event)=>{const message=JSON.parse(event.data);if(message.type==="error"){document.querySelector("#sensorState")!.textContent=message.message||"连接失败";}}); handheldSocket.addEventListener("close",()=>{clearTouches();document.querySelector("#handheldConnection")!.className="badge error";document.querySelector("#handheldConnection b")!.textContent="电脑已断开";}); handheldTimer=window.setInterval(()=>void sendHandheldFrame(),16); } catch(error){document.querySelector("#sensorState")!.textContent=error instanceof Error?error.message:"传感器不可用";} }
async function stopHandheld(): Promise<void> { await stopVoiceControl(); clearTouches(); if(handheldTimer!=null)window.clearInterval(handheldTimer);handheldTimer=null;await new Promise((resolve)=>setTimeout(resolve,35));handheldSocket?.close();handheldSocket=null;await SensorBridge.stop().catch(()=>{});await wakeLock?.release().catch(()=>{});wakeLock=null;await NativeCamera.setDisplayMode({role:"home"}).catch(()=>{});showRole("home");setConnection("offline"); }
async function suspendHandheld(): Promise<void> { await stopVoiceControl(); clearTouches();if(handheldTimer!=null)window.clearInterval(handheldTimer);handheldTimer=null;await new Promise((resolve)=>setTimeout(resolve,35));handheldSocket?.close();handheldSocket=null;await SensorBridge.stop().catch(()=>{});document.querySelector("#sensorState")!.textContent="已暂停"; }
function updateStick(event: PointerEvent): void { const stick=document.querySelector<HTMLElement>("#stick")!;const rect=stick.getBoundingClientRect();const x=Math.max(-1,Math.min(1,(event.clientX-(rect.left+rect.width/2))/(rect.width*.38)));const y=Math.max(-1,Math.min(1,(event.clientY-(rect.top+rect.height/2))/(rect.height*.38)));stickState={x,y};stick.querySelector<HTMLElement>("i")!.style.transform=`translate(${x*34}px,${y*34}px)`; }

async function chooseCamera(deviceId: string): Promise<void> {
  if (cameraSwitching) return;
  cameraSwitching = true;
  const previousId = selectedCameraDeviceId, previousFacing = facingMode;
  cameraLog(`choose start deviceId=${deviceId}`);
  try {
    selectedCameraDeviceId = deviceId;
    if (nativeCameraOperational) {
      const camera = nativeCameras.find((item) => item.cameraId === deviceId);
      if (camera) facingMode = camera.facing === "front" ? "user" : "environment";
      localStorage.setItem("motionbridge-native-camera-last", deviceId);
    } else {
      const label = cameraDevices.find((item) => item.deviceId === deviceId)?.label.toLowerCase() || "";
      if (label.includes("front")) facingMode = "user";
      else if (label.includes("back")) facingMode = "environment";
    }
    cameraDeviceSelect.value = runtimeCameraDevice.value = deviceId;
    if (running) { await startCamera(); }
    applyMirror();
    cameraLog(`choose finished deviceId=${selectedCameraDeviceId} facing=${facingMode}`);
  } catch (error) {
    selectedCameraDeviceId = previousId; facingMode = previousFacing;
    cameraDeviceSelect.value = runtimeCameraDevice.value = previousId;
    const message = error instanceof Error ? error.message : String(error);
    document.querySelector("#securityWarning")!.textContent = `切换镜头失败：${message}`;
    cameraLog(`choose failed: ${message}`);
    if (running) {
      try { await startCamera(); } catch (recoverError) {
        document.querySelector("#securityWarning")!.textContent = `切换失败且恢复失败：${recoverError instanceof Error ? recoverError.message : String(recoverError)}`;
      }
    }
    applyMirror();
  } finally {
    cameraSwitching = false;
  }
}

document.querySelector("#cameraRole")!.addEventListener("click",()=>{void NativeCamera.setDisplayMode({role:"camera"}).catch(()=>{}).then(()=>{showRole("camera");return refreshCameraDevices();}).then(()=>startFramingPreview()).catch(()=>{});});
document.querySelector("#handheldRole")!.addEventListener("click",()=>{
  // Switching roles always releases the camera first; the handheld role must not
  // leave a Camera2 session or MediaPipe runtime alive in the background.
  void (running || activeNativeCamera || voiceEnabled ? stop() : Promise.resolve())
    .then(()=>NativeCamera.setDisplayMode({role:"handheld"}).catch(()=>{}))
    .then(()=>startHandheld());
});
document.querySelector("#cameraHome")!.addEventListener("click",()=>{void stop().then(()=>NativeCamera.setDisplayMode({role:"home"}).catch(()=>{})).then(()=>showRole("home"));});
document.querySelector("#startButton")!.addEventListener("click", () => void start()); document.querySelector("#stopButton")!.addEventListener("click", () => void stop());
for (const select of [cameraDeviceSelect, runtimeCameraDevice]) select.addEventListener("change", () => void chooseCamera(select.value));
voiceToggle.addEventListener("change", () => void (voiceToggle.checked ? startVoiceControl() : stopVoiceControl()));
document.querySelector("#centerSensor")!.addEventListener("click",()=>{handheldRecenter=true;document.querySelector("#sensorState")!.textContent="正在居中";});document.querySelector("#stopHandheld")!.addEventListener("click",()=>void stopHandheld());
document.querySelectorAll<HTMLElement>("[data-pad]").forEach((button)=>{button.addEventListener("pointerdown",(event)=>{event.preventDefault();button.setPointerCapture(event.pointerId);padState.add(button.dataset.pad!);button.classList.add("pressed");});const release=()=>{padState.delete(button.dataset.pad!);button.classList.remove("pressed");};button.addEventListener("pointerup",release);button.addEventListener("pointercancel",release);button.addEventListener("lostpointercapture",release);});
const stick=document.querySelector<HTMLElement>("#stick")!;stick.addEventListener("pointerdown",(event)=>{stick.setPointerCapture(event.pointerId);updateStick(event);});stick.addEventListener("pointermove",(event)=>{if(stick.hasPointerCapture(event.pointerId))updateStick(event);});const releaseStick=()=>{stickState={x:0,y:0};stick.querySelector<HTMLElement>("i")!.style.transform="translate(0,0)";};stick.addEventListener("pointerup",releaseStick);stick.addEventListener("pointercancel",releaseStick);
window.addEventListener("resize", resizeCanvas);
document.addEventListener("visibilitychange", () => { if(document.hidden&&voiceEnabled)void stopVoiceControl();if(document.hidden&&activeRole==="handheld")void suspendHandheld();if(document.visibilityState==="visible"&&activeRole==="handheld"&&handheldTimer==null)void startHandheld();if(document.visibilityState==="visible"&&running&&nativeCameraOperational)void startCamera().catch((error)=>alert(error instanceof Error?error.message:String(error))); if (document.visibilityState === "visible" && (running || activeRole==="handheld") && !wakeLock) void navigator.wakeLock?.request("screen").then((lock) => { wakeLock = lock; }).catch(() => {}); });
window.addEventListener("beforeunload",()=>{clearTouches();void stopVoiceControl();});
if(nativeCameraEnabled){void NativeCamera.addListener("poseResult",handleNativePoseFrame);void NativeCamera.addListener("cameraError",(event)=>{document.querySelector("#sendState")!.textContent=event.message;setNativePreview(false);activeNativeCamera=false;if(running){void NativeCamera.stopCamera().catch(()=>{});}});}
if(nativeCameraEnabled)void NativeCamera.setDisplayMode({role:"home"}).catch(()=>{});
if ("serviceWorker" in navigator && location.protocol !== "file:") void navigator.serviceWorker.register("./sw.js").catch(() => {});
