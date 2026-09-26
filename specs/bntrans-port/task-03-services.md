# Task 03 — Provider/format/TTS services

Status: done

## Outcome
All AI providers, HTML↔markdown format utilities, and the TTS service are ported
verbatim under `extension/src/services/`.

## Scope
- In: verbatim copy of `extension/src/services/ai-providers.js`,
  `extension/src/services/format-utils.js`, `extension/src/services/tts.js`
- Out: new providers; prompt changes; removing the commented Microsoft provider

## Coverage
- CP-06, CP-07 (`tts.js` half), CP-09

## Ownership
- Create: `extension/src/services/ai-providers.js`, `extension/src/services/format-utils.js`,
  `extension/src/services/tts.js`

## Acceptance
- AC-06: `AIProviderService.getProvider` maps `gemini`, `openai`, `openrouter`, `deepl`,
  `google-translate`, `groq`, `ollama`, `custom`, `gemini-nano` (default → offscreen signal).
- AC-07 (partial): `tts.play` reads `activeTTSProviderId`/`ttsProviders` and sends
  `tts-play` to background.
- AC-09: `shouldConvertFormat`/`htmlToMarkdown`/`markdownToHtml` exported and cover
  code blocks, links, bold/italic/strike/underline, lists, `<br>`.

## Dependencies
- task-01-scaffold-manifest.md

## Verification Plan
- Command: `npx eslint extension/src/services/`
- Named probe: eslint-clean + exported-symbols probe (task-07 verify script re-checks exports)
- Reachability: `npm install` from task-01
- Oracle: exit 0
- Counterexample: dropping a provider case (e.g. `groq`) is caught by task-07 provider probe;
  here a syntax-truncated copy fails eslint
- Artifacts: ephemeral

## Receipt

Verification: PASS
Command: npx eslint extension/src/services/
Exit: 0
Base: cd67b91
Head: 53e11f6
```text
$ npx eslint extension/src/services/
EXIT=0
```
Note: prettier --fix applied; removed 3 unused `translate()` params on
base/`WindowAIProvider` stubs and dead `isFree` in `DeepLProvider` — no behavior
change (subclasses keep their own signatures; base only throws).
