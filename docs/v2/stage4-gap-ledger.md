# Stage-4 gap ledger

2026-09-02 · explore pass on main `86569ef` · branch `v2/data-surfaces`.
Decisions: `FIXED (completed in the round-2 follow-up commit: end-to-end usability, DAG reconciliation, title lifecycle)` / `DEFERRED-stage-5` / `INTENTIONAL-REMOVAL` / `NOT-A-GAP`.

## 1. Sidebar tree missing v2 sessions

**Description.** `GET /api/workspaces/{wsId}/sessions` listed `store` chats only. Cursorstore-only v2 chats never reached `SessionTree` (silent omission).

**Decision.** FIXED-here

**Rationale.** `handleListWorkspaceSessions` unions via `unionWorkspaceChats` + `cursorstore.ListChats`. Overlapping IDs keep the legacy name. Covered by `TestListWorkspaceSessionsUnionsCursorChatsWithStoredChatsWinningConflicts`.

## 2. v2 Summary lacking title/digests

**Description.** `session.Summary` had no `Title`, activity pair, or task/dag digests, so `GET /api/sessions/live` left overview badges dark for v2 sessions.

**Decision.** FIXED-here

**Rationale.** Session now derives title (first prompt / `session_info_changed`) and digests from the activity-snapshot cache; `handleListLiveSessions` copies them onto `liveSessionResponse`. Covered by `TestListLiveSessionsEnrichesV2SummaryWithCompatibleShape`.

## 3. Upload endpoint for v2 chats

**Description.** `POST /api/workspaces/{wsId}/chats/{chatId}/upload` resolved chats only through `store.GetChat`, so cursorstore-only chats 404'd.

**Decision.** FIXED-here

**Rationale.** `handleUpload` falls back to `cursorstore.GetChat` when the legacy row is missing, still requiring `WorkspaceID` match. Persist is engine-independent. Covered by `TestUploadAcceptsCursorStoreOnlyChatAndRejectsMissingChat`.

## 4. Background-session activity WS feed (`sessions.subscribe`)

**Description.** No `sessions.subscribe` (or bridge frame set) pushes activity for sessions not attached to the pane socket. Unattached overview is REST-only.

**Decision.** DEFERRED-stage-5

**Rationale.** `GET /api/sessions/live` at 4s (`useLiveSessions` `POLL_MS=4000`) already fills badges/summaries. A subscribe frame set is a contract change; it belongs with cutover, not this additive rewire.

## 5. `GET /api/ws` still registered

**Description.** Router still mounts v1 `GET /api/ws` (`handleWS`) while `features/` chat transport uses `CHAT_WS_ENDPOINT` (`/api/v2/ws`).

**Decision.** DEFERRED-stage-5

**Rationale.** Dual-mount is required while the v1 engine remains. Dropping `/api/ws` is cutover work (v1 engine switch), not a data-surface completeness hole.

## 6. `extensionEvent` for unbound sessions accepted-but-unrendered

**Description.** `ingestExtensionEvent` stores task/dag frames for any `sessionId`; `useMergedLiveSummaries` only paints overrides whose id is already in the poll snapshot.

**Decision.** NOT-A-GAP

**Rationale.** Chat WS is attach-scoped, so background sessions never emit `extensionEvent` on the pane socket. The 4s live-list poll (now title/digest-enriched) is the intended fill. Orphan overrides without a poll row stay inert until `sessions.subscribe` (gap 4). Known behavior, not a stage-4 defect.


## Round-2 addendum
The initial merge-state of items 1-3 was incomplete: cursor-only rows were visible but not
operable (create/rename/delete), terminal-DAG reconciliation and the title lifecycle diverged
from v1. These are closed by the round-2 fix commit; the ledger marks them FIXED only in that
final sense.
