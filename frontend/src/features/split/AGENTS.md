# features/split — SPLIT-VIEW CHAT UI

The main chat surface: pane tree layout, session orchestration, activity feed, composer, transcript. 123 flat files, concern-prefixed, no barrel.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Feature root / pane layout | SplitView.tsx, paneTree*, layout*, useLayout | `leaf`/`splitLeaf`/`removeNode`/`setRatio` ops |
| Session state machine | useChatSession*, chatSessionState.ts | `reconcileHistory`/`reconcileOutcome`, `chatEntries` |
| Activity feed | activity* | parse → state → view pipeline (DAG, todos, agents) |
| Chat composition | ChatPane.tsx | composes ApprovalModal, ActivityShelf, ChatComposer, ModelPicker, ChatTranscript |
| Input | ChatComposer.tsx, CommandPalette, FilePalette, curatedCommands | command + file trigger matching |
| Transcript | ChatTranscript.tsx | @tanstack/react-virtual + react-markdown + remark-gfm |
| UI tests | chatPaneTestHarness, *.support.tsx | the integration entry point for component tests |

## CONVENTIONS
- Parsers before reducers: reducers never receive raw RPC records; parse modules (`activityParse*`, `chat*` parsing) return `null` on malformed input instead of throwing.
- Domain-prefix naming (`activity*`, `chat*`, `use*`); tests colocated with behavior suffixes (`.reconnect.*`, `.history`, `.commands.*`).

## ANTI-PATTERNS (THIS PROJECT)
- Never trust raw RPC/JSON records — go through the parse modules (guards live in ../../lib); never allow prototype-polluting keys.
- History reconciliation guards are load-bearing: identical prompts, uncertain runs, stale baselines, completion identity. Do not "simplify" them; late request A must never roll back request B.
- Curated `/compact` stays authoritative only for the curated entry; never hijack provider-advertised same-named commands.
- No duplicate WebSocket close; reconnect on liveness loss, opt-out only via close-code callback.
- CSS layout invariants in the chat-pane/chat-composer/activity-shelf styles are contract-tested — preserve them.

## COMMANDS
```bash
cd frontend && npx vitest run src/features/split
```
