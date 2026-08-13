from __future__ import annotations

from motionbridge.mapping import MappingEngine
from motionbridge.models import Binding, MappingProfile, Target


class FakeRouter:
    def __init__(self) -> None:
        self.digital: list[tuple[str, str, bool, str]] = []
        self.axes: list[tuple[str, float]] = []
        self.motion = 0
        self.released = 0

    def set_digital(self, kind: str, control: str, active: bool, mode: str) -> None:
        self.digital.append((kind, control, active, mode))

    def set_axis(self, control: str, value: float) -> None:
        self.axes.append((control, value))

    def update_motion(self, signals: dict) -> None:
        self.motion += 1

    def tick(self) -> None:
        pass

    def release_all(self) -> None:
        self.released += 1


def test_pulse_only_fires_on_rising_edge() -> None:
    router = FakeRouter()
    engine = MappingEngine(router)  # type: ignore[arg-type]
    engine.select(MappingProfile(
        id="test",
        name="test",
        bindings=[Binding(id="jump", signal="jump", target=Target(kind="gamepad_button", control="A"), mode="pulse")],
    ))
    engine.process({"jump": True})
    engine.process({"jump": True})
    engine.process({"jump": False})
    engine.process({"jump": True})
    assert router.digital == [
        ("gamepad_button", "A", True, "pulse"),
        ("gamepad_button", "A", True, "pulse"),
    ]


def test_analog_deadzone_scale_and_invert() -> None:
    router = FakeRouter()
    engine = MappingEngine(router)  # type: ignore[arg-type]
    engine.select(MappingProfile(
        id="analog",
        name="analog",
        bindings=[Binding(
            id="lean", signal="lean_x", target=Target(kind="gamepad_axis", control="LX"),
            mode="analog", scale=2.0, deadzone=0.2, invert=True,
        )],
    ))
    engine.process({"lean_x": 0.05})
    engine.process({"lean_x": 0.4})
    assert router.axes == [("LX", 0.0), ("LX", -0.8)]

