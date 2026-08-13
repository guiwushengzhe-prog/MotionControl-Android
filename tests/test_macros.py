from __future__ import annotations

import json

import pytest

from motionbridge.macros import (
    MacroControl,
    MacroDefinition,
    MacroScheduler,
    MacroStep,
    MacroStore,
    MacroTrigger,
)


class FakeRouter:
    def __init__(self) -> None:
        self.digital: dict[tuple[str, str], set[str]] = {}
        self.axes: dict[str, dict[str, tuple[int, float]]] = {}
        self.events: list[tuple] = []

    def set_digital(self, kind: str, control: str, active: bool, mode: str = "hold", *, owner: str = "mapping") -> None:
        key = kind, control
        owners = self.digital.setdefault(key, set())
        owners.add(owner) if active else owners.discard(owner)
        self.events.append(("digital", owner, kind, control, active))

    def set_axis(self, control: str, value: float, *, owner: str = "mapping", priority: int = 0) -> None:
        self.axes.setdefault(control, {})[owner] = (priority, value)
        self.events.append(("axis", owner, control, value))

    def release_control(self, owner: str, kind: str, control: str) -> None:
        if kind == "gamepad_axis":
            self.axes.get(control, {}).pop(owner, None)
        else:
            self.digital.get((kind, control), set()).discard(owner)
        self.events.append(("release_control", owner, kind, control))

    def release_owner(self, owner: str) -> None:
        for owners in self.digital.values():
            owners.discard(owner)
        for owners in self.axes.values():
            owners.pop(owner, None)
        self.events.append(("release_owner", owner))

    def tick(self) -> None:
        pass


def button(control: str) -> MacroControl:
    return MacroControl(kind="gamepad_button", control=control)


def macro(macro_id: str, steps: list[MacroStep], **options) -> MacroDefinition:
    return MacroDefinition(id=macro_id, name=macro_id, steps=steps, **options)


def test_sequence_chord_delay_and_hold_advance_without_sleep() -> None:
    now = [10.0]
    router = FakeRouter()
    scheduler = MacroScheduler(router, clock=lambda: now[0])
    scheduler.load([macro("combo", [
        MacroStep(type="sequence", steps=[
            MacroStep(type="chord", targets=[button("LB"), button("X")], duration_ms=100),
            MacroStep(type="delay", duration_ms=50),
            MacroStep(type="hold", target=button("Y"), duration_ms=80),
        ]),
    ])])

    result = scheduler.trigger("combo")
    assert result["accepted"] is True
    assert router.digital[("gamepad_button", "LB")]
    assert router.digital[("gamepad_button", "X")]
    now[0] += .10
    scheduler.tick()
    assert not router.digital[("gamepad_button", "LB")]
    now[0] += .049
    scheduler.tick()
    assert ("gamepad_button", "Y") not in router.digital
    now[0] += .002
    scheduler.tick()
    assert router.digital[("gamepad_button", "Y")]
    now[0] += .08
    scheduler.tick()
    assert scheduler.status()["active"] == []
    assert not router.digital[("gamepad_button", "Y")]


def test_tap_down_up_toggle_axis_and_ramp() -> None:
    now = [0.0]
    router = FakeRouter()
    scheduler = MacroScheduler(router, clock=lambda: now[0])
    scheduler.load([macro("all", [
        MacroStep(type="tap", target=button("A"), duration_ms=40),
        MacroStep(type="down", target=button("B")),
        MacroStep(type="up", target=button("B")),
        MacroStep(type="toggle", target=button("RB")),
        MacroStep(type="axis", target=MacroControl(kind="gamepad_axis", control="LX"), value=-.5),
        MacroStep(type="axis_ramp", target=MacroControl(kind="gamepad_axis", control="LX"), from_value=-.5, value=1.0, duration_ms=100),
    ])])
    scheduler.trigger("all")
    now[0] = .04
    scheduler.tick()
    now[0] = .09
    scheduler.tick()
    assert router.digital[("gamepad_button", "RB")]
    owner_values = router.axes["LX"]
    assert next(iter(owner_values.values()))[1] == pytest.approx(.25)
    now[0] = .14
    scheduler.tick()
    assert scheduler.status()["active"] == []
    assert router.digital[("gamepad_button", "RB")]
    assert router.axes["LX"] == {}
    scheduler.trigger("all")
    now[0] = .19
    scheduler.tick()
    assert not router.digital[("gamepad_button", "RB")]


def test_trigger_sources_hysteresis_release_cancel_and_manual_trigger() -> None:
    now = [1.0]
    router = FakeRouter()
    scheduler = MacroScheduler(router, clock=lambda: now[0])
    definition = macro(
        "voice-hold",
        [MacroStep(type="hold", target=button("X"), duration_ms=1000)],
        triggers=[MacroTrigger(
            id="spoken", source="voice", signal="intent_attack",
            threshold=.7, release_threshold=.3, release_cancels=True,
        )],
    )
    scheduler.load([definition])
    scheduler.update_source("voice", {"intent_attack": .6})
    assert scheduler.status()["active"] == []
    scheduler.update_source("voice", {"intent_attack": .8})
    assert scheduler.status()["active"][0]["source"] == "voice"
    scheduler.update_source("voice", {"intent_attack": .5})
    assert scheduler.status()["active"]
    scheduler.update_source("voice", {"intent_attack": .2})
    assert scheduler.status()["active"] == []
    assert not router.digital[("gamepad_button", "X")]

    scheduler.trigger("voice-hold", source="manual")
    assert scheduler.status()["active"]
    scheduler.cancel_source("voice")
    assert scheduler.status()["active"]  # A voice disconnect cannot cancel a body/manual macro.


def test_repeat_queue_restart_mutex_cooldown_and_cancel_all() -> None:
    now = [0.0]
    router = FakeRouter()
    scheduler = MacroScheduler(router, clock=lambda: now[0])
    scheduler.load([
        macro("queued", [MacroStep(type="hold", target=button("A"), duration_ms=100)], repeat_policy="queue", max_queue=1),
        macro("restart", [MacroStep(type="hold", target=button("B"), duration_ms=100)], repeat_policy="restart"),
        macro("exclusive", [MacroStep(type="hold", target=button("X"), duration_ms=100)], mutex_group="attack"),
        macro("reject", [MacroStep(type="hold", target=button("Y"), duration_ms=100)], mutex_group="attack", mutex_policy="reject_new"),
        macro("cool", [MacroStep(type="tap", target=button("LB"), duration_ms=10)], cooldown_ms=500),
    ])
    assert scheduler.trigger("queued")["accepted"]
    assert scheduler.trigger("queued")["state"] == "queued"
    assert scheduler.trigger("queued")["accepted"] is False
    first = scheduler.trigger("restart")["run_id"]
    second = scheduler.trigger("restart")["run_id"]
    assert first != second
    scheduler.trigger("exclusive")
    assert scheduler.trigger("reject")["accepted"] is False
    assert scheduler.trigger("cool")["accepted"]
    assert scheduler.trigger("cool")["accepted"] is False
    scheduler.cancel_all("紧急停止")
    assert scheduler.status()["active"] == []
    assert scheduler.status()["queued"] == {}
    assert all(not owners for owners in router.digital.values())


def test_p2_keyboard_is_rejected_but_gamepad_runs() -> None:
    router = FakeRouter()
    scheduler = MacroScheduler(router, player_slot=1)
    scheduler.load([
        macro("keyboard", [MacroStep(type="tap", target=MacroControl(kind="keyboard", control="SPACE"), duration_ms=50)]),
        macro("xbox", [MacroStep(type="tap", target=button("A"), duration_ms=50)]),
    ])
    assert scheduler.trigger("keyboard")["accepted"] is False
    assert "二号玩家" in scheduler.status()["last_event"]["reason"]
    assert scheduler.trigger("xbox")["accepted"] is True


def test_store_copy_rename_import_export_conflict_and_atomic_save(tmp_path) -> None:
    store = MacroStore(tmp_path / "macros", install_defaults=False)
    first = macro(
        "one", [MacroStep(type="tap", target=button("A"), duration_ms=80)],
        triggers=[MacroTrigger(id="t-one", source="voice", signal="intent_jump")],
    )
    second = macro(
        "two", [MacroStep(type="tap", target=button("B"), duration_ms=80)],
        triggers=[MacroTrigger(id="t-two", source="voice", signal="intent_jump")],
    )
    store.save(first)
    store.save(second)
    assert store.conflicts("one")[0]["other_macro_id"] == "two"
    clone = store.copy("one", "复制宏")
    assert clone.id.startswith("macro-")
    assert store.rename(clone.id, "已改名").name == "已改名"
    exported = json.loads(store.export("one"))
    imported = store.import_payload(exported)
    assert imported.id.startswith("one-import-")
    assert not list((tmp_path / "macros").glob("*.tmp"))
    store.delete(clone.id)
    assert all(item.id != clone.id for item in store.list())
