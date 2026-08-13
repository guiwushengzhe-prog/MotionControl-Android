from __future__ import annotations

import json
import math
import re
import struct
import threading
import time
from pathlib import Path
from typing import Callable

from .models import MappingProfile


DIRECTION_VALUES = {
    "left": (-1.0, 0.0), "right": (1.0, 0.0),
    "forward": (0.0, 1.0), "back": (0.0, -1.0),
    "forward_left": (-0.707, 0.707), "forward_right": (0.707, 0.707),
    "back_left": (-0.707, -0.707), "back_right": (0.707, -0.707),
}

# The command parser is strict, while the acoustic recognizer prefers a small
# runtime vocabulary when the installed Vosk model can represent enough command
# phrases. Unsupported phrases are filtered individually; if too few remain the
# recognizer falls back to open decoding instead of silently losing all speech.
COMMON_TEXT_ALIASES = {
    "体干": "体感", "体杆": "体感", "体敢": "体感", "体看": "体感",
    "一好": "一号", "医号": "一号", "二好": "二号", "爱号": "二号",
    "像左": "向左", "向佐": "向左", "像右": "向右", "向又": "向右",
    "开使": "开始", "开市": "开始", "跳月": "跳跃", "调跃": "跳跃",
    "停指": "停止", "亭止": "停止", "紧急停指": "紧急停止",
}

BUILTIN_COMMAND_PHRASES: dict[str, tuple[str, ...]] = {
    "start": ("开始", "启动", "继续"),
    "stop": ("停止", "结束"),
    "left": ("向左", "左移", "左"),
    "right": ("向右", "右移", "右"),
    "jump": ("跳跃", "跳一下"),
    "emergency_stop": ("紧急停止", "立即停止"),
}


def normalize_voice_text(text: str) -> str:
    compact = re.sub(r"[\s，。！？、,.!?：:；;\-—_（）()\[\]]", "", text).lower()
    for heard, intended in COMMON_TEXT_ALIASES.items():
        compact = compact.replace(heard, intended)
    return compact


class VoiceCommandParser:
    def parse(self, text: str, mapping: MappingProfile, player_count: int) -> tuple[int | None, str | None, str | None]:
        normalized = normalize_voice_text(text).replace("一号玩家", "一号").replace("二号玩家", "二号")
        wake = normalize_voice_text(mapping.voice.wake_word)
        if mapping.voice.wake_word_required and (not wake or wake not in normalized):
            return None, None, "缺少唤醒词"
        command_text = normalized.split(wake, 1)[1] if wake and wake in normalized else normalized
        slot: int | None = None
        if "一号" in command_text or "1号" in command_text:
            slot = 0
            command_text = command_text.replace("一号", "").replace("1号", "")
        elif "二号" in command_text or "2号" in command_text:
            slot = 1
            command_text = command_text.replace("二号", "").replace("2号", "")
        elif player_count > 1:
            return None, None, "双人模式请说一号或二号"
        else:
            slot = 0

        candidates: list[tuple[int, str]] = []
        phrase_sets = {command: list(phrases) for command, phrases in BUILTIN_COMMAND_PHRASES.items()}
        for command, phrases in mapping.voice.phrases.items():
            phrase_sets.setdefault(command, []).extend(phrases)
        for command, phrases in phrase_sets.items():
            for phrase in phrases:
                compact = normalize_voice_text(phrase)
                if compact and compact in command_text:
                    candidates.append((len(compact), command))
        if not candidates:
            return slot, None, "未识别到有效命令"
        candidates.sort(reverse=True)
        return slot, candidates[0][1], None


class VoiceController:
    def __init__(self, emergency_stop: Callable[[int], None]) -> None:
        self.parser = VoiceCommandParser()
        self.emergency_stop = emergency_stop
        self.connected = False
        self.device_id: str | None = None
        self.last_result = ""
        self.last_partial = ""
        self.last_final = ""
        self.last_command: str | None = None
        self.last_command_slot: int | None = None
        self.last_error: str | None = None
        self.last_command_at = 0.0
        self.command_enabled = [True, True]
        self.states = [self._empty_state(), self._empty_state()]
        self._pulse_until: list[dict[str, float]] = [{}, {}]
        self._lock = threading.RLock()

    @staticmethod
    def _empty_state() -> dict[str, float]:
        return {
            "voice_move_x": 0.0, "voice_move_y": 0.0,
            "voice_steer": 0.0, "voice_throttle": 0.0, "voice_brake": 0.0,
        }

    def connect(self, device_id: str) -> None:
        with self._lock:
            self.connected = True
            self.device_id = device_id
            self.last_error = None

    def disconnect(self) -> None:
        with self._lock:
            self.connected = False
            self.device_id = None
            self.release_all()

    def release_all(self, slot: int | None = None) -> None:
        with self._lock:
            targets = range(2) if slot is None else [slot]
            for index in targets:
                self.states[index] = self._empty_state()
                self._pulse_until[index].clear()

    def set_partial(self, text: str) -> None:
        with self._lock:
            self.last_partial = text

    def set_final(self, text: str) -> None:
        with self._lock:
            self.last_final = text
            self.last_partial = ""

    def apply_text(self, text: str, mappings: list[MappingProfile | None], player_count: int) -> dict[str, object]:
        reference = next((mapping for mapping in mappings if mapping is not None), None)
        if reference is None:
            self.last_error = "玩家尚未选择游戏预设"
            return {"ok": False, "message": self.last_error}
        slot, command, error = self.parser.parse(text, reference, player_count)
        with self._lock:
            self.last_result = text
            self.last_error = error
            if error or slot is None or command is None:
                return {"ok": False, "message": error or "无效命令"}
            mapping = mappings[slot]
            if mapping is None:
                self.last_error = f"{slot + 1}号玩家尚未选择预设"
                return {"ok": False, "message": self.last_error}
            if command == "start":
                self.command_enabled[slot] = True
                self.last_command = command
                self.last_command_slot = slot
                self.last_command_at = time.monotonic()
                return {"ok": True, "slot": slot, "command": command, "message": "语音控制已恢复"}
            if command == "stop":
                self.release_all(slot)
                self.command_enabled[slot] = False
                self.last_command = command
                self.last_command_slot = slot
                self.last_command_at = time.monotonic()
                return {"ok": True, "slot": slot, "command": command, "message": "语音保持已释放"}
            if command != "emergency_stop" and not self.command_enabled[slot]:
                self.last_error = "语音控制已停止，请先说体感开始"
                return {"ok": False, "slot": slot, "command": command, "message": self.last_error}
            state = self.states[slot]
            amp = mapping.voice.output_amplitudes
            if command in DIRECTION_VALUES:
                x, y = DIRECTION_VALUES[command]
                state["voice_move_x"] = x * float(amp.get("move", 1.0))
                state["voice_move_y"] = y * float(amp.get("move", 1.0))
            elif command == "emergency_stop":
                self.release_all(slot)
                self.command_enabled[slot] = False
                self.emergency_stop(slot)
            elif command == "steer_left":
                state["voice_steer"] = -float(amp.get("steer", 1.0))
            elif command == "steer_right":
                state["voice_steer"] = float(amp.get("steer", 1.0))
            elif command == "steer_center":
                state["voice_steer"] = 0.0
            elif command == "throttle_on":
                state["voice_throttle"] = float(amp.get("throttle", 1.0))
            elif command == "throttle_off":
                state["voice_throttle"] = 0.0
            elif command == "brake_on":
                state["voice_brake"] = float(amp.get("brake", 1.0))
            elif command == "brake_off":
                state["voice_brake"] = 0.0
            else:
                signal = mapping.voice.command_signals.get(command)
                if not signal:
                    signal = command if any(binding.signal == command for binding in mapping.bindings) else f"intent_{command}"
                semantics = mapping.voice.semantics.get(command, "press")
                if semantics == "release":
                    state[signal] = 0.0
                    self._pulse_until[slot].pop(signal, None)
                elif semantics == "toggle":
                    state[signal] = 0.0 if abs(float(state.get(signal, 0.0))) > 1e-6 else 1.0
                elif semantics == "down":
                    state[signal] = 1.0
                else:
                    state[signal] = 1.0
                    self._pulse_until[slot][signal] = time.monotonic() + 0.16
            self.last_command_at = time.monotonic()
            self.last_command = command
            self.last_command_slot = slot
            return {"ok": True, "slot": slot, "command": command}

    def signals(self, slot: int) -> dict[str, float]:
        with self._lock:
            now = time.monotonic()
            for signal, deadline in list(self._pulse_until[slot].items()):
                if now >= deadline:
                    self.states[slot][signal] = 0.0
                    self._pulse_until[slot].pop(signal, None)
            return dict(self.states[slot])

    def status(self, slot: int) -> dict[str, object]:
        with self._lock:
            active = {key: value for key, value in self.states[slot].items() if abs(value) > 1e-6}
            return {
                "connected": self.connected,
                "last_result": self.last_result,
                "last_partial": self.last_partial,
                "last_final": self.last_final,
                "last_command": self.last_command,
                "last_command_slot": self.last_command_slot,
                "command_enabled": self.command_enabled[slot],
                "last_error": self.last_error,
                "held": active,
            }


class VoskStreamRecognizer:
    """Lazy offline Vosk recognizer. Import/model failures remain visible in status."""

    def __init__(self, model_path: Path, phrases: list[str] | None = None, sample_rate: int = 16_000) -> None:
        try:
            from vosk import KaldiRecognizer, Model, SetLogLevel
        except ImportError as exc:
            raise RuntimeError("Vosk 未安装，离线语音不可用") from exc
        if not model_path.exists():
            raise RuntimeError(f"Vosk 中文模型不存在：{model_path}")
        SetLogLevel(-1)
        model = Model(str(model_path))
        requested = list(dict.fromkeys(phrases or []))
        supported: list[str] = []
        unsupported: list[str] = []
        for phrase in requested:
            tokenized = self._tokenize_phrase(model, phrase)
            if tokenized:
                supported.append(tokenized)
            else:
                unsupported.append(phrase)
        # Vosk's grammar recognizer materially improves command-domain accuracy,
        # but only dynamic-graph models support it.  The small Chinese model used
        # by MotionBridge is intended for runtime vocabulary updates.  Requiring
        # several supported phrases prevents a partially incompatible dictionary
        # from turning recognition into an accidental one-word grammar.
        self.mode = "grammar" if len(supported) >= 6 else "open"
        self.grammar_count = len(supported) if self.mode == "grammar" else 0
        self.unsupported_phrase_count = len(unsupported)
        if self.mode == "grammar":
            # [unk] lets unrelated speech remain unknown instead of forcing the
            # nearest command, which is important because macro outputs can be stateful.
            grammar = json.dumps([*supported, "[unk]"], ensure_ascii=False)
            try:
                self._recognizer = KaldiRecognizer(model, sample_rate, grammar)
            except Exception:
                # Some precompiled/static-graph models reject runtime grammars.
                # Falling back keeps audio usable and makes the mode observable.
                self.mode = "open"
                self.grammar_count = 0
                self._recognizer = KaldiRecognizer(model, sample_rate)
        else:
            self._recognizer = KaldiRecognizer(model, sample_rate)
        self.last_partial = ""

    @staticmethod
    def _tokenize_phrase(model: object, phrase: str) -> str | None:
        compact = re.sub(r"\s", "", phrase)
        tokens: list[str] = []
        index = 0
        while index < len(compact):
            match: str | None = None
            for length in range(min(5, len(compact) - index), 0, -1):
                candidate = compact[index : index + length]
                if model.vosk_model_find_word(candidate) >= 0:  # type: ignore[attr-defined]
                    match = candidate
                    break
            if match is None:
                return None
            tokens.append(match)
            index += len(match)
        return " ".join(tokens)

    def accept(self, pcm16: bytes) -> dict[str, str] | None:
        if self._recognizer.AcceptWaveform(pcm16):
            text = str(json.loads(self._recognizer.Result()).get("text", "")).strip()
            self.last_partial = ""
            return {"kind": "final", "text": text} if text else None
        partial = str(json.loads(self._recognizer.PartialResult()).get("partial", "")).strip()
        if partial and partial != self.last_partial:
            self.last_partial = partial
            return {"kind": "partial", "text": partial}
        return None


class AudioStreamDiagnostics:
    """Validates PCM16LE chunks and tracks real audio activity, not just a socket."""

    def __init__(self, sample_rate: int = 16_000, *, silence_rms: float = 90.0) -> None:
        self.sample_rate = sample_rate
        self.silence_rms = silence_rms
        self.bytes_received = 0
        self.chunks_received = 0
        self.non_silent_chunks = 0
        self.last_rms = 0.0
        self.peak_rms = 0.0
        self.started_at = time.monotonic()
        self.last_chunk_at = 0.0
        self.last_non_silent_at = 0.0

    def ingest(self, pcm16le: bytes, now: float | None = None) -> float:
        if not pcm16le or len(pcm16le) % 2:
            raise ValueError("PCM16 音频块必须是非空的双数字节")
        sample_count = len(pcm16le) // 2
        samples = struct.unpack(f"<{sample_count}h", pcm16le)
        rms = math.sqrt(sum(sample * sample for sample in samples) / sample_count)
        current = time.monotonic() if now is None else now
        self.bytes_received += len(pcm16le)
        self.chunks_received += 1
        self.last_rms = rms
        self.peak_rms = max(self.peak_rms, rms)
        self.last_chunk_at = current
        if rms >= self.silence_rms:
            self.non_silent_chunks += 1
            self.last_non_silent_at = current
        return rms

    def status(self, now: float | None = None) -> dict[str, object]:
        current = time.monotonic() if now is None else now
        elapsed = max(current - self.started_at, 1e-6)
        seconds = self.bytes_received / float(self.sample_rate * 2)
        stream_alive = bool(self.last_chunk_at and current - self.last_chunk_at < 1.5)
        audio_active = bool(self.last_non_silent_at and current - self.last_non_silent_at < 3.0)
        return {
            "bytes_received": self.bytes_received,
            "chunks_received": self.chunks_received,
            "pcm_seconds": round(seconds, 2),
            "receive_realtime_ratio": round(seconds / elapsed, 2),
            "last_rms": round(self.last_rms, 1),
            "peak_rms": round(self.peak_rms, 1),
            "non_silent_chunks": self.non_silent_chunks,
            "stream_alive": stream_alive,
            "audio_active": audio_active,
            "silence": stream_alive and not audio_active,
        }


def grammar_phrases(mappings: list[MappingProfile]) -> list[str]:
    """Build complete utterance alternatives for Vosk's runtime grammar.

    Vosk grammar entries are phrases, not independent tokens that can be freely
    concatenated.  Therefore "体感" and "开始" alone are not enough: the common
    spoken form "体感 开始" must also be present explicitly.
    """
    phrases: set[str] = {"体感", "一号", "二号"}
    builtin = {phrase for values in BUILTIN_COMMAND_PHRASES.values() for phrase in values}
    phrases.update(builtin)
    for mapping in mappings:
        wake = mapping.voice.wake_word.strip()
        if wake:
            phrases.add(wake)
        commands = set(builtin)
        for values in mapping.voice.phrases.values():
            commands.update(values)
        for phrase in commands:
            if not phrase:
                continue
            phrases.add(phrase)
            if wake:
                phrases.add(f"{wake} {phrase}")
                phrases.add(f"{wake} 一号 {phrase}")
                phrases.add(f"{wake} 二号 {phrase}")
    return sorted(phrases)
