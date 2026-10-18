import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { tick } from "./test-labs-provider-harness.mjs";

const source = (file) =>
  readFileSync(new URL(`../extension/src/${file}`, import.meta.url), "utf8");
const wrapper =
  '<span data-bntrans-wrapper data-bntrans-source-language="en" data-bntrans-target-language="vi"><span data-bntrans-original>Original <b>words.</b></span><br><span data-bntrans-translation><b>Initial</b> translation.</span></span>';
function fixture(t, html = `<main><p>${wrapper}</p></main>`, options = {}) {
  const dom = new JSDOM(html, {
    url: "https://work.test/article",
    runScripts: "outside-only"
  });
  t.after(() => {
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    dom.window.close();
  });
  const w = dom.window,
    listeners = new Set(),
    storageListeners = new Set(),
    shadows = new Map(),
    sent = [];
  const settings = {
    enabled: true,
    labFeatures: { corrections: true },
    sourceLanguage: "en",
    targetLanguageCode: "en",
    nativeLanguageCode: "vi",
    ...options.settings
  };
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (init) {
    const result = attach.call(this, init);
    shadows.set(this, result);
    return result;
  };
  const sender = {
    id: "synthetic",
    url: "chrome-extension://synthetic/pages/labs.html"
  };
  w.chrome = {
    runtime: {
      id: "synthetic",
      getURL: (path) => `chrome-extension://synthetic/${path}`,
      onMessage: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn)
      },
      async sendMessage(message) {
        sent.push(message);
        return options.send ? options.send(message) : { ok: true };
      }
    },
    storage: {
      local: { get: async () => ({ translatorSettings: settings }) },
      onChanged: {
        addListener: (fn) => storageListeners.add(fn),
        removeListener: (fn) => storageListeners.delete(fn)
      }
    }
  };
  w.eval(source("content-script-granularity.js"));
  w.eval(source("experimental/content-corrections.js"));
  const send = (payload, from = sender) =>
    new Promise((resolve) => {
      const handled = [...listeners].some((listener) =>
        listener({ type: "labs-corrections-page", payload }, from, resolve)
      );
      if (!handled) resolve({ ignored: true });
    });
  const editor = () =>
    shadows.get(w.document.querySelector("[data-bntrans-correction-control]"));
  const button = (label, root = editor()) =>
    [...root.querySelectorAll("button")].find((el) => el.textContent === label);
  const click = async (label) => {
    button(label).click();
    await tick();
    await tick();
  };
  const start = () => send({ command: "start", url: w.location.href });
  return {
    w,
    settings,
    shadows,
    sent,
    start,
    send,
    editor,
    click,
    button,
    listeners,
    storageListeners,
    translation: () => w.document.querySelector("[data-bntrans-translation]"),
    original: () => w.document.querySelector("[data-bntrans-original]")
  };
}

test("explicit start only: preview HTML is literal, no save until click, exact rich original restored", async (t) => {
  const f = fixture(t);
  const before = f.original().innerHTML,
    originalNodes = [...f.original().childNodes];
  assert.equal(f.editor(), undefined);
  assert.equal((await f.start()).count, 1);
  await f.click("Edit translation");
  f.editor().querySelector("textarea").value =
    '<img src=x onerror="alert(1)"> **literal**';
  await f.click("Apply on page only");
  assert.equal(
    f.translation().textContent,
    '<img src=x onerror="alert(1)"> **literal**'
  );
  assert.equal(f.translation().querySelector("img"), null);
  assert.equal(f.sent.length, 0);
  assert.equal(f.original().innerHTML, before);
  assert.deepEqual([...f.original().childNodes], originalNodes);
  await f.click("Cancel");
  assert.equal(f.translation().innerHTML, "<b>Initial</b> translation.");
  await f.click("Edit translation");
  f.editor().querySelector("textarea").value = "Saved correction";
  await f.click("Save correction");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.explicitSave, true);
  assert.equal(f.sent[0].payload.entry.text, "Original **words.**");
  assert.equal(f.sent[0].payload.entry.sourceLanguage, "en");
  assert.equal(f.sent[0].payload.entry.targetLanguage, "vi");
  assert.equal(
    (
      await f.send({
        command: "validate-save",
        token: f.sent[0].payload.token,
        url: f.w.location.href
      })
    ).ok,
    true
  );
  await f.click("Restore translation");
  assert.equal(f.translation().innerHTML, "<b>Initial</b> translation.");
  await f.send({ command: "stop" });
  assert.equal(f.editor(), undefined);
  assert.equal(f.original().innerHTML, before);
});

test("stale identical replacement node/lineage/translation cannot save through old controls", async (t) => {
  for (const mutate of [
    (f) => {
      f.original().innerHTML = f.original().innerHTML;
    },
    (f) => {
      const p = f.w.document.createElement("p");
      f.w.document.body.append(p);
      p.append(f.original().parentNode);
    },
    (f) => {
      f.translation().textContent = "External change";
    },
    (f) => {
      f.original().textContent = "Different source";
    }
  ]) {
    const f = fixture(t);
    await f.start();
    const old = f.editor();
    [...old.querySelectorAll("button")]
      .find((el) => el.textContent === "Edit translation")
      .click();
    old.querySelector("textarea").value = "Stale correction";
    mutate(f);
    [...old.querySelectorAll("button")]
      .find((el) => el.textContent === "Save correction")
      .click();
    await tick();
    assert.equal(f.sent.length, 0);
  }
});

test("protected ancestor/nested opt-outs/hidden/sensitive/contenteditable are never edited", async (t) => {
  for (const [outer, source] of [
    ['<main translate="no">', "Text"],
    ['<main contenteditable="true">', "Text"],
    ["<form>", "Text"],
    ["<main hidden>", "Text"],
    ['<main style="opacity:0">', "Text"],
    ['<main role="textbox">', "Text"],
    ["<main>", '<span translate="no">Private</span>'],
    ["<main>", '<span style="display:none">Private</span>'],
    ["<main>", '<input type="password" value="secret">']
  ]) {
    const f = fixture(
      t,
      `${outer}${wrapper.replace("Original <b>words.</b>", source)}</${outer.startsWith("<form") ? "form" : "main"}>`
    );
    assert.equal((await f.start()).count, 0);
    assert.equal(f.sent.length, 0);
  }
});

test("disabled and untrusted sender/iframe cannot activate editing", async (t) => {
  const f = fixture(t, undefined, {
    settings: { labFeatures: { corrections: false } }
  });
  assert.equal((await f.start()).ok, false);
  assert.deepEqual(
    await f.send(
      { command: "start", url: f.w.location.href },
      { id: "synthetic", tab: { id: 1 }, url: "https://work.test/article" }
    ),
    { ignored: true }
  );
  assert.equal(f.editor(), undefined);
  const iframe = f.w.document.createElement("iframe");
  f.w.document.body.append(iframe);
  let called = false;
  iframe.contentWindow.chrome = {
    runtime: {
      onMessage: {
        addListener() {
          called = true;
        }
      }
    }
  };
  iframe.contentWindow.eval(source("experimental/content-corrections.js"));
  assert.equal(called, false);
});

test("saved language pair comes from translated wrapper, not changed settings; unknown pair and changed metadata are not saved", async (t) => {
  const f = fixture(t, undefined, {
    settings: { targetLanguageCode: "ja", nativeLanguageCode: "fr" }
  });
  await f.start();
  await f.click("Edit translation");
  f.editor().querySelector("textarea").value = "Literal correction";
  await f.click("Save correction");
  assert.equal(f.sent[0].payload.entry.sourceLanguage, "en");
  assert.equal(f.sent[0].payload.entry.targetLanguage, "vi");
  const old = f.editor();
  f.original().parentNode.setAttribute("data-bntrans-target-language", "de");
  [...old.querySelectorAll("button")]
    .find((el) => el.textContent === "Save correction")
    .click();
  await tick();
  assert.equal(f.sent.length, 1);
  await f.send({ command: "stop" });
  f.original().parentNode.removeAttribute("data-bntrans-source-language");
  assert.equal((await f.start()).count, 0);
});

test("cancel during pending Save invalidates token and drops late response", async (t) => {
  let release;
  const f = fixture(t, undefined, {
    send: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  await f.start();
  await f.click("Edit translation");
  f.editor().querySelector("textarea").value = "Late correction";
  f.button("Save correction").click();
  await tick();
  const token = f.sent[0].payload.token;
  await f.click("Cancel");
  assert.equal(
    (await f.send({ command: "validate-save", token, url: f.w.location.href }))
      .ok,
    false
  );
  release({ ok: true });
  await tick();
  assert.equal(f.translation().textContent, "Initial translation.");
});

test("stop, flag-off and pagehide restore preview; pagehide releases listeners", async (t) => {
  for (const action of [
    async (f) => f.send({ command: "stop" }),
    async (f) => {
      f.settings.labFeatures.corrections = false;
      for (const listener of f.storageListeners)
        listener({ translatorSettings: {} }, "local");
    },
    async (f) => f.w.dispatchEvent(new f.w.Event("pagehide"))
  ]) {
    const f = fixture(t);
    await f.start();
    await f.click("Edit translation");
    f.editor().querySelector("textarea").value = "Preview";
    await f.click("Apply on page only");
    await action(f);
    assert.equal(f.translation().innerHTML, "<b>Initial</b> translation.");
    assert.equal(f.editor(), undefined);
    if (f.listeners.size === 0) assert.equal(f.storageListeners.size, 0);
  }
});

test("navigation invalidates pending Save and controls without applying late text", async (t) => {
  let release;
  const f = fixture(t, undefined, {
    send: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  await f.start();
  await f.click("Edit translation");
  f.editor().querySelector("textarea").value = "Late correction";
  f.button("Save correction").click();
  await tick();
  const token = f.sent[0].payload.token;
  f.w.history.pushState({}, "", "/new-route");
  f.w.dispatchEvent(new f.w.Event("popstate"));
  release({ ok: true });
  await tick();
  assert.equal(
    (
      await f.send({
        command: "validate-save",
        token,
        url: "https://work.test/article"
      })
    ).ok,
    false
  );
  assert.equal(f.translation().textContent, "Initial translation.");
  assert.equal(f.editor(), undefined);
});
