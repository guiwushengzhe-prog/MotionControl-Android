import { describe, expect, it } from "vitest";
import { dayKey, FitnessStore, type FitnessStateMessage } from "./fitness";
const memory = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
const state = (override: Partial<FitnessStateMessage> = {}): FitnessStateMessage => ({ type: "fitness_state_v1", session_id: "one", status: "active", started_at_ms: new Date(2026, 9, 8, 12).getTime(), updated_at_ms: 2000, elapsed_seconds: 120, active_seconds: 90, steps: 12, action_count: 5, estimated_kcal: 10, source: "motion_estimate", ...override });
describe("运动记录绝对累计", () => {
  it("重复推送、乱序补传、结束后重播不重复计数也不复活会话", () => {
    const store = new FitnessStore(memory());
    store.receive(state()); store.receive(state());
    store.receive(state({ updated_at_ms: 3000, status: "finished", active_seconds: 100, steps: 15 }));
    store.receive(state({ updated_at_ms: 1000, active_seconds: 20, steps: 2 }));
    expect(store.sessions).toHaveLength(1); expect(store.sessions[0].steps).toBe(15);
    expect(store.sessions[0].status).toBe("finished"); expect(store.current).toBeUndefined();
    expect(store.days()[0].active_seconds).toBe(100);
  });
  it("暂停只保存电脑报告的累计值，不根据墙钟继续累计", () => {
    const storage = memory(), store = new FitnessStore(storage);
    store.receive(state({ status: "paused" }));
    const restored = new FitnessStore(storage);
    expect(restored.current?.status).toBe("paused"); expect(restored.current?.elapsed_seconds).toBe(120);
    expect(restored.current?.active_seconds).toBe(90);
  });
  it("历史补同步按会话编号合并，已有记录取最高累计", () => {
    const store = new FitnessStore(memory()); store.receive(state());
    store.receive({ type: "fitness_state_v1", history: [state(), state({ session_id: "two", steps: 4, status: "finished" }) as any] });
    expect(store.sessions).toHaveLength(2); expect(store.days()[0].steps).toBe(16);
  });
  it("主目标达成自动打卡，重复同步不重复经验，提高目标保留已经完成的打卡", () => {
    const storage = memory(), store = new FitnessStore(storage);
    store.setProfile({ primary_goal: "steps", goal_steps: 10 }); store.receive(state());
    const before = store.achievements(state().started_at_ms!);
    store.receive(state()); expect(store.achievements(state().started_at_ms!)).toEqual(before);
    store.setProfile({ primary_goal: "steps", goal_steps: 1000 });
    expect(new FitnessStore(storage).achievements(state().started_at_ms!).checkins).toBe(1);
    expect(before.todayDone).toBe(true);
  });
  it("损坏存储、无效输入和不可保存时不会污染累计", () => {
    const store = new FitnessStore({ getItem: () => "broken", setItem: () => { throw new Error("quota"); } });
    expect(store.receive(state({ started_at_ms: NaN }))).toBe(false);
    store.receive(state({ steps: -8, active_seconds: Infinity }));
    expect(store.sessions[0].steps).toBe(0); expect(store.sessions[0].active_seconds).toBe(0);
    expect(store.persistenceError).toBe(true);
    expect(dayKey(new Date(2026, 9, 8).getTime())).toBe("2026-10-08");
  });
  it("电脑空闲状态不会把历史未结束记录当成当前会话", () => {
    const store = new FitnessStore(memory()); store.receive(state({ status: "paused" }));
    store.receive({ type: "fitness_state_v1", session_id: "" });
    expect(store.current).toBeUndefined(); expect(store.sessions).toHaveLength(1);
    store.receive({ type: "fitness_state_v1", history: [state({ session_id: "old", status: "paused", updated_at_ms: 1 }) as any] });
    expect(store.current).toBeUndefined();
  });
  it("按电脑每日分桶保存跨午夜运动，并与电脑保持同一经验等级", () => {
    const store = new FitnessStore(memory());
    store.receive(state({ active_seconds: 600, steps: 40, days: { "2026-10-08": { active_seconds: 300, steps: 20, action_count: 2, estimated_kcal: 5 }, "2026-10-09": { active_seconds: 300, steps: 20, action_count: 3, estimated_kcal: 5 } }, checkins: ["2026-10-08"] }));
    expect(store.days().map(day => day.steps)).toEqual([20, 20]);
    expect(store.achievements(state().started_at_ms!).xp).toBe(150);
    expect(store.achievements(state().started_at_ms!).level).toBe(2);
    store.receive(state({ updated_at_ms: 1, days: { "2026-10-08": { active_seconds: 1, steps: 1, action_count: 0, estimated_kcal: 0 } } }));
    expect(store.days().map(day => day.steps)).toEqual([20, 20]);
  });
});
