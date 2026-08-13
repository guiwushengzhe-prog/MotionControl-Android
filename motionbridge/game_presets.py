"""First-party game presets and their editor metadata.

The runtime mapping format deliberately stays at v2.  Richer information used by
the layout, voice and Input Intent editors lives beside it so older profiles and
their migration remain readable.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .models import Binding, MappingProfile, Target, VoiceSettings


def _button(binding_id: str, signal: str, control: str, *, enabled: bool = True,
            mode: str = "pulse", threshold: float = 0.55, cooldown_ms: int = 320) -> Binding:
    return Binding(
        id=binding_id,
        signal=signal,
        target=Target(kind="gamepad_button", control=control),
        mode=mode,  # type: ignore[arg-type]
        threshold=threshold,
        release_threshold=max(0.18, threshold * 0.55),
        cooldown_ms=cooldown_ms,
        enabled=enabled,
    )


def _axis(binding_id: str, signal: str, control: str, *, deadzone: float,
          scale: float = 1.0) -> Binding:
    return Binding(
        id=binding_id,
        signal=signal,
        target=Target(kind="gamepad_axis", control=control),
        mode="analog",
        deadzone=deadzone,
        scale=scale,
    )


FH4_VOICE = VoiceSettings(
    wake_word="体感",
    phrases={
        "pause": ["暂停"],
        "map": ["地图", "打开地图"],
        "reset_vehicle": ["重置车辆", "车辆重置"],
        "change_camera": ["切换视角", "换视角"],
        "rewind": ["倒带"],
        "shift_up": ["升挡"],
        "shift_down": ["降挡"],
        "cruise_on": ["巡航", "开始巡航"],
        "cruise_off": ["取消巡航", "结束巡航"],
        "stop": ["停止", "结束"],
        "emergency_stop": ["紧急停止"],
    },
    semantics={
        "pause": "press", "map": "press", "reset_vehicle": "press", "change_camera": "press",
        "rewind": "press", "shift_up": "press", "shift_down": "press",
        "cruise_on": "toggle", "cruise_off": "release",
    },
    command_signals={"cruise_on": "intent_cruise_on", "cruise_off": "intent_cruise_on"},
)


WUKONG_VOICE = VoiceSettings(
    wake_word="体感",
    phrases={
        "lock_target": ["锁定", "锁定目标"],
        "interact": ["互动", "交互"],
        "gourd": ["喝药", "葫芦", "喝葫芦"],
        "staff_spin": ["棍花"],
        "staff_spin_off": ["停止棍花", "结束棍花"],
        "pause": ["暂停"],
        "spell_one": ["法术一"],
        "spell_two": ["法术二"],
        "transform": ["变身"],
        "pillar_stance": ["立棍"],
        "stop": ["停止", "结束"],
        "emergency_stop": ["紧急停止"],
    },
    semantics={
        "lock_target": "press", "interact": "press", "gourd": "press",
        "staff_spin": "down", "staff_spin_off": "release", "pause": "press", "spell_one": "press", "spell_two": "press",
        "transform": "press", "pillar_stance": "press",
    },
    command_signals={"staff_spin": "intent_staff_spin", "staff_spin_off": "intent_staff_spin"},
)


GAME_MAPPINGS = (
    MappingProfile(
        id="forza-horizon-4-motion",
        name="《极限竞速：地平线4》体感",
        description="身体连续转向，驾驶区保持油门，下蹲或后移连续刹车；菜单和低频操作交给语音。",
        voice=FH4_VOICE,
        bindings=[
            _axis("fh4-steer", "intent_steer_x", "LX", deadzone=0.10),
            _axis("fh4-throttle", "intent_throttle", "RT", deadzone=0.02),
            _axis("fh4-brake", "intent_brake", "LT", deadzone=0.02),
            _button("fh4-handbrake", "intent_handbrake", "A", threshold=0.62, cooldown_ms=420),
            _button("fh4-pause", "intent_pause", "START", cooldown_ms=650),
            _button("fh4-map", "intent_map", "BACK", cooldown_ms=650),
            _button("fh4-reset", "intent_reset_vehicle", "DPAD_DOWN", cooldown_ms=650),
            _button("fh4-camera", "intent_change_camera", "RB", cooldown_ms=450),
            _button("fh4-rewind", "intent_rewind", "Y", enabled=False, cooldown_ms=450),
            _button("fh4-shift-down", "intent_shift_down", "X", enabled=False, cooldown_ms=260),
            _button("fh4-shift-up", "intent_shift_up", "B", enabled=False, cooldown_ms=260),
        ],
    ),
    MappingProfile(
        id="black-myth-wukong-motion",
        name="《黑神话：悟空》体感",
        description="髋部连续移动，快速动作负责攻击与闪避；锁定、互动和法术等低频操作优先语音。",
        voice=WUKONG_VOICE,
        bindings=[
            _axis("wukong-move-x", "intent_move_x", "LX", deadzone=0.12),
            _axis("wukong-move-y", "intent_move_y", "LY", deadzone=0.12, scale=1.0),
            _button("wukong-light", "intent_light_attack", "X", threshold=0.64, cooldown_ms=230),
            _button("wukong-heavy", "intent_heavy_attack", "Y", threshold=0.68, cooldown_ms=360),
            _button("wukong-dodge", "intent_dodge", "B", threshold=0.66, cooldown_ms=430),
            _button("wukong-jump", "intent_jump", "A", threshold=0.68, cooldown_ms=520),
            _button("wukong-gourd", "intent_gourd", "LB", mode="hold", threshold=0.58, cooldown_ms=0),
            _axis("wukong-staff-spin", "intent_staff_spin", "LT", deadzone=0.02),
            _button("wukong-lock", "intent_lock_target", "R3", cooldown_ms=480),
            _axis("wukong-interact", "intent_interact", "RT", deadzone=0.02),
            _button("wukong-pause", "intent_pause", "START", cooldown_ms=650),
            _button("wukong-auto-combo", "intent_auto_combo", "X", enabled=False, mode="hold", cooldown_ms=0),
        ],
    ),
)


# Editor-facing metadata.  Sources feed one Input Intent before the v2 binding,
# allowing OR/AND/priority composition without creating duplicate Xbox targets.
GAME_PRESET_SPECS: dict[str, dict[str, Any]] = {
    "forza-horizon-4-motion": {
        "game": "《极限竞速：地平线4》",
        "controller": "Xbox 360 虚拟手柄",
        "editable": True,
        "copyable": True,
        "binding_notice": "Xbox 控件为可编辑建议值，发布前应在游戏控制设置中核对；不声称未经实玩的键位绝对正确。",
        "macro_templates": ["fh4-pause-example"],
        "recommended_transmission": "自动挡",
        "variants": ["站姿", "坐姿", "低运动量"],
        "continuous": {
            "intent_steer_x": {"name": "身体转向", "sources": ["髋中心左右", "躯干倾斜", "手持姿态横向"], "sensitivity": 1.0, "deadzone": 0.10},
            "intent_throttle": {"name": "油门", "sources": ["双手进入驾驶区", "手持ZR", "语音巡航"], "release_on_exit": True},
            "intent_brake": {"name": "刹车", "sources": ["身体后移", "下蹲程度", "手持ZL"], "release_on_exit": True},
        },
        "intents": {
            "intent_handbrake": {"name": "手刹", "sources": ["快速侧跨", "弓步"]},
            "intent_shift_down": {"name": "降挡", "sources": ["左拳", "语音降挡"], "enabled": False},
            "intent_shift_up": {"name": "升挡", "sources": ["右拳", "语音升挡"], "enabled": False},
            "intent_rewind": {"name": "倒带", "sources": ["语音倒带"], "enabled": False},
        },
        "regions": {
            "driving_zone": {"name": "前方驾驶区", "signal": "intent_throttle", "hands": "both", "mode": "hold", "release_on_exit": True, "dwell_ms": 140},
        },
        "cruise": {"enabled": False, "mode": "toggle", "cancel_on": ["刹车", "紧急停止", "断流"]},
        "voice_commands": {
            "pause": {"name": "暂停", "signal": "intent_pause", "semantics": "press", "enabled": True},
            "map": {"name": "地图", "signal": "intent_map", "semantics": "press", "enabled": True},
            "reset_vehicle": {"name": "重置车辆", "signal": "intent_reset_vehicle", "semantics": "press", "enabled": True},
            "change_camera": {"name": "切换视角", "signal": "intent_change_camera", "semantics": "press", "enabled": True},
            "rewind": {"name": "倒带", "signal": "intent_rewind", "semantics": "down", "enabled": False},
            "shift_up": {"name": "升挡", "signal": "intent_shift_up", "semantics": "press", "enabled": False},
            "shift_down": {"name": "降挡", "signal": "intent_shift_down", "semantics": "press", "enabled": False},
            "cruise_on": {"name": "巡航", "signal": "intent_cruise", "semantics": "toggle", "enabled": False},
            "cruise_off": {"name": "取消巡航", "signal": "intent_cruise", "semantics": "release", "enabled": False},
        },
    },
    "black-myth-wukong-motion": {
        "game": "《黑神话：悟空》",
        "controller": "Xbox 360 虚拟手柄",
        "editable": True,
        "copyable": True,
        "binding_notice": "Xbox 控件为可编辑建议值，特别是闪避、轻击、重击与棍花，请按自己的游戏设置核对。",
        "macro_templates": ["wukong-staff-spin-example", "wukong-dodge-light-example"],
        "variants": ["标准", "低运动量"],
        "continuous": {
            "intent_move_x": {"name": "左右移动", "sources": ["髋中心左右", "手持左摇杆X"], "sensitivity": 1.0, "deadzone": 0.12},
            "intent_move_y": {"name": "前后移动", "sources": ["髋中心前后", "手持左摇杆Y"], "sensitivity": 1.0, "deadzone": 0.12},
        },
        "intents": {
            "intent_light_attack": {"name": "轻攻击", "sources": ["右拳", "手持X"]},
            "intent_heavy_attack": {"name": "重攻击", "sources": ["左拳", "手持Y"]},
            "intent_dodge": {"name": "闪避", "sources": ["快速浅蹲", "快速侧跨", "手持B"], "voice_only": False},
            "intent_jump": {"name": "跳跃", "sources": ["双臂快速举起", "手持A"]},
            "intent_gourd": {"name": "喝葫芦", "sources": ["左手高举", "语音喝葫芦", "葫芦区"]},
            "intent_staff_spin": {"name": "棍花", "sources": ["双手前举", "语音棍花", "棍花区"]},
            "intent_lock_target": {"name": "锁定", "sources": ["右手高举", "语音锁定", "锁定区"]},
            "intent_interact": {"name": "互动", "sources": ["语音互动", "手持RT"]},
        },
        "regions": {
            "gourd_zone": {"name": "葫芦区", "signal": "intent_gourd", "enabled": False, "mode": "hold", "release_on_exit": True, "dwell_ms": 180},
            "staff_spin_zone": {"name": "棍花区", "signal": "intent_staff_spin", "enabled": False, "mode": "hold", "release_on_exit": True, "dwell_ms": 160},
            "lock_zone": {"name": "锁定区", "signal": "intent_lock_target", "enabled": False, "mode": "pulse", "dwell_ms": 220},
            "attack_zone": {"name": "攻击区", "enabled": False, "reason": "避免误触高频攻击"},
        },
        "low_motion": {"enabled": False, "short_combo": False, "replace_high_effort_with": ["语音", "区域", "手持按钮"]},
        "voice_commands": {
            "lock_target": {"name": "锁定", "signal": "intent_lock_target", "semantics": "press", "enabled": True},
            "interact": {"name": "互动", "signal": "intent_interact", "semantics": "press", "enabled": True},
            "gourd": {"name": "喝葫芦", "signal": "intent_gourd", "semantics": "press", "enabled": True},
            "staff_spin": {"name": "棍花", "signal": "intent_staff_spin", "semantics": "down", "enabled": True},
            "pause": {"name": "暂停", "signal": "intent_pause", "semantics": "press", "enabled": True},
            "spell_one": {"name": "法术一", "signal": "intent_spell_one", "semantics": "press", "enabled": True},
            "spell_two": {"name": "法术二", "signal": "intent_spell_two", "semantics": "press", "enabled": True},
            "transform": {"name": "变身", "signal": "intent_transform", "semantics": "press", "enabled": True},
            "pillar_stance": {"name": "立棍", "signal": "intent_pillar_stance", "semantics": "press", "enabled": True},
        },
    },
}


def get_game_preset_spec(mapping_id: str) -> dict[str, Any]:
    """Return a defensive copy suitable for an editor or layout instance."""
    try:
        return deepcopy(GAME_PRESET_SPECS[mapping_id])
    except KeyError as exc:
        raise KeyError(f"unknown game preset: {mapping_id}") from exc
