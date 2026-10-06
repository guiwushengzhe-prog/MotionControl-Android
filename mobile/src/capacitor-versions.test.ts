import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 网页包会热更到已经装好的 APK 上：网页里的 @capacitor/core 必须和那些壳子的原生层同一个大版本，
// 否则插件调用的桥接协议对不上。所以运行时（core、android、各插件）一起升，而且只能随新 APK 一起升，
// 并给网页包写上 min_native_api，免得新网页送到旧壳子上。
// @capacitor/cli 只是构建工具：它生成的 Android 文件和同大版本的 CLI 逐字一致（CI 里 sync 之后会
// 检查受版本管理的生成文件没有变化），所以允许比运行时新——它自带已修补的 tar，降回 6 反而会带回漏洞。
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const major = (range: string) => Number(/\d+/.exec(range)?.[0] ?? NaN);

describe("Capacitor 版本", () => {
  it("运行时的 core、android 和插件是同一个大版本", () => {
    const runtime = { ...pkg.dependencies, ...pkg.devDependencies };
    const majors = Object.entries(runtime)
      .filter(([name]) => name.startsWith("@capacitor/") && name !== "@capacitor/cli")
      .map(([name, range]) => [name, major(String(range))] as const);
    expect(majors.length).toBeGreaterThanOrEqual(3);
    expect(new Set(majors.map(([, value]) => value)).size, JSON.stringify(majors)).toBe(1);
  });

  it("构建工具 CLI 不比运行时旧", () => {
    expect(major(pkg.devDependencies["@capacitor/cli"])).toBeGreaterThanOrEqual(major(pkg.dependencies["@capacitor/core"]));
  });
});
