#!/usr/bin/env node
/**
 * BNTrans live smoke test (task-08).
 * Loads extension/ unpacked into real Chrome via puppeteer (dependency provided
 * by the repo-installed chrome-devtools skill) and asserts:
 *   1. the MV3 service_worker target registers (chrome-extension://...)
 *   2. content_scripts CSS injects on a test http page
 * Content scripts only match http/https URLs, so the test page is served by a
 * local throwaway http server (data:/file: URLs do not receive content scripts).
 * Exits 0 only when every probe passes.
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

// Branded Google Chrome ignores --load-extension entirely (extension_service.cc:
// "--load-extension is not allowed in Google Chrome, ignoring"), so the smoke
// test must run on Chrome for Testing. Resolution order:
//   1. BNTRANS_CHROME env override
//   2. newest Chrome for Testing in ~/.cache/puppeteer
//   3. system Google Chrome (will fail the probes on branded builds)
function resolveChrome() {
  if (process.env.BNTRANS_CHROME) return process.env.BNTRANS_CHROME;
  const cache = join(homedir(), ".cache/puppeteer/chrome");
  if (existsSync(cache)) {
    for (const ver of readdirSync(cache).sort().reverse()) {
      const verDir = join(cache, ver);
      for (const arch of readdirSync(verDir)) {
        const bin = join(
          verDir,
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

if (!existsSync(CHROME)) {
  fail("reachability", `Chrome not found at ${CHROME}`);
  process.exit(1);
}
console.log(`Chrome: ${CHROME}`);

// Resolve puppeteer from the chrome-devtools skill's own dependencies.
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
if (!puppeteer) {
  fail("reachability", "puppeteer not resolvable — run skill install first");
  process.exit(1);
}

// Throwaway http page (content scripts need http/https)
const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<!doctype html><html><body><input id='t'></body></html>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const userDir = mkdtempSync(join(tmpdir(), "bntrans-smoke-"));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false, // MV3 extensions are not supported in old headless mode
    userDataDir: userDir,
    // puppeteer's default args include --disable-extensions which would
    // silently cancel --load-extension below
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--load-extension=${extDir}`,
      `--disable-extensions-except=${extDir}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble"
    ]
  });

  // Probe 1: MV3 service worker registered
  const deadline = Date.now() + 20000;
  let sw;
  while (Date.now() < deadline) {
    sw = browser
      .targets()
      .find(
        (t) =>
          t.type() === "service_worker" &&
          t.url().startsWith("chrome-extension://")
      );
    if (sw) break;
    await sleep(250);
  }
  if (sw) pass("service-worker", sw.url());
  else fail("service-worker", "no chrome-extension service worker within 20s");

  // Probe 2: content stylesheet injected on the test page
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, {
    waitUntil: "networkidle0",
    timeout: 30000
  });
  await sleep(1500);
  const extCss = await page.evaluate(() =>
    [...document.styleSheets]
      .map((s) => s.href || "")
      .filter((h) => h.startsWith("chrome-extension://"))
  );
  if (extCss.length > 0) pass("content-css", extCss.join(", "));
  else fail("content-css", "no chrome-extension stylesheet on test page");
} catch (err) {
  fail("launch", err?.message || String(err));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
  rmSync(userDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} smoke probe(s) FAILED`);
  process.exit(1);
}
console.log("\nSmoke test passed.");
