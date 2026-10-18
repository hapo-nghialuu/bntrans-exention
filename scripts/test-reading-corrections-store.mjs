import test from "node:test";
import assert from "node:assert/strict";
import {
  createCorrectionStore,
  CORRECTIONS_KEY,
  correctionScope,
  normalizeCorrection
} from "../extension/src/experimental/correction-store.js";

const input = (patch = {}) => ({
  ...correctionScope("https://work.test/path?token=private"),
  text: "Original **words**.",
  translation: "<img src=x onerror=alert(1)>",
  sourceLanguage: "en",
  targetLanguage: "vi",
  ...patch
});
function fixture() {
  const state = {},
    config = {
      labFeatures: { corrections: true },
      historyTTLHours: 10,
      cacheTTLHours: 2
    };
  let now = 10000,
    reads = 0;
  const storage = {
    async get(key) {
      reads++;
      return { [key]: structuredClone(state[key]) };
    },
    async set(value) {
      Object.assign(state, structuredClone(value));
    }
  };
  const store = createCorrectionStore({
    storage,
    settings: async () => config,
    now: () => now
  });
  return {
    store,
    state,
    config,
    storage,
    reads: () => reads,
    advance: (ms) => {
      now += ms;
    }
  };
}

test("canonical exact scope/languages/text with HTML literal and no sensitive extra keys", async () => {
  const { store, state } = fixture();
  await store.save(
    input({ apiKey: "do-not-store", history: ["private"], context: "private" })
  );
  assert.equal(
    (await store.lookup(input())).translation,
    "<img src=x onerror=alert(1)>"
  );
  for (const patch of [
    correctionScope("https://sub.work.test"),
    correctionScope("http://work.test"),
    correctionScope("https://work.test:8443"),
    { sourceLanguage: "auto" },
    { targetLanguage: "ja" },
    { text: "Original **words**. " }
  ])
    assert.equal(await store.lookup(input(patch)), null);
  assert.doesNotMatch(
    JSON.stringify(state),
    /do-not-store|private|apiKey|history|context|path/
  );
  assert.equal(
    (await store.lookup(input({ sourceLanguage: "EN" }))).sourceLanguage,
    "en"
  );
});
test("serialized concurrent saves, exact delete and safe import whitelist", async () => {
  const { store } = fixture();
  await Promise.all([
    store.save(input()),
    store.save(input({ text: "Second" })),
    store.save(input({ translation: "Final" }))
  ]);
  assert.equal((await store.list()).length, 2);
  assert.equal((await store.lookup(input())).translation, "Final");
  await store.delete(input());
  assert.equal(await store.lookup(input()), null);
  assert.equal(
    await store.import({
      schemaVersion: 1,
      items: [input({ secret: "not-saved" })]
    }),
    2
  );
  assert.equal((await store.list()).length, 2);
  assert.doesNotMatch(JSON.stringify(await store.list()), /secret|not-saved/);
});
test("hostile entries/imports reject atomically rather than truncate into another key", async () => {
  const { store } = fixture();
  for (const patch of [
    { text: "x".repeat(12001) },
    { text: "\u0000" },
    { translation: " " },
    { sourceLanguage: "en\n" },
    { scope: "https://work.test/path" },
    { hostname: "sub.work.test" },
    { scope: "javascript:alert(1)" },
    { scope: "https://user:pass@work.test" }
  ])
    assert.throws(() => normalizeCorrection(input(patch)));
  assert.throws(() => store.import({ schemaVersion: 2, items: [] }));
  assert.throws(() =>
    store.import({
      schemaVersion: 1,
      items: [input(), input({ sourceLanguage: "*" })]
    })
  );
  assert.throws(() =>
    store.import({ schemaVersion: 1, items: Array(201).fill(input()) })
  );
  assert.deepEqual(await store.list(), []);
});
test("disabled/incognito/ephemeral and retention-off never read persistent entries or save", async () => {
  for (const patch of [
    { enabled: false },
    { labFeatures: { corrections: false } },
    { historyEnabled: false },
    { cacheEnabled: false },
    { retentionEnabled: false },
    { cacheTTLHours: 0 }
  ]) {
    const f = fixture();
    await f.store.save(input());
    Object.assign(f.config, patch);
    const reads = f.reads();
    assert.equal(await f.store.lookup(input()), null);
    await assert.rejects(f.store.save(input()), /disabled-or-private/);
    assert.equal(f.reads(), reads);
  }
  for (const policy of [{ incognito: true }, { ephemeral: true }]) {
    const f = fixture();
    const reads = f.reads();
    assert.equal(await f.store.lookup(input(), policy), null);
    await assert.rejects(f.store.save(input(), policy), /disabled-or-private/);
    assert.equal(f.reads(), reads);
  }
});
test("retention expires at shorter TTL, corrupt/future/versioned entries never match", async () => {
  const f = fixture();
  f.state[CORRECTIONS_KEY] = {
    schemaVersion: 1,
    items: [input({ updatedAt: Infinity })]
  };
  assert.equal(await f.store.lookup(input()), null);
  await f.store.save(input());
  f.advance(2 * 3600000);
  assert.equal(await f.store.lookup(input()), null);
  assert.deepEqual(f.state[CORRECTIONS_KEY].items, []);
  f.state[CORRECTIONS_KEY] = {
    schemaVersion: 1,
    items: [
      input({ updatedAt: Infinity }),
      input({ updatedAt: 1e15 }),
      { apiKey: "private" }
    ]
  };
  assert.equal(await f.store.lookup(input()), null);
  f.state[CORRECTIONS_KEY] = {
    schemaVersion: 2,
    items: [input({ updatedAt: 10000 })]
  };
  assert.equal(await f.store.lookup(input()), null);
});
test("bounds use actual UTF-8 bytes instead of UTF-16 character count", async () => {
  const { store } = fixture();
  const items = Array.from({ length: 40 }, (_, i) =>
    input({ text: "語".repeat(11900) + i, translation: "語".repeat(11900) })
  );
  const value = { schemaVersion: 1, items };
  assert.ok(JSON.stringify(value).length < 2000000);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 2000000
  );
  assert.throws(() => store.import(value), /invalid-import/);
  assert.deepEqual(await store.list(), []);
});
test("clear invalidates queued/inflight saves and never resurrects pending entries", async () => {
  const f = fixture();
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const set = f.storage.set;
  f.storage.set = async (value) => {
    entered();
    await gate;
    await set(value);
  };
  const save = f.store.save(input());
  await started;
  const clear = f.store.clear();
  release();
  await assert.rejects(save, /cancelled/);
  await clear;
  assert.deepEqual(await f.store.list(), []);
  const pending = f.store.save(input());
  const clearing = f.store.clear();
  await assert.rejects(pending, /disabled-or-private/);
  await clearing;
  assert.deepEqual(await f.store.list(), []);
});
test("post-save stale guard rolls back persisted write without deleting earlier valid memory", async () => {
  const f = fixture();
  await f.store.save(input({ translation: "Previous valid" }));
  let calls = 0;
  await assert.rejects(
    f.store.save(input(), {}, async () => ++calls === 1),
    /stale/
  );
  assert.equal((await f.store.lookup(input())).translation, "Previous valid");
  await assert.rejects(
    f.store.save(input(), {}, async () => false),
    /stale/
  );
});
