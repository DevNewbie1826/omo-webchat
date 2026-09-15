st_01a0a416 [completed] model GPT-6 Astra (reasoning xhigh, variant max)
Revisions remain necessary: the glyph measurement is fixed, but the previously required lane geometry correction is incomplete.

`F/` = `frontend/src/features/split/`; `E/` = `.omo/evidence/mobile-scroll-fix/`.

## Executed verification

| Criterion | Result |
|---|---|
| C1 | PASS: 133px landing error (`E/after/scroll-travel.json:2-6`). |
| C2 | PASS: travel -3112/-3069/-3074px; independently recomputed maximum residuals 56/52/63px (`E/after/ios-path.json:8,4492,4502,8830,8840,13180`). |
| C3 | PASS: parked movement 0px; bottom distance 0px (`E/after/follow-intent.json:2-18`). |
| C4 | PASS: anchor shift 0px, with image mounted and decoded (`E/after/image-shift.json:2-13`). |
| C5 | PASS: independently recomputed median 1.111111%, p90 9.782609% across 300 rows (`E/after/estimator-accuracy.json:4-9`). |
| C6 | PASS: `npx vitest run --maxWorkers=4` passed 253 files / 2,701 tests; `npm run build` exited 0. All eight changed source/test files have clean diagnostics. No tests were deleted or disabled in the reviewed diff. |

I executed the frozen runner once. Pre/post hashes matched, including required SHA256 `eed669df264cd1ae77346b5db2cf570945d2214985c2df08a6592f2c5a5ad556`. Core restoration and temporary-directory cleanup passed.

## Required-change assessment

- **Replay: fixed.** Passing integration tests exercise real `resizeItem`, not fabricated callback adjustments: equal, increasing, mixed-sign, scroll-separated and successive gestures, plus bottom-button cancellation (`F/ChatTranscript.scrollAdjust.test.tsx:126-249`; implementation `F/ChatTranscript.tsx:532-570`, `F/useChatScroll.ts:35-43`).

- **Metrics invalidation: fixed.** Independent browser execution used real `useAppConfig` effects. A font-family boundary case changed an unmeasured code estimate from 434px to 467px, matching fresh estimates; resize-in-place changed another from 160px to 192px. Settings required no unrelated input (`F/ChatTranscript.tsx:296-321,514-522`; `F/chatRowEstimate.ts:93-122`).

- **Never-mounted freeze: fixed.** Six confirmed unmounted/unmeasured rows gained images while total height remained exactly 209183px. A subsequent real `resizeItem` measurement of 1111px superseded its frozen 708px estimate. Changing typography refreshed other estimates to 488px while preserving that measurement (`F/ChatTranscript.tsx:309,489-522`).

- **Focus behavior: fixed.** Browser execution preserved 28108px on focus loss; focus gain and unfocused restore both produced zero bottom distance. Component tests also pass (`F/ChatTranscript.focusRestore.test.tsx:103-141`; implementation `F/ChatTranscript.tsx:606-615`).

- **Glyph calibration: fixed; lane geometry: incomplete.** Independent Range measurements using the same prose agreed within 0.000037px across 10/13/17/24px fonts at both viewport widths. Code advance agreed within 0.000056px. However, the strongest counter-check—comparing the probe against actual rendered row geometry—failed in all eight combinations: **378px estimated versus 366px rendered at viewport 390; 564px versus 552px at viewport 600** (`F/chatRowEstimate.ts:128-159`; actual containing block `F/ChatTranscript.tsx:629-645`).

The signed-error table is accurate: user mean/median +1px / +1.111111%; assistant mean +15.982708px / +3.963372%, median +6px / +1.621622%. These independently recompute from the refreshed JSON and match `E/verdict.md:41-42`.

## NOTES

- The supplemental sweep’s alphabet reference (`E/harness/metrics-sweep.mjs:52-62`) is mismatched with the product’s prose sample (`F/chatRowEstimate.ts:31-34`). Its glyph failure is tooling-only, independently confirmed—not the reason for REVISE. Correcting that supplemental reference is non-blocking.
- C2 exercises forced-iOS virtual-core behavior in desktop WebKit, not physical iOS.
- Build retains the existing chunk-size warning.
- No source or harness files were edited; the mandated runner refreshed generated evidence. No commit or merge was performed.

## Required changes

1. **`F/chatRowEstimate.ts:128-159`: measure the actual row containing geometry.** The absolutely positioned probe is appended to the scroll element, whereas rendered rows resolve their percentage width inside `.th-chat-history`. Consequently, the probe misses the gutter-reduced containing width and overstates the lane by 12px. Use the real row containing geometry rather than compensating through sample calibration. **Proof of completion:** browser checks at 390/600px and 10–24px show probe lane dimensions matching mounted rows within subpixel rounding, retain accurate prose/code advances, and keep the unchanged C1–C5 harness passing.

VERDICT: REVISE