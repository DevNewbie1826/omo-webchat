# Stage 8 — activity surfaces: sessions.subscribe and unbound child visibility

Roadmap: see `roadmap-post-cutover.md` Phase C + its evidence appendix. This stage executes it.

## Evidence (live probing + our own manager code)

- Manager `eventLoop` drops events for session ids with no live `Session` object
  (`bound=false`, no-op) — engine-spawned child sessions never surface.
- Live WS probe (real daemon, one subagent turn): 1516 frames on the parent chat only;
  subagent execution events (`senpi.eval.execution`) arrive parent-scoped; task lists are
  parent-scoped snapshots (`omo.task.updated` / `omo.dag.updated` per activitySnapshotOrder).
- Stage-4 gap ledger #4 (sessions.subscribe deferred) and #6 (unbound frames
  accepted-but-unrendered) are the two open items this stage closes.

## Requirements

1. **`sessions.subscribe` client frame + server push frames** through the single-source
   contract (`contract/schemas/`, regenerate Go/TS): a socket may subscribe to activity for
   sessions not attached to it. Deliver task/dag activity snapshots (same shapes the REST
   live endpoint serves) as push frames; unsubscribe/teardown on socket close; bounded
   buffers with drop-oldest + overflow flagging consistent with existing replay semantics.
2. **Manager unbound-event ingestion**: extension events for session ids with no live
   Session feed an overview cache (task/dag snapshots + digests), not a silent drop. The
   cache backs both the REST live endpoint (unchanged shape) and the new push frames.
3. **Overview rows for child sessions**: chats running engine children surface their
   task/dag state in the overview even while no pane is attached (gap #6). Preserve: ID
   ordering + digest semantics (invariant 17/21), 4s REST poll stays valid for clients that
   never subscribe.
4. **Frontend**: overview/sidebar consumes push frames when available with REST poll
   fallback; no new polling loops; useT strings; named exports; th- prefix.
5. **Tests**: contract roundtrip for the new frames; manager ingestion test (unbound child
   event lands in cache and pushes); e2e — two sockets, one subscribed without attach,
   receives the activity snapshot when the engine emits it; REST shape unchanged
   (regression on existing live-sessions tests).
6. **Gates**: `go test ./...`, `go test -race ./internal/...`, `npx vitest run` green.
   Runtime DAG verification: since the local real-daemon host is currently unstable
   (environment issue, unrelated to this repo), validate event flow against the
   omorpctest daemon with engine-shaped task/dag events including a real
   `omo.dag.updated`-style multi-node payload.

## Constraints

- Public text attributes every protocol fact to live protocol probing or our own design
  decisions — no external product or reverse-engineering references.
- Single-source contract flow; no wire changes outside `contract/schemas/`.
