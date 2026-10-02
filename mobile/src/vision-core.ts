import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

export type HandSide = "left" | "right";
export type PackedHand = { handedness: "Left" | "Right"; points: number[][] };
export const HAND_CROP_SIDE = 256;
const POSE_WRIST: Record<HandSide, number> = { left: 15, right: 16 };
const POSE_ELBOW: Record<HandSide, number> = { left: 13, right: 14 };
export type HandCrop = { sx: number; sy: number; side: number };

export function inferenceSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Shared by the worker and compatibility path: neither changes handedness or
// the wrist/elbow crop geometry when choosing a different execution backend.
export function handCropBox(points: readonly NormalizedLandmark[], side: HandSide, width: number, height: number): HandCrop | null {
  const elbow = points[POSE_ELBOW[side]], wrist = points[POSE_WRIST[side]];
  if (!elbow || !wrist) return null;
  const dx = (wrist.x - elbow.x) * width, dy = (wrist.y - elbow.y) * height;
  const forearm = Math.hypot(dx, dy);
  if (forearm < 8) return null;
  const box = Math.min(Math.max(forearm * 1.5, 48), Math.min(width, height));
  return {
    sx: Math.min(Math.max(wrist.x * width + dx * .35 - box / 2, 0), width - box),
    sy: Math.min(Math.max(wrist.y * height + dy * .35 - box / 2, 0), height - box),
    side: box,
  };
}

const round = (value: number) => Math.round(value * 10000) / 10000;
export function packHandCrop(landmarks: readonly NormalizedLandmark[] | undefined, side: HandSide,
    box: HandCrop, width: number, height: number): PackedHand | null {
  if (!landmarks || landmarks.length !== 21) return null;
  return { handedness: side === "left" ? "Left" : "Right", points: landmarks.map(point => [
    round((box.sx + point.x * box.side) / width), round((box.sy + point.y * box.side) / height),
    round(point.z * box.side / width), 1,
  ]) };
}
