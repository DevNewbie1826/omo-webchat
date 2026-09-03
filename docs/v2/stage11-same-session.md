# Stage 11 — same session across TUI and GUI (takeover, not fork)

## Evidence

- User requirement (2026-09-03, explicit): TUI and GUI must use THE SAME session. Opening
  a CLI session in the web must open THAT session and continue it — not a copied fork.
- Current model (stage 7): discovered rows adopt a VERIFIED COPY; the web chat continues
  the copy while the CLI keeps writing the original — the conversation splits. The
  채택/채택됨 UI split exists only to serve that fork model.
- Known defect (live-observed): re-adoption after a turn was appended to the owned copy
  returns `collision` instead of the bound chat.
- Assets already merged: coldhistory disk reader (stage 6), provenance/peer-identity
  state machine and env-complete spawning (stage 9), memory binding verified shared
  across web/CLI (stage 10) — the agent's memory now follows the session owner.

## Requirements

1. **In-place open (the new default)**: clicking a discovered session opens THE ORIGINAL
   session file — validated (header/tree/ceiling via the adoptcopy validation assets)
   then `open_session(original)`; web turns append to the original; cold history serves
   from disk (stage 6 path) exactly as for owned chats.
2. **Takeover safety**:
   a. Pre-takeover activity check: if the original shows a fresh writer (mtime/size
      delta within a short window), the web offers a read-only live view and a
      "force takeover" affordance, not a silent double-writer.
   b. Takeover snapshot: before the first web-side write, one bounded backup copy of the
      original is recorded (size-ceilinged, single per session, restorable).
   c. External-write detection while web owns the session: file identity/leaf drift
      observed → re-hydrate from disk + surface an explicit "external write detected"
      state instead of silently diverging.
3. **UX**: the 채택/채택됨 split is REMOVED — a discovered row opens the session directly
   (requirement 1). The REST adoption endpoint remains for scripted fork use but is no
   longer the UI path.
4. **Fork-adopt collision fix (absorbed)**: adoptExistingChat returns the chat already
   bound to an existing provenance-owned destination regardless of hash drift since
   adoption; strict hash collision still applies to untracked destinations. Regression:
   turn-appended re-adopt returns the same chat.
5. **Tests**: in-place open path (open_session receives the ORIGINAL, not a copy);
   freshness gate; backup-once semantics; external-write re-hydrate; UX flows
   (click-through open, live-view state); collision regression; existing adoption,
   provenance, and stage-6/9 suites stay green.
6. **Gates + live validation**: go test ./..., go test -race ./internal/...,
   npx vitest run green; live: open a real CLI session from the web, send a turn, assert
   the ORIGINAL file grew (web writes landed in it), then resume it from the CLI and
   assert the web-written turn is visible there — the same-session loop closed.

## Constraints

- Public text attributes every protocol/format fact to live probing or our own design.
- Stage-9 provenance semantics are reused, not reinvented.
