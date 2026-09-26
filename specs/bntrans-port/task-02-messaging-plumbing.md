# Task 02 — Messaging plumbing + common modules

Status: pending

## Outcome
Background service worker, offscreen document, and shared common modules are ported
verbatim so the content↔SW↔offscreen translation pipeline works end to end.

## Scope
- In: verbatim copy of `extension/src/background.js`, `extension/src/offscreen.js`,
  `extension/pages/offscreen.html`, `extension/src/common/{language-map.js,i18n.js,locales.js}`
- Out: any logic change; popup page; services (task-03)

## Coverage
- CP-07 (offscreen `play-tts` half), CP-12

## Ownership
- Create: `extension/src/background.js`, `extension/src/offscreen.js`,
  `extension/pages/offscreen.html`, `extension/src/common/language-map.js`,
  `extension/src/common/i18n.js`, `extension/src/common/locales.js`

## Acceptance
- AC-07 (partial): offscreen document handles `play-tts` with URL-template audio.
- CP-12: `onMessage` covers `ping`, `get-settings`, `set-settings`, `translate`,
  `open-options`, `tts-play`; `ensureOffscreen` guards document creation;
  settings defaults include providers, instant domains, hover config.

## Dependencies
- task-01-scaffold-manifest.md

## Verification Plan
- Command: `npx eslint extension/src/background.js extension/src/offscreen.js extension/src/common/`
- Named probe: eslint-clean (parses as ESM, prettier-clean, no undef beyond declared globals)
- Reachability: `npm install` from task-01 provides eslint; donor globals `Translator`/`LanguageDetector` are declared in eslint.config
- Oracle: exit 0
- Counterexample: a truncated copy (e.g. missing `safeRuntimeCall` caller paths or unterminated blocks) fails eslint parse
- Artifacts: ephemeral

## Receipt
<!-- Fill only after execution; see canonical form below. -->
