export type ShooterControlState = {
  stick: { x: number; y: number };
  stickPressed: boolean;
  /** 左键为 1，右键为 2；同时按下为 3。 */
  mouseButtons: number;
};

type Point = { x: number; y: number };
type MouseButton = 1 | 2;

export const SHOOTER_CONTROLS_HTML = `
  <div id="shooterControls" class="shooter-controls hidden">
    <div class="shooter-stick-area" data-shooter-stick-area aria-label="浮动摇杆区域">
      <div class="shooter-instructions">
        <strong>点哪里，摇杆就在哪里</strong>
        <span>按住或拖动摇杆暂停陀螺仪，松手恢复</span>
      </div>
      <div class="shooter-stick-ring hidden" aria-hidden="true"><i class="shooter-stick-knob"></i></div>
      <span class="shooter-gyro-state">松手状态 · 允许陀螺仪</span>
    </div>
    <div class="shooter-mouse-buttons">
      <button type="button" data-shooter-mouse="1" aria-pressed="false"><strong>左键</strong><small>按住射击</small></button>
      <button type="button" data-shooter-mouse="2" aria-pressed="false"><strong>右键</strong><small>按住瞄准</small></button>
    </div>
  </div>`;

/** 每个触点独立释放；只有第一个摇杆触点负责移动和陀螺仪暂停。 */
export class ShooterTouchState {
  private stickPointer: number | null = null;
  private origin: Point | null = null;
  private radius = 1;
  private stick = { x: 0, y: 0 };
  private readonly mousePointers = new Map<number, MouseButton>();

  get state(): ShooterControlState {
    let mouseButtons = 0;
    for (const button of this.mousePointers.values()) mouseButtons |= button;
    return { stick: { ...this.stick }, stickPressed: this.stickPointer !== null, mouseButtons };
  }

  get center(): Point | null { return this.origin ? { ...this.origin } : null; }

  pressStick(pointer: number, x: number, y: number, radius: number): boolean {
    if (this.stickPointer !== null || this.mousePointers.has(pointer)) return false;
    this.stickPointer = pointer;
    this.origin = { x, y };
    this.radius = Math.max(1, radius);
    this.stick = { x: 0, y: 0 };
    return true;
  }

  moveStick(pointer: number, x: number, y: number): boolean {
    if (pointer !== this.stickPointer || !this.origin) return false;
    const dx = (x - this.origin.x) / this.radius;
    const dy = (y - this.origin.y) / this.radius;
    const length = Math.max(1, Math.hypot(dx, dy));
    this.stick = { x: dx / length, y: dy / length };
    return true;
  }

  pressMouse(pointer: number, button: MouseButton): boolean {
    if (pointer === this.stickPointer || this.mousePointers.has(pointer)) return false;
    this.mousePointers.set(pointer, button);
    return true;
  }

  release(pointer: number): boolean {
    if (pointer === this.stickPointer) {
      this.stickPointer = null;
      this.origin = null;
      this.stick = { x: 0, y: 0 };
      return true;
    }
    return this.mousePointers.delete(pointer);
  }

  reset(): void {
    this.stickPointer = null;
    this.origin = null;
    this.stick = { x: 0, y: 0 };
    this.mousePointers.clear();
  }
}

export function createShooterControls(root: HTMLElement, onChange: (state: ShooterControlState) => void): {
  reset(): void;
  destroy(): void;
} {
  const touch = new ShooterTouchState();
  const area = root.querySelector<HTMLElement>("[data-shooter-stick-area]")!;
  const ring = root.querySelector<HTMLElement>(".shooter-stick-ring")!;
  const knob = root.querySelector<HTMLElement>(".shooter-stick-knob")!;
  const gyroState = root.querySelector<HTMLElement>(".shooter-gyro-state")!;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-shooter-mouse]"));
  const captures = new Map<number, HTMLElement>();
  let stickRadius = 1;

  const render = (): void => {
    const state = touch.state;
    const center = touch.center;
    root.classList.toggle("stick-pressed", state.stickPressed);
    ring.classList.toggle("hidden", !state.stickPressed);
    if (center) {
      ring.style.left = `${center.x}px`;
      ring.style.top = `${center.y}px`;
      ring.style.width = `${stickRadius * 2}px`;
      ring.style.height = `${stickRadius * 2}px`;
      knob.style.transform = `translate(${state.stick.x * stickRadius}px, ${state.stick.y * stickRadius}px)`;
    }
    gyroState.textContent = state.stickPressed ? "摇杆按住 · 陀螺仪暂停" : "松手状态 · 允许陀螺仪";
    for (const button of buttons) {
      const pressed = (state.mouseButtons & Number(button.dataset.shooterMouse)) !== 0;
      button.classList.toggle("pressed", pressed);
      button.setAttribute("aria-pressed", String(pressed));
    }
  };
  const publish = (): void => { render(); onChange(touch.state); };
  const releaseCapture = (pointer: number): void => {
    const element = captures.get(pointer);
    captures.delete(pointer);
    if (element?.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
  };
  const reset = (): void => {
    touch.reset();
    for (const pointer of Array.from(captures.keys())) releaseCapture(pointer);
    publish();
  };
  const down = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-shooter-mouse]");
    let accepted: boolean;
    if (button && root.contains(button)) {
      accepted = touch.pressMouse(event.pointerId, Number(button.dataset.shooterMouse) as MouseButton);
    } else {
      const rect = area.getBoundingClientRect();
      stickRadius = Math.min(68, Math.max(36, Math.min(rect.width, rect.height) * 0.2));
      accepted = touch.pressStick(event.pointerId, event.clientX - rect.left, event.clientY - rect.top, stickRadius);
    }
    if (!accepted) return;
    const element = button ?? root;
    captures.set(event.pointerId, element);
    element.setPointerCapture(event.pointerId);
    publish();
  };
  const move = (event: PointerEvent): void => {
    const rect = area.getBoundingClientRect();
    if (touch.moveStick(event.pointerId, event.clientX - rect.left, event.clientY - rect.top)) {
      event.preventDefault();
      publish();
    }
  };
  const release = (event: PointerEvent): void => {
    if (!touch.release(event.pointerId)) return;
    releaseCapture(event.pointerId);
    publish();
  };
  const contextMenu = (event: Event): void => { event.preventDefault(); };
  const visibility = (): void => { if (document.hidden) reset(); };
  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move);
  root.addEventListener("lostpointercapture", release);
  root.addEventListener("contextmenu", contextMenu);
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", reset);
  window.addEventListener("resize", reset);
  document.addEventListener("visibilitychange", visibility);
  render();

  return {
    reset,
    destroy(): void {
      root.removeEventListener("pointerdown", down);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("lostpointercapture", release);
      root.removeEventListener("contextmenu", contextMenu);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", reset);
      window.removeEventListener("resize", reset);
      document.removeEventListener("visibilitychange", visibility);
      reset();
    },
  };
}
