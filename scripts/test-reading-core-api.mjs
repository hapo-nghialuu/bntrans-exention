import test from "node:test";
import assert from "node:assert/strict";
import { readSettings } from "../extension/src/common/settings-storage.js";
import { createLabApi } from "../extension/src/experimental/lab-api.js";
import { createReadingFeatureApi } from "../extension/src/experimental/reading-feature-api.js";
import {
  worker,
  local,
  google,
  success,
  tick
} from "./test-labs-provider-harness.mjs";

const sender = {
  id: "synthetic",
  url: "chrome-extension://synthetic/pages/labs.html"
};
const flags = {
  ask: true,
  image: true,
  compare: true,
  readalong: true,
  privacy: true
};
function fixture(settings = {}) {
  const calls = [],
    listeners = new Set();
  const state = {
    translatorSettings: {
      enabled: true,
      labFeatures: flags,
      activeProviderId: "local",
      ...settings
    }
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: state[key] };
        }
      },
      onChanged: {
        addListener(fn) {
          listeners.add(fn);
        },
        removeListener(fn) {
          listeners.delete(fn);
        }
      }
    },
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        return { ok: true, result: { translation: "synthetic" } };
      }
    },
    tabs: {
      async get(id) {
        return { id, url: "https://work.test/article" };
      },
      async sendMessage(id, message, options) {
        calls.push({ id, ...message, options });
        return {
          ok: true,
          source: {
            url: "https://work.test/article",
            snapshotId: "snapshot",
            blocks: []
          }
        };
      }
    }
  };
  return {
    state,
    calls,
    listeners,
    api: createLabApi({ selectedTab: () => 9 })
  };
}

test("five new flags default off for empty and legacy saved settings", async () => {
  for (const settings of [undefined, { labFeatures: { page: true } }]) {
    fixture();
    chrome.storage.local.get = async () => ({ translatorSettings: settings });
    const actual = await readSettings();
    for (const feature of [
      "corrections",
      "ask",
      "image",
      "compare",
      "readalong"
    ])
      assert.equal(actual.labFeatures[feature], false);
    if (settings) assert.equal(actual.labFeatures.page, true);
  }
});

test("explicit empty PDF site URL never falls back to selected website or its Ask rule", async () => {
  const { api, calls } = fixture({
    privacyRules: [{ hostname: "work.test", mode: "ask" }]
  });
  globalThis.window = {
    confirm() {
      throw new Error("website consent must not run");
    }
  };
  await api.translate("synthetic PDF", { siteUrl: "", labFeature: "ask" });
  assert.equal(calls[0].payload.siteUrl, "");
  assert.equal(calls[0].payload.targetTabId, undefined);
  await api.translate("synthetic website", {
    labFeature: "ask",
    privacyPolicy: "local-only"
  });
  assert.equal(calls[1].payload.targetTabId, 9);
  assert.equal(calls[1].payload.siteUrl, "https://work.test/article");
});

test("feature wrapper sends canonical nested source envelope and cleans pinned top frame", async () => {
  const { api, calls, listeners } = fixture();
  const feature = createReadingFeatureApi(api, "ask");
  const source = await feature.capture("article");
  assert.deepEqual(calls[0], {
    id: 9,
    type: "labs-reading-source",
    payload: { feature: "ask", command: "capture", mode: "article" },
    options: { frameId: 0 }
  });
  await feature.jump(source, "web-1");
  assert.equal(calls[1].payload.snapshotId, "snapshot");
  await feature.translate("synthetic", {
    siteUrl: "",
    skipHistory: false,
    ephemeral: false,
    labFeature: "image",
    model: "two"
  });
  assert.equal(calls[2].payload.labFeature, "ask");
  assert.equal(calls[2].payload.ephemeral, true);
  assert.equal(calls[2].payload.skipHistory, true);
  assert.equal(calls[2].payload.model, "two");
  await feature.dispose();
  assert.equal(calls[3].payload.command, "clear");
  assert.equal(calls[3].id, 9);
  assert.equal(listeners.size, 0);
});

test("wrapper denies disabled feature and drops late responses after cancel or flag change", async () => {
  const { api, state, listeners } = fixture({ labFeatures: { ask: false } });
  const feature = createReadingFeatureApi(api, "ask");
  await assert.rejects(feature.translate("synthetic"), /source-disabled/);
  state.translatorSettings.labFeatures.ask = true;
  let finish;
  api.translate = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const request = feature.translate("synthetic");
  await tick();
  await feature.cancel();
  finish("late");
  await assert.rejects(request, /source-cancelled/);
  const other = feature.translate("synthetic");
  await tick();
  state.translatorSettings.labFeatures.ask = false;
  for (const fn of listeners) fn({ translatorSettings: {} }, "local");
  finish("late");
  await assert.rejects(other, /source-disabled/);
  await feature.dispose();
});

test("background rejects missing flags, unknown feature, unknown provider and invalid models", async () => {
  const disabled = worker();
  assert.equal(
    (await disabled.translate({ labFeature: "ask", siteUrl: "" }, sender)).ok,
    false
  );
  const w = worker({ settings: { labFeatures: flags } });
  for (const payload of [
    { labFeature: "corrections" },
    { labFeature: "unknown" },
    { labFeature: "ask", providerId: "missing" },
    ...[{}, "", "x".repeat(201), "x\ny"].map((model) => ({
      labFeature: "compare",
      model
    }))
  ])
    assert.equal(
      (await w.translate({ siteUrl: "", ...payload }, sender)).ok,
      false
    );
  assert.equal(w.calls.length, 0);
});

test("models are isolated per request, endpoint/config stay unchanged and nothing retained", async () => {
  const w = worker({
    settings: { labFeatures: flags, allowCloudFallback: true }
  });
  const original = structuredClone(w.state.translatorSettings);
  for (const model of ["model-a", "model-b"]) {
    assert.equal(
      (
        await w.translate(
          {
            siteUrl: "",
            labFeature: "compare",
            model,
            ephemeral: false,
            skipHistory: false,
            baseUrl: "https://evil.test",
            apiKey: "ignored"
          },
          sender
        )
      ).ok,
      true
    );
  }
  assert.deepEqual(
    w.calls.map((call) => JSON.parse(call[1].body).model),
    ["model-a", "model-b"]
  );
  assert.ok(
    w.calls.every((call) => call[0].startsWith("http://localhost:11434"))
  );
  assert.deepEqual(w.state.translatorSettings, original);
  assert.equal(w.state.translationCache, undefined);
  assert.equal(w.state.translatorSettings.translationHistory, undefined);
  const keyA = await w.context.translationCacheKey({
    text: "same",
    provider: { ...local, config: { ...local.config, model: "a" } },
    settings: {}
  });
  const keyB = await w.context.translationCacheKey({
    text: "same",
    provider: { ...local, config: { ...local.config, model: "b" } },
    settings: {}
  });
  assert.notEqual(keyA, keyB);
});

test("actual target tab privacy wins over claimed URL; pinned provider mismatch errors explicitly", async () => {
  const w = worker({
    settings: {
      labFeatures: flags,
      privacyRules: [
        { hostname: "work.test", mode: "local-only", providerId: "local" }
      ]
    }
  });
  w.context.chrome.tabs = {
    async get() {
      return { url: "https://work.test/article" };
    }
  };
  const spoofed = await w.translate(
    {
      labFeature: "compare",
      targetTabId: 9,
      siteUrl: "https://public.test",
      providerId: google.id
    },
    sender
  );
  assert.match(spoofed.error, /stale/);
  const mismatch = await w.translate(
    {
      labFeature: "compare",
      targetTabId: 9,
      siteUrl: "https://work.test/article",
      providerId: google.id
    },
    sender
  );
  assert.match(mismatch.error, /conflicts/);
  assert.equal(w.calls.length, 0);
  assert.equal(
    (
      await w.translate(
        {
          labFeature: "compare",
          targetTabId: 9,
          siteUrl: "https://work.test/article",
          providerId: "local",
          model: "alternate"
        },
        sender
      )
    ).ok,
    true
  );
  assert.equal(w.calls.length, 1);
});

test("feature instruction text and JSON remain exact; translation-only engines rejected; no cloud fallback", async () => {
  const raw = '{"answer":"<p>synthetic</p>","citations":["web-1"]}';
  const w = worker({
    settings: { labFeatures: flags, allowCloudFallback: true },
    fetch: async () => success(raw)
  });
  const input = "<p>synthetic input</p>";
  const response = await w.translate(
    {
      siteUrl: "",
      labFeature: "ask",
      text: input,
      task: "qa",
      customPrompt: "Return JSON"
    },
    sender
  );
  assert.equal(response.result.translation, raw);
  assert.ok(
    JSON.parse(w.calls[0][1].body).messages.some((message) =>
      message.content.includes(input)
    )
  );
  const denied = await w.translate(
    { siteUrl: "", labFeature: "ask", providerId: google.id, task: "qa" },
    sender
  );
  assert.match(denied.error, /instruction-capable/);
  const failing = worker({
    settings: { labFeatures: flags, allowCloudFallback: true },
    fetch: async () => {
      throw new Error("synthetic failure");
    }
  });
  assert.equal(
    (await failing.translate({ siteUrl: "", labFeature: "compare" }, sender))
      .ok,
    false
  );
  assert.equal(failing.calls.length, 1);
});

test("Ask policy requires trusted consent and feature disable suppresses pending output", async () => {
  const w = worker({
    settings: {
      labFeatures: flags,
      privacyDefaultMode: "ask",
      activeProviderId: google.id
    }
  });
  assert.equal(
    (await w.translate({ labFeature: "image", siteUrl: "" }, sender))
      .privacyBlocked,
    true
  );
  assert.equal(
    (
      await w.translate(
        { labFeature: "image", siteUrl: "", cloudConsent: true },
        sender
      )
    ).ok,
    true
  );
  let release;
  const pending = worker({
    settings: { labFeatures: flags },
    fetch: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  const result = pending.translate(
    { labFeature: "readalong", siteUrl: "" },
    sender
  );
  while (!release) await tick();
  pending.state.translatorSettings.labFeatures.readalong = false;
  release(success());
  assert.match((await result).error, /disabled/);
  assert.equal(pending.state.translationCache, undefined);
});

test("navigation during pending feature request drops results in wrapper and background", async () => {
  const { api } = fixture();
  const feature = createReadingFeatureApi(api, "compare");
  let release,
    target = { id: 9, url: "https://work.test/article" };
  api.activeTab = async () => target;
  api.translate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = feature.translate("synthetic");
  while (!release) await tick();
  target = { id: 9, url: "https://work.test/next" };
  release("late");
  await assert.rejects(pending, /source-stale/);
  await feature.dispose();
  let finish,
    url = "https://work.test/article";
  const w = worker({
    settings: { labFeatures: { compare: true } },
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  });
  w.context.chrome.tabs = {
    async get() {
      return { url };
    }
  };
  const request = w.translate(
    { labFeature: "compare", targetTabId: 9, siteUrl: url },
    sender
  );
  while (!finish) await tick();
  url = "https://work.test/next";
  finish(success());
  assert.match((await request).error, /stale/);
  assert.equal(w.state.translationCache, undefined);
});
