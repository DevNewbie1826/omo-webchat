# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-29
**Commit:** cd19a9b
**Branch:** main

## OVERVIEW
omo-webchat: local chat web UI wrapping the `omo` CLI. Go 1.26 server (`gws` websocket dep) + React 18/Vite/Vitest SPA; built frontend is embedded into the single Go binary via `frontend/embed.go` (`fs.Sub(frontend.Dist, "dist")`).

## STRUCTURE
```
.
├── cmd/server/        # main.go entry: config.Load -> daemon.Start + api.New -> Handler()
├── internal/          # store/daemon/config/auth route to internal/AGENTS.md
│   ├── chat/          # subprocess session engine: `omo --mode rpc`, frame protocol (own AGENTS.md)
│   ├── api/           # HTTP/WS boundary: central mux, embedded SPA, fs handlers (own AGENTS.md)
│   ├── store/         # JSON state persistence (atomic temp+rename, mode 0600)
│   ├── daemon/        # background daemon (stub off darwin/Linux)
│   ├── config/        # flags + config; legacy env GAJAE_PROVIDER as flag default
│   └── auth/          # token auth, memory-only tokens
├── frontend/
│   ├── embed.go       # embeds frontend/dist into Go binary
│   └── src/           # SPA (own AGENTS.md); lib/ = transport, features/split/ = split-view chat
└── test/
    ├── mock-pi/       # mock-pi.mjs: executable RPC/reconnect contract fixture used by Go tests
    └── install_checksum_test.sh
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Session lifecycle / omo subprocess | internal/chat | Manager/Session, Frame protocol |
| HTTP routes / WS endpoints | internal/api | central mux (router.go, ws.go) |
| Persistence format | internal/store | senpi->omo rename at read time |
| Frontend transport (api/ws/chatWs) | frontend/src/lib | sanitize + reconnect contracts |
| Split-view chat UI | frontend/src/features/split | pane tree, session reconciliation |
| RPC contract fixture | test/mock-pi/mock-pi.mjs | consumed by Go tests |

## CODE MAP
| Symbol | Type | Location | Role |
|--------|------|----------|------|
| chat.Manager / Session / SessionOptions / Frame / ParseClientFrame | types+funcs | internal/chat | high-reference subprocess session boundary |
| api.Server / New / Handler / Run | type+funcs | internal/api | HTTP/WS server boundary |
| store.Store / SessionStore | types | internal/store | persistence layer |
| useChatSession | hook | frontend/src | session + history reconciliation |
| chatPaneTestHarness | helper | frontend/src/features/split | pane test harness |

## CONVENTIONS
- Chat engine is a subprocess, not a library: always drive `omo --mode rpc` over its frame protocol.
- Store persists projects under `senpi` key; renamed to `omo` at read time without mutating storage.
- Provider flag default may come from legacy env `GAJAE_PROVIDER`.
- Auth token is memory-only: server restart forces re-login.
- Serving rejects empty password; `--stop`/`--status` exempt. Default bind is loopback.
- Client IP is always RemoteAddr - XFF headers ignored by design.

## ANTI-PATTERNS (THIS PROJECT)
- NEVER wrap `omo` in tmux or any multiplexer - direct `--mode rpc` only.
- NEVER run `npm test` (enters vitest watch mode) - use `npx vitest run`.
- NEVER trust X-Forwarded-For; no TLS/Secure cookies - loopback-only threat model, never expose the server raw.
- No PR test workflow in CI: tests run locally; releases via GoReleaser on `v*` tags (CGO disabled, Node 22 in CI).

## UNIQUE STYLES
- Frontend: named exports only, no barrel files; all strings through `useT`; CSS prefix `th-`.
- Go lifecycle test files >500 LOC are intentional canon, not a smell.

## COMMANDS
```bash
make build                    # frontend ci+build, then go build -> bin/omo-webchat
make frontend|run|clean       # make run uses dev password `dev123`
go test ./...
go test -race ./internal/...
npx vitest run                # in frontend/
sh test/install_checksum_test.sh
```

## NOTES
- Sub-AGENTS.md: internal/, internal/chat, internal/api, frontend/src, frontend/src/features/split, frontend/src/lib.
- Dirs without files route to parent: cmd/, test/, frontend/ root files -> this file; internal/{store,daemon,config,auth} -> internal/AGENTS.md; frontend/src/{components,styles,i18n}, features/{workspace,terminal,auth,system} -> frontend/src/AGENTS.md.
- Concurrency/dispatch hotspots: chat process manager, api router/ws, useChatSession history reconciliation, FileBrowser upload/cancel/focus flows.
