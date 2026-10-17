import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  worker,
  google,
  builtin,
  success
} from "./test-labs-provider-harness.mjs";

async function translate({
  offscreen = { ok: false, error: "Translator API not supported" },
  fallbackFails = false,
  providerType = "gemini-nano",
  setupFails = false,
  allowCloudFallback = true
} = {}) {
  const w = worker({
    settings: {
      providers: [builtin, google],
      activeProviderId:
        providerType === "google-translate" ? google.id : builtin.id,
      allowCloudFallback
    },
    offscreen,
    setupFails,
    fetch: async () => {
      if (fallbackFails) throw new Error("Google unavailable");
      return success("Xin chào");
    }
  });
  const calls = [];
  w.context.providerCalls = calls;
  vm.runInContext(
    `const originalTranslate = AIProviderService.prototype.translate;
    AIProviderService.prototype.translate = function(...args) { providerCalls.push(args[3] || this.activeProviderId); return originalTranslate.apply(this, args); };`,
    w.context
  );
  return {
    response: await w.translate({ text: "Hello", skipHistory: true }),
    calls
  };
}

test(
  "unsupported Built-in AI retries through Google only with explicit opt-in",
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

test("Built-in failures are fail-closed without explicit cloud fallback opt-in", async () => {
  const { response, calls } = await translate({ allowCloudFallback: false });
  assert.equal(response.ok, false);
  assert.deepEqual(calls, ["builtin"]);
});
