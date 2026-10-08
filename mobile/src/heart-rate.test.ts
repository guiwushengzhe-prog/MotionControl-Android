import { describe, expect, it } from "vitest";
import { HeartRateFeed, SEND_INTERVAL_MS, STALE_MS } from "./heart-rate";

describe("手环心率读数", () => {
  it("新鲜的才显示，过了几秒没有新读数就消失", () => {
    const feed = new HeartRateFeed();
    expect(feed.receive({ bpm: 128, at: 1000, device: "手环" })).toBe(true);
    expect(feed.bpm(1000 + STALE_MS)).toBe(128);
    expect(feed.bpm(1001 + STALE_MS)).toBeNull();
  });
  it("每秒最多发一次给电脑，过期的不发", () => {
    const feed = new HeartRateFeed();
    feed.receive({ bpm: 100, at: 0, device: "" });
    expect(feed.takeSend(0)?.bpm).toBe(100);
    feed.receive({ bpm: 101, at: 400, device: "" });
    expect(feed.takeSend(400)).toBeNull();
    feed.receive({ bpm: 102, at: SEND_INTERVAL_MS, device: "" });
    expect(feed.takeSend(SEND_INTERVAL_MS)?.bpm).toBe(102);
    expect(feed.takeSend(SEND_INTERVAL_MS * 2 + STALE_MS)).toBeNull();
  });
  it("不合理的读数和迟到的旧读数不收", () => {
    const feed = new HeartRateFeed();
    expect(feed.receive({ bpm: 0, at: 1, device: "" })).toBe(false);
    expect(feed.receive({ bpm: 300, at: 1, device: "" })).toBe(false);
    expect(feed.receive({ bpm: 90.5, at: 1, device: "" })).toBe(false);
    feed.receive({ bpm: 90, at: 2000, device: "" });
    expect(feed.receive({ bpm: 95, at: 1000, device: "" })).toBe(false);
    expect(feed.bpm(2000)).toBe(90);
  });
});
