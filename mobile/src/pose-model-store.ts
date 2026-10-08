// 高精度模型只由已连接电脑发送；默认安装包继续只带完整身体模型。
export type PoseModelOffer = { id: string; size_bytes: number; sha256: string; request_id: string };
type StoredModel = { blob: Blob; sha256: string; size: number };

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("motioncontrol-vision-models", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("models");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readHeavyModel(): Promise<StoredModel | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("models").objectStore("models").get("heavy");
      request.onsuccess = () => {
        const value = request.result as StoredModel | undefined;
        resolve(value?.blob instanceof Blob && value.blob.size === value.size ? value : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function receiveHeavyModel(base: string, offer: PoseModelOffer, progress: (percent: number) => void): Promise<StoredModel> {
  if (offer.id !== "mp-heavy" || !/^[0-9a-f]{64}$/.test(offer.sha256)
      || !Number.isSafeInteger(offer.size_bytes) || offer.size_bytes < 1_000_000 || offer.size_bytes > 100_000_000) {
    throw new Error("电脑提供的模型信息不完整");
  }
  const cached = await readHeavyModel();
  if (cached?.sha256 === offer.sha256 && cached.size === offer.size_bytes) return cached;
  const response = await fetch(new URL("/api/model/mp-heavy", base), { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error("高精度模型接收失败，请在电脑上重新发送");
  const reader = response.body.getReader(), chunks: ArrayBuffer[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > offer.size_bytes) throw new Error("模型大小与电脑提供的信息不一致");
      chunks.push(next.value.slice().buffer as ArrayBuffer);
      progress(Math.floor(received / offer.size_bytes * 100));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (received !== offer.size_bytes) throw new Error("模型没有接收完整，请重新发送");
  const blob = new Blob(chunks, { type: "application/octet-stream" });
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const digest = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
  if (digest !== offer.sha256) throw new Error("模型校验未通过，请重新发送");
  const saved = { blob, sha256: digest, size: received };
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("models", "readwrite");
      transaction.objectStore("models").put(saved, "heavy");
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
  return saved;
}
