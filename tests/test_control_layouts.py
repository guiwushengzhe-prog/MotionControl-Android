from __future__ import annotations

from pathlib import Path
import os

import pytest

from motionbridge.control_layouts import (
    CameraLayoutKey,
    ControlLayout,
    ControlLayoutStore,
    NormalizedRegion,
    RegionStateMachine,
    TriggerRegion,
    recommended_regions,
)
from motionbridge.intents import InputIntent, InputIntentEngine, IntentBinding


def camera(lens: str = "main", orientation: int = 0) -> CameraLayoutKey:
    return CameraLayoutKey(
        device_id="phone-a",
        lens_id=lens,
        facing="environment",
        orientation_degrees=orientation,
    )


def test_layout_persists_reads_back_and_preserves_calibration_history(tmp_path: Path) -> None:
    store = ControlLayoutStore(tmp_path)
    layout = store.create(
        "地平线站姿",
        "player-1",
        "fh4",
        camera(),
        calibration_session_ids=["day-1"],
    )
    edited = store.get(layout.id)
    edited.calibration_session_ids = ["day-2"]
    edited.center = {"x": 0.1, "y": -0.2}
    store.save(edited)

    reloaded = ControlLayoutStore(tmp_path).get(layout.id)
    assert reloaded.center == {"x": 0.1, "y": -0.2}
    assert reloaded.calibration_session_ids == ["day-1", "day-2"]
    assert reloaded.regions[0].name == "前方驾驶区"


def test_copy_rename_export_import_and_atomic_invalid_import(tmp_path: Path) -> None:
    store = ControlLayoutStore(tmp_path / "source")
    layout = store.create("原布局", "player-1", "black_myth_wukong", camera())
    clone = store.copy(layout.id, "副本")
    renamed = store.rename(clone.id, "低运动量")
    assert renamed.name == "低运动量"

    exported = store.export(layout.id)
    target = ControlLayoutStore(tmp_path / "target")
    imported = target.import_json(exported)
    assert imported.model_dump() == target.get(layout.id).model_dump()
    before = list((tmp_path / "target").iterdir())
    with pytest.raises(ValueError):
        target.import_json('{"id":"broken"}')
    assert list((tmp_path / "target").iterdir()) == before

    target.delete(layout.id)
    with pytest.raises(KeyError):
        target.get(layout.id)


def test_failed_atomic_replace_preserves_previous_layout(tmp_path: Path, monkeypatch) -> None:
    store = ControlLayoutStore(tmp_path)
    layout = store.create("原名称", "player-1", "fh4", camera())
    edited = store.get(layout.id)
    edited.name = "不应落盘"

    def fail_replace(source: str | os.PathLike[str], target: str | os.PathLike[str]) -> None:
        raise OSError("simulated interrupted replace")

    monkeypatch.setattr("motionbridge.control_layouts.os.replace", fail_replace)
    with pytest.raises(OSError, match="interrupted"):
        store.save(edited)
    assert store.get(layout.id).name == "原名称"
    assert not list(tmp_path.glob("*.tmp"))


def test_changed_lens_or_orientation_requires_quick_realign(tmp_path: Path) -> None:
    store = ControlLayoutStore(tmp_path)
    layout = store.create("布局", "player-1", "fh4", camera())
    assert store.resolve(layout.id, camera()).needs_realign is False
    changed = store.resolve(layout.id, camera("ultrawide", 90))
    assert changed.needs_realign is True
    assert "镜头已变化" in changed.reasons
    assert "画面方向已变化" in changed.reasons


def test_recommendations_cover_posture_and_low_motion_without_attack_zone() -> None:
    regions = recommended_regions("black_myth_wukong", "seated", "low")
    assert {region.id for region in regions} == {"left_utility", "right_utility"}
    assert all("attack" not in region.id for region in regions)
    assert regions[0].geometry.width == pytest.approx(0.70)


def test_region_dwell_hysteresis_and_immediate_loss_release() -> None:
    region = TriggerRegion(
        id="hold",
        name="保持区",
        point="left_wrist",
        signal="region.hold",
        geometry=NormalizedRegion(x=-0.5, y=-0.5, width=1.0, height=1.0),
        dwell_ms=150,
        cooldown_ms=100,
    )
    machine = RegionStateMachine([region])
    assert machine.update({"left_wrist": (0.0, 0.0)}, 0)["hold"].active is False
    entered = machine.update({"left_wrist": (0.0, 0.0)}, 150)["hold"]
    assert entered.active and entered.entered
    # Slightly outside the nominal rectangle remains held by exit hysteresis.
    assert machine.update({"left_wrist": (0.54, 0.0)}, 160)["hold"].active
    released = machine.update({"left_wrist": (0.9, 0.0)}, 170)["hold"]
    assert released.exited and not released.active

    machine.update({"left_wrist": (0.0, 0.0)}, 300)
    machine.update({"left_wrist": (0.0, 0.0)}, 450)
    lost = machine.update({}, 451, person_tracked=False)["hold"]
    assert lost.exited and not lost.active


def test_pulse_region_fires_once_then_obeys_cooldown() -> None:
    region = TriggerRegion(
        id="pulse",
        name="点按区",
        point="right_wrist",
        signal="region.pulse",
        behavior="pulse",
        geometry=NormalizedRegion(x=-0.5, y=-0.5, width=1.0, height=1.0),
        dwell_ms=50,
        cooldown_ms=200,
    )
    machine = RegionStateMachine([region])
    machine.update({"right_wrist": (0.0, 0.0)}, 0)
    fired = machine.update({"right_wrist": (0.0, 0.0)}, 50)["pulse"]
    assert fired.active and fired.entered
    assert machine.update({"right_wrist": (0.0, 0.0)}, 51)["pulse"].active is False
    # Remaining inside cannot retrigger before cooldown expires.
    assert machine.update({"right_wrist": (0.0, 0.0)}, 249)["pulse"].active is False


def test_intent_or_and_gate_axis_tuning_and_exclusivity() -> None:
    engine = InputIntentEngine([
        IntentBinding(
            id="throttle",
            control="RT",
            kind="axis",
            any_of=("region:driving", "voice:cruise"),
            gates=("pose:driving_posture",),
            sensitivity=0.8,
            deadzone=0.1,
        ),
        IntentBinding(
            id="left",
            control="LX",
            kind="axis",
            all_of=("pose:tracked", "pose:lean_left"),
            priority=1,
            exclusive_group="steer",
        ),
        IntentBinding(
            id="right",
            control="LX",
            kind="axis",
            all_of=("pose:tracked", "pose:lean_right"),
            priority=2,
            exclusive_group="steer",
        ),
    ])
    engine.submit(InputIntent("region", "driving", 0.7))
    assert "RT" not in engine.evaluate().values
    frame = engine.submit(InputIntent("pose", "driving_posture", True))
    assert frame.values["RT"] == pytest.approx(0.56)
    engine.submit(InputIntent("pose", "tracked", True))
    engine.submit(InputIntent("pose", "lean_left", -0.5))
    frame = engine.submit(InputIntent("pose", "lean_right", 0.4))
    assert frame.values["LX"] == pytest.approx(0.4)


def test_voice_semantics_disconnect_and_preset_switch_release_everything() -> None:
    binding = IntentBinding(id="lock", control="R3", kind="digital", any_of=("voice:lock", "region:lock"))
    engine = InputIntentEngine([binding])
    assert engine.submit(InputIntent("voice", "lock", semantics="down")).values["R3"] is True
    released = engine.disconnect("voice")
    assert released.values["R3"] is False
    assert "R3" in released.released_controls

    engine.submit(InputIntent("voice", "lock", semantics="toggle"))
    switched = engine.switch_preset([])
    assert switched.values["R3"] is False
    assert switched.reason == "切换预设"


def test_voice_press_is_one_shot_and_emergency_has_highest_priority() -> None:
    engine = InputIntentEngine([
        IntentBinding(id="interact", control="RT", kind="digital", any_of=("voice:interact",)),
    ])
    pressed = engine.submit(InputIntent("voice", "interact", semantics="press"))
    assert pressed.values["RT"] is True
    released = engine.evaluate()
    assert released.values["RT"] is False

    engine.submit(InputIntent("voice", "interact", semantics="down"))
    stopped = engine.submit(InputIntent("system", "emergency_stop", semantics="down"))
    assert stopped.emergency is True
    assert stopped.values["RT"] is False
