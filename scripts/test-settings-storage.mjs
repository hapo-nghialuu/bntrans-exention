import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
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
  assert.deepEqual((await readSettings()).labFeatures, { writing: true });
  await writeSettings({ labFeatures: { privacy: true } });
  assert.deepEqual(stored.labFeatures, { writing: true, privacy: true });
  assert.equal(stored.activeProviderId, "builtin");

  stored = null;
  assert.deepEqual(await readSettings(), defaults);
  delete globalThis.chrome;
});

const options = readFileSync(
  new URL("../extension/src/options.js", import.meta.url),
  "utf8"
);
const markup = readFileSync(
  new URL("../extension/pages/options.html", import.meta.url),
  "utf8"
);

async function optionsHarness(t, set) {
  const dom = new JSDOM(markup);
  const previous = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previous;
    dom.window.close();
  });
  globalThis.chrome = { storage: { local: { get: async () => ({}) } } };
  let stored = {
    ...(await readSettings()),
    websiteProfiles: [{ hostname: "example.test", targetLanguage: "fr" }],
    labFeatures: { learning: true, privacy: true },
    privacyDefaultMode: "ask",
    providers: [
      { id: "google-translate", type: "google-translate", name: "Google" },
      {
        id: "fixture",
        type: "custom",
        name: "Controlled fixture",
        config: { baseUrl: "http://localhost:8765/v1", model: "test" }
      }
    ]
  };
  const chrome = {
    runtime: {
      sendMessage() {
        throw new Error("Service worker unavailable");
      }
    },
    storage: {
      local: {
        get: async () => ({ translatorSettings: structuredClone(stored) }),
        set: async (value) => {
          await set?.();
          stored = structuredClone(value.translatorSettings);
        }
      }
    }
  };
  globalThis.chrome = chrome;
  const context = vm.createContext({
    document: dom.window.document,
    chrome,
    writeSettings,
    initial: stored,
    setTimeout: () => 1,
    clearTimeout() {},
    i18n: { language: "en", t: (key) => key },
    setNavBadge() {},
    shotModelEffective: () => ""
  });
  const section = (start, end) =>
    options.slice(
      options.indexOf(start),
      options.indexOf(end, options.indexOf(start))
    );
  vm.runInContext(
    section("const enabledCheckbox", "const LANGUAGES") +
      section("function escapeSettingsText(", "function renderDomains(") +
      section("function renderProviderList(", "function getProviderInfo(") +
      section(
        "async function saveSettings(",
        'addAliasBtn.addEventListener("click"'
      ) +
      `
      providers = initial.providers;
      activeProviderId = initial.activeProviderId;
      enabledCheckbox.checked = true;
      nativeSelect.innerHTML = '<option value="vi">Vietnamese</option>';
      targetSelect.innerHTML = '<option value="en">English</option><option value="fr">French</option>';
      savedTargetLanguageCode = 'en';
      renderProviderList();
      `,
    context
  );
  return {
    context,
    doc: dom.window.document,
    stored: () => stored,
    settle: () => new Promise((resolve) => setImmediate(resolve))
  };
}

test("Options Use persists provider without service worker and preserves unrelated settings", async (t) => {
  const h = await optionsHarness(t);
  const before = structuredClone(h.stored());
  h.doc.querySelector('.btn-set-active[data-id="fixture"]').click();
  await h.settle();
  assert.equal(h.stored().activeProviderId, "fixture");
  assert.equal((await readSettings()).activeProviderId, "fixture");
  assert.equal(
    h.doc.querySelector(".bt-provider-item.active .bt-provider-name")
      .textContent,
    "Controlled fixture"
  );
  assert.deepEqual(h.stored().websiteProfiles, before.websiteProfiles);
  assert.deepEqual(h.stored().labFeatures, before.labFeatures);
  assert.equal(h.stored().privacyDefaultMode, "ask");
  assert.deepEqual(h.stored().providers, before.providers);
  h.doc.querySelector("#target").value = "fr";
  assert.equal(await h.context.saveSettings(), true);
  assert.equal(h.stored().selectionLastTarget, "fr");
});

test("Options does not claim Active until provider is persisted", async (t) => {
  let finish;
  const h = await optionsHarness(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const button = h.doc.querySelector('.btn-set-active[data-id="fixture"]');
  button.click();
  await h.settle();
  assert.equal(button.disabled, true);
  assert.equal(
    h.doc.querySelector(".bt-provider-item.active .bt-provider-name")
      .textContent,
    "Google"
  );
  assert.equal(h.stored().activeProviderId, "google-translate");
  finish();
  await h.settle();
  assert.equal(h.stored().activeProviderId, "fixture");
  assert.equal(
    h.doc.querySelector(".bt-provider-item.active .bt-provider-name")
      .textContent,
    "Controlled fixture"
  );
});

test("Options restores previous Active provider and shows save failure", async (t) => {
  const h = await optionsHarness(t, () => {
    throw new Error("Storage failed");
  });
  h.doc.querySelector('.btn-set-active[data-id="fixture"]').click();
  await h.settle();
  assert.equal(h.stored().activeProviderId, "google-translate");
  assert.equal(
    h.doc.querySelector(".bt-provider-item.active .bt-provider-name")
      .textContent,
    "Google"
  );
  assert.match(h.doc.querySelector("#save-status").textContent, /not saved/);
  assert.equal(
    h.doc.querySelector('.btn-set-active[data-id="fixture"]').disabled,
    false
  );
});
