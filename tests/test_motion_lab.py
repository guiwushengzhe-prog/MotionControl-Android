from __future__ import annotations

import math

from motionbridge.motion_lab import (
    MotionLabVoiceContext,
    PersonalActionStore,
    compare_action,
    normalize_sequence,
    recommend_threshold,
)


def _frame(wrist_x: float, wrist_y: float) -> dict:
    pose: list[dict] = []
    for _ in range(33):
        pose.append({"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 1.0})
    # A coarse but consistent skeleton: shoulders, elbows, wrists, hips, knees.
    pose[11] = {"x": 0.42, "y": 0.42, "z": 0.0, "visibility": 1.0}
    pose[12] = {"x": 0.58, "y": 0.42, "z": 0.0, "visibility": 1.0}
    pose[13] = {"x": 0.40, "y": 0.55, "z": 0.0, "visibility": 1.0}
    pose[14] = {"x": 0.60, "y": 0.55, "z": 0.0, "visibility": 1.0}
    pose[15] = {"x": 0.38, "y": 0.68, "z": 0.0, "visibility": 1.0}
    pose[16] = {"x": wrist_x, "y": wrist_y, "z": 0.0, "visibility": 1.0}
    pose[23] = {"x": 0.45, "y": 0.78, "z": 0.0, "visibility": 1.0}
    pose[24] = {"x": 0.55, "y": 0.78, "z": 0.0, "visibility": 1.0}
    pose[25] = {"x": 0.46, "y": 0.90, "z": 0.0, "visibility": 1.0}
    pose[26] = {"x": 0.54, "y": 0.90, "z": 0.0, "visibility": 1.0}
    return {"pose": pose}


def _punch(frames: int = 12) -> list[dict]:
    return [
        _frame(0.62 + 0.02 * index, 0.68 - 0.01 * index)
        for index in range(frames)
    ]


def _raise_hand(frames: int = 12) -> list[dict]:
    return [
        _frame(0.62, 0.68 - 0.03 * index)
        for index in range(frames)
    ]


def test_normalize_removes_absolute_position_and_scale() -> None:
    source = _punch()
    shifted = [
        {"pose": [
            {"x": point["x"] + 0.1, "y": point["y"] + 0.05, "z": point["z"], "visibility": 1.0}
            for point in frame["pose"]
        ]}
        for frame in source
    ]
    a = normalize_sequence(source, "right_punch")
    b = normalize_sequence(shifted, "right_punch")
    assert len(a) == len(b)
    for frame_a, frame_b in zip(a, b):
        for point_a, point_b in zip(frame_a, frame_b):
            assert math.isclose(point_a[0], point_b[0], abs_tol=1e-6)
            assert math.isclose(point_a[1], point_b[1], abs_tol=1e-6)


def test_compare_action_scores_same_motion_higher() -> None:
    same = compare_action(_punch(), _punch(), "right_punch")
    different = compare_action(_punch(), _raise_hand(), "right_punch")
    assert same["ok"] is True
    assert same["score"] > different["score"]
    assert 0.0 <= same["score"] <= 100.0


def test_recommend_threshold_separates_distributions() -> None:
    result = recommend_threshold([84.0, 90.0, 93.0], [50.0, 55.0, 58.0])
    assert result["ok"] is True
    assert 58.0 < result["threshold"] < 84.0


def test_personal_action_store_roundtrip(tmp_path) -> None:
    store = PersonalActionStore(tmp_path / "motion-lab" / "actions")
    store.save("player-a", "right_punch", _punch(), meta={"game": "黑神话：悟空"})
    loaded = store.load("player-a", "right_punch")
    assert loaded is not None
    assert loaded["action_id"] == "right_punch"
    assert store.list("player-a")[0]["label"] == "右拳"
    assert store.delete("player-a", "right_punch") is True
    assert store.load("player-a", "right_punch") is None


def test_voice_context_missing_wake_word_not_executed() -> None:
    context = MotionLabVoiceContext()
    context.set_context("teach")
    result = context.accept("开始录制")
    assert result["executed"] is False
    assert result["reason"] == "缺少唤醒词"


def test_voice_context_wrong_context_command_not_executed() -> None:
    context = MotionLabVoiceContext()
    context.set_context("teach")
    result = context.accept("体感，开始测试")
    assert result["executed"] is False
    assert result["reason"] == "当前页面不允许此命令"


def test_voice_context_critical_requires_confirmation() -> None:
    context = MotionLabVoiceContext()
    context.set_context("recording_ready")
    first = context.accept("体感，保存动作", now=100.0)
    assert first["needs_confirmation"] is True
    second = context.accept("体感，确认保存", now=101.0)
    assert second["executed"] is True
    assert second["confirmed"] is True


def test_voice_context_confirmation_times_out() -> None:
    context = MotionLabVoiceContext()
    context.set_context("recording_ready")
    context.accept("体感，保存动作", now=100.0)
    late = context.accept("体感，确认保存", now=107.0)
    assert late["executed"] is False


def test_voice_context_recording_lock_only_allows_emergency() -> None:
    context = MotionLabVoiceContext()
    context.set_context("recording_ready", recording_locked=True)
    blocked = context.accept("体感，下一步")
    assert blocked["executed"] is False
    emergency = context.accept("体感，紧急停止")
    assert emergency["executed"] is True
    assert emergency["command"] == "紧急停止"
