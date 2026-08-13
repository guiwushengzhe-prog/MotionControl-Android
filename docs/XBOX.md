# Xbox 虚拟手柄输出

MotionBridge 内置一层很小的 ViGEmClient（虚拟手柄用户态客户端）封装，连接 ViGEmBus（Windows 虚拟手柄内核驱动），向游戏呈现一只 Xbox 360 手柄。不再运行 `vgamepad` 的安装脚本。

ViGEmBus 已停止维护，但目前仍是该 Python 链路所依赖的驱动。安装是系统级变更，所以基础安装脚本不会静默安装它。

1. 运行驱动检查：

   ```powershell
   .\scripts\enable-xbox.ps1
   ```

2. 如果显示未安装，再从官方发布页安装签名驱动：<https://github.com/nefarius/ViGEmBus/releases>
3. 按安装器要求重启电脑。
4. 启动 MotionBridge，电脑面板应显示“Xbox 虚拟手柄 · 可用”。
5. 在 Windows 运行 `joy.cpl`，应看到 Xbox 360 Controller，并能观察按钮和摇杆变化。

本机开发验证还会直接调用 Windows `XInputGetState`（读取 Xbox 手柄状态的系统函数），确认 A 键、摇杆、归零和设备移除，不依赖控制面板截图判断成功。

不要把“脚本已运行”当成成功。最终验收是 `joy.cpl` 看到控制器、动作改变输入状态、停止输出后全部回到中立。
