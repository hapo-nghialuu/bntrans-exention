import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../extension/src/content-script.js", import.meta.url),
  "utf8"
);
const helpers = source.slice(
  source.indexOf("const editableGenerations = new WeakMap();"),
  source.indexOf("function parseFieldTextAndCommand(")
);
const editable = source.slice(
  source.indexOf("  async function translateEditableSelection() {"),
  source.indexOf("  // Triggered from the extension context menu")
);
const instant = source.slice(
  source.indexOf("async function handleInstantTranslate("),
  source.indexOf("// --- Dual subtitles")
);
const field = (value = "ALPHA beta GAMMA") => ({
  tagName: "TEXTAREA",
  isConnected: true,
  value,
  selectionStart: 0,
  selectionEnd: 5,
  getAttribute() {
    return null;
  },
  setRangeText(text, start, end) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
  },
  dispatchEvent() {},
  focus() {}
});

function harness(element = field()) {
  const requests = [],
    notices = [],
    timers = [];
  let selection = null;
  let resolveRequest;
  const window = { getSelection: () => selection };
  const document = { activeElement: element };
  const context = vm.createContext({
    window,
    document,
    URL,
    console,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    i18n: { t: (key) => key },
    showToast: (text) => notices.push(text),
    getSettings: async () => ({
      selectionLastSource: "ja",
      selectionLastTarget: "vi",
      enabled: true
    }),
    requestTranslation: (payload) => {
      requests.push(payload);
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    },
    justAppliedTranslation: false,
    instantTimer: null,
    currentSuggestion: null,
    shouldTriggerInstant: (text) => text?.length >= 5,
    isInstantDomain: () => ({ position: "auto" }),
    commitIMEComposition: async () => {},
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout() {},
    buildInlineSuggestion: () => ({ destroy() {} }),
    setupSuggestionKeyHandlers() {}
  });
  vm.runInContext(`${helpers}\n${editable}\n${instant}`, context);
  return {
    context,
    element,
    requests,
    notices,
    timers,
    document,
    window,
    select(value) {
      selection = value;
    },
    finish(text = "RESULT") {
      resolveRequest({ ok: true, result: { translation: text } });
    },
    run(code) {
      return vm.runInContext(code, context);
    }
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("password and sensitive autocomplete cannot enter editable/instant translation", async () => {
  for (const attributes of [
    { type: "password" },
    { autocomplete: "section-login current-password" },
    { autocomplete: "one-time-code" },
    { autocomplete: "cc-number" },
    { autocomplete: "username webauthn" }
  ]) {
    const element = field("PUBLIC_SYNTHETIC_ONLY");
    element.tagName = "INPUT";
    element.type = attributes.type || "text";
    element.getAttribute = (key) => attributes[key] || null;
    const h = harness(element);
    assert.equal(h.run("isEditableElement(document.activeElement)"), false);
    await h.run("translateEditableSelection()");
    await h.run("handleInstantTranslate(document.activeElement)");
    assert.equal(h.requests.length, 0);
    assert.equal(h.timers.length, 0);
  }
});

test("instant debounce rechecks sensitivity at dispatch, not just input", async () => {
  const element = field();
  element.tagName = "INPUT";
  element.type = "text";
  const h = harness(element);
  await h.run("handleInstantTranslate(document.activeElement)");
  assert.equal(h.timers.length, 1);
  element.type = "password";
  await h.timers[0]();
  assert.equal(h.requests.length, 0);
});

test("settings await cannot dispatch a field that became sensitive", async () => {
  const h = harness();
  let resolveSettings;
  h.context.getSettings = () =>
    new Promise((resolve) => {
      resolveSettings = resolve;
    });
  const done = h.run("translateEditableSelection()");
  h.element.getAttribute = (key) =>
    key === "autocomplete" ? "one-time-code" : null;
  resolveSettings({});
  await done;
  assert.equal(h.requests.length, 0);
});

test("an input revision rejects edit-and-revert even when the final value matches", async () => {
  const h = harness();
  const done = h.run("translateEditableSelection()");
  await tick();
  const start = source.indexOf("function handleUserInputEvent(");
  vm.runInContext(
    source.slice(
      start,
      source.indexOf("function attemptTranslationTrigger(", start)
    ),
    h.context
  );
  h.context.debounceTimer = null;
  h.run(
    'handleUserInputEvent({ type: "input", composedPath: () => [document.activeElement] })'
  );
  h.finish();
  await done;
  assert.equal(h.element.value, "ALPHA beta GAMMA");
  assert.ok(
    h.notices.some((notice) => notice.includes("nothing was replaced"))
  );
});

test("contenteditable containing a sensitive child is not an active editable source", async () => {
  const element = field();
  element.tagName = "DIV";
  element.isContentEditable = true;
  element.querySelectorAll = () => [{ type: "password" }];
  const h = harness(element);
  await h.run("translateEditableSelection()");
  assert.equal(h.requests.length, 0);
});

test("selection movement never changes the saved replacement range", async () => {
  const h = harness();
  const done = h.run("translateEditableSelection()");
  await tick();
  assert.equal(h.requests[0].text, "ALPHA");
  h.element.selectionStart = 11;
  h.element.selectionEnd = 16;
  h.finish();
  await done;
  assert.equal(h.element.value, "RESULT beta GAMMA");
});

test("new edits and disconnected fields reject completion without overwriting", async () => {
  for (const change of [
    (e) => {
      e.value = "ALPHA beta USER";
    },
    (e) => {
      e.isConnected = false;
    },
    (e) => {
      e.type = "password";
    }
  ]) {
    const h = harness();
    const done = h.run("translateEditableSelection()");
    await tick();
    change(h.element);
    const before = h.element.value;
    h.finish();
    await done;
    assert.equal(h.element.value, before);
    assert.ok(
      h.notices.some((notice) => notice.includes("nothing was replaced"))
    );
  }
});

test("whole-field snapshots reject new input and older request generations", async () => {
  const h = harness();
  h.element.selectionEnd = 0;
  const first = h.run("translateEditableSelection()");
  await tick();
  h.run("captureEditableSnapshot(document.activeElement)");
  h.finish();
  await first;
  assert.equal(h.element.value, "ALPHA beta GAMMA");
  const second = h.run("translateEditableSelection()");
  await tick();
  h.element.value += " NEW";
  h.finish();
  await second;
  assert.equal(h.element.value, "ALPHA beta GAMMA NEW");
});

test("provider markup remains literal text in an editable field", async () => {
  const h = harness();
  const done = h.run("translateEditableSelection()");
  await tick();
  h.finish("<strong>literal documentation example</strong>");
  await done;
  assert.equal(
    h.element.value,
    "<strong>literal documentation example</strong> beta GAMMA"
  );
});

test("selection-text accessor refuses sensitive active fields and ancestors", () => {
  const h = harness();
  h.select({ toString: () => "SYNTHETIC", rangeCount: 0 });
  assert.equal(h.run("getSafeSelection().toString()"), "SYNTHETIC");
  h.element.type = "password";
  assert.equal(h.run("getSafeSelection()"), null);
  h.element.type = "text";
  const parent = {
    getAttribute: (key) => (key === "autocomplete" ? "new-password" : null)
  };
  h.select({
    anchorNode: { nodeType: 3, parentElement: parent },
    rangeCount: 0
  });
  assert.equal(h.run("getSafeSelection()"), null);
});

function editorHarness() {
  const node = { nodeType: 3, isConnected: true };
  const element = {
    ...field(),
    tagName: "DIV",
    isContentEditable: true,
    innerHTML: "<b>ALPHA</b> beta",
    innerText: "ALPHA beta",
    contains: (child) => child === node
  };
  node.parentElement = element;
  const range = {
    startContainer: node,
    endContainer: node,
    collapsed: false,
    toString: () => "ALPHA",
    cloneRange() {
      return { ...this };
    }
  };
  const h = harness(element);
  const applied = [];
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges() {},
    addRange(saved) {
      applied.push(saved);
    }
  };
  h.select(selection);
  h.document.execCommand = (command, _ui, text) => {
    applied.push([command, text]);
    return true;
  };
  return { ...h, range, node, selection, applied };
}

test("contenteditable applies a cloned original range, not live global selection", async () => {
  const h = editorHarness();
  const done = h.run("translateEditableSelection()");
  await tick();
  h.selection.getRangeAt = () => {
    throw new Error("must not reread live selection");
  };
  h.finish();
  await done;
  assert.notEqual(h.applied[0], h.range);
  assert.deepEqual(h.applied[1], ["insertText", "RESULT"]);
  assert.ok(!h.applied.some((item) => item[0] === "selectAll"));
});

test("stale or detached contenteditable Range is rejected", async () => {
  for (const mutate of [
    (h) => {
      h.node.isConnected = false;
    },
    (h) => {
      h.element.innerHTML = "<i>USER EDIT</i>";
    }
  ]) {
    const h = editorHarness();
    const done = h.run("translateEditableSelection()");
    await tick();
    mutate(h);
    h.finish();
    await done;
    assert.equal(h.applied.length, 0);
  }
});

test("contenteditable never borrows a selection from outside its editor", async () => {
  const h = editorHarness();
  h.range.endContainer = { isConnected: true };
  await h.run("translateEditableSelection()");
  assert.equal(h.requests.length, 0);
  assert.equal(h.applied.length, 0);
});

test("child-frame screenshot rejects before capture/crop/provider requests", async () => {
  const h = harness();
  h.window.self = {};
  h.window.top = {};
  const capture = source.slice(
    source.indexOf("function canCaptureScreenshot()"),
    source.indexOf("function showScreenshotPopup(")
  );
  vm.runInContext(capture, h.context);
  await h.run("captureAndTranslateRect({ x: 10, y: 20, w: 100, h: 50 })");
  assert.equal(h.timers.length, 0);
  assert.equal(h.requests.length, 0);
  assert.ok(h.notices[0].includes("inside frames"));
});
