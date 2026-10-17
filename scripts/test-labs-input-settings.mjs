import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { prepareSettingsImport } from "../extension/src/common/settings-backup.js";

const options = readFileSync(
  new URL("../extension/src/options.js", import.meta.url),
  "utf8"
);
const content = readFileSync(
  new URL("../extension/src/content-script.js", import.meta.url),
  "utf8"
);

class Element {
  constructor(tag = "div", text = "") {
    this.tagName = tag.toUpperCase();
    this.nodeType = tag === "#text" ? 3 : 1;
    this.childNodes = [];
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.textContent = text;
  }
  set textContent(text) {
    this.text = String(text);
    this.childNodes = [];
  }
  get textContent() {
    return (
      this.text + this.childNodes.map((child) => child.textContent).join("")
    );
  }
  set innerHTML(value) {
    assert.equal(
      value,
      "",
      "arbitrary text must never reach a rendered HTML sink"
    );
    this.replaceChildren();
  }
  append(...children) {
    this.childNodes.push(...children);
  }
  appendChild(child) {
    this.append(child);
    return child;
  }
  replaceChildren(...children) {
    this.text = "";
    this.childNodes = children;
  }
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  getAttribute(key) {
    return this.attributes?.[key] ?? null;
  }
}

const document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => new Element("#text", text),
  createDocumentFragment: () => new Element("fragment")
};

for (const payload of [
  { translationHistory: {} },
  { translationHistory: [null] },
  { translationHistory: [{ text: "test", translation: {} }] },
  { translationHistory: [{ text: "test", translation: "ok", ts: "wrong" }] },
  { instantDomains: ["example.test"] },
  { autoTranslateDomains: [{ domain: "example.test", enabled: "yes" }] },
  { hoverTranslateDomains: {} },
  { aliases: [] },
  { glossary: { word: {} } },
  { instantToggleShortcut: { key: 1 } },
  { hoverToggleShortcut: { key: "I", ctrl: "yes" } },
  { hoverInjectStyle: { textColor: {} } },
  { providers: [{ id: "p", config: { model: {} } }] },
  { ttsProviders: [{ id: "t", url: [] }] },
  { enabled: "true" },
  { instantDelay: "3000" },
  { schemaVersion: 2 },
  { labFeatures: { learning: "true" } }
]) {
  test(`invalid import is rejected atomically: ${JSON.stringify(payload)}`, async () => {
    let change;
    const writes = [],
      statuses = [];
    const existing = { theme: "dark", translationHistory: [] };
    const context = vm.createContext({
      importFileInput: {
        addEventListener: (_event, listener) => {
          change = listener;
        }
      },
      readSettings: async () => existing,
      writeSettings: async (data) => writes.push(data),
      prepareSettingsImport,
      flashSaveStatus: (key) => statuses.push(key),
      loadSettings: () => {
        throw new Error("invalid import must not reload");
      }
    });
    const start = options.indexOf('importFileInput?.addEventListener("change"');
    const end = options.indexOf(
      "// ============================================",
      start
    );
    vm.runInContext(options.slice(start, end), context);
    await change({
      target: { files: [{ text: async () => JSON.stringify(payload) }] }
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(statuses, ["popup.importInvalid"]);
    assert.deepEqual(existing, { theme: "dark", translationHistory: [] });
  });
}

test("valid history, domains, maps, shortcuts and opt-ins survive import", () => {
  const settings = {
    schemaVersion: 1,
    translationHistory: [
      { text: "<strong>literal</strong>", translation: "<em>text</em>", ts: 1 }
    ],
    aliases: { e: "en" },
    glossary: { a: "b" },
    instantDomains: [
      { domain: "example.test", position: "top", enabled: false }
    ],
    autoTranslateDomains: [],
    hoverTranslateDomains: [],
    screenshotShortcut: { key: "S", ctrl: true, shift: true, alt: false },
    labFeatures: { learning: false }
  };
  assert.deepEqual(prepareSettingsImport(settings), settings);
});

test("alias/glossary text and data-key are literal, with local delete listener", () => {
  const list = new Element();
  const key = '<em>BirdNion</em>" example';
  let removed;
  const context = vm.createContext({
    document,
    list,
    values: { [key]: "<strong>literal</strong>" },
    onRemove: (value) => {
      removed = value;
    }
  });
  vm.runInContext(
    options.slice(
      options.indexOf("function renderTextMap("),
      options.indexOf("function renderAliases(")
    ),
    context
  );
  vm.runInContext('renderTextMap(list, values, "remove", onRemove)', context);
  const item = list.childNodes[0];
  const [label, button] = item.childNodes;
  assert.equal(label.textContent, `${key} → <strong>literal</strong>`);
  assert.equal(button.dataset.key, key);
  button.listeners.click();
  assert.equal(removed, key);
});

test("history renderer tolerates already-corrupt stored values", () => {
  for (const history of [
    { unexpected: true },
    null,
    [null, "wrong", { text: "x" }],
    [{ text: "x", translation: "y", ts: { toString: "invalid" } }],
    [{ text: "x", translation: "y", providerName: { toString: "invalid" } }]
  ]) {
    const list = new Element();
    const context = vm.createContext({
      document,
      historyListEl: list,
      historyEmptyEl: {},
      setNavBadge() {},
      history
    });
    const start = options.indexOf("function renderHistory(");
    vm.runInContext(
      options.slice(start, options.indexOf("clearHistoryBtn?.", start)),
      context
    );
    vm.runInContext("renderHistory(history)", context);
    assert.equal(list.childNodes.length, 0);
  }
});

test("imported provider form values are escaped in HTML attributes", () => {
  const parts = [];
  const config = {
    model: '<em>model</em>"',
    apiKey: 'synthetic" <strong>key</strong>',
    baseUrl: 'http://example.test/?q="<em>literal</em>'
  };
  const context = vm.createContext({
    config,
    formDynamicFields: {
      set innerHTML(value) {
        parts.push(value);
      },
      insertAdjacentHTML(_where, value) {
        parts.push(value);
      }
    },
    document: { querySelector: () => null },
    getProviderInfo: () => null,
    loadModelsIntoDatalist() {},
    i18n: { t: () => "label" }
  });
  const escapeStart = options.indexOf("function escapeSettingsText(");
  vm.runInContext(
    options.slice(
      escapeStart,
      options.indexOf("function renderDomains(", escapeStart)
    ),
    context
  );
  vm.runInContext(
    options.slice(
      options.indexOf("function modelFieldHtml("),
      options.indexOf("function openProviderForm(")
    ),
    context
  );
  vm.runInContext('renderFormFields("openai", config)', context);
  const markup = parts.join("");
  for (const value of Object.values(config)) assert.ok(!markup.includes(value));
  assert.ok(
    markup.includes("synthetic&quot; &lt;strong&gt;key&lt;/strong&gt;")
  );
  assert.ok(markup.includes("&lt;em&gt;model&lt;/em&gt;&quot;"));
});

test("hover formatter copies only formatting tags and safe absolute links", () => {
  const text = (value) => document.createTextNode(value);
  const node = (tag, children = [], attributes = {}) => {
    const element = new Element(tag);
    element.append(...children);
    element.attributes = attributes;
    return element;
  };
  const input = [
    node("strong", [text("formatted")], { onclick: "unused" }),
    node("script", [text("blocked inert fixture")]),
    node("img", [], { src: "https://example.test/unused.png" }),
    ...[
      "javascript:unused",
      "data:text/plain,unused",
      "//example.test",
      "https://user:pass@example.test",
      "https://example.test/docs",
      "http://example.test/docs"
    ].map((href) => node("a", [text("link")], { href, onclick: "unused" }))
  ];
  const safeDocument = {
    ...document,
    createElement(tag) {
      if (tag !== "template") return new Element(tag);
      return {
        content: { childNodes: input },
        set innerHTML(value) {
          assert.equal(value, "synthetic markup");
        }
      };
    }
  };
  const result = new Element();
  const context = vm.createContext({ document: safeDocument, URL, result });
  vm.runInContext(
    content.slice(
      content.indexOf("function appendSafeTranslation("),
      content.indexOf("function updateHoverContent(")
    ),
    context
  );
  vm.runInContext('appendSafeTranslation(result, "synthetic markup")', context);
  const strong = result.childNodes[0];
  assert.equal(strong.tagName, "STRONG");
  assert.equal(strong.attributes, undefined);
  assert.ok(!result.textContent.includes("blocked"));
  const anchors = result.childNodes.filter((child) => child.tagName === "A");
  assert.equal(anchors.length, 6);
  assert.ok(anchors.slice(0, 4).every((a) => !a.href));
  assert.equal(anchors[4].href, "https://example.test/docs");
  assert.equal(anchors[4].rel, "noopener noreferrer");
});

test("selection and suggestion templates put source/provider markup through textContent", () => {
  const literal = "<strong>literal documentation example</strong>";
  for (const [startMarker, endMarker, variable, selector] of [
    [
      "  container.innerHTML = `",
      "  const preventBlur =",
      "container",
      ".bt-suggestion-text"
    ],
    [
      "    popup.innerHTML = `",
      "    const selectionCenter =",
      "popup",
      ".bt-selection-original .bt-selection-text-content"
    ]
  ]) {
    const start = content.indexOf(startMarker);
    let snippet = content.slice(start, content.indexOf(endMarker, start));
    // Run the actual template plus literal assignment without unrelated positioning.
    const assignmentEnd = snippet.indexOf(
      ";",
      snippet.indexOf(".textContent =")
    );
    snippet = snippet.slice(0, assignmentEnd + 1);
    const textNode = new Element("span");
    let markup;
    const container = {
      set innerHTML(value) {
        markup = value;
      },
      querySelector(value) {
        assert.equal(value, selector);
        return textNode;
      }
    };
    const context = vm.createContext({
      [variable]: container,
      translatedText: literal,
      text: literal,
      iconUrl: "",
      i18n: { t: () => "label" },
      document,
      window: {},
      settings: {},
      applyThemeTo() {}
    });
    // Popup template is followed by layout declarations; retain just its setter and text assignment.
    if (variable === "popup") {
      const close = snippet.indexOf("`;", snippet.indexOf("innerHTML"));
      snippet =
        snippet.slice(0, close + 2) +
        snippet.slice(snippet.indexOf("    popup.querySelector("));
    }
    vm.runInContext(snippet, context);
    assert.ok(!markup.includes(literal));
    assert.equal(textNode.textContent, literal);
  }
});
