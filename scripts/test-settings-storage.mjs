import assert from "node:assert/strict";
import test from "node:test";
import {
  readSettings,
  writeSettings
} from "../extension/src/common/settings-storage.js";

test("settings defaults and storage work without service-worker messages", async () => {
  let stored;
  globalThis.chrome = {
    runtime: {
      sendMessage() {
        throw new Error("Service worker must not be required");
      }
    },
    storage: {
      local: {
        async get(key) {
          assert.equal(key, "translatorSettings");
          return { translatorSettings: structuredClone(stored) };
        },
        async set(value) {
          stored = structuredClone(value.translatorSettings);
        }
      }
    }
  };
  const defaults = await readSettings();
  assert.equal(defaults.activeProviderId, "google-translate");
  assert.equal(defaults.nativeLanguageCode, "vi");
  assert.equal(defaults.targetLanguageCode, "en");
  assert.equal(defaults.hoverToggleShortcut.key, "O");
  assert.ok(defaults.providers.some((p) => p.id === "google-translate"));
  assert.ok(defaults.providers.some((p) => p.id === "builtin"));
  assert.deepEqual(defaults.labFeatures, {
    corrections: false,
    ask: false,
    image: false,
    compare: false,
    readalong: false,
    learning: false,
    writing: false,
    media: false,
    documents: false,
    ocr: false,
    privacy: false,
    page: false
  });

  await writeSettings({ theme: "dark", selectionLastTarget: "fr" });
  assert.equal(stored.theme, "dark");
  assert.equal(stored.activeProviderId, "google-translate");
  await writeSettings({ theme: "light" });
  assert.equal(stored.theme, "light");
  assert.equal(stored.selectionLastTarget, "fr");
  assert.deepEqual(await readSettings(), stored);

  stored = { labFeatures: { writing: true }, activeProviderId: "builtin" };
  const readingDefaults = {
    corrections: false,
    ask: false,
    image: false,
    compare: false,
    readalong: false
  };
  assert.deepEqual((await readSettings()).labFeatures, {
    ...readingDefaults,
    writing: true
  });
  await writeSettings({ labFeatures: { privacy: true } });
  assert.deepEqual(stored.labFeatures, {
    ...readingDefaults,
    writing: true,
    privacy: true
  });
  assert.equal(stored.activeProviderId, "builtin");

  stored = null;
  assert.deepEqual(await readSettings(), defaults);
  delete globalThis.chrome;
});
