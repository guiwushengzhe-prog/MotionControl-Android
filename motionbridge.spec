from pathlib import Path

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules


datas = [
    ("desktop", "desktop"),
    ("mobile/dist", "mobile/dist"),
    ("models/internal-research-only", "models/internal-research-only"),
]
if Path("models/vosk-model-small-cn-0.22").exists():
    datas.append(("models/vosk-model-small-cn-0.22", "models/vosk-model-small-cn-0.22"))

binaries = collect_dynamic_libs("onnxruntime") + collect_dynamic_libs("vosk") + [
    ("motionbridge/outputs/native/x64/ViGEmClient.dll", "motionbridge/outputs/native/x64"),
]

analysis = Analysis(
    ["run_motionbridge.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=collect_submodules("uvicorn") + [
        "numpy",
        "onnxruntime",
        "onnxruntime.capi._pybind_state",
        "onnxruntime.capi.onnxruntime_inference_collection",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["torch", "mmaction", "mmcv", "mmengine", "onnx"],
    noarchive=False,
    optimize=1,
)

pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="MotionBridge-0.4.3-camera-audio-macros",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

collect = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="MotionBridge-0.4.3-camera-audio-macros",
)
