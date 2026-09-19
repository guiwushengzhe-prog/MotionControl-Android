import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// 网页包的版本号，只有 package.json 那一处。
//
// 手机端有两个版本，而且它们会分叉：APK 重发了才变，网页包随时能热更。
// 一半的修复走的是热更，所以"我这版有没有那个修复"这件事，光看 APK
// 版本号是答不了的。写进构建里，而不是在界面上再手敲一个数字。
const webVersion = JSON.parse(readFileSync("package.json", "utf-8")).version;

export default defineConfig({
  base: "./",
  define: { __WEB_VERSION__: JSON.stringify(webVersion) },
  build: {
    target: "es2022",
    // release 包里的日志是关的，产物里的 source map 我们根本读不到，只是白占
    // 110 KB 并且把源码一起发出去。
    sourcemap: false,
  },
});
