import assert from "node:assert/strict";
import test from "node:test";
import {
  createHarness,
  deferred,
  delay,
  until
} from "./test-labs-page-harness.mjs";

const translated = (text) => ({
  ok: true,
  result: {
    translation: text
      .split(" ||| ")
      .map((s) => "Translated " + s)
      .join(" ||| ")
  }
});
const live = {
  labFeatures: { page: true },
  labPage: { live: true, requestsPerSecond: 10 }
};

test("direct page start reports active; restore reports inactive before a pending reply", async (t) => {
  const pending = deferred();
  const h = createHarness({
    count: 1,
    provider: () => pending.promise
  });
  t.after(h.dispose);
  const task = h.runPageTranslation();
  assert.deepEqual(h.stateMessages, [true]);
  await until(() => h.requests.length === 1);
  h.dispose();
  assert.deepEqual(h.stateMessages, [true, false]);
  pending.resolve(translated(h.requests[0].text));
  await task;
  assert.equal(h.document.querySelectorAll("[data-bntrans-wrapper]").length, 0);
});

test("empty non-live page and failed setup reset page state", async (t) => {
  const empty = createHarness();
  t.after(empty.dispose);
  const result = await empty.runPageTranslation();
  assert.equal(result.active, false);
  assert.deepEqual(empty.stateMessages, [true, false]);

  const failed = createHarness({
    settingsError: "Synthetic settings unavailable"
  });
  t.after(failed.dispose);
  const response = await failed.runPageTranslation();
  assert.equal(response.ok, false);
  assert.match(response.error, /Synthetic settings unavailable/);
  assert.deepEqual(failed.stateMessages, [true, false]);
  assert.equal(failed.pageSnapshot().active, false);
});

test("empty live observer remains active until explicitly restored", async (t) => {
  const h = createHarness({ settings: live });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.equal(h.pageSnapshot().state, "watching");
  assert.deepEqual(h.stateMessages, [true]);
  h.dispose();
  assert.deepEqual(h.stateMessages, [true, false]);
});

test("deep opt-outs never enter payload, and restore retains exact original nodes", async (t) => {
  const h = createHarness();
  t.after(h.dispose);
  const p = h.appendParagraph("");
  const protectedNodes = [];
  for (const [attr, value] of [
    ["translate", "no"],
    ["class", "notranslate"],
    ["contenteditable", "true"]
  ]) {
    const outer = h.document.createElement("span");
    const middle = h.document.createElement("em");
    const excluded = h.document.createElement("span");
    excluded.setAttribute(attr, value);
    excluded.textContent = "SYNTHETIC_PROTECTED";
    middle.append(h.document.createTextNode("Public " + attr), excluded);
    outer.appendChild(middle);
    p.appendChild(outer);
    protectedNodes.push(excluded);
  }
  const script = h.document.createElement("script");
  script.textContent = "SYNTHETIC_EXECUTABLE";
  p.appendChild(script);
  for (const tag of [
    "form",
    "fieldset",
    "label",
    "iframe",
    "canvas",
    "video"
  ]) {
    const outer = h.document.createElement("span");
    const excluded = h.document.createElement(tag);
    excluded.textContent = "SYNTHETIC_" + tag.toUpperCase();
    outer.appendChild(excluded);
    p.appendChild(outer);
    protectedNodes.push(excluded);
  }
  const originals = [...p.childNodes];
  await h.runPageTranslation();
  assert.ok(h.requests.length > 0);
  assert.ok(
    h.requests.every(
      (r) =>
        !r.text.includes("SYNTHETIC_PROTECTED") &&
        !r.text.includes("SYNTHETIC_EXECUTABLE") &&
        !r.text.includes("SYNTHETIC_FORM") &&
        !r.text.includes("SYNTHETIC_LABEL") &&
        !r.text.includes("SYNTHETIC_IFRAME") &&
        !r.text.includes("SYNTHETIC_VIDEO")
    )
  );
  assert.equal(h.toMarkdown(originals).includes("SYNTHETIC_PROTECTED"), false);
  await h.command("mode", { mode: "translation" });
  for (const node of protectedNodes) {
    let ancestor = node;
    while (ancestor) {
      assert.notEqual(ancestor.style.display, "none");
      ancestor = ancestor.parentNode;
    }
  }
  h.dispose();
  assert.deepEqual(p.childNodes, originals);
  protectedNodes.forEach((node) => assert.equal(node.isConnected, true));
});

test("detached first/middle units keep source index, stale nodes never receive shifted output", (t) => {
  const h = createHarness({ count: 4 });
  t.after(h.dispose);
  const units = h.getTranslationUnits(h.document.body);
  h.paragraphs[0].firstChild.remove();
  h.paragraphs[2].firstChild.remove();
  const wrappers = h.injectUnitWrappers(units);
  assert.deepEqual(
    Array.from(wrappers, (w) => w.sourceIndex),
    [1, 3]
  );
  h.updateWrappers(
    wrappers,
    ["Wrong A", "Correct B", "Wrong C", "Correct D"],
    {}
  );
  assert.deepEqual(
    Array.from(wrappers, (w) => w.translationSpan.textContent),
    ["Correct B", "Correct D"]
  );
});

test("provider HTML is literal text, never executable nodes or innerHTML", async (t) => {
  const payload =
    '<img src=x onerror="synthetic()"><script>synthetic()</script> **safe**';
  const h = createHarness({
    count: 1,
    provider: () => ({ ok: true, result: { translation: payload } })
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  const span = h.document.querySelectorAll("[data-bntrans-translation]")[0];
  assert.ok(span.textContent.includes("<img"));
  assert.equal(span.querySelectorAll("img").length, 0);
  assert.equal(span.querySelectorAll("script").length, 0);
  assert.equal(span.querySelector("b").textContent, "safe");
});

test("restoring a pending batch prevents fallback/apply and does not lock a new session", async (t) => {
  const first = deferred();
  const h = createHarness({
    count: 25,
    provider: (p, n) => (n === 1 ? first.promise : translated(p.text))
  });
  t.after(h.dispose);
  const old = h.runPageTranslation();
  await until(() => h.requests.length === 1);
  h.dispose();
  await h.runPageTranslation();
  assert.equal(h.pageSnapshot().complete, 25);
  first.resolve({ ok: true, result: { translation: "broken delimiter" } });
  await old;
  await delay(20);
  assert.equal(h.requests.length, 2);
  assert.equal(
    h.document.querySelectorAll("[data-bntrans-wrapper]").length,
    25
  );
});

test("stop during fallback prevents further requests even when two workers are pending", async (t) => {
  const pending = deferred();
  const h = createHarness({
    count: 25,
    provider: (_p, n) =>
      n === 1
        ? { ok: true, result: { translation: "mismatch" } }
        : pending.promise
  });
  t.after(h.dispose);
  const running = h.runPageTranslation();
  await until(() => h.requests.length === 3);
  h.dispose();
  pending.resolve(translated("fallback"));
  await running;
  await delay(20);
  assert.equal(h.requests.length, 3);
  assert.equal(h.document.querySelectorAll("[data-bntrans-wrapper]").length, 0);
});

test("stop before QA identical-source retry opens no QA requests", async (t) => {
  const first = deferred();
  const h = createHarness({ count: 25, provider: () => first.promise });
  t.after(h.dispose);
  const running = h.runPageTranslation();
  await until(() => h.requests.length === 1);
  const text = h.requests[0].text;
  h.dispose();
  first.resolve({ ok: true, result: { translation: text } });
  await running;
  assert.equal(h.requests.length, 1);
});

test("live mode sends only 20 appended paragraphs and ignores its own wrapper changes", async (t) => {
  const h = createHarness({ count: 10, settings: live });
  t.after(h.dispose);
  await h.runPageTranslation();
  const before = h.requests.length;
  for (let i = 0; i < 20; i++) h.appendParagraph("New synthetic " + i);
  await until(() => h.pageSnapshot().complete === 30);
  assert.equal(h.requests.length, before + 1);
  assert.equal(h.requests.at(-1).text.split(" ||| ").length, 20);
  assert.ok(
    h.requests
      .at(-1)
      .text.split(" ||| ")
      .every((s) => s.startsWith("New synthetic"))
  );
  await delay(450);
  assert.equal(h.requests.length, before + 1);
  assert.equal(h.pageSnapshot().state, "watching");
});

test("editing a pending unit rejects the old revision and translates only the new text", async (t) => {
  const first = deferred();
  const h = createHarness({
    count: 1,
    settings: live,
    provider: (p, n) => (n === 1 ? first.promise : translated(p.text))
  });
  t.after(h.dispose);
  const original = h.paragraphs[0].firstChild;
  const running = h.runPageTranslation();
  await until(() => h.requests.length === 1);
  original.textContent = "Changed synthetic";
  first.resolve({
    ok: true,
    result: { translation: "STALE SYNTHETIC RESPONSE" }
  });
  await running;
  await until(() => h.pageSnapshot().complete === 1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].text, "Changed synthetic");
  assert.equal(
    h.document.body.textContent.includes("STALE SYNTHETIC RESPONSE"),
    false
  );
  assert.equal(original.isConnected, true);
});

test("route change cleans observers/listeners and drops late response", async (t) => {
  const pending = deferred();
  const h = createHarness({
    count: 1,
    settings: live,
    provider: () => pending.promise
  });
  t.after(h.dispose);
  const running = h.runPageTranslation();
  await until(() => h.requests.length === 1);
  h.context.location.href = "https://synthetic.example/route-two";
  h.listeners.get("popstate")();
  pending.resolve(translated("late"));
  await running;
  h.appendParagraph("Next route");
  await delay(300);
  assert.equal(h.requests.length, 1);
  assert.equal(h.document.querySelectorAll("[data-bntrans-wrapper]").length, 0);
  assert.equal(h.listeners.size, 0);
});

test("three reading modes change only display and restore truly unwraps", async (t) => {
  const h = createHarness({ count: 2 });
  t.after(h.dispose);
  const originalNodes = h.paragraphs.map((p) => p.firstChild);
  await h.runPageTranslation();
  const requests = h.requests.length;
  for (const mode of ["original", "translation", "bilingual"]) {
    await h.command("mode", { mode });
    const original = h.document.querySelectorAll("[data-bntrans-original]")[0];
    const translation = h.document.querySelectorAll(
      "[data-bntrans-translation]"
    )[0];
    assert.equal(original.style.display, mode === "translation" ? "none" : "");
    assert.equal(
      translation.style.display,
      mode === "original" ? "none" : "inline"
    );
  }
  assert.equal(h.requests.length, requests);
  await h.command("restore");
  assert.deepEqual(
    h.paragraphs.map((p) => p.firstChild),
    originalNodes
  );
  assert.equal(h.document.querySelectorAll("[data-bntrans-wrapper]").length, 0);
});

test("site mode uses exact hostname, never another site's preference", (t) => {
  const h = createHarness();
  t.after(h.dispose);
  const settings = {
    labFeatures: { page: true },
    labPage: {
      siteModes: {
        "synthetic.example": "translation",
        "other.example": "original"
      }
    }
  };
  assert.equal(h.pageOptions(settings).mode, "translation");
  h.context.location.hostname = "third.example";
  assert.equal(h.pageOptions(settings).mode, "bilingual");
});

test("fallback 25 respects configured concurrency and request rate", async (t) => {
  let active = 0,
    peak = 0;
  const starts = [];
  const h = createHarness({
    count: 25,
    fastClock: false,
    provider: async (p, n) => {
      starts.push(Date.now());
      active++;
      peak = Math.max(peak, active);
      await delay(160);
      active--;
      return n === 1
        ? { ok: true, result: { translation: "mismatch" } }
        : translated(p.text);
    }
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.equal(h.requests.length, 26);
  assert.ok(peak <= 2);
  assert.ok(peak > 1);
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i] - starts[i - 1] >= 95, "10 requests/s maximum");
  assert.equal(h.pageSnapshot().complete, 25);
});

test("budget counts batch and retries; resume never repeats successful units", async (t) => {
  const h = createHarness({
    count: 25,
    settings: {
      labFeatures: { page: true },
      labPage: { maxRequests: 3, requestsPerSecond: 10 }
    },
    provider: (p, n) =>
      n === 1
        ? { ok: true, result: { translation: "mismatch" } }
        : translated(p.text)
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  const stats = h.pageSnapshot();
  assert.equal(stats.requests, 3);
  assert.equal(stats.state, "budget");
  assert.equal(stats.complete, 2);
  assert.equal(stats.remaining, 23);
  const successful = h.requests.slice(1).map((r) => r.text);
  h.setSettings({
    labFeatures: { page: true },
    labPage: { maxRequests: 10, requestsPerSecond: 10 }
  });
  await h.command("resume");
  await until(() => h.pageSnapshot().complete === 25);
  const resumedText = h.requests
    .slice(3)
    .map((r) => r.text)
    .join(" ||| ")
    .split(" ||| ");
  assert.ok(successful.every((text) => !resumedText.includes(text)));
});

test("character budget and estimate stop before sending, retry characters count too", async (t) => {
  const h = createHarness({
    count: 2,
    settings: { labFeatures: { page: true }, labPage: { maxChars: 1 } }
  });
  t.after(h.dispose);
  const estimate = await h.command("estimate");
  assert.equal(estimate.units, 2);
  assert.ok(estimate.chars > 1);
  assert.equal(h.requests.length, 0);
  await h.runPageTranslation();
  assert.equal(h.requests.length, 0);
  assert.equal(h.pageSnapshot().state, "budget");
  h.setSettings({ labFeatures: { page: true }, labPage: { maxChars: 1000 } });
  await h.command("resume");
  await until(() => h.pageSnapshot().complete === 2);
  assert.equal(
    h.pageSnapshot().sentChars,
    h.requests.reduce((n, r) => n + r.text.length, 0)
  );
});

test("pause cancels promptly; resume retains successes without a concurrent old pump", async (t) => {
  const pending = deferred();
  const h = createHarness({
    count: 30,
    provider: (p, n) => (n === 2 ? pending.promise : translated(p.text))
  });
  t.after(h.dispose);
  const running = h.runPageTranslation();
  await until(() => h.requests.length === 2);
  assert.equal(h.pageSnapshot().complete, 25);
  await h.command("pause");
  await running;
  assert.equal(h.pageSnapshot().state, "paused");
  pending.resolve(translated("obsolete"));
  await delay(0);
  await h.command("resume");
  await until(() => h.pageSnapshot().complete === 30);
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].text.split(" ||| ").length, 5);
  assert.equal(h.document.body.textContent.includes("obsolete"), false);
});

test("timeout pauses generation and never opens old fallback or applies late output", async (t) => {
  const pending = deferred();
  const h = createHarness({
    count: 25,
    settings: { labFeatures: { page: true }, labPage: { timeoutMs: 100 } },
    provider: () => pending.promise
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.equal(h.pageSnapshot().state, "paused");
  assert.match(h.pageSnapshot().error, /timed out/);
  pending.resolve({ ok: true, result: { translation: "bad delimiter" } });
  await delay(20);
  assert.equal(h.requests.length, 1);
  assert.equal(h.pageSnapshot().complete, 0);
});

test("near-viewport-only defers offscreen units until they enter viewport", async (t) => {
  const h = createHarness({
    count: 30,
    visible: [29],
    settings: {
      labFeatures: { page: true },
      labPage: { nearViewportOnly: true }
    }
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.equal(h.pageSnapshot().complete, 1);
  assert.equal(h.requests[0].text, "Synthetic 29");
  h.paragraphs[28].rect.top = 100;
  h.paragraphs[28].rect.bottom = 150;
  h.intersect([28]);
  await until(() => h.pageSnapshot().complete === 2);
  assert.equal(h.requests[1].text, "Synthetic 28");
});

test("Labs defaults off; live opt-out disconnects and restores", async (t) => {
  const h = createHarness({
    count: 1,
    settings: { labFeatures: {}, labPage: { live: true } }
  });
  t.after(h.dispose);
  const denied = await h.command("translate");
  assert.equal(denied.ok, false);
  assert.equal(h.requests.length, 0);
  await h.runPageTranslation();
  h.appendParagraph("Not auto translated");
  await delay(250);
  assert.equal(h.requests.length, 1);
  h.dispose();
  h.setSettings(live);
  await h.runPageTranslation();
  h.setSettings({ labFeatures: { page: false } }, true);
  h.appendParagraph("After opt out");
  await delay(250);
  assert.equal(h.document.querySelectorAll("[data-bntrans-wrapper]").length, 0);
  assert.equal(h.pageSnapshot().active, false);
});

test("newly protected descendants stay visible in translation-only mode", async (t) => {
  const h = createHarness({ settings: live });
  t.after(h.dispose);
  const p = h.appendParagraph("");
  const outer = h.document.createElement("span");
  outer.textContent = "Public synthetic";
  p.appendChild(outer);
  await h.runPageTranslation();
  const protectedNode = h.document.createElement("span");
  protectedNode.setAttribute("translate", "no");
  protectedNode.textContent = "NEW_PROTECTED_SYNTHETIC";
  outer.appendChild(protectedNode);
  await h.command("mode", { mode: "translation" });
  for (let ancestor = protectedNode; ancestor; ancestor = ancestor.parentNode)
    assert.notEqual(ancestor.style.display, "none");
  await until(() => h.requests.length === 2);
  assert.ok(
    h.requests.every((p) => !p.text.includes("NEW_PROTECTED_SYNTHETIC"))
  );
  assert.equal(protectedNode.isConnected, true);
});

test("pending mutation survives mode changes before observer delivery", async (t) => {
  const h = createHarness({ count: 1, settings: live });
  t.after(h.dispose);
  await h.runPageTranslation();
  h.appendParagraph("New before display mutation");
  await h.command("mode", { mode: "original" });
  await until(() => h.pageSnapshot().complete === 2);
  assert.equal(h.requests.length, 2);
});

test("provider-specific limits are bounded and isolated", (t) => {
  const h = createHarness();
  t.after(h.dispose);
  const settings = {
    activeProviderId: "synthetic-a",
    labFeatures: { page: true },
    labPage: {
      concurrency: 2,
      requestsPerSecond: 2,
      timeoutMs: 30000,
      providerLimits: {
        "synthetic-a": {
          concurrency: 99,
          requestsPerSecond: 0.5,
          timeoutMs: 5000
        },
        "synthetic-b": { concurrency: 1 }
      }
    }
  };
  assert.equal(h.pageOptions(settings).concurrency, 4);
  assert.equal(h.pageOptions(settings).requestsPerSecond, 0.5);
  assert.equal(h.pageOptions(settings).timeoutMs, 5000);
  assert.equal(
    h.pageOptions({ ...settings, activeProviderId: "synthetic-b" }).concurrency,
    1
  );
  assert.equal(
    h.pageOptions({ ...settings, activeProviderId: "synthetic-b" }).timeoutMs,
    30000
  );
});

test("QA retries count in the same request and character budget", async (t) => {
  const h = createHarness({
    count: 3,
    settings: { labFeatures: { page: true }, labPage: { maxRequests: 2 } },
    provider: (p, n) =>
      n === 1
        ? { ok: true, result: { translation: p.text } }
        : translated(p.text)
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.equal(h.requests.length, 2);
  assert.equal(h.pageSnapshot().requests, 2);
  assert.equal(
    h.pageSnapshot().sentChars,
    h.requests.reduce((n, p) => n + p.text.length, 0)
  );
  assert.equal(h.pageSnapshot().state, "budget");
  assert.equal(h.pageSnapshot().complete, 1);
  assert.equal(h.pageSnapshot().remaining, 2);
});

test("zero retries reports delimiter capability failure rather than fake translations", async (t) => {
  const h = createHarness({
    count: 2,
    settings: { labFeatures: { page: true }, labPage: { maxRetries: 0 } },
    provider: () => ({ ok: true, result: { translation: "mismatch" } })
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.equal(h.requests.length, 1);
  assert.equal(h.pageSnapshot().complete, 0);
  assert.match(h.pageSnapshot().error, /Delimiter mismatch/);
});

test("unchanged output after retry stays visible as a provider failure", async (t) => {
  const h = createHarness({
    count: 1,
    provider: (payload) => ({ ok: true, result: { translation: payload.text } })
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.equal(h.requests.length, 2);
  assert.equal(h.pageSnapshot().complete, 0);
  assert.match(h.pageSnapshot().error, /unchanged text/);
  assert.match(
    h.document.querySelectorAll("[data-bntrans-translation]")[0].textContent,
    /unchanged text/
  );
});
