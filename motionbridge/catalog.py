from __future__ import annotations

from typing import Any


ACTION_CATALOG: list[dict[str, Any]] = [
    *[
        {"id": signal, "name": name, "kind": kind, "group": "控制意图"}
        for signal, name, kind in [
            ("intent_steer_x", "转向意图", "analog"), ("intent_throttle", "油门意图", "analog"),
            ("intent_brake", "刹车意图", "analog"), ("intent_move_x", "左右移动意图", "analog"),
            ("intent_move_y", "前后移动意图", "analog"), ("intent_handbrake", "手刹意图", "digital"),
            ("intent_light_attack", "轻攻击意图", "digital"), ("intent_heavy_attack", "重攻击意图", "digital"),
            ("intent_dodge", "闪避意图", "digital"), ("intent_jump", "跳跃意图", "digital"),
            ("intent_gourd", "喝葫芦意图", "digital"), ("intent_staff_spin", "棍花意图", "digital"),
            ("intent_lock_target", "锁定意图", "digital"), ("intent_interact", "互动意图", "digital"),
            ("intent_pause", "暂停意图", "digital"), ("intent_map", "地图意图", "digital"),
            ("intent_reset_vehicle", "重置车辆意图", "digital"), ("intent_change_camera", "切换视角意图", "digital"),
            ("intent_rewind", "倒带意图", "digital"), ("intent_shift_up", "升挡意图", "digital"),
            ("intent_shift_down", "降挡意图", "digital"), ("intent_auto_combo", "自动连击意图", "digital"),
        ]
    ],
    {"id": "jump", "name": "跳跃", "kind": "digital", "group": "身体"},
    {"id": "squat", "name": "下蹲", "kind": "digital", "group": "身体"},
    {"id": "left_punch", "name": "左拳", "kind": "digital", "group": "身体"},
    {"id": "right_punch", "name": "右拳", "kind": "digital", "group": "身体"},
    {"id": "left_kick", "name": "左踢", "kind": "digital", "group": "身体"},
    {"id": "right_kick", "name": "右踢", "kind": "digital", "group": "身体"},
    {"id": "left_hand_up", "name": "举左手", "kind": "digital", "group": "身体"},
    {"id": "right_hand_up", "name": "举右手", "kind": "digital", "group": "身体"},
    {"id": "both_hands_up", "name": "双手举起", "kind": "digital", "group": "身体"},
    {"id": "left_fist", "name": "左手握拳", "kind": "digital", "group": "手势"},
    {"id": "right_fist", "name": "右手握拳", "kind": "digital", "group": "手势"},
    {"id": "left_pinch", "name": "左手捏合", "kind": "digital", "group": "手势"},
    {"id": "right_pinch", "name": "右手捏合", "kind": "digital", "group": "手势"},
    {"id": "left_pinch_amount", "name": "左手捏合幅度", "kind": "analog", "group": "手势"},
    {"id": "right_pinch_amount", "name": "右手捏合幅度", "kind": "analog", "group": "手势"},
    {"id": "lean_x", "name": "身体左右倾斜", "kind": "analog", "group": "身体"},
    {"id": "move_x", "name": "身体左右移动", "kind": "analog", "group": "身体"},
    {"id": "voice_move_x", "name": "语音左右移动", "kind": "analog", "group": "语音"},
    {"id": "voice_move_y", "name": "语音前后移动", "kind": "analog", "group": "语音"},
    {"id": "voice_steer", "name": "语音转向", "kind": "analog", "group": "语音"},
    {"id": "voice_throttle", "name": "语音油门", "kind": "analog", "group": "语音"},
    {"id": "voice_brake", "name": "语音刹车", "kind": "analog", "group": "语音"},
    {"id": "guard", "name": "防御", "kind": "digital", "group": "身体"},
    {"id": "torso_roll", "name": "身体横滚体感", "kind": "analog", "group": "体感"},
    {"id": "handheld_stick_x", "name": "手持左摇杆（左右）", "kind": "analog", "group": "手持手柄"},
    {"id": "handheld_stick_y", "name": "手持左摇杆（上下）", "kind": "analog", "group": "手持手柄"},
    *[
        {"id": f"handheld_{name.lower()}", "name": f"手持{name}", "kind": "digital", "group": "手持手柄"}
        for name in ("A", "B", "X", "Y", "L", "R", "ZL", "ZR")
    ],
    {"id": "handheld_start", "name": "手持开始", "kind": "digital", "group": "手持手柄"},
    {"id": "handheld_select", "name": "手持选择", "kind": "digital", "group": "手持手柄"},
    {"id": "handheld_orientation_x", "name": "手持姿态横向", "kind": "analog", "group": "手持手柄"},
    {"id": "handheld_orientation_y", "name": "手持姿态纵向", "kind": "analog", "group": "手持手柄"},
    {"id": "handheld_rotation", "name": "手持旋转", "kind": "analog", "group": "手持手柄"},
    {"id": "handheld_swing", "name": "手持挥动", "kind": "analog", "group": "手持手柄"},
]


CONTROL_CATALOG: dict[str, list[dict[str, str]]] = {
    "keyboard": [
        {"id": key, "name": key}
        for key in ["W", "A", "S", "D", "SPACE", "ENTER", "ESC", "SHIFT", "CTRL", "UP", "DOWN", "LEFT", "RIGHT"]
    ],
    "gamepad_button": [
        {"id": key, "name": key}
        for key in ["A", "B", "X", "Y", "LB", "RB", "BACK", "START", "L3", "R3", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"]
    ],
    "gamepad_axis": [
        {"id": key, "name": name}
        for key, name in [
            ("LX", "左摇杆左右"), ("LY", "左摇杆上下"), ("RX", "右摇杆左右"),
            ("RY", "右摇杆上下"), ("LT", "左扳机"), ("RT", "右扳机"),
        ]
    ],
    "dsu_motion": [{"id": "BODY", "name": "身体体感"}],
}


ACTION_NAMES = {item["id"]: item["name"] for item in ACTION_CATALOG}
