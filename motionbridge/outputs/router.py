from __future__ import annotations

import threading
import time
from typing import Any

from .dsu import DSUServer
from .gamepad import GamepadOutput
from .keyboard import KeyboardOutput


class OutputRouter:
    def __init__(
        self, enable_dsu: bool = True, slot: int = 0,
        shared_dsu: DSUServer | None = None, keyboard_allowed: bool = True,
    ) -> None:
        self.keyboard = KeyboardOutput()
        self.gamepad = GamepadOutput()
        self.dsu = shared_dsu or DSUServer()
        self.slot = slot
        self.keyboard_allowed = keyboard_allowed
        self._owns_dsu = shared_dsu is None or slot == 0
        self.enabled = False
        self.shadow_mode = False
        self._pulse_deadlines: dict[tuple[str, str, str], float] = {}
        self._digital_owners: dict[tuple[str, str], set[str]] = {}
        self._owner_digital: dict[str, set[tuple[str, str]]] = {}
        self._axis_owners: dict[str, dict[str, tuple[int, int, float]]] = {}
        self._owner_axes: dict[str, set[str]] = {}
        self._axis_sequence = 0
        self._lock = threading.RLock()
        self._enable_dsu = enable_dsu

    def start(self) -> None:
        self.gamepad.start()
        if self._enable_dsu and self._owns_dsu:
            self.dsu.start()

    def set_enabled(self, enabled: bool) -> None:
        with self._lock:
            self.enabled = bool(enabled and not self.shadow_mode)
            if not self.enabled:
                self.release_all()

    def set_shadow_mode(self, active: bool) -> None:
        """Hardware-level output lock used by real-input algorithm experiments."""
        with self._lock:
            self.shadow_mode = bool(active)
            self.enabled = False
            self.release_all()

    def set_digital(
        self,
        kind: str,
        control: str,
        active: bool,
        mode: str = "hold",
        *,
        owner: str = "mapping",
    ) -> None:
        with self._lock:
            if not self.enabled or self.shadow_mode:
                return
            if mode == "pulse" and active:
                key = (owner, kind, control.upper())
                if key in self._pulse_deadlines:
                    return
                self._set_digital_owned(owner, kind, control, True)
                self._pulse_deadlines[key] = time.monotonic() + 0.11
            elif mode == "hold":
                self._set_digital_owned(owner, kind, control, active)

    def set_axis(self, control: str, value: float, *, owner: str = "mapping", priority: int = 0) -> None:
        with self._lock:
            if self.enabled and not self.shadow_mode:
                control = control.upper()
                self._axis_sequence += 1
                self._axis_owners.setdefault(control, {})[owner] = (
                    int(priority), self._axis_sequence, max(-1.0, min(1.0, float(value))),
                )
                self._owner_axes.setdefault(owner, set()).add(control)
                self._apply_axis_winner(control)

    def release_control(self, owner: str, kind: str, control: str) -> None:
        """Release one owner's claim without disturbing another input source."""
        with self._lock:
            control = control.upper()
            if kind == "gamepad_axis":
                owners = self._axis_owners.get(control)
                if owners:
                    owners.pop(owner, None)
                    if not owners:
                        self._axis_owners.pop(control, None)
                    self._apply_axis_winner(control)
                self._owner_axes.get(owner, set()).discard(control)
                if not self._owner_axes.get(owner):
                    self._owner_axes.pop(owner, None)
                return
            self._set_digital_owned(owner, kind, control, False)
            self._pulse_deadlines.pop((owner, kind, control), None)

    def release_owner(self, owner: str) -> None:
        """Cancel one mapping or macro and preserve controls held by other owners."""
        with self._lock:
            for kind, control in tuple(self._owner_digital.get(owner, set())):
                self._set_digital_owned(owner, kind, control, False)
            for control in tuple(self._owner_axes.get(owner, set())):
                owners = self._axis_owners.get(control)
                if owners:
                    owners.pop(owner, None)
                    if not owners:
                        self._axis_owners.pop(control, None)
                    self._apply_axis_winner(control)
            self._owner_axes.pop(owner, None)
            for key in [key for key in self._pulse_deadlines if key[0] == owner]:
                self._pulse_deadlines.pop(key, None)

    def update_motion(self, signals: dict[str, Any]) -> None:
        with self._lock:
            if not self.enabled or self.shadow_mode:
                return
            self.dsu.update(
                slot=self.slot,
                accel_x=float(signals.get("accel_x", 0.0)),
                accel_y=float(signals.get("accel_y", 0.0)),
                accel_z=float(signals.get("accel_z", 1.0)),
                gyro_pitch=float(signals.get("gyro_x", 0.0)),
                gyro_yaw=float(signals.get("gyro_y", 0.0)),
                gyro_roll=float(signals.get("gyro_z", 0.0)),
            )

    def tick(self) -> None:
        now = time.monotonic()
        with self._lock:
            due = [key for key, deadline in self._pulse_deadlines.items() if now >= deadline]
            for owner, kind, control in due:
                self._set_digital_owned(owner, kind, control, False)
                self._pulse_deadlines.pop((owner, kind, control), None)

    def release_all(self) -> None:
        self.keyboard.release_all()
        self.gamepad.release_all()
        self._pulse_deadlines.clear()
        self._digital_owners.clear()
        self._owner_digital.clear()
        self._axis_owners.clear()
        self._owner_axes.clear()

    def close(self) -> None:
        self.release_all()
        self.gamepad.close()
        if self._owns_dsu:
            self.dsu.stop()

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "shadow_mode": self.shadow_mode,
            "slot": self.slot,
            "keyboard": {"available": self.keyboard.available, "error": self.keyboard.last_error},
            "gamepad": {"available": self.gamepad.available, "error": self.gamepad.last_error},
            "dsu": {
                "available": self.dsu.available,
                "port": self.dsu.port,
                "clients": len(self.dsu.clients),
                "error": self.dsu.last_error,
            },
        }

    def _set_digital_owned(self, owner: str, kind: str, control: str, active: bool) -> None:
        control = control.upper()
        key = (kind, control)
        owners = self._digital_owners.setdefault(key, set())
        was_active = bool(owners)
        if active:
            if kind == "keyboard" and not self.keyboard_allowed:
                return
            owners.add(owner)
            self._owner_digital.setdefault(owner, set()).add(key)
        else:
            owners.discard(owner)
            self._owner_digital.get(owner, set()).discard(key)
            if not self._owner_digital.get(owner):
                self._owner_digital.pop(owner, None)
        is_active = bool(owners)
        if not owners:
            self._digital_owners.pop(key, None)
        if was_active != is_active:
            self._apply_digital(kind, control, is_active)

    def _apply_axis_winner(self, control: str) -> None:
        owners = self._axis_owners.get(control, {})
        value = max(owners.values(), key=lambda item: (item[0], item[1]))[2] if owners else 0.0
        self.gamepad.set_axis(control, value)

    def _apply_digital(self, kind: str, control: str, active: bool) -> None:
        if kind == "keyboard":
            if self.keyboard_allowed:
                self.keyboard.set_key(control, active)
        elif kind == "gamepad_button":
            self.gamepad.set_button(control, active)
