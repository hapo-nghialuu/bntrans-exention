import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import {
  normalizeSiteProfiles,
  findSiteProfile,
  applySiteProfile
} from "../extension/src/common/site-profiles.js";
import {
  checkTranslationQuality,
  qualityWarningText
} from "../extension/src/common/translation-quality.js";
import {
  captureQuickSelection,
  openQuickActions
} from "../extension/src/common/quick-actions.js";
import { mountProductivitySettings } from "../extension/src/common/productivity-settings.js";
import {
  prepareSettingsImport,
  createSettingsBackup
} from "../extension/src/common/settings-backup.js";
import {
  worker,
  local,
  google,
  success
} from "./test-labs-provider-harness.mjs";

const profile = {
  hostname: "example.test",
  sourceLanguage: "en",
  targetLanguage: "vi",
  translationStyle: "literal",
  glossary: { commit: "commit" }
};
test("site matching respects boundaries, opt-in subdomains and specificity", () => {
  const settings = { websiteProfiles: [profile] };
  assert.equal(findSiteProfile(settings, "https://sub.example.test"), null);
  assert.equal(findSiteProfile(settings, "https://badexample.test"), null);
  assert.equal(
    findSiteProfile(settings, "https://example.test.evil.test"),
    null
  );
  settings.websiteProfiles = [
    { ...profile, includeSubdomains: true },
    { ...profile, hostname: "sub.example.test", targetLanguage: "fr" }
  ];
  assert.equal(
    findSiteProfile(settings, "https://sub.example.test/path").targetLanguage,
    "fr"
  );
  assert.equal(
    findSiteProfile(settings, "https://other.example.test").targetLanguage,
    "vi"
  );
  assert.equal(findSiteProfile(settings, "file:///example.test"), null);
});
test("profile validation rejects ambiguous imports atomically", () => {
  for (const value of [
    null,
    {},
    [null],
    [{ hostname: "com" }],
    [{ hostname: "https://example.test" }],
    [{ ...profile, privacyDefaultMode: "cloud" }],
    [{ ...profile, enabled: "yes" }],
    [{ ...profile, targetLanguage: "auto" }],
    [{ ...profile, sourceLanguage: 0 }],
    [{ ...profile, glossary: { x: {} } }],
    [profile, { ...profile, hostname: "EXAMPLE.TEST." }]
  ]) {
    assert.throws(() => normalizeSiteProfiles(value));
    assert.throws(() => prepareSettingsImport({ websiteProfiles: value }));
  }
  assert.equal(
    normalizeSiteProfiles([{ hostname: "BÜCHER.example" }])[0].hostname,
    "xn--bcher-kva.example"
  );
});
test("profiles merge glossary without changing global settings or rewrite tasks", () => {
  const settings = {
    websiteProfiles: [profile],
    glossary: { base: "gốc" },
    privacyDefaultMode: "local-only"
  };
  const original = structuredClone(settings);
  const applied = applySiteProfile(
    settings,
    {
      sourceLanguage: "ja",
      targetLanguage: "de",
      siteUrl: "https://wrong.test"
    },
    { tab: { url: "https://example.test" } }
  );
  assert.deepEqual(applied.settings.glossary, {
    base: "gốc",
    commit: "commit"
  });
  assert.equal(applied.payload.targetLanguage, "vi");
  assert.equal(applied.settings.privacyDefaultMode, "local-only");
  assert.deepEqual(settings, original);
  assert.equal(
    applySiteProfile(settings, {
      task: "rewrite",
      siteUrl: "https://example.test",
      targetLanguage: "same"
    }).payload.targetLanguage,
    "same"
  );
  assert.deepEqual(
    createSettingsBackup({ websiteProfiles: [profile] }).websiteProfiles,
    [profile]
  );
});
test("quality checks preserve multisets and never alter text or leak token values", () => {
  const source = "Hello {name} {name}, %s https://example.test/a `foo()` 12.5%";
  assert.deepEqual(
    checkTranslationQuality(
      source,
      "Xin chào {name} {name}, %s https://example.test/a `foo()` 12.5%"
    ),
    []
  );
  const warnings = checkTranslationQuality(
    source,
    "Xin chào {name}, https://other.test/a `bar()` 15%"
  );
  assert.deepEqual(
    warnings.map((w) => w.kind),
    ["placeholders", "urls", "code", "numbers"]
  );
  assert.equal(warnings[0].missing, 2);
  assert.deepEqual(
    checkTranslationQuality(
      "[link](https://example.test/Foo_(bar)/a)",
      "[dịch](https://example.test/Foo_(bar)/a)"
    ),
    []
  );
  assert.equal(
    checkTranslationQuality(
      "https://example.test/Foo_(bar)/a",
      "https://example.test/Foo_(bar)/b"
    )[0].kind,
    "urls"
  );
  assert.ok(!JSON.stringify(warnings).includes("example.test"));
  assert.match(qualityWarningText(warnings, "vi"), /Cần kiểm tra/);
  assert.match(qualityWarningText(warnings), /Advisory only/);
  assert.deepEqual(checkTranslationQuality("One 12 and 12", "Hai 12"), [
    { kind: "numbers", missing: 1, added: 0 }
  ]);
  assert.deepEqual(
    checkTranslationQuality("```js\nfoo();\n```", "```javascript\nfoo();\n```"),
    []
  );
});
test("background applies sender site profile, isolates cache and returns diagnostics on cache hits", async () => {
  const w = worker({
    settings: {
      websiteProfiles: [profile],
      providers: [local],
      activeProviderId: local.id
    },
    fetch: async () => success("Hello")
  });
  const first = await w.translate(
    { text: "Hello {name} 12", targetLanguage: "de" },
    { tab: { url: "https://example.test" } }
  );
  assert.equal(first.ok, true);
  assert.equal(first.result.targetLanguage, "vi");
  assert.equal(first.result.siteProfile, "example.test");
  assert.equal(first.result.qualityWarnings.length, 2);
  const cached = await w.translate(
    { text: "Hello {name} 12", targetLanguage: "de" },
    { tab: { url: "https://example.test" } }
  );
  assert.equal(cached.result.cached, true);
  assert.deepEqual(cached.result.qualityWarnings, first.result.qualityWarnings);
  await w.translate(
    { text: "Hello {name} 12", targetLanguage: "vi" },
    { tab: { url: "https://other.test" } }
  );
  assert.equal(w.calls.length, 2);
});
test("site profiles cannot bypass privacy or opt into Google fallback", async () => {
  const w = worker({
    settings: {
      websiteProfiles: [profile],
      providers: [google],
      activeProviderId: google.id,
      labFeatures: { privacy: true },
      privacyDefaultMode: "local-only"
    }
  });
  const result = await w.translate(
    {},
    { tab: { url: "https://example.test" } }
  );
  assert.equal(result.ok, false);
  assert.equal(w.calls.length, 0);
});
test("quick selection is read-only, rejects sensitive ranges and invalidates stale text", () => {
  const dom = new JSDOM(
    "<body><p>Hello world</p><form><span>secret</span></form><p hidden>hidden</p></body>"
  );
  const doc = dom.window.document;
  const choose = (node) => {
    const range = doc.createRange();
    range.selectNodeContents(node);
    doc.defaultView.getSelection().removeAllRanges();
    doc.defaultView.getSelection().addRange(range);
  };
  choose(doc.querySelector("p"));
  const snapshot = captureQuickSelection(doc);
  assert.equal(snapshot.text, "Hello world");
  assert.equal(snapshot.valid(), true);
  doc.querySelector("p").firstChild.textContent = "Changed";
  assert.equal(snapshot.valid(), false);
  choose(doc.querySelector("form span"));
  assert.equal(captureQuickSelection(doc), null);
  choose(doc.querySelector("p[hidden]"));
  assert.equal(captureQuickSelection(doc), null);
  choose(doc.body);
  assert.equal(captureQuickSelection(doc), null);
  doc.querySelector("p").textContent = "x".repeat(8001);
  choose(doc.querySelector("p"));
  assert.equal(captureQuickSelection(doc), null);
  dom.window.close();
});

test("explicit session direction wins over profile; nonmatching and disabled profiles inherit defaults", () => {
  const settings = { websiteProfiles: [profile] };
  const payload = {
    siteUrl: "https://example.test",
    sourceLanguage: "ja",
    targetLanguage: "fr",
    languageOverride: true
  };
  assert.equal(
    applySiteProfile(settings, payload).payload.targetLanguage,
    "fr"
  );
  assert.equal(
    applySiteProfile(settings, payload).payload.sourceLanguage,
    "ja"
  );
  assert.equal(
    applySiteProfile(settings, { siteUrl: "https://other.test" }).settings,
    settings
  );
  assert.equal(
    findSiteProfile(
      { websiteProfiles: [{ ...profile, enabled: false }] },
      payload.siteUrl
    ),
    null
  );
  assert.equal(
    applySiteProfile(
      settings,
      { siteUrl: "https://example.test" },
      { tab: { url: "https://other.test" } }
    ).settings,
    settings
  );
});

test("quality is tolerant of prose punctuation and locale number separators, but flags broken Markdown", () => {
  assert.deepEqual(
    checkTranslationQuality("Price: 1,234.50; 1,234", "Giá: 1.234,50; 1234"),
    []
  );
  assert.deepEqual(
    checkTranslationQuality("Wait... Really?", "Đợi đã! Thật sao?"),
    []
  );
  assert.deepEqual(
    checkTranslationQuality("\\{literal} %%s", "văn bản thường"),
    []
  );
  assert.deepEqual(
    checkTranslationQuality("**hello** _word_ ~~old~~", "**chào** _từ_ ~~cũ~~"),
    []
  );
  assert.deepEqual(checkTranslationQuality("**hello** _word_", "chào từ"), [
    { kind: "markdown", missing: 4, added: 0 }
  ]);
  assert.equal(
    checkTranslationQuality("{x} {x} %1$s ${user.name}", "{x} %1$s")[0].missing,
    2
  );
});

test("Google fallback also returns quality diagnostics without retrying warnings", async () => {
  const w = worker({
    settings: { allowCloudFallback: true },
    fetch: async (url) => {
      if (String(url).includes("localhost"))
        throw new Error("Local unavailable");
      return success("Xin chào");
    }
  });
  const response = await w.translate({ text: "Hello {name}" });
  assert.equal(response.ok, true);
  assert.equal(response.result.providerName, "Google Translate (fallback)");
  assert.equal(response.result.qualityWarnings[0].kind, "placeholders");
  assert.equal(w.calls.length, 2);
});

test("profile respects ask consent and destination restrictions", async () => {
  for (const privacy of [
    { privacyDefaultMode: "ask" },
    {
      privacyDefaultMode: "cloud",
      privacyRules: [
        {
          hostname: "example.test",
          mode: "cloud",
          allowedDestinations: ["https://safe.test"]
        }
      ]
    }
  ]) {
    const w = worker({
      settings: {
        ...privacy,
        websiteProfiles: [profile],
        labFeatures: { privacy: true },
        providers: [google],
        activeProviderId: google.id
      }
    });
    const response = await w.translate(
      { cloudConsent: true },
      { tab: { url: "https://example.test" } }
    );
    assert.equal(response.ok, false);
    assert.equal(w.calls.length, 0);
  }
});

function quickDom() {
  const dom = new JSDOM("<body><p>Hello {name} 12</p></body>", {
    url: "https://example.test/page"
  });
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.querySelector("p"));
  dom.window.getSelection().addRange(range);
  return dom;
}

test("opening Quick Actions sends nothing, renders text safely and cleans up on Escape/settings changes", async (t) => {
  const dom = quickDom(),
    listeners = new Set();
  let sent = 0;
  const old = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      sendMessage() {
        sent++;
        throw new Error("Must not run without user action");
      }
    },
    storage: {
      local: {
        get: async () => ({
          translatorSettings: { websiteProfiles: [profile] }
        })
      },
      onChanged: {
        addListener(fn) {
          listeners.add(fn);
        },
        removeListener(fn) {
          listeners.delete(fn);
        }
      }
    }
  };
  t.after(() => {
    globalThis.chrome = old;
    dom.window.close();
  });
  await openQuickActions(dom.window.document);
  const shadow = dom.window.document.querySelector(
    "[data-bntrans-quick]"
  ).shadowRoot;
  assert.equal(
    shadow.querySelector("[role=dialog]").getAttribute("aria-label"),
    "BNTrans Quick Actions"
  );
  assert.equal(shadow.querySelector(".source").textContent, "Hello {name} 12");
  assert.equal(shadow.activeElement.textContent, "Close");
  assert.match(shadow.querySelector(".meta").textContent, /en → vi/);
  [...shadow.querySelectorAll("button")]
    .find((node) => node.textContent === "Translate")
    .click();
  assert.equal(sent, 0);
  shadow
    .querySelector("button")
    .dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
  assert.equal(dom.window.document.querySelector("[data-bntrans-quick]"), null);
  assert.equal(listeners.size, 0);
  await openQuickActions(dom.window.document);
  for (const fn of listeners)
    fn({ translatorSettings: { newValue: {} } }, "local");
  assert.equal(dom.window.document.querySelector("[data-bntrans-quick]"), null);
  assert.equal(sent, 0);
});

test("Quick Actions never opens for focused password/OTP inputs or disabled extension", async (t) => {
  const dom = quickDom();
  const doc = dom.window.document;
  const input = doc.createElement("input");
  doc.body.append(input);
  for (const autocomplete of [
    "current-password",
    "one-time-code",
    "cc-number",
    "username"
  ]) {
    input.autocomplete = autocomplete;
    input.focus();
    assert.equal(captureQuickSelection(doc), null);
  }
  input.type = "password";
  assert.equal(captureQuickSelection(doc), null);
  input.remove();
  const old = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ translatorSettings: { enabled: false } }) }
    }
  };
  t.after(() => {
    globalThis.chrome = old;
    dom.window.close();
  });
  await openQuickActions(doc);
  assert.equal(doc.querySelector("[data-bntrans-quick]"), null);
});

test("Options profile editor saves, edits and deletes validated settings without waking service worker", async (t) => {
  const dom = new JSDOM("<body><main id=container></main></body>");
  const previous = {
    chrome: globalThis.chrome,
    document: globalThis.document,
    Option: globalThis.Option
  };
  let stored = {
    interfaceLanguage: "vi",
    providers: [google],
    activeProviderId: google.id
  };
  globalThis.document = dom.window.document;
  globalThis.Option = dom.window.Option;
  globalThis.chrome = {
    commands: {
      getAll: async () => [{ name: "quick-actions", shortcut: "Alt+Shift+K" }]
    },
    runtime: {
      sendMessage() {
        throw new Error("Service worker unavailable");
      }
    },
    storage: {
      local: {
        get: async () => ({ translatorSettings: structuredClone(stored) }),
        set: async (values) => {
          stored = structuredClone(values.translatorSettings);
        }
      }
    }
  };
  t.after(() => {
    Object.assign(globalThis, previous);
    dom.window.close();
  });
  const container = document.querySelector("main");
  await mountProductivitySettings(container);
  assert.match(container.textContent, /Alt\+Shift\+K/);
  const fill = () => {
    container.querySelector("input[type=text], input:not([type])").value =
      "example.test";
    const selects = container.querySelectorAll("select");
    selects[0].value = "en";
    selects[1].value = "vi";
    selects[2].value = "literal";
    container.querySelector("textarea").value = "commit = commit";
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  fill();
  container
    .querySelector("form")
    .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(stored.websiteProfiles.length, 1);
  assert.equal(stored.websiteProfiles[0].hostname, "example.test");
  assert.equal(stored.activeProviderId, google.id);
  const edit = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Sửa"
  );
  edit.click();
  await settle();
  container.querySelector("textarea").value = "commit = xác nhận";
  container
    .querySelector("form")
    .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(stored.websiteProfiles[0].glossary.commit, "xác nhận");
  [...container.querySelectorAll("button")]
    .find((node) => node.textContent === "Xóa")
    .click();
  await settle();
  assert.deepEqual(stored.websiteProfiles, []);
});

test("Quick Actions uses Chrome-managed configurable shortcuts with independent Mac modifier mapping", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")
  );
  assert.equal(
    manifest.commands["quick-actions"].suggested_key.default,
    "Alt+Shift+K"
  );
  assert.equal(
    manifest.commands["quick-actions"].suggested_key.mac,
    "Command+Shift+K"
  );
  const script = readFileSync(
    new URL("../extension/src/content-quick-actions.js", import.meta.url),
    "utf8"
  );
  assert.match(script, /sender.id !== chrome.runtime.id/);
  assert.ok(!script.includes("preventDefault"));
  assert.ok(!script.includes('addEventListener("keydown"'));
});
