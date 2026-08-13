from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path
from typing import Callable


INSTALLER_NAME = "安装虚拟手柄驱动.exe"
INSTALLER_SHA256 = "89220a7865076b342892f98865f3499fb7c4cfd673159e89d352c360fd014c6a"


def application_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def installer_path(root: Path | None = None) -> Path:
    return (root or application_root()) / INSTALLER_NAME


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def service_state(runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run) -> dict[str, object]:
    if os.name != "nt":
        return {"installed": False, "running": False, "error": "仅支持 Windows"}
    try:
        result = runner(
            ["sc.exe", "query", "ViGEmBus"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=5, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"installed": False, "running": False, "error": str(exc)}
    output = f"{result.stdout}\n{result.stderr}".upper()
    installed = result.returncode == 0 and "SERVICE_NAME" in output
    running = installed and ("STATE" in output and "RUNNING" in output)
    return {"installed": installed, "running": running, "error": None if installed else "驱动未安装"}


def driver_status(gamepad_available: bool = False, root: Path | None = None) -> dict[str, object]:
    service = service_state()
    path = installer_path(root)
    installer_ok = path.is_file() and sha256_file(path) == INSTALLER_SHA256
    ready = bool(gamepad_available or service["running"])
    if ready:
        label, hint = "虚拟手柄已就绪", ""
    elif service["installed"]:
        label = "虚拟手柄仍不可用"
        hint = "如从旧版升级，请再次运行安装程序；需要重启时只会提示。"
    else:
        label, hint = "虚拟手柄未安装", "点击按钮后由 Windows 请求管理员授权。"
    return {
        **service,
        "ready": ready,
        "label": label,
        "hint": hint,
        "installer_available": installer_ok,
        "installer_name": INSTALLER_NAME,
        "installer_sha256": INSTALLER_SHA256,
    }


def launch_installer(
    root: Path | None = None,
    shell_execute: Callable[..., int] | None = None,
) -> dict[str, object]:
    path = installer_path(root)
    if not path.is_file():
        raise FileNotFoundError(f"找不到官方安装程序：{INSTALLER_NAME}")
    if sha256_file(path) != INSTALLER_SHA256:
        raise ValueError("驱动安装程序校验失败，已拒绝启动")
    if shell_execute is None:
        if os.name != "nt":
            raise OSError("仅支持 Windows")
        import ctypes

        shell_execute = ctypes.windll.shell32.ShellExecuteW
    result = int(shell_execute(None, "runas", str(path), None, str(path.parent), 1))
    if result <= 32:
        raise OSError(f"Windows 未能启动安装程序（错误 {result}）")
    return {"launched": True, "installer": path.name, "sha256": INSTALLER_SHA256}
