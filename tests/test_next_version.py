from __future__ import annotations

import json

import pytest

from motionbridge.mapping import MappingEngine, MappingStore
from motionbridge.models import Binding, MappingProfile, PersonPose, Target
from motionbridge.models import SensorFrame
from motionbridge.outputs.dsu import DSUServer
from motionbridge.recognizer import MotionRecognizer
from motionbridge.sensors import HandheldManager, relative_quaternion
from motionbridge.server import RuntimeState
from motionbridge.tracking import MultiPersonTracker
from motionbridge.voice import VoskStreamRecognizer, VoiceCommandParser, VoiceController, grammar_phrases


class FakeRouter:
    def __init__(self) -> None:
        self.digital: list[tuple[str, str, bool, str]] = []
        self.axes: list[tuple[str, float]] = []

    def set_digital(self, kind: str, control: str, active: bool, mode: str) -> None:
        self.digital.append((kind, control, active, mode))

    def set_axis(self, control: str, value: float) -> None:
        self.axes.append((control, value))

    def update_motion(self, signals: dict) -> None:
        pass

    def tick(self) -> None:
        pass

    def release_all(self) -> None:
        pass


def make_person(x: float, scale: float = 0.18) -> PersonPose:
    points = [{"x": x, "y": 0.5, "z": 0.0, "visibility": 1.0} for _ in range(33)]
    points[11]["x"], points[12]["x"] = x - scale / 2, x + scale / 2
    points[11]["y"] = points[12]["y"] = 0.3
    points[23]["x"], points[24]["x"] = x - scale / 3, x + scale / 3
    points[23]["y"] = points[24]["y"] = 0.55
    return PersonPose(pose=points)


def test_mapping_rejects_duplicate_control(tmp_path) -> None:
    store = MappingStore(tmp_path / "mappings")
    mapping = MappingProfile(id="conflict", name="冲突", bindings=[
        Binding(id="one", signal="jump", target=Target(kind="gamepad_button", control="A")),
        Binding(id="two", signal="squat", target=Target(kind="gamepad_button", control="A")),
    ])
    with pytest.raises(ValueError, match="控制冲突"):
        store.save(mapping)


def test_v1_mapping_is_backed_up_and_migrated(tmp_path) -> None:
    root = tmp_path / "mappings"
    root.mkdir()
    legacy = {"id": "legacy", "name": "旧配置", "bindings": [{
        "id": "jump", "signal": "jump", "target": {"kind": "gamepad_button", "control": "A"},
        "mode": "hold", "threshold": 0.6,
    }]}
    (root / "legacy.json").write_text(json.dumps(legacy), encoding="utf-8")
    store = MappingStore(root)
    migrated = store.get("legacy")
    assert migrated.version == 2
    assert migrated.bindings[0].release_threshold == pytest.approx(0.39)
    backups = list((tmp_path / "backups").glob("mapping-v1-*"))
    assert len(backups) == 1
    assert json.loads((backups[0] / "legacy.json").read_text(encoding="utf-8"))["name"] == "旧配置"


def test_mapping_hysteresis_and_cooldown(monkeypatch) -> None:
    now = [10.0]
    monkeypatch.setattr("motionbridge.mapping.time.monotonic", lambda: now[0])
    router = FakeRouter()
    engine = MappingEngine(router)  # type: ignore[arg-type]
    engine.select(MappingProfile(id="test", name="test", bindings=[Binding(
        id="punch", signal="right_punch", target=Target(kind="gamepad_button", control="X"),
        mode="pulse", threshold=.7, release_threshold=.3, cooldown_ms=500,
    )]))
    for value in (.75, .5, .2, .8):
        engine.process({"right_punch": value})
    assert len(router.digital) == 1
    now[0] += .6
    engine.process({"right_punch": .2})
    engine.process({"right_punch": .8})
    assert len(router.digital) == 2


def test_voice_wakeup_prefix_direction_and_release() -> None:
    mapping = MappingStore.__new__(MappingStore)  # Avoid filesystem; use shipped template.
    from motionbridge.mapping import DEFAULT_MAPPINGS
    preset = DEFAULT_MAPPINGS[0]
    parser = VoiceCommandParser()
    assert parser.parse("体感，一号向左", preset, 2)[:2] == (0, "left")
    assert parser.parse("体感，向左", preset, 2)[2] == "双人模式请说一号或二号"
    stopped: list[int] = []
    voice = VoiceController(stopped.append)
    voice.connect("phone")
    assert voice.apply_text("体感，一号向左", [preset, preset], 2)["ok"] is True
    assert voice.signals(0)["voice_move_x"] == -1
    voice.apply_text("体感，一号停止", [preset, preset], 2)
    assert all(value == 0 for value in voice.signals(0).values())
    voice.apply_text("体感，二号紧急停止", [preset, preset], 2)
    assert stopped == [1]
    voice.apply_text("体感，一号向右", [preset, preset], 2)
    voice.disconnect()
    assert all(value == 0 for value in voice.signals(0).values())


def test_vosk_grammar_contains_complete_wake_utterances() -> None:
    from motionbridge.mapping import DEFAULT_MAPPINGS
    phrases = grammar_phrases([DEFAULT_MAPPINGS[0]])
    assert "体感 开始" in phrases
    assert "体感 一号 向左" in phrases
    assert "体感 二号 紧急停止" in phrases


def test_vosk_phrase_tokenizer_uses_model_dictionary() -> None:
    class FakeModel:
        words = {"体感", "一号", "向左"}

        def vosk_model_find_word(self, value: str) -> int:
            return 1 if value in self.words else -1

    assert VoskStreamRecognizer._tokenize_phrase(FakeModel(), "体感一号向左") == "体感 一号 向左"
    assert VoskStreamRecognizer._tokenize_phrase(FakeModel(), "体感飞行") is None


def test_vosk_uses_supported_runtime_grammar_and_falls_back_if_grammar_rejected(tmp_path, monkeypatch) -> None:
    import json as _json
    import sys
    import types

    calls: list[tuple] = []

    class FakeModel:
        words = {"体感", "开始", "停止", "向左", "向右", "跳跃", "紧急停止"}

        def __init__(self, path: str) -> None:
            self.path = path

        def vosk_model_find_word(self, value: str) -> int:
            return 1 if value in self.words else -1

    class FakeRecognizer:
        def __init__(self, *args) -> None:
            calls.append(args)

        def AcceptWaveform(self, data: bytes) -> bool:
            return False

        def PartialResult(self) -> str:
            return '{"partial":""}'

    fake = types.SimpleNamespace(
        Model=FakeModel, KaldiRecognizer=FakeRecognizer, SetLogLevel=lambda _: None,
    )
    monkeypatch.setitem(sys.modules, "vosk", fake)
    model_path = tmp_path / "model"
    model_path.mkdir()
    recognizer = VoskStreamRecognizer(
        model_path, ["体感", "开始", "停止", "向左", "向右", "跳跃", "紧急停止", "飞行"]
    )
    assert recognizer.mode == "grammar"
    assert recognizer.grammar_count == 7
    assert recognizer.unsupported_phrase_count == 1
    grammar = _json.loads(calls[0][2])
    assert "飞行" not in grammar

    calls.clear()

    class RejectGrammar(FakeRecognizer):
        def __init__(self, *args) -> None:
            if len(args) == 3:
                raise RuntimeError("static graph")
            super().__init__(*args)

    fake.KaldiRecognizer = RejectGrammar
    recognizer = VoskStreamRecognizer(
        model_path, ["体感", "开始", "停止", "向左", "向右", "跳跃", "紧急停止"]
    )
    assert recognizer.mode == "open"
    assert len(calls[0]) == 2


def test_unassigned_intruder_never_gets_slot_and_crossing_neutralizes() -> None:
    tracker = MultiPersonTracker(join_duration=3.0)
    tracker.request_join(0, now=0.0)
    assert tracker.update([make_person(.25)], now=0.0) == {}
    tracker.update([make_person(.25)], now=1.0)
    tracker.update([make_person(.25)], now=2.0)
    result = tracker.update([make_person(.25)], now=3.1)
    assert 0 in result
    result = tracker.update([make_person(.26), make_person(.78)], now=3.2)
    assert set(result) == {0}
    assert tracker.last_unassigned == 1
    tracker.request_join(1, now=3.2)
    tracker.update([make_person(.26), make_person(.78)], now=3.3)
    tracker.update([make_person(.26), make_person(.78)], now=4.3)
    tracker.update([make_person(.27), make_person(.77)], now=5.3)
    result = tracker.update([make_person(.27), make_person(.77)], now=6.4)
    assert set(result) == {0, 1}
    assert tracker.update([make_person(.49), make_person(.51)], now=6.5) == {}
    assert tracker.slot_status(0, now=6.5)["state"] == "uncertain"


def test_track_short_occlusion_and_long_loss_auto_rejoin() -> None:
    tracker = MultiPersonTracker(join_duration=0.0)
    tracker.request_join(0, now=0.0)
    tracker.update([make_person(.3)], now=0.0)
    assert 0 in tracker.update([make_person(.3)], now=.01)
    tracker.update([], now=.4)
    assert tracker.slot_status(0, now=.4)["state"] == "missing"
    assert 0 in tracker.update([make_person(.31)], now=1.5)
    tracker.update([], now=3.6)
    assert tracker.slot_status(0, now=3.6)["state"] == "auto_rejoining"
    assert 0 in tracker.update([make_person(.31)], now=3.7)


def test_boolean_stabilizer_rejects_single_frame_flicker_and_holds_release() -> None:
    recognizer = MotionRecognizer()
    assert recognizer._stabilize_booleans({"squat": True, "left_fist": True}, 0.00) == {
        "squat": False,
        "left_fist": False,
    }
    assert recognizer._stabilize_booleans({"squat": False, "left_fist": False}, 0.05) == {
        "squat": False,
        "left_fist": False,
    }
    recognizer._stabilize_booleans({"squat": True, "left_fist": True}, 1.00)
    assert recognizer._stabilize_booleans({"squat": True, "left_fist": True}, 1.17) == {
        "squat": True,
        "left_fist": True,
    }
    recognizer._stabilize_booleans({"squat": False, "left_fist": False}, 2.00)
    assert recognizer._stabilize_booleans({"squat": False, "left_fist": False}, 2.15) == {
        "squat": True,
        "left_fist": True,
    }
    assert recognizer._stabilize_booleans({"squat": False, "left_fist": False}, 2.21) == {
        "squat": False,
        "left_fist": False,
    }


def sensor_frame(device: str, slot: int, sequence: int, *, recenter: bool = False, touches: list[dict] | None = None) -> SensorFrame:
    return SensorFrame(device_id=device, sequence=sequence, captured_at_ms=sequence * 16,
        player_slot=slot, quaternion={"x": 0, "y": 0, "z": 0, "w": 1}, recenter=recenter,
        rotation_rate={"x": 1, "y": 2, "z": 3}, acceleration={"x": 4, "y": 5, "z": 6}, touches=touches or [])


def test_relative_quaternion_center_is_identity() -> None:
    baseline = (0.2, -0.1, 0.3, 0.92)
    relative = relative_quaternion(baseline, baseline)
    assert relative == pytest.approx((0, 0, 0, 1), abs=1e-6)


def test_handheld_slots_are_isolated_and_duplicate_binding_rejected() -> None:
    manager = HandheldManager()
    manager.ingest(sensor_frame("phone-a", 0, 1, recenter=True, touches=[{"control": "a", "pressed": True}]), now=0.01)
    manager.ingest(sensor_frame("phone-b", 1, 1, recenter=True, touches=[{"control": "b", "pressed": True}]), now=0.01)
    assert manager.signals(0, now=.02)["handheld_a"] is True
    assert manager.signals(0, now=.02)["handheld_b"] is False
    assert manager.signals(1, now=.02)["handheld_b"] is True
    with pytest.raises(ValueError, match="已绑定其他玩家"):
        manager.bind("phone-a", 1)


def test_handheld_watchdog_releases_touch_and_requires_center() -> None:
    manager = HandheldManager()
    manager.ingest(sensor_frame("phone", 0, 1, recenter=True, touches=[{"control": "a", "pressed": True}]), now=1.0)
    assert manager.watchdog(0, now=1.31) is True
    assert manager.signals(0, now=1.31) == {}
    assert manager.status(0, now=1.31)["sensor_centered"] is False


def test_real_sensor_motion_overrides_camera_then_falls_back(tmp_path) -> None:
    import time
    runtime = RuntimeState(tmp_path, enable_outputs=False)
    camera = {"pose_visible": True, "gyro_x": -7.0, "accel_x": -4.0}
    runtime.last_camera_signals[0] = camera
    now = time.monotonic()
    runtime.handhelds.ingest(sensor_frame("phone", 0, 1, recenter=True), now=now)
    fused = runtime._compose_signals(0, camera)
    assert fused["gyro_x"] == 1.0
    assert fused["accel_x"] == 4.0
    runtime.handhelds.watchdog(0, now=now + .31)
    fallback = runtime._compose_signals(0, camera)
    assert fallback["gyro_x"] == -7.0
    assert fallback["accel_x"] == -4.0


def test_dsu_keeps_two_independent_motion_slots() -> None:
    server = DSUServer(port=0)
    server.update(slot=0, accel_x=.25, gyro_roll=1.0)
    server.update(slot=1, accel_x=-.5, gyro_roll=-2.0)
    assert server.motions[0].accel_x == .25
    assert server.motions[1].accel_x == -.5
    assert server.motions[0].gyro_roll == 1.0
    assert server.motions[1].gyro_roll == -2.0
