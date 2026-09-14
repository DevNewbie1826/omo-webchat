# r3 real-Chrome regression: all three checks PASS

Artifacts are under /tmp/webchat-image-qa-r3/. Real headless Google Chrome, real omo agent, no transport mocks. Fresh authenticated browser context for each check; checks 1-3 use the SAME chat chat-36d7fa30 in workspace ws-e4fb6ca6.

## Setup and scope
Copied the current worktree including uncommitted changes into source/ to honor WRITE ONLY /tmp. Installed frontend dependencies (install.log), checked ChatTranscript.tsx diagnostics (none), and ran make build successfully (build.log; existing Vite large-chunk warning). Server bound loopback with password dev123. Final workspace is workspace-final/, containing the requested copied test-display.png. No repo edits or commits; before/after diff files compare equal. Initial combined build/server shell reached its timeout because it waited on the server; build itself succeeded. Subsequent servers were explicitly detached and tracked.

## RED then GREEN
Historical product RED: historical-red.md copies the preceding round's report; not reproduced against this build.

Current harness RED outputs retained:
- red/qa.log: check 1 `3 !== 1` counted engine notice cards as invocations; check 2 `0 !== 1` checked history before hydration. Text PASS.
- red-selector/qa.log: checks 1 and 2 timed out looking for an img INSIDE .th-tool, despite each receiving one HTTP 200 media GET. Screenshot check1-failure.png proves the image was actually visible. Source ChatTranscript.tsx renders the image as a sibling of .th-tool inside .th-chat-tool-media. This was a selector bug, not product failure.
Corrected only /tmp QA harness: select cards with data-tool-call-id, await hydration, and inspect their shared media wrapper. Final single script run qa.log/results.json: PASS, PASS, PASS. No product changes between runs.

## Per-check evidence
| Check | Verdict | Evidence |
|---|---|---|
| 1 REGRESSION | PASS | check1-collapsed.png, check1-expanded.png; matching -dom.txt/-dom.json; results.json check 1 |
| 2 ANCHORED | PASS | check2-collapsed.png, check2-earlier.png, check2-expanded.png; matching DOM files; results.json check 2 |
| 3 Plain text | PASS | check3-text.png and DOM files; exact assistant sentinel IMAGE_QA_TEXT_OK; zero media requests and page errors |

### Network proof
Full media request/response records and actual image_ref websocket frames: results.json. Compact output: qa.log.

Shared base: http://127.0.0.1:18091/api/workspaces/ws-e4fb6ca6/chats/chat-36d7fa30/media

1. GET ?toolCallId=toolu_01CXZLwQb5kcXy8pJ9bx3Gqp&contentIndex=1 -> 200.
   Collapsed GETs 0; first expansion 1; re-expansion still 1. Decoded blob image complete=true, 640x400. Live tool AND message websocket frames contain image_ref.
2. GET ?toolCallId=toolu_01AiGHeTkJce9BPhhucf6KoD&contentIndex=1 -> 200.
   New invocation, distinct ID, same chat. Collapsed GETs 0; first expansion 1; re-expansion still 1. New image decoded from blob, 640x400. Earlier card retains original ID and independently renders a decoded 640x400 data image hydrated from transcript history, without another GET. Exactly TWO real invocation cards, TWO media images, ONE per wrapper; assertions passed. Both cards remained expanded during the earlier/new scroll-position screenshots.
3. No media traffic; normal exact text response. No page errors in any final check.

## Visual observations and limits
Opened all final expanded/text screenshots: landscape with sun, mountains and house is visibly rendered, not an unavailable fallback. PNG signatures and 1280x1400 dimensions verified. Every captured state comes from the unchanged current build. Captured settled states, not animation timing. No reference mock was supplied. This child has no subagent dispatch tool: independent dual-oracle visual-QA certification is unavailable, so PASS here denotes the requested real-browser behavioral regression checks, not completion of that broader visual gate.

## Cleanup receipt
cleanup.json confirms server PIDs 17930, 19593, 21285 are gone via kill(pid,0); no listeners on 18089/18090/18091. Every harness run closes each context and awaits browser.close() in finally; final receipt browser-cleanup.json. Repo diff unchanged. Authored artifacts/build copies remain only under /tmp/webchat-image-qa-r3; ordinary engine-managed session persistence was not altered or deleted.
