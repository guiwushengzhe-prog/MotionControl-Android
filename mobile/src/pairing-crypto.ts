/**
 * The pairing exchange itself: WebCrypto only, no Capacitor, no DOM.
 *
 * Kept free of platform imports on purpose. The PC half of this protocol is
 * Python, and the only way to know the two agree on every byte -- the order of
 * the MAC parts, the base64 of each public key, the HKDF salt and info -- is
 * to run both against each other. That is possible in plain Node because
 * nothing here needs a WebView. The Capacitor-aware wrapper lives in
 * pairing.ts.
 *
 * Protocol shape, mirroring device_pairing.py:
 *
 *   phone -> pair_init      {device_id, role, pub_phone}
 *   pc    -> pair_challenge {pub_pc, salt}
 *   both  :  Z = ECDH(P-256);  secret = HKDF-SHA256(Z, salt, info|device_id)
 *   phone -> pair_confirm   {mac_phone = HMAC(secret, "phone"|code|pubs...)}
 *   pc    -> pair_result    {mac_pc    = HMAC(secret, "pc"   |code|pubs...)}
 *
 * The secret is never transmitted. The pairing code never leaves the device it
 * was typed into; it only goes into a MAC, so an attacker who relayed the key
 * exchange still has to guess it.
 */

export const PROTOCOL_VERSION = 2;
export const PAIR_PROTOCOL = "ecdh_p256_v1";

const HKDF_INFO_PREFIX = "motioncontrol-pairing-v1|";

export type PairRole = "camera" | "sensor";

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Both sides join their parts with "|" before signing; keep that exact. */
async function hmac(secret: Uint8Array, parts: string[]): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const message = new TextEncoder().encode(parts.join("|"));
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

/**
 * One pairing attempt: holds the ephemeral key across pair_init and
 * pair_confirm, which are separate messages on the socket.
 */
export class PairingAttempt {
  readonly deviceId: string;
  readonly role: PairRole;
  private keyPair: CryptoKeyPair | null = null;
  private publicRaw: Uint8Array | null = null;
  private pcPublicRaw: Uint8Array | null = null;
  private secret: Uint8Array | null = null;

  constructor(deviceId: string, role: PairRole) {
    this.deviceId = deviceId;
    this.role = role;
  }

  /** Step 1: generate an ephemeral key and offer its public half. */
  async initMessage(): Promise<Record<string, unknown>> {
    // extractable=false applies to the private half; WebCrypto exports public
    // keys regardless, and the private half never leaves this object.
    this.keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
    ) as CryptoKeyPair;
    this.publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", this.keyPair.publicKey));
    return {
      type: "pair_init",
      pair_protocol: PAIR_PROTOCOL,
      device_id: this.deviceId,
      role: this.role,
      pub_phone: toBase64(this.publicRaw),
    };
  }

  /** Step 2: derive the shared secret, then prove we know the pairing code. */
  async confirmMessage(
    challenge: { pub_pc: string; salt: string },
    code: string,
    deviceName: string,
  ): Promise<Record<string, unknown>> {
    if (!this.keyPair || !this.publicRaw) throw new Error("请先发送 pair_init");
    this.pcPublicRaw = fromBase64(challenge.pub_pc);
    const pcKey = await crypto.subtle.importKey(
      "raw", this.pcPublicRaw as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, [],
    );
    // ECDH deriveBits yields the X coordinate of the shared point, which is
    // exactly what the PC's cryptography exchange() returns.
    const shared = await crypto.subtle.deriveBits(
      { name: "ECDH", public: pcKey }, this.keyPair.privateKey, 256,
    );
    const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const derived = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: fromBase64(challenge.salt) as BufferSource,
        info: new TextEncoder().encode(HKDF_INFO_PREFIX + this.deviceId),
      },
      hkdfKey,
      256,
    );
    this.secret = new Uint8Array(derived);
    const mac = await hmac(this.secret, [
      "phone", code, toBase64(this.publicRaw), toBase64(this.pcPublicRaw),
    ]);
    return {
      type: "pair_confirm",
      device_id: this.deviceId,
      mac_phone: toBase64(mac),
      device_name: deviceName,
    };
  }

  /**
   * Step 3: check the PC proved it holds the same secret, then hand it back.
   *
   * Storing is the caller's job -- this module stays free of platform APIs.
   * Skipping this check would mean trusting whoever answered, which is exactly
   * how a man in the middle would pair us to itself.
   */
  async acceptResult(result: { mac_pc?: string }, code: string): Promise<Uint8Array> {
    if (!this.secret || !this.publicRaw || !this.pcPublicRaw) throw new Error("配对状态丢失");
    if (!result.mac_pc) throw new Error("电脑没有返回确认值");
    const expected = await hmac(this.secret, [
      "pc", code, toBase64(this.pcPublicRaw), toBase64(this.publicRaw),
    ]);
    if (!equalBytes(fromBase64(result.mac_pc), expected)) {
      throw new Error("电脑确认值不匹配，可能不是你要连接的电脑");
    }
    return this.secret;
  }
}

/**
 * Answer a server challenge for an already-paired device.
 *
 * role is inside the signed message, so a proof made for the camera socket
 * cannot be replayed on the handheld sensor socket.
 */
export async function helloMessage(
  deviceId: string,
  role: PairRole,
  nonce: string,
  secret: Uint8Array,
): Promise<Record<string, unknown>> {
  const proof = await hmac(secret, [nonce, deviceId, String(PROTOCOL_VERSION), role]);
  return {
    type: "hello",
    protocol_version: PROTOCOL_VERSION,
    device_id: deviceId,
    role,
    auth: { mode: "paired_hmac", proof: toBase64(proof) },
  };
}
