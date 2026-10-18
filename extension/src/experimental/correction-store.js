import { canRetain, ttlMillis } from "../common/privacy-policy.js";

export const CORRECTIONS_KEY = "bntransLabs:corrections";
export const CORRECTION_LIMITS = Object.freeze({
  items: 200,
  text: 12000,
  bytes: 2000000
});
const byteSize = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

function bounded(value, limit) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    value.includes("\u0000")
  )
    throw new Error("correction-invalid-text");
  return value;
}
export function correctionScope(siteUrl) {
  if (typeof siteUrl !== "string" || siteUrl.length > 4096)
    throw new Error("correction-invalid-site");
  const url = new URL(siteUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("correction-invalid-site");
  return { hostname: url.hostname, scope: url.origin };
}
export function normalizeCorrection(value) {
  if (!value || typeof value !== "object")
    throw new Error("correction-invalid-entry");
  const { hostname, scope } = correctionScope(value.scope);
  if (value.hostname !== hostname || scope !== value.scope)
    throw new Error("correction-invalid-site");
  const language = (input) => {
    if (
      typeof input !== "string" ||
      !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(input)
    )
      throw new Error("correction-invalid-language");
    return input.toLowerCase();
  };
  return {
    hostname,
    scope,
    sourceLanguage: language(value.sourceLanguage),
    targetLanguage: language(value.targetLanguage),
    text: bounded(value.text, CORRECTION_LIMITS.text),
    translation: bounded(value.translation, CORRECTION_LIMITS.text),
    updatedAt:
      Number.isFinite(value.updatedAt) && value.updatedAt >= 0
        ? value.updatedAt
        : 0
  };
}
export function correctionKey(value) {
  return JSON.stringify([
    value.scope,
    value.hostname,
    value.sourceLanguage,
    value.targetLanguage,
    value.text
  ]);
}
export function correctionsAllowed(settings, policy = {}) {
  return (
    settings.enabled !== false &&
    settings.labFeatures?.corrections === true &&
    canRetain(settings, policy, "history") &&
    canRetain(settings, policy, "cache") &&
    ttlMillis(settings, "history") > 0 &&
    ttlMillis(settings, "cache") > 0
  );
}

export function createCorrectionStore({
  storage = chrome.storage.local,
  settings,
  now = Date.now
} = {}) {
  let queue = Promise.resolve(),
    epoch = 0;
  function serial(action) {
    const result = queue.then(action, action);
    queue = result.catch(() => {});
    return result;
  }
  async function allowed(policy, token) {
    const current = await settings();
    if (token !== epoch || !correctionsAllowed(current, policy))
      throw new Error("correction-disabled-or-private");
    return current;
  }
  async function load(current, policy, token) {
    const stored = (await storage.get(CORRECTIONS_KEY))[CORRECTIONS_KEY];
    if (stored?.schemaVersion !== 1) return [];
    const ttl = Math.min(
      ttlMillis(current, "history"),
      ttlMillis(current, "cache")
    );
    const values = [];
    for (const item of (Array.isArray(stored?.items) ? stored.items : []).slice(
      0,
      CORRECTION_LIMITS.items
    )) {
      try {
        if (!Number.isFinite(item?.updatedAt) || item.updatedAt < 0) continue;
        const entry = normalizeCorrection(item);
        if (entry.updatedAt <= now() && now() - entry.updatedAt < ttl)
          values.push(entry);
      } catch {
        /* Corrupt storage is never a match. */
      }
    }
    if (JSON.stringify(stored.items) !== JSON.stringify(values))
      await persist(values, policy, token);
    return values;
  }
  function transaction(policy, action) {
    const token = epoch;
    return serial(async () => {
      const current = await allowed(policy, token);
      const items = await load(current, policy, token);
      await allowed(policy, token);
      return action(items, token);
    });
  }
  async function persist(items, policy, token) {
    if (byteSize(items) > CORRECTION_LIMITS.bytes)
      throw new Error("correction-store-full");
    await allowed(policy, token);
    await storage.set({ [CORRECTIONS_KEY]: { schemaVersion: 1, items } });
    if (token !== epoch) throw new Error("correction-cancelled");
  }
  return {
    list(policy = {}) {
      return transaction(policy, (items) => items);
    },
    async lookup(query, policy = {}) {
      if (!correctionsAllowed(await settings(), policy)) return null;
      const entry = normalizeCorrection({ ...query, translation: "lookup" });
      try {
        return await transaction(
          policy,
          (items) =>
            items.find(
              (item) => correctionKey(item) === correctionKey(entry)
            ) || null
        );
      } catch (error) {
        if (error.message === "correction-disabled-or-private") return null;
        throw error;
      }
    },
    save(value, policy = {}, validate = async () => true) {
      const entry = normalizeCorrection({ ...value, updatedAt: now() });
      return transaction(policy, async (items, token) => {
        const previous = items;
        if (!(await validate())) throw new Error("correction-stale");
        items = items.filter(
          (item) => correctionKey(item) !== correctionKey(entry)
        );
        if (items.length >= CORRECTION_LIMITS.items)
          throw new Error("correction-store-full");
        items.unshift(entry);
        await persist(items, policy, token);
        if (!(await validate())) {
          if (token === epoch)
            await storage.set({
              [CORRECTIONS_KEY]: { schemaVersion: 1, items: previous }
            });
          throw new Error("correction-stale");
        }
        return entry;
      });
    },
    delete(value, policy = {}) {
      const key = correctionKey(
        normalizeCorrection({ ...value, translation: "delete" })
      );
      return transaction(policy, (items, token) =>
        persist(
          items.filter((entry) => correctionKey(entry) !== key),
          policy,
          token
        )
      );
    },
    import(value, policy = {}) {
      if (
        value?.schemaVersion !== 1 ||
        !Array.isArray(value.items) ||
        value.items.length > CORRECTION_LIMITS.items ||
        byteSize(value) > CORRECTION_LIMITS.bytes
      )
        throw new Error("correction-invalid-import");
      const incoming = value.items.map((item) =>
        normalizeCorrection({ ...item, updatedAt: now() })
      );
      return transaction(policy, async (items, token) => {
        const merged = new Map(
          items.map((item) => [correctionKey(item), item])
        );
        for (const item of incoming) merged.set(correctionKey(item), item);
        if (merged.size > CORRECTION_LIMITS.items)
          throw new Error("correction-store-full");
        await persist([...merged.values()], policy, token);
        return merged.size;
      });
    },
    clear() {
      epoch++;
      return serial(() =>
        storage.set({ [CORRECTIONS_KEY]: { schemaVersion: 1, items: [] } })
      );
    }
  };
}
