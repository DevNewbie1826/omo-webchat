# Theme QA: inspect disclosed status through its native control

## Cause and correction

The theme consumer sampled secondary status metrics in the normal idle frame,
where the compact composer's native Details disclosure is intentionally closed.
The metrics existed but were not exposed; computed styles could not prove paint.

Keep that collapsed idle/send capture and assert its status is unexposed. Arm
the existing state signal before clicking the real summary, then use the existing
one-buffer capture and painted verdict for a separate `status-disclosure` frame.
Close through the same summary with a pre-armed closed-state signal. Assert hidden
status, restored composer geometry and enabled idle send, unchanged draft/model,
and no submitted message. Preserve all ten scenario/theme pairs and 22 roles.
No product or helper contracts changed; no capture inventory test needed updating.

## RED and GREEN

- RED reuses, without modifying or rerunning, the failed final-main capture at
  `.omo/evidence/ulw/ui-polish-20260907/G001-deliver-all-five-cli-webchat-ui-requ/a1/browser/theme`
  in the primary worktree. Its actual revision is `8ad6162`, tree `a26dd67`,
  which includes `5688d36`. All ten failures are status-only: present but
  `exposed=false`. The task branch already matched current main `8ad6162`.
- GREEN: `node --check test/qa/ui-theme-polish.mjs` exited 0;
  `bun test test/qa/ui-theme-evidence.test.mjs` passed 7 tests in one run;
  `cd frontend && npm run build` exited 0 (existing large-chunk warning).
- GREEN: `QA_PLAYWRIGHT=<installed playwright-core/index.mjs> bun
  test/qa/ui-theme-polish.mjs --phase green --out <evidence-root>/green`
  exited 0. All ten pairs and 22 roles passed; 120 PNG hashes were verified,
  including ten additional disclosed-status frames. Native open/close receipts
  prove restoration and zero sends. All 11 owned resources closed successfully.
- LSP initialization failed because its workspace TypeScript installation could
  not be located; it is not reported as clean. Syntax and frontend build passed.

All new evidence is local and uncommitted under
`.omo/evidence/ui-polish-20260907/theme/final-integration` in the task worktree.
