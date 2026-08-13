from __future__ import annotations

"""Research-only, pluggable COCO17 action-model runtime.

The module deliberately has no hard dependency on PyTorch.  Importing it is
always safe in the normal MotionBridge runtime; model loading either produces a
strictly validated backend or leaves the engine in ``parameters_pending``.
"""

import hashlib
import json
import math
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence


COCO17_MEDIAPIPE_INDICES: tuple[int, ...] = (
    0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28,
)
CORE13_MEDIAPIPE_INDICES: tuple[int, ...] = (
    0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28,
)
CLASS_LABELS: tuple[str, ...] = (
    "SQUAT_PULSE",
    "LUNGE_SHIFT",
    "ARMS_UP_DYNAMIC",
    "RAPID_ARM_STRIKE",
    "SLOW_ARM_DISTRACTOR",
    "DAILY_MOTION_DISTRACTOR",
)
ACTIVE_LABELS = frozenset(CLASS_LABELS[:4])
DISTRACTOR_LABELS = frozenset(CLASS_LABELS[4:])
CHINESE_ACTIONS: dict[str, str] = {
    "SQUAT_PULSE": "下蹲脉冲",
    "LUNGE_SHIFT": "弓步移动",
    "ARMS_UP_DYNAMIC": "快速举臂",
    "RAPID_ARM_STRIKE": "快速出拳",
    "SLOW_ARM_DISTRACTOR": "缓慢手臂动作",
    "DAILY_MOTION_DISTRACTOR": "日常动作",
}
EXPECTED_CANDIDATE = "openmmlab_ntu60_2d_native_coco17"
EXPECTED_TOPOLOGY = "coco17"
SUPPORTED_MODEL_CONTRACTS = {
    "openmmlab_ntu60_2d_native_coco17": "coco17",
    "penn_core13": "core13",
}
WINDOW_SIZE = 24


class InferenceBackend(Protocol):
    """Small interface implemented by PyTorch or test inference backends."""

    def predict(
        self,
        skeleton: Sequence[Sequence[Sequence[float]]],
        root_motion: Sequence[float],
    ) -> Sequence[float]: ...


@dataclass(frozen=True)
class ValidatedModel:
    backend: InferenceBackend
    checkpoint_sha256: str
    protocol_hash: str
    candidate: str = EXPECTED_CANDIDATE
    topology: str = EXPECTED_TOPOLOGY
    labels: tuple[str, ...] = CLASS_LABELS
    checkpoint_path: str | None = None
    best_epoch: int | None = None

    def __post_init__(self) -> None:
        if len(self.checkpoint_sha256) != 64 or any(
            char not in "0123456789abcdefABCDEF" for char in self.checkpoint_sha256
        ):
            raise ValueError("checkpoint_sha256 must be a 64-character SHA256")
        if not self.protocol_hash:
            raise ValueError("protocol_hash is required")
        if self.candidate not in SUPPORTED_MODEL_CONTRACTS:
            raise ValueError("unexpected model candidate")
        if self.topology != SUPPORTED_MODEL_CONTRACTS[self.candidate]:
            raise ValueError("unexpected skeleton topology")
        if tuple(self.labels) != CLASS_LABELS:
            raise ValueError("six-class order does not match the frozen protocol")


@dataclass
class OneEuro1D:
    """Causal One Euro filter matching the frozen ``(0.10, 80, 1.0)`` setup."""

    min_cutoff: float = 0.10
    beta: float = 80.0
    d_cutoff: float = 1.0
    _raw_previous: float | None = None
    _filtered_previous: float | None = None
    _derivative_previous: float = 0.0

    @staticmethod
    def _alpha(dt: float, cutoff: float) -> float:
        cutoff = max(float(cutoff), 1e-6)
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / max(dt, 1e-6))

    def update(self, value: float, dt: float) -> float:
        value = float(value)
        if self._raw_previous is None or self._filtered_previous is None:
            self._raw_previous = value
            self._filtered_previous = value
            return value
        dt = min(max(float(dt), 1.0 / 240.0), 0.25)
        derivative = (value - self._raw_previous) / dt
        d_alpha = self._alpha(dt, self.d_cutoff)
        filtered_derivative = (
            d_alpha * derivative + (1.0 - d_alpha) * self._derivative_previous
        )
        cutoff = self.min_cutoff + self.beta * abs(filtered_derivative)
        alpha = self._alpha(dt, cutoff)
        filtered = alpha * value + (1.0 - alpha) * self._filtered_previous
        self._raw_previous = value
        self._filtered_previous = filtered
        self._derivative_previous = filtered_derivative
        return filtered

    def reset(self) -> None:
        self._raw_previous = None
        self._filtered_previous = None
        self._derivative_previous = 0.0


@dataclass(frozen=True)
class ModelWindow:
    """Frozen model input before conversion to a framework-specific tensor."""

    # Shape: [1, 24, 17, 3], matching one person's STGCN++ input.
    skeleton: tuple[tuple[tuple[tuple[float, ...], ...], ...], ...]
    root_motion: tuple[float, float, float, float]
    timestamp_ms: float
    left_wrist_speed: float
    right_wrist_speed: float
    hip_delta_x: float


def _point_value(point: Any, name: str, default: float = 0.0) -> float:
    if isinstance(point, Mapping):
        return float(point.get(name, default))
    return float(getattr(point, name, default))


@dataclass
class Coco17WindowBuilder:
    """Transforms consecutive MediaPipe33 image landmarks into model windows."""

    max_gap_ms: float = 250.0
    _filters: list[tuple[OneEuro1D, OneEuro1D]] = field(init=False)
    _frames: deque[tuple[tuple[tuple[float, float, float], ...], tuple[float, float], float]] = field(
        default_factory=lambda: deque(maxlen=WINDOW_SIZE), init=False
    )
    _last_timestamp_ms: float | None = field(default=None, init=False)
    _last_sequence: int | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        self._filters = [(OneEuro1D(), OneEuro1D()) for _ in COCO17_MEDIAPIPE_INDICES]

    @property
    def frame_count(self) -> int:
        return len(self._frames)

    def reset(self) -> None:
        self._frames.clear()
        self._last_timestamp_ms = None
        self._last_sequence = None
        for pair in self._filters:
            pair[0].reset()
            pair[1].reset()

    def push(
        self,
        landmarks: Sequence[Any] | None,
        *,
        timestamp_ms: float,
        sequence: int | None = None,
        world_landmarks: Sequence[Any] | None = None,
    ) -> tuple[ModelWindow | None, bool]:
        """Add one frame and return ``(window, gap_reset)``.

        A missing/invalid pose, non-monotonic time, a dropped sequence number,
        or a long frame interval resets all temporal and filter state.
        """

        timestamp_ms = float(timestamp_ms)
        sequence_gap = (
            sequence is not None
            and self._last_sequence is not None
            and int(sequence) != self._last_sequence + 1
        )
        time_gap = (
            self._last_timestamp_ms is not None
            and (
                timestamp_ms <= self._last_timestamp_ms
                or timestamp_ms - self._last_timestamp_ms > self.max_gap_ms
            )
        )
        if landmarks is None or len(landmarks) != 33 or sequence_gap or time_gap:
            self.reset()
            if landmarks is None or len(landmarks) != 33 or time_gap:
                return None, True

        try:
            raw_xy = [
                (_point_value(point, "x"), _point_value(point, "y"))
                for point in landmarks
            ]
            if not all(math.isfinite(value) for xy in raw_xy for value in xy):
                raise ValueError("non-finite image landmark")
            dt = (
                (timestamp_ms - self._last_timestamp_ms) / 1000.0
                if self._last_timestamp_ms is not None
                else 1.0 / 30.0
            )
            coco: list[tuple[float, float, float]] = []
            for output_index, media_pipe_index in enumerate(COCO17_MEDIAPIPE_INDICES):
                point = landmarks[media_pipe_index]
                x, y = raw_xy[media_pipe_index]
                visibility = _point_value(point, "visibility", 1.0)
                if not math.isfinite(visibility):
                    visibility = 0.0
                filtered_x = self._filters[output_index][0].update(x, dt)
                filtered_y = self._filters[output_index][1].update(y, dt)
                coco.append((filtered_x * 2.0 - 1.0, filtered_y * 2.0 - 1.0, visibility))
            hip = (
                (raw_xy[23][0] + raw_xy[24][0]) * 0.5,
                (raw_xy[23][1] + raw_xy[24][1]) * 0.5,
            )
        except (AttributeError, IndexError, TypeError, ValueError):
            self.reset()
            return None, True

        self._frames.append((tuple(coco), hip, timestamp_ms))
        self._last_timestamp_ms = timestamp_ms
        self._last_sequence = int(sequence) if sequence is not None else None
        if len(self._frames) < WINDOW_SIZE:
            return None, sequence_gap

        points = tuple(item[0] for item in self._frames)
        hips = tuple(item[1] for item in self._frames)
        times = tuple(item[2] for item in self._frames)
        dx = hips[-1][0] - hips[0][0]
        dy = hips[-1][1] - hips[0][1]
        x_values = [point[0] for point in hips]
        y_values = [point[1] for point in hips]
        root = (dx, dy, max(x_values) - min(x_values), max(y_values) - min(y_values))
        # Compare four frames to reduce single-frame velocity noise. COCO index
        # 9 is the left wrist and index 10 the right wrist.
        offset = min(4, WINDOW_SIZE - 1)
        elapsed = max((times[-1] - times[-1 - offset]) / 1000.0, 1e-3)

        def wrist_speed(index: int) -> float:
            before, after = points[-1 - offset][index], points[-1][index]
            return math.hypot(after[0] - before[0], after[1] - before[1]) / elapsed

        return ModelWindow(
            skeleton=(points,),
            root_motion=root,
            timestamp_ms=timestamp_ms,
            left_wrist_speed=wrist_speed(9),
            right_wrist_speed=wrist_speed(10),
            hip_delta_x=dx,
        ), sequence_gap


@dataclass
class Core13WindowBuilder:
    """Frozen Penn Core13 preprocessing using filtered MediaPipe world coordinates."""

    max_gap_ms: float = 250.0
    _filters: list[tuple[OneEuro1D, OneEuro1D, OneEuro1D]] = field(init=False)
    _frames: deque[tuple[tuple[tuple[float, float, float], ...], tuple[float, float], float]] = field(
        default_factory=lambda: deque(maxlen=WINDOW_SIZE), init=False
    )
    _last_timestamp_ms: float | None = field(default=None, init=False)
    _last_sequence: int | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        self._filters = [(OneEuro1D(), OneEuro1D(), OneEuro1D()) for _ in CORE13_MEDIAPIPE_INDICES]

    @property
    def frame_count(self) -> int:
        return len(self._frames)

    def reset(self) -> None:
        self._frames.clear()
        self._last_timestamp_ms = None
        self._last_sequence = None
        for group in self._filters:
            for item in group:
                item.reset()

    def push(self, landmarks: Sequence[Any] | None, *, timestamp_ms: float, sequence: int | None = None, world_landmarks: Sequence[Any] | None = None) -> tuple[ModelWindow | None, bool]:
        timestamp_ms = float(timestamp_ms)
        sequence_gap = sequence is not None and self._last_sequence is not None and int(sequence) != self._last_sequence + 1
        time_gap = self._last_timestamp_ms is not None and (timestamp_ms <= self._last_timestamp_ms or timestamp_ms - self._last_timestamp_ms > self.max_gap_ms)
        if landmarks is None or len(landmarks) != 33 or world_landmarks is None or len(world_landmarks) != 33 or sequence_gap or time_gap:
            self.reset()
            if landmarks is None or len(landmarks) != 33 or world_landmarks is None or len(world_landmarks) != 33 or time_gap:
                return None, True
        try:
            image_xy = [(_point_value(point, "x"), _point_value(point, "y")) for point in landmarks]
            dt = (timestamp_ms - self._last_timestamp_ms) / 1000.0 if self._last_timestamp_ms is not None else 1.0 / 30.0
            filtered: list[tuple[float, float, float]] = []
            for output_index, media_pipe_index in enumerate(CORE13_MEDIAPIPE_INDICES):
                point = world_landmarks[media_pipe_index]
                raw = (_point_value(point, "x"), _point_value(point, "y"), _point_value(point, "z"))
                if not all(math.isfinite(value) for value in raw):
                    raise ValueError("non-finite world landmark")
                filters = self._filters[output_index]
                filtered.append(tuple(filters[axis].update(raw[axis], dt) for axis in range(3)))
            image_hip = ((image_xy[23][0] + image_xy[24][0]) * 0.5, (image_xy[23][1] + image_xy[24][1]) * 0.5)
        except (AttributeError, IndexError, TypeError, ValueError):
            self.reset()
            return None, True
        self._frames.append((tuple(filtered), image_hip, timestamp_ms))
        self._last_timestamp_ms = timestamp_ms
        self._last_sequence = int(sequence) if sequence is not None else None
        if len(self._frames) < WINDOW_SIZE:
            return None, sequence_gap

        raw_points = tuple(item[0] for item in self._frames)
        image_hips = tuple(item[1] for item in self._frames)
        times = tuple(item[2] for item in self._frames)
        # Core13 indices 1/2 are shoulders and 7/8 are hips.
        world_hips = [tuple((frame[7][axis] + frame[8][axis]) * 0.5 for axis in range(3)) for frame in raw_points]
        shoulders = [tuple((frame[1][axis] + frame[2][axis]) * 0.5 for axis in range(3)) for frame in raw_points]
        torso_lengths = [math.sqrt(sum((shoulder[axis] - hip[axis]) ** 2 for axis in range(3))) for shoulder, hip in zip(shoulders, world_hips, strict=True)]
        ordered = sorted(torso_lengths)
        scale = (ordered[11] + ordered[12]) * 0.5
        if not math.isfinite(scale) or scale <= 1e-6:
            self.reset()
            return None, True
        points = tuple(tuple(tuple((point[axis] - hip[axis]) / scale for axis in range(3)) for point in frame) for frame, hip in zip(raw_points, world_hips, strict=True))
        dx, dy = image_hips[-1][0] - image_hips[0][0], image_hips[-1][1] - image_hips[0][1]
        xs, ys = [item[0] for item in image_hips], [item[1] for item in image_hips]
        root = (dx, dy, max(xs) - min(xs), max(ys) - min(ys))
        offset = min(4, WINDOW_SIZE - 1)
        elapsed = max((times[-1] - times[-1-offset]) / 1000.0, 1e-3)
        def speed(index: int) -> float:
            before, after = points[-1-offset][index], points[-1][index]
            return math.sqrt(sum((after[axis] - before[axis]) ** 2 for axis in range(3))) / elapsed
        return ModelWindow(skeleton=(points,), root_motion=root, timestamp_ms=timestamp_ms, left_wrist_speed=speed(5), right_wrist_speed=speed(6), hip_delta_x=dx), sequence_gap


@dataclass(frozen=True)
class ActionTiming:
    trigger_threshold: float = 0.72
    release_threshold: float = 0.45
    prepare_ms: float = 120.0
    minimum_hold_ms: float = 100.0
    cooldown_ms: float = 380.0


@dataclass
class _PhaseState:
    phase: str = "neutral"
    candidate_since_ms: float | None = None
    triggered_at_ms: float | None = None
    cooldown_until_ms: float = 0.0


@dataclass
class ActionStateMachine:
    """Turns window predictions into debounced, mutually-exclusive actions."""

    timing: dict[str, ActionTiming] = field(
        default_factory=lambda: {label: ActionTiming() for label in ACTIVE_LABELS}
    )
    distractor_threshold: float = 0.55
    _states: dict[str, _PhaseState] = field(
        default_factory=lambda: {label: _PhaseState() for label in ACTIVE_LABELS}, init=False
    )
    _current: str | None = field(default=None, init=False)

    def reset(self) -> None:
        self._states = {label: _PhaseState() for label in ACTIVE_LABELS}
        self._current = None

    def update(
        self,
        probabilities: Mapping[str, float],
        *,
        timestamp_ms: float,
        window: ModelWindow,
    ) -> dict[str, Any]:
        scores = {label: float(probabilities.get(label, 0.0)) for label in CLASS_LABELS}
        predicted = max(CLASS_LABELS, key=scores.__getitem__)
        confidence = scores[predicted]
        if predicted in DISTRACTOR_LABELS and confidence >= self.distractor_threshold:
            self.reset()
            return self._result(
                predicted, confidence, "suppressed", window,
                suppressed_by=predicted,
            )

        candidate = predicted if predicted in ACTIVE_LABELS else None
        for label, state in self._states.items():
            if label != candidate and state.phase in {"preparing", "triggered", "holding"}:
                state.phase = "cooldown"
                state.cooldown_until_ms = timestamp_ms + self.timing[label].cooldown_ms
                state.candidate_since_ms = None
                state.triggered_at_ms = None
        if candidate is None:
            self._current = None
            return self._result(predicted, confidence, "neutral", window)

        state = self._states[candidate]
        config = self.timing[candidate]
        if state.phase == "cooldown":
            if timestamp_ms < state.cooldown_until_ms:
                return self._result(candidate, confidence, "cooldown", window)
            state.phase = "neutral"
        if state.phase == "neutral":
            if confidence >= config.trigger_threshold:
                state.phase = "preparing"
                state.candidate_since_ms = timestamp_ms
            return self._result(candidate, confidence, state.phase, window)
        if state.phase == "preparing":
            if confidence < config.trigger_threshold:
                state.phase = "neutral"
                state.candidate_since_ms = None
            elif timestamp_ms - (state.candidate_since_ms or timestamp_ms) >= config.prepare_ms:
                state.phase = "triggered"
                state.triggered_at_ms = timestamp_ms
                self._current = candidate
                return self._result(candidate, confidence, "triggered", window, triggered=True)
            return self._result(candidate, confidence, state.phase, window)
        if state.phase == "triggered":
            state.phase = "holding"
        if state.phase == "holding":
            held_for = timestamp_ms - (state.triggered_at_ms or timestamp_ms)
            if confidence < config.release_threshold and held_for >= config.minimum_hold_ms:
                state.phase = "cooldown"
                state.cooldown_until_ms = timestamp_ms + config.cooldown_ms
                self._current = None
                return self._result(candidate, confidence, "cooldown", window, released=True)
            return self._result(candidate, confidence, "holding", window, active=True)
        return self._result(candidate, confidence, state.phase, window)

    def _result(
        self,
        label: str,
        confidence: float,
        phase: str,
        window: ModelWindow,
        *,
        triggered: bool = False,
        released: bool = False,
        active: bool = False,
        suppressed_by: str | None = None,
    ) -> dict[str, Any]:
        qualifier: str | None = None
        chinese = CHINESE_ACTIONS[label]
        if label == "RAPID_ARM_STRIKE":
            if window.left_wrist_speed > window.right_wrist_speed * 1.12:
                qualifier, chinese = "left", "左拳"
            elif window.right_wrist_speed > window.left_wrist_speed * 1.12:
                qualifier, chinese = "right", "右拳"
        elif label == "LUNGE_SHIFT":
            if window.hip_delta_x < -0.015:
                qualifier, chinese = "left", "向左弓步"
            elif window.hip_delta_x > 0.015:
                qualifier, chinese = "right", "向右弓步"
        return {
            "label": label,
            "action": label if label in ACTIVE_LABELS and phase not in {"suppressed", "neutral"} else None,
            "action_zh": chinese,
            "qualifier": qualifier,
            "confidence": confidence,
            "phase": phase,
            "triggered": triggered,
            "active": active or triggered,
            "released": released,
            "suppressed": suppressed_by is not None,
            "suppressed_by": suppressed_by,
        }


class _TorchBackend:
    def __init__(self, torch_module: Any, model: Any) -> None:
        self.torch = torch_module
        self.model = model.eval()

    def predict(self, skeleton: Sequence[Any], root_motion: Sequence[float]) -> Sequence[float]:
        torch = self.torch
        # skeleton is [M,T,V,C]; add batch to get the training shape [B,M,T,V,C].
        body = torch.tensor([skeleton], dtype=torch.float32)
        root = torch.tensor([root_motion], dtype=torch.float32)
        with torch.inference_mode():
            logits = self.model(body, root)[0]
            probabilities = torch.softmax(logits, dim=0).detach().cpu().tolist()
        return probabilities


class _OnnxBackend:
    """CPU-only ONNX Runtime backend for the portable research package."""

    def __init__(self, session: Any) -> None:
        self.session = session

    def predict(self, skeleton: Sequence[Any], root_motion: Sequence[float]) -> Sequence[float]:
        import numpy as np

        pose = np.asarray([skeleton], dtype=np.float32)
        root = np.asarray([root_motion], dtype=np.float32)
        logits = self.session.run(["logits"], {"pose": pose, "root": root})[0][0]
        logits = logits.astype(np.float64)
        logits -= logits.max()
        values = np.exp(logits)
        values /= values.sum()
        return values.tolist()


def _default_model_factory(torch: Any) -> Any:
    try:
        from mmaction.models.backbones import STGCN
    except Exception as exc:  # pragma: no cover - depends on the research runtime
        raise RuntimeError("缺少 mmaction STGCN++ 运行组件") from exc

    nn = torch.nn

    class Coco17Model(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.backbone = STGCN(
                graph_cfg={"layout": "coco", "mode": "spatial"},
                in_channels=3,
                num_person=1,
                gcn_adaptive="init",
                gcn_with_res=True,
                tcn_type="mstcn",
            )
            self.root_branch = nn.Sequential(nn.Linear(4, 32), nn.ReLU())
            self.head = nn.Linear(288, len(CLASS_LABELS))

        def forward(self, skeleton: Any, root: Any) -> Any:
            feature = self.backbone(skeleton).mean(dim=(1, 3, 4))
            return self.head(torch.cat([feature, self.root_branch(root)], 1))

    return Coco17Model()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass
class ActionModelEngine:
    """Safe facade used by the runtime before falling back to rule recognition."""

    validated_model: ValidatedModel | None = None
    window_builder: Coco17WindowBuilder | Core13WindowBuilder = field(default_factory=Coco17WindowBuilder)
    state_machine: ActionStateMachine = field(default_factory=ActionStateMachine)
    _state: str = field(default="parameters_pending", init=False)
    _detail: str = field(default="参数准备中", init=False)
    _last_inference_ms: float = field(default=0.0, init=False)

    def __post_init__(self) -> None:
        if self.validated_model is not None:
            # ValidatedModel.__post_init__ has already checked the immutable contract.
            self._state, self._detail = "ready", "模型已就绪"

    def reset(self) -> None:
        self.window_builder.reset()
        self.state_machine.reset()
        self._last_inference_ms = 0.0

    def status(self) -> dict[str, Any]:
        model = self.validated_model
        return {
            "state": self._state,
            "state_zh": self._detail,
            "ready": model is not None,
            "checkpoint_path": model.checkpoint_path if model else None,
            "checkpoint_sha256": model.checkpoint_sha256 if model else None,
            "protocol_hash": model.protocol_hash if model else None,
            "best_epoch": model.best_epoch if model else None,
            "frames_ready": self.window_builder.frame_count,
            "frames_required": WINDOW_SIZE,
            "inference_ms": self._last_inference_ms,
            "labels": list(CLASS_LABELS),
        }

    def load_checkpoint(
        self,
        checkpoint_path: str | Path,
        *,
        expected_sha256: str,
        expected_protocol_hash: str,
        model_factory: Callable[[Any], Any] | None = None,
    ) -> dict[str, Any]:
        """Load a state-dict checkpoint only after hash and protocol validation.

        Every failure is non-throwing and leaves the engine unable to infer.
        That invariant prevents accidental use of random parameters.
        """

        self.validated_model = None
        self.reset()
        self._state, self._detail = "parameters_pending", "参数准备中"
        path = Path(checkpoint_path)
        try:
            if not path.is_file():
                raise ValueError("正式模型参数不存在")
            actual_sha256 = _sha256(path)
            if not expected_sha256 or actual_sha256.lower() != expected_sha256.lower():
                raise ValueError("模型参数 SHA256 校验失败")
            if not expected_protocol_hash:
                raise ValueError("缺少协议哈希")
            import torch

            try:
                payload = torch.load(path, map_location="cpu", weights_only=True)
            except TypeError:  # older research-only PyTorch
                payload = torch.load(path, map_location="cpu")
            if not isinstance(payload, Mapping):
                raise ValueError("模型参数格式无效")
            protocol_hash = payload.get("protocol_sha256", payload.get("protocol_hash"))
            if protocol_hash != expected_protocol_hash:
                raise ValueError("模型协议校验失败")
            if payload.get("candidate") != EXPECTED_CANDIDATE:
                raise ValueError("不是指定的 OpenMMLab COCO17 六分类模型")
            if payload.get("topology") != EXPECTED_TOPOLOGY:
                raise ValueError("模型人体骨架拓扑不匹配")
            state_dict = payload.get("state_dict")
            if not isinstance(state_dict, Mapping):
                raise ValueError("模型缺少 state_dict")
            head = state_dict.get("head.weight")
            if head is None or tuple(head.shape)[0] != len(CLASS_LABELS):
                raise ValueError("模型六分类输出顺序或形状不匹配")
            root_weight = state_dict.get("root_branch.0.weight")
            if root_weight is None or tuple(root_weight.shape)[1] != 4:
                raise ValueError("Root Motion 输入形状不匹配")
            model = (model_factory or _default_model_factory)(torch)
            model.load_state_dict(state_dict, strict=True)
            self.validated_model = ValidatedModel(
                backend=_TorchBackend(torch, model),
                checkpoint_sha256=actual_sha256,
                protocol_hash=expected_protocol_hash,
                checkpoint_path=str(path.resolve()),
                best_epoch=int(payload["epoch"]) if payload.get("epoch") is not None else None,
            )
            self._state, self._detail = "ready", "模型已就绪"
        except Exception as exc:
            self.validated_model = None
            self._state, self._detail = "parameters_pending", f"参数准备中：{exc}"
        return self.status()

    def load_onnx(
        self,
        model_path: str | Path,
        *,
        metadata_path: str | Path,
        expected_sha256: str,
        expected_source_checkpoint_sha256: str,
        expected_protocol_hash: str,
        expected_candidate: str = EXPECTED_CANDIDATE,
        expected_topology: str = EXPECTED_TOPOLOGY,
    ) -> dict[str, Any]:
        """Strictly validate and load a portable ONNX model without PyTorch."""

        self.validated_model = None
        self.reset()
        self._state, self._detail = "parameters_pending", "参数准备中"
        path, metadata_file = Path(model_path), Path(metadata_path)
        try:
            if not path.is_file() or not metadata_file.is_file():
                raise ValueError("便携 ONNX 模型或元数据不存在")
            actual_sha256 = _sha256(path)
            if actual_sha256.lower() != expected_sha256.lower():
                raise ValueError("ONNX 模型 SHA256 校验失败")
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            if metadata.get("status") != "INTERNAL_RESEARCH_ONLY":
                raise ValueError("模型未标记为内部研究用途")
            if expected_candidate not in SUPPORTED_MODEL_CONTRACTS or SUPPORTED_MODEL_CONTRACTS[expected_candidate] != expected_topology:
                raise ValueError("不支持的模型候选或拓扑")
            if metadata.get("candidate") != expected_candidate or metadata.get("topology") != expected_topology:
                raise ValueError("ONNX 模型候选或人体骨架拓扑不匹配")
            if tuple(metadata.get("labels", [])) != CLASS_LABELS:
                raise ValueError("ONNX 六分类输出顺序不匹配")
            vertices = 13 if expected_topology == "core13" else 17
            if metadata.get("pose_shape") != ["N", 1, 24, vertices, 3] or metadata.get("root_shape") != ["N", 4]:
                raise ValueError("ONNX 输入形状不匹配")
            if metadata.get("output_shape") != ["N", 6]:
                raise ValueError("ONNX 输出形状不匹配")
            if metadata.get("onnx_sha256", "").lower() != actual_sha256.lower():
                raise ValueError("ONNX 元数据哈希不匹配")
            if metadata.get("source_checkpoint_sha256", "").lower() != expected_source_checkpoint_sha256.lower():
                raise ValueError("源 checkpoint 身份不匹配")
            if metadata.get("protocol_sha256") != expected_protocol_hash:
                raise ValueError("ONNX 模型协议校验失败")
            import onnxruntime as ort

            session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
            inputs = {item.name: item.shape for item in session.get_inputs()}
            outputs = {item.name: item.shape for item in session.get_outputs()}
            if set(inputs) != {"pose", "root"} or set(outputs) != {"logits"}:
                raise ValueError("ONNX 输入输出名称不匹配")
            probe = _OnnxBackend(session).predict(
                [[[[0.0, 0.0, 0.0] for _ in range(vertices)] for _ in range(24)]],
                [0.0, 0.0, 0.0, 0.0],
            )
            if len(probe) != len(CLASS_LABELS) or not all(math.isfinite(value) for value in probe):
                raise ValueError("ONNX 真实推理探测失败")
            self.validated_model = ValidatedModel(
                backend=_OnnxBackend(session),
                checkpoint_sha256=actual_sha256,
                protocol_hash=expected_protocol_hash,
                checkpoint_path=str(path.resolve()),
                best_epoch=int(metadata.get("best_epoch", 12)),
                candidate=expected_candidate,
                topology=expected_topology,
            )
            self.window_builder = Core13WindowBuilder() if expected_topology == "core13" else Coco17WindowBuilder()
            self._state, self._detail = "ready", "模型已就绪（ONNX CPU）"
        except Exception as exc:
            self.validated_model = None
            self._state, self._detail = "parameters_pending", f"参数准备中：{exc}"
        return self.status()

    def process(
        self,
        landmarks: Sequence[Any] | None,
        *,
        timestamp_ms: float,
        sequence: int | None = None,
        world_landmarks: Sequence[Any] | None = None,
    ) -> dict[str, Any]:
        if self.validated_model is None:
            return self._fallback("parameters_pending", release=False)
        window, gap_reset = self.window_builder.push(
            landmarks, timestamp_ms=timestamp_ms, sequence=sequence, world_landmarks=world_landmarks,
        )
        if gap_reset:
            self.state_machine.reset()
            return self._fallback("input_gap", release=True)
        if window is None:
            return self._fallback("warming_up", release=False)
        try:
            started = time.perf_counter()
            raw = self.validated_model.backend.predict(window.skeleton, window.root_motion)
            self._last_inference_ms = (time.perf_counter() - started) * 1000.0
            if len(raw) != len(CLASS_LABELS):
                raise ValueError("model output must contain exactly six values")
            values = [float(value) for value in raw]
            if not all(math.isfinite(value) and value >= 0.0 for value in values):
                raise ValueError("model output contains invalid probabilities")
            total = sum(values)
            if total <= 0.0:
                raise ValueError("model output probabilities sum to zero")
            probabilities = {
                label: value / total for label, value in zip(CLASS_LABELS, values, strict=True)
            }
            action = self.state_machine.update(
                probabilities, timestamp_ms=timestamp_ms, window=window,
            )
            self._state, self._detail = "ready", "模型已就绪"
            return {
                "usable": True,
                "fallback_required": False,
                "release_required": bool(action["released"]),
                "reason": None,
                "model_state": self._state,
                "inference_ms": self._last_inference_ms,
                "probabilities": probabilities,
                **action,
            }
        except Exception as exc:
            self.window_builder.reset()
            self.state_machine.reset()
            self._state, self._detail = "runtime_error", f"模型推理失败：{exc}"
            return self._fallback("inference_error", release=True)

    def process_frame(self, frame: Any) -> dict[str, Any]:
        """Convenience adapter for PoseFrame or pose-frame-like mappings."""

        if isinstance(frame, Mapping):
            pose = frame.get("pose")
            world_pose = frame.get("world_pose")
            timestamp = frame.get("captured_at_ms", 0.0)
            sequence = frame.get("sequence")
        else:
            pose = getattr(frame, "pose", None)
            world_pose = getattr(frame, "world_pose", None)
            timestamp = getattr(frame, "captured_at_ms", 0.0)
            sequence = getattr(frame, "sequence", None)
        return self.process(pose, timestamp_ms=float(timestamp), sequence=sequence, world_landmarks=world_pose)

    def mark_input_missing(self) -> dict[str, Any]:
        self.reset()
        return self._fallback("input_missing", release=True)

    def _fallback(self, reason: str, *, release: bool) -> dict[str, Any]:
        return {
            "usable": False,
            "fallback_required": True,
            "release_required": release,
            "reason": reason,
            "model_state": self._state,
            "action": None,
            "action_zh": None,
            "qualifier": None,
            "confidence": 0.0,
            "phase": "neutral",
            "triggered": False,
            "active": False,
            "released": release,
            "suppressed": False,
            "suppressed_by": None,
            "inference_ms": self._last_inference_ms,
            "probabilities": {},
        }
