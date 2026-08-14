# MotionBridge

单手机摄像头体感游戏控制器。手机本地识别人体关键点、手势和语音，电脑端映射为键盘 / Xbox 虚拟手柄 / DSU 体感输出，并支持宏。

## 目录

- `mobile/`：手机端（Capacitor + Android），网页版 MediaPipe 人体/手势识别，原生 AudioRecord 语音采集。
- `motionbridge/`：电脑端 Python 服务（FastAPI + Vosk + ONNX + ViGEm）。
- `desktop/`：电脑端网页面板。
- `docs/`：架构、踩坑记录与长期决策。
- `scripts/`：构建与验证脚本。
- `tests/`：Python 测试。

## 构建

电脑端便携包：

```powershell
.\scripts\build-pc.ps1
```

手机端 APK：

```powershell
.\scripts\build-android.ps1
```

运行开发环境：

```powershell
.\scripts\setup.ps1
.\scripts\start.ps1
```

## 说明

人体识别当前使用网页版 MediaPipe；语音使用手机原生 AudioRecord，失败时回退 WebAudio。详见 `docs/`。
