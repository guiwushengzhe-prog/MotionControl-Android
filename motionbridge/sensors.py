from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any

from .models import SensorFrame


Quaternion = tuple[float, float, float, float]


def normalize_quaternion(value: Quaternion) -> Quaternion:
    length = math.sqrt(sum(item * item for item in value)) or 1.0
    return tuple(item / length for item in value)  # type: ignore[return-value]


def inverse_quaternion(value: Quaternion) -> Quaternion:
    x, y, z, w = normalize_quaternion(value)
    return -x, -y, -z, w


def multiply_quaternion(a: Quaternion, b: Quaternion) -> Quaternion:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return normalize_quaternion((
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ))


def relative_quaternion(baseline: Quaternion, current: Quaternion) -> Quaternion:
    return multiply_quaternion(inverse_quaternion(baseline), normalize_quaternion(current))


def quaternion_euler(value: Quaternion) -> tuple[float, float, float]:
    x, y, z, w = normalize_quaternion(value)
    roll = math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
    pitch = math.asin(max(-1.0, min(1.0, 2 * (w * y - z * x))))
    yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    return roll, pitch, yaw


@dataclass
class SensorSlot:
    device_id: str | None = None
    centered: bool = False
    baseline: Quaternion | None = None
    relative: Quaternion = (0.0, 0.0, 0.0, 1.0)
    last_seen: float = 0.0
    frame_count: int = 0
    fps: float = 0.0
    fps_started: float = field(default_factory=time.monotonic)
    fps_count: int = 0
    signals: dict[str, Any] = field(default_factory=dict)
    motion: dict[str, float] = field(default_factory=dict)
    stale_released: bool = True


class HandheldManager:
    timeout = 0.3

    def __init__(self) -> None:
        self.slots = [SensorSlot(), SensorSlot()]

    def bind(self, device_id: str, slot: int) -> None:
        if slot not in (0, 1):
            raise ValueError("玩家槽位无效")
        for index, item in enumerate(self.slots):
            if item.device_id == device_id and index != slot:
                raise ValueError("这台手持手机已绑定其他玩家")
        current = self.slots[slot]
        if current.device_id and current.device_id != device_id:
            raise ValueError("该玩家已经绑定另一台手持手机")
        if current.device_id != device_id:
            self.slots[slot] = SensorSlot(device_id=device_id)

    def unbind(self, slot: int) -> None:
        self.slots[slot] = SensorSlot()

    def request_center(self, slot: int) -> None:
        item = self.slots[slot]
        item.centered = False
        item.baseline = None

    def ingest(self, frame: SensorFrame, now: float | None = None) -> dict[str, Any]:
        current = now if now is not None else time.monotonic()
        slot = frame.player_slot
        self.bind(frame.device_id, slot)
        item = self.slots[slot]
        was_stale = not item.last_seen or current - item.last_seen > self.timeout
        if was_stale and item.last_seen:
            item.centered = False
            item.baseline = None
            item.fps = 0.0
            item.fps_count = 0
            item.fps_started = current
        item.last_seen = current
        item.stale_released = False
        item.frame_count += 1
        item.fps_count += 1
        elapsed = current - item.fps_started
        if elapsed >= 1.0:
            item.fps = item.fps_count / elapsed
            item.fps_count = 0
            item.fps_started = current

        raw = tuple(float(frame.quaternion.get(key, default)) for key, default in zip(("x", "y", "z", "w"), (0, 0, 0, 1)))
        quaternion = normalize_quaternion(raw)  # type: ignore[arg-type]
        if frame.recenter:
            item.baseline = quaternion
            item.centered = True
        if item.centered and item.baseline:
            item.relative = relative_quaternion(item.baseline, quaternion)
        roll, pitch, yaw = quaternion_euler(item.relative)
        rotation = frame.rotation_rate
        acceleration = frame.acceleration
        item.motion = {
            "gyro_x": float(rotation.get("x", 0.0)),
            "gyro_y": float(rotation.get("y", 0.0)),
            "gyro_z": float(rotation.get("z", 0.0)),
            "accel_x": float(acceleration.get("x", 0.0)),
            "accel_y": float(acceleration.get("y", 0.0)),
            "accel_z": float(acceleration.get("z", 1.0)),
            "handheld_orientation_x": max(-1.0, min(1.0, yaw / 1.2)),
            "handheld_orientation_y": max(-1.0, min(1.0, pitch / 1.0)),
            "handheld_rotation": max(-1.0, min(1.0, roll / 1.2)),
            "handheld_swing": max(-1.0, min(1.0, math.sqrt(sum(float(rotation.get(k, 0.0)) ** 2 for k in ("x", "y", "z"))) / 8.0)),
        }
        signals: dict[str, Any] = {"handheld_stick_x": 0.0, "handheld_stick_y": 0.0}
        for name in ("a", "b", "x", "y", "l", "r", "zl", "zr", "start", "select"):
            signals[f"handheld_{name}"] = False
        for touch in frame.touches:
            control = str(touch.get("control", "")).lower()
            if control == "stick":
                signals["handheld_stick_x"] = float(touch.get("x", 0.0))
                signals["handheld_stick_y"] = float(touch.get("y", 0.0))
            elif control in {"a", "b", "x", "y", "l", "r", "zl", "zr", "start", "select"}:
                signals[f"handheld_{control}"] = bool(touch.get("pressed", touch.get("value", 0)))
        if item.centered:
            signals.update(item.motion)
        item.signals = signals
        return dict(signals)

    def watchdog(self, slot: int, now: float | None = None) -> bool:
        current = now if now is not None else time.monotonic()
        item = self.slots[slot]
        if not item.last_seen or current - item.last_seen <= self.timeout or item.stale_released:
            return False
        item.signals.clear()
        item.motion.clear()
        item.centered = False
        item.baseline = None
        item.stale_released = True
        return True

    def signals(self, slot: int, now: float | None = None) -> dict[str, Any]:
        current = now if now is not None else time.monotonic()
        item = self.slots[slot]
        return dict(item.signals) if item.last_seen and current - item.last_seen <= self.timeout else {}

    def status(self, slot: int, now: float | None = None) -> dict[str, Any]:
        current = now if now is not None else time.monotonic()
        item = self.slots[slot]
        connected = bool(item.device_id and item.last_seen and current - item.last_seen <= self.timeout)
        return {
            "sensor_device_id": item.device_id,
            "sensor_connected": connected,
            "sensor_centered": connected and item.centered,
            "sensor_fps": round(item.fps, 1) if connected else 0.0,
        }
