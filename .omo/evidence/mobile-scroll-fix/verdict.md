# Mobile transcript scroll verdict

Overall: PASS. All five measured criteria pass against the estimate-stability fix. C4 improved from the previous +2063px failure to 0px using the unchanged harness.

The harness was run unchanged once, successfully (exit 0):

```sh
bun /Volumes/storage/workspace/cli-webchat-scroll-fix/.omo/evidence/mobile-scroll-fix/harness/run-scroll-qa.mjs --mode after
```

Run recorded at 2026-09-15T06:00:51.061Z; Bun 1.4.2 WebView; viewport 390x844 CSS pixels. Source SHA256: `94f56486a0d31b16151611fed8a6c59cbb0aad946c9ae4be3009576b8c5540c5`.

Harness SHA256 (from `shasum -a 256 /Volumes/storage/workspace/cli-webchat-scroll-fix/.omo/evidence/mobile-scroll-fix/harness/run-scroll-qa.mjs`):

```text
eed669df264cd1ae77346b5db2cf570945d2214985c2df08a6592f2c5a5ad556
```

Pre/post SHA256 checks also confirm `harness/main.tsx` and `harness/index.html` were unchanged. The pre-run hashes are retained in `after/harness-before.sha256`; execution output is in `after/rerun.log`.

All distances below are CSS pixels. Baselines come from the corresponding `baseline/*.json`.

| Criterion | Baseline | New after | Threshold | Verdict |
|---|---|---|---|---|
| C1 travel error | 1705px | 60px | abs(landed - target) <= 200px | PASS |
| C2 iOS travel/maxJump, hops 8k; 16k; 24k | -580/300px; -2452/56px; -2111/390px | -3140/70px; -3077/67px; -3096/77px | Every hop: negative travel, magnitude >= 2400px; maxJump <= 200px | PASS |
| C3 follow intent | Away bottom distance 6000 -> 0px; position not recorded. Bottom append distance 0px | Away position movement 0px; bottom append distance 0px | Away movement <= 100px; bottom distance <= 40px | PASS |
| C4 image anchor shift | 0px | 0px (previous after: +2063px) | abs(shift) <= 8px | PASS |
| C5 estimator median/p90 absolute percentage error | 23.809524% / 83.739837% | 1.111111% / 10.385757% | Median <= 25%; p90 <= 35% | PASS |

## Measurement details and limitations

- C1: `scroll-travel.json`. Baseline target 17614, landed 19319. New target 52582, landed 52522; signed error -60px, travel -4060px.
- C2: `ios-path.json`, ordered by hops 8000, 16000, 24000. The unchanged experiment forces the iOS virtual-core branch in desktop WebKit; it does not verify physical iOS gestures.
- C3: `follow-intent.json`. New away scrollTop is 62512 before and after append; final bottom distance is 0. Baseline omitted scrollTop, so exact baseline position movement cannot be reconstructed; its recorded bottom-distance change is stated instead.
- C4: `image-shift.json`. The same anchor row 295 stayed at -420px before and after the pending-image swap. Image row 293 remained mounted; the image was complete, natural width 363, row height 720.65625px. scrollTop changed from 68581 to 68808 while the visible anchor stayed fixed. No measurement was changed or discounted.
- C5: `estimator-accuracy.json`. Independently recomputed from all 300 unique rows in each dataset as `abs(height - estimate) / height * 100`, with constant 80 for baseline and each row's estimate for after. Median averages the middle pair; p90 is nearest rank (270th sorted value). Exact baseline median/p90: 23.80952380952381% / 83.73983739837398%. Exact after: 1.1111111111111112% / 10.385756676557865%.

C6/tests/build were outside this five-criterion rerun and were not rerun. No frontend/src files were edited by this verification task. No git add, commit, push, or PR merge was performed.

## Screenshots and cleanup

Both screenshots were refreshed by the unchanged harness and visually inspected:

- `after/transcript-390x844.png`: latest questions 149-150.
- `after/transcript-older-history-390x844.png`: older history around question 124, with return-to-bottom button.

Both capture the verified 390x844 CSS viewport at 780x1688 device pixels. All after JSON files are refreshed, non-empty, and parse successfully. Artifact timestamps, sizes, dimensions, harness hash, and independent cleanup checks are recorded in refreshed `after/verification.json`.

`after/cleanup.json` reports:

```json
{"mode":"after","viteStopped":true,"temporaryRemoved":true,"coreRestored":true,"cmpExitCode":0,"portFree":true}
```

Independent cleanup verification: virtual-core matches `virtual-core-index.original.js` (`cmp` exit 0); `ls /Volumes/storage/workspace/cli-webchat-scroll-fix/frontend/.qa-harness` fails with exit 1 and No such file or directory; `lsof -i :5211` prints nothing (exit 1).
