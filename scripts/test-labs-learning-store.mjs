import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY,
  VOCABULARY_KEY,
  normalizeVocabulary,
  normalizeItem,
  saveItem,
  deleteItem,
  mergeItems,
  mergeVocabulary,
  dueQueue,
  reviewItem,
  filterItems,
  exportVocabulary,
  highlightTokens,
  createVocabularyStore,
  saveVocabulary
} from "../extension/src/experimental/learning-store.js";
import {
  encodeSync,
  decodeSync,
  mergeSync,
  syncBudget,
  SYNC_PREFIX,
  createLearningSync
} from "../extension/src/experimental/learning-sync.js";
import {
  parseLearningResponse,
  learningPrompt
} from "../extension/src/experimental/learning.js";
import { rankedEnglishWords } from "../extension/src/experimental/learning-frequency-data.js";
import {
  frequencyRank,
  shouldHighlightEnglishWord
} from "../extension/src/experimental/learning-frequency.js";

const card = (id = "word", patch = {}) =>
  normalizeItem({
    id,
    text: "bank",
    translation: "bờ sông",
    context: 'The "bank", by the river.\nCâu ví dụ.',
    url: "https://user:pass@example.com/story?api_key=SECRET#private",
    sourceLanguage: "en",
    targetLanguage: "vi",
    createdAt: 1000,
    updatedAt: 1000,
    dueAt: 1000,
    ...patch
  });
const vocab = (...items) => normalizeVocabulary({ items });
const clone = (value) => structuredClone(value);
test("local licensed frequency ranks approximate levels; saved and known win", () => {
  assert.equal(rankedEnglishWords.length, 10000);
  assert.equal(frequencyRank("you"), 1);
  for (const [level, boundary] of [
    ["beginner", 1000],
    ["intermediate", 3000],
    ["advanced", 7000]
  ]) {
    assert.equal(
      shouldHighlightEnglishWord(rankedEnglishWords[boundary - 1], level),
      false
    );
    assert.equal(
      shouldHighlightEnglishWord(rankedEnglishWords[boundary], level),
      true
    );
  }
  assert.equal(
    shouldHighlightEnglishWord("you", "advanced", new Set(["you"])),
    true
  );
  assert.equal(
    shouldHighlightEnglishWord(
      "you",
      "beginner",
      new Set(["you"]),
      new Set(["you"])
    ),
    false
  );
  assert.equal(
    shouldHighlightEnglishWord(
      "uncommon",
      "advanced",
      new Set(),
      new Set(),
      false
    ),
    false
  );
  assert.equal(shouldHighlightEnglishWord("Propername", "beginner"), false);
  assert.equal(shouldHighlightEnglishWord("banké", "beginner"), false);
  assert.equal(shouldHighlightEnglishWord("bank_", "beginner"), false);
  assert.equal(shouldHighlightEnglishWord("12bank", "beginner"), false);
  assert.equal(shouldHighlightEnglishWord("unknown", "invalid"), false);
  const original = normalizeVocabulary(null);
  assert.equal(original.highlightLevel, "intermediate");
  assert.equal(
    normalizeVocabulary({ highlightLevel: "malicious" }).highlightLevel,
    "intermediate"
  );
  assert.equal(
    mergeVocabulary(
      { ...original, highlightLevel: "beginner", preferencesUpdatedAt: 2 },
      { ...original, highlightLevel: "advanced", preferencesUpdatedAt: 3 }
    ).highlightLevel,
    "advanced"
  );
});
const settle = async () => {
  for (let i = 0; i < 12; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
function eventBus() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (event, area) => {
      for (const fn of listeners) fn(clone(event), area);
    },
    get size() {
      return listeners.size;
    }
  };
}
function localHarness(bus = eventBus()) {
  let data = {};
  const storage = {
    async get(key) {
      if (key === null) return clone(data);
      return clone({ [key]: data[key] });
    },
    async set(values) {
      const event = {};
      for (const [key, value] of Object.entries(values)) {
        event[key] = { oldValue: data[key], newValue: clone(value) };
        data[key] = clone(value);
      }
      bus.emit(event, "local");
    }
  };
  const api = {
    async get(key) {
      return (await storage.get("bntransLabs:" + key))["bntransLabs:" + key];
    },
    async set(key, value) {
      await storage.set({ ["bntransLabs:" + key]: value });
    }
  };
  return { storage, api, bus };
}

test("versioned allowlisted storage, context identity, UTF-8 export and source sanitization", () => {
  let state = saveItem(
    null,
    { ...card("a"), apiKey: "SECRET", settings: { password: "SECRET" } },
    1000,
    "a"
  );
  state = saveItem(
    state,
    {
      ...card("b"),
      context: "I went to the bank to deposit money.",
      translation: "ngân hàng"
    },
    1000,
    "b"
  );
  assert.equal(state.items.length, 2);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.items[0].url, "https://example.com/story");
  assert.ok(!JSON.stringify(state).includes("SECRET"));
  assert.match(exportVocabulary(state), /bờ sông/);
  assert.match(
    exportVocabulary(state),
    /The ""bank"", by the river\.\nCâu ví dụ\./
  );
  assert.match(exportVocabulary(state, "\t"), /"text"\t"translation"/);
  assert.ok(
    !exportVocabulary(deleteItem(state, "a", 2000)).includes("bờ sông")
  );
  assert.throws(() => normalizeVocabulary({ schemaVersion: 2 }), /schema/);
  assert.throws(() => saveItem(state, { text: " " }), /Enter/);
  const formula = vocab(
    card("danger", { text: " =SUM(A1)", translation: "@cmd" })
  );
  assert.match(exportVocabulary(formula), /'=SUM/);
  assert.match(exportVocabulary(formula), /'@cmd/);
});

test("edits, tags, star, delete and history-independent persistence beyond 50 entries", () => {
  let state = null;
  for (let i = 0; i < 65; i++)
    state = saveItem(
      state,
      { text: "word" + i, tags: [" test ", "test"] },
      1000 + i,
      "id" + i
    );
  state = saveItem(
    state,
    { id: "id1", translation: "nghĩa mới", starred: true, tags: ["river"] },
    3000,
    "id1"
  );
  const restarted = normalizeVocabulary(JSON.parse(JSON.stringify(state)));
  assert.equal(restarted.items.length, 65);
  assert.equal(
    filterItems(restarted, { search: "NGHĨA", tag: "river", starred: true })
      .length,
    1
  );
  assert.equal(restarted.items.find((v) => v.id === "id1").createdAt, 1001);
  assert.deepEqual(restarted.items[0].tags, ["test"]);
  const deleted = deleteItem(state, "id1", 4000);
  assert.equal(filterItems(deleted).length, 64);
  assert.throws(
    () => saveItem(deleted, { id: "id1", text: "resurrect" }, 9000, "id1"),
    /Deleted/
  );
});

test("deterministic merge is commutative/idempotent/associative; tombstones beat future stale edits", () => {
  const a = card("same", { translation: "A", updatedAt: 2000, revision: 2 });
  const b = card("same", { translation: "B", updatedAt: 2000, revision: 2 });
  const c = card("other");
  const left = mergeItems([a], [b, c]);
  assert.deepEqual(left, mergeItems([b, c], [a]));
  assert.deepEqual(left, mergeItems(left, left));
  assert.deepEqual(
    mergeItems(mergeItems([a], [b]), [c]),
    mergeItems([a], mergeItems([b], [c]))
  );
  const deleted = deleteItem(vocab(a), "same", 2500);
  const result = mergeVocabulary(
    deleted,
    vocab({ ...b, updatedAt: 9999999999 })
  );
  assert.ok(result.items[0].deletedAt > 0);
  assert.equal(result.items[0].text, "[deleted]");
  assert.equal(result.items[0].context, "");
});

test("SRS fake clock: due only, 1/3/7 days, Again 10 minutes, restart and session cap", () => {
  let state = vocab(
    card("due"),
    card("future", { dueAt: 999999 }),
    card("known", { known: true })
  );
  assert.deepEqual(
    dueQueue(state, 1000).map((v) => v.id),
    ["due"]
  );
  state = reviewItem(state, "due", "remember", 1000);
  assert.equal(state.items.find((v) => v.id === "due").dueAt, 1000 + DAY);
  assert.throws(() => reviewItem(state, "due", "remember", 1001), /not due/);
  state = reviewItem(state, "due", "remember", 1000 + DAY);
  assert.equal(state.items.find((v) => v.id === "due").interval, 3);
  state = reviewItem(state, "due", "remember", 1000 + DAY * 4);
  assert.equal(state.items.find((v) => v.id === "due").interval, 7);
  state = reviewItem(state, "due", "again", 1000 + DAY * 11);
  const restarted = normalizeVocabulary(JSON.parse(JSON.stringify(state)));
  assert.equal(
    restarted.items.find((v) => v.id === "due").dueAt,
    1000 + DAY * 11 + 600000
  );
  assert.equal(restarted.items.find((v) => v.id === "due").lapses, 1);
  assert.equal(
    dueQueue(
      vocab(...Array.from({ length: 30 }, (_, i) => card("i" + i))),
      1000
    ).length,
    20
  );
});

test("highlights use only saved unknown whole English words; known excludes all senses", () => {
  const state = vocab(
    card("a"),
    card("b", { known: true }),
    card("c", { text: "river" }),
    card("d", { text: "two words" }),
    card("e", { text: "fleuve", sourceLanguage: "fr" })
  );
  assert.deepEqual([...highlightTokens(state)], ["river"]);
  assert.equal(normalizeVocabulary(null).highlightEnabled, false);
  assert.equal(normalizeVocabulary(null).syncEnabled, false);
});

test("store uses lock, refreshes on change, reconciles lost concurrent update, cleans listener", async () => {
  const { api, bus } = localHarness();
  let lockCalls = 0;
  const store = createVocabularyStore(api, {
    changes: bus,
    locks: {
      async request(key, callback) {
        assert.equal(key, VOCABULARY_KEY);
        lockCalls++;
        return callback();
      }
    }
  });
  let refreshed = 0;
  store.subscribe(() => refreshed++);
  await store.update((v) => saveItem(v, card("a"), 1000, "a"));
  await api.set("vocabulary", vocab(card("b")));
  await store.update((v) => v);
  assert.deepEqual(
    (await api.get("vocabulary")).items.map((v) => v.id),
    ["a", "b"]
  );
  assert.ok(lockCalls > 0 && refreshed > 0);
  store.dispose();
  assert.equal(bus.size, 0);
});

test("canonical saveVocabulary rejects disabled and survives restart, no history coupling", async () => {
  const { storage, bus } = localHarness();
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local: storage, onChanged: bus } };
  try {
    await assert.rejects(
      saveVocabulary({ text: "synthetic" }),
      /Enable Learning/
    );
    await storage.set({
      translatorSettings: {
        labFeatures: { learning: true },
        translationHistory: Array(50).fill({ text: "noise" })
      }
    });
    const saved = await saveVocabulary({
      text: "synthetic",
      translation: "tổng hợp",
      timestamp: 1234,
      url: "https://example.com/a?key=SECRET"
    });
    assert.equal(saved.createdAt, 1234);
    assert.equal(saved.translation, "tổng hợp");
    await storage.set({
      translatorSettings: {
        labFeatures: { learning: true },
        translationHistory: []
      }
    });
    const stored = (await storage.get(VOCABULARY_KEY))[VOCABULARY_KEY];
    assert.equal(stored.items.length, 1);
    assert.ok(!JSON.stringify(stored).includes("SECRET"));
    assert.equal(bus.size, 0);
  } finally {
    globalThis.chrome = previous;
  }
});

test("parallel stores without Web Locks retain independent updates through event reconciliation", async () => {
  const { api, bus } = localHarness(),
    errors = [];
  const a = createVocabularyStore(api, {
    changes: bus,
    locks: undefined,
    onError: (e) => errors.push(e)
  });
  const b = createVocabularyStore(api, {
    changes: bus,
    locks: undefined,
    onError: (e) => errors.push(e)
  });
  try {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? a : b).update((v) =>
          saveItem(v, { text: "word" + i }, 1000, "parallel" + i)
        )
      )
    );
    await settle();
    assert.equal((await api.get("vocabulary")).items.length, 10);
    assert.equal(errors.length, 0);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test("sync quota rejection is visible, keeps local cards, and never writes when disabled", async () => {
  const { api, bus } = localHarness();
  const statuses = [];
  let writes = 0;
  const store = createVocabularyStore(api, { changes: bus });
  await store.update(() => ({ ...vocab(card()), syncEnabled: true }));
  const sync = createLearningSync(store, {
    storage: {
      async get() {
        return {};
      },
      async set() {
        writes++;
        throw new Error("Synthetic Chrome quota rejection");
      }
    },
    changes: eventBus(),
    delay: 60000,
    cooldown: 0,
    onStatus: (kind, error) => statuses.push([kind, error?.message])
  });
  try {
    await assert.rejects(sync.flush(), /quota rejection/);
    assert.equal(statuses.at(-1)[0], "error");
    assert.equal((await store.read()).items.length, 1);
    await store.update((v) => ({
      ...v,
      syncEnabled: false,
      preferencesUpdatedAt: 1000
    }));
    const before = writes;
    await sync.flush();
    assert.equal(writes, before);
  } finally {
    sync.dispose();
    store.dispose();
  }
});

test("sync onChanged preserves overwritten own chunks but never imports foreign settings", async () => {
  const { api, bus } = localHarness(),
    changes = eventBus();
  const store = createVocabularyStore(api, { changes: bus });
  await store.update(() => ({ ...vocab(card("local")), syncEnabled: true }));
  const sync = createLearningSync(store, {
    storage: {
      async get() {
        return {};
      },
      async set() {}
    },
    changes,
    delay: 60000,
    cooldown: 0
  });
  try {
    changes.emit(
      {
        [SYNC_PREFIX + "000"]: {
          oldValue: { schemaVersion: 1, items: [card("old")] },
          newValue: { schemaVersion: 1, items: [card("new")] }
        },
        foreignSettings: {
          newValue: { schemaVersion: 1, items: [card("not-vocabulary")] }
        }
      },
      "sync"
    );
    await settle();
    assert.deepEqual(
      (await store.read()).items.map((v) => v.id),
      ["local", "new", "old"]
    );
  } finally {
    sync.dispose();
    store.dispose();
  }
});

test("dictionary validates JSON rather than fabricating plain translations", () => {
  const valid = {
    meaning: "bờ sông",
    pos: "noun",
    ipa: null,
    gender: null,
    synonyms: ["shore"],
    example: null
  };
  assert.deepEqual(
    parseLearningResponse(
      "dictionary",
      "```json\n" + JSON.stringify(valid) + "\n```",
      "bank"
    ),
    valid
  );
  assert.throws(() => parseLearningResponse("dictionary", "ngân hàng", "bank"));
  assert.throws(() =>
    parseLearningResponse(
      "dictionary",
      JSON.stringify({ ...valid, synonyms: [1] }),
      "bank"
    )
  );
  assert.throws(() =>
    parseLearningResponse(
      "dictionary",
      JSON.stringify({ meaning: "bank" }),
      "bank"
    )
  );
  assert.ok(learningPrompt("dictionary").includes("untrusted data"));
});

test("grammar offsets align to exact UTF-16 substrings, including nested clauses", () => {
  const source = "While 😀 I read, she left.";
  const valid = {
    summary: "Hai mệnh đề",
    spans: [
      {
        start: 0,
        end: 15,
        text: source.slice(0, 15),
        label: "Phụ",
        explanation: "Mệnh đề thời gian"
      },
      {
        start: 17,
        end: source.length,
        text: source.slice(17),
        label: "Chính",
        explanation: "Hành động chính"
      }
    ]
  };
  assert.deepEqual(
    parseLearningResponse("grammar", JSON.stringify(valid), source),
    valid
  );
  assert.throws(
    () =>
      parseLearningResponse(
        "grammar",
        JSON.stringify({ ...valid, spans: [{ ...valid.spans[0], end: 999 }] }),
        source
      ),
    /alignment/
  );
  assert.throws(
    () =>
      parseLearningResponse(
        "grammar",
        JSON.stringify({
          ...valid,
          spans: [{ ...valid.spans[0], text: "hallucination" }]
        }),
        source
      ),
    /alignment/
  );
});

test("sync chunk UTF-8 quota, total cap, allowlist, deterministic conflict and tombstones", () => {
  const state = vocab(
    ...Array.from({ length: 25 }, (_, i) =>
      card("id" + i, { context: "đ".repeat(400), translation: "Unicode 🦜" })
    )
  );
  state.apiKey = "SECRET";
  const encoded = encodeSync(state);
  assert.ok(Object.keys(encoded).length > 1);
  for (const [key, value] of Object.entries(encoded))
    assert.ok(
      Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)) <= 7500
    );
  assert.ok(!JSON.stringify(encoded).includes("SECRET"));
  assert.deepEqual(decodeSync(encoded).items, state.items);
  assert.throws(
    () =>
      encodeSync(
        vocab(
          card("large", {
            translation: "đ".repeat(4000),
            context: "đ".repeat(2000)
          })
        )
      ),
    /too large/
  );
  assert.throws(() => encodeSync(state, { totalCap: 100 }), /cap/);
  assert.throws(
    () => syncBudget({ foreign: "x".repeat(100000) }, encoded),
    /full/
  );
  assert.throws(
    () =>
      decodeSync({ [SYNC_PREFIX + "000"]: { schemaVersion: 9, items: [] } }),
    /schema/
  );
  const deleted = deleteItem(vocab(card("id0")), "id0", 2000);
  assert.ok(
    mergeSync(state, deleted).items.find((v) => v.id === "id0").deletedAt > 0
  );
  assert.equal(
    mergeSync({ ...state, syncEnabled: false }, deleted).syncEnabled,
    false
  );
});

test("fake two-profile sync converges, disable preserves local; erase only owns sync keys", async () => {
  let cloud = { foreign: "keep" },
    writes = 0;
  const storage = {
    QUOTA_BYTES: 102400,
    async get() {
      return clone(cloud);
    },
    async set(v) {
      writes++;
      Object.assign(cloud, clone(v));
    },
    async remove(keys) {
      for (const k of keys) delete cloud[k];
    }
  };
  const a = localHarness(),
    b = localHarness();
  const sa = createVocabularyStore(a.api, { changes: a.bus }),
    sb = createVocabularyStore(b.api, { changes: b.bus });
  await sa.update(() => ({ ...vocab(card("a")), syncEnabled: true }));
  await sb.update(() => ({ ...vocab(card("b")), syncEnabled: true }));
  const syncA = createLearningSync(sa, {
    storage,
    changes: eventBus(),
    delay: 60000,
    cooldown: 0
  });
  const syncB = createLearningSync(sb, {
    storage,
    changes: eventBus(),
    delay: 60000,
    cooldown: 0
  });
  try {
    await syncA.flush();
    await syncB.flush();
    await syncA.flush();
    assert.deepEqual((await sa.read()).items, (await sb.read()).items);
    await sa.update((v) => deleteItem(v, "a", 5000));
    await syncA.flush();
    await syncB.flush();
    assert.ok((await sb.read()).items.find((v) => v.id === "a").deletedAt > 0);
    await sa.update((v) => ({
      ...v,
      syncEnabled: false,
      preferencesUpdatedAt: 10000
    }));
    const count = writes;
    await syncA.flush();
    assert.equal(writes, count);
    assert.equal((await sa.read()).items.length, 2);
    await syncA.eraseRemote();
    assert.deepEqual(cloud, { foreign: "keep" });
  } finally {
    syncA.dispose();
    syncB.dispose();
    sa.dispose();
    sb.dispose();
  }
});
