# after mobile scroll measurements

Real ChatTranscript; Bun.WebView 390x844. All distances are CSS pixels. Positive travelled means downward despite an upward request. Error compares measured height with the real content estimator in after mode and constant 80 in baseline mode. M2 sumJump is the sum of absolute residuals above 1px; signed total is also retained. Exact sample traces and all 300 row heights are in JSON.

| Measurement | Values |
|---|---|
| M1 travel | start 56582; target 52582; landed 52522; shortfall -60; 55 samples |
| M2 hop 8000 | start 60492; target 57492; landed 57352; travelled -3140; shortfall -140; jumpFrames 3; maxJump 70; sumJump 138; signedSumJump -138; 47 samples |
| M2 hop 16000 | start 52504; target 49504; landed 49427; travelled -3077; shortfall -77; jumpFrames 3; maxJump 67; sumJump 76; signedSumJump -76; 47 samples |
| M2 hop 24000 | start 44507; target 41507; landed 41411; travelled -3096; shortfall -96; jumpFrames 5; maxJump 77; sumJump 101; signedSumJump -95; 47 samples |
| M3 follow | before append distance 5903, button true; away append distance 6031, button true; bottom append distance 0, button false |
| M4 image | image row 293; anchor 295; before -420; after 1643; shift 2063; scrollTop 68581 → 68498; image width 363 |
| M5 estimator | rows 300; median error 1.5; p90 error 64; max error 131.34375; underestimated 34 |

Synthetic content is English fixture data. Cadence is counted over assistant messages, giving 1-4 paragraphs and images at indices 41,83,125,167,209,251,293. M1-M3 start with image placeholders; M4 swaps them; M5 measures loaded images. M2 forces the iOS library branch in desktop WebKit, not physical iOS gesture hardware.
