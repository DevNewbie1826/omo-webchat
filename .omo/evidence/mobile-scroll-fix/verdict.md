# Mobile transcript scroll verdict

Overall: FAIL (C4 and C5). Completed with Bun 1.4.2 WebView at 390x844 CSS pixels, using the existing harness against the fixed production code. Distances below are CSS pixels. Baseline numbers are from the saved baseline/*.json, not the differing background summary.

| Criterion | Baseline | After | Threshold | Verdict |
|---|---|---|---|---|
| C1 travel | 1,705px short | 0px error; travelled -4,000px | Absolute landed-target <= 200px | PASS |
| C2 iOS path | Travel/maxJump by hop: 8k -580/300px; 16k -2,452/56px; 24k -2,111/390px | 8k -2,995/18px; 16k -2,909/32px; 24k -2,972/45px | Every hop travel <= -2,400px and maxJump <= 200px | PASS |
| C3 follow | Away bottom distance 6,000 -> 0px (position not recorded); bottom append distance 0px | Away position movement 0px; bottom append distance 0px | Away movement <= 100px; bottom distance <= 40px | PASS |
| C4 image shift | 0px | +2,063px | Absolute anchor shift <= 8px | FAIL |
| C5 estimator accuracy | Median 23.810%; p90 83.740% (constant 80, 300 rows) | Median 25.556%; p90 25.556% (real estimator, 300 rows) | Median absolute percentage error <= 25%; p90 <= 35% | FAIL |

## Exact failures

- C4: anchor row 295 moved from top -420px to 1,643px, a +2,063px shift (limit 8px), when image row 293 changed. scrollTop moved from 65,293px to 65,306px. The image remained mounted and complete, with natural width 363 and row height 720.65625px. See after/image-shift.json.
- C5: median absolute percentage error is 25.555555555555554%, exceeding 25% by 0.555555555555554 percentage points. p90 is 25.555555555555554%, which passes its 35% limit. See after/estimator-accuracy.json, including every row's measured height, estimate, errors, and live metrics.

## Evidence and measurement changes

- C1 uses after/scroll-travel.json: start 53,293, target 49,293, landed 49,293.
- C2 uses after/ios-path.json. As in baseline, this forces virtual-core's iOS branch in desktop WebKit; it is not physical iOS gesture testing.
- C3 uses after/follow-intent.json: scrollTop 59,293 before and after away append; bottom append distance 0.
- C4 reuses the existing image-swap experiment unchanged. It measures the visible anchor, not merely scrollTop, and swaps all pending fixture images.
- C5 imports the actual /src/features/split/chatRowEstimate.ts inside the browser page and invokes estimateRowHeight(makeRow(index, true), readRowMetrics(scrollElement)) for each measured row. Absolute percentage error = abs(measured - estimated) / measured * 100; median averages the middle pair and p90 uses nearest rank. Saved baseline percentage statistics were computed by the same formula from its 300 measured heights and constant 80.
- Corrected two incomplete harness measurements only: after mode previously still scored constant 80, and follow-intent omitted scrollTop. Added screenshot capture. No production files were edited.
- Screenshots: after/transcript-390x844.png (latest messages) and after/transcript-older-history-390x844.png (older history around question 122). Both were visually inspected. WebView captures 780x1688 device pixels for the verified 390x844 CSS viewport.
- The first invocation stopped before experiments because screenshot() returns a Blob, not an ArrayBuffer. Its cleanup succeeded; the screenshot writer was corrected to Bun.write and the next invocation completed all measurements. There were no result-driven reruns.

## Cleanup and verification

Completed harness receipt (also after/cleanup.json):

```json
{"mode":"after","viteStopped":true,"temporaryRemoved":true,"coreRestored":true,"cmpExitCode":0,"portFree":true}
```

All five measurement JSON files and both screenshots were checked for non-empty content. All 300 estimator indices are present exactly once. git status --short shows only the six pre-existing frontend/src changes from other nodes; their SHA-1 hashes match those recorded before this run. Evidence is ignored by git. frontend/.qa-harness does not exist and lsof -i :5211 prints nothing. No git add, commit, or push was run.

Harness language-server diagnostics were unavailable because the tool could not locate TypeScript; JavaScript syntax was checked separately with node --check. Browser execution completed successfully. See after/verification.json for the final artifact and syntax-check receipt.
