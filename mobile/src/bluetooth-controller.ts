import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type BluetoothState = {
  supported: boolean; enabled: boolean; registered: boolean; connected: boolean;
  deviceName?: string; connecting: boolean; devices: { address: string; name: string }[];
  message: string; sessionId: number;
};
export const BluetoothController = registerPlugin<{
  getStatus(): Promise<BluetoothState>;
  start(): Promise<BluetoothState>;
  requestDiscoverable(): Promise<BluetoothState>;
  connect(options: { address: string }): Promise<BluetoothState>;
  sendMouse(options: { buttons: number; dx: number; dy: number; sessionId: number }): Promise<{ sent: boolean }>;
  sendGamepad(options: { buttons: number; x: number; y: number; rx: number; ry: number; lt: number; rt: number; sessionId: number }): Promise<{ sent: boolean }>;
  releaseAll(): Promise<BluetoothState>;
  stop(): Promise<BluetoothState>;
  addListener(event: "controllerState", listener: (state: BluetoothState) => void): Promise<PluginListenerHandle>;
}>("BluetoothController");

const PAD_BUTTONS = ["a", "b", "x", "y", "l", "r", "select", "start"];
export function bluetoothButtons(pressed: ReadonlySet<string>): number {
  return PAD_BUTTONS.reduce((mask, button, index) => mask | (pressed.has(button) ? 1 << index : 0), 0);
}

// 用触摸摇杆控制较快的连续视角移动，小数保留到下一帧。
export class StickMouse {
  private lastTime = 0;
  private x = 0;
  private y = 0;
  reset(): void { this.lastTime = 0; this.x = this.y = 0; }
  update(stick: { x: number; y: number }, pressed: boolean, now: number, speed: number): { dx: number; dy: number } {
    if (!pressed) { this.reset(); return { dx: 0, dy: 0 }; }
    const dt = this.lastTime ? Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000)) : 0;
    this.lastTime = now;
    const axis = (value: number) => Math.abs(value) <= 0.08 ? 0 : Math.sign(value) * (Math.abs(value) - 0.08) / 0.92;
    this.x += axis(stick.x) * speed * dt;
    this.y += axis(stick.y) * speed * dt;
    const dx = Math.trunc(this.x), dy = Math.trunc(this.y);
    this.x -= dx; this.y -= dy;
    return { dx, dy };
  }
}

export function relativeTilt(base: number[], q: number[]): { rx: number; ry: number } {
  const [a, b, c, d] = base, [x, y, z, w] = q;
  const qx = d*x - a*w - b*z + c*y, qy = d*y + a*z - b*w - c*x;
  const qz = d*z - a*y + b*x - c*w, qw = d*w + a*x + b*y + c*z;
  const yaw = Math.atan2(2*(qw*qz+qx*qy), 1-2*(qy*qy+qz*qz));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2*(qw*qy-qz*qx))));
  return { rx: Math.max(-1, Math.min(1, yaw / 0.65)), ry: Math.max(-1, Math.min(1, -pitch / 0.65)) };
}
