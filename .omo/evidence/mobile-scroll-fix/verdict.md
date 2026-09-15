# Mobile transcript scroll verdict

C1-C5: PASS on this run. Settings sweep: FAIL (all eight glyph-error checks). This is not an overall clean verification. The previous supplied C4 result was +2063px; this run measures 0px. A single passing observation does not establish stability or explain the difference. No source fix or retry was performed by this task.

## Frozen measurement

Run once, unchanged, exit 0:

`bun /Volumes/storage/workspace/cli-webchat-scroll-fix/.omo/evidence/mobile-scroll-fix/harness/run-scroll-qa.mjs --mode after`

Settings sweep also run once, unchanged, exit 1:

`bun /Volumes/storage/workspace/cli-webchat-scroll-fix/.omo/evidence/mobile-scroll-fix/harness/metrics-sweep.mjs`

Verification recorded 2026-09-15T07:56:20.401632+00:00. Raw output is in `after/rerun.log` and `after/metrics-sweep.log`.

Runner SHA256 before and after: `eed669df264cd1ae77346b5db2cf570945d2214985c2df08a6592f2c5a5ad556` (matches required frozen hash). `after/harness-before.sha256` and `after/harness-after.sha256` compare equal, cmp exit 0, for all three frozen files: run-scroll-qa.mjs, main.tsx and index.html. Runner exit 0 means execution completed, not automatic criterion acceptance.

## Per-criterion verdict

All distances are CSS px. C2 pairs are travel/maxJump at hops 8000, 16000 and 24000. Baseline comes from existing baseline JSON, not a new baseline run. Baseline C5 uses the recorded constant 80px estimate; percentages are recomputed from all 300 heights. Percentages below are rounded to six decimals; thresholds use unrounded values.

| Criterion | Baseline | After | Threshold | Verdict |
|---|---|---|---|---|
| C1 absolute landing error | 1705px | 133px (signed -133) | <= 200px | PASS |
| C2 travel/maxJump | -580/300; -2452/56; -2111/390px | -3112/56; -3069/48; -3074/72px | Every travel <= -2400px and maxJump <= 200px | PASS |
| C3 follow intent | Away bottom distance 6000 -> 0px; scrollTop absent; bottom distance 0px | Away movement 0px; bottom distance 0px | Away movement <= 100px; bottom distance <= 40px | PASS |
| C4 absolute image anchor shift | 0px | 0px | <= 8px | PASS |
| C5 median/p90 absolute percentage error | 23.809524% / 83.739837% | 1.111111% / 9.782609% | Median <= 25%; p90 <= 35% | PASS |

C1 target 52135, landed 52002. C3 away scrollTop remains 62135; the bottom button is present while away and absent at bottom. C4 anchor 295 stays at -420px while scrollTop changes from 68203 to 68430; image row 293 remains mounted, image complete=true, natural width 363, row height 720.65625px. C4 is judged by anchor shift, not scrollTop movement. The prior +2063px failure is retained here as history, not overwritten as a claim that it never happened. C2's first maxJump is 56px rather than the supplied reference's 57px.

C6 was reported green in the task context, but no C6 definition or threshold was supplied. It is not independently rejudged here; tests/build were not rerun for this evidence-only task. Cleanup is independently verified below.

## Per-role signed estimator errors

Signed error = estimate minus measured height; positive means overestimation. Signed percentage divides each row's signed error by its measured height. Each role has 150 rows. These statistics are computed from the refreshed estimator JSON; median uses the middle-pair average.

| Role | Baseline mean px / % | After mean px / % | Baseline median px / % | After median px / % |
|---|---|---|---|---|
| User | -10 / -11.111111% | +1 / +1.111111% | -10 / -11.111111% | +1 / +1.111111% |
| Assistant | -288.470625 / -72.229108% | +15.982708 / +3.963372% | -290 / -78.378378% | +6 / +1.621622% |

## Settings sweep: FAIL

Refreshed `after/metrics-sweep.json` records pass=false and no execution exception. Every row fails the glyphError <= 0.05px check. Exact absolute errors, repeated at both widths for font sizes 10/13/17/24 respectively, are 1.308749666228639, 1.7013748567408316, 2.224875110757088 and 3.4115631837937617px.

| Viewport / scrollport px | Font px | Estimator glyph px | Independent glyph px | Absolute glyph error px | Unmeasured / fresh estimate px | Browser height px | Verdict |
|---|---|---|---|---|---|---|---|
| 390 / 384 | 10 | 4.782738 | 6.091488 | 1.308750 | 80 / 80 | 80 | FAIL |
| 390 / 384 | 13 | 5.989025 | 7.690400 | 1.701375 | 100 / 100 | 116 | FAIL |
| 390 / 384 | 17 | 7.499752 | 9.724627 | 2.224875 | 180 / 180 | 178 | FAIL |
| 390 / 384 | 24 | 10.059276 | 13.470839 | 3.411563 | 285 / 285 | 320 | FAIL |
| 600 / 594 | 10 | 4.782738 | 6.091488 | 1.308750 | 64 / 64 | 64 | FAIL |
| 600 / 594 | 13 | 5.989025 | 7.690400 | 1.701375 | 79 / 79 | 76 | FAIL |
| 600 / 594 | 17 | 7.499752 | 9.724627 | 2.224875 | 125 / 125 | 124 | FAIL |
| 600 / 594 | 24 | 10.059276 | 13.470839 | 3.411563 | 209 / 209 | 206 | FAIL |

Applied font sizes match requested settings. Row 40 remains outside the measured cache and its virtualizer estimate equals the fresh estimate in every case. Glyph widths and estimates increase with font size at both viewport widths, and wider viewports decrease estimates at every font size. Those checks pass but do not waive the recorded sweep failure. The sweep's independent Range probe uses `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`; no cause of the discrepancy was independently diagnosed in this measurement-only task. Browser-height equality is not a sweep criterion. Widths use separate viewports, not resize-in-place; font-family changes are not tested.

## Artifacts and cleanup

All measurement `after/*.json` files were refreshed, with `after/verification.json` recording timestamps, sizes, hash checks and independent cleanup checks. Both screenshots were refreshed and visually inspected: `after/transcript-390x844.png` shows questions 149-150; `after/transcript-older-history-390x844.png` shows question 124 and the bottom button. They represent a 390x844 CSS viewport at 780x1688 raster pixels. The first screenshot is a readiness-time capture, not independent proof of final landing.

Both `after/cleanup.json` and sweep cleanup report viteStopped=true, temporaryRemoved=true, coreRestored=true, cmpExitCode=0 and portFree=true. The sweep also reports sweepCacheRemoved=true. Independent virtual-core comparison against `virtual-core-index.original.js` exits 0; frontend/.qa-harness and metrics-vite-cache are absent; lsof on port 5211 returns no output (exit 1).

C2 forces the iOS virtual-core branch in desktop WebKit; this is not physical iOS gesture testing. The required frozen harness temporarily stages frontend/.qa-harness and patches/restores installed virtual-core; this mandated behavior is treated as the exception to the evidence-only write scope. All explicit evidence writes were under .omo/evidence/mobile-scroll-fix. No frontend/src or harness file was edited. No git add, commit, push or merge was performed; PR #160 was not changed by this task.
