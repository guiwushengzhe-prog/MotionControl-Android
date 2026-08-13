from __future__ import annotations


BUTTON_NAMES = {
    "A": "XUSB_GAMEPAD_A",
    "B": "XUSB_GAMEPAD_B",
    "X": "XUSB_GAMEPAD_X",
    "Y": "XUSB_GAMEPAD_Y",
    "LB": "XUSB_GAMEPAD_LEFT_SHOULDER",
    "RB": "XUSB_GAMEPAD_RIGHT_SHOULDER",
    "BACK": "XUSB_GAMEPAD_BACK",
    "START": "XUSB_GAMEPAD_START",
    "GUIDE": "XUSB_GAMEPAD_GUIDE",
    "L3": "XUSB_GAMEPAD_LEFT_THUMB",
    "R3": "XUSB_GAMEPAD_RIGHT_THUMB",
    "DPAD_UP": "XUSB_GAMEPAD_DPAD_UP",
    "DPAD_DOWN": "XUSB_GAMEPAD_DPAD_DOWN",
    "DPAD_LEFT": "XUSB_GAMEPAD_DPAD_LEFT",
    "DPAD_RIGHT": "XUSB_GAMEPAD_DPAD_RIGHT",
}


class GamepadOutput:
    """Xbox 360 output backed by the bundled ViGEmClient wrapper and ViGEmBus."""

    def __init__(self) -> None:
        self.available = False
        self.last_error: str | None = None
        self.pressed: set[str] = set()
        self.axes = {"LX": 0.0, "LY": 0.0, "RX": 0.0, "RY": 0.0, "LT": 0.0, "RT": 0.0}
        self._vg = None
        self._pad = None

    def start(self) -> None:
        if self.available:
            return
        try:
            from . import vigem as vg

            self._vg = vg
            self._pad = vg.VX360Gamepad()
            self.available = True
        except Exception as exc:  # driver import and connection both fail here
            self.last_error = str(exc)

    def set_button(self, control: str, pressed: bool) -> None:
        control = control.upper()
        if pressed == (control in self.pressed):
            return
        if not self.available or self._pad is None or self._vg is None:
            return
        enum_name = BUTTON_NAMES.get(control)
        if enum_name is None:
            self.last_error = f"unknown Xbox button: {control}"
            return
        button = getattr(self._vg.XUSB_BUTTON, enum_name)
        if pressed:
            self._pad.press_button(button=button)
            self.pressed.add(control)
        else:
            self._pad.release_button(button=button)
            self.pressed.discard(control)
        self._pad.update()

    def set_axis(self, control: str, value: float) -> None:
        control = control.upper()
        value = max(-1.0, min(1.0, float(value)))
        if control in {"LT", "RT"}:
            value = max(0.0, value)
        if abs(self.axes.get(control, 99.0) - value) < 0.005:
            return
        self.axes[control] = value
        if not self.available or self._pad is None:
            return
        if control == "LX":
            self._pad.left_joystick_float(x_value_float=value, y_value_float=self.axes["LY"])
        elif control == "LY":
            self._pad.left_joystick_float(x_value_float=self.axes["LX"], y_value_float=-value)
        elif control == "RX":
            self._pad.right_joystick_float(x_value_float=value, y_value_float=self.axes["RY"])
        elif control == "RY":
            self._pad.right_joystick_float(x_value_float=self.axes["RX"], y_value_float=-value)
        elif control == "LT":
            self._pad.left_trigger_float(value_float=value)
        elif control == "RT":
            self._pad.right_trigger_float(value_float=value)
        else:
            self.last_error = f"unknown Xbox axis: {control}"
            return
        self._pad.update()

    def release_all(self) -> None:
        if self.available and self._pad is not None:
            self._pad.reset()
            self._pad.update()
        self.pressed.clear()
        for key in self.axes:
            self.axes[key] = 0.0

    def close(self) -> None:
        self.release_all()
        if self._pad is not None:
            self._pad.close()
        self._pad = None
        self.available = False
