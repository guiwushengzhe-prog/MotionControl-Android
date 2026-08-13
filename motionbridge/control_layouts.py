from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


Stance = Literal["standing", "seated"]
MotionLevel = Literal["standard", "low"]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
        raise ValueError("invalid layout id")
    return value


class CameraLayoutKey(BaseModel):
    """Camera properties that affect player-normalized scene geometry."""

    device_id: str = Field(min_length=1, max_length=100)
    lens_id: str = Field(min_length=1, max_length=100)
    facing: Literal["user", "environment"]
    orientation_degrees: Literal[0, 90, 180, 270] = 0


class NormalizedRegion(BaseModel):
    """Rectangle in calibration-centered, body-scale normalized coordinates."""

    x: float = Field(ge=-3.0, le=3.0)
    y: float = Field(ge=-3.0, le=3.0)
    width: float = Field(gt=0.0, le=6.0)
    height: float = Field(gt=0.0, le=6.0)

    @model_validator(mode="after")
    def validate_bounds(self) -> "NormalizedRegion":
        if self.x + self.width > 3.0 or self.y + self.height > 3.0:
            raise ValueError("normalized region exceeds supported bounds")
        return self

    def contains(self, point: tuple[float, float], margin: float = 0.0) -> bool:
        px, py = point
        return (
            self.x - margin <= px <= self.x + self.width + margin
            and self.y - margin <= py <= self.y + self.height + margin
        )

    def contains_for_entry(self, point: tuple[float, float], inset: float) -> bool:
        if self.width <= inset * 2 or self.height <= inset * 2:
            return self.contains(point)
        px, py = point
        return (
            self.x + inset <= px <= self.x + self.width - inset
            and self.y + inset <= py <= self.y + self.height - inset
        )


class TriggerRegion(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=80)
    point: str = Field(description="Normalized tracked point, for example left_wrist")
    geometry: NormalizedRegion
    signal: str = Field(min_length=1, max_length=100)
    behavior: Literal["hold", "pulse"] = "hold"
    enabled: bool = True
    enter_inset: float = Field(default=0.04, ge=0.0, le=0.5)
    exit_margin: float = Field(default=0.08, ge=0.0, le=0.75)
    dwell_ms: int = Field(default=160, ge=0, le=10_000)
    cooldown_ms: int = Field(default=250, ge=0, le=60_000)


class VoiceLayoutEntry(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    phrases: list[str] = Field(min_length=1)
    signal: str = Field(min_length=1, max_length=100)
    semantics: Literal["press", "down", "release", "toggle"] = "press"
    wake_word_required: bool = True
    enabled: bool = True


class ControlLayout(BaseModel):
    """A reusable scene bound to player, game and camera geometry."""

    version: Literal[1] = 1
    id: str
    name: str = Field(min_length=1, max_length=100)
    player_profile_id: str = Field(min_length=1, max_length=100)
    game_preset_id: str = Field(min_length=1, max_length=100)
    camera: CameraLayoutKey
    stance: Stance = "standing"
    motion_level: MotionLevel = "standard"
    calibration_session_ids: list[str] = Field(default_factory=list)
    calibration_reference: dict[str, Any] = Field(default_factory=dict)
    center: dict[str, float] = Field(default_factory=lambda: {"x": 0.0, "y": 0.0})
    deadzones: dict[str, float] = Field(default_factory=lambda: {"move": 0.12, "steer": 0.10})
    regions: list[TriggerRegion] = Field(default_factory=list)
    action_thresholds: dict[str, dict[str, float]] = Field(default_factory=dict)
    voice: list[VoiceLayoutEntry] = Field(default_factory=list)
    mappings: list[dict[str, Any]] = Field(default_factory=list)
    created_at: str = Field(default_factory=_utc_now)
    updated_at: str = Field(default_factory=_utc_now)


class LayoutResolution(BaseModel):
    layout: ControlLayout
    needs_realign: bool
    reasons: list[str] = Field(default_factory=list)


def camera_alignment_reasons(saved: CameraLayoutKey, current: CameraLayoutKey) -> list[str]:
    reasons: list[str] = []
    if saved.device_id != current.device_id:
        reasons.append("摄像头设备已变化")
    if saved.lens_id != current.lens_id:
        reasons.append("镜头已变化")
    if saved.facing != current.facing:
        reasons.append("前后镜头方向已变化")
    if saved.orientation_degrees != current.orientation_degrees:
        reasons.append("画面方向已变化")
    return reasons


def recommended_regions(
    game_preset_id: str,
    stance: Stance = "standing",
    motion_level: MotionLevel = "standard",
) -> list[TriggerRegion]:
    """Return conservative defaults; fixed attack regions are intentionally absent."""

    preset = game_preset_id.casefold()
    low = motion_level == "low"
    seated = stance == "seated"
    vertical_shift = 0.18 if seated else 0.0
    if any(token in preset for token in ("horizon", "forza", "fh4", "地平线", "赛车")):
        width = 1.55 if low else 1.30
        return [
            TriggerRegion(
                id="driving_hands",
                name="前方驾驶区",
                point="both_wrists_center",
                geometry=NormalizedRegion(x=-width / 2, y=-0.45 + vertical_shift, width=width, height=0.75),
                signal="region.driving_hands",
                dwell_ms=120 if low else 170,
            )
        ]
    if any(token in preset for token in ("wukong", "black_myth", "悟空", "黑神话")):
        size = 0.70 if low else 0.56
        return [
            TriggerRegion(
                id="left_utility",
                name="左手技能区",
                point="left_wrist",
                geometry=NormalizedRegion(x=-1.15, y=-0.85 + vertical_shift, width=size, height=size),
                signal="region.left_utility",
            ),
            TriggerRegion(
                id="right_utility",
                name="右手技能区",
                point="right_wrist",
                geometry=NormalizedRegion(x=0.45, y=-0.85 + vertical_shift, width=size, height=size),
                signal="region.right_utility",
            ),
        ]
    return []


def restore_recommended_regions(layout: ControlLayout) -> ControlLayout:
    updated = layout.model_copy(deep=True)
    updated.regions = recommended_regions(updated.game_preset_id, updated.stance, updated.motion_level)
    updated.updated_at = _utc_now()
    return updated


class ControlLayoutStore:
    """Atomic JSON persistence for reusable per-player game scenes."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def list(self) -> list[ControlLayout]:
        with self._lock:
            layouts: list[ControlLayout] = []
            for path in sorted(self.root.glob("*.json")):
                try:
                    layouts.append(ControlLayout.model_validate_json(path.read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    continue
            return layouts

    def create(
        self,
        name: str,
        player_profile_id: str,
        game_preset_id: str,
        camera: CameraLayoutKey,
        *,
        stance: Stance = "standing",
        motion_level: MotionLevel = "standard",
        calibration_session_ids: list[str] | None = None,
    ) -> ControlLayout:
        layout = ControlLayout(
            id=f"layout-{uuid.uuid4().hex[:12]}",
            name=name,
            player_profile_id=player_profile_id,
            game_preset_id=game_preset_id,
            camera=camera,
            stance=stance,
            motion_level=motion_level,
            calibration_session_ids=list(calibration_session_ids or []),
            regions=recommended_regions(game_preset_id, stance, motion_level),
        )
        self.save(layout)
        return layout

    def get(self, layout_id: str) -> ControlLayout:
        path = self._path(layout_id)
        if not path.exists():
            raise KeyError(layout_id)
        return ControlLayout.model_validate_json(path.read_text(encoding="utf-8"))

    def save(self, layout: ControlLayout) -> None:
        with self._lock:
            path = self._path(layout.id)
            if path.exists():
                previous = ControlLayout.model_validate_json(path.read_text(encoding="utf-8"))
                layout = layout.model_copy(deep=True)
                layout.created_at = previous.created_at
                # Calibration is cumulative: an edit cannot discard prior day references.
                layout.calibration_session_ids = list(dict.fromkeys(
                    previous.calibration_session_ids + layout.calibration_session_ids
                ))
            layout.updated_at = _utc_now()
            self._atomic_write(path, layout.model_dump_json(indent=2))

    def copy(self, layout_id: str, name: str) -> ControlLayout:
        source = self.get(layout_id)
        clone = source.model_copy(deep=True)
        clone.id = f"layout-{uuid.uuid4().hex[:12]}"
        clone.name = name
        clone.created_at = _utc_now()
        clone.updated_at = clone.created_at
        self.save(clone)
        return clone

    def rename(self, layout_id: str, name: str) -> ControlLayout:
        layout = self.get(layout_id)
        layout.name = name
        self.save(layout)
        return self.get(layout_id)

    def delete(self, layout_id: str) -> None:
        with self._lock:
            path = self._path(layout_id)
            if not path.exists():
                raise KeyError(layout_id)
            path.unlink()

    def export(self, layout_id: str) -> str:
        return json.dumps(self.get(layout_id).model_dump(), ensure_ascii=False, indent=2)

    def import_json(self, payload: str, *, replace: bool = False) -> ControlLayout:
        # Validate fully before creating a temp file so malformed imports are no-ops.
        layout = ControlLayout.model_validate_json(payload)
        path = self._path(layout.id)
        with self._lock:
            if path.exists() and not replace:
                raise FileExistsError(layout.id)
            if path.exists():
                previous = self.get(layout.id)
                layout.calibration_session_ids = list(dict.fromkeys(
                    previous.calibration_session_ids + layout.calibration_session_ids
                ))
                layout.created_at = previous.created_at
            layout.updated_at = _utc_now()
            self._atomic_write(path, layout.model_dump_json(indent=2))
        return layout

    def resolve(self, layout_id: str, current_camera: CameraLayoutKey) -> LayoutResolution:
        layout = self.get(layout_id)
        reasons = camera_alignment_reasons(layout.camera, current_camera)
        return LayoutResolution(layout=layout, needs_realign=bool(reasons), reasons=reasons)

    def find_for(
        self,
        player_profile_id: str,
        game_preset_id: str,
        current_camera: CameraLayoutKey,
    ) -> list[LayoutResolution]:
        return [
            LayoutResolution(
                layout=layout,
                needs_realign=bool(reasons := camera_alignment_reasons(layout.camera, current_camera)),
                reasons=reasons,
            )
            for layout in self.list()
            if layout.player_profile_id == player_profile_id and layout.game_preset_id == game_preset_id
        ]

    def _path(self, layout_id: str) -> Path:
        return self.root / f"{_safe_id(layout_id)}.json"

    @staticmethod
    def _atomic_write(path: Path, payload: str) -> None:
        temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temp.open("w", encoding="utf-8", newline="\n") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


class RegionRuntimeState(BaseModel):
    active: bool = False
    highlighted: bool = False
    entered: bool = False
    exited: bool = False
    pending_ms: float = 0.0


class RegionStateMachine:
    """Hysteretic region evaluation with immediate loss/out-of-bounds release."""

    def __init__(self, regions: list[TriggerRegion]):
        self.regions = {region.id: region for region in regions}
        self._active: dict[str, bool] = {}
        self._pending_since: dict[str, float] = {}
        self._last_release: dict[str, float] = {}

    def update(
        self,
        points: dict[str, tuple[float, float]],
        now_ms: float,
        *,
        person_tracked: bool = True,
    ) -> dict[str, RegionRuntimeState]:
        if not person_tracked:
            return self.release_all(now_ms)
        result: dict[str, RegionRuntimeState] = {}
        for region_id, region in self.regions.items():
            was_active = self._active.get(region_id, False)
            point = points.get(region.point)
            if not region.enabled or point is None:
                result[region_id] = self._release(region, now_ms, was_active)
                continue
            if was_active:
                if region.geometry.contains(point, region.exit_margin):
                    result[region_id] = RegionRuntimeState(active=True, highlighted=True)
                else:
                    result[region_id] = self._release(region, now_ms, True)
                continue

            if not region.geometry.contains_for_entry(point, region.enter_inset):
                self._pending_since.pop(region_id, None)
                result[region_id] = RegionRuntimeState()
                continue
            if now_ms < self._last_release.get(region_id, float("-inf")) + region.cooldown_ms:
                result[region_id] = RegionRuntimeState(highlighted=True)
                continue
            started = self._pending_since.setdefault(region_id, now_ms)
            pending_ms = max(0.0, now_ms - started)
            if pending_ms >= region.dwell_ms:
                self._pending_since.pop(region_id, None)
                if region.behavior == "pulse":
                    self._active[region_id] = False
                    self._last_release[region_id] = now_ms
                    result[region_id] = RegionRuntimeState(active=True, highlighted=True, entered=True)
                    continue
                self._active[region_id] = True
                result[region_id] = RegionRuntimeState(active=True, highlighted=True, entered=True)
            else:
                result[region_id] = RegionRuntimeState(highlighted=True, pending_ms=pending_ms)
        return result

    def release_all(self, now_ms: float) -> dict[str, RegionRuntimeState]:
        return {
            region_id: self._release(region, now_ms, self._active.get(region_id, False))
            for region_id, region in self.regions.items()
        }

    def _release(self, region: TriggerRegion, now_ms: float, was_active: bool) -> RegionRuntimeState:
        self._pending_since.pop(region.id, None)
        self._active[region.id] = False
        if was_active:
            self._last_release[region.id] = now_ms
        return RegionRuntimeState(exited=was_active)
