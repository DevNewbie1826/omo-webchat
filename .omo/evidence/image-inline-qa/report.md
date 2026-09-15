# Real Chrome inline-image QA (sanitized)

Chrome 152 against the live provider, fresh context per check. This directory keeps only media-verification fields: media-endpoint URLs and query, request counts, rects, verdicts, and timestamps.

## What each remaining artifact proves

| Artifact | Proves |
|---|---|
| collapsed.png | Crop of the transcript image area only (decoded 900x560 cartoon). UI chrome and notices removed. |
| collapsed-network.json | Exactly one media GET for `toolCallId=toolu_01X7EjHLgMKBgmvbAyCgTF72&contentIndex=1` with HTTP 200. |
| collapsed-frames.json | Observed engine contract for that same pair: `image_ref`, `mimeType=image/png`, `byteLength=8073`. |
| results.json | Collapsed PASS (closed card, 900x560, rect, one 200); text-only PASS (`TEXT_ONLY_QA_7419`, zero media requests); laziness/no-refetch marked SUPERSEDED. |
| text-only-network.json | Empty array: zero media requests on the plain-text turn. |
| GREEN-observations.log | Collapsed PASS and text-only PASS from this run. |
| RED-harness.log | First selector attempt timed out on a hidden sidebar label (harness, not product). |
| cleanup-receipt.json | QA server PID 7932 was gone after SIGTERM. |
| browser-cleanup.json | Browsers launched for this run were closed. |

## Checks

1. Collapsed visibility — PASS. Closed card (`aria-expanded=false`) showed a 900x560 image; exactly one scoped media request for `(ws-2a10f82a, chat-e82447d2, toolu_01X7EjHLgMKBgmvbAyCgTF72, contentIndex=1)`.
2. Viewport laziness — SUPERSEDED. The capture in this directory auto-followed the row into view before a zero-request checkpoint, so it cannot prove offscreen=zero. Replaced by the r2 trace (produced separately): `lazy-trace.json`, `offscreen.png`, `entered.png`, `after-toggle.png`.
3. No refetch — SUPERSEDED. The capture in this directory mixed identities (requested `toolu_019N4ek16A4c3SV3bt2b1f23` vs toggled card `toolu_01NfjDs7gApXDxaNfRGAAdUW`). Replaced by the same r2 trace, which keeps one `(workspace, chat, toolCallId, contentIndex)` through offscreen, viewport entry, disclosure toggles, and remount.
4. Plain text — PASS. Assistant text `TEXT_ONLY_QA_7419`; zero media requests. Pixel-identical pre-change baseline was not captured.

## RED then GREEN (this run)

RED: `RED-harness.log` — `locator.click` timed out because the sidebar label was not visible. Harness-only; selector was corrected outside the product tree.

GREEN: collapsed visibility (one media 200, 900x560 under a closed card) and plain text (exact string, zero media). Viewport laziness and no-refetch are not certified here; they are owned by the r2 files named above.

## Removed (confidentiality / not media-verification)

- `state/state-v2.json` and `state/notices/*` — debug dumps (engine session file paths and identifiers). Not media-verification.
- `collapsed-chat.json`, `text-only-chat.json` — workspace metadata with absolute working-directory paths. Not media-verification.
- Original `collapsed-frames.json`, `text-only-frames.json`, `no-refetch-frames.json`, `viewport-lazy-frames.json` — full turn logs with internal notices and prompt text. Value does not survive sanitisation except the collapsed `image_ref` extract kept above.
- `check1.log`, `checks.log`, `probe.log`, `viewport-attempt.log`, `server.log`, `build.log` — harness/setup dumps, including notices and engine session paths. Not media-verification.
- `text-only.png` — full-page capture contained internal notices and has no transcript image area to crop to. Plain-text proof is `text-only-network.json` plus `results.json`.
- `expanded.png`, `no-refetch.png`, `viewport-before.png`, `initial.png` — full-page captures with notices and/or no media proof; laziness/no-refetch screenshots superseded by r2.
- `no-refetch-network.json`, `viewport-lazy-network.json` — incomplete/mismatched traces superseded by r2.

`collapsed.png` was cropped in place from 1440x1000 to the image rect (522x330) so only the transcript image remains.
