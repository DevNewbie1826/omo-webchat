# WebSocket contract generation

`contract/schemas` is the single source for the committed Go and TypeScript contract mirrors.
Regenerate both with:

```sh
go generate ./contract
```

Node.js must be available because this command runs `gen_ts.mjs` after the Go generator. Both generators validate the supported JSON-Schema vocabulary strictly and fail on malformed types, references, or unsupported semantic keywords. CI can detect stale output with `go generate ./contract && git diff --exit-code`.

Known frame parsers validate required properties, constants, nested types, and closed enums. Unknown frame `type` values pass through for forward compatibility. Known frames also preserve additional wire properties when decoded and re-encoded, despite `additionalProperties: false`, so newer peers do not lose fields during a round trip.

## Contract v4: on-demand history

Clients opt into v4 by sending `hello` with `version: 4`. Before the engine
attaches, the server sends a provisional `entries` frame with
`segment: "preview"` and `final: false` for the uncommitted disk tail. The
authoritative terminal is a separate `entries` frame with no segment and
`final: true`. Live persisted message additions are announced with the server
`entry.appended` frame.

Older history is fetched with
`GET /api/workspaces/{wsId}/chats/{chatId}/history`. The endpoint returns 200
for a page, 400 for missing required parameters, 401 when unauthenticated, 404
for an unknown or inaccessible workspace/chat or missing session file, 409
for a stale history cursor, and 503 when history-read capacity is exhausted.
See [Stage 15: contract v4 on-demand history](../docs/v2/stage15-on-demand-history.md)
for the protocol details.
