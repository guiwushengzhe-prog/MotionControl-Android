// App 内更新 APK 的界面规则（原生部分见 AppUpdatePlugin.java）。
// 功能更新（更新日志里写了新增、变更、移除）弹一次「新版 App」说明，可以选以后再说；
// 系统维护版只在「更多设置」里留一行和一个更新按钮，不打扰人。
import type { ReleaseSection } from "./release-notes";

export type AppUpdateState = "none" | "current" | "available" | "unsigned" | "failed" | "ready" | "permission" | "installing";
export type AppUpdateResult = {
  state: AppUpdateState; version?: string; kind?: string; size?: number;
  sections?: ReleaseSection[]; downloaded?: boolean; message?: string;
};

export const APP_UPDATE_CHECKED_KEY = "motionbridge-app-update-checked";
export const APP_UPDATE_DISMISSED_KEY = "motionbridge-app-update-dismissed";
/** 没有新版时最多六小时问一次服务器；上次看到有新版就每次打开都再确认。 */
export const APP_UPDATE_INTERVAL_MS = 6 * 3600 * 1000;

export function shouldCheck(last: { at?: number; state?: string } | null, now: number, forced = false): boolean {
  if (forced || !last || last.state === "available") return true;
  return !(Number(last.at) > 0) || now - Number(last.at) >= APP_UPDATE_INTERVAL_MS;
}

/** 只有功能更新才弹；用户点过「以后再说」的那一版不再弹。 */
export function shouldPrompt(result: AppUpdateResult | null, dismissedVersion: string): boolean {
  return Boolean(result && result.state === "available" && result.kind === "feature" && result.version !== dismissedVersion);
}

function megabytes(size?: number): string {
  return size && size > 0 ? `，${(size / 1024 / 1024).toFixed(1)} MB` : "";
}

/** 「更多设置」里那一行和按钮上的字；空字符串表示不显示。 */
export function appUpdateView(result: AppUpdateResult | null): { line: string; button: string } {
  switch (result?.state) {
    case "available":
      return { line: `新版 App ${result.version ?? ""} 可以更新${megabytes(result.size)}`, button: result.downloaded ? "安装" : "下载并安装" };
    case "ready": return { line: "新版 App 已下载", button: "安装" };
    case "permission": return { line: "请在系统设置里允许本 App 安装应用，回来后再点一次", button: "继续安装" };
    case "installing": return { line: "正在打开系统安装…", button: "" };
    case "unsigned": return { line: "服务器上的新版签名不对，没有下载", button: "" };
    case "failed": return { line: `App 更新没成功：${result.message ?? "请稍后再试"}`, button: "重试" };
    default: return { line: "", button: "" };
  }
}

export function progressLine(done: number, total: number): string {
  const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  return `正在下载新版 App ${percent}%`;
}
