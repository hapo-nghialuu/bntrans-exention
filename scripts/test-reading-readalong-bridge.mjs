import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const script = readFileSync(
  new URL(
    "../extension/src/experimental/content-readalong.js",
    import.meta.url
  ),
  "utf8"
);
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
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
function fixture(t, enabled = true) {
  const dom = new JSDOM(
    "<main><p>PUBLIC</p><p contenteditable>PRIVATE</p></main>",
    { url: "https://work.test/article", runScripts: "outside-only" }
  );
  const connect = event(),
    storage = event();
  let reads = 0;
  const settings = { enabled: true, labFeatures: { readalong: enabled } };
  dom.window.chrome = {
    runtime: {
      id: "self",
      getURL: (path) => `chrome-extension://self/${path}`,
      onConnect: connect
    },
    storage: {
      local: {
        get: async () => {
          reads++;
          return { translatorSettings: settings };
        }
      },
      onChanged: storage
    }
  };
  new vm.Script(script).runInContext(dom.getInternalVMContext());
  function open(
    sender = { id: "self", url: "chrome-extension://self/pages/labs.html" },
    name = "bntrans-readalong"
  ) {
    const onMessage = event(),
      onDisconnect = event(),
      sent = [];
    let disconnects = 0;
    const port = {
      sender,
      name,
      onMessage,
      onDisconnect,
      postMessage: (value) => sent.push(value),
      disconnect: () => {
        disconnects++;
      }
    };
    connect.emit(port);
    return {
      ...port,
      sent,
      disconnects: () => disconnects,
      send: (payload = {}) =>
        onMessage.emit({
          command: "watch",
          snapshotId: "snapshot",
          url: dom.window.location.href,
          ...payload
        })
    };
  }
  t.after(() => {
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    dom.window.close();
  });
  return { dom, open, connect, storage, settings, reads: () => reads };
}

test("classic monitor is inert until an authenticated extension port explicitly watches", async (t) => {
  const h = fixture(t);
  h.dom.window.document.querySelector("p").textContent =
    "Changed before any watch";
  await flush();
  assert.equal(h.reads(), 0);
  for (const sender of [
    { id: "other", url: "chrome-extension://self/pages/labs.html" },
    { id: "self", url: "https://work.test" },
    { id: "self", url: "chrome-extension://self/pages/labs.html", tab: {} }
  ]) {
    const port = h.open(sender);
    port.send();
    assert.equal(port.onMessage.listeners.size, 0);
  }
  const unknown = h.open(undefined, "another-port");
  unknown.send();
  assert.equal(h.reads(), 0);
  const port = h.open();
  assert.equal(h.reads(), 0);
  port.send();
  await flush();
  assert.equal(port.sent[0].type, "ready");
  assert.equal(h.reads(), 1);
  assert.doesNotMatch(JSON.stringify(port.sent), /PUBLIC|PRIVATE|Changed/);
});

test("feature-off, wrong URL and malformed watch cannot create an observer session", async (t) => {
  const h = fixture(t, false);
  for (const payload of [
    {},
    { url: "https://other.test" },
    { snapshotId: "" },
    { command: "capture" }
  ]) {
    const port = h.open();
    port.send(payload);
    await flush();
    assert.equal(port.sent[0].type, "invalidated");
    assert.equal(port.onMessage.listeners.size, 0);
    assert.equal(port.disconnects(), 1);
  }
});

test("monitor conservatively invalidates on mutation without sending any page text", async (t) => {
  const h = fixture(t);
  const port = h.open();
  port.send();
  await flush();
  h.dom.window.document.querySelector("p").setAttribute("translate", "no");
  await flush();
  assert.deepEqual(
    port.sent.map((value) => value.type),
    ["ready", "invalidated"]
  );
  assert.equal(port.onMessage.listeners.size, 0);
  assert.equal(port.onDisconnect.listeners.size, 0);
  assert.equal(port.disconnects(), 1);
  h.dom.window.document.querySelector("p").textContent = "PRIVATE AFTER STOP";
  await flush();
  assert.equal(port.sent.length, 2);
});

test("flag changes, routes and pagehide close active ports and remove global listeners", async (t) => {
  const h = fixture(t);
  for (const trigger of [
    () => h.storage.emit({ translatorSettings: {} }, "local"),
    () => h.dom.window.dispatchEvent(new h.dom.window.Event("popstate")),
    () => h.dom.window.dispatchEvent(new h.dom.window.Event("hashchange")),
    () => h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"))
  ]) {
    const port = h.open();
    port.send();
    await flush();
    trigger();
    await flush();
    assert.equal(port.sent.at(-1).type, "invalidated");
    assert.equal(port.onMessage.listeners.size, 0);
  }
  assert.equal(h.storage.listeners.size, 0);
  assert.equal(h.connect.listeners.size, 0);
});

test("disconnect before pending settings prevents late observer installation", async (t) => {
  const h = fixture(t);
  let resolve;
  h.dom.window.chrome.storage.local.get = () =>
    new Promise((done) => {
      resolve = done;
    });
  const port = h.open();
  port.send();
  port.onDisconnect.emit();
  resolve({ translatorSettings: h.settings });
  await flush();
  h.dom.window.document.querySelector("p").textContent = "Later change";
  await flush();
  assert.equal(port.sent.length, 0);
  assert.equal(port.onMessage.listeners.size, 0);
});

test("readalong engine contains no clock-based progression or network speech path", () => {
  const engine = readFileSync(
    new URL(
      "../extension/src/experimental/readalong-engine.js",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(
    engine,
    /setTimeout|setInterval|fetch\(|Audio\(|https?:/u
  );
  assert.match(engine, /localService === true/u);
  assert.match(engine, /utterance\.onend/u);
});
