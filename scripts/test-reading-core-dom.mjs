import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  captureReadingSnapshot,
  readingSnapshotRange,
  splitReadingSentences,
  isSafeReadingNode
} from "../extension/src/experimental/reading-context.js";

const bridgeSource = readFileSync(
  new URL("../extension/src/experimental/content-reading.js", import.meta.url),
  "utf8"
);
function documentFor(html) {
  return new JSDOM(
    `<!doctype html><html lang="en"><head><title>Synthetic</title></head><body>${html}</body></html>`,
    {
      url: "https://work.test/article",
      runScripts: "outside-only"
    }
  );
}
const request = (snapshot, extra = {}) => ({
  snapshotId: snapshot.source.snapshotId,
  url: snapshot.source.url,
  blockId: snapshot.source.blocks[0].id,
  ...extra
});

test("article source never swallows protected descendants, forms, overlays or iframe documents", (t) => {
  const dom =
    documentFor(`<main><p>Public <b>source.</b><span translate="no">SECRET-1</span> Tail.</p>
    <div hidden>SECRET-2</div><div style="display:none">SECRET-3</div><div style="visibility:hidden">SECRET-4</div>
    <div contenteditable="true"><span contenteditable="false">SECRET-5</span></div>
    <form><p>SECRET-6</p><input type="password" value="SECRET-7"></form>
    <textarea>SECRET-8</textarea><div aria-hidden="true">SECRET-9</div>
    <div class="notranslate"><p>SECRET-10</p></div><div id="bntrans-private">SECRET-11</div>
    <div data-bntrans-translation>SECRET-12</div><div class="bt-hover-translation">SECRET-13</div>
    <iframe srcdoc="<p>SECRET-14</p>"></iframe><script>SECRET-15</script>
    <div translate="no"><span translate="yes">SECRET-16</span></div>
    <div inert>SECRET-17</div><div role="textbox">SECRET-18</div><div style="opacity:0">SECRET-19</div>
    <div data-bt-original="Original replaced">SECRET-20</div></main>`);
  t.after(() => dom.window.close());
  const { source } = captureReadingSnapshot(dom.window.document, "article");
  assert.equal(source.url, "https://work.test/article");
  assert.equal(source.lang, "en");
  assert.equal(source.title, "Synthetic");
  assert.ok(
    source.blocks
      .map((block) => block.text)
      .join(" ")
      .includes("Public source.")
  );
  assert.ok(source.blocks.some((block) => block.text === "Tail."));
  assert.doesNotMatch(JSON.stringify(source), /SECRET/);
});

test("selection requires an explicit nonempty range and captures only that range", (t) => {
  const dom = documentFor(
    "<main><p>Before selected text after</p><p>Not selected</p></main>"
  );
  t.after(() => dom.window.close());
  const { document } = dom.window;
  assert.throws(() => captureReadingSnapshot(document), /source-selection/);
  const text = document.querySelector("p").firstChild;
  const range = document.createRange();
  range.setStart(text, 7);
  range.setEnd(text, 20);
  dom.window.getSelection().addRange(range);
  const snapshot = captureReadingSnapshot(document);
  assert.deepEqual(
    snapshot.source.blocks.map((block) => block.text),
    ["selected text"]
  );
  assert.equal(
    readingSnapshotRange(document, snapshot, request(snapshot)).toString(),
    "selected text"
  );
  assert.throws(
    () => captureReadingSnapshot(document, "automatic"),
    /source-mode/
  );
});

test("translated page captures safe original once, including translation-only hidden original", (t) => {
  const dom = documentFor(
    `<main><p><span data-bntrans-wrapper="true"><span data-bntrans-original="true" style="display:none">Original <b>words.</b><span translate="no">SECRET</span></span><br><span data-bntrans-translation="true">Translated words.</span></span></p></main>`
  );
  t.after(() => dom.window.close());
  const source = captureReadingSnapshot(dom.window.document, "article").source;
  assert.deepEqual(
    source.blocks.map((block) => block.text),
    ["Original words."]
  );
  assert.doesNotMatch(JSON.stringify(source), /Translated|SECRET/);
});

test("source bounds are 40 blocks and 30000 characters, stable ids survive fresh capture", (t) => {
  const dom = documentFor(
    `<main>${Array.from({ length: 50 }, (_, i) => `<p>Block ${i}</p>`).join("")}</main>`
  );
  t.after(() => dom.window.close());
  const a = captureReadingSnapshot(dom.window.document, "article").source;
  const b = captureReadingSnapshot(dom.window.document, "article").source;
  assert.equal(a.blocks.length, 40);
  assert.equal(a.truncated, true);
  assert.deepEqual(
    a.blocks.map((block) => block.id),
    b.blocks.map((block) => block.id)
  );
  assert.notEqual(a.snapshotId, b.snapshotId);
  dom.window.document.querySelector("main").textContent = "a".repeat(40000);
  const long = captureReadingSnapshot(dom.window.document, "article").source;
  assert.equal(
    long.blocks.reduce((sum, block) => sum + block.text.length, 0),
    30000
  );
  assert.equal(long.truncated, true);
});

test("HTTP source snapshots do not depend on secure-context randomUUID", (t) => {
  const dom = documentFor("<main><p>Synthetic HTTP source.</p></main>");
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.crypto, "randomUUID", { value: undefined });
  const source = captureReadingSnapshot(dom.window.document, "article").source;
  assert.match(source.snapshotId, /^[a-f0-9]{32}$/);
});

test("snapshot validates URL, nodes, exact text, offsets and newly protected descendants", (t) => {
  const dom = documentFor(
    "<main><p> First <b>sentence.</b> Second sentence.</p></main>"
  );
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const snapshot = captureReadingSnapshot(doc, "article");
  const original = doc.body.innerHTML;
  assert.equal(
    readingSnapshotRange(
      doc,
      snapshot,
      request(snapshot, { start: 6, end: 15 })
    ).toString(),
    "sentence."
  );
  assert.equal(doc.body.innerHTML, original);
  for (const extra of [
    { url: "https://other.test" },
    { snapshotId: "old" },
    { blockId: "wrong" },
    { start: -1 },
    { end: 999 },
    { start: 2, end: 1 }
  ])
    assert.throws(
      () => readingSnapshotRange(doc, snapshot, request(snapshot, extra)),
      /source-/
    );
  doc.querySelector("b").setAttribute("translate", "no");
  assert.throws(
    () => readingSnapshotRange(doc, snapshot, request(snapshot)),
    /source-stale/
  );
  doc.querySelector("b").removeAttribute("translate");
  doc.querySelector("b").firstChild.data = "changed";
  assert.throws(
    () => readingSnapshotRange(doc, snapshot, request(snapshot)),
    /source-stale/
  );
});

test("inserted nodes, replaced same-text nodes and SPA URL changes reject stale snapshot", (t) => {
  const dom = documentFor("<main><p>First <b>word.</b></p></main>");
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  let snapshot = captureReadingSnapshot(doc, "article");
  doc.querySelector("b").insertAdjacentText("beforebegin", "inserted ");
  assert.throws(
    () => readingSnapshotRange(doc, snapshot, request(snapshot)),
    /source-stale/
  );
  snapshot = captureReadingSnapshot(doc, "article");
  const first = doc.querySelector("p").firstChild;
  first.replaceWith(doc.createTextNode(first.data));
  assert.throws(
    () => readingSnapshotRange(doc, snapshot, request(snapshot)),
    /source-stale/
  );
  snapshot = captureReadingSnapshot(doc, "article");
  dom.window.history.pushState({}, "", "/next");
  assert.throws(
    () => readingSnapshotRange(doc, snapshot, request(snapshot)),
    /source-stale/
  );
  assert.equal(isSafeReadingNode(first), false);
});

test("sentence helper preserves exact source offsets for English, Vietnamese and CJK", () => {
  for (const [text, lang] of [
    ["First sentence. Second one!", "en"],
    ["Xin chào. Đây là câu hai!", "vi"],
    ["你好。再见！", "zh"]
  ]) {
    const segments = splitReadingSentences(text, lang);
    assert.equal(segments.length, 2);
    assert.ok(
      segments.every((part) => text.slice(part.start, part.end) === part.text)
    );
  }
  assert.throws(() => splitReadingSentences("a".repeat(30001)), /source-limit/);
});

async function bridgeFixture(t, enabled = true) {
  const dom = documentFor(
    "<main><p>First sentence. Second sentence.</p></main>"
  );
  const { window } = dom;
  const runtime = new Set(),
    storage = new Set();
  const settings = { enabled: true, labFeatures: { ask: enabled } };
  let reads = 0;
  window.chrome = {
    runtime: {
      id: "synthetic",
      getURL: (path) => `chrome-extension://synthetic/${path}`,
      onMessage: {
        addListener(fn) {
          runtime.add(fn);
        },
        removeListener(fn) {
          runtime.delete(fn);
        }
      }
    },
    storage: {
      local: {
        async get() {
          reads++;
          return { translatorSettings: settings };
        }
      },
      onChanged: {
        addListener(fn) {
          storage.add(fn);
        },
        removeListener(fn) {
          storage.delete(fn);
        }
      }
    }
  };
  window.document.adoptedStyleSheets = [];
  window.CSS = { highlights: new Map() };
  window.Highlight = class {
    constructor(range) {
      this.range = range;
    }
  };
  window.CSSStyleSheet = class {
    replaceSync(value) {
      this.value = value;
    }
  };
  window.Element.prototype.scrollIntoView = function () {
    this.scrolled = true;
  };
  new vm.Script(bridgeSource, {
    importModuleDynamically: () =>
      import("../extension/src/experimental/reading-context.js")
  }).runInContext(dom.getInternalVMContext());
  const send = (
    payload,
    type = "labs-reading-source",
    sender = {
      id: "synthetic",
      url: "chrome-extension://synthetic/pages/labs.html"
    }
  ) =>
    new Promise((resolve) => {
      if (![...runtime][0]?.({ type, payload }, sender, resolve))
        resolve({ ignored: true });
    });
  t.after(() => {
    window.dispatchEvent(new window.Event("pagehide"));
    window.close();
  });
  return { window, send, runtime, storage, settings, reads: () => reads };
}

test("classic bridge is lazy, authenticates sender and accepts only nested opt-in requests", async (t) => {
  const h = await bridgeFixture(t, false);
  assert.equal(h.reads(), 0);
  const payload = { feature: "ask", command: "capture", mode: "article" };
  assert.equal(
    (await h.send(payload, "labs-reading-source", { id: "evil" })).ignored,
    true
  );
  assert.equal(
    (
      await h.send(payload, "labs-reading-source", {
        id: "synthetic",
        tab: {},
        url: "https://work.test"
      })
    ).ignored,
    true
  );
  assert.equal((await h.send(undefined)).error, "source-feature");
  assert.equal((await h.send(payload)).error, "source-disabled");
  h.settings.labFeatures.ask = true;
  const captured = await h.send(payload);
  assert.equal(captured.ok, true);
  assert.equal(captured.source.blocks.length, 1);
});

test("bridge highlight/clear preserve original DOM; mutations, flag off and teardown invalidate", async (t) => {
  const h = await bridgeFixture(t);
  const capture = () =>
    h.send({ feature: "ask", command: "capture", mode: "article" });
  let captured = await capture();
  const highlight = () =>
    h.send({
      feature: "ask",
      command: "highlight",
      snapshotId: captured.source.snapshotId,
      url: captured.source.url,
      blockId: captured.source.blocks[0].id,
      start: 0,
      end: 15,
      jump: true
    });
  const html = h.window.document.body.innerHTML;
  assert.equal((await highlight()).ok, true);
  assert.equal(h.window.CSS.highlights.size, 1);
  assert.equal(h.window.document.body.innerHTML, html);
  assert.equal(h.window.document.querySelector("p").scrolled, true);
  h.window.document.body.append(h.window.document.createElement("aside"));
  await Promise.resolve();
  assert.equal(
    (await highlight()).ok,
    true,
    "unrelated UI does not stale the chosen source"
  );
  h.window.document.querySelector("p").firstChild.data += " changed";
  await Promise.resolve();
  assert.equal(h.window.CSS.highlights.size, 0);
  assert.equal((await highlight()).error, "source-stale");
  captured = await capture();
  assert.equal((await highlight()).ok, true);
  h.settings.labFeatures.ask = false;
  for (const fn of h.storage) fn({ translatorSettings: {} }, "local");
  assert.equal(h.window.CSS.highlights.size, 0);
  assert.equal(h.window.document.adoptedStyleSheets.length, 0);
  assert.equal((await highlight()).error, "source-disabled");
  h.window.dispatchEvent(new h.window.Event("pagehide"));
  assert.equal(h.runtime.size, 0);
  assert.equal(h.storage.size, 0);
});
