from __future__ import annotations

from motionbridge.game_presets import GAME_MAPPINGS, get_game_preset_spec
from motionbridge.mapping import DEFAULT_MAPPINGS, MappingStore


def _mapping(mapping_id: str):
    return next(item for item in GAME_MAPPINGS if item.id == mapping_id)


def _binding(mapping_id: str, binding_id: str):
    return next(item for item in _mapping(mapping_id).bindings if item.id == binding_id)


def test_fh4_core_controls_and_safe_defaults() -> None:
    preset = _mapping("forza-horizon-4-motion")
    assert preset.name == "《极限竞速：地平线4》体感"
    targets = {item.id: (item.target.control, item.mode) for item in preset.bindings}
    assert targets["fh4-steer"] == ("LX", "analog")
    assert targets["fh4-throttle"] == ("RT", "analog")
    assert targets["fh4-brake"] == ("LT", "analog")
    assert targets["fh4-handbrake"] == ("A", "pulse")
    assert not _binding(preset.id, "fh4-rewind").enabled
    assert not _binding(preset.id, "fh4-shift-up").enabled
    assert not _binding(preset.id, "fh4-shift-down").enabled
    spec = get_game_preset_spec(preset.id)
    assert spec["variants"] == ["站姿", "坐姿", "低运动量"]
    assert spec["regions"]["driving_zone"]["release_on_exit"] is True
    assert spec["cruise"]["enabled"] is False
    assert "紧急停止" in spec["cruise"]["cancel_on"]
    assert spec["voice_commands"]["cruise_on"]["semantics"] == "toggle"
    assert spec["voice_commands"]["shift_up"]["enabled"] is False


def test_wukong_core_controls_and_attack_zone_default() -> None:
    preset = _mapping("black-myth-wukong-motion")
    assert preset.name == "《黑神话：悟空》体感"
    targets = {item.id: item.target.control for item in preset.bindings}
    assert targets["wukong-move-x"] == "LX"
    assert targets["wukong-move-y"] == "LY"
    assert targets["wukong-light"] == "X"
    assert targets["wukong-heavy"] == "Y"
    assert targets["wukong-dodge"] == "B"
    assert targets["wukong-jump"] == "A"
    assert targets["wukong-gourd"] == "LB"
    assert targets["wukong-staff-spin"] == "LT"
    assert targets["wukong-lock"] == "R3"
    assert targets["wukong-interact"] == "RT"
    assert not _binding(preset.id, "wukong-auto-combo").enabled
    spec = get_game_preset_spec(preset.id)
    assert spec["regions"]["attack_zone"]["enabled"] is False
    assert spec["intents"]["intent_dodge"]["voice_only"] is False
    assert spec["low_motion"]["short_combo"] is False
    assert spec["voice_commands"]["staff_spin"]["semantics"] == "down"


def test_game_presets_are_installed_editable_and_copyable(tmp_path) -> None:
    store = MappingStore(tmp_path / "mappings")
    ids = {item.id for item in store.list()}
    assert {"forza-horizon-4-motion", "black-myth-wukong-motion"} <= ids
    copied = store.create("我的地平线布局", "forza-horizon-4-motion")
    assert copied.id.startswith("preset-")
    assert copied.name == "我的地平线布局"
    copied.bindings[0].deadzone = 0.25
    store.save(copied)
    assert store.get(copied.id).bindings[0].deadzone == 0.25
    assert store.get("forza-horizon-4-motion").bindings[0].deadzone == 0.10


def test_specs_and_default_objects_return_defensive_copies() -> None:
    first = get_game_preset_spec("forza-horizon-4-motion")
    first["variants"].append("被污染")
    assert "被污染" not in get_game_preset_spec("forza-horizon-4-motion")["variants"]
    shipped_ids = {mapping.id for mapping in DEFAULT_MAPPINGS}
    assert {mapping.id for mapping in GAME_MAPPINGS} <= shipped_ids
