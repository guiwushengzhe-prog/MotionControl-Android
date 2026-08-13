from __future__ import annotations

import binascii
import socket
import struct
import time

from motionbridge.outputs.dsu import DSUServer, PAD_DATA, PORT_INFO, PROTOCOL_VERSION


def client_packet(message_type: int, payload: bytes = b"") -> bytes:
    message = struct.pack("<I", message_type) + payload
    header = struct.pack("<4sHHII", b"DSUC", PROTOCOL_VERSION, len(message), 0, 0x4D42)
    checksum = binascii.crc32(header + message) & 0xFFFFFFFF
    return struct.pack("<4sHHII", b"DSUC", PROTOCOL_VERSION, len(message), checksum, 0x4D42) + message


def main() -> None:
    port = 26761
    server = DSUServer(port=port)
    server.start()
    assert server.available, server.last_error
    server.update(0, accel_x=0.25, gyro_roll=1.0)
    server.update(1, accel_x=-0.5, gyro_roll=-2.0)
    client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    client.settimeout(2)
    try:
        client.sendto(client_packet(PORT_INFO, struct.pack("<I", 2) + bytes((0, 1))), ("127.0.0.1", port))
        info_slots = set()
        while len(info_slots) < 2:
            response, _ = client.recvfrom(512)
            assert response[:4] == b"DSUS"
            assert struct.unpack_from("<I", response, 16)[0] == PORT_INFO
            info_slots.add(response[20])
        client.sendto(client_packet(PAD_DATA, b"\0\0" + b"\0" * 6), ("127.0.0.1", port))
        data_slots = set()
        deadline = time.monotonic() + 2
        while len(data_slots) < 2 and time.monotonic() < deadline:
            response, _ = client.recvfrom(1024)
            if struct.unpack_from("<I", response, 16)[0] == PAD_DATA:
                data_slots.add(response[20])
        assert data_slots == {0, 1}, data_slots
        print(f"DSU port={port} info_slots={sorted(info_slots)} data_slots={sorted(data_slots)}")
    finally:
        client.close()
        server.stop()


if __name__ == "__main__":
    main()
