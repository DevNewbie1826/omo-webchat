# after mobile scroll measurements

Real ChatTranscript; Bun.WebView 390x844. All distances are CSS pixels. Positive travelled means downward despite an upward request. Error compares measured height with the real content estimator in after mode and constant 80 in baseline mode. M2 sumJump is the sum of absolute residuals above 1px; signed total is also retained. Exact sample traces and all 300 row heights are in JSON.

| Measurement | Values |
|---|---|
| M1 travel | start 63019; target 59019; landed 58423; shortfall -596; 55 samples |
| M2 hop 8000 | start 67010; target 64010; landed 63588; travelled -3422; shortfall -422; jumpFrames 5; maxJump 179; sumJump 422; signedSumJump -422; 47 samples |
| M2 hop 16000 | start 58914; target 55914; landed 55444; travelled -3470; shortfall -470; jumpFrames 5; maxJump 219; sumJump 470; signedSumJump -470; 47 samples |
| M2 hop 24000 | start 50925; target 47925; landed 47459; travelled -3466; shortfall -466; jumpFrames 3; maxJump 293; sumJump 466; signedSumJump -466; 47 samples |
| M3 follow | before append distance 5999, button true; away append distance 6150, button true; bottom append distance 0, button false |
| M4 image | image row 293; anchor 295; before -420; after -420; shift 0; scrollTop 75305 → 77364; image width 363 |
| M5 estimator | rows 300; median error 7.5; p90 error 98; max error 154.34375; underestimated 0 |

Synthetic content is English fixture data. Cadence is counted over assistant messages, giving 1-4 paragraphs and images at indices 41,83,125,167,209,251,293. M1-M3 start with image placeholders; M4 swaps them; M5 measures loaded images. M2 forces the iOS library branch in desktop WebKit, not physical iOS gesture hardware.
