import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerReconnect, matchesComputer, parseConnectionCode, probeCanIdentify, withPairingKey } from "./connection-code";

const code = JSON.stringify({ type: "motioncontrol-connect", version: 1, instance: "0123456789ab",
  name: "电脑", candidates: [{ host: "192.168.1.2", port: 8765, kind: "lan" }] });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("选机与重连", () => {
  it("读取电脑编号和地址，拒绝其他二维码", () => {
    expect(parseConnectionCode(code).instance).toBe("0123456789ab");
    expect(() => parseConnectionCode("https://example.com")).toThrow();
    expect(() => parseConnectionCode(code.replace("192.168.1.2", "example.com"))).toThrow();
  });
  it("扫码存下配对钥匙，连接时带上；旧码没有钥匙就不带", () => {
    const key = "AbCdEfGhIjKlMnOpQrStUv";
    const computer = parseConnectionCode(code.replace('"name"', `"key":"${key}","name"`));
    expect(computer.key).toBe(key);
    // 存下来再读回来还在：重启 App 不用再扫。
    expect(parseConnectionCode(JSON.stringify({ ...computer, role: "camera" })).key).toBe(key);
    expect(withPairingKey("ws://192.168.1.2:8765/ws/input", computer)).toBe(`ws://192.168.1.2:8765/ws/input?key=${key}`);
    const old = parseConnectionCode(code);
    expect(old.key).toBeUndefined();
    expect(withPairingKey("ws://192.168.1.2:8765/ws/input", old)).toBe("ws://192.168.1.2:8765/ws/input");
    expect(withPairingKey("ws://192.168.1.2:8765/ws/input", null)).toBe("ws://192.168.1.2:8765/ws/input");
    // 格式不对的钥匙不收，免得把奇怪的东西拼进地址。
    expect(parseConnectionCode(code.replace('"name"', '"key":"a&b=c","name"')).key).toBeUndefined();
  });
  it("旧地址被另一台电脑使用时不能连错，地址变化后仍认同一台电脑", () => {
    const computer = parseConnectionCode(code);
    expect(matchesComputer({ ok: true, instance: "ffffffffffff" }, computer)).toBe(false);
    expect(matchesComputer({ ok: true }, computer)).toBe(false);
    expect(matchesComputer({ ok: true, instance: computer.instance }, computer)).toBe(true);
    expect(matchesComputer({ ok: true }, null)).toBe(true);
  });
  it("旧壳子的 probe 答不出电脑编号时改走直接读取，不能认定不是这台", () => {
    const computer = parseConnectionCode(code);
    expect(probeCanIdentify({ ok: true }, computer)).toBe(false);
    expect(probeCanIdentify({ ok: true, instance: "" }, computer)).toBe(true);
    expect(probeCanIdentify({ ok: false }, computer)).toBe(true);
    expect(probeCanIdentify({ ok: true }, null)).toBe(true);
  });
  it("电脑还没开时自动重试；手动停止后不再重启", async () => {
    vi.useFakeTimers(); const attempt = vi.fn(async () => {});
    const reconnect = new ComputerReconnect(() => true, () => false, attempt);
    reconnect.activate("camera"); await vi.advanceTimersByTimeAsync(5000);
    expect(attempt).toHaveBeenCalledTimes(3);
    reconnect.cancel(); await vi.advanceTimersByTimeAsync(10000);
    expect(attempt).toHaveBeenCalledTimes(3);
  });
  it("进后台停止重试，回到前台恢复；不会并行启动", async () => {
    vi.useFakeTimers(); let foreground = true, resolve!: () => void;
    const attempt = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const reconnect = new ComputerReconnect(() => foreground, () => false, attempt);
    reconnect.activate("handheld"); reconnect.resume();
    expect(attempt).toHaveBeenCalledTimes(1);
    foreground = false; reconnect.pause(); resolve(); await vi.advanceTimersByTimeAsync(10000);
    expect(attempt).toHaveBeenCalledTimes(1);
    foreground = true; reconnect.resume(); expect(attempt).toHaveBeenCalledTimes(2);
    reconnect.cancel(); resolve(); await vi.advanceTimersByTimeAsync(10000);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
