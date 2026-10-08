import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * 手环心率：读手环、心率带的「心率广播」（标准蓝牙心率服务）。
 *
 * 只在用户打开「手环心率」、而且正在玩或者开着运动记录时才找设备；别的时候蓝牙一点
 * 不动。读到的心率在手机上大字显示，每秒最多发一次给电脑，由电脑并进这次运动记录。
 * 原厂应用和手环的连接一概不碰（见 HeartRatePlugin.java）。
 */

export type HeartRateState = "off" | "unsupported" | "bluetooth_off" | "location_off" | "permission"
  | "scanning" | "connecting" | "connected" | "error";
export type HeartRateStatus = { state: HeartRateState; message: string; device: string; wanted: boolean };
export type HeartRateReading = { bpm: number; at: number; device: string };

const NativeHeartRate = registerPlugin<{
  getStatus(): Promise<HeartRateStatus>;
  start(): Promise<HeartRateStatus>;
  stop(): Promise<HeartRateStatus>;
  addListener(event: "heartRate", listener: (reading: HeartRateReading) => void): Promise<PluginListenerHandle>;
  addListener(event: "heartRateState", listener: (status: HeartRateStatus) => void): Promise<PluginListenerHandle>;
}>("HeartRate");

export const HEART_RATE_ENABLED_KEY = "motioncontrol-heart-rate-v1";
/** 超过这么久没有新读数，就不再显示、不再发给电脑：手环停止广播或者人走开了。 */
export const STALE_MS = 5000;
export const SEND_INTERVAL_MS = 1000;
const OFF: HeartRateStatus = { state: "off", message: "", device: "", wanted: false };

/** 最近一次心率、新不新鲜、这一次该不该发给电脑。不碰蓝牙，单独可测。 */
export class HeartRateFeed {
  latest: HeartRateReading | null = null;
  private lastSentAt = -Infinity;
  receive(reading: HeartRateReading): boolean {
    const bpm = Number(reading?.bpm), at = Number(reading?.at);
    if (!Number.isInteger(bpm) || bpm < 25 || bpm > 250 || !Number.isFinite(at)) return false;
    if (this.latest && at < this.latest.at) return false;
    this.latest = { bpm, at, device: String(reading.device || "") };
    return true;
  }
  bpm(now: number): number | null {
    return this.latest && now - this.latest.at <= STALE_MS ? this.latest.bpm : null;
  }
  /** 该发了就返回这条读数并记下发过；同一秒里的、过期的都不发。 */
  takeSend(now: number): HeartRateReading | null {
    if (this.bpm(now) == null || now - this.lastSentAt < SEND_INTERVAL_MS) return null;
    this.lastSentAt = now;
    return this.latest;
  }
  clear(): void { this.latest = null; this.lastSentAt = -Infinity; }
}

export class HeartRate {
  readonly feed = new HeartRateFeed();
  status: HeartRateStatus = { ...OFF };
  /** 旧 APK 上热更来的新网页没有这个原生插件：整个功能不出现。 */
  readonly available = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("HeartRate");
  private wantedNow = false;
  private listeners: (() => void)[] = [];
  private staleTimer: number | null = null;
  constructor(private storage: Pick<Storage, "getItem" | "setItem">, private onReading: (reading: HeartRateReading) => void) {
    if (!this.available) return;
    void NativeHeartRate.addListener("heartRateState", status => { this.status = status; this.changed(); });
    void NativeHeartRate.addListener("heartRate", reading => {
      if (!this.feed.receive(reading)) return;
      this.onReading(reading);
      this.armStale();
      this.changed();
    });
  }
  get enabled(): boolean {
    try { return this.available && this.storage.getItem(HEART_RATE_ENABLED_KEY) === "on"; } catch { return false; }
  }
  setEnabled(on: boolean): void {
    try { this.storage.setItem(HEART_RATE_ENABLED_KEY, on ? "on" : "off"); } catch { /* 存不下也照样这一次生效。 */ }
    if (!on) this.want(false);
    this.changed();
  }
  /** 现在需不需要心率。开着「手环心率」才会真的去找。 */
  want(active: boolean): void {
    const next = active && this.enabled;
    if (next === this.wantedNow) return;
    this.wantedNow = next;
    if (next) void NativeHeartRate.start().then(status => { this.status = status; this.changed(); }).catch(() => undefined);
    else {
      this.feed.clear();
      void NativeHeartRate.stop().then(status => { this.status = status; this.changed(); }).catch(() => undefined);
    }
  }
  subscribe(listener: () => void): void { this.listeners.push(listener); }
  private changed(): void { this.listeners.forEach(listener => listener()); }
  /** 读数过期的那一刻刷新一次界面，大字心率要消失；不轮询。 */
  private armStale(): void {
    if (this.staleTimer != null) window.clearTimeout(this.staleTimer);
    this.staleTimer = window.setTimeout(() => { this.staleTimer = null; this.changed(); }, STALE_MS + 50);
  }
}
