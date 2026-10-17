import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../extension/src/experimental/content-media.js", import.meta.url),
  "utf8"
);
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

class Node {
  constructor(text = "") {
    this.innerText = text;
    this.textContent = text;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.events = new Map();
    this.shown = true;
    this.isConnected = true;
  }
  getClientRects() {
    return this.shown ? [{}] : [];
  }
  closest() {
    return null;
  }
  contains(node) {
    return this.children.includes(node);
  }
  setAttribute() {}
  appendChild(node) {
    this.children.push(node);
    node.parent = this;
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (node) => node !== this
      );
    this.isConnected = false;
  }
  addEventListener(type, callback) {
    if (!this.events.has(type)) this.events.set(type, new Set());
    this.events.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this.events.get(type)?.delete(callback);
  }
  dispatch(type) {
    for (const callback of [...(this.events.get(type) || [])]) callback();
  }
}

function harness({ host = "www.youtube.com", enabled = true, translate } = {}) {
  const body = new Node();
  const caption = new Node();
  const speaker = new Node("Alice");
  const root = new Node();
  const video = new Node();
  video.currentTime = 10;
  video.duration = 100;
  video.play = async () => {
    video.played = true;
  };
  video.pause = () => {
    video.paused = true;
  };
  let rootPresent = true;
  let observer = null;
  let onMessage;
  let onSettings;
  let config = {
    labFeatures: { media: enabled },
    nativeLanguageCode: "vi",
    targetLanguageCode: "en"
  };
  const requests = [];
  const scheduled = new Map();
  const intervals = new Map();
  let counter = 0;
  let now = 1000;
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const location = {
    hostname: host,
    origin: `https://${host}`,
    pathname: host === "meet.google.com" ? "/abc-defg-hij" : "/watch",
    search: "?v=one",
    href: `https://${host}/watch?v=one`
  };
  const selectors = {
    ".ytp-caption-segment": [caption],
    ".player-timedtext-text-container": [caption],
    ".a4cQT .ygicle, .a4cQT .bh44bd, [role='region'][aria-label='Captions'] .ygicle, .iTTPOb":
      [caption],
    ".zs7s8d": [speaker]
  };
  const doc = {
    body,
    dispatchEvent() {},
    fullscreenElement: null,
    querySelectorAll: (selector) => selectors[selector] || [],
    querySelector: (selector) =>
      selector === "video" ? video : rootPresent ? root : null,
    createElement: () => new Node()
  };
  const win = new Node();
  win.top = win;
  const context = vm.createContext({
    console,
    Intl,
    URLSearchParams,
    Date: Clock,
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    document: doc,
    window: win,
    location,
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1"
    }),
    setTimeout: (fn) => {
      scheduled.set(++counter, fn);
      return counter;
    },
    clearTimeout: (id) => scheduled.delete(id),
    setInterval: (fn) => {
      intervals.set(++counter, fn);
      return counter;
    },
    clearInterval: (id) => intervals.delete(id),
    MutationObserver: class {
      constructor(callback) {
        observer = this;
        this.callback = callback;
      }
      observe() {
        this.active = true;
      }
      disconnect() {
        this.active = false;
      }
    },
    chrome: {
      runtime: {
        id: "test-extension",
        onMessage: {
          addListener: (callback) => {
            onMessage = callback;
          }
        },
        sendMessage: async (message) => {
          requests.push(message);
          return translate
            ? translate(message)
            : { ok: true, result: { translation: "Bản dịch" } };
        }
      },
      storage: {
        local: {
          get: async () => ({ translatorSettings: config }),
          set: () => {
            throw new Error("Live captions must not persist");
          }
        },
        onChanged: {
          addListener: (callback) => {
            onSettings = callback;
          }
        }
      }
    }
  });
  vm.runInContext(source, context);
  const command = (command, payload = {}, sender = { id: "test-extension" }) =>
    new Promise((resolve) =>
      onMessage(
        { type: "labs-media-command", payload: { command, ...payload } },
        sender,
        resolve
      )
    );
  const mutate = async (text, time = video.currentTime) => {
    caption.innerText = text;
    video.currentTime = time;
    if (observer?.active) observer.callback([{ target: caption }]);
    await settle();
  };
  return {
    api: context.BNTransMedia,
    command,
    mutate,
    requests,
    body,
    video,
    win,
    location,
    caption,
    root,
    get observer() {
      return observer;
    },
    get intervalCount() {
      return intervals.size;
    },
    async flush() {
      for (const fn of [...scheduled.values()]) fn();
      await settle();
    },
    async tick(ms = 500) {
      now += ms;
      for (const fn of [...intervals.values()]) fn();
      await settle();
    },
    async settings(patch) {
      config = { ...config, ...patch };
      onSettings({ translatorSettings: { newValue: config } }, "local");
      await settle();
    },
    noCaptionRoot() {
      rootPresent = false;
    }
  };
}

test("default inactive, disabled flag rejects start and untrusted sender rejected", async () => {
  const h = harness({ enabled: false });
  assert.equal(h.observer, null);
  await h.mutate("Private text.");
  assert.equal(h.requests.length, 0);
  assert.equal((await h.command("start")).ok, false);
  assert.equal(
    (await h.command("start", {}, { id: "test-extension", tab: { id: 1 } })).ok,
    false
  );
  assert.equal(h.requests.length, 0);
});

for (const host of ["www.youtube.com", "www.netflix.com"]) {
  test(`${host}: real observer groups two fragments into one request and cleans up`, async () => {
    const h = harness({ host });
    const started = await h.command("start");
    assert.equal(started.ok, true);
    assert.equal(h.observer.active, true);
    await h.mutate("Hello", 10);
    assert.equal(h.requests.length, 0);
    await h.mutate("world.", 11);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].payload.text, "Hello\nworld.");
    assert.equal(h.requests[0].payload.skipHistory, true);
    assert.equal(h.requests[0].payload.siteUrl, h.location.href);
    assert.equal(h.requests[0].payload.context, "");
    assert.equal(h.requests[0].payload.ephemeral, true);
    const snapshot = await h.command("snapshot");
    assert.equal(snapshot.cues.length, 1);
    assert.equal(snapshot.cues[0].translation, "Bản dịch");
    assert.equal(snapshot.requests, 1);
    assert.equal(snapshot.observations, 2);
    assert.equal(h.body.children.length, 1);
    await h.command("stop");
    assert.equal(h.observer.active, false);
    assert.equal(h.intervalCount, 0);
    assert.equal(h.body.children.length, 0);
    await h.mutate("No request after stop.");
    assert.equal(h.requests.length, 1);
  });
}

test("grouping timeout, punctuation, overlap and speaker separation deterministic", () => {
  const h = harness();
  const groups = [];
  let timeout;
  const grouper = h.api.createGrouper({
    emit: (group) => groups.push(group),
    schedule: (fn, delay) => {
      assert.equal(delay, 900);
      timeout = fn;
      return 1;
    },
    unschedule() {}
  });
  grouper.push({ text: "I like", speaker: "A", key: "1" });
  grouper.push({ text: "I like tea", speaker: "A", key: "2" });
  assert.equal(groups.length, 0);
  timeout();
  assert.equal(groups[0].text, "I like tea");
  grouper.push({ text: "こんにちは。", speaker: "A", key: "3" });
  assert.equal(groups.length, 2);
  grouper.push({ text: "Unfinished", speaker: "A", key: "4" });
  grouper.push({ text: "Different", speaker: "B", key: "5" });
  assert.equal(groups.length, 3);
  grouper.clear();
  timeout();
  assert.equal(groups.length, 3);
  assert.equal(h.api.mergeText("one two", "two three"), "one two three");
  assert.equal(h.api.sentenceEnded("你好！", "zh"), true);
  assert.equal(h.api.sentenceEnded("hello", "en"), false);
  assert.equal(h.api.sentenceEnded("Hello!", "bad_locale"), true);
});

test("seek discards pending response, clears timeline and replay pauses at real cue end", async () => {
  let resolve;
  const h = harness({
    translate: () =>
      new Promise((r) => {
        resolve = r;
      })
  });
  await h.command("start");
  await h.mutate("Old sentence.");
  await h.command("seek", { time: 30 });
  resolve({ ok: true, result: { translation: "STALE" } });
  await settle();
  assert.equal((await h.command("snapshot")).cues.length, 0);
  assert.equal(h.body.children.length, 0);
  await h.command("replay", { time: 1, options: { end: 3 } });
  h.video.dispatch("seeking");
  assert.equal(h.video.currentTime, 1);
  assert.equal(h.video.played, true);
  h.video.currentTime = 3;
  h.video.dispatch("timeupdate");
  assert.equal(h.video.paused, true);
  assert.equal((await h.command("seek", { time: -1 })).ok, false);
  assert.equal((await h.command("seek", { time: 101 })).ok, false);
});

test("caption change and route change discard late responses; no old overlay", async () => {
  const pending = [];
  const h = harness({
    translate: () => new Promise((resolve) => pending.push(resolve))
  });
  await h.command("start");
  await h.mutate("First.");
  await h.mutate("Second.", 12);
  pending[0]({ ok: true, result: { translation: "Wrong first" } });
  await settle();
  assert.equal(h.body.children.length, 0);
  assert.equal(h.requests.length, 2);
  h.location.search = "?v=two";
  await h.tick();
  pending[1]({ ok: true, result: { translation: "Wrong video" } });
  await settle();
  const snapshot = await h.command("snapshot");
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.cues.length, 0);
  assert.equal(h.body.children.length, 0);
});

test("settings opt-out clears observer, timeline and in-flight results", async () => {
  let resolve;
  const h = harness({
    translate: () =>
      new Promise((r) => {
        resolve = r;
      })
  });
  await h.command("start");
  await h.mutate("Private.");
  await h.settings({ labFeatures: { media: false } });
  resolve({ ok: true, result: { translation: "Discard" } });
  await settle();
  assert.equal(h.observer.active, false);
  assert.equal((await h.command("snapshot")).cues.length, 0);
  assert.equal(h.body.children.length, 0);
  await h.settings({ labFeatures: { media: true }, nativeLanguageCode: "ja" });
  await h.command("start");
  await h.mutate("New.");
  assert.equal(h.requests.at(-1).payload.targetLanguage, "ja");
});

test("Meet requires consent per session, latest sentence only, no persistent writes", async () => {
  const h = harness({ host: "meet.google.com" });
  assert.equal((await h.command("start")).ok, false);
  assert.equal(h.requests.length, 0);
  await h.command("start", { options: { meetingConsent: true } });
  await h.mutate("First sentence.");
  await h.mutate("Second sentence.");
  const result = await h.command("snapshot");
  assert.equal(result.ephemeral, true);
  assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].speaker, "Alice");
  assert.equal(result.cues[0].text, "Second sentence.");
  assert.equal((await h.command("seek", { time: 1 })).ok, false);
  h.noCaptionRoot();
  await h.tick();
  assert.equal((await h.command("snapshot")).active, false);
  assert.equal((await h.command("start")).ok, false);
});

test("hidden captions, unsupported selectors/sites and provider errors are explicit", async () => {
  const unknown = harness({ host: "notyoutube.com" });
  assert.equal((await unknown.command("start")).ok, false);
  const h = harness({
    translate: async () => ({ ok: false, error: "synthetic unavailable" })
  });
  await h.command("start");
  h.caption.shown = false;
  await h.mutate("Hidden.");
  assert.equal(h.requests.length, 0);
  assert.equal(
    (await h.command("snapshot")).status,
    "captions-unavailable-enable-visible-captions"
  );
  h.caption.shown = true;
  await h.mutate("Visible.");
  const snapshot = await h.command("snapshot");
  assert.equal(snapshot.status, "provider-error");
  assert.equal(snapshot.error, "synthetic unavailable");
});

test("panel heartbeat expiry and pagehide stop observers without persisting state", async () => {
  const h = harness();
  await h.command("start");
  await h.tick(6000);
  assert.equal((await h.command("snapshot")).active, false);
  await h.command("start");
  h.win.dispatch("pagehide");
  assert.equal(h.observer.active, false);
  assert.equal(h.intervalCount, 0);
});

test("same completed caption repeated later is a new cue, not deduped from earlier timeline", async () => {
  const h = harness();
  await h.command("start");
  await h.mutate("Repeated sentence.", 10);
  await h.mutate("Next sentence.", 12);
  await h.mutate("Repeated sentence.", 14);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(
    Array.from((await h.command("snapshot")).cues, (cue) => cue.text),
    ["Repeated sentence.", "Next sentence.", "Repeated sentence."]
  );
});

test("imported-file replay cleans temporary listeners on navigation and panel lease expiry", async () => {
  const h = harness();
  await h.command("replay", { time: 1, options: { end: 3 } });
  assert.equal(h.intervalCount, 1);
  h.location.search = "?v=two";
  await h.tick();
  assert.equal(h.intervalCount, 0);
  h.video.currentTime = 4;
  h.video.dispatch("timeupdate");
  assert.notEqual(h.video.paused, true);
  await h.command("replay", { time: 1, options: { end: 3 } });
  await h.tick(6000);
  assert.equal(h.intervalCount, 0);
});

test("Meet stops when an existing caption region becomes hidden after leaving meeting", async () => {
  const h = harness({ host: "meet.google.com" });
  await h.command("start", { options: { meetingConsent: true } });
  await h.mutate("Private synthetic sentence.");
  h.root.shown = false;
  await h.tick();
  const snapshot = await h.command("snapshot");
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.cues.length, 0);
  assert.equal(h.observer.active, false);
  assert.equal(h.intervalCount, 0);
});

test("Meet labels follow the selected caption group; ambiguous speakers are not guessed", () => {
  const h = harness();
  const first = new Node("Earlier sentence.");
  const latest = new Node("Latest sentence.");
  const alice = new Node("Alice");
  const bob = new Node("Bob");
  const adapter = h.api.adapterFor("meet.google.com");
  const doc = {
    querySelectorAll: (selector) =>
      selector === adapter.selector ? [first, latest] : [alice, bob]
  };
  assert.equal(h.api.readCaption(adapter, doc).speaker, "");
  latest.closest = (selector) =>
    selector === "[hidden], [aria-hidden='true']"
      ? null
      : { querySelector: () => bob };
  const cue = h.api.readCaption(adapter, doc);
  assert.equal(cue.text, "Latest sentence.");
  assert.equal(cue.speaker, "Bob");
});
