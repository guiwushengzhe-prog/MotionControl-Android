export type StudioRequest = { type: "studio_video_request_v1"; enabled: boolean; fps?: number; max_width?: number };
/** 只复用当前相机原始画面；不打开相机、不绘制人体框、不保留视频队列。 */
export class StudioVideo {
  constructor(private readonly deviceId = "") {}
  private socket: WebSocket | null = null;
  private generation = 0;
  private lastFrameAt = -Infinity;
  private interval = 1000 / 12;
  private maxSide = 640;
  private sequence = 0;
  private busy = false;
  private canvas: HTMLCanvasElement | null = null;
  get active(): boolean { return this.socket !== null; }
  request(raw: StudioRequest, socket: WebSocket, allowed: boolean): void {
    this.stop();
    if (raw.enabled !== true || !allowed || socket.readyState !== WebSocket.OPEN) return;
    this.socket = socket;
    this.interval = Math.max(80, 1000 / Math.max(1, Math.min(12, Number(raw.fps) || 12)));
    this.maxSide = Math.max(160, Math.min(640, Number(raw.max_width) || 640));
  }
  stop(): void { this.generation++; this.socket = null; this.busy = false; this.lastFrameAt = -Infinity; }
  frame(video: HTMLVideoElement, capturedAtMs: number, now: number, allowed: boolean, activeSocket: WebSocket | null): void {
    const ws = this.socket;
    if (!allowed || !ws || ws !== activeSocket || ws.readyState !== WebSocket.OPEN) { if (ws) this.stop(); return; }
    if (this.busy || now - this.lastFrameAt < this.interval || ws.bufferedAmount > 4 * 1024 || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    this.lastFrameAt = now; this.busy = true;
    const generation = this.generation;
    this.canvas ||= document.createElement("canvas");
    const scale = Math.min(1, this.maxSide / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
    this.canvas.width = width; this.canvas.height = height;
    try {
      this.canvas.getContext("2d", { alpha: false })!.drawImage(video, 0, 0, width, height);
      this.canvas.toBlob(blob => {
        if (!blob || generation !== this.generation) { if (generation === this.generation) this.busy = false; return; }
        const reader = new FileReader();
        const done = () => { if (generation === this.generation) this.busy = false; };
        reader.onerror = done; reader.onabort = done;
        reader.onload = () => {
          if (generation === this.generation && this.socket === ws && ws === activeSocket && !document.hidden && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= 4 * 1024) {
            const jpeg = String(reader.result || "").split(",")[1];
            if (jpeg) { try { ws.send(JSON.stringify({ type: "studio_video_frame_v1", device_id: this.deviceId, sequence: this.sequence++, captured_at_ms: capturedAtMs, width, height, jpeg })); } catch { this.stop(); } }
          }
          done();
        };
        reader.readAsDataURL(blob);
      }, "image/jpeg", 0.68);
    } catch { this.busy = false; }
  }
}
