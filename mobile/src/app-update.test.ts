import { describe, expect, it } from "vitest";
import { APP_UPDATE_INTERVAL_MS, appUpdateView, progressLine, shouldCheck, shouldPrompt } from "./app-update";

describe("App 内更新", () => {
  it("没有新版时不频繁问服务器，上次有新版就每次都确认", () => {
    const now = 10 * APP_UPDATE_INTERVAL_MS;
    expect(shouldCheck(null, now)).toBe(true);
    expect(shouldCheck({ at: now - 1000, state: "current" }, now)).toBe(false);
    expect(shouldCheck({ at: now - APP_UPDATE_INTERVAL_MS, state: "current" }, now)).toBe(true);
    expect(shouldCheck({ at: now - 1000, state: "available" }, now)).toBe(true);
    expect(shouldCheck({ at: now - 1000, state: "current" }, now, true)).toBe(true);
  });

  it("只有功能更新弹窗，点过以后再说的那一版不再弹", () => {
    const feature = { state: "available" as const, version: "2.4.0", kind: "feature" };
    expect(shouldPrompt(feature, "")).toBe(true);
    expect(shouldPrompt(feature, "2.4.0")).toBe(false);
    expect(shouldPrompt({ ...feature, kind: "system" }, "")).toBe(false);
    expect(shouldPrompt({ state: "current" }, "")).toBe(false);
  });

  it("每一步都有一句人话和对应的按钮", () => {
    expect(appUpdateView({ state: "available", version: "2.4.0", size: 30 * 1024 * 1024 }))
      .toEqual({ line: "新版 App 2.4.0 可以更新，30.0 MB", button: "下载并安装" });
    expect(appUpdateView({ state: "available", version: "2.4.0", downloaded: true }).button).toBe("安装");
    expect(appUpdateView({ state: "permission" }).button).toBe("继续安装");
    expect(appUpdateView({ state: "failed", message: "网络不通" }).line).toContain("网络不通");
    expect(appUpdateView({ state: "current" })).toEqual({ line: "", button: "" });
    expect(appUpdateView(null).line).toBe("");
    expect(progressLine(15, 60)).toBe("正在下载新版 App 25%");
    expect(progressLine(5, 0)).toBe("正在下载新版 App 0%");
  });
});
