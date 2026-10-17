import { readFileSync } from "node:fs";
import vm from "node:vm";

const granular = readFileSync(
  new URL("../extension/src/content-script-granularity.js", import.meta.url),
  "utf8"
);
const source = readFileSync(
  new URL("../extension/src/content-script.js", import.meta.url),
  "utf8"
);
const start = source.indexOf("  const PAGE_MAX_UNITS =");
const end = source.indexOf("  // --- Translate & replace", start);

export function createHarness({
  count = 0,
  visible = [],
  settings = {},
  settingsError,
  provider,
  fastClock = true
} = {}) {
  const observers = new Set();
  const intersections = [];
  const listeners = new Map();
  const runtimeListeners = [];
  const storageListeners = [];
  const requests = [];
  const stateMessages = [];
  const batches = [];
  const paragraphs = [];
  let now = Date.now();
  const notify = (target, type) => {
    for (const observer of observers) {
      if (!observer.target || !observer.target.contains(target)) continue;
      observer.records.push({ target, type });
      if (observer.scheduled) continue;
      observer.scheduled = true;
      queueMicrotask(() => {
        observer.scheduled = false;
        const records = observer.takeRecords();
        if (records.length && observer.target) observer.callback(records);
      });
    }
  };
  class MockNode {
    constructor(tag, text) {
      this.nodeType = tag ? 1 : 3;
      this.tagName = tag?.toUpperCase();
      this.valueText = text || "";
      this.childNodes = [];
      this.parentNode = null;
      this.attrs = new Map();
      this.style = {};
      this.rect = { top: 2000, bottom: 2050, left: 0, right: 800 };
      this.classList = {
        contains: (v) => (this.className || "").split(/\s+/).includes(v),
        add: (v) => {
          this.className = (this.className || "") + " " + v;
        },
        remove: (v) => {
          this.className = (this.className || "")
            .split(/\s+/)
            .filter((x) => x !== v)
            .join(" ");
        }
      };
    }
    get parentElement() {
      return this.parentNode;
    }
    get isConnected() {
      return (
        this === document.documentElement || !!this.parentNode?.isConnected
      );
    }
    get isContentEditable() {
      return (
        this.getAttribute("contenteditable") === "true" ||
        (this.getAttribute("contenteditable") !== "false" &&
          !!this.parentNode?.isContentEditable)
      );
    }
    get firstChild() {
      return this.childNodes[0];
    }
    get textContent() {
      return this.nodeType === 3
        ? this.valueText
        : this.childNodes.map((n) => n.textContent).join("");
    }
    set textContent(value) {
      if (this.nodeType === 3) {
        this.valueText = String(value);
        notify(this, "characterData");
      } else {
        this.replaceChildren();
        if (String(value)) this.appendChild(new MockNode(null, String(value)));
      }
    }
    get innerHTML() {
      throw new Error("Unsafe HTML getter in authored code");
    }
    set innerHTML(_) {
      throw new Error("Unsafe HTML setter in authored code");
    }
    setAttribute(key, value) {
      this.attrs.set(key, String(value));
      if (key === "class") this.className = value;
      notify(this, "attributes");
    }
    getAttribute(key) {
      return this.attrs.get(key) ?? null;
    }
    hasAttribute(key) {
      return this.attrs.has(key);
    }
    removeAttribute(key) {
      this.attrs.delete(key);
      notify(this, "attributes");
    }
    contains(node) {
      return node === this || this.childNodes.some((n) => n.contains(node));
    }
    insertBefore(node, before) {
      if (node.parentNode) node.remove();
      const i = before
        ? this.childNodes.indexOf(before)
        : this.childNodes.length;
      if (i < 0) throw new Error("Invalid insertion anchor");
      this.childNodes.splice(i, 0, node);
      node.parentNode = this;
      notify(this, "childList");
      return node;
    }
    appendChild(node) {
      return this.insertBefore(node, null);
    }
    append(...nodes) {
      nodes.forEach((n) =>
        this.appendChild(typeof n === "string" ? new MockNode(null, n) : n)
      );
    }
    remove() {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
      this.parentNode = null;
      notify(parent, "childList");
    }
    replaceChildren(...nodes) {
      [...this.childNodes].forEach((n) => n.remove());
      this.append(...nodes);
    }
    matches(selector) {
      if (selector.startsWith("#")) return this.id === selector.slice(1);
      const attrs = [
        ...selector.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/g)
      ];
      if (attrs.length)
        return attrs.every(([, key, value]) =>
          value === undefined
            ? this.hasAttribute(key)
            : this.getAttribute(key) === value
        );
      return this.tagName?.toLowerCase() === selector;
    }
    querySelectorAll(selector) {
      return this.childNodes.flatMap((node) => [
        ...(node.matches(selector) ? [node] : []),
        ...node.querySelectorAll(selector)
      ]);
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    getBoundingClientRect() {
      return this.rect.top === 2000 &&
        this.hasAttribute("data-bntrans-original")
        ? this.parentNode.parentNode.getBoundingClientRect()
        : this.rect;
    }
  }
  const document = {
    createElement: (tag) => new MockNode(tag),
    createTextNode: (text) => new MockNode(null, text),
    getElementById: (id) => document.documentElement.querySelector("#" + id),
    querySelectorAll: (selector) =>
      document.documentElement.querySelectorAll(selector)
  };
  document.documentElement = new MockNode("html");
  document.body = new MockNode("body");
  document.documentElement.appendChild(document.body);
  const appendParagraph = (text, visibleHere = false) => {
    const p = document.createElement("p");
    if (visibleHere) p.rect = { top: 100, bottom: 150, left: 0, right: 800 };
    p.textContent = text;
    document.body.appendChild(p);
    paragraphs.push(p);
    return p;
  };
  for (let i = 0; i < count; i++)
    appendParagraph("Synthetic " + i, visible.includes(i));
  let currentSettings = {
    labFeatures: { page: true },
    labPage: { requestsPerSecond: 10 },
    ...settings
  };
  const context = vm.createContext({
    console,
    document,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8 },
    NodeList: Array,
    Date: fastClock
      ? class extends Date {
          static now() {
            return (now += 1000);
          }
        }
      : Date,
    window: {
      innerHeight: 768,
      innerWidth: 1024,
      addEventListener: (type, cb) => listeners.set(type, cb),
      removeEventListener: (type) => listeners.delete(type)
    },
    location: {
      href: "https://synthetic.example/article",
      hostname: "synthetic.example"
    },
    setTimeout,
    clearTimeout,
    setInterval: (cb, ms) => {
      const timer = setInterval(cb, ms);
      timer.unref();
      return timer;
    },
    clearInterval,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "page-translation-state")
            stateMessages.push(message.active);
        },
        onMessage: { addListener: (cb) => runtimeListeners.push(cb) }
      },
      storage: { onChanged: { addListener: (cb) => storageListeners.push(cb) } }
    },
    getSettings: async () => {
      if (settingsError) throw new Error(settingsError);
      return currentSettings;
    },
    requestTranslation: async (payload) => {
      requests.push(payload);
      const batch = payload.text.split(" ||| ");
      batches.push(batch);
      return provider
        ? provider(payload, requests.length)
        : {
            ok: true,
            result: {
              translation: batch.map((x) => "Translated " + x).join(" ||| ")
            }
          };
    },
    IntersectionObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        intersections.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.records = [];
        observers.add(this);
      }
      observe(target) {
        this.target = target;
      }
      disconnect() {
        this.target = null;
        this.records = [];
      }
      takeRecords() {
        return this.records.splice(0);
      }
    }
  });
  vm.runInContext(
    granular +
      "\n" +
      source.slice(start, end) +
      `
    globalThis.api = {runPageTranslation, removePageTranslation, pageCommand, pageSnapshot,
      getTranslationUnits, toMarkdown, injectUnitWrappers, updateWrappers, requestSegmentTranslations, pageOptions};`,
    context
  );
  return {
    context,
    document,
    paragraphs,
    appendParagraph,
    requests,
    stateMessages,
    batches,
    intersections,
    listeners,
    ...context.api,
    setSettings: (next, notifyChange = false) => {
      currentSettings = next;
      if (notifyChange)
        storageListeners.forEach((cb) =>
          cb({ translatorSettings: { newValue: next } }, "local")
        );
    },
    intersect: (indices) =>
      intersections
        .at(-1)
        .callback(
          indices.map((i) => ({ target: paragraphs[i], isIntersecting: true }))
        ),
    command: (command, extra = {}) =>
      new Promise((resolve) =>
        runtimeListeners[0](
          { type: "labs-page-command", command, ...extra },
          {},
          resolve
        )
      ),
    dispose: () => context.api.removePageTranslation()
  };
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end)
      throw new Error("Timed out waiting for synthetic state");
    await delay(5);
  }
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
