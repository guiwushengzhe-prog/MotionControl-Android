import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { HandSide, PackedHand } from "./vision-core";

export type VisionInit = { type: "init"; wasmBaseUrl: string; poseModelUrl: string; handModelUrl: string; cpuOnly: boolean };
export type VisionReady = { type: "ready"; delegate: "GPU" | "CPU"; fallbackError: string | null };
export type VisionFrameInput = { bitmap: ImageBitmap; timestampMs: number; capturedAtMs: number;
  width: number; height: number; inferenceSide: number; hands: HandSide[] };
export type VisionFrame = VisionFrameInput & { type: "frame"; id: number };
export type VisionResult = { type: "result"; id: number; landmarks: NormalizedLandmark[][];
  worldLandmarks: NormalizedLandmark[][]; hands: PackedHand[];
  timings: { copyMs: number; poseMs: number; handsMs: number; totalMs: number };
  handState?: "idle" | "loading" | "ready" | "error"; handError?: string };
export type VisionError = { type: "error"; id?: number; message: string };
export type VisionRequest = VisionInit | VisionFrame;
export type VisionResponse = VisionReady | VisionResult | VisionError;
