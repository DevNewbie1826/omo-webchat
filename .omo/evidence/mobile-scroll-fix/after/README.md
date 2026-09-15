# after mobile scroll measurements

Real ChatTranscript; Bun.WebView 390x844. All distances are CSS pixels. Positive travelled means downward despite an upward request. Error compares measured height with the real content estimator in after mode and constant 80 in baseline mode. M2 sumJump is the sum of absolute residuals above 1px; signed total is also retained. Exact sample traces and all 300 row heights are in JSON.

| Measurement | Values |
|---|---|
| M1 travel | start 53293; target 49293; landed 49293; shortfall 0; 55 samples |
| M2 hop 8000 | start 57323; target 54323; landed 54328; travelled -2995; shortfall 5; jumpFrames 3; maxJump 18; sumJump 31; signedSumJump 5; 47 samples |
| M2 hop 16000 | start 49308; target 46308; landed 46399; travelled -2909; shortfall 91; jumpFrames 5; maxJump 32; sumJump 123; signedSumJump 91; 47 samples |
| M2 hop 24000 | start 41323; target 38323; landed 38351; travelled -2972; shortfall 28; jumpFrames 4; maxJump 45; sumJump 118; signedSumJump 28; 47 samples |
| M3 follow | before append distance 6065, button true; away append distance 6193, button true; bottom append distance 0, button false |
| M4 image | image row 293; anchor 295; before -420; after 1643; shift 2063; scrollTop 65293 → 65306; image width 363 |
| M5 estimator | rows 300; median error 23; p90 error 64; max error 131.34375; underestimated 184 |

Synthetic content is English fixture data. Cadence is counted over assistant messages, giving 1-4 paragraphs and images at indices 41,83,125,167,209,251,293. M1-M3 start with image placeholders; M4 swaps them; M5 measures loaded images. M2 forces the iOS library branch in desktop WebKit, not physical iOS gesture hardware.
