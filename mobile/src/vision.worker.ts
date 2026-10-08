import { FilesetResolver, GestureRecognizer, PoseLandmarker } from "@mediapipe/tasks-vision";
import { HAND_CROP_SIDE, handCropBox, inferenceSize, packHandCrop, type PackedHand } from "./vision-core";
import type { VisionFrame, VisionInit, VisionRequest, VisionResponse } from "./vision-protocol";

// The MediaPipe WASM loader calls importScripts. This entry is bundled as a
// classic IIFE worker; module workers cannot execute that loader.
const scope = self as unknown as { onmessage: (event: MessageEvent<VisionRequest>) => void; postMessage(message: VisionResponse): void };
let pose: PoseLandmarker | null = null, hand: GestureRecognizer | null = null;
let files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
let options: VisionInit;
let delegate: "GPU" | "CPU" = "CPU";
let handFailed = false;
let handError: string | undefined;
let handRequested = false;
let handGeneration = 0;
let handTask: Promise<void> | null = null;
let frameBusy = false;
const image = new OffscreenCanvas(1, 1), imageContext = image.getContext("2d", { alpha: false })!;
const crop = new OffscreenCanvas(HAND_CROP_SIDE, HAND_CROP_SIDE), cropContext = crop.getContext("2d")!;

async function initialize(init: VisionInit): Promise<void> {
  options = init; files = await FilesetResolver.forVisionTasks(init.wasmBaseUrl);
  const create = (choice: "GPU" | "CPU") => PoseLandmarker.createFromOptions(files, {
    canvas: new OffscreenCanvas(1, 1), baseOptions: { modelAssetPath: init.poseModelUrl, delegate: choice },
    runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: .55, minPosePresenceConfidence: .55, minTrackingConfidence: .55,
  });
  let fallbackError: string | null = null;
  if (!init.cpuOnly) {
    try { pose = await create("GPU"); delegate = "GPU"; }
    catch (error) { fallbackError = error instanceof Error ? error.message : String(error); }
  }
  if (!pose) { pose = await create("CPU"); delegate = "CPU"; }
  scope.postMessage({ type: "ready", delegate, fallbackError });
}
async function loadHand(generation: number): Promise<void> {
  let loaded: GestureRecognizer | null = null;
  const current = () => generation === handGeneration && handRequested;
  const create = (choice: "GPU" | "CPU") => GestureRecognizer.createFromOptions(files, {
    canvas: new OffscreenCanvas(1, 1), baseOptions: { modelAssetPath: options.handModelUrl, delegate: choice },
    runningMode: "IMAGE", numHands: 1,
  });
  try {
    try { loaded = await create(delegate); }
    catch (error) {
      if (!current()) return;
      if (delegate !== "GPU") throw error;
      loaded = await create("CPU");
    }
    if (!current()) { loaded.close(); loaded = null; return; }
    hand = loaded; loaded = null;
  }
  catch (error) {
    loaded?.close();
    if (current()) { handFailed = true; handError = "手部模型暂不可用，身体识别仍可使用"; }
  }
}
function configureHands(enabled: boolean): void {
  if (!enabled) {
    if (handRequested) handGeneration++;
    handRequested = false; hand?.close(); hand = null; handFailed = false; handError = undefined;
    return;
  }
  handRequested = true;
  if (!pose || hand || handFailed || handTask) return;
  const task = loadHand(handGeneration); handTask = task;
  void task.finally(() => { if (handTask === task) handTask = null; });
}
async function infer(frame: VisionFrame): Promise<void> {
  if (frameBusy || !pose) { frame.bitmap.close(); throw new Error("视觉线程收到并行帧"); }
  frameBusy = true;
  let bitmapOwned = true;
  const started = performance.now();
  try {
    // Model fetch/loading is independent of the pose stream. A slow hand fetch
    // must not hold the current body frame or form a queue of camera frames.
    configureHands(frame.hands.length > 0);
    const copyStarted = performance.now();
    const size = inferenceSize(frame.bitmap.width, frame.bitmap.height, frame.inferenceSide);
    if (image.width !== size.width || image.height !== size.height) { image.width = size.width; image.height = size.height; }
    imageContext.drawImage(frame.bitmap, 0, 0, image.width, image.height); frame.bitmap.close(); bitmapOwned = false;
    const copyMs = performance.now() - copyStarted;
    const poseStarted = performance.now(), result = pose.detectForVideo(image, frame.timestampMs);
    const poseMs = performance.now() - poseStarted, handsStarted = performance.now();
    const packedHands: PackedHand[] = [];
    if (hand && result.landmarks[0]) for (const side of [...new Set(frame.hands)]) {
      const box = handCropBox(result.landmarks[0], side, image.width, image.height);
      if (!box) continue;
      cropContext.drawImage(image, box.sx, box.sy, box.side, box.side, 0, 0, HAND_CROP_SIDE, HAND_CROP_SIDE);
      const packed = packHandCrop(hand.recognize(crop).landmarks[0], side, box, image.width, image.height);
      if (packed) packedHands.push(packed);
    }
    scope.postMessage({ type: "result", id: frame.id, landmarks: result.landmarks, worldLandmarks: result.worldLandmarks,
      hands: packedHands, timings: { copyMs, poseMs, handsMs: performance.now() - handsStarted, totalMs: performance.now() - started },
      handState: !handRequested ? "idle" : hand ? "ready" : handFailed ? "error" : "loading",
      ...(handError ? { handError } : {}) });
  } finally { if (bitmapOwned) frame.bitmap.close(); frameBusy = false; }
}
scope.onmessage = event => {
  const message = event.data;
  if (message.type === "hands") { configureHands(message.enabled); return; }
  void (message.type === "init" ? initialize(message) : infer(message)).catch(error => {
    scope.postMessage({ type: "error", ...(message.type === "frame" ? { id: message.id } : {}),
      message: error instanceof Error ? error.message : String(error) });
  });
};
