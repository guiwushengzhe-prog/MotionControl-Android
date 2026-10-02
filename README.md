# MotionControl Android 2.3.0

配套 MotionControl 的手机应用：本地 Full 姿态与手部识别、Vosk 语音、手持传感器和蓝牙控制。手机摄像头发送控制关键点，由电脑统一映射和输出。

当前手机入口在 `mobile/`；电脑端和云端在 [MotionControl](https://github.com/guiwushengzhe-prog/MotionControl) 的 `server.py`、`motioncontrol/`、`web/` 与 `cloud/`。PC 管理界面是 `http://127.0.0.1:8766`，手机接入 `ws://<电脑地址>:8765/ws/input`。

本轮保留界面和 2.3.0 版本，尚未正式发布新 APK 或完整 PC 便携包。逐项进度、本轮 Worker 等改动、后置的实机/兼容/长期稳定性验收，以及双仓配套、网页更新和回退边界，见[优化进度与维护](mobile/docs/optimization-progress.md)。此前协调改动与验证命令见[协调优化记录](mobile/docs/coordination-optimization.md)。

## 目录

- `mobile/`：当前手机端（Capacitor + Android），MediaPipe 视觉与原生 Vosk `SpeechService` 语音，包含网页和原生测试。
- `motionbridge/`：保留的早期电脑 Python 服务，见[历史目录说明](motionbridge/README.md)。
- `desktop/`：早期电脑网页面板，见[历史目录说明](desktop/README.md)。
- `mobile/docs/`：当前手机优化与维护记录。
- `docs/`：架构与历史实验记录，阅读时核对所描述的版本。
- `scripts/`、`tests/`：包含历史桌面脚本/测试，当前 Android 构建入口如下。

## 源码开发与构建

从本仓根目录进入 `mobile/`，与 CI 一致使用 Node 24、JDK 21、Android SDK 36 和 build-tools 35.0.0：

```text
cd mobile
npm ci
npm run check
npm test
npm run test:controller
npm run android:sync
```

再运行原生测试和 Debug 构建：

```powershell
.\android\gradlew.bat -p android testDebugUnitTest assembleDebug --no-daemon
```

Linux 对应命令为 `bash android/gradlew -p android testDebugUnitTest assembleDebug --no-daemon`。输出在 `mobile/android/app/build/outputs/apk/debug/app-debug.apk`，使用调试签名；根目录 `scripts/build-android.ps1` 同样生成 Debug。正式 Release 构建要求已有发行密钥配置，见 `mobile/android/keystore.properties.example`，不要将密钥提交到仓库。

网页开发从 `mobile/` 运行 `npm run dev`，相机使用需要浏览器允许的安全上下文。验证 Android 原生插件使用 APK 路径。`scripts/start.ps1`、`scripts/setup.ps1`、`scripts/build-pc.ps1` 和 `scripts/verify-release.py` 面向历史 MotionBridge 桌面实验，不是当前 PC 启动或打包入口。

## 说明

人体与手部识别在手机本地运行；主要语音路径为原生 Vosk `SpeechService`，最终 `voice_text` 交给 PC 同一映射边界。生产网页构建写入 `dist/build-provenance.json`，PC 装配须显式选择该 dist，不能只凭相同版本号判断配套。

签名网页更新下次启动才切换，启动健康确认失败时回到 APK 内置网页；网页更新不会更新或回退原生 APK。涉及原生能力应安装配套 APK。完整流程及验证边界见[维护文档](mobile/docs/optimization-progress.md)。

## 许可证

Copyright (C) 2026 guiwushengzhe

本项目采用 **GNU Affero General Public License v3.0**（AGPL-3.0），完整条文见
[LICENSE](LICENSE)。

你可以自由使用、研究、修改和分发这份代码；但分发修改版、或把修改版当成网络
服务给别人用，都必须同样以 AGPL-3.0 公开完整源码。

第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，各自遵循自己的
许可证。
