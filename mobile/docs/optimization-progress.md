# 2.3.0 优化进度与双仓维护

沿用当前视觉、Full 姿态模型和同帧双手识别。网页和 APK 源码版本保持 **2.3.0**（APK 版本码 `20300`）；本轮不正式发布新 APK 或完整 PC 便携包。依据 2026-10-02《MotionControl 2.3.0 源码审查与优化方案》，实现状态和设备验收分别记录。

## 已落地与本轮范围

| 原方案 | 状态 | Android 范围与验证边界 |
|---|---|---|
| 1.1 配置协调 | 基础已落地 | 接收 PC 权威配置、语音词表与区域状态；PC 统一事务与版本保护。不同 PC/APK/网页组合专项后置。 |
| 1.2 / 1.3 来源和会话 | 已落地 | 相机、模型、socket、录音使用代次，取消及时失效；旧任务不能改新会话。主身体设备所有权由 PC 接入桥维护。真实前后台、拔插及双手机后置。 |
| 1.4 / 2.3 命令与时效 | 已落地 | 有界发送、8 KiB 背压、会话/序号与采集时间；PC 执行器保序、急停失效。时钟不可信时保留兼容路径，真实弱网后置。 |
| 2.1 PC 状态快照 | 配套 PC 已落地 | 状态读取跳过动作示范帧重复生成，快速复制配置，预计算语音冲突、精简响应编码；返回字段和可变隔离保留。合成 CPU 数据见配套 PC 进度文档。 |
| 2.2 推理与交互解耦 | 已落地 | 具备 Worker、OffscreenCanvas、createImageBitmap 能力时默认启用；Full 与同帧双手保持，1 个处理中帧加 1 个可替换最新帧，主线程作有限回退。手模型后台加载，未就绪时身体帧先返回；旧结果/bitmap/worker按代次清理。真实模型 Chromium CPU 对照通过，实机 WebView/GPU/热机后置。 |
| 2.4 页面变化更新 | 配套 PC 已落地 | 电脑前端只更新变化字段，保留事件/目录/菜单节点与焦点，相同骨架不清空画布；49 项相关回归通过。手机保持已有绘图节流与后台处理。 |
| 3.1 时间适配 | PC 已落地 | 手机提供采样时刻，控制内核按可信时间处理；真人跨帧率手感对照后置。 |
| 3.2 能力判断 | 基础已落地 | 原生传感器注册、有效位、样本年龄及 API 能力可读；失鲜不继续当新样本。ARM64、蓝牙权限、旧 WebView 和 16 KiB 原生页专项后置。 |
| 3.3 显示与操作 | 已有浏览器回归 | 当前视觉保留，PC 窄屏/触屏/DPR/焦点适配已补；真实设备组合后置。 |
| 4.1 / 4.2 保存与重连 | 基础已落地 | 地址缓存失败元数据保留，握手与回应有期限、心跳有代次；PC 多文件保存和回滚有行为回归。进程中断与长期故障专项后置。 |
| 4.3 网页更新 | 基础已落地 | 签名/hash 后核验最低原生 API 和协议，必要初始化完成才确认健康；缺少能力使用兼容路径。完整组合矩阵后置。 |
| 4.4 云缓存与离线 | 配套 PC/云已落地 | 云列表批量查询；公开元数据 60 秒 TTL、后台合并刷新、离线保留成功结果与更新时间，已接入云与官方动作库界面；72 项相关回归通过。安装仍直接下载并验签，本地识别与控制独立于云。 |
| 4.5 来源与维护 | 已落地 | 生产 dist 含 commit、dirty、输入及产物摘要；PC 装配显式选择 dist 并校验。当前入口、历史目录、双仓更新/回退说明已补齐。 |

设备冷/热机基线、模型质量、厂商后台、跨版本兼容、强制杀进程及 2/8 小时稳定性均按用户安排后置。原生视觉和设备自动分档是候选实验；没有本轮必做或已完成的架构结论。

## 本轮 Worker 的实际边界

实现入口为 [Worker](../src/vision.worker.ts)、[推理核心](../src/vision-core.ts)、[有界客户端](../src/vision-worker-client.ts)与 `main.ts`。原尺寸 bitmap 转移后按既有 384/448/512 自适应尺寸推理 Full，左右手在同一帧各按 256 尺寸裁剪；保持已有 10 FPS 叠加绘制。手模型独立后台加载，不阻塞身体帧开始返回。

能力缺失、30 秒初始化超时、运行异常或 8 秒帧超时时终止 Worker 并回退既有主线程路径；GPU/CPU 模型恢复保持有限次数，不无限重试。停止、切镜头及连接代次拒绝旧结果，待传 bitmap 被关闭。诊断字段含 `inferenceBackend`、`workerFallbackError`、`workerDroppedFrames`、`workerQueueMs` 和 `mainBusyMs`。

TypeScript、64 项 Vitest、3 项 controller 测试、生产构建及来源记录已通过。`mobile/scripts/benchmark-vision-worker.mjs` 使用真实 Chromium、生产 Worker 与 Full/Hand/WASM，30 帧 CPU 对照通过：每帧 33 身体点及左右各 21 手点，图像点、世界点、手部点逐项最大差为 0；旧 DOMCanvas 与新原尺寸 Bitmap/Offscreen 路径 1,093,120 个采样 RGBA 分量差为 0，无页面错误。双方使用同图、相同时间戳、640 输入档与 CPU 预热；生产自适应档为 384/448/512，本次数据不覆盖各档。

| 固定图、CPU、headless Chromium 对照 | 主线程路径 | Worker 路径 |
|---|---:|---:|
| 主线程同步工作总 P95，含 bitmap 发起 | 179.7 ms | 14.1 ms |
| 10 ms 心跳间隔 P95 | 184.3 ms | 11.0 ms |
| 心跳最大间隔 | 335.2 ms | 24.0 ms |
| 模型总计算均值 | 164.27 ms | 163.55 ms |
| 帧完成总时间均值 | 169.45 ms | 173.34 ms |

测得主线程阻塞减少，帧完成包含线程传输开销；不能据此宣称模型更快或 FPS 提升。从 `mobile/` 可复测：

另用生产尺寸 **512 × 342** 完成三帧正确性烟测：每帧均有 33 身体点和左右各 21 手点，与主线程归一化/世界/手部结果及原始图像缩放像素的最大差均为 0，无页面错误。该烟测与上述 640 输入档的 30 帧性能对照分别记录，不代表其他尺寸、GPU 或设备均已覆盖。

```text
npm run build
node scripts/benchmark-vision-worker.mjs --python <已安装Playwright的Python> --frames 30 --side 640 --warmup 5 --require-hands 2 --out vision-worker-performance.json
```

需要可用 Chromium；可加 `--chromium <浏览器实际路径>` 指定。输出 JSON 记录对照环境和结果。

该对照验证上述输入下的结果一致，不能代替 Android WebView/GPU 的兼容、真人双手质量和持续温升验收。配套 PC 完整本地回归为 1,546 项通过、38 项条件跳过、7 条警告（126.65 秒），其中 30 项真实 Chromium 行为用例；各定向组有重叠，不与全量或 Android 测试相加。跳过项不计为通过，完整本地回归不代替 Windows 设备专项。

## 当前开发入口

当前手机产品在 `mobile/`；PC 服务在[配套 MotionControl 仓库](https://github.com/guiwushengzhe-prog/MotionControl)的 `server.py`、`motioncontrol/` 和 `web/`。PC 的完整进度文档为 `docs/optimization-progress.md`。本仓 `motionbridge/`、`desktop/` 和启动它们的旧脚本留作历史参考，不参与当前发布链。见 [motionbridge 说明](../../motionbridge/README.md)与 [desktop 说明](../../desktop/README.md)。

从仓库根进入 `mobile/`，采用 CI 同样的 Node 24、JDK 21、Android SDK 36 与 build-tools 35.0.0：

```text
npm ci
npm run check
npm test
npm run test:controller
npm run android:sync
```

再执行原生单元测试与 Debug 构建：Linux 用 `bash android/gradlew -p android testDebugUnitTest assembleDebug --no-daemon`；Windows 用 `android\gradlew.bat -p android testDebugUnitTest assembleDebug --no-daemon`。输出位于 `android/app/build/outputs/apk/debug/app-debug.apk`，是调试签名包。`scripts/build-android.ps1` 也构建 Debug，并非正式 Release；正式 `assembleRelease` 必须配置既有发行密钥，见 `android/keystore.properties.example`，密钥不入库。

PC 管理界面为 `http://127.0.0.1:8766`，手机接入为 `ws://<电脑地址>:8765/ws/input`。手机摄像头在本地推理，发送 `pose_features_v1`；正式手机语音由原生 Vosk `SpeechService` 识别并发送 `voice_text`。协议保留旧格式边界，但历史 `motionbridge` 的 `/ws/audio`、DSU 和 `/api/status` 不是当前 PC 验证入口。

## 更新与回退边界

使用现有正式 APK 的用户继续通过当前应用与配套 PC 连接。网页更新由 PC 提供，验签、摘要与最低能力校验通过后写入 `web_next`，下次启动才切换。必要初始化成功后调用启动健康确认；如果没有确认，下次启动移除热更网页并回到 **APK 内置网页**。没有恢复上一份热更网页或回退原生 APK 的承诺。

网页包无法补入旧 APK 缺少的原生插件，涉及原生能力应提供配套 APK。APK 的安装时间用于清理可能覆盖内置页面的旧热更包，不代替原生 API/协议检查。APK 覆盖安装须满足签名和版本码约束；不把卸载/清除数据作为常规回退办法。

PC 对未通过启动健康确认的程序更新，下一次便携启动恢复 `app_previous`；确认成功后删除该备份。用户设置在 `%LOCALAPPDATA%\MotionControl`，人工恢复已知可用正式 PC 包前应停止服务并备份该目录，保留程序目录，避免把配置格式兼容当成已经验证。详见配套 PC 的维护文档。

## 配套发布记录

本轮配套变更见 [Android PR #1](https://github.com/guiwushengzhe-prog/MotionControl-Android/pull/1) 与 [PC PR #10](https://github.com/guiwushengzhe-prog/MotionControl/pull/10)。完整提交和 CI 以两个 PR 的最新提交/检查及总交付记录为准，文档不将自身提交号写为固定发布来源；不能仅凭两边显示 2.3.0 判断它们配套。

生产 `npm run build` 生成 `dist/build-provenance.json`；PC 必须显式传入该 dist 给 `tools/stage_release.py --phone-web`，保留两仓完整 commit、dirty 状态和摘要。发布说明还要记录 APK 版本名/码、网页版本、原生 API/协议、模型 hash、产物 SHA256、签名状态、实际验证与后置项。Debug 构建、APK 签名工具检查或 ZIP 16 KiB 对齐不等于正式发包或所有原生页面设备已验收。

此前已完成的源码回归与构建命令见[协调优化记录](coordination-optimization.md)。`window.__motionDebug` 的阶段计时、最近帧样本、丢帧和恢复信息供后续测量使用；“帧到达后”耗时不应标成曝光到游戏画面的端到端延迟。当前 Vosk 原生库加载失败会报告 `VOICE_LIBRARY_UNAVAILABLE`，16 KiB 原生页兼容尚待专项，不据 ZIP 对齐宣称 ELF 可运行。
