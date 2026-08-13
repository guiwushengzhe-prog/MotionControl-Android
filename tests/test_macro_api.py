from __future__ import annotations

import json

from fastapi.testclient import TestClient

from motionbridge.mapping import MappingStore
from motionbridge.server import create_app


def test_macro_http_crud_and_manual_trigger(tmp_path) -> None:
    app = create_app(tmp_path, enable_outputs=False)
    with TestClient(app) as client:
        catalog = client.get("/api/macros/catalog")
        assert catalog.status_code == 200
        assert catalog.json()["steps"]["chord"] == "同时组合"

        created = client.post("/api/macros", json={"name": "组合测试", "preset_ids": []})
        assert created.status_code == 200
        macro = created.json()
        macro["enabled"] = True
        macro["steps"] = [{
            "type": "chord",
            "targets": [
                {"kind": "gamepad_button", "control": "LB"},
                {"kind": "gamepad_button", "control": "X"},
            ],
            "duration_ms": 80,
        }]
        saved = client.put(f"/api/macros/{macro['id']}", json=macro)
        assert saved.status_code == 200

        triggered = client.post(f"/api/macros/{macro['id']}/trigger", json={"slot": 0})
        assert triggered.status_code == 200
        assert triggered.json()["accepted"] is True

        status = client.get("/api/macros/status").json()
        assert any(run["macro_id"] == macro["id"] for run in status["players"][0]["active"])
        assert client.post(f"/api/macros/{macro['id']}/cancel", json={"slot": 0}).status_code == 200

        exported = client.get(f"/api/macros/{macro['id']}/export")
        assert exported.status_code == 200
        assert exported.json()["id"] == macro["id"]
        assert client.delete(f"/api/macros/{macro['id']}").status_code == 200


def test_known_wukong_trigger_bindings_are_repaired_without_overwriting_custom_edits(tmp_path) -> None:
    root = tmp_path / "mappings"
    root.mkdir(parents=True)
    stale = {
        "version": 2,
        "id": "black-myth-wukong-motion",
        "name": "Wukong",
        "description": "",
        "bindings": [
            {
                "id": "wukong-staff-spin", "signal": "intent_staff_spin",
                "target": {"kind": "gamepad_button", "control": "LT"},
                "mode": "hold", "threshold": 0.58, "release_threshold": 0.319,
                "scale": 1.0, "deadzone": 0.12, "invert": False, "enabled": True,
                "hold_ms": 0, "cooldown_ms": 0,
            },
            {
                "id": "wukong-interact", "signal": "intent_interact",
                "target": {"kind": "gamepad_button", "control": "RT"},
                "mode": "pulse", "threshold": 0.55, "release_threshold": 0.30,
                "scale": 1.0, "deadzone": 0.12, "invert": False, "enabled": True,
                "hold_ms": 0, "cooldown_ms": 420,
            },
            {
                "id": "custom-lt", "signal": "custom",
                "target": {"kind": "gamepad_button", "control": "LT"},
                "mode": "pulse", "threshold": 0.5, "release_threshold": 0.3,
                "scale": 1.0, "deadzone": 0.1, "invert": False, "enabled": False,
                "hold_ms": 0, "cooldown_ms": 0,
            },
        ],
        "voice": {"wake_word": "体感", "wake_word_required": True, "phrases": {}, "output_amplitudes": {}, "command_signals": {}, "semantics": {}},
    }
    (root / "black-myth-wukong-motion.json").write_text(json.dumps(stale, ensure_ascii=False), encoding="utf-8")

    store = MappingStore(root)
    repaired = store.get("black-myth-wukong-motion")
    by_id = {binding.id: binding for binding in repaired.bindings}
    assert by_id["wukong-staff-spin"].target.kind == "gamepad_axis"
    assert by_id["wukong-staff-spin"].mode == "analog"
    assert by_id["wukong-interact"].target.kind == "gamepad_axis"
    assert by_id["wukong-interact"].mode == "analog"
    assert by_id["custom-lt"].target.kind == "gamepad_button"
    assert list((tmp_path / "backups").glob("mapping-repair-*"))


def test_desktop_exposes_visual_macro_editor(tmp_path) -> None:
    app = create_app(tmp_path, enable_outputs=False)
    with TestClient(app) as client:
        html = client.get("/").text
        assert 'id="macroPanel"' in html
        assert 'id="macroStepsBody"' in html
        assert 'id="testMacro"' in html


def test_runtime_voice_signal_enters_macro_scheduler(tmp_path) -> None:
    from motionbridge.macros import MacroControl, MacroDefinition, MacroStep, MacroTrigger
    from motionbridge.server import RuntimeState

    state = RuntimeState(tmp_path, enable_outputs=False)
    preset_id = state.selected_mapping_ids[0]
    assert preset_id is not None
    definition = MacroDefinition(
        id="voice-runtime-test",
        name="语音链路测试",
        enabled=True,
        preset_ids=[preset_id],
        triggers=[MacroTrigger(id="voice", source="voice", signal="intent_spell_one")],
        steps=[MacroStep(type="hold", target=MacroControl(kind="gamepad_button", control="X"), duration_ms=200)],
    )
    state.macro_store.save(definition)
    state.reload_macros()
    state.update_macro_sources(0, voice={"intent_spell_one": 1.0})
    assert state.macro_schedulers[0].status()["active"][0]["macro_id"] == definition.id
