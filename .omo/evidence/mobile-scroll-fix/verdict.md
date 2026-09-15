# Mobile transcript scroll verdict

Overall: FAIL / REVISE. C1 and C2 regress with the unchanged yardstick. C3-C5 and the new settings sweep pass. No frontend source was edited by this evidence task.

Frozen command (exit 0; criterion failures are judged below, not by the runner exit):

`bun /Volumes/storage/workspace/cli-webchat-scroll-fix/.omo/evidence/mobile-scroll-fix/harness/run-scroll-qa.mjs --mode after`

Recorded: 2026-09-15T06:49:16.132Z. Source SHA256: `0221574950f1a5581970d6e871f844109aa3c616242dbab7a43e230f46c64e0d`.
Harness SHA256: `eed669df264cd1ae77346b5db2cf570945d2214985c2df08a6592f2c5a5ad556`.
Pre/post checks match for run-scroll-qa.mjs, main.tsx and index.html (`after/harness-before.sha256`, `after/harness-after.sha256`). The frozen harness was run once in this task.

## C1-C5

| Criterion | Baseline | After | Threshold | Verdict |
|---|---|---|---|---|
| C1 travel error | 1705px | 596px (signed -596) | Absolute error <= 200px | FAIL |
| C2 travel/maxJump, hops 8k;16k;24k | -580/300px; -2452/56px; -2111/390px | -3422/179px; -3470/219px; -3466/293px | Each travel <= -2400px; maxJump <= 200px | FAIL |
| C3 follow intent | Away bottom distance 6000 -> 0px; position absent. Bottom distance 0px | Away movement 0px; bottom distance 0px | Away movement <= 100px; bottom distance <= 40px | PASS |
| C4 image anchor shift | 0px | 0px | Absolute shift <= 8px | PASS |
| C5 estimator median/p90 percentage error | 23.809524% / 83.739837% | 3.796296% / 20% | Median <= 25%; p90 <= 35% | PASS |

C1 target 59019, landed 58423: 596px error, 396px over threshold. C2 hop 16000 exceeds the jump threshold by 19px; hop 24000 by 93px. Travel passes for all three hops. C3 away scrollTop stays 68945. C4 anchor 295 stays at -420px; image 293 is mounted and decoded (natural width 363). C5 covers all 300 rows; baseline percentages independently recomputed from measured heights (median 23.80952380952381%, p90 83.73983739837398%), not the stale 36.5% claim.

## Settings sweep: PASS

Separate script: `harness/metrics-sweep.mjs`; run with Bun, final execution exit 0. Uses the real ChatTranscript, real useAppConfig setting setters/effects, and the actual virtualizer retrieved from React hook state, without source instrumentation. Font changes are applied sequentially in each WebView; readiness uses effect events and layout frames, never fixed sleeps. Widths are separate real page viewports, not a resize-in-place claim.

| Viewport / scrollport px | Font px | Glyph advance px | Independent glyph px | Unmeasured estimate / fresh px | Browser height px | Result |
|---|---|---|---|---|---|---|
| 390 / 384 | 10 | 6.091734 | 6.091488 | 96 / 96 | 80 | PASS |
| 390 / 384 | 13 | 7.690524 | 7.690400 | 141 / 141 | 116 | PASS |
| 390 / 384 | 17 | 9.724798 | 9.724627 | 207 / 207 | 178 | PASS |
| 390 / 384 | 24 | 13.471018 | 13.470839 | 362 / 362 | 320 | PASS |
| 600 / 594 | 10 | 6.091734 | 6.091488 | 64 / 64 | 64 | PASS |
| 600 / 594 | 13 | 7.690524 | 7.690400 | 100 / 100 | 76 | PASS |
| 600 / 594 | 17 | 9.724798 | 9.724627 | 153 / 153 | 124 | PASS |
| 600 / 594 | 24 | 13.471018 | 13.470839 | 285 / 285 | 206 | PASS |

The same unmeasured row 40 remains absent from itemSizeCache at every setting, and its virtualizer size equals the fresh estimate. All fixture rows have identical assistant text and structure; browser heights come from an identical mounted row (its actual index is recorded in JSON), representing the same row content at every setting without mounting row 40 and contaminating its unmeasured cache. Heights are reported for comparison, not required to equal estimates. Glyph advance increases at every font step and agrees with an independent DOM Range measurement to within 0.05px (maximum error 0.000247px). Estimates increase at every font step and decrease at the wider viewport for all four fonts. This sweep does not add a font-family or resize-in-place assertion.

## Artifacts, verification and limits

Both 390x844 CSS viewport screenshots were refreshed and visually inspected (780x1688 device pixels). The initial screenshot shows questions 141-142; older-history shows 125-126 and the bottom button. The initial screenshot is the frozen harness's readiness-time capture, not proof of final bottom landing.

`after/*.json`, `after/rerun.log`, `after/metrics-sweep.log`, and `after/verification.json` contain refreshed data. `STATUS.md` and `verify-diffstat.log` have been corrected. Sweep startup development encountered module-resolution issues and an unsuitable measured reference row; the final script explicitly asserts its chosen row remains unmeasured. No frozen measurement was retried or altered.

Cleanup receipt: viteStopped=true, temporaryRemoved=true, coreRestored=true, cmpExitCode=0, portFree=true. Independent cmp exits 0; .qa-harness is absent; lsof -i :5211 prints nothing (exit 1). Sweep cache is removed as well.

C2 forces the iOS virtual-core branch in desktop WebKit, not physical iOS gestures. C6 tests/build were not rerun by this evidence task. Script syntax validation passed; LSP diagnostics could not initialize because the language-server workspace could not locate TypeScript. No git add, commit, push, or merge was performed; PR #160 is left unmerged.
