#!/usr/bin/env node
/**
 * Screenshot-area translation e2e. Requires GEMINI_KEY env.
 * Flow: launch Chrome+ext → seed gemini provider → test page →
 * sendMessage start-screenshot-select → drag → captureVisibleTab →
 * crop → Gemini vision → assert result popup has translation.
 */
import http from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extDir = join(root, "extension");
const skillDir = join(root, ".agents/skills/chrome-devtools/scripts");
const KEY = process.env.GEMINI_KEY;
if (!KEY) {
  console.error("GEMINI_KEY env required");
  process.exit(1);
}

function resolveChrome() {
  if (process.env.BNTRANS_CHROME) return process.env.BNTRANS_CHROME;
  const cache = join(homedir(), ".cache/puppeteer/chrome");
  if (existsSync(cache)) {
    for (const ver of readdirSync(cache).sort().reverse()) {
      for (const arch of readdirSync(join(cache, ver))) {
        const bin = join(
          cache,
          ver,
          arch,
          "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        );
        if (existsSync(bin)) return bin;
      }
    }
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}
const CHROME = resolveChrome();

let failures = 0;
const pass = (n, d = "") => console.log(`PASS ${n}${d ? ` — ${d}` : ""}`);
const fail = (n, d) => {
  failures++;
  console.log(`FAIL ${n} — ${d}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let puppeteer;
try {
  puppeteer = createRequire(join(skillDir, "package.json"))("puppeteer");
} catch {
  puppeteer = (
    await import(
      pathToFileURL(
        join(skillDir, "node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js")
      ).href
    )
  ).default;
}

const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><html><body style="background:#fff">
    <div id="shot" style="position:fixed;left:120px;top:120px;width:420px;
      padding:20px;font:24px/1.5 sans-serif;border:1px solid #ccc">
      The quick brown fox jumps over the lazy dog
    </div></body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const userDir = mkdtempSync(join(tmpdir(), "bntrans-shot-"));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    userDataDir: userDir,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--load-extension=${extDir}`,
      `--disable-extensions-except=${extDir}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  const deadline = Date.now() + 20000;
  let swTarget;
  while (Date.now() < deadline) {
    swTarget = browser
      .targets()
      .find(
        (t) =>
          t.type() === "service_worker" &&
          t.url().startsWith("chrome-extension://")
      );
    if (swTarget) break;
    await sleep(250);
  }
  if (!swTarget) {
    fail("sw", "no service worker");
    throw new Error("no sw");
  }
  pass("service-worker");
  const sw = await swTarget.worker();

  // Seed settings: gemini provider + vi target
  await sw.evaluate(
    (key) =>
      chrome.storage.local.set({
        translatorSettings: {
          enabled: true,
          nativeLanguageCode: "vi",
          targetLanguageCode: "vi",
          useAutoDetect: false,
          interfaceLanguage: "en",
          theme: "auto",
          activeProviderId: "google-translate",
          providers: [
            {
              id: "gemini-test",
              name: "Gemini",
              type: "gemini",
              config: { apiKey: key, model: "gemini-3.1-flash-lite" }
            }
          ]
        }
      }),
    KEY
  );
  pass("seed-settings");

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.goto(`http://127.0.0.1:${port}/`, {
    waitUntil: "networkidle0"
  });
  await sleep(1200); // content script boot

  // Trigger overlay via the same path as context menu
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    await chrome.tabs.sendMessage(tab.id, { type: "start-screenshot-select" });
  });
  await sleep(300);
  const overlay = await page.$(".bt-shot-overlay");
  overlay ? pass("overlay-shown") : fail("overlay-shown", "no overlay");
  await page.bringToFront();

  // Drag a rect around the text block (120..560 x, 110..210 y)
  await page.mouse.move(110, 105);
  await page.mouse.down();
  await page.mouse.move(570, 215, { steps: 8 });
  await page.mouse.up();

  // Wait for result popup + translation (gemini ~1-3s; allow 30s)
  const ok = await page
    .waitForFunction(
      () => {
        const el = document.querySelector(
          ".bt-shot-popup .bt-shot-result-text"
        );
        return el && !el.classList.contains("bt-loading-text");
      },
      { timeout: 30000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    fail("result", "popup never left loading state");
  } else {
    const out = await page.evaluate(() => ({
      source: document.querySelector(".bt-shot-source-text")?.textContent,
      translation: document.querySelector(".bt-shot-result-text")?.textContent,
      provider: document.querySelector(".bt-shot-provider")?.textContent
    }));
    console.log("  source:", JSON.stringify(out.source));
    console.log("  translation:", JSON.stringify(out.translation));
    if (/cáo|con cáo|nhanh|nhảy|chó|lười/i.test(out.translation || ""))
      pass("translation", out.translation);
    else if (out.translation && out.translation.length > 3)
      pass("translation-nonempty", out.translation);
    else fail("translation", JSON.stringify(out));

    // Language switcher: change target to Japanese, expect re-translation
    await page.select(".bt-shot-target-select", "ja");
    const switched = await page
      .waitForFunction(
        (prev) => {
          const el = document.querySelector(".bt-shot-result-text");
          return (
            el &&
            !el.classList.contains("bt-loading-text") &&
            el.textContent !== prev
          );
        },
        { timeout: 30000 },
        out.translation
      )
      .then(() => true)
      .catch(() => false);
    if (switched) {
      const ja = await page.evaluate(
        () => document.querySelector(".bt-shot-result-text")?.textContent
      );
      console.log("  ja:", JSON.stringify(ja));
      /[ぁ-んァ-ン一-龥]/.test(ja || "")
        ? pass("target-switch", ja)
        : fail("target-switch", `not japanese: ${ja}`);
      const saved = await sw.evaluate(
        async () =>
          (await chrome.storage.local.get("translatorSettings"))
            .translatorSettings?.selectionLastTarget
      );
      saved === "ja"
        ? pass("target-saved", "selectionLastTarget=ja")
        : fail("target-saved", `got ${saved}`);
    } else {
      fail("target-switch", "no re-translation after select change");
    }
  }

  // Escape-cancel path: trigger again, press Escape, overlay must go
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    await chrome.tabs.sendMessage(tab.id, { type: "start-screenshot-select" });
  });
  await sleep(300);
  await page.keyboard.press("Escape");
  await sleep(300);
  const gone = await page.$(".bt-shot-overlay");
  !gone ? pass("escape-cancel") : fail("escape-cancel", "overlay survived Esc");

  // No-gemini error path: wipe key, retry → popup should show actionable error
  await sw.evaluate(() =>
    chrome.storage.local.set({
      translatorSettings: { providers: [], targetLanguageCode: "vi" }
    })
  );
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    await chrome.tabs.sendMessage(tab.id, { type: "start-screenshot-select" });
  });
  await sleep(200);
  await page.mouse.move(110, 105);
  await page.mouse.down();
  await page.mouse.move(570, 215, { steps: 5 });
  await page.mouse.up();
  const errShown = await page
    .waitForFunction(
      () => {
        const el = document.querySelector(
          ".bt-shot-popup .bt-shot-result-text"
        );
        return el && /Gemini API key/i.test(el.textContent || "");
      },
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);
  errShown
    ? pass("no-key-error", "actionable error shown in popup")
    : fail("no-key-error", "no error surfaced");

  // Context menu registered?
  const menuOk = await sw.evaluate(
    () =>
      new Promise((r) =>
        chrome.contextMenus.remove("bntrans-screenshot-area", () =>
          r(!chrome.runtime.lastError)
        )
      )
  );
  menuOk
    ? pass("context-menu", "bntrans-screenshot-area registered")
    : fail("context-menu", "menu id absent");
} catch (err) {
  fail("unexpected", err.message);
} finally {
  if (browser) await browser.close();
  server.close();
  rmSync(userDir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
