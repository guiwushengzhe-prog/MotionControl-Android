import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GyroMouse, type GyroMouseOptions, type GyroMouseSample } from './gyro-mouse.ts'

const STEP_NS = 10_000_000
const sample = (timestamp: number, values: Partial<GyroMouseSample> = {}): GyroMouseSample => ({
  gx: 0, gy: 0, gz: 0, timestamp, running: true, ...values,
})

function calibratedMouse(bias: Partial<GyroMouseSample> = {}) {
  const mouse = new GyroMouse()
  let timestamp = 1_000_000_000
  let result = mouse.update(sample(timestamp, bias), true)
  for (let step = 0; step < 100; step++) {
    timestamp += STEP_NS
    result = mouse.update(sample(timestamp, bias), true)
    assert.equal(result.dx, 0)
    assert.equal(result.dy, 0)
  }
  assert.equal(result.calibrating, false)
  return { mouse, timestamp }
}

test('导出校准后新实例恢复零偏和重力，首帧无旧位移并拒绝非法缓存', () => {
  const bias = { gx: 0.004, gy: -0.003, gz: 0.005 }
  const { mouse, timestamp } = calibratedMouse({ ...bias, ax: 0, ay: 0, az: 9.80665 })
  mouse.update(sample(timestamp + STEP_NS, { ...bias, gz: bias.gz + 0.025 }), true)
  const saved = mouse.getCalibration()
  assert.deepEqual(saved, { version: 1, bias: [bias.gx, bias.gy, bias.gz], gravity: [0, 0, 1] })
  const restored = new GyroMouse()
  assert.equal(restored.getCalibration(), null)
  assert.equal(restored.restoreCalibration(saved), true)
  assert.deepEqual(restored.update(sample(8_000_000_000, { ...bias, gx: 1, gz: 1 }), true), { dx: 0, dy: 0, calibrating: false })
  assert.deepEqual(restored.update(sample(8_000_000_000 + STEP_NS, bias), true), { dx: 0, dy: 0, calibrating: false })
  for (const invalid of [null, { ...saved, version: 2 }, { ...saved, bias: [0, 0] }, { ...saved, bias: [0, NaN, 0] }, { ...saved, gravity: [0, 0, Infinity] }, { ...saved, gravity: [0, 0, 2] }]) {
    assert.equal(restored.restoreCalibration(invalid), false)
    assert.deepEqual(restored.getCalibration(), saved)
  }
  restored.reset()
  assert.equal(restored.getCalibration(), null)
})

test('只接受运行后的有效时间，稳定握持一秒后去除零偏，重新校准清空状态', () => {
  const mouse = new GyroMouse()
  assert.deepEqual(mouse.update(sample(0), true), { dx: 0, dy: 0, calibrating: true })
  assert.equal(mouse.update(sample(100, { running: false }), true).calibrating, true)
  const bias = { gx: 0.004, gy: -0.003, gz: 0.005 }
  let timestamp = 1_000_000_000
  for (let step = 0; step < 100; step++) {
    assert.equal(mouse.update(sample(timestamp, bias), true).calibrating, true)
    timestamp += STEP_NS
  }
  assert.equal(mouse.update(sample(timestamp, bias), true).calibrating, false)
  assert.deepEqual(mouse.update(sample(timestamp + STEP_NS, bias), true), { dx: 0, dy: 0, calibrating: false })
  mouse.reset()
  assert.equal(mouse.update(sample(timestamp + 2 * STEP_NS, { gz: 0.3 }), true).calibrating, true)
})

test('运动或加速度不稳定时不能校准；之后稳定一秒可恢复', () => {
  const mouse = new GyroMouse()
  let timestamp = 1_000_000_000
  for (let step = 0; step < 120; step++) {
    const result = mouse.update(sample(timestamp, { gz: 0.1 }), true)
    assert.equal(result.calibrating, true)
    timestamp += STEP_NS
  }
  for (let step = 0; step < 120; step++) {
    assert.equal(mouse.update(sample(timestamp, { ax: 0, ay: 0, az: 12 }), true).calibrating, true)
    timestamp += STEP_NS
  }
  for (let step = 0; step < 101; step++) {
    mouse.update(sample(timestamp, { ax: 0, ay: 0, az: 9.80665 }), true)
    timestamp += STEP_NS
  }
  assert.equal(mouse.update(sample(timestamp), true).calibrating, false)
})

test('自然握持的往复抖动可校准，持续转动和大动作仍不能混入零偏', () => {
  const held = new GyroMouse()
  const start = 1_000_000_000
  let result
  for (let step = 0; step <= 100; step++) {
    const phase = 2 * Math.PI * step / 10
    result = held.update(sample(start + step * STEP_NS, {
      gx: 0.004 + 0.018 * Math.sin(phase) + (step === 25 || step === 75 ? 0.06 : 0),
      gy: -0.003 + 0.012 * Math.cos(phase), gz: 0.005 + 0.008 * Math.sin(phase),
      ax: 0, ay: 0, az: 9.80665,
    }), true)
    assert.equal(result.dx, 0)
    assert.equal(result.dy, 0)
  }
  assert.equal(result!.calibrating, false)
  assert.ok(Math.hypot(...held.getCalibration()!.bias) < 0.01)

  const turning = new GyroMouse()
  for (let step = 0; step <= 200; step++) {
    assert.equal(turning.update(sample(start + step * STEP_NS, { gz: 0.05 }), true).calibrating, true)
  }
  const interrupted = new GyroMouse()
  for (let step = 0; step <= 50; step++) interrupted.update(sample(start + step * STEP_NS), true)
  assert.equal(interrupted.update(sample(start + 51 * STEP_NS, { gx: 0.2 }), true).calibrating, true)
  for (let step = 52; step < 152; step++) {
    assert.equal(interrupted.update(sample(start + step * STEP_NS), true).calibrating, true)
  }
  assert.equal(interrupted.update(sample(start + 152 * STEP_NS), true).calibrating, false)
})

test('按住和搓动期间无位移，松手不追补，也不残留低通和小数', () => {
  const { mouse, timestamp: start } = calibratedMouse()
  let timestamp = start + STEP_NS
  mouse.update(sample(timestamp, { gz: 0.01 }), true)
  for (let step = 0; step < 100; step++) {
    timestamp += STEP_NS
    assert.deepEqual(mouse.update(sample(timestamp, { gx: 1, gz: 1 }), false), { dx: 0, dy: 0, calibrating: false })
  }
  timestamp += STEP_NS
  assert.deepEqual(mouse.update(sample(timestamp, { gx: 1, gz: 1 }), true), { dx: 0, dy: 0, calibrating: false })
  timestamp += STEP_NS
  assert.deepEqual(mouse.update(sample(timestamp), true), { dx: 0, dy: 0, calibrating: false })
  timestamp += STEP_NS
  assert.ok(mouse.update(sample(timestamp, { gz: 0.2 }), true).dx < 0)
})

test('摇杆按下并松手短于轮询间隔时，同步暂停仍丢弃运动且保留零偏', () => {
  const bias = { gx: 0.004, gy: -0.003, gz: 0.005 }
  const { mouse, timestamp } = calibratedMouse(bias)
  const beforeTouch = sample(timestamp + STEP_NS, { ...bias, gz: bias.gz + 0.025 })
  assert.equal(mouse.update(beforeTouch, true).dx, 0)
  // 按下回调同步暂停，松手发生在下一次 16ms 轮询前，因此没有 enabled=false 的轮询。
  mouse.pause()
  assert.deepEqual(mouse.update(beforeTouch, true), { dx: 0, dy: 0, calibrating: false })
  const release = sample(timestamp + 2 * STEP_NS, { ...bias, gx: bias.gx + 0.3, gz: bias.gz + 0.3 })
  assert.deepEqual(mouse.update(release, true), { dx: 0, dy: 0, calibrating: false })
  assert.deepEqual(mouse.update(sample(timestamp + 3 * STEP_NS, bias), true), { dx: 0, dy: 0, calibrating: false })
  // 原小数余量和低通值必须已清空，否则这一步会产生多余位移。
  assert.equal(mouse.update(sample(timestamp + 4 * STEP_NS, { ...bias, gz: bias.gz + 0.025 }), true).dx, 0)
  assert.ok(mouse.update(sample(timestamp + 5 * STEP_NS, { ...bias, gz: bias.gz + 0.2 }), true).dx < 0)
})

test('重复时间戳不重复积分；暂停或时间倒退后首帧无跳变', () => {
  const { mouse, timestamp } = calibratedMouse()
  const moving = sample(timestamp + STEP_NS, { gz: 0.2 })
  assert.ok(mouse.update(moving, true).dx < 0)
  for (let repeat = 0; repeat < 50; repeat++) {
    assert.deepEqual(mouse.update(moving, true), { dx: 0, dy: 0, calibrating: false })
  }
  assert.deepEqual(mouse.update(sample(timestamp + 2_000_000_000, { gz: 1 }), true), { dx: 0, dy: 0, calibrating: false })
  assert.deepEqual(mouse.update(sample(timestamp + 2_010_000_000), true), { dx: 0, dy: 0, calibrating: false })
  assert.deepEqual(mouse.update(sample(timestamp - STEP_NS, { gz: 1 }), true), { dx: 0, dy: 0, calibrating: false })
  assert.deepEqual(mouse.update(sample(timestamp), true), { dx: 0, dy: 0, calibrating: false })
})

test('小数持续累积，实际事件间隔决定角速度积分而非调用次数', () => {
  const { mouse, timestamp: start } = calibratedMouse()
  let timestamp = start
  let total = 0
  for (let step = 0; step < 100; step++) {
    timestamp += STEP_NS
    const result = mouse.update(sample(timestamp, { gz: 0.01 }), true)
    if (step === 0) assert.equal(result.dx, 0)
    total += result.dx
  }
  // 一秒 (0.01 - 0.0007) rad/s，对应约 -34.1 个计数。
  assert.equal(total, -34)

  const slow = calibratedMouse()
  let slowTotal = 0
  for (let step = 1; step <= 50; step++) {
    slowTotal += slow.mouse.update(sample(slow.timestamp + step * 2 * STEP_NS, { gz: 0.01 }), true).dx
  }
  assert.equal(slowTotal, total)
})

test('确认静止后缓慢追踪温漂，加速度不稳定时保持原零偏', () => {
  const tracked = calibratedMouse()
  const untracked = calibratedMouse()
  for (let step = 1; step <= 800; step++) {
    const timestamp = tracked.timestamp + step * STEP_NS
    assert.equal(tracked.mouse.update(sample(timestamp, { gz: 0.001, ax: 0, ay: 0, az: 9.80665 }), false).dx, 0)
    untracked.mouse.update(sample(timestamp, { gz: 0.001, ax: 0, ay: 0, az: 12 }), false)
  }
  const resumeTime = tracked.timestamp + 801 * STEP_NS
  const options = { sensitivity: 100 }
  for (const mouse of [tracked.mouse, untracked.mouse]) {
    mouse.update(sample(resumeTime, { gz: 0.01 }), true, options)
  }
  const afterTracking = tracked.mouse.update(sample(resumeTime + STEP_NS, { gz: 0.01 }), true, options)
  const originalBias = untracked.mouse.update(sample(resumeTime + STEP_NS, { gz: 0.01 }), true, options)
  // 八秒追踪约消除 63% 的 0.001 rad/s 温漂，不会直接跳成全部零偏。
  assert.ok(Math.abs(afterTracking.dx) < Math.abs(originalBias.dx))
  assert.ok(Math.abs(afterTracking.dx) > Math.abs(originalBias.dx) * 0.9)
})

test('竖屏与四个旋转方向选择正确俯仰轴，无重力数据时横向默认负 GZ', () => {
  const orientations = [
    { orientation: 0, values: { gx: 0.2 }, sign: -1 },
    { orientation: 90, values: { gy: 0.2 }, sign: -1 },
    { orientation: 180, values: { gx: 0.2 }, sign: 1 },
    { orientation: 270, values: { gy: 0.2 }, sign: 1 },
  ]
  for (const { orientation, values, sign } of orientations) {
    const { mouse, timestamp } = calibratedMouse()
    const options: GyroMouseOptions = { sensitivity: 1, orientation }
    const movement = mouse.update(sample(timestamp + STEP_NS, { ...values, gz: 0.2 }), true, options)
    assert.ok(movement.dx < 0)
    assert.equal(Math.sign(movement.dy), sign)
  }
  const { mouse, timestamp } = calibratedMouse()
  assert.ok(mouse.update(sample(timestamp + STEP_NS, { gx: 0.2 }), true, { sensitivity: 1, orientation: 0 }).dy < 0)
  assert.equal(mouse.update(sample(timestamp + 2 * STEP_NS, { gx: 0.2 }), true, { sensitivity: 1, orientation: 90 }).dy, 0)
  assert.ok(mouse.update(sample(timestamp + 3 * STEP_NS, { gy: 0.2 }), true, { sensitivity: 1, orientation: 90 }).dy < 0)
})

test('平放、竖握和横握沿重力轴转动产生水平位移，其他轴不产生水平位移', () => {
  const poses = [
    { gravity: { ax: 0, ay: 0, az: 9.80665 }, yaw: { gz: 0.2 }, other: { gx: 0.2 } },
    { gravity: { ax: 0, ay: 9.80665, az: 0 }, yaw: { gy: 0.2 }, other: { gz: 0.2 } },
    { gravity: { ax: 9.80665, ay: 0, az: 0 }, yaw: { gx: 0.2 }, other: { gz: 0.2 } },
  ]
  for (const { gravity, yaw, other } of poses) {
    const horizontal = calibratedMouse()
    const movement = horizontal.mouse.update(sample(horizontal.timestamp + STEP_NS, { ...gravity, ...yaw }), true)
    assert.ok(movement.dx < 0)
    assert.equal(movement.calibrating, false)
    // 加速度暂时缺失或异常时沿用上次方向，不把握持轴误改回 Z。
    assert.ok(horizontal.mouse.update(sample(horizontal.timestamp + 2 * STEP_NS, yaw), true).dx < 0)
    assert.ok(horizontal.mouse.update(sample(horizontal.timestamp + 3 * STEP_NS, { ...yaw, ax: 0, ay: 0, az: 12 }), true).dx < 0)
    const orthogonal = calibratedMouse()
    assert.equal(orthogonal.mouse.update(sample(orthogonal.timestamp + STEP_NS, { ...gravity, ...other }), true).dx, 0)
  }
})
