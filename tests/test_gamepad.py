from __future__ import annotations

from motionbridge.outputs.gamepad import GamepadOutput


class FakePad:
    def __init__(self) -> None:
        self.left: tuple[float, float] | None = None
        self.right: tuple[float, float] | None = None
        self.updated = 0

    def left_joystick_float(self, x_value_float: float, y_value_float: float) -> None:
        self.left = (x_value_float, y_value_float)

    def right_joystick_float(self, x_value_float: float, y_value_float: float) -> None:
        self.right = (x_value_float, y_value_float)

    def update(self) -> None:
        self.updated += 1


def test_gamepad_axes_use_x_and_y_keyword_contract() -> None:
    output = GamepadOutput()
    fake = FakePad()
    output.available = True
    output._pad = fake  # type: ignore[assignment]
    output.set_axis("LX", 0.75)
    output.set_axis("LY", -0.25)
    output.set_axis("RX", 0.4)
    output.set_axis("RY", -0.2)
    assert fake.left == (0.75, 0.25)
    assert fake.right == (0.4, 0.2)
    assert fake.updated == 4

