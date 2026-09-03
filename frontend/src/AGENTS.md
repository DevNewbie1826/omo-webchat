# frontend/src — REACT SPA

React 18 + Vite + TypeScript (strict) SPA; built to `dist/` and embedded into the Go binary via `frontend/embed.go`.

## STRUCTURE
```
src/
├── App.tsx / main.tsx / app-config.ts  # bootstrap, live polling, locale, provider retry
├── features/split/       # split-view chat UI (own AGENTS.md)
├── features/workspace/   # workspace wizard + provider discovery (WorkspaceWizard.tsx)
├── features/terminal/    # file browser/editor/upload (FileBrowser.tsx, FileTree, FileEditor)
├── features/auth|system/ # login wrappers; system stats modal (REFRESH_MS timer)
├── lib/                  # transport (api/ws/chatWs) + browser utils (own AGENTS.md)
├── components/           # standalone dialogs, Sidebar, SessionTree, SettingsMenu, icons
├── i18n/                 # index.ts barrel; locales/en.json + ko.json
└── styles/               # one concern per CSS file; shared tokens in tokens.css
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| App wiring / session polling | App.tsx | `App.testHarness.tsx` for tests |
| All UI text | `useT()` from i18n | fallback: selected → English → key |
| Modal / dialog patterns | components/ | `createModalStack`, `useConfirm` |
| Design tokens | styles/tokens.css | contract-tested CSS |

## CONVENTIONS
- Named exports + `import type` only — no default exports; the only barrel is `i18n/index.ts`.
- All user-facing text goes through `useT()`; never bypass the i18n context. Locale keys may legitimately exist only in en.json.
- CSS classes are prefixed `th-`; layout invariants are enforced by tests (`styles/styleContracts.test.ts`, `lib/viewportSafeArea.test.ts`).
- Async effects use cancellation/generation refs; `localStorage` keys are fixed (`th-lang`, activity-shelf width constant).
- Props/data are `readonly`; tests are colocated with dotted behavior names (`ChatPane.tools.test.tsx`).

## ANTI-PATTERNS (THIS PROJECT)
- `npm test` starts Vitest watch mode — non-interactive validation MUST use `npx vitest run` (or `npm test -- --run`).
- No timing-sleep assertions; drive events and assert resulting state.
- Do not read/write `localStorage` outside the established keys, and persist locale only via `persistLang`.

## COMMANDS
```bash
cd frontend
npx vitest run        # tests, one-shot
npm run build         # tsc --noEmit && vite build
npm run dev           # dev server
```
