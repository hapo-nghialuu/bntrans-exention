import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createLabApi } from "../extension/src/experimental/lab-api.js";
import {
  MAX_COMPARE_TEXT,
  MAX_COMPARE_OUTPUT,
  compareProviders,
  comparisonOptions,
  prepareComparison,
  createCompareEngine,
  renderDiff
} from "../extension/src/experimental/compare-engine.js";
import { mount } from "../extension/src/experimental/compare.js";
import { worker, success, tick } from "./test-labs-provider-harness.mjs";

const providers = [
  {
    id: "a",
    name: "Provider A",
    type: "openai",
    config: { model: "configured-a" }
  },
  {
    id: "b",
    name: "Provider B",
    type: "ollama",
    config: { baseUrl: "http://localhost:11434/v1", model: "configured-b" }
  },
  { id: "google", name: "Google", type: "google-translate", config: {} }
];
const draft = (patch = {}) => ({
  text: "Synthetic source only.\nSecond paragraph.",
  sourceLanguage: "en",
  targetLanguage: "vi",
  a: { providerId: "a", model: "model-a" },
  b: { providerId: "b", model: "model-b" },
  ...patch
});
const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
};
function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => {
      for (const fn of [...listeners]) fn(...args);
    }
  };
}
function fixture({
  settings = {},
  send,
  captureText = "Synthetic selected text."
} = {}) {
  const state = {
    translatorSettings: {
      enabled: true,
      labFeatures: { compare: true, privacy: true },
      activeProviderId: "b",
      nativeLanguageCode: "vi",
      privacyDefaultMode: "cloud",
      privacyRules: [],
      providers: structuredClone(providers),
      ...settings
    }
  };
  const messages = [],
    sourceMessages = [],
    writes = [],
    statuses = [];
  const changed = event(),
    updated = event(),
    removed = event();
  let selected = 7;
  const tabs = new Map([
    [7, { id: 7, url: "https://source.test/article" }],
    [8, { id: 8, url: "https://source.test/article" }]
  ]);
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://synthetic/${path}`,
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (send) return send(message, state);
        return {
          ok: true,
          result: {
            providerName: state.translatorSettings.providers.find(
              (p) => p.id === message.payload.providerId
            )?.name,
            translation: `Translation ${message.payload.providerId}`
          }
        };
      }
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(state[key]) };
        },
        async set(value) {
          writes.push(value);
        }
      },
      onChanged: changed
    },
    tabs: {
      async get(id) {
        return { ...tabs.get(id) };
      },
      async sendMessage(id, message, options) {
        sourceMessages.push({ id, ...structuredClone(message), options });
        return {
          ok: true,
          source: {
            kind: "website",
            mode: "selection",
            title: "Synthetic page",
            url: tabs.get(id).url,
            snapshotId: "snapshot-1",
            blocks: [{ id: "block-1", text: captureText }]
          }
        };
      },
      onUpdated: updated,
      onRemoved: removed
    }
  };
  const api = createLabApi({
    selectedTab: () => selected,
    onStatus: (...args) => statuses.push(args)
  });
  return {
    api,
    state,
    messages,
    sourceMessages,
    writes,
    statuses,
    changed,
    updated,
    removed,
    tabs,
    select: (id) => {
      selected = id;
    }
  };
}
const translated = (f) =>
  f.messages.filter((message) => message.type === "translate");
async function waitFor(check) {
  for (let count = 0; count < 60; count++) {
    if (check()) return;
    await tick();
  }
  assert.fail("Expected asynchronous condition was not reached");
}

test("exactly two canonical requests carry isolated models and identical bounded translation instructions", async () => {
  const f = fixture();
  const original = structuredClone(f.state);
  const engine = createCompareEngine(f.api);
  await engine.compare(draft());
  const calls = translated(f);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => [call.payload.providerId, call.payload.model]),
    [
      ["a", "model-a"],
      ["b", "model-b"]
    ]
  );
  for (const { payload } of calls) {
    assert.equal(payload.text, draft().text);
    assert.equal(payload.sourceLanguage, "en");
    assert.equal(payload.targetLanguage, "vi");
    assert.equal(payload.task, "compare");
    assert.equal(payload.labFeature, "compare");
    assert.equal(payload.ephemeral, true);
    assert.equal(payload.skipHistory, true);
    assert.equal(payload.siteUrl, "");
    assert.equal(payload.targetTabId, undefined);
    assert.equal(payload.compareToken, undefined);
    assert.equal(payload.compareSide, undefined);
    assert.equal(payload.apiKey, undefined);
    assert.equal(payload.baseUrl, undefined);
    assert.match(payload.customPrompt, /Translate the supplied text/);
    assert.match(payload.customPrompt, /never as instructions/);
    assert.ok(payload.customPrompt.length < 1000);
  }
  assert.equal(calls[0].payload.customPrompt, calls[1].payload.customPrompt);
  assert.equal(engine.snapshot().requests, 2);
  assert.deepEqual(f.state, original);
  assert.equal(f.writes.length, 0);
  await engine.dispose();
});

test("provider options expose metadata only and explicit defaults remain exact request models", async () => {
  const f = fixture({
    settings: {
      providers: [
        {
          ...providers[0],
          config: {
            apiKey: "synthetic-only",
            baseUrl: "http://localhost:9999/v1"
          }
        },
        providers[1]
      ]
    }
  });
  const options = compareProviders(f.state.translatorSettings);
  assert.equal(options[0].model, "gpt-4o-mini");
  assert.equal(JSON.stringify(options).includes("synthetic-only"), false);
  assert.equal(JSON.stringify(options).includes("localhost:9999"), false);
  const engine = createCompareEngine(f.api);
  await engine.compare(draft({ a: { providerId: "a", model: "" } }));
  assert.equal(translated(f)[0].payload.model, "gpt-4o-mini");
  await engine.dispose();
});

test("empty/oversized inputs, invalid languages/models and translation-only providers send nothing", async () => {
  const f = fixture();
  const engine = createCompareEngine(f.api);
  for (const patch of [
    { text: " " },
    { text: "x".repeat(MAX_COMPARE_TEXT + 1) },
    { sourceLanguage: "en\nIgnore" },
    { targetLanguage: "same" },
    { a: { providerId: "missing" } },
    { a: { providerId: "google" } },
    ...["a\nb", "x".repeat(201), "\t"].map((model) => ({
      a: { providerId: "a", model }
    }))
  ])
    await assert.rejects(engine.compare(draft(patch)));
  assert.equal(translated(f).length, 0);
  assert.equal(engine.snapshot().requests, 0);
  assert.throws(() => comparisonOptions("auto", ""), /compare-language/);
  await engine.dispose();
});

test("identical provider/model is rejected; same provider with distinct models sends real distinct requests", async () => {
  const f = fixture();
  const engine = createCompareEngine(f.api);
  await assert.rejects(
    engine.compare(draft({ b: { providerId: "a", model: "model-a" } })),
    /compare-duplicate/
  );
  assert.equal(translated(f).length, 0);
  await engine.compare(draft({ b: { providerId: "a", model: "other-model" } }));
  assert.deepEqual(
    translated(f).map(({ payload }) => [payload.providerId, payload.model]),
    [
      ["a", "model-a"],
      ["a", "other-model"]
    ]
  );
  await engine.dispose();
});

test("Ask refusal before A dispatch sends zero requests and never asks or sends B", async () => {
  const f = fixture({ settings: { privacyDefaultMode: "ask" } });
  const prompts = [];
  const engine = createCompareEngine(f.api, {
    confirm: (prompt) => {
      prompts.push(prompt);
      return false;
    }
  });
  await engine.compare(draft());
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Provider A.*model-a.*column A/);
  assert.equal(translated(f).length, 0);
  assert.equal(engine.snapshot().requests, 0);
  assert.deepEqual(
    engine.snapshot().sides.map((side) => side.status),
    ["cancelled", "cancelled"]
  );
  await engine.dispose();
});

test("each Ask column gets separate consent; declining B retains A and counts only A", async () => {
  const f = fixture({ settings: { privacyDefaultMode: "ask" } });
  const prompts = [];
  const engine = createCompareEngine(f.api, {
    confirm: (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1;
    }
  });
  await engine.compare(draft());
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Provider B.*model-b.*column B/);
  assert.equal(translated(f).length, 1);
  assert.equal(translated(f)[0].payload.cloudConsent, true);
  assert.equal(engine.snapshot().requests, 1);
  assert.equal(engine.snapshot().sides[0].translation, "Translation a");
  assert.equal(engine.snapshot().sides[1].status, "cancelled");
  await engine.dispose();
});

test("Cancel during unresolved consent prevents every send, even if approval arrives later", async () => {
  const f = fixture({ settings: { privacyDefaultMode: "ask" } });
  const consent = deferred();
  let asked = 0;
  const engine = createCompareEngine(f.api, {
    confirm: () => {
      asked++;
      return consent.promise;
    }
  });
  const pending = engine.compare(draft());
  await waitFor(() => asked === 1);
  engine.cancel();
  consent.resolve(true);
  await assert.rejects(pending, /source-cancelled/);
  assert.equal(translated(f).length, 0);
  assert.equal(engine.snapshot().requests, 0);
  await engine.dispose();
});

test("Cancel after A was sent drops its late response and does not dispatch B", async () => {
  const reply = deferred();
  const f = fixture({ send: () => reply.promise });
  const engine = createCompareEngine(f.api);
  const pending = engine.compare(draft());
  await waitFor(() => translated(f).length === 1);
  engine.cancel();
  reply.resolve({ ok: true, result: { translation: "LATE" } });
  await assert.rejects(pending, /source-cancelled/);
  assert.equal(translated(f).length, 1);
  assert.equal(engine.snapshot().requests, 1);
  assert.ok(engine.snapshot().sides.every((side) => side.translation === ""));
  await engine.dispose();
});

test("one-side failure preserves the other; Retry sends only the failed column and asks again", async () => {
  let aCalls = 0;
  const f = fixture({
    settings: { privacyDefaultMode: "ask" },
    send: async ({ payload }) => {
      if (payload.providerId === "a" && ++aCalls === 1)
        return { ok: false, error: "Synthetic A failure" };
      return {
        ok: true,
        result: { translation: `Result ${payload.providerId}` }
      };
    }
  });
  let prompts = 0;
  const engine = createCompareEngine(f.api, {
    confirm: () => {
      prompts++;
      return true;
    }
  });
  await engine.compare(draft());
  assert.equal(engine.snapshot().sides[0].status, "error");
  assert.equal(engine.snapshot().sides[1].translation, "Result b");
  await assert.rejects(engine.retry("b"), /compare-retry/);
  await engine.retry("a");
  assert.equal(prompts, 3);
  assert.deepEqual(
    translated(f).map(({ payload }) => payload.providerId),
    ["a", "b", "a"]
  );
  assert.deepEqual(
    engine.snapshot().sides.map((side) => side.requests),
    [2, 1]
  );
  assert.equal(engine.snapshot().requests, 3);
  assert.equal(engine.snapshot().sides[1].translation, "Result b");
  await engine.dispose();
});

test("Local-only rejects a cloud column before sending; two loopback models can compare", async () => {
  const f = fixture({ settings: { privacyDefaultMode: "local-only" } });
  const engine = createCompareEngine(f.api);
  await assert.rejects(engine.compare(draft()), /Local-only/);
  assert.equal(translated(f).length, 0);
  await engine.compare(draft({ a: { providerId: "b", model: "local-a" } }));
  assert.equal(translated(f).length, 2);
  assert.ok(
    translated(f).every(({ payload }) => payload.privacyPolicy === "local-only")
  );
  await engine.dispose();
});

test("website capture uses nested top-frame safe selection bridge and retains per-site provider pin", async () => {
  const f = fixture({
    settings: {
      privacyRules: [{ hostname: "source.test", mode: "ask", providerId: "b" }]
    }
  });
  const engine = createCompareEngine(f.api, { confirm: () => true });
  const captured = await engine.capture();
  assert.equal(captured.text, "Synthetic selected text.");
  assert.deepEqual(f.sourceMessages[0], {
    id: 7,
    type: "labs-reading-source",
    payload: { feature: "compare", command: "capture", mode: "selection" },
    options: { frameId: 0 }
  });
  await assert.rejects(
    engine.compare(draft({ text: captured.text })),
    /compare-pinned-provider/
  );
  assert.equal(translated(f).length, 0);
  await engine.compare(
    draft({ text: captured.text, a: { providerId: "b", model: "local-a" } })
  );
  for (const { payload } of translated(f)) {
    assert.equal(payload.siteUrl, "https://source.test/article");
    assert.equal(payload.targetTabId, 7);
    assert.equal(payload.privacyPolicy, "ask");
    assert.equal(payload.cloudConsent, true);
    assert.equal(payload.providerId, "b");
  }
  assert.ok(
    f.sourceMessages.every(
      (message) => !JSON.stringify(message).includes("apiKey")
    )
  );
  await engine.dispose();
});

test("pasted text uses global privacy, not an unrelated selected site's policy", async () => {
  const f = fixture({
    settings: {
      privacyDefaultMode: "ask",
      privacyRules: [
        { hostname: "source.test", mode: "local-only", providerId: "b" }
      ]
    }
  });
  let prompts = 0;
  const engine = createCompareEngine(f.api, {
    confirm: () => {
      prompts++;
      return true;
    }
  });
  await engine.compare(draft());
  assert.equal(prompts, 2);
  assert.ok(translated(f).every(({ payload }) => payload.siteUrl === ""));
  await engine.dispose();
});

test("navigation after A dispatch invalidates source/results and no B or late result survives", async () => {
  const reply = deferred();
  const f = fixture({ send: () => reply.promise });
  let invalidated = 0;
  const engine = createCompareEngine(f.api, {
    onInvalidate: () => invalidated++
  });
  await engine.capture();
  const pending = engine.compare(draft());
  await waitFor(() => translated(f).length === 1);
  f.tabs.get(7).url = "https://other.test/";
  f.updated.emit(7, { url: "https://other.test/" });
  reply.resolve({ ok: true, result: { translation: "LATE" } });
  await assert.rejects(pending, /source-cancelled/);
  assert.equal(invalidated, 1);
  assert.equal(translated(f).length, 1);
  assert.ok(engine.snapshot().sides.every((side) => side.translation === ""));
  await engine.dispose();
});

test("selected-tab changes are detected even when two tabs have the same URL", async () => {
  const f = fixture();
  const engine = createCompareEngine(f.api);
  await engine.capture();
  f.select(8);
  await assert.rejects(engine.compare(draft()), /source-stale/);
  assert.equal(translated(f).length, 0);
  await engine.dispose();
});

test("settings/disable/source edit resets generation and disposes every listener", async () => {
  for (const action of ["settings", "disable", "edit", "dispose"]) {
    const reply = deferred();
    const f = fixture({ send: () => reply.promise });
    const engine = createCompareEngine(f.api);
    const pending = engine.compare(draft());
    await waitFor(() => translated(f).length === 1);
    if (action === "dispose") await engine.dispose();
    else if (action === "edit") engine.reset();
    else {
      if (action === "disable")
        f.state.translatorSettings.labFeatures.compare = false;
      else f.state.translatorSettings.providers[0].config.model = "changed";
      f.changed.emit({ translatorSettings: {} }, "local");
    }
    reply.resolve({ ok: true, result: { translation: "LATE" } });
    await assert.rejects(pending);
    assert.equal(translated(f).length, 1);
    assert.ok(engine.snapshot().sides.every((side) => side.translation === ""));
    await engine.dispose();
    assert.equal(f.changed.listeners.size, 0);
    assert.equal(f.updated.listeners.size, 0);
    assert.equal(f.removed.listeners.size, 0);
  }
});

test("missing flags and destination allowlist block before send", async () => {
  for (const settings of [
    { enabled: false },
    { labFeatures: { privacy: true, compare: false } },
    {
      privacyRules: [
        {
          hostname: "source.test",
          mode: "cloud",
          allowedDestinations: ["https://elsewhere.test"]
        }
      ]
    }
  ]) {
    const f = fixture({ settings });
    const engine = createCompareEngine(f.api);
    if (settings.privacyRules) await engine.capture();
    await assert.rejects(engine.compare(draft()));
    assert.equal(translated(f).length, 0);
    await engine.dispose();
  }
});

test("empty/oversized output and wrong provider are visible only as one-column errors", async () => {
  for (const result of [
    { translation: "" },
    { translation: "x".repeat(MAX_COMPARE_OUTPUT + 1) },
    { translation: "wrong", providerName: "Wrong provider" }
  ]) {
    const f = fixture({
      send: async ({ payload }) => ({
        ok: true,
        result: payload.providerId === "a" ? result : { translation: "Good B" }
      })
    });
    const engine = createCompareEngine(f.api);
    await engine.compare(draft());
    assert.equal(engine.snapshot().sides[0].status, "error");
    assert.equal(engine.snapshot().sides[0].translation, "");
    assert.equal(engine.snapshot().sides[1].translation, "Good B");
    await engine.dispose();
  }
});

test("real background VM honors exact two model overrides without history/cache/settings writes", async () => {
  const f = fixture({
    settings: {
      providers: [{ ...providers[1], id: "a", name: "Local A" }, providers[1]],
      allowCloudFallback: true
    }
  });
  const w = worker({
    state: f.state,
    fetch: async () => success("Synthetic VM translation")
  });
  const original = structuredClone(f.state);
  const api = {
    ...f.api,
    send: async (type, payload) => {
      assert.equal(type, "translate");
      const response = await w.translate(payload, {
        url: "chrome-extension://synthetic/pages/labs.html"
      });
      if (!response.ok) throw new Error(response.error);
      return response;
    }
  };
  const engine = createCompareEngine(api);
  await engine.compare(draft());
  assert.equal(w.calls.length, 2);
  assert.deepEqual(
    w.calls.map(([, options]) => JSON.parse(options.body).model),
    ["model-a", "model-b"]
  );
  assert.ok(
    w.calls.every(([, options]) =>
      JSON.parse(options.body).messages[0].content.includes(
        "Translate the supplied text"
      )
    )
  );
  assert.ok(engine.snapshot().sides.every((side) => side.status === "success"));
  assert.deepEqual(f.state, original);
  assert.equal(f.state.translationCache, undefined);
  assert.equal(f.state.translatorSettings.translationHistory, undefined);
  await engine.dispose();
});

test("real background VM rejects cloud Local-only and provider pin conflicts with zero fetches", async () => {
  const f = fixture({
    settings: {
      privacyDefaultMode: "local-only",
      providers: [
        { ...providers[0], config: { apiKey: "synthetic-only" } },
        providers[1]
      ],
      privacyRules: [
        { hostname: "source.test", mode: "cloud", providerId: "b" }
      ]
    }
  });
  const w = worker({ state: f.state });
  w.context.chrome.tabs = {
    get: async (id) => ({ id, url: "https://source.test/article" })
  };
  const sender = { url: "chrome-extension://synthetic/pages/labs.html" };
  const local = await w.translate(
    {
      ...comparisonOptions("en", "vi"),
      text: "Synthetic",
      providerId: "a",
      model: "a",
      siteUrl: ""
    },
    sender
  );
  assert.equal(local.ok, false);
  assert.match(local.error, /Local-only/);
  const pin = await w.translate(
    {
      ...comparisonOptions("en", "vi"),
      text: "Synthetic",
      providerId: "a",
      model: "a",
      siteUrl: "https://source.test/article",
      targetTabId: 7
    },
    sender
  );
  assert.equal(pin.ok, false);
  assert.match(pin.error, /conflicts with this site's privacy rule/);
  assert.equal(w.calls.length, 0);
});

test("diff uses only text nodes and bounds long comparisons without injecting HTML", () => {
  const dom = new JSDOM("<div></div>");
  const root = dom.window.document.querySelector("div");
  const a = '<img src=x onerror="bad()"> A & <script>bad()</script>';
  const b = '<img src=y onerror="bad()"> B & <svg onload="bad()">';
  renderDiff(root, a, b);
  assert.equal(root.querySelector("img,script,svg"), null);
  assert.ok(root.querySelector("del"));
  assert.ok(root.querySelector("ins"));
  const before = "a ".repeat(1000),
    after = "b ".repeat(1000);
  renderDiff(root, before, after);
  assert.equal(root.children.length, 2);
  assert.equal(root.querySelector("del").textContent, before);
  assert.equal(root.querySelector("ins").textContent, after);
  dom.window.close();
});

async function uiFixture(options = {}) {
  const f = fixture(options);
  const dom = new JSDOM(
    '<select id="lab-target"><option value="7">Synthetic tab</option></select><main></main>',
    { url: "chrome-extension://synthetic/pages/labs.html" }
  );
  const { document } = dom.window;
  const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async (text) => copied.push(text) }
  });
  dom.window.confirm = () => true;
  const t = (en) => en;
  const api = {
    ...f.api,
    t,
    field: (label, node) => {
      const field = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = label;
      field.append(span, node);
      return field;
    }
  };
  const container = document.querySelector("main");
  const cleanup = await mount(container, api);
  const control = (key) => container.querySelector(`[data-compare="${key}"]`);
  const click = (label) => {
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label
    );
    assert.ok(button, label);
    button.click();
    return button;
  };
  function input(key, value, type = "input") {
    const node = control(key);
    node.value = value;
    node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  }
  return {
    ...f,
    dom,
    container,
    control,
    input,
    click,
    copied,
    cleanup: () => {
      cleanup();
      dom.window.close();
    }
  };
}

test("UI mounts without capture/send/save, shows exact preview metadata, safe columns/diff and explicit pick/copy", async () => {
  const html = '<img src=x onerror="bad()"> & synthetic';
  const f = await uiFixture({
    send: async ({ payload }) => ({
      ok: true,
      result: { translation: `${html} ${payload.providerId}` }
    })
  });
  assert.equal(f.messages.length, 0);
  assert.equal(f.sourceMessages.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.control("provider-a").value, "a");
  assert.equal(f.control("provider-b").value, "b");
  assert.match(f.container.textContent, /TWO separate requests/);
  assert.match(f.container.textContent, /No winner selected/);
  f.input("source", html);
  f.input("model-a", "override-a");
  f.input("model-b", "override-b");
  f.click("Compare · 2 requests");
  await waitFor(() => !f.control("output-b").hidden);
  assert.equal(translated(f).length, 2);
  assert.match(f.container.textContent, /model override-a/);
  assert.match(f.container.textContent, /model override-b/);
  assert.match(f.container.textContent, /2 requests dispatched/);
  assert.equal(f.container.querySelector("img,script,svg"), null);
  assert.match(f.control("output-a").textContent, /<img/);
  assert.ok(f.control("diff").querySelector("ins"));
  f.click("Choose B");
  await tick();
  assert.match(f.container.textContent, /Your choice: B/);
  f.click("Copy B");
  await tick();
  assert.deepEqual(f.copied, [`${html} b`]);
  assert.equal(f.writes.length, 0);
  f.cleanup();
  assert.equal(f.changed.listeners.size, 0);
});

test("UI capture previews before send; edited capture keeps website privacy; target navigation clears text", async () => {
  const f = await uiFixture({
    settings: {
      privacyRules: [{ hostname: "source.test", mode: "ask", providerId: "b" }]
    }
  });
  f.click("Capture website selection");
  await waitFor(() => f.control("source").value === "Synthetic selected text.");
  assert.equal(translated(f).length, 0);
  assert.match(f.container.textContent, /Edits keep this site's privacy rule/);
  f.input("source", "Edited selected text");
  f.click("Compare · 2 requests");
  await waitFor(() =>
    f.statuses.some(([message]) => message.includes("pins a provider"))
  );
  assert.equal(translated(f).length, 0);
  f.input("provider-a", "b", "change");
  f.input("model-a", "other-local-model");
  f.click("Compare · 2 requests");
  await waitFor(() => translated(f).length === 2);
  assert.ok(
    translated(f).every(
      ({ payload }) => payload.siteUrl === "https://source.test/article"
    )
  );
  f.updated.emit(7, { url: "https://other.test/" });
  assert.equal(f.control("source").value, "");
  assert.equal(f.control("output-a").textContent, "");
  f.cleanup();
});

test("UI edits cancel an in-flight run; late results cannot render or start B", async () => {
  const reply = deferred();
  const f = await uiFixture({ send: () => reply.promise });
  f.input("source", "Synthetic old");
  f.click("Compare · 2 requests");
  await waitFor(() => translated(f).length === 1);
  f.input("source", "Synthetic new");
  reply.resolve({ ok: true, result: { translation: "LATE" } });
  await tick();
  await tick();
  assert.equal(translated(f).length, 1);
  assert.equal(f.control("output-a").textContent, "");
  assert.equal(f.control("source").value, "Synthetic new");
  f.cleanup();
});

test("UI disable tears down pending requests and controls; unmount removes content/listeners", async () => {
  const reply = deferred();
  const f = await uiFixture({ send: () => reply.promise });
  f.input("source", "Synthetic text");
  f.click("Compare · 2 requests");
  await waitFor(() => translated(f).length === 1);
  f.state.translatorSettings.labFeatures.compare = false;
  f.changed.emit({ translatorSettings: {} }, "local");
  await tick();
  assert.equal(f.control("source").disabled, true);
  assert.equal(f.control("provider-a").disabled, true);
  reply.resolve({ ok: true, result: { translation: "LATE" } });
  await tick();
  assert.equal(f.control("output-a").textContent, "");
  assert.equal(translated(f).length, 1);
  f.cleanup();
  assert.equal(f.container.children.length, 0);
  assert.equal(f.changed.listeners.size, 0);
  assert.equal(f.updated.listeners.size, 0);
});

test("UI pagehide/unmount while A is pending drops results and does not dispatch B", async () => {
  const reply = deferred();
  const f = await uiFixture({ send: () => reply.promise });
  f.input("source", "Synthetic source");
  f.click("Compare · 2 requests");
  await waitFor(() => translated(f).length === 1);
  f.dom.window.dispatchEvent(new f.dom.window.Event("pagehide"));
  reply.resolve({ ok: true, result: { translation: "LATE" } });
  await tick();
  assert.equal(f.container.textContent, "");
  assert.equal(translated(f).length, 1);
  assert.equal(f.changed.listeners.size, 0);
  f.cleanup();
});

test("static Compare surface has no remote JS, HTML injection, persistence or provider/global settings mutation", () => {
  for (const file of ["compare.js", "compare-engine.js"]) {
    const text = readFileSync(
      new URL(`../extension/src/experimental/${file}`, import.meta.url),
      "utf8"
    );
    assert.doesNotMatch(
      text,
      /innerHTML|insertAdjacentHTML|\beval\s*\(|new Function|\bfetch\s*\(|updateSettings|storage\.local\.set|activeProviderId\s*=/
    );
  }
  const settings = fixture().state.translatorSettings;
  assert.equal(prepareComparison(settings, draft()).options.ephemeral, true);
});

test("settings change while consent is pending invalidates approval before any send", async () => {
  const f = fixture({ settings: { privacyDefaultMode: "ask" } });
  const consent = deferred();
  let asked = false;
  const engine = createCompareEngine(f.api, {
    confirm: () => {
      asked = true;
      return consent.promise;
    }
  });
  const pending = engine.compare(draft());
  await waitFor(() => asked);
  f.state.translatorSettings.providers[0].config.model = "changed-model";
  f.changed.emit({ translatorSettings: {} }, "local");
  consent.resolve(true);
  await assert.rejects(pending, /source-cancelled/);
  assert.equal(translated(f).length, 0);
  assert.equal(engine.snapshot().requests, 0);
  await engine.dispose();
});

test("a new run cannot reuse cancelled run text or late output with a newer column/model", async () => {
  const reply = deferred();
  let calls = 0;
  const f = fixture({
    send: async ({ payload }) => {
      if (++calls === 1) return reply.promise;
      return {
        ok: true,
        result: { translation: `${payload.text}:${payload.model}` }
      };
    }
  });
  const engine = createCompareEngine(f.api);
  const old = engine.compare(draft({ text: "Old text" }));
  await waitFor(() => translated(f).length === 1);
  engine.cancel();
  await engine.compare(
    draft({ text: "New text", a: { providerId: "a", model: "new-model" } })
  );
  reply.resolve({ ok: true, result: { translation: "LATE OLD" } });
  await assert.rejects(old, /source-cancelled/);
  assert.equal(translated(f).length, 3);
  assert.deepEqual(
    translated(f).map(({ payload }) => payload.text),
    ["Old text", "New text", "New text"]
  );
  assert.equal(engine.snapshot().sides[0].translation, "New text:new-model");
  assert.equal(engine.snapshot().requests, 2);
  await engine.dispose();
});

test("a delayed source capture never overwrites newer manual edits and clears its snapshot", async () => {
  const f = await uiFixture();
  const response = deferred();
  let asked = false;
  const sendMessage = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (id, message, options) => {
    if (message.payload.command === "capture") {
      asked = true;
      return response.promise;
    }
    return sendMessage(id, message, options);
  };
  f.click("Capture website selection");
  await waitFor(() => asked);
  f.input("source", "New manual edit");
  response.resolve({
    ok: true,
    source: {
      kind: "website",
      url: "https://source.test/article",
      snapshotId: "late-source",
      blocks: [{ id: "s", text: "LATE CAPTURE" }]
    }
  });
  await tick();
  await tick();
  assert.equal(f.control("source").value, "New manual edit");
  assert.equal(translated(f).length, 0);
  assert.ok(
    f.sourceMessages.some(
      ({ payload }) =>
        payload.command === "clear" && payload.snapshotId === "late-source"
    )
  );
  f.cleanup();
});

test("oversized capture is not silently truncated and leaves no old website preview or snapshot", async () => {
  const f = await uiFixture({ captureText: "x".repeat(MAX_COMPARE_TEXT + 1) });
  f.input("source", "Older pasted text");
  f.click("Capture website selection");
  await waitFor(() =>
    f.statuses.some(([message]) => message.includes("never silently truncated"))
  );
  assert.equal(f.control("source").value, "");
  assert.equal(translated(f).length, 0);
  assert.ok(
    f.sourceMessages.some(({ payload }) => payload.command === "clear")
  );
  f.cleanup();
});

test("UI retry preserves the successful column and exposes the extra request count", async () => {
  let bRequests = 0;
  const f = await uiFixture({
    send: async ({ payload }) => {
      if (payload.providerId === "b" && ++bRequests === 1)
        return { ok: false, error: "Synthetic failure B" };
      return {
        ok: true,
        result: { translation: `Result ${payload.providerId}` }
      };
    }
  });
  f.input("source", "Synthetic source");
  f.click("Compare · 2 requests");
  await waitFor(() => f.container.textContent.includes("Synthetic failure B"));
  assert.equal(f.control("output-a").textContent, "Result a");
  const retry = [
    ...f.container.querySelector('[data-column="b"]').querySelectorAll("button")
  ].find((button) => button.textContent.startsWith("Retry"));
  assert.equal(retry.hidden, false);
  retry.click();
  await waitFor(() => !f.control("output-b").hidden);
  assert.equal(f.control("output-a").textContent, "Result a");
  assert.deepEqual(
    translated(f).map(({ payload }) => payload.providerId),
    ["a", "b", "b"]
  );
  assert.match(f.container.textContent, /3 requests dispatched/);
  f.cleanup();
});

test("mount settings failure fails closed and releases listeners before propagating the error", async () => {
  const f = fixture();
  const dom = new JSDOM("<main></main>");
  const container = dom.window.document.querySelector("main");
  await assert.rejects(
    mount(container, {
      ...f.api,
      settings: async () => {
        throw new Error("Synthetic settings failure");
      },
      field: (label, node) => node
    }),
    /Synthetic settings failure/
  );
  assert.equal(container.children.length, 0);
  assert.equal(f.changed.listeners.size, 0);
  assert.equal(f.updated.listeners.size, 0);
  assert.equal(f.removed.listeners.size, 0);
  dom.window.close();
});
