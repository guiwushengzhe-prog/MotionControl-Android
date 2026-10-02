import { parseCandidates, toLong, type ServerCandidate } from "./discovery";

export type RememberedComputer = {
  type: "motioncontrol-connect"; version: 1; instance: string; name: string;
  candidates: ServerCandidate[]; role?: "camera" | "handheld";
};
export const COMPUTER_KEY = "motionbridge-remembered-computer";

export function parseConnectionCode(text: string): RememberedComputer {
  if (text.length > 8192) throw new Error("这不是 MotionControl 的连接二维码");
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error("这不是 MotionControl 的连接二维码"); }
  if (raw?.type !== "motioncontrol-connect" || raw.version !== 1 || !/^[a-f0-9]{12}$/.test(raw.instance ?? "")) {
    throw new Error("这不是 MotionControl 的连接二维码");
  }
  const candidates = parseCandidates(raw.candidates).filter(item => toLong(item.host) >= 0 && item.host !== "0.0.0.0");
  if (!candidates.length) throw new Error("二维码里没有可用的电脑地址");
  return { type: "motioncontrol-connect", version: 1, instance: raw.instance,
    name: typeof raw.name === "string" ? raw.name.slice(0, 80) : "上次的电脑", candidates,
    role: ["camera", "handheld"].includes(raw.role) ? raw.role : undefined };
}
export function readComputer(): RememberedComputer | null {
  try { return parseConnectionCode(localStorage.getItem(COMPUTER_KEY) || ""); } catch { return null; }
}
export function saveComputer(computer: RememberedComputer): void {
  try { localStorage.setItem(COMPUTER_KEY, JSON.stringify(computer)); } catch { /* 本次仍可连接。 */ }
}
export function matchesComputer(identity: { ok?: boolean; instance?: string }, computer: RememberedComputer | null): boolean {
  return Boolean(identity.ok) && (!computer || identity.instance === computer.instance);
}

/** 只有扫码选定的电脑才自动开上次模式；手动停止取消本次重试，保存的选择供下次打开。 */
export class ComputerReconnect {
  private role: "camera" | "handheld" | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private task: Promise<void> | null = null;
  constructor(private allowed: () => boolean, private active: (role: "camera" | "handheld") => boolean,
              private attempt: (role: "camera" | "handheld", current: () => boolean) => Promise<void>) {}
  activate(role: "camera" | "handheld"): void { this.cancel(); this.role = role; this.resume(); }
  cancel(): void { this.pause(); this.role = null; }
  pause(): void { ++this.generation; if (this.timer != null) clearTimeout(this.timer); this.timer = null; }
  resume(): void {
    if (this.task) { const generation = this.generation; void this.task.then(() => { if (generation === this.generation) this.resume(); }); return; }
    const role = this.role, generation = this.generation;
    if (!role || !this.allowed() || this.active(role) || this.timer != null) return;
    const task = this.attempt(role, () => generation === this.generation && this.role === role && this.allowed()).catch(() => {});
    this.task = task;
    void task.finally(() => {
      if (this.task === task) this.task = null;
      if (generation === this.generation && this.role === role && this.allowed() && !this.active(role)) {
        this.timer = setTimeout(() => { this.timer = null; this.resume(); }, 2500);
      }
    });
  }
}
