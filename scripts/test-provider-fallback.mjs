import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../extension/src/background.js", import.meta.url),
  "utf8"
);
const start = source.indexOf("const OFFSCREEN_URL");
const end = source.indexOf("// --- Context menus", start);
assert.ok(start >= 0 && end > start);

async function translate({
  offscreen = { ok: false, error: "Translator API not supported" },
  fallbackFails = false,
  providerType = "gemini-nano",
  setupFails = false
} = {}) {
  let listener;
  const calls = [];
  const providers = [
    { id: "builtin", type: "gemini-nano", name: "Chrome Built-in AI" },
    {
      id: "google-translate",
      type: "google-translate",
      name: "Google Translate"
    }
  ];
  const settings = {
    providers,
    activeProviderId:
      providerType === "google-translate" ? "google-translate" : "builtin"
  };
  const context = vm.createContext({
    console: { error() {} },
    AIProviderService: class {
      constructor(settings) {
        this.activeProvider = settings.providers.find(
          (p) => p.id === settings.activeProviderId
        );
      }
      async translate() {
        calls.push(this.activeProvider.id);
        if (this.activeProvider.type === "google-translate") {
          if (fallbackFails) throw new Error("Google unavailable");
          return { translation: "Xin chào", providerName: "Google Translate" };
        }
        return { useOffscreen: true };
      }
    },
    shouldConvertFormat: () => false,
    chrome: {
      storage: {
        local: {
          get: async () => ({ translatorSettings: settings }),
          set: async () => {}
        }
      },
      runtime: {
        getURL: () => "chrome-extension://test/pages/offscreen.html",
        getContexts: async () => {
          if (setupFails) throw new Error("Offscreen unavailable");
          return [
            {
              contextType: "OFFSCREEN_DOCUMENT",
              documentUrl: "chrome-extension://test/pages/offscreen.html"
            }
          ];
        },
        sendMessage: async () => offscreen,
        onMessage: {
          addListener(fn) {
            listener = fn;
          }
        }
      }
    }
  });
  vm.runInContext(source.slice(start, end), context);
  const response = await new Promise((resolve) => {
    listener(
      {
        type: "translate",
        payload: {
          text: "Hello",
          sourceLanguage: "en",
          targetLanguage: "vi",
          skipHistory: true
        }
      },
      {},
      resolve
    );
  });
  return { response, calls };
}

test(
  "unsupported Built-in AI retries through Google",
  { timeout: 1000 },
  async () => {
    const { response, calls } = await translate();
    assert.equal(response.ok, true);
    assert.equal(response.result.translation, "Xin chào");
    assert.equal(response.result.providerName, "Google Translate (fallback)");
    assert.equal(response.result.fellBackFrom, "Chrome Built-in AI");
    assert.deepEqual(calls, ["builtin", "google-translate"]);
  }
);

test(
  "successful offscreen translation does not use fallback",
  { timeout: 1000 },
  async () => {
    const { response, calls } = await translate({
      offscreen: { ok: true, translation: "Xin chào" }
    });
    assert.equal(response.ok, true);
    assert.equal(response.result.translation, "Xin chào");
    assert.deepEqual(calls, ["builtin"]);
  }
);

test(
  "empty offscreen response also falls back",
  { timeout: 1000 },
  async () => {
    const { response } = await translate({ offscreen: null });
    assert.equal(response.ok, true);
    assert.equal(response.result.providerName, "Google Translate (fallback)");
  }
);

test("offscreen setup failure falls back", { timeout: 1000 }, async () => {
  const { response } = await translate({ setupFails: true });
  assert.equal(response.ok, true);
});

test(
  "fallback failure preserves the original provider error",
  { timeout: 1000 },
  async () => {
    const { response, calls } = await translate({ fallbackFails: true });
    assert.equal(response.ok, false);
    assert.equal(response.error, "Translator API not supported");
    assert.deepEqual(calls, ["builtin", "google-translate"]);
  }
);

test(
  "Google failures do not retry Google recursively",
  { timeout: 1000 },
  async () => {
    const { response, calls } = await translate({
      providerType: "google-translate",
      fallbackFails: true
    });
    assert.equal(response.ok, false);
    assert.equal(response.error, "Google unavailable");
    assert.deepEqual(calls, ["google-translate"]);
  }
);
