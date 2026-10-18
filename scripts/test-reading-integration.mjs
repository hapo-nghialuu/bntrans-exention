import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../extension/", import.meta.url);
const features = ["corrections", "ask", "image", "compare", "readalong"];
const tick = () => new Promise((resolve) => setImmediate(resolve));
function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => {
      for (const fn of [...listeners]) fn(...args);
    }
  };
}
function png(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("integrated background and Labs use real ESM wiring without provider traffic", async (t) => {
  const names = [
    "chrome",
    "fetch",
    "createImageBitmap",
    "OffscreenCanvas",
    "window",
    "document",
    "location",
    "matchMedia"
  ];
  const previous = names.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name)
  ]);
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const tab = {
    id: 7,
    windowId: 3,
    active: true,
    url: "https://work.test/article",
    title: "Synthetic website"
  };
  const local = {
    id: "local",
    name: "Local",
    type: "ollama",
    config: { baseUrl: "http://localhost:11434/v1", model: "configured" }
  };
  const state = {
    translatorSettings: {
      enabled: true,
      labFeatures: Object.fromEntries(features.map((id) => [id, true])),
      providers: [local],
      activeProviderId: "local",
      interfaceLanguage: "vi",
      nativeLanguageCode: "vi"
    }
  };
  const sender = {
    id: "integration",
    url: "chrome-extension://integration/pages/labs.html"
  };
  const source = {
    id: "image-1",
    url: tab.url,
    src: "https://cdn.test/example.png",
    width: 100,
    height: 50,
    rect: { x: 10, y: 20, width: 100, height: 50 },
    viewport: { width: 800, height: 600, scale: 1, offsetLeft: 0, offsetTop: 0 }
  };
  const calls = [],
    writes = [],
    crops = [],
    network = [];
  let output = "Synthetic output",
    captureHook,
    bitmapClosed = 0;
  const chromeApi = {
    runtime: {
      id: sender.id,
      getURL: (path) => `chrome-extension://integration/${path}`,
      getContexts: async () => [],
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
      sendMessage(message) {
        return dispatch(message);
      }
    },
    storage: {
      onChanged: event(),
      local: {
        get: async (key) => ({ [key]: structuredClone(state[key]) }),
        async set(values) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: state[key], newValue: value };
            state[key] = structuredClone(value);
          }
          writes.push(structuredClone(values));
          chromeApi.storage.onChanged.emit(changes, "local");
        }
      }
    },
    tabs: {
      get: async () => ({ ...tab }),
      query: async () => [{ ...tab }],
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
      async sendMessage(id, message, options) {
        calls.push({ id, message, options });
        if (message.type === "labs-image-source")
          return { ok: true, source: structuredClone(source) };
        if (message.type === "labs-corrections-page") return { ok: true };
        throw new Error("Unexpected automatic source access");
      },
      async captureVisibleTab() {
        await captureHook?.();
        return `data:image/png;base64,${Buffer.from(png(800, 600)).toString("base64")}`;
      }
    },
    windows: {
      get: async () => ({ id: 3, focused: true }),
      onFocusChanged: event()
    },
    contextMenus: {
      remove: (_id, done) => done(),
      create: (_item, done) => done(),
      update: (_id, _item, done) => done(),
      onClicked: event()
    }
  };
  function dispatch(message, origin = sender) {
    return new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of chromeApi.runtime.onMessage.listeners)
        if (listener(message, origin, resolve) === true) handled = true;
      if (!handled) reject(new Error(`Unhandled: ${message.type}`));
    });
  }
  const translate = (payload, origin = sender) =>
    dispatch(
      {
        type: "translate",
        payload: {
          text: "Synthetic source",
          sourceLanguage: "en",
          targetLanguage: "vi",
          ...payload
        }
      },
      origin
    );
  globalThis.chrome = chromeApi;
  globalThis.fetch = async (url, options) => {
    network.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: output } }] })
    };
  };
  globalThis.createImageBitmap = async () => ({
    width: 800,
    height: 600,
    close: () => bitmapClosed++
  });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return { drawImage: (...args) => crops.push(args.slice(1)) };
    }
    async convertToBlob() {
      return new Blob([png(this.width, this.height)], { type: "image/png" });
    }
  };
  await import("../extension/src/background.js");
  await tick();

  await t.test(
    "manifest resolves every bridge and its transitive content imports",
    () => {
      const manifest = JSON.parse(readFileSync(new URL("manifest.json", root)));
      const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
      for (const path of scripts)
        assert.ok(existsSync(new URL(path, root)), path);
      const resources = manifest.web_accessible_resources.flatMap(
        (entry) => entry.resources
      );
      for (const name of [
        "reading-context",
        "image-translation-utils",
        "ocr-utils"
      ])
        assert.ok(resources.includes(`src/experimental/${name}.js`), name);
      assert.deepEqual(manifest.permissions, [
        "storage",
        "offscreen",
        "contextMenus",
        "sidePanel"
      ]);
      assert.equal(network.length, 0);
      assert.equal(calls.length, 0);
      assert.equal(writes.length, 0);
    }
  );

  await t.test(
    "registered image handler responds through real background and crops only chosen image",
    async () => {
      const result = await dispatch({
        type: "labs-image-capture",
        payload: { tabId: 7, windowId: 3, url: tab.url, imageId: source.id }
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.width, 100);
      assert.equal(result.height, 50);
      assert.deepEqual(crops[0], [10, 20, 100, 50, 0, 0, 100, 50]);
      assert.equal(bitmapClosed, 1);
      assert.ok(calls.every((call) => call.options.frameId === 0));
      assert.equal(network.length, 0);
      assert.equal(writes.length, 0);
      captureHook = () => chromeApi.tabs.onActivated.emit({ tabId: 8 });
      const stale = await dispatch({
        type: "labs-image-capture",
        payload: { tabId: 7, windowId: 3, url: tab.url, imageId: source.id }
      });
      assert.equal(stale.ok, false);
      assert.match(stale.error, /cancelled/);
      captureHook = null;
    }
  );

  await t.test(
    "reading requests reject content scripts, foreign IDs and non-page origins before provider access",
    async () => {
      for (const origin of [
        {},
        { ...sender, id: "other" },
        { ...sender, tab: { ...tab }, frameId: 0 },
        { ...sender, url: "https://work.test/" },
        { ...sender, url: "chrome-extension://integration/untrusted.html" }
      ]) {
        const result = await translate(
          { labFeature: "ask", siteUrl: "" },
          origin
        );
        assert.equal(result.ok, false);
        assert.match(result.error, /extension page/);
      }
      assert.equal(network.length, 0);
    }
  );

  await t.test(
    "request-only model config and plain JSON remain isolated from settings/cache/history",
    async () => {
      const original = structuredClone(state);
      output = '{"answer":"<p>Synthetic</p>","citations":[]}';
      for (const model of ["model-a", "model-b"]) {
        const result = await translate({
          labFeature: "compare",
          task: "compare",
          text: "<p>Synthetic source</p>",
          model,
          siteUrl: "",
          ephemeral: false,
          skipHistory: false
        });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.result.translation, output);
      }
      assert.deepEqual(
        network.map((call) => call.body.model),
        ["model-a", "model-b"]
      );
      assert.deepEqual(state, original);
      assert.equal(writes.length, 0);
    }
  );

  await t.test(
    "correction save is explicit, exact-origin scoped and connected to normal translation lookup",
    async () => {
      const entry = {
        text: "Synthetic corrected source",
        translation: "Synthetic correction",
        sourceLanguage: "en",
        targetLanguage: "vi",
        scope: "https://attacker.test",
        hostname: "attacker.test"
      };
      const page = { ...sender, tab: { ...tab }, frameId: 0 };
      const payload = {
        command: "save",
        entry,
        url: tab.url,
        token: "editor-1"
      };
      const denied = await dispatch(
        { type: "labs-corrections", payload },
        page
      );
      assert.equal(denied.ok, false);
      const saved = await dispatch(
        {
          type: "labs-corrections",
          payload: { ...payload, explicitSave: true }
        },
        page
      );
      assert.equal(saved.ok, true, saved.error);
      assert.equal(saved.entry.scope, "https://work.test");
      assert.equal(saved.entry.hostname, "work.test");
      const before = network.length;
      const remembered = await translate({ text: entry.text }, page);
      assert.equal(remembered.result.translation, entry.translation);
      assert.equal(remembered.result.correction, true);
      assert.equal(network.length, before);
      const otherOrigin = await translate(
        { text: entry.text, ephemeral: true },
        { ...page, tab: { ...tab, url: "http://work.test/article" } }
      );
      assert.equal(otherOrigin.result.correction, undefined);
      assert.equal(network.length, before + 1);
      const clear = await dispatch({
        type: "labs-corrections",
        payload: { command: "clear" }
      });
      assert.equal(clear.ok, true);
      assert.deepEqual(state["bntransLabs:corrections"].items, []);
    }
  );

  await t.test(
    "all five real Labs modules mount only after explicit opt-in without reading sources or sending text",
    async () => {
      state.translatorSettings.labFeatures = Object.fromEntries(
        features.map((id) => [id, false])
      );
      const dom = new JSDOM(
        readFileSync(new URL("pages/labs.html", root), "utf8"),
        {
          url: `${sender.url}#corrections`
        }
      );
      const win = dom.window;
      t.after(() => win.close());
      globalThis.window = win;
      globalThis.document = win.document;
      globalThis.location = win.location;
      globalThis.matchMedia = () => ({ matches: false });
      const before = {
        calls: calls.length,
        network: network.length,
        writes: writes.length
      };
      await import("../extension/src/experimental/labs.js");
      const workspace = win.document.getElementById("lab-workspace");
      const waitReady = async (id, enabled) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          await tick();
          const toggle = win.document.getElementById(`lab-enable-${id}`);
          if (
            toggle?.checked === enabled &&
            workspace.getAttribute("aria-busy") === "false" &&
            (enabled
              ? workspace.querySelector(".lab-panel")?.children.length
              : workspace.querySelector(".lab-empty"))
          )
            return toggle;
        }
        assert.fail(
          `Workspace did not mount ${id}: ${win.document.getElementById("lab-status").textContent}`
        );
      };
      for (const id of features) {
        win.location.hash = id;
        const toggle = await waitReady(id, false);
        toggle.checked = true;
        toggle.dispatchEvent(new win.Event("change", { bubbles: true }));
        await waitReady(id, true);
        assert.ok(workspace.querySelector("button"), id);
        assert.equal(
          win.document.getElementById("lab-status").dataset.kind === "error",
          false
        );
        assert.equal(state.translatorSettings.labFeatures[id], true);
      }
      win.dispatchEvent(new win.Event("pagehide"));
      await tick();
      assert.equal(calls.length, before.calls);
      assert.equal(network.length, before.network);
      const added = writes.slice(before.writes);
      assert.equal(added.length, 5);
      assert.ok(
        added.every(
          (write) => Object.keys(write).join() === "translatorSettings"
        )
      );
    }
  );
});
