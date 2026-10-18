import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mount } from "../extension/src/experimental/ask.js";
import { createLabApi } from "../extension/src/experimental/lab-api.js";
import {
  captureReadingSnapshot,
  readingSnapshotRange
} from "../extension/src/experimental/reading-context.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 80 && !predicate(); n++) await tick();
  assert.ok(predicate(), "synthetic DOM phase was reached");
}
function delayed() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  t,
  {
    html = "<main><p>First literal source.</p><p>UNCHECKED-SOURCE.</p></main>",
    settings = {},
    language = "en"
  } = {}
) {
  const dom = new JSDOM("<!doctype html><body><main></main></body>", {
    url: "https://extension.test/labs"
  });
  const web = new JSDOM(
    `<!doctype html><html lang="en"><head><title>Synthetic source</title></head><body>${html}</body></html>`,
    { url: "https://synthetic.test/article" }
  );
  const listeners = new Set(),
    calls = [],
    messages = [],
    status = [],
    confirms = [],
    writes = [],
    pdfCalls = [];
  const state = {
    enabled: true,
    labFeatures: { ask: true },
    activeProviderId: "local",
    privacyDefaultMode: "cloud",
    providers: [
      {
        id: "local",
        name: "Local provider",
        type: "ollama",
        config: { model: "synthetic-local" }
      },
      {
        id: "cloud",
        name: "Cloud provider",
        type: "openai",
        config: { model: "synthetic-cloud" }
      }
    ],
    ...settings
  };
  const h = {
    dom,
    web,
    listeners,
    calls,
    messages,
    status,
    confirms,
    writes,
    pdfCalls,
    state,
    accept: true
  };
  let snapshot;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.confirm = (message) => {
    confirms.push(message);
    return h.accept;
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: state };
        },
        async set(value) {
          writes.push(value);
          throw new Error("Ask must never write content/settings");
        }
      },
      onChanged: {
        addListener(fn) {
          listeners.add(fn);
        },
        removeListener(fn) {
          listeners.delete(fn);
        }
      }
    },
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        assert.equal(message.type, "translate");
        const data = JSON.parse(message.payload.text);
        const translation = h.output
          ? await h.output(data)
          : JSON.stringify({
              answer: "Synthetic answer.",
              citations: [
                {
                  id: data.sources[0].id,
                  quote: data.sources[0].text.slice(0, 5)
                }
              ]
            });
        return { ok: true, result: { translation } };
      }
    },
    tabs: {
      async get(id) {
        return { id, url: web.window.document.URL };
      },
      async sendMessage(id, message, options) {
        calls.push({ id, message, options });
        assert.equal(message.type, "labs-reading-source");
        assert.equal(message.payload.feature, "ask");
        assert.deepEqual(options, { frameId: 0 });
        const payload = message.payload;
        if (payload.command === "clear") {
          snapshot = null;
          return { ok: true };
        }
        try {
          if (state.enabled === false || state.labFeatures.ask !== true)
            throw new Error("source-disabled");
          if (payload.command === "capture") {
            snapshot = captureReadingSnapshot(
              web.window.document,
              payload.mode
            );
            return { ok: true, source: snapshot.source };
          }
          readingSnapshotRange(web.window.document, snapshot, payload);
          if (h.noHighlight && payload.command === "highlight")
            throw new Error("source-highlight-unsupported");
          return { ok: true, blockId: payload.blockId };
        } catch (error) {
          return { ok: false, error: error.code || error.message };
        }
      }
    }
  };
  const pdf = {
    async open(file) {
      pdfCalls.push(["open", file]);
      return { documentId: "doc", title: file.name, pages: 3 };
    },
    async capturePage(page) {
      pdfCalls.push(["page", page]);
      if (page === 3) throw new Error("pdf-no-text");
      if (page < 1 || page > 3 || !Number.isInteger(page))
        throw new Error("pdf-page");
      return {
        kind: "pdf",
        mode: "page",
        snapshotId: `pdf-${page}`,
        documentId: "doc",
        title: "Synthetic.pdf",
        page,
        url: "",
        blocks: [
          {
            id: `pdf-p${page}-b1`,
            page,
            text: `PDF page ${page} selected text.`
          },
          { id: `pdf-p${page}-b2`, page, text: "UNCHECKED-PDF-TEXT" }
        ]
      };
    },
    async close() {
      pdfCalls.push(["close"]);
    },
    async destroy() {
      pdfCalls.push(["destroy"]);
    }
  };
  const api = createLabApi({
    language,
    selectedTab: () => 7,
    onStatus: (message, kind) => status.push({ message, kind })
  });
  const cleanup = mount(dom.window.document.querySelector("main"), api, {
    pdf
  });
  h.node = (name) => dom.window.document.querySelector(`[data-ask="${name}"]`);
  h.idle = async () => {
    await tick();
    await until(
      () =>
        h
          .node("question")
          ?.closest("section.lab-panel")
          .getAttribute("aria-busy") === "false"
    );
  };
  h.change = (node, event = "change") =>
    node.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
  h.click = async (name) => {
    h.node(name).click();
    await h.idle();
  };
  h.select = (index = 0, checked = true) => {
    const input = h.node("sources").querySelectorAll("input")[index];
    input.checked = checked;
    h.change(input);
    return input.dataset.blockId;
  };
  h.question = (text = "What does this source say?") => {
    h.node("question").value = text;
    h.change(h.node("question"), "input");
  };
  h.consent = () => {
    h.node("consent").checked = true;
    h.change(h.node("consent"));
  };
  h.capture = async () => {
    h.node("mode").value = "article";
    await h.click("capture");
  };
  h.prepare = async () => {
    await h.capture();
    const id = h.select();
    h.question();
    h.consent();
    return id;
  };
  h.notify = () => {
    for (const fn of [...listeners])
      fn({ translatorSettings: { newValue: state } }, "local");
  };
  h.file = async () => {
    const file = {
      name: "Synthetic.pdf",
      type: "application/pdf",
      size: 14,
      async arrayBuffer() {
        throw new Error("The UI must delegate PDF reading to the local helper");
      }
    };
    Object.defineProperty(h.node("file"), "files", {
      configurable: true,
      value: [file]
    });
    h.change(h.node("file"));
    await h.idle();
    return file;
  };
  let alive = true;
  h.cleanup = async () => {
    if (alive) {
      alive = false;
      cleanup();
      await tick();
    }
  };
  t.after(async () => {
    await h.cleanup();
    dom.window.close();
    web.window.close();
  });
  await h.idle();
  return h;
}

test("mount is passive: no website/PDF read, no provider call and no storage write", async (t) => {
  const h = await fixture(t);
  assert.equal(h.calls.length, 0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.pdfCalls.length, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.node("send").disabled, true);
  assert.match(
    h.node("provider").textContent,
    /Local provider.*synthetic-local/
  );
});

test("website preview defaults unchecked; explicit request sends only checked source and question with no retention", async (t) => {
  const h = await fixture(t);
  const before = structuredClone(h.state);
  await h.capture();
  assert.equal(h.messages.length, 0);
  const checks = [...h.node("sources").querySelectorAll("input")];
  assert.equal(checks.length, 2);
  assert.ok(checks.every((check) => !check.checked));
  assert.match(
    h.node("summary").textContent,
    /0 selected snippets · 0 source characters/
  );
  const id = h.select();
  h.question();
  assert.equal(h.node("send").disabled, true);
  h.consent();
  await h.click("send");
  assert.equal(h.messages.length, 1);
  const payload = h.messages[0].payload;
  assert.deepEqual(JSON.parse(payload.text), {
    question: "What does this source say?",
    sources: [{ id, text: "First literal source." }]
  });
  assert.equal(payload.labFeature, "ask");
  assert.equal(payload.task, "qa");
  assert.equal(payload.ephemeral, true);
  assert.equal(payload.skipHistory, true);
  assert.equal(payload.providerId, "local");
  assert.equal(payload.siteUrl, "https://synthetic.test/article");
  assert.equal(payload.targetTabId, 7);
  assert.match(h.node("answer").textContent, /Synthetic answer/);
  assert.match(h.node("answer").textContent, /not factual verification/);
  assert.equal(h.node("consent").checked, false);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.state, before);
  h.node("answer").querySelector("button").click();
  await tick();
  const jump = h.calls.findLast(
    (call) => call.message.payload.command === "jump"
  );
  assert.equal(jump.id, 7);
  assert.equal(jump.message.payload.blockId, id);
  assert.equal(jump.message.payload.start, 0);
  assert.equal(jump.message.payload.end, 5);
});

test("selection mode requires a nonempty website range and sends only that range", async (t) => {
  const h = await fixture(t);
  await h.click("capture");
  assert.match(h.status.at(-1).message, /Select readable website text/);
  const text = h.web.window.document.querySelector("p").firstChild;
  const range = h.web.window.document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 13);
  h.web.window.getSelection().addRange(range);
  await h.click("capture");
  assert.equal(h.node("sources").querySelector("p").textContent, "literal");
  h.select();
  h.question();
  h.consent();
  await h.click("send");
  assert.equal(
    JSON.parse(h.messages[0].payload.text).sources[0].text,
    "literal"
  );
});

test("consent resets on question, selection, recapture and cancel; repeated asks do not resend prior answers", async (t) => {
  const h = await fixture(t);
  await h.prepare();
  h.question("New question");
  assert.equal(h.node("consent").checked, false);
  h.consent();
  h.select(1);
  assert.equal(h.node("consent").checked, false);
  h.select(1, false);
  h.consent();
  await h.click("send");
  h.question("Second fresh question");
  h.consent();
  await h.click("send");
  assert.doesNotMatch(
    h.messages[1].payload.text,
    /Synthetic answer|New question|UNCHECKED/
  );
  await h.capture();
  assert.equal(h.node("consent").checked, false);
  assert.equal(h.node("sources").querySelector("input").checked, false);
  assert.equal(h.node("question").value, "");
  h.select();
  h.question();
  h.consent();
  await h.click("cancel");
  assert.equal(h.node("sources").textContent, "");
  assert.equal(h.node("answer").textContent, "");
  assert.equal(h.node("send").disabled, true);
  assert.equal(h.node("consent").checked, false);
});

test("source text, title, model answer and quotes render as text, never HTML or model URLs", async (t) => {
  const h = await fixture(t);
  const malicious =
    '<img src="https://evil.test" onerror="run()"><script>run()</script>';
  h.web.window.document.querySelector("p").textContent = malicious;
  h.web.window.document.title = malicious;
  h.output = ({ sources }) =>
    JSON.stringify({
      answer: malicious + " [link](https://evil.test)",
      citations: [{ id: sources[0].id, quote: malicious }]
    });
  await h.prepare();
  await h.click("send");
  assert.match(h.node("answer").textContent, /<img/);
  assert.match(h.node("source").textContent, /<script>/);
  assert.equal(
    h.dom.window.document.querySelectorAll("img,script,a,iframe").length,
    0
  );
  assert.equal(h.writes.length, 0);
});

test("invalid/hallucinated/unchecked/mismatched/no citations never render a sourced answer", async (t) => {
  const h = await fixture(t);
  await h.prepare();
  for (const output of [
    "not JSON",
    '{"answer":"UNTRUSTED ANSWER","citations":[]}',
    '{"answer":"UNTRUSTED ANSWER","citations":[{"id":"invented"}]}',
    () =>
      JSON.stringify({
        answer: "UNTRUSTED ANSWER",
        citations: [
          { id: h.node("sources").querySelectorAll("input")[1].dataset.blockId }
        ]
      }),
    ({ sources }) =>
      JSON.stringify({
        answer: "UNTRUSTED ANSWER",
        citations: [{ id: sources[0].id, quote: "FAKE QUOTE" }]
      }),
    ({ sources }) =>
      JSON.stringify({
        answer: "UNTRUSTED ANSWER",
        citations: [{ id: sources[0].id, url: "https://evil.test" }]
      })
  ]) {
    h.output = typeof output === "string" ? () => output : output;
    h.consent();
    await h.click("send");
    assert.equal(h.node("answer").textContent, "");
    assert.equal(h.status.at(-1).kind, "error");
    assert.doesNotMatch(
      h.dom.window.document.body.textContent,
      /UNTRUSTED ANSWER|FAKE QUOTE/
    );
  }
});

test("real source filtering excludes sensitive/editable/hidden/nested opt-out/iframe text", async (t) => {
  const h = await fixture(t, {
    html: `<main><p>Public source.</p><p translate="no"><span translate="yes">SECRET-OPT</span></p>
    <div hidden>SECRET-HIDDEN</div><div contenteditable="true"><span contenteditable="false">SECRET-EDIT</span></div>
    <form><p>SECRET-FORM</p><input type="password" value="SECRET-PASS"></form><iframe srcdoc="<p>SECRET-FRAME</p>"></iframe>
    <p aria-hidden="true">SECRET-ARIA</p><div style="display:none">SECRET-CSS</div></main>`
  });
  await h.prepare();
  await h.click("send");
  assert.doesNotMatch(h.node("sources").textContent, /SECRET/);
  assert.doesNotMatch(h.messages[0].payload.text, /SECRET/);
});

test("fully protected source and disabled feature refuse capture and never send", async (t) => {
  const h = await fixture(t, {
    html: '<main contenteditable="true"><p>SECRET</p></main>'
  });
  await h.capture();
  assert.match(h.status.at(-1).message, /No readable source/);
  assert.equal(h.node("sources").textContent, "");
  h.state.labFeatures.ask = false;
  h.notify();
  await h.idle();
  assert.equal(h.node("capture").disabled, true);
  assert.equal(h.node("send").disabled, true);
  assert.equal(h.messages.length, 0);
});

test("stale DOM is refused before send and citation navigation cannot jump into changed content", async (t) => {
  const h = await fixture(t);
  await h.prepare();
  h.web.window.document.querySelector("p").setAttribute("translate", "no");
  await h.click("send");
  assert.equal(h.messages.length, 0);
  assert.equal(h.node("sources").textContent, "");
  assert.match(h.status.at(-1).message, /source changed/);
  h.web.window.document.querySelector("p").removeAttribute("translate");
  await h.prepare();
  await h.click("send");
  h.web.window.history.pushState({}, "", "/changed");
  h.node("answer").querySelector("button").click();
  await tick();
  assert.match(h.status.at(-1).message, /source changed/);
  assert.equal(h.node("answer").textContent, "");
  assert.equal(h.node("sources").textContent, "");
});

test("pending website mutation, navigation, cancellation and recapture discard late output", async (t) => {
  const h = await fixture(t);
  for (const mode of ["mutation", "navigation", "cancel", "recapture"]) {
    await h.prepare();
    const result = delayed();
    h.output = () => result.promise;
    const count = h.messages.length;
    h.node("send").click();
    await until(() => h.messages.length > count);
    const id = JSON.parse(h.messages.at(-1).payload.text).sources[0].id;
    if (mode === "mutation")
      h.web.window.document.querySelector("p").firstChild.data =
        "Changed source.";
    else if (mode === "navigation")
      h.web.window.history.pushState({}, "", "/next");
    else {
      await h.click("cancel");
      if (mode === "recapture") await h.capture();
    }
    result.resolve(
      JSON.stringify({ answer: "LATE ANSWER", citations: [{ id }] })
    );
    await h.idle();
    assert.equal(h.node("answer").textContent, "");
    assert.doesNotMatch(h.dom.window.document.body.textContent, /LATE ANSWER/);
  }
});

test("unmount suppresses pending output and removes both storage listeners", async (t) => {
  const h = await fixture(t);
  await h.prepare();
  const result = delayed();
  h.output = () => result.promise;
  h.node("send").click();
  await until(() => h.messages.length === 1);
  const id = JSON.parse(h.messages[0].payload.text).sources[0].id;
  await h.cleanup();
  const statusCount = h.status.length;
  assert.equal(h.listeners.size, 0);
  assert.ok(h.pdfCalls.some(([name]) => name === "destroy"));
  result.resolve(JSON.stringify({ answer: "LATE", citations: [{ id }] }));
  await tick();
  await tick();
  assert.equal(h.dom.window.document.querySelector(".lab-panel"), null);
  assert.equal(h.status.length, statusCount);
});

test("website Ask policy uses shown pinned provider and lab API confirmation; rejecting consent sends nothing", async (t) => {
  const h = await fixture(t, {
    settings: {
      privacyRules: [
        { hostname: "synthetic.test", mode: "ask", providerId: "cloud" }
      ]
    }
  });
  await h.prepare();
  assert.match(h.node("provider").textContent, /Cloud provider.*ask/);
  h.accept = false;
  await h.click("send");
  assert.equal(h.confirms.length, 1);
  assert.equal(h.messages.length, 0);
  h.accept = true;
  h.consent();
  await h.click("send");
  assert.equal(h.messages[0].payload.cloudConsent, true);
  assert.equal(h.messages[0].payload.providerId, "cloud");
  assert.equal(h.messages[0].payload.privacyPolicy, "ask");
  assert.equal(h.state.activeProviderId, "local");
});

test("PDF upload is local, extracts only clicked page; selected snippets use empty site URL and PDF citation focus", async (t) => {
  const h = await fixture(t, {
    settings: {
      privacyRules: [
        { hostname: "synthetic.test", mode: "ask", providerId: "cloud" }
      ]
    }
  });
  await h.file();
  assert.equal(h.pdfCalls.filter(([name]) => name === "open").length, 0);
  await h.click("open");
  assert.equal(h.pdfCalls.filter(([name]) => name === "page").length, 0);
  h.node("page").value = "2";
  h.change(h.node("page"), "input");
  await h.idle();
  assert.equal(h.pdfCalls.filter(([name]) => name === "page").length, 0);
  await h.click("preview");
  assert.deepEqual(
    h.pdfCalls.filter(([name]) => name === "page"),
    [["page", 2]]
  );
  assert.ok(
    [...h.node("sources").querySelectorAll("input")].every(
      (check) => !check.checked
    )
  );
  h.select();
  h.question();
  h.consent();
  await h.click("send");
  const payload = h.messages[0].payload;
  assert.equal(payload.siteUrl, "");
  assert.equal(payload.targetTabId, undefined);
  assert.equal(payload.providerId, "local");
  assert.equal(h.confirms.length, 0);
  assert.equal(
    h.calls.filter((call) => call.message.payload.command === "capture").length,
    0
  );
  assert.doesNotMatch(payload.text, /UNCHECKED-PDF|Synthetic\.pdf|%PDF/);
  h.node("answer").querySelector("button").click();
  await tick();
  assert.equal(
    h.node("sources").querySelector("li").getAttribute("aria-current"),
    "true"
  );
  assert.equal(
    h.dom.window.document.activeElement,
    h.node("sources").querySelector("li")
  );
  h.node("page").value = "1";
  h.change(h.node("page"), "input");
  await h.idle();
  assert.equal(h.node("sources").textContent, "");
  assert.equal(h.node("answer").textContent, "");
  assert.equal(h.node("consent").checked, false);
  assert.equal(h.node("send").disabled, true);
});

test("PDF scan failure is explicit and flag-off closes document without retaining its snippets", async (t) => {
  const h = await fixture(t);
  await h.file();
  await h.click("open");
  h.node("page").value = "3";
  h.change(h.node("page"), "input");
  await h.idle();
  await h.click("preview");
  assert.match(h.status.at(-1).message, /no text layer/);
  assert.equal(h.node("sources").textContent, "");
  assert.equal(h.messages.length, 0);
  h.node("page").value = "1";
  h.change(h.node("page"), "input");
  await h.idle();
  await h.click("preview");
  h.select();
  h.question();
  h.consent();
  const before = h.pdfCalls.filter(([name]) => name === "close").length;
  h.state.labFeatures.ask = false;
  h.notify();
  await h.idle();
  assert.ok(h.pdfCalls.filter(([name]) => name === "close").length > before);
  assert.equal(h.node("sources").textContent, "");
  assert.equal(h.node("consent").checked, false);
  assert.equal(h.node("capture").disabled, true);
  assert.equal(h.node("send").disabled, true);
});

test("feature or global disable during a pending request clears consent/source and suppresses its answer", async (t) => {
  const h = await fixture(t);
  for (const flag of ["ask", "global"]) {
    h.state.enabled = true;
    h.state.labFeatures.ask = true;
    h.notify();
    await h.idle();
    await h.prepare();
    const result = delayed();
    h.output = () => result.promise;
    const count = h.messages.length;
    h.node("send").click();
    await until(() => h.messages.length > count);
    const id = JSON.parse(h.messages.at(-1).payload.text).sources[0].id;
    if (flag === "ask") h.state.labFeatures.ask = false;
    else h.state.enabled = false;
    h.notify();
    await h.idle();
    result.resolve(
      JSON.stringify({ answer: "DISABLED LATE", citations: [{ id }] })
    );
    await tick();
    await tick();
    assert.equal(h.node("sources").textContent, "");
    assert.equal(h.node("answer").textContent, "");
    assert.equal(h.node("consent").checked, false);
    assert.equal(h.node("capture").disabled, true);
    assert.equal(h.node("send").disabled, true);
  }
});

test("translation-only provider is blocked in the UI and labels use Vietnamese api.t", async (t) => {
  const h = await fixture(t, {
    language: "vi",
    settings: {
      providers: [
        {
          id: "local",
          type: "google-translate",
          name: "Synthetic Translate",
          config: {}
        }
      ]
    }
  });
  await h.prepare();
  assert.equal(h.node("send").disabled, true);
  assert.match(h.node("provider").textContent, /cần model hỗ trợ chỉ dẫn/);
  assert.equal(h.node("capture").textContent, "Lấy nguồn website");
  assert.equal(h.messages.length, 0);
});
