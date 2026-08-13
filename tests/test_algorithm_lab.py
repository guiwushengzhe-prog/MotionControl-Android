from __future__ import annotations

import csv
import json

import pytest

from motionbridge.algorithm_lab import (
    PROJECTS,
    AlgorithmLabRecorder,
    AlgorithmLabStore,
    SCHEMA_VERSION,
    ShadowModeGuard,
    ShadowModeViolation,
    build_guided_plan,
    compare_session,
    replay_session,
)
from motionbridge.models import PoseFrame


def pose_frame(sequence: int, captured_at_ms: float) -> PoseFrame:
    # These coordinates only satisfy the transport schema.  Recognition is
    # deliberately supplied by a deterministic test double; this unit test is
    # not presented as a真人准确率 test.
    landmarks = [
        {"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 1.0}
        for _ in range(33)
    ]
    return PoseFrame(
        device_id="real-phone-fixture",
        sequence=sequence,
        captured_at_ms=captured_at_ms,
        width=1280,
        height=720,
        pose=landmarks,
    )


def compact_plan(project: str = "fist") -> dict:
    return {
        "project": project,
        "project_name": PROJECTS[project]["name"],
        "repetitions": 2,
        "total_duration_ms": 800,
        "stages": [
            {
                "id": "one",
                "kind": "action",
                "prompt": "握拳",
                "expected": "fist",
                "trial_index": 0,
                "phase_index": 0,
                "start_offset_ms": 100,
                "end_offset_ms": 300,
            },
            {
                "id": "two",
                "kind": "action",
                "prompt": "握拳",
                "expected": "fist",
                "trial_index": 1,
                "phase_index": 0,
                "start_offset_ms": 500,
                "end_offset_ms": 700,
            },
        ],
    }


class ParameterRecognizer:
    instances: list["ParameterRecognizer"] = []

    def __init__(self, parameters: dict | None = None) -> None:
        self.parameters = dict(parameters or {})
        self.sequences: list[int] = []
        self.last_raw_signals: dict = {}
        self.__class__.instances.append(self)

    def reset(self) -> None:
        self.sequences.clear()

    def process(self, frame: PoseFrame) -> dict:
        self.sequences.append(frame.sequence)
        active = frame.sequence in self.parameters.get("fist_sequences", [])
        self.last_raw_signals = {"fist_score": 0.9 if active else 0.1}
        return {
            "pose_visible": True,
            "left_fist": active,
            "right_fist": False,
            "left_pinch": False,
            "right_pinch": False,
            "squat": False,
            "jump": False,
        }


class LegacyRecognizer:
    """Exercises compatibility with recognizers lacking parameters/raw signals."""

    def reset(self) -> None:
        pass

    def process(self, frame: PoseFrame) -> dict:
        return {"left_fist": frame.sequence == 1}


def recorded_session(*, plan: dict | None = None) -> dict:
    recorder = AlgorithmLabRecorder(
        "fist",
        repetitions=2,
        plan=plan or compact_plan(),
        name="真实手机录制",
    )
    recorder.start(10_000)
    for sequence, offset in enumerate((0, 150, 200, 250, 400, 620, 680, 750)):
        recorder.record_frame(
            pose_frame(sequence, 20_000 + offset),
            received_at_ms=10_000 + offset,
            raw_signals={"camera_score": sequence / 10},
        )
    return recorder.finish(metadata={"camera": "phone"})


def test_all_six_projects_have_guided_countdown_and_actions() -> None:
    assert set(PROJECTS) == {
        "still", "fist", "pinch", "fist_then_pinch", "squat", "jump",
    }
    for project in PROJECTS:
        plan = build_guided_plan(project, repetitions=2)
        assert [stage["prompt"] for stage in plan["stages"][:3]] == ["3", "2", "1"]
        assert plan["repetitions"] == 2
        assert plan["total_duration_ms"] > 0
    sequence = build_guided_plan("fist_then_pinch", repetitions=1)
    assert [
        stage["expected"] for stage in sequence["stages"] if stage["kind"] == "action"
    ] == ["fist", "pinch"]


def test_recorder_preserves_pose_hands_raw_signals_and_extension_slots() -> None:
    class Source:
        last_raw_signals = {"pinch_distance": 0.23}

    recorder = AlgorithmLabRecorder("pinch", source_recognizer=Source())  # type: ignore[arg-type]
    recorder.start(1_000)
    recorder.record_frame(pose_frame(7, 900), received_at_ms=1_025)
    session = recorder.finish()
    assert session["schema_version"] == SCHEMA_VERSION
    assert session["frames"][0]["pose_frame"]["sequence"] == 7
    assert len(session["frames"][0]["pose_frame"]["pose"]) == 33
    assert session["frames"][0]["raw_signals"] == {"pinch_distance": 0.23}
    assert set(session["extensions"]) == {
        "video_clips", "pcm16_audio", "sensor_frames", "multi_person_tracks",
    }


def test_replay_directly_feeds_same_poseframes_and_computes_metrics() -> None:
    session = recorded_session()
    result = replay_session(
        session,
        {"fist_sequences": [1, 3, 5]},
        recognizer_factory=ParameterRecognizer,
    )
    assert ParameterRecognizer.instances[-1].sequences == list(range(8))
    assert result["shadow_mode"] is True
    assert result["metrics"] == {
        "success_count": 2,
        "total_count": 2,
        "success_rate": 1.0,
        "missed_count": 0,
        "static_false_triggers": 0,
        "duplicate_triggers": 1,
        "average_latency_ms": 85.0,
        "p95_latency_ms": 116.5,
    }
    assert [item["error_type"] for item in result["timeline"]].count("duplicate") == 1
    matrix = result["confusion_matrix"]
    assert matrix["labels"] == ["fist", "pinch", "open_hand"]
    assert matrix["counts"]["fist"]["fist"] > 0
    assert result["frame_results"][1]["raw_signals"] == {"fist_score": 0.9}


def test_ab_comparison_uses_identical_recording_and_supports_legacy_recognizer() -> None:
    ParameterRecognizer.instances.clear()
    session = recorded_session()
    comparison = compare_session(
        session,
        {"fist_sequences": [1]},
        {"fist_sequences": [1, 5]},
        recognizer_factory=ParameterRecognizer,
    )
    assert comparison["same_input_frame_count"] == 8
    assert comparison["current"]["metrics"]["success_count"] == 1
    assert comparison["candidate"]["metrics"]["success_count"] == 2
    assert comparison["delta_candidate_minus_current"]["success_count"] == 1
    assert ParameterRecognizer.instances[-2].sequences == ParameterRecognizer.instances[-1].sequences

    legacy = replay_session(session, {"future_threshold": 0.7}, recognizer_factory=LegacyRecognizer)
    assert legacy["frame_count"] == 8
    assert legacy["frame_results"][0]["raw_signals"] == {}


def test_still_false_trigger_and_missed_event_are_explicit_on_timeline() -> None:
    still_plan = {
        "project": "still",
        "repetitions": 1,
        "total_duration_ms": 300,
        "stages": [{
            "id": "still-one", "kind": "action", "prompt": "保持静止",
            "expected": "still", "trial_index": 0, "phase_index": 0,
            "start_offset_ms": 0, "end_offset_ms": 300,
        }],
    }
    recorder = AlgorithmLabRecorder("still", repetitions=1, plan=still_plan)
    recorder.start(1_000)
    for sequence, offset in enumerate((0, 100, 200)):
        recorder.record_frame(pose_frame(sequence, offset), received_at_ms=1_000 + offset)
    session = recorder.finish()
    result = replay_session(
        session, {"fist_sequences": [1]}, recognizer_factory=ParameterRecognizer,
    )
    assert result["metrics"]["success_count"] == 0
    assert result["metrics"]["static_false_triggers"] == 1
    assert result["timeline"][0]["error_type"] == "static_false_trigger"
    assert result["confusion_matrix"]["counts"]["open_hand"]["fist"] == 1


def test_shadow_guard_releases_on_entry_exit_and_exception() -> None:
    releases: list[str] = []
    with pytest.raises(RuntimeError, match="boom"):
        with ShadowModeGuard(lambda: releases.append("released")) as guard:
            assert guard.active is True
            with pytest.raises(ShadowModeViolation):
                guard.dispatch("keyboard", "A", True)
            raise RuntimeError("boom")
    assert releases == ["released", "released"]
    assert guard.active is False


def test_local_store_crud_exports_and_prunes_old_sessions(tmp_path) -> None:
    store = AlgorithmLabStore(tmp_path / "sessions", max_sessions=2, max_bytes=2_000_000)
    sessions = []
    for index in range(3):
        session = recorded_session()
        session["id"] = f"session-{index}"
        session["name"] = f"会话 {index}"
        session["created_at"] = f"2026-08-09T00:00:0{index}+00:00"
        store.save(session)
        sessions.append(session)
    assert [item["id"] for item in store.list_sessions()] == ["session-2", "session-1"]
    with pytest.raises(FileNotFoundError):
        store.load("session-0")

    renamed = store.rename("session-2", "握拳候选阈值")
    assert renamed["name"] == "握拳候选阈值"
    json_path = store.export_json("session-2")
    assert json.loads(json_path.read_text(encoding="utf-8"))["id"] == "session-2"

    result = replay_session(
        store.load("session-2"), {"fist_sequences": [1, 5]},
        recognizer_factory=ParameterRecognizer,
    )
    csv_path = store.export_csv("session-2", result)
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows and rows[0]["session_id"] == "session-2"
    assert store.delete("session-1") is True
    assert store.delete("session-1") is False


def test_store_rejects_path_traversal(tmp_path) -> None:
    store = AlgorithmLabStore(tmp_path)
    with pytest.raises(ValueError, match="会话 ID"):
        store.load("../mapping")

