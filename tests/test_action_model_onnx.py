from pathlib import Path

from motionbridge.action_model import ActionModelEngine


MODEL_ROOT = Path(__file__).resolve().parents[1] / "models" / "internal-research-only"


def test_portable_onnx_loads_and_runs_without_torch() -> None:
    engine = ActionModelEngine()
    status = engine.load_onnx(
        MODEL_ROOT / "motionbridge-coco17-6class-internal-research-only.onnx",
        metadata_path=MODEL_ROOT / "model-metadata.json",
        expected_sha256="af5071b376340cd0a60a9b7ece685af8e7557d98a829f3c4ff2ac1de53f18c40",
        expected_source_checkpoint_sha256="85d2eb63c14d37cc546ec7945d7be922f1a83e726a12d8a5592652fe22b4aa3f",
        expected_protocol_hash="c9e9964434050f09715543f2da339621a1948d23aa24fed331ff2451ef2aaf3a",
    )
    assert status["ready"] is True
    output = engine.validated_model.backend.predict(
        [[[[0.0, 0.0, 0.0] for _ in range(17)] for _ in range(24)]],
        [0.0, 0.0, 0.0, 0.0],
    )
    assert len(output) == 6
    assert abs(sum(output) - 1.0) < 1e-6


def test_portable_core13_loads_and_runs() -> None:
    engine = ActionModelEngine()
    status = engine.load_onnx(
        MODEL_ROOT / "motionbridge-penn-core13-6class-internal-research-only.onnx",
        metadata_path=MODEL_ROOT / "model-metadata-core13.json",
        expected_sha256="d72dfafa02be55962aad92e40b0170bc5acd7b5bdbfcdad2c777b519601ec458",
        expected_source_checkpoint_sha256="683b3b4b0912335aee1b4eec31f3b2ce8dc81f62c73951d0200b73cc611c259c",
        expected_protocol_hash="c9e9964434050f09715543f2da339621a1948d23aa24fed331ff2451ef2aaf3a",
        expected_candidate="penn_core13",
        expected_topology="core13",
    )
    assert status["ready"] is True
    output = engine.validated_model.backend.predict(
        [[[[0.0, 0.0, 0.0] for _ in range(13)] for _ in range(24)]],
        [0.0, 0.0, 0.0, 0.0],
    )
    assert len(output) == 6
    assert abs(sum(output) - 1.0) < 1e-6
