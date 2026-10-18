import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as engineExports from "../extension/src/experimental/readalong-engine.js";
import * as contextExports from "../extension/src/experimental/reading-context.js";

const sourceCode = readFileSync(
  new URL("../extension/src/experimental/readalong.js", import.meta.url),
  "utf8"
);
const flush = async () => {
  for (let i = 0; i < 6; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => {
      for (const fn of [...listeners]) fn(...args);
    }
  };
}
async function fixture(t, options = {}) {
  const dom = new JSDOM("<div id='panel'></div>", {
    url: "https://labs.test/#readalong",
    runScripts: "outside-only"
  });
  const { window: win } = dom;
  const calls = [],
    spoken = [],
    translations = [],
    saves = [];
  const storage = event();
  const settings = {
    enabled: true,
    labFeatures: { readalong: true, learning: true }
  };
  win.chrome = { storage: { onChanged: storage }, tabs: {} };
  win.speechSynthesis = {
    getVoices: () => [
      { localService: true, voiceURI: "local", name: "Offline", lang: "en" }
    ],
    speak: (utterance) => spoken.push(utterance),
    cancel: () => calls.push("speech-cancel"),
    addEventListener() {},
    removeEventListener() {}
  };
  win.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  const feature = {
    assertEnabled: async () => settings,
    clear: async () => calls.push("clear"),
    cancel: async () => calls.push("cancel"),
    dispose: async () => calls.push("dispose"),
    highlight: async () => {
      throw new Error("PDF must not enter website highlight bridge");
    },
    jump: async () => {
      throw new Error("PDF must not jump to website");
    },
    translate: async (text, opts) => {
      translations.push({ text, opts });
      return "Dịch local synthetic.";
    }
  };
  const pdf = {
    open: async (file) => {
      calls.push(["open", file.name]);
      return { documentId: "doc", title: "<script>PDF</script>", pages: 8 };
    },
    capturePage: async (page) => {
      calls.push(["page", page]);
      if (options.capturePage) return options.capturePage(page);
      if (!Number.isInteger(page) || page < 1 || page > 8)
        throw new Error("pdf-page");
      return {
        kind: "pdf",
        title: "<script>PDF</script>",
        page,
        url: "",
        lang: "en",
        documentId: "doc",
        snapshotId: "snapshot",
        blocks: [{ id: `pdf-p${page}`, text: "PDF first. PDF second." }]
      };
    },
    close: async () => calls.push("pdf-close"),
    destroy: async () => calls.push("pdf-destroy")
  };
  const context = dom.getInternalVMContext();
  const synthetic = (value) =>
    new vm.SyntheticModule(
      Object.keys(value),
      function () {
        for (const [key, item] of Object.entries(value))
          this.setExport(key, item);
      },
      { context }
    );
  const imports = new Map([
    ["./reading-context.js", synthetic(contextExports)],
    ["./readalong-engine.js", synthetic(engineExports)],
    ["./reading-documents.js", synthetic({ createReadingPdf: () => pdf })],
    [
      "./reading-feature-api.js",
      synthetic({ createReadingFeatureApi: () => feature })
    ]
  ]);
  const module = new vm.SourceTextModule(sourceCode, { context });
  await module.link((specifier) => {
    assert.ok(imports.has(specifier));
    return imports.get(specifier);
  });
  await module.evaluate();
  const panel = win.document.getElementById("panel");
  const api = {
    t: (en) => en,
    status() {},
    activeTab: async () => {
      throw new Error("No website tab should be used for local PDF");
    },
    send: async (type) => {
      calls.push(type);
    },
    saveVocabulary: async (value) => saves.push(value),
    field(label, element) {
      const wrapper = win.document.createElement("label"),
        text = win.document.createElement("span");
      text.textContent = label;
      wrapper.append(text, element);
      return wrapper;
    }
  };
  const cleanup = await module.namespace.mount(panel, api);
  const button = (label) =>
    [...panel.querySelectorAll("button")].find(
      (el) => el.textContent === label
    );
  const click = async (label) => {
    button(label).click();
    await flush();
  };
  const field = (label) =>
    [...panel.querySelectorAll("label")].find(
      (el) => el.firstChild.textContent === label
    ).lastChild;
  Object.defineProperty(field("Local PDF · text layer only"), "files", {
    value: [{ name: "synthetic.pdf" }]
  });
  t.after(() => {
    cleanup();
    dom.window.close();
  });
  return {
    panel,
    calls,
    spoken,
    translations,
    saves,
    storage,
    settings,
    button,
    click,
    field,
    cleanup
  };
}

test("PDF opens without extracting pages; only the explicitly chosen page enters preview and local speech", async (t) => {
  const h = await fixture(t);
  assert.deepEqual(h.calls, []);
  await h.click("Open local PDF");
  assert.equal(
    h.calls.filter((call) => Array.isArray(call) && call[0] === "page").length,
    0
  );
  assert.equal(h.panel.querySelectorAll("ol li").length, 0);
  h.field("PDF page").value = "4";
  await h.click("Preview chosen PDF page");
  assert.deepEqual(
    h.calls.find((call) => Array.isArray(call) && call[0] === "page"),
    ["page", 4]
  );
  assert.match(h.panel.textContent, /<script>PDF<\/script> · Page 4/);
  assert.equal(h.panel.querySelectorAll("script").length, 0);
  assert.equal(h.spoken.length, 0);
  await h.click("Play original");
  assert.equal(h.spoken[0].text, "PDF first.");
  assert.equal(h.translations.length, 0);
  h.spoken[0].onstart();
  h.spoken[0].onend();
  await flush();
  assert.equal(h.spoken[1].text, "PDF second.");
  await h.click("Translate this sentence");
  assert.equal(h.translations[0].opts.siteUrl, "");
  assert.equal(h.translations[0].text, "PDF second.");
  await h.click("Save sentence to vocabulary");
  assert.equal(h.saves[0].url, "");
  await h.click("Clear preview");
  assert.ok(h.calls.includes("pdf-close"));
  assert.equal(h.panel.querySelectorAll("ol li").length, 0);
  h.cleanup();
  assert.ok(h.calls.includes("pdf-destroy"));
});

test("PDF page selection errors do not read a different page or send provider requests", async (t) => {
  const h = await fixture(t);
  await h.click("Open local PDF");
  h.field("PDF page").value = "99";
  await h.click("Preview chosen PDF page");
  assert.match(h.panel.textContent, /pdf-page/);
  assert.equal(h.panel.querySelectorAll("ol li").length, 0);
  assert.equal(h.spoken.length, 0);
  assert.equal(h.translations.length, 0);
});

test("late PDF page results after Clear are dropped and flag-off closes the reader", async (t) => {
  let release;
  const h = await fixture(t, {
    capturePage: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  await h.click("Open local PDF");
  await h.click("Preview chosen PDF page");
  await h.click("Clear preview");
  release({
    kind: "pdf",
    title: "LATE",
    page: 1,
    blocks: [{ id: "late", text: "LATE PRIVATE PAGE" }]
  });
  await flush();
  assert.doesNotMatch(h.panel.textContent, /LATE PRIVATE PAGE/);
  h.settings.labFeatures.readalong = false;
  const previous = h.calls.filter((value) => value === "pdf-close").length;
  h.storage.emit({ translatorSettings: {} }, "local");
  await flush();
  assert.equal(
    h.calls.filter((value) => value === "pdf-close").length,
    previous + 1
  );
});
