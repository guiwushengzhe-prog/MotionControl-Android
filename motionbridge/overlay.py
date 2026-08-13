from __future__ import annotations

import json
import os
import queue
import threading
from pathlib import Path
from typing import Any


DEFAULT_SETTINGS: dict[str, Any] = {
    "visible": True, "compact": False, "click_through": False,
    "opacity": 0.88, "scale": 1.0, "x": 60, "y": 60,
}


class OverlayController:
    """Independent lightweight Windows overlay; no browser tab is required."""

    def __init__(self, settings_path: Path) -> None:
        self.settings_path = settings_path
        self.settings = dict(DEFAULT_SETTINGS)
        try:
            self.settings.update(json.loads(settings_path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        self.available = os.name == "nt"
        self.last_error: str | None = None
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if not self.available or self._thread:
            return
        self._thread = threading.Thread(target=self._run, name="motionbridge-overlay", daemon=True)
        self._thread.start()

    def close(self) -> None:
        if self._thread:
            self._queue.put(("close", None))
            self._thread.join(timeout=1.5)
        self._thread = None

    def update(self, players: list[dict[str, Any]]) -> None:
        if self._thread:
            self._queue.put(("players", players))

    def configure(self, **changes: Any) -> dict[str, Any]:
        for key, value in changes.items():
            if value is not None and key in DEFAULT_SETTINGS:
                self.settings[key] = value
        self._save()
        if self._thread:
            self._queue.put(("settings", dict(self.settings)))
        return self.status()

    def toggle(self) -> dict[str, Any]:
        return self.configure(visible=not bool(self.settings["visible"]))

    def status(self) -> dict[str, Any]:
        return {"available": self.available, "error": self.last_error, **self.settings}

    def _save(self) -> None:
        try:
            self.settings_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.settings_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self.settings, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(self.settings_path)
        except OSError as exc:
            self.last_error = str(exc)

    def _run(self) -> None:
        try:
            import ctypes
            import ctypes.wintypes
            import tkinter as tk

            root = tk.Tk()
            root.title("MotionBridge 悬浮层")
            root.configure(bg="#0b1014")
            root.overrideredirect(True)
            root.attributes("-topmost", True)
            label = tk.Label(root, text="MotionBridge\n等待玩家", justify="left", bg="#0b1014", fg="#f4f8ed", padx=14, pady=10)
            label.pack()
            drag = {"x": 0, "y": 0}

            def press(event: Any) -> None:
                drag["x"], drag["y"] = event.x, event.y

            def move(event: Any) -> None:
                x, y = root.winfo_x() + event.x - drag["x"], root.winfo_y() + event.y - drag["y"]
                root.geometry(f"+{x}+{y}")
                self.settings["x"], self.settings["y"] = x, y

            def release(_: Any) -> None:
                self._save()

            label.bind("<ButtonPress-1>", press)
            label.bind("<B1-Motion>", move)
            label.bind("<ButtonRelease-1>", release)

            def apply_settings(settings: dict[str, Any]) -> None:
                root.attributes("-alpha", float(settings["opacity"]))
                root.geometry(f"+{int(settings['x'])}+{int(settings['y'])}")
                font_size = max(8, round((10 if settings["compact"] else 12) * float(settings["scale"])))
                label.configure(font=("Microsoft YaHei UI", font_size))
                root.deiconify() if settings["visible"] else root.withdraw()
                hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
                exstyle = ctypes.windll.user32.GetWindowLongW(hwnd, -20)
                transparent = 0x20
                exstyle = exstyle | transparent if settings["click_through"] else exstyle & ~transparent
                ctypes.windll.user32.SetWindowLongW(hwnd, -20, exstyle)

            def render(players: list[dict[str, Any]]) -> None:
                lines = ["MOTIONBRIDGE"]
                for player in players:
                    slot = int(player.get("slot", 0)) + 1
                    profile = player.get("profile_name") or "未选择玩家"
                    tracking = player.get("tracking", {}).get("state", "unassigned")
                    actions = player.get("active_actions", [])
                    voice = player.get("voice", {})
                    lines.append(f"{slot}号 · {profile} · {tracking}")
                    if actions:
                        lines.append("  " + "  ".join(actions[:6]))
                    if voice.get("last_result"):
                        held = voice.get("held") or {}
                        lines.append(f"  语音：{voice['last_result']}  {held}")
                label.configure(text="\n".join(lines))

            apply_settings(self.settings)

            def poll() -> None:
                try:
                    while True:
                        command, payload = self._queue.get_nowait()
                        if command == "close":
                            root.destroy()
                            return
                        if command == "settings":
                            apply_settings(payload)
                        elif command == "players":
                            render(payload)
                except queue.Empty:
                    pass
                root.after(50, poll)

            def hotkey_loop() -> None:
                user32 = ctypes.windll.user32
                if not user32.RegisterHotKey(None, 0x4D42, 0x0002 | 0x0004, 0x79):
                    self.last_error = "Ctrl+Shift+F10 全局快捷键注册失败"
                    return
                message = ctypes.wintypes.MSG()
                while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                    if message.message == 0x0312 and message.wParam == 0x4D42:
                        self.settings["visible"] = not bool(self.settings["visible"])
                        self._save()
                        self._queue.put(("settings", dict(self.settings)))
                user32.UnregisterHotKey(None, 0x4D42)

            threading.Thread(target=hotkey_loop, name="motionbridge-overlay-hotkey", daemon=True).start()
            root.after(50, poll)
            root.mainloop()
        except Exception as exc:
            self.last_error = str(exc)
