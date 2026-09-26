# Task 05 — Settings popup UI

Status: pending

## Outcome
The 5-tab settings popup (General / Instant / AI Provider / TTS / Help) and its logic
are ported so users can configure every ported feature with EN/VI i18n, and the
popup's visible product name reads "BNTrans".

## Scope
- In: copy of `extension/pages/popup.html` and `extension/src/popup.js`;
  R1 rename — `popup.html` `<title>` and logo `alt`, plus `popup.title` values for
  EN+VI in `extension/src/common/locales.js`, read "BNTrans"
- Out: CSS prefix or internal identifier renames, layout/style changes,
  other locale strings

## Coverage
- CP-08, CP-11 (product-name half)

## Ownership
- Create: `extension/pages/popup.html`, `extension/src/popup.js`
- Modify: `extension/src/common/locales.js` (popup.title strings only; file created by task-02)

## Acceptance
- AC-08: all 5 tabs exist in markup (`data-tab` general/instant/ai-provider/tts/help),
  settings read/write goes through `get-settings`/`set-settings` messages,
  provider management UI, domain list management, TTS provider config, and
  `data-i18n` attributes map to `locales.js` keys.
- AC-14: popup `<title>`, logo `alt`, and both `popup.title` locale values read "BNTrans".

## Dependencies
- task-01-scaffold-manifest.md
- task-02-messaging-plumbing.md (creates `locales.js` this task renames)

## Verification Plan
- Command: `npx eslint extension/src/popup.js`
- Named probe: eslint-clean; `data-i18n`↔locales key coverage and tab markup probes run in task-07
- Reachability: `npm install` from task-01
- Oracle: exit 0
- Counterexample: a popup.js missing a tab handler still lints but fails the task-07
  markup/i18n probe
- Artifacts: ephemeral

## Receipt
<!-- Fill only after execution; see canonical form below. -->
