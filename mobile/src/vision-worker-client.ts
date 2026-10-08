import { SessionCancelled } from "./session";
import type { VisionFrameInput, VisionInit, VisionReady, VisionResponse, VisionResult } from "./vision-protocol";

type WorkerPort = Pick<Worker, "postMessage" | "addEventListener" | "removeEventListener" | "terminate">;
type Pending<T> = { id: number; frame: VisionFrameInput; context: T; queuedAt: number; dispatchedAt: number };

export function supportsVisionWorker(): boolean {
  return typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function";
}

/** One in-flight frame and one replaceable latest frame; never a FIFO backlog. */
export class VisionWorkerClient<T> {
  readonly ready: Promise<VisionReady>;
  droppedFrames = 0;
  private resolveReady!: (value: VisionReady) => void;
  private rejectReady!: (error: unknown) => void;
  private initialized = false;
  private closed = false;
  private nextId = 0;
  private active: Pending<T> | null = null;
  private latest: Pending<T> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly worker: WorkerPort, init: VisionInit,
      private readonly onResult: (context: T, result: VisionResult, queueMs: number, roundTripMs: number) => void,
      private readonly onFatal: (error: Error) => void,
      private readonly timeouts = { initMs: 30000, frameMs: 8000 }) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    worker.addEventListener("message", this.message);
    worker.addEventListener("error", this.error);
    worker.addEventListener("messageerror", this.error);
    this.timer = setTimeout(() => this.fail(new Error("后台模型初始化超时")), timeouts.initMs);
    try { worker.postMessage(init); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
  submit(frame: VisionFrameInput, context: T): void {
    if (this.closed) { frame.bitmap.close(); return; }
    if (this.latest) { this.latest.frame.bitmap.close(); this.droppedFrames++; }
    this.latest = { id: ++this.nextId, frame, context, queuedAt: performance.now(), dispatchedAt: 0 };
    this.drain();
  }
  setHandsEnabled(enabled: boolean): void {
    if (!this.closed) this.worker.postMessage({ type: "hands", enabled });
    if (!enabled && this.latest) this.latest.frame.hands = [];
  }
  clearPending(): void {
    if (this.latest) { this.latest.frame.bitmap.close(); this.latest = null; this.droppedFrames++; }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer != null) clearTimeout(this.timer); this.timer = null;
    this.clearPending(); this.active = null;
    this.worker.removeEventListener("message", this.message);
    this.worker.removeEventListener("error", this.error);
    this.worker.removeEventListener("messageerror", this.error);
    this.worker.terminate();
    if (!this.initialized) this.rejectReady(new SessionCancelled());
  }
  private drain(): void {
    if (this.closed || !this.initialized || this.active || !this.latest) return;
    const pending = this.latest; this.latest = null; this.active = pending;
    pending.dispatchedAt = performance.now();
    this.timer = setTimeout(() => this.fail(new Error("后台视觉推理超时")), this.timeouts.frameMs);
    try { this.worker.postMessage({ type: "frame", id: pending.id, ...pending.frame }, [pending.frame.bitmap]); }
    catch (error) { pending.frame.bitmap.close(); this.fail(error instanceof Error ? error : new Error(String(error))); }
  }
  private readonly message = (event: Event): void => {
    if (this.closed) return;
    const result = (event as MessageEvent<VisionResponse>).data;
    if (result.type === "ready" && !this.initialized) {
      if (this.timer != null) clearTimeout(this.timer); this.timer = null;
      this.initialized = true; this.resolveReady(result); this.drain();
    } else if (result.type === "error") this.fail(new Error(result.message));
    else if (result.type === "result" && this.active?.id === result.id) {
      if (this.timer != null) clearTimeout(this.timer); this.timer = null;
      const pending = this.active; this.active = null;
      try { this.onResult(pending.context, result, pending.dispatchedAt - pending.queuedAt, performance.now() - pending.dispatchedAt); }
      finally { this.drain(); }
    }
  };
  private readonly error = (event: Event): void => this.fail(new Error((event as ErrorEvent).message || "后台视觉线程无法运行"));
  private fail(error: Error): void {
    if (this.closed) return;
    const initialized = this.initialized;
    if (!initialized) this.rejectReady(error);
    this.close();
    if (initialized) this.onFatal(error);
  }
}
