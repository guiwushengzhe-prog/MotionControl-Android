from __future__ import annotations

import binascii
import random
import socket
import struct
import threading
import time
from dataclasses import dataclass


PROTOCOL_VERSION = 1001
VERSION = 0x100000
PORT_INFO = 0x100001
PAD_DATA = 0x100002
MACS = (b"MB0000", b"MB0001")
MAC = MACS[0]


def build_packet(server_id: int, message_type: int, payload: bytes = b"") -> bytes:
    message = struct.pack("<I", message_type) + payload
    header = struct.pack("<4sHHII", b"DSUS", PROTOCOL_VERSION, len(message), 0, server_id)
    checksum = binascii.crc32(header + message) & 0xFFFFFFFF
    header = struct.pack("<4sHHII", b"DSUS", PROTOCOL_VERSION, len(message), checksum, server_id)
    return header + message


def valid_client_packet(data: bytes) -> bool:
    if len(data) < 20 or data[:4] != b"DSUC":
        return False
    _, version, length, checksum, _ = struct.unpack_from("<4sHHII", data)
    if version > PROTOCOL_VERSION or length + 16 != len(data):
        return False
    zeroed = data[:8] + b"\0\0\0\0" + data[12:]
    return (binascii.crc32(zeroed) & 0xFFFFFFFF) == checksum


@dataclass
class MotionState:
    accel_x: float = 0.0
    accel_y: float = 0.0
    accel_z: float = 1.0
    gyro_pitch: float = 0.0
    gyro_yaw: float = 0.0
    gyro_roll: float = 0.0


class DSUServer:
    """Two-slot DSU/Cemuhook server for emulator motion input."""

    def __init__(self, host: str = "127.0.0.1", port: int = 26760) -> None:
        self.host = host
        self.port = port
        self.server_id = random.SystemRandom().randint(1, 0xFFFFFFFF)
        self.clients: dict[tuple[str, int], tuple[float, set[int]]] = {}
        self.motions = [MotionState(), MotionState()]
        self.motion = self.motions[0]  # Compatibility handle for older callers/tests.
        self.packet_numbers = [0, 0]
        self.packet_number = 0
        self.available = False
        self.last_error: str | None = None
        self._socket: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.RLock()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind((self.host, self.port))
            sock.settimeout(0.01)
            self._socket = sock
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="motionbridge-dsu", daemon=True)
            self._thread.start()
            self.available = True
        except OSError as exc:
            self.last_error = str(exc)
            self.available = False

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        if self._socket:
            self._socket.close()
        self.available = False

    def update(self, slot: int = 0, **values: float) -> None:
        if slot not in (0, 1):
            return
        with self._lock:
            for key, value in values.items():
                if hasattr(self.motions[slot], key):
                    setattr(self.motions[slot], key, float(value))

    def _run(self) -> None:
        next_send = time.monotonic()
        while not self._stop.is_set():
            self._receive()
            now = time.monotonic()
            if now >= next_send:
                self._broadcast(now)
                next_send = now + 1 / 60

    def _receive(self) -> None:
        if self._socket is None:
            return
        try:
            data, address = self._socket.recvfrom(1024)
        except TimeoutError:
            return
        except OSError:
            return
        if not valid_client_packet(data):
            return
        message_type = struct.unpack_from("<I", data, 16)[0]
        if message_type == VERSION:
            self._socket.sendto(build_packet(self.server_id, VERSION, struct.pack("<H", PROTOCOL_VERSION)), address)
        elif message_type == PORT_INFO:
            wanted = struct.unpack_from("<I", data, 20)[0] if len(data) >= 24 else 1
            slots = list(data[24 : 24 + min(wanted, 4)]) or [0]
            for slot in slots:
                state = 2 if slot in (0, 1) else 0
                mac = MACS[slot] if slot in (0, 1) else b"\0" * 6
                payload = struct.pack("<BBBB6sBB", slot, state, 2 if state else 0, 2 if state else 0, mac, 5, 1 if state else 0)
                self._socket.sendto(build_packet(self.server_id, PORT_INFO, payload), address)
        elif message_type == PAD_DATA:
            reg_flags, slot = struct.unpack_from("<BB", data, 20) if len(data) >= 22 else (0, 0)
            requested_mac = data[22:28] if len(data) >= 28 else b"\0" * 6
            slots = {0, 1}
            if reg_flags & 1:
                slots = {slot} if slot in (0, 1) else set()
            elif reg_flags & 2:
                slots = {index for index, mac in enumerate(MACS) if requested_mac == mac}
            if slots:
                self.clients[address] = (time.monotonic(), slots)

    def _broadcast(self, now: float) -> None:
        if self._socket is None:
            return
        expired = [address for address, (seen, _) in self.clients.items() if now - seen > 5.0]
        for address in expired:
            self.clients.pop(address, None)
        if not self.clients:
            return
        with self._lock:
            motions = [MotionState(**vars(item)) for item in self.motions]
        for slot, motion in enumerate(motions):
            self.packet_numbers[slot] = (self.packet_numbers[slot] + 1) & 0xFFFFFFFF
            self.packet_number = self.packet_numbers[0]
            port_info = struct.pack("<BBBB6sBBI", slot, 2, 2, 2, MACS[slot], 5, 1, self.packet_numbers[slot])
            # Buttons/sticks/touch are neutral; six floats are accelerometer then gyroscope.
            controls = struct.pack(
            "<22B2H2B2HQ6f",
            *([0] * 4),
            128,
            128,
            128,
            128,
            *([0] * 14),
            0,
            0,
            0,
            0,
            0,
            0,
            int(time.perf_counter() * 1_000_000),
            motion.accel_x,
            motion.accel_y,
            motion.accel_z,
            motion.gyro_pitch,
            motion.gyro_yaw,
            motion.gyro_roll,
            )
            packet = build_packet(self.server_id, PAD_DATA, port_info + controls)
            for address, (_, registered) in tuple(self.clients.items()):
                if slot not in registered:
                    continue
                try:
                    self._socket.sendto(packet, address)
                except OSError:
                    self.clients.pop(address, None)
