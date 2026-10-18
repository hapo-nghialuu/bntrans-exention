import test from "node:test";
import assert from "node:assert/strict";
import { registerImageHandlers } from "../extension/src/experimental/background-images.js";

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
const png = (width, height) => {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};
const dataUrl = (bytes) =>
  `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
function setup(t, overrides = {}) {
  const source = {
    id: "image-1",
    url: "https://example.test/article",
    src: "https://cdn.test/a.png",
    width: 200,
    height: 100,
    rect: { x: 10, y: 20, width: 200, height: 100 },
    viewport: { width: 800, height: 600, scale: 1, offsetLeft: 0, offsetTop: 0 }
  };
  const tab = { id: 7, windowId: 3, active: true, url: source.url };
  const win = { id: 3, focused: true };
  const calls = [],
    bitmap = {
      width: 1600,
      height: 1200,
      close() {
        calls.push(["close"]);
      }
    };
  const chromeApi = {
    runtime: {
      id: "extension",
      getURL: (path) => `chrome-extension://extension/${path}`,
      onMessage: event()
    },
    storage: { onChanged: event() },
    windows: { get: async () => ({ ...win }), onFocusChanged: event() },
    tabs: {
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
      get: async () => ({ ...tab }),
      query: async () => [{ ...tab }],
      sendMessage: async (id, message, options) => {
        calls.push(["validate", id, message, options]);
        return overrides.validate
          ? overrides.validate(source, calls)
          : { ok: true, source: structuredClone(source) };
      },
      captureVisibleTab: async (...args) => {
        calls.push(["capture", ...args]);
        await overrides.capture?.({ tab, win, source, chromeApi });
        return dataUrl(png(1600, 1200));
      }
    }
  };
  const dispose = registerImageHandlers({
    chromeApi,
    settings: async () =>
      overrides.settings || { enabled: true, labFeatures: { image: true } },
    createBitmap: async () => {
      await overrides.decode?.({ chromeApi, source });
      return bitmap;
    },
    Canvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        calls.push(["canvas", width, height]);
      }
      getContext() {
        return { drawImage: (...args) => calls.push(["draw", ...args]) };
      }
      async convertToBlob() {
        return new Blob([png(this.width, this.height)], { type: "image/png" });
      }
    }
  });
  t.after(dispose);
  const payload = {
    tabId: tab.id,
    windowId: win.id,
    url: tab.url,
    imageId: source.id
  };
  const sender = {
    id: "extension",
    url: "chrome-extension://extension/pages/labs.html"
  };
  const send = (patch = {}, senderPatch = {}) =>
    new Promise((resolve) => {
      const listener = [...chromeApi.runtime.onMessage.listeners][0];
      assert.equal(
        listener(
          { type: "labs-image-capture", payload: { ...payload, ...patch } },
          { ...sender, ...senderPatch },
          resolve
        ),
        true
      );
    });
  return { send, calls, source, tab, win, chromeApi, dispose };
}

test("capture verifies pinned active tab/window/url before and after; returns only cropped PNG", async (t) => {
  const { send, calls } = setup(t);
  assert.equal(calls.length, 0);
  const result = await send();
  assert.equal(result.ok, true);
  assert.deepEqual([result.width, result.height], [400, 200]);
  assert.deepEqual(result.region, { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(result.dataUrl, dataUrl(png(400, 200)));
  assert.notEqual(result.dataUrl, dataUrl(png(1600, 1200)));
  assert.deepEqual(
    calls.find(([name]) => name === "capture"),
    ["capture", 3, { format: "png" }]
  );
  assert.deepEqual(
    calls.find(([name]) => name === "draw").slice(2),
    [20, 40, 400, 200, 0, 0, 400, 200]
  );
  assert.equal(calls.at(-1)[0], "close");
  const validations = calls.filter(([name]) => name === "validate");
  assert.equal(validations.length, 3);
  for (const [, id, message, options] of validations) {
    assert.equal(id, 7);
    assert.deepEqual(options, { frameId: 0 });
    assert.deepEqual(message, {
      type: "labs-image-source",
      payload: { command: "validate", id: "image-1" }
    });
  }
});

test("website/content senders and invalid targets cannot capture", async (t) => {
  const { send, calls } = setup(t);
  for (const sender of [
    { id: "other" },
    { tab: { id: 7 } },
    { url: "https://example.test" },
    { url: "chrome-extension://extension/src/background.js" }
  ])
    assert.equal((await send({}, sender)).error, "image-sender");
  assert.equal((await send({ tabId: "7" })).error, "image-target");
  assert(!calls.some(([name]) => name === "capture"));
});

test("inactive, wrong window/url, unfocused and disabled cases refuse before Chrome capture", async (t) => {
  const state = setup(t);
  for (const [target, key, value] of [
    [state.tab, "active", false],
    [state.tab, "windowId", 4],
    [state.tab, "url", "https://other.test"],
    [state.win, "focused", false]
  ]) {
    const original = target[key];
    target[key] = value;
    assert.equal((await state.send()).error, "image-tab-not-active");
    target[key] = original;
  }
  const disabled = setup(t, { settings: { labFeatures: { image: false } } });
  assert.equal((await disabled.send()).error, "image-disabled");
  assert(!state.calls.some(([name]) => name === "capture"));
  assert(!disabled.calls.some(([name]) => name === "capture"));
});

test("tab changes during capture discard screenshot, never decode/deliver it", async (t) => {
  const { send, calls } = setup(t, {
    capture: ({ tab }) => {
      tab.url = "https://other.test";
    }
  });
  assert.equal((await send()).error, "image-tab-not-active");
  assert(!calls.some(([name]) => name === "draw"));
});

test("switching away and back still invalidates the operation by activation epoch", async (t) => {
  const { send, calls } = setup(t, {
    capture: ({ chromeApi }) =>
      chromeApi.tabs.onActivated.emit({ tabId: 8, windowId: 3 })
  });
  assert.equal((await send()).error, "image-cancelled");
  assert(!calls.some(([name]) => name === "draw"));
});

test("image src/geometry changes during capture are rejected before OCR pixels are returned", async (t) => {
  let validation = 0;
  const { send, calls } = setup(t, {
    validate: (source) => {
      validation++;
      return {
        ok: true,
        source: {
          ...structuredClone(source),
          src: validation > 1 ? "https://cdn.test/changed.png" : source.src
        }
      };
    }
  });
  assert.equal((await send()).error, "image-stale");
  assert(!calls.some(([name]) => name === "draw"));
});

test("content refusal (protected/clipped/obscured) does not invoke capture", async (t) => {
  const { send, calls } = setup(t, {
    validate: () => ({ ok: false, error: "image-obscured" })
  });
  assert.equal((await send()).error, "image-obscured");
  assert(!calls.some(([name]) => name === "capture"));
});

test("flag off while decoding discards late pixels and closes bitmap", async (t) => {
  const { send, calls } = setup(t, {
    decode: ({ chromeApi }) =>
      chromeApi.storage.onChanged.emit(
        { translatorSettings: { newValue: { labFeatures: { image: false } } } },
        "local"
      )
  });
  assert.equal((await send()).error, "image-cancelled");
  assert.equal(calls.at(-1)[0], "close");
});

test("dispose removes message, tab, window and storage listeners", (t) => {
  const { chromeApi, dispose } = setup(t);
  dispose();
  for (const event of [
    chromeApi.runtime.onMessage,
    chromeApi.storage.onChanged,
    chromeApi.tabs.onActivated,
    chromeApi.tabs.onUpdated,
    chromeApi.tabs.onRemoved,
    chromeApi.windows.onFocusChanged
  ])
    assert.equal(event.listeners.size, 0);
});
