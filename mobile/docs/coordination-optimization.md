# 2.3.0 会话与设备适配优化

保留当前界面、Full 姿态模型、双手识别和空间自适应。相机、模型、身体源、socket 和语音分别使用会话代次；停止先同步失效代次，迟到资源释放自己，旧回调不能修改新会话。

本文记录第一轮协调与能力改动；本轮追加 Worker 及配套 PC 性能、云缓存、前端变化更新的当前状态，见[优化进度与双仓维护](optimization-progress.md)。实机、兼容与长期稳定性专项后置。

连接握手最多 5 秒；服务器回应超过 8 秒不可达时重新连接，每 3 秒更新时钟信息。传感器发送采用 8KiB 背压；原生采样分别报告可用性与样本年龄，过期样本停止刷新，缺少可选传感器继续走兼容路径。

GPU 运行异常最多尝试两次 CPU 恢复，相机停帧或结束最多两次重开；旧 WebView 的摄像头 FPS 仅统计新视频帧。`window.__motionDebug` 保存最近 300 条分阶段计时、丢帧和恢复记录，用于实机诊断。当前测量明确区分采集时刻和帧到达后的耗时。

原生录音加载和资源关闭放在串行后台执行，取消立即使会话失效。Vosk 语音服务在主线程创建，后台退出清理旧资源。蓝牙释放逐个报告检查返回结果。网页更新验证签名后检查原生 API/协议需求，页面必要初始化完成后确认启动成功；旧 APK 保留兼容流程。

## 验证与构建

```bash
npm ci
npm run check
npm test
npm run test:controller
npm run android:sync
bash android/gradlew -p android testDebugUnitTest assembleDebug
```

需要 JDK 21、Android SDK 36 和对应 build-tools。Gradle wrapper 使用官方地址，CI 从干净检出执行网页和 Android 构建。生产网页构建生成 `dist/build-provenance.json`，记录源码 commit、dirty 状态和输入/产物 hash，供桌面装配校验。

回归使用真实入口事件和受控相机、socket、传感器替身；原生纯逻辑通过 JUnit 验证，插件使用准确 Android/Capacitor/Vosk 类库编译。实际设备的蓝牙权限、厂商后台策略、16KiB 原生页兼容、长时功耗和温升仍需实机测量。

当前 Vosk 0.3.47 的 arm64 库 PT_LOAD 对齐为 4KiB，尚不能承诺所有 16KiB 页面设备可用。加载失败会返回 `VOICE_LIBRARY_UNAVAILABLE`；原生库升级需另行检查 ABI、语音识别和设备兼容。

第一轮交付时 Worker 视觉路径尚未启用。本轮已为具备所需能力的设备实现默认 Worker、同帧双手、最新帧单槽和主线程回退，源码、定向回归及真实 Full/Hand/WASM 的 Chromium CPU 对照完成。Android WebView/GPU 的兼容性、真人双手识别质量和持续运行收益仍属后置验收，不能据浏览器对照宣称已完成。

30 帧同图、640 输入档 CPU 对照中，身体/世界/左右手关键点最大差为 0，采样 RGBA 差为 0；主线程同步工作 P95 179.7 → 14.1 ms。模型计算均值基本持平，帧完成均值 169.45 → 173.34 ms，包含传输开销；没有 FPS 提升结论。生产自适应档为 384/448/512，完整输入、指标和复测入口见[本轮进度](optimization-progress.md)。
