from __future__ import annotations

import binascii
import struct

from motionbridge.outputs.dsu import PAD_DATA, PROTOCOL_VERSION, build_packet, valid_client_packet


def make_client_packet(message_type: int, payload: bytes = b"") -> bytes:
    message = struct.pack("<I", message_type) + payload
    header = struct.pack("<4sHHII", b"DSUC", PROTOCOL_VERSION, len(message), 0, 123)
    checksum = binascii.crc32(header + message) & 0xFFFFFFFF
    return struct.pack("<4sHHII", b"DSUC", PROTOCOL_VERSION, len(message), checksum, 123) + message


def test_server_packet_has_length_and_crc() -> None:
    packet = build_packet(999, PAD_DATA, b"payload")
    magic, version, length, checksum, server_id = struct.unpack_from("<4sHHII", packet)
    assert magic == b"DSUS"
    assert version == PROTOCOL_VERSION
    assert length + 16 == len(packet)
    assert server_id == 999
    zeroed = packet[:8] + b"\0\0\0\0" + packet[12:]
    assert binascii.crc32(zeroed) & 0xFFFFFFFF == checksum


def test_client_packet_validation() -> None:
    packet = make_client_packet(PAD_DATA, b"\0" * 8)
    assert valid_client_packet(packet)
    assert not valid_client_packet(packet[:-1])
    corrupted = packet[:-1] + bytes([packet[-1] ^ 0xFF])
    assert not valid_client_packet(corrupted)

