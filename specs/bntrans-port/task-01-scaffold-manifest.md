# Task 01 — Scaffold + BNTrans manifest

Status: pending

## Outcome
The repo has npm tooling and an MV3 manifest that installs as "BNTrans" once the
remaining source files land in later tasks.

## Scope
- In: `package.json` (name `bntrans`, version `1.0.0`, `private: true`, no
  `repository`/`homepage` fields — this repo has no git remote; lint script
  `eslint extension --fix && prettier extension --write`),
  `eslint.config.mjs` + `.prettierrc` ported from donor, `.gitignore` gains `node_modules/`,
  `extension/manifest.json` with `name` "BNTrans - Power Inline Translate Kit",
  `version` `1.0.0`, `author` "BNTrans", `description` unchanged in substance,
  `homepage_url` removed,
  `extension/assets/styles/` (all 7 donor CSS files, copied verbatim)
- Out: icons (task-06), pages, all `src/` JS

## Coverage
- CP-01, CP-11 (manifest half)

## Ownership
- Modify: `.gitignore`
- Create: `package.json`, `eslint.config.mjs`, `.prettierrc`, `extension/manifest.json`,
  `extension/assets/styles/{tokens,common,dialogs,popup,inline-suggestion,selection,hover-translate}.css`

## Acceptance
- AC-01 (partial): manifest parses, `manifest_version === 3`, name contains "BNTrans",
  permissions `storage` + `offscreen`, host_permissions `<all_urls>` + localhost,
  content_scripts list granularity then content-script JS plus the 3 content CSS files.
- AC-11 groundwork: `npm install` then `npx eslint extension/manifest.json` is not a thing —
  lint acceptance lands in task-07; here `npm install` must succeed.

## Dependencies
- none

## Verification Plan
- Command: `node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8'));if(m.manifest_version!==3||!/BNTrans/i.test(m.name)||!m.permissions.includes('offscreen'))process.exit(1);for(const f of m.content_scripts[0].css.concat(m.content_scripts[0].js).concat([m.background.service_worker,m.action.default_popup]))console.log(f)"`
- Named probe: manifest-parse (MV3 + BNTrans name + offscreen permission + path listing)
- Reachability: node ≥ any modern version; runs from repo root
- Oracle: exit 0 and every referenced path printed
- Counterexample: a manifest still named "TransKit" or missing `offscreen` permission fails
- Artifacts: ephemeral console output only

## Receipt
<!-- Fill only after execution; see canonical form below. -->
