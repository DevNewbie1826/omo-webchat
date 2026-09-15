# after mobile scroll measurements

Real ChatTranscript; Bun.WebView 390x844. All distances are CSS pixels. Positive travelled means downward despite an upward request. Error compares measured height with the real content estimator in after mode and constant 80 in baseline mode. M2 sumJump is the sum of absolute residuals above 1px; signed total is also retained. Exact sample traces and all 300 row heights are in JSON.

| Measurement | Values |
|---|---|
| M1 travel | start 56135; target 52135; landed 52002; shortfall -133; 56 samples |
| M2 hop 8000 | start 60128; target 57128; landed 57016; travelled -3112; shortfall -112; jumpFrames 4; maxJump 56; sumJump 112; signedSumJump -112; 47 samples |
| M2 hop 16000 | start 52140; target 49140; landed 49071; travelled -3069; shortfall -69; jumpFrames 4; maxJump 48; sumJump 68; signedSumJump -68; 47 samples |
| M2 hop 24000 | start 44136; target 41136; landed 41062; travelled -3074; shortfall -74; jumpFrames 3; maxJump 62; sumJump 72; signedSumJump -72; 47 samples |
| M3 follow | before append distance 5924, button true; away append distance 6052, button true; bottom append distance 0, button false |
| M4 image | image row 293; anchor 295; before -420; after -420; shift 0; scrollTop 68203 → 68430; image width 363 |
| M5 estimator | rows 300; median error 1.5; p90 error 54; max error 117.34375; underestimated 34 |

Synthetic content is English fixture data. Cadence is counted over assistant messages, giving 1-4 paragraphs and images at indices 41,83,125,167,209,251,293. M1-M3 start with image placeholders; M4 swaps them; M5 measures loaded images. M2 forces the iOS library branch in desktop WebKit, not physical iOS gesture hardware.
