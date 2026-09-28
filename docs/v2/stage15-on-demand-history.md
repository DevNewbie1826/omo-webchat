# Stage 15: contract v4 on-demand history

Opening a chat used to replay the whole active branch over the socket on every
open, reconnect, and recovery. On a real 44 MB session that is 67 pages of
history frames before the user sees anything, and a slow reader could overflow
its subscriber queue just by receiving the replay. Contract v4 makes history
on-demand: the server sends only a bounded tail at attach, the client pages
older entries over a REST endpoint when the reader scrolls up, and live message
appends carry entry ids so the client can bind steer marks without ever loading
the branch root. v2 and v3 clients keep their exact previous wire behavior.

All protocol facts below come from live protocol probing of the engine socket
or are our own design decisions. Design inputs: `.omo/plans/on-demand-history.md`
gaps G4-G14, QA scenarios Q1-Q12.

## Why

- **Eager whole-branch replay is the dominant open cost.** Every open,
  reconnect, and overflow recovery pushed the complete active branch
  root-to-leaf (or tail-then-warm-pages for v3). For a 43 MB / 6k-entry session
  that is tens of megabytes over a loopback socket, multi-second time to first
  transcript row, and a full subscriber queue before the reader has scrolled
  anywhere.
- **Recovery amplified it.** Each overflow-triggered reattach re-hydrated the
  whole branch again, and a saturated recovery queue closed the socket
  outright.
- **Live frames carried no entry id.** The engine emits `entry_appended` after
  persisting a message, but the v1-v3 wire never forwarded it. Steer marks had
  to be keyed by root ordinal, which never applies under tail-only history,
  and recovered live frames could duplicate persisted entries because the
  client could not tell them apart.

## Version negotiation

- Client sends `{type:"hello",version:4}`. The server answers with
  `ContractVersion = 4` and `MinContractVersion = 2`
  (`internal/wsbridge/bridge.go`).
- `internal/wsbridge` gates features by hello version through named constants,
  so bumping the contract does not silently retarget older gates:
  `progressiveHistoryVersion = 3` backs `ProgressiveHistory()`
  (`helloVersion >= 3`), and `onDemandHistoryVersion = 4` backs
  `OnDemandHistory()` (`helloVersion >= 4`) on the subscriber.
- The session package defines the capability seam:
  `type OnDemandHistorySubscriber interface{ OnDemandHistory() bool }` in
  `internal/session`. The wsbridge subscriber implements it; hydration asks
  the replay target, so any future transport gets the same opt-in.

## Tail-only hydration (server)

When the replay target implements `OnDemandHistorySubscriber` and returns
true, `hydrateEntriesValidated` (`internal/session/session.go`) changes its
replay shape:

1. Emit ONLY the bounded tail: at most `hydrationTailBudget = 60` branch
   entries from `internal/coldhistory` (`StreamTailFirst` tail budget), then
2. the live engine tail as the terminal page, exactly as today, then stop.
   No `segment:"head"` warm pages are ever emitted. There is no head-fill
   hold machinery and no auto warm.

Rules that still hold:

- The terminal page carries `historyComplete`, computed as
  `(first emitted branch index == 0)`: true only when the bounded tail reached
  the branch root. A large session under v4 therefore ends hydration with
  `historyComplete = false`, which is the client's signal that older pages
  exist and can be fetched over REST.
- The complete-branch notice derivation and compaction fold
  (`deriveCompleteHistoryBranch`) still run root-to-leaf BEFORE the terminal
  commit, so the compaction count and transcript notices a v4 client sees are
  identical to v3. Hydration is cheaper on the wire, not less correct.
- Resume path: `historyComplete = (cursor first index == 0)`, and no warm
  ranges are emitted after a resume either. The accepted resume cursor is
  echoed on the terminal page as today (`resume` + `historySessionId`).

## The `entry.appended` frame (server to client)

New server frame, defined in `contract/schemas/server-frames.json`
(`EntryAppendedFrame`) and generated into `internal/wscontract`:

```json
{"type":"entry.appended","sessionId":"<chatId>","id":"<entry id>",
 "parentId":"<parent entry id or null>","role":"<role>",
 "textPrefix":"<prefix>","bindingId":"<optional binding id>"}
```

Emission rules:

- Sent ONLY to subscribers whose hello negotiated version 4.
- Sent ONLY for engine `entry_appended` events whose entry type is
  `"message"`.
- `textPrefix` is the first 128 Unicode code points of the concatenation of
  the message's text content blocks (the content string, or blocks with
  `type:"text"` joined with `""`), exactly as persisted. Go computes it in
  runes; the TS mirror uses `Array.from(s).slice(0,128).join("")`. `parentId`
  is null when the entry is the branch root.

## REST history endpoint

```
GET /api/workspaces/{wsId}/chats/{chatId}/history?session=<durableSessionId>&before=<entryId>&limit=<n>
```

- Auth-protected like every other `/api` route; workspace/chat confinement
  applies (a chat belonging to another workspace is 404, not a leak).
- `limit` defaults to 100 and is clamped to `[1,100]`; a request asking for
  1000 gets at most 100 entries.
- The page is additionally bounded by the coldhistory `PageBytes` budget
  (`DefaultPageBytes = 4 << 20`, 4 MB), so one entry cannot blow the response.
- Pages are read through `internal/coldhistory` (`StreamBefore`) directly from
  the session file; a concurrency limiter caps simultaneous history reads and
  identical in-flight pages are coalesced so a scrolling client and a
  recovering subscriber do not index the same file twice.

Status codes:

| Code | When | Body |
|------|------|------|
| 200 | page read | `{"sessionId":string,"entries":[<raw entry JSON>...],"historyComplete":bool}` |
| 400 | missing `session` or `before` param | error body |
| 401 | unauthenticated | (auth middleware) |
| 404 | unknown workspace or chat, chat in another workspace, or missing session file | error body |
| 409 | stale cursor: `session` != the chat's `DurableSessionID`, `before` not on the current active branch, or the chat's live session is quarantined by an external write | `{"error":"history_cursor_stale"}` |
| 503 | history read capacity exceeded | error body |

Semantics of a 200 page: `entries` are in branch order, the newest entry
immediately before `before`, walking toward the root; `historyComplete` is
true if and only if the page reaches the branch root (oldest entry is the
root). Pagination is pure cursor: the client passes the current oldest loaded
entry id as the next `before`.

## Client loader (frontend)

`useChatSession` exposes the view surface:

- `olderHistory: { state: "idle"|"loading"|"error"|"complete"|"unavailable"; loadOlder(): void }`
- `historyRootKnown: boolean`, true once the committed list is known to start
  at the branch root (terminal `historyComplete`, or a REST page that reached
  it).
- `historyFailedEmpty: boolean`, true iff connected AND
  `historyStatus === "failed"` AND zero committed messages. This is the only
  case where a history failure renders as a failed row with a retry button;
  the row is hidden while disconnected.
- `retryHistory(): void`, allowed even while a run or compaction is active,
  as long as there are zero committed messages (invariant 16's run gate never
  applied to a bare retry).

Fencing rules for the loader (these are the invariants; see
`docs/v2/invariants.md` #23):

1. At most one history request in flight per pane.
2. Every request is fenced by `connectionGeneration` + `historySessionId`; a
   stale fence result is discarded, never prepended.
3. A request is aborted on `markOpen` / `markClose` / `beginResync`.
4. A 409 (`history_cursor_stale`) triggers `beginResync` at most once per
   load; a 404 never resyncs (the chat or its session file is gone; a network
   error leaves the loader in `error` with a retry affordance instead).
5. Pages prepend without reparsing or repainting the committed list: parsed
  `UiMessage`s are cached by entry id so row identity survives prepends.
6. Notices older than the first loaded message stay hidden until their range
   is loaded.

### Steer marks by entry id

- The v4 client binds `entry.appended` ids FIFO onto id-less live message
  frames, so a live user message gains its durable entry id as soon as the
  engine persists it.
- Steer marks are keyed by entry id. A retained steer occurrence binds to the
  live message with the same entry id, and its pending summary retires because
  the echo proves the engine consumed it.
- Legacy ordinal-based marks migrate to entry ids only when the branch root
  has been loaded; under tail-only history (root never loaded) ordinal marks
  simply do not apply, which is the pre-v4 behavior made explicit.
- Recovered live frames no longer duplicate persisted entries: the resume
  echo plus entry ids lets the client drop frames the replayed pages already
  delivered (`internal/wsbridge/replay_live_overlap_e2e_test.go` pins the
  overlap contract).

## Overflow recovery hardening

Pre-v4, the recovery queue was a buffered channel; when it filled, the server
closed an otherwise healthy socket. v4 changes the mechanics
(`internal/wsbridge/bridge.go`, `subscriber.go`):

- The recovery channel has capacity 1 and carries NO recovery state. It is a
  wake signal only, so N pending overflows coalesce into at most one in-flight
  recovery pass per connection.
- Recovery ownership lives in per-subscriber-attempt pending state
  (`sub.attempt.recovery`). `run()` dequeues and executes the current
  subscriber's pending recovery exactly once; `commitBinding`,
  `bindRecovered`, and `bindResumed` re-signal after a commit so a recovery
  armed mid-bind is not lost.
- Locking: recovery takes `sub.mu` and `stateMu` together under the order
  delivery already uses, and never holds `stateMu` while waiting on `sub.mu`.
  A concurrent bind cannot turn a checked recovery into an unbind of its
  successor.
- Overflow transfer ownership: a saturated subscriber's undelivered state may
  transfer to its replacement. The transfer is released only by the matching
  session + transfer key + instance (never deleted by key alone, never
  succeeded via a fresh hydrate over a saturated transfer), on give-up, chat
  switch, or shutdown.
- Budget: at most 3 consecutive automatic recoveries. The counter resets after
  120 s of healthy connection or on an explicit user `chat.create`. Exhaustion
  closes the socket through exactly one path that logs
  `subscriber_recovery_exhausted` and sends `subscriber_overflow`.
- Diagnostics: every enqueue and dequeue logs subscriber, binding id,
  transfer key, and generation, so a recovery storm is attributable from the
  log alone.
- Resume echo: after the terminal history page is delivered, the pump records
  `deliveredCursor` (session id, first/last entry id, historyComplete) and
  passes it as the `resume` field of the recovery `chat.create`. The client's
  accept check is narrowed accordingly: same `historySessionId`,
  `echo.lastEntryId == cursor.lastEntryId`, and `echo.firstEntryId` present in
  the committed list. Overflow after terminal delivery therefore reattaches
  with a resume echo and the client keeps its committed list, including any
  REST-prepended rows; overflow before terminal delivery does a fresh load; a
  branch switch still replaces the list.

## v2 / v3 compatibility

| Hello | Wire behavior | Unchanged by v4? |
|-------|---------------|------------------|
| 2 | Complete root-to-leaf `entries` stream; `final` on every page (invariant 18) | Yes, byte-identical contract |
| 3 | Bounded tail + terminal page, then warm `segment:"head"` pages newest-first with `historyComplete` on the final one | Yes. `ProgressiveHistory()` keys off `progressiveHistoryVersion = 3`, not off `ContractVersion`, so bumping the contract to 4 does not demote v3 tabs to the v2 stream |
| 4 | Tail-only hydration, `entry.appended`, REST history paging | New |

A v3 SPA tab that stays open across a server upgrade keeps its exact previous
history stream; only clients that send `hello version 4` see the new shape.

## Source map

| Piece | Location |
|-------|----------|
| Version constants, recovery loop | `internal/wsbridge/bridge.go`, `internal/wsbridge/subscriber.go` |
| Capability interface, tail-only hydrate, notice/compaction fold | `internal/session/session.go` (`OnDemandHistorySubscriber`, `hydrateEntriesValidated`, `hydrationTailBudget`, `deriveCompleteHistoryBranch`) |
| Disk paging, resume cursor | `internal/coldhistory/coldhistory.go` |
| Frame schema | `contract/schemas/server-frames.json` (`EntryAppendedFrame`), generated mirror `internal/wscontract/types_gen.go` |
| REST endpoint | `internal/api` (route `GET /api/workspaces/{wsId}/chats/{chatId}/history`) |
| Client API, loader, steer marks | `frontend/src/features/split/useChatSession.ts`, `useEntriesPageBuffer.ts`, `chatSteerMarks.ts`, `useChatFrameHandler.ts` |
| Pinning tests | `internal/wsbridge/hello_progressive_test.go`, `replay_live_overlap_e2e_test.go`, `internal/session/broadcast_history_delivery_test.go`, `broadcast_transfer_ownership_test.go`, `broadcast_transfer_recovery_test.go` |
