st_01a0a48f [completed] model GPT-6 Astra (reasoning xhigh, variant max)
**Agreed: the mounted-row/finite-size criterion is met.** The FAIL is an oracle mismatch, not evidence of a product defect.

I independently parsed `chat-switch.json`:
- All **22 observations** have mounted rows and finite geometry.
- Sample **15** alone has zero visible rows; sample **16** restores five visible rows at the same scrollTop.
- All **16 frame samples** have at least four visible rows.
- All four checkpoints pass; `observations.nonFinite` is empty.

Two timing corrections: MutationObserver callbacks run asynchronously after mutations, not necessarily inside React’s synchronous commit; `requestAnimationFrame` runs **before paint**, not after it. Therefore, these observations neither demonstrate a blank painted frame nor universally prove “never blanks.”

**No additional required change arises from this browser evidence.** The two independent blockers from my executed review remain:

1. **`frontend/src/features/split/ChatPane.behavior.optimistic.test.tsx`:** Both tests survived removal of reconciliation’s ID filtering. Exercise overlapping live/snapshot IDs; prove the unchanged implementation passes and that exact mutation fails.
2. **`.omo/evidence/mobile-scroll-fix/harness/metrics-sweep.mjs:18`:** Accepted single-quoted escapes decode incorrectly. Decode them accurately or reject them loudly; prove runtime-value equality or explicit failure while retaining the passing metrics sweep.

VERDICT: REVISE