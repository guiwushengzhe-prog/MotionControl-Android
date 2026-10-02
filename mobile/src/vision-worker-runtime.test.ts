import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisionFrame, VisionInit, VisionResponse, VisionResult } from "./vision-protocol";

const mocks = vi.hoisted(() => ({ createPose: vi.fn(), createHand: vi.fn() }));
vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  PoseLandmarker: { createFromOptions: mocks.createPose }, HandLandmarker: { createFromOptions: mocks.createHand },
}));
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const points = () => {
  const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: 1 }));
  pose[13].x = .4; pose[15].x = .2; pose[14].x = .6; pose[16].x = .8; return pose;
};
const handModel = () => ({ close: vi.fn(), detect: vi.fn(() => ({ landmarks: [Array.from({ length: 21 }, () => ({ x: .5, y: .5, z: 0, visibility: 1 }))] })) });
let messages: VisionResponse[], scope: { postMessage: (message: VisionResponse) => void; onmessage: (event: MessageEvent) => void };
const init: VisionInit = { type: "init", wasmBaseUrl: "/wasm", poseModelUrl: "/full.task", handModelUrl: "/hand.task", cpuOnly: true };
function frame(id: number, hands: VisionFrame["hands"] = ["left", "right"]): VisionFrame {
  return { type: "frame", id, hands, timestampMs: id * 34, capturedAtMs: 1000 + id * 34, width: 480, height: 640,
    inferenceSide: 512, bitmap: { width: 384, height: 512, close: vi.fn() } as unknown as ImageBitmap };
}
const send = (message: VisionInit | VisionFrame) => scope.onmessage({ data: message } as MessageEvent);
const results = () => messages.filter((message): message is VisionResult => message.type === "result");
beforeEach(async () => {
  vi.resetModules(); messages = [];
  scope = { postMessage: message => messages.push(message), onmessage: () => {} };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("OffscreenCanvas", class { constructor(public width: number, public height: number) {} getContext() { return { drawImage: vi.fn() }; } });
  mocks.createPose.mockReset().mockResolvedValue({ close: vi.fn(), detectForVideo: () => ({ landmarks: [points()], worldLandmarks: [points()] }) });
  mocks.createHand.mockReset().mockImplementation(async () => handModel());
  await import("./vision.worker"); send(init); await flush();
});
afterEach(() => vi.unstubAllGlobals());

describe("worker hand loading and same-frame processing", () => {
  it("continues body inference during a pending hand model load and detects both crops once ready", async () => {
    const pending = deferred<ReturnType<typeof handModel>>(); mocks.createHand.mockReturnValueOnce(pending.promise);
    const first = frame(1); send(first); send(frame(2)); await flush();
    expect(first.bitmap.close).toHaveBeenCalledOnce();
    expect(results()).toHaveLength(2); expect(results()[0].landmarks[0]).toHaveLength(33);
    expect(results()[0].handState).toBe("loading"); expect(mocks.createHand).toHaveBeenCalledOnce();
    const model = handModel(); pending.resolve(model); await flush(); send(frame(3)); await flush();
    expect(results().at(-1)?.handState).toBe("ready"); expect(model.detect).toHaveBeenCalledTimes(2);
    expect(results().at(-1)?.hands.map(hand => hand.handedness)).toEqual(["Left", "Right"]);
    expect(results().at(-1)?.hands.every(hand => hand.points.length === 21)).toBe(true);
  });
  it("closes a hand model finishing after disable and can load a fresh model after re-enable", async () => {
    const pending = deferred<ReturnType<typeof handModel>>(), late = handModel();
    mocks.createHand.mockReturnValueOnce(pending.promise);
    send(frame(1)); send(frame(2, [])); pending.resolve(late); await flush();
    expect(late.close).toHaveBeenCalledOnce(); expect(results().at(-1)?.handState).toBe("idle");
    send(frame(3)); await flush(); send(frame(4)); await flush();
    expect(mocks.createHand).toHaveBeenCalledTimes(2); expect(results().at(-1)?.handState).toBe("ready");
  });
  it("bounds hand load failure until disable/re-enable explicitly requests another load", async () => {
    mocks.createHand.mockRejectedValueOnce(new Error("load failed"));
    send(frame(1)); await flush(); send(frame(2)); send(frame(3)); await flush();
    expect(mocks.createHand).toHaveBeenCalledOnce(); expect(results().at(-1)?.handState).toBe("error");
    expect(results().at(-1)?.landmarks[0]).toHaveLength(33);
    send(frame(4, [])); send(frame(5)); await flush(); send(frame(6)); await flush();
    expect(mocks.createHand).toHaveBeenCalledTimes(2); expect(results().at(-1)?.handState).toBe("ready");
  });
});
