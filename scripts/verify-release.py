from __future__ import annotations

import asyncio
import binascii
import json
import os
import socket
import struct
import time
import urllib.request

import websockets


BASE_URL = os.environ.get("MOTIONBRIDGE_BASE_URL", "http://127.0.0.1:8765").rstrip("/")
DSU_PORT = int(os.environ.get("MOTIONBRIDGE_DSU_PORT", "26760"))
REQUIRE_OUTPUTS = os.environ.get("MOTIONBRIDGE_REQUIRE_OUTPUTS", "1") == "1"


def get(path: str) -> tuple[int, dict[str, str], bytes]:
    with urllib.request.urlopen(BASE_URL + path, timeout=5) as response:
        return response.status, {key.lower(): value for key, value in response.headers.items()}, response.read()


async def verify_websocket() -> dict[str, object]:
    landmark = {"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 1.0}
    websocket_url = BASE_URL.replace("http://", "ws://", 1).replace("https://", "wss://", 1) + "/ws/input"
    async with websockets.connect(websocket_url) as websocket:
        for sequence in range(15):
            await websocket.send(
                json.dumps(
                    {
                        "type": "pose_frame_v2",
                        "role": "camera",
                        "device_id": "final-exe-test",
                        "sequence": sequence,
                        "captured_at_ms": time.time() * 1000,
                        "width": 1280,
                        "height": 720,
                        "camera_facing": "user",
                        "preview_mirrored": True,
                        "coordinates_mirrored": False,
                        "people": [{"pose": [landmark] * 33}],
                        "hands": [],
                        "inference_ms": 5.0,
                    }
                )
            )
        ack = json.loads(await asyncio.wait_for(websocket.recv(), timeout=5))
        assert ack["type"] == "ack", ack
        assert ack["accepted"] == 15
        return ack


def verify_dsu() -> str:
    message = struct.pack("<I", 0x100000)
    header = struct.pack("<4sHHII", b"DSUC", 1001, len(message), 0, 12345)
    checksum = binascii.crc32(header + message) & 0xFFFFFFFF
    packet = struct.pack("<4sHHII", b"DSUC", 1001, len(message), checksum, 12345) + message
    client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    client.settimeout(2)
    try:
        client.sendto(packet, ("127.0.0.1", DSU_PORT))
        response, _ = client.recvfrom(1024)
    finally:
        client.close()
    assert response[:4] == b"DSUS"
    return response[:4].decode("ascii")


def main() -> None:
    status_code, status_headers, raw = get("/api/status")
    status = json.loads(raw)
    assert status_code == 200
    assert status["mobile_url"].endswith("/phone/")
    assert status["input_url"].endswith("/ws/input")
    assert status["build_id"] == "2026.08.09-v0.3.0"
    assert len(status["players"]) == 2
    assert status["audio_url"].endswith("/ws/audio")
    assert "no-store" in status_headers.get("cache-control", "")
    if REQUIRE_OUTPUTS:
        assert status["outputs"]["keyboard"]["available"] is True
        assert status["outputs"]["gamepad"]["available"] is True
        assert status["outputs"]["dsu"]["available"] is True

    asset_sizes: dict[str, int] = {}
    for path in (
        "/",
        "/phone/",
        "/phone/models/pose_landmarker_lite.task",
        "/phone/models/pose_landmarker_full.task",
        "/phone/models/pose_landmarker_heavy.task",
        "/phone/models/gesture_recognizer.task",
        "/phone/wasm/vision_wasm_internal.wasm",
        "/api/qr",
    ):
        response_code, _, body = get(path)
        assert response_code == 200
        assert len(body) > 100
        asset_sizes[path] = len(body)

    ack = asyncio.run(verify_websocket())
    time.sleep(0.8)
    _, _, raw = get("/api/status")
    after_watchdog = json.loads(raw)
    assert after_watchdog["signals"]["pose_visible"] is False

    print(
        json.dumps(
            {
                "mobile_url": status["mobile_url"],
                "input_url": status["input_url"],
                "outputs": status["outputs"],
                "asset_sizes": asset_sizes,
                "websocket_ack": ack,
                "watchdog_pose_visible": after_watchdog["signals"]["pose_visible"],
                "dsu_magic": verify_dsu() if REQUIRE_OUTPUTS else "skipped",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
