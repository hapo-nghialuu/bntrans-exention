import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  worker,
  source,
  local,
  success,
  tick
} from "./test-labs-provider-harness.mjs";
import { createHarness } from "./test-labs-page-harness.mjs";
import { CORRECTIONS_KEY } from "../extension/src/experimental/correction-store.js";
import { mount } from "../extension/src/experimental/corrections.js";

const page = {
  id: "synthetic",
  frameId: 0,
  tab: { id: 7, url: "https://work.test/article" }
};
const labs = {
  id: "synthetic",
  url: "chrome-extension://synthetic/pages/labs.html"
};
const entry = {
  scope: "https://work.test",
  hostname: "work.test",
  sourceLanguage: "en",
  targetLanguage: "vi",
  text: "Synthetic input",
  translation: "Remembered local correction"
};
function fixture(options = {}) {
  const f = worker({
    ...options,
    settings: {
      labFeatures: { corrections: true, privacy: true },
      ...options.settings
    }
  });
  vm.runInContext(source("experimental/correction-store.js"), f.context);
  const validations = [];
  f.context.chrome.tabs = {
    get: async (id) => ({ ...page.tab, id }),
    async sendMessage(id, message, target) {
      validations.push({ id, message, target });
      return options.validate ? options.validate(message) : { ok: true };
    }
  };
  const send = (payload, sender = labs) =>
    f.send("labs-corrections", payload, sender);
  const save = (patch = {}, sender = labs) =>
    send(
      {
        command: "save",
        explicitSave: true,
        entry: { ...entry, ...patch },
        ...(sender.tab ? { token: "token", url: sender.tab.url } : {})
      },
      sender
    );
  return { ...f, validations, sendCorrection: send, save };
}

test("explicit Save + actual translation lookup bypasses provider/cache/history including Ask and Local-only", async () => {
  for (const mode of ["cloud", "ask", "local-only"]) {
    const f = fixture({
      settings: {
        privacyDefaultMode: mode,
        providers: [
          {
            id: "remote",
            type: "openai",
            config: { apiKey: "synthetic-not-sent" }
          }
        ],
        activeProviderId: "remote"
      }
    });
    assert.equal((await f.save()).ok, true);
    const result = await f.translate({}, page);
    assert.equal(result.ok, true);
    assert.equal(result.result.translation, entry.translation);
    assert.equal(result.result.correction, true);
    assert.equal(f.calls.length, 0);
    assert.equal(f.state.translationCache, undefined);
    assert.equal(f.state.translatorSettings.translationHistory, undefined);
    assert.doesNotMatch(
      JSON.stringify(f.state[CORRECTIONS_KEY]),
      /apiKey|synthetic-not-sent|translationHistory/
    );
  }
});

test("exact source/language/site and task-only lookups never mix memory with instruction/ephemeral/incognito requests", async () => {
  const cases = [
    [{ text: "Synthetic input " }, page],
    [{ sourceLanguage: "ja" }, page],
    [{ targetLanguage: "en" }, page],
    [
      {},
      { ...page, tab: { ...page.tab, url: "https://sub.work.test/article" } }
    ],
    [{ task: "ask" }, page],
    [{ ephemeral: true, skipHistory: true }, page],
    [{}, { ...page, tab: { ...page.tab, incognito: true } }],
    [{ labFeature: "compare", task: "translate", siteUrl: "" }, labs]
  ];
  for (const [payload, sender] of cases) {
    const f = fixture({
      settings: { labFeatures: { corrections: true, compare: true } }
    });
    await f.save();
    const result = await f.translate(payload, sender);
    assert.equal(result.ok, true, result.error);
    assert.notEqual(result.result.translation, entry.translation);
    assert.equal(f.calls.length, 1);
  }
});

test("disabled and retention-off requests skip memory; long ordinary input still reaches provider", async () => {
  for (const patch of [
    { labFeatures: { corrections: false } },
    { historyEnabled: false },
    { cacheEnabled: false },
    { retentionEnabled: false }
  ]) {
    const f = fixture();
    await f.save();
    Object.assign(f.state.translatorSettings, patch);
    assert.equal((await f.translate({}, page)).ok, true);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  assert.equal((await f.translate({ text: "x".repeat(15000) }, page)).ok, true);
  assert.equal(f.calls.length, 1);
});

test("content Save derives actual scope and validates pinned top-frame snapshot twice; no provider", async () => {
  const f = fixture();
  assert.equal(
    (await f.save({ scope: "https://evil.test", hostname: "evil.test" }, page))
      .ok,
    true
  );
  assert.equal(f.state[CORRECTIONS_KEY].items[0].scope, "https://work.test");
  assert.equal(f.validations.length, 2);
  assert.equal(f.validations[0].id, 7);
  assert.equal(f.validations[0].target.frameId, 0);
  assert.equal(f.validations[0].message.payload.command, "validate-save");
  assert.equal(f.calls.length, 0);
  const count = f.state[CORRECTIONS_KEY].items.length;
  for (const sender of [
    { ...page, frameId: 1 },
    { ...labs, id: "other" },
    { url: "https://work.test" }
  ]) {
    assert.equal((await f.save({}, sender)).ok, false);
  }
  assert.equal((await f.sendCorrection({ command: "clear" }, page)).ok, false);
  assert.equal((await f.sendCorrection({ command: "save", entry })).ok, false);
  assert.equal(
    (
      await f.sendCorrection(
        {
          command: "save",
          entry,
          explicitSave: true,
          url: "https://work.test/old"
        },
        page
      )
    ).ok,
    false
  );
  assert.equal(f.state[CORRECTIONS_KEY].items.length, count);
});

test("stale content during save rolls back entry; incognito/ephemeral save forbidden", async () => {
  let validations = 0;
  const f = fixture({ validate: async () => ({ ok: ++validations === 1 }) });
  const response = await f.save({}, page);
  assert.equal(response.ok, false);
  assert.match(response.error, /stale/);
  assert.equal(f.state[CORRECTIONS_KEY].items.length, 0);
  const privateSave = await f.save(
    {},
    { ...page, tab: { ...page.tab, incognito: true } }
  );
  assert.equal(privateSave.ok, false);
  assert.equal(
    (
      await f.sendCorrection({
        command: "save",
        explicitSave: true,
        ephemeral: true,
        entry
      })
    ).ok,
    false
  );
  assert.equal(f.calls.length, 0);
});

test("batch corrections are used on real page engine; only missing exact units reach provider and restore keeps original DOM", async (t) => {
  const f = fixture({ fetch: async () => success("Provider missing unit") });
  await f.save({
    text: "Synthetic 0",
    scope: "https://synthetic.example",
    hostname: "synthetic.example"
  });
  const sender = {
    ...page,
    tab: { id: 9, url: "https://synthetic.example/article" }
  };
  const h = createHarness({
    count: 2,
    settings: {
      labFeatures: { page: true, corrections: true },
      providers: [local],
      activeProviderId: "local"
    },
    provider: (payload) => f.translate(payload, sender)
  });
  t.after(h.dispose);
  // Use the real content-script transport hook rather than the harness stub.
  const raw = readFileSync(
    new URL("../extension/src/content-script.js", import.meta.url),
    "utf8"
  );
  const transportStart = raw.indexOf(
    "async function requestTranslation(payload)"
  );
  const transportEnd = raw.indexOf("\n}", transportStart) + 2;
  h.context.isExtensionContextValid = () => true;
  h.context.getPageContext = () => "synthetic.example";
  h.context.chrome.runtime.sendMessage = (message) =>
    message.type === "translate"
      ? f.translate(message.payload, sender)
      : Promise.resolve();
  vm.runInContext(raw.slice(transportStart, transportEnd), h.context);
  await h.runPageTranslation();
  const texts = h.document
    .querySelectorAll("[data-bntrans-translation]")
    .map((el) => el.textContent);
  assert.deepEqual(texts, [entry.translation, "Provider missing unit"]);
  assert.equal(f.calls.length, 1);
  const body = f.calls[0][1].body;
  assert.match(body, /Synthetic 1/);
  assert.doesNotMatch(body, /Synthetic 0|Remembered local correction/);
  h.removePageTranslation();
  assert.deepEqual(
    h.paragraphs.map((el) => el.textContent),
    ["Synthetic 0", "Synthetic 1"]
  );
  assert.equal(h.document.querySelectorAll("[data-bntrans-wrapper]").length, 0);
});

test("clear and disable invalidate pending Save; re-enable cannot resurrect memory after service-worker restart", async () => {
  for (const operation of ["clear", "disable"]) {
    const f = fixture();
    let release, entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const set = f.context.chrome.storage.local.set;
    f.context.chrome.storage.local.set = async (value) => {
      if (value[CORRECTIONS_KEY]?.items.length) {
        entered();
        await gate;
      }
      await set(value);
    };
    const saving = f.save();
    await started;
    const clearing =
      operation === "clear"
        ? f.sendCorrection({ command: "clear" })
        : f.send("set-settings", { labFeatures: { corrections: false } });
    await tick();
    await tick();
    release();
    await saving;
    await clearing;
    assert.equal(f.state[CORRECTIONS_KEY].items.length, 0);
    // Simulate persisted entries on a restarted worker, before any lookup creates the singleton.
    f.state.translatorSettings.labFeatures.corrections = true;
    f.state[CORRECTIONS_KEY].items = [{ ...entry, updatedAt: Date.now() }];
    const restarted = fixture({ state: f.state });
    await restarted.send("set-settings", {
      labFeatures: { corrections: false }
    });
    await restarted.send("set-settings", {
      labFeatures: { corrections: true }
    });
    assert.equal(restarted.state[CORRECTIONS_KEY].items.length, 0);
    assert.equal(
      (await restarted.translate({}, page)).result.correction,
      undefined
    );
  }
});

test("real hover line path ignores stale local cache, reuses latest memory and restores rich originals", async (t) => {
  const f = fixture();
  await f.save({ text: "Original **words.**" });
  const dom = new JSDOM("<p>Original <b>words.</b></p>", {
    url: page.tab.url,
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  const element = w.document.querySelector("p"),
    original = element.querySelector("b");
  const raw = readFileSync(
    new URL("../extension/src/content-script.js", import.meta.url),
    "utf8"
  );
  const define = (name, next) =>
    w.eval(
      raw.slice(
        raw.indexOf(`function ${name}(`) -
          (name === "handleHoverTranslate" ? 6 : 0),
        raw.indexOf(`\nfunction ${next}(`)
      )
    );
  w.eval(
    readFileSync(
      new URL(
        "../extension/src/content-script-granularity.js",
        import.meta.url
      ),
      "utf8"
    )
  );
  w.isSensitiveElement = () => false;
  w.tmCache = {
    has: () => true,
    get: () => ["stale local cache"],
    set: () => assert.fail("Persistent hover cache must be bypassed")
  };
  w.requestTranslation = (payload) =>
    f.translate(
      { ...payload, correctionSegments: payload.text.split(" ||| ") },
      page
    );
  w.createHoverPlaceholder = () =>
    assert.fail("No block placeholder for line mode");
  w.updateHoverContent = () => assert.fail("No block renderer for line mode");
  w.currentHoveredElement = null;
  define("clearAllHoverTranslations", "isHoverTranslateDomain");
  define("handleHoverTranslate", "createHoverPlaceholder");
  const settings = {
    labFeatures: { corrections: true },
    targetLanguageCode: "en",
    nativeLanguageCode: "vi",
    hoverTranslateGranularity: "line"
  };
  await w.handleHoverTranslate(element, settings);
  assert.equal(
    element.querySelector("[data-bntrans-translation]").textContent,
    entry.translation
  );
  assert.equal(
    element
      .querySelector("[data-bntrans-wrapper]")
      .getAttribute("data-bntrans-source-language"),
    "en"
  );
  assert.equal(f.calls.length, 0);
  w.clearAllHoverTranslations();
  assert.equal(element.innerHTML, "Original <b>words.</b>");
  assert.equal(element.querySelector("b"), original);
  await f.save({
    text: "Original **words.**",
    translation: "Latest correction"
  });
  await w.handleHoverTranslate(element, settings);
  assert.equal(
    element.querySelector("[data-bntrans-translation]").textContent,
    "Latest correction"
  );
  assert.equal(f.calls.length, 0);
});

test("Labs DOM stays inert until clicks, renders literal data, provides search/edit/delete/clear/export/import and stops pinned tab on dispose", async (t) => {
  const f = fixture();
  const dom = new JSDOM("<main></main>");
  const previous = Object.fromEntries(
    ["document", "window", "chrome"].map((key) => [key, globalThis[key]])
  );
  const listeners = new Set(),
    requests = [],
    downloads = [],
    tabs = [];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.chrome = {
    storage: {
      onChanged: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn)
      }
    }
  };
  dom.window.confirm = () => true;
  let pending;
  const api = {
    t: (en) => en,
    settings: async () => f.state.translatorSettings,
    status() {},
    activeTab: async () => ({ ...page.tab, title: "Synthetic target" }),
    updateSettings: async (settings) => f.send("set-settings", settings),
    send: async (type, payload) => {
      requests.push(payload.command);
      const result = await f.sendCorrection(payload);
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    sendToTab: async (type, payload, id) => {
      tabs.push({ type, payload, id });
      return { ok: true, count: 1 };
    },
    field(label, el) {
      const node = document.createElement("label");
      node.append(document.createTextNode(label), el);
      return node;
    },
    button(label, callback) {
      const node = document.createElement("button");
      node.textContent = label;
      node.addEventListener("click", () => {
        pending = callback();
      });
      return node;
    },
    download: (...args) => downloads.push(args)
  };
  const container = document.querySelector("main");
  const dispose = await mount(container, api);
  t.after(() => {
    dispose();
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    dom.window.close();
  });
  const click = async (label) => {
    [...container.querySelectorAll("button")]
      .find((el) => el.textContent === label)
      .click();
    await pending;
  };
  assert.deepEqual(requests, []);
  assert.deepEqual(tabs, []);
  await click("Edit translations on selected tab");
  assert.match(container.textContent, /Editing tab 7: Synthetic target/);
  assert.equal(tabs[0].id, 7);
  await f.save({
    text: "<img src=x onerror=alert(1)>",
    translation: "Literal saved correction"
  });
  await click("Load memory");
  assert.equal(container.querySelectorAll(".lab-card").length, 1);
  assert.equal(container.querySelector("img"), null);
  const search = container.querySelector('input[type="search"]');
  search.value = "not matched";
  search.dispatchEvent(new dom.window.Event("input"));
  assert.equal(container.querySelectorAll(".lab-card").length, 0);
  search.value = "work.test";
  search.dispatchEvent(new dom.window.Event("input"));
  container.querySelector("textarea").value = "Edited in Labs";
  assert.equal(
    (await f.sendCorrection({ command: "list" })).items[0].translation,
    "Literal saved correction"
  );
  await click("Save edit");
  await click("Export memory");
  assert.equal(
    JSON.parse(downloads[0][1]).items[0].translation,
    "Edited in Labs"
  );
  await click("Delete");
  assert.equal(container.querySelectorAll(".lab-card").length, 0);
  const file = container.querySelector('input[type="file"]');
  Object.defineProperty(file, "files", {
    value: [{ size: downloads[0][1].length, text: async () => downloads[0][1] }]
  });
  await click("Import selected file");
  assert.equal(container.querySelectorAll(".lab-card").length, 1);
  await click("Clear memory");
  assert.equal(container.querySelectorAll(".lab-card").length, 0);
  assert.equal(f.state[CORRECTIONS_KEY].items.length, 0);
  dispose();
  assert.equal(listeners.size, 0);
  assert.equal(tabs.at(-1).payload.command, "stop");
  assert.equal(tabs.at(-1).id, 7);
  assert.equal(f.calls.length, 0);
});
