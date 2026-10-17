export const VOCABULARY_KEY = "bntransLabs:vocabulary";
export const DAY = 86400000;
const LIMITS = { text: 500, translation: 4000, context: 2000, url: 2000 };
const str = (value, max) =>
  typeof value === "string" ? value.slice(0, max) : "";
const number = (value, fallback = 0) =>
  Number.isFinite(value) && value >= 0 ? value : fallback;

export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    // Query strings/fragments frequently contain access tokens or private IDs.
    return (url.origin + url.pathname).slice(0, LIMITS.url);
  } catch {
    return "";
  }
}

export function normalizeItem(value) {
  if (
    !value ||
    typeof value.id !== "string" ||
    !value.id ||
    !value.text?.trim?.()
  )
    return null;
  return {
    id: str(value.id, 120),
    text: str(value.text, LIMITS.text).trim(),
    translation: str(value.translation, LIMITS.translation),
    context: str(value.context, LIMITS.context),
    url: safeSourceUrl(value.url),
    sourceLanguage: str(value.sourceLanguage, 20) || "en",
    targetLanguage: str(value.targetLanguage, 20) || "vi",
    tags: [
      ...new Set(
        (Array.isArray(value.tags) ? value.tags : [])
          .filter((v) => typeof v === "string")
          .map((v) => v.trim().slice(0, 50))
          .filter(Boolean)
      )
    ]
      .sort()
      .slice(0, 30),
    starred: value.starred === true,
    known: value.known === true,
    createdAt: number(value.createdAt),
    updatedAt: number(value.updatedAt),
    deletedAt: number(value.deletedAt),
    revision: number(value.revision),
    dueAt: number(value.dueAt),
    interval: number(value.interval),
    reviews: number(value.reviews),
    lapses: number(value.lapses)
  };
}

export function normalizeVocabulary(value) {
  if (value?.schemaVersion && value.schemaVersion !== 1)
    throw new Error(
      "Unsupported vocabulary schema / Phiên bản kho từ chưa hỗ trợ"
    );
  return {
    schemaVersion: 1,
    version: number(value?.version),
    items: mergeItems([], Array.isArray(value?.items) ? value.items : []),
    highlightEnabled: value?.highlightEnabled === true,
    highlightLevel: ["beginner", "intermediate", "advanced"].includes(
      value?.highlightLevel
    )
      ? value.highlightLevel
      : "intermediate",
    syncEnabled: value?.syncEnabled === true,
    preferencesUpdatedAt: number(value?.preferencesUpdatedAt)
  };
}

function rank(item) {
  return [
    item.deletedAt > 0 ? 1 : 0,
    item.updatedAt,
    item.revision,
    JSON.stringify(item)
  ];
}
function compare(a, b) {
  const x = rank(a),
    y = rank(b);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}
export function mergeItems(left, right) {
  const items = new Map();
  for (const value of [...left, ...right]) {
    const item = normalizeItem(value);
    if (item && (!items.has(item.id) || compare(item, items.get(item.id)) > 0))
      items.set(item.id, item);
  }
  return [...items.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
}

export function mergeVocabulary(left, right) {
  const a = normalizeVocabulary(left),
    b = normalizeVocabulary(right);
  const prefA = JSON.stringify([
    a.preferencesUpdatedAt,
    a.highlightEnabled,
    a.highlightLevel,
    a.syncEnabled
  ]);
  const prefB = JSON.stringify([
    b.preferencesUpdatedAt,
    b.highlightEnabled,
    b.highlightLevel,
    b.syncEnabled
  ]);
  const prefs =
    a.preferencesUpdatedAt === b.preferencesUpdatedAt
      ? prefA > prefB
        ? a
        : b
      : a.preferencesUpdatedAt > b.preferencesUpdatedAt
        ? a
        : b;
  return {
    ...prefs,
    version: Math.max(a.version, b.version),
    items: mergeItems(a.items, b.items)
  };
}

export function saveItem(
  state,
  input,
  now = Date.now(),
  id = globalThis.crypto.randomUUID()
) {
  const next = normalizeVocabulary(state);
  const old = next.items.find((item) => item.id === (input.id || id));
  if (old?.deletedAt)
    throw new Error(
      "Deleted card cannot be restored / Thẻ đã xóa không thể khôi phục"
    );
  const item = normalizeItem({
    ...old,
    ...input,
    id: old?.id || id,
    createdAt: old?.createdAt ?? now,
    updatedAt: Math.max(now, (old?.updatedAt || 0) + 1),
    deletedAt: 0,
    revision: (old?.revision || 0) + 1,
    dueAt: input.dueAt ?? old?.dueAt ?? now
  });
  if (!item) throw new Error("Enter a word or phrase / Nhập từ hoặc cụm từ");
  return {
    ...next,
    version: next.version + 1,
    items: mergeItems(next.items, [item])
  };
}

export function deleteItem(state, id, now = Date.now()) {
  const next = normalizeVocabulary(state);
  const old = next.items.find((item) => item.id === id);
  if (!old) return next;
  const stamp = Math.max(now, old.updatedAt + 1);
  // Keep the tombstone identity but erase deleted content from future sync/export.
  const tombstone = normalizeItem({
    id,
    text: "[deleted]",
    createdAt: old.createdAt,
    updatedAt: stamp,
    deletedAt: stamp,
    revision: old.revision + 1
  });
  return {
    ...next,
    version: next.version + 1,
    items: mergeItems(next.items, [tombstone])
  };
}

export function reviewItem(state, id, answer, now = Date.now()) {
  const item = normalizeVocabulary(state).items.find(
    (v) => v.id === id && !v.deletedAt && !v.known
  );
  if (!item || item.dueAt > now)
    throw new Error("Card is not due / Thẻ chưa đến hạn");
  if (!["remember", "again"].includes(answer))
    throw new Error("Invalid review answer");
  const interval =
    answer === "again"
      ? 0
      : item.interval === 0
        ? 1
        : item.interval === 1
          ? 3
          : item.interval === 3
            ? 7
            : Math.min(365, Math.round(item.interval * 2));
  return saveItem(
    state,
    {
      ...item,
      interval,
      reviews: item.reviews + 1,
      lapses: item.lapses + (answer === "again" ? 1 : 0),
      dueAt: now + (answer === "again" ? 600000 : interval * DAY)
    },
    now,
    id
  );
}

export function dueQueue(state, now = Date.now(), limit = 20) {
  return normalizeVocabulary(state)
    .items.filter((v) => !v.deletedAt && !v.known && v.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.min(100, limit)));
}

export function filterItems(
  state,
  { search = "", tag = "", starred = false } = {}
) {
  const query = search.toLocaleLowerCase();
  return normalizeVocabulary(state).items.filter(
    (v) =>
      !v.deletedAt &&
      (!tag || v.tags.includes(tag)) &&
      (!starred || v.starred) &&
      [v.text, v.translation, v.context, ...v.tags]
        .join("\n")
        .toLocaleLowerCase()
        .includes(query)
  );
}

export function exportVocabulary(state, separator = ",") {
  if (![",", "\t"].includes(separator)) throw new Error("Invalid separator");
  const cell = (value) => {
    const text = String(value ?? "");
    // Spreadsheet formula injection is possible even in quoted CSV cells.
    const safe = /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const columns = [
    "text",
    "translation",
    "context",
    "url",
    "sourceLanguage",
    "targetLanguage",
    "tags"
  ];
  return [
    columns,
    ...filterItems(state).map((v) =>
      columns.map((k) => (k === "tags" ? v.tags.join(" ") : v[k]))
    )
  ]
    .map((row) => row.map(cell).join(separator))
    .join("\r\n");
}

export function highlightTokens(state) {
  const items = normalizeVocabulary(state).items.filter(
    (v) =>
      !v.deletedAt &&
      /^en(?:-|$)/i.test(v.sourceLanguage) &&
      /^[a-z]+(?:['’-][a-z]+)*$/i.test(v.text)
  );
  const known = new Set(
    items.filter((v) => v.known).map((v) => v.text.toLowerCase())
  );
  return new Set(
    items
      .filter((v) => !v.known && !known.has(v.text.toLowerCase()))
      .map((v) => v.text.toLowerCase())
  );
}

export function createVocabularyStore(
  api,
  {
    locks = globalThis.navigator?.locks,
    changes = globalThis.chrome?.storage?.onChanged,
    onError = () => {}
  } = {}
) {
  let remembered = normalizeVocabulary(null),
    tail = Promise.resolve(),
    disposed = false;
  const listeners = new Set();
  const emit = (value) => {
    if (!disposed) for (const fn of listeners) fn(value);
  };
  const enqueue = (work) => {
    const result = tail.then(() =>
      locks?.request ? locks.request(VOCABULARY_KEY, work) : work()
    );
    tail = result.catch(() => {});
    return result;
  };
  const read = async () => {
    remembered = mergeVocabulary(remembered, await api.get("vocabulary"));
    return remembered;
  };
  const update = (transform) =>
    enqueue(async () => {
      let next = normalizeVocabulary(await transform(await read()));
      for (let attempt = 0; attempt < 5; attempt++) {
        next = mergeVocabulary(next, await api.get("vocabulary"));
        remembered = next;
        await api.set("vocabulary", next);
        const current = normalizeVocabulary(await api.get("vocabulary"));
        const merged = mergeVocabulary(next, current);
        if (JSON.stringify(merged) === JSON.stringify(current)) {
          remembered = merged;
          emit(merged);
          return merged;
        }
        next = merged;
      }
      throw new Error(
        "Concurrent changes; retry / Có cập nhật đồng thời, thử lại"
      );
    });
  const changed = (event, area) => {
    if (disposed || area !== "local" || !event[VOCABULARY_KEY]) return;
    try {
      const { oldValue, newValue } = event[VOCABULARY_KEY];
      remembered = mergeVocabulary(
        remembered,
        mergeVocabulary(oldValue, newValue)
      );
      emit(remembered);
      if (
        JSON.stringify(remembered) !==
        JSON.stringify(normalizeVocabulary(newValue))
      )
        update((v) => v).catch(onError);
    } catch (error) {
      onError(error);
    }
  };
  changes?.addListener(changed);
  return {
    read,
    update,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      disposed = true;
      listeners.clear();
      changes?.removeListener(changed);
    }
  };
}

export function chromeVocabularyApi(
  storage = globalThis.chrome?.storage?.local
) {
  if (!storage)
    throw new Error("Local storage unavailable / Bộ nhớ local không khả dụng");
  return {
    async get(key) {
      const fullKey = "bntransLabs:" + key;
      return (await storage.get(fullKey))[fullKey];
    },
    async set(key, value) {
      await storage.set({ ["bntransLabs:" + key]: value });
    }
  };
}

export async function saveVocabulary(entry) {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage)
    throw new Error("Local storage unavailable / Bộ nhớ local không khả dụng");
  const { translatorSettings } = await storage.get("translatorSettings");
  if (translatorSettings?.labFeatures?.learning !== true)
    throw new Error("Enable Learning Labs first / Cần bật Learning Labs trước");
  const store = createVocabularyStore(chromeVocabularyApi(storage));
  try {
    const id = globalThis.crypto.randomUUID();
    const now = number(entry?.timestamp, Date.now());
    // New IDs deliberately preserve distinct meanings in different contexts.
    const state = await store.update((v) =>
      saveItem(v, { ...entry, id: undefined }, now, id)
    );
    return state.items.find((v) => v.id === id);
  } finally {
    store.dispose();
  }
}
