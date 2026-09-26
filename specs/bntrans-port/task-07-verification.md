# Task 07 — Verification harness + full lint

Status: pending

## Outcome
`scripts/verify-extension.mjs` statically proves the port is internally consistent
(manifest refs, imports, markers, i18n keys, branding) and `npm run lint` passes
repo-wide.

## Scope
- In: create `scripts/verify-extension.mjs` checking:
  (a) every path referenced by `manifest.json` (icons, popup, service_worker,
      content_scripts js/css, web_accessible_resources globs) exists;
  (a2) `content_scripts[0].js` keeps granularity before content-script
      (load-bearing: granularity defines `handleLineByLineTranslate` used at
      `content-script.js` hover section);
  (b) every `chrome.runtime.getURL`/`import()` literal path in `src/` exists;
  (c) marker probes — `TRANSLATION_COMMAND_PATTERN`, `safeRuntimeCall`,
      `registerHoverTranslate`, `buildInlineSuggestion`, `showTranslationPopup`,
      `getTranslationUnits` present in content scripts;
  (d) provider probes — all 9 provider `case` strings in `ai-providers.js`;
  (e) every `data-i18n` key in `popup.html` resolves in `common/locales.js`;
  (f) manifest `name` contains "BNTrans";
  (g) product-name probe — `popup.html` `<title>`/`alt` and `popup.title`
      EN+VI locale values read "BNTrans";
  then run `npm run lint`
- Out: live Chrome load test (task-08), rewriting donor code style

## Coverage
- CP-01, CP-02..CP-10 (source-level proof), CP-11, CP-12

## Ownership
- Create: `scripts/verify-extension.mjs`
- Read: everything under `extension/`

## Acceptance
- AC-01..AC-11: verify script exits 0 covering probes (a)–(f); `npm run lint` exits 0.

## Dependencies
- task-02-messaging-plumbing.md
- task-03-services.md
- task-04-content-scripts.md
- task-05-popup-ui.md
- task-06-logo-icons.md

## Verification Plan
- Command: `node scripts/verify-extension.mjs && npm run lint`
- Named probe: verify-extension (probes a–f) + eslint-clean (whole `extension/`)
- Reachability: node + npm from task-01; all inputs are repo files
- Oracle: exit 0; script prints one PASS line per probe group
- Counterexample: missing icon file, dangling getURL path, dropped provider case,
  or orphaned `data-i18n` key each make a probe FAIL
- Artifacts: `scripts/verify-extension.mjs` persists (reusable port verifier)

## Receipt
<!-- Fill only after execution; see canonical form below. -->
