from pathlib import Path


MAIN_TS = Path(__file__).parents[1] / "mobile" / "src" / "main.ts"


def test_mobile_sends_the_whole_skeleton_and_optional_world_points() -> None:
    source = MAIN_TS.read_text(encoding="utf-8")

    # mc33-v3：33 个点全发。早先的 27 点紧凑布局跳过了手上的点，握拳控制视角要用它们。
    assert 'type: "pose_features_v1"' in source
    assert 'const POSE_LAYOUT = "mc33-v3";' in source
    assert "layout: POSE_LAYOUT" in source
    assert "const CONTROL_POINT_INDICES = Array.from({ length: 33 }, (_, index) => index);" in source

    # 只有完整 33 点结果存在时才携带世界坐标；缺失可选结果时保持旧接收端兼容。
    assert "poseResult.worldLandmarks?.[0]" in source
    assert "if (!points || points.length < 33) return [];" in source
    assert "points.slice(0, 33).map" in source
    assert "if (worldPoints.length === 33) frame.world_points = worldPoints;" in source
    assert "roundPose(point.visibility ?? 1)" in source
    assert "function packWorldPoints" in source
