from __future__ import annotations

import csv
import inspect
import json
import math
import re
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, Protocol

from .models import PoseFrame


SCHEMA_VERSION = "motionbridge.algorithm-lab/1"
DEFAULT_SESSION_DIR = Path("data/algorithm-tests/sessions")
DEFAULT_MAX_SESSIONS = 30
DEFAULT_MAX_BYTES = 500 * 1024 * 1024

PROJECTS: dict[str, dict[str, str]] = {
    "still": {"name": "静止误触", "prompt": "保持静止"},
    "fist": {"name": "握拳", "prompt": "握拳"},
    "pinch": {"name": "捏合", "prompt": "拇指和食指捏合"},
    "fist_then_pinch": {"name": "握拳后立即捏合", "prompt": "先握拳，再立即捏合"},
    "squat": {"name": "下蹲", "prompt": "下蹲后站起"},
    "jump": {"name": "跳跃", "prompt": "向上跳跃"},
}

ACTION_SIGNALS: dict[str, tuple[str, ...]] = {
    "fist": ("left_fist", "right_fist"),
    "pinch": ("left_pinch", "right_pinch"),
    "squat": ("squat",),
    "jump": ("jump",),
}
TRACKED_ACTIONS = tuple(ACTION_SIGNALS)
CONFUSION_LABELS = ("fist", "pinch", "open_hand")
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class RecognizerLike(Protocol):
    def process(self, frame: PoseFrame) -> Mapping[str, Any]: ...

    def reset(self) -> None: ...


RecognizerFactory = Callable[..., RecognizerLike]
ReleaseCallback = Callable[[], None]


class ShadowModeViolation(RuntimeError):
    """Raised if code tries to dispatch a real output during a lab session."""


@dataclass
class ShadowModeGuard:
    """Output firewall for a lab run.

    The core lab never imports an output router.  A runtime integration can pass
    its ``release_all`` callback so held keys and axes are neutralized both
    before the first replayed frame and in ``finally`` on every exit path.
    """

    release_all: ReleaseCallback | None = None
    active: bool = field(default=False, init=False)

    def __enter__(self) -> ShadowModeGuard:
        if self.release_all is not None:
            self.release_all()
        self.active = True
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> bool:
        self.active = False
        if self.release_all is not None:
            self.release_all()
        return False

    def dispatch(self, *_args: Any, **_kwargs: Any) -> None:
        raise ShadowModeViolation("算法测试处于影子模式，禁止发送真实输入")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_guided_plan(
    project: str,
    repetitions: int = 3,
    *,
    countdown_ms: int = 3_000,
    prepare_ms: int = 800,
    action_ms: int = 1_800,
    rest_ms: int = 900,
) -> dict[str, Any]:
    """Build the compact Chinese countdown/action plan used by the UI."""

    if project not in PROJECTS:
        raise ValueError(f"未知测试项目: {project}")
    if not 1 <= repetitions <= 100:
        raise ValueError("测试次数必须在 1 到 100 之间")
    durations = (countdown_ms, prepare_ms, action_ms, rest_ms)
    if any(value < 0 for value in durations) or action_ms <= 0:
        raise ValueError("阶段时长不能为负数，动作阶段必须大于 0")

    stages: list[dict[str, Any]] = []
    cursor = 0

    def add(
        kind: str,
        duration: int,
        prompt: str,
        *,
        expected: str | None = None,
        trial_index: int | None = None,
        phase_index: int | None = None,
    ) -> None:
        nonlocal cursor
        stages.append({
            "id": f"stage-{len(stages) + 1}",
            "kind": kind,
            "prompt": prompt,
            "expected": expected,
            "trial_index": trial_index,
            "phase_index": phase_index,
            "start_offset_ms": cursor,
            "end_offset_ms": cursor + duration,
        })
        cursor += duration

    if countdown_ms:
        step = countdown_ms // 3
        remainder = countdown_ms - step * 3
        for index, value in enumerate(("3", "2", "1")):
            add("countdown", step + (remainder if index == 2 else 0), value)

    for trial_index in range(repetitions):
        add("prepare", prepare_ms, "准备", trial_index=trial_index)
        if project == "fist_then_pinch":
            first = max(1, action_ms // 2)
            second = max(1, action_ms - first)
            add(
                "action", first, "握拳", expected="fist",
                trial_index=trial_index, phase_index=0,
            )
            add(
                "action", second, "立即捏合", expected="pinch",
                trial_index=trial_index, phase_index=1,
            )
        else:
            expected = "still" if project == "still" else project
            add(
                "action", action_ms, PROJECTS[project]["prompt"], expected=expected,
                trial_index=trial_index, phase_index=0,
            )
        add("rest", rest_ms, "放松", trial_index=trial_index)

    return {
        "project": project,
        "project_name": PROJECTS[project]["name"],
        "repetitions": repetitions,
        "total_duration_ms": cursor,
        "stages": stages,
    }


@dataclass
class AlgorithmLabRecorder:
    """Records a genuine camera landmark stream without retaining raw video."""

    project: str
    repetitions: int = 3
    player_slot: int = 0
    name: str | None = None
    plan: dict[str, Any] | None = None
    source_recognizer: RecognizerLike | None = None
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    _started_at_ms: float | None = field(default=None, init=False)
    _frames: list[dict[str, Any]] = field(default_factory=list, init=False)

    def __post_init__(self) -> None:
        if self.project not in PROJECTS:
            raise ValueError(f"未知测试项目: {self.project}")
        if self.player_slot not in (0, 1):
            raise ValueError("玩家槽位只能是 0 或 1")
        if self.plan is None:
            self.plan = build_guided_plan(self.project, self.repetitions)
        else:
            self.plan = deepcopy(self.plan)

    @property
    def started_at_ms(self) -> float | None:
        return self._started_at_ms

    def start(self, received_at_ms: float | None = None) -> float:
        if self._started_at_ms is not None:
            raise RuntimeError("录制已经开始")
        self._started_at_ms = float(received_at_ms if received_at_ms is not None else time.time() * 1000)
        return self._started_at_ms

    def record_frame(
        self,
        frame: PoseFrame | Mapping[str, Any],
        *,
        received_at_ms: float | None = None,
        raw_signals: Mapping[str, Any] | None = None,
        live_signals: Mapping[str, Any] | None = None,
    ) -> None:
        pose_frame = frame if isinstance(frame, PoseFrame) else PoseFrame.model_validate(frame)
        received = float(received_at_ms if received_at_ms is not None else time.time() * 1000)
        if self._started_at_ms is None:
            self.start(received)
        if self._frames and received < self._frames[-1]["received_at_ms"]:
            raise ValueError("接收时间必须单调递增")
        if raw_signals is None and self.source_recognizer is not None:
            candidate = getattr(self.source_recognizer, "last_raw_signals", None)
            if isinstance(candidate, Mapping):
                raw_signals = candidate
        self._frames.append({
            "received_at_ms": received,
            "pose_frame": pose_frame.model_dump(mode="json"),
            "raw_signals": _json_mapping(raw_signals),
            "live_signals": _json_mapping(live_signals),
        })

    def finish(self, *, metadata: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if self._started_at_ms is None:
            self.start()
        now = utc_now()
        return {
            "schema_version": SCHEMA_VERSION,
            "id": self.session_id,
            "name": self.name or f"{PROJECTS[self.project]['name']} {now[:19]}",
            "created_at": now,
            "updated_at": now,
            "project": self.project,
            "project_name": PROJECTS[self.project]["name"],
            "player_slot": self.player_slot,
            "repetitions": self.repetitions,
            "recording_started_at_ms": self._started_at_ms,
            "plan": deepcopy(self.plan),
            "frames": deepcopy(self._frames),
            "metadata": dict(metadata or {}),
            "extensions": {
                "video_clips": [],
                "pcm16_audio": [],
                "sensor_frames": [],
                "multi_person_tracks": [],
            },
        }


def replay_session(
    session: Mapping[str, Any],
    parameters: Mapping[str, Any] | None = None,
    *,
    recognizer_factory: RecognizerFactory | None = None,
    release_all: ReleaseCallback | None = None,
) -> dict[str, Any]:
    """Replay saved PoseFrames directly into one isolated MotionRecognizer."""

    _validate_session(session)
    recognizer = _make_recognizer(recognizer_factory, dict(parameters or {}))
    if hasattr(recognizer, "reset"):
        recognizer.reset()

    frame_results: list[dict[str, Any]] = []
    started = float(session.get("recording_started_at_ms") or _first_received_at(session))
    guard = ShadowModeGuard(release_all)
    with guard, _recognizer_replay_clock(recognizer) as set_clock:
        for envelope in session.get("frames", []):
            frame = PoseFrame.model_validate(envelope["pose_frame"])
            received = float(envelope["received_at_ms"])
            set_clock(received / 1000.0)
            signals = dict(_call_process(recognizer, frame, received))
            raw = getattr(recognizer, "last_raw_signals", None)
            frame_results.append({
                "sequence": frame.sequence,
                "captured_at_ms": frame.captured_at_ms,
                "received_at_ms": received,
                "offset_ms": received - started,
                "signals": _json_mapping(signals),
                "raw_signals": _json_mapping(raw),
                "hand_count": len(frame.hands),
            })

    evaluation = evaluate_results(session, frame_results)
    evaluation.update({
        "parameters": dict(parameters or {}),
        "shadow_mode": True,
        "frame_count": len(frame_results),
        "frame_results": frame_results,
    })
    return evaluation


def compare_session(
    session: Mapping[str, Any],
    current_parameters: Mapping[str, Any] | None,
    candidate_parameters: Mapping[str, Any] | None,
    *,
    recognizer_factory: RecognizerFactory | None = None,
    release_all: ReleaseCallback | None = None,
) -> dict[str, Any]:
    """Run current and candidate settings against the exact same saved frames."""

    current = replay_session(
        session, current_parameters, recognizer_factory=recognizer_factory,
        release_all=release_all,
    )
    candidate = replay_session(
        session, candidate_parameters, recognizer_factory=recognizer_factory,
        release_all=release_all,
    )
    metric_names = (
        "success_count", "missed_count", "static_false_triggers",
        "duplicate_triggers", "average_latency_ms", "p95_latency_ms",
    )
    delta = {
        name: _number(candidate["metrics"].get(name)) - _number(current["metrics"].get(name))
        for name in metric_names
    }
    merged_timeline = [
        {"variant": variant, **deepcopy(item)}
        for variant, result in (("current", current), ("candidate", candidate))
        for item in result["timeline"]
    ]
    merged_timeline.sort(key=lambda item: (float(item["at_ms"]), str(item["variant"])))
    return {
        "session_id": session["id"],
        "current": current,
        "candidate": candidate,
        "delta_candidate_minus_current": delta,
        "timeline": merged_timeline,
        "same_input_frame_count": len(session.get("frames", [])),
        "shadow_mode": True,
    }


def evaluate_results(
    session: Mapping[str, Any],
    frame_results: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    frames = [dict(item) for item in frame_results]
    events = _rising_events(frames)
    action_stages = [
        dict(stage) for stage in session.get("plan", {}).get("stages", [])
        if stage.get("kind") == "action"
    ]
    trials: dict[int, list[dict[str, Any]]] = {}
    for stage in action_stages:
        trials.setdefault(int(stage.get("trial_index") or 0), []).append(stage)

    timeline: list[dict[str, Any]] = []
    trial_successes = 0
    missed_count = 0
    duplicate_triggers = 0
    static_false_triggers = 0
    latencies: list[float] = []

    for trial_index, stages in sorted(trials.items()):
        stages.sort(key=lambda item: float(item["start_offset_ms"]))
        trial_ok = True
        for stage in stages:
            expected = str(stage.get("expected") or "still")
            start = float(stage["start_offset_ms"])
            end = float(stage["end_offset_ms"])
            hits = [event for event in events if start <= float(event["offset_ms"]) <= end]
            expected_hits = [event for event in hits if event["action"] == expected]
            wrong_hits = [event for event in hits if event["action"] != expected]

            if expected == "still":
                static_false_triggers += len(hits)
                if hits:
                    trial_ok = False
                    for event in hits:
                        timeline.append(_timeline_entry(
                            trial_index, expected, event["action"], event["offset_ms"],
                            "static_false_trigger", stage,
                        ))
                else:
                    timeline.append(_timeline_entry(
                        trial_index, expected, None, start, "success", stage,
                    ))
                continue

            if not expected_hits:
                missed_count += 1
                trial_ok = False
                timeline.append(_timeline_entry(
                    trial_index, expected,
                    wrong_hits[0]["action"] if wrong_hits else None,
                    wrong_hits[0]["offset_ms"] if wrong_hits else end,
                    "wrong_action" if wrong_hits else "missed", stage,
                ))
            else:
                first = expected_hits[0]
                latency = max(0.0, float(first["offset_ms"]) - start)
                latencies.append(latency)
                timeline.append(_timeline_entry(
                    trial_index, expected, expected, first["offset_ms"], "success", stage,
                    latency_ms=latency,
                ))
                extras = expected_hits[1:]
                duplicate_triggers += len(extras)
                for event in extras:
                    timeline.append(_timeline_entry(
                        trial_index, expected, expected, event["offset_ms"],
                        "duplicate", stage,
                    ))
            for event in wrong_hits:
                trial_ok = False
                timeline.append(_timeline_entry(
                    trial_index, expected, event["action"], event["offset_ms"],
                    "wrong_action", stage,
                ))
        if trial_ok:
            trial_successes += 1

    # Triggers during countdown/prepare/rest are false activations too.  They
    # are shown on the timeline but only still-project action windows contribute
    # to the dedicated static_false_triggers headline metric.
    for event in events:
        if not any(
            float(stage["start_offset_ms"]) <= float(event["offset_ms"]) <= float(stage["end_offset_ms"])
            for stage in action_stages
        ):
            timeline.append({
                "trial_index": None,
                "expected": "none",
                "actual": event["action"],
                "at_ms": event["offset_ms"],
                "error_type": "outside_action_window",
                "stage_id": None,
                "latency_ms": None,
            })

    timeline.sort(key=lambda item: float(item["at_ms"]))
    total = int(session.get("repetitions") or len(trials))
    metrics = {
        "success_count": trial_successes,
        "total_count": total,
        "success_rate": (trial_successes / total) if total else 0.0,
        "missed_count": missed_count,
        "static_false_triggers": static_false_triggers,
        "duplicate_triggers": duplicate_triggers,
        "average_latency_ms": round(sum(latencies) / len(latencies), 3) if latencies else None,
        "p95_latency_ms": round(_percentile(latencies, 0.95), 3) if latencies else None,
    }
    return {
        "session_id": session["id"],
        "project": session["project"],
        "metrics": metrics,
        "timeline": timeline,
        "confusion_matrix": _confusion_matrix(action_stages, frames),
        "recognized_events": events,
    }


class AlgorithmLabStore:
    """Bounded local JSON store; calibration, profiles and mappings are untouched."""

    def __init__(
        self,
        root: str | Path = DEFAULT_SESSION_DIR,
        *,
        max_sessions: int = DEFAULT_MAX_SESSIONS,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        self.root = Path(root)
        self.max_sessions = max_sessions
        self.max_bytes = max_bytes
        if max_sessions < 1 or max_bytes < 1:
            raise ValueError("存储上限必须大于 0")
        self.root.mkdir(parents=True, exist_ok=True)

    def save(self, session: Mapping[str, Any]) -> Path:
        _validate_session(session)
        session_id = _validated_id(str(session["id"]))
        target = self.root / f"{session_id}.json"
        temporary = self.root / f".{session_id}.{uuid.uuid4().hex}.tmp"
        temporary.write_text(
            json.dumps(session, ensure_ascii=False, indent=2, allow_nan=False),
            encoding="utf-8",
        )
        if temporary.stat().st_size > self.max_bytes:
            temporary.unlink()
            raise ValueError("单个算法测试会话超过本地存储上限")
        temporary.replace(target)
        self._prune(protected=target)
        return target

    def list_sessions(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for path in self._session_paths():
            try:
                session = json.loads(path.read_text(encoding="utf-8"))
                items.append({
                    "id": session["id"],
                    "name": session.get("name", session["id"]),
                    "project": session.get("project"),
                    "project_name": session.get("project_name"),
                    "player_slot": session.get("player_slot", 0),
                    "repetitions": session.get("repetitions", 0),
                    "frame_count": len(session.get("frames", [])),
                    "created_at": session.get("created_at"),
                    "updated_at": session.get("updated_at"),
                    "size_bytes": path.stat().st_size,
                })
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return sorted(items, key=lambda item: str(item.get("created_at") or ""), reverse=True)

    def load(self, session_id: str) -> dict[str, Any]:
        path = self._path(session_id)
        if not path.is_file():
            raise FileNotFoundError(f"找不到算法测试会话: {session_id}")
        session = json.loads(path.read_text(encoding="utf-8"))
        _validate_session(session)
        return session

    def rename(self, session_id: str, name: str) -> dict[str, Any]:
        clean = name.strip()
        if not clean or len(clean) > 100:
            raise ValueError("会话名称长度必须为 1 到 100 个字符")
        session = self.load(session_id)
        session["name"] = clean
        session["updated_at"] = utc_now()
        self.save(session)
        return session

    def delete(self, session_id: str) -> bool:
        path = self._path(session_id)
        if not path.exists():
            return False
        path.unlink()
        return True

    def export_json(self, session_id: str, destination: str | Path | None = None) -> Path:
        session = self.load(session_id)
        target = self._export_path(session_id, "json", destination)
        target.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
        return target

    def export_csv(
        self,
        session_id: str,
        result: Mapping[str, Any],
        destination: str | Path | None = None,
    ) -> Path:
        self.load(session_id)
        target = self._export_path(session_id, "csv", destination)
        with target.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=[
                "session_id", "trial_index", "expected", "actual", "at_ms",
                "error_type", "latency_ms", "stage_id",
            ])
            writer.writeheader()
            for row in result.get("timeline", []):
                writer.writerow({"session_id": session_id, **{
                    key: row.get(key) for key in writer.fieldnames if key != "session_id"
                }})
        return target

    def _path(self, session_id: str) -> Path:
        return self.root / f"{_validated_id(session_id)}.json"

    def _export_path(self, session_id: str, suffix: str, destination: str | Path | None) -> Path:
        if destination is None:
            directory = self.root.parent / "exports"
            directory.mkdir(parents=True, exist_ok=True)
            return directory / f"{_validated_id(session_id)}.{suffix}"
        target = Path(destination)
        if target.exists() and target.is_dir():
            target = target / f"{_validated_id(session_id)}.{suffix}"
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def _session_paths(self) -> list[Path]:
        return [path for path in self.root.glob("*.json") if path.is_file()]

    def _prune(self, protected: Path) -> None:
        paths = sorted(self._session_paths(), key=lambda path: path.stat().st_mtime)
        total = sum(path.stat().st_size for path in paths)
        while len(paths) > self.max_sessions or total > self.max_bytes:
            victim = next((path for path in paths if path != protected), None)
            if victim is None:
                # One newly saved session may itself exceed the byte cap.  Keep
                # it usable and let the next save replace/prune around it.
                break
            size = victim.stat().st_size
            victim.unlink()
            paths.remove(victim)
            total -= size


def _make_recognizer(factory: RecognizerFactory | None, parameters: dict[str, Any]) -> RecognizerLike:
    if factory is None:
        from .recognizer import MotionRecognizer

        factory = MotionRecognizer
    try:
        factory_parameters = inspect.signature(factory).parameters.values()
        accepts_parameters = any(
            item.name == "parameters" or item.kind == inspect.Parameter.VAR_KEYWORD
            for item in factory_parameters
        )
    except (TypeError, ValueError):
        accepts_parameters = True
    if accepts_parameters:
        recognizer = factory(parameters=deepcopy(parameters))
    else:
        recognizer = factory()

    setter = getattr(recognizer, "set_parameters", None)
    if callable(setter):
        setter(deepcopy(parameters))
    elif hasattr(recognizer, "parameters"):
        existing = getattr(recognizer, "parameters")
        if isinstance(existing, dict):
            existing.clear()
            existing.update(deepcopy(parameters))
        else:
            try:
                setattr(recognizer, "parameters", deepcopy(parameters))
            except (AttributeError, TypeError):
                pass
    elif parameters:
        # Compatibility with the pre-parameters MotionRecognizer.  Dynamic
        # dataclasses accept this harmless metadata attribute; old behavior is
        # unchanged while recorded sessions stay replayable after the upgrade.
        try:
            setattr(recognizer, "parameters", deepcopy(parameters))
        except (AttributeError, TypeError):
            pass
    return recognizer


def _call_process(recognizer: RecognizerLike, frame: PoseFrame, received_at_ms: float) -> Mapping[str, Any]:
    process = recognizer.process
    try:
        parameters = inspect.signature(process).parameters
    except (TypeError, ValueError):
        parameters = {}
    if "replay_time_ms" in parameters:
        return process(frame, replay_time_ms=received_at_ms)  # type: ignore[call-arg]
    if "now_ms" in parameters:
        return process(frame, now_ms=received_at_ms)  # type: ignore[call-arg]
    return process(frame)


class _TimeProxy:
    def __init__(self, source: Any) -> None:
        self.source = source
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now

    def __getattr__(self, name: str) -> Any:
        return getattr(self.source, name)


_REPLAY_CLOCK_LOCK = threading.RLock()


@contextmanager
def _recognizer_replay_clock(recognizer: RecognizerLike) -> Iterator[Callable[[float], None]]:
    module = sys.modules.get(type(recognizer).__module__)
    should_patch = type(recognizer).__module__ == "motionbridge.recognizer" and module is not None
    if not should_patch:
        yield lambda _value: None
        return
    with _REPLAY_CLOCK_LOCK:
        original = getattr(module, "time")
        proxy = _TimeProxy(original)
        setattr(module, "time", proxy)
        try:
            yield lambda value: setattr(proxy, "now", value)
        finally:
            setattr(module, "time", original)


def _rising_events(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    previous = {action: False for action in TRACKED_ACTIONS}
    events: list[dict[str, Any]] = []
    for frame in frames:
        signals = frame.get("signals") or {}
        for action, aliases in ACTION_SIGNALS.items():
            active_aliases = [name for name in aliases if bool(signals.get(name, False))]
            active = bool(active_aliases)
            if active and not previous[action]:
                events.append({
                    "action": action,
                    "signal": active_aliases[0],
                    "offset_ms": float(frame["offset_ms"]),
                    "received_at_ms": float(frame["received_at_ms"]),
                    "sequence": frame.get("sequence"),
                    "raw_signals": deepcopy(frame.get("raw_signals") or {}),
                })
            previous[action] = active
    return events


def _confusion_matrix(
    action_stages: list[dict[str, Any]],
    frames: list[dict[str, Any]],
) -> dict[str, Any]:
    counts = {actual: {predicted: 0 for predicted in CONFUSION_LABELS} for actual in CONFUSION_LABELS}
    for stage in action_stages:
        expected = stage.get("expected")
        if expected == "still":
            actual = "open_hand"
        elif expected in ("fist", "pinch"):
            actual = str(expected)
        else:
            continue
        start = float(stage["start_offset_ms"])
        end = float(stage["end_offset_ms"])
        for frame in frames:
            offset = float(frame["offset_ms"])
            if not start <= offset <= end:
                continue
            signals = frame.get("signals") or {}
            if any(bool(signals.get(name, False)) for name in ACTION_SIGNALS["fist"]):
                predicted = "fist"
            elif any(bool(signals.get(name, False)) for name in ACTION_SIGNALS["pinch"]):
                predicted = "pinch"
            else:
                predicted = "open_hand"
            counts[actual][predicted] += 1
    return {
        "labels": list(CONFUSION_LABELS),
        "counts": counts,
        "unit": "frames",
    }


def _timeline_entry(
    trial_index: int,
    expected: str,
    actual: str | None,
    at_ms: float,
    error_type: str,
    stage: Mapping[str, Any],
    *,
    latency_ms: float | None = None,
) -> dict[str, Any]:
    return {
        "trial_index": trial_index,
        "expected": expected,
        "actual": actual,
        "at_ms": float(at_ms),
        "error_type": error_type,
        "stage_id": stage.get("id"),
        "latency_ms": latency_ms,
    }


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("percentile requires values")
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _validate_session(session: Mapping[str, Any]) -> None:
    if session.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("不支持的算法测试会话格式")
    _validated_id(str(session.get("id") or ""))
    project = session.get("project")
    if project not in PROJECTS:
        raise ValueError(f"未知测试项目: {project}")
    if not isinstance(session.get("frames", []), list):
        raise ValueError("frames 必须是列表")
    if not isinstance(session.get("plan", {}).get("stages", []), list):
        raise ValueError("plan.stages 必须是列表")


def _validated_id(value: str) -> str:
    if not _SAFE_ID.fullmatch(value):
        raise ValueError("无效的会话 ID")
    return value


def _first_received_at(session: Mapping[str, Any]) -> float:
    frames = session.get("frames", [])
    if not frames:
        return 0.0
    return float(frames[0]["received_at_ms"])


def _json_mapping(value: Mapping[str, Any] | None) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    # A JSON round trip also converts tuples and numpy-like scalar subclasses
    # accepted by the standard encoder into durable session data.
    try:
        return json.loads(json.dumps(dict(value), ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError):
        return {
            str(key): _simple_json_value(item)
            for key, item in value.items()
        }


def _simple_json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return [_simple_json_value(item) for item in value]
    if isinstance(value, Mapping):
        return {str(key): _simple_json_value(item) for key, item in value.items()}
    return str(value)


def _number(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) else 0.0


__all__ = [
    "ACTION_SIGNALS",
    "AlgorithmLabRecorder",
    "AlgorithmLabStore",
    "DEFAULT_MAX_BYTES",
    "DEFAULT_MAX_SESSIONS",
    "DEFAULT_SESSION_DIR",
    "PROJECTS",
    "SCHEMA_VERSION",
    "ShadowModeGuard",
    "ShadowModeViolation",
    "build_guided_plan",
    "compare_session",
    "evaluate_results",
    "replay_session",
]
