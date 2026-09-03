# api — HTTP + WEBSOCKET BOUNDARY

The only place browsers touch the server: `api.New(...)` → `Server.Handler()` mux, WebSocket chat proxying, and filesystem/workspace/auth/layout/system endpoints.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Route table / middleware | router.go | central mux; handlers are unexported methods |
| Server startup | run.go | `Run` |
| WebSocket surface | ws.go, routing.go | connection ownership, `OnMessage`/`OnClose` |
| Chat endpoints | chat.go | dispatch to chat.Session commands |
| Filesystem / workspace handlers | feature handler files | root-resolved paths, atomic writes, size limits |
| Platform stats | system_darwin.go / system_linux.go / system_other.go | filename-based OS variants |
| Test fixtures | testdata/name_pi.mjs | fake provider script for integration tests |

## CONVENTIONS
- Handlers are unexported methods on `Server`, reachable only through the central `Handler` mux — no side-door route registration.
- Frontend assets are embedded: `fs.Sub(frontend.Dist, "dist")`, immutable caching for `assets/`, no-cache for everything else.
- Filesystem handlers resolve every path beneath the allowed workspace root; writes replace atomically with explicit size limits; uploads and JSON endpoints are separate handlers.
- Tests are contract/integration style: `httptest` + real WebSocket harnesses + fake provider scripts in `testdata/`, not pure mocks.

## ANTI-PATTERNS (THIS PROJECT)
- Never bypass the router/auth middleware, and never call filesystem operations without root resolution — out-of-root paths are rejected by design.
- Never decode client frames ad hoc; route through `chat.ParseClientFrame`.
- Do not assume a single provider or platform: provider normalization and OS-specific system implementations are explicit here.

## COMMANDS
```bash
go test ./internal/api
```
