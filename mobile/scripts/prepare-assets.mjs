import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const publicRoot = resolve("public");
const wasmSource = resolve("node_modules/@mediapipe/tasks-vision/wasm");
const wasmTarget = resolve(publicRoot, "wasm");
const modelTarget = resolve(publicRoot, "models");

await mkdir(wasmTarget, { recursive: true });
await mkdir(modelTarget, { recursive: true });

for (const filename of [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
]) {
  await copyFile(resolve(wasmSource, filename), resolve(wasmTarget, filename));
}

// These files belong to a newer packaging layout. Leaving stale copies in
// public/ makes it too easy to accidentally ship mismatched loader/binary pairs.
for (const obsolete of [
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
]) {
  await unlink(resolve(wasmTarget, obsolete)).catch(() => {});
}

for (const filename of [
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.wasm",
]) {
  const path = resolve(wasmTarget, filename);
  const bytes = await readFile(path);
  if (bytes.byteLength < 1_000_000) {
    throw new Error(`WASM is unexpectedly small: ${filename}`);
  }
  try {
    await WebAssembly.compile(bytes);
  } catch (error) {
    throw new Error(`WASM failed structural validation: ${filename}`, { cause: error });
  }
}

const models = [
  {
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    filename: "pose_landmarker_lite.task",
  },
  {
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    filename: "pose_landmarker_full.task",
  },
  {
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
    filename: "pose_landmarker_heavy.task",
  },
  {
    url: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
    filename: "gesture_recognizer.task",
  },
];

for (const model of models) {
  const destination = resolve(modelTarget, model.filename);
  try {
    const info = await stat(destination);
    if (info.size > 1_000_000) continue;
  } catch {
    // Download below.
  }
  const temporary = `${destination}.download`;
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`Failed to download ${basename(destination)}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1_000_000) throw new Error(`Downloaded model is unexpectedly small: ${basename(destination)}`);
  await unlink(temporary).catch(() => {});
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  process.stdout.write(`Downloaded ${model.filename} (${bytes.byteLength} bytes)\n`);
}
