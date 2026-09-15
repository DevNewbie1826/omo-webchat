# Chat switching: FAIL

| Step | Rows rendered | Content height (px) | Non-finite sizes seen | Result |
| --- | ---: | ---: | ---: | --- |
| Long chat initially at bottom | 13 | 69078 | 0 | PASS |
| Long chat in never-visited history | 20 | 69003 | 0 | PASS |
| Switched to short chat | 4 | 562 | 0 | PASS |
| Switched back to long chat | 13 | 69003 | 0 | PASS |

Real Google Chrome at 390x844; production ChatTranscript built with Vite. A 300-row chat was scrolled directly into unmeasured history, replaced in-place with 4 rows, then restored to 300 rows. Screenshots are taken after the switch commit and browser layout frames, without fixed sleeps.

Build-only instrumentation observes every estimate output and resizeItem measurement input; cached geometry is checked at each DOM mutation/frame. 22 transition observations; all had mounted rows and finite sizes. The stronger visibility check failed once: `switch-long:mutation` had 14 mounted rows, content height 69003 px, zero non-finite sizes, but zero rows intersecting the viewport. Every frame sample and all four checkpoint snapshots had visible rows. A DOM mutation is not proof of a blank painted frame; nevertheless this evidence does not establish the stronger claim that the transcript never blanks, so the overall verdict remains FAIL. The table above reports the requested mounted-row/finite-size checks, which all passed. This demonstrates the fixture in Chrome, not a universal guarantee across browsers or backend chat loading.

Source SHA-256: `65d20167d5fb8044a7e4465f028fcb78f890ca369ee5f3a88dad9dfecc93de41`. No application source was edited. Fixture switches use distinct message IDs and increment restoreVersion on the same mounted component, matching ChatPane's transcript prop surface.

Verification: Vite production harness build completed; real Chrome browser execution completed. LSP diagnostics were unavailable because the evidence directory is outside the frontend TypeScript workspace (the language server could not locate TypeScript). The runner passed `node --check`. No source tests were changed or run. The earlier invalid scrollTop-driven setup is preserved under `initial-probe/`; the final run used actual wheel input with event-based scrollend completion.

Cleanup: {"serverPid":56415,"serverClosed":true,"chromePid":56430,"chromeExited":true,"browserContextClosed":true,"webSocketClosed":true,"temporaryRemoved":true,"portsFree":true,"debugPort":57399,"chromeExit":{"code":0,"signal":null},"servePort":5237,"sourceUnchangedDuringRun":true}
