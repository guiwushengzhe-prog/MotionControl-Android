from __future__ import annotations

import json
import math
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, ClassVar, Mapping, Sequence


# MediaPipe Pose 33-point indices used by the first Motion Lab actions.
SHOULDER_L, SHOULDER_R = 11, 12
ELBOW_L, ELBOW_R = 13, 14
WRIST_L, WRIST_R = 15, 16
HIP_L, HIP_R = 23, 24
KNEE_L, KNEE_R = 25, 26

ACTION_JOINTS: dict[str, dict[str, list[int]]] = {
    "right_punch": {"trajectory": [SHOULDER_R, ELBOW_R, WRIST_R], "support": [SHOULDER_L, SHOULDER_R, HIP_L, HIP_R], "lead": WRIST_R},
    "left_punch": {"trajectory": [SHOULDER_L, ELBOW_L, WRIST_L], "support": [SHOULDER_L, SHOULDER_R, HIP_L, HIP_R], "lead": WRIST_L},
    "side_dodge": {"trajectory": [SHOULDER_L, SHOULDER_R, HIP_L, HIP_R], "support": [HIP_L, HIP_R, KNEE_L, KNEE_R], "lead": SHOULDER_L},
    "hands_up": {"trajectory": [SHOULDER_L, SHOULDER_R, WRIST_L, WRIST_R], "support": [SHOULDER_L, SHOULDER_R, HIP_L, HIP_R], "lead": WRIST_L},
}

ACTION_LABELS = {
    "right_punch": "右拳",
    "left_punch": "左拳",
    "side_dodge": "侧闪",
    "hands_up": "双手举起",
}

_WAKE_WORD = "体感"
_CONFIRM_TIMEOUT_S = 5.0


def _landmark_xyz(point: Any) -> tuple[float, float, float]:
    if isinstance(point, Mapping):
        return float(point.get("x", 0.0)), float(point.get("y", 0.0)), float(point.get("z", 0.0))
    return float(getattr(point, "x", 0.0)), float(getattr(point, "y", 0.0)), float(getattr(point, "z", 0.0))


def extract_pose(frame: Any) -> list[tuple[float, float, float]] | None:
    """Return the first person's 33 landmarks as a list of (x, y, z), or None."""
    pose = None
    if isinstance(frame, Mapping):
        if isinstance(frame.get("pose"), list):
            pose = frame["pose"]
        elif isinstance(frame.get("poses"), list) and frame["poses"]:
            pose = frame["poses"][0].get("pose") if isinstance(frame["poses"][0], Mapping) else None
    else:
        if hasattr(frame, "pose"):
            pose = frame.pose
        elif hasattr(frame, "poses") and frame.poses:
            pose = getattr(frame.poses[0], "pose", None)
    if not isinstance(pose, list):
        return None
    points = [_landmark_xyz(point) for point in pose]
    return points if len(points) >= 33 else None


def normalize_sequence(
    frames: Sequence[Any],
    action_id: str,
) -> list[list[tuple[float, float, float]]]:
    """Center each frame on the hip midpoint and scale by shoulder width.

    Absolute screen position, distance from camera, body height and shoulder
    width are removed so templates remain reusable across sessions and games.
    """
    if action_id not in ACTION_JOINTS:
        raise ValueError(f"未知动作: {action_id}")
    normalized: list[list[tuple[float, float, float]]] = []
    for frame in frames:
        pose = extract_pose(frame)
        if pose is None:
            continue
        hip = (
            (pose[HIP_L][0] + pose[HIP_R][0]) / 2.0,
            (pose[HIP_L][1] + pose[HIP_R][1]) / 2.0,
            (pose[HIP_L][2] + pose[HIP_R][2]) / 2.0,
        )
        shoulder_span = math.hypot(
            pose[SHOULDER_R][0] - pose[SHOULDER_L][0],
            pose[SHOULDER_R][1] - pose[SHOULDER_L][1],
        )
        torso = math.hypot(
            (pose[SHOULDER_L][0] + pose[SHOULDER_R][0]) / 2.0 - hip[0],
            (pose[SHOULDER_L][1] + pose[SHOULDER_R][1]) / 2.0 - hip[1],
        )
        scale = shoulder_span if shoulder_span > 1e-6 else torso if torso > 1e-6 else 1.0
        normalized.append([
            ((point[0] - hip[0]) / scale, (point[1] - hip[1]) / scale, (point[2] - hip[2]) / scale)
            for point in pose
        ])
    return normalized


def _flatten(frame: list[tuple[float, float, float]], indices: Sequence[int]) -> list[float]:
    values: list[float] = []
    for index in indices:
        x, y, z = frame[index]
        values.extend((x, y, z))
    return values


def dtw_distance(seq_a: Sequence[list[float]], seq_b: Sequence[list[float]]) -> float:
    """Classic DTW over flattened joint vectors; no windowing in v1."""
    if not seq_a or not seq_b:
        return float("inf")
    rows, cols = len(seq_a), len(seq_b)
    cost = [[float("inf")] * cols for _ in range(rows)]
    for i in range(rows):
        for j in range(cols):
            distance = math.dist(seq_a[i], seq_b[j])
            if i == 0 and j == 0:
                cost[i][j] = distance
            elif i == 0:
                cost[i][j] = distance + cost[i][j - 1]
            elif j == 0:
                cost[i][j] = distance + cost[i - 1][j]
            else:
                cost[i][j] = distance + min(cost[i - 1][j], cost[i][j - 1], cost[i - 1][j - 1])
    return cost[-1][-1]


def _similarity_from_distance(distance: float, scale: float = 1.0) -> float:
    return max(0.0, min(100.0, 100.0 * math.exp(-distance / max(scale, 1e-6))))


def _path_length(seq: Sequence[list[float]]) -> float:
    total = 0.0
    for index in range(1, len(seq)):
        total += math.dist(seq[index], seq[index - 1])
    return total


def _lead_displacement(seq: Sequence[list[float]]) -> tuple[float, float, float]:
    if len(seq) < 2:
        return (0.0, 0.0, 0.0)
    first, last = seq[0], seq[-1]
    return last[0] - first[0], last[1] - first[1], last[2] - first[2]


def compare_action(
    template_frames: Sequence[Any],
    candidate_frames: Sequence[Any],
    action_id: str,
) -> dict[str, Any]:
    """Transparent, explainable template similarity (0-100) with sub-scores."""
    template = normalize_sequence(template_frames, action_id)
    candidate = normalize_sequence(candidate_frames, action_id)
    if not template or not candidate:
        return {"ok": False, "message": "缺少有效 Pose 序列", "score": 0.0}

    joints = ACTION_JOINTS[action_id]
    template_flat = [_flatten(frame, joints["trajectory"]) for frame in template]
    candidate_flat = [_flatten(frame, joints["trajectory"]) for frame in candidate]

    trajectory = _similarity_from_distance(dtw_distance(template_flat, candidate_flat))

    lead = joints["lead"]
    template_lead = [frame[lead] for frame in template]
    candidate_lead = [frame[lead] for frame in candidate]
    d_t = _lead_displacement(template_lead)
    d_c = _lead_displacement(candidate_lead)
    dot = d_t[0] * d_c[0] + d_t[1] * d_c[1] + d_t[2] * d_c[2]
    norm_t = math.sqrt(sum(value * value for value in d_t))
    norm_c = math.sqrt(sum(value * value for value in d_c))
    direction = 0.0 if norm_t < 1e-6 or norm_c < 1e-6 else max(0.0, dot / (norm_t * norm_c))
    direction_score = direction * 100.0

    template_speed = _path_length(template_flat) / max(len(template), 1)
    candidate_speed = _path_length(candidate_flat) / max(len(candidate), 1)
    speed_ratio = min(template_speed, candidate_speed) / max(max(template_speed, candidate_speed), 1e-6)
    speed_score = speed_ratio * 100.0

    template_amplitude = norm_t
    candidate_amplitude = norm_c
    amplitude_ratio = min(template_amplitude, candidate_amplitude) / max(max(template_amplitude, candidate_amplitude), 1e-6)
    amplitude_score = amplitude_ratio * 100.0

    duration_ratio = min(len(template), len(candidate)) / max(max(len(template), len(candidate)), 1)
    duration_score = duration_ratio * 100.0

    stability = 0.0
    for frame in template:
        support_values = [frame[index] for index in joints["support"]]
        center = [sum(value) / len(support_values) for value in zip(*support_values)]
        stability += sum(math.dist(value, center) for value in support_values) / len(support_values)
    stability /= max(len(template), 1)
    stability_score = _similarity_from_distance(stability, scale=0.5)

    score = round(
        0.38 * trajectory + 0.18 * direction_score + 0.12 * speed_score
        + 0.12 * amplitude_score + 0.10 * duration_score + 0.10 * stability_score,
        1,
    )
    return {
        "ok": True,
        "score": score,
        "trajectory": round(trajectory, 1),
        "direction": round(direction_score, 1),
        "speed": round(speed_score, 1),
        "amplitude": round(amplitude_score, 1),
        "duration": round(duration_score, 1),
        "stability": round(stability_score, 1),
        "frame_count": {"template": len(template), "candidate": len(candidate)},
    }


def recommend_threshold(
    real_scores: Sequence[float],
    false_scores: Sequence[float],
    *,
    margin: float = 0.08,
) -> dict[str, Any]:
    """Recommend a trigger threshold between real-action and non-target scores."""
    real = sorted(float(value) for value in real_scores)
    false = sorted(float(value) for value in false_scores)
    if not real:
        return {"ok": False, "message": "没有真实动作相似度样本", "threshold": None}
    real_min, real_avg = real[0], sum(real) / len(real)
    false_max = false[-1] if false else 0.0
    # Favor separation; when distributions overlap, clamp near the real minimum.
    gap = real_min - false_max
    if gap > 0:
        threshold = false_max + gap * 0.5
    else:
        threshold = real_min * 0.82
    threshold = max(1.0, min(99.0, round(threshold, 1)))
    return {
        "ok": True,
        "threshold": threshold,
        "real_min": round(real_min, 1),
        "real_avg": round(real_avg, 1),
        "false_max": round(false_max, 1),
        "margin": margin,
    }


@dataclass
class PersonalActionTemplate:
    action_id: str
    normalized_frames: list[list[list[float]]]
    created_at: str
    source_frame_count: int = 0
    meta: dict[str, Any] = field(default_factory=dict)


class PersonalActionStore:
    """Per-player personal action library, reusable across games."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _path(self, player_id: str, action_id: str) -> Path:
        safe_player = re.sub(r"[^A-Za-z0-9_-]", "_", player_id) or "player"
        safe_action = re.sub(r"[^A-Za-z0-9_-]", "_", action_id)
        return self.root / safe_player / f"{safe_action}.json"

    def save(self, player_id: str, action_id: str, frames: Sequence[Any], *, meta: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if action_id not in ACTION_JOINTS:
            raise ValueError(f"未知动作: {action_id}")
        normalized = normalize_sequence(frames, action_id)
        if not normalized:
            raise ValueError("没有可保存的 Pose 序列")
        template = PersonalActionTemplate(
            action_id=action_id,
            normalized_frames=[[list(point) for point in frame] for frame in normalized],
            created_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            source_frame_count=len(frames),
            meta=dict(meta or {}),
        )
        payload = {
            "schema_version": 1,
            "action_id": action_id,
            "normalized_frames": template.normalized_frames,
            "created_at": template.created_at,
            "source_frame_count": template.source_frame_count,
            "meta": template.meta,
        }
        path = self._path(player_id, action_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        with self._lock:
            temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            temp.replace(path)
        return payload

    def load(self, player_id: str, action_id: str) -> dict[str, Any] | None:
        path = self._path(player_id, action_id)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def list(self, player_id: str) -> list[dict[str, Any]]:
        player_root = self.root / player_id
        if not player_root.is_dir():
            return []
        items: list[dict[str, Any]] = []
        for path in sorted(player_root.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                items.append({
                    "action_id": data.get("action_id"),
                    "label": ACTION_LABELS.get(data.get("action_id"), data.get("action_id")),
                    "created_at": data.get("created_at"),
                    "source_frame_count": data.get("source_frame_count"),
                    "meta": data.get("meta", {}),
                })
            except (OSError, ValueError):
                continue
        return items

    def delete(self, player_id: str, action_id: str) -> bool:
        path = self._path(player_id, action_id)
        if not path.exists():
            return False
        path.unlink()
        return True


@dataclass
class MotionLabVoiceContext:
    """Strict context + wake-word + limited-command state machine.

    Only commands allowed in the current context execute.  Critical operations
    require a confirmation phrase, recordings lock out navigation commands, and
    the emergency command is always valid.
    """

    wake_word: str = _WAKE_WORD
    context: str = "idle"
    _pending_confirm: tuple[str, float] | None = None
    _recording_locked: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _clock: Callable[[], float] = time.monotonic

    COMMANDS: ClassVar[dict[str, dict[str, tuple[str, ...]]]] = {
        "idle": {"navigate": ("开始训练", "进入训练"), "critical": ("退出训练",)},
        "teach": {"navigate": ("开始录制", "下一步", "返回"), "critical": ("退出训练",)},
        "recording_ready": {"navigate": ("开始录制", "返回"), "critical": ("保存动作",)},
        "recording_locked": {"navigate": (), "critical": ()},
        "confirm_save": {"navigate": ("确认保存", "取消"), "critical": ()},
        "test": {"navigate": ("开始测试", "重新测试", "下一步", "返回"), "critical": ("退出训练",)},
    }

    CRITICAL_COMMANDS: ClassVar[set[str]] = {"保存动作", "退出训练", "删除全部训练数据"}
    CONFIRM_PHRASES: ClassVar[dict[str, str]] = {"保存动作": "确认保存", "退出训练": "确认退出", "删除全部训练数据": "确认删除全部训练数据"}
    EMERGENCY_PHRASES: ClassVar[tuple[str, ...]] = ("紧急停止", "立即停止", "取消")

    def set_context(self, context: str, *, recording_locked: bool = False) -> None:
        with self._lock:
            if context not in self.COMMANDS:
                raise ValueError(f"未知语音上下文: {context}")
            self.context = context
            self._recording_locked = recording_locked
            self._pending_confirm = None

    def _expire_confirmation(self, now: float) -> None:
        if self._pending_confirm and now - self._pending_confirm[1] > _CONFIRM_TIMEOUT_S:
            self._pending_confirm = None

    def accept(self, raw_text: str, *, now: float | None = None) -> dict[str, Any]:
        at = self._clock() if now is None else now
        text = self._normalize(raw_text)
        with self._lock:
            self._expire_confirmation(at)
            if self._recording_locked:
                if self._contains(text, self.EMERGENCY_PHRASES):
                    self._recording_locked = False
                    self._pending_confirm = None
                    return {"ok": True, "executed": True, "command": "紧急停止", "raw_text": raw_text, "context": self.context}
                return {"ok": False, "executed": False, "command": None, "reason": "录制锁定，仅允许：体感，紧急停止", "raw_text": raw_text, "context": self.context}

            if self._contains(text, self.EMERGENCY_PHRASES):
                self._pending_confirm = None
                return {"ok": True, "executed": True, "command": "紧急停止", "raw_text": raw_text, "context": self.context}

            if self._pending_confirm is not None:
                pending, _ = self._pending_confirm
                expected = self.CONFIRM_PHRASES[pending]
                if self._contains(text, (expected,)):
                    self._pending_confirm = None
                    return {"ok": True, "executed": True, "command": pending, "confirmed": True, "raw_text": raw_text, "context": self.context}
                if self._contains(text, ("取消",)):
                    self._pending_confirm = None
                    return {"ok": False, "executed": False, "command": None, "reason": "已取消", "raw_text": raw_text, "context": self.context}
                return {"ok": False, "executed": False, "command": None, "reason": f"等待确认，请说：体感，{expected}", "raw_text": raw_text, "context": self.context}

            if not self._has_wake_word(text):
                return {"ok": False, "executed": False, "command": None, "reason": "缺少唤醒词", "raw_text": raw_text, "context": self.context}

            allowed = self.COMMANDS.get(self.context, {})
            all_allowed = allowed.get("navigate", ()) + allowed.get("critical", ())
            command = self._match_command(text, all_allowed)
            if command is None:
                return {"ok": False, "executed": False, "command": None, "reason": "当前页面不允许此命令", "raw_text": raw_text, "context": self.context}

            if command in self.CRITICAL_COMMANDS:
                confirm_phrase = self.CONFIRM_PHRASES[command]
                self._pending_confirm = (command, at)
                return {
                    "ok": False, "executed": False, "command": command, "needs_confirmation": True,
                    "reason": f"准备{command}，请说：体感，{confirm_phrase}", "raw_text": raw_text, "context": self.context,
                }
            return {"ok": True, "executed": True, "command": command, "raw_text": raw_text, "context": self.context}

    def _normalize(self, text: str) -> str:
        return re.sub(r"[\s，。！？、,.!?：:；;—_-]", "", text).lower()

    def _has_wake_word(self, normalized: str) -> bool:
        wake = self._normalize(self.wake_word)
        return bool(wake) and wake in normalized

    def _contains(self, normalized: str, phrases: Sequence[str]) -> bool:
        return any(self._normalize(phrase) in normalized for phrase in phrases)

    def _match_command(self, normalized: str, commands: Sequence[str]) -> str | None:
        matches = [command for command in commands if self._contains(normalized, (command,))]
        if not matches:
            return None
        return max(matches, key=len)


__all__ = [
    "ACTION_JOINTS",
    "ACTION_LABELS",
    "MotionLabVoiceContext",
    "PersonalActionStore",
    "compare_action",
    "dtw_distance",
    "extract_pose",
    "normalize_sequence",
    "recommend_threshold",
]
