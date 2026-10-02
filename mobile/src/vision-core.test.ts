import { describe, expect, it } from "vitest";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { handCropBox, inferenceSize, packHandCrop } from "./vision-core";

describe("shared pose and hand geometry", () => {
  it("preserves the aspect ratio and adaptive side without upscaling small images", () => {
    expect(inferenceSize(480, 640, 512)).toEqual({ width: 384, height: 512 });
    expect(inferenceSize(640, 480, 384)).toEqual({ width: 384, height: 288 });
    expect(inferenceSize(200, 100, 512)).toEqual({ width: 200, height: 100 });
  });
  it("crops each anatomical wrist independently and restores its 21 points to full-image coordinates", () => {
    const points: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: 1 }));
    points[13] = { x: .3, y: .6, z: 0, visibility: 1 }; points[15] = { x: .2, y: .4, z: 0, visibility: 1 };
    points[14] = { x: .7, y: .6, z: 0, visibility: 1 }; points[16] = { x: .8, y: .4, z: 0, visibility: 1 };
    const left = handCropBox(points, "left", 384, 512)!, right = handCropBox(points, "right", 384, 512)!;
    expect(left.sx).toBe(0); expect(right.sx).toBeCloseTo(384 - right.side); expect(left.sy).toBeCloseTo(right.sy);
    const fingers = Array.from({ length: 21 }, () => ({ x: .5, y: .5, z: -.1, visibility: 1 }));
    const packed = packHandCrop(fingers, "right", right, 384, 512)!;
    expect(packed.handedness).toBe("Right"); expect(packed.points).toHaveLength(21);
    expect(packed.points[0]).toEqual([
      Math.round((right.sx + right.side / 2) / 384 * 10000) / 10000,
      Math.round((right.sy + right.side / 2) / 512 * 10000) / 10000,
      Math.round(-.1 * right.side / 384 * 10000) / 10000, 1,
    ]);
    expect(packHandCrop(fingers.slice(0, 20), "right", right, 384, 512)).toBeNull();
  });
  it("omits a hand when its forearm cannot define a crop", () => {
    expect(handCropBox([], "left", 384, 512)).toBeNull();
    const points = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: 1 }));
    expect(handCropBox(points, "left", 384, 512)).toBeNull();
  });
});
