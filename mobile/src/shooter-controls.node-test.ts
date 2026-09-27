import assert from "node:assert/strict";
import test from "node:test";
import { ShooterTouchState } from "./shooter-controls.ts";

// 中心必须是实际落点，靠边按下也不能产生偏移；零位按住同样暂停陀螺仪。
test("浮动中心保持实际落点，零位按住也暂停陀螺仪，释放后回零", () => {
  const touch = new ShooterTouchState();
  assert(touch.pressStick(1, 2, 3, 50), "第一个触点应取得摇杆");
  assert(touch.center?.x === 2 && touch.center?.y === 3, "摇杆中心应保留实际落点");
  assert(touch.state.stickPressed && touch.state.stick.x === 0 && touch.state.stick.y === 0, "摇杆零位按下也应暂停陀螺仪");
  touch.moveStick(1, 52, 53);
  assert(Math.abs(Math.hypot(touch.state.stick.x, touch.state.stick.y) - 1) < 1e-12, "斜向拖动应限制到圆形摇杆边界");
  touch.release(1);
  assert(!touch.state.stickPressed && touch.state.stick.x === 0 && touch.state.stick.y === 0, "松手应回零并恢复陀螺仪");
});

// 第二个摇杆触点移动、抬起都不能改变第一个触点的归属。
test("第二个摇杆触点不能夺取控制或释放第一个触点", () => {
  const touch = new ShooterTouchState();
  touch.pressStick(10, 100, 100, 50);
  assert(!touch.pressStick(11, 200, 200, 50), "第二个触点应被忽略");
  assert(!touch.moveStick(11, 250, 250), "第二个触点不能移动摇杆");
  assert(!touch.release(11) && touch.state.stickPressed, "第二个触点抬起不能恢复陀螺仪");
  touch.moveStick(10, 125, 100);
  assert(touch.state.stick.x === 0.5, "第一个触点应继续控制摇杆");
});

// 左右键可同时按住；同一按键上的多个触点必须分别释放。
test("左右键及同一按键的多个触点各自释放，并且不暂停陀螺仪", () => {
  const touch = new ShooterTouchState();
  touch.pressMouse(1, 1);
  touch.pressMouse(2, 1);
  touch.pressMouse(3, 2);
  assert.deepEqual(touch.state, { stick: { x: 0, y: 0 }, stickPressed: false, mouseButtons: 3 }, "左右键不能暂停陀螺仪");
  touch.release(1);
  assert.equal(touch.state.mouseButtons, 3, "另一左键触点仍按下时应保留左键");
  touch.release(2);
  assert.equal(touch.state.mouseButtons, 2, "左键全部松开后仍应保留右键");
  touch.release(3);
  assert.equal(touch.state.mouseButtons, 0, "左右键都松开后应清空");
});

// 按键与摇杆互相独立；模式切换或取消时必须一起回零。
test("按键释放不影响摇杆，重置清空所有触点并允许下一次触摸", () => {
  const touch = new ShooterTouchState();
  touch.pressStick(1, 80, 80, 50);
  touch.moveStick(1, 80, 55);
  touch.pressMouse(2, 1);
  touch.release(2);
  assert(touch.state.stickPressed && touch.state.stick.y === -0.5, "按键松开不能释放摇杆");
  touch.pressMouse(3, 2);
  touch.reset();
  assert(!touch.state.stickPressed && touch.state.mouseButtons === 0 && touch.center === null, "重置应清空所有触点");
  assert(touch.pressStick(4, 20, 20, 50), "重置后新的触点应能取得摇杆");
});
