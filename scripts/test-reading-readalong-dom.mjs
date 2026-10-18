import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { mount } from "../extension/src/experimental/readalong.js";
import { createLabApi } from "../extension/src/experimental/lab-api.js";

const readingScript = readFileSync(
  new URL("../extension/src/experimental/content-reading.js", import.meta.url),
  "utf8"
);
const readalongScript = readFileSync(
  new URL(
    "../extension/src/experimental/content-readalong.js",
    import.meta.url
  ),
  "utf8"
);
const flush = async () => {
  for (let i = 0; i < 8; i++)
    await new Promise((resolve) => setImmediate(resolve));
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
function ports() {
  const a = { onMessage: event(), onDisconnect: event() },
    b = { onMessage: event(), onDisconnect: event() };
  let closed = false;
  a.postMessage = (value) => {
    if (!closed) b.onMessage.emit(value);
  };
  b.postMessage = (value) => {
    if (!closed) a.onMessage.emit(value);
  };
  a.disconnect = b.disconnect = () => {
    if (!closed) {
      closed = true;
      a.onDisconnect.emit();
      b.onDisconnect.emit();
    }
  };
  return [a, b];
}
async function fixture(t, options = {}) {
  const web = new JSDOM(
    options.html ||
      "<main><p>First sentence. Second sentence!</p><p translate='no'>PRIVATE</p><p contenteditable>SECRET</p><form>Password</form></main>",
    {
      url: "https://work.test/article",
      runScripts: "outside-only",
      pretendToBeVisual: true
    }
  );
  const lab = new JSDOM(
    "<select id='lab-target'><option value='9'>Website</option></select><div id='panel'></div>",
    { url: "https://labs.test/#readalong", pretendToBeVisual: true }
  );
  const settings = {
    enabled: true,
    labFeatures: { readalong: true, learning: false },
    nativeLanguageCode: "vi",
    activeProviderId: "configured",
    providers: [{ id: "configured", name: "Configured", type: "openai" }],
    privacyDefaultMode: options.privacy || "ask",
    privacyRules: []
  };
  const storage = event(),
    webStorage = event(),
    messages = event(),
    connect = event(),
    updated = event(),
    removed = event();
  const requests = [],
    saves = [],
    highlights = [],
    spoken = [],
    status = [],
    openedPorts = [];
  let consent = true,
    confirmations = 0,
    writes = 0;
  const tab = { id: 9, url: web.window.location.href };
  const sender = {
    id: "synthetic",
    url: "chrome-extension://synthetic/pages/labs.html"
  };
  const readSettings = async (key) => ({ [key]: settings });
  web.window.chrome = {
    runtime: {
      id: "synthetic",
      getURL: (path) => `chrome-extension://synthetic/${path}`,
      onMessage: messages,
      onConnect: connect
    },
    storage: { local: { get: readSettings }, onChanged: webStorage }
  };
  web.window.CSS = { highlights: new Map() };
  web.window.Highlight = class {
    constructor(range) {
      this.range = range;
    }
  };
  web.window.CSSStyleSheet = class {
    replaceSync() {}
  };
  web.window.document.adoptedStyleSheets = [];
  web.window.Element.prototype.scrollIntoView = () => {};
  new vm.Script(readingScript, {
    importModuleDynamically: () =>
      import("../extension/src/experimental/reading-context.js")
  }).runInContext(web.getInternalVMContext());
  new vm.Script(readalongScript).runInContext(web.getInternalVMContext());
  const oldChrome = globalThis.chrome,
    oldDocument = globalThis.document,
    oldWindow = globalThis.window;
  globalThis.chrome = {
    storage: {
      local: {
        get: readSettings,
        set: async () => {
          writes++;
        }
      },
      onChanged: storage
    },
    tabs: {
      get: async () => ({ ...tab }),
      onUpdated: updated,
      onRemoved: removed,
      async sendMessage(id, message, opts) {
        highlights.push({ id, message, opts });
        return new Promise((resolve) => {
          for (const listener of messages.listeners)
            if (listener(message, sender, resolve)) return;
          resolve({ ok: false, error: "no-listener" });
        });
      },
      connect(id, opts) {
        const [a, b] = ports();
        Object.assign(b, { name: opts.name, sender });
        openedPorts.push(a);
        connect.emit(b);
        return a;
      }
    },
    runtime: {
      async sendMessage(message) {
        requests.push(message);
        if (message.type === "translate") {
          if (options.translation)
            return {
              ok: true,
              result: { translation: await options.translation() }
            };
          return {
            ok: true,
            result: { translation: "<img src=x onerror=bad()> Bản dịch." }
          };
        }
        return { ok: true };
      }
    }
  };
  globalThis.document = lab.window.document;
  globalThis.window = lab.window;
  lab.window.confirm = () => {
    confirmations++;
    return consent;
  };
  const speechEvents = event();
  const speech = {
    cancels: 0,
    pauses: 0,
    resumes: 0,
    getVoices: () =>
      options.noVoice
        ? [
            {
              name: "Remote",
              voiceURI: "cloud",
              lang: "en",
              localService: false
            }
          ]
        : [
            {
              name: "Offline",
              voiceURI: "local",
              lang: "en",
              localService: true
            }
          ],
    speak: (value) => spoken.push(value),
    cancel() {
      this.cancels++;
    },
    pause() {
      this.pauses++;
    },
    resume() {
      this.resumes++;
    },
    addEventListener: (name, fn) => speechEvents.addListener(fn),
    removeEventListener: (name, fn) => speechEvents.removeListener(fn)
  };
  lab.window.speechSynthesis = speech;
  lab.window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  const api = createLabApi({
    selectedTab: () => lab.window.document.getElementById("lab-target").value,
    onStatus: (message) => status.push(message)
  });
  api.saveVocabulary = async (entry) => saves.push(entry);
  const panel = lab.window.document.getElementById("panel");
  const cleanup = await mount(panel, api);
  const button = (label) =>
    [...panel.querySelectorAll("button")].find(
      (value) => value.textContent === label
    );
  const field = (label) =>
    [...panel.querySelectorAll("label")].find(
      (value) => value.firstChild.textContent === label
    )?.lastChild;
  const click = async (label) => {
    assert.ok(button(label), label);
    button(label).click();
    await flush();
  };
  const previewManual = async (text = "First sentence. Second sentence!") => {
    field("Manual text (preview before Play)").value = text;
    await click("Preview manual text");
  };
  t.after(() => {
    cleanup();
    web.window.dispatchEvent(new web.window.Event("pagehide"));
    lab.window.close();
    web.window.close();
    globalThis.chrome = oldChrome;
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  });
  return {
    web,
    lab,
    panel,
    settings,
    requests,
    saves,
    spoken,
    highlights,
    status,
    speech,
    speechEvents,
    storage,
    webStorage,
    updated,
    removed,
    openedPorts,
    cleanup,
    button,
    field,
    click,
    previewManual,
    tab,
    setConsent: (value) => {
      consent = value;
    },
    confirmations: () => confirmations,
    writes: () => writes
  };
}

test("mount, manual preview and Play never translate, persist or ask for provider consent", async (t) => {
  const h = await fixture(t);
  assert.equal(h.requests.length, 0);
  assert.equal(h.button("Play original").disabled, true);
  await h.previewManual();
  assert.equal(h.panel.querySelectorAll("ol li").length, 2);
  assert.equal(h.spoken.length, 0);
  await h.click("Play original");
  assert.deepEqual(
    h.requests.map((request) => request.type),
    ["tts-stop"]
  );
  assert.equal(h.spoken.length, 1);
  assert.equal(h.confirmations(), 0);
  assert.equal(h.writes(), 0);
  assert.equal(h.saves.length, 0);
  assert.equal(h.panel.querySelectorAll("[aria-current='step']").length, 0);
  h.spoken[0].onstart();
  assert.equal(
    h.panel
      .querySelector("[aria-current='step']")
      .textContent.includes("First sentence."),
    true
  );
  h.spoken[0].onend();
  await flush();
  h.spoken[1].onstart();
  assert.equal(
    h.panel
      .querySelector("[aria-current='step']")
      .textContent.includes("Second sentence!"),
    true
  );
});

test("no local voice reports honest capability and cannot start remote speech", async (t) => {
  const h = await fixture(t, { noVoice: true });
  await h.previewManual();
  assert.equal(h.button("Play original").disabled, true);
  await h.click("Refresh local voices");
  assert.match(h.panel.textContent, /No local voice available/);
  await h.click("Play original");
  assert.equal(h.spoken.length, 0);
  assert.equal(h.requests.length, 0);
});

test("pasted bilingual pairs stay in safe DOM and advance with actual speech events", async (t) => {
  const h = await fixture(t);
  await h.previewManual("<script>unsafe()</script> First. Second!");
  h.field(
    "Pasted translation · one non-empty line per preview sentence"
  ).value = "<img onerror=bad()> Một.\nHai!";
  await h.click("Apply pasted translation");
  assert.equal(h.panel.querySelectorAll("script,img").length, 0);
  await h.click("Play original");
  h.spoken[0].onstart();
  assert.match(
    h.panel.querySelector("[aria-current='step']").textContent,
    /Một/
  );
  h.spoken[0].onend();
  await flush();
  h.spoken[1].onstart();
  assert.match(
    h.panel.querySelector("[aria-current='step']").textContent,
    /Hai/
  );
  assert.equal(
    h.requests.filter((request) => request.type === "translate").length,
    0
  );
});

test("translation is explicit per sentence, honors Ask and forces ephemeral/skipHistory", async (t) => {
  const h = await fixture(t);
  await h.previewManual();
  h.setConsent(false);
  await h.click("Translate this sentence");
  assert.equal(h.confirmations(), 1);
  assert.equal(h.requests.length, 0);
  h.setConsent(true);
  await h.click("Translate this sentence");
  const request = h.requests.find((value) => value.type === "translate");
  assert.equal(h.confirmations(), 2);
  assert.equal(request.payload.text, "First sentence.");
  assert.equal(request.payload.labFeature, "readalong");
  assert.equal(request.payload.ephemeral, true);
  assert.equal(request.payload.skipHistory, true);
  assert.equal(request.payload.siteUrl, "");
  assert.equal(request.payload.cloudConsent, true);
  assert.equal(request.payload.privacyPolicy, "ask");
  assert.equal(h.panel.querySelectorAll("img").length, 0);
  assert.match(h.panel.querySelector("ol li").textContent, /Bản dịch/);
  assert.equal(h.writes(), 0);
});

test("Local-only translation keeps the configured policy rather than bypassing it", async (t) => {
  const h = await fixture(t, { privacy: "local-only" });
  await h.previewManual();
  await h.click("Translate this sentence");
  assert.equal(h.requests[0].payload.privacyPolicy, "local-only");
  assert.equal(h.requests[0].payload.providerId, "configured");
  assert.equal(h.confirmations(), 0);
});

test("provider results after clear, source replacement and unmount are discarded", async (t) => {
  let release;
  const h = await fixture(t, {
    translation: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  await h.previewManual();
  await h.click("Translate this sentence");
  await h.click("Clear preview");
  release("LATE PRIVATE OUTPUT");
  await flush();
  assert.doesNotMatch(h.panel.textContent, /LATE PRIVATE OUTPUT/);
  await h.previewManual();
  await h.click("Translate this sentence");
  h.cleanup();
  release("LATE UNMOUNT OUTPUT");
  await flush();
  assert.equal(h.panel.childNodes.length, 0);
  assert.equal(h.writes(), 0);
});

test("website capture filters protected text and highlights exact current sentence without DOM mutation", async (t) => {
  const h = await fixture(t);
  const html = h.web.window.document.body.innerHTML;
  await h.click("Preview article paragraphs");
  assert.doesNotMatch(
    h.panel.querySelector("ol").textContent,
    /PRIVATE|SECRET|Password/
  );
  await h.click("Play original");
  assert.equal(h.spoken.length, 1);
  assert.equal(
    h.web.window.CSS.highlights
      .get("bntrans-reading-readalong")
      .range.toString(),
    "First sentence."
  );
  h.spoken[0].onstart();
  h.spoken[0].onend();
  await flush();
  assert.equal(
    h.web.window.CSS.highlights
      .get("bntrans-reading-readalong")
      .range.toString(),
    "Second sentence!"
  );
  assert.equal(h.web.window.document.body.innerHTML, html);
  assert.ok(h.highlights.every((value) => value.opts.frameId === 0));
  assert.equal(
    h.requests.filter((value) => value.type === "translate").length,
    0
  );
  await h.click("Stop");
  assert.equal(h.web.window.CSS.highlights.size, 0);
  assert.equal(h.button("Play original").disabled, true);
});

test("stale website text refuses speech before the first utterance", async (t) => {
  const h = await fixture(t);
  await h.click("Preview article paragraphs");
  h.web.window.document.querySelector("p").firstChild.data = "Changed source";
  await flush();
  await h.click("Play original");
  assert.equal(h.spoken.length, 0);
  assert.match(h.panel.textContent, /Capture it again/);
  assert.equal(h.web.window.CSS.highlights.size, 0);
});

test("source mutation while speaking stops immediately and late utterance callbacks cannot progress", async (t) => {
  const h = await fixture(t);
  await h.click("Preview article paragraphs");
  await h.click("Play original");
  h.spoken[0].onstart();
  h.web.window.document.querySelector("p").setAttribute("translate", "no");
  await flush();
  const cancelled = h.speech.cancels;
  assert.ok(cancelled > 0);
  assert.equal(h.web.window.CSS.highlights.size, 0);
  h.spoken[0].onend();
  h.spoken[0].onstart();
  await flush();
  assert.equal(h.spoken.length, 1);
  assert.equal(h.button("Play original").disabled, true);
});

test("selected tab switch, navigation and flag-off stop speech and remove highlights", async (t) => {
  const h = await fixture(t);
  for (const invalidate of [
    () =>
      h.lab.window.document
        .getElementById("lab-target")
        .dispatchEvent(new h.lab.window.Event("change")),
    () => h.updated.emit(9, { status: "loading" }),
    () => {
      h.settings.labFeatures.readalong = false;
      h.storage.emit({ translatorSettings: {} }, "local");
      h.webStorage.emit({ translatorSettings: {} }, "local");
    }
  ]) {
    h.settings.labFeatures.readalong = true;
    await h.click("Preview article paragraphs");
    await h.click("Play original");
    const utterance = h.spoken.at(-1);
    utterance.onstart();
    invalidate();
    await flush();
    assert.equal(h.web.window.CSS.highlights.size, 0);
    const count = h.spoken.length;
    utterance.onend();
    await flush();
    assert.equal(h.spoken.length, count);
  }
});

test("pause/resume, speed and previous/next are explicit and never auto-translate", async (t) => {
  const h = await fixture(t);
  await h.previewManual();
  h.field("Speed (next Play)").value = "1.5";
  await h.click("Play original");
  assert.equal(h.spoken[0].rate, 1.5);
  h.spoken[0].onstart();
  await h.click("Pause");
  assert.equal(h.speech.pauses, 1);
  await h.click("Resume");
  assert.equal(h.speech.resumes, 1);
  await h.click("Next");
  assert.match(h.panel.textContent, /Sentence 2 of 2/);
  assert.equal(h.spoken.length, 1);
  await h.click("Play original");
  assert.equal(h.spoken[1].text, "Second sentence!");
  await h.click("Previous");
  await h.click("Play original");
  assert.equal(h.spoken[2].text, "First sentence.");
  assert.equal(
    h.requests.filter((value) => value.type === "translate").length,
    0
  );
});

test("only Save with Learning enabled stores the chosen sentence, never audio", async (t) => {
  const h = await fixture(t);
  await h.previewManual();
  await h.click("Save sentence to vocabulary");
  assert.equal(h.saves.length, 0);
  assert.match(h.panel.textContent, /Enable Vocabulary/);
  h.settings.labFeatures.learning = true;
  await h.click("Save sentence to vocabulary");
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].text, "First sentence.");
  assert.equal(Object.hasOwn(h.saves[0], "audio"), false);
  await h.click("Next");
  await h.click("Save sentence to vocabulary");
  assert.equal(h.saves[1].text, "Second sentence!");
});

test("route teardown removes storage/tab/voice listeners, speech and all original source highlights", async (t) => {
  const h = await fixture(t);
  await h.click("Preview article paragraphs");
  await h.click("Play original");
  h.lab.window.dispatchEvent(new h.lab.window.Event("hashchange"));
  await flush();
  assert.equal(h.storage.listeners.size, 0);
  assert.equal(h.updated.listeners.size, 0);
  assert.equal(h.removed.listeners.size, 0);
  assert.equal(h.speechEvents.listeners.size, 0);
  assert.equal(h.web.window.CSS.highlights.size, 0);
  assert.equal(h.panel.childNodes.length, 0);
  h.spoken[0].onend();
  await flush();
  assert.equal(h.spoken.length, 1);
});
