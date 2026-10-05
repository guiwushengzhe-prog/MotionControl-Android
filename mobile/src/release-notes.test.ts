import { afterEach, describe, expect, it, vi } from "vitest";
import { compareVersions, pendingReleases, readReleaseNotes, renderReleases, versionKey, webUpdateLine, type ReleaseNotes } from "./release-notes";

const feature = (version: string) => ({ version, channel: "web", kind: "feature", sections: [{ title: "新增", items: [`**${version} 新功能。** 说明`] }] });
const fix = (version: string) => ({ version, channel: "web", kind: "system", sections: [{ title: "修复", items: ["修了一个问题"] }] });

describe("网页热更说明", () => {
  it("按数字比较版本号", () => {
    expect(versionKey("2.10.0")).toEqual([2, 10, 0]);
    expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
    expect(compareVersions("bad", "0.0.1")).toBeLessThan(0);
  });

  it("只在跳过的几版里有功能更新时才弹，并且一起列出来", () => {
    const notes: ReleaseNotes = { releases: [fix("2.3.4"), feature("2.3.3"), fix("2.3.2"), { ...feature("2.3.3"), channel: "app" }] };
    expect(pendingReleases(notes, "2.3.2", "2.3.4").map(r => r.version)).toEqual(["2.3.4", "2.3.3"]);
    expect(pendingReleases(notes, "2.3.3", "2.3.4")).toEqual([]);
    expect(pendingReleases(null, "2.3.2", "2.3.4")).toEqual([]);
  });

  it("每种热更结果都有一句人话", () => {
    expect(webUpdateLine("ready")).toBe("网页更新已下载，下次打开 App 生效");
    expect(webUpdateLine("incompatible", "此网页更新需要更新手机安装包")).toContain("先安装新版手机 App");
    expect(webUpdateLine("unsigned")).toContain("签名不对");
    expect(webUpdateLine("none")).toBe("");
  });

  it("读不到说明文件就当没有", async () => {
    expect(await readReleaseNotes(vi.fn(async () => ({ ok: false })) as unknown as typeof fetch)).toBeNull();
    expect(await readReleaseNotes(vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
    const ok = vi.fn(async () => ({ ok: true, json: async () => ({ releases: [feature("2.3.3")] }) })) as unknown as typeof fetch;
    expect((await readReleaseNotes(ok))?.releases?.[0].version).toBe("2.3.3");
  });
});

describe("说明内容只当文字", () => {
  type Node = { tag: string; text: string; children: Node[] };
  const created: Node[] = [];
  const make = (tag: string): Node & Record<string, unknown> => {
    const node: Node & Record<string, unknown> = { tag, text: "", children: [] };
    Object.defineProperty(node, "textContent", { set(value: string) { node.text = value; }, get() { return node.text; } });
    node.appendChild = (child: Node) => { node.children.push(child); return child; };
    node.replaceChildren = () => { node.children = []; };
    created.push(node);
    return node;
  };
  afterEach(() => { vi.unstubAllGlobals(); created.length = 0; });

  it("粗体照样加粗，尖括号不变成标签", () => {
    vi.stubGlobal("document", { createElement: make, createTextNode: (text: string) => ({ tag: "#text", text, children: [] }) });
    const container = make("div");
    renderReleases(container as unknown as HTMLElement, [feature("2.3.3"), { version: "2.3.2", sections: [{ items: ["<b>x</b>"] }] }]);
    const flat = (node: Node): Node[] => [node, ...node.children.flatMap(flat)];
    const nodes = flat(container as Node);
    expect(nodes.find(n => n.tag === "h3")?.text).toBe("网页 2.3.3");
    expect(nodes.find(n => n.tag === "strong")?.text).toBe("2.3.3 新功能。");
    expect(nodes.some(n => n.tag === "#text" && n.text === "<b>x</b>")).toBe(true);
    expect(nodes.some(n => n.tag === "b")).toBe(false);
  });
});
