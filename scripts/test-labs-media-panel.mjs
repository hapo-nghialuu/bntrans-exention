import assert from "node:assert/strict";
import test from "node:test";
import { mount } from "../extension/src/experimental/media.js";

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.value = "";
    this.checked = false;
    this.events = new Map();
    this.attributes = new Map();
  }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
      node.parent = this;
      if (this.tagName === "select" && !this.value) this.value = node.value;
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(key, value) {
    this.attributes.set(key, value);
  }
  removeAttribute(key) {
    this.attributes.delete(key);
  }
  addEventListener(type, callback) {
    this.events.set(type, callback);
  }
  removeEventListener(type, callback) {
    if (this.events.get(type) === callback) this.events.delete(type);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (node) => node !== this
      );
  }
  async dispatch(type) {
    await this.events.get(type)?.();
  }
}

const walk = (root) => [root, ...root.children.flatMap(walk)];
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
const srt =
  "one\n00:00:01,000 --> 00:00:03,000\nHello\n\ntwo\n00:00:04,000 --> 00:00:06,000\nWorld\n";

async function harness(t, { enabled = true, bridge } = {}) {
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => {
    globalThis.document = oldDocument;
  });
  const container = new Element("main");
  const translations = [];
  const sends = [];
  const saved = [];
  const downloads = [];
  const config = {
    labFeatures: { media: enabled, learning: true },
    targetLanguageCode: "en",
    nativeLanguageCode: "vi"
  };
  let tab = { id: 7, url: "https://www.youtube.com/watch?v=one" };
  const api = {
    t: (_en, vi) => vi,
    settings: async () => config,
    activeTab: async () => tab,
    button: (label, callback) => {
      const node = new Element("button");
      node.textContent = label;
      node.click = callback;
      return node;
    },
    field: (label, input) => {
      const node = new Element("label");
      node.textContent = label;
      node.append(input);
      return node;
    },
    sendToTab: async (type, payload) => {
      sends.push({ type, payload });
      return bridge
        ? bridge(type, payload)
        : {
            ok: true,
            active: payload.command === "start",
            videoId: "video-one",
            currentTime: payload.time || 2,
            cues: [],
            status: "captions-unavailable-enable-visible-captions"
          };
    },
    translate: async (text, options) => {
      translations.push({ text, options });
      return "Dịch " + text;
    },
    saveVocabulary: async (entry) => saved.push(entry),
    download: (...args) => downloads.push(args)
  };
  const cleanup = await mount(container, api);
  t.after(cleanup);
  return {
    container,
    config,
    translations,
    sends,
    saved,
    downloads,
    cleanup,
    all: () => walk(container),
    find: (predicate) => walk(container).find(predicate),
    button: (label) =>
      walk(container).find(
        (node) => node.tagName === "button" && node.textContent === label
      ),
    changeTab: () => {
      tab = { id: 8, url: "https://www.youtube.com/watch?v=two" };
    },
    async import(text = srt) {
      const file = walk(container).find((node) => node.type === "file");
      file.files = [
        { name: "synthetic.srt", size: text.length, text: async () => text }
      ];
      await file.dispatch("change");
    }
  };
}

test("panel mount is inert; import/preview/search/export/canonical vocabulary use actual cue data", async (t) => {
  const h = await harness(t);
  assert.equal(h.sends.length, 0);
  assert.equal(h.translations.length, 0);
  await h.import();
  assert.equal(
    h.find((node) => node.className === "lab-list").children.length,
    2
  );
  await h.button("Dịch 3 cue tiếp · xem thử").click();
  assert.equal(h.translations.length, 2);
  assert.equal(h.translations[0].options.skipHistory, true);
  assert.equal(
    h.translations[0].options.siteUrl,
    "https://www.youtube.com/watch?v=one"
  );
  await h.button("Lưu câu vào sổ từ").click();
  assert.deepEqual(h.saved[0], {
    text: "Hello",
    translation: "Dịch Hello",
    context: "Hello",
    url: "https://www.youtube.com/watch?v=one",
    sourceLanguage: "en",
    targetLanguage: "vi"
  });
  const search = h.find((node) => node.type === "search");
  search.value = "DỊCH WORLD";
  await search.dispatch("input");
  assert.equal(
    h.find((node) => node.className === "lab-list").children.length,
    1
  );
  await h.button("Xuất tệp").click();
  assert.equal(h.downloads[0][0], "synthetic.bilingual.srt");
  assert.match(h.downloads[0][1], /Hello\nDịch Hello/);
  h.cleanup();
  assert.equal(h.container.children.length, 0);
  assert.equal(search.events.size, 0);
});

test("manual actions require flag and missing provider/bridge does not fake success", async (t) => {
  const h = await harness(t, { enabled: false });
  await h.import();
  assert.equal(h.translations.length, 0);
  await assert.rejects(
    () => h.button("Bắt đầu tab đã chọn").click(),
    /Cần bật/
  );
  assert.equal(h.sends.length, 0);
  h.config.labFeatures.media = true;
  await assert.rejects(
    () => h.button("Dịch 3 cue tiếp · xem thử").click(),
    /nhập tệp/
  );
});

test("imported cues seek/replay exact timestamps and track playing cue without live caption start", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  await h.import();
  await h.button("0:01.000 – 0:03.000").click();
  assert.equal(h.sends.at(-1).payload.command, "seek");
  assert.equal(h.sends.at(-1).payload.time, 1);
  assert.equal(
    h
      .find((node) => node.className === "lab-list")
      .children[0].attributes.get("aria-current"),
    "true"
  );
  await h.button("Phát lại câu").click();
  assert.equal(h.sends.at(-1).payload.command, "replay");
  assert.equal(h.sends.at(-1).payload.options.end, 3);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(h.sends.at(-1).payload.command, "snapshot");
  assert.equal(
    h.sends.some((send) => send.payload.command === "start"),
    false
  );
});

test("Meet consent is consumed, selected-tab change clears transcript and stale responses", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t, {
    bridge: async (_type, payload) => ({
      ok: true,
      active: true,
      videoId: "meeting-one",
      status: "translating-visible-captions",
      cues:
        payload.command === "stop"
          ? []
          : [
              {
                id: "1",
                start: 1,
                end: 2,
                text: "Synthetic meeting",
                translation: "Họp giả lập"
              }
            ]
    })
  });
  const consent = h.find((node) => node.type === "checkbox");
  consent.checked = true;
  await h.button("Bắt đầu tab đã chọn").click();
  assert.equal(h.sends.at(-1).payload.options.meetingConsent, true);
  assert.equal(consent.checked, false);
  assert.equal(
    h.find((node) => node.className === "lab-list").children.length,
    1
  );
  h.changeTab();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(
    h.find((node) => node.className === "lab-list").children.length,
    0
  );
});

test("cleanup while start awaits bridge stops late session and never remounts", async (t) => {
  let resolve;
  const h = await harness(t, {
    bridge: (_type, payload) =>
      payload.command === "start"
        ? new Promise((r) => {
            resolve = r;
          })
        : { ok: true }
  });
  const starting = h.button("Bắt đầu tab đã chọn").click();
  await settle();
  h.cleanup();
  resolve({ ok: true, active: true, videoId: "one", cues: [] });
  await starting;
  assert.equal(h.sends.at(-1).payload.command, "stop");
  assert.equal(h.container.children.length, 0);
});

test("large transcripts render bounded pages rather than thousands of DOM nodes", async (t) => {
  const h = await harness(t);
  const contents = Array.from(
    { length: 121 },
    (_, index) => `${index + 1}\n00:00:01,000 --> 00:00:02,000\nCue ${index}`
  ).join("\n\n");
  await h.import(contents);
  assert.equal(
    h.find((node) => node.className === "lab-list").children.length,
    60
  );
  await h.button("60 câu tiếp").click();
  assert.equal(
    h.find((node) => node.className === "lab-list").children.length,
    60
  );
  await h.button("60 câu tiếp").click();
  assert.equal(
    h.find((node) => node.className === "lab-list").children.length,
    1
  );
});

test("canonical vocabulary requires learning opt-in and never silently truncates long cues", async (t) => {
  const h = await harness(t);
  await h.import();
  h.config.labFeatures.learning = false;
  await assert.rejects(
    () => h.button("Lưu câu vào sổ từ").click(),
    /Vocabulary Labs/
  );
  assert.equal(h.saved.length, 0);
  h.config.labFeatures.learning = true;
  await h.import(`1\n00:00:01,000 --> 00:00:02,000\n${"x".repeat(501)}\n`);
  await assert.rejects(() => h.button("Lưu câu vào sổ từ").click(), /500/);
  assert.equal(h.saved.length, 0);
});
