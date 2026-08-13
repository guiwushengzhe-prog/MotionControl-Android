from pathlib import Path

from motionbridge.server import RuntimeState


def test_game_preset_switch_releases_all_sources(tmp_path: Path) -> None:
    state = RuntimeState(tmp_path, enable_outputs=False)
    profile = state.profile_store.create("试用玩家")
    state.select_profile(profile.id)
    state.select_mapping("forza-horizon-4-motion")
    state.voice.states[0]["intent_cruise_on"] = 1.0
    state.intent_engines[0].replace_source("voice", {"intent_cruise_on": 1.0})
    state.select_mapping("black-myth-wukong-motion")
    assert all(value == 0 for value in state.voice.signals(0).values())
    assert state.intent_engines[0].evaluate().values == {}


def test_hybrid_forza_and_wukong_signal_composition(tmp_path: Path) -> None:
    state = RuntimeState(tmp_path, enable_outputs=False)
    profile = state.profile_store.create("混合控制玩家")
    state.select_profile(profile.id)
    state.select_mapping("forza-horizon-4-motion")
    forza = state._compose_signals(0, {"pose_visible": True, "lean_x": .5, "move_x": .5, "crouch_amount": .4})
    assert forza["intent_steer_x"] == .5
    assert forza["intent_brake"] == .4
    state.select_mapping("black-myth-wukong-motion")
    wukong = state._compose_signals(0, {"pose_visible": True, "move_x": -.6, "torso_pitch": .3, "right_punch": True})
    assert wukong["intent_move_x"] == -.6
    assert wukong["intent_light_attack"] is True


def test_action_model_toggle_and_emergency_release(tmp_path: Path) -> None:
    state = RuntimeState(tmp_path, enable_outputs=False)
    state.action_model_enabled[0] = False
    state.last_signals[0] = {"intent_move_x": 1.0}
    state.emergency_stop(0)
    assert state.last_signals[0] == {"pose_visible": False}
    assert state.action_models[0].status()["frames_ready"] == 0
