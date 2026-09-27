export interface GyroMouseSample {
  /** Android 陀螺仪角速度，单位为弧度/秒。 */
  gx: number
  gy: number
  gz: number
  /** 陀螺仪事件自己的单调时间，单位为纳秒。 */
  timestamp: number
  running: boolean
  /** 可选 Android 含重力加速度，单位为米/秒²。 */
  ax?: number
  ay?: number
  az?: number
  /** 可选手机坐标到世界坐标的姿态四元数，分量顺序为 x、y、z、w。 */
  qx?: number
  qy?: number
  qz?: number
  qw?: number
}

export interface GyroMouseOptions {
  /** 草图每度 64 个鼠标计数的倍率，默认 1。 */
  sensitivity: number
  /** 屏幕相对自然方向的旋转角，单位为度。 */
  orientation?: number
}

export interface GyroMouseMovement {
  dx: number
  dy: number
  calibrating: boolean
}

export interface GyroMouseCalibration {
  version: 2
  bias: number[]
  gravity: number[]
  referenceQuaternion: number[] | null
}

const CALIBRATION_SECONDS = 1
const CALIBRATION_MIN_SAMPLES = 20
const CALIBRATION_MAX_RATE = 0.15
const CALIBRATION_MAX_MEAN_RATE = 0.035
const CALIBRATION_MAX_STD = 0.02
const MAX_GAP_SECONDS = 0.25
const STILL_RATE = 0.002
const STILL_CONFIRM_SECONDS = 0.15
const BIAS_SECONDS = 8
const LOWPASS_HZ = 25
const DEADZONE_RATE = 0.0007
const COUNTS_PER_RADIAN = 64 * 180 / Math.PI

/**
 * 移植 sketch_sep27b 的零偏、静止追踪、低通、死区和小数累积。
 * 手机使用真实事件时间：不沿用 ESP32 的 960 Hz 或按样本数计时。
 * 移植草图的角速度积分算法，横纵方向均使用校准握持的坐标参考。
 * 横向为角速度在重力轴上的负投影；无重力数据时默认 -GZ。
 */
export class GyroMouse {
  private calibrated = false
  private lastTimestamp = 0
  private wasEnabled = false
  private orientation = 0
  private bias = [0, 0, 0]
  private gravity = [0, 0, 1]
  private referenceQuaternion: number[] | null = null
  private calibrationStart = 0
  private calibrationCount = 0
  private calibrationMean = [0, 0, 0]
  private calibrationM2 = [0, 0, 0]
  private stillSeconds = 0
  private filteredX = 0
  private filteredY = 0
  private filterInitialized = false
  private accumulatedX = 0
  private accumulatedY = 0

  reset(): void {
    this.calibrated = false
    this.lastTimestamp = 0
    this.wasEnabled = false
    this.orientation = 0
    this.bias = [0, 0, 0]
    this.gravity = [0, 0, 1]
    this.referenceQuaternion = null
    this.stillSeconds = 0
    this.clearCalibration()
    this.clearMovement()
  }

  getCalibration(): GyroMouseCalibration | null {
    return this.calibrated ? {
      version: 2, bias: [...this.bias], gravity: [...this.gravity],
      referenceQuaternion: this.referenceQuaternion ? [...this.referenceQuaternion] : null,
    } : null
  }

  restoreCalibration(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const saved = value as Partial<GyroMouseCalibration>
    if (saved.version !== 2 || !Array.isArray(saved.bias) || !Array.isArray(saved.gravity)
      || saved.bias.length !== 3 || saved.gravity.length !== 3
      || ![...saved.bias, ...saved.gravity].every(Number.isFinite)
      || Math.abs(Math.hypot(...saved.gravity) - 1) > 1e-6) return false
    const reference = saved.referenceQuaternion
    if (reference !== null && (!Array.isArray(reference) || reference.length !== 4
      || ![...reference].every(Number.isFinite) || Math.abs(Math.hypot(...reference) - 1) > 1e-6)) return false
    this.reset()
    this.bias = [...saved.bias]
    this.gravity = [...saved.gravity]
    this.referenceQuaternion = reference ? [...reference] : null
    this.calibrated = true
    return true
  }

  /** 触摸按下立即暂停；即使松手早于下次轮询，也不追补触摸期间的运动。 */
  pause(): void {
    this.wasEnabled = false
    this.clearMovement()
  }

  update(sample: GyroMouseSample, enabled: boolean, options?: GyroMouseOptions): GyroMouseMovement {
    if (!enabled) this.pause()
    if (!sample.running || sample.timestamp <= 0 || ![sample.gx, sample.gy, sample.gz, sample.timestamp].every(Number.isFinite)) {
      this.lastTimestamp = 0
      this.wasEnabled = false
      this.stillSeconds = 0
      this.clearCalibration()
      this.clearMovement()
      return this.result()
    }
    if (!this.calibrated && sample.ax !== undefined && sample.ay !== undefined && sample.az !== undefined) {
      const magnitude = Math.hypot(sample.ax, sample.ay, sample.az)
      if (Math.abs(magnitude - 9.80665) < 0.5) {
        this.gravity[0] = sample.ax / magnitude
        this.gravity[1] = sample.ay / magnitude
        this.gravity[2] = sample.az / magnitude
      }
    }
    if (sample.timestamp === this.lastTimestamp) return this.result()

    const dt = (sample.timestamp - this.lastTimestamp) / 1e9
    const continuous = this.lastTimestamp > 0 && dt > 0 && dt <= MAX_GAP_SECONDS
    this.lastTimestamp = sample.timestamp
    if (!continuous) {
      this.wasEnabled = false
      this.stillSeconds = 0
      this.clearCalibration()
      this.clearMovement()
    }

    if (!this.calibrated) {
      this.calibrate(sample)
      // 完成校准的这一帧只建立零偏，避免把校准期间的运动带出。
      this.wasEnabled = enabled
      return this.result()
    }

    let [gx, gy, gz] = [sample.gx - this.bias[0], sample.gy - this.bias[1], sample.gz - this.bias[2]]
    if (continuous && Math.hypot(gx, gy, gz) < STILL_RATE && this.accelerationIsStill(sample)) {
      this.stillSeconds += dt
      if (this.stillSeconds >= STILL_CONFIRM_SECONDS) {
        const alpha = 1 - Math.exp(-dt / BIAS_SECONDS)
        this.bias[0] += gx * alpha
        this.bias[1] += gy * alpha
        this.bias[2] += gz * alpha
        gx = gy = gz = 0
      }
    } else {
      this.stillSeconds = 0
    }

    // 禁用时仍推进时间；松手首帧重新起算，绝不追补按住期间的位移。
    if (!enabled || !this.wasEnabled || !continuous) {
      this.wasEnabled = enabled
      return this.result()
    }
    this.wasEnabled = true

    const currentQuaternion = this.quaternion(sample)
    if (this.referenceQuaternion && currentQuaternion) {
      const [rx, ry, rz, rw] = this.referenceQuaternion
      const [cx, cy, cz, cw] = currentQuaternion
      // inverse(qRef) * qNow 将当前手机轴上的角速度转回校准时的手机轴。
      const x = rw * cx - rx * cw - ry * cz + rz * cy
      const y = rw * cy + rx * cz - ry * cw - rz * cx
      const z = rw * cz - rx * cy + ry * cx - rz * cw
      const w = rw * cw + rx * cx + ry * cy + rz * cz
      const tx = 2 * (y * gz - z * gy)
      const ty = 2 * (z * gx - x * gz)
      const tz = 2 * (x * gy - y * gx)
      gx += w * tx + y * tz - z * ty
      gy += w * ty + z * tx - x * tz
      gz += w * tz + x * ty - y * tx
    }

    const requestedOrientation = options?.orientation ?? 0
    const orientation = Number.isFinite(requestedOrientation) ? ((requestedOrientation % 360) + 360) % 360 : 0
    if (orientation !== this.orientation) {
      this.orientation = orientation
      this.clearMovement()
    }
    const angle = orientation * Math.PI / 180
    const rateX = -(gx * this.gravity[0] + gy * this.gravity[1] + gz * this.gravity[2])
    // 横屏时以屏幕横轴作为俯仰轴：90° 为 -GY，180° 为 +GX。
    const rateY = -(gx * Math.cos(angle) + gy * Math.sin(angle))
    const alpha = 1 - Math.exp(-2 * Math.PI * LOWPASS_HZ * dt)
    if (!this.filterInitialized) {
      this.filteredX = rateX
      this.filteredY = rateY
      this.filterInitialized = true
    } else {
      this.filteredX += alpha * (rateX - this.filteredX)
      this.filteredY += alpha * (rateY - this.filteredY)
    }
    const requestedSensitivity = options?.sensitivity ?? 1
    const sensitivity = Number.isFinite(requestedSensitivity) ? Math.max(0, requestedSensitivity) : 1
    this.accumulatedX += this.deadzone(this.filteredX) * dt * COUNTS_PER_RADIAN * sensitivity
    this.accumulatedY += this.deadzone(this.filteredY) * dt * COUNTS_PER_RADIAN * sensitivity
    const dx = Math.trunc(this.accumulatedX)
    const dy = Math.trunc(this.accumulatedY)
    this.accumulatedX -= dx
    this.accumulatedY -= dy
    return this.result(dx, dy)
  }

  private calibrate(sample: GyroMouseSample): void {
    const rates = [sample.gx, sample.gy, sample.gz]
    if (Math.hypot(...rates) > CALIBRATION_MAX_RATE || !this.accelerationIsStill(sample)) {
      this.clearCalibration()
      return
    }
    if (!this.calibrationStart) this.calibrationStart = sample.timestamp
    this.calibrationCount++
    for (let axis = 0; axis < 3; axis++) {
      const delta = rates[axis] - this.calibrationMean[axis]
      this.calibrationMean[axis] += delta / this.calibrationCount
      this.calibrationM2[axis] += delta * (rates[axis] - this.calibrationMean[axis])
    }
    if ((sample.timestamp - this.calibrationStart) / 1e9 < CALIBRATION_SECONDS || this.calibrationCount < CALIBRATION_MIN_SAMPLES) return
    // 自然握持允许小幅往复抖动；用整秒平均值排除持续转动，避免每次轻微抖动都重新计时。
    const stable = Math.hypot(...this.calibrationMean) <= CALIBRATION_MAX_MEAN_RATE
      && this.calibrationM2.every(value => Math.sqrt(value / this.calibrationCount) <= CALIBRATION_MAX_STD)
    if (stable) {
      this.bias = [...this.calibrationMean]
      this.referenceQuaternion = this.quaternion(sample)
      this.calibrated = true
    }
    this.clearCalibration()
  }

  private accelerationIsStill(sample: GyroMouseSample): boolean {
    if (sample.ax === undefined || sample.ay === undefined || sample.az === undefined) return true
    return Math.abs(Math.hypot(sample.ax, sample.ay, sample.az) - 9.80665) < 0.5
  }

  private quaternion(sample: GyroMouseSample): number[] | null {
    const values = [sample.qx, sample.qy, sample.qz, sample.qw]
    if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) return null
    const quaternion = values as number[]
    const magnitude = Math.hypot(...quaternion)
    return Number.isFinite(magnitude) && magnitude > 1e-6 ? quaternion.map(value => value / magnitude) : null
  }

  private deadzone(rate: number): number {
    return Math.sign(rate) * Math.max(0, Math.abs(rate) - DEADZONE_RATE)
  }

  private clearCalibration(): void {
    this.calibrationStart = 0
    this.calibrationCount = 0
    this.calibrationMean = [0, 0, 0]
    this.calibrationM2 = [0, 0, 0]
  }

  private clearMovement(): void {
    this.filteredX = this.filteredY = this.accumulatedX = this.accumulatedY = 0
    this.filterInitialized = false
  }

  private result(dx = 0, dy = 0): GyroMouseMovement {
    return { dx: dx || 0, dy: dy || 0, calibrating: !this.calibrated }
  }
}
