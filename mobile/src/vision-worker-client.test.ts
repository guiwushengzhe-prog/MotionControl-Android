import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisionWorkerClient } from "./vision-worker-client";
import { SessionCancelled } from "./session";
import type { VisionFrameInput, VisionInit, VisionResult } from "./vision-protocol";

class WorkerStub extends EventTarget {
  postMessage = vi.fn(); terminate = vi.fn();
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
const init: VisionInit = { type: "init", wasmBaseUrl: "/wasm", poseModelUrl: "/full.task", handModelUrl: "/hand.task", cpuOnly: false };
const frame = (capturedAtMs: number): VisionFrameInput => ({
  bitmap: { close: vi.fn() } as unknown as ImageBitmap, timestampMs: capturedAtMs - 1000, capturedAtMs,
  width: 480, height: 640, inferenceSide: 512, hands: ["left", "right"],
});
const result = (id: number): VisionResult => ({ type: "result", id, landmarks: [], worldLandmarks: [], hands: [],
  timings: { copyMs: 1, poseMs: 20, handsMs: 10, totalMs: 31 } });
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("latest-frame worker pipeline", () => {
  it("keeps the running frame and only the newest waiting bitmap, preserving capture metadata", async () => {
    const worker = new WorkerStub(), publish = vi.fn();
    const client = new VisionWorkerClient(worker, init, publish, vi.fn());
    worker.receive({ type: "ready", delegate: "GPU", fallbackError: null }); await client.ready;
    const first = frame(1000), skipped = frame(1033), latest = frame(1066);
    client.submit(first, { capturedAtMs: first.capturedAtMs });
    client.submit(skipped, { capturedAtMs: skipped.capturedAtMs });
    client.submit(latest, { capturedAtMs: latest.capturedAtMs });
    expect(worker.postMessage).toHaveBeenCalledTimes(2); // init + one transfer
    expect(skipped.bitmap.close).toHaveBeenCalledOnce(); expect(client.droppedFrames).toBe(1);
    worker.receive(result(1));
    expect(publish.mock.calls[0][0]).toEqual({ capturedAtMs: 1000 });
    expect(worker.postMessage.mock.calls[2][0]).toMatchObject({ id: 3, capturedAtMs: 1066, timestampMs: 66, hands: ["left", "right"] });
    expect(worker.postMessage.mock.calls[2][1]).toEqual([latest.bitmap]);
    worker.receive(result(3)); expect(publish.mock.calls[1][0]).toEqual({ capturedAtMs: 1066 });
    client.close();
  });
  it("ignores unmatched and stopped worker responses, and disposes pending frames on stop", async () => {
    const worker = new WorkerStub(), publish = vi.fn();
    const client = new VisionWorkerClient(worker, init, publish, vi.fn());
    worker.receive({ type: "ready", delegate: "CPU", fallbackError: null }); await client.ready;
    client.submit(frame(1000), "old"); const waiting = frame(1033); client.submit(waiting, "waiting");
    worker.receive(result(99)); expect(publish).not.toHaveBeenCalled();
    client.close(); client.close(); worker.receive(result(1));
    expect(publish).not.toHaveBeenCalled(); expect(waiting.bitmap.close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    const late = frame(1066); client.submit(late, "late"); expect(late.bitmap.close).toHaveBeenCalledOnce();
  });
  it("releases frames from a superseded camera source without stopping the worker", async () => {
    const worker = new WorkerStub(), client = new VisionWorkerClient(worker, init, vi.fn(), vi.fn());
    worker.receive({ type: "ready", delegate: "CPU", fallbackError: null }); await client.ready;
    client.submit(frame(1000), 1); const waiting = frame(1033); client.submit(waiting, 1);
    client.clearPending(); worker.receive(result(1));
    expect(waiting.bitmap.close).toHaveBeenCalledOnce(); expect(worker.postMessage).toHaveBeenCalledTimes(2);
    client.submit(frame(1066), 2); expect(worker.postMessage).toHaveBeenCalledTimes(3); client.close();
  });
  it("terminates startup promptly when cancellation arrives before model loading completes", async () => {
    const worker = new WorkerStub(), client = new VisionWorkerClient(worker, init, vi.fn(), vi.fn());
    const rejected = expect(client.ready).rejects.toBeInstanceOf(SessionCancelled);
    client.close(); worker.receive({ type: "ready", delegate: "GPU", fallbackError: null });
    await rejected; expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("bounds startup and a stalled inference without repeatedly invoking recovery", async () => {
    const worker = new WorkerStub(), fatal = vi.fn();
    const client = new VisionWorkerClient(worker, init, vi.fn(), fatal, { initMs: 100, frameMs: 50 });
    worker.receive({ type: "ready", delegate: "GPU", fallbackError: null }); await client.ready;
    client.submit(frame(1000), null); const pending = frame(1033); client.submit(pending, null);
    await vi.advanceTimersByTimeAsync(200);
    expect(fatal).toHaveBeenCalledOnce(); expect(fatal.mock.calls[0][0].message).toContain("推理超时");
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(pending.bitmap.close).toHaveBeenCalledOnce();
    const neverReady = new WorkerStub(), startup = new VisionWorkerClient(neverReady, init, vi.fn(), fatal, { initMs: 100, frameMs: 50 });
    const rejected = expect(startup.ready).rejects.toThrow("初始化超时");
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(neverReady.terminate).toHaveBeenCalledOnce(); expect(fatal).toHaveBeenCalledOnce();
  });
  it("disposes an untransferred bitmap when the browser rejects postMessage", async () => {
    const worker = new WorkerStub(), fatal = vi.fn();
    const client = new VisionWorkerClient(worker, init, vi.fn(), fatal);
    worker.receive({ type: "ready", delegate: "GPU", fallbackError: null }); await client.ready;
    worker.postMessage.mockImplementationOnce(() => { throw new Error("bitmap transfer unavailable"); });
    const rejected = frame(1000); client.submit(rejected, null);
    expect(rejected.bitmap.close).toHaveBeenCalledOnce(); expect(fatal).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
