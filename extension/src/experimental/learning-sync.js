import { mergeItems, normalizeVocabulary } from "./learning-store.js";

export const SYNC_PREFIX = "bntransLabs:vocabularySync:v1:";
export const SYNC_ITEM_CAP = 7500;
export const SYNC_TOTAL_CAP = 90000;
const bytes = (value) => new TextEncoder().encode(value).length;
const entryBytes = (key, value) => bytes(key) + bytes(JSON.stringify(value));

// Only normalized vocabulary fields leave local storage; never settings/keys.
export function encodeSync(
  state,
  { itemCap = SYNC_ITEM_CAP, totalCap = SYNC_TOTAL_CAP } = {}
) {
  const items = normalizeVocabulary(state).items;
  const chunks = {};
  let index = 0,
    chunk = { schemaVersion: 1, items: [] };
  const key = () => SYNC_PREFIX + String(index).padStart(3, "0");
  for (const item of items) {
    const candidate = { schemaVersion: 1, items: [...chunk.items, item] };
    if (entryBytes(key(), candidate) > itemCap) {
      if (!chunk.items.length)
        throw new Error(
          "Card too large for Chrome sync / Thẻ quá lớn để đồng bộ Chrome"
        );
      chunks[key()] = chunk;
      index++;
      chunk = { schemaVersion: 1, items: [item] };
      if (entryBytes(key(), chunk) > itemCap)
        throw new Error(
          "Card too large for Chrome sync / Thẻ quá lớn để đồng bộ Chrome"
        );
    } else chunk = candidate;
  }
  chunks[key()] = chunk;
  const total = Object.entries(chunks).reduce(
    (n, [k, v]) => n + entryBytes(k, v),
    0
  );
  if (total > totalCap || Object.keys(chunks).length > 100)
    throw new Error(
      "Vocabulary exceeds sync cap (90 KB); local data is safe / Kho từ vượt giới hạn sync 90 KB; dữ liệu local vẫn an toàn"
    );
  return chunks;
}

export function decodeSync(values) {
  let items = [];
  for (const [key, value] of Object.entries(values || {})) {
    if (!key.startsWith(SYNC_PREFIX)) continue;
    if (value?.schemaVersion !== 1 || !Array.isArray(value.items))
      throw new Error("Invalid sync schema / Dữ liệu đồng bộ sai schema");
    items = mergeItems(items, value.items);
  }
  return normalizeVocabulary({ items });
}

export function mergeSync(local, remote) {
  const state = normalizeVocabulary(local);
  return {
    ...state,
    items: mergeItems(state.items, normalizeVocabulary(remote).items)
  };
}

export function syncBudget(existing, next, quota = 102400) {
  const foreign = Object.entries(existing).filter(
    ([key]) => !key.startsWith(SYNC_PREFIX)
  );
  const bytesUsed = [...foreign, ...Object.entries(next)].reduce(
    (n, [key, value]) => n + entryBytes(key, value),
    0
  );
  if (bytesUsed > quota)
    throw new Error(
      "Chrome sync storage full; local data is safe / Bộ nhớ sync Chrome đầy; dữ liệu local vẫn an toàn"
    );
  if (foreign.length + Object.keys(next).length > 512)
    throw new Error(
      "Chrome sync item limit reached / Đã chạm giới hạn mục sync Chrome"
    );
  return bytesUsed;
}

export function createLearningSync(
  store,
  {
    storage = globalThis.chrome?.storage?.sync,
    changes = globalThis.chrome?.storage?.onChanged,
    onStatus = () => {},
    enabled = async () => true,
    delay = 1500,
    cooldown = 30000
  } = {}
) {
  let disposed = false,
    timer,
    pending = Promise.resolve(),
    lastWrite = 0;
  const flush = () => {
    const work = pending.then(async () => {
      if (disposed || !(await enabled())) return;
      const local = await store.read();
      if (!local.syncEnabled) return;
      if (!storage)
        throw new Error("Chrome sync unavailable / Chrome sync không khả dụng");
      const remote = await storage.get(null);
      if (disposed || !(await enabled()) || !(await store.read()).syncEnabled)
        return;
      const merged = mergeSync(local, decodeSync(remote));
      if (JSON.stringify(local.items) !== JSON.stringify(merged.items))
        await store.update((v) => mergeSync(v, merged));
      const next = encodeSync(await store.read());
      syncBudget(remote, next, storage.QUOTA_BYTES || 102400);
      const updates = Object.fromEntries(
        Object.entries(next).filter(
          ([k, v]) => JSON.stringify(v) !== JSON.stringify(remote[k])
        )
      );
      const stale = Object.keys(remote).filter(
        (k) => k.startsWith(SYNC_PREFIX) && !(k in next)
      );
      if (disposed || !(await enabled()) || !(await store.read()).syncEnabled)
        return;
      if (Object.keys(updates).length || stale.length) {
        const remaining = Math.max(0, cooldown - (Date.now() - lastWrite));
        if (remaining) {
          schedule(remaining);
          return;
        }
        await storage.set(updates);
        if (stale.length) await storage.remove(stale);
        lastWrite = Date.now();
      }
      onStatus("ready");
    });
    pending = work.catch((error) => onStatus("error", error));
    return work;
  };
  function schedule(wait = delay) {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, wait);
  }
  const unsubscribe = store.subscribe(() => schedule());
  const changed = (event, area) => {
    if (
      area === "sync" &&
      Object.keys(event).some((k) => k.startsWith(SYNC_PREFIX))
    ) {
      // Preserve an overwritten concurrent remote chunk as well as its successor.
      const versions = Object.entries(event)
        .filter(([key]) => key.startsWith(SYNC_PREFIX))
        .map(([, value]) => value)
        .flatMap((v) => [v.oldValue, v.newValue])
        .filter((v) => v?.schemaVersion === 1);
      pending = pending
        .then(async () => {
          if (
            disposed ||
            !(await enabled()) ||
            !(await store.read()).syncEnabled
          )
            return;
          for (const value of versions)
            await store.update((v) => mergeSync(v, normalizeVocabulary(value)));
        })
        .catch((error) => onStatus("error", error));
      schedule();
    }
  };
  changes?.addListener(changed);
  schedule();
  return {
    flush,
    async eraseRemote() {
      clearTimeout(timer);
      await pending;
      if (!storage)
        throw new Error("Chrome sync unavailable / Chrome sync không khả dụng");
      const all = await storage.get(null);
      await storage.remove(
        Object.keys(all).filter((k) => k.startsWith(SYNC_PREFIX))
      );
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      changes?.removeListener(changed);
    }
  };
}
