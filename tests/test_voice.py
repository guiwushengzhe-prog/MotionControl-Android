from __future__ import annotations

import math
import struct

import pytest

from motionbridge.mapping import DEFAULT_MAPPINGS
from motionbridge.voice import AudioStreamDiagnostics, VoiceCommandParser, VoiceController, normalize_voice_text


def test_normalizer_accepts_spacing_punctuation_and_common_homophones() -> None:
    assert normalize_voice_text("体感 向 左！") == "体感向左"
    assert normalize_voice_text("体干，像右") == "体感向右"
    assert normalize_voice_text("体杆开使") == "体感开始"


@pytest.mark.parametrize(
    ("text", "command"),
    [
        ("体感开始", "start"),
        ("体感 停止", "stop"),
        ("体感向左", "left"),
        ("体感 向右", "right"),
        ("体感跳跃", "jump"),
        ("体感紧急停止", "emergency_stop"),
        ("体干像左", "left"),
    ],
)
def test_required_commands_parse_in_single_player(text: str, command: str) -> None:
    slot, parsed, error = VoiceCommandParser().parse(text, DEFAULT_MAPPINGS[0], 1)
    assert (slot, parsed, error) == (0, command, None)


def test_wake_word_and_double_player_prefix_are_strict() -> None:
    parser = VoiceCommandParser()
    mapping = DEFAULT_MAPPINGS[0]
    assert parser.parse("向左", mapping, 1)[2] == "缺少唤醒词"
    assert parser.parse("体感向左", mapping, 2)[2] == "双人模式请说一号或二号"
    assert parser.parse("体感 一号 向左", mapping, 2) == (0, "left", None)
    assert parser.parse("体感二号向右", mapping, 2) == (1, "right", None)


def test_start_stop_jump_and_emergency_controller_semantics() -> None:
    emergencies: list[int] = []
    voice = VoiceController(emergencies.append)
    mapping = DEFAULT_MAPPINGS[0]
    voice.connect("phone")

    assert voice.apply_text("体感向左", [mapping, None], 1)["command"] == "left"
    assert voice.signals(0)["voice_move_x"] == -1.0

    stopped = voice.apply_text("体感停止", [mapping, None], 1)
    assert stopped["ok"] is True and stopped["command"] == "stop"
    assert voice.status(0)["command_enabled"] is False
    assert not any(voice.signals(0).values())
    blocked = voice.apply_text("体感跳跃", [mapping, None], 1)
    assert blocked["ok"] is False and "体感开始" in str(blocked["message"])

    assert voice.apply_text("体感开始", [mapping, None], 1)["ok"] is True
    jumped = voice.apply_text("体感跳跃", [mapping, None], 1)
    assert jumped["command"] == "jump"
    assert voice.signals(0)["jump"] == 1.0

    emergency = voice.apply_text("体感紧急停止", [mapping, None], 1)
    assert emergency["ok"] is True and emergencies == [0]
    assert not any(voice.signals(0).values())


def test_disconnect_immediately_releases_held_voice_state() -> None:
    voice = VoiceController(lambda _slot: None)
    mapping = DEFAULT_MAPPINGS[0]
    voice.connect("phone")
    voice.apply_text("体感向右", [mapping, None], 1)
    assert voice.signals(0)["voice_move_x"] == 1.0
    voice.disconnect()
    assert voice.connected is False
    assert not any(voice.signals(0).values())


def test_pcm16le_diagnostics_distinguish_silence_from_real_audio() -> None:
    diagnostics = AudioStreamDiagnostics(silence_rms=90.0)
    silence = struct.pack("<160h", *([0] * 160))
    assert diagnostics.ingest(silence, now=1.0) == 0.0
    assert diagnostics.status(now=1.1)["silence"] is True

    wave = [int(2_000 * math.sin(index * math.pi / 8)) for index in range(160)]
    rms = diagnostics.ingest(struct.pack("<160h", *wave), now=1.2)
    assert rms == pytest.approx(2_000 / math.sqrt(2), rel=0.03)
    status = diagnostics.status(now=1.3)
    assert status["audio_active"] is True
    assert status["non_silent_chunks"] == 1
    assert status["bytes_received"] == 640


def test_pcm16le_diagnostics_reject_malformed_chunks() -> None:
    diagnostics = AudioStreamDiagnostics()
    with pytest.raises(ValueError, match="双数字节"):
        diagnostics.ingest(b"\x01")

