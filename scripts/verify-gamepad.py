from __future__ import annotations

import ctypes
import time
from ctypes import wintypes

from motionbridge.outputs.gamepad import GamepadOutput


class XInputGamepad(ctypes.Structure):
    _fields_ = [
        ("buttons", wintypes.WORD),
        ("left_trigger", ctypes.c_ubyte),
        ("right_trigger", ctypes.c_ubyte),
        ("thumb_lx", ctypes.c_short),
        ("thumb_ly", ctypes.c_short),
        ("thumb_rx", ctypes.c_short),
        ("thumb_ry", ctypes.c_short),
    ]


class XInputState(ctypes.Structure):
    _fields_ = [("packet_number", wintypes.DWORD), ("gamepad", XInputGamepad)]


def main() -> None:
    xinput = ctypes.WinDLL("xinput1_4.dll")
    xinput.XInputGetState.argtypes = [wintypes.DWORD, ctypes.POINTER(XInputState)]
    xinput.XInputGetState.restype = wintypes.DWORD

    outputs = [GamepadOutput(), GamepadOutput()]
    for output in outputs:
        output.start()
        assert output.available, output.last_error
    try:
        outputs[0].set_button("A", True)
        outputs[0].set_axis("LX", 0.75)
        outputs[1].set_button("B", True)
        outputs[1].set_axis("LX", -0.75)
        time.sleep(0.1)
        matches: list[tuple[int, int, int]] = []
        for index in range(4):
            state = XInputState()
            if xinput.XInputGetState(index, ctypes.byref(state)) == 0:
                if state.gamepad.buttons & (0x1000 | 0x2000):
                    matches.append((index, state.gamepad.buttons, state.gamepad.thumb_lx))
        positive = [item for item in matches if item[1] & 0x1000 and item[2] > 20_000]
        negative = [item for item in matches if item[1] & 0x2000 and item[2] < -20_000]
        assert positive, "XInput did not read back player one A/right state"
        assert negative, "XInput did not read back player two B/left state"
        print(f"player1={positive[0]} player2={negative[0]}")
    finally:
        for output in outputs:
            output.close()


if __name__ == "__main__":
    main()
