import test from "node:test";
import assert from "node:assert/strict";
import { StickMouse, bluetoothButtons, relativeTilt } from "./bluetooth-controller.ts";

test("摇杆保持产生连续大移动，松手清空余量且重新按下不补发", () => {
  const mouse = new StickMouse();
  assert.deepEqual(mouse.update({ x: 1, y: -1 }, true, 100, 1800), { dx: 0, dy: 0 });
  assert.deepEqual(mouse.update({ x: 1, y: -1 }, true, 116, 1800), { dx: 28, dy: -28 });
  assert.deepEqual(mouse.update({ x: 1, y: -1 }, false, 117, 1800), { dx: 0, dy: 0 });
  assert.deepEqual(mouse.update({ x: 1, y: -1 }, true, 500, 1800), { dx: 0, dy: 0 });
});
test("摇杆零位无移动，时间间断不会累积大幅跳跃", () => {
  const mouse = new StickMouse();
  mouse.update({ x: 0.01, y: 0 }, true, 100, 1800);
  assert.deepEqual(mouse.update({ x: 0.01, y: 0 }, true, 116, 1800), { dx: 0, dy: 0 });
  assert.deepEqual(mouse.update({ x: 1, y: 0 }, true, 5000, 1800), { dx: 90, dy: 0 });
});
test("手柄多键同时保留；相对居中姿态为零，左右转动方向相反", () => {
  assert.equal(bluetoothButtons(new Set(["a", "r", "start", "zr"])), 0b10100001);
  const q = [0, 0, Math.sin(0.2), Math.cos(0.2)];
  const centered = relativeTilt(q, q);
  assert.ok(Math.abs(centered.rx) < 1e-10 && Math.abs(centered.ry) < 1e-10);
  assert.ok(relativeTilt([0, 0, 0, 1], q).rx > 0);
  assert.ok(relativeTilt(q, [0, 0, 0, 1]).rx < 0);
});
