import assert from "node:assert/strict";
import test from "node:test";
import { createHarness } from "./test-labs-page-harness.mjs";

const ids = (batch) =>
  batch.map((text) => Number(text.replace("Synthetic ", "")));
function verifyUnique(h, count) {
  const all = h.batches.flat();
  assert.equal(all.length, count);
  assert.equal(new Set(all).size, count);
  assert.equal(h.pageSnapshot().complete, count);
}

test("prioritizes the initial viewport before the observer's first callback", async (t) => {
  const h = createHarness({ count: 70, visible: [49, 50, 51] });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.deepEqual(ids(h.batches[0]).slice(0, 3), [49, 50, 51]);
  verifyUnique(h, 70);
});

test("reserves queued units before sequential fallback can select them again", async (t) => {
  const h = createHarness({
    count: 70,
    provider: (payload, number) => {
      if (number === 2) h.intersect([62, 63]);
      return {
        ok: true,
        result: {
          translation: payload.text
            .split(" ||| ")
            .map((s) => "Translated " + s)
            .join(" ||| ")
        }
      };
    }
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.deepEqual(ids(h.batches[2]).slice(0, 2), [62, 63]);
  verifyUnique(h, 70);
});

test("repeated intersections never schedule a unit twice", async (t) => {
  const h = createHarness({
    count: 70,
    visible: [26, 27],
    provider: (payload) => {
      h.intersect([0, 26, 27, 62, 63]);
      return {
        ok: true,
        result: {
          translation: payload.text
            .split(" ||| ")
            .map((s) => "Translated " + s)
            .join(" ||| ")
        }
      };
    }
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  verifyUnique(h, 70);
  assert.ok(h.batches.every((batch) => batch.length <= 25));
});

test("handles multiple translation units sharing a visible anchor", async (t) => {
  const h = createHarness();
  t.after(h.dispose);
  const p = h.appendParagraph("", true);
  for (let i = 0; i < 30; i++)
    p.append(
      h.document.createTextNode("Synthetic " + i),
      h.document.createElement("br")
    );
  await h.runPageTranslation();
  verifyUnique(h, 30);
  assert.deepEqual(
    h.batches.map((batch) => batch.length),
    [25, 5]
  );
});

test("marks failed batches once and disconnects observers on restore", async (t) => {
  const h = createHarness({
    count: 30,
    provider: () => {
      throw new Error("Provider unavailable");
    }
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.equal(h.requests.length, 2);
  assert.equal(h.pageSnapshot().complete, 0);
  assert.equal(h.pageSnapshot().remaining, 30);
  const wrappers = h.document.querySelectorAll("[data-bntrans-translation]");
  assert.equal(wrappers.length, 30);
  assert.ok(wrappers.every((w) => w.textContent === "Provider unavailable"));
  h.dispose();
  assert.equal(h.intersections[0].disconnected, true);
  assert.equal(h.listeners.size, 0);
});

test("retains the page safety cap and handles empty pages", async (t) => {
  const capped = createHarness({ count: 550 });
  t.after(capped.dispose);
  await capped.runPageTranslation();
  verifyUnique(capped, 500);
  assert.equal(capped.pageSnapshot().capped, true);
  const empty = createHarness();
  t.after(empty.dispose);
  await empty.runPageTranslation();
  assert.equal(empty.requests.length, 0);
});
