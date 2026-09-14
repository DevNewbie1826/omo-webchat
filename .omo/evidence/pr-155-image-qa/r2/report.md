# Image QA round 2: four behavioral checks PASS

Real headless Google Chrome, real omo engine, no mocked transport. Fresh browser context per check with login state only. Evidence paths below are relative to /tmp/webchat-image-qa-r2/.

## Setup
To honor WRITE ONLY /tmp, copied the current worktree (including its uncommitted implementation) to source/, ran bun install and make build there: both succeeded (install.log, build.log). No source changes. Server PID 80404 listened on 127.0.0.1:18088 with password dev123 and isolated server state. Chat workspace: /tmp/webchat-image-qa-r2/workspace; copied the requested test-display.png there. This deliberately avoids writing build artifacts or a temporary image into the original worktree.

## RED then GREEN
RED historical baseline, not reproduced on this revision: prior-red-report.md and prior-red-check1.png copied from the preceding QA run. That run reported live expanded text only and timeout waiting for an image.

RED in this run's initial check-4 harness: remaining-results.json says `Expected exactly one unseen coordinate request`, actual 0. The harness used hydrated history, which contains inline data images rather than unseen image_ref coordinates. This is not evidence that live lazy fetch is broken. Re-exercised the exact contract with a new real live read in a fresh browser context; GREEN below. A first new-live screenshot placed the expanded image below the viewport; corrected capture scrolling and captured a new live read. No product code changed.

## Final verdicts
| Check | Verdict | Evidence |
|---|---|---|
| 1 LIVE expanded card | PASS | live-0.png, live-results.json; real decoded image 640x400, blob: source; latest repeat also shows full expanded card and image in check4-live.png |
| 2 RELOAD hydration | PASS | check2.png, remaining-results.json check 2; fresh context, page reload and chat re-entry, live DOM complete=true, 640x400, data: source, zero media requests |
| 3 Plain text | PASS | check3.png, remaining-results.json check 3; actual assistant response exactly IMAGE_QA_TEXT_OK; zero page errors/media requests |
| 4 Lazy disclosure | PASS for live image_ref | check4-live-collapsed.png, check4-live.png, check4-live-results.json; collapsed aria-expanded=false and zero GETs; first expansion one GET; collapse/re-expansion still one GET total, image decoded |

## Capability/design finding: PROVEN
Placeholders are active on the existing daemon: the live websocket `tool` and `message` frames contain image_ref, not inline image data. First live read issued:

GET /api/workspaces/ws-1f6f49e5/chats/chat-3e26df42/media?toolCallId=toolu_01JrujnN8yaPJcMjpUt3AwGn&contentIndex=1 -> 200

Final fresh-context disclosure check issued exactly one:

GET /api/workspaces/ws-1f6f49e5/chats/chat-3e26df42/media?toolCallId=toolu_01Bxx2tuPqrXu36hdr2tdDQr&contentIndex=1 -> 200

Full request/response logs and sanitized relevant websocket frames: live-results.json and check4-live-results.json. No daemon restart was necessary: the condition requiring restart (zero live media GETs plus inline data URI) never occurred. Fresh-daemon provenance is NOT independently proven because this run did not restart the shared daemon; functioning placeholder capability and on-demand media delivery ARE proven. Hydrated data: images are explicitly not claimed as lazy-media evidence.

## Visual inspection and limitations
Opened final live, hydrated, text and disclosure screenshots. The test landscape is actually visible (sun, mountains, house, image-display label), not the unavailable fallback. PNG signatures/dimensions validated with file: live-0 1280x800; final checks 1280x1000. Final check4-live.png includes the expanded read card and full image after completion. No source edits occurred between captures. Independent dual-oracle subagent dispatch is unavailable in this child's toolset, so these are browser behavioral verdicts, not a certified complete visual-QA dual-oracle gate. No exact UI reference packet was supplied.

## Cleanup receipt
cleanup.json: server PID 80404 terminated; kill -0 confirms PID gone; lsof confirms no listener on 18088. All browser scripts awaited browser.close() in finally and exited 0. Older unrelated Chrome PID 24896 was left untouched. No manually created temporary files outside /tmp; no repository edits, commits, or pushes. Normal engine-managed session storage was not deleted. All authored scripts, copied image, build output, state, screenshots, logs, and this report are under /tmp/webchat-image-qa-r2/.
