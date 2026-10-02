import { describe, expect, it } from "vitest";
import { SessionCancelled, SessionGeneration, SocketLiveness, optionalSensorFresh, sampleCapturedAt, sensorSampleFresh } from "./session";

describe("asynchronous device sessions", () => {
  it("discards a late resource after stop and preserves the replacement session", async () => {
    const gate = new SessionGeneration();
    const oldSession = gate.next();
    let resolve!: (resource: { close(): void }) => void;
    const pending = new Promise<{ close(): void }>((done) => { resolve = done; });
    let currentResource: unknown;
    let closed = 0;
    const opening = gate.resolveResource(oldSession, pending, resource => resource.close()).then((resource) => {
      currentResource = resource;
    }).catch(error => { expect(error).toBeInstanceOf(SessionCancelled); });
    gate.next(); // stop invalidates in-flight camera/model work
    const replacement = { close() {} };
    currentResource = replacement;
    resolve({ close() { closed++; } });
    await opening;
    expect(closed).toBe(1);
    expect(currentResource).toBe(replacement);
    expect(() => gate.assertCurrent(oldSession)).toThrow(SessionCancelled);
  });
  it("accepts the current resource and disposes a superseded model exactly once", async () => {
    const gate = new SessionGeneration();
    const modelA = gate.next();
    let release!: (resource: { close(): void }) => void;
    const pending = new Promise<{ close(): void }>(done => { release = done; });
    const old = gate.resolveResource(modelA, pending, model => model.close());
    const rejected = expect(old).rejects.toBeInstanceOf(SessionCancelled);
    const modelB = gate.next();
    let disposed = 0;
    const current = { close() { disposed++; } };
    expect(await gate.resolveResource(modelB, Promise.resolve(current), model => model.close())).toBe(current);
    release({ close() { disposed++; } });
    await rejected;
    expect(disposed).toBe(1);
  });
  it("prevents old socket events from belonging to a newly opened session", () => {
    const gate = new SessionGeneration();
    const socketA = gate.next();
    const socketB = gate.next();
    expect(gate.isCurrent(socketA)).toBe(false);
    expect(gate.isCurrent(socketB)).toBe(true);
  });
});

describe("socket recovery", () => {
  it("expires a handshake and an open connection even when TCP does not close", () => {
    const connecting = new SocketLiveness(0);
    expect(connecting.check(4999)).toBe("wait");
    expect(connecting.check(5000)).toBe("timeout");
    const live = new SocketLiveness(0);
    live.open(100);
    expect(live.check(3100)).toBe("ping");
    expect(live.check(8100)).toBe("timeout");
  });
  it("keeps a responsive connection alive without requiring a detected body", () => {
    const live = new SocketLiveness(0);
    live.open(0);
    for (const now of [3000, 6000, 9000, 12000]) {
      expect(live.check(now)).toBe("ping");
      live.response(now + 5);
    }
    expect(live.check(15000)).toBe("ping");
  });
});

describe("native sample freshness", () => {
  it("omits uninitialized optional native samples and accepts legacy missing ages", () => {
    for (const age of [-1, NaN, Infinity, 151]) expect(optionalSensorFresh(true, age)).toBe(false);
    expect(optionalSensorFresh(false, 0)).toBe(false);
    expect(optionalSensorFresh(true, 150)).toBe(true);
    expect(optionalSensorFresh(undefined, undefined)).toBe(true);
  });
  it("retains sampling delay instead of relabeling old input as captured now", () => {
    expect(sampleCapturedAt(1000, 40)).toBe(960);
    expect(sampleCapturedAt(1000, undefined)).toBe(1000);
    expect(sampleCapturedAt(1000, Infinity)).toBe(1000);
  });
  it("neutralizes missing/stale required sensors while retaining old APK support", () => {
    expect(sensorSampleFresh({ running: false })).toBe(false);
    expect(sensorSampleFresh({ running: true, sample_age_ms: 151 })).toBe(false);
    expect(sensorSampleFresh({ running: true, sample_age_ms: 10, rotationAvailable: false, rotation_age_ms: -1 }, true)).toBe(false);
    expect(sensorSampleFresh({ running: true, sample_age_ms: 10, rotationAvailable: true, rotation_age_ms: 10 }, true)).toBe(true);
    expect(sensorSampleFresh({ running: true }, true)).toBe(true);
  });
});
