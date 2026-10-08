import { dayKey, FitnessStore, type FitnessControl, type FitnessSession } from "./fitness";
import type { HeartRate } from "./heart-rate";

const amount = (value: number): string => Math.round(value).toLocaleString("zh-CN");
const minutes = (seconds: number): string => (seconds / 60).toFixed(seconds < 600 ? 1 : 0);
const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const timestamp = (ms: number): string => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const statusLabel = { active: "记录中", paused: "已暂停", finished: "已结束" };
const NUDGE_KEY = "motioncontrol-fitness-profile-nudge";
const kcalLabel = (session: FitnessSession): string => session.kcal_source === "heart_rate" ? "按心率估算" : "体感估算";
const heartLine = (session: FitnessSession): string => session.hr_avg != null ? ` · 平均心率 ${session.hr_avg}、最高 ${session.hr_max}` : "";
export const FITNESS_PAGE_HTML = `<section id="fitnessPage" class="fitness-page" role="dialog" aria-modal="true" aria-labelledby="fitnessTitle" hidden>
  <div class="fitness-page-inner"><div class="fitness-heading"><button id="fitnessBack" class="back-button" type="button">‹ 返回</button><span id="fitnessConnection" class="fitness-connection">本地记录</span></div>
  <h2 id="fitnessTitle">运动记录</h2><p class="fitness-intro">体感游戏也是今天的运动。</p><div id="fitnessSummary"></div>
  <div class="fitness-session-card"><div id="fitnessCurrent"></div><div class="fitness-actions"><button id="fitnessStart" type="button" class="start-primary">开始记录</button><button id="fitnessFinish" type="button" class="scan-computer" hidden>结束并保存</button></div><p id="fitnessMessage" class="fitness-note" aria-live="polite">连接电脑后，使用现有体感动作统计。</p><p id="fitnessProfileNudge" class="fitness-note fitness-nudge" hidden>填上年龄和性别，按心率算的热量更准。<button id="fitnessProfileNudgeGo" type="button">去填</button></p></div><div id="fitnessHeart" class="fitness-heart" hidden><div class="fitness-heart-top"><strong>手环心率</strong><button id="fitnessHeartToggle" type="button" class="fitness-switch" role="switch" aria-checked="false"><i></i></button></div><p id="fitnessHeartStatus" class="fitness-note"></p></div>
  <div class="fitness-actions fitness-mode-links"><button id="fitnessCamera" type="button" class="scan-computer">使用固定摄像头</button><button id="fitnessPair" type="button" class="scan-computer">扫码连接电脑</button></div>
  <details class="more fitness-settings" id="fitnessSettings"><summary>身体数据与每日目标</summary><form id="fitnessProfile"><label class="field">体重（千克）<input name="weight_kg" type="number" min="20" max="300" step="0.1" required inputmode="decimal"></label><label class="field">年龄<input name="age" type="number" min="10" max="100" step="1" inputmode="numeric" placeholder="不填"></label><label class="field">性别<select name="sex"><option value="">不填</option><option value="male">男</option><option value="female">女</option></select></label><label class="field">每日运动（分钟）<input name="goal_active_minutes" type="number" min="1" max="600" required inputmode="numeric"></label><label class="field">每日步数（步）<input name="goal_steps" type="number" min="1" max="100000" required inputmode="numeric"></label><label class="field">每日活动热量（千卡，估算）<input name="goal_kcal" type="number" min="1" max="10000" required inputmode="numeric"></label><label class="field">打卡主目标<select name="primary_goal"><option value="minutes">有效运动时间</option><option value="steps">原地踏步步数</option><option value="kcal">估算活动热量</option></select></label><button type="submit" class="scan-computer">保存设置</button></form></details>
  <section class="fitness-history"><div class="fitness-week-nav"><h3 id="fitnessWeekTitle">最近七天</h3><div><button id="fitnessWeekPrev" type="button" aria-label="查看更早一周">‹ 上一周</button><button id="fitnessWeekNext" type="button" aria-label="查看后一周" disabled>下一周 ›</button></div></div><div id="fitnessWeek"></div><h3>单次记录</h3><div id="fitnessSessions"></div><button id="fitnessMoreHistory" class="scan-computer" type="button" hidden>查看更多记录</button></section>
  <p class="fitness-note">活动热量按动作强度与体重估算；读到手环心率时按心率、体重、年龄、性别估算。都已扣除静息消耗，不是实际测量。脚部不可见时不补步；暂停、断流和静止时不累计有效运动。记录保存在手机本地，电脑保留会话供断线补同步。</p>
  </div></section>`;

export class FitnessUI {
  private page: HTMLElement;
  private feedback = "";
  private connected = false;
  private connectionLabel = "本地记录";
  private weekOffset = 0;
  private historyLimit = 100;
  constructor(private store: FitnessStore, private hooks: { control: (message: FitnessControl) => Promise<boolean>; open: () => void; close: () => void; camera: () => void; pair: () => void }, private heart: HeartRate | null = null) {
    this.page = document.querySelector<HTMLElement>("#fitnessPage")!;
    document.querySelector("#fitnessHeartToggle")!.addEventListener("click", () => { if (this.heart) { this.heart.setEnabled(!this.heart.enabled); this.hooks.open(); } });
    document.querySelector("#fitnessProfileNudgeGo")!.addEventListener("click", () => { this.nudgeSeen(); const details = document.querySelector<HTMLDetailsElement>("#fitnessSettings")!; details.open = true; details.scrollIntoView({ block: "start", behavior: "smooth" }); });
    heart?.subscribe(() => this.render());
    this.page.hidden = true;
    document.querySelector("#fitnessBack")!.addEventListener("click", () => this.hide());
    document.querySelector("#fitnessCamera")!.addEventListener("click", () => { this.hide(); hooks.camera(); });
    document.querySelector("#fitnessPair")!.addEventListener("click", () => { this.hide(); hooks.pair(); });
    document.querySelector("#fitnessStart")!.addEventListener("click", () => void this.control());
    document.querySelector("#fitnessFinish")!.addEventListener("click", () => void this.control(true));
    document.querySelector("#fitnessWeekPrev")!.addEventListener("click", () => { this.weekOffset++; this.render(); });
    document.querySelector("#fitnessWeekNext")!.addEventListener("click", () => { this.weekOffset = Math.max(0, this.weekOffset - 1); this.render(); });
    document.querySelector("#fitnessMoreHistory")!.addEventListener("click", () => { this.historyLimit += 100; this.render(); });
    const form = document.querySelector<HTMLFormElement>("#fitnessProfile")!;
    form.addEventListener("submit", event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      const data = new FormData(form);
      const age = String(data.get("age") || "").trim(), sex = String(data.get("sex") || "");
      store.setProfile({ weight_kg: Number(data.get("weight_kg")), goal_active_minutes: Number(data.get("goal_active_minutes")), goal_steps: Number(data.get("goal_steps")), goal_kcal: Number(data.get("goal_kcal")), primary_goal: String(data.get("primary_goal")) as "minutes" | "steps" | "kcal", age: age ? Number(age) : null, sex: sex === "male" || sex === "female" ? sex : null });
      this.feedback = "设置已保存在手机；连接电脑时同步。"; this.render();
      void hooks.control({ type: "fitness_control_v1", action: "profile", profile: store.profile });
    });
    store.subscribe(() => { this.feedback = ""; if (!store.profileConfigured && !form.querySelector(":focus")) this.fillProfile(); this.render(); });
    this.fillProfile(); this.render();
  }
  get visible(): boolean { return !this.page.hidden; }
  show(): void { this.page.hidden = false; document.body.classList.add("fitness-open"); this.fillProfile(); this.render(); this.hooks.open(); }
  hide(): void { if (!document.querySelector<HTMLElement>("#fitnessProfileNudge")!.hidden) this.nudgeSeen(); this.page.hidden = true; document.body.classList.remove("fitness-open"); this.hooks.close(); }
  /** 提示填年龄性别：只在第一次有心率的锻炼结束后出现一次，看过就不再出现。 */
  private nudgeSeen(): void { try { localStorage.setItem(NUDGE_KEY, "seen"); } catch { /* 存不下就下次再提示一次。 */ } }
  private nudgeWanted(): boolean {
    const profile = this.store.profile;
    if (profile.age != null && profile.sex != null) return false;
    try { if (localStorage.getItem(NUDGE_KEY)) return false; } catch { return false; }
    return this.store.sessions.some(session => session.status === "finished" && session.hr_avg != null);
  }
  private renderHeart(current: FitnessSession | undefined): string {
    const heart = this.heart, box = document.querySelector<HTMLElement>("#fitnessHeart")!;
    box.hidden = !heart?.available;
    if (!heart?.available) return "";
    const toggle = document.querySelector<HTMLButtonElement>("#fitnessHeartToggle")!;
    toggle.setAttribute("aria-checked", String(heart.enabled));
    const bpm = heart.feed.bpm(Date.now()), status = heart.status;
    document.querySelector("#fitnessHeartStatus")!.textContent = !heart.enabled ? "在手环上打开「心率广播」后，这里读心率；手环和原厂应用的连接不受影响。"
      : bpm != null ? `${status.device || "手环"} · ${bpm} 次/分` : status.message || "在手环上打开「心率广播」";
    return bpm != null && current ? ` · 心率 ${bpm}` : "";
  }
  connection(connected: boolean, label?: string): void { this.connected = connected; this.connectionLabel = label || (connected ? "已连接电脑" : "本地记录"); this.render(); }
  private fillProfile(): void {
    const form = document.querySelector<HTMLFormElement>("#fitnessProfile")!;
    for (const [key, value] of Object.entries(this.store.profile)) {
      const field = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${key}"]`);
      if (field) field.value = value == null ? "" : String(value);
    }
  }
  private async control(finish = false): Promise<void> {
    const session = this.store.current;
    const action = finish ? "finish" : !session ? "start" : session.status === "paused" ? "resume" : "pause";
    this.feedback = "正在同步电脑…"; this.render();
    const sent = await this.hooks.control({ type: "fitness_control_v1", action, ...(session ? { session_id: session.session_id } : {}), profile: this.store.profile });
    if (!sent) { this.feedback = "未连接电脑。请打开电脑 MotionControl，或扫码连接；已保存的记录仍可查看。"; this.render(); }
  }
  render(): void {
    if (this.page.hidden) return;
    const days = this.store.days(), today = days.find(day => day.day === dayKey(Date.now())), achievements = this.store.achievements();
    const profile = this.store.profile, progress = this.store.progress(today), current = this.store.current;
    const goal = profile.primary_goal === "steps" ? `${amount(profile.goal_steps)} 步` : profile.primary_goal === "kcal" ? `${amount(profile.goal_kcal)} 千卡` : `${amount(profile.goal_active_minutes)} 分钟`;
    document.querySelector("#fitnessConnection")!.textContent = this.connectionLabel;
    document.querySelector("#fitnessSummary")!.innerHTML = `<div class="fitness-goal-card"><div class="fitness-goal-top"><strong>${achievements.todayDone ? "今日已打卡" : "今日目标"}</strong><span>${Math.round(progress * 100)}% · ${goal}</span></div><progress max="1" value="${Math.min(1, progress)}" aria-label="今日目标进度"></progress><div class="fitness-metrics"><div><strong>${minutes(today?.active_seconds || 0)}</strong><span>有效运动 · 分钟</span></div><div><strong>${amount(today?.steps || 0)}</strong><span>原地踏步 · 步</span></div><div><strong>${amount(today?.estimated_kcal || 0)}</strong><span>估算热量 · 千卡</span></div></div></div><div class="fitness-achievements"><span><strong>等级 ${achievements.level}</strong>${amount(achievements.xp)} 经验</span><span><strong>连续 ${achievements.streak} 天</strong>累计 ${achievements.checkins} 天打卡</span></div>`;
    const live = this.renderHeart(current);
    document.querySelector<HTMLElement>("#fitnessProfileNudge")!.hidden = !this.nudgeWanted();
    document.querySelector("#fitnessCurrent")!.innerHTML = current ? `<div class="fitness-current-top"><strong>${statusLabel[current.status]}</strong><span>${timestamp(current.started_at_ms)}</span></div><b class="fitness-timer">${clock(current.elapsed_seconds)}</b><p class="fitness-note">有效运动 ${minutes(current.active_seconds)} 分钟 · ${amount(current.steps)} 步 · ${amount(current.action_count)} 次动作 · ${amount(current.estimated_kcal)} 千卡（${kcalLabel(current)}）${live}</p>` : `<strong>本次锻炼</strong><p class="fitness-note">开始控制会自动记录，也可以单独开始记录。</p>`;
    document.querySelector("#fitnessStart")!.textContent = !current ? "开始记录" : current.status === "paused" ? "继续记录" : "暂停记录";
    document.querySelector<HTMLButtonElement>("#fitnessFinish")!.hidden = !current;
    document.querySelector("#fitnessMessage")!.textContent = this.store.persistenceError ? "本机存储空间不足，当前记录未能保存；请释放空间后重试。" : this.feedback || (!this.connected && current ? "连接已断开，等待电脑补传记录，不额外计步或估算。" : this.store.profileConfigured ? `按已保存的体重 ${profile.weight_kg} 千克估算热量。` : `估算体重 ${profile.weight_kg} 千克，可在下面修改。`);
    const dates = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - index - this.weekOffset * 7); return dayKey(date.getTime()); });
    document.querySelector("#fitnessWeekTitle")!.textContent = this.weekOffset ? `${dates[6].slice(5).replace("-", "/")} — ${dates[0].slice(5).replace("-", "/")}` : "最近七天";
    document.querySelector<HTMLButtonElement>("#fitnessWeekNext")!.disabled = this.weekOffset === 0;
    document.querySelector("#fitnessWeek")!.innerHTML = dates.map(day => { const total = days.find(item => item.day === day); return `<div class="fitness-day"><strong>${day.slice(5).replace("-", "/")}</strong><span>${minutes(total?.active_seconds || 0)} 分钟</span><span>${amount(total?.steps || 0)} 步</span><span>${amount(total?.estimated_kcal || 0)} 千卡</span><i>${this.store.checkedDays.includes(day) ? "✓" : ""}</i></div>`; }).join("");
    const week = dates.reduce((sum, day) => { const total = days.find(item => item.day === day); return sum + (total?.active_seconds || 0); }, 0);
    document.querySelector("#fitnessWeek")!.innerHTML += `<p class="fitness-note">七天有效运动合计 ${minutes(week)} 分钟</p>`;
    document.querySelector("#fitnessSessions")!.innerHTML = this.store.sessions.length ? this.store.sessions.slice(0, this.historyLimit).map(session => `<article class="fitness-history-session"><div><strong>${timestamp(session.started_at_ms)}</strong><span>${statusLabel[session.status]}</span></div><p>有效运动 ${minutes(session.active_seconds)} 分钟 · ${amount(session.steps)} 步 · ${amount(session.action_count)} 次动作</p><small>记录 ${clock(session.elapsed_seconds)} · ${kcalLabel(session)} ${amount(session.estimated_kcal)} 千卡${heartLine(session)}</small></article>`).join("") : `<p class="fitness-empty">还没有运动记录。完成一局体感游戏，记录会保存在这里。</p>`;
    document.querySelector<HTMLButtonElement>("#fitnessMoreHistory")!.hidden = this.historyLimit >= this.store.sessions.length;
  }
}
