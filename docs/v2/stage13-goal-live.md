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
