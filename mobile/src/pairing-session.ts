/**
 * Drives pairing and authentication for one socket.
 *
 * The phone opens two sockets -- one as the fixed camera, one as the handheld
 * sensor -- and each proves itself separately, because the PC binds an
 * identity to the connection rather than to the device. One session object
 * therefore belongs to one socket.
 *
 * State it walks through:
 *
 *   challenge   -> already paired? sign it.
 *                  not paired, and the PC is enforcing? ask for the code it
 *                  is showing.
 *                  not paired, and the PC is not enforcing? say so and carry
 *                  on -- popping a modal for a step the PC does not require
 *                  would just be in the way.
 *   (user types the code)
 *   pair_init   -> pair_challenge -> pair_confirm -> pair_result
 *   then        -> hello, using the nonce from the original challenge, which
 *                  the PC only consumes on a successful hello.
 *
 * An older PC that does not know about pairing never sends a challenge, so
 * this stays dormant and the app behaves exactly as it did before.
 */

import { PairingAttempt, helloMessage, type PairRole } from "./pairing-crypto";
import { loadSecret, storeSecret } from "./pairing";

const PAIRING_MESSAGE_TYPES = new Set([
  "challenge", "pair_challenge", "pair_result", "hello_ack",
]);

/** Cheap synchronous test so callers can bail out before awaiting anything. */
export function isPairingMessage(type: unknown): boolean {
  return typeof type === "string" && PAIRING_MESSAGE_TYPES.has(type);
}

export interface PairingCallbacks {
  /** The PC wants a pairing code; show the prompt. */
  onNeedCode(): void;
  /** Progress or failure text for the user. */
  onStatus(text: string, kind?: "info" | "error"): void;
  /** Authentication finished; the socket may now send frames. */
  onReady(): void;
}

export class PairingSession {
  readonly role: PairRole;
  private readonly deviceId: string;
  private readonly send: (message: unknown) => void;
  private readonly callbacks: PairingCallbacks;

  private nonce: string | null = null;
  private attempt: PairingAttempt | null = null;
  private code = "";
  authenticated = false;
  /** Whether the PC is enforcing pairing on this connection. */
  pairingRequired = false;
  /** False until the PC actually offers a challenge. */
  serverSupportsPairing = false;

  constructor(
    deviceId: string,
    role: PairRole,
    send: (message: unknown) => void,
    callbacks: PairingCallbacks,
  ) {
    this.deviceId = deviceId;
    this.role = role;
    this.send = send;
    this.callbacks = callbacks;
  }

  /** Returns true when the message was a pairing message and was consumed. */
  async handle(message: any): Promise<boolean> {
    if (!isPairingMessage(message?.type)) return false;
    try {
      switch (message.type) {
        case "challenge":
          await this.onChallenge(message);
          break;
        case "pair_challenge":
          await this.onPairChallenge(message);
          break;
        case "pair_result":
          await this.onPairResult(message);
          break;
        case "hello_ack":
          this.authenticated = true;
          this.callbacks.onStatus("设备已通过验证", "info");
          this.callbacks.onReady();
          break;
      }
    } catch (error) {
      this.callbacks.onStatus(
        error instanceof Error ? error.message : "配对失败", "error");
    }
    return true;
  }

  private async onChallenge(message: any): Promise<void> {
    this.serverSupportsPairing = true;
    this.nonce = String(message.nonce || "");
    this.pairingRequired = Boolean(message.pairing_required);
    const secret = await loadSecret(this.deviceId);
    if (secret) {
      this.send(await helloMessage(this.deviceId, this.role, this.nonce, secret));
      return;
    }
    if (!this.pairingRequired) {
      // The PC is not enforcing pairing yet, so demanding a code here would
      // block the player on a step that buys them nothing.  Say it is
      // available and carry on unpaired; the PC accepts protocol-1 traffic
      // while require_paired_devices is off.
      this.callbacks.onStatus("未配对（电脑当前未要求配对）", "info");
      this.callbacks.onReady();
      return;
    }
    this.callbacks.onStatus("这台手机还没有和电脑配对", "info");
    this.callbacks.onNeedCode();
  }

  /** Lets the UI offer pairing on demand even when the PC is not enforcing it. */
  async startPairing(): Promise<void> {
    this.callbacks.onNeedCode();
  }

  /** Called when the user submits the code shown on the PC. */
  async submitCode(code: string): Promise<void> {
    const trimmed = code.trim();
    if (!/^\d{8}$/.test(trimmed)) {
      this.callbacks.onStatus("配对码是 8 位数字", "error");
      return;
    }
    this.code = trimmed;
    this.attempt = new PairingAttempt(this.deviceId, this.role);
    this.callbacks.onStatus("正在与电脑交换密钥…", "info");
    this.send(await this.attempt.initMessage());
  }

  private async onPairChallenge(message: any): Promise<void> {
    if (!this.attempt) throw new Error("配对流程未开始");
    this.send(await this.attempt.confirmMessage(message, this.code, deviceLabel()));
  }

  private async onPairResult(message: any): Promise<void> {
    if (!this.attempt) throw new Error("配对流程未开始");
    // acceptResult verifies the PC proved it holds the same secret before we
    // keep anything -- without that we would be trusting whoever answered.
    const secret = await this.attempt.acceptResult(message, this.code);
    await storeSecret(this.deviceId, secret);
    this.attempt = null;
    this.code = "";
    this.callbacks.onStatus("配对成功", "info");
    if (this.nonce) {
      this.send(await helloMessage(this.deviceId, this.role, this.nonce, secret));
    }
  }
}

function deviceLabel(): string {
  const match = navigator.userAgent.match(/Android[^;)]*;\s*([^;)]+)/);
  return (match?.[1] || "Android 手机").trim().slice(0, 40);
}
