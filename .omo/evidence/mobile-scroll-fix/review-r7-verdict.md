st_01a0a432 [completed] model GPT-6 Astra (reasoning xhigh, variant max)
The sole remaining required change is fixed. No blocking findings in `3fe8a8e..a2093c2`.

`F/` = `frontend/src/features/split/`; `E/` = `.omo/evidence/mobile-scroll-fix/`.

## Delta assessment

- **Containing geometry: PASS.** `F/chatRowEstimate.ts:161-163` appends the probe to `.th-chat-history`, matching rendered rows (`F/ChatTranscript.tsx:629-645`). Executing `E/lane-geometry.mjs` confirmed exact lane **and bubble** matches across all eight combinations: **366px at viewport 390; 552px at 600**, for 10/13/17/24px fonts. This defeats the previous strongest counter-case: the persistent 12px discrepancy.
- **Glyph accuracy: PASS.** Independent Range measurements retained maximum errors of **0.000036815px prose** and **0.000055707px code** (`E/after/lane-geometry.json`). My stricter numerical recheck passed. Product sample and sizing logic are unchanged; there is no compensating offset.
- **Corrected sweep: PASS.** `E/harness/metrics-sweep.mjs` exited 0. I programmatically confirmed its reference sample matches the unchanged product sample. All eight unmeasured estimates equal fresh estimates.
- **Scope: PASS.** The product delta contains only the probe-host correction and one regression test; remaining changes are related evidence/tooling. No tests were deleted, skipped, or disabled.

## Independently executed gates

| Criterion | Result |
|---|---|
| C1 | PASS: 133px landing error (`E/after/scroll-travel.json:5`). |
| C2 | PASS: travel/max residual **-3112/56, -3069/48, -3074/62px**, independently recomputed from `E/after/ios-path.json`. |
| C3 | PASS: parked movement **0px**, bottom distance **0px** (`E/after/follow-intent.json`). |
| C4 | PASS: anchor shift **0px**; image mounted and decoded (`E/after/image-shift.json`). |
| C5 | PASS: independently recomputed median **1.111111%**, p90 **9.782609%**, across 300 rows (`E/after/estimator-accuracy.json:4-9`). |
| C6 | PASS: `npx vitest run --maxWorkers=4` passed **253 files / 2,702 tests**; `npm run build` exited **0**. Both changed TypeScript files have clean diagnostics. |

The frozen runner executed once, exit 0. All three frozen files matched pre/post hashes; runner SHA256 remained `eed669df264cd1ae77346b5db2cf570945d2214985c2df08a6592f2c5a5ad556`.

**Never-mounted freeze also passed my separate browser counter-check:** six ordinal-key rows, observed since initial mount, remained never-mounted/unmeasured after gaining images; total height stayed **111132px**. Real `resizeItem(41, 1111)` superseded the frozen **370px** estimate. Typography changes refreshed other estimates to **568px**, matching fresh calculation, while preserving the **1111px** measurement (`bun --input-type=module -`, output `INDEPENDENT_FREEZE_AND_PARENT_COUNTERCHECK`).

## NOTES

- C2 remains desktop WebKit exercising the forced-iOS library path, not physical iOS.
- Build retains the existing chunk-size warning. Evidence-script LSP initialization was unavailable; `node --check` passed.
- The custom probe required Vite import-path/CJS corrections before its assertions executed successfully.
- Required runners refreshed generated evidence. No source/harness edits, commits, or merges were performed. Core restoration, temporary/cache cleanup, and port release passed.

VERDICT: APPROVED