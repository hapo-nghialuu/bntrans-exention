import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { mount } from "../extension/src/experimental/learning.js";
import * as learningStore from "../extension/src/experimental/learning-store.js";
import { rankedEnglishWords } from "../extension/src/experimental/learning-frequency-data.js";

class Node {
  constructor(tag = "", type = 1, value = "") {
    this.tagName = tag.toLowerCase();
    this.nodeType = type;
    this.value = value;
    this.data = value;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.listeners = new Map();
    this.checked = false;
  }
  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get textContent() {
    return this.nodeType === 3
      ? this.data
      : this.children.map((v) => v.textContent).join("");
  }
  set textContent(value) {
    if (this.nodeType === 3) this.data = String(value);
    else this.replaceChildren(new Node("", 3, String(value)));
  }
  set innerHTML(_) {
    throw new Error("Unsafe innerHTML prohibited");
  }
  get isContentEditable() {
    return Boolean(
      this.closest("[contenteditable]:not([contenteditable='false'])")
    );
  }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === "string") node = new Node("", 3, node);
      if (node.nodeType === 11) {
        this.append(...[...node.children]);
        continue;
      }
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) {
      const siblings = this.parentNode.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    }
  }
  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    const after = parent.children.slice(index + 1);
    parent.children = parent.children.slice(0, index);
    this.parentNode = null;
    for (const child of after) child.parentNode = null;
    parent.append(...nodes, ...after);
  }
  normalize() {
    const result = [];
    for (const child of this.children) {
      if (child.nodeType === 3 && result.at(-1)?.nodeType === 3) {
        result.at(-1).data += child.data;
        child.parentNode = null;
      } else result.push(child);
    }
    this.children = result;
  }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
  }
  matches(selector) {
    if (this.nodeType !== 1) return false;
    if (/^[a-z0-9]+$/i.test(selector)) return this.tagName === selector;
    if (selector === "[contenteditable]:not([contenteditable='false'])")
      return (
        this.attributes.contenteditable !== undefined &&
        this.attributes.contenteditable !== "false"
      );
    const match = selector.match(
      /^\[([a-z-]+)(\*?=)?(?:['"]([^'"]*)['"])?\]$/i
    );
    if (!match) throw new Error("Unsupported selector " + selector);
    let value = this.attributes[match[1]];
    if (match[1] === "data-bntrans-learning")
      value = this.dataset.bntransLearning;
    if (!match[2]) return value !== undefined;
    return match[2] === "*=" ? value?.includes(match[3]) : value === match[3];
  }
  closest(selectors) {
    let node = this;
    while (node) {
      if (selectors.split(",").some((s) => node.matches(s.trim()))) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelectorAll(selectors) {
    const result = [];
    for (const child of this.children) {
      if (selectors.split(",").some((s) => child.matches(s.trim())))
        result.push(child);
      result.push(...child.querySelectorAll(selectors));
    }
    return result;
  }
  querySelector(selectors) {
    return this.querySelectorAll(selectors)[0] || null;
  }
  attachShadow() {
    this.shadowRoot = new Node("shadow");
    return this.shadowRoot;
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  async fire(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) || [])])
      await fn({
        type,
        target: this,
        isTrusted: true,
        preventDefault() {},
        stopPropagation() {},
        ...event
      });
  }
  dispatchEvent(event) {
    this.fire(event.type, event);
  }
}
function fakeDocument() {
  const document = new Node("document");
  document.nodeType = 9;
  document.documentElement = new Node("html");
  document.documentElement.lang = "en";
  document.body = new Node("body");
  document.documentElement.append(document.body);
  document.append(document.documentElement);
  document.activeElement = document.body;
  document.createElement = (tag) => new Node(tag);
  document.createTextNode = (text) => new Node("", 3, text);
  document.createDocumentFragment = () => new Node("", 11);
  document.createTreeWalker = (root, _, filter) => {
    const nodes = [];
    const collect = (node) => {
      if (node.nodeType === 3 && filter.acceptNode(node) === 1)
        nodes.push(node);
      for (const child of node.children) collect(child);
    };
    collect(root);
    let index = -1;
    return {
      currentNode: null,
      nextNode() {
        this.currentNode = nodes[++index];
        return this.currentNode || null;
      }
    };
  };
  return document;
}
function bus() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (e, area) => {
      for (const fn of [...listeners]) fn(e, area);
    },
    get size() {
      return listeners.size;
    }
  };
}
function chromeMock(initial = {}) {
  let data = structuredClone(initial);
  const changes = bus(),
    messages = bus();
  const local = {
    async get(key) {
      return structuredClone(key === null ? data : { [key]: data[key] });
    },
    async set(values) {
      const event = {};
      for (const [key, value] of Object.entries(values)) {
        event[key] = { oldValue: data[key], newValue: structuredClone(value) };
        data[key] = structuredClone(value);
      }
      changes.emit(event, "local");
    }
  };
  return {
    storage: { local, onChanged: changes },
    runtime: {
      id: "test-extension",
      getURL: (path) => "chrome-extension://test-extension/" + path,
      onMessage: messages
    },
    data: () => structuredClone(data)
  };
}
const settle = async () => {
  for (let i = 0; i < 12; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
const button = (node, label) => {
  const found = node
    .querySelectorAll("button")
    .find((v) => v.textContent === label);
  assert.ok(found, "button " + label);
  return found;
};
const field = (node, label) => {
  const wrapper = node
    .querySelectorAll("label")
    .find((v) => v.children[0]?.textContent === label);
  assert.ok(wrapper, "field " + label);
  return wrapper.children[1];
};

test("mount exposes real management, SRS and schema lookup safely; cleanup removes listeners", async () => {
  const oldDocument = globalThis.document,
    oldChrome = globalThis.chrome;
  const document = fakeDocument(),
    chrome = chromeMock();
  globalThis.document = document;
  globalThis.chrome = chrome;
  const container = new Node("main");
  document.body.append(container);
  const statuses = [],
    calls = [],
    downloads = [];
  let enabled = true;
  const api = {
    t: (en) => en,
    settings: async () => ({
      labFeatures: { learning: enabled },
      activeProviderId: "synthetic"
    }),
    get: async (key) =>
      (await chrome.storage.local.get("bntransLabs:" + key))[
        "bntransLabs:" + key
      ],
    set: async (key, value) =>
      chrome.storage.local.set({ ["bntransLabs:" + key]: value }),
    field(label, node) {
      const wrapper = new Node("label"),
        span = new Node("span");
      span.textContent = label;
      wrapper.append(span, node);
      return wrapper;
    },
    button(label, callback) {
      const node = new Node("button");
      node.textContent = label;
      node.addEventListener("click", () =>
        callback().catch((error) => statuses.push(error.message))
      );
      return node;
    },
    status: (message) => statuses.push(message),
    download: (...args) => downloads.push(args),
    sendToTab: async () => ({
      ok: true,
      text: "bank",
      context: "The river bank.",
      url: "https://example.com/a?key=SECRET"
    }),
    translate: async (source, options) => {
      calls.push({ source, options });
      return options.task === "dictionary"
        ? JSON.stringify({
            meaning: "<img src=x onerror=alert(1)>",
            pos: "noun",
            ipa: null,
            gender: null,
            synonyms: ["shore"],
            example: "A river bank."
          })
        : JSON.stringify({
            summary: "A clause.",
            spans: [
              {
                start: 0,
                end: 3,
                text: source.slice(0, 3),
                label: "Subject",
                explanation: "The determiner"
              }
            ]
          });
    }
  };
  let cleanup;
  try {
    cleanup = await mount(container, api);
    const level = field(container, "Approximate level");
    assert.equal(level.value, "intermediate");
    level.value = "beginner";
    await level.fire("change");
    assert.equal(
      chrome.data()[learningStore.VOCABULARY_KEY].highlightLevel,
      "beginner"
    );
    await button(container, "Use selected page text").fire("click");
    assert.equal(field(container, "Word or phrase").value, "bank");
    assert.equal(
      field(container, "Source URL (optional)").value,
      "https://example.com/a"
    );
    field(container, "Tags (comma-separated)").value = "river, travel";
    field(container, "Meaning (editable)").value = "bờ sông";
    await button(container, "Save card").fire("click");
    assert.equal(chrome.data()[learningStore.VOCABULARY_KEY].items.length, 1);
    await button(container, "Dictionary").fire("click");
    assert.ok(container.textContent.includes("<img src=x onerror=alert(1)>"));
    assert.equal(container.querySelectorAll("img").length, 0);
    assert.ok(container.textContent.includes("IPA: Not available"));
    await button(container, "Dictionary").fire("click");
    assert.equal(calls.length, 1, "identical lookup uses context-aware cache");
    field(container, "Source sentence (max 2,000 characters)").value =
      "The bank accepted a deposit.";
    await button(container, "Dictionary").fire("click");
    assert.equal(calls.length, 2, "different context calls provider again");
    assert.ok(
      calls.every(
        (v) =>
          v.options.skipHistory &&
          v.options.customPrompt &&
          v.options.siteUrl === "https://example.com/a"
      )
    );
    await button(container, "Explain sentence").fire("click");
    await button(container, "Subject · The").fire("click");
    assert.equal(container.querySelector("mark").textContent, "The");
    await button(container, "Export Anki CSV").fire("click");
    assert.ok(downloads[0][1].includes("bờ sông"));
    assert.ok(!downloads[0][1].includes("SECRET"));
    await button(container, "Start due session (20 max)").fire("click");
    await button(container, "Reveal meaning").fire("click");
    await button(container, "Remember").fire("click");
    assert.equal(
      chrome.data()[learningStore.VOCABULARY_KEY].items[0].interval,
      1
    );
    await button(container, "Mark learned").fire("click");
    assert.equal(
      chrome.data()[learningStore.VOCABULARY_KEY].items[0].known,
      true
    );
    await button(container, "Star").fire("click");
    assert.equal(
      chrome.data()[learningStore.VOCABULARY_KEY].items[0].starred,
      true
    );
    field(container, "Exact tag filter").value = "absent";
    await field(container, "Exact tag filter").fire("input");
    assert.match(container.textContent, /Matching cards: 0/);
    field(container, "Exact tag filter").value = "river";
    await field(container, "Exact tag filter").fire("input");
    assert.match(container.textContent, /Matching cards: 1/);
    await button(container, "Delete").fire("click");
    assert.ok(
      chrome.data()[learningStore.VOCABULARY_KEY].items[0].deletedAt > 0
    );
  } finally {
    cleanup?.();
    assert.equal(chrome.storage.onChanged.size, 0);
    assert.equal(container.children.length, 0);
    globalThis.document = oldDocument;
    globalThis.chrome = oldChrome;
  }
});

test("disabled mount actions never write or invoke cloud; malformed provider output stays visible", async () => {
  const oldDocument = globalThis.document,
    oldChrome = globalThis.chrome;
  globalThis.document = fakeDocument();
  globalThis.chrome = chromeMock();
  const container = new Node("main"),
    errors = [];
  let enabled = false,
    requests = 0;
  const api = {
    t: (en) => en,
    settings: async () => ({ labFeatures: { learning: enabled } }),
    get: async () => null,
    set: async () => {
      throw new Error("unexpected write");
    },
    status: (v) => errors.push(v),
    field: (_, n) => n,
    button(label, callback) {
      const n = new Node("button");
      n.textContent = label;
      n.addEventListener("click", () =>
        callback().catch((e) => errors.push(e.message))
      );
      return n;
    },
    translate: async () => {
      requests++;
      return "not JSON";
    }
  };
  const cleanup = await mount(container, api);
  try {
    await button(container, "Save card").fire("click");
    await button(container, "Dictionary").fire("click");
    assert.equal(requests, 0);
    assert.ok(errors.every((v) => v.includes("Enable Learning")));
    enabled = true;
    container.querySelector("input").value = "bank";
    await button(container, "Dictionary").fire("click");
    assert.equal(requests, 1);
    assert.match(container.textContent, /No valid structured result/);
  } finally {
    cleanup();
    globalThis.document = oldDocument;
    globalThis.chrome = oldChrome;
  }
});

async function contentHarness(
  enabled = true,
  highlighted = false,
  level = "intermediate"
) {
  const document = fakeDocument(),
    chrome = chromeMock({
      translatorSettings: {
        labFeatures: { learning: enabled },
        nativeLanguageCode: "vi"
      },
      [learningStore.VOCABULARY_KEY]: {
        ...learningStore.saveItem(null, { text: "bank" }, 1000, "bank"),
        highlightEnabled: highlighted,
        highlightLevel: level
      }
    });
  const timers = new Map(),
    observers = [];
  let nextTimer = 1,
    selection = null,
    imports = 0;
  class Observer {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
  }
  const context = vm.createContext({
    document,
    chrome,
    location: { href: "https://example.com/story?secret=NO" },
    window: { getSelection: () => selection },
    innerWidth: 1000,
    innerHeight: 800,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    MutationObserver: Observer,
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    setTimeout: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(
    readFileSync(
      new URL(
        "../extension/src/experimental/content-learning.js",
        import.meta.url
      ),
      "utf8"
    ),
    context,
    {
      importModuleDynamically: async (specifier) => {
        imports++;
        return specifier.includes("learning-frequency.js")
          ? import("../extension/src/experimental/learning-frequency.js")
          : import("../extension/src/experimental/learning-store.js");
      }
    }
  );
  const flush = async () => {
    await settle();
    const work = [...timers.values()];
    timers.clear();
    for (const fn of work) fn();
    await settle();
  };
  const select = (node) => {
    selection = {
      anchorNode: node,
      focusNode: node,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => node.textContent,
      getRangeAt: () => ({
        commonAncestorContainer: node,
        intersectsNode: (other) => other === node || other === node.parentNode,
        getBoundingClientRect: () => ({ left: 10, bottom: 10 })
      })
    };
  };
  return {
    document,
    chrome,
    timers,
    observers,
    context,
    flush,
    select,
    imports: () => imports,
    cleanup: () => context.__bntransLearningCleanup()
  };
}

test("classic content is inert when disabled; no observers/imports, cleans runtime/storage listeners", async () => {
  const h = await contentHarness(false);
  await h.flush();
  assert.equal(h.imports(), 0);
  assert.equal(h.observers.length, 0);
  assert.equal(h.document.querySelectorAll("mark").length, 0);
  h.cleanup();
  assert.equal(h.chrome.storage.onChanged.size, 0);
  assert.equal(h.chrome.runtime.onMessage.size, 0);
  assert.equal(h.timers.size, 0);
});

test("content selection rejects editable/password/code and saves safe Unicode context only on click", async () => {
  const h = await contentHarness(true);
  const previous = globalThis.chrome;
  globalThis.chrome = h.chrome;
  try {
    await h.flush();
    for (const tag of ["input", "textarea", "code"]) {
      const node = new Node(tag);
      node.textContent = "secret";
      h.document.body.append(node);
      h.select(node.children[0]);
      await h.document.fire("pointerup");
      assert.equal(h.document.querySelector("[data-bntrans-learning]"), null);
    }
    const editable = new Node("div");
    editable.setAttribute("contenteditable", "true");
    editable.textContent = "secret";
    h.document.body.append(editable);
    h.select(editable.children[0]);
    await h.document.fire("pointerup");
    assert.equal(h.document.querySelector("[data-bntrans-learning]"), null);
    const paragraph = new Node("p");
    paragraph.textContent = "Bờ sông bank";
    h.document.body.append(paragraph);
    h.select(paragraph.children[0]);
    await h.document.fire("pointerup", { isTrusted: false });
    assert.equal(h.document.querySelector("[data-bntrans-learning]"), null);
    await h.document.fire("pointerup");
    const host = h.document.querySelector("[data-bntrans-learning]");
    assert.ok(host);
    await button(host.shadowRoot, "Save to BNTrans").fire("click", {
      isTrusted: false
    });
    assert.equal(
      h.chrome.data()[learningStore.VOCABULARY_KEY].items.length,
      1,
      "page-generated clicks cannot save cards"
    );
    await button(host.shadowRoot, "Save to BNTrans").fire("click");
    const saved = h.chrome
      .data()
      [learningStore.VOCABULARY_KEY].items.find(
        (v) => v.text === "Bờ sông bank"
      );
    assert.ok(saved);
    assert.equal(saved.context, "Bờ sông bank");
    assert.equal(saved.url, "https://example.com/story");
    assert.equal(saved.targetLanguage, "vi");
    assert.equal(
      h.chrome.runtime.sendMessage,
      undefined,
      "content never requests translation"
    );
  } finally {
    h.cleanup();
    globalThis.chrome = previous;
  }
});

test("highlight whole tokens, learned exclusion, mutation debounce, disable restores DOM", async () => {
  const h = await contentHarness(true, true);
  const previous = globalThis.chrome;
  globalThis.chrome = h.chrome;
  const paragraph = new Node("p");
  paragraph.textContent = "bank riverbank banké BANK bank_ bank";
  const code = new Node("code");
  code.textContent = "bank";
  h.document.body.append(paragraph, code);
  try {
    await h.flush();
    assert.equal(h.document.querySelectorAll("mark").length, 4);
    assert.equal(code.textContent, "bank");
    const original = paragraph.textContent;
    h.observers.at(-1).callback([]);
    h.observers.at(-1).callback([]);
    h.observers.at(-1).callback([]);
    assert.equal(h.timers.size, 1);
    const state = h.chrome.data()[learningStore.VOCABULARY_KEY];
    await h.chrome.storage.local.set({
      [learningStore.VOCABULARY_KEY]: learningStore.saveItem(
        state,
        { id: "bank", known: true },
        2000,
        "bank"
      )
    });
    await h.flush();
    assert.deepEqual(
      h.document.querySelectorAll("mark").map((mark) => mark.textContent),
      ["riverbank"]
    );
    assert.equal(paragraph.textContent, original);
    await h.chrome.storage.local.set({
      translatorSettings: { labFeatures: { learning: false } }
    });
    await h.flush();
    assert.ok(h.observers.every((v) => !v.connected));
    assert.equal(h.timers.size, 0);
    assert.equal(h.document.listeners.get("pointerup").size, 0);
  } finally {
    h.cleanup();
    globalThis.chrome = previous;
  }
});

test("page frequency filtering, saved priority, click-to-ignore and local persistence", async () => {
  const h = await contentHarness(true, true, "advanced");
  const previous = globalThis.chrome;
  globalThis.chrome = h.chrome;
  const para = new Node("p");
  const rare = rankedEnglishWords[7000];
  const mid = rankedEnglishWords[3000];
  para.textContent = `you bank ${mid} ${rare} Propernoun 7word banké`;
  h.document.body.append(para);
  try {
    await h.flush();
    assert.deepEqual(
      h.document.querySelectorAll("mark").map((mark) => mark.textContent),
      ["bank", rare]
    );
    const ignored = h.document.querySelectorAll("mark")[1];
    await ignored.fire("click");
    await h.flush();
    assert.deepEqual(
      h.document.querySelectorAll("mark").map((mark) => mark.textContent),
      ["bank"]
    );
    assert.equal(
      h.chrome
        .data()
        [learningStore.VOCABULARY_KEY].items.some(
          (item) => item.text === rare && item.known
        ),
      true
    );
    await h.chrome.storage.local.set({
      [learningStore.VOCABULARY_KEY]: {
        ...h.chrome.data()[learningStore.VOCABULARY_KEY],
        highlightLevel: "beginner",
        preferencesUpdatedAt: Date.now() + 10000
      }
    });
    await h.flush();
    assert.deepEqual(
      h.document.querySelectorAll("mark").map((mark) => mark.textContent),
      ["bank", mid]
    );
    h.document.documentElement.lang = "vi";
    h.observers.at(-1).callback([]);
    await h.flush();
    assert.deepEqual(
      h.document.querySelectorAll("mark").map((mark) => mark.textContent),
      ["bank"]
    );
    assert.equal(
      para.textContent,
      `you bank ${mid} ${rare} Propernoun 7word banké`
    );
  } finally {
    h.cleanup();
    globalThis.chrome = previous;
  }
});

test("highlighting caps DOM wrappers, skips code and restores all marked text", async () => {
  const h = await contentHarness(true, true, "beginner");
  const previous = globalThis.chrome;
  globalThis.chrome = h.chrome;
  const para = new Node("p"),
    code = new Node("code"),
    input = new Node("input");
  para.textContent = "bank ".repeat(600).trim();
  code.textContent = "bank";
  input.value = "bank";
  const original = para.textContent;
  h.document.body.append(para, code, input);
  try {
    await h.flush();
    assert.equal(h.document.querySelectorAll("mark").length, 500);
    assert.equal(code.textContent, "bank");
    assert.equal(input.value, "bank");
    await h.chrome.storage.local.set({
      translatorSettings: { labFeatures: { learning: false } }
    });
    await h.flush();
    assert.equal(h.document.querySelectorAll("mark").length, 0);
    assert.equal(para.textContent, original);
  } finally {
    h.cleanup();
    globalThis.chrome = previous;
  }
});
