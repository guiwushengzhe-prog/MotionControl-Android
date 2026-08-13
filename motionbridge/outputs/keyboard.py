from __future__ import annotations

import ctypes
import platform
from ctypes import wintypes


KEY_CODES = {
    **{chr(code): code for code in range(ord("A"), ord("Z") + 1)},
    **{str(code): ord(str(code)) for code in range(10)},
    "SPACE": 0x20,
    "ENTER": 0x0D,
    "ESC": 0x1B,
    "TAB": 0x09,
    "SHIFT": 0x10,
    "CTRL": 0x11,
    "ALT": 0x12,
    "LEFT": 0x25,
    "UP": 0x26,
    "RIGHT": 0x27,
    "DOWN": 0x28,
    "F1": 0x70,
    "F2": 0x71,
    "F3": 0x72,
    "F4": 0x73,
    "F5": 0x74,
    "F6": 0x75,
    "F7": 0x76,
    "F8": 0x77,
    "F9": 0x78,
    "F10": 0x79,
    "F11": 0x7A,
    "F12": 0x7B,
}


if platform.system() == "Windows":
    ULONG_PTR = wintypes.WPARAM

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class INPUT_UNION(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT)]

    class INPUT(ctypes.Structure):
        _anonymous_ = ("union",)
        _fields_ = [("type", wintypes.DWORD), ("union", INPUT_UNION)]


class KeyboardOutput:
    def __init__(self) -> None:
        self.pressed: set[str] = set()
        self.available = platform.system() == "Windows"
        self.last_error: str | None = None

    def set_key(self, control: str, pressed: bool) -> None:
        control = control.upper()
        if pressed == (control in self.pressed):
            return
        if not self.available:
            self.last_error = "keyboard injection is only available on Windows"
            return
        code = KEY_CODES.get(control)
        if code is None:
            self.last_error = f"unknown keyboard control: {control}"
            return
        flags = 0 if pressed else 0x0002
        event = INPUT(type=1, ki=KEYBDINPUT(code, 0, flags, 0, 0))
        sent = ctypes.windll.user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(INPUT))
        if sent != 1:
            self.last_error = f"SendInput failed for {control}"
            return
        if pressed:
            self.pressed.add(control)
        else:
            self.pressed.discard(control)

    def release_all(self) -> None:
        for control in tuple(self.pressed):
            self.set_key(control, False)


