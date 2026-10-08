// 年龄、性别可以不填：按心率算热量时要用，没填就按平均成年人算，热量标「估算」。
export type Sex = "male" | "female";
export type FitnessProfile = { weight_kg: number; goal_active_minutes: number; goal_steps: number; goal_kcal: number; primary_goal: "minutes" | "steps" | "kcal"; age?: number | null; sex?: Sex | null };
type FitnessCounters = { active_seconds: number; steps: number; action_count: number; estimated_kcal: number };
// 心率：手环「心率广播」读到的。hr_curve 是每 30 秒一个平均值 [第几秒, 心率]，给人看曲线用。
export type HeartRateSummary = { hr_avg?: number; hr_max?: number; hr_seconds?: number; hr_curve?: [number, number][]; kcal_source?: "motion" | "heart_rate" };
export type FitnessSession = { session_id: string; status: "active" | "paused" | "finished"; started_at_ms: number; updated_at_ms: number; ended_at_ms?: number; elapsed_seconds: number; active_seconds: number; steps: number; action_count: number; estimated_kcal: number; source: "motion_estimate"; days?: Record<string, FitnessCounters> } & HeartRateSummary;
export type FitnessStateMessage = Partial<FitnessSession> & { type: "fitness_state_v1"; profile?: Partial<FitnessProfile>; history?: FitnessSession[]; checkins?: string[] };
export type FitnessControl = { type: "fitness_control_v1"; action: "start" | "pause" | "resume" | "finish" | "profile"; session_id?: string; profile?: FitnessProfile };
export const FITNESS_KEY = "motioncontrol-fitness-v1";
export const DEFAULT_FITNESS_PROFILE: FitnessProfile = { weight_kg: 70, goal_active_minutes: 20, goal_steps: 1000, goal_kcal: 100, primary_goal: "minutes" };
const nonnegative = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const bounded = (value: unknown, fallback: number, min: number, max: number): number => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
export function normalizeProfile(raw: Partial<FitnessProfile> = {}): FitnessProfile {
  const age = typeof raw.age === "number" && Number.isInteger(raw.age) && raw.age >= 10 && raw.age <= 100 ? raw.age : null;
  const sex = raw.sex === "male" || raw.sex === "female" ? raw.sex : null;
  return { weight_kg: bounded(raw.weight_kg, 70, 20, 300), goal_active_minutes: bounded(raw.goal_active_minutes, 20, 1, 600), goal_steps: bounded(raw.goal_steps, 1000, 1, 100000), goal_kcal: bounded(raw.goal_kcal, 100, 1, 10000), primary_goal: ["minutes", "steps", "kcal"].includes(raw.primary_goal || "") ? raw.primary_goal! : "minutes", age, sex };
}
export function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** 电脑发来的心率摘要，只收认得的字段、合理的数。没有心率就是 null。 */
export function heartRateSummary(raw: Partial<HeartRateSummary>): HeartRateSummary | null {
  const bpm = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 25 && value <= 250 ? Math.round(value) : undefined;
  const avg = bpm(raw.hr_avg), max = bpm(raw.hr_max);
  if (avg == null) return null;
  const curve = Array.isArray(raw.hr_curve) ? raw.hr_curve.filter((point): point is [number, number] => Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && point[0] >= 0 && bpm(point[1]) != null).slice(0, 2880) : [];
  return { hr_avg: avg, hr_max: max ?? avg, hr_seconds: nonnegative(raw.hr_seconds), hr_curve: curve, kcal_source: raw.kcal_source === "heart_rate" ? "heart_rate" : "motion" };
}
export type FitnessDay = { day: string; active_seconds: number; elapsed_seconds: number; steps: number; estimated_kcal: number; action_count: number; sessions: number };
/** 电脑推送绝对累计值；重复推送和断线补传不增加第二份记录。 */
export class FitnessStore {
  profile = { ...DEFAULT_FITNESS_PROFILE };
  profileConfigured = false;
  sessions: FitnessSession[] = [];
  checkedDays: string[] = [];
  private currentSessionId: string | null = null;
  persistenceError = false;
  private callbacks: (() => void)[] = [];
  constructor(private storage: Pick<Storage, "getItem" | "setItem">) {
    try {
      const saved = JSON.parse(storage.getItem(FITNESS_KEY) || "null");
      if (!saved || saved.version !== 1) return;
      this.profile = normalizeProfile(saved.profile); this.profileConfigured = saved.profileConfigured === true;
      if (Array.isArray(saved.sessions)) saved.sessions.forEach((session: FitnessSession) => this.merge(session));
      if (Array.isArray(saved.checkedDays)) this.checkedDays = [...new Set<string>(saved.checkedDays.filter((day: unknown) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)))];
      this.currentSessionId = typeof saved.currentSessionId === "string" ? saved.currentSessionId : null;
    } catch { /* 无记录或旧格式不阻止原有控制。 */ }
  }
  subscribe(callback: () => void): void { this.callbacks.push(callback); }
  private save(): void {
    try { this.storage.setItem(FITNESS_KEY, JSON.stringify({ version: 1, profile: this.profile, profileConfigured: this.profileConfigured, sessions: this.sessions, checkedDays: this.checkedDays, currentSessionId: this.currentSessionId })); this.persistenceError = false; }
    catch { this.persistenceError = true; }
    this.callbacks.forEach(callback => callback());
  }
  setProfile(raw: Partial<FitnessProfile>): void { this.profile = normalizeProfile(raw); this.profileConfigured = true; this.checkIn(dayKey(Date.now())); this.save(); }
  receive(raw: FitnessStateMessage): boolean {
    if (raw.type !== "fitness_state_v1") return false;
    let changed = false;
    if (raw.profile && typeof raw.profile === "object") {
      // 首次使用接受电脑保存的设置；主动修改的手机设置在重新连接时发送给电脑。
      if (!this.profileConfigured) this.profile = normalizeProfile(raw.profile);
    }
    if (Array.isArray(raw.history)) for (const session of raw.history) changed = this.merge(session) || changed;
    changed = this.merge(raw) || changed;
    if (raw.session_id === "") this.currentSessionId = null;
    else if (raw.session_id && this.sessions.some(session => session.session_id === raw.session_id)) {
      // 迟到的旧状态不应顶替电脑最新的活动会话。
      const current = this.sessions.find(session => session.session_id === this.currentSessionId);
      if (!current || (raw.updated_at_ms || 0) >= current.updated_at_ms) this.currentSessionId = raw.session_id;
    }
    if (raw.started_at_ms) this.checkIn(dayKey(raw.started_at_ms));
    if (Array.isArray(raw.history)) raw.history.forEach(session => this.checkIn(dayKey(session.started_at_ms)));
    if (Array.isArray(raw.checkins)) this.checkedDays = [...new Set([...this.checkedDays, ...raw.checkins.filter(day => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day))])];
    this.save(); return changed;
  }
  private merge(raw: Partial<FitnessSession>): boolean {
    if (typeof raw.session_id !== "string" || !raw.session_id || raw.session_id.length > 160 || !["active", "paused", "finished"].includes(raw.status || "") || !Number.isFinite(raw.started_at_ms) || Number(raw.started_at_ms) <= 0 || !Number.isFinite(raw.updated_at_ms)) return false;
    const previous = this.sessions.find(session => session.session_id === raw.session_id);
    const newer = !previous || Number(raw.updated_at_ms) >= previous.updated_at_ms;
    const session: FitnessSession = {
      session_id: raw.session_id, status: previous?.status === "finished" ? "finished" : newer ? raw.status! : previous!.status,
      started_at_ms: previous?.started_at_ms ?? raw.started_at_ms!, updated_at_ms: Math.max(previous?.updated_at_ms || 0, raw.updated_at_ms!),
      source: "motion_estimate", elapsed_seconds: Math.max(previous?.elapsed_seconds || 0, nonnegative(raw.elapsed_seconds)),
      active_seconds: Math.max(previous?.active_seconds || 0, nonnegative(raw.active_seconds)), steps: Math.floor(Math.max(previous?.steps || 0, nonnegative(raw.steps))),
      action_count: Math.floor(Math.max(previous?.action_count || 0, nonnegative(raw.action_count))), estimated_kcal: Math.max(previous?.estimated_kcal || 0, nonnegative(raw.estimated_kcal)),
    };
    // 心率是电脑算好的整份摘要，新的一份整份换掉旧的。
    const hr = newer ? heartRateSummary(raw) : null;
    if (hr) Object.assign(session, hr);
    else if (previous) Object.assign(session, heartRateSummary(previous));
    const ended = nonnegative(raw.ended_at_ms) || previous?.ended_at_ms;
    if (ended) session.ended_at_ms = ended;
    if (raw.days && typeof raw.days === "object" && !Array.isArray(raw.days)) {
      session.days = structuredClone(previous?.days || {});
      for (const [day, counters] of Object.entries(raw.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !counters || typeof counters !== "object") continue;
        const old = session.days[day];
        session.days[day] = { active_seconds: Math.max(old?.active_seconds || 0, nonnegative(counters.active_seconds)),
          steps: Math.floor(Math.max(old?.steps || 0, nonnegative(counters.steps))), action_count: Math.floor(Math.max(old?.action_count || 0, nonnegative(counters.action_count))),
          estimated_kcal: Math.max(old?.estimated_kcal || 0, nonnegative(counters.estimated_kcal)) };
      }
    } else if (previous?.days) session.days = previous.days;
    if (previous) this.sessions[this.sessions.indexOf(previous)] = session; else this.sessions.push(session);
    this.sessions.sort((a, b) => b.started_at_ms - a.started_at_ms);
    return !previous || JSON.stringify(previous) !== JSON.stringify(session);
  }
  get current(): FitnessSession | undefined { return this.sessions.find(session => session.session_id === this.currentSessionId && session.status !== "finished"); }
  days(): FitnessDay[] {
    const byDay = new Map<string, FitnessDay>();
    for (const session of this.sessions) {
      const buckets = session.days ? Object.entries(session.days) : [[dayKey(session.started_at_ms), session] as const];
      for (const [day, counters] of buckets) {
        const total = byDay.get(day) || { day, active_seconds: 0, elapsed_seconds: 0, steps: 0, estimated_kcal: 0, action_count: 0, sessions: 0 };
        total.active_seconds += counters.active_seconds; total.elapsed_seconds += day === dayKey(session.started_at_ms) ? session.elapsed_seconds : 0;
        total.steps += counters.steps; total.estimated_kcal += counters.estimated_kcal; total.action_count += counters.action_count; total.sessions++;
        byDay.set(day, total);
      }
    }
    return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
  }
  progress(day: FitnessDay | undefined): number {
    if (!day) return 0;
    const key = this.profile.primary_goal;
    return Math.max(0, key === "steps" ? day.steps / this.profile.goal_steps : key === "kcal" ? day.estimated_kcal / this.profile.goal_kcal : day.active_seconds / (this.profile.goal_active_minutes * 60));
  }
  private checkIn(day: string): void {
    if (!this.checkedDays.includes(day) && this.progress(this.days().find(item => item.day === day)) >= 1) this.checkedDays.push(day);
  }
  achievements(now = Date.now()): { xp: number; level: number; checkins: number; streak: number; todayDone: boolean } {
    const days = this.days(), completed = new Set(this.checkedDays);
    const xp = Math.floor(days.reduce((sum, day) => sum + day.active_seconds, 0) / 60) * 10 + completed.size * 50;
    const today = dayKey(now), date = new Date(now); let streak = 0;
    if (!completed.has(today)) date.setDate(date.getDate() - 1);
    while (completed.has(dayKey(date.getTime()))) { streak++; date.setDate(date.getDate() - 1); }
    return { xp, level: Math.floor(xp / 100) + 1, checkins: completed.size, streak, todayDone: completed.has(today) };
  }
}
