/** Async work may finish after a user has stopped or switched the device. */
export class SessionGeneration {
  private generation = 0;
  get current(): number { return this.generation; }
  next(): number { return ++this.generation; }
  isCurrent(generation: number): boolean { return generation === this.generation; }
  assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new SessionCancelled();
  }
  async resolveResource<T>(generation: number, pending: Promise<T>, dispose: (resource: T) => void): Promise<T> {
    const resource = await pending;
    if (!this.isCurrent(generation)) { dispose(resource); throw new SessionCancelled(); }
    return resource;
  }
}

export class SessionCancelled extends Error {
  constructor() { super("操作已取消"); this.name = "SessionCancelled"; }
}

export function isSessionCancelled(error: unknown): boolean {
  return error instanceof SessionCancelled || (error as { code?: string } | null)?.code === "START_CANCELLED";
}

/** A stalled TCP socket may stay OPEN. Require a server response as well. */
export class SocketLiveness {
  private opened = false;
  private lastResponse: number;
  private lastPing: number;
  constructor(private readonly startedAt: number, private readonly connectTimeout = 5000,
              private readonly responseTimeout = 8000, private readonly pingInterval = 3000) {
    this.lastResponse = this.lastPing = startedAt;
  }
  open(now: number): void { this.opened = true; this.lastResponse = this.lastPing = now; }
  response(now: number): void { this.lastResponse = now; }
  check(now: number): "wait" | "ping" | "timeout" {
    if (!this.opened) return now - this.startedAt >= this.connectTimeout ? "timeout" : "wait";
    if (now - this.lastResponse >= this.responseTimeout) return "timeout";
    if (now - this.lastPing >= this.pingInterval) { this.lastPing = now; return "ping"; }
    return "wait";
  }
}

/** Native ages are elapsed times; timestamps use Android's monotonic clock. */
export function sampleCapturedAt(now: number, sampleAgeMs: unknown): number {
  return typeof sampleAgeMs === "number" && Number.isFinite(sampleAgeMs) && sampleAgeMs >= 0
    ? now - sampleAgeMs : now;
}

/** Missing optional samples are omitted, so gyro calibration can use its fallback. */
export function optionalSensorFresh(available: boolean | undefined, ageMs: number | undefined): boolean {
  if (available === false) return false;
  return ageMs === undefined || (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 150);
}

export function sensorSampleFresh(sample: { running: boolean; rotationAvailable?: boolean;
    sample_age_ms?: number; rotation_age_ms?: number }, requireRotation = false): boolean {
  if (!sample.running) return false;
  if (sample.sample_age_ms !== undefined && (!Number.isFinite(sample.sample_age_ms) || sample.sample_age_ms < 0 || sample.sample_age_ms > 150)) return false;
  // Older APKs do not report per-sensor ages. Keep their existing behavior.
  if (requireRotation && sample.rotation_age_ms !== undefined) {
    return sample.rotationAvailable === true && Number.isFinite(sample.rotation_age_ms)
      && sample.rotation_age_ms >= 0 && sample.rotation_age_ms <= 150;
  }
  return true;
}
