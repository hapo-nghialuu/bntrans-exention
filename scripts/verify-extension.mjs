#!/usr/bin/env node
/**
 * BNTrans port verification harness (task-07).
 * Static probes: manifest refs (a), script order (a2), getURL/import refs (b),
 * feature markers (c), provider cases (d), data-i18n key coverage (e),
 * manifest branding (f), popup product-name (g).
 * Exit 0 when every probe passes; prints one PASS/FAIL line per group.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ext = join(root, "extension");
let failures = 0;

function pass(name, detail = "") {
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  failures++;
  console.log(`FAIL ${name} — ${detail}`);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Resolve an extension-internal reference the way Chrome would:
// absolute-from-extension-root, with `..` clamped at the root.
function resolveExtRef(ref) {
  const pathname = new URL(ref, "chrome-extension://bntrans/").pathname;
  return join(ext, decodeURIComponent(pathname).replace(/^\/+/, ""));
}

// ---------- (f) manifest loads + BNTrans name ----------
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
} catch (err) {
  fail("manifest-parse", err.message);
}
if (manifest) {
  if (manifest.manifest_version === 3 && /BNTrans/i.test(manifest.name)) {
    pass("manifest-branding", `name="${manifest.name}" v${manifest.version}`);
  } else {
    fail(
      "manifest-branding",
      `manifest_version=${manifest.manifest_version} name=${JSON.stringify(manifest.name)}`
    );
  }
}

// ---------- (a) every manifest-referenced path exists ----------
if (manifest) {
  const refs = [];
  for (const v of Object.values(manifest.icons || {})) refs.push(v);
  for (const v of Object.values(manifest.action?.default_icon || {})) refs.push(v);
  if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
  if (manifest.options_ui?.page) refs.push(manifest.options_ui.page);
  if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) {
    refs.push(...(cs.js || []), ...(cs.css || []));
  }
  const missing = refs.filter((r) => !existsSync(resolveExtRef(r)));

  // web_accessible_resources globs: dir must exist and be non-empty
  const warMisses = [];
  for (const war of manifest.web_accessible_resources || []) {
    for (const res of war.resources || []) {
      if (res.endsWith("/*")) {
        const dir = resolveExtRef(res.slice(0, -2));
        if (!existsSync(dir) || readdirSync(dir).length === 0) {
          warMisses.push(res);
        }
      } else if (!existsSync(resolveExtRef(res))) {
        warMisses.push(res);
      }
    }
  }

  if (missing.length === 0 && warMisses.length === 0) {
    pass("manifest-paths", `${refs.length} refs + ${(manifest.web_accessible_resources || []).length} WAR groups`);
  } else {
    fail("manifest-paths", `missing=${missing.join(",")} war=${warMisses.join(",")}`);
  }

  // ---------- (a2) granularity loads before content-script ----------
  const csJs = manifest.content_scripts?.[0]?.js || [];
  const granIdx = csJs.findIndex((f) => /granularity/.test(f));
  const mainIdx = csJs.findIndex((f) => /content-script\.js$/.test(f));
  if (granIdx !== -1 && mainIdx !== -1 && granIdx < mainIdx) {
    pass("script-order", csJs.join(" -> "));
  } else {
    fail("script-order", `js=${csJs.join(",")}`);
  }
}

// ---------- (b) getURL + relative import literal paths resolve ----------
const jsFiles = walk(join(ext, "src")).filter((f) => f.endsWith(".js"));
const htmlFiles = existsSync(join(ext, "pages"))
  ? readdirSync(join(ext, "pages")).filter((f) => f.endsWith(".html")).map((f) => join(ext, "pages", f))
  : [];
const refFails = [];
for (const file of jsFiles) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/getURL\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    if (m[1] === "test") continue; // context-validity probe, not a resource
    if (!existsSync(resolveExtRef(m[1]))) {
      refFails.push(`${file.slice(root.length + 1)} getURL(${m[1]})`);
    }
  }
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
    if (!m[1].startsWith(".")) continue;
    if (!existsSync(join(dirname(file), m[1]))) {
      refFails.push(`${file.slice(root.length + 1)} import ${m[1]}`);
    }
  }
}
for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    if (!existsSync(resolveExtRef(m[1]))) {
      refFails.push(`${file.slice(root.length + 1)} ${m[1]}`);
    }
  }
}
if (refFails.length === 0) {
  pass("resource-refs", `${jsFiles.length} js + ${htmlFiles.length} html scanned`);
} else {
  fail("resource-refs", refFails.join("; "));
}

// ---------- (c) feature markers present ----------
const cs = readFileSync(join(ext, "src/content-script.js"), "utf8");
const gran = readFileSync(join(ext, "src/content-script-granularity.js"), "utf8");
const all = cs + "\n" + gran;
const markers = [
  "TRANSLATION_COMMAND_PATTERN",
  "handleAutoTranslation",
  "buildInlineSuggestion",
  "registerInstantMode",
  "registerInstantToggleShortcut",
  "registerInstantLabelIndicator",
  "showTranslateIcon",
  "showTranslationPopup",
  "registerSelectionMode",
  "safeRuntimeCall",
  "isExtensionContextValid",
  "cleanupExtensionElements",
  "registerHoverTranslate",
  "handleHoverTranslate",
  "createHoverPlaceholder",
  "updateHoverContent",
  "clearAllHoverTranslations",
  "getTranslationUnits",
  "handleLineByLineTranslate",
  "handleSentenceBySentenceTranslate"
];
const missingMarkers = markers.filter((mk) => !all.includes(mk));
if (missingMarkers.length === 0) {
  pass("feature-markers", `${markers.length} markers`);
} else {
  fail("feature-markers", `missing: ${missingMarkers.join(", ")}`);
}

// ---------- (d) provider switch cases ----------
const providers = readFileSync(join(ext, "src/services/ai-providers.js"), "utf8");
const providerCases = [
  "gemini",
  "openai",
  "openrouter",
  "deepl",
  "google-translate",
  "groq",
  "ollama",
  "custom",
  "gemini-nano"
];
const missingProviders = providerCases.filter(
  (p) => !providers.includes(`case "${p}"`)
);
if (missingProviders.length === 0) {
  pass("providers", `${providerCases.length} provider cases`);
} else {
  fail("providers", `missing case: ${missingProviders.join(", ")}`);
}

// ---------- (e) data-i18n keys resolve in both locales ----------
const popupHtml = readFileSync(join(ext, "pages/popup.html"), "utf8");
const localesSrc = readFileSync(join(ext, "src/common/locales.js"), "utf8");
function localeKeys(src, name) {
  const start = src.indexOf(`${name}: {`);
  if (start === -1) return new Set();
  let depth = 0;
  let i = src.indexOf("{", start);
  const begin = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const block = src.slice(begin, i + 1);
  return new Set([...block.matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]));
}
const enKeys = localeKeys(localesSrc, "en");
const viKeys = localeKeys(localesSrc, "vi");
const i18nKeys = [...popupHtml.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
const missingEn = i18nKeys.filter((k) => !enKeys.has(k));
const missingVi = i18nKeys.filter((k) => !viKeys.has(k));
if (missingEn.length === 0 && missingVi.length === 0) {
  pass("i18n-keys", `${i18nKeys.length} data-i18n keys covered en+vi`);
} else {
  fail("i18n-keys", `missing en: ${missingEn.join(",")} | missing vi: ${missingVi.join(",")}`);
}

// ---------- (g) product-name surfaces read BNTrans ----------
const nameChecks = [
  [/<title>BNTrans<\/title>/.test(popupHtml), "popup <title>"],
  [/alt="BNTrans"/.test(popupHtml), "popup img alt"],
  [(localesSrc.match(/"popup\.title":\s*"BNTrans"/g) || []).length === 2, "popup.title en+vi"]
];
const nameFails = nameChecks.filter(([ok]) => !ok).map(([, label]) => label);
if (nameFails.length === 0) {
  pass("product-name", "title/alt/locales = BNTrans");
} else {
  fail("product-name", `not BNTrans: ${nameFails.join(", ")}`);
}

// ---------- summary ----------
if (failures > 0) {
  console.log(`\n${failures} probe group(s) FAILED`);
  process.exit(1);
}
console.log("\nAll probes passed.");
