import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../extension/src/content-script.js", import.meta.url),
  "utf8"
);
const start = source.indexOf("function registerDualSubtitles() {");
const end = source.indexOf("function registerInstantMode()", start);
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness({ enabled = true, translate } = {}) {
  let observer;
  let listener;
  let pagehide;
  let config = {
    dualSubtitlesEnabled: enabled,
    nativeLanguageCode: "vi",
    targetLanguageCode: "en"
  };
  const requests = [];
  const segment = {
    nodeType: 1,
    isConnected: true,
    childNodes: [{ nodeType: 3, textContent: "Hello" }],
    matches: (selector) => selector === ".ytp-caption-segment",
    closest: (selector) =>
      selector === ".ytp-caption-segment" ? segment : null,
    querySelectorAll: () =>
      segment.childNodes.filter((node) => node.nodeType === 1),
    appendChild: (node) => {
      node.parentElement = segment;
      segment.childNodes.push(node);
    }
  };
  const body = { nodeType: 1, querySelectorAll: () => [segment] };
  const ctx = vm.createContext({
    location: {
      hostname: "www.youtube.com",
      href: "https://www.youtube.com/watch?v=test"
    },
    window: {
      addEventListener: (_type, fn) => {
        pagehide = fn;
      }
    },
    document: {
      body,
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => segment.querySelectorAll(),
      createElement() {
        return {
          nodeType: 1,
          style: {},
          classList: { contains: (name) => name === "bntrans-sub-translation" },
          remove() {
            segment.childNodes = segment.childNodes.filter(
              (node) => node !== this
            );
          }
        };
      }
    },
    chrome: {
      storage: {
        onChanged: {
          addListener: (fn) => {
            listener = fn;
          },
          removeListener: () => {
            listener = null;
          }
        }
      }
    },
    getSettings: async () => config,
    requestTranslation: async (payload) => {
      requests.push(payload);
      return translate
        ? translate(payload)
        : {
            ok: true,
            result: {
              translation: `Translated:${payload.text}:${payload.targetLanguage}`
            }
          };
    },
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn;
        observer = this;
      }
      observe() {
        this.active = true;
      }
      disconnect() {
        this.active = false;
      }
    }
  });
  vm.runInContext(source.slice(start, end) + "\nregisterDualSubtitles();", ctx);
  return {
    requests,
    segment,
    get observer() {
      return observer;
    },
    get translations() {
      return segment.querySelectorAll().map((node) => node.textContent);
    },
    async settings(patch) {
      config = { ...config, ...patch };
      listener({ translatorSettings: { newValue: config } }, "local");
      await settle();
    },
    async text(text, type = "childList") {
      segment.childNodes = [
        { nodeType: 3, textContent: text, parentElement: segment }
      ];
      if (observer?.active)
        observer.fn([
          {
            type,
            target: type === "childList" ? segment : segment.childNodes[0],
            addedNodes: [segment.childNodes[0]]
          }
        ]);
      await settle();
    },
    async ownMutation() {
      observer.fn([
        {
          type: "childList",
          target: segment,
          addedNodes: segment.querySelectorAll()
        }
      ]);
      await settle();
    },
    pagehide: () => pagehide()
  };
}

test("ML-02 on→off removes observer/overlay; off→on resumes without reload", async () => {
  const h = harness();
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.translations.length, 1);
  await h.settings({ dualSubtitlesEnabled: false });
  assert.equal(h.observer.active, false);
  assert.equal(h.translations.length, 0);
  await h.text("Disabled new cue");
  assert.equal(h.requests.length, 1);
  await h.settings({ dualSubtitlesEnabled: true });
  assert.equal(h.requests.length, 2);
  assert.equal(h.translations.length, 1);
  assert.equal(h.observer.active, true);
});

test("ML-02 initially off can be enabled; language change refreshes same cue", async () => {
  const h = harness({ enabled: false });
  await settle();
  assert.equal(h.observer, undefined);
  await h.settings({ dualSubtitlesEnabled: true });
  await h.settings({ nativeLanguageCode: "ja", targetLanguageCode: "fr" });
  assert.equal(h.requests.at(-1).targetLanguage, "ja");
  assert.equal(h.requests.at(-1).sourceLanguage, "fr");
  assert.deepEqual(h.translations, ["Translated:Hello:ja"]);
});

test("ML-02 delayed response after opt-out/language change cannot render", async () => {
  const pending = [];
  const h = harness({
    translate: () => new Promise((resolve) => pending.push(resolve))
  });
  await settle();
  await h.settings({ nativeLanguageCode: "ja" });
  pending[0]({ ok: true, result: { translation: "OLD VI" } });
  await settle();
  assert.equal(h.translations.length, 0);
  await h.settings({ dualSubtitlesEnabled: false });
  pending[1]({ ok: true, result: { translation: "LATE JA" } });
  await settle();
  assert.equal(h.translations.length, 0);
});

test("ML-03 childList added Text and characterData both translate current source; own mutations dedupe", async () => {
  const h = harness();
  await settle();
  await h.text("New Text node", "childList");
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].text, "New Text node");
  assert.deepEqual(h.translations, ["Translated:New Text node:vi"]);
  await h.ownMutation();
  assert.equal(h.requests.length, 2);
  await h.text("New character data", "characterData");
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.translations, ["Translated:New character data:vi"]);
  h.pagehide();
  assert.equal(h.observer.active, false);
  assert.equal(h.translations.length, 0);
});
