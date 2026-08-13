from __future__ import annotations

import hashlib

import pytest

from motionbridge.action_model import (
    ACTIVE_LABELS,
    CLASS_LABELS,
    COCO17_MEDIAPIPE_INDICES,
    ActionModelEngine,
    ActionStateMachine,
    ActionTiming,
    Coco17WindowBuilder,
    ValidatedModel,
    WINDOW_SIZE,
)


def landmarks(x_offset: float = 0.0) -> list[dict[str, float]]:
    points = [
        {"x": 0.2 + index * 0.01 + x_offset, "y": 0.3 + index * 0.005, "visibility": 0.9}
        for index in range(33)
    ]
    points[23]["x"], points[24]["x"] = 0.45 + x_offset, 0.55 + x_offset
    return points


def full_window(builder: Coco17WindowBuilder, *, moving: bool = False):
    window = None
    for index in range(WINDOW_SIZE):
        offset = index * 0.002 if moving else 0.0
        window, gap = builder.push(
            landmarks(offset), timestamp_ms=index * 40.0, sequence=index,
        )
        assert gap is False
    assert window is not None
    return window


def test_frozen_mapping_window_shape_coordinates_and_root_motion() -> None:
    assert COCO17_MEDIAPIPE_INDICES == (
        0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28,
    )
    assert CLASS_LABELS == (
        "SQUAT_PULSE", "LUNGE_SHIFT", "ARMS_UP_DYNAMIC", "RAPID_ARM_STRIKE",
        "SLOW_ARM_DISTRACTOR", "DAILY_MOTION_DISTRACTOR",
    )
    window = full_window(Coco17WindowBuilder(), moving=True)
    assert len(window.skeleton) == 1
    assert len(window.skeleton[0]) == 24
    assert len(window.skeleton[0][0]) == 17
    assert len(window.skeleton[0][0][0]) == 3
    first_nose = window.skeleton[0][0][0]
    assert first_nose == pytest.approx((-0.6, -0.4, 0.9))
    assert window.root_motion == pytest.approx((0.046, 0.0, 0.046, 0.0))


def test_missing_or_skipped_frame_resets_filter_and_window() -> None:
    builder = Coco17WindowBuilder()
    for index in range(10):
        builder.push(landmarks(), timestamp_ms=index * 33.0, sequence=index)
    assert builder.frame_count == 10
    result, gap = builder.push(landmarks(), timestamp_ms=400.0, sequence=12)
    assert gap is True
    assert result is None
    assert builder.frame_count == 1
    result, gap = builder.push(None, timestamp_ms=433.0, sequence=13)
    assert gap is True
    assert result is None
    assert builder.frame_count == 0


class FixedBackend:
    def __init__(self, values: list[float] | None = None, *, fail: bool = False) -> None:
        self.values = values or [0.8, 0.04, 0.04, 0.04, 0.04, 0.04]
        self.fail = fail
        self.shapes: list[tuple[int, int, int, int]] = []

    def predict(self, skeleton, root_motion):
        self.shapes.append((len(skeleton), len(skeleton[0]), len(skeleton[0][0]), len(skeleton[0][0][0])))
        if self.fail:
            raise RuntimeError("simulated backend failure")
        assert len(root_motion) == 4
        return self.values


def validated(backend: FixedBackend) -> ValidatedModel:
    return ValidatedModel(
        backend=backend,
        checkpoint_sha256="a" * 64,
        protocol_hash="frozen-protocol",
    )


def test_engine_never_infers_without_validated_parameters() -> None:
    engine = ActionModelEngine()
    assert engine.status()["state"] == "parameters_pending"
    result = engine.process(landmarks(), timestamp_ms=0.0, sequence=0)
    assert result["fallback_required"] is True
    assert result["reason"] == "parameters_pending"
    assert result["release_required"] is False


def test_checkpoint_absent_or_hash_failure_stays_parameters_pending(tmp_path) -> None:
    engine = ActionModelEngine()
    missing = engine.load_checkpoint(
        tmp_path / "missing.pt", expected_sha256="a" * 64,
        expected_protocol_hash="frozen-protocol",
    )
    assert missing["ready"] is False
    checkpoint = tmp_path / "best.pt"
    checkpoint.write_bytes(b"not a checkpoint")
    status = engine.load_checkpoint(
        checkpoint, expected_sha256="0" * 64,
        expected_protocol_hash="frozen-protocol",
    )
    assert status["ready"] is False
    assert "SHA256" in status["state_zh"]
    assert hashlib.sha256(checkpoint.read_bytes()).hexdigest() != "0" * 64


def test_engine_input_shape_inference_and_exception_release() -> None:
    backend = FixedBackend()
    engine = ActionModelEngine(validated(backend))
    final = None
    for index in range(WINDOW_SIZE):
        final = engine.process(landmarks(), timestamp_ms=index * 40.0, sequence=index)
    assert final is not None and final["usable"] is True
    assert backend.shapes == [(1, 24, 17, 3)]
    assert final["probabilities"]["SQUAT_PULSE"] == pytest.approx(0.8)

    failing = ActionModelEngine(validated(FixedBackend(fail=True)))
    for index in range(WINDOW_SIZE):
        final = failing.process(landmarks(), timestamp_ms=index * 40.0, sequence=index)
    assert final["reason"] == "inference_error"
    assert final["release_required"] is True
    assert final["fallback_required"] is True
    assert failing.window_builder.frame_count == 0


def test_state_machine_debounces_suppresses_and_does_not_repeat() -> None:
    builder = Coco17WindowBuilder()
    window = full_window(builder)
    machine = ActionStateMachine(
        timing={label: ActionTiming(prepare_ms=100, minimum_hold_ms=80, cooldown_ms=200) for label in ACTIVE_LABELS}
    )
    squat = {label: (0.9 if label == "SQUAT_PULSE" else 0.02) for label in CLASS_LABELS}
    first = machine.update(squat, timestamp_ms=1_000, window=window)
    assert first["phase"] == "preparing" and first["triggered"] is False
    assert machine.update(squat, timestamp_ms=1_060, window=window)["triggered"] is False
    trigger = machine.update(squat, timestamp_ms=1_120, window=window)
    assert trigger["triggered"] is True and trigger["action_zh"] == "下蹲脉冲"
    assert machine.update(squat, timestamp_ms=1_180, window=window)["phase"] == "holding"
    assert machine.update(squat, timestamp_ms=1_500, window=window)["triggered"] is False

    distractor = {label: (0.9 if label == "DAILY_MOTION_DISTRACTOR" else 0.02) for label in CLASS_LABELS}
    suppressed = machine.update(distractor, timestamp_ms=1_520, window=window)
    assert suppressed["suppressed"] is True
    assert suppressed["action"] is None


def test_wrist_and_hip_refinement_use_original_motion() -> None:
    builder = Coco17WindowBuilder()
    for index in range(WINDOW_SIZE):
        points = landmarks(index * 0.001)
        points[15]["x"] += index * 0.02  # MediaPipe left wrist moves faster.
        window, _ = builder.push(points, timestamp_ms=index * 40.0, sequence=index)
    assert window is not None
    machine = ActionStateMachine()
    strike = {label: (0.9 if label == "RAPID_ARM_STRIKE" else 0.02) for label in CLASS_LABELS}
    result = machine.update(strike, timestamp_ms=2_000, window=window)
    assert result["qualifier"] == "left"
    assert result["action_zh"] == "左拳"

    lunge = {label: (0.9 if label == "LUNGE_SHIFT" else 0.02) for label in CLASS_LABELS}
    result = machine.update(lunge, timestamp_ms=2_100, window=window)
    assert result["qualifier"] == "right"
    assert result["action_zh"] == "向右弓步"
