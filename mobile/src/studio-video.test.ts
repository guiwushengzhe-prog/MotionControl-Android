import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioVideo } from "./studio-video";
function harness() {
  let blobCallback: ((blob: Blob | null) => void) | null = null;
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toBlob: vi.fn((callback: (blob: Blob | null) => void) => { blobCallback = callback; }) };
  const doc = { hidden: false, createElement: () => canvas };
  vi.stubGlobal("document", doc); vi.stubGlobal("WebSocket", { OPEN: 1 });
  vi.stubGlobal("FileReader", class { result = "data:image/jpeg;base64,aGVsbG8="; onload: (() => void) | null = null; readAsDataURL() { this.onload?.(); } });
  const ws = { readyState: 1, bufferedAmount: 0, send: vi.fn() } as any;
  const video = { readyState: 2, videoWidth: 1080, videoHeight: 1920 } as HTMLVideoElement;
  return { canvas, ws, video, done: () => blobCallback?.(new Blob(["jpeg"])), doc };
}
afterEach(() => vi.unstubAllGlobals());
describe("按需手机视频", () => {
  it("未请求不发，最长边640，限频且不重复编码忙碌帧", () => {
    const h = harness(), sender = new StudioVideo();
    sender.frame(h.video, 10, 0, true, h.ws); expect(h.canvas.toBlob).not.toHaveBeenCalled();
    sender.request({ type: "studio_video_request_v1", enabled: true, fps: 12, max_width: 640 }, h.ws, true);
    sender.frame(h.video, 10, 0, true, h.ws); sender.frame(h.video, 20, 100, true, h.ws);
    expect(h.canvas.toBlob).toHaveBeenCalledTimes(1); expect(h.canvas.width).toBe(360); expect(h.canvas.height).toBe(640);
    h.done(); expect(JSON.parse(h.ws.send.mock.calls[0][0])).toMatchObject({ type: "studio_video_frame_v1", captured_at_ms: 10, jpeg: "aGVsbG8=", width: 360, height: 640 });
    sender.frame(h.video, 30, 70, true, h.ws); expect(h.canvas.toBlob).toHaveBeenCalledTimes(1);
  });
  it("停止、背景或更换连接时取消迟到的编码结果", () => {
    const h = harness(), sender = new StudioVideo();
    sender.request({ type: "studio_video_request_v1", enabled: true }, h.ws, true);
    sender.frame(h.video, 10, 0, true, h.ws); sender.stop(); h.done(); expect(h.ws.send).not.toHaveBeenCalled();
    sender.request({ type: "studio_video_request_v1", enabled: true }, h.ws, true);
    sender.frame(h.video, 20, 100, true, h.ws); h.doc.hidden = true; h.done(); expect(h.ws.send).not.toHaveBeenCalled();
  });
  it("缓冲拥塞丢帧，不积压、不切换到另一个连接发送", () => {
    const h = harness(), sender = new StudioVideo();
    sender.request({ type: "studio_video_request_v1", enabled: true }, h.ws, true);
    h.ws.bufferedAmount = 200 * 1024; sender.frame(h.video, 10, 0, true, h.ws);
    expect(h.canvas.toBlob).not.toHaveBeenCalled();
    h.ws.bufferedAmount = 0; sender.frame(h.video, 20, 100, true, {} as WebSocket);
    sender.frame(h.video, 30, 200, true, h.ws); expect(h.canvas.toBlob).not.toHaveBeenCalled();
  });
});
