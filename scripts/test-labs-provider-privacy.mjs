import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  worker,
  google,
  local,
  builtin,
  success,
  source,
  tick
} from "./test-labs-provider-harness.mjs";
import {
  endpoint,
  hostnameMatches
} from "../extension/src/common/privacy-policy.js";

const privateSettings = {
  labFeatures: { privacy: true },
  privacyDefaultMode: "local-only",
  allowCloudFallback: true
};
const extensionSender = { url: "chrome-extension://synthetic/pages/labs.html" };

test("strict loopback, host suffix boundaries and invalid endpoints", () => {
  for (const url of [
    "http://localhost:11434/v1",
    "http://127.0.0.1",
    "http://[::1]:999"
  ])
    assert.equal(endpoint(url).local, true);
  for (const url of [
    "https://localhost.evil.test",
    "http://127.1",
    "http://2130706433",
    "http://127.0.0.2",
    "https://evil.test/localhost"
  ])
    assert.equal(endpoint(url).local, false);
  for (const url of [
    "file:///private",
    "https://user:secret@example.test",
    "not-url"
  ])
    assert.throws(() => endpoint(url));
  assert.equal(hostnameMatches("sub.work.test", "work.test"), true);
  assert.equal(hostnameMatches("notwork.test", "work.test"), false);
  assert.equal(hostnameMatches("work.test.evil.test", "work.test"), false);
});

test("local failure never contacts cloud by default or under local-only even opted in", async () => {
  for (const settings of [{}, privateSettings]) {
    const w = worker({
      settings,
      fetch: async () => {
        throw new Error("Local unavailable");
      }
    });
    const result = await w.translate();
    assert.equal(result.ok, false);
    assert.equal(w.calls.length, 1);
    assert.match(w.calls[0][0], /^http:\/\/localhost:/);
  }
});

test("provider names do not make remote endpoints local; image and text are denied", async () => {
  const w = worker({
    settings: {
      ...privateSettings,
      providers: [{ ...local, config: { baseUrl: "https://remote.test/v1" } }]
    }
  });
  assert.equal((await w.translate()).privacyBlocked, true);
  assert.equal(
    (
      await w.send("translate-image", {
        providerId: "local",
        imageBase64: "SYNTHETIC"
      })
    ).privacyBlocked,
    true
  );
  assert.equal(w.calls.length, 0);
});

test("sender URL overrides spoofed payload; exact/subdomain rule routes to local", async () => {
  const w = worker({
    settings: {
      labFeatures: { privacy: true },
      activeProviderId: google.id,
      privacyRules: [
        { hostname: "work.test", mode: "local-only", providerId: "local" }
      ]
    }
  });
  const result = await w.translate(
    { siteUrl: "https://public.test" },
    { tab: { url: "https://sub.work.test/a" } }
  );
  assert.equal(result.ok, true);
  assert.match(w.calls[0][0], /^http:\/\/localhost/);
  await w.translate(
    { text: "Different" },
    { tab: { url: "https://notwork.test" } }
  );
  assert.match(w.calls[1][0], /translate.googleapis.com/);
  const denied = await w.translate(
    { privacyPolicy: "local-only", providerId: google.id },
    extensionSender
  );
  assert.equal(denied.privacyBlocked, true);
});

test("ask consent is per action and extension-only, allowlist still wins", async () => {
  const settings = {
    labFeatures: { privacy: true },
    privacyDefaultMode: "ask",
    activeProviderId: google.id
  };
  const w = worker({ settings });
  assert.equal(
    (
      await w.translate(
        { cloudConsent: true },
        { tab: { url: "https://work.test" } }
      )
    ).privacyBlocked,
    true
  );
  assert.equal(
    (await w.translate({ cloudConsent: true }, extensionSender)).ok,
    true
  );
  assert.equal((await w.translate({}, extensionSender)).privacyBlocked, true);
  assert.equal(w.calls.length, 1);
  await w.send("set-settings", {
    privacyRules: [
      {
        hostname: "work.test",
        mode: "cloud",
        allowedDestinations: ["http://localhost:11434"]
      }
    ]
  });
  assert.equal(
    (
      await w.translate(
        { cloudConsent: true, siteUrl: "https://work.test" },
        extensionSender
      )
    ).privacyBlocked,
    true
  );
  assert.equal(w.calls.length, 1);
});

test("request guard rechecks actual fetch destination and forbids redirects", async () => {
  const w = worker({
    settings: {
      ...privateSettings,
      providers: [{ ...local, config: { baseUrl: "http://127.1:11434/v1" } }]
    }
  });
  assert.equal((await w.translate()).privacyBlocked, true);
  assert.equal(w.calls.length, 0);
  const allowed = worker();
  await allowed.translate();
  assert.equal(allowed.calls[0][1].redirect, "error");
});

test("DeepL auto omits source, maps target variants, explicit source stays valid", async () => {
  const w = worker({
    settings: {
      providers: [
        { id: "deepl", type: "deepl", config: { apiKey: "synthetic:fx" } }
      ],
      activeProviderId: "deepl"
    }
  });
  assert.equal(
    (await w.translate({ sourceLanguage: "auto", targetLanguage: "en" })).ok,
    true
  );
  assert.equal(w.calls[0][1].body.has("source_lang"), false);
  assert.equal(w.calls[0][1].body.get("target_lang"), "EN-US");
  await w.translate({ sourceLanguage: "en-US", targetLanguage: "zh-TW" });
  assert.equal(w.calls[1][1].body.get("source_lang"), "EN");
  assert.equal(w.calls[1][1].body.get("target_lang"), "ZH-HANT");
});

test("instruction tasks bypass language no-op; translation-only engines reject without fallback", async () => {
  for (const task of ["rewrite", "dictionary", "grammar"]) {
    const w = worker({ detect: "en" });
    const result = await w.translate({
      task,
      targetLanguage: "en",
      sourceLanguage: "auto",
      customPrompt: "Return a synthetic structured task response"
    });
    assert.equal(result.ok, true);
    assert.equal(w.calls.length, 1);
    assert.match(
      JSON.parse(w.calls[0][1].body).messages[0].content,
      /Perform the requested/
    );
    for (const provider of [
      google,
      builtin,
      { id: "deepl", type: "deepl", config: {} }
    ]) {
      const denied = worker({
        settings: {
          activeProviderId: provider.id,
          providers: [provider],
          allowCloudFallback: true
        },
        detect: "en"
      });
      assert.equal(
        (
          await denied.translate({
            task,
            sourceLanguage: "auto",
            targetLanguage: "same"
          })
        ).ok,
        false
      );
      assert.equal(denied.calls.length, 0);
    }
  }
  const w = worker({ detect: "en" });
  assert.equal(
    (await w.translate({ sourceLanguage: "auto", targetLanguage: "en" })).result
      .skippedSameLanguage,
    true
  );
  assert.equal(w.calls.length, 0);
});

test("full config, global/request prompt and context fingerprint; secrets are not stored in cache keys", async () => {
  const w = worker();
  await w.translate();
  assert.equal((await w.translate()).result.cached, true);
  for (const patch of [
    { config: { ...local.config, model: "new" } },
    {
      config: {
        ...local.config,
        model: "new",
        baseUrl: "http://localhost:999/v1"
      }
    }
  ]) {
    await w.send("set-settings", { providers: [{ ...local, ...patch }] });
    assert.equal((await w.translate()).result.cached, undefined);
  }
  await w.send("set-settings", { customPrompt: "New prompt" });
  await w.translate();
  await w.translate({ context: "Synthetic context" });
  await w.translate({ customPrompt: "Request prompt" });
  assert.equal(w.calls.length, 6);
  assert.equal(Object.keys(w.state.translationCache).length, 6);
  assert.ok(
    Object.keys(w.state.translationCache).every((key) =>
      /^v2:[a-f0-9]{64}$/.test(key)
    )
  );
  const restarted = worker({ state: w.state });
  assert.equal(
    (await restarted.translate({ customPrompt: "Request prompt" })).result
      .cached,
    true
  );
  assert.equal(restarted.calls.length, 0);
});

test("concurrent reverse completions preserve cache and latest history; clear epoch prevents restore", async () => {
  const pending = new Map();
  const w = worker({
    fetch: (url, options) =>
      new Promise((resolve) => {
        pending.set(JSON.parse(options.body).messages[1].content, resolve);
      })
  });
  const a = w.translate({ text: "A" });
  const b = w.translate({ text: "B" });
  while (pending.size < 2) await tick();
  pending.get("B")(success("B result"));
  await b;
  pending.get("A")(success("A result"));
  await a;
  assert.equal(Object.keys(w.state.translationCache).length, 2);
  assert.deepEqual(
    w.state.translatorSettings.translationHistory.map((e) => e.text),
    ["A", "B"]
  );
  const c = w.translate({ text: "C" });
  while (!pending.has("C")) await tick();
  await w.send("set-settings", { translationHistory: [] });
  await w.send("privacy-clear-cache");
  pending.get("C")(success("C result"));
  await c;
  assert.deepEqual(w.state.translatorSettings.translationHistory, []);
  assert.deepEqual(w.state.translationCache, {});
});

test("LRU hits persist and survive worker reload; TTL expires", async () => {
  const w = worker();
  for (let i = 0; i < 300; i++) {
    w.advance();
    await w.translate({ text: `item ${i}`, skipHistory: true });
  }
  const firstKey = Object.keys(w.state.translationCache)[0];
  const ts = w.state.translationCache[firstKey].ts;
  w.advance(100);
  assert.equal(
    (await w.translate({ text: "item 0", skipHistory: true })).result.cached,
    true
  );
  assert.ok(w.state.translationCache[firstKey].ts > ts);
  const restarted = worker({ state: w.state });
  await restarted.translate({ text: "extra", skipHistory: true });
  assert.ok(w.state.translationCache[firstKey]);
  assert.equal(Object.keys(w.state.translationCache).length, 300);
  assert.equal(
    (await restarted.translate({ text: "item 0", skipHistory: true })).result
      .cached,
    true
  );
  restarted.advance(169 * 3600000);
  assert.equal(
    (await restarted.translate({ text: "item 0", skipHistory: true })).result
      .cached,
    undefined
  );
});

test("retention disabled/incognito don't read or write private history/cache; concurrent settings merge", async () => {
  for (const patch of [
    { cacheEnabled: false, historyEnabled: false },
    { retentionEnabled: false }
  ]) {
    const w = worker({ settings: patch });
    await w.translate();
    await w.translate();
    assert.equal(w.calls.length, 2);
    assert.equal(JSON.stringify(w.state).includes("Synthetic input"), false);
  }
  const w = worker();
  await w.translate({ text: "normal" });
  const snapshot = JSON.stringify(w.state);
  await w.translate(
    { text: "private" },
    { tab: { url: "https://work.test", incognito: true } }
  );
  assert.equal(JSON.stringify(w.state), snapshot);
  await Promise.all([
    w.send("set-settings", { theme: "dark" }),
    w.send("set-settings", { targetLanguageCode: "fr" })
  ]);
  assert.equal(w.state.translatorSettings.theme, "dark");
  assert.equal(w.state.translatorSettings.targetLanguageCode, "fr");
  await w.send("set-settings", { cacheEnabled: false, historyEnabled: false });
  assert.deepEqual(w.state.translationCache, {});
  assert.deepEqual(w.state.translatorSettings.translationHistory, []);
});

test("TTS local-only sends local voice request, ask blocks page consent, offscreen errors propagate", async () => {
  const w = worker({
    settings: privateSettings,
    offscreen: { ok: false, error: "No local voice" }
  });
  const result = await w.send("tts-play", {
    text: "Synthetic speech",
    lang: "vi",
    urlTemplate: "https://evil.test"
  });
  assert.equal(result.ok, false);
  assert.equal(w.sent[0].payload.localOnly, true);
  assert.equal(w.calls.length, 0);
  const ask = worker({
    settings: { labFeatures: { privacy: true }, privacyDefaultMode: "ask" }
  });
  assert.equal(
    (
      await ask.send(
        "tts-play",
        { text: "Synthetic", cloudConsent: true },
        { tab: { url: "https://work.test" } }
      )
    ).privacyBlocked,
    true
  );
  assert.equal(ask.sent.length, 0);
  await ask.send("tts-stop");
  assert.equal(ask.sent[0].type, "offscreen-tts-stop");
});

test("offscreen singleton latest-wins, pause/stop, local voice selection and unsupported errors", async () => {
  const audios = [];
  const spoken = [];
  let fetches = 0;
  let listener;
  class AudioMock {
    constructor() {
      audios.push(this);
    }
    async play() {
      this.active = true;
    }
    pause() {
      this.active = false;
    }
    removeAttribute() {}
    load() {}
  }
  const synth = {
    getVoices: () => [
      { lang: "en-US", localService: false },
      { lang: "en-US", localService: true }
    ],
    speak(u) {
      spoken.push(u);
    },
    cancel() {},
    pause() {},
    resume() {}
  };
  const context = vm.createContext({
    URL: { createObjectURL: () => "blob:synthetic", revokeObjectURL() {} },
    AbortController,
    Audio: AudioMock,
    self: {
      speechSynthesis: synth,
      SpeechSynthesisUtterance: class {
        constructor(text) {
          this.text = text;
        }
      }
    },
    fetch: async () => {
      fetches++;
      return { ok: true, blob: async () => ({}) };
    },
    assertDestination() {},
    chrome: {
      runtime: {
        getURL: (p) => p,
        onMessage: {
          addListener(fn) {
            listener = fn;
          }
        }
      }
    },
    normalizeLanguageToCode: (v) => v
  });
  vm.runInContext(source("offscreen.js"), context);
  const play = (options) => {
    context.options = options;
    return vm.runInContext("playTTS(options)", context);
  };
  const options = {
    text: "Synthetic",
    lang: "en",
    urlTemplate: "https://speech.test/{text}",
    privacyPolicy: { mode: "cloud" }
  };
  const a = play(options);
  await tick();
  assert.equal(audios[0].active, true);
  const b = play(options);
  await tick();
  assert.equal((await a).stopped, true);
  assert.equal(audios[0].active, false);
  assert.equal(audios[1].active, true);
  listener(
    { type: "offscreen-tts-pause" },
    { url: "src/background.js" },
    () => {}
  );
  assert.equal(audios[1].active, false);
  vm.runInContext("stopTTS()", context);
  assert.equal((await b).stopped, true);
  const c = play({ text: "Local", lang: "en", localOnly: true });
  await tick();
  assert.equal(spoken[0].voice.localService, true);
  spoken[0].onend();
  assert.equal((await c).ok, true);
  const denied = await play({ text: "Local", lang: "vi", localOnly: true });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /No local speech voice/);
  assert.equal(fetches, 2);
  assert.equal(
    listener(
      { type: "play-tts", payload: options },
      { tab: { id: 1 }, url: "src/background.js" },
      () => {}
    ),
    false
  );
});

test("ephemeral captions bypass existing cache and never persist success/failure/fallback or history", async () => {
  const w = worker();
  await w.translate({ text: "same caption", skipHistory: true });
  const snapshot = JSON.stringify(w.state);
  const ephemeral = await w.translate({
    text: "same caption",
    ephemeral: true
  });
  assert.equal(ephemeral.ok, true);
  assert.equal(ephemeral.result.cached, undefined);
  assert.equal(w.calls.length, 2);
  assert.equal(JSON.stringify(w.state), snapshot);
  const failed = worker({
    fetch: async () => {
      throw new Error("Synthetic outage");
    }
  });
  assert.equal(
    (await failed.translate({ text: "ephemeral failure", ephemeral: true })).ok,
    false
  );
  assert.equal(
    JSON.stringify(failed.state).includes("ephemeral failure"),
    false
  );
  const fallback = worker({
    settings: { activeProviderId: "builtin", allowCloudFallback: true }
  });
  assert.equal(
    (await fallback.translate({ text: "ephemeral fallback", ephemeral: true }))
      .ok,
    true
  );
  assert.equal(
    JSON.stringify(fallback.state).includes("ephemeral fallback"),
    false
  );
  const builtinWorker = worker({
    settings: { activeProviderId: "builtin" },
    offscreen: { ok: true, translation: "ephemeral output" }
  });
  assert.equal(
    (
      await builtinWorker.translate({
        text: "ephemeral offscreen",
        ephemeral: true
      })
    ).ok,
    true
  );
  assert.equal(
    JSON.stringify(builtinWorker.state).includes("ephemeral"),
    false
  );
});

test("storage failures are surfaced, never hidden by cache or cloud fallback", async () => {
  const w = worker({ settings: { allowCloudFallback: true } });
  const originalGet = w.context.chrome.storage.local.get;
  w.context.chrome.storage.local.get = async (key) => {
    if (key === "translationCache") throw new Error("Cache permission denied");
    return originalGet(key);
  };
  const denied = await w.translate();
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Cache permission denied/);
  assert.equal(w.calls.length, 0);

  w.context.chrome.storage.local.get = originalGet;
  const originalSet = w.context.chrome.storage.local.set;
  let cacheWrites = 0;
  w.context.chrome.storage.local.set = async (values) => {
    if ("translationCache" in values && ++cacheWrites === 2)
      throw new Error("Storage full");
    return originalSet(values);
  };
  const full = await w.translate({ skipHistory: true });
  assert.equal(full.ok, false);
  assert.match(full.error, /Storage full/);
  assert.equal(w.calls.length, 1);
});

test("rules referencing removed providers fail visibly for text and images", async () => {
  const w = worker({
    settings: {
      labFeatures: { privacy: true },
      privacyRules: [
        { hostname: "work.test", mode: "local-only", providerId: "removed" }
      ]
    }
  });
  const sender = { tab: { url: "https://work.test" } };
  const text = await w.translate({}, sender);
  assert.equal(text.ok, false);
  assert.match(text.error, /Selected provider is not configured/);
  const image = await w.send(
    "translate-image",
    { imageBase64: "SYNTHETIC" },
    sender
  );
  assert.equal(image.ok, false);
  assert.match(image.error, /Selected image provider is not configured/);
  assert.equal(w.calls.length, 0);
});

test("privacy panel previews real routes, saves rules and removes listeners", async () => {
  const { mount } = await import("../extension/src/experimental/privacy.js");
  const create = (tag) => ({
    tag,
    children: [],
    listeners: {},
    append(...children) {
      this.children.push(...children);
    },
    addEventListener(type, callback, options) {
      this.listeners[type] = { callback, signal: options.signal };
    },
    remove() {
      this.removed = true;
    },
    checkValidity() {
      return Number(this.value) > 0 && Number(this.value) <= 8760;
    }
  });
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: create };
  try {
    const container = create("main");
    const patches = [];
    const api = {
      t: (en) => en,
      settings: async () => ({
        providers: [local, google],
        activeProviderId: google.id,
        screenshotProviderId: local.id,
        labFeatures: {},
        privacyRules: []
      }),
      field(label, element) {
        const wrapper = create("label");
        wrapper.textContent = label;
        wrapper.append(element);
        return wrapper;
      },
      updateSettings: async (patch) => patches.push(patch),
      send: async () => ({ ok: true }),
      status() {}
    };
    const cleanup = await mount(container, api);
    const nodes = () => {
      const items = [];
      const visit = (node) => {
        items.push(node);
        node.children.forEach(visit);
      };
      visit(container);
      return items;
    };
    const click = (label) =>
      nodes()
        .find((node) => node.tag === "button" && node.textContent === label)
        .listeners.click.callback();
    assert.ok(
      nodes().some(
        (node) =>
          node.textContent?.includes("translate.googleapis.com") &&
          node.textContent?.includes("localhost:11434") &&
          node.textContent?.includes("translate.google.com")
      )
    );
    await click("Add hostname rule");
    nodes().find((node) => node.placeholder === "work.example.com").value =
      "work.test";
    await click("Save privacy settings");
    assert.equal(patches[0].privacyRules[0].hostname, "work.test");
    assert.equal(patches[0].privacyRules[0].mode, "local-only");
    cleanup();
    assert.equal(container.children[0].removed, true);
    assert.equal(
      nodes().find((node) => node.tag === "button").listeners.click.signal
        .aborted,
      true
    );
  } finally {
    globalThis.document = previousDocument;
  }
});
