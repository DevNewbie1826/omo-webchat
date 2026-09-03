# INTERNAL PACKAGES

Server-side Go internals. `chat/` and `api/` have their own AGENTS.md; this file covers the remaining packages plus conventions shared across all of them.

## STRUCTURE
```
internal/
├── api/      # HTTP + WebSocket boundary (own AGENTS.md)
├── chat/     # subprocess session engine (own AGENTS.md)
├── store/    # JSON state persistence: chats + workspaces, migration, unknown-field round-trip
├── daemon/   # portable facade (daemon.go) over daemon_unix.go / daemon_other.go
├── config/   # flag-first config loading + validation
└── auth/     # in-memory cookie-token sessions, IP failure bans (middleware.go)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Persisted state shape / migrations | store | `Load`/`LoadDir`/`StateDir`, `NewChatID`, `Chat`/`Workspace`/`Store` |
| Daemon lifecycle / child handoff | daemon | `Start`/`Stop`/`Status`/`PrepareChild`, `RemoveChildPIDFile` |
| CLI flags / env / root validation | config | `config.Load`; env vars are only flag defaults |
| Login sessions / middleware | auth | `SessionStore.Create/Validate/Revoke/Authenticate/Middleware`, `SessionTTL` |

## CONVENTIONS
- `slog` for logging; errors wrapped with `%w`; context cancellation drives teardown.
- OS differences are filename-based (`*_darwin.go`, `*_linux.go`, `*_other.go`); unsupported platforms get stubs. When editing one side of a pair, check the other.
- State files are written atomically (temp file + rename) with mode `0600`.
- Store listings project persisted legacy records (`senpi` → `omo`) at read time and hide unsupported ones — storage is never mutated to match.

## ANTI-PATTERNS (THIS PROJECT)
- No TLS and no `Secure` cookie attribute anywhere — never expose the server without TLS termination in front.
- Client IP is `RemoteAddr` only; do not trust `X-Forwarded-For`.
- Session tokens are memory-only: a server restart logs users out. Do not persist them.
- Legacy env `GAJAE_PROVIDER` still loads (as a flag default); do not remove it silently.
- Do not assume daemon support off darwin/Linux — `daemon_other.go` is a stub.

## COMMANDS
```bash
go test ./...
go test -race ./internal/...
```
