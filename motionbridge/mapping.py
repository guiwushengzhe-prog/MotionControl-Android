from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import Binding, MappingProfile, Target, VoiceSettings
from .outputs import OutputRouter
from .game_presets import GAME_MAPPINGS


def _voice() -> VoiceSettings:
    return VoiceSettings(phrases={
        "left": ["向左", "左"], "right": ["向右", "右"],
        "forward": ["向前", "前进"], "back": ["向后", "后退"],
        "forward_left": ["左前", "左前方"], "forward_right": ["右前", "右前方"],
        "back_left": ["左后", "左后方"], "back_right": ["右后", "右后方"],
        "stop": ["停止", "结束"], "emergency_stop": ["紧急停止"],
        "steer_left": ["左转"], "steer_right": ["右转"], "steer_center": ["回正"],
        "throttle_on": ["加速"], "throttle_off": ["松油"],
        "brake_on": ["刹车"], "brake_off": ["松刹"],
    })


DEFAULT_MAPPINGS = [
    MappingProfile(
        id="xbox-general-v2",
        name="通用 Xbox（语音 v2）",
        description="语音控制移动，身体控制跳跃、下蹲、拳、踢、握拳和捏合。",
        voice=_voice(),
        bindings=[
            Binding(id="voice-x", signal="voice_move_x", target=Target(kind="gamepad_axis", control="LX"), mode="analog", deadzone=0.05),
            Binding(id="voice-y", signal="voice_move_y", target=Target(kind="gamepad_axis", control="LY"), mode="analog", deadzone=0.05),
            Binding(id="a-jump", signal="jump", target=Target(kind="gamepad_button", control="A"), mode="pulse", threshold=0.65, release_threshold=0.25, cooldown_ms=450),
            Binding(id="b-squat", signal="squat", target=Target(kind="gamepad_button", control="B"), mode="hold"),
            Binding(id="x-right-punch", signal="right_punch", target=Target(kind="gamepad_button", control="X"), mode="pulse", release_threshold=0.2, cooldown_ms=350),
            Binding(id="y-left-punch", signal="left_punch", target=Target(kind="gamepad_button", control="Y"), mode="pulse", release_threshold=0.2, cooldown_ms=350),
            Binding(id="lb-left-fist", signal="left_fist", target=Target(kind="gamepad_button", control="LB"), mode="hold"),
            Binding(id="rb-right-fist", signal="right_fist", target=Target(kind="gamepad_button", control="RB"), mode="hold"),
            Binding(id="lt-left-pinch", signal="left_pinch_amount", target=Target(kind="gamepad_axis", control="LT"), mode="analog", deadzone=0.08),
            Binding(id="rt-right-pinch", signal="right_pinch_amount", target=Target(kind="gamepad_axis", control="RT"), mode="analog", deadzone=0.08),
            Binding(id="dpad-left", signal="left_kick", target=Target(kind="gamepad_button", control="DPAD_LEFT"), mode="pulse"),
            Binding(id="dpad-right", signal="right_kick", target=Target(kind="gamepad_button", control="DPAD_RIGHT"), mode="pulse"),
        ],
    ),
    MappingProfile(
        id="racing-default",
        name="赛车",
        description="语音转向、油门和刹车；适合无需持续喊话的状态控制。",
        voice=_voice(),
        bindings=[
            Binding(id="race-steer", signal="voice_steer", target=Target(kind="gamepad_axis", control="LX"), mode="analog", deadzone=0.05),
            Binding(id="race-throttle", signal="voice_throttle", target=Target(kind="gamepad_axis", control="RT"), mode="analog", deadzone=0.02),
            Binding(id="race-brake", signal="voice_brake", target=Target(kind="gamepad_axis", control="LT"), mode="analog", deadzone=0.02),
        ],
    ),
    MappingProfile(
        id="racing-handheld-v3", name="赛车（手持增强）",
        description="手持倾斜转向，触摸 ZR/ZL 控制油门与刹车。", voice=_voice(),
        bindings=[
            Binding(id="race-handheld-steer", signal="handheld_orientation_x", target=Target(kind="gamepad_axis", control="LX"), mode="analog", deadzone=0.08),
            Binding(id="race-handheld-throttle", signal="handheld_zr", target=Target(kind="gamepad_axis", control="RT"), mode="analog", deadzone=0.01),
            Binding(id="race-handheld-brake", signal="handheld_zl", target=Target(kind="gamepad_axis", control="LT"), mode="analog", deadzone=0.01),
        ],
    ),
    MappingProfile(
        id="fighting-default", name="格斗", description="语音前进、后退和停止；拳、踢、防御、下蹲控制按钮。", voice=_voice(),
        bindings=[
            Binding(id="fight-x", signal="voice_move_x", target=Target(kind="gamepad_axis", control="LX"), mode="analog"),
            Binding(id="fight-rp", signal="right_punch", target=Target(kind="gamepad_button", control="X"), mode="pulse"),
            Binding(id="fight-lp", signal="left_punch", target=Target(kind="gamepad_button", control="Y"), mode="pulse"),
            Binding(id="fight-rk", signal="right_kick", target=Target(kind="gamepad_button", control="A"), mode="pulse"),
            Binding(id="fight-lk", signal="left_kick", target=Target(kind="gamepad_button", control="B"), mode="pulse"),
            Binding(id="fight-guard", signal="both_hands_up", target=Target(kind="gamepad_button", control="RB"), mode="hold"),
            Binding(id="fight-squat", signal="squat", target=Target(kind="gamepad_button", control="LB"), mode="hold"),
        ],
    ),
    MappingProfile(
        id="platform-default", name="平台动作", description="语音方向，身体跳跃、下蹲和攻击。", voice=_voice(),
        bindings=[
            Binding(id="platform-x", signal="voice_move_x", target=Target(kind="gamepad_axis", control="LX"), mode="analog"),
            Binding(id="platform-y", signal="voice_move_y", target=Target(kind="gamepad_axis", control="LY"), mode="analog"),
            Binding(id="platform-jump", signal="jump", target=Target(kind="gamepad_button", control="A"), mode="pulse"),
            Binding(id="platform-squat", signal="squat", target=Target(kind="gamepad_button", control="B"), mode="hold"),
            Binding(id="platform-attack", signal="right_punch", target=Target(kind="gamepad_button", control="X"), mode="pulse"),
        ],
    ),
    MappingProfile(
        id="switch-emulator-v2",
        name="Switch 模拟器（双槽位 v2）",
        description="按钮走 Xbox 虚拟手柄，身体姿态同时输出到本机 DSU 26760 端口。",
        bindings=[
            Binding(id="switch-lx", signal="voice_move_x", target=Target(kind="gamepad_axis", control="LX"), mode="analog"),
            Binding(id="switch-ly", signal="voice_move_y", target=Target(kind="gamepad_axis", control="LY"), mode="analog"),
            Binding(id="switch-rx", signal="lean_x", target=Target(kind="gamepad_axis", control="RX"), mode="analog"),
            Binding(id="switch-a", signal="right_hand_up", target=Target(kind="gamepad_button", control="A"), mode="hold"),
            Binding(id="switch-b", signal="squat", target=Target(kind="gamepad_button", control="B"), mode="hold"),
            Binding(id="switch-x", signal="left_hand_up", target=Target(kind="gamepad_button", control="X"), mode="hold"),
            Binding(id="switch-y", signal="right_punch", target=Target(kind="gamepad_button", control="Y"), mode="pulse"),
            Binding(id="switch-l", signal="left_pinch", target=Target(kind="gamepad_button", control="LB"), mode="hold"),
            Binding(id="switch-r", signal="right_pinch", target=Target(kind="gamepad_button", control="RB"), mode="hold"),
            Binding(id="switch-zl", signal="left_pinch_amount", target=Target(kind="gamepad_axis", control="LT"), mode="analog"),
            Binding(id="switch-zr", signal="right_pinch_amount", target=Target(kind="gamepad_axis", control="RT"), mode="analog"),
            Binding(id="switch-motion", signal="torso_roll", target=Target(kind="dsu_motion", control="BODY"), mode="analog"),
        ],
        voice=_voice(),
    ),
    MappingProfile(
        id="switch-handheld-v3", name="Switch 模拟器（手持增强）",
        description="手持触摸按钮加真实手机 IMU 体感；摄像头继续负责身体动作。", voice=_voice(),
        bindings=[
            Binding(id="sh-lx", signal="handheld_stick_x", target=Target(kind="gamepad_axis", control="LX"), mode="analog"),
            Binding(id="sh-ly", signal="handheld_stick_y", target=Target(kind="gamepad_axis", control="LY"), mode="analog", invert=True),
            Binding(id="sh-a", signal="handheld_a", target=Target(kind="gamepad_button", control="A")),
            Binding(id="sh-b", signal="handheld_b", target=Target(kind="gamepad_button", control="B")),
            Binding(id="sh-x", signal="handheld_x", target=Target(kind="gamepad_button", control="X")),
            Binding(id="sh-y", signal="handheld_y", target=Target(kind="gamepad_button", control="Y")),
            Binding(id="sh-l", signal="handheld_l", target=Target(kind="gamepad_button", control="LB")),
            Binding(id="sh-r", signal="handheld_r", target=Target(kind="gamepad_button", control="RB")),
            Binding(id="sh-zl", signal="handheld_zl", target=Target(kind="gamepad_axis", control="LT"), mode="analog"),
            Binding(id="sh-zr", signal="handheld_zr", target=Target(kind="gamepad_axis", control="RT"), mode="analog"),
            Binding(id="sh-start", signal="handheld_start", target=Target(kind="gamepad_button", control="START")),
            Binding(id="sh-select", signal="handheld_select", target=Target(kind="gamepad_button", control="BACK")),
            Binding(id="sh-motion", signal="handheld_rotation", target=Target(kind="dsu_motion", control="BODY"), mode="analog"),
        ],
    ),
] + [mapping.model_copy(deep=True) for mapping in GAME_MAPPINGS]


class MappingStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.backup_root = self.root.parent / "backups"
        self._migrate_existing()
        self._install_defaults()
        self._repair_known_builtin_defects()

    def list(self) -> list[MappingProfile]:
        with self._lock:
            result = []
            for path in sorted(self.root.glob("*.json")):
                try:
                    result.append(self._load(path))
                except (OSError, ValueError):
                    continue
            return result

    def get(self, mapping_id: str) -> MappingProfile:
        path = self._path(mapping_id)
        if not path.exists():
            raise KeyError(mapping_id)
        return self._load(path)

    def save(self, mapping: MappingProfile) -> MappingProfile:
        with self._lock:
            self._validate_conflicts(mapping)
            mapping.updated_at = datetime.now(timezone.utc).isoformat()
            path = self._path(mapping.id)
            temp = path.with_suffix(".tmp")
            temp.write_text(mapping.model_dump_json(indent=2), encoding="utf-8")
            temp.replace(path)
            return mapping

    def create(self, name: str, source_id: str | None = None) -> MappingProfile:
        source = self.get(source_id).model_copy(deep=True) if source_id else MappingProfile(id="new", name=name)
        source.id = f"preset-{uuid.uuid4().hex[:12]}"
        source.name = name
        return self.save(source)

    def rename(self, mapping_id: str, name: str) -> MappingProfile:
        mapping = self.get(mapping_id)
        mapping.name = name
        return self.save(mapping)

    def delete(self, mapping_id: str) -> None:
        with self._lock:
            path = self._path(mapping_id)
            if not path.exists():
                raise KeyError(mapping_id)
            path.unlink()

    def import_payload(self, payload: dict[str, Any]) -> MappingProfile:
        mapping = self._from_raw(payload)
        if self._path(mapping.id).exists():
            mapping.id = f"{mapping.id}-import-{uuid.uuid4().hex[:6]}"
        return self.save(mapping)

    def _load(self, path: Path) -> MappingProfile:
        return self._from_raw(json.loads(path.read_text(encoding="utf-8")))

    def _from_raw(self, raw: dict[str, Any]) -> MappingProfile:
        migrated = dict(raw)
        migrated["version"] = 2
        for binding in migrated.get("bindings", []):
            binding.setdefault("release_threshold", max(0.0, float(binding.get("threshold", 0.5)) * 0.65))
            binding.setdefault("hold_ms", 0)
            binding.setdefault("cooldown_ms", 250)
        migrated.setdefault("voice", _voice().model_dump())
        return MappingProfile.model_validate(migrated)

    def _migrate_existing(self) -> None:
        old_paths: list[Path] = []
        for path in self.root.glob("*.json"):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if raw.get("version") != 2:
                old_paths.append(path)
        if not old_paths:
            return
        backup = self.backup_root / f"mapping-v1-{time.strftime('%Y%m%d-%H%M%S')}"
        backup.mkdir(parents=True, exist_ok=False)
        for path in old_paths:
            shutil.copy2(path, backup / path.name)
            mapping = self._from_raw(json.loads(path.read_text(encoding="utf-8")))
            temp = path.with_suffix(".migrating")
            temp.write_text(mapping.model_dump_json(indent=2), encoding="utf-8")
            temp.replace(path)

    def _repair_known_builtin_defects(self) -> None:
        """Repair only signatures that shipped invalid trigger-as-button bindings.

        Existing user edits are preserved: a row is changed only when its id,
        target kind/control and legacy mode all exactly match the known bad
        built-in 0.4.x payload.
        """
        path = self._path("black-myth-wukong-motion")
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        repairs = {
            "wukong-staff-spin": ("LT", "hold"),
            "wukong-interact": ("RT", "pulse"),
        }
        changed = False
        for binding in raw.get("bindings", []):
            signature = repairs.get(str(binding.get("id", "")))
            if not signature:
                continue
            control, legacy_mode = signature
            target = binding.get("target") or {}
            if (
                target.get("kind") == "gamepad_button"
                and str(target.get("control", "")).upper() == control
                and binding.get("mode") == legacy_mode
            ):
                target["kind"] = "gamepad_axis"
                binding["mode"] = "analog"
                binding["deadzone"] = 0.02
                changed = True
        if not changed:
            return
        backup = self.backup_root / f"mapping-repair-{time.strftime('%Y%m%d-%H%M%S')}"
        backup.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup / path.name)
        mapping = self._from_raw(raw)
        temp = path.with_suffix(".repairing")
        temp.write_text(mapping.model_dump_json(indent=2), encoding="utf-8")
        temp.replace(path)

    @staticmethod
    def _validate_conflicts(mapping: MappingProfile) -> None:
        occupied: dict[tuple[str, str], str] = {}
        for binding in mapping.bindings:
            if not binding.enabled:
                continue
            target = (binding.target.kind, binding.target.control.upper())
            previous = occupied.get(target)
            if previous is not None:
                raise ValueError(f"控制冲突：{target[0]} {target[1]} 同时被 {previous} 和 {binding.signal} 占用")
            occupied[target] = binding.signal

    def _install_defaults(self) -> None:
        for mapping in DEFAULT_MAPPINGS:
            path = self._path(mapping.id)
            if not path.exists():
                self.save(mapping.model_copy(deep=True))

    def _path(self, mapping_id: str) -> Path:
        if not mapping_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in mapping_id):
            raise ValueError("invalid mapping id")
        return self.root / f"{mapping_id}.json"


class MappingEngine:
    def __init__(self, router: OutputRouter) -> None:
        self.router = router
        self.mapping: MappingProfile | None = None
        self.previous_active: dict[str, bool] = {}
        self.cooldown_until: dict[str, float] = {}

    def select(self, mapping: MappingProfile) -> None:
        release_owner = getattr(self.router, "release_owner", None)
        release_owner("mapping") if release_owner else self.router.release_all()
        self.mapping = mapping
        self.previous_active.clear()
        self.cooldown_until.clear()

    def process(self, signals: dict[str, Any]) -> None:
        if self.mapping is None:
            return
        has_motion = False
        for binding in self.mapping.bindings:
            if not binding.enabled:
                continue
            raw = signals.get(binding.signal, False)
            if binding.target.kind == "dsu_motion":
                has_motion = True
                continue
            if binding.mode == "analog":
                value = float(raw) if isinstance(raw, (int, float)) else 0.0
                value = -value if binding.invert else value
                value *= binding.scale
                if abs(value) < binding.deadzone:
                    value = 0.0
                if binding.target.kind == "gamepad_axis":
                    self.router.set_axis(binding.target.control, max(-1.0, min(1.0, value)))
                continue
            numeric = 1.0 if raw is True else 0.0 if raw is False else float(raw)
            previous = self.previous_active.get(binding.id, False)
            release = binding.release_threshold if binding.release_threshold is not None else binding.threshold * 0.65
            active = numeric >= (release if previous else binding.threshold)
            if binding.invert:
                active = not active
            if binding.mode == "pulse":
                now = time.monotonic()
                if active and not previous and now >= self.cooldown_until.get(binding.id, 0.0):
                    self.router.set_digital(binding.target.kind, binding.target.control, True, "pulse")
                    self.cooldown_until[binding.id] = now + binding.cooldown_ms / 1000.0
            else:
                self.router.set_digital(binding.target.kind, binding.target.control, active, "hold")
            self.previous_active[binding.id] = active
        if has_motion:
            self.router.update_motion(signals)
        self.router.tick()

    def neutralize(self) -> None:
        self.previous_active.clear()
        self.cooldown_until.clear()
        release_owner = getattr(self.router, "release_owner", None)
        release_owner("mapping") if release_owner else self.router.release_all()
