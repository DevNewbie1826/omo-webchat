st_01a0a499 [completed] model GPT-6 Astra (reasoning xhigh, variant max)
Merge is blocked by fabricated failure wording.

**Verified on `954987b`:**
- `go test ./...`, `go test -race ./internal/...`, `npx vitest run` (2,716 tests), frontend build, `go build ./...`, and `go generate ./contract && git diff --exit-code` passed.
- Independent Chrome execution through scripted RPC → Go dispatch → real WebSocket → production parser/state/transcript displayed exact failure text, `auto_retry_start`, `auto_retry_end`, all four `retry_fallback_*` notices, and `continuation_error`.
- Backward compatibility passed: frames without either field parsed and rendered normally, with no error rows or empty placeholders. Fields remain optional in `contract/schemas/shared-types.json:89`, `internal/wscontract/types_gen.go:32-36`, and `frontend/src/lib/contract/types_gen.ts:26-30`.
- Producer paths agree: live cloning (`internal/session/dispatch.go:493`), raw history paging (`internal/session/session.go:1926,2191,2250`), per-field parsing (`frontend/src/lib/chatWsParseFields.ts:180-208`), and restoration (`frontend/src/features/split/chatEntries.ts:304-313`). Browser checks also preserved errors through both live and restored tool folding.
- Cancellation and successful tool-only scenarios produced zero error rows.

**NOTES**
- Main advanced beyond `62ccd7a`; the apparent unrelated deletions in `main..HEAD` are not branch-authored deletions. The branch-relative diff introduces no test deletions or skips.
- Validation used Go 1.27.1 and scripted RPC events, not a live provider quota failure.
- Initial synthetic-page WebSocket probes failed with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`; serving genuine same-origin HTTP/WebSocket resolved the harness issue.
- Build emitted the large-chunk warning. `git diff --check` flagged whitespace in committed evidence logs only.
- Tracked files remain unchanged; temporary review artifacts were removed.

**Required change**
1. `frontend/src/features/split/ChatTranscript.tsx:688-695`, `frontend/src/i18n/locales/{en,ko}.json:195`, and `ChatTranscript.turnError.test.tsx:64-79`: the fallback invents **“Turn failed”**, violating the wire-only wording requirement. The strongest counter-case reproduced this with both `errorMessage: ""` and absent `errorMessage`, alongside `stopReason: "error"`. Remove the synthesized label and render only wire-provided failure text/stop reason. Proof: those two frames never display fabricated wording, nonempty failure text remains exact, and legacy/cancellation/tool-only cases remain unchanged.

VERDICT: REVISE