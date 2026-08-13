# 手机端说明

## 0.2 权限与离线模型

Android 包会请求相机和麦克风权限。拒绝麦克风后身体控制仍可用；拒绝相机则无法运行。APK 内置 Pose Lite/Full/Heavy（轻量/完整/高精度人体模型）、Gesture Recognizer（手势分类器）和 MediaPipe WASM（网页端本地推理模块），首次识别不需要互联网。

运行界面始终提供“切换前后镜头”“左右镜像”和“重新测速”。镜像会同时修正传给电脑的横向坐标，不会出现预览向左而游戏向右。

语音经独立 `/ws/audio` WebSocket（低延迟双向连接）发送 16kHz 单声道 PCM16（16位脉冲编码音频）；断线时电脑立即释放所有语音锁定输入。

## 三种运行方式

1. 同一局域网浏览器：开发最快，但 Android/iOS 浏览器通常要求摄像头页面处于安全上下文（可信 HTTPS 或 localhost）。普通 `http://电脑IP` 可能被拒绝相机权限。
2. PWA（渐进式网页应用）：通过可信 HTTPS 打开后可“添加到主屏幕”，仍受系统浏览器权限规则约束。
3. Android 原生壳：项目已包含 Capacitor（把 Web 应用封装成原生 App 的工具）配置，这是正式测试推荐路径。它从手机本地安全源加载界面，再通过局域网 WebSocket 连接电脑。

## 构建 Android 壳

需要 Android Studio 和 Android SDK（安卓开发工具包）：

```powershell
cd F:\switch\mobile
npm run android:sync
npm run android:open
```

仓库已经包含 `mobile/android` 原生工程，并声明相机、屏幕唤醒和局域网明文连接权限。在 Android Studio 中安装到手机。调试 APK 已完成构建和签名验证，但发布包仍需经过真机摄像头、GPU 与权限测试后再使用正式密钥签名。

当前工作区已经生成经过签名校验的调试 APK：`F:\switch\mobile\android\app\build\outputs\apk\debug\app-debug.apk`。重新构建可直接运行 `F:\switch\scripts\build-android.ps1`。

## 摆放

- 优先用后置广角镜头，手机横放、固定，高度约在腰到胸之间。
- 人与手机距离应让头顶、双手伸展、脚踝都留有 10% 以上边距。
- 光源放在手机后方或侧前方，避免玩家背后强光。
- 识别帧率低于 15 FPS（每秒帧数）时，先把页面保持前台，并关闭省电模式。
