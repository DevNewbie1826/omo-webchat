# Stage 13 — goal state live in the web

## Evidence

- User requirement (2026-09-03): "골이 설정되면 실시간으로 보이면 좋겠음" — when a goal is
  set on the CLI side, the web should show it live.
- Assets: stage-8 push infra (sessions.subscribe + activity frames), stage-11 in-place
  sessions (the web opens THE session), stage-12 disk-surface pattern (task store read
  under the chat's cwd).
- Unknown to resolve by live probing: where goal state persists (engine agent state file
  under ~/.omo or the project's .omo tree; this repo's own sessions run under goals —
  probe one), its format, and update cadence.

## Requirements

1. GOAL SOURCE: discover the goal-state file(s) by live probing (agent dir / project .omo;
   attribute to live probing). Implement a bounded reader (stage-12 budget/stable-read
   pattern) extracting: objective text (bounded), status, created/updated timestamps,
   blocked reason if present.
2. SURFACE: per-chat goal state — REST (e.g. GET .../chats/{id}/goal) + a wire frame or
   push on change. Simplest sound design: piggyback on the stage-12 attach-time hydration
   (fetch on attach) + a lightweight mtime-watched push when the daemon session is
   attached (reuse stage-8 push channels; if no cheap change signal exists, an explicit
   poll is acceptable ONLY if bounded and documented — prefer file-watch push).
3. FRONTEND: goal banner/card in the chat pane (objective + status + blocked reason;
   i18n ko/en; th- prefix; named exports). Updates live while attached.
4. TESTS: reader unit (formats/missing/corrupt), API integration, push-on-change (or
   poll) coverage, frontend rendering. Stage-8/11/12 suites stay green.
5. GATES + live validation: sequential go/race/vitest green; live: this repo's own
   session with an active goal renders its goal in the web.

## Constraints

- Public text attributes format facts to live probing / own design.
- Reuse stage-12 budget/stable-read utilities; no new unbounded reads.

## Live protocol probing findings (2026-09-03)

All facts in this section come from live protocol probing of this machine's
own agent state (this very session runs under an active goal and its files
were inspected); nothing is attributed to engine internals.

- SURFACE: the engine's live goal state lives under the coding agent dir, at
  `<agentDir>/sessions/<encoded-cwd>/extensions/goal/<sessionID>.json`, where
  `<encoded-cwd>` is the cwd with `/` replaced by `-` wrapped in `--`
  (exactly the encoder the disk-session lister already uses) and
  `<sessionID>` is the engine session id (the session JSONL header id, i.e.
  the durable session identity the catalog already stores). The same
  document names its session in a `threadId` field.
- FORMAT: `{"version":1,"goal":{...}}` with `goal.threadId`,
  `goal.objective` (long free text; the engine also emits truncated
  objectives plus a companion `objective-full.txt` for extreme cases),
  `goal.status` (observed values: `active`, `blocked`, `complete`),
  `goal.blockedReason` + `goal.blockedAt` when blocked,
  `goal.completedAt` when complete, `goal.createdAt`/`goal.updatedAt` as
  unix seconds, plus engine-only counters (`tokensUsed`, `timeUsedSeconds`,
  `consecutiveContinuations`, `unattendedContinuations`,
  `lastStartedAt`). Writes are atomic via a `.goal-*.tmp` sibling.
- CADENCE: `updatedAt` advances on goal-state transitions (observed live:
  the active goal's file mtime advanced twice during probing while its
  session worked). No cheap push signal exists engine-to-web, so the web
  watches the file's size/mtime with a bounded stat ticker (2 s) and pushes
  the bounded projection only on change — mtime-watch push-on-change, never
  a full-state poll on the wire.
- NOT THE LIVE SURFACE: `<project>/.omo/ulw-loop/<id>/goals.json` is the
  ulw-loop plan format (a goals/ledger plan, different schema, not keyed by
  chat identity). It is deliberately not read by this stage.

## Design

- Reader: `session.ReadGoalState` (internal/session/goal_state.go) reuses the
  stage-12 stable-read/budget seam: symlink rejection, size cap (512 KiB),
  stable-read with retry for the atomic tmp-rename write, `threadId`
  miskey rejection, rune-safe objective truncation (8 KiB wire bound with
  `objectiveTruncated`). Missing/corrupt/oversized/miskeyed ⇒ no goal, not
  an error; only context cancellation is an error.
- REST: `GET /api/workspaces/{wsId}/chats/{chatId}/goal` — protected,
  catalog-scoped, and confined like stage 12 (chat must belong to the
  workspace; chat cwd must resolve inside the workspace). Response
  `{"goal": <projection>|null}`. The raw chat cwd is encoded (matching what
  the engine wrote) after the canonical-path confinement check.
- Live updates: while a socket has the chat bound (stage-11 in-place open),
  a per-connection watcher stats the goal document each tick and pushes a
  `chat.goal` contract frame on appear/update/disappear (`goal: null` on
  disappearance). The bind-time read stays silent when no goal exists (the
  attach-time REST fetch already reported it).
- Frontend: attach-time `GET /goal` hydration plus `chat.goal` push handling
  (a push always outranks an in-flight fetch); the goal renders as a banner
  in the chat pane (`GoalBanner.tsx`, th- prefixed classes, ko/en strings).
