import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../extension/src/content-script.js", import.meta.url),
  "utf8"
);
const start = source.indexOf("  const PAGE_MAX_UNITS =");
const end = source.indexOf("  // --- Translate & replace", start);
assert.ok(start >= 0 && end > start, "Page translation section exists");

function createHarness({
  count = 70,
  visible = [],
  sharedAnchor = false,
  onBatch,
  rejectBatch = false
} = {}) {
  const batches = [];
  const injected = [];
  const updated = [];
  const errors = [];
  const badges = new Map();
  let observer;
  const anchors = Array.from({ length: count }, (_, i) => ({
    getBoundingClientRect: () => ({
      top: visible.includes(i) ? 100 : 2000,
      bottom: visible.includes(i) ? 150 : 2050,
      left: 0,
      right: 800
    })
  }));
  const units = anchors.map((anchor, i) => ({
    nodes: [{ id: i, parentElement: sharedAnchor ? anchors[0] : anchor }]
  }));
  const context = vm.createContext({
    console,
    window: { innerHeight: 768, innerWidth: 1024 },
    document: {
      body: { setAttribute() {} },
      documentElement: { appendChild: (el) => badges.set(el.id, el) },
      getElementById: (id) => badges.get(id),
      createElement: () => ({ style: {}, remove() {} })
    },
    chrome: { runtime: { sendMessage: async () => {} } },
    setTimeout() {},
    getSettings: async () => ({}),
    getTranslationUnits: () => units,
    toMarkdown: (nodes) => String(nodes[0].id),
    injectUnitWrappers: (batch) => {
      injected.push(...batch.map((unit) => unit.nodes[0].id));
      return batch.map(() => ({ wrapper: { setAttribute() {} } }));
    },
    requestTranslation: async (payload) => {
      assert.equal(payload.skipHistory, true);
    },
    requestSegmentTranslations: async (segments, settings, translate) => {
      const batch = Array.from(segments, Number);
      batches.push(batch);
      onBatch?.({
        batch,
        number: batches.length,
        intersect: (indices) =>
          observer.callback(
            indices.map((i) => ({ target: anchors[i], isIntersecting: true }))
          )
      });
      await translate({ text: segments.join(" ||| "), settings });
      if (rejectBatch) throw new Error("Provider unavailable");
      return segments;
    },
    updateWrappers: (_wrappers, segments) =>
      updated.push(...segments.map(Number)),
    markTranslationError: (_wrappers, error) => errors.push(error.message),
    IntersectionObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observer = this;
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    }
  });
  vm.runInContext(
    source.slice(start, end) + "\nglobalThis.run = runPageTranslation;",
    context
  );
  return {
    run: () => context.run(),
    batches,
    injected,
    updated,
    errors,
    get disconnected() {
      return observer?.disconnected;
    }
  };
}

test("prioritizes the initial viewport before the observer's first callback", async () => {
  const harness = createHarness({ visible: [49, 50, 51] });
  await harness.run();
  assert.deepEqual(harness.batches[0].slice(0, 3), [49, 50, 51]);
  assert.equal(harness.injected.length, 70);
  assert.equal(new Set(harness.injected).size, 70);
  assert.equal(harness.disconnected, true);
});

test("reserves queued units before sequential fallback can select them again", async () => {
  const harness = createHarness({
    onBatch: ({ number, intersect }) => {
      if (number === 2) intersect([62, 63]);
    }
  });
  await harness.run();
  assert.deepEqual(harness.batches[2].slice(0, 2), [62, 63]);
  assert.equal(harness.injected.length, 70);
  assert.equal(new Set(harness.injected).size, 70);
  assert.equal(harness.updated.length, 70);
});

test("repeated intersections never schedule a unit twice", async () => {
  const harness = createHarness({
    visible: [26, 27],
    onBatch: ({ intersect }) => intersect([0, 26, 27, 62, 63])
  });
  await harness.run();
  assert.equal(harness.injected.length, 70);
  assert.equal(new Set(harness.injected).size, 70);
  assert.ok(harness.batches.every((batch) => batch.length <= 25));
});

test("handles multiple translation units sharing a visible anchor", async () => {
  const harness = createHarness({
    count: 30,
    visible: [0],
    sharedAnchor: true
  });
  await harness.run();
  assert.deepEqual(
    harness.injected,
    Array.from({ length: 30 }, (_, i) => i)
  );
  assert.deepEqual(
    harness.batches.map((batch) => batch.length),
    [25, 5]
  );
});

test("marks failed batches once and disconnects the observer", async () => {
  const harness = createHarness({ count: 30, rejectBatch: true });
  await harness.run();
  assert.equal(harness.injected.length, 30);
  assert.equal(new Set(harness.injected).size, 30);
  assert.equal(harness.errors.length, 2);
  assert.equal(harness.disconnected, true);
});

test("retains the page safety cap and handles empty pages", async () => {
  const capped = createHarness({ count: 550 });
  await capped.run();
  assert.equal(capped.injected.length, 500);
  const empty = createHarness({ count: 0 });
  await empty.run();
  assert.equal(empty.batches.length, 0);
});
