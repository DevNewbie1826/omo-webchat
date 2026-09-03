# lib — TRANSPORT + BROWSER UTILITIES

Cross-feature shared code: HTTP + WebSocket transport, chat frame parsing, small browser utilities. Every feature consumes this; nothing here imports features.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| HTTP helpers | api.ts | path-ID encoding, typed promises, `apiVoid` |
| Generic WebSocket | ws.ts | connection + reconnect + liveness |
| Chat WebSocket | chatWs.ts | `connectChat`, `ChatClientFrame`/`ChatServerFrame` types |
| Frame parsing | chatWsParse.ts + chatWsParse{Conversation,Fields,Lifecycle,Session}.ts | per-concern parsers |
| Browser utils | font.ts, path.ts, useMediaQuery.ts, viewportSafeArea | all direct browser APIs live here |
| Sanitization | chatWs.sanitizeJson.ts | `sanitizeJson` + forbidden-key set |

## CONVENTIONS
- Parsing boundaries take `unknown` and validate with `isRecord`/typed field helpers; `sanitizeJson` rejects prototype-polluting keys (`__proto__`, `constructor`, `prototype`).
- WebSocket reconnect retries by default; a close-code callback opts out. Close logic must never run twice.
- Named exports only; types via `import type`.

## HOTSPOTS
- Each parse module has a paired behavior test (`chatWs.parse.catalog/payload`, `chatWs.extEvent`, `ws`, `viewportSafeArea`); parser changes fail loudly — keep the pairing.
- `chatWs`/`ws` are consumed by `useChatSession` upstream; reconnect changes surface as split-feature test failures.

## ANTI-PATTERNS (THIS PROJECT)
- No `fetch` or `WebSocket` outside lib — features go through `api.ts` / `ws.ts` / `chatWs.ts`.
- Malformed payloads return `null`, never throw — callers depend on that contract.
- Tests mock `WebSocket`, `fetch`, `matchMedia`, `localStorage` at this boundary; do not introduce new global escapes.

## COMMANDS
```bash
cd frontend && npx vitest run src/lib
```
