import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../extension/src/content-script.js", import.meta.url),
  "utf8"
);
const start = source.indexOf("  async function translateEditableSelection() {");
const end = source.indexOf(
  "  // Triggered from the extension context menu",
  start
);
assert.ok(start >= 0 && end > start);
const handler = source.slice(start, end);

async function translate(
  settings,
  { value = "Hello world", start = 0, end = 0, ok = true } = {}
) {
  let payload;
  const events = [];
  const field = {
    tagName: "TEXTAREA",
    value,
    selectionStart: start,
    selectionEnd: end,
    setRangeText(text, from, to) {
      this.value = this.value.slice(0, from) + text + this.value.slice(to);
    },
    dispatchEvent(event) {
      events.push(event.type);
    }
  };
  const context = vm.createContext({
    getActiveEditableElement: () => field,
    getSettings: async () => settings,
    showToast: () => {},
    i18n: { t: (key) => key },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    requestTranslation: async (request) => {
      payload = request;
      return { ok, result: { translation: "<b>Xin chào thế giới</b>" } };
    }
  });
  await vm.runInContext(`${handler}\ntranslateEditableSelection()`, context);
  return { payload, field, events };
}

test("fixed direction matches popup: target language to native language", async () => {
  const { payload, field, events } = await translate({
    nativeLanguageCode: "vi",
    targetLanguageCode: "en",
    useAutoDetect: false
  });
  assert.equal(payload.sourceLanguage, "en");
  assert.equal(payload.targetLanguage, "vi");
  assert.equal(payload.useAutoDetect, false);
  assert.equal(field.value, "Xin chào thế giới");
  assert.deepEqual(events, ["input"]);
});

test("fixed direction respects configured languages", async () => {
  const { payload } = await translate({
    nativeLanguageCode: "ja",
    targetLanguageCode: "fr",
    useAutoDetect: false
  });
  assert.equal(payload.sourceLanguage, "fr");
  assert.equal(payload.targetLanguage, "ja");
});

test("auto detect leaves source unspecified and uses the target language", async () => {
  const { payload } = await translate({
    nativeLanguageCode: "vi",
    targetLanguageCode: "ja",
    useAutoDetect: true
  });
  assert.equal(payload.sourceLanguage, undefined);
  assert.equal(payload.targetLanguage, "ja");
  assert.equal(payload.useAutoDetect, true);
});

test("missing languages use popup defaults", async () => {
  const { payload } = await translate({});
  assert.equal(payload.sourceLanguage, "en");
  assert.equal(payload.targetLanguage, "vi");
});

test("selection replacement preserves surrounding text", async () => {
  const { payload, field } = await translate(
    {},
    { value: "Before Hello world after", start: 7, end: 18 }
  );
  assert.equal(payload.text, "Hello world");
  assert.equal(field.value, "Before Xin chào thế giới after");
});

test("provider failure leaves the field unchanged", async () => {
  const { field, events } = await translate({}, { ok: false });
  assert.equal(field.value, "Hello world");
  assert.deepEqual(events, []);
});
