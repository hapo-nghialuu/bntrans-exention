import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../extension/src/popup.js", import.meta.url),
  "utf8"
);
const start = source.indexOf("async function loadSettings() {");
const end = source.indexOf("async function runQuickTranslate()", start);
assert.ok(start >= 0 && end > start);

async function load(settings) {
  const quickSource = { value: "" };
  const quickTarget = { value: "" };
  let populated = false;
  const context = vm.createContext({
    chrome: {
      storage: {
        local: {
          get: async (key) => {
            assert.equal(key, "translatorSettings");
            return { translatorSettings: settings };
          }
        }
      },
      runtime: {
        sendMessage() {
          throw new Error("Service worker unavailable");
        }
      }
    },
    quickSource,
    quickTarget,
    activeProviderId: "google-translate",
    applyTheme() {},
    i18n: { setLanguage() {} },
    populateLangs() {
      populated = true;
    },
    translateUI() {},
    console: {
      error(...args) {
        throw new Error(args.join(" "));
      }
    }
  });
  await vm.runInContext(`${source.slice(start, end)}\nloadSettings()`, context);
  return {
    source: quickSource.value,
    target: quickTarget.value,
    provider: context.activeProviderId,
    populated
  };
}

test("fresh popup initializes defaults without a running service worker", async () => {
  assert.deepEqual(await load(undefined), {
    source: "en",
    target: "vi",
    provider: "google-translate",
    populated: true
  });
});

test("popup loads saved picks and provider directly from local storage", async () => {
  assert.deepEqual(
    await load({
      selectionLastSource: "ja",
      selectionLastTarget: "fr",
      activeProviderId: "builtin"
    }),
    { source: "ja", target: "fr", provider: "builtin", populated: true }
  );
});

test("auto-detect popup defaults use the configured target language", async () => {
  const settings = await load({
    useAutoDetect: true,
    targetLanguageCode: "fr"
  });
  assert.equal(settings.source, "auto");
  assert.equal(settings.target, "fr");
});
