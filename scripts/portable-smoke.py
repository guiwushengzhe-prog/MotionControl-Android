from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

from motionbridge.action_model import CLASS_LABELS
from motionbridge.control_layouts import CameraLayoutKey, ControlLayoutStore
from motionbridge.intents import InputIntent, InputIntentEngine, IntentBinding
from motionbridge.mapping import MappingStore


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    internal = args.root / "_internal"
    model = internal / "models" / "internal-research-only" / "motionbridge-coco17-6class-internal-research-only.onnx"
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    logits = session.run(
        ["logits"],
        {"pose": np.zeros((1, 1, 24, 17, 3), np.float32), "root": np.zeros((1, 4), np.float32)},
    )[0]
    if logits.shape != (1, len(CLASS_LABELS)) or not np.isfinite(logits).all():
        raise SystemExit("ONNX inference failed")

    store = MappingStore(args.root / "smoke-data" / "mappings")
    ids = {mapping.id for mapping in store.list()}
    required = {"forza-horizon-4-motion", "black-myth-wukong-motion"}
    if not required.issubset(ids):
        raise SystemExit("game presets missing")

    layout_root = args.root / "smoke-data" / "control-layouts"
    layouts = ControlLayoutStore(layout_root)
    layout = layouts.create(
        "便携布局持久化验证",
        "portable-profile",
        "forza-horizon-4-motion",
        CameraLayoutKey(device_id="portable-camera", lens_id="main", facing="environment"),
    )
    reloaded = ControlLayoutStore(layout_root).get(layout.id)
    if reloaded.name != layout.name or not reloaded.regions:
        raise SystemExit("layout persistence failed")

    mixer = InputIntentEngine([IntentBinding(id="gas", control="RT", kind="axis", any_of=("voice:cruise",))])
    mixer.submit(InputIntent("voice", "cruise", value=1.0, semantics="down"))
    released = mixer.exit()
    if released.values.get("RT") not in (0, 0.0, False):
        raise SystemExit("emergency release failed")

    print(json.dumps({
        "onnx_shape": list(logits.shape),
        "onnx_argmax": int(logits.argmax(axis=1)[0]),
        "preset_ids": sorted(required),
        "layout_id": layout.id,
        "layout_restart_readback": True,
        "emergency_release_value": released.values.get("RT"),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
