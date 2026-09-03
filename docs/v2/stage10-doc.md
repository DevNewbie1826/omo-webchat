# Stage 10 — daemon-spawn session memory binding

## Evidence (user report + prior in-web investigation, 2026-09-03)

- Symptom: in sessions opened through the web (engine sessions spawned by our rpc host
  daemon), the omo memory tools fail with "no memory identity bound to this session;
  enable omo memory and restart the session so the memory tools can initialize".
  CLI-started sessions in the same project keep working memory.
- Prior probing (done in a web chat, attributed to live probing): the memory component
  ships inside the omo-ai plugin extension (default-on; `--omo-senpi-memory-disabled`
  flag exists); memory home resolves from `OMO_MEMORY_HOME` else `~/.omo/memory`, with
  per-agent `agents/<id>/{repo,runtime}`; identity binds once at session start.
- Stage 9 (merged) guarantees the plugin `--extension` is forwarded on every spawn path
  (launcher default and node fallback) and the parent environment is inherited — so the
  component LOADS; the failure is in per-session identity INITIALIZATION in daemon-spawned
  sessions, not in loading.
- The user updated omo again today; current behavior must be re-measured fresh.

## Requirements

1. **Reproduce first**: start this branch's server (ladder spawns the daemon), open a web
   chat, drive the memory tool end-to-end. Record the exact failure point (or confirm it
   is already healed by today's omo update — then pin it with a regression so it cannot
   silently regress again).
2. **Root cause**: identify what the daemon-spawned engine session lacks at session-start
   initialization versus a CLI-started session (suspects: env the interactive CLI injects
   around the memory home/agent identity; a start-time hook that only runs on interactive
   paths; runtime-dir state). Attribute all findings to live probing.
3. **Fix in this repo**: whatever is actionable server-side — explicit env forwarding
   through ensure/open_session (e.g. memory home/identity vars), or the missing
   initialization signal our spawn can provide. If the remaining gap is purely upstream
   (plugin needs a CLI-only interactive path), document precisely and implement the
   strongest server-side mitigation available; state the boundary honestly in the PR.
4. **Validation**: a web session's memory write/recall round-trips into the SAME agent
   store a CLI session of the same project uses (assert on the repo path/agent id), and
   the bound identity survives across daemon respawns (ladder retry path included).
5. **Tests**: deterministic regression pinning whatever initialization we control;
   gates `go test ./...`, `go test -race ./internal/...`, `npx vitest run` green.

## Constraints

- Public text attributes every protocol/runtime fact to live probing or our own design —
  no external product or reverse-engineering references.
