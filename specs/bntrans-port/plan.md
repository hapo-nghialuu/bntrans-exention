# BNTrans — port TransKit extension

Specs-Contract: process-first-ready-v1

## Scope decision (C1 — 2026-09-26)

- Existing: donor repo `/Users/nghialuutrung/Desktop/transkit-extension/extension/` — full MV3 extension
  (`manifest.json`, `src/background.js`, `src/offscreen.js`, `src/content-script.js`,
  `src/content-script-granularity.js`, `src/popup.js`, `src/services/*`, `src/common/*`,
  `pages/*`, `assets/*`). Target repo has zero extension code (only CafeKit tooling).
- Minimum change: copy the donor `extension/` tree, rebrand manifest to BNTrans,
  generate a new app logo via `gpt-image2`, reuse donor's icon set elsewhere.
- Expansion signals: >8 files; 5 independent surfaces (content modes, providers,
  popup UI, offscreen AI, assets).
- User decision: KEEP — port the entire extension (all 4 translate modes, all
  providers, TTS, popup settings, i18n). Branding: manifest name/description/author
  become BNTrans; CSS prefixes, internal identifiers, and UI copy stay as-is.
  Assets: new generated logo for app icons; system icons reuse the best existing set.

## Out of scope

- `landing/` site, README/DEVELOPER/CONTRIBUTING docs, `.github/` workflows
- Donor root `src/` stale duplicates (not referenced by manifest)
- `extension/src/content-script-helpers.js` and `content-script-hover.js` — dead files
  not listed in `manifest.json:32-44`
- `EXTENSION_CONTEXT_FIX.md` dev note
- Deep rebrand: CSS `bt-` prefixes, `data-i18n` keys, internal identifiers, code comments
- Provider API-key encryption — accepted donor parity (R5): keys stay plaintext in
  `chrome.storage.local`; surfaced as limitation at C3
- New features beyond donor parity

## Coverage profile

| ID | Outcome | Change kinds | Material surfaces | Ambiguity/action | Risk/evidence | Required proof |
|---|---|---|---|---|---|---|
| CP-01 | Extension installs as MV3 named BNTrans | add, migrate | `extension/manifest.json` | none | elevated: invalid manifest blocks load | installed, live |
| CP-02 | Manual `!!<lang>`/`!!t` translation in inputs | migrate | `extension/src/content-script.js` | none | routine: donor-proven code | source |
| CP-03 | Instant domain mode + inline suggestion + toggle shortcut | migrate | `extension/src/content-script.js` | none | elevated: installed DOM behavior | source |
| CP-04 | Select-to-translate draggable popup | migrate | `extension/src/content-script.js`, selection.css | none | routine | source |
| CP-05 | Hover translate inject/replace + granularity | migrate | `extension/src/content-script.js`, `content-script-granularity.js` | none | elevated: DOM mutation | source |
| CP-06 | Provider routing: google-translate, gemini-nano, gemini, openai, openrouter, deepl, groq, ollama/custom | migrate | `src/services/ai-providers.js`, `src/background.js` | none | elevated: external API contracts | source |
| CP-07 | TTS playback through offscreen audio | migrate | `src/services/tts.js`, `src/offscreen.js` | none | routine | source |
| CP-08 | Settings popup: 5 tabs, persistence, EN/VI i18n | migrate | `pages/popup.html`, `src/popup.js`, `src/common/locales.js` | none | routine | source, installed |
| CP-09 | HTML formatting preserved via markdown round-trip | migrate | `src/services/format-utils.js`, `src/background.js` | none | routine | source |
| CP-10 | Extension-context invalidation handled without unhandled errors | migrate | `src/content-script.js` | none | routine | source |
| CP-11 | BNTrans identity: manifest name, popup product-name strings, generated logo icons at all referenced sizes | add, migrate | `extension/assets/icons/icon-*.png`, `pages/popup.html`, `src/common/locales.js` | none | routine: broken refs block load | installed |
| CP-12 | Message plumbing content↔SW↔offscreen + settings storage | migrate | `src/background.js`, `src/offscreen.js`, `src/common/*` | none | elevated: cross-context contract | source |

## Acceptance criteria

| ID | EARS criterion | Proof |
|---|---|---|
| AC-01 | The extension shall ship a valid Manifest V3 file named "BNTrans" whose every referenced icon, page, script, and stylesheet path exists on disk. | `node scripts/verify-extension.mjs` |
| AC-02 | When the user appends `!!<lang>` or `!!t` to editable text, the content script shall detect the command and request a translation. | `npx eslint extension/src/content-script.js` + pattern probe in verify script |
| AC-03 | While instant mode is enabled for the current domain, the extension shall render an inline suggestion after the configured delay and apply it on Tab. | `npx eslint extension/src/content-script.js` |
| AC-04 | When text is selected, the extension shall show a draggable translate popup with language and provider selectors. | `npx eslint extension/src/content-script.js` |
| AC-05 | Where hover translate is enabled, holding the configured modifier while hovering shall inject or replace the translation per settings. | `npx eslint extension/src/content-script.js extension/src/content-script-granularity.js` |
| AC-06 | The provider layer shall support google-translate (default), gemini-nano via offscreen, gemini, openai, openrouter, deepl, groq, and ollama/custom endpoints with custom prompt injection. | `npx eslint extension/src/services/ai-providers.js` + provider probe in verify script |
| AC-07 | When TTS is requested, the offscreen document shall play audio built from the configured URL template. | `npx eslint extension/src/offscreen.js extension/src/services/tts.js` |
| AC-08 | The popup shall expose General, Instant, AI Provider, TTS, and Help tabs persisting to `chrome.storage.local` with EN/VI locales. | `node scripts/verify-extension.mjs` |
| AC-09 | When translating HTML input, the extension shall convert to markdown and back so formatting survives. | `npx eslint extension/src/services/format-utils.js` |
| AC-10 | If the extension context is invalidated, the content script shall clean up its DOM without unhandled errors. | `npx eslint extension/src/content-script.js` + handler probe in verify script |
| AC-11 | All linted extension sources shall satisfy `npm run lint` with exit 0. | `npm run lint` |
| AC-12 | The extension shall include a BNTrans logo exported at every size referenced by the manifest. | `node scripts/verify-extension.mjs` |
| AC-13 | When loaded unpacked into Chrome, the extension shall register its service worker and inject its content stylesheets on a test page. | `node scripts/smoke-extension.mjs` |
| AC-14 | The extension's user-visible product name (manifest `name`, popup `<title>`/img `alt`, `popup.title` locale values EN+VI) shall read "BNTrans". | `node scripts/verify-extension.mjs` |

## Tasks

| # | Task | Criteria | Primary ownership | Dependencies | Status |
|---|---|---|---|---|---|
| 01 | Scaffold + BNTrans manifest | AC-01, AC-11 | `package.json`, `eslint.config.mjs`, `.prettierrc`, `.gitignore`, `extension/manifest.json`, `extension/assets/styles/` | - | blocked |
| 02 | Messaging plumbing + common modules | AC-07 (partial), CP-12 | `extension/src/background.js`, `extension/src/offscreen.js`, `extension/pages/offscreen.html`, `extension/src/common/` | task-01 | blocked |
| 03 | Provider/format/TTS services | AC-06, AC-07, AC-09 | `extension/src/services/` | task-01 | blocked |
| 04 | Content scripts (all 4 modes) | AC-02, AC-03, AC-04, AC-05, AC-10 | `extension/src/content-script.js`, `extension/src/content-script-granularity.js` | task-01 | blocked |
| 05 | Settings popup UI | AC-08, AC-14 | `extension/pages/popup.html`, `extension/src/popup.js` | task-01, task-02 | blocked |
| 06 | BNTrans logo + icon set | AC-12 | `extension/assets/icons/` | task-01 | blocked |
| 07 | Verification harness + full lint | AC-01..AC-11, AC-14 | `scripts/verify-extension.mjs`, repo-wide lint | task-02, task-03, task-04, task-05, task-06 | blocked |
| 08 | Live smoke test | AC-13 | `scripts/smoke-extension.mjs` | task-07 | blocked |

## Review log

- Round 1: 6 findings (R1–R6) presented at C2 — R1 accept (rename visible product-name
  strings), R2 accept (add task-08 live smoke), R3/R5/R6 accept (order probe, donor-parity
  API keys, icon fallback), R4 accept (version 1.0.0 + drop stale repository field —
  no git remote exists). All repairs applied; sweep below.

| ID | Decision | Original counterexample | Repaired at | Proved at | Replay | Closure |
|---|---|---|---|---|---|---|
| R1 | accept | popup shows "TransKit" in BNTrans install | task-05 Scope/Acceptance; plan AC-14, CP-11 | task-07 probe (g) asserts popup title/locales; AC-14 row | repair adds rename + probe; replayed counterexample now covered by probe (g) | PASS (paper) |
| R2 | accept | lint-clean port could still die at runtime | new `task-08-smoke-test.md`; plan AC-13, CP-01 live | task-08 Verification Plan (SW target + injected stylesheet probes) | counterexample now has a live-level command | PASS (paper) |
| R3 | accept | reordered content_scripts silently break hover translate | task-07 Scope probe (a2) | task-07 Acceptance AC-01 | probe asserts granularity loads first | PASS (paper) |
| R4 | accept | package.json keeps transkit repo url + 1.2.2 | task-01 Scope (1.0.0, `private: true`, drop repository) | task-01 Verification Command prints manifest name/version | metadata fix visible in task scope | PASS (paper) |
| R5 | accept | plaintext API keys in storage.local | plan "Out of scope" donor-parity note | this row + C3 limitation note | no code change; limitation recorded | PASS |
| R6 | accept | gpt-image2 unreachable leaves icons missing | task-06 Reachability + fallback clause | task-06 Acceptance keeps icon-dimensions probe on whichever source | fallback = copy donor icon set, receipt notes source used | PASS (paper) |

- Sweep: 8 files reread; deltas — CP-01 live proof, CP-11 expanded to product-name,
  AC-13/AC-14 added, task-05 dep + rename scope, task-06 fallback, task-07 probes
  (a2)+(g), task-08 created; stale references fixed: none; conflicts left: none.
