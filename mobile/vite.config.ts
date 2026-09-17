import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    // release 包里的日志是关的，产物里的 source map 我们根本读不到，只是白占
    // 110 KB 并且把源码一起发出去。
    sourcemap: false,
  },
});
