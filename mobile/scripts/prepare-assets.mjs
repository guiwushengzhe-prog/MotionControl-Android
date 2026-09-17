import { copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const publicRoot = resolve("public");
const wasmSource = resolve("node_modules/@mediapipe/tasks-vision/wasm");
const wasmTarget = resolve(publicRoot, "wasm");
const modelTarget = resolve(publicRoot, "models");

await mkdir(wasmTarget, { recursive: true });
await mkdir(modelTarget, { recursive: true });

// The non-SIMD pair is a fallback for WebViews older than Chrome 91.  It is
// deliberately not shipped: it costs 9 MB and every device this runs on has
// had WASM SIMD for years.
for (const filename of [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
]) {
  await copyFile(resolve(wasmSource, filename), resolve(wasmTarget, filename));
}

// These files belong to a newer packaging layout. Leaving stale copies in
// public/ makes it too easy to accidentally ship mismatched loader/binary pairs.
for (const obsolete of [
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
]) {
  await unlink(resolve(wasmTarget, obsolete)).catch(() => {});
}

for (const filename of [
  "vision_wasm_internal.wasm",
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

const modelFiles = [
  "pose_landmarker_full.task",
  // Hand steering reads the fist from finger joints. Without this file the app
  // still runs -- it falls back to the pose model's three fingertips -- but
  // that fallback cannot tell an open hand from a fist at all, so a build
  // missing it is a broken build, not a smaller one.
  "hand_landmarker.task",
];

// MotionControl 1.00 is local-first/offline. Never download models during a build.
// Keep the already-provisioned public/models files; if a previous Android
// sync contains them, it can restore a missing public copy.
const androidModelFallback = resolve("android/app/src/main/assets/public/models");
for (const filename of modelFiles) {
  const destination = resolve(modelTarget, filename);
  let valid = false;
  try { valid = (await stat(destination)).size > 1_000_000; } catch { valid = false; }
  if (valid) continue;

  const fallback = resolve(androidModelFallback, filename);
  try {
    if ((await stat(fallback)).size > 1_000_000) {
      await copyFile(fallback, destination);
      process.stdout.write(`Restored local ${filename} from Android assets\n`);
      continue;
    }
  } catch { /* handled below */ }

  throw new Error(
    `Missing local model ${filename}. Put the verified model in public/models before building; 1.00 does not download models automatically.`
  );
}
