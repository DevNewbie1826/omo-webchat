# Stage 9 — daemon runtime fallback: env inheritance, bun→node ladder, signed stderr

## Evidence (live probing, 2026-09-03 deep-dive)

Three independent layers broke the spawned daemon chain today:

- **C1 (this repo)**: `internal/api/run.go` builds `omorpc.EnsureConfig{WorkingDir}` without
  `Env`; `EnsureExtensionEventsCapability(nil)` returns a NON-nil empty slice, and a
  non-nil `cmd.Env` in Go means the child inherits ZERO environment (no PATH, no HOME).
  The daemon host's watchdog then fails `execFile("ps")` with ENOENT (reproduced directly
  with an `env -i` supervisor) and the daemon dies minutes after server start — under any
  runtime. This is the direct cause of every server-spawned daemon death today.
- **C2 (external)**: the current bun binary (replaced in-place today under
  /opt/homebrew/bin/bun) hits `RangeError: Out of memory` inside the daemonized host
  child's watchdog `execFile("ps")` in a tight loop — full env and a 4 GiB JSC heap raise
  do not help; the same call works in a bare runtime. Upstream runtime issue; the launcher
  shim prefers bun whenever the binary exists, so this fails readiness.
- **C3 (context)**: supervisors spawned from agent/tool sessions die on the watchdog's
  ppid identity checks; user terminals are unaffected. No code change warranted.

The pre-replacement bun binary ran the original daemon for days with a full environment —
the difference is exactly C1 (env) + C2 (binary) + spawn context.

## Requirements

1. **Env inheritance (C1 fix)**: the ensure path passes the parent environment through
   (`os.Environ()` + the capabilities variable). `EnsureExtensionEventsCapability(nil)`
   returns nil (inherit) rather than an empty slice; document the Go nil-vs-empty trap.
   Regression: a spawned supervisor env must contain PATH.
2. **Runtime ladder**: first attempt runs with no runtime override (the launcher shim
   prefers bun when present; absent bun already falls back to node). On failure —
   readiness timeout, supervisor exit before ready, or capability check failure — tear
   the attempt down (SIGTERM the tree, remove a stale socket file) and retry once with
   `OMO_RUNTIME=node` in the child env. Persist the winning choice in memory for the
   process lifetime (respawns reuse it; every fresh server start retries bun first, so
   an upstream runtime fix is picked up automatically). A user-set `OMO_RUNTIME` is
   authoritative: no ladder, single attempt as specified. Retries stay inside the
   existing ensure lock; failure of both attempts returns a typed error naming both.
3. **Signed stderr**: the spawned supervisor's stderr is captured to a bounded file under
   the state dir (replaces `nil`), so daemon deaths leave evidence. Keep it simple:
   truncate-on-start single file, size-bounded by readiness/attempt lifetime.
4. **Tests**: unit (env passthrough; ladder with fake supervisor binaries that fail/succeed
   per runtime marker; user-override respected; socket cleanup between attempts;
   in-memory winner reuse) and integration (real binary on this machine reproduces the
   bun-failure → node-success → daemon-stays-alive path).
5. **Gates**: `go test ./...`, `go test -race ./internal/...`, `npx vitest run` green.

## Constraints

- Public text attributes runtime/protocol facts to live probing or our own design — no
  external product or reverse-engineering references.
