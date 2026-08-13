from __future__ import annotations

import ctypes
import platform
from enum import IntFlag
from pathlib import Path


VIGEM_ERROR_NONE = 0x20000000


class XUSB_BUTTON(IntFlag):
    XUSB_GAMEPAD_DPAD_UP = 0x0001
    XUSB_GAMEPAD_DPAD_DOWN = 0x0002
    XUSB_GAMEPAD_DPAD_LEFT = 0x0004
    XUSB_GAMEPAD_DPAD_RIGHT = 0x0008
    XUSB_GAMEPAD_START = 0x0010
    XUSB_GAMEPAD_BACK = 0x0020
    XUSB_GAMEPAD_LEFT_THUMB = 0x0040
    XUSB_GAMEPAD_RIGHT_THUMB = 0x0080
    XUSB_GAMEPAD_LEFT_SHOULDER = 0x0100
    XUSB_GAMEPAD_RIGHT_SHOULDER = 0x0200
    XUSB_GAMEPAD_GUIDE = 0x0400
    XUSB_GAMEPAD_A = 0x1000
    XUSB_GAMEPAD_B = 0x2000
    XUSB_GAMEPAD_X = 0x4000
    XUSB_GAMEPAD_Y = 0x8000


class XUSB_REPORT(ctypes.Structure):
    _fields_ = [
        ("wButtons", ctypes.c_ushort),
        ("bLeftTrigger", ctypes.c_ubyte),
        ("bRightTrigger", ctypes.c_ubyte),
        ("sThumbLX", ctypes.c_short),
        ("sThumbLY", ctypes.c_short),
        ("sThumbRX", ctypes.c_short),
        ("sThumbRY", ctypes.c_short),
    ]


ERROR_NAMES = {
    0xE0000001: "ViGEmBus driver not found",
    0xE0000002: "no free virtual gamepad slot",
    0xE0000008: "ViGEmBus version mismatch",
    0xE0000009: "ViGEmBus access denied",
}


def _check(code: int, operation: str) -> None:
    code &= 0xFFFFFFFF
    if code != VIGEM_ERROR_NONE:
        detail = ERROR_NAMES.get(code, f"ViGEm error 0x{code:08X}")
        raise RuntimeError(f"{operation}: {detail}")


class VX360Gamepad:
    """Small Xbox 360 wrapper over ViGEmClient, without vgamepad's MSI installer."""

    def __init__(self) -> None:
        if platform.system() != "Windows" or platform.architecture()[0] != "64bit":
            raise RuntimeError("bundled Xbox output currently requires 64-bit Windows")
        dll_path = Path(__file__).parent / "native" / "x64" / "ViGEmClient.dll"
        if not dll_path.exists():
            raise RuntimeError(f"ViGEmClient.dll is missing: {dll_path}")
        self._dll = ctypes.CDLL(str(dll_path))
        self._bind()
        self._client: int | None = self._dll.vigem_alloc()
        self._target: int | None = None
        if not self._client:
            raise RuntimeError("vigem_alloc returned null")
        try:
            _check(self._dll.vigem_connect(self._client), "vigem_connect")
            self._target = self._dll.vigem_target_x360_alloc()
            if not self._target:
                raise RuntimeError("vigem_target_x360_alloc returned null")
            _check(self._dll.vigem_target_add(self._client, self._target), "vigem_target_add")
            self.report = XUSB_REPORT()
            self.update()
        except Exception:
            self.close()
            raise

    def _bind(self) -> None:
        dll = self._dll
        dll.vigem_alloc.argtypes = ()
        dll.vigem_alloc.restype = ctypes.c_void_p
        dll.vigem_free.argtypes = (ctypes.c_void_p,)
        dll.vigem_free.restype = None
        dll.vigem_connect.argtypes = (ctypes.c_void_p,)
        dll.vigem_connect.restype = ctypes.c_uint
        dll.vigem_disconnect.argtypes = (ctypes.c_void_p,)
        dll.vigem_disconnect.restype = None
        dll.vigem_target_x360_alloc.argtypes = ()
        dll.vigem_target_x360_alloc.restype = ctypes.c_void_p
        dll.vigem_target_add.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        dll.vigem_target_add.restype = ctypes.c_uint
        dll.vigem_target_remove.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        dll.vigem_target_remove.restype = ctypes.c_uint
        dll.vigem_target_free.argtypes = (ctypes.c_void_p,)
        dll.vigem_target_free.restype = None
        dll.vigem_target_x360_update.argtypes = (ctypes.c_void_p, ctypes.c_void_p, XUSB_REPORT)
        dll.vigem_target_x360_update.restype = ctypes.c_uint

    def press_button(self, button: XUSB_BUTTON) -> None:
        self.report.wButtons |= int(button)

    def release_button(self, button: XUSB_BUTTON) -> None:
        self.report.wButtons &= ~int(button)

    def left_trigger_float(self, value_float: float) -> None:
        self.report.bLeftTrigger = round(max(0.0, min(1.0, value_float)) * 255)

    def right_trigger_float(self, value_float: float) -> None:
        self.report.bRightTrigger = round(max(0.0, min(1.0, value_float)) * 255)

    def left_joystick_float(self, x_value_float: float, y_value_float: float) -> None:
        self.report.sThumbLX = round(max(-1.0, min(1.0, x_value_float)) * 32767)
        self.report.sThumbLY = round(max(-1.0, min(1.0, y_value_float)) * 32767)

    def right_joystick_float(self, x_value_float: float, y_value_float: float) -> None:
        self.report.sThumbRX = round(max(-1.0, min(1.0, x_value_float)) * 32767)
        self.report.sThumbRY = round(max(-1.0, min(1.0, y_value_float)) * 32767)

    def reset(self) -> None:
        self.report = XUSB_REPORT()

    def update(self) -> None:
        if self._client and self._target:
            _check(self._dll.vigem_target_x360_update(self._client, self._target, self.report), "vigem_target_x360_update")

    def close(self) -> None:
        target, client = getattr(self, "_target", None), getattr(self, "_client", None)
        self._target = None
        self._client = None
        if target and client:
            self._dll.vigem_target_remove(client, target)
            self._dll.vigem_target_free(target)
        if client:
            self._dll.vigem_disconnect(client)
            self._dll.vigem_free(client)

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

