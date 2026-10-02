# 历史电脑服务

这里保留 MotionBridge 早期 Python 服务，用于查阅算法与旧协议；当前 2.3.0 手机应用配套的是 [MotionControl](https://github.com/guiwushengzhe-prog/MotionControl) 的 `server.py`、`motioncontrol/` 和 `web/`。

本仓 `scripts/start.ps1` 调用 `motionbridge.cli`，`scripts/build-pc.ps1` 打包早期 `MotionBridge.exe`，`scripts/verify-release.py` 检查早期 `/api/status`、`/ws/audio` 和 DSU。这些操作不能用于构建或验证当前 PC 产品。

本目录未搬动或删除。当前开发入口和配套流程见[仓库 README](../README.md)与[优化进度](../mobile/docs/optimization-progress.md)。修改历史实现时应单独说明目标，不将其测试结果记为当前控制链路验收。
