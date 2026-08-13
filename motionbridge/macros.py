from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


MacroTargetKind = Literal["keyboard", "gamepad_button", "gamepad_axis"]
MacroStepKind = Literal[
    "tap", "down", "up", "hold", "toggle", "chord", "sequence",
    "delay", "axis", "axis_ramp",
]
MacroTriggerSource = Literal["action", "voice", "region", "handheld"]
MacroActivation = Literal["rising", "falling", "while_active"]
MacroRepeatPolicy = Literal["ignore", "restart", "queue"]
MacroMutexPolicy = Literal["cancel_existing", "reject_new"]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MacroControl(BaseModel):
    kind: MacroTargetKind
    control: str = Field(min_length=1, max_length=40)

    @field_validator("control")
    @classmethod
    def normalize_control(cls, value: str) -> str:
        return value.strip().upper()

    @property
    def key(self) -> tuple[str, str]:
        return self.kind, self.control


class MacroStep(BaseModel):
    """One editor-friendly macro operation.

    A sequence is recursively flattened by the runtime.  Timed operations are
    advanced by ``tick`` and never sleep on the server thread.
    """

    type: MacroStepKind
    target: MacroControl | None = None
    targets: list[MacroControl] = Field(default_factory=list, max_length=16)
    steps: list["MacroStep"] = Field(default_factory=list, max_length=128)
    duration_ms: int = Field(default=0, ge=0, le=60_000)
    value: float | None = Field(default=None, ge=-1.0, le=1.0)
    from_value: float | None = Field(default=None, ge=-1.0, le=1.0)

    @model_validator(mode="after")
    def validate_shape(self) -> "MacroStep":
        digital = {"tap", "down", "up", "hold", "toggle"}
        if self.type in digital:
            if self.target is None or self.target.kind == "gamepad_axis":
                raise ValueError(f"{self.type} 需要键盘或手柄按键目标")
        elif self.type in {"axis", "axis_ramp"}:
            if self.target is None or self.target.kind != "gamepad_axis":
                raise ValueError(f"{self.type} 需要手柄摇杆目标")
            if self.value is None:
                raise ValueError(f"{self.type} 需要目标值")
            if self.type == "axis_ramp" and self.duration_ms <= 0:
                raise ValueError("摇杆渐变时间必须大于 0")
        elif self.type == "chord":
            if len(self.targets) < 2 or any(target.kind == "gamepad_axis" for target in self.targets):
                raise ValueError("同时组合至少需要两个键盘或手柄按键")
            if len({target.key for target in self.targets}) != len(self.targets):
                raise ValueError("同时组合不能包含重复按键")
        elif self.type == "sequence":
            if not self.steps:
                raise ValueError("顺序步骤不能为空")
        elif self.type == "delay" and self.duration_ms <= 0:
            raise ValueError("延时必须大于 0")
        if self.type == "hold" and self.duration_ms <= 0:
            raise ValueError("保持时间必须大于 0")
        return self


MacroStep.model_rebuild()


class MacroTrigger(BaseModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    source: MacroTriggerSource
    signal: str = Field(min_length=1, max_length=120)
    activation: MacroActivation = "rising"
    threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    release_threshold: float = Field(default=0.25, ge=0.0, le=1.0)
    direction: Literal["positive", "negative", "absolute"] = "positive"
    release_cancels: bool = False
    enabled: bool = True

    @model_validator(mode="after")
    def validate_thresholds(self) -> "MacroTrigger":
        if self.release_threshold > self.threshold:
            raise ValueError("释放阈值不能高于触发阈值")
        return self


class MacroDefinition(BaseModel):
    version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    enabled: bool = True
    preset_ids: list[str] = Field(default_factory=list, max_length=32)
    triggers: list[MacroTrigger] = Field(default_factory=list, max_length=32)
    steps: list[MacroStep] = Field(default_factory=list, max_length=128)
    repeat_policy: MacroRepeatPolicy = "ignore"
    max_queue: int = Field(default=1, ge=0, le=20)
    cooldown_ms: int = Field(default=0, ge=0, le=60_000)
    mutex_group: str | None = Field(default=None, max_length=80)
    mutex_policy: MacroMutexPolicy = "cancel_existing"
    output_priority: int = Field(default=100, ge=1, le=1000)
    updated_at: str = Field(default_factory=_utc_now)

    @model_validator(mode="after")
    def validate_tree(self) -> "MacroDefinition":
        trigger_ids = [trigger.id for trigger in self.triggers]
        if len(trigger_ids) != len(set(trigger_ids)):
            raise ValueError("宏内触发器 ID 不能重复")
        count = 0

        def visit(steps: list[MacroStep], depth: int) -> None:
            nonlocal count
            if depth > 8:
                raise ValueError("顺序嵌套不能超过 8 层")
            for step in steps:
                count += 1
                if count > 256:
                    raise ValueError("宏最多包含 256 个展开步骤")
                if step.type == "sequence":
                    visit(step.steps, depth + 1)

        visit(self.steps, 1)
        return self


class MacroCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    source_id: str | None = None
    preset_ids: list[str] = Field(default_factory=list, max_length=32)


class MacroRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class MacroTriggerRequest(BaseModel):
    slot: int = Field(default=0, ge=0, le=1)


# Shipped examples stay disabled: they are safe editor starting points, not
# claims about one immutable in-game key layout.
DEFAULT_MACROS: tuple[MacroDefinition, ...] = (
    MacroDefinition(
        id="fh4-pause-example",
        name="地平线4：暂停（示例）",
        description="默认关闭；请先在游戏控制设置中核对 START 对应操作。",
        enabled=False,
        preset_ids=["forza-horizon-4-motion"],
        triggers=[MacroTrigger(id="voice-pause", source="voice", signal="intent_pause")],
        steps=[MacroStep(type="tap", target=MacroControl(kind="gamepad_button", control="START"), duration_ms=90)],
        cooldown_ms=650,
    ),
    MacroDefinition(
        id="wukong-staff-spin-example",
        name="黑神话：棍花按住（示例）",
        description="默认关闭；按住时长和按键仅作可编辑起点，需在游戏内核对。",
        enabled=False,
        preset_ids=["black-myth-wukong-motion"],
        triggers=[MacroTrigger(
            id="voice-staff-spin", source="voice", signal="intent_staff_spin",
            release_cancels=True,
        )],
        steps=[MacroStep(type="axis", target=MacroControl(kind="gamepad_axis", control="LT"), value=1.0, duration_ms=650)],
        repeat_policy="restart",
        mutex_group="wukong-attack",
    ),
    MacroDefinition(
        id="wukong-dodge-light-example",
        name="黑神话：闪避后轻击（示例）",
        description="默认关闭；这是可撤销的 Xbox 顺序示例，具体键位未经实玩保证。",
        enabled=False,
        preset_ids=["black-myth-wukong-motion"],
        triggers=[MacroTrigger(id="action-combo", source="action", signal="intent_dodge_light")],
        steps=[
            MacroStep(type="tap", target=MacroControl(kind="gamepad_button", control="B"), duration_ms=75),
            MacroStep(type="delay", duration_ms=110),
            MacroStep(type="tap", target=MacroControl(kind="gamepad_button", control="X"), duration_ms=80),
        ],
        cooldown_ms=700,
        mutex_group="wukong-attack",
    ),
)


class MacroStore:
    """Atomic JSON persistence used by both the API and portable data folder."""

    def __init__(self, root: Path, *, install_defaults: bool = True) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        if install_defaults:
            for macro in DEFAULT_MACROS:
                if not self._path(macro.id).exists():
                    self.save(macro.model_copy(deep=True))

    def list(self) -> list[MacroDefinition]:
        with self._lock:
            result: list[MacroDefinition] = []
            for path in sorted(self.root.glob("*.json")):
                try:
                    result.append(MacroDefinition.model_validate_json(path.read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    continue
            return result

    def get(self, macro_id: str) -> MacroDefinition:
        path = self._path(macro_id)
        if not path.exists():
            raise KeyError(macro_id)
        return MacroDefinition.model_validate_json(path.read_text(encoding="utf-8"))

    def save(self, macro: MacroDefinition) -> MacroDefinition:
        with self._lock:
            saved = macro.model_copy(deep=True)
            saved.updated_at = _utc_now()
            self._atomic_write(self._path(saved.id), saved.model_dump_json(indent=2))
            return self.get(saved.id)

    def create(self, name: str, source_id: str | None = None, *, preset_ids: list[str] | None = None) -> MacroDefinition:
        if source_id:
            macro = self.get(source_id).model_copy(deep=True)
        else:
            macro = MacroDefinition(id="new", name=name, enabled=False, preset_ids=list(preset_ids or []))
        macro.id = f"macro-{uuid.uuid4().hex[:12]}"
        macro.name = name
        if preset_ids is not None:
            macro.preset_ids = list(preset_ids)
        return self.save(macro)

    def copy(self, macro_id: str, name: str) -> MacroDefinition:
        return self.create(name, macro_id)

    def rename(self, macro_id: str, name: str) -> MacroDefinition:
        macro = self.get(macro_id)
        macro.name = name
        return self.save(macro)

    def delete(self, macro_id: str) -> None:
        with self._lock:
            path = self._path(macro_id)
            if not path.exists():
                raise KeyError(macro_id)
            path.unlink()

    def import_payload(self, payload: dict[str, Any]) -> MacroDefinition:
        macro = MacroDefinition.model_validate(payload)
        if self._path(macro.id).exists():
            macro.id = f"{macro.id}-import-{uuid.uuid4().hex[:6]}"
        return self.save(macro)

    def export(self, macro_id: str) -> str:
        return self.get(macro_id).model_dump_json(indent=2)

    def conflicts(self, macro_id: str | None = None) -> list[dict[str, str]]:
        """Return editor warnings without forbidding deliberate fan-out."""
        macros = [macro for macro in self.list() if macro.enabled]
        warnings: list[dict[str, str]] = []
        entries = [
            (macro, trigger)
            for macro in macros
            for trigger in macro.triggers
            if trigger.enabled
        ]
        for index, (left_macro, left) in enumerate(entries):
            for right_macro, right in entries[index + 1:]:
                if (left.source, left.signal, left.activation) != (right.source, right.signal, right.activation):
                    continue
                left_presets, right_presets = set(left_macro.preset_ids), set(right_macro.preset_ids)
                if left_presets and right_presets and left_presets.isdisjoint(right_presets):
                    continue
                if macro_id and macro_id not in {left_macro.id, right_macro.id}:
                    continue
                warnings.append({
                    "kind": "trigger",
                    "macro_id": left_macro.id,
                    "other_macro_id": right_macro.id,
                    "message": f"触发冲突：{left.source} → {left.signal} 同时启动两个宏",
                })
        return warnings

    def _path(self, macro_id: str) -> Path:
        if not macro_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in macro_id):
            raise ValueError("invalid macro id")
        return self.root / f"{macro_id}.json"

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


@dataclass
class _Invocation:
    macro_id: str
    source: str
    trigger_key: str | None
    requested_at: float


@dataclass
class _Run:
    id: str
    macro: MacroDefinition
    source: str
    trigger_key: str | None
    owner: str
    steps: tuple[MacroStep, ...]
    started_at: float
    step_index: int = 0
    phase: str = "ready"
    wait_until: float = 0.0
    phase_targets: tuple[MacroControl, ...] = ()
    ramp_started_at: float = 0.0
    ramp_from: float = 0.0
    axis_values: dict[str, float] = field(default_factory=dict)


class MacroScheduler:
    """Deterministic, non-blocking macro state machine for one player slot."""

    SOURCE_ALIASES = {"camera": "action", "model": "action", "sensor": "handheld"}

    def __init__(
        self,
        router: Any,
        store: MacroStore | None = None,
        *,
        player_slot: int = 0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.router = router
        self.store = store
        self.player_slot = player_slot
        self.clock = clock
        self.selected_preset_id: str | None = None
        self._macros: dict[str, MacroDefinition] = {}
        self._active: dict[str, _Run] = {}
        self._queues: dict[str, deque[_Invocation]] = {}
        self._cooldown_until: dict[str, float] = {}
        self._source_values: dict[str, dict[str, float | bool]] = {}
        self._trigger_active: dict[str, bool] = {}
        self._persistent: dict[str, tuple[str, str, str | None]] = {}
        self._last_event: dict[str, Any] = {"state": "idle", "reason": None}
        self._lock = threading.RLock()
        self.reload(cancel_running=False)

    def reload(self, *, cancel_running: bool = True) -> None:
        with self._lock:
            if cancel_running:
                self.cancel_all("宏配置已更新")
            self._macros = {macro.id: macro for macro in (self.store.list() if self.store else [])}

    def load(self, macros: list[MacroDefinition], *, cancel_running: bool = True) -> None:
        with self._lock:
            if cancel_running:
                self.cancel_all("宏配置已更新")
            self._macros = {macro.id: macro.model_copy(deep=True) for macro in macros}

    def set_preset(self, preset_id: str | None) -> None:
        with self._lock:
            if preset_id != self.selected_preset_id:
                self.cancel_all("切换游戏预设")
                self.selected_preset_id = preset_id

    def trigger(
        self,
        macro_id: str,
        *,
        source: str = "manual",
        trigger_key: str | None = None,
        now: float | None = None,
    ) -> dict[str, Any]:
        at = self.clock() if now is None else now
        with self._lock:
            macro = self._macros.get(macro_id)
            if macro is None:
                return self._reject(macro_id, "宏不存在")
            if not macro.enabled:
                return self._reject(macro_id, "宏未启用")
            if macro.preset_ids and self.selected_preset_id not in macro.preset_ids:
                return self._reject(macro_id, "宏不适用于当前预设")
            if not macro.steps:
                return self._reject(macro_id, "宏没有执行步骤")
            if self.player_slot == 1 and self._contains_keyboard(macro.steps):
                return self._reject(macro_id, "二号玩家禁止输出键盘")
            if at < self._cooldown_until.get(macro.id, 0.0):
                return self._reject(macro_id, "宏处于冷却时间")

            same = [run for run in self._active.values() if run.macro.id == macro.id]
            if same and macro.repeat_policy == "ignore":
                return self._reject(macro_id, "宏正在执行，已忽略重复触发")
            if same and macro.repeat_policy == "queue":
                queue = self._queues.setdefault(macro.id, deque())
                if len(queue) >= macro.max_queue:
                    return self._reject(macro_id, "宏等待队列已满")
                queue.append(_Invocation(macro.id, source, trigger_key, at))
                self._cooldown_until[macro.id] = at + macro.cooldown_ms / 1000.0
                self._last_event = {"state": "queued", "macro_id": macro.id, "reason": None}
                return {"accepted": True, "state": "queued", "macro_id": macro.id}
            if same and macro.repeat_policy == "restart":
                self.cancel_macro(macro.id, "重复触发重新开始", include_persistent=False)

            conflicts = self._mutex_conflicts(macro)
            if conflicts and macro.mutex_policy == "reject_new":
                return self._reject(macro_id, "互斥组已有宏正在执行")
            for conflict_id in conflicts:
                self.cancel_macro(conflict_id, f"被互斥宏 {macro.name} 取消")

            run = self._start(_Invocation(macro.id, source, trigger_key, at), at)
            self._cooldown_until[macro.id] = at + macro.cooldown_ms / 1000.0
            self._advance(run, at)
            return {"accepted": True, "state": "running" if run.id in self._active else "completed", "macro_id": macro.id, "run_id": run.id}

    def update_source(self, source: MacroTriggerSource | str, values: dict[str, float | bool], *, now: float | None = None) -> None:
        self.update_sources({str(source): values}, now=now)

    def update_sources(self, sources: dict[str, dict[str, float | bool]], *, now: float | None = None) -> None:
        at = self.clock() if now is None else now
        with self._lock:
            for raw_source, values in sources.items():
                source = self.SOURCE_ALIASES.get(raw_source, raw_source)
                if source not in {"action", "voice", "region", "handheld"}:
                    continue
                self._source_values[source] = dict(values)
                self._evaluate_source(source, values, at)
            self.tick(now=at)

    def tick(self, *, now: float | None = None) -> None:
        at = self.clock() if now is None else now
        with self._lock:
            for run in list(self._active.values()):
                self._advance(run, at)
            for macro_id, queue in list(self._queues.items()):
                if queue and not any(run.macro.id == macro_id for run in self._active.values()):
                    invocation = queue.popleft()
                    run = self._start(invocation, at)
                    self._advance(run, at)
                if not queue:
                    self._queues.pop(macro_id, None)
            self.router.tick()

    def cancel_source(self, source: str, reason: str = "来源断开") -> None:
        normalized = self.SOURCE_ALIASES.get(source, source)
        with self._lock:
            for run in list(self._active.values()):
                if run.source == normalized:
                    self._cancel_run(run, reason)
            for macro_id, queue in list(self._queues.items()):
                self._queues[macro_id] = deque(item for item in queue if item.source != normalized)
                if not self._queues[macro_id]:
                    self._queues.pop(macro_id, None)
            for owner, (_, persistent_source, _) in list(self._persistent.items()):
                if persistent_source == normalized:
                    self.router.release_owner(owner)
                    self._persistent.pop(owner, None)
            self._source_values.pop(normalized, None)
            for key in [key for key in self._trigger_active if f":{normalized}:" in key]:
                self._trigger_active.pop(key, None)
            self._last_event = {"state": "cancelled", "reason": reason, "source": normalized}

    def cancel_macro(self, macro_id: str, reason: str = "用户取消", *, include_persistent: bool = True) -> None:
        with self._lock:
            for run in list(self._active.values()):
                if run.macro.id == macro_id:
                    self._cancel_run(run, reason)
            self._queues.pop(macro_id, None)
            if include_persistent:
                for owner, (persistent_macro, _, _) in list(self._persistent.items()):
                    if persistent_macro == macro_id:
                        self.router.release_owner(owner)
                        self._persistent.pop(owner, None)
            self._last_event = {"state": "cancelled", "macro_id": macro_id, "reason": reason}

    def cancel_all(self, reason: str = "全部取消") -> None:
        with self._lock:
            for run in list(self._active.values()):
                self._cancel_run(run, reason)
            self._queues.clear()
            for owner in list(self._persistent):
                self.router.release_owner(owner)
            self._persistent.clear()
            self._trigger_active.clear()
            self._source_values.clear()
            self._last_event = {"state": "cancelled", "reason": reason}

    def status(self) -> dict[str, Any]:
        with self._lock:
            now = self.clock()
            return {
                "selected_preset_id": self.selected_preset_id,
                "active": [
                    {
                        "run_id": run.id,
                        "macro_id": run.macro.id,
                        "name": run.macro.name,
                        "source": run.source,
                        "step_index": run.step_index,
                        "step_count": len(run.steps),
                        "state": run.phase,
                        "elapsed_ms": round(max(0.0, now - run.started_at) * 1000),
                    }
                    for run in self._active.values()
                ],
                "queued": {macro_id: len(queue) for macro_id, queue in self._queues.items() if queue},
                "toggles": [
                    {"owner": owner, "macro_id": info[0], "source": info[1]}
                    for owner, info in self._persistent.items()
                ],
                "last_event": dict(self._last_event),
            }

    def _evaluate_source(self, source: str, values: dict[str, float | bool], now: float) -> None:
        for macro in self._macros.values():
            if not macro.enabled or (macro.preset_ids and self.selected_preset_id not in macro.preset_ids):
                continue
            for trigger in macro.triggers:
                if not trigger.enabled or trigger.source != source:
                    continue
                state_key = f"{macro.id}:{source}:{trigger.id}"
                previous = self._trigger_active.get(state_key, False)
                raw = values.get(trigger.signal)
                if raw is None and trigger.signal.startswith(f"{source}:"):
                    raw = values.get(trigger.signal.split(":", 1)[1])
                number = float(raw) if isinstance(raw, (int, float)) else 0.0
                measured = -number if trigger.direction == "negative" else abs(number) if trigger.direction == "absolute" else number
                active = measured >= (trigger.release_threshold if previous else trigger.threshold)
                self._trigger_active[state_key] = active
                released = previous and not active
                if released and trigger.release_cancels and trigger.activation != "falling":
                    self._cancel_trigger(state_key, "触发来源已释放")
                fire = (
                    (trigger.activation == "rising" and active and not previous)
                    or (trigger.activation == "falling" and released)
                    or (trigger.activation == "while_active" and active)
                )
                if fire:
                    self.trigger(macro.id, source=source, trigger_key=state_key, now=now)

    def _cancel_trigger(self, trigger_key: str, reason: str) -> None:
        for run in list(self._active.values()):
            if run.trigger_key == trigger_key:
                self._cancel_run(run, reason)
        for macro_id, queue in list(self._queues.items()):
            self._queues[macro_id] = deque(item for item in queue if item.trigger_key != trigger_key)
            if not self._queues[macro_id]:
                self._queues.pop(macro_id, None)
        for owner, (_, _, persistent_trigger) in list(self._persistent.items()):
            if persistent_trigger == trigger_key:
                self.router.release_owner(owner)
                self._persistent.pop(owner, None)

    def _start(self, invocation: _Invocation, now: float) -> _Run:
        macro = self._macros[invocation.macro_id]
        run_id = uuid.uuid4().hex[:12]
        run = _Run(
            id=run_id,
            macro=macro,
            source=invocation.source,
            trigger_key=invocation.trigger_key,
            owner=f"macro:{self.player_slot}:{macro.id}:{run_id}",
            steps=tuple(self._flatten(macro.steps)),
            started_at=now,
        )
        self._active[run.id] = run
        self._last_event = {"state": "started", "macro_id": macro.id, "run_id": run.id, "reason": None}
        return run

    def _advance(self, run: _Run, now: float) -> None:
        operations = 0
        while run.id in self._active and operations < 512:
            operations += 1
            if run.phase == "waiting":
                if now < run.wait_until:
                    return
                for target in run.phase_targets:
                    self.router.release_control(run.owner, target.kind, target.control)
                run.phase_targets = ()
                run.phase = "ready"
                run.step_index += 1
                continue
            if run.phase == "ramping":
                step = run.steps[run.step_index]
                duration = max(step.duration_ms / 1000.0, 1e-9)
                progress = max(0.0, min(1.0, (now - run.ramp_started_at) / duration))
                value = run.ramp_from + (float(step.value) - run.ramp_from) * progress
                self.router.set_axis(step.target.control, value, owner=run.owner, priority=run.macro.output_priority)  # type: ignore[union-attr]
                run.axis_values[step.target.control] = value  # type: ignore[union-attr]
                if progress < 1.0:
                    return
                run.phase = "ready"
                run.step_index += 1
                continue
            if run.step_index >= len(run.steps):
                self.router.release_owner(run.owner)
                self._active.pop(run.id, None)
                self._last_event = {"state": "completed", "macro_id": run.macro.id, "run_id": run.id, "reason": None}
                return

            step = run.steps[run.step_index]
            if step.type == "delay":
                run.phase = "waiting"
                run.wait_until = now + step.duration_ms / 1000.0
                return
            if step.type in {"tap", "hold"}:
                self.router.set_digital(step.target.kind, step.target.control, True, "hold", owner=run.owner)  # type: ignore[union-attr]
                run.phase_targets = (step.target,)  # type: ignore[arg-type]
                run.phase = "waiting"
                run.wait_until = now + (step.duration_ms or 80) / 1000.0
                return
            if step.type == "down":
                self.router.set_digital(step.target.kind, step.target.control, True, "hold", owner=run.owner)  # type: ignore[union-attr]
                run.step_index += 1
                continue
            if step.type == "up":
                self.router.release_control(run.owner, step.target.kind, step.target.control)  # type: ignore[union-attr]
                run.step_index += 1
                continue
            if step.type == "toggle":
                self._toggle(run, step.target)  # type: ignore[arg-type]
                run.step_index += 1
                continue
            if step.type == "chord":
                for target in step.targets:
                    self.router.set_digital(target.kind, target.control, True, "hold", owner=run.owner)
                run.phase_targets = tuple(step.targets)
                run.phase = "waiting"
                run.wait_until = now + (step.duration_ms or 80) / 1000.0
                return
            if step.type == "axis":
                self.router.set_axis(step.target.control, float(step.value), owner=run.owner, priority=run.macro.output_priority)  # type: ignore[union-attr]
                run.axis_values[step.target.control] = float(step.value)  # type: ignore[union-attr,arg-type]
                if step.duration_ms:
                    run.phase_targets = (step.target,)  # type: ignore[arg-type]
                    run.phase = "waiting"
                    run.wait_until = now + step.duration_ms / 1000.0
                    return
                run.step_index += 1
                continue
            if step.type == "axis_ramp":
                run.ramp_from = float(step.from_value) if step.from_value is not None else run.axis_values.get(step.target.control, 0.0)  # type: ignore[union-attr]
                run.ramp_started_at = now
                run.phase = "ramping"
                continue
            # Sequence steps are flattened before execution.
            run.step_index += 1

    def _toggle(self, run: _Run, target: MacroControl) -> None:
        owner = f"macro-toggle:{self.player_slot}:{run.macro.id}:{target.kind}:{target.control}"
        if owner in self._persistent:
            self.router.release_owner(owner)
            self._persistent.pop(owner, None)
        else:
            self.router.set_digital(target.kind, target.control, True, "hold", owner=owner)
            self._persistent[owner] = (run.macro.id, run.source, run.trigger_key)

    def _cancel_run(self, run: _Run, reason: str) -> None:
        self.router.release_owner(run.owner)
        self._active.pop(run.id, None)
        self._last_event = {"state": "cancelled", "macro_id": run.macro.id, "run_id": run.id, "reason": reason}

    def _mutex_conflicts(self, macro: MacroDefinition) -> set[str]:
        if not macro.mutex_group:
            return set()
        active = {
            run.macro.id
            for run in self._active.values()
            if run.macro.mutex_group == macro.mutex_group and run.macro.id != macro.id
        }
        active.update(
            persistent_macro
            for persistent_macro, _, _ in self._persistent.values()
            if persistent_macro != macro.id
            and self._macros.get(persistent_macro)
            and self._macros[persistent_macro].mutex_group == macro.mutex_group
        )
        return active

    @staticmethod
    def _flatten(steps: list[MacroStep]):
        for step in steps:
            if step.type == "sequence":
                yield from MacroScheduler._flatten(step.steps)
            else:
                yield step

    @staticmethod
    def _contains_keyboard(steps: list[MacroStep]) -> bool:
        for step in MacroScheduler._flatten(steps):
            if step.target and step.target.kind == "keyboard":
                return True
            if any(target.kind == "keyboard" for target in step.targets):
                return True
        return False

    def _reject(self, macro_id: str, reason: str) -> dict[str, Any]:
        self._last_event = {"state": "rejected", "macro_id": macro_id, "reason": reason}
        return {"accepted": False, "state": "rejected", "macro_id": macro_id, "reason": reason}


def macro_catalog() -> dict[str, Any]:
    """Chinese labels for a visual editor; users never need to author JSON."""
    return {
        "sources": {
            "action": "人体动作", "voice": "语音命令",
            "region": "画面区域", "handheld": "手持按键",
        },
        "steps": {
            "tap": "单击", "down": "按下", "up": "释放", "hold": "保持",
            "toggle": "切换保持", "chord": "同时组合", "sequence": "顺序执行",
            "delay": "延时", "axis": "摇杆值", "axis_ramp": "摇杆渐变",
        },
        "repeat_policies": {
            "ignore": "执行中忽略", "restart": "重新开始", "queue": "排队执行",
        },
        "mutex_policies": {
            "cancel_existing": "取消同组旧宏", "reject_new": "拒绝新宏",
        },
        "notice": "宏只输出 Xbox 虚拟手柄或键盘输入，不执行系统命令；二号玩家禁止键盘输出。",
    }
