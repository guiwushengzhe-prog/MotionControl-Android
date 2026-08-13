from __future__ import annotations

"""Export and numerically verify the approved internal COCO17 trial model."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


LABELS = [
    "SQUAT_PULSE",
    "LUNGE_SHIFT",
    "ARMS_UP_DYNAMIC",
    "RAPID_ARM_STRIKE",
    "SLOW_ARM_DISTRACTOR",
    "DAILY_MOTION_DISTRACTOR",
]
CANDIDATE = "openmmlab_ntu60_2d_native_coco17"
PROTOCOL_SHA256 = "c9e9964434050f09715543f2da339621a1948d23aa24fed331ff2451ef2aaf3a"
CHECKPOINT_SHA256 = "85d2eb63c14d37cc546ec7945d7be922f1a83e726a12d8a5592652fe22b4aa3f"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_model(mmaction_root: Path) -> torch.nn.Module:
    sys.path.insert(0, str(mmaction_root))
    from mmaction.models.backbones import STGCN

    class ResearchModel(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.backbone = STGCN(
                graph_cfg={"layout": "coco", "mode": "spatial"},
                in_channels=3,
                num_person=1,
                gcn_adaptive="init",
                gcn_with_res=True,
                tcn_type="mstcn",
            )
            self.root_branch = torch.nn.Sequential(torch.nn.Linear(4, 32), torch.nn.ReLU())
            self.head = torch.nn.Linear(288, len(LABELS))

        def forward(self, pose: torch.Tensor, root: torch.Tensor) -> torch.Tensor:
            feature = self.backbone(pose).mean(dim=(1, 3, 4))
            return self.head(torch.cat([feature, self.root_branch(root)], dim=1))

    return ResearchModel()


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
    if payload.get("candidate") != CANDIDATE:
        raise SystemExit("candidate mismatch")
    if payload.get("protocol_sha256", payload.get("protocol_hash")) != PROTOCOL_SHA256:
        raise SystemExit("protocol mismatch")

    model = build_model(args.mmaction_root).eval()
    model.load_state_dict(payload["state_dict"], strict=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    pose = torch.zeros(1, 1, 24, 17, 3, dtype=torch.float32)
    root = torch.zeros(1, 4, dtype=torch.float32)
    with torch.inference_mode():
        torch.onnx.export(
            model,
            (pose, root),
            args.output,
            input_names=["pose", "root"],
            output_names=["logits"],
            dynamic_axes={"pose": {0: "batch"}, "root": {0: "batch"}, "logits": {0: "batch"}},
            opset_version=17,
            do_constant_folding=True,
        )
    graph = onnx.load(str(args.output))
    onnx.checker.check_model(graph)
    session = ort.InferenceSession(str(args.output), providers=["CPUExecutionProvider"])

    rng = np.random.default_rng(20260813)
    samples: list[tuple[np.ndarray, np.ndarray]] = [
        (np.zeros((1, 1, 24, 17, 3), np.float32), np.zeros((1, 4), np.float32)),
        (np.full((1, 1, 24, 17, 3), 0.25, np.float32), np.array([[0.1, -0.1, 0.2, 0.3]], np.float32)),
    ]
    for _ in range(32):
        candidate_pose = rng.uniform(-1.0, 1.0, (1, 1, 24, 17, 3)).astype(np.float32)
        candidate_pose[..., 2] = rng.uniform(0.0, 1.0, candidate_pose[..., 2].shape)
        samples.append((candidate_pose, rng.uniform(-0.5, 0.5, (1, 4)).astype(np.float32)))

    max_abs_error = 0.0
    matched = 0
    records = []
    with torch.inference_mode():
        for index, (sample_pose, sample_root) in enumerate(samples):
            expected = model(torch.from_numpy(sample_pose), torch.from_numpy(sample_root)).cpu().numpy()
            actual = session.run(["logits"], {"pose": sample_pose, "root": sample_root})[0]
            error = float(np.max(np.abs(expected - actual)))
            expected_class = int(expected.argmax(axis=1)[0])
            actual_class = int(actual.argmax(axis=1)[0])
            max_abs_error = max(max_abs_error, error)
            matched += int(expected_class == actual_class)
            records.append({"sample": index, "max_abs_error": error, "torch_class": expected_class, "onnx_class": actual_class})

    agreement = matched / len(samples)
    if not np.isfinite(max_abs_error) or max_abs_error > 1e-4 or agreement != 1.0:
        raise SystemExit(f"ONNX equivalence failed: max_abs_error={max_abs_error}, agreement={agreement}")
    model_sha256 = sha256(args.output)
    metadata = {
        "status": "INTERNAL_RESEARCH_ONLY",
        "candidate": CANDIDATE,
        "topology": "coco17",
        "labels": LABELS,
        "pose_shape": ["N", 1, 24, 17, 3],
        "root_shape": ["N", 4],
        "output_shape": ["N", 6],
        "onnx_sha256": model_sha256,
        "source_checkpoint_sha256": CHECKPOINT_SHA256,
        "protocol_sha256": PROTOCOL_SHA256,
        "best_epoch": int(payload.get("epoch", 12)),
        "verification": {
            "sample_count": len(samples),
            "max_absolute_logit_error": max_abs_error,
            "argmax_agreement": agreement,
            "providers": session.get_providers(),
        },
        "sample_records": records,
        "license": "Internal non-commercial research only. Do not redistribute or use commercially.",
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
