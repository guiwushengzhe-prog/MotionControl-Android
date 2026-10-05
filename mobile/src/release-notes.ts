// 手机网页热更看得见：下好了、装不上、换上了，都在「更多设置」里说一句；换上的是
// 功能更新（更新日志里写了新增、变更、移除）才弹一次「这次更新了什么」，只修问题、
// 系统维护的安静换上。
//
// 说明文字来自电脑端打包时写进网页包的 release-notes.json（和网页包一起签名），
// 只收「网页 x.y.z」那些条目——按 CHANGELOG 的约定，它们才是随热更送到手机的改动。

export type ReleaseSection = { title?: string; intro?: string; items?: string[] };
export type Release = { version: string; channel?: string; date?: string; kind?: string; sections?: ReleaseSection[] };
export type ReleaseNotes = { releases?: Release[] };

export const SEEN_WEB_VERSION_KEY = "motionbridge-seen-web-version";

export function versionKey(text: unknown): [number, number, number] {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(String(text ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

export function compareVersions(left: unknown, right: unknown): number {
  const a = versionKey(left), b = versionKey(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** 比 seen 新、不比 current 新的网页条目；里面没有功能更新就是空的（不弹）。 */
export function pendingReleases(notes: ReleaseNotes | null, seen: string, current: string): Release[] {
  const releases = (notes?.releases ?? []).filter(release =>
    (release.channel ?? "web") === "web" && compareVersions(release.version, seen) > 0 && compareVersions(release.version, current) <= 0);
  return releases.some(release => release.kind === "feature") ? releases : [];
}

/** 「更多设置」里那一行：热更这一次走到了哪一步。 */
export function webUpdateLine(state: string, message?: string): string {
  switch (state) {
    case "ready": return "网页更新已下载，下次打开 App 生效";
    case "current": return "网页已是最新";
    case "incompatible": return message ? `${message}，先安装新版手机 App` : "电脑上有新网页，但需要先安装新版手机 App";
    case "unsigned": return "电脑带的网页更新签名不对，没有安装";
    case "failed": return "网页更新没下完，连上电脑后会再试";
    default: return "";
  }
}

export async function readReleaseNotes(fetcher: typeof fetch = fetch): Promise<ReleaseNotes | null> {
  try {
    const response = await fetcher("./release-notes.json", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    return data && typeof data === "object" && Array.isArray(data.releases) ? data as ReleaseNotes : null;
  } catch {
    return null; // APK 自带的网页没有这个文件，那就不弹
  }
}

// 条目里的 **粗体** 照样加粗；一律当文字，不拼 HTML。
function appendInline(parent: HTMLElement, text: string): void {
  for (const part of String(text).split(/(\*\*[^*]+\*\*)/)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong"); strong.textContent = part.slice(2, -2); parent.appendChild(strong);
    } else parent.appendChild(document.createTextNode(part.replace(/`/g, "")));
  }
}

export function renderReleases(container: HTMLElement, releases: Release[]): void {
  container.replaceChildren();
  for (const release of releases) {
    const block = document.createElement("section");
    if (releases.length > 1) {
      const head = document.createElement("h3"); head.textContent = release.date ? `网页 ${release.version} · ${release.date}` : `网页 ${release.version}`;
      block.appendChild(head);
    }
    for (const section of release.sections ?? []) {
      if (section.title) { const title = document.createElement("h4"); title.textContent = section.title; block.appendChild(title); }
      if (section.intro) { const intro = document.createElement("p"); appendInline(intro, section.intro); block.appendChild(intro); }
      if (section.items?.length) {
        const list = document.createElement("ul");
        for (const item of section.items) { const li = document.createElement("li"); appendInline(li, item); list.appendChild(li); }
        block.appendChild(list);
      }
    }
    container.appendChild(block);
  }
}
