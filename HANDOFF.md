# BNTrans Extension — Session Handoff

Snapshot of work state as of this session. The extension is a source-only
MV3 Chrome extension (no build step); source root is `extension/`.

## Repo layout

- `extension/manifest.json` — MV3 manifest (side_panel, contextMenus, etc.)
- `extension/src/background.js` — service worker: settings defaults,
  translate handler, provider fallback, context menus, history recording
- `extension/src/content-script.js` — selection/instant/hover/screenshot
  popups, page translation, dual subtitles, language banner
- `extension/src/content-script-granularity.js` — shared DOM helpers loaded
  BEFORE content-script.js (`getTranslationUnits`, `toMarkdown`,
  `injectUnitWrappers`, `requestSegmentTranslations`, `updateWrappers`,
  `markTranslationError`); referenced via `/* global */` comments
- `extension/src/services/ai-providers.js` — provider registry
  (`google-translate`, `chrome-ai`, `openai-compat`, `gemini`, `groq`,
  `openrouter`, `claude`)
- `extension/pages/{popup,options,sidepanel}.html` +
  `extension/src/{popup,options,sidepanel}.js` — UI surfaces
- `extension/src/common/locales.js` — EN/VI strings
- `scripts/verify-extension.mjs` — static probes (manifest, paths,
  script order, refs, feature markers, providers, i18n, product name)

## Verification commands

- `npm run lint` — ESLint + Prettier
- `node scripts/verify-extension.mjs` — must end with `All probes passed.`
- Package: `cd extension && zip -r ../bntrans-extension.zip .`
  (zip is untracked artifact; `.DS_Store` also untracked — never commit)

## Merged on `main` (this session + earlier)

| Commit | Feature |
|---|---|
| `37ec96a` | Claude (Anthropic) provider + live model picker |
| `d69526e` | Quick popup fills target from translation direction |
| `377eb0a` | #1 Context-menu translate selection |
| `8a66090` | #2 Glossary/style in image OCR prompts |
| `a16e6e4` | #3 Google Translate fallback on provider failure |
| `5998224` | #4 Export/import settings JSON |
| `3e9d6bf` | #5 Translation history (cap 50, `skipHistory` opt-out) |
| `c067223` | #6 Side panel (reuses quick-translate UI, selection prefill) |
| `9e1869b` | #7 Bilingual whole-page translation (batches ~25u/3000c, restore) |

## OPEN PRs — all authored, lint+verify PASS, all reported MERGEABLE

| # | Branch | Feature | Commit |
|---|---|---|---|
| 8 | `feat/viewport-page-translate` | Page translate prioritizes viewport via IntersectionObserver | `f58bebf` |
| 9 | `feat/translation-cache` | Persistent LRU cache (300 entries, `translationCache` key) | `bf388fe` |
| 10 | `feat/history-copy` | History click-to-copy + localized "Copied" | `3308a3f` |
| 11 | `feat/editable-replace` | Context menu translate-and-replace in editable fields | `b90cfa9` |
| 12 | `feat/menu-title-toggle` | Page menu title Translate↔Restore per tab state | `f264cc6` |
| 13 | `feat/auto-translate-domains` | Auto page-translate on configured domains | `c3c5df1` |
| 14 | `feat/lang-detect-banner` | Language-detect banner offers page translate | `aff2f56` |
| 15 | `feat/dual-subtitles` | YouTube dual subtitles (`.ytp-caption-segment` observer) | `9e019d2` |

## Merge order notes (predicted conflict regions)

Merge sequentially, resolve as they come (same pattern as first batch —
keep ALL feature blocks, delete conflict markers):

- `content-script.js` tail (message listener / module tail): PR11, PR12,
  PR14 all append there — expect chained conflicts after first merge.
- `options.js`/`options.html`/`locales.js`: PR10, PR13, PR15 all add
  elements/keys — keep all additions.
- `background.js`: PR9 (translate handler/cache), PR11 (new menu),
  PR12 (menu-title handler), PR13 (`autoTranslateDomains` default) —
  distinct regions, some may chain.
- After each conflict resolution: `npm run lint` + verify, commit merge,
  push branch, then `gh pr merge --squash`.
- Merge via `gh pr merge <N> --squash`; confirm each with
  `gh pr view <N> --json state`.

## Key semantics (don't break during merges)

- Direction: `useAutoDetect=false` → translate targetLanguageCode →
  nativeLanguageCode (foreign→native). Quick popup + editable replace
  mirror this.
- `skipHistory: true` on high-frequency paths (instant, hover, page
  batches, subtitle cues).
- Domain matching everywhere = `url.includes(domain)` substring.
- Context menus register via remove-then-create (MV3 SW restart safety).
- History lives in `settings.translationHistory` (max 50, newest first);
  cache lives in separate `translationCache` key.
- Image-capable providers whitelist: `IMAGE_CAPABLE` in background.js.
- Claude: Messages API, `x-api-key` + `anthropic-version` +
  `anthropic-dangerous-direct-browser-access`; default model
  `claude-haiku-5-5`, family 5.5 (opus/sonnet/haiku).

## Gotchas learned this session

- `gh` push: osxkeychain sometimes fails with
  `unable to get password` — workaround is
  `git -c credential.helper='!gh auth git-credential' push`; permanent
  fix is `gh auth setup-git`.
- Heredoc inside `$()` command substitution breaks this shell — write PR
  bodies to `/tmp/*.md` and use `gh pr create --body-file`, or pipe
  `gh pr create --body-file -` at top level.
- Only trust `gh` output for PR state — never infer merged from todos.

## Remaining after all PRs merge

- Rebuild `bntrans-extension.zip` from final `extension/` source
  (current zip predates all open PRs).
- Manual smoke pass: popup target prefill, context-menu selection, OCR
  glossary/style, provider fallback, export/import, history + copy,
  side panel prefill, page translate + restore, editable replace,
  auto-translate domain, lang banner, YouTube dual subs.

## Branch cleanup

Batch-1 branches are merged and safe to delete (local + origin):
`feat/context-menu-translate`, `feat/image-prompt-glossary`,
`feat/provider-fallback`, `feat/settings-backup`,
`feat/translation-history`, `feat/side-panel`, `feat/page-translate`.
Batch-2 branches delete after their PRs merge. No stash entries.
This `HANDOFF.md` itself is untracked — keep local or commit as needed.

## Cross-pane work (Orca)

A sibling Devin session on the same machine works on `bntrans-mac`
(macOS native port) — Orca pane `term_bcf77b22`. It was asked to port
the Claude provider to Swift (`AIProviders.swift` POST `/v1/messages`,
`x-api-key` + `anthropic-version`, NO
`anthropic-dangerous-direct-browser-access` since native skips CORS;
ModelsFetcher `GET /v1/models`; default `claude-haiku-5-5`), with
`git show 37ec96a` as reference. Message was accepted and the pane was
running when last observed; check `/Users/nghialuutrung/Desktop/bntrans-mac`
for results.
