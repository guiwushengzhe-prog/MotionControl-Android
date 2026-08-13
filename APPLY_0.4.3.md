# MotionBridge 0.4.3 接手修复包

## 用法

本 ZIP 是“覆盖式源码补丁”，目录结构与 `F:\switch` 根目录一致。

1. 先关闭正在运行的 MotionBridge。
2. 可选但建议：复制一份当前 `F:\switch` 作为备份，或至少备份本补丁将覆盖的同名文件。
3. 将本 ZIP **直接解压到 `F:\switch`**，允许覆盖同名文件。
4. 双击根目录新增的 `BUILD_MOBILE_0.4.3.cmd`，重新生成手机 APK。
5. APK 成功后会额外复制到：
   `F:\switch\output\MotionBridge-Mobile-0.4.3-debug.apk`
6. PC 端建议先从源码运行，验证真人 Pose / 语音 / 宏闭环后再重打 portable 包：
   `F:\switch\.venv-pc\Scripts\python.exe F:\switch\run_motionbridge.py`

## 这次补齐的基础链路

### 1. Pose / 相机
- 已审计当前 `NativeCameraRuntime.java`：MediaPipe 的 `ImageProcessingOptions(rotationDegrees)` 已负责旋转，归一化关键点编码没有再次手工旋转。
- 推理分辨率策略已存在：`640×360` 平衡档、`960×540` 重定位档、`480×270` 回退档。
- 已有独立的 capture / inference / poseCount / detect error 等诊断。
- **注意：这些相机修复在上传源码中已经存在；本次没有把它虚报成重新修复。**
- 仍需真机验证“完整站立 → 持续 33 点”，以及前置→后置→再次前置的完整往返。

### 2. 原生麦克风 / 中文语音
- 保留 Android `AudioRecord` 16 kHz / mono / PCM16 原生采集链。
- 修正 Android API 24–25 的 Base64 兼容问题：由 `java.util.Base64` 改为 `android.util.Base64`。
- `audio_ready` 现在会报告 Vosk 当前是否启用了命令 grammar、可用短语数量和不支持短语数量。
- Vosk 优先使用“完整可说命令”的动态 grammar，并保留 `[unk]`；模型不支持动态 grammar 时自动退回开放识别。
- grammar 只纳入模型词典能拆分的短语，避免单个 OOV（词表外词）把整套命令识别拖垮。

### 3. 组合键 / 宏命令
- 已把现有 `motionbridge/macros.py` 真正接入服务运行时，而不是只留一个未使用模块。
- 支持：tap / down / up / hold / toggle / chord / sequence / delay / axis / axis_ramp。
- 支持动作、语音、区域、手持输入四类触发源。
- 支持 cooldown、互斥组、repeat 策略、释放取消、手动测试。
- 新增 REST API 与桌面端“组合键 / 宏命令”编辑器。
- LT / RT 视为模拟轴，不再错误地按普通按钮输出。
- 自动修复《黑神话：悟空》已知的 LT / RT 旧映射缺陷；只修 exact-known-bad 签名，避免覆盖用户自定义映射，并会先生成备份。

## 已跑过的自动测试

在接手环境中：

- Python 主回归（排除缺失的研究模型测试、Linux 无法运行的 ViGEm Windows 驱动测试）：`88 passed`
- TypeScript：`npm run check` 通过
- Desktop JS：`node --check desktop/assets/app.js` 通过
- Python 关键模块：`py_compile` 通过

两个被排除的测试不是发现了产品回归：
- `tests/test_action_model_onnx.py`：交接 ZIP 按要求没有包含 `models/internal-research-only`。
- `tests/test_vigem_driver.py`：接手环境是 Linux，而 ViGEm 是 Windows 驱动链。

## 当前绝不能写成“已验证”的项目

- 真人在新 APK 上持续检测到 33 点：待真机。
- 中文真人语音能稳定识别并执行：待真机 + PC。
- 宏在真实游戏中按正确顺序执行：待 Windows + 游戏。
- 前置→后置→再次前置完整连续往返：仍未形成有效证据。

## 很重要：不要继续安装旧 APK

交接 ZIP 中的 `mobile/android/app/build/outputs/apk/debug/app-debug.apk` 时间早于当前 `NativeCameraRuntime.java` / `main.ts` 源码约 56 分钟，所以它不是当前源码的有效构建产物。必须重新 build。
