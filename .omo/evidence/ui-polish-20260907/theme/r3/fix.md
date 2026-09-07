# R3 compact chooser shadow correction

- Worktree: `/Volumes/storage/workspace/cli-webchat-ui-theme-20260907`
- Branch: `fix/ui-codex-theme-20260907`
- Starting HEAD: `3fa1ae1ade36ae6781de9cc99e60906617e897ca`
- Scope: `.th-model-picker-popover--sheet` `box-shadow` role only, plus its direct style contract.

## RED before CSS edit

Command: `cd frontend && npm run test -- --run src/styles/styleContracts.test.ts`

Result: exit 1; 44 tests, 43 passed and 1 failed. The direct assertion reported the sheet value `var(--th-shadow-overlay)` where the required Raised role was `var(--th-shadow-raised)`.

## GREEN after correction

- `cd frontend && npx vitest run src/styles/styleContracts.test.ts test/qa/ui-theme-evidence.test.mjs`: exit 0; 44 style contract cases passed (the evidence test path was not collected by this frontend Vitest configuration).
- `npm --prefix frontend run build`: exit 0; existing chunk-size warning retained.
- Changed-file LSP diagnostics: no diagnostics for `frontend/src/styles/chat-pane.css` or `frontend/src/styles/styleContracts.test.ts`.
- `git diff --check`: clean.

The compact chooser keeps its existing overlay fill, border, geometry, dialog behavior, close target, focus, and scroll rules. Global overlay and composer shadow declarations were not changed. The existing full `menuShadow` assertions remain unchanged.
