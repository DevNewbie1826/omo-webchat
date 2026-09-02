# WebSocket contract generation

`contract/schemas` is the single source for the committed Go and TypeScript contract mirrors.
Regenerate both with:

```sh
go generate ./contract
```

Node.js must be available because this command runs `gen_ts.mjs` after the Go generator. Both generators validate the supported JSON-Schema vocabulary strictly and fail on malformed types, references, or unsupported semantic keywords. CI can detect stale output with `go generate ./contract && git diff --exit-code`.

Known frame parsers validate required properties, constants, nested types, and closed enums. Unknown frame `type` values pass through for forward compatibility. Known frames also preserve additional wire properties when decoded and re-encoded, despite `additionalProperties: false`, so newer peers do not lose fields during a round trip.
