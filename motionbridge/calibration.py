from __future__ import annotations

import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .geometry import percentile, robust_center
from .models import PlayerProfile, PoseFrame
from .geometry import calibration_visibility_issues, extract_pose_features


STAGES = ("neutral", "arms_up", "t_pose", "squat", "lean_sides")
MIN_STAGE_SAMPLES = 8
STAGE_TITLES = {
    "neutral": "自然站立",
    "arms_up": "双手举过头顶",
    "t_pose": "展开双臂",
    "squat": "自然下蹲",
    "lean_sides": "左右倾斜",
}
STAGE_HOLD_GUIDANCE = {
    "neutral": "面向镜头自然站直，双手放下并保持",
    "arms_up": "双手伸直并稳定举过头顶",
    "t_pose": "双臂水平伸直，手腕保持在肩膀高度",
    "squat": "继续下蹲，让髋部明显降低并保持",
    "lean_sides": "缓慢完成左右两个方向的侧倾",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff_-]+", "-", value.strip()).strip("-")
    return value[:40] or "player"


class ProfileStore:
    """Persists every calibration session and derives an all-session aggregate."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def list(self) -> list[PlayerProfile]:
        with self._lock:
            profiles = []
            for path in sorted(self.root.glob("*.json")):
                try:
                    profiles.append(PlayerProfile.model_validate_json(path.read_text(encoding="utf-8")))
                except (ValueError, OSError):
                    continue
            return profiles

    def create(self, name: str) -> PlayerProfile:
        with self._lock:
            profile = PlayerProfile(
                id=f"{_slug(name)}-{uuid.uuid4().hex[:8]}",
                name=name.strip(),
                created_at=_utc_now(),
            )
            self.save(profile)
            return profile

    def get(self, profile_id: str) -> PlayerProfile:
        path = self._path(profile_id)
        if not path.exists():
            raise KeyError(profile_id)
        return PlayerProfile.model_validate_json(path.read_text(encoding="utf-8"))

    def save(self, profile: PlayerProfile) -> None:
        with self._lock:
            path = self._path(profile.id)
            temp = path.with_suffix(".tmp")
            temp.write_text(profile.model_dump_json(indent=2), encoding="utf-8")
            temp.replace(path)

    def add_session(self, profile_id: str, session: dict[str, Any]) -> PlayerProfile:
        with self._lock:
            profile = self.get(profile_id)
            profile.sessions.append(session)
            profile.aggregate = aggregate_sessions(profile.sessions)
            self.save(profile)
            return profile

    def _path(self, profile_id: str) -> Path:
        safe_id = _slug(profile_id)
        if safe_id != profile_id:
            raise ValueError("invalid profile id")
        return self.root / f"{safe_id}.json"


def aggregate_sessions(sessions: list[dict[str, Any]]) -> dict[str, float]:
    """Combine session-level values so a new day never overwrites old calibration.

    Each accepted session contributes one value per feature. The center is a
    median/MAD-based robust mean, so one badly framed day cannot dominate merely
    because it contained more video frames.
    """

    by_feature: dict[str, list[float]] = {}
    quality_values: list[float] = []
    for session in sessions:
        if session.get("quality", 0.0) < 0.35:
            continue
        quality_values.append(float(session["quality"]))
        for key, value in session.get("features", {}).items():
            if isinstance(value, (int, float)):
                by_feature.setdefault(key, []).append(float(value))
    result = {key: robust_center(values) for key, values in by_feature.items() if values}
    result["session_count"] = float(len(quality_values))
    if quality_values:
        result["calibration_quality"] = sum(quality_values) / len(quality_values)
    return result


@dataclass
class CalibrationRecorder:
    profile_store: ProfileStore
    profile_id: str | None = None
    active_stage: str | None = None
    samples: dict[str, list[dict[str, float]]] = field(default_factory=dict)
    rejected_parts: dict[str, dict[str, int]] = field(default_factory=dict)
    rejected_actions: dict[str, dict[str, int]] = field(default_factory=dict)
    last_guidance: dict[str, str | None] = field(default_factory=dict)
    last_observation_monotonic: dict[str, float] = field(default_factory=dict)
    started_at: str | None = None
    _lock: threading.RLock = field(default_factory=threading.RLock)

    def start(self, profile_id: str) -> dict[str, Any]:
        self.profile_store.get(profile_id)
        with self._lock:
            self.profile_id = profile_id
            self.active_stage = None
            self.samples = {stage: [] for stage in STAGES}
            self.rejected_parts = {stage: {} for stage in STAGES}
            self.rejected_actions = {stage: {} for stage in STAGES}
            self.last_guidance = {stage: None for stage in STAGES}
            self.last_observation_monotonic = {stage: 0.0 for stage in STAGES}
            self.started_at = _utc_now()
            return self.status()

    def set_stage(self, stage: str, reset: bool = False) -> dict[str, Any]:
        if stage not in STAGES:
            raise ValueError(f"unknown calibration stage: {stage}")
        with self._lock:
            if not self.profile_id:
                raise RuntimeError("calibration has not started")
            if reset:
                self.samples[stage] = []
                self.rejected_parts[stage] = {}
                self.rejected_actions[stage] = {}
                self.last_guidance[stage] = None
            self.last_observation_monotonic[stage] = time.monotonic()
            self.active_stage = stage
            return self.status()

    def add_frame(self, frame: PoseFrame) -> bool:
        with self._lock:
            if not self.active_stage or not self.profile_id:
                return False
            self.last_observation_monotonic[self.active_stage] = time.monotonic()
            issues = calibration_visibility_issues(frame)
            if issues:
                rejected = self.rejected_parts[self.active_stage]
                for issue in issues:
                    rejected[issue] = rejected.get(issue, 0) + 1
                self.last_guidance[self.active_stage] = "请调整镜头或站位，确保" + "、".join(issues) + "清晰进入画面"
                return False
            features = extract_pose_features(frame)
            if features is None:
                return False
            action_issue = self._action_issue(self.active_stage, features)
            if action_issue:
                rejected = self.rejected_actions[self.active_stage]
                rejected[action_issue] = rejected.get(action_issue, 0) + 1
                self.last_guidance[self.active_stage] = action_issue
                return False
            self.samples[self.active_stage].append(features)
            self.last_guidance[self.active_stage] = None
            return True

    def _action_issue(self, stage: str, features: dict[str, float]) -> str | None:
        if stage == "arms_up":
            low = []
            if features["left_wrist_above_nose"] <= 0.05:
                low.append("左手")
            if features["right_wrist_above_nose"] <= 0.05:
                low.append("右手")
            return "、".join(low) + "还没有举过头顶" if low else None
        if stage == "t_pose":
            if features["left_wrist_extent"] < 0.9 or features["right_wrist_extent"] < 0.9:
                return "请把双臂继续向两侧伸直"
            if features["left_wrist_shoulder_y"] > 0.55 or features["right_wrist_shoulder_y"] > 0.55:
                return "请把双手腕调整到肩膀高度"
            return None
        if stage == "squat":
            neutral = self.samples.get("neutral", [])
            if len(neutral) < MIN_STAGE_SAMPLES:
                return "请先完成自然站立基准"
            drop = _stage_center(neutral, "hip_floor_ratio") - features["hip_floor_ratio"]
            return "下蹲还不够，请让髋部继续降低" if drop < 0.06 else None
        if stage == "lean_sides":
            neutral = self.samples.get("neutral", [])
            if len(neutral) < MIN_STAGE_SAMPLES:
                return "请先完成自然站立基准"
            center = _stage_center(neutral, "torso_lean")
            left_count, right_count = lean_side_counts(self.samples.get(stage, []), center)
            value = features["torso_lean"]
            per_side = MIN_STAGE_SAMPLES // 2
            if value <= center - 0.04 and left_count < per_side:
                return None
            if value >= center + 0.04 and right_count < per_side:
                return None
            if left_count < per_side:
                return "请向左侧倾斜并保持"
            if right_count < per_side:
                return "请向右侧倾斜并保持"
            return None
        return None

    def finish(self) -> PlayerProfile:
        with self._lock:
            if not self.profile_id:
                raise RuntimeError("calibration has not started")
            session = build_session(self.samples, self.started_at or _utc_now())
            profile = self.profile_store.add_session(self.profile_id, session)
            self.active_stage = None
            self.profile_id = None
            self.started_at = None
            return profile

    def cancel(self) -> None:
        with self._lock:
            self.active_stage = None
            self.profile_id = None
            self.samples = {}
            self.rejected_parts = {}
            self.rejected_actions = {}
            self.last_guidance = {}
            self.last_observation_monotonic = {}
            self.started_at = None

    def report(self, stage: str) -> dict[str, Any]:
        if stage not in STAGES:
            raise ValueError(f"unknown calibration stage: {stage}")
        with self._lock:
            if not self.profile_id:
                raise RuntimeError("calibration has not started")
            report = build_stage_report(stage, self.samples, self.rejected_parts)
            report["rejected_actions"] = self.rejected_actions.get(stage, {})
            report["guidance"] = self._guidance(stage, report)
            return report

    def _guidance(self, stage: str, report: dict[str, Any]) -> str:
        if report["valid"]:
            return "本段已完成，正在进入下一段"
        last_observation = self.last_observation_monotonic.get(stage, 0.0)
        if not last_observation or time.monotonic() - last_observation > 1.0:
            return "当前没有检测到完整人体，请让头、双手、膝盖和脚踝全部进入画面"
        if stage == "lean_sides" and len(self.samples.get("neutral", [])) >= MIN_STAGE_SAMPLES:
            center = _stage_center(self.samples["neutral"], "torso_lean")
            left_count, right_count = lean_side_counts(self.samples.get(stage, []), center)
            per_side = MIN_STAGE_SAMPLES // 2
            if left_count < per_side:
                return f"请向左侧倾斜并保持（{left_count}/{per_side}）"
            if right_count < per_side:
                return f"请向右侧倾斜并保持（{right_count}/{per_side}）"
        return self.last_guidance.get(stage) or STAGE_HOLD_GUIDANCE[stage]

    def status(self) -> dict[str, Any]:
        return {
            "active": bool(self.profile_id),
            "profile_id": self.profile_id,
            "stage": self.active_stage,
            "counts": {key: len(value) for key, value in self.samples.items()},
            "reports": {
                stage: build_stage_report(stage, self.samples, self.rejected_parts)
                for stage in self.samples
            },
            "started_at": self.started_at,
        }


def _stage_center(samples: list[dict[str, float]], key: str) -> float:
    return robust_center(sample[key] for sample in samples)


def lean_side_counts(samples: list[dict[str, float]], center: float) -> tuple[int, int]:
    left = sum(sample["torso_lean"] <= center - 0.04 for sample in samples)
    right = sum(sample["torso_lean"] >= center + 0.04 for sample in samples)
    return left, right


def build_stage_report(
    stage: str,
    samples: dict[str, list[dict[str, float]]],
    rejected_parts: dict[str, dict[str, int]] | None = None,
) -> dict[str, Any]:
    stage_samples = samples.get(stage, [])
    sample_count = len(stage_samples)
    issues: list[str] = []
    rejected = (rejected_parts or {}).get(stage, {})
    if sample_count < MIN_STAGE_SAMPLES:
        issues.append(f"有效全身画面只有 {sample_count}/{MIN_STAGE_SAMPLES} 帧")
        if rejected:
            frequent = sorted(rejected.items(), key=lambda item: item[1], reverse=True)
            issues.append("经常看不清或出框：" + "、".join(name for name, _ in frequent[:3]))
        else:
            issues.append("没有持续检测到完整人体，请确认头、双手、膝盖和脚踝都在画面内")
    else:
        if stage == "arms_up":
            left = _stage_center(stage_samples, "left_wrist_above_nose")
            right = _stage_center(stage_samples, "right_wrist_above_nose")
            if left <= 0.05 or right <= 0.05:
                sides = []
                if left <= 0.05:
                    sides.append("左手")
                if right <= 0.05:
                    sides.append("右手")
                issues.append("、".join(sides) + "没有稳定举过头顶")
        elif stage == "t_pose":
            left_extent = _stage_center(stage_samples, "left_wrist_extent")
            right_extent = _stage_center(stage_samples, "right_wrist_extent")
            left_level = _stage_center(stage_samples, "left_wrist_shoulder_y")
            right_level = _stage_center(stage_samples, "right_wrist_shoulder_y")
            if left_extent < 0.9 or right_extent < 0.9:
                issues.append("双臂横向伸展幅度不足")
            if left_level > 0.55 or right_level > 0.55:
                issues.append("手腕没有稳定保持在肩膀高度")
        elif stage == "squat":
            neutral = samples.get("neutral", [])
            if len(neutral) < MIN_STAGE_SAMPLES:
                issues.append("缺少合格的自然站立基准")
            else:
                drop = _stage_center(neutral, "hip_floor_ratio") - _stage_center(stage_samples, "hip_floor_ratio")
                if drop < 0.06:
                    issues.append("下蹲幅度不足，请让髋部明显降低并保持")
        elif stage == "lean_sides":
            neutral = samples.get("neutral", [])
            if len(neutral) < MIN_STAGE_SAMPLES:
                issues.append("缺少合格的自然站立基准")
            else:
                center = _stage_center(neutral, "torso_lean")
                lean_values = [sample["torso_lean"] for sample in stage_samples]
                if center - percentile(lean_values, 0.1) < 0.04:
                    issues.append("一个方向的侧倾幅度不足")
                if percentile(lean_values, 0.9) - center < 0.04:
                    issues.append("另一个方向的侧倾幅度不足")
    valid = not issues
    return {
        "stage": stage,
        "title": STAGE_TITLES[stage],
        "valid": valid,
        "sample_count": sample_count,
        "required_samples": MIN_STAGE_SAMPLES,
        "issues": issues,
        "message": "本段通过" if valid else "；".join(issues),
        "rejected_parts": rejected,
    }


def build_session(samples: dict[str, list[dict[str, float]]], started_at: str) -> dict[str, Any]:
    failed = [build_stage_report(stage, samples) for stage in STAGES]
    failed = [report for report in failed if not report["valid"]]
    if failed:
        details = "；".join(f'{report["title"]}：{report["message"]}' for report in failed)
        raise ValueError(f"校准未通过：{details}")

    neutral = samples["neutral"]
    arms = samples["arms_up"]
    t_pose = samples["t_pose"]
    squat = samples["squat"]
    lean = samples["lean_sides"]

    lean_values = [sample["torso_lean"] for sample in lean]
    features = {
        "neutral_shoulder_width": _stage_center(neutral, "shoulder_width"),
        "neutral_torso_length": _stage_center(neutral, "torso_length"),
        "neutral_standing_height": _stage_center(neutral, "standing_height"),
        "neutral_center_x": _stage_center(neutral, "center_x"),
        "neutral_hip_y": _stage_center(neutral, "hip_y"),
        "neutral_hip_floor_ratio": _stage_center(neutral, "hip_floor_ratio"),
        "arms_up_left": _stage_center(arms, "left_wrist_above_nose"),
        "arms_up_right": _stage_center(arms, "right_wrist_above_nose"),
        "tpose_left_extent": _stage_center(t_pose, "left_wrist_extent"),
        "tpose_right_extent": _stage_center(t_pose, "right_wrist_extent"),
        "squat_hip_floor_ratio": _stage_center(squat, "hip_floor_ratio"),
        "lean_left_limit": percentile(lean_values, 0.1),
        "lean_right_limit": percentile(lean_values, 0.9),
    }
    counts = {stage: len(stage_samples) for stage, stage_samples in samples.items()}
    coverage = min(1.0, min(counts.values()) / 30)
    pose_separation = min(
        1.0,
        abs(features["neutral_hip_floor_ratio"] - features["squat_hip_floor_ratio"]) / 0.12,
    )
    lean_separation = min(
        1.0,
        (features["lean_right_limit"] - features["lean_left_limit"]) / 0.35,
    )
    quality = round(0.5 * coverage + 0.25 * pose_separation + 0.25 * lean_separation, 4)
    return {
        "id": uuid.uuid4().hex,
        "recorded_at": _utc_now(),
        "started_at": started_at,
        "quality": quality,
        "sample_counts": counts,
        "features": features,
    }


def export_profile(profile: PlayerProfile) -> str:
    return json.dumps(profile.model_dump(), ensure_ascii=False, indent=2)
