# Task 06 — BNTrans logo + icon set

Status: pending

## Outcome
`extension/assets/icons/` contains a BNTrans logo generated via the `gpt-image2`
skill and exported at every size the manifest and code reference.

## Scope
- In: invoke `gpt-image2` to generate one square app logo for BNTrans
  (translation/language motif, flat modern style, legible at 16px);
  export `icon-{16,19,32,38,48,96,128}.png` into `extension/assets/icons/`;
  R6 fallback — if `codex`/`gpt-image2` is unreachable or fails, copy the donor
  icon set verbatim and record the source used in the receipt;
  `loading.gif` is not referenced by any manifest/src path — skip it
- Out: UI copy/icons inside pages (emojis and CSS stay as donor shipped);
  landing/store promo imagery

## Coverage
- CP-11 (asset half)

## Ownership
- Create: `extension/assets/icons/icon-{16,19,32,38,48,96,128}.png`

## Acceptance
- AC-12: every icon path in `manifest.json` and every `assets/icons/icon-*.png`
  `getURL` reference in `src/` resolves to an existing valid PNG of the stated size;
  receipt records whether icons came from gpt-image2 or the donor fallback.

## Dependencies
- task-01-scaffold-manifest.md

## Verification Plan
- Command: `for s in 16 19 32 38 48 96 128; do sips -g pixelWidth -g pixelHeight "extension/assets/icons/icon-$s.png" | awk -v s=$s '/pixelWidth|pixelHeight/{if($2!=s)exit 1}' || exit 1; done; echo ICONS_OK`
- Named probe: icon-dimensions (sips reports exact WxH for all 7 sizes)
- Reachability: `sips` ships with macOS; `codex` CLI confirmed at `/opt/homebrew/bin/codex`
  (auth/quota unverified until run) — R6: on failure, fall back to copying donor
  `extension/assets/icons/icon-*.png` and note it in the receipt
- Oracle: prints ICONS_OK, exit 0
- Counterexample: a missing size or wrong-dimension export fails the loop
- Artifacts: PNG files persist as task output; no temp artifacts

## Receipt
<!-- Fill only after execution; see canonical form below. -->
