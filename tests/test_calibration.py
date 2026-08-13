from __future__ import annotations

from pathlib import Path

import pytest

from motionbridge.calibration import (
    CalibrationRecorder,
    ProfileStore,
    aggregate_sessions,
    build_session,
    build_stage_report,
)


def feature_row(**overrides: float) -> dict[str, float]:
    row = {
        "shoulder_width": 0.2,
        "torso_length": 0.24,
        "standing_height": 0.75,
        "center_x": 0.5,
        "hip_y": 0.58,
        "hip_floor_ratio": 0.48,
        "torso_lean": 0.0,
        "left_wrist_above_nose": 0.0,
        "right_wrist_above_nose": 0.0,
        "left_wrist_extent": 0.5,
        "right_wrist_extent": 0.5,
        "left_wrist_shoulder_y": 1.0,
        "right_wrist_shoulder_y": 1.0,
        "wrists_distance": 1.0,
        "left_wrist_forward": 0.0,
        "right_wrist_forward": 0.0,
        "left_ankle_lift": 0.0,
        "right_ankle_lift": 0.0,
        "shoulder_roll": 0.0,
    }
    row.update(overrides)
    return row


def test_build_session_extracts_all_calibration_stages() -> None:
    samples = {
        "neutral": [feature_row() for _ in range(30)],
        "arms_up": [feature_row(left_wrist_above_nose=0.6, right_wrist_above_nose=0.58) for _ in range(30)],
        "t_pose": [
            feature_row(
                left_wrist_extent=1.5,
                right_wrist_extent=1.48,
                left_wrist_shoulder_y=0.1,
                right_wrist_shoulder_y=0.1,
            )
            for _ in range(30)
        ],
        "squat": [feature_row(hip_floor_ratio=0.29) for _ in range(30)],
        "lean_sides": [feature_row(torso_lean=-0.35 if index < 15 else 0.35) for index in range(30)],
    }
    session = build_session(samples, "2026-08-08T00:00:00+00:00")
    assert session["features"]["arms_up_left"] == pytest.approx(0.6)
    assert session["features"]["squat_hip_floor_ratio"] == pytest.approx(0.29)
    assert session["quality"] >= 0.9


def test_build_session_rejects_missing_visible_samples() -> None:
    samples = {stage: [feature_row()] * 7 for stage in ("neutral", "arms_up", "t_pose", "squat", "lean_sides")}
    with pytest.raises(ValueError, match="有效全身画面只有 7/8 帧"):
        build_session(samples, "now")


def test_stage_report_names_missing_body_parts() -> None:
    samples = {stage: [] for stage in ("neutral", "arms_up", "t_pose", "squat", "lean_sides")}
    rejected = {"neutral": {"双脚踝": 12, "双手腕": 4}}
    report = build_stage_report("neutral", samples, rejected)
    assert report["valid"] is False
    assert report["sample_count"] == 0
    assert "双脚踝" in report["message"]
    assert "双手腕" in report["message"]


def test_stage_report_rejects_wrong_action_even_with_enough_frames() -> None:
    samples = {
        "neutral": [feature_row() for _ in range(10)],
        "arms_up": [feature_row(left_wrist_above_nose=-0.2, right_wrist_above_nose=0.4) for _ in range(10)],
    }
    report = build_stage_report("arms_up", samples)
    assert report["valid"] is False
    assert "左手" in report["message"]
    assert "举过头顶" in report["message"]


def test_recorder_pauses_with_guidance_until_action_is_correct(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path)
    profile = store.create("玩家")
    recorder = CalibrationRecorder(store)
    recorder.start(profile.id)
    recorder.samples["neutral"] = [feature_row() for _ in range(8)]

    assert recorder._action_issue("arms_up", feature_row()) == "左手、右手还没有举过头顶"
    assert recorder._action_issue(
        "arms_up",
        feature_row(left_wrist_above_nose=0.4, right_wrist_above_nose=0.4),
    ) is None


def test_recorder_reports_missing_body_while_stage_waits(tmp_path: Path, monkeypatch) -> None:
    now = [100.0]
    monkeypatch.setattr("motionbridge.calibration.time.monotonic", lambda: now[0])
    store = ProfileStore(tmp_path)
    profile = store.create("玩家")
    recorder = CalibrationRecorder(store)
    recorder.start(profile.id)
    recorder.set_stage("neutral", reset=True)
    now[0] += 1.1

    report = recorder.report("neutral")
    assert report["valid"] is False
    assert "没有检测到完整人体" in report["guidance"]


def test_aggregate_uses_sessions_not_frame_counts_and_filters_outlier() -> None:
    sessions = [
        {"quality": 0.9, "features": {"neutral_center_x": 0.48}},
        {"quality": 0.8, "features": {"neutral_center_x": 0.50}},
        {"quality": 0.9, "features": {"neutral_center_x": 0.49}},
        {"quality": 0.9, "features": {"neutral_center_x": 0.95}},
        {"quality": 0.2, "features": {"neutral_center_x": 0.1}},
    ]
    aggregate = aggregate_sessions(sessions)
    assert aggregate["session_count"] == 4
    assert aggregate["neutral_center_x"] == pytest.approx(0.49, abs=0.01)


def test_profile_store_preserves_prior_sessions(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path)
    profile = store.create("玩家一")
    store.add_session(profile.id, {"id": "one", "quality": 0.8, "features": {"x": 1.0}})
    updated = store.add_session(profile.id, {"id": "two", "quality": 0.8, "features": {"x": 3.0}})
    assert [session["id"] for session in updated.sessions] == ["one", "two"]
    assert updated.aggregate["x"] == pytest.approx(2.0)
