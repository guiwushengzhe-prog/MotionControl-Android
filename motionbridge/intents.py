from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


IntentKind = Literal["digital", "axis"]
IntentSemantics = Literal["press", "down", "release", "toggle", "value"]


@dataclass(frozen=True)
class InputIntent:
    source: str
    signal: str
    value: float | bool = True
    semantics: IntentSemantics = "value"
    timestamp_ms: float = 0.0

    @property
    def key(self) -> str:
        return f"{self.source}:{self.signal}"


@dataclass(frozen=True)
class IntentBinding:
    id: str
    control: str
    kind: IntentKind
    any_of: tuple[str, ...] = ()
    all_of: tuple[str, ...] = ()
    gates: tuple[str, ...] = ()
    priority: int = 0
    exclusive_group: str | None = None
    sensitivity: float = 1.0
    deadzone: float = 0.0
    invert: bool = False

    def __post_init__(self) -> None:
        if not self.any_of and not self.all_of:
            raise ValueError("binding requires any_of or all_of sources")
        if not 0.0 <= self.deadzone < 1.0:
            raise ValueError("deadzone must be in [0, 1)")


@dataclass
class IntentFrame:
    values: dict[str, float | bool]
    released_controls: set[str] = field(default_factory=set)
    emergency: bool = False
    reason: str | None = None


@dataclass
class _SourceState:
    source: str
    value: float | bool
    active: bool
    timestamp_ms: float


class InputIntentEngine:
    """Combines camera, regions, voice and handheld input before output routing."""

    EMERGENCY_SIGNAL = "system:emergency_stop"

    def __init__(self, bindings: list[IntentBinding] | None = None):
        self.bindings = list(bindings or [])
        self._sources: dict[str, _SourceState] = {}
        self._one_shot: set[str] = set()
        self._last_outputs: dict[str, float | bool] = {}

    def submit(self, intent: InputIntent) -> IntentFrame:
        key = intent.key
        previous = self._sources.get(key)
        if intent.semantics == "release":
            value: float | bool = False
            active = False
        elif intent.semantics == "toggle":
            active = not bool(previous and previous.active)
            value = active
        elif intent.semantics == "press":
            value = True
            active = True
            self._one_shot.add(key)
        elif intent.semantics == "down":
            value = True
            active = True
        else:
            value = intent.value
            active = bool(value) if isinstance(value, bool) else abs(float(value)) > 1e-9
        self._sources[key] = _SourceState(intent.source, value, active, intent.timestamp_ms)
        return self.evaluate()

    def replace_source(self, source: str, values: dict[str, float | bool], timestamp_ms: float = 0.0) -> IntentFrame:
        """Atomically replace one device/source frame before a single evaluation."""
        for key in [key for key, state in self._sources.items() if state.source == source]:
            self._sources.pop(key, None)
            self._one_shot.discard(key)
        for signal, value in values.items():
            active = bool(value) if isinstance(value, bool) else abs(float(value)) > 1e-9
            self._sources[f"{source}:{signal}"] = _SourceState(source, value, active, timestamp_ms)
        return self.evaluate()

    def evaluate(self) -> IntentFrame:
        emergency = self._sources.get(self.EMERGENCY_SIGNAL)
        if emergency and emergency.active:
            return self.release_all("紧急停止", emergency=True)

        candidates: list[tuple[IntentBinding, float | bool]] = []
        for binding in self.bindings:
            if not all(self._is_active(key) for key in binding.gates):
                continue
            any_active = any(self._is_active(key) for key in binding.any_of) if binding.any_of else True
            all_active = all(self._is_active(key) for key in binding.all_of) if binding.all_of else True
            if not any_active or not all_active:
                continue
            value = self._binding_value(binding)
            if binding.kind == "digital" and not bool(value):
                continue
            if binding.kind == "axis" and abs(float(value)) <= 1e-9:
                continue
            candidates.append((binding, value))

        # A higher-priority member owns an entire mutual-exclusion group.
        group_winners: dict[str, tuple[IntentBinding, float | bool]] = {}
        ungrouped: list[tuple[IntentBinding, float | bool]] = []
        for candidate in candidates:
            binding = candidate[0]
            if binding.exclusive_group is None:
                ungrouped.append(candidate)
                continue
            winner = group_winners.get(binding.exclusive_group)
            if winner is None or binding.priority > winner[0].priority:
                group_winners[binding.exclusive_group] = candidate

        selected = ungrouped + list(group_winners.values())
        outputs: dict[str, tuple[int, float | bool]] = {}
        for binding, value in selected:
            current = outputs.get(binding.control)
            if current is None or binding.priority > current[0]:
                outputs[binding.control] = (binding.priority, value)
            elif binding.priority == current[0] and binding.kind == "digital":
                outputs[binding.control] = (binding.priority, bool(current[1]) or bool(value))

        values = {control: value for control, (_, value) in outputs.items()}
        released = set(self._last_outputs) - set(values)
        for control in released:
            prior = self._last_outputs[control]
            values[control] = False if isinstance(prior, bool) else 0.0
        self._last_outputs = {control: value for control, value in values.items() if bool(value)}

        for key in self._one_shot:
            state = self._sources.get(key)
            if state:
                state.active = False
                state.value = False
        self._one_shot.clear()
        return IntentFrame(values=values, released_controls=released)

    def disconnect(self, source: str) -> IntentFrame:
        for key in [key for key, state in self._sources.items() if state.source == source]:
            self._sources.pop(key, None)
            self._one_shot.discard(key)
        return self.evaluate()

    def switch_preset(self, bindings: list[IntentBinding]) -> IntentFrame:
        frame = self.release_all("切换预设")
        self.bindings = list(bindings)
        return frame

    def exit(self) -> IntentFrame:
        return self.release_all("退出")

    def release_all(self, reason: str, *, emergency: bool = False) -> IntentFrame:
        controls = set(self._last_outputs)
        values = {
            control: False if isinstance(value, bool) else 0.0
            for control, value in self._last_outputs.items()
        }
        self._sources.clear()
        self._one_shot.clear()
        self._last_outputs.clear()
        return IntentFrame(values, controls, emergency=emergency, reason=reason)

    def _is_active(self, key: str) -> bool:
        state = self._sources.get(key)
        return bool(state and state.active)

    def _binding_value(self, binding: IntentBinding) -> float | bool:
        keys = tuple(dict.fromkeys(binding.any_of + binding.all_of))
        active = [self._sources[key].value for key in keys if self._is_active(key)]
        if binding.kind == "digital":
            return bool(active)
        # Boolean AND members are predicates (for example pose:tracked), not an
        # axis value.  Prefer real analog sources and only fall back to 1/0 when
        # the binding intentionally consists entirely of digital inputs.
        analog = [float(value) for value in active if not isinstance(value, bool)]
        raw = max(analog or [float(value) for value in active], key=abs, default=0.0)
        if abs(raw) <= binding.deadzone:
            return 0.0
        scaled = raw * binding.sensitivity * (-1.0 if binding.invert else 1.0)
        return max(-1.0, min(1.0, scaled))
