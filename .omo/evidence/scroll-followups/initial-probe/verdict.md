# Chat switching: FAIL

| Step | Rows rendered | Content height (px) | Non-finite sizes seen | Result |
| --- | ---: | ---: | ---: | --- |
| Long chat initially at bottom | 13 | 69078 | 0 | PASS |
| Long chat in never-visited history | 13 | 69003 | 0 | PASS |
| Switched to short chat | 4 | 562 | 0 | PASS |
| Switched back to long chat | 13 | 69003 | 0 | PASS |

Real Google Chrome at 390x844; production ChatTranscript built with Vite. A 300-row chat was scrolled directly into unmeasured history, replaced in-place with 4 rows, then restored to 300 rows. Screenshots are taken after the switch commit and browser layout frames, without fixed sleeps.

Build-only instrumentation observes every estimate output and resizeItem measurement input; cached geometry is checked at each DOM mutation/frame. 39 transition observations; 2 blank/invalid observations. This demonstrates the fixture in Chrome, not a universal guarantee across browsers or backend chat loading.

Source SHA-256: `65d20167d5fb8044a7e4465f028fcb78f890ca369ee5f3a88dad9dfecc93de41`. No application source was edited. Fixture switches use distinct message IDs and increment restoreVersion on the same mounted component, matching ChatPane's transcript prop surface.

Cleanup: {"serverPid":55310,"serverClosed":true,"chromePid":55325,"chromeExited":true,"browserContextClosed":true,"webSocketClosed":true,"temporaryRemoved":true,"portsFree":true,"debugPort":57124,"chromeExit":{"code":0,"signal":null},"servePort":5237,"sourceUnchangedDuringRun":true}
