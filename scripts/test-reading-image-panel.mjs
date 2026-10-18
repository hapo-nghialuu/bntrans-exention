import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mount } from "../extension/src/experimental/image-translation.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 15; i++) await tick();
}
function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => {
      for (const fn of listeners) fn(...args);
    }
  };
}
async function setup(t, options = {}) {
  const dom = new JSDOM("<!doctype html><main></main>");
  const { window } = dom,
    { document } = window;
  const calls = [],
    config = {
      enabled: true,
      labFeatures: { image: options.enabled !== false }
    },
    tab = { id: 7, windowId: 3, url: "https://example.test/article" };
  const chrome = {
    runtime: {
      id: "extension",
      getURL: (path) => `chrome-extension://extension/${path}`,
      onMessage: event()
    },
    storage: { onChanged: event() },
    tabs: { update: async (...args) => calls.push(["activate", ...args]) },
    windows: { update: async (...args) => calls.push(["focus", ...args]) }
  };
  const previousChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  const pixels = new Map();
  window.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    return {
      drawImage: (...args) => calls.push(["draw", ...args]),
      getImageData: (_x, _y, width, height) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4).fill(173)
      }),
      putImageData: (image) => {
        pixels.set(canvas, image);
        calls.push(["pixels", image]);
      }
    };
  };
  window.HTMLCanvasElement.prototype.toBlob = function (callback) {
    callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  };
  const source = {
    id: "image-1",
    url: tab.url,
    rect: { x: 20, y: 30, width: 200, height: 100 }
  };
  const api = {
    t: (en) => en,
    settings: async () => structuredClone(config),
    activeTab: async () => ({ ...tab }),
    field(label, input) {
      const el = document.createElement("label"),
        span = document.createElement("span");
      span.textContent = label;
      el.append(span, input);
      return el;
    },
    sendToTab: async (type, payload, id) => {
      calls.push(["source", type, { ...payload }, id]);
      if (payload.command === "choose-image")
        return options.choose
          ? options.choose()
          : { ok: true, source: structuredClone(source) };
      if (options.check && payload.command === "check") return options.check();
      return { ok: true };
    },
    send: async (type, payload) => {
      calls.push(["capture", type, payload]);
      return {
        ok: true,
        dataUrl: "data:image/png;base64,AQID",
        width: 200,
        height: 100,
        region: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 }
      };
    },
    translate: async (...args) => {
      calls.push(["translate", ...args]);
      return options.translate
        ? options.translate(...args)
        : '[{"id":"line-1","text":"<script>dịch</script>"}]';
    }
  };
  const cleanup = await mount(document.querySelector("main"), api, {
    createBitmap: async () => ({
      width: 200,
      height: 100,
      close() {
        calls.push(["bitmap-close"]);
      }
    }),
    createEngine: () => {
      calls.push(["worker"]);
      return {
        recognizeLayout: async (bytes) => {
          calls.push(["ocr", bytes]);
          return options.recognize
            ? options.recognize()
            : {
                lines: [
                  {
                    text: "<img src=x onerror=alert(1)>",
                    bbox: { x0: 10, y0: 5, x1: 80, y1: 25 }
                  }
                ]
              };
        },
        terminate() {
          calls.push(["terminate"]);
        }
      };
    }
  });
  t.after(() => {
    cleanup();
    dom.window.close();
    globalThis.chrome = previousChrome;
  });
  const button = (label) =>
    [...document.querySelectorAll("button")].find(
      (el) => el.textContent === label
    );
  const click = async (label) => {
    button(label).click();
    await settle();
  };
  const checks = () => [...document.querySelectorAll('input[type="checkbox"]')];
  const consent = () => {
    checks()[1].checked = true;
    checks()[1].dispatchEvent(new window.Event("change"));
  };
  return {
    window,
    document,
    chrome,
    config,
    tab,
    calls,
    button,
    click,
    checks,
    consent,
    cleanup,
    pixels,
    source
  };
}

test("disabled feature never activates tabs, reads images, creates workers or registers feature listeners", async (t) => {
  const state = await setup(t, { enabled: false });
  assert.equal(state.calls.length, 0);
  assert.equal(state.document.querySelector("canvas"), null);
  assert.equal(state.chrome.runtime.onMessage.listeners.size, 0);
  assert.equal(state.chrome.storage.onChanged.listeners.size, 0);
});

test("explicit image selection/capture precedes local OCR, separate consent sends only edited lines", async (t) => {
  const state = await setup(t);
  assert.equal(state.calls.length, 0);
  await state.click("Activate tab & choose image");
  assert(state.calls.some(([name]) => name === "activate"));
  assert(state.calls.some(([name]) => name === "focus"));
  assert(!state.calls.some(([name]) => name === "ocr" || name === "translate"));
  assert.equal(state.document.querySelector("canvas").width, 200);
  await state.click("Confirm preview & run local OCR");
  assert(state.calls.some(([name]) => name === "terminate"));
  const text = state.document.querySelector("textarea");
  assert.equal(text.value, "<img src=x onerror=alert(1)>");
  assert.equal(state.document.querySelector("img"), null);
  assert.equal(state.button("Translate reviewed lines").disabled, true);
  state.consent();
  text.value = "Edited only";
  text.dispatchEvent(new state.window.Event("input", { bubbles: true }));
  assert.equal(state.checks()[1].checked, false);
  assert.equal(state.button("Translate reviewed lines").disabled, true);
  state.consent();
  await state.click("Translate reviewed lines");
  const [, sent, options] = state.calls.find(([name]) => name === "translate");
  assert.deepEqual(JSON.parse(sent), [{ id: "line-1", text: "Edited only" }]);
  assert.equal(options.ephemeral, true);
  assert.equal(options.skipHistory, true);
  assert.equal(options.labFeature, "image");
  assert.equal(options.siteUrl, state.tab.url);
  assert.doesNotMatch(sent, /base64|bbox/);
  assert.equal(state.document.querySelector("script"), null);
  assert.equal(state.checks()[1].checked, false);
  assert.equal(state.button("Show translated").disabled, false);
  await state.click("Show translated");
  const shown = state.calls.find(
    ([name, , payload]) => name === "source" && payload.command === "show"
  );
  assert.equal(shown[2].lines[0].text, "<script>dịch</script>");
  assert.equal(shown[2].lines[0].bbox.x, 0.1 + 0.05 * 0.8);
  await state.click("Show original");
  assert(
    state.calls.some(
      ([name, , payload]) => name === "source" && payload.command === "original"
    )
  );
});

test("local preview masks destroy pixels, crop preserves normalized bbox mapping and resets OCR/consent", async (t) => {
  const state = await setup(t);
  await state.click("Activate tab & choose image");
  await state.click("Confirm preview & run local OCR");
  state.consent();
  const numbers = [...state.document.querySelectorAll('input[type="number"]')];
  for (const [index, value] of [20, 10, 100, 50].entries())
    numbers[index].value = String(value);
  await state.click("Crop rectangle");
  assert.equal(state.checks()[1].checked, false);
  assert.equal(state.document.querySelector("textarea"), null);
  assert.equal(state.document.querySelector("canvas").width, 100);
  await state.click("Confirm preview & run local OCR");
  state.consent();
  await state.click("Translate reviewed lines");
  await state.click("Show translated");
  const shown = state.calls.find(
    ([name, , payload]) => name === "source" && payload.command === "show"
  );
  assert.equal(shown[2].lines[0].bbox.x, 0.1 + 0.1 * 0.8 + 0.1 * 0.4);
  await state.click("Mask rectangle");
  assert.equal(state.document.querySelector("textarea"), null);
  assert.equal(state.checks()[1].checked, false);
  const pixels = state.calls.filter(([name]) => name === "pixels").at(-1)[1];
  assert.deepEqual([...pixels.data.slice(0, 4)], [0, 0, 0, 255]);
});

test("privacy change resets consent, malformed mapping never enables overlay", async (t) => {
  const state = await setup(t, {
    translate: async () => '[{"id":"wrong-id","text":"bad"}]'
  });
  await state.click("Activate tab & choose image");
  await state.click("Confirm preview & run local OCR");
  state.consent();
  state.checks()[0].checked = true;
  state.checks()[0].dispatchEvent(new state.window.Event("change"));
  assert.equal(state.checks()[1].checked, false);
  state.consent();
  await state.click("Translate reviewed lines");
  assert.equal(
    state.calls.find(([name]) => name === "translate")[2].privacyPolicy,
    "local-only"
  );
  assert.equal(state.button("Show translated").disabled, true);
  assert.match(
    state.document.querySelector('[role="status"]').textContent,
    /image-translation-mapping/
  );
  assert(
    !state.calls.some(
      ([name, , payload]) => name === "source" && payload.command === "show"
    )
  );
});

test("flag off during local OCR terminates worker and drops late text", async (t) => {
  let finish;
  const state = await setup(t, {
    recognize: () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  });
  await state.click("Activate tab & choose image");
  state.button("Confirm preview & run local OCR").click();
  await settle();
  assert.equal(typeof finish, "function");
  state.config.labFeatures.image = false;
  state.chrome.storage.onChanged.emit(
    { translatorSettings: { newValue: state.config } },
    "local"
  );
  assert(state.calls.some(([name]) => name === "terminate"));
  assert.equal(state.document.querySelector("canvas").width, 0);
  finish({ lines: [{ text: "LATE", bbox: { x0: 1, y0: 1, x1: 50, y1: 20 } }] });
  await settle();
  assert.equal(state.document.querySelector("textarea"), null);
  assert.equal(state.button("Activate tab & choose image").disabled, true);
  assert(!state.calls.some(([name]) => name === "translate"));
});

test("content invalidation promptly cancels worker owner; forged sender cannot clear it", async (t) => {
  const state = await setup(t);
  await state.click("Activate tab & choose image");
  await state.click("Confirm preview & run local OCR");
  const message = { type: "labs-image-invalidated", imageId: state.source.id };
  state.chrome.runtime.onMessage.emit(message, {
    id: "extension",
    tab: { id: 99 }
  });
  assert.equal(state.document.querySelector("canvas").width, 200);
  state.chrome.runtime.onMessage.emit(message, {
    id: "extension",
    tab: { id: 7 }
  });
  await settle();
  assert.equal(state.document.querySelector("canvas").width, 0);
  assert.equal(state.document.querySelector("textarea"), null);
  assert(
    state.calls.some(
      ([name, , payload]) => name === "source" && payload.command === "restore"
    )
  );
});

test("Restore drops late provider text and clears all local state; teardown unregisters listeners", async (t) => {
  let finish;
  const state = await setup(t, {
    translate: () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  });
  await state.click("Activate tab & choose image");
  await state.click("Confirm preview & run local OCR");
  state.consent();
  state.button("Translate reviewed lines").click();
  await settle();
  await state.click("Restore & clear");
  assert.equal(state.document.querySelector("canvas").width, 0);
  assert.equal(state.document.querySelector("textarea"), null);
  finish('[{"id":"line-1","text":"LATE"}]');
  await settle();
  assert.equal(state.button("Show translated").disabled, true);
  assert.doesNotMatch(state.document.body.textContent, /LATE/);
  state.cleanup();
  assert.equal(state.chrome.runtime.onMessage.listeners.size, 0);
  assert.equal(state.chrome.storage.onChanged.listeners.size, 0);
});

test("selected-tab URL change before OCR prevents a worker or provider request", async (t) => {
  const state = await setup(t);
  await state.click("Activate tab & choose image");
  state.tab.url = "https://other.test";
  await state.click("Confirm preview & run local OCR");
  assert(
    !state.calls.some(([name]) => name === "worker" || name === "translate")
  );
  assert.match(
    state.document.querySelector('[role="status"]').textContent,
    /image-stale/
  );
});
