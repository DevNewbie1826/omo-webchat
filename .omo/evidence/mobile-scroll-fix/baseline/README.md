# baseline mobile scroll measurements

Real ChatTranscript; Bun.WebView 390x844. All distances are CSS pixels. Positive travelled means downward despite an upward request. Error uses absolute height minus 80. M2 sumJump is the sum of absolute residuals above 1px; signed total is also retained. Exact sample traces and all 300 row heights are in JSON.

| Measurement | Values |
|---|---|
| M1 travel | start 21614; target 17614; landed 19319; shortfall 1705; 56 samples |
| M2 hop 8000 | start 23640; target 20640; landed 23060; travelled -580; shortfall 2420; jumpFrames 1; maxJump 300; sumJump 300; signedSumJump 300; 47 samples |
| M2 hop 16000 | start 17464; target 14464; landed 15012; travelled -2452; shortfall 548; jumpFrames 1; maxJump 56; sumJump 56; signedSumJump 56; 47 samples |
| M2 hop 24000 | start 9336; target 6336; landed 7225; travelled -2111; shortfall 889; jumpFrames 1; maxJump 390; sumJump 390; signedSumJump 390; 47 samples |
| M3 follow | before append distance 6000, button true; away append distance 0, button false; bottom append distance 0, button false |
| M4 image | image row 293; anchor 295; before -420; after -420; shift 0; scrollTop 30498 → 30725; image width 363 |
| M5 80px estimator | rows 300; median error 28; p90 error 412; max error 762.65625; underestimated 300 |

Synthetic content is English fixture data. Cadence is counted over assistant messages, giving 1-4 paragraphs and images at indices 41,83,125,167,209,251,293. M1-M3 start with image placeholders; M4 swaps them; M5 measures loaded images. M2 forces the iOS library branch in desktop WebKit, not physical iOS gesture hardware.
