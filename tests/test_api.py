from __future__ import annotations

from motionbridge.models import PoseFrame, PoseFrameV2
from motionbridge.server import RuntimeState


def test_runtime_profile_mapping_and_output_state(tmp_path) -> None:
    state = RuntimeState(tmp_path, enable_outputs=False)
    status = state.status()
    assert status["camera_connected"] is False
    assert status["selected_mapping_id"]
    player = state.profile_store.create("测试玩家")
    state.select_profile(player.id)
    state.router.set_enabled(True)
    next_status = state.status()
    assert next_status["selected_profile_id"] == player.id
    assert next_status["outputs"]["enabled"] is True


def pose_frame(sequence: int) -> PoseFrame:
    landmark = {"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 1.0}
    return PoseFrame(
        device_id="camera-test",
        sequence=sequence,
        captured_at_ms=0,
        width=1280,
        height=720,
        pose=[landmark] * 33,
    )


def test_sequence_can_restart_after_stream_is_stale(tmp_path, monkeypatch) -> None:
    now = [100.0]
    monkeypatch.setattr("motionbridge.server.time.monotonic", lambda: now[0])
    state = RuntimeState(tmp_path, enable_outputs=False)

    assert state.ingest_pose(pose_frame(20)) is True
    now[0] += 0.5
    assert state.ingest_pose(pose_frame(0)) is False
    now[0] += 1.1
    assert state.ingest_pose(pose_frame(1)) is True
    now[0] += 2.0
    assert state.ingest_pose(pose_frame(1)) is False


def test_pose_v2_exposes_real_receive_count_and_native_diagnostics(tmp_path) -> None:
    state = RuntimeState(tmp_path, enable_outputs=False)
    landmark = {"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 0.9}
    frame = PoseFrameV2(
        device_id="camera-native", sequence=1, captured_at_ms=0,
        width=720, height=1280,
        poses=[{"detection_id": None, "pose": [landmark] * 33, "world_pose": [landmark] * 33}],
        pose_diagnostics={
            "imageReaderFrames": 30, "submittedFrames": 14, "detectCalls": 14,
            "detectErrors": 0, "poseCount": 1, "bitmapWidth": 640, "bitmapHeight": 360,
            "rotationDegrees": 90,
        },
    )

    assert state.ingest_pose_v2(frame) is True
    status = state.status()
    assert status["pose_count"] == 1
    assert status["pose_frames_with_people"] == 1
    assert status["pose_diagnostics"]["detectCalls"] == 14
    assert status["pose_diagnostics"]["bitmapWidth"] == 640
