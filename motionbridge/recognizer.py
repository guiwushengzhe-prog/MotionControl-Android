from __future__ import annotations

import math
import time  # Kept as a replay-clock compatibility seam for recorded sessions.
from dataclasses import dataclass, field
from typing import Any

from .geometry import clamp, extract_pose_features, hand_signals
from .models import PoseFrame


DEFAULT_CALIBRATION = {
    "neutral_shoulder_width": 0.20,
    "neutral_torso_length": 0.24,
    "neutral_center_x": 0.50,
    "neutral_hip_y": 0.58,
    "neutral_hip_floor_ratio": 0.48,
    "arms_up_left": 0.45,
    "arms_up_right": 0.45,
    "tpose_left_extent": 1.45,
    "tpose_right_extent": 1.45,
    "squat_hip_floor_ratio": 0.31,
    "lean_left_limit": -0.32,
    "lean_right_limit": 0.32,
}


DEFAULT_RECOGNIZER_PARAMETERS = {
    "squat_trigger": 0.58,
    "squat_release": 0.34,
    "jump_ready": 0.18,
    "jump_trigger": 0.62,
    "jump_release": 0.20,
    "jump_cooldown_s": 0.45,
    "fist_trigger": 0.62,
    "fist_release": 0.42,
    "pinch_trigger": 0.58,
    "pinch_release": 0.36,
    "hand_enter_s": 0.16,
    "hand_release_s": 0.20,
    "body_enter_s": 0.12,
    "body_release_s": 0.16,
    "fist_blocks_pinch": True,
}


@dataclass
class OneEuroValue:
    value: float | None = None
    derivative: float = 0.0

    def update(self, value: float, dt: float, min_cutoff: float = 1.1, beta: float = 0.018, d_cutoff: float = 1.0) -> float:
        if self.value is None:
            self.value = value
            return value
        dt = max(1 / 120, min(0.2, dt))
        derivative = (value - self.value) / dt
        d_alpha = self._alpha(dt, d_cutoff)
        self.derivative += d_alpha * (derivative - self.derivative)
        cutoff = min_cutoff + beta * abs(self.derivative)
        alpha = self._alpha(dt, cutoff)
        self.value += alpha * (value - self.value)
        return self.value

    @staticmethod
    def _alpha(dt: float, cutoff: float) -> float:
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)


@dataclass
class MotionRecognizer:
    calibration: dict[str, float] = field(default_factory=lambda: DEFAULT_CALIBRATION.copy())
    parameters: dict[str, Any] = field(default_factory=lambda: DEFAULT_RECOGNIZER_PARAMETERS.copy())
    filters: dict[str, OneEuroValue] = field(default_factory=dict)
    previous_time: float | None = None
    previous_roll: float = 0.0
    previous_pitch: float = 0.0
    previous_center: tuple[float, float] | None = None
    previous_velocity: tuple[float, float] = (0.0, 0.0)
    digital_state: dict[str, bool] = field(default_factory=dict)
    action_phase: dict[str, str] = field(default_factory=dict)
    action_cooldown_until: dict[str, float] = field(default_factory=dict)
    event_hold_until: dict[str, float] = field(default_factory=dict)
    stable_state: dict[str, bool] = field(default_factory=dict)
    stable_candidate: dict[str, bool] = field(default_factory=dict)
    stable_since: dict[str, float] = field(default_factory=dict)
    last_raw_signals: dict[str, Any] = field(default_factory=dict)

    def set_calibration(self, calibration: dict[str, float]) -> None:
        self.calibration = {**DEFAULT_CALIBRATION, **calibration}
        self.reset()

    def set_parameters(self, parameters: dict[str, Any] | None = None) -> None:
        """Apply an isolated rule configuration without changing player calibration."""
        self.parameters = {**DEFAULT_RECOGNIZER_PARAMETERS, **(parameters or {})}
        self.reset()

    def reset(self) -> None:
        self.filters.clear()
        self.previous_time = None
        self.previous_center = None
        self.previous_velocity = (0.0, 0.0)
        self.digital_state.clear()
        self.action_phase.clear()
        self.action_cooldown_until.clear()
        self.event_hold_until.clear()
        self.stable_state.clear()
        self.stable_candidate.clear()
        self.stable_since.clear()
        self.last_raw_signals.clear()

    def process(self, frame: PoseFrame) -> dict[str, Any]:
        raw = extract_pose_features(frame)
        if raw is None:
            self.last_raw_signals = {"pose_visible": False}
            return {"pose_visible": False}
        timestamp = frame.captured_at_ms / 1000.0
        values = self._smooth(raw, timestamp)
        cal = self.calibration
        shoulder_width = max(cal["neutral_shoulder_width"], 1e-4)
        torso = max(cal["neutral_torso_length"], 1e-4)

        left_up_threshold = max(0.18, cal["arms_up_left"] * 0.48)
        right_up_threshold = max(0.18, cal["arms_up_right"] * 0.48)
        left_hand_up = values["left_wrist_above_nose"] > left_up_threshold
        right_hand_up = values["right_wrist_above_nose"] > right_up_threshold

        squat_midpoint = (
            cal["neutral_hip_floor_ratio"] + cal["squat_hip_floor_ratio"]
        ) / 2
        crouch_range = max(
            0.08,
            cal["neutral_hip_floor_ratio"] - cal["squat_hip_floor_ratio"],
        )
        crouch_amount = clamp(
            (cal["neutral_hip_floor_ratio"] - values["hip_floor_ratio"]) / crouch_range,
            0.0,
            1.0,
        )
        squat_score = crouch_amount
        params = self.parameters
        squat = self._hysteresis(
            "squat", squat_score,
            float(params["squat_trigger"]), float(params["squat_release"]),
        )

        lean = values["torso_lean"]
        if lean < 0:
            lean_x = -clamp(lean / min(cal["lean_left_limit"], -0.12), 0.0, 1.0)
        else:
            lean_x = clamp(lean / max(cal["lean_right_limit"], 0.12), 0.0, 1.0)
        move_x = clamp(
            (values["center_x"] - cal["neutral_center_x"]) / (shoulder_width * 1.35)
        )
        jump_amount = clamp(
            (cal["neutral_hip_y"] - values["hip_y"]) / max(torso * 0.42, 1e-4),
            0.0,
            1.0,
        )

        t_pose = (
            values["left_wrist_extent"] > max(0.85, cal["tpose_left_extent"] * 0.62)
            and values["right_wrist_extent"] > max(0.85, cal["tpose_right_extent"] * 0.62)
            and values["left_wrist_shoulder_y"] < 0.72
            and values["right_wrist_shoulder_y"] < 0.72
        )

        motion = self._motion(values, timestamp)
        # Captured time makes a recorded real landmark stream deterministic when replayed.
        now = timestamp
        jump_event = self._event(
            "jump", jump_amount,
            float(params["jump_ready"]), float(params["jump_trigger"]),
            float(params["jump_release"]), float(params["jump_cooldown_s"]), now,
        )
        left_punch_event = self._event("left_punch", values["left_wrist_forward"], 0.38, 1.0, 0.42, 0.34, now)
        right_punch_event = self._event("right_punch", values["right_wrist_forward"], 0.38, 1.0, 0.42, 0.34, now)
        left_kick_event = self._event("left_kick", values["left_ankle_lift"], 0.12, 0.48, 0.16, 0.5, now)
        right_kick_event = self._event("right_kick", values["right_ankle_lift"], 0.12, 0.48, 0.16, 0.5, now)
        if squat:
            jump_event = False
        if jump_event:
            squat = False
        signals: dict[str, Any] = {
            "pose_visible": True,
            "left_hand_up": left_hand_up,
            "right_hand_up": right_hand_up,
            "both_hands_up": left_hand_up and right_hand_up,
            "t_pose": t_pose,
            "squat": squat,
            "jump": jump_event,
            "lean_left": lean_x < -0.52,
            "lean_right": lean_x > 0.52,
            "move_left": move_x < -0.55 and move_x <= 0,
            "move_right": move_x > 0.55 and move_x >= 0,
            "clap": values["wrists_distance"] < 0.38,
            "left_punch": left_punch_event,
            "right_punch": right_punch_event,
            "left_kick": left_kick_event,
            "right_kick": right_kick_event,
            "lean_x": lean_x,
            "move_x": move_x,
            "vertical_move": clamp(crouch_amount - jump_amount),
            "crouch_amount": crouch_amount,
            "jump_amount": jump_amount,
            "torso_roll": motion["roll"],
            "torso_pitch": motion["pitch"],
            "gyro_x": motion["gyro_x"],
            "gyro_y": motion["gyro_y"],
            "gyro_z": motion["gyro_z"],
            "accel_x": motion["accel_x"],
            "accel_y": motion["accel_y"],
            "accel_z": 1.0,
        }
        hand_values = hand_signals(frame)
        raw_hand_values = dict(hand_values)
        for prefix in ("left", "right"):
            gesture_score = max((hand.gesture_score for hand in frame.hands if hand.handedness.lower() == prefix and hand.gesture == "Closed_Fist"), default=0.0)
            fist_score = max(float(hand_values.get(f"{prefix}_fist_score", 0.0)), gesture_score)
            fist = self._hysteresis(
                f"{prefix}_fist_raw", fist_score,
                float(params["fist_trigger"]), float(params["fist_release"]),
            )
            pinch_amount = float(hand_values.get(f"{prefix}_pinch_amount", 0.0))
            if fist and bool(params["fist_blocks_pinch"]):
                self.digital_state[f"{prefix}_pinch_raw"] = False
                pinch = False
            else:
                pinch = self._hysteresis(
                    f"{prefix}_pinch_raw", pinch_amount,
                    float(params["pinch_trigger"]), float(params["pinch_release"]),
                )
            hand_values[f"{prefix}_fist"] = fist
            hand_values[f"{prefix}_pinch"] = pinch
            hand_values[f"{prefix}_pinch_amount"] = 0.0 if fist else pinch_amount
            hand_values.pop(f"{prefix}_fist_score", None)
        signals.update(hand_values)
        self.last_raw_signals = {
            "pose_visible": True,
            **{key: float(value) for key, value in raw.items()},
            **raw_hand_values,
            "squat_score": squat_score,
            "jump_score": jump_amount,
        }
        return self._stabilize_booleans(signals, now)

    def _smooth(self, raw: dict[str, float], timestamp: float) -> dict[str, float]:
        dt = 1 / 30 if self.previous_time is None else max(1 / 120, min(0.2, timestamp - self.previous_time))
        result: dict[str, float] = {}
        for key, value in raw.items():
            result[key] = self.filters.setdefault(key, OneEuroValue()).update(value, dt)
        return result

    def _hysteresis(self, name: str, value: float, trigger: float, release: float) -> bool:
        active = self.digital_state.get(name, False)
        active = value >= (release if active else trigger)
        self.digital_state[name] = active
        return active

    def _event(
        self, name: str, value: float, ready: float, trigger: float, release: float,
        cooldown: float, now: float,
    ) -> bool:
        phase = self.action_phase.get(name, "neutral")
        if phase == "cooldown" and now >= self.action_cooldown_until.get(name, 0.0) and value <= release:
            phase = "neutral"
        if phase == "neutral" and value <= ready:
            phase = "ready"
        fired = phase == "ready" and value >= trigger and now >= self.action_cooldown_until.get(name, 0.0)
        if fired:
            phase = "cooldown"
            self.action_cooldown_until[name] = now + cooldown
            self.event_hold_until[name] = now + 0.24
        self.action_phase[name] = phase
        return fired or now < self.event_hold_until.get(name, 0.0)

    def _stabilize_booleans(self, signals: dict[str, Any], now: float) -> dict[str, Any]:
        result = dict(signals)
        for name, value in signals.items():
            if name == "pose_visible" or not isinstance(value, bool):
                continue
            candidate = bool(value)
            if self.stable_candidate.get(name) != candidate:
                self.stable_candidate[name] = candidate
                self.stable_since[name] = now
            stable = self.stable_state.get(name, False)
            is_hand = name.endswith(("_fist", "_pinch"))
            enter = float(self.parameters["hand_enter_s"] if is_hand else self.parameters["body_enter_s"])
            release = float(self.parameters["hand_release_s"] if is_hand else self.parameters["body_release_s"])
            if candidate != stable and now - self.stable_since.get(name, now) >= (enter if candidate else release):
                stable = candidate
                self.stable_state[name] = stable
            result[name] = stable
        return result

    def _motion(self, values: dict[str, float], timestamp: float) -> dict[str, float]:
        roll = values["shoulder_roll"]
        pitch = clamp(
            (self.calibration["neutral_hip_floor_ratio"] - values["hip_floor_ratio"]) * 2.5
        )
        if self.previous_time is None:
            dt = 1 / 30
        else:
            dt = max(1 / 120, min(0.2, timestamp - self.previous_time))
        gyro_x = (pitch - self.previous_pitch) / dt
        gyro_z = (roll - self.previous_roll) / dt
        center = (values["center_x"], values["hip_y"])
        if self.previous_center is None:
            velocity = (0.0, 0.0)
        else:
            velocity = (
                (center[0] - self.previous_center[0]) / dt,
                (center[1] - self.previous_center[1]) / dt,
            )
        accel_x = (velocity[0] - self.previous_velocity[0]) / dt
        accel_y = (velocity[1] - self.previous_velocity[1]) / dt
        self.previous_time = timestamp
        self.previous_roll = roll
        self.previous_pitch = pitch
        self.previous_center = center
        self.previous_velocity = velocity
        return {
            "roll": roll,
            "pitch": pitch,
            "gyro_x": clamp(gyro_x, -20.0, 20.0),
            "gyro_y": 0.0,
            "gyro_z": clamp(gyro_z, -20.0, 20.0),
            "accel_x": clamp(accel_x, -8.0, 8.0),
            "accel_y": clamp(accel_y, -8.0, 8.0),
        }
