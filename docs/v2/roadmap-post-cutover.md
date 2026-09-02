# Post-cutover roadmap

2026-09-03 · main `55d1760` (v2 cutover complete). Three sequential phases born from the
first real-daemon incident and the stage-4 gap ledger. Each phase ships as its own worktree,
branch, PR, and review loop.

## Incident evidence (live protocol probing, 2026-09-02 night)

Four sessions opened against the real long-lived daemon all died within seconds, split
between `omorpc: transport disconnected: epoch 1: context deadline exceeded` and
`provider connection lost`. Probing the daemon socket directly with real session files:

| call | real 79 MB session file |
|---|---|
| `open_session` (resume) | 0.59 s, success |
| `get_entries` (full dump) | **no response within 90 s** |

Root cause chain (three compounding defects):

- **D1** full-dump `get_entries` over RPC is unusable on real multi-MB sessions — the
  engine rebuilds/indexes the whole transcript before answering.
- **D2** the bridge's 15 s per-message context turns the slow history load into a hard
  `DeadlineExceeded`.
- **D3** one call deadline invalidates the whole epoch; `Manager.invalidateEpoch` then marks
  every session in the epoch `provider_disconnected` — one slow load kills all sessions.

The v2 engine was only ever exercised against mock daemons with toy histories, so D1 was
invisible until first real use.

## Phase decisions

| Phase | Branch | Scope | Decision basis |
|---|---|---|---|
| A · history hybrid | `v2/history-hybrid` | cold history from disk; `get_entries` incremental only; deadline + invalidation separation | D1–D3 root cause; engine `since` parameter confirmed by protocol probing; v1's disk graph reader is a reusable in-repo asset |
| B · adoption copy | `v2/adopt-copy` | discovered-session adoption becomes a verified atomic copy; originals never opened in place | current resume-in-place writes turns into user CLI files and walks straight into D1 for exactly the biggest old files |
| C · activity subscribe | `v2/activity-subscribe` | `sessions.subscribe` frame set + unbound child-session event surfacing | stage-4 gap ledger #4/#6; manager `eventLoop` provably drops events for sessions with no live `Session` object (`bound=false`, no-op) |

Phase 1 (v1 metadata migration code) — **kept as-is by decision**: 129 LOC, isolated,
permanent no-op now that no v1 `state.json` exists anywhere; deletion is pure churn.

## Phase A — history hybrid (stage 6)

1. **Cold history is a disk read.** Hydration for a stored/discovered chat reads the
   session `.jsonl` directly: incremental chunked reads, malformed unterminated final line
   tolerated as a torn append, active branch = last file-order entry is the leaf, walk
   `parentId` links to the root. `get_entries` full dump is never used for cold load.
2. **Live history is incremental.** After attach, the bridge issues `get_entries` with the
   `since` cursor only (engine supports the optional parameter — protocol probing). Full
   dumps are forbidden on any path reachable from chat open/attach.
3. **Deadline separation.** Interactive per-message deadline stays 15 s. History/load
   hydration gets its own long budget. A caller-context deadline on a single call must
   fail that call only; only transport-level failure (write timeout on the socket, EOF,
   protocol break) invalidates an epoch.
4. **Red test first.** A synthetic multi-MB fixture session must open, hydrate from disk,
   and stay alive; no epoch invalidation; live deltas arrive via `since` reads.

## Phase B — adoption copy (stage 7)

1. Discovered rows never `open_session` the user's original file. Adoption = validated
   read (header/tree/version, size ceiling, duplicate guard), atomic copy to a
   webchat-owned directory (`temp + fsync + rename`), hash-verified against the original.
2. The copy becomes the chat's `sessionPath`; cold history for adopted chats is served
   from the copy via the Phase A disk reader.
3. `sidebar.tm.missingOriginal` stays meaningful: a copy whose original vanished is still
   readable; a missing copy row shows the dangling state.

## Phase C — activity subscribe (stage 8)

1. `sessions.subscribe` client frame + server push frames carrying task/dag activity for
   sessions not attached to the subscribing socket (gap ledger #4).
2. Manager ingests extension events for session ids with no live `Session` into an
   overview cache; child sessions spawned by the engine surface as overview rows (gap #6).
3. Design is validated against live daemon event names captured in the Explore-phase
   probe before the contract schema is edited.

## Constraints (all phases)

- Public artifacts (PR text, commits, docs, comments) must attribute protocol facts to
  live protocol probing or our own design decisions — no external product analysis.
- Contract changes flow through the canonical `contract/schemas/` definitions; regenerate Go + TS.
- `go test ./...`, `go test -race ./internal/...`, `npx vitest run` all green per phase.

## Phase C evidence appendix (2026-09-03, live runtime observation + design decisions)

- Live WS probe against the real daemon, using one subagent-spawning turn, captured 1516 frames:
  `run.started`→`run.done`, 1484 deltas, 12 tool frames, 2 `extensionEvent`
  (`senpi.eval.execution`), and 2 approvals. Only the chat's own `sessionId` appeared;
  child sessions did not get their own socket frames.
- Live daemon socket probing captured the task activity event as
  `rpc.emit("omo.task.updated", {parent_session_id, tasks: [...max 256], truncated_tasks})`,
  with per-task `child_session_id`, `run_stats`, and `live_progress` (driven by
  `subscribeChild`), and observed re-emission on each activity update while attached. The
  snapshot names are `activitySnapshotOrder` entries (`omo.task.updated` /
  `omo.dag.updated`).
- Design consequence: subagent "lists" are parent-scoped snapshot payloads, not separate
  sessions. Phase C's `sessions.subscribe` must (a) keep per-session snapshots for chats with
  no live pane socket and (b) run a real DAG during QA to observe `omo.dag.updated`
  end-to-end. The simple probe above did not trigger `omo.task.updated` because the spawn
  followed a path outside the task manager.
