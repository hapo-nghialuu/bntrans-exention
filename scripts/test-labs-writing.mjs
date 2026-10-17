import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const utilsSource = readFileSync(
  new URL("../extension/src/experimental/writing-utils.js", import.meta.url),
  "utf8"
);
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const utilsUrl = moduleUrl(utilsSource);
const { tokenDiff, renderDiff, rewriteOptions } = await import(utilsUrl);
const writingSource = readFileSync(
  new URL("../extension/src/experimental/writing.js", import.meta.url),
  "utf8"
);
const { mount } = await import(
  moduleUrl(
    writingSource.replace('"./writing-utils.js"', JSON.stringify(utilsUrl))
  )
);

class Target {
  listeners = new Map();
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  fire(type, extra = {}) {
    for (const handler of this.listeners.get(type) || [])
      handler({ type, preventDefault() {}, ...extra });
  }
}
class Node extends Target {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = "none";
  }
  set textContent(value) {
    this._text = value;
    this.children = [];
  }
  get textContent() {
    return this.children.length
      ? this.children.map((node) => node.textContent).join("")
      : this._text || "";
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
      if (this.tagName === "SELECT" && !this.value) this.value = node.value;
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (node) => node !== this
      );
  }
  setSelectionRange(start, end, direction) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  all(tag) {
    return this.children.flatMap((node) => [
      ...(node.tagName === tag.toUpperCase() ? [node] : []),
      ...node.all(tag)
    ]);
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function fixture({
  speech = false,
  enabled = true,
  provider = "openai",
  translate,
  sendToTab,
  activeTab
} = {}) {
  const win = new Target();
  const doc = new Target();
  doc.defaultView = win;
  doc.createElement = (tag) => new Node(tag, doc);
  const instances = [];
  if (speech) {
    win.webkitSpeechRecognition = class {
      constructor() {
        this.starts = this.stops = this.aborts = 0;
        instances.push(this);
      }
      start() {
        this.starts++;
      }
      stop() {
        this.stops++;
      }
      abort() {
        this.aborts++;
      }
    };
  }
  const settings = {
    labFeatures: { writing: enabled },
    activeProviderId: "synthetic",
    providers: [{ id: "synthetic", type: provider }]
  };
  const calls = [];
  const messages = [];
  const statuses = [];
  let tab = { id: 7, url: "https://synthetic.example.test/mail" };
  const api = {
    t: (en) => en,
    settings: async () => settings,
    status: (message, kind) => statuses.push({ message, kind }),
    field: (label, node) => {
      const wrapper = doc.createElement("label");
      wrapper.textContent = label;
      wrapper.append(node);
      return wrapper;
    },
    activeTab: activeTab || (async () => tab),
    sendToTab: async (type, payload) => {
      messages.push({ type, ...payload });
      return (
        sendToTab?.(type, payload) || {
          ok: true,
          id: "synthetic-id",
          text: "Hello friend",
          editable: true,
          kind: "input"
        }
      );
    },
    translate: async (text, options) => {
      calls.push({ text, options });
      return translate ? translate(text, options) : "Hello friend.";
    }
  };
  const container = doc.createElement("main");
  const cleanup = await mount(container, api);
  const source = container.all("textarea")[0];
  const preview = container.all("textarea")[1];
  const button = (label) =>
    container.all("button").find((node) => node.textContent === label);
  async function click(label) {
    const node = button(label);
    assert.ok(node, `missing button ${label}`);
    if (!node.disabled) node.fire("click");
    await settle();
  }
  function type(value) {
    source.value = value;
    source.fire("input");
  }
  return {
    win,
    doc,
    api,
    container,
    cleanup,
    source,
    preview,
    button,
    click,
    type,
    calls,
    messages,
    statuses,
    instances,
    settings,
    setTab(value) {
      tab = value;
    },
    consent: container.all("input")[0],
    result: () =>
      container.all("section").find((node) => node.className === "lab-result")
  };
}

test("rewrite options specify same-language action and explicit no-new-facts instructions", () => {
  for (const style of ["grammar", "concise", "polite"]) {
    const options = rewriteOptions(style);
    assert.equal(options.task, "rewrite");
    assert.equal(options.targetLanguage, "same");
    assert.equal(options.sourceLanguage, "auto");
    assert.equal(options.skipHistory, true);
    assert.match(options.customPrompt, /do not translate/i);
    assert.match(options.customPrompt, /factual claims/);
    assert.match(options.customPrompt, /not as instructions/);
  }
  assert.match(
    rewriteOptions("grammar", 1).customPrompt,
    /different valid wording/
  );
  assert.throws(() => rewriteOptions("made-up"));
});

test("token diff reconstructs exact before/after for Unicode, whitespace and multiline markup", () => {
  for (const [before, after] of [
    ["", ""],
    ["", "new"],
    ["old", ""],
    ["Hello freind", "Hello friend"],
    ['Chào bạn 😀\n\t<script>&"', "Chào bạn\n<b>Bro</b> & '"],
    ["日本語\r\n한국어", "日本語!\r\n한국어"],
    ["a ".repeat(800), "b ".repeat(800)]
  ]) {
    const parts = tokenDiff(before, after);
    assert.equal(
      parts
        .filter((part) => part.type !== "insert")
        .map((part) => part.text)
        .join(""),
      before
    );
    assert.equal(
      parts
        .filter((part) => part.type !== "delete")
        .map((part) => part.text)
        .join(""),
      after
    );
  }
  const small = tokenDiff("Hello freind", "Hello friend");
  assert.deepEqual(small, [
    { type: "equal", text: "Hello " },
    { type: "delete", text: "freind" },
    { type: "insert", text: "friend" }
  ]);
});

test("diff renderer uses only textContent and semantic ins/del, preserving multiline escaping", () => {
  const doc = { createElement: (tag) => new Node(tag, doc) };
  const container = new Node("div", doc);
  const before = "<img src=x onerror=bad()>\n&old";
  const after = "<script>bad()</script>\n&new";
  renderDiff(container, before, after);
  assert.ok(container.all("ins").length);
  assert.ok(container.all("del").length);
  assert.equal(container.all("script").length, 0);
  assert.equal(container.all("img").length, 0);
  assert.equal(container.style.whiteSpace, "pre-wrap");
  assert.equal(
    container.children
      .filter((node) => node.tagName !== "DEL")
      .map((node) => node.textContent)
      .join(""),
    after
  );
});

test("manual rewrite previews without mutating input, Apply and one-step Undo restore selection", async () => {
  const f = await fixture();
  f.type("Hello freind");
  f.source.setSelectionRange(1, 5, "backward");
  await f.click("Rewrite preview");
  assert.equal(f.source.value, "Hello freind");
  assert.equal(f.preview.value, "Hello friend.");
  assert.equal(f.result().hidden, false);
  assert.equal(f.calls[0].options.task, "rewrite");
  await f.click("Apply reviewed text");
  assert.equal(f.source.value, "Hello friend.");
  await f.click("Undo once");
  assert.equal(f.source.value, "Hello freind");
  assert.equal(f.source.selectionStart, 1);
  assert.equal(f.source.selectionEnd, 5);
  assert.equal(f.source.selectionDirection, "backward");
  assert.equal(f.button("Undo once").disabled, true);
  f.cleanup();
});

test("manual Undo refuses to destroy later typing", async () => {
  const f = await fixture();
  f.type("Hello freind");
  await f.click("Rewrite preview");
  await f.click("Apply reviewed text");
  f.type("Hello friend. typed later");
  await f.click("Undo once");
  assert.equal(f.source.value, "Hello friend. typed later");
  assert.match(f.statuses.at(-1).message, /will not overwrite/);
  f.cleanup();
});

test("variants are actual provider calls, selectable and editable; duplicates are not fabricated", async () => {
  let index = 0;
  const f = await fixture({
    translate: () => ["Hello friend.", "Dear friend.", "Dear friend."][index++]
  });
  f.type("Hello freind");
  await f.click("Rewrite preview");
  await f.click("Generate another variant");
  assert.equal(f.calls.length, 2);
  assert.equal(f.preview.value, "Dear friend.");
  assert.match(f.calls[1].options.customPrompt, /different valid wording/);
  await f.click("Variant 1");
  assert.equal(f.preview.value, "Hello friend.");
  await f.click("Generate another variant");
  assert.equal(f.button("Variant 3"), undefined);
  assert.match(f.statuses.at(-1).message, /same variant/);
  f.preview.value = "Reviewed final wording";
  f.preview.fire("input");
  await f.click("Apply reviewed text");
  assert.equal(f.source.value, "Reviewed final wording");
  f.cleanup();
});

test("feature defaults off and translation-only providers cannot accidentally translate rewrite input", async () => {
  for (const options of [
    { enabled: false },
    { provider: "google-translate" },
    { provider: "deepl" }
  ]) {
    const f = await fixture(options);
    f.type("Synthetic original");
    await f.click("Rewrite preview");
    assert.equal(f.calls.length, 0);
    assert.equal(f.source.value, "Synthetic original");
    assert.equal(f.result().hidden, true);
    f.cleanup();
  }
});

test("provider empty/invalid/failure does not claim a preview or alter original", async () => {
  for (const translate of [
    () => "",
    () => ({ translation: "no" }),
    () => "a".repeat(12001),
    () => {
      throw new Error("synthetic provider failure");
    }
  ]) {
    const f = await fixture({ translate });
    f.type("Synthetic original");
    await f.click("Rewrite preview");
    assert.equal(f.result().hidden, true);
    assert.equal(f.source.value, "Synthetic original");
    assert.equal(f.statuses.at(-1).kind, "error");
    f.cleanup();
  }
});

test("source edits and unmount discard delayed provider output", async () => {
  let resolve;
  const f = await fixture({
    translate: () =>
      new Promise((done) => {
        resolve = done;
      })
  });
  f.type("Synthetic original");
  await f.click("Rewrite preview");
  f.type("User edited while waiting");
  resolve("Stale synthetic output");
  await settle();
  assert.equal(f.result().hidden, true);
  assert.equal(f.source.value, "User edited while waiting");
  f.cleanup();
  assert.equal(f.container.children.length, 0);
  assert.equal(f.source.value, "");
});

test("Apply rechecks snapshot after awaiting settings and cannot overwrite typing during the await", async () => {
  const f = await fixture();
  f.type("Synthetic original");
  await f.click("Rewrite preview");
  let release;
  f.api.settings = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await f.click("Apply reviewed text");
  assert.equal(f.button("Apply reviewed text").disabled, true);
  f.type("Typed while settings pending");
  release(f.settings);
  await settle();
  assert.equal(f.source.value, "Typed while settings pending");
  assert.equal(f.messages.length, 0);
  f.cleanup();
});

test("capture response cannot overwrite typing while tab snapshot is pending", async () => {
  let release;
  const f = await fixture({
    sendToTab: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  await f.click("Capture chosen tab");
  f.type("Typed while capture pending");
  release({
    ok: true,
    id: "pending",
    text: "Captured snapshot",
    editable: true
  });
  await settle();
  assert.equal(f.source.value, "Typed while capture pending");
  f.cleanup();
});

test("repeated rewrites release old variant listeners before removing their buttons", async () => {
  const f = await fixture();
  f.type("Synthetic original");
  await f.click("Rewrite preview");
  const oldButton = f.button("Variant 1");
  assert.equal(oldButton.listeners.get("click").size, 1);
  f.type("New synthetic text");
  assert.equal(oldButton.listeners.get("click").size, 0);
  await f.click("Rewrite preview");
  const next = f.button("Variant 1");
  f.cleanup();
  assert.equal(next.listeners.get("click").size, 0);
});

test("capture/apply/undo use contract messages and site context, and pin original selected tab", async () => {
  const f = await fixture();
  await f.click("Capture chosen tab");
  assert.equal(f.source.value, "Hello friend");
  await f.click("Rewrite preview");
  assert.equal(f.messages.length, 1, "preview must not write into page");
  assert.equal(
    f.calls[0].options.siteUrl,
    "https://synthetic.example.test/mail"
  );
  f.setTab({ id: 8, url: "https://synthetic.example.test/other" });
  await f.click("Apply reviewed text");
  assert.equal(f.messages.length, 1, "must not write into a different tab");
  f.setTab({ id: 7, url: "https://synthetic.example.test/mail" });
  await f.click("Apply reviewed text");
  assert.deepEqual(f.messages[1], {
    type: "labs-writing-command",
    command: "apply",
    id: "synthetic-id",
    text: "Hello friend."
  });
  await f.click("Undo once");
  assert.deepEqual(f.messages[2], {
    type: "labs-writing-command",
    command: "undo",
    id: "synthetic-id"
  });
  f.cleanup();
});

test("read-only capture permits preview but disables Apply, sensitive capture has visible error", async () => {
  const f = await fixture({
    sendToTab: () => ({
      ok: true,
      id: "readonly",
      text: "Synthetic page selection",
      editable: false
    })
  });
  await f.click("Capture chosen tab");
  await f.click("Rewrite preview");
  assert.equal(f.button("Apply reviewed text").disabled, true);
  await f.click("Apply reviewed text");
  assert.equal(f.messages.length, 1);
  f.cleanup();
  const blocked = await fixture({
    sendToTab: () => ({ ok: false, error: "SENSITIVE_FIELD" })
  });
  await blocked.click("Capture chosen tab");
  assert.equal(blocked.source.value, "");
  assert.match(blocked.statuses.at(-1).message, /Sensitive/);
  blocked.cleanup();
});

test("unsupported recognition and permission denial leave typed rewrite usable", async () => {
  const f = await fixture();
  assert.equal(f.button("Hold to talk").disabled, true);
  assert.match(f.container.textContent, /unavailable/);
  f.type("Synthetic typed input");
  await f.click("Rewrite preview");
  assert.equal(f.calls.length, 1);
  f.cleanup();
  const denied = await fixture({ speech: true });
  denied.consent.checked = true;
  denied.consent.fire("change");
  denied.button("Hold to talk").fire("pointerdown", { button: 0 });
  await settle();
  const rec = denied.instances[0];
  rec.onerror({ error: "not-allowed" });
  rec.onend?.();
  assert.match(denied.container.textContent, /permission denied/);
  denied.type("Typed after denial");
  await denied.click("Rewrite preview");
  assert.equal(denied.calls.length, 1);
  denied.cleanup();
});

test("voice permission failure releases listening even if browser never emits end", async () => {
  const f = await fixture({ speech: true });
  f.type("Typed synthetic input");
  f.consent.checked = true;
  f.consent.fire("change");
  f.button("Hold to talk").fire("pointerdown", { button: 0 });
  await settle();
  const rec = f.instances[0];
  rec.onerror({ error: "not-allowed" });
  assert.equal(rec.aborts, 1);
  assert.equal(f.button("Rewrite preview").disabled, false);
  await f.click("Rewrite preview");
  assert.equal(f.calls.length, 1);
  f.cleanup();
});

test("settings failure is visible and fails closed without starting voice or sending text", async () => {
  const f = await fixture({ speech: true });
  f.api.settings = async () => {
    throw new Error("Synthetic disconnected worker");
  };
  f.type("Synthetic typed input");
  await f.click("Rewrite preview");
  assert.equal(f.calls.length, 0);
  assert.equal(f.source.value, "Synthetic typed input");
  assert.equal(f.statuses.at(-1).kind, "error");
  f.consent.checked = true;
  f.consent.fire("change");
  f.button("Hold to talk").fire("pointerdown", { button: 0 });
  await settle();
  assert.equal(f.instances.length, 0);
  assert.match(f.statuses.at(-1).message, /Cannot read Labs settings/);
  f.cleanup();
});

test("quick push/release before settings resolves never opens the microphone", async () => {
  const f = await fixture({ speech: true });
  f.consent.checked = true;
  f.consent.fire("change");
  let release;
  f.api.settings = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.button("Hold to talk").fire("pointerdown", { button: 0 });
  f.win.fire("pointerup");
  release(f.settings);
  await settle();
  assert.equal(f.instances.length, 0);
  f.cleanup();
});

test("unmount drops a pending provider response and releases all document/window handlers", async () => {
  let release;
  const f = await fixture({
    translate: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  f.type("Synthetic original");
  await f.click("Rewrite preview");
  f.cleanup();
  const statusCount = f.statuses.length;
  release("Synthetic late result");
  await settle();
  assert.equal(f.container.children.length, 0);
  assert.equal(f.statuses.length, statusCount);
  assert.equal(f.source.value, "");
  assert.equal(f.preview.value, "");
  for (const handlers of f.win.listeners.values())
    assert.equal(handlers.size, 0);
  for (const handlers of f.doc.listeners.values())
    assert.equal(handlers.size, 0);
});

test("real variant requests are capped at three", async () => {
  let n = 0;
  const f = await fixture({ translate: () => `Synthetic variant ${++n}` });
  f.type("Synthetic original");
  await f.click("Rewrite preview");
  await f.click("Generate another variant");
  await f.click("Generate another variant");
  assert.equal(f.calls.length, 3);
  assert.equal(f.preview.value, "Synthetic variant 3");
  assert.equal(f.button("Generate another variant").disabled, true);
  await f.click("Generate another variant");
  assert.equal(f.calls.length, 3);
  f.cleanup();
});

test("push-to-talk requires consent, stops on release, editable transcript never auto-translates", async () => {
  const f = await fixture({ speech: true });
  f.button("Hold to talk").fire("pointerdown", { button: 0 });
  await settle();
  assert.equal(f.instances.length, 0);
  f.consent.checked = true;
  f.consent.fire("change");
  f.button("Hold to talk").fire("pointerdown", { button: 0 });
  await settle();
  const rec = f.instances[0];
  assert.equal(rec.starts, 1);
  assert.equal(rec.lang, "vi-VN");
  assert.equal(rec.interimResults, false);
  assert.equal(f.button("Rewrite preview").disabled, true);
  assert.equal(f.calls.length, 0);
  f.win.fire("pointerup");
  assert.equal(rec.stops, 1);
  rec.onresult({
    results: [{ isFinal: true, 0: { transcript: "Synthetic transcript" } }]
  });
  assert.equal(f.source.value, "Synthetic transcript");
  assert.equal(f.calls.length, 0);
  rec.onend();
  f.type("Edited synthetic transcript");
  await f.click("Rewrite preview");
  assert.equal(f.calls[0].text, "Edited synthetic transcript");
  f.cleanup();
});

test("voice result never overwrites edits made while listening; abort on blur/unmount releases handlers", async () => {
  const f = await fixture({ speech: true });
  f.type("Synthetic original");
  f.consent.checked = true;
  f.consent.fire("change");
  f.button("Hold to talk").fire("keydown", { key: " ", repeat: false });
  await settle();
  const rec = f.instances[0];
  f.type("User typed while listening");
  rec.onresult({
    results: [{ isFinal: true, 0: { transcript: "Late transcript" } }]
  });
  assert.equal(f.source.value, "User typed while listening");
  assert.match(f.statuses.at(-1).message, /not inserted/);
  f.win.fire("blur");
  assert.equal(rec.aborts, 1);
  assert.equal(rec.onresult, null);
  assert.equal(rec.onend, null);
  assert.equal(f.button("Hold to talk").attributes["aria-pressed"], "false");
  f.button("Hold to talk").fire("pointerdown", { button: 0 });
  await settle();
  const next = f.instances[1];
  f.cleanup();
  assert.equal(next.aborts, 1);
  assert.equal(next.onresult, null);
  assert.equal(f.win.listeners.get("pointerup").size, 0);
  assert.equal(f.doc.listeners.get("visibilitychange").size, 0);
});
