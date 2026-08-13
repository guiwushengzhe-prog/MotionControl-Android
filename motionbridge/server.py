from __future__ import annotations

import asyncio
import io
import json
import os
import signal
import socket
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .calibration import CalibrationRecorder, ProfileStore
from .action_model import ActionModelEngine
from .control_layouts import (
    CameraLayoutKey, ControlLayout, ControlLayoutStore, RegionStateMachine,
    restore_recommended_regions,
)
from .algorithm_lab import (
    PROJECTS as ALGORITHM_LAB_PROJECTS,
    AlgorithmLabRecorder,
    AlgorithmLabStore,
    compare_session,
)
from .catalog import ACTION_CATALOG, ACTION_NAMES, CONTROL_CATALOG
from .geometry import serializable_signals
from .intents import InputIntentEngine, IntentBinding
from .mapping import MappingEngine, MappingStore
from .macros import (
    MacroCreateRequest,
    MacroDefinition,
    MacroRenameRequest,
    MacroScheduler,
    MacroStore,
    MacroTriggerRequest,
    macro_catalog,
)
from .models import (
    CreatePlayerRequest,
    JoinRequest,
    MappingCreateRequest,
    MappingProfile,
    MappingRenameRequest,
    OverlaySettingsRequest,
    PersonPose,
    PoseFrame,
    PoseFrameV2,
    SelectRequest,
    SensorFrame,
    SensorBindRequest,
    SlotSelectRequest,
    StageRequest,
)
from .outputs import OutputRouter
from .outputs.dsu import DSUServer
from .overlay import OverlayController
from .recognizer import DEFAULT_RECOGNIZER_PARAMETERS, MotionRecognizer
from .sensors import HandheldManager
from .tracking import MultiPersonTracker
from .voice import AudioStreamDiagnostics, VoiceController, VoskStreamRecognizer, grammar_phrases
from .vigem_driver import driver_status, launch_installer

try:
    import qrcode
except ImportError:
    qrcode = None


BUILD_ID = "2026.08.13-v0.4.3-camera-audio-macros"

ALGORITHM_LAB_PRESETS: dict[str, dict[str, Any]] = {
    "stable": {
        "name": "稳健防误触",
        "parameters": {
            "squat_trigger": 0.62, "squat_release": 0.38,
            "jump_trigger": 0.68,
            "fist_trigger": 0.68, "fist_release": 0.46,
            "pinch_trigger": 0.64, "pinch_release": 0.40,
            "hand_enter_s": 0.20, "hand_release_s": 0.24,
            "body_enter_s": 0.14, "body_release_s": 0.18,
        },
    },
    "responsive": {
        "name": "快速响应",
        "parameters": {
            "squat_trigger": 0.54, "squat_release": 0.31,
            "jump_trigger": 0.56,
            "fist_trigger": 0.58, "fist_release": 0.38,
            "pinch_trigger": 0.54, "pinch_release": 0.32,
            "hand_enter_s": 0.10, "hand_release_s": 0.14,
            "body_enter_s": 0.08, "body_release_s": 0.12,
        },
    },
}

if getattr(sys, "frozen", False):
    PROJECT_ROOT = Path(getattr(sys, "_MEIPASS"))
    executable_root = Path(sys.executable).resolve().parent
    portable_data = executable_root / "data"
    DATA_ROOT = (
        Path(os.environ["MOTIONBRIDGE_DATA_ROOT"])
        if os.environ.get("MOTIONBRIDGE_DATA_ROOT")
        else portable_data if (executable_root / "portable.flag").is_file()
        else Path(os.environ.get("LOCALAPPDATA", Path.home())) / "MotionBridge" / "data"
    )
else:
    PROJECT_ROOT = Path(__file__).resolve().parent.parent
    DATA_ROOT = PROJECT_ROOT / "data"


def local_ipv4() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"
    finally:
        sock.close()


class RuntimeState:
    def __init__(self, data_root: Path = DATA_ROOT, enable_outputs: bool = True) -> None:
        self.data_root = data_root
        self.profile_store = ProfileStore(data_root / "profiles")
        self.mapping_store = MappingStore(data_root / "mappings")
        self.macro_store = MacroStore(data_root / "macros")
        self.layout_store = ControlLayoutStore(data_root / "control-layouts")
        self.recorder = CalibrationRecorder(self.profile_store)
        self.recognizers = [MotionRecognizer(), MotionRecognizer()]
        self.shared_dsu = DSUServer()
        self.routers = [
            OutputRouter(enable_dsu=enable_outputs, slot=0, shared_dsu=self.shared_dsu, keyboard_allowed=True),
            OutputRouter(enable_dsu=enable_outputs, slot=1, shared_dsu=self.shared_dsu, keyboard_allowed=False),
        ]
        self.mapping_engines = [MappingEngine(self.routers[0]), MappingEngine(self.routers[1])]
        self.macro_schedulers = [
            MacroScheduler(self.routers[0], self.macro_store, player_slot=0),
            MacroScheduler(self.routers[1], self.macro_store, player_slot=1),
        ]
        self.intent_engines = [InputIntentEngine(), InputIntentEngine()]
        self.action_models = [ActionModelEngine(), ActionModelEngine()]
        self.action_model_choice = "core13"
        self.action_model_enabled = [True, True]
        self.last_model_results: list[dict[str, Any]] = [{}, {}]
        self.selected_layout_ids: list[str | None] = [None, None]
        self.region_engines: list[RegionStateMachine | None] = [None, None]
        self.last_regions: list[dict[str, Any]] = [{}, {}]
        self.last_macro_regions: list[dict[str, float | bool]] = [{}, {}]
        self.camera_key = CameraLayoutKey(device_id="unknown", lens_id="logical", facing="environment")
        self.selected_profile_ids: list[str | None] = [None, None]
        self.selected_mapping_ids: list[str | None] = [None, None]
        self.last_signals: list[dict[str, Any]] = [{"pose_visible": False}, {"pose_visible": False}]
        self.last_camera_signals: list[dict[str, Any]] = [{"pose_visible": False}, {"pose_visible": False}]
        self.slot_last_seen = [0.0, 0.0]
        self.tracker = MultiPersonTracker()
        self.voice = VoiceController(self.emergency_stop)
        self.handhelds = HandheldManager()
        self.run_mode = "single"
        self.camera_model: str | None = None
        self.voice_link_state = "not_connected"
        self.voice_audio_status: dict[str, Any] = {
            "channel_connected": False, "stream_alive": False, "audio_active": False,
            "silence": False, "last_rms": 0.0, "peak_rms": 0.0,
            "partial": "", "final": "", "last_command": None,
        }
        self.overlay = OverlayController(data_root / "overlay.json")
        self.algorithm_lab_store = AlgorithmLabStore(data_root / "algorithm-tests" / "sessions")
        self.algorithm_lab_recorder: AlgorithmLabRecorder | None = None
        self.algorithm_lab_candidate_preset = "stable"
        self.algorithm_lab_last_completed_id: str | None = None
        self.algorithm_lab_last_result: dict[str, Any] | None = None
        self.calibration_slot = 0
        self.last_frame_monotonic = 0.0
        self.last_frame_time_ms = 0.0
        self.last_sequence: dict[str, int] = {}
        self.last_sequence_monotonic: dict[str, float] = {}
        self.camera_device_id: str | None = None
        self.pose_count = 0
        self.pose_frames_with_people = 0
        self.last_pose_diagnostics: dict[str, Any] = {}
        self.sensor_device_id: str | None = None
        self.frame_count = 0
        self.fps = 0.0
        self.inference_ms = 0.0
        self.network_ms = 0.0
        self.total_latency_ms = 0.0
        self.clock_rtt_ms = 0.0
        self._last_fps_time = time.monotonic()
        self._last_fps_count = 0
        self._watchdog_task: asyncio.Task[None] | None = None
        mappings = self.mapping_store.list()
        profiles = self.profile_store.list()
        for slot in range(2):
            if mappings:
                self.select_mapping(slot, mappings[min(slot, len(mappings) - 1)].id)
            if profiles and slot < len(profiles):
                self.select_profile(slot, profiles[slot].id)
        self._load_internal_research_model()

    def _load_internal_research_model(self) -> None:
        """Load the approved external checkpoint without copying it into the product."""
        portable_root = PROJECT_ROOT / "models" / "internal-research-only"
        portable_model = portable_root / "motionbridge-coco17-6class-internal-research-only.onnx"
        portable_metadata = portable_model.with_name("model-metadata.json")
        portable_sha = "af5071b376340cd0a60a9b7ece685af8e7557d98a829f3c4ff2ac1de53f18c40"
        source_sha = "85d2eb63c14d37cc546ec7945d7be922f1a83e726a12d8a5592652fe22b4aa3f"
        protocol_sha = "c9e9964434050f09715543f2da339621a1948d23aa24fed331ff2451ef2aaf3a"
        core_model = portable_root / "motionbridge-penn-core13-6class-internal-research-only.onnx"
        core_metadata = portable_root / "model-metadata-core13.json"
        if core_model.is_file() and core_metadata.is_file():
            self.action_model_choice = "core13"
            for engine in self.action_models:
                engine.load_onnx(
                    core_model,
                    metadata_path=core_metadata,
                    expected_sha256="d72dfafa02be55962aad92e40b0170bc5acd7b5bdbfcdad2c777b519601ec458",
                    expected_source_checkpoint_sha256="683b3b4b0912335aee1b4eec31f3b2ce8dc81f62c73951d0200b73cc611c259c",
                    expected_protocol_hash=protocol_sha,
                    expected_candidate="penn_core13",
                    expected_topology="core13",
                )
            if all(engine.validated_model is not None for engine in self.action_models):
                return
        if portable_model.is_file() and portable_metadata.is_file():
            self.action_model_choice = "coco17"
            for engine in self.action_models:
                engine.load_onnx(
                    portable_model,
                    metadata_path=portable_metadata,
                    expected_sha256=portable_sha,
                    expected_source_checkpoint_sha256=source_sha,
                    expected_protocol_hash=protocol_sha,
                )
            if all(engine.validated_model is not None for engine in self.action_models):
                return
        checkpoint = Path(os.environ.get(
            "MOTIONBRIDGE_RESEARCH_CHECKPOINT",
            r"F:\MotionControl\test_results\public_rgb_control_ab_v1\runs_v2_epochs12\openmmlab_ntu60_2d_native_coco17_seed42\best.pt",
        ))
        expected_sha = source_sha
        if not checkpoint.is_file():
            return
        try:
            if getattr(sys, "frozen", False):
                external_site = Path(r"F:\MotionControl\.venv-stgcn-cuda\Lib\site-packages")
                external_mmaction = Path(r"F:\MotionControl\MMAction2")
                for candidate in (external_site, external_mmaction):
                    if candidate.is_dir() and str(candidate) not in sys.path:
                        sys.path.insert(0, str(candidate))
            import torch
            from mmaction.models.backbones import STGCN
            nn = torch.nn
            class ResearchModel(nn.Module):
                def __init__(self) -> None:
                    super().__init__()
                    self.backbone = STGCN(graph_cfg={"layout": "coco", "mode": "spatial"}, in_channels=3, num_person=1, gcn_adaptive="init", gcn_with_res=True, tcn_type="mstcn")
                    self.root_branch = nn.Sequential(nn.Linear(4, 32), nn.ReLU())
                    self.head = nn.Linear(288, 6)
                def forward(self, skeleton: Any, root: Any) -> Any:
                    feature = self.backbone(skeleton).mean(dim=(1, 3, 4))
                    return self.head(torch.cat([feature, self.root_branch(root)], 1))
            for engine in self.action_models:
                engine.load_checkpoint(checkpoint, expected_sha256=expected_sha, expected_protocol_hash=protocol_sha, model_factory=lambda _torch: ResearchModel())
        except Exception as exc:
            for engine in self.action_models:
                engine._detail = f"参数准备中：研究运行时不可用（{exc}）"

    def select_action_model(self, choice: str) -> None:
        contracts = {
            "core13": (
                "motionbridge-penn-core13-6class-internal-research-only.onnx", "model-metadata-core13.json",
                "d72dfafa02be55962aad92e40b0170bc5acd7b5bdbfcdad2c777b519601ec458",
                "683b3b4b0912335aee1b4eec31f3b2ce8dc81f62c73951d0200b73cc611c259c", "penn_core13", "core13",
            ),
            "coco17": (
                "motionbridge-coco17-6class-internal-research-only.onnx", "model-metadata.json",
                "af5071b376340cd0a60a9b7ece685af8e7557d98a829f3c4ff2ac1de53f18c40",
                "85d2eb63c14d37cc546ec7945d7be922f1a83e726a12d8a5592652fe22b4aa3f", "openmmlab_ntu60_2d_native_coco17", "coco17",
            ),
        }
        if choice not in contracts:
            raise ValueError("动作模型选项无效")
        for slot in range(2):
            self.release_player_inputs(slot, "切换动作模型")
        file_name, metadata_name, model_sha, source_sha, candidate, topology = contracts[choice]
        root = PROJECT_ROOT / "models" / "internal-research-only"
        replacement: list[ActionModelEngine] = []
        for _ in range(2):
            engine = ActionModelEngine()
            status = engine.load_onnx(
                root / file_name, metadata_path=root / metadata_name,
                expected_sha256=model_sha, expected_source_checkpoint_sha256=source_sha,
                expected_protocol_hash="c9e9964434050f09715543f2da339621a1948d23aa24fed331ff2451ef2aaf3a",
                expected_candidate=candidate, expected_topology=topology,
            )
            if not status["ready"]:
                for prior in replacement: prior.reset()
                raise ValueError(status["state_zh"])
            replacement.append(engine)
        self.action_models = replacement
        self.last_model_results = [{}, {}]
        self.action_model_choice = choice

    # Compatibility handles used by the original tests and cached UI.
    @property
    def selected_profile_id(self) -> str | None:
        return self.selected_profile_ids[0]

    @property
    def selected_mapping_id(self) -> str | None:
        return self.selected_mapping_ids[0]

    @property
    def recognizer(self) -> MotionRecognizer:
        return self.recognizers[0]

    @property
    def router(self) -> OutputRouter:
        return self.routers[0]

    @property
    def mapping_engine(self) -> MappingEngine:
        return self.mapping_engines[0]

    def start(self) -> None:
        for router in self.routers:
            router.start()
        self.overlay.start()

    def select_profile(self, slot_or_id: int | str, profile_id: str | None = None) -> None:
        slot = int(slot_or_id) if isinstance(slot_or_id, int) else 0
        resolved = profile_id if profile_id is not None else str(slot_or_id)
        profile = self.profile_store.get(resolved)
        self.selected_profile_ids[slot] = profile.id
        self.recognizers[slot].set_calibration(profile.aggregate)
        self._auto_select_layout(slot)

    def select_mapping(self, slot_or_id: int | str, mapping_id: str | None = None) -> None:
        slot = int(slot_or_id) if isinstance(slot_or_id, int) else 0
        resolved = mapping_id if mapping_id is not None else str(slot_or_id)
        mapping = self.mapping_store.get(resolved)
        self.release_player_inputs(slot, "切换游戏预设")
        self.selected_mapping_ids[slot] = mapping.id
        self.mapping_engines[slot].select(mapping)
        self.intent_engines[slot].switch_preset(self._intent_bindings(mapping.id))
        self.macro_schedulers[slot].set_preset(mapping.id)
        self._auto_select_layout(slot)

    def current_mapping(self, slot: int) -> MappingProfile | None:
        mapping_id = self.selected_mapping_ids[slot]
        if not mapping_id:
            return None
        try:
            return self.mapping_store.get(mapping_id)
        except KeyError:
            return None

    def release_player_inputs(self, slot: int, reason: str) -> None:
        self.voice.release_all(slot)
        self.macro_schedulers[slot].cancel_all(reason)
        self.intent_engines[slot].release_all(reason)
        self.action_models[slot].reset()
        self.mapping_engines[slot].neutralize()
        self.last_signals[slot] = {"pose_visible": False}

    def reload_macros(self) -> None:
        for scheduler in self.macro_schedulers:
            scheduler.reload()

    def update_macro_sources(
        self,
        slot: int,
        *,
        action: dict[str, Any] | None = None,
        voice: dict[str, float] | None = None,
        region: dict[str, float | bool] | None = None,
        handheld: dict[str, Any] | None = None,
    ) -> None:
        if region is not None:
            self.last_macro_regions[slot] = dict(region)
        sources: dict[str, dict[str, float | bool]] = {}
        if action is not None:
            sources["action"] = {
                key: value for key, value in action.items()
                if isinstance(value, (bool, int, float))
            }
        if voice is not None:
            sources["voice"] = {
                key: value for key, value in voice.items()
                if isinstance(value, (bool, int, float))
            }
        if region is not None:
            sources["region"] = dict(region)
        if handheld is not None:
            sources["handheld"] = {
                key: value for key, value in handheld.items()
                if isinstance(value, (bool, int, float))
            }
        if sources:
            self.macro_schedulers[slot].update_sources(sources)

    @staticmethod
    def _intent_bindings(mapping_id: str) -> list[IntentBinding]:
        def axis(name: str, sources: tuple[str, ...], deadzone: float, priority: int = 10) -> IntentBinding:
            return IntentBinding(name, name, "axis", any_of=sources, priority=priority, deadzone=deadzone)
        def digital(name: str, sources: tuple[str, ...], priority: int = 10, group: str | None = None) -> IntentBinding:
            return IntentBinding(name, name, "digital", any_of=sources, priority=priority, exclusive_group=group)
        if mapping_id == "forza-horizon-4-motion":
            return [
                axis("intent_steer_x", ("camera:steer_x", "sensor:handheld_orientation_x"), .08),
                axis("intent_throttle", ("region:driving_hands", "sensor:handheld_zr", "voice:intent_cruise_on"), .01),
                axis("intent_brake", ("camera:brake", "sensor:handheld_zl"), .01, 30),
                digital("intent_handbrake", ("model:lunge", "camera:lunge"), 20),
                *[digital(f"intent_{key}", (f"voice:intent_{key}",), 20) for key in ("pause", "map", "reset_vehicle", "change_camera", "rewind", "shift_up", "shift_down")],
            ]
        if mapping_id == "black-myth-wukong-motion":
            return [
                axis("intent_move_x", ("camera:move_x", "sensor:handheld_stick_x"), .10),
                axis("intent_move_y", ("camera:move_y", "sensor:handheld_stick_y"), .10),
                digital("intent_light_attack", ("model:right_strike", "camera:right_punch", "sensor:handheld_x"), 20, "attack"),
                digital("intent_heavy_attack", ("model:left_strike", "camera:left_punch", "sensor:handheld_y"), 21, "attack"),
                digital("intent_dodge", ("model:squat", "model:lunge", "camera:quick_dodge", "sensor:handheld_b"), 30),
                digital("intent_jump", ("model:arms_up", "camera:both_hands_up", "sensor:handheld_a"), 20),
                digital("intent_gourd", ("camera:left_hand_up", "region:left_utility", "voice:intent_gourd"), 20),
                digital("intent_staff_spin", ("camera:hands_forward", "region:right_utility", "voice:intent_staff_spin"), 20),
                digital("intent_lock_target", ("camera:right_hand_up", "voice:intent_lock_target"), 20),
                digital("intent_interact", ("voice:intent_interact", "sensor:handheld_zr"), 20),
                *[digital(f"intent_{key}", (f"voice:intent_{key}",), 20) for key in ("pause", "spell_one", "spell_two", "transform", "pillar_stance")],
            ]
        return []

    def _auto_select_layout(self, slot: int) -> None:
        profile_id, mapping_id = self.selected_profile_ids[slot], self.selected_mapping_ids[slot]
        if not profile_id or not mapping_id or self.camera_key.device_id == "unknown":
            return
        matches = self.layout_store.find_for(profile_id, mapping_id, self.camera_key)
        aligned = next((item for item in matches if not item.needs_realign), None)
        if aligned:
            self.select_layout(slot, aligned.layout.id)

    def select_layout(self, slot: int, layout_id: str) -> None:
        layout = self.layout_store.get(layout_id)
        if layout.player_profile_id != self.selected_profile_ids[slot] or layout.game_preset_id != self.selected_mapping_ids[slot]:
            raise ValueError("控制布局与当前玩家或游戏不匹配")
        self.release_player_inputs(slot, "切换控制布局")
        self.selected_layout_ids[slot] = layout.id
        self.region_engines[slot] = RegionStateMachine(layout.regions)

    def current_layout(self, slot: int) -> ControlLayout | None:
        try:
            return self.layout_store.get(self.selected_layout_ids[slot] or "")
        except (KeyError, ValueError):
            return None

    @property
    def algorithm_lab_active(self) -> bool:
        return self.algorithm_lab_recorder is not None

    def start_algorithm_lab(self, project: str, slot: int, repetitions: int, candidate_preset: str) -> dict[str, Any]:
        if self.algorithm_lab_active:
            raise RuntimeError("已有真人算法测试正在进行")
        if project not in ALGORITHM_LAB_PROJECTS:
            raise ValueError("未知测试项目")
        if slot not in (0, 1) or (slot == 1 and self.run_mode != "double"):
            raise ValueError("玩家槽位不可用")
        if candidate_preset not in ALGORITHM_LAB_PRESETS:
            raise ValueError("未知候选参数配置")
        if not self.selected_profile_ids[slot]:
            raise RuntimeError("请先选择玩家档案")
        if not self.last_frame_monotonic or time.monotonic() - self.last_frame_monotonic >= 1.5:
            raise RuntimeError("请先连接真实摄像头手机")
        if self.tracker.slot_status(slot).get("state") != "tracking":
            raise RuntimeError(f"请先让玩家{slot + 1}加入并锁定")
        self.voice.release_all()
        for engine in self.mapping_engines:
            engine.neutralize()
        for router in self.routers:
            router.set_shadow_mode(True)
        self.recognizers[slot].reset()
        self.algorithm_lab_candidate_preset = candidate_preset
        self.algorithm_lab_last_completed_id = None
        self.algorithm_lab_last_result = None
        self.algorithm_lab_recorder = AlgorithmLabRecorder(
            project=project,
            repetitions=repetitions,
            player_slot=slot,
            source_recognizer=self.recognizers[slot],
        )
        self.algorithm_lab_recorder.start(time.monotonic() * 1000)
        return self.algorithm_lab_status()

    def _release_algorithm_outputs(self) -> None:
        for engine in self.mapping_engines:
            engine.neutralize()
        for router in self.routers:
            router.release_all()

    def _compare_algorithm_session(self, session: dict[str, Any], preset: str | None = None) -> dict[str, Any]:
        selected = preset or str(session.get("metadata", {}).get("candidate_preset") or "stable")
        if selected not in ALGORITHM_LAB_PRESETS:
            raise ValueError("未知候选参数配置")
        calibration = dict(session.get("metadata", {}).get("calibration") or {})

        def factory(parameters: dict[str, Any] | None = None) -> MotionRecognizer:
            recognizer = MotionRecognizer()
            recognizer.set_calibration(calibration)
            recognizer.set_parameters(parameters)
            return recognizer

        current_parameters = dict(session.get("metadata", {}).get("current_parameters") or DEFAULT_RECOGNIZER_PARAMETERS)
        candidate_parameters = {**DEFAULT_RECOGNIZER_PARAMETERS, **ALGORITHM_LAB_PRESETS[selected]["parameters"]}
        comparison = compare_session(
            session, current_parameters, candidate_parameters,
            recognizer_factory=factory, release_all=self._release_algorithm_outputs,
        )
        comparison["current"]["name"] = "当前默认参数"
        comparison["candidate"]["name"] = ALGORITHM_LAB_PRESETS[selected]["name"]
        comparison["candidate_preset"] = selected
        return comparison

    @staticmethod
    def _compact_algorithm_comparison(comparison: dict[str, Any]) -> dict[str, Any]:
        compact = json.loads(json.dumps(comparison, ensure_ascii=False))
        for variant in ("current", "candidate"):
            compact.get(variant, {}).pop("frame_results", None)
        return compact

    def finish_algorithm_lab(self) -> dict[str, Any]:
        recorder = self.algorithm_lab_recorder
        if recorder is None:
            raise RuntimeError("当前没有正在进行的算法测试")
        slot = recorder.player_slot
        try:
            profile = self.profile_store.get(self.selected_profile_ids[slot] or "")
            session = recorder.finish(metadata={
                "build_id": BUILD_ID,
                "candidate_preset": self.algorithm_lab_candidate_preset,
                "calibration": dict(profile.aggregate),
                "current_parameters": dict(DEFAULT_RECOGNIZER_PARAMETERS),
                "output_isolation": "hardware-shadow-lock",
                "streams": {"pose_landmarks": True, "hand_landmarks": True, "raw_video": False},
            })
            comparison = self._compare_algorithm_session(session, self.algorithm_lab_candidate_preset)
            session["comparison"] = self._compact_algorithm_comparison(comparison)
            self.algorithm_lab_store.save(session)
            self.algorithm_lab_last_completed_id = str(session["id"])
            self.algorithm_lab_last_result = session
            return session
        finally:
            self.algorithm_lab_recorder = None
            self.voice.release_all()
            self._release_algorithm_outputs()
            for router in self.routers:
                router.set_shadow_mode(False)

    def algorithm_lab_status(self) -> dict[str, Any]:
        recorder = self.algorithm_lab_recorder
        if recorder is None:
            return {
                "active": False,
                "completed_session_id": self.algorithm_lab_last_completed_id,
                "shadow_mode": any(router.shadow_mode for router in self.routers),
                "outputs_released": not any(router.enabled for router in self.routers),
            }
        started = float(recorder.started_at_ms or time.monotonic() * 1000)
        elapsed = max(0.0, time.monotonic() * 1000 - started)
        plan = recorder.plan or {}
        total = max(1.0, float(plan.get("total_duration_ms") or 1.0))
        if elapsed >= total:
            completed = self.finish_algorithm_lab()
            return {
                "active": False, "completed_session_id": completed["id"],
                "shadow_mode": False, "outputs_released": True,
            }
        stages = list(plan.get("stages") or [])
        stage = next((item for item in stages if float(item["start_offset_ms"]) <= elapsed < float(item["end_offset_ms"])), stages[-1] if stages else {})
        return {
            "active": True,
            "session_id": recorder.session_id,
            "project": recorder.project,
            "project_name": ALGORITHM_LAB_PROJECTS[recorder.project]["name"],
            "instruction": stage.get("prompt", "准备"),
            "stage_kind": stage.get("kind"),
            "remaining_ms": max(0.0, float(stage.get("end_offset_ms", total)) - elapsed),
            "progress": min(1.0, elapsed / total),
            "frame_count": len(recorder._frames),
            "shadow_mode": True,
            "outputs_released": not any(router.enabled for router in self.routers),
        }
        try:
            return self.mapping_store.get(mapping_id)
        except KeyError:
            return None

    def ingest_pose(self, frame: PoseFrame) -> bool:
        if not self._begin_frame(frame.device_id, frame.sequence, frame.captured_at_ms, frame.inference_ms):
            return False
        person = PersonPose(pose=frame.pose, world_pose=frame.world_pose)
        assigned = self.tracker.assign_legacy(person)
        self._process_assignments(assigned, frame, frame.hands)
        return True

    def ingest_pose_v2(self, frame: PoseFrameV2) -> bool:
        if not self._begin_frame(frame.device_id, frame.sequence, frame.captured_at_ms, frame.inference_ms):
            return False
        self.camera_model = frame.actual_model or self.camera_model
        self.pose_count = len(frame.poses)
        if self.pose_count:
            self.pose_frames_with_people += 1
        self.last_pose_diagnostics = dict(frame.pose_diagnostics)
        self.camera_key = CameraLayoutKey(
            device_id=frame.device_id, lens_id=frame.camera_id or "logical",
            facing=frame.camera_facing, orientation_degrees=frame.orientation_degrees,
        )
        if not self.voice.connected:
            self.voice_link_state = frame.voice_state
        assigned = self.tracker.update(frame.poses)
        if self.run_mode == "single":
            assigned.pop(1, None)
        self._process_assignments(assigned, frame, frame.hands)
        return True

    def _begin_frame(self, device_id: str, sequence: int, captured_at_ms: float, inference_ms: float) -> bool:
        if not self._accept_sequence(device_id, sequence):
            return False
        self.camera_device_id = device_id
        self.last_frame_monotonic = time.monotonic()
        self.last_frame_time_ms = captured_at_ms
        self.frame_count += 1
        self.inference_ms = inference_ms
        wall_delta = time.time() * 1000 - captured_at_ms
        self.total_latency_ms = wall_delta if 0 <= wall_delta <= 10_000 else inference_ms
        self.network_ms = max(0.0, self.total_latency_ms - inference_ms)
        now = time.monotonic()
        elapsed = now - self._last_fps_time
        if elapsed >= 1.0:
            self.fps = (self.frame_count - self._last_fps_count) / elapsed
            self._last_fps_count = self.frame_count
            self._last_fps_time = now
        return True

    def _process_assignments(self, assigned: dict[int, PersonPose], frame: PoseFrame | PoseFrameV2, hands: list[Any]) -> None:
        now = time.monotonic()
        for slot, person in assigned.items():
            legacy = PoseFrame(
                device_id=frame.device_id, sequence=frame.sequence, captured_at_ms=frame.captured_at_ms,
                width=frame.width, height=frame.height,
                mirrored=getattr(frame, "coordinates_mirrored", getattr(frame, "mirrored", False)),
                pose=person.pose, world_pose=person.world_pose, hands=hands,
                inference_ms=frame.inference_ms,
            )
            self.slot_last_seen[slot] = now
            if slot == self.calibration_slot:
                self.recorder.add_frame(legacy)
            camera_signals = self.recognizers[slot].process(legacy)
            model_result = self.action_models[slot].process_frame(legacy) if self.action_model_enabled[slot] else self.action_models[slot].mark_input_missing()
            self.last_model_results[slot] = model_result
            region_signals: dict[str, float | bool] = {}
            region_engine = self.region_engines[slot]
            if region_engine is not None:
                p = legacy.pose
                hip_x = (p[23].x + p[24].x) / 2
                hip_y = (p[23].y + p[24].y) / 2
                scale = max(abs(p[12].x - p[11].x), 1e-4)
                point = lambda index: ((p[index].x - hip_x) / scale, (p[index].y - hip_y) / scale)
                left, right = point(15), point(16)
                points = {"left_wrist": left, "right_wrist": right, "both_wrists_center": ((left[0]+right[0])/2, (left[1]+right[1])/2)}
                states = region_engine.update(points, frame.captured_at_ms, person_tracked=True)
                self.last_regions[slot] = {key: value.model_dump() for key, value in states.items()}
                layout = self.current_layout(slot)
                if layout:
                    for region in layout.regions:
                        state = states.get(region.id)
                        if state:
                            region_signals[region.id] = state.entered if region.behavior == "pulse" else state.active
            if self.algorithm_lab_recorder is not None and slot == self.algorithm_lab_recorder.player_slot:
                self.algorithm_lab_recorder.record_frame(
                    legacy,
                    received_at_ms=time.monotonic() * 1000,
                    raw_signals=self.recognizers[slot].last_raw_signals,
                    live_signals=camera_signals,
                )
            self.last_camera_signals[slot] = camera_signals
            signals = self._compose_signals(slot, camera_signals, model_result=model_result, region_signals=region_signals)
            self.last_signals[slot] = signals
            if not self.algorithm_lab_active:
                self.mapping_engines[slot].process(signals)
                self.update_macro_sources(
                    slot,
                    action=signals,
                    voice=self.voice.signals(slot),
                    region=region_signals,
                    handheld=self.handhelds.signals(slot),
                )
        for slot in range(2):
            if slot not in assigned and self.slot_last_seen[slot] and now - self.slot_last_seen[slot] > 0.3:
                self.action_models[slot].mark_input_missing()
                if self.region_engines[slot]:
                    self.region_engines[slot].release_all(frame.captured_at_ms)
                self.neutralize_player(slot, pose_only=True)
        self.overlay.update(self.player_statuses())

    def ingest_sensor(self, frame: SensorFrame) -> bool:
        if not self._accept_sequence(frame.device_id, frame.sequence):
            return False
        if frame.player_slot == 1 and self.run_mode != "double":
            raise ValueError("请先在电脑切换到双人模式")
        self.sensor_device_id = frame.device_id
        signals = self.handhelds.ingest(frame)
        slot = frame.player_slot
        self.last_signals[slot] = self._compose_signals(slot, self.last_camera_signals[slot])
        if not self.algorithm_lab_active:
            self.mapping_engines[slot].process(self.last_signals[slot])
            self.update_macro_sources(
                slot,
                voice=self.voice.signals(slot),
                handheld=self.handhelds.signals(slot),
            )
        return True

    def _compose_signals(
        self, slot: int, camera: dict[str, Any], *,
        model_result: dict[str, Any] | None = None,
        region_signals: dict[str, float | bool] | None = None,
    ) -> dict[str, Any]:
        mapping_id = self.selected_mapping_ids[slot]
        voice = self.voice.signals(slot)
        sensor = self.handhelds.signals(slot)
        if mapping_id not in {"forza-horizon-4-motion", "black-myth-wukong-motion"}:
            return {**camera, **voice, **sensor}
        camera_source: dict[str, float | bool] = {}
        if mapping_id == "forza-horizon-4-motion":
            if float(camera.get("crouch_amount", 0.0)) > 0.12 or float(sensor.get("handheld_zl", 0.0)) > 0.05:
                self.voice.states[slot]["intent_cruise_on"] = 0.0
            camera_source = {
                "steer_x": max(-1.0, min(1.0, .58 * float(camera.get("lean_x", 0.0)) + .42 * float(camera.get("move_x", 0.0)))),
                "brake": max(0.0, float(camera.get("crouch_amount", 0.0))),
                "lunge": bool(camera.get("move_left") or camera.get("move_right")),
            }
        else:
            camera_source = {
                "move_x": float(camera.get("move_x", 0.0)),
                "move_y": max(-1.0, min(1.0, -float(camera.get("torso_pitch", 0.0)))),
                "right_punch": bool(camera.get("right_punch")), "left_punch": bool(camera.get("left_punch")),
                "quick_dodge": bool(camera.get("squat")), "both_hands_up": bool(camera.get("both_hands_up")),
                "left_hand_up": bool(camera.get("left_hand_up")), "right_hand_up": bool(camera.get("right_hand_up")),
                "hands_forward": bool(camera.get("left_fist") and camera.get("right_fist")),
            }
        model = model_result or self.last_model_results[slot]
        model_source: dict[str, float | bool] = {}
        if model and not model.get("fallback_required") and model.get("active"):
            label, qualifier = model.get("action"), model.get("qualifier")
            if label == "SQUAT_PULSE": model_source["squat"] = True
            elif label == "LUNGE_SHIFT": model_source["lunge"] = True
            elif label == "ARMS_UP_DYNAMIC": model_source["arms_up"] = True
            elif label == "RAPID_ARM_STRIKE": model_source[f"{qualifier or 'right'}_strike"] = True
        mixer = self.intent_engines[slot]
        mixer.replace_source("camera", camera_source)
        mixer.replace_source("voice", voice)
        mixer.replace_source("sensor", sensor)
        mixer.replace_source("region", region_signals or {})
        frame = mixer.replace_source("model", model_source)
        motion = {
            key: sensor.get(key, camera.get(key, default))
            for key, default in (("gyro_x", 0.0), ("gyro_y", 0.0), ("gyro_z", 0.0), ("accel_x", 0.0), ("accel_y", 0.0), ("accel_z", 1.0))
        }
        return {"pose_visible": bool(camera.get("pose_visible")), **motion, **frame.values}

    def _accept_sequence(self, device_id: str, sequence: int) -> bool:
        previous = self.last_sequence.get(device_id, -1)
        now = time.monotonic()
        if sequence == previous:
            return False
        if sequence < previous and now - self.last_sequence_monotonic.get(device_id, now) < 1.5:
            return False
        self.last_sequence[device_id] = sequence
        self.last_sequence_monotonic[device_id] = now
        return True

    def neutralize_player(self, slot: int, pose_only: bool = False) -> None:
        self.last_camera_signals[slot] = {"pose_visible": False}
        preserved = self._compose_signals(slot, {"pose_visible": False}) if pose_only else {"pose_visible": False}
        self.last_signals[slot] = preserved
        self.mapping_engines[slot].neutralize()
        self.update_macro_sources(slot, action={"pose_visible": False}, region={})
        if pose_only and any((isinstance(value, bool) and value) or (isinstance(value, (int, float)) and abs(value) > 1e-6) for value in preserved.values()):
            self.mapping_engines[slot].process(self.last_signals[slot])

    def emergency_stop(self, slot: int) -> None:
        self.release_player_inputs(slot, "紧急停止")
        self.recognizers[slot].reset()

    def set_mode(self, mode: str) -> None:
        if mode not in {"single", "double"}:
            raise ValueError("运行模式无效")
        self.voice.release_all()
        for slot in range(2):
            self.release_player_inputs(slot, "切换运行模式")
        if mode == "single":
            self.tracker.leave_slot(1)
        self.run_mode = mode

    def leave_player(self, slot: int) -> None:
        self.tracker.leave_slot(slot)
        self.release_player_inputs(slot, "退出玩家槽位")

    async def watchdog(self) -> None:
        stale_slots = [False, False]
        while True:
            await asyncio.sleep(0.05)
            now = time.monotonic()
            if self.algorithm_lab_active:
                self.algorithm_lab_status()
            for slot in range(2):
                stale = bool(self.slot_last_seen[slot]) and now - self.slot_last_seen[slot] > 0.3
                if stale and not stale_slots[slot]:
                    self.neutralize_player(slot, pose_only=True)
                stale_slots[slot] = stale
                if self.handhelds.watchdog(slot, now):
                    self.last_signals[slot] = self._compose_signals(slot, self.last_camera_signals[slot])
                    if not self.algorithm_lab_active:
                        self.mapping_engines[slot].process(self.last_signals[slot])
                        self.update_macro_sources(slot, handheld=self.handhelds.signals(slot))
                self.macro_schedulers[slot].tick(now=now)

    def player_statuses(self) -> list[dict[str, Any]]:
        profiles = {profile.id: profile for profile in self.profile_store.list()}
        result: list[dict[str, Any]] = []
        for slot in range(2):
            profile = profiles.get(self.selected_profile_ids[slot] or "")
            signals = serializable_signals(self.last_signals[slot])
            active = [ACTION_NAMES.get(key, key) for key, value in signals.items() if value is True]
            sensor = self.handhelds.status(slot)
            result.append({
                "slot": slot,
                "profile_id": self.selected_profile_ids[slot],
                "profile_name": profile.name if profile else None,
                "mapping_id": self.selected_mapping_ids[slot],
                "layout_id": self.selected_layout_ids[slot],
                "layout_name": self.current_layout(slot).name if self.current_layout(slot) else None,
                "regions": self.last_regions[slot],
                "action_model": {**self.action_models[slot].status(), "enabled": self.action_model_enabled[slot], "result": self.last_model_results[slot]},
                "tracking": self.tracker.slot_status(slot),
                "signals": signals,
                "active_actions": active,
                "voice": self.voice.status(slot),
                "macros": self.macro_schedulers[slot].status(),
                "outputs": self.routers[slot].status(),
                **sensor,
            })
        return result

    def status(self) -> dict[str, Any]:
        age_ms = round((time.monotonic() - self.last_frame_monotonic) * 1000) if self.last_frame_monotonic else None
        players = self.player_statuses()
        return {
            "camera_connected": age_ms is not None and age_ms < 1500,
            "camera_device_id": self.camera_device_id,
            "camera_model": self.camera_model,
            "pose_count": self.pose_count,
            "pose_frames_with_people": self.pose_frames_with_people,
            "pose_diagnostics": dict(self.last_pose_diagnostics),
            "action_model_choice": self.action_model_choice,
            "run_mode": self.run_mode,
            "voice_link_state": self.voice_link_state,
            "voice_audio": dict(self.voice_audio_status),
            "macros": [scheduler.status() for scheduler in self.macro_schedulers],
            "macro_count": len(self.macro_store.list()),
            "sensor_connected": self.sensor_device_id is not None,
            "sensor_device_id": self.sensor_device_id,
            "frame_age_ms": age_ms,
            "fps": round(self.fps, 1),
            "latency_ms": round(self.total_latency_ms, 1),
            "latency": {
                "inference_ms": round(self.inference_ms, 1), "network_ms": round(self.network_ms, 1),
                "total_ms": round(self.total_latency_ms, 1), "clock_rtt_ms": round(self.clock_rtt_ms, 1),
            },
            "players": players,
            "unassigned_people": self.tracker.last_unassigned,
            "overlay": self.overlay.status(),
            "algorithm_lab": self.algorithm_lab_status(),
            "research_trial": True,
            # One-release compatibility fields for older cached consoles.
            "selected_profile_id": self.selected_profile_ids[0],
            "selected_mapping_id": self.selected_mapping_ids[0],
            "calibration": self.recorder.status(),
            "outputs": players[0]["outputs"],
            "signals": players[0]["signals"],
        }

    def close(self) -> None:
        if self.algorithm_lab_active:
            try:
                self.finish_algorithm_lab()
            except Exception:
                self.algorithm_lab_recorder = None
                self._release_algorithm_outputs()
        self.voice.disconnect()
        for scheduler in self.macro_schedulers:
            scheduler.cancel_all("程序退出")
        for engine in self.mapping_engines:
            engine.neutralize()
        for router in self.routers:
            router.close()
        self.overlay.close()


def create_app(data_root: Path | None = None, enable_outputs: bool = True) -> FastAPI:
    state = RuntimeState(data_root or DATA_ROOT, enable_outputs=enable_outputs)

    def merge_algorithm_timeline(comparison: dict[str, Any]) -> list[dict[str, Any]]:
        grouped: dict[tuple[Any, ...], dict[str, list[dict[str, Any]]]] = {}
        for variant in ("current", "candidate"):
            for event in comparison.get(variant, {}).get("timeline", []):
                key = (event.get("stage_id"), event.get("trial_index"), event.get("expected"))
                grouped.setdefault(key, {"current": [], "candidate": []})[variant].append(event)
        rows: list[dict[str, Any]] = []
        for key, variants in grouped.items():
            count = max(len(variants["current"]), len(variants["candidate"]))
            for index in range(count):
                current = variants["current"][index] if index < len(variants["current"]) else {}
                candidate = variants["candidate"][index] if index < len(variants["candidate"]) else {}
                current_error = str(current.get("error_type") or "none")
                candidate_error = str(candidate.get("error_type") or "none")
                rows.append({
                    "id": len(rows),
                    "stage_id": key[0], "trial_index": key[1], "expected": key[2],
                    "at_ms": current.get("at_ms", candidate.get("at_ms", 0)),
                    "current": {"recognized": current.get("actual") or "none", "error_type": current_error},
                    "candidate": {"recognized": candidate.get("actual") or "none", "error_type": candidate_error},
                    "error_type": current_error if current_error not in {"success", "none"} else candidate_error,
                })
        rows.sort(key=lambda item: float(item.get("at_ms") or 0))
        for index, row in enumerate(rows):
            row["id"] = index
        return rows

    def public_algorithm_session(session: dict[str, Any]) -> dict[str, Any]:
        result = {key: value for key, value in session.items() if key != "frames"}
        result["frame_count"] = len(session.get("frames", []))
        comparison = json.loads(json.dumps(session.get("comparison") or {}, ensure_ascii=False))
        if comparison:
            comparison["timeline"] = merge_algorithm_timeline(comparison)
        result["comparison"] = comparison
        return result

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if enable_outputs:
            state.start()
        state._watchdog_task = asyncio.create_task(state.watchdog())
        yield
        state._watchdog_task.cancel()
        state.close()

    app = FastAPI(title="MotionBridge", version="0.4.3", lifespan=lifespan)
    app.state.runtime = state

    @app.middleware("http")
    async def prevent_stale_control_ui(request: Request, call_next):
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith(("/assets/", "/api/", "/phone/")):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    @app.get("/api/status")
    async def get_status(request: Request) -> dict[str, Any]:
        result = state.status()
        port = request.url.port or 8765
        host = local_ipv4()
        result.update({
            "build_id": BUILD_ID,
            "mobile_url": f"http://{host}:{port}/phone/",
            "input_url": f"ws://{host}:{port}/ws/input",
            "audio_url": f"ws://{host}:{port}/ws/audio",
            "vigembus": driver_status(any(player["outputs"]["gamepad"]["available"] for player in result.get("players", []))),
        })
        return result

    @app.get("/api/vigembus/status")
    async def vigembus_status() -> dict[str, object]:
        return driver_status(any(router.gamepad.available for router in state.routers))

    @app.post("/api/vigembus/install")
    async def vigembus_install(request: Request) -> dict[str, object]:
        if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
            raise HTTPException(403, "驱动安装只能在本机操作")
        current = driver_status(any(router.gamepad.available for router in state.routers))
        if current["ready"]:
            return {**current, "launched": False}
        try:
            return {**launch_installer(), "status": current}
        except (OSError, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/api/catalog/actions")
    async def action_catalog() -> list[dict[str, Any]]:
        return ACTION_CATALOG

    @app.get("/api/catalog/controls")
    async def control_catalog() -> dict[str, list[dict[str, str]]]:
        return CONTROL_CATALOG

    @app.get("/api/action-model")
    async def action_model_status() -> dict[str, Any]:
        return {"choice": state.action_model_choice, "players": [{**state.action_models[slot].status(), "slot": slot, "enabled": state.action_model_enabled[slot]} for slot in range(2)]}

    @app.post("/api/action-model/select")
    async def action_model_select(request: Request) -> dict[str, Any]:
        body = await request.json()
        try:
            state.select_action_model(str(body.get("choice", "core13")))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return state.status()

    @app.post("/api/action-model/toggle")
    async def action_model_toggle(request: Request) -> dict[str, Any]:
        body = await request.json()
        slot, enabled = int(body.get("slot", 0)), bool(body.get("enabled", True))
        if slot not in (0, 1): raise HTTPException(400, "玩家槽位无效")
        state.release_player_inputs(slot, "切换动作模型")
        state.action_model_enabled[slot] = enabled
        return state.status()

    @app.post("/api/emergency-stop")
    async def emergency_stop_all() -> dict[str, Any]:
        for slot in range(2): state.emergency_stop(slot)
        return state.status()

    @app.get("/api/control-layouts")
    async def list_control_layouts() -> list[dict[str, Any]]:
        return [layout.model_dump() for layout in state.layout_store.list()]

    @app.post("/api/control-layouts")
    async def create_control_layout(request: Request) -> dict[str, Any]:
        body = await request.json(); slot = int(body.get("slot", 0))
        profile_id, mapping_id = state.selected_profile_ids[slot], state.selected_mapping_ids[slot]
        if not profile_id or not mapping_id: raise HTTPException(409, "请先选择玩家和游戏")
        camera = state.camera_key
        if camera.device_id == "unknown": raise HTTPException(409, "请先连接摄像头")
        profile = state.profile_store.get(profile_id)
        layout = state.layout_store.create(
            str(body.get("name") or f"{profile.name} 的控制布局"), profile_id, mapping_id, camera,
            stance=str(body.get("stance", "standing")), motion_level=str(body.get("motion_level", "standard")),
            calibration_session_ids=[str(item.get("id")) for item in profile.sessions if item.get("id")],
        )
        layout.calibration_reference = dict(profile.aggregate)
        mapping = state.current_mapping(slot)
        if mapping:
            from .game_presets import get_game_preset_spec
            try:
                spec = get_game_preset_spec(mapping.id)
                layout.voice = [
                    {"id": key, "phrases": mapping.voice.phrases.get(key, []), "signal": value["signal"], "semantics": value["semantics"], "wake_word_required": mapping.voice.wake_word_required, "enabled": value.get("enabled", True)}
                    for key, value in spec.get("voice_commands", {}).items() if mapping.voice.phrases.get(key)
                ]
                layout.mappings = [binding.model_dump() for binding in mapping.bindings]
            except KeyError: pass
        state.layout_store.save(layout); state.select_layout(slot, layout.id)
        return state.layout_store.get(layout.id).model_dump()

    @app.put("/api/control-layouts/{layout_id}")
    async def save_control_layout(layout_id: str, layout: ControlLayout) -> dict[str, Any]:
        if layout.id != layout_id: raise HTTPException(400, "布局ID不能修改")
        state.layout_store.save(layout)
        for slot, selected in enumerate(state.selected_layout_ids):
            if selected == layout_id: state.select_layout(slot, layout_id)
        return state.layout_store.get(layout_id).model_dump()

    @app.post("/api/control-layouts/{layout_id}/copy")
    async def copy_control_layout(layout_id: str, request: Request) -> dict[str, Any]:
        body = await request.json(); return state.layout_store.copy(layout_id, str(body.get("name") or "布局副本")).model_dump()

    @app.post("/api/control-layouts/{layout_id}/rename")
    async def rename_control_layout(layout_id: str, request: Request) -> dict[str, Any]:
        body = await request.json(); return state.layout_store.rename(layout_id, str(body.get("name") or "控制布局")).model_dump()

    @app.delete("/api/control-layouts/{layout_id}")
    async def delete_control_layout(layout_id: str) -> dict[str, bool]:
        if layout_id in state.selected_layout_ids: raise HTTPException(409, "正在使用的布局不能删除")
        state.layout_store.delete(layout_id); return {"ok": True}

    @app.get("/api/control-layouts/{layout_id}/export")
    async def export_control_layout(layout_id: str) -> Response:
        return Response(state.layout_store.export(layout_id), media_type="application/json")

    @app.post("/api/control-layouts/import")
    async def import_control_layout(request: Request) -> dict[str, Any]:
        try: return state.layout_store.import_json(json.dumps(await request.json(), ensure_ascii=False)).model_dump()
        except (ValueError, FileExistsError) as exc: raise HTTPException(400, str(exc)) from exc

    @app.post("/api/control-layouts/{layout_id}/recommended")
    async def restore_layout(layout_id: str) -> dict[str, Any]:
        layout = restore_recommended_regions(state.layout_store.get(layout_id)); state.layout_store.save(layout)
        return state.layout_store.get(layout_id).model_dump()

    @app.post("/api/players/layout")
    async def select_player_layout(request: Request) -> dict[str, Any]:
        body = await request.json(); state.select_layout(int(body.get("slot", 0)), str(body["id"])); return state.status()

    @app.get("/api/qr")
    async def get_qr(request: Request) -> Response:
        port = request.url.port or 8765
        url = f"http://{local_ipv4()}:{port}/phone/"
        if qrcode is None:
            return Response('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><text x="20" y="120">请复制手机地址</text></svg>', media_type="image/svg+xml")
        image = qrcode.make(url)
        output = io.BytesIO()
        image.save(output, format="PNG")
        return Response(output.getvalue(), media_type="image/png")

    @app.get("/api/profiles")
    async def list_profiles() -> list[dict[str, Any]]:
        return [profile.model_dump() for profile in state.profile_store.list()]

    @app.post("/api/profiles")
    async def create_profile(body: CreatePlayerRequest) -> dict[str, Any]:
        profile = state.profile_store.create(body.name)
        state.select_profile(0, profile.id)
        return profile.model_dump()

    @app.post("/api/profiles/select")
    async def select_profile_legacy(body: SelectRequest) -> dict[str, Any]:
        return await select_player_profile(SlotSelectRequest(slot=0, id=body.id))

    @app.post("/api/players/select")
    async def select_player_profile(body: SlotSelectRequest) -> dict[str, Any]:
        try:
            state.select_profile(body.slot, body.id)
        except (KeyError, ValueError):
            raise HTTPException(404, "player profile not found") from None
        return state.status()

    @app.post("/api/players/join")
    async def join_player(body: JoinRequest) -> dict[str, Any]:
        if not state.selected_profile_ids[body.slot]:
            raise HTTPException(409, "请先为该槽位选择玩家档案")
        state.tracker.request_join(body.slot)
        state.neutralize_player(body.slot)
        return state.status()

    @app.post("/api/players/leave")
    async def leave_player(body: JoinRequest) -> dict[str, Any]:
        state.leave_player(body.slot)
        return state.status()

    @app.post("/api/mode/{mode}")
    async def set_mode(mode: str) -> dict[str, Any]:
        try:
            state.set_mode(mode)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return state.status()

    @app.post("/api/sensors/bind")
    async def bind_sensor(body: SensorBindRequest) -> dict[str, Any]:
        if body.slot == 1 and state.run_mode != "double":
            raise HTTPException(409, "请先切换到双人模式")
        try:
            state.handhelds.bind(body.device_id, body.slot)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return state.status()

    @app.post("/api/sensors/unbind")
    async def unbind_sensor(body: JoinRequest) -> dict[str, Any]:
        state.handhelds.unbind(body.slot)
        state.last_signals[body.slot] = state._compose_signals(body.slot, state.last_camera_signals[body.slot])
        state.mapping_engines[body.slot].process(state.last_signals[body.slot])
        return state.status()

    @app.post("/api/sensors/center")
    async def center_sensor(body: JoinRequest) -> dict[str, Any]:
        state.handhelds.request_center(body.slot)
        return state.status()

    @app.post("/api/calibration/start")
    async def start_calibration(request: Request) -> dict[str, Any]:
        body = await request.json() if request.headers.get("content-length") not in {None, "0"} else {}
        slot = int(body.get("slot", 0))
        if slot not in (0, 1) or not state.selected_profile_ids[slot]:
            raise HTTPException(409, "select or create a player first")
        state.calibration_slot = slot
        state.routers[slot].set_enabled(False)
        return state.recorder.start(state.selected_profile_ids[slot] or "")

    @app.post("/api/calibration/stage")
    async def calibration_stage(body: StageRequest) -> dict[str, Any]:
        try:
            return state.recorder.set_stage(body.stage, reset=body.reset)
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/api/calibration/report/{stage}")
    async def calibration_report(stage: str) -> dict[str, Any]:
        try:
            return state.recorder.report(stage)
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/calibration/finish")
    async def finish_calibration() -> dict[str, Any]:
        try:
            profile = state.recorder.finish()
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc
        state.select_profile(state.calibration_slot, profile.id)
        return profile.model_dump()

    @app.post("/api/calibration/cancel")
    async def cancel_calibration() -> JSONResponse:
        state.recorder.cancel()
        return JSONResponse({"ok": True})

    @app.get("/api/mappings")
    async def list_mappings() -> list[dict[str, Any]]:
        return [mapping.model_dump() for mapping in state.mapping_store.list()]

    @app.post("/api/mappings")
    async def create_mapping(body: MappingCreateRequest) -> dict[str, Any]:
        try:
            return state.mapping_store.create(body.name, body.source_id).model_dump()
        except (KeyError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.put("/api/mappings/{mapping_id}")
    async def save_mapping(mapping_id: str, mapping: MappingProfile) -> dict[str, Any]:
        if mapping.id != mapping_id:
            raise HTTPException(400, "mapping id cannot be changed")
        try:
            saved = state.mapping_store.save(mapping)
            for slot, selected in enumerate(state.selected_mapping_ids):
                if selected == saved.id:
                    state.select_mapping(slot, saved.id)
            return saved.model_dump()
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/mappings/{mapping_id}/rename")
    async def rename_mapping(mapping_id: str, body: MappingRenameRequest) -> dict[str, Any]:
        try:
            return state.mapping_store.rename(mapping_id, body.name).model_dump()
        except KeyError:
            raise HTTPException(404, "mapping not found") from None

    @app.delete("/api/mappings/{mapping_id}")
    async def delete_mapping(mapping_id: str) -> dict[str, bool]:
        if mapping_id in state.selected_mapping_ids:
            raise HTTPException(409, "正在使用的预设不能删除")
        try:
            state.mapping_store.delete(mapping_id)
        except KeyError:
            raise HTTPException(404, "mapping not found") from None
        return {"ok": True}

    @app.post("/api/mappings/import")
    async def import_mapping(request: Request) -> dict[str, Any]:
        try:
            return state.mapping_store.import_payload(await request.json()).model_dump()
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/mappings/{mapping_id}/export")
    async def export_mapping(mapping_id: str) -> dict[str, Any]:
        try:
            return state.mapping_store.get(mapping_id).model_dump()
        except KeyError:
            raise HTTPException(404, "mapping not found") from None

    @app.get("/api/macros/catalog")
    async def get_macro_catalog() -> dict[str, Any]:
        return {
            **macro_catalog(),
            "controls": CONTROL_CATALOG,
            "actions": ACTION_CATALOG,
        }

    @app.get("/api/macros/status")
    async def macro_status() -> dict[str, Any]:
        return {
            "count": len(state.macro_store.list()),
            "players": [scheduler.status() for scheduler in state.macro_schedulers],
        }

    @app.get("/api/macros/conflicts")
    async def macro_conflicts() -> dict[str, Any]:
        return {"conflicts": state.macro_store.conflicts()}

    @app.get("/api/macros")
    async def list_macros() -> list[dict[str, Any]]:
        return [macro.model_dump() for macro in state.macro_store.list()]

    @app.post("/api/macros")
    async def create_macro(body: MacroCreateRequest) -> dict[str, Any]:
        try:
            macro = state.macro_store.create(body.name, body.source_id, preset_ids=body.preset_ids)
            state.reload_macros()
            return macro.model_dump()
        except (KeyError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/macros/import")
    async def import_macro(request: Request) -> dict[str, Any]:
        try:
            macro = state.macro_store.import_payload(await request.json())
            state.reload_macros()
            return macro.model_dump()
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.put("/api/macros/{macro_id}")
    async def save_macro(macro_id: str, macro: MacroDefinition) -> dict[str, Any]:
        if macro.id != macro_id:
            raise HTTPException(400, "macro id cannot be changed")
        try:
            saved = state.macro_store.save(macro)
            state.reload_macros()
            return saved.model_dump()
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/macros/{macro_id}/rename")
    async def rename_macro(macro_id: str, body: MacroRenameRequest) -> dict[str, Any]:
        try:
            saved = state.macro_store.rename(macro_id, body.name)
            state.reload_macros()
            return saved.model_dump()
        except KeyError:
            raise HTTPException(404, "macro not found") from None
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.delete("/api/macros/{macro_id}")
    async def delete_macro(macro_id: str) -> dict[str, bool]:
        try:
            for scheduler in state.macro_schedulers:
                scheduler.cancel_macro(macro_id, "宏已删除")
            state.macro_store.delete(macro_id)
            state.reload_macros()
        except KeyError:
            raise HTTPException(404, "macro not found") from None
        return {"ok": True}

    @app.get("/api/macros/{macro_id}/export")
    async def export_macro(macro_id: str) -> dict[str, Any]:
        try:
            return state.macro_store.get(macro_id).model_dump()
        except KeyError:
            raise HTTPException(404, "macro not found") from None

    @app.post("/api/macros/{macro_id}/trigger")
    async def trigger_macro(macro_id: str, body: MacroTriggerRequest) -> dict[str, Any]:
        result = state.macro_schedulers[body.slot].trigger(macro_id, source="manual")
        if not result.get("accepted") and result.get("reason") == "宏不存在":
            raise HTTPException(404, "macro not found")
        return result

    @app.post("/api/macros/{macro_id}/cancel")
    async def cancel_macro(macro_id: str, body: MacroTriggerRequest) -> dict[str, bool]:
        try:
            state.macro_store.get(macro_id)
        except KeyError:
            raise HTTPException(404, "macro not found") from None
        state.macro_schedulers[body.slot].cancel_macro(macro_id, "用户取消")
        return {"ok": True}

    @app.post("/api/mappings/select")
    async def select_mapping_legacy(body: SelectRequest) -> dict[str, Any]:
        return await select_player_mapping(SlotSelectRequest(slot=0, id=body.id))

    @app.post("/api/players/mapping")
    async def select_player_mapping(body: SlotSelectRequest) -> dict[str, Any]:
        try:
            state.select_mapping(body.slot, body.id)
        except (KeyError, ValueError):
            raise HTTPException(404, "mapping not found") from None
        return state.status()

    @app.get("/api/algorithm-tests/projects")
    async def algorithm_test_projects() -> dict[str, Any]:
        return {
            "projects": [{"id": key, **value} for key, value in ALGORITHM_LAB_PROJECTS.items()],
            "candidate_presets": [{"id": key, "name": value["name"]} for key, value in ALGORITHM_LAB_PRESETS.items()],
            "storage_path": str(state.algorithm_lab_store.root.resolve()),
            "limits": {"max_sessions": state.algorithm_lab_store.max_sessions, "max_bytes": state.algorithm_lab_store.max_bytes},
        }

    @app.get("/api/algorithm-tests/sessions")
    async def list_algorithm_test_sessions() -> dict[str, Any]:
        return {
            "sessions": state.algorithm_lab_store.list_sessions(),
            "storage_path": str(state.algorithm_lab_store.root.resolve()),
        }

    @app.post("/api/algorithm-tests/start")
    async def start_algorithm_test(request: Request) -> dict[str, Any]:
        payload = await request.json()
        try:
            return state.start_algorithm_lab(
                project=str(payload.get("project_id", "")),
                slot=int(payload.get("slot", 0)),
                repetitions=int(payload.get("repetitions", 5)),
                candidate_preset=str(payload.get("candidate_preset", "stable")),
            )
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/api/algorithm-tests/active")
    async def active_algorithm_test() -> dict[str, Any]:
        return state.algorithm_lab_status()

    @app.post("/api/algorithm-tests/stop")
    async def stop_algorithm_test() -> dict[str, Any]:
        try:
            return public_algorithm_session(state.finish_algorithm_lab())
        except RuntimeError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/api/algorithm-tests/sessions/{session_id}")
    async def get_algorithm_test_session(session_id: str) -> dict[str, Any]:
        try:
            return public_algorithm_session(state.algorithm_lab_store.load(session_id))
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.patch("/api/algorithm-tests/sessions/{session_id}")
    async def rename_algorithm_test_session(session_id: str, request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
            return public_algorithm_session(state.algorithm_lab_store.rename(session_id, str(payload.get("name", ""))))
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.delete("/api/algorithm-tests/sessions/{session_id}")
    async def delete_algorithm_test_session(session_id: str) -> dict[str, bool]:
        try:
            if not state.algorithm_lab_store.delete(session_id):
                raise HTTPException(404, "找不到算法测试会话")
            return {"ok": True}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/algorithm-tests/sessions/{session_id}/replay")
    async def replay_algorithm_test_session(session_id: str, request: Request) -> dict[str, Any]:
        if state.algorithm_lab_active:
            raise HTTPException(409, "请先结束正在进行的真人测试")
        try:
            payload = await request.json()
            preset = str(payload.get("candidate_preset", "stable"))
            session = state.algorithm_lab_store.load(session_id)
            state._release_algorithm_outputs()
            comparison = state._compare_algorithm_session(session, preset)
            session.setdefault("metadata", {})["candidate_preset"] = preset
            session["comparison"] = state._compact_algorithm_comparison(comparison)
            state.algorithm_lab_store.save(session)
            return public_algorithm_session(session)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/algorithm-tests/sessions/{session_id}/events/{event_id}")
    async def algorithm_test_event_detail(session_id: str, event_id: str) -> dict[str, Any]:
        try:
            session = state.algorithm_lab_store.load(session_id)
            comparison = state._compare_algorithm_session(session)
            rows = merge_algorithm_timeline(comparison)
            index = int(event_id)
            if index < 0 or index >= len(rows):
                raise ValueError("事件编号无效")
            event = rows[index]
            at_ms = float(event.get("at_ms") or 0)
            variant = "current" if event.get("current", {}).get("error_type") not in {"success", "none"} else "candidate"
            replay_frames = comparison[variant].get("frame_results", [])
            source_frames = session.get("frames", [])
            nearby: list[dict[str, Any]] = []
            for frame_index, replayed in enumerate(replay_frames):
                offset = float(replayed.get("offset_ms") or 0)
                if abs(offset - at_ms) > 750:
                    continue
                source = source_frames[frame_index].get("pose_frame", {}) if frame_index < len(source_frames) else {}
                pose = source.get("pose") or []
                key_indices = (0, 11, 12, 15, 16, 23, 24, 25, 26, 27, 28)
                nearby.append({
                    "elapsed_ms": offset,
                    "sequence": replayed.get("sequence"),
                    "signals": replayed.get("signals", {}),
                    "raw_signals": replayed.get("raw_signals", {}),
                    "pose_landmarks": {str(i): pose[i] for i in key_indices if i < len(pose)},
                    "hands": source.get("hands", []),
                })
            return {"event": event, "expected": event.get("expected"), "frames": nearby, "window_ms": 750}
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/algorithm-tests/sessions/{session_id}/export/json")
    async def export_algorithm_test_json(session_id: str) -> FileResponse:
        try:
            path = state.algorithm_lab_store.export_json(session_id)
            return FileResponse(path, media_type="application/json", filename=f"motionbridge-lab-{session_id}.json")
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/api/algorithm-tests/sessions/{session_id}/export/csv")
    async def export_algorithm_test_csv(session_id: str) -> FileResponse:
        try:
            session = state.algorithm_lab_store.load(session_id)
            result = (session.get("comparison") or {}).get("candidate") or {}
            path = state.algorithm_lab_store.export_csv(session_id, result)
            return FileResponse(path, media_type="text/csv", filename=f"motionbridge-lab-{session_id}.csv")
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.post("/api/output/{action}")
    async def output_action(action: str) -> dict[str, Any]:
        if action not in {"enable", "disable"}:
            raise HTTPException(400, "action must be enable or disable")
        if action == "enable" and state.algorithm_lab_active:
            raise HTTPException(423, "算法测试处于影子模式，不能启用游戏输出")
        if action == "enable" and not any(state.selected_profile_ids):
            raise HTTPException(409, "create and calibrate a player first")
        for slot, router in enumerate(state.routers):
            router.set_enabled(action == "enable" and state.selected_profile_ids[slot] is not None)
        return state.status()

    @app.post("/api/voice/test")
    async def test_voice(request: Request) -> dict[str, object]:
        text = str((await request.json()).get("text", ""))
        mappings = [state.current_mapping(0), state.current_mapping(1)]
        count = 2 if state.run_mode == "double" else 1
        result = state.voice.apply_text(text, mappings, count)
        for slot in range(2):
            state.last_signals[slot] = state._compose_signals(slot, state.last_camera_signals[slot])
            state.mapping_engines[slot].process(state.last_signals[slot])
        return result

    @app.get("/api/overlay")
    async def overlay_status() -> dict[str, Any]:
        return state.overlay.status()

    @app.post("/api/overlay/toggle")
    async def overlay_toggle() -> dict[str, Any]:
        return state.overlay.toggle()

    @app.put("/api/overlay")
    async def overlay_settings(body: OverlaySettingsRequest) -> dict[str, Any]:
        return state.overlay.configure(**body.model_dump(exclude_none=True))

    @app.post("/api/shutdown")
    async def shutdown(request: Request) -> dict[str, bool]:
        if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
            raise HTTPException(403, "退出软件只能在本机操作")
        state.close()

        async def stop_process() -> None:
            await asyncio.sleep(0.35)
            os.kill(os.getpid(), signal.SIGTERM)

        asyncio.create_task(stop_process())
        return {"ok": True}

    @app.websocket("/ws/input")
    async def input_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        accepted = 0
        try:
            while True:
                payload = await websocket.receive_json()
                message_type = payload.get("type")
                if message_type == "pose_frame":
                    processed = state.ingest_pose(PoseFrame.model_validate(payload))
                elif message_type == "pose_frame_v2":
                    processed = state.ingest_pose_v2(PoseFrameV2.model_validate(payload))
                elif message_type == "sensor_frame":
                    processed = state.ingest_sensor(SensorFrame.model_validate(payload))
                elif message_type == "clock_sync":
                    await websocket.send_json({"type": "clock_sync", "client_sent_ms": payload.get("client_sent_ms"), "server_ms": time.time() * 1000})
                    continue
                else:
                    await websocket.send_json({"type": "error", "message": "unknown input message"})
                    continue
                if processed:
                    accepted += 1
                if accepted and accepted % 15 == 0:
                    await websocket.send_json({
                        "type": "ack", "accepted": accepted, "calibration": state.recorder.status(),
                        "players": state.player_statuses(), "pose_visible": state.last_signals[0].get("pose_visible", False),
                        "pose_count": state.pose_count, "pose_frames_with_people": state.pose_frames_with_people,
                    })
        except WebSocketDisconnect:
            return
        except Exception as exc:
            try:
                await websocket.send_json({"type": "error", "message": str(exc)})
            except RuntimeError:
                pass

    @app.websocket("/ws/audio")
    async def audio_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        try:
            hello = await websocket.receive_json()
            if (hello.get("type") != "audio_start" or int(hello.get("sample_rate", 0)) != 16_000
                    or int(hello.get("channels", 0)) != 1 or str(hello.get("format", "")).lower() not in {"pcm16", "pcm16le"}):
                await websocket.send_json({"type": "error", "message": "音频必须是 16kHz 单声道 PCM16"})
                await websocket.close(code=1003)
                return
            mappings = state.mapping_store.list()
            model_path = PROJECT_ROOT / "models" / "vosk-model-small-cn-0.22"
            if not model_path.exists():
                model_path = state.data_root / "models" / "vosk-model-small-cn-0.22"
            recognizer = VoskStreamRecognizer(model_path, grammar_phrases(mappings))
            diagnostics = AudioStreamDiagnostics()
            state.voice.connect(str(hello.get("device_id", "unknown-audio")))
            state.voice_link_state = "connected"
            state.voice_audio_status = {
                **diagnostics.status(), "channel_connected": True, "capture_source": hello.get("source", "unknown"),
                "input_sample_rate": hello.get("input_sample_rate"), "partial": "", "final": "", "last_command": None,
            }
            state.voice_audio_status.update({
                "recognizer_mode": recognizer.mode,
                "grammar_count": recognizer.grammar_count,
                "unsupported_phrase_count": recognizer.unsupported_phrase_count,
            })
            await websocket.send_json({
                "type": "audio_ready", "sample_rate": 16_000, "channels": 1, "format": "pcm16le",
                "recognizer_mode": recognizer.mode, "grammar_count": recognizer.grammar_count,
                "unsupported_phrase_count": recognizer.unsupported_phrase_count,
            })
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                if message.get("bytes") is None:
                    continue
                pcm16 = message["bytes"]
                rms = diagnostics.ingest(pcm16)
                audio_status = diagnostics.status()
                state.voice_link_state = "enabled" if audio_status["audio_active"] else ("silent" if audio_status["stream_alive"] else "connected")
                state.voice_audio_status.update(audio_status)
                if diagnostics.chunks_received == 1 or diagnostics.chunks_received % 4 == 0:
                    await websocket.send_json({"type": "audio_level", "rms": round(rms, 1), **audio_status})
                recognition = recognizer.accept(pcm16)
                if not recognition:
                    continue
                text, kind = recognition["text"], recognition["kind"]
                state.voice_audio_status[kind] = text
                if kind == "partial":
                    state.voice.set_partial(text)
                    await websocket.send_json({"type": "voice_partial", "text": text})
                    continue
                state.voice.set_final(text)
                current = [state.current_mapping(0), state.current_mapping(1)]
                result = state.voice.apply_text(text, current, 2 if state.run_mode == "double" else 1)
                if result.get("ok"):
                    state.voice_audio_status["last_command"] = result.get("command")
                for slot in range(2):
                    state.last_signals[slot] = state._compose_signals(slot, state.last_camera_signals[slot])
                    state.mapping_engines[slot].process(state.last_signals[slot])
                    state.update_macro_sources(slot, voice=state.voice.signals(slot))
                await websocket.send_json({"type": "voice_final", "text": text})
                await websocket.send_json({"type": "voice_result", "text": text, **result})
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            state.voice_link_state = "failed"
            try:
                await websocket.send_json({"type": "error", "message": str(exc)})
            except RuntimeError:
                pass
        finally:
            state.voice.disconnect()
            state.voice_link_state = "not_connected"
            state.voice_audio_status.update({
                "channel_connected": False, "stream_alive": False, "audio_active": False, "silence": False,
            })
            for slot in range(2):
                state.macro_schedulers[slot].cancel_source("voice", "语音断开")
                state.intent_engines[slot].disconnect("voice")
                state.mapping_engines[slot].neutralize()

    desktop_dir = PROJECT_ROOT / "desktop"
    mobile_dist = PROJECT_ROOT / "mobile" / "dist"
    mobile_fallback = PROJECT_ROOT / "mobile" / "fallback"
    app.mount("/assets", StaticFiles(directory=desktop_dir / "assets"), name="desktop-assets")
    app.mount("/phone", StaticFiles(directory=mobile_dist if mobile_dist.exists() else mobile_fallback, html=True), name="phone")

    @app.get("/")
    async def desktop_index() -> FileResponse:
        return FileResponse(desktop_dir / "index.html")

    return app


app = create_app()
