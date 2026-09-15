st_01a0a3ae [completed] model GPT-6 Astra (reasoning xhigh, variant max)
Revisions are required despite the current measured criteria passing. The task's C4 failure is stale: the latest evidence records 0px.

Paths below: `E/` = `.omo/evidence/mobile-scroll-fix/`; `F/` = `frontend/src/features/split/`.

## Contract evidence

| Criterion | Review result |
|---|---|
| C1 | PASS: `abs(52522 - 52582) = 60px` (`E/after/scroll-travel.json:2-6`). |
| C2 | PASS for the recorded forced-iOS experiment: travel is -3140/-3077/-3096px; recomputed maximum residuals are 70/67/77px. Even individual shared-row residuals peak at only 82/67/77px (`E/after/ios-path.json:4-8,4496,4502-4506,8834,8840-8844,13160`). This is desktop WebKit, not physical iOS. |
| C3 | PASS: away position remains 62512px; bottom distance is 0px (`E/after/follow-intent.json:2-18`). |
| C4 | PASS: the same anchor remains at -420px; the image is mounted and decoded (`E/after/image-shift.json:2-13`). |
| C5 | PASS: independently recomputed all 300 rows: median 1.111111%, p90 10.385757% (`E/after/estimator-accuracy.json:4-9`). The supplied baseline recomputes to 23.809524%, not the task's 36.5%. |
| C6 | PASS: I ran `npx vitest run --maxWorkers=4`: 250 files, 2686 tests passed. `npm run build` exited 0. All eight changed source/test files have clean diagnostics. No tests were deleted or disabled in the diff. |

The runner hashes identically at failing commit `4894988`, passing commit `a5fe789`, and HEAD: `eed669df264cd1ae77346b5db2cf570945d2214985c2df08a6592f2c5a5ad556`. Its history contains only its initial addition. The other harness hashes also match `E/after/harness-before.sha256:1-3`. C4 was not made green by altering the harness.

## Implementation and test assessment

- **Estimate cache:** content updates retain the per-key estimate (`F/ChatTranscript.tsx:507-515`); removed keys are pruned (`:483-491`). Measurements win through virtual-core's `itemSizeCache` lookup (`E/virtual-core-index.original.js:632-635`). Metrics invalidation is defective, detailed below.
- **Correction replay:** explicit virtualizer intent clears both refs, and listener cleanup works; both passed executable checks (`F/ChatTranscript.tsx:527-533,577-584`). Accumulation is incorrect. Importantly, installed **3.17.6 also resets adjustments after eagerly advancing its offset**, not merely on observed scroll events (`E/virtual-core-index.original.js:423,1125-1132`).
- **Follow intent:** `isFollowing` is a stable callback, not a stale captured boolean (`F/useChatScroll.ts:26`). Bottom-follow and forced restore tests pass. Focus loss introduces a separate jump.
- **Adjacent behavior:** native scrollend intent remains covered by `F/ChatTranscript.scroll.test.tsx:26`; stable keys/windowing by `F/ChatPane.virtualization.test.tsx:30,58`. `RefImage` retains its intersection guard (`F/ChatTranscript.tsx:227`; explicit negative-intersection tests at `F/ChatTranscript.images.test.tsx:639,684`). Tool disclosure choices remain transcript-owned and pruned by retained IDs (`F/ChatTranscript.tsx:312-323,460-465`); `ToolCard` still prioritizes recorded choices (`F/ToolCard.tsx:111`). These related tests passed.
- **Test sensitivity:** not every new test is a regression detector. The fresh-key and bottom/restore cases are useful preservation controls. The replay test manually supplies `20,35` at an unchanged offset, bypassing the library behavior that breaks the implementation (`F/ChatTranscript.scrollAdjust.test.tsx:91-97`). The font test scales a supplied metrics object, so it cannot detect broken DOM measurement or settings propagation (`F/chatRowEstimate.test.ts:112-119`).
- **Optimistic assertion:** counting the real virtualizer's rows is faithful to the previous two-row assertion and avoids coupling reconciliation to estimated pixels (`F/ChatPane.behavior.optimistic.test.tsx:23-37,111,136`). However, changing the expected count from 2 to 3 only proves assertion sensitivity—not sensitivity to broken reconciliation (`E/mutation-optimistic-rowcount.log:17-21`).

## NOTES

- Adding the extra 12px turn-start gap to consecutive user rows is an acceptable estimation approximation given the measured accuracy, although the alternating fixture does not exercise it (`F/chatRowEstimate.ts:225-228`; `F/ChatTranscript.tsx:122-126`).
- On browsers advertising scrollend, missing that event leaves pending compensation indefinitely; there is no watchdog in that branch (`F/ChatTranscript.tsx:571-575`). Deferring throughout a genuinely ongoing gesture is intentional.
- `E/STATUS.md:3-17` and `E/verify-diffstat.log:1-8` are stale. The build emits a chunk-size warning.
- No unrelated production files changed. The worktree remains clean; PR #160 remains open and unmerged.

## Required changes

1. **`F/ChatTranscript.tsx:535-542,560-564` and `F/ChatTranscript.scrollAdjust.test.tsx:91-97`: correct replay bookkeeping and clear it for the real bottom-button intent.** Executing the current callbacks with the actual virtual-core `resizeItem` path produced 335px instead of 355px for +20/+35 corrections, and 320px instead of 340px for +20/+20. An intervening observed scroll also loses 20px. A queued -100px correction still replays after the bottom-button handler (`F/useChatScroll.ts:28-35`). **Proof:** deterministic integration tests through real measurement calls cover equal, increasing, mixed-sign, inter-event and successive-gesture corrections; each delta applies exactly once, and clicking bottom leaves no subsequent replay.

2. **`F/ChatTranscript.tsx:290-306` and `F/chatRowEstimate.ts:91-97`: make metrics/cache invalidation timely and complete.** Metrics are read during render before `useAppConfig` updates CSS in its effect (`frontend/src/app-config.ts:66-71`); clearing estimates afterward also leaves virtualizer calculations stale until another render. In browser execution, an unmeasured row retained 412px after selecting 10px, while a fresh estimate was 320px; selecting 24px then retained 320px versus 746px. Font-family changes are absent from the dependency/cache keys. **Proof:** changing width, font size or font family updates unmeasured estimates using the applied styles without unrelated input, while unchanged-metrics content updates stay frozen and measured sizes retain precedence.

3. **`F/chatRowEstimate.ts:99-142,217-218`: measure actual glyph and transcript geometry.** The body span stretches across the flex column, so `charWidth` measures container width divided by 62, not glyph advance. Browser measurements reported 6.2903px at both 10px and 24px fonts, while actual advances were 6.0915px and 13.4708px. The probe overrides the CSS row width; estimated user inner width was 288px versus 266.796875px. Its code probe also misses `.th-chat-markdown pre code` styling. **Proof:** browser checks across 10–24px and multiple widths match intrinsic glyph advance, real lane/bubble dimensions and code typography; rerun the unchanged C1–C5 harness without threshold regressions.

4. **`F/ChatTranscript.tsx:589-594`: preserve position when focus becomes false.** Removing the original `focused` guard makes losing focus scroll to the last row. A mounted-component check reproduced 300px → 5600px solely from `focused: true → false`. **Proof:** a regression test preserves the parked position on focus loss while focus gain and `restoreVersion` changes still force the intended end position.

VERDICT: REVISE