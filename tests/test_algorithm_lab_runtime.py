from __future__ import annotations

from fastapi.testclient import TestClient

from motionbridge.models import PoseFrame
from motionbridge.server import RuntimeState, create_app


def frame(sequence: int, captured_at_ms: float) -> PoseFrame:
    points = [{"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 1.0} for _ in range(33)]
    # Give the recognizer non-zero shoulder, torso and leg scales.
    points[11].update(x=0.42, y=0.32)
    points[12].update(x=0.58, y=0.32)
    points[23].update(x=0.45, y=0.58)
    points[24].update(x=0.55, y=0.58)
    points[27].update(x=0.46, y=0.90)
    points[28].update(x=0.54, y=0.90)
    return PoseFrame(
        device_id="runtime-real-phone",
        sequence=sequence,
        captured_at_ms=captured_at_ms,
        width=1280,
        height=720,
        pose=points,
    )


def test_runtime_shadow_lock_records_replays_and_leaves_outputs_released(tmp_path) -> None:
    state = RuntimeState(tmp_path, enable_outputs=False)
    profile = state.profile_store.create("真人测试玩家")
    state.select_profile(profile.id)
    assert state.ingest_pose(frame(1, 1_000)) is True

    state.router.set_enabled(True)
    assert state.router.enabled is True
    started = state.start_algorithm_lab("still", slot=0, repetitions=1, candidate_preset="stable")
    assert started["active"] is True
    assert state.router.shadow_mode is True
    assert state.router.enabled is False

    # Even an accidental enable call is rejected by the hardware-level shadow lock.
    state.router.set_enabled(True)
    assert state.router.enabled is False
    assert state.ingest_pose(frame(2, 1_033)) is True

    session = state.finish_algorithm_lab()
    assert len(session["frames"]) == 1
    assert len(session["frames"][0]["pose_frame"]["pose"]) == 33
    assert session["metadata"]["output_isolation"] == "hardware-shadow-lock"
    assert session["comparison"]["same_input_frame_count"] == 1
    assert session["comparison"]["shadow_mode"] is True
    assert state.router.shadow_mode is False
    assert state.router.enabled is False
    assert state.algorithm_lab_store.load(session["id"])["id"] == session["id"]


def test_algorithm_lab_http_flow_uses_real_websocket_pose_and_exports(tmp_path) -> None:
    app = create_app(tmp_path, enable_outputs=False)
    with TestClient(app) as client:
        assert client.post("/api/profiles", json={"name": "接口真人玩家"}).status_code == 200
        with client.websocket_connect("/ws/input") as socket:
            socket.send_json(frame(1, 1_000).model_dump(mode="json"))

        assert client.post("/api/output/enable").json()["outputs"]["enabled"] is True
        started = client.post("/api/algorithm-tests/start", json={
            "project_id": "fist", "slot": 0, "repetitions": 1,
            "candidate_preset": "stable",
        })
        assert started.status_code == 200
        assert started.json()["shadow_mode"] is True
        locked = client.post("/api/output/enable")
        assert locked.status_code == 423

        with client.websocket_connect("/ws/input") as socket:
            socket.send_json(frame(2, 1_033).model_dump(mode="json"))

        stopped = client.post("/api/algorithm-tests/stop")
        assert stopped.status_code == 200
        session_id = stopped.json()["id"]
        assert stopped.json()["comparison"]["same_input_frame_count"] == 1
        assert client.get(f"/api/algorithm-tests/sessions/{session_id}/export/json").status_code == 200
        assert client.get(f"/api/algorithm-tests/sessions/{session_id}/export/csv").status_code == 200
        sessions = client.get("/api/algorithm-tests/sessions").json()["sessions"]
        assert sessions[0]["id"] == session_id
