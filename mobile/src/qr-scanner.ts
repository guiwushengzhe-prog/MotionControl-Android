import jsQR from "jsqr";

/** 摄像头只在弹层存在时占用；取消、进后台、迟到的授权都会释放镜头。 */
export function scanConnectionCode(signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const panel = document.createElement("div"); panel.className = "connection-scanner";
    panel.innerHTML = '<section role="dialog" aria-modal="true" aria-label="扫码连接电脑"><h2>扫码连接电脑</h2><video autoplay playsinline muted></video><p>对准电脑上的连接二维码</p><button type="button">取消</button></section>';
    const video = panel.querySelector("video")!, cancel = panel.querySelector("button")!;
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true });
    let stream: MediaStream | null = null, timer: ReturnType<typeof setTimeout> | null = null, finished = false;
    const finish = (text: string | null, error?: unknown) => {
      if (finished) return; finished = true;
      clearTimeout(openTimeout); if (timer != null) clearTimeout(timer);
      stream?.getTracks().forEach(track => track.stop()); video.srcObject = null;
      signal.removeEventListener("abort", aborted); document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", keydown); panel.remove();
      if (error) reject(error); else resolve(text);
    };
    const aborted = () => finish(null);
    const visibility = () => { if (document.hidden) finish(null); };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") finish(null); };
    const openTimeout = setTimeout(() => finish(null, new Error("摄像头打开超时，请重试")), 8000);
    signal.addEventListener("abort", aborted); document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", keydown); cancel.addEventListener("click", aborted);
    if (signal.aborted || document.hidden) { finish(null); return; }
    document.body.append(panel);
    const decode = () => {
      if (finished) return;
      try {
        if (video.readyState >= 2 && video.videoWidth && context) {
          const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const qr = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "dontInvert" });
          if (qr) { finish(qr.data); return; }
        }
        timer = setTimeout(decode, 180);
      } catch (error) { finish(null, error); }
    };
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then(async opened => {
      if (finished) { opened.getTracks().forEach(track => track.stop()); return; }
      stream = opened; video.srcObject = stream;
      await video.play(); if (finished) return;
      clearTimeout(openTimeout); decode();
    }).catch(error => finish(null, error));
  });
}
