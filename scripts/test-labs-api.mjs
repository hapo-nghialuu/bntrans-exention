import assert from "node:assert/strict";
import test from "node:test";
import {
  createLabApi,
  matchesHostname
} from "../extension/src/experimental/lab-api.js";

function fixture(settings = {}) {
  const calls = [];
  const stored = {
    translatorSettings: {
      activeProviderId: "local",
      nativeLanguageCode: "vi",
      providers: [{ id: "local", name: "Test local" }],
      ...settings
    }
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: stored[key] };
        },
        async set(next) {
          Object.assign(stored, next);
        }
      }
    },
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        if (message.type === "set-settings") {
          Object.assign(stored.translatorSettings, message.settings);
          return { ok: true, settings: stored.translatorSettings };
        }
        return { ok: true, result: { translation: "TEST RESULT" } };
      }
    },
    tabs: {
      async get(id) {
        return { id, url: "https://work.example.com/page" };
      },
      async query() {
        return [
          { id: 1, url: "chrome://settings" },
          { id: 2, url: "https://example.com", lastAccessed: 1 },
          { id: 3, url: "file:///notes.html", lastAccessed: 2 }
        ];
      },
      async sendMessage(id, message, options) {
        calls.push({ id, message, options });
        return { ok: true };
      }
    }
  };
  return {
    api: createLabApi({ language: "vi", selectedTab: () => 42 }),
    calls,
    stored
  };
}

test("hostname rules match subdomain boundaries, not suffix/lookalike URLs", () => {
  assert.equal(matchesHostname("work.example.com", "example.com"), true);
  assert.equal(matchesHostname("EXAMPLE.COM.", "example.com"), true);
  assert.equal(matchesHostname("notexample.com", "example.com"), false);
  assert.equal(matchesHostname("example.com.evil.test", "example.com"), false);
  assert.equal(matchesHostname("example.com", ""), false);
});

test("settings updates preserve legacy settings field expected by worker", async () => {
  const { api, calls } = fixture();
  const result = await api.updateSettings({ labFeatures: { page: true } });
  assert.equal(result.labFeatures.page, true);
  assert.deepEqual(calls[0].settings, { labFeatures: { page: true } });
});

test("tab actions are explicit and top-frame only", async () => {
  const { api, calls } = fixture();
  await api.sendToTab("labs-page-command", { command: "restore" });
  assert.deepEqual(calls[0], {
    id: 42,
    message: { type: "labs-page-command", payload: { command: "restore" } },
    options: { frameId: 0 }
  });
  assert.deepEqual(
    (await api.tabs()).map((tab) => tab.id),
    [3, 2]
  );
});

test("no target is not silently replaced by another tab", async () => {
  fixture();
  const api = createLabApi();
  await assert.rejects(api.activeTab(), /Choose/);
});

test("translation forwards task and tightens local-only; history defaults off", async () => {
  const { api, calls } = fixture();
  assert.equal(
    await api.translate("public fixture", {
      task: "rewrite",
      privacyPolicy: "local-only",
      targetLanguage: "same"
    }),
    "TEST RESULT"
  );
  assert.equal(calls[0].payload.task, "rewrite");
  assert.equal(calls[0].payload.privacyPolicy, "local-only");
  assert.equal(calls[0].payload.skipHistory, true);
  assert.equal(calls[0].payload.siteUrl, "https://work.example.com/page");
});

test("ask consent rejection never dispatches translation", async () => {
  const { api, calls } = fixture({ privacyDefaultMode: "ask" });
  globalThis.window = { confirm: () => false };
  await assert.rejects(api.translate("public fixture"), /hủy/);
  assert.equal(calls.length, 0);
});

test("ask consent is per request, not silently reused for later text", async () => {
  const { api, calls } = fixture({ privacyDefaultMode: "ask" });
  let prompts = 0;
  globalThis.window = { confirm: () => ++prompts === 1 };
  await api.translate("first public fixture");
  await assert.rejects(api.translate("second public fixture"), /hủy/);
  assert.equal(prompts, 2);
  assert.equal(calls.length, 1);
});

test("most-specific matching privacy rule is selected", async () => {
  const { api, calls } = fixture({
    privacyRules: [
      { hostname: "example.com", mode: "cloud" },
      { hostname: "work.example.com", mode: "local-only" }
    ]
  });
  await api.translate("public fixture");
  assert.equal(calls[0].payload.privacyPolicy, "local-only");
});

test("local experiment storage is namespaced and not synced", async () => {
  const { api, stored } = fixture();
  await api.set("draft", "test");
  assert.equal(stored["bntransLabs:draft"], "test");
  assert.equal(await api.get("draft"), "test");
  assert.equal(await api.get("absent", "fallback"), "fallback");
});
