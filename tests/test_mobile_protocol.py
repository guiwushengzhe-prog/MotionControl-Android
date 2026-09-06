from pathlib import Path


MAIN_TS = Path(__file__).parents[1] / "mobile" / "src" / "main.ts"


def test_mobile_keeps_compact_points_and_adds_optional_world_points() -> None:
    source = MAIN_TS.read_text(encoding="utf-8")

    # 旧帧和紧凑 27 点布局继续作为兼容路径。
    assert 'type: "pose_features_v1"' in source
    assert 'layout: "mc27-v2"' in source
    assert "const CONTROL_POINT_INDICES = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]" in source

    # 只有完整 33 点结果存在时才携带世界坐标；缺失可选结果时保持旧接收端兼容。
    assert "poseResult.worldLandmarks?.[0]" in source
    assert "if (!points || points.length < 33) return [];" in source
    assert "points.slice(0, 33).map" in source
    assert "if (worldPoints.length === 33) frame.world_points = worldPoints;" in source
    assert "roundPose(point.visibility ?? 1)" in source
    assert "function packWorldPoints" in source
