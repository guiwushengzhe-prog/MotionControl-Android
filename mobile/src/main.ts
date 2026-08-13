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
  start(): Promise<{sampleRate:number;channels:number;format:string;source:string}>; stop(): Promise<void>;
  addListener(eventName:"audioData", listener:(event:{pcm:string;byteLength:number;rms:number})=>void):Promise<PluginListenerHandle>;
  addListener(eventName:"audioError", listener:(event:{message:string})=>void):Promise<PluginListenerHandle>;
};
const NativeAudio = registerPlugin<NativeAudioApi>("NativeAudio");
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
let nativeCameraOperational = nativeCameraEnabled;
let activeNativeCamera = false;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <video id="camera" autoplay playsinline muted></video><canvas id="overlay"></canvas><div class="shade"></div>
  <header><div><p>MOTIONBRIDGE 0.4.3</p><h1 id="pageTitle">体感桥</h1></div><div id="connectionBadge" class="badge"><i></i><b>未连接</b></div></header>
  <main>
    <section class="setup-card role-card" id="roleCard"><h2>选择角色</h2><div class="role-grid"><button id="cameraRole">摄像头</button><button id="handheldRole">手持手柄</button></div></section>
    <section class="setup-card hidden" id="setupCard">
      <div class="card-head"><h2>摄像头</h2><button id="cameraHome" class="text-button">返回首页</button></div>
      <label>电脑服务器地址<input id="serverUrl" inputmode="url" autocomplete="url" placeholder="ws://电脑地址:8765/ws/input"></label>
      <label>镜头<select id="cameraDeviceSelect"><option value="">后置镜头</option></select></label>
      <label>识别精度<select id="precisionSelect"><option value="auto">自动</option><option value="lite">流畅</option><option value="full">均衡</option><option value="heavy">精确</option></select></label>
      <div class="actions"><button id="startButton">开始识别</button><button id="retryVoice" class="secondary hidden">重新授权 / 开启语音</button></div>
      <p class="warning" id="securityWarning"></p>
    </section>
    <section class="runtime-card hidden" id="runtimeCard">
      <div><strong id="cameraFps">0</strong><small>相机 FPS</small></div><div><strong id="localFps">0</strong><small>识别 FPS</small></div><div><strong id="sendState">等待人体</strong><small>识别</small></div><div><strong id="modelGrade">—</strong><small>当前模型</small></div><div class="voice-diagnostic"><strong id="micState">未连接</strong><small>语音</small><em id="micDetail">尚未采集</em></div>
      <label class="runtime-select">镜头<select id="runtimeCameraDevice"><option value="">后置镜头</option></select></label>
      <label class="runtime-select">识别精度<select id="runtimePrecision"><option value="auto">自动</option><option value="lite">流畅</option><option value="full">均衡</option><option value="heavy">精确</option></select></label>
      <button id="runtimeFlip" class="secondary">切换镜头</button><button id="runtimeRetryVoice" class="secondary hidden">开启语音</button><button id="stopButton" class="stop">停止识别</button>
    </section>
    <section class="handheld-card hidden" id="handheldCard"><div class="handheld-top"><span id="handheldConnection" class="badge"><i></i><b>未连接</b></span><label>绑定玩家<select id="handheldSlot"><option value="0">玩家一</option><option value="1">玩家二</option></select></label><span><b id="sensorFps">0 FPS</b><small id="sensorState">等待传感器</small></span><button id="centerSensor">重新居中</button><button id="stopHandheld" class="stop">停止手柄</button></div><div class="shoulders"><button data-pad="l">L</button><button data-pad="zl">ZL</button><button data-pad="zr">ZR</button><button data-pad="r">R</button></div><div class="gamepad"><div id="stick" class="stick"><i></i></div><div class="middle-buttons"><button data-pad="select">选择</button><button data-pad="start">开始</button></div><div class="face-buttons"><button data-pad="y">Y</button><button data-pad="x">X</button><button data-pad="b">B</button><button data-pad="a">A</button></div></div></section>
  </main>
  <div class="guide hidden" id="guide"></div>
  <div class="loading hidden" id="loading"><i></i><b id="loadingText">正在加载识别模型…</b></div>`;

const video = document.querySelector<HTMLVideoElement>("#camera")!;
const canvas = document.querySelector<HTMLCanvasElement>("#overlay")!;
const context = canvas.getContext("2d")!;
const serverInput = document.querySelector<HTMLInputElement>("#serverUrl")!;
const cameraDeviceSelect = document.querySelector<HTMLSelectElement>("#cameraDeviceSelect")!;
const runtimeCameraDevice = document.querySelector<HTMLSelectElement>("#runtimeCameraDevice")!;
const roleCard = document.querySelector<HTMLElement>("#roleCard")!;
const setupCard = document.querySelector<HTMLElement>("#setupCard")!;
const runtimeCard = document.querySelector<HTMLElement>("#runtimeCard")!;
const handheldCard = document.querySelector<HTMLElement>("#handheldCard")!;
const badge = document.querySelector<HTMLElement>("#connectionBadge")!;

function setNativePreview(active: boolean): void {
  document.documentElement.classList.toggle("native-preview", active);
  document.body.classList.toggle("native-preview", active);
}

let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let poseLandmarker: PoseLandmarker | null = null;
let gestureRecognizer: GestureRecognizer | null = null;
let stream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let socket: WebSocket | null = null;
let audioSocket: WebSocket | null = null;
let audioContext: AudioContext | null = null;
let audioProcessor: ScriptProcessorNode | null = null;
let audioSource: MediaStreamAudioSourceNode | null = null;
let nativeAudioDataListener: PluginListenerHandle | null = null;
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
let voiceState: "not_connected" | "connected" | "enabled" | "silent" | "unauthorized" | "failed" = "not_connected";
let microphoneSource = "unknown";
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

const deviceId = getDeviceId();
serverInput.value = localStorage.getItem("motionbridge-server") || getSuggestedServer();
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
function selectedPrecision(): PrecisionMode { return (localStorage.getItem(`${modelCacheKey()}-mode`) as PrecisionMode | null) || "auto"; }
function syncPrecisionControls(value: PrecisionMode): void { document.querySelector<HTMLSelectElement>("#precisionSelect")!.value = value; document.querySelector<HTMLSelectElement>("#runtimePrecision")!.value = value; }

async function selectPoseModel(force = false, requested?: PrecisionMode): Promise<void> {
  if (activeNativeCamera) {
    const mode = requested || selectedPrecision(); localStorage.setItem(`${modelCacheKey()}-mode`, mode); syncPrecisionControls(mode);
    const grade = mode === "auto" ? ((localStorage.getItem(`${modelCacheKey()}-native-auto`) as ModelGrade | null) || "full") : mode;
    await NativeCamera.setModel({model:grade}); showGrade(grade, mode === "auto" ? "自动选择" : "手动选择"); return;
  }
  document.querySelector("#loading")!.classList.remove("hidden");
  const mode = requested || selectedPrecision(); localStorage.setItem(`${modelCacheKey()}-mode`, mode); syncPrecisionControls(mode);
  const cached = force ? null : localStorage.getItem(`${modelCacheKey()}-auto`) as ModelGrade | null;
  if (mode !== "auto") {
    poseLandmarker?.close(); poseLandmarker = await createPose(mode); showGrade(mode, "手动选择");
  } else if (cached && ["lite", "full", "heavy"].includes(cached)) {
    poseLandmarker?.close(); poseLandmarker = await createPose(cached); showGrade(cached, "自动选择");
  } else {
    const results: { grade: ModelGrade; fps: number; p95: number }[] = [];
    for (const grade of ["lite", "full", "heavy"] as ModelGrade[]) {
      document.querySelector("#loadingText")!.textContent = `正在为 ${grade} 模型测速 4 秒…`;
      const candidate = await createPose(grade); const samples: number[] = []; const started = performance.now(); let frames = 0;
      while (performance.now() - started < 4000) {
        const t = performance.now(); candidate.detectForVideo(video, t); samples.push(performance.now() - t); frames++;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      candidate.close(); samples.sort((a, b) => a - b);
      results.push({ grade, fps: frames / 4, p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))] || 999 });
    }
    const valid = results.filter((item) => item.fps >= 15 && item.p95 <= 60);
    const chosen = (valid.at(-1) || results[0]).grade;
    localStorage.setItem(`${modelCacheKey()}-auto`, chosen); localStorage.setItem(`${modelCacheKey()}-results`, JSON.stringify(results));
    poseLandmarker?.close(); poseLandmarker = await createPose(chosen); showGrade(chosen, results.map((r) => `${r.grade}:${r.fps.toFixed(0)}fps/P95 ${r.p95.toFixed(0)}ms`).join(" · "));
  }
  await loadGesture();
  document.querySelector("#loading")!.classList.add("hidden");
}

function showGrade(grade: ModelGrade, title: string): void {
  currentModel = grade; const label = document.querySelector<HTMLElement>("#modelGrade")!; label.textContent = ({ lite: "流畅", full: "均衡", heavy: "精确" })[grade]; label.title = title;
}

async function start(): Promise<void> {
  try {
    const socketUrl = normalizeSocketUrl(serverInput.value); serverInput.value = socketUrl; localStorage.setItem("motionbridge-server", socketUrl);
    setConnection("connecting");
    if(activeNativeCamera){
      const mode=selectedPrecision();const grade=mode==="auto"?((localStorage.getItem(`${modelCacheKey()}-native-auto`) as ModelGrade|null)||"lite"):mode;
      await NativeCamera.enableInference({model:grade});showGrade(grade,mode==="auto"?"自动选择":"手动选择");
    }else{await startCamera();if(!activeNativeCamera)await selectPoseModel();}
    running = true; activeRole = "camera"; setupCard.classList.add("hidden"); runtimeCard.classList.remove("hidden"); document.querySelector("#guide")!.classList.remove("hidden"); applyMirror();
    connectSocket(socketUrl); void startMicrophone(socketUrl);
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
    if (!descriptor) {nativeCameraOperational=false;} else {
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
      document.querySelector("#securityWarning")!.textContent=`原生相机不可用，已切换兼容模式${lastError instanceof Error?`：${lastError.message}`:""}`;nativeCameraOperational=false;
    }
  }
  activeNativeCamera=false;activeNativeCameraId="";selectedCameraDeviceId="";setNativePreview(false);
  clearWebCamera();
  const source = selectedCameraDeviceId ? { deviceId: { exact: selectedCameraDeviceId } } : { facingMode: { ideal: facingMode } };
  stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...source, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30, max: 30 } } });
  const track = stream.getVideoTracks()[0]; const settings = track.getSettings();
  if (settings.deviceId) selectedCameraDeviceId = settings.deviceId;
  if (settings.facingMode === "user" || settings.facingMode === "environment") facingMode = settings.facingMode;
  video.style.display = "block";video.srcObject = stream; await video.play(); await refreshCameraDevices(); resizeCanvas(); applyMirror();
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
    } catch(error){nativeCameraOperational=false;document.querySelector("#securityWarning")!.textContent=`原生相机不可用，使用兼容模式${error instanceof Error?`：${error.message}`:""}`;}
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
  socket.addEventListener("open", () => { setConnection("online"); syncClock(); });
  socket.addEventListener("close", () => { setConnection("offline"); if (running) reconnectTimer = window.setTimeout(() => connectSocket(url), 1500); });
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

async function startMicrophone(inputUrl: string): Promise<void> {
  try {
    await stopMicrophone();
    setMicState("not_connected");
    audioSocket = new WebSocket(normalizeSocketUrl(inputUrl, "/ws/audio")); audioSocket.binaryType = "arraybuffer";
    if (nativeCameraEnabled) {
      const format = await NativeAudio.start(); microphoneSource = format.source;
      nativeAudioDataListener = await NativeAudio.addListener("audioData", (event) => {
        if (audioSocket?.readyState !== WebSocket.OPEN || audioSocket.bufferedAmount > 128000) return;
        audioSocket.send(base64ToArrayBuffer(event.pcm));
        updateMicDetail(`手机音量 ${Math.round(event.rms)}`);
      });
      nativeAudioErrorListener = await NativeAudio.addListener("audioError", (event) => { updateMicDetail(event.message); setMicState("failed"); });
    } else {
      microphoneSource = "web_audio";
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      audioContext = new AudioContext({latencyHint:"interactive"}); await audioContext.resume();
      audioSource = audioContext.createMediaStreamSource(micStream); audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      audioProcessor.onaudioprocess = (event) => { if (audioSocket?.readyState !== WebSocket.OPEN || audioSocket.bufferedAmount > 128000) return; const input = event.inputBuffer.getChannelData(0); const pcm=resample(input, audioContext!.sampleRate, 16000); audioSocket.send(floatToPcm16(pcm)); updateMicDetail(`手机音量 ${Math.round(floatRms(pcm)*32767)}`); };
      audioSource.connect(audioProcessor); audioProcessor.connect(audioContext.destination);
    }
    audioSocket.addEventListener("open", () => { setMicState("connected"); audioSocket?.send(JSON.stringify({ type: "audio_start", device_id: deviceId, sample_rate: 16000, input_sample_rate: audioContext?.sampleRate||16000, channels: 1, format: "pcm16le", source: microphoneSource })); });
    audioSocket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.type === "audio_ready") { setMicState("connected"); updateMicDetail(message.recognizer_mode === "grammar" ? `命令词识别已就绪（${message.grammar_count || 0} 条）` : "开放语音识别已就绪"); } else if(message.type==="audio_level"){setMicState(message.audio_active?"enabled":message.stream_alive?"silent":"connected");updateMicDetail(message.audio_active?`有效音量 ${Math.round(message.rms)}`:"未听到声音，请靠近麦克风");} else if(message.type==="voice_partial"){updateMicDetail(`听到：${message.text}`);} else if(message.type==="voice_final"){updateMicDetail(`识别：${message.text}`);} else if(message.type==="voice_result"){updateMicDetail(message.ok?`已执行：${voiceCommandName(message.command)}`:`未执行：${message.message||message.text}`);} else if (message.type === "error") { updateMicDetail(message.message||"语音错误"); setMicState("failed"); } });
    audioSocket.addEventListener("error", () => setMicState("failed"));
    audioSocket.addEventListener("close", () => { if (running && !["unauthorized","failed"].includes(voiceState)) { setMicState("failed"); updateMicDetail("音频已断开，保持命令已释放"); } });
  } catch (error) { const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name); setMicState(denied ? "unauthorized" : "failed"); console.warn(error); }
}

async function stopMicrophone():Promise<void>{audioSocket?.close();audioSocket=null;micStream?.getTracks().forEach((track)=>track.stop());micStream=null;audioProcessor?.disconnect();audioSource?.disconnect();audioProcessor=null;audioSource=null;await audioContext?.close().catch(()=>{});audioContext=null;await nativeAudioDataListener?.remove().catch(()=>{});await nativeAudioErrorListener?.remove().catch(()=>{});nativeAudioDataListener=nativeAudioErrorListener=null;if(nativeCameraEnabled)await NativeAudio.stop().catch(()=>{});}
function setMicState(value: typeof voiceState): void { voiceState = value; const text = ({not_connected:"未连接",connected:"通道已连接",enabled:"声音有效",silent:"没有听到声音",unauthorized:"麦克风未授权",failed:"语音连接失败"})[value]; document.querySelector("#micState")!.textContent = text; document.querySelector("#retryVoice")!.classList.toggle("hidden", !["unauthorized","failed"].includes(value)); document.querySelector("#runtimeRetryVoice")!.classList.toggle("hidden", !["unauthorized","failed"].includes(value)); }
function updateMicDetail(text:string):void{document.querySelector("#micDetail")!.textContent=text;}
function base64ToArrayBuffer(value:string):ArrayBuffer{const binary=atob(value),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes.buffer;}
function floatRms(input:Float32Array):number{let sum=0;for(const sample of input)sum+=sample*sample;return Math.sqrt(sum/Math.max(1,input.length));}
function voiceCommandName(command:string):string{return({start:"开始",stop:"停止",left:"向左",right:"向右",jump:"跳跃",emergency_stop:"紧急停止"} as Record<string,string>)[command]||command||"命令";}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input; const length = Math.max(1, Math.round(input.length * to / from)); const output = new Float32Array(length);
  for (let i = 0; i < length; i++) { const position = i * from / to; const left = Math.floor(position); const right = Math.min(input.length - 1, left + 1); const mix = position - left; output[i] = input[left] * (1 - mix) + input[right] * mix; }
  return output;
}

function floatToPcm16(input: Float32Array): ArrayBuffer {
  const result = new Int16Array(input.length); for (let i = 0; i < input.length; i++) result[i] = Math.round(Math.max(-1, Math.min(1, input[i])) * 32767); return result.buffer;
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
      width: video.videoWidth, height: video.videoHeight, camera_facing: facingMode, camera_id: selectedCameraDeviceId||"logical", orientation_degrees: 0, preview_mirrored: facingMode === "user", coordinates_mirrored: false, actual_model: currentModel, voice_state: voiceState,
      poses: poseResult.landmarks.map((pose, index) => ({ detection_id: null, pose: compact(pose), world_pose: poseResult.worldLandmarks[index] ? compactLandmarks(poseResult.worldLandmarks[index], false) : null })),
      hands: gestureCache.map((hand) => ({ handedness: hand.handedness, landmarks: compact(hand.landmarks), gesture: hand.gesture, gesture_score: hand.gesture_score })), inference_ms: elapsed }));
    document.querySelector("#sendState")!.textContent = poseResult.landmarks.length ? `发送 ${poseResult.landmarks.length} 人` : "等待人体";
  } else if (!poseResult.landmarks.length) document.querySelector("#sendState")!.textContent = "等待人体";
  if (performance.now() - lastClockSyncAt > 5000) syncClock(); frameCounter++; fpsCounter++;
  if (now - fpsStarted >= 1000) { const fps=Math.round(fpsCounter * 1000 / (now - fpsStarted));document.querySelector("#cameraFps")!.textContent=String(fps);document.querySelector("#localFps")!.textContent = String(fps); fpsCounter = 0; fpsStarted = now; }
}

function handleNativePoseFrame(frame: NativePoseFrame): void {
  if (!running) return;
  nativeFrameWidth=frame.width;nativeFrameHeight=frame.height;facingMode=frame.facing==="front"?"user":"environment";currentModel=frame.actualModel;
  lastNativePoseCount=frame.poseCount??frame.poses.length;lastPoseDiagnostics=frame.poseDiagnostics;
  draw(frame.poses.map((item)=>item.pose),frame.hands); document.querySelector("#cameraFps")!.textContent=String(Math.round(frame.previewFps||frame.captureFps));document.querySelector("#localFps")!.textContent=String(Math.round(frame.inferenceFps||0));
  if(socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount<256000){
    socket.send(JSON.stringify({type:"pose_frame_v2",role:"camera",device_id:deviceId,sequence:sequence++,captured_at_ms:frame.capturedAtMs+serverClockOffsetMs,sent_at_ms:Date.now()+serverClockOffsetMs,width:frame.width,height:frame.height,camera_facing:facingMode,camera_id:frame.cameraId,orientation_degrees:0,preview_mirrored:frame.previewMirrored,coordinates_mirrored:false,actual_model:frame.actualModel,voice_state:voiceState,pose_diagnostics:frame.poseDiagnostics,poses:frame.poses,hands:frame.hands,inference_ms:frame.inferenceMs}));
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
  clearWebCamera(); await stopMicrophone();
  await wakeLock?.release().catch(() => {}); wakeLock = null; context.clearRect(0, 0, canvas.width, canvas.height); setupCard.classList.remove("hidden"); runtimeCard.classList.add("hidden"); document.querySelector("#guide")!.classList.add("hidden"); setMicState("not_connected"); setConnection("offline"); }

async function flipCamera(): Promise<void> {
  const previousFacing=facingMode, previousId=selectedCameraDeviceId;
  const desired: "user" | "environment" = previousFacing === "environment" ? "user" : "environment";
  const target=nativeCameras.find((item)=>item.available&&item.facing===(desired==="user"?"front":"back"));
  if(nativeCameraOperational&&!target){document.querySelector("#securityWarning")!.textContent=desired==="user"?"前置镜头不可用":"后置镜头不可用";return;}
  facingMode=desired;selectedCameraDeviceId=nativeCameraOperational?target!.cameraId:"";syncPrecisionControls(selectedPrecision());
  try{if(running){await startCamera();if(!activeNativeCamera)await selectPoseModel();}applyMirror();}
  catch(error){facingMode=previousFacing;selectedCameraDeviceId=previousId;document.querySelector("#securityWarning")!.textContent=`切换镜头失败：${error instanceof Error?error.message:String(error)}`;if(running)await startCamera();applyMirror();}
}
function showRole(role: "home" | "camera" | "handheld"): void { activeRole = role;if(role!=="camera"||!activeNativeCamera)setNativePreview(false);roleCard.classList.toggle("hidden", role !== "home"); setupCard.classList.toggle("hidden", role !== "camera"); handheldCard.classList.toggle("hidden", role !== "handheld"); document.querySelector("#pageTitle")!.textContent = role === "handheld" ? "手持手柄" : role === "camera" ? "摄像头" : "体感桥"; }

let sensorPolling = false;
async function sendHandheldFrame(): Promise<void> { if (sensorPolling || handheldSocket?.readyState !== WebSocket.OPEN) return; sensorPolling = true; try { const sample = await SensorBridge.getLatest(); const touches: Record<string, unknown>[] = [...padState].map((control) => ({control, pressed:true})); if (Math.abs(stickState.x) > .02 || Math.abs(stickState.y) > .02) touches.push({control:"stick",x:stickState.x,y:stickState.y}); handheldSocket.send(JSON.stringify({type:"sensor_frame",role:"sensor",device_id:deviceId,sequence:handheldSequence++,captured_at_ms:Date.now(),player_slot:Number(document.querySelector<HTMLSelectElement>("#handheldSlot")!.value),quaternion:{x:sample.qx,y:sample.qy,z:sample.qz,w:sample.qw},orientation:{},rotation_rate:{x:sample.gx,y:sample.gy,z:sample.gz},acceleration:{x:sample.ax,y:sample.ay,z:sample.az},touches,recenter:handheldRecenter})); if (handheldRecenter) { handheldRecenter=false; document.querySelector("#sensorState")!.textContent="已居中"; } handheldFrames++; const now=performance.now(); if(now-handheldFpsStarted>=1000){document.querySelector("#sensorFps")!.textContent=`${Math.round(handheldFrames*1000/(now-handheldFpsStarted))} FPS`;handheldFrames=0;handheldFpsStarted=now;} } catch (error) { document.querySelector("#sensorState")!.textContent=error instanceof Error?error.message:"传感器异常"; } finally { sensorPolling=false; } }
function clearTouches(): void { padState.clear(); stickState={x:0,y:0}; document.querySelector<HTMLElement>("#stick i")!.style.transform="translate(0,0)"; document.querySelectorAll("[data-pad]").forEach((el)=>el.classList.remove("pressed")); void sendHandheldFrame(); }
async function startHandheld(): Promise<void> { showRole("handheld"); try { await SensorBridge.start(); wakeLock=await navigator.wakeLock?.request("screen").catch(()=>null)??null; const url=normalizeSocketUrl(serverInput.value); handheldSocket=new WebSocket(url); handheldSocket.addEventListener("open",()=>{document.querySelector("#handheldConnection")!.className="badge online";document.querySelector("#handheldConnection b")!.textContent="已连接";document.querySelector("#sensorState")!.textContent="自然持握 1 秒";window.setTimeout(()=>{handheldRecenter=true;},1000);}); handheldSocket.addEventListener("message",(event)=>{const message=JSON.parse(event.data);if(message.type==="error"){document.querySelector("#sensorState")!.textContent=message.message||"绑定失败";}}); handheldSocket.addEventListener("close",()=>{clearTouches();document.querySelector("#handheldConnection")!.className="badge error";document.querySelector("#handheldConnection b")!.textContent="已断开";}); handheldTimer=window.setInterval(()=>void sendHandheldFrame(),16); } catch(error){document.querySelector("#sensorState")!.textContent=error instanceof Error?error.message:"传感器不可用";} }
async function stopHandheld(): Promise<void> { clearTouches(); if(handheldTimer!=null)window.clearInterval(handheldTimer);handheldTimer=null;await new Promise((resolve)=>setTimeout(resolve,35));handheldSocket?.close();handheldSocket=null;await SensorBridge.stop().catch(()=>{});await wakeLock?.release().catch(()=>{});wakeLock=null;await NativeCamera.setDisplayMode({role:"home"}).catch(()=>{});showRole("home");setConnection("offline"); }
async function suspendHandheld(): Promise<void> { clearTouches();if(handheldTimer!=null)window.clearInterval(handheldTimer);handheldTimer=null;await new Promise((resolve)=>setTimeout(resolve,35));handheldSocket?.close();handheldSocket=null;await SensorBridge.stop().catch(()=>{});document.querySelector("#sensorState")!.textContent="已暂停"; }
function updateStick(event: PointerEvent): void { const stick=document.querySelector<HTMLElement>("#stick")!;const rect=stick.getBoundingClientRect();const x=Math.max(-1,Math.min(1,(event.clientX-(rect.left+rect.width/2))/(rect.width*.38)));const y=Math.max(-1,Math.min(1,(event.clientY-(rect.top+rect.height/2))/(rect.height*.38)));stickState={x,y};stick.querySelector<HTMLElement>("i")!.style.transform=`translate(${x*34}px,${y*34}px)`; }

async function chooseCamera(deviceId: string): Promise<void> {
  selectedCameraDeviceId = deviceId;
  if(nativeCameraOperational){const camera=nativeCameras.find((item)=>item.cameraId===deviceId);if(camera)facingMode=camera.facing==="front"?"user":"environment";localStorage.setItem("motionbridge-native-camera-last",deviceId);}else{const label = cameraDevices.find((item) => item.deviceId === deviceId)?.label.toLowerCase() || "";if (label.includes("front")) facingMode = "user"; else if (label.includes("back")) facingMode = "environment";}
  cameraDeviceSelect.value = runtimeCameraDevice.value = deviceId;
  if (running) { await startCamera(); if(!activeNativeCamera)await selectPoseModel(); }
  applyMirror();
}

document.querySelector("#cameraRole")!.addEventListener("click",()=>{void NativeCamera.setDisplayMode({role:"camera"}).catch(()=>{}).then(()=>{showRole("camera");syncPrecisionControls(selectedPrecision());return refreshCameraDevices();}).then(()=>startFramingPreview()).catch(()=>{});});
document.querySelector("#handheldRole")!.addEventListener("click",()=>{void NativeCamera.setDisplayMode({role:"handheld"}).catch(()=>{}).then(()=>startHandheld());});
document.querySelector("#cameraHome")!.addEventListener("click",()=>{void stop().then(()=>NativeCamera.setDisplayMode({role:"home"}).catch(()=>{})).then(()=>showRole("home"));});
document.querySelector("#startButton")!.addEventListener("click", () => void start()); document.querySelector("#stopButton")!.addEventListener("click", () => void stop());
document.querySelector("#runtimeFlip")!.addEventListener("click", () => void flipCamera());
for (const select of [cameraDeviceSelect, runtimeCameraDevice]) select.addEventListener("change", () => void chooseCamera(select.value));
for(const id of ["precisionSelect","runtimePrecision"]){document.querySelector<HTMLSelectElement>(`#${id}`)!.addEventListener("change",(event)=>{const value=(event.target as HTMLSelectElement).value as PrecisionMode;syncPrecisionControls(value);localStorage.setItem(`${modelCacheKey()}-mode`,value);if(running)void selectPoseModel(false,value);});}
for(const id of ["retryVoice","runtimeRetryVoice"]){document.querySelector(`#${id}`)!.addEventListener("click",()=>{void startMicrophone(normalizeSocketUrl(serverInput.value));});}
document.querySelector("#centerSensor")!.addEventListener("click",()=>{handheldRecenter=true;document.querySelector("#sensorState")!.textContent="正在居中";});document.querySelector("#stopHandheld")!.addEventListener("click",()=>void stopHandheld());
document.querySelectorAll<HTMLElement>("[data-pad]").forEach((button)=>{button.addEventListener("pointerdown",(event)=>{event.preventDefault();button.setPointerCapture(event.pointerId);padState.add(button.dataset.pad!);button.classList.add("pressed");});const release=()=>{padState.delete(button.dataset.pad!);button.classList.remove("pressed");};button.addEventListener("pointerup",release);button.addEventListener("pointercancel",release);button.addEventListener("lostpointercapture",release);});
const stick=document.querySelector<HTMLElement>("#stick")!;stick.addEventListener("pointerdown",(event)=>{stick.setPointerCapture(event.pointerId);updateStick(event);});stick.addEventListener("pointermove",(event)=>{if(stick.hasPointerCapture(event.pointerId))updateStick(event);});const releaseStick=()=>{stickState={x:0,y:0};stick.querySelector<HTMLElement>("i")!.style.transform="translate(0,0)";};stick.addEventListener("pointerup",releaseStick);stick.addEventListener("pointercancel",releaseStick);
window.addEventListener("resize", resizeCanvas);
document.addEventListener("visibilitychange", () => { if(document.hidden&&activeRole==="handheld")void suspendHandheld();if(document.visibilityState==="visible"&&activeRole==="handheld"&&handheldTimer==null)void startHandheld();if(document.visibilityState==="visible"&&running&&nativeCameraOperational)void startCamera().catch((error)=>alert(error instanceof Error?error.message:String(error))); if (document.visibilityState === "visible" && (running || activeRole==="handheld") && !wakeLock) void navigator.wakeLock?.request("screen").then((lock) => { wakeLock = lock; }).catch(() => {}); });
window.addEventListener("beforeunload",clearTouches);
if(nativeCameraEnabled){void NativeCamera.addListener("poseResult",handleNativePoseFrame);void NativeCamera.addListener("cameraError",(event)=>{document.querySelector("#sendState")!.textContent=event.message;setNativePreview(false);activeNativeCamera=false;if(running){nativeCameraOperational=false;void NativeCamera.stopCamera().catch(()=>{}).then(()=>startCamera()).then(()=>selectPoseModel()).catch(()=>{});}});}
if(nativeCameraEnabled)void NativeCamera.setDisplayMode({role:"home"}).catch(()=>{});
if ("serviceWorker" in navigator && location.protocol !== "file:") void navigator.serviceWorker.register("./sw.js").catch(() => {});
