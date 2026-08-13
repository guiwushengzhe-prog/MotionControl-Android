from __future__ import annotations

import asyncio
import json
import os

import websockets


async def main() -> None:
    base = os.environ.get("MOTIONBRIDGE_BASE_URL", "http://127.0.0.1:8765").rstrip("/")
    url = base.replace("http://", "ws://", 1).replace("https://", "wss://", 1) + "/ws/audio"
    async with websockets.connect(url, open_timeout=15) as websocket:
        await websocket.send(json.dumps({
            "type": "audio_start", "device_id": "release-audio-test",
            "sample_rate": 16_000, "channels": 1, "format": "pcm16",
        }))
        response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=30))
        assert response == {"type": "audio_ready", "sample_rate": 16_000}, response
        print(f"audio_url={url} response={response}")


if __name__ == "__main__":
    asyncio.run(main())
