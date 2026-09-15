# Real Chrome inline-image QA: NEEDS WORK

All paths below are relative to /tmp/webchat-inline-qa/. Tested real Google Chrome 152 headless against the real omo provider, with a fresh context per check. No mock engine, substituted transcript, repository edit, or commit was used.

| Check | Verdict | Evidence |
|---|---|---|
| 1. Collapsed visibility | PASS | collapsed.png; collapsed-network.json; results.json. Completed real image-read turn, untouched card aria-expanded=false, image naturalWidth=900 and naturalHeight=560. Tool toolu_01X7EjHLgMKBgmvbAyCgTF72, contentIndex=1: exactly one HTTP 200 media fetch. |
| 2. Viewport laziness | FAIL (evidence incomplete, not a demonstrated product defect) | viewport-before.png; viewport-lazy-network.json; viewport-attempt.log. Restored history rendered inline image bytes, not lazy media references. Live attempts auto-followed the new result into view before the zero-request checkpoint. No valid never-visible-row -> one-fetch proof was obtained. |
| 3. No refetch | FAIL (evidence identity mismatch) | expanded.png; no-refetch.png; no-refetch-network.json; results.json. One request remained after interactions, but audit found that request was for toolu_019N4ek16A4c3SV3bt2b1f23/contentIndex=1 while the toggled/scrolled last DOM card was toolu_01NfjDs7gApXDxaNfRGAAdUW. This does NOT prove the required same-pair invariant. The script's preliminary PASS in checks.log is superseded by this report and corrected results.json. |
| 4. Plain text | PASS (content and traffic) | text-only.png; text-only-network.json ([]). Exact assistant text TEXT_ONLY_QA_7419 rendered, no tool-image wrappers, zero media requests. No pre-change screenshot was provided or captured, so pixel-identical baseline rendering is not verified. |

## RED then GREEN observations

RED-harness.log: initial browser selector failed because it selected a hidden sidebar chat label: `locator.click: Timeout 30000ms exceeded`, `element is not visible`. This was a harness error, not a product regression. The selector was corrected in the /tmp script only.

GREEN-observations.log: collapsed visibility passed with a decoded 900x560 image under a closed card; exact plain text passed with zero media traffic. Overall GREEN was NOT achieved. No pre-change product RED build was run, and none is claimed.

Additional failed harness attempts are documented in viewport-attempt.log. Runtime streaming/history reconciliation and automatic scrolling prevented the attempted viewport proof. The no-refetch identity mismatch was caught during final evidence audit rather than being silently approved.

## Setup and scope

The requested `bun install` and `make build` succeeded in source/, an rsync copy of the current dedicated worktree, to honor the more restrictive write-only-under-/tmp requirement. See install.log and build.log. Build emitted the existing Vite large-chunk warning. The server bound 127.0.0.1:60316 with development authentication and temporary root/state directories under this evidence directory. The real provider was available and answered.

Existing uncommitted inline-image changes were present before QA. No source fix was attempted. PNG signatures and dimensions were checked; collapsed/text captures are 1440x1000 and no-refetch is 1440x500. Screenshots were opened directly for inspection. Independent dual-oracle review was unavailable because this child has no delegation tool; no visual completion gate is claimed.

## Cleanup receipt

Server PID 7932 received SIGTERM and `os.kill(pid, 0)` confirmed ProcessLookupError. Every browser launched by the scripts was closed in finally; no task-owned browser remained. The only remaining Playwright Chrome tree (PID 24896) started September 13, two days before this task, and was deliberately preserved. No workspace roots outside /tmp were created. See cleanup-receipt.json and browser-cleanup.json.

## Remaining gaps

Checks 2 and 3 need valid real-browser evidence tied to the same toolCallId/contentIndex throughout the observation. This report does not certify viewport laziness or no-refetch, and does not classify the failed evidence as a confirmed product defect.
