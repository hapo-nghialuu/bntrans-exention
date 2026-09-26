# Task 04 — Content scripts (all 4 modes)

Status: pending

## Outcome
The main content script and granularity helper are ported verbatim, giving BNTrans
manual `!!` translation, instant domain mode, select-to-translate, and
hover-to-translate with context-invalidation resilience.

## Scope
- In: verbatim copy of `extension/src/content-script.js` (3001 lines) and
  `extension/src/content-script-granularity.js` (428 lines)
- Out: `content-script-helpers.js`/`content-script-hover.js` (dead donor files);
  any behavior change or rebrand of `bt-`/`data-transkit-*` markers

## Coverage
- CP-02, CP-03, CP-04, CP-05, CP-10

## Ownership
- Create: `extension/src/content-script.js`, `extension/src/content-script-granularity.js`

## Acceptance
- AC-02: `TRANSLATION_COMMAND_PATTERN` and `handleAutoTranslation` present.
- AC-03: instant timer, `buildInlineSuggestion`, Tab/Esc handling, `Ctrl+Shift+I` toggle,
  instant label indicator present.
- AC-04: selection icon + draggable popup with source/target selectors and copy/TTS buttons.
- AC-05: `registerHoverTranslate`, modifier tracking, inject/replace modes,
  `getTranslationUnits` granularity.
- AC-10: `isExtensionContextValid`, `safeRuntimeCall`, `cleanupExtensionElements`,
  global error/unhandledrejection handlers present.

## Dependencies
- task-01-scaffold-manifest.md

## Verification Plan
- Command: `npx eslint extension/src/content-script.js extension/src/content-script-granularity.js`
- Named probe: eslint-clean; deeper marker probes (`!!` pattern, safeRuntimeCall,
  hover/inject functions) run in task-07 verify script
- Reachability: `npm install` from task-01
- Oracle: exit 0
- Counterexample: partial copy missing the bootstrap IIFE or trailing hover section fails
  both eslint and the task-07 marker probes
- Artifacts: ephemeral

## Receipt
<!-- Fill only after execution; see canonical form below. -->
