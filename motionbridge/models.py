from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class Landmark(BaseModel):
    x: float
    y: float
    z: float = 0.0
    visibility: float = 1.0


class HandFrame(BaseModel):
    handedness: Literal["Left", "Right", "Unknown"] = "Unknown"
    landmarks: list[Landmark] = Field(min_length=21, max_length=21)
    gesture: str | None = None
    gesture_score: float = Field(default=0.0, ge=0.0, le=1.0)


class PersonPose(BaseModel):
    """One detected person carried by pose_frame_v2."""

    detection_id: str | None = Field(default=None, max_length=100)
    pose: list[Landmark] = Field(min_length=33, max_length=33)
    world_pose: list[Landmark] | None = None

    @field_validator("world_pose")
    @classmethod
    def validate_world_pose(cls, value: list[Landmark] | None) -> list[Landmark] | None:
        if value is not None and len(value) != 33:
            raise ValueError("world_pose must contain exactly 33 landmarks")
        return value


class PoseFrame(BaseModel):
    type: Literal["pose_frame"] = "pose_frame"
    role: Literal["camera", "sensor"] = "camera"
    device_id: str = Field(min_length=1, max_length=100)
    sequence: int = Field(ge=0)
    captured_at_ms: float
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    mirrored: bool = True
    pose: list[Landmark] = Field(min_length=33, max_length=33)
    world_pose: list[Landmark] | None = None
    hands: list[HandFrame] = Field(default_factory=list, max_length=2)
    inference_ms: float = Field(default=0.0, ge=0.0)

    @field_validator("world_pose")
    @classmethod
    def validate_world_pose(cls, value: list[Landmark] | None) -> list[Landmark] | None:
        if value is not None and len(value) != 33:
            raise ValueError("world_pose must contain exactly 33 landmarks")
        return value


class PoseFrameV2(BaseModel):
    type: Literal["pose_frame_v2"] = "pose_frame_v2"
    role: Literal["camera"] = "camera"
    device_id: str = Field(min_length=1, max_length=100)
    sequence: int = Field(ge=0)
    captured_at_ms: float
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    camera_facing: Literal["user", "environment"] = "environment"
    camera_id: str | None = Field(default=None, max_length=100)
    orientation_degrees: Literal[0, 90, 180, 270] = 0
    preview_mirrored: bool = False
    coordinates_mirrored: bool = False
    poses: list[PersonPose] = Field(default_factory=list, max_length=2)
    hands: list[HandFrame] = Field(default_factory=list, max_length=4)
    inference_ms: float = Field(default=0.0, ge=0.0)
    sent_at_ms: float | None = None
    actual_model: Literal["lite", "full", "heavy"] | None = None
    voice_state: Literal["not_connected", "connected", "enabled", "silent", "unauthorized", "failed"] = "not_connected"
    pose_diagnostics: dict[str, Any] = Field(default_factory=dict)


class SensorFrame(BaseModel):
    type: Literal["sensor_frame"] = "sensor_frame"
    role: Literal["sensor"] = "sensor"
    device_id: str = Field(min_length=1, max_length=100)
    sequence: int = Field(ge=0)
    captured_at_ms: float
    player_slot: int = Field(default=0, ge=0, le=1)
    quaternion: dict[str, float] = Field(default_factory=dict)
    recenter: bool = False
    orientation: dict[str, float] = Field(default_factory=dict)
    acceleration: dict[str, float] = Field(default_factory=dict)
    rotation_rate: dict[str, float] = Field(default_factory=dict)
    touches: list[dict[str, Any]] = Field(default_factory=list)


class PlayerProfile(BaseModel):
    id: str
    name: str
    created_at: str
    sessions: list[dict[str, Any]] = Field(default_factory=list)
    aggregate: dict[str, float] = Field(default_factory=dict)


class Target(BaseModel):
    kind: Literal["keyboard", "gamepad_button", "gamepad_axis", "dsu_motion"]
    control: str


class Binding(BaseModel):
    id: str
    signal: str
    target: Target
    mode: Literal["hold", "pulse", "analog"] = "hold"
    threshold: float = 0.5
    release_threshold: float | None = None
    scale: float = 1.0
    deadzone: float = 0.12
    invert: bool = False
    enabled: bool = True
    hold_ms: int = Field(default=0, ge=0, le=60_000)
    cooldown_ms: int = Field(default=0, ge=0, le=60_000)

    @field_validator("release_threshold")
    @classmethod
    def default_release_threshold(cls, value: float | None) -> float | None:
        return value


class VoiceSettings(BaseModel):
    wake_word: str = "体感"
    wake_word_required: bool = True
    phrases: dict[str, list[str]] = Field(default_factory=dict)
    semantics: dict[str, Literal["press", "down", "release", "toggle"]] = Field(default_factory=dict)
    command_signals: dict[str, str] = Field(default_factory=dict)
    output_amplitudes: dict[str, float] = Field(
        default_factory=lambda: {"move": 1.0, "steer": 1.0, "throttle": 1.0, "brake": 1.0}
    )


class MappingProfile(BaseModel):
    version: Literal[2] = 2
    id: str
    name: str
    description: str = ""
    bindings: list[Binding] = Field(default_factory=list)
    voice: VoiceSettings = Field(default_factory=VoiceSettings)
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class CreatePlayerRequest(BaseModel):
    name: str = Field(min_length=1, max_length=50)


class SelectRequest(BaseModel):
    id: str


class SlotSelectRequest(BaseModel):
    slot: int = Field(ge=0, le=1)
    id: str


class JoinRequest(BaseModel):
    slot: int = Field(ge=0, le=1)


class SensorBindRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=100)
    slot: int = Field(ge=0, le=1)


class MappingCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    source_id: str | None = None


class MappingRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class OverlaySettingsRequest(BaseModel):
    visible: bool | None = None
    compact: bool | None = None
    click_through: bool | None = None
    opacity: float | None = Field(default=None, ge=0.2, le=1.0)
    scale: float | None = Field(default=None, ge=0.6, le=2.0)


class StageRequest(BaseModel):
    stage: Literal["neutral", "arms_up", "t_pose", "squat", "lean_sides"]
    reset: bool = False
