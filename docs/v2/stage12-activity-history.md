# Stage 12 — session history: subagents and DAG visibility

## Evidence

- User requirement (2026-09-03): opening a session in the web must show the subagents and
  DAGs that were used in it — currently invisible.
- Stage 8 shipped live activity surfaces (sessions.subscribe push, task/dag snapshot
  cache for daemon-attached sessions). Stage 11 shipped in-place open of CLI sessions.
  The gap: for a session opened in place, its HISTORICAL task/DAG activity is not
  rendered — activity frames cover the live window only.
- Data sources on disk (established by live probing in earlier stages): the engine's
  task store files live under the project's `.omo/senpi-task/` (tasks, logs) keyed by
  parent session; task snapshots also reference `parent_session_id` and
  `child_session_id` per task. The session file itself does not persist task snapshots.

## Requirements

1. **Historical activity surface**: for an attached (in-place or stored) chat, surface
   the session's PAST subagent tasks and DAG runs. Primary source: the engine task store
   under the chat's cwd (`.omo/senpi-task/tasks/*.json` — filter by the session's
   durable id / parent session linkage; fall back to any task-store entries whose
   parent_session_id matches). Secondary: none yet — if the store lacks linkage for old
   runs, surface what matches and degrade gracefully (empty state is honest).
2. **API + push**: REST endpoint per chat (e.g. GET /api/workspaces/{wsId}/chats/{chatId}/activity)
   returning the same task/dag shapes the stage-8 overview serves (reuse the digest/snapshot
   model); and on attach, hydrate the pane's activity shelf from this endpoint (frontend).
   Live updates continue via the stage-8 subscribe push for daemon-attached sessions.
3. **Frontend**: the activity shelf (existing components) gains a history hydration path —
   on chat attach, fetch the REST activity and merge with live frames (same merge rules as
   stage 8's ordering work: REST supersedes older pushes per side).
4. **Tests**: unit (task-store parsing/filter by parent session; REST shape parity with the
   stage-8 model), integration (attach with historical tasks in the store → shelf receives
   them), and the stage-8 suites stay green.
5. **Gates**: go test ./...; go test -race ./internal/...; npx vitest run green. Live
   validation: open a real session that used subagents (e.g. this project's own sessions)
   and see its task/DAG history render.

## Constraints

- Public text attributes format facts to live probing / own design.
- No new polling loops; REST fetch on attach + existing push infra only.
