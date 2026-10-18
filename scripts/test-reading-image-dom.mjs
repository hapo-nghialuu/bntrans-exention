import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import * as contextModule from "../extension/src/experimental/reading-context.js";
import * as imageModule from "../extension/src/experimental/image-translation-utils.js";

const script = readFileSync(
  new URL("../extension/src/experimental/content-images.js", import.meta.url),
  "utf8"
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const event = () => {
  const listeners = new Set();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => {
      for (const fn of listeners) fn(...args);
    }
  };
};
function setup(
  t,
  html = '<img id="photo" src="https://cdn.test/photo.png" style="object-fit:contain;object-position:50% 50%">'
) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://page.test/article",
    runScripts: "outside-only"
  });
  t.after(() => dom.window.close());
  const { window } = dom,
    { document } = window;
  const img = document.querySelector("img");
  let rect = { x: 20, y: 30, width: 400, height: 200 };
  Object.defineProperties(img, {
    complete: { value: true, configurable: true },
    naturalWidth: { value: 800, configurable: true },
    naturalHeight: { value: 400, configurable: true }
  });
  img.getBoundingClientRect = () => ({
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height
  });
  const zero = { x: 0, y: 0, width: 0, height: 0 };
  for (const el of [document.body, document.documentElement])
    el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 600 });
  document.elementFromPoint = () => img;
  Object.defineProperties(window, {
    innerWidth: { value: 800 },
    innerHeight: { value: 600 }
  });
  const nativeStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (el, pseudo) =>
    pseudo ? { content: "none" } : nativeStyle(el);
  const callbacks = {},
    intervals = new Set(),
    mutations = [],
    notifications = [],
    shadows = [];
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) {
    const result = attachShadow.call(this, options);
    shadows.push(result);
    return result;
  };
  const nativeAdd = document.addEventListener.bind(document),
    nativeRemove = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn, options) => {
    if (type === "click") callbacks.click = fn;
    nativeAdd(type, fn, options);
  };
  document.removeEventListener = (type, fn, options) => {
    if (type === "click" && callbacks.click === fn) delete callbacks.click;
    nativeRemove(type, fn, options);
  };
  window.setInterval = (fn) => {
    intervals.add(fn);
    return fn;
  };
  window.clearInterval = (fn) => intervals.delete(fn);
  window.MutationObserver = class {
    constructor(fn) {
      this.fn = fn;
      mutations.push(this);
    }
    observe() {
      this.active = true;
    }
    disconnect() {
      this.active = false;
    }
  };
  const chrome = {
    runtime: {
      id: "extension",
      getURL: (path) => `chrome-extension://extension/${path}`,
      onMessage: event(),
      sendMessage: async (message) => {
        notifications.push(message);
      }
    },
    storage: {
      local: {
        get: async () => ({
          translatorSettings: { enabled: true, labFeatures: { image: true } }
        })
      },
      onChanged: event()
    }
  };
  window.chrome = chrome;
  const vmContext = dom.getInternalVMContext();
  const loaded = new Map();
  new vm.Script(script, {
    importModuleDynamically: async (path) => {
      if (loaded.has(path)) return loaded.get(path);
      const exports = path.endsWith("reading-context.js")
        ? contextModule
        : imageModule;
      const module = new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports))
            this.setExport(name, value);
        },
        { context: vmContext }
      );
      await module.link(() => {});
      await module.evaluate();
      loaded.set(path, module);
      return module;
    }
  }).runInContext(vmContext);
  const send = (
    payload,
    sender = {
      id: "extension",
      url: "chrome-extension://extension/pages/labs.html"
    }
  ) =>
    new Promise((resolve) => {
      const listener = [...chrome.runtime.onMessage.listeners][0];
      const accepted = listener(
        { type: "labs-image-source", payload },
        sender,
        resolve
      );
      if (!accepted) resolve({ refused: true });
    });
  const choose = async (target = img, trusted = true) => {
    const pending = send({ command: "choose-image" });
    await tick();
    if (!callbacks.click) return pending;
    callbacks.click({
      isTrusted: trusted,
      button: 0,
      target,
      preventDefault() {},
      stopImmediatePropagation() {}
    });
    return pending;
  };
  const show = (source, text = "<img src=x onerror=alert(1)> Xin chào") =>
    send({
      command: "show",
      id: source.id,
      lines: [
        {
          id: "line-1",
          text,
          bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 }
        }
      ]
    });
  const mutate = () => {
    for (const m of mutations) if (m.active) m.fn([{ target: img }]);
  };
  return {
    dom,
    window,
    document,
    img,
    chrome,
    callbacks,
    intervals,
    mutations,
    notifications,
    shadows,
    send,
    choose,
    show,
    mutate,
    zero,
    setRect: (value) => {
      rect = { ...rect, ...value };
    }
  };
}

test("choose-image is explicit, top-frame, trusted-click only and no OCR/network occurs", async (t) => {
  const state = setup(t);
  assert.equal(state.intervals.size, 0);
  assert.equal(state.callbacks.click, undefined);
  const pending = state.send({ command: "choose-image" });
  await tick();
  state.callbacks.click({ isTrusted: false, button: 0 });
  assert.equal(state.intervals.size, 0);
  state.callbacks.click({
    isTrusted: true,
    button: 0,
    target: state.img,
    preventDefault() {},
    stopImmediatePropagation() {}
  });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.source.src, "https://cdn.test/photo.png");
  assert.equal(state.callbacks.click, undefined);
  assert.equal(state.intervals.size, 1);
  assert.equal(state.notifications.length, 0);
  await state.send({ command: "restore" });
});

test("sender boundaries reject websites/content scripts; source command fields are nested", async (t) => {
  const state = setup(t);
  assert.equal(
    (
      await state.send(
        { command: "choose-image" },
        { id: "extension", url: "https://page.test" }
      )
    ).refused,
    true
  );
  assert.equal(
    (
      await state.send(
        { command: "choose-image" },
        {
          id: "extension",
          tab: { id: 7 },
          url: "chrome-extension://extension/pages/labs.html"
        }
      )
    ).refused,
    true
  );
  assert.equal(
    (
      await state.send(
        { command: "choose-image" },
        { id: "other", url: "chrome-extension://extension/pages/labs.html" }
      )
    ).refused,
    true
  );
  assert.equal(state.callbacks.click, undefined);
});

test("nested opt-outs, editable/form/hidden/iframe ancestry never become image sources", async (t) => {
  for (const attributes of [
    'translate="no"',
    'contenteditable="true"',
    "hidden",
    "inert",
    'aria-hidden="true"',
    'class="notranslate"',
    'style="opacity:0"'
  ]) {
    const state = setup(
      t,
      `<div ${attributes}><span translate="yes" contenteditable="false"><img src="https://cdn.test/a.png"></span></div>`
    );
    assert.equal((await state.choose()).error, "image-protected", attributes);
  }
  const state = setup(t, '<form><img src="https://cdn.test/a.png"></form>');
  assert.equal((await state.choose()).error, "image-protected");
});

test("unsupported SVG, clipped/offscreen, transformed and obscured images are refused", async (t) => {
  const state = setup(t);
  state.img.src = "https://cdn.test/a.svg";
  assert.equal((await state.choose()).error, "image-raster-only");
  state.img.src = "https://cdn.test/a.png";
  state.setRect({ x: -1 });
  assert.equal((await state.choose()).error, "image-clipped");
  state.setRect({ x: 20 });
  state.img.style.transform = "rotate(3deg)";
  assert.equal((await state.choose()).error, "image-style-unsupported");
  state.img.style.transform = "none";
  const password = state.document.createElement("input");
  password.type = "password";
  password.value = "SECRET";
  password.getBoundingClientRect = () => ({
    x: 40,
    y: 60,
    width: 100,
    height: 20
  });
  state.document.body.append(password);
  assert.equal((await state.choose()).error, "image-obscured");
});

test("overlay uses normalized real boxes, safe text and leaves original pixels/layout intact", async (t) => {
  const state = setup(t);
  const { source } = await state.choose();
  const before = state.img.outerHTML;
  assert.equal((await state.show(source)).ok, true);
  const host = state.document.querySelector("#bntrans-image-overlay"),
    shadow = state.shadows.at(-1),
    label = shadow.querySelector("span");
  assert.equal(host.style.left, "20px");
  assert.equal(host.style.width, "400px");
  assert.equal(label.style.left, "10%");
  assert.equal(label.style.top, "20%");
  assert.equal(label.style.width, "50%");
  assert.equal(label.style.height, "25%");
  assert.match(label.textContent, /<img src=x/);
  assert.equal(shadow.querySelector("img"), null);
  assert.equal(state.img.outerHTML, before);
  assert.equal(host.style.pointerEvents, "none");
  await state.send({ command: "original", id: source.id });
  assert.equal(state.document.querySelector("#bntrans-image-overlay"), null);
  assert.equal(state.img.outerHTML, before);
  await state.send({ command: "restore" });
});

test("resize/scroll repositions overlay without drifting; strict capture rejects resized source", async (t) => {
  const state = setup(t);
  const { source } = await state.choose();
  await state.show(source);
  state.setRect({ x: 50, y: 70, width: 200, height: 100 });
  state.window.dispatchEvent(new state.window.Event("resize"));
  const host = state.document.querySelector("#bntrans-image-overlay");
  assert.equal(host.style.left, "50px");
  assert.equal(host.style.width, "200px");
  assert.equal(
    (await state.send({ command: "validate", id: source.id })).error,
    "image-stale"
  );
  assert.equal(
    (await state.send({ command: "check", id: source.id })).ok,
    true
  );
  state.setRect({ y: -30 });
  state.window.dispatchEvent(new state.window.Event("scroll"));
  assert.equal(host.style.display, "none");
  state.setRect({ y: 20 });
  state.window.dispatchEvent(new state.window.Event("scroll"));
  assert.equal(host.style.display, "block");
  await state.send({ command: "restore" });
});

test("changed img src invalidates overlay and notifies worker owner even while offscreen", async (t) => {
  const state = setup(t);
  const { source } = await state.choose();
  await state.show(source);
  state.setRect({ y: -30 });
  state.img.src = "https://cdn.test/new.png";
  state.mutate();
  assert.equal(state.document.querySelector("#bntrans-image-overlay"), null);
  assert.equal(state.intervals.size, 0);
  assert(state.mutations.every((observer) => !observer.active));
  assert.equal(state.notifications.at(-1).type, "labs-image-invalidated");
  assert.equal(state.notifications.at(-1).imageId, source.id);
  assert.equal(
    (await state.send({ command: "show", id: source.id, lines: [] })).error,
    "image-stale"
  );
});

test("URL navigation, flag off, Restore and pagehide release observer/timer/highlights", async (t) => {
  for (const action of ["url", "flag", "restore", "pagehide"]) {
    const state = setup(t);
    const { source } = await state.choose();
    await state.show(source);
    if (action === "url") {
      state.window.history.pushState({}, "", "/other");
      [...state.intervals][0]();
    }
    if (action === "flag")
      state.chrome.storage.onChanged.emit(
        { translatorSettings: { newValue: { labFeatures: { image: false } } } },
        "local"
      );
    if (action === "restore") await state.send({ command: "restore" });
    if (action === "pagehide")
      state.window.dispatchEvent(new state.window.Event("pagehide"));
    assert.equal(
      state.document.querySelector("#bntrans-image-overlay"),
      null,
      action
    );
    assert.equal(state.intervals.size, 0, action);
    assert(
      state.mutations.every((observer) => !observer.active),
      action
    );
    if (action === "pagehide") {
      assert.equal(state.chrome.runtime.onMessage.listeners.size, 0);
      assert.equal(state.chrome.storage.onChanged.listeners.size, 0);
    }
  }
});

test("malformed/duplicate boxes never create an overlay", async (t) => {
  const state = setup(t);
  const { source } = await state.choose();
  for (const lines of [
    [{ id: "bad", text: "x", bbox: { x: 0, y: 0, width: 2, height: 1 } }],
    [
      { id: "x", text: "x", bbox: { x: 0, y: 0, width: 0.1, height: 0.1 } },
      { id: "x", text: "y", bbox: { x: 0, y: 0, width: 0.1, height: 0.1 } }
    ]
  ]) {
    assert.equal(
      (await state.send({ command: "show", id: source.id, lines })).error,
      "image-layout"
    );
    assert.equal(state.document.querySelector("#bntrans-image-overlay"), null);
  }
  await state.send({ command: "restore" });
});

test("Restore cancels pending image picker without lingering click listeners", async (t) => {
  const state = setup(t);
  const pending = state.send({ command: "choose-image" });
  await tick();
  await state.send({ command: "restore" });
  assert.equal((await pending).error, "image-cancelled");
  assert.equal(state.callbacks.click, undefined);
  assert.equal(state.intervals.size, 0);
});
