# Stage 7 — adoption copy: discovered sessions adopt verified copies

Roadmap: see `roadmap-post-cutover.md` Phase B. This stage executes it.

## Evidence

- Current behavior: a discovered row in the session tree opens the user's ORIGINAL
  `.jsonl` in place (`internal/api/sessions_history.go`, Source=stored|discovered). Two
  problems, both observed: webchat turns are written into the user's CLI session file, and
  old large files walk straight into the slow-history path this project just spent stage 6
  hardening (cold reads now make that survivable, but mutating a foreign live file is wrong
  regardless).
- Design decision (from live session-file probing + our own adoption UX): adoption must be a
  read-only, verified-copy workflow. The original is never opened for writing.

## Seams (pinned)

- `cursorstore.Chat.SessionFile` + `Store.UpdateIdentity(id, sessionFile, durableID)` — atomic
  adoption write; bridge consumes via `session.Cursor` at `wsbridge/bridge.go` (~750).
- `internal/coldhistory` (stage 6) — header/tree validation asset (id/version/leaf walk,
  index budget, torn-tail tolerance).
- `internal/api/sessions_history.go` — discovered catalog (`Source` field already exists).
- `SessionTree` discovered rows + `sidebar.tm.discovered` / `sidebar.tm.missingOriginal`
  i18n keys stay; only semantics change.

## Requirements

1. New `internal/adoptcopy`: validate source (header parses, durable id present, size at or
   under a documented ceiling), copy atomically (staging temp + fsync + rename) into a
   webchat-owned directory under the state dir, SHA-256-verify source vs published copy,
   clean the staging file on every failure path. Idempotent re-adoption of the same source
   yields the same chat, not duplicate copies.
2. Adoption REST endpoint: discovered row -> adopted chat. The copy becomes the chat's
   `sessionPath` via `UpdateIdentity`. Catalog marks the source `alreadyAdopted` while the
   original remains visible read-only.
3. Open/resume of an adopted chat targets the copy only. Originals are never `open_session`ed
   by the webchat server on any reachable path.
4. Dangling state: a copy whose source vanished stays readable; a missing copy row surfaces
   `sidebar.tm.missingOriginal` semantics.
5. Tests: torn final line tolerated at validation; oversized rejected; hash mismatch (mutating
   source mid-copy) rejected without publishing; concurrent adoptions of the same source
   converge; originals provably untouched (mtime + hash before/after a full chat open + turn).
6. Gates: `go test ./...`, `go test -race ./internal/...`, `npx vitest run` green; real-daemon
   smoke adopting a real discovered session.

## Constraints

- Public text attributes every protocol/format fact to live session-file probing or our own
  design decisions — no external product or reverse-engineering references.
- Contract changes (if any) flow through `contract/schemas/` with regenerated Go/TS.
