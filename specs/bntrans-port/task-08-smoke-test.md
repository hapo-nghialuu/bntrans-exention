# Task 08 — Live smoke test

Status: done

## Outcome
`scripts/smoke-extension.mjs` loads the unpacked extension into real Chrome via
puppeteer (deps from the repo-installed `chrome-devtools` skill) and proves the
service worker registers and content stylesheets inject on a page.

## Scope
- In: create `scripts/smoke-extension.mjs` — installs skill deps if needed,
  launches `/Applications/Google Chrome.app` with `--load-extension=<repo>/extension`,
  waits for the `service_worker` target whose URL starts `chrome-extension://`,
  opens a test page (`data:` URL with an input), asserts at least one
  `document.styleSheets` entry is a `chrome-extension://` href, prints PASS lines,
  closes the browser
- Out: end-to-end translation calls (need live provider API — manual at C3);
  interacting with page DOM beyond stylesheet detection

## Coverage
- CP-01 (live level)

## Ownership
- Create: `scripts/smoke-extension.mjs`
- Read: `extension/manifest.json`

## Acceptance
- AC-13: script exits 0 having observed (1) the extension service-worker target and
  (2) an injected `chrome-extension://` stylesheet on the test page.

## Dependencies
- task-07-verification.md (all extension files must exist and lint clean first)

## Verification Plan
- Command: `npm --prefix .agents/skills/chrome-devtools/scripts install --silent && node scripts/smoke-extension.mjs`
- Named probe: live-load (SW target + injected stylesheet detection)
- Reachability: Chrome confirmed at `/Applications/Google Chrome.app`; puppeteer dep
  ships in `chrome-devtools` skill (`scripts/package.json`); script requires it via
  `createRequire` on that package
- Oracle: prints `PASS service-worker` and `PASS content-css`, exit 0
- Counterexample: a missing/corrupt manifest or bad script path leaves no
  service-worker target → FAIL; disabled content scripts → no injected stylesheet → FAIL
- Artifacts: temporary `--user-data-dir` under `/tmp`, cleaned by the script

## Receipt

Verification: PASS
Command: node scripts/smoke-extension.mjs
Exit: 0
Base: a5bed57
Head: 3f33cd5
```text
$ node scripts/smoke-extension.mjs
Chrome: /Users/nghialuutrung/.cache/puppeteer/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
PASS service-worker — chrome-extension://fpahklahenfdfpkhpdlcbpckioddopnd/src/background.js
PASS content-css — chrome-extension://fpahklahenfdfpkhpdlcbpckioddopnd/assets/styles/dialogs.css

Smoke test passed.
```
Note: branded Google Chrome 152 refuses `--load-extension` outright
(`extension_service.cc: "--load-extension is not allowed in Google Chrome,
ignoring"`), so the launcher resolves Chrome for Testing from the puppeteer
cache (`BNTRANS_CHROME` env var overrides).
