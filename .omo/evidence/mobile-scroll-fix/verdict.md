# Mobile transcript scroll verdict

C1-C5 PASS. Corrected settings sweep PASS. Mounted-row lane and bubble geometry PASS in all eight combinations, with exactly 0px difference.

## Frozen measurement

Executed once each, exit 0:

- `bun /Volumes/storage/workspace/cli-webchat-scroll-fix/.omo/evidence/mobile-scroll-fix/harness/run-scroll-qa.mjs --mode after`
- `bun /Volumes/storage/workspace/cli-webchat-scroll-fix/.omo/evidence/mobile-scroll-fix/harness/metrics-sweep.mjs`
- `bun /Volumes/storage/workspace/cli-webchat-scroll-fix/.omo/evidence/mobile-scroll-fix/lane-geometry.mjs`

Runner pre/post SHA256: `eed669df264cd1ae77346b5db2cf570945d2214985c2df08a6592f2c5a5ad556`. All three frozen files (runner, main.tsx, index.html) match pre/post; cmp exit 0. Records: `after/harness-before.sha256`, `after/harness-after.sha256`. Logs: `after/rerun.log`, `after/metrics-sweep.log`, `after/lane-geometry.log`. Verification recorded 2026-09-15T08:27:43.728954+00:00.

## Per-criterion verdict

All distances are CSS px. C2 pairs are travel/maxJump at hops 8000, 16000, 24000. Baseline is existing JSON, not a new run. C5 uses all 300 rows, middle-pair median and nearest-rank p90; thresholds use unrounded numbers.

| Criterion | Baseline | After | Threshold | Verdict |
|---|---|---|---|---|
| C1 absolute landing error | 1705px | 133px (signed -133) | <= 200px | PASS |
| C2 travel/maxJump | -580/300; -2452/56; -2111/390px | -3112/68; -3069/48; -3074/63px | Every travel <= -2400px; maxJump <= 200px | PASS |
| C3 follow intent | Away bottom distance 6000 -> 0px; scrollTop absent; bottom distance 0px | Away movement 0px; bottom distance 0px | Away movement <= 100px; bottom distance <= 40px | PASS |
| C4 absolute image anchor shift | 0px | 0px | <= 8px | PASS |
| C5 median/p90 absolute percentage error | 23.809524% / 83.739837% | 1.111111% / 9.782609% | Median <= 25%; p90 <= 35% | PASS |

C1 target 52135, landed 52002. C2 residual maxima independently recompute to 68/48/63px. C3 parked scrollTop remains 62135; bottom button is present away and absent at bottom. C4 anchor 295 stays at -420px, image row 293 is mounted and decoded (natural width 363), and scrollTop changes 68203 -> 68430. Anchor shift, not scrollTop movement, is the criterion. The previous verdict's historical +2063px C4 observation is not erased by this passing run.

C6 was not rerun for this evidence-only task. `review-r6-verdict.md` reports 253 files / 2701 tests and build exit 0 with the existing chunk-size warning; this is prior reviewer evidence, not this task's verification of current source.

## Per-role signed estimator errors

Signed error = estimate minus measured height; signed percentage divides each row's error by its height. Positive means overestimation. Each role has 150 rows.

| Role | Baseline mean px / % | After mean px / % | Baseline median px / % | After median px / % |
|---|---|---|---|---|
| user | -10.000000 / -11.111111% | +1.000000 / +1.111111% | -10.000000 / -11.111111% | +1.000000 / +1.111111% |
| assistant | -288.470625 / -72.229108% | +15.982708 / +3.963372% | -290.000000 / -78.378378% | +6.000000 / +1.621622% |

## Corrected settings sweep: PASS

The existing corrected sweep independently measures the product's prose sample with Range. Applied settings match; row 40 remains unmeasured; virtualizer and fresh estimates agree in all eight cases. Glyph widths and estimates increase with font size; wider viewports reduce estimates. Browser height is informational, not an equality criterion.

| Viewport px | Font px | Glyph error px | Unmeasured / fresh estimate px | Browser height px | Verdict |
|---|---|---|---|---|---|
| 390 | 10 | 0.000031486 | 80 / 80 | 80 | PASS |
| 390 | 13 | 0.000020345 | 120 / 120 | 116 | PASS |
| 390 | 17 | 0.000009688 | 180 / 180 | 178 | PASS |
| 390 | 24 | 0.000036815 | 285 / 285 | 320 | PASS |
| 600 | 10 | 0.000031486 | 64 / 64 | 64 | PASS |
| 600 | 13 | 0.000020345 | 79 / 79 | 76 | PASS |
| 600 | 17 | 0.000009688 | 125 / 125 | 124 | PASS |
| 600 | 24 | 0.000036815 | 209 / 209 | 206 | PASS |

## Mounted-row lane geometry: PASS

`after/lane-geometry.json` captures the actual estimator-created assistant probe synchronously after insertion and before removal, then compares against an already mounted real ChatTranscript assistant row, not a duplicate synthetic probe. A fresh module instance ensures each probe executes. The native append method is restored in finally. Both containing blocks are `.th-chat-history`; raw metrics and mounted row indices are retained per combination. Reported metrics.laneWidth also equals mounted width. Tolerance is 1/64 CSS px; observed differences are exactly zero.

| Viewport px | Font px | Probe / mounted lane px | Probe / mounted bubble px | Delta lane / bubble px | Verdict |
|---|---|---|---|---|---|
| 390 | 10 | 366 / 366 | 366 / 366 | 0 / 0 | PASS |
| 390 | 13 | 366 / 366 | 366 / 366 | 0 / 0 | PASS |
| 390 | 17 | 366 / 366 | 366 / 366 | 0 / 0 | PASS |
| 390 | 24 | 366 / 366 | 366 / 366 | 0 / 0 | PASS |
| 600 | 10 | 552 / 552 | 552 / 552 | 0 / 0 | PASS |
| 600 | 13 | 552 / 552 | 552 / 552 | 0 / 0 | PASS |
| 600 | 17 | 552 / 552 | 552 / 552 | 0 / 0 | PASS |
| 600 | 24 | 552 / 552 | 552 / 552 | 0 / 0 | PASS |

The reviewer's previous mismatches were 378/366px and 564/552px. Independent prose Range error now remains at most 0.000036814856px and code Range error at most 0.000055706690px, both below 0.05px.

## Artifacts and cleanup

All measurement JSON and both 390x844 CSS-viewport screenshots were refreshed. Both screenshots were opened and visually inspected: `after/transcript-390x844.png` shows questions 149-150; `after/transcript-older-history-390x844.png` shows question 124 and the bottom button. Raster dimensions are 780x1688. `after/verification.json` records timestamps, sizes, hash checks, independently recomputed residuals and final cleanup.

Runner, sweep and geometry cleanup receipts report viteStopped=true, temporaryRemoved=true, coreRestored=true, cmpExitCode=0, portFree=true. Final independent cmp exits 0; frontend/.qa-harness, metrics-vite-cache and lane-vite-cache are absent; lsof port 5211 has no output (exit 1).

The new evidence script passed `node --check` and executed successfully through the real browser surface. LSP diagnostics were attempted but unavailable: initialization could not find a valid TypeScript installation. No product tests/build were rerun for this evidence-only task.

C2 forces the iOS library path in desktop WebKit, not physical iOS hardware. Widths use separate viewports; font-family and resize-in-place changes are not tested here. The mandated frozen runner's temporary staging and virtual-core patch/restore are treated as the explicit exception to evidence-only writes. No frontend/src or existing harness file was edited by this task. No git add, commit, push or merge was performed; PR #160 was not modified by this task.
