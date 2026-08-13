from __future__ import annotations

import math
from collections.abc import Iterable
from statistics import median
from typing import Any

from .models import Landmark, PoseFrame


NOSE = 0
LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12
LEFT_ELBOW = 13
RIGHT_ELBOW = 14
LEFT_WRIST = 15
RIGHT_WRIST = 16
LEFT_HIP = 23
RIGHT_HIP = 24
LEFT_KNEE = 25
RIGHT_KNEE = 26
LEFT_ANKLE = 27
RIGHT_ANKLE = 28


def midpoint(a: Landmark, b: Landmark) -> tuple[float, float, float]:
    return ((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)


def distance(a: Landmark, b: Landmark) -> float:
    return math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)


def distance2(a: Landmark, b: Landmark) -> float:
    return math.hypot(a.x - b.x, a.y - b.y)


def clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def percentile(values: Iterable[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("percentile requires at least one value")
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def robust_center(values: Iterable[float]) -> float:
    values = list(values)
    if not values:
        raise ValueError("robust_center requires at least one value")
    med = median(values)
    deviations = [abs(value - med) for value in values]
    mad = median(deviations)
    if mad <= 1e-9:
        return float(med)
    kept = [value for value in values if abs(value - med) <= 3.5 * mad]
    return float(sum(kept) / len(kept)) if kept else float(med)


def visible(frame: PoseFrame, indexes: Iterable[int], minimum: float = 0.55) -> bool:
    return all(frame.pose[index].visibility >= minimum for index in indexes)


def calibration_visibility_issues(frame: PoseFrame, minimum: float = 0.55) -> list[str]:
    groups = {
        "头部": [NOSE],
        "双肩": [LEFT_SHOULDER, RIGHT_SHOULDER],
        "双手腕": [LEFT_WRIST, RIGHT_WRIST],
        "髋部": [LEFT_HIP, RIGHT_HIP],
        "双膝": [LEFT_KNEE, RIGHT_KNEE],
        "双脚踝": [LEFT_ANKLE, RIGHT_ANKLE],
    }
    return [name for name, indexes in groups.items() if not visible(frame, indexes, minimum)]


def extract_pose_features(frame: PoseFrame) -> dict[str, float] | None:
    required = [
        NOSE,
        LEFT_SHOULDER,
        RIGHT_SHOULDER,
        LEFT_WRIST,
        RIGHT_WRIST,
        LEFT_HIP,
        RIGHT_HIP,
        LEFT_KNEE,
        RIGHT_KNEE,
        LEFT_ANKLE,
        RIGHT_ANKLE,
    ]
    if not visible(frame, required):
        return None

    p = frame.pose
    shoulder_mid = midpoint(p[LEFT_SHOULDER], p[RIGHT_SHOULDER])
    hip_mid = midpoint(p[LEFT_HIP], p[RIGHT_HIP])
    ankle_mid = midpoint(p[LEFT_ANKLE], p[RIGHT_ANKLE])
    shoulder_width = max(distance2(p[LEFT_SHOULDER], p[RIGHT_SHOULDER]), 1e-4)
    torso = max(math.hypot(shoulder_mid[0] - hip_mid[0], shoulder_mid[1] - hip_mid[1]), 1e-4)
    standing_height = max(ankle_mid[1] - p[NOSE].y, torso)
    center_x = (shoulder_mid[0] + hip_mid[0]) / 2
    hip_floor_ratio = (ankle_mid[1] - hip_mid[1]) / standing_height
    torso_lean = (shoulder_mid[0] - hip_mid[0]) / torso
    shoulder_roll = math.atan2(
        p[RIGHT_SHOULDER].y - p[LEFT_SHOULDER].y,
        p[RIGHT_SHOULDER].x - p[LEFT_SHOULDER].x,
    )
    shoulder_y = shoulder_mid[1]

    return {
        "shoulder_width": shoulder_width,
        "torso_length": torso,
        "standing_height": standing_height,
        "center_x": center_x,
        "hip_y": hip_mid[1],
        "hip_floor_ratio": hip_floor_ratio,
        "torso_lean": torso_lean,
        "shoulder_roll": shoulder_roll,
        "left_wrist_above_nose": (p[NOSE].y - p[LEFT_WRIST].y) / torso,
        "right_wrist_above_nose": (p[NOSE].y - p[RIGHT_WRIST].y) / torso,
        "left_wrist_extent": distance2(p[LEFT_WRIST], p[LEFT_SHOULDER]) / shoulder_width,
        "right_wrist_extent": distance2(p[RIGHT_WRIST], p[RIGHT_SHOULDER]) / shoulder_width,
        "left_wrist_shoulder_y": abs(p[LEFT_WRIST].y - shoulder_y) / shoulder_width,
        "right_wrist_shoulder_y": abs(p[RIGHT_WRIST].y - shoulder_y) / shoulder_width,
        "wrists_distance": distance2(p[LEFT_WRIST], p[RIGHT_WRIST]) / shoulder_width,
        "left_wrist_forward": (p[LEFT_SHOULDER].z - p[LEFT_WRIST].z) / shoulder_width,
        "right_wrist_forward": (p[RIGHT_SHOULDER].z - p[RIGHT_WRIST].z) / shoulder_width,
        "left_ankle_lift": (p[RIGHT_ANKLE].y - p[LEFT_ANKLE].y) / torso,
        "right_ankle_lift": (p[LEFT_ANKLE].y - p[RIGHT_ANKLE].y) / torso,
    }


def hand_signals(frame: PoseFrame) -> dict[str, bool | float]:
    result: dict[str, bool | float] = {
        "left_pinch": False,
        "right_pinch": False,
        "left_fist": False,
        "right_fist": False,
        "left_pinch_amount": 0.0,
        "right_pinch_amount": 0.0,
        "left_fist_score": 0.0,
        "right_fist_score": 0.0,
    }
    for hand in frame.hands:
        points = hand.landmarks
        hand_scale = max(distance(points[0], points[9]), 1e-4)
        pinch = distance(points[4], points[8]) / hand_scale
        folded = sum(distance(points[index], points[0]) for index in (8, 12, 16, 20)) / (4 * hand_scale)
        prefix = hand.handedness.lower()
        if prefix not in {"left", "right"}:
            continue
        result[f"{prefix}_pinch_amount"] = clamp(1.0 - pinch / 0.65, 0.0, 1.0)
        result[f"{prefix}_pinch"] = pinch < 0.42
        result[f"{prefix}_fist_score"] = clamp((1.9 - folded) / 0.65, 0.0, 1.0)
        result[f"{prefix}_fist"] = folded < 1.55
    return result


def serializable_signals(signals: dict[str, Any]) -> dict[str, Any]:
    return {
        key: list(value) if isinstance(value, tuple) else value
        for key, value in signals.items()
    }
