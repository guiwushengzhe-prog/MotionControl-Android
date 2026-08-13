from __future__ import annotations

"""Export and verify the frozen Penn Core13 internal research model."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


LABELS = ["SQUAT_PULSE", "LUNGE_SHIFT", "ARMS_UP_DYNAMIC", "RAPID_ARM_STRIKE", "SLOW_ARM_DISTRACTOR", "DAILY_MOTION_DISTRACTOR"]
CANDIDATE = "penn_core13"
PROTOCOL_SHA256 = "c9e9964434050f09715543f2da339621a1948d23aa24fed331ff2451ef2aaf3a"
CHECKPOINT_SHA256 = "683b3b4b0912335aee1b4eec31f3b2ce8dc81f62c73951d0200b73cc611c259c"
CORE13 = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
CORE_EDGES = [(5,3),(3,1),(6,4),(4,2),(0,1),(0,2),(1,2),(1,7),(2,8),(7,8),(11,9),(9,7),(12,10),(10,8)]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def build_model(mmaction_root: Path) -> torch.nn.Module:
    sys.path.insert(0, str(mmaction_root))
    from mmaction.models.backbones import STGCN

    class Model(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            graph = {"num_node": 13, "inward": CORE_EDGES, "center": CORE13.index(23)}
            self.backbone = STGCN(graph_cfg={"layout": graph, "mode": "spatial"}, in_channels=3, num_person=1, gcn_adaptive="init", gcn_with_res=True, tcn_type="mstcn")
            self.root_branch = torch.nn.Sequential(torch.nn.Linear(4, 32), torch.nn.ReLU())
            self.head = torch.nn.Linear(288, len(LABELS))

        def forward(self, pose: torch.Tensor, root: torch.Tensor) -> torch.Tensor:
            feature = self.backbone(pose).mean(dim=(1, 3, 4))
            return self.head(torch.cat([feature, self.root_branch(root)], 1))

    return Model()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--mmaction-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if sha256(args.checkpoint) != CHECKPOINT_SHA256:
        raise SystemExit("checkpoint SHA256 mismatch")
    payload = torch.load(args.checkpoint, map_location="cpu")
    if payload.get("candidate") != CANDIDATE or payload.get("topology") != "core13":
        raise SystemExit("candidate/topology mismatch")
    if payload.get("protocol_sha256") != PROTOCOL_SHA256 or int(payload.get("epoch", -1)) != 11:
        raise SystemExit("protocol/epoch mismatch")
    model = build_model(args.mmaction_root).eval()
    model.load_state_dict(payload["state_dict"], strict=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    pose = torch.zeros(1, 1, 24, 13, 3, dtype=torch.float32)
    root = torch.zeros(1, 4, dtype=torch.float32)
    with torch.inference_mode():
        torch.onnx.export(model, (pose, root), args.output, input_names=["pose", "root"], output_names=["logits"], dynamic_axes={"pose": {0: "batch"}, "root": {0: "batch"}, "logits": {0: "batch"}}, opset_version=17, do_constant_folding=True)
    onnx.checker.check_model(onnx.load(str(args.output)))
    session = ort.InferenceSession(str(args.output), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(20260813)
    samples = [(np.zeros((1, 1, 24, 13, 3), np.float32), np.zeros((1, 4), np.float32)), (np.full((1, 1, 24, 13, 3), 0.25, np.float32), np.array([[.1, -.1, .2, .3]], np.float32))]
    for _ in range(32):
        samples.append((rng.uniform(-2, 2, (1, 1, 24, 13, 3)).astype(np.float32), rng.uniform(-.5, .5, (1, 4)).astype(np.float32)))
    errors, matches = [], 0
    with torch.inference_mode():
        for body, motion in samples:
            expected = model(torch.from_numpy(body), torch.from_numpy(motion)).numpy()
            actual = session.run(["logits"], {"pose": body, "root": motion})[0]
            errors.append(float(np.max(np.abs(expected - actual))))
            matches += int(expected.argmax(1)[0] == actual.argmax(1)[0])
    maximum, agreement = max(errors), matches / len(samples)
    if maximum > 1e-4 or agreement != 1.0:
        raise SystemExit(f"equivalence failed: {maximum=} {agreement=}")
    metadata = {
        "status": "INTERNAL_RESEARCH_ONLY", "candidate": CANDIDATE, "topology": "core13", "labels": LABELS,
        "pose_shape": ["N", 1, 24, 13, 3], "root_shape": ["N", 4], "output_shape": ["N", 6],
        "onnx_sha256": sha256(args.output), "source_checkpoint_sha256": CHECKPOINT_SHA256,
        "protocol_sha256": PROTOCOL_SHA256, "best_epoch": 11,
        "preprocessing": {"indices": CORE13, "world": "OneEuro(0.10,80,1.0); per-frame hip center; one median torso scale per 24-frame window; no rotation", "root": "image hip center [dx,dy,x_range,y_range]"},
        "verification": {"sample_count": len(samples), "max_absolute_logit_error": maximum, "argmax_agreement": agreement, "providers": session.get_providers()},
        "official_test": {"macro_f1": 0.84420, "difficult_negative_false_trigger_rate": 0.1818},
        "license": "Internal non-commercial research only. Do not redistribute or use commercially.",
    }
    args.report.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
