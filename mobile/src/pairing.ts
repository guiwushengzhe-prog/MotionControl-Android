/**
 * Pairing, wired to Android storage.
 *
 * The exchange itself lives in pairing-crypto.ts, which imports nothing from
 * Capacitor so it can be run against the Python server directly. This file is
 * the thin part that knows where the secret goes.
 *
 * The secret goes to the Keystore-backed SecureStore plugin, never to
 * localStorage: localStorage is ordinary app storage, and the secret is what
 * proves this phone may send gamepad input to the PC. device_id stays in
 * localStorage on purpose -- it identifies, it does not authenticate, which is
 * why the PC verifies an HMAC instead of trusting the id.
 */

import { registerPlugin } from "@capacitor/core";

export {
  PAIR_PROTOCOL,
  PROTOCOL_VERSION,
  PairingAttempt,
  fromBase64,
  helloMessage,
  toBase64,
  type PairRole,
} from "./pairing-crypto";

import { fromBase64, toBase64 } from "./pairing-crypto";

const SECRET_KEY_PREFIX = "pairing-secret:";

interface SecureStoreApi {
  set(options: { key: string; value: string }): Promise<void>;
  get(options: { key: string }): Promise<{ value: string | null }>;
  remove(options: { key: string }): Promise<void>;
}

const SecureStore = registerPlugin<SecureStoreApi>("SecureStore");

export async function loadSecret(deviceId: string): Promise<Uint8Array | null> {
  try {
    const stored = await SecureStore.get({ key: SECRET_KEY_PREFIX + deviceId });
    return stored.value ? fromBase64(stored.value) : null;
  } catch {
    return null;
  }
}

export async function storeSecret(deviceId: string, secret: Uint8Array): Promise<void> {
  await SecureStore.set({ key: SECRET_KEY_PREFIX + deviceId, value: toBase64(secret) });
}

export async function forgetSecret(deviceId: string): Promise<void> {
  try {
    await SecureStore.remove({ key: SECRET_KEY_PREFIX + deviceId });
  } catch {
    /* nothing stored is not an error */
  }
}

/** True when the Keystore-backed store is usable at all. */
export async function secureStoreAvailable(): Promise<boolean> {
  try {
    await SecureStore.get({ key: SECRET_KEY_PREFIX + "__probe" });
    return true;
  } catch {
    return false;
  }
}
