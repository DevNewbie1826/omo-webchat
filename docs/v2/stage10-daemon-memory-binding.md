# Stage 10 - daemon-spawn session memory binding

## Resolution

Fresh live protocol probing on 2026-09-03, after the omo update to `5.0.0-0.beta.36`
(engine `2026.9.3-2`), shows that the original daemon-session gap is healed upstream.
No new initialization field is available or needed in `open_session`: the current runtime
runs the memory session-start initialization for a daemon-opened session and binds the
same project identity as a CLI-started session.

This repository's strongest server-side mitigation is therefore the Stage 9 launch
contract, now covered by memory-specific regressions:

- `internal/api.Run` passes the complete parent environment, including an explicit
  `OMO_MEMORY_HOME`, and uses the configured project root as the daemon working directory.
- `EnsureDaemon` preserves `OMO_MEMORY_HOME` through both the automatic and explicit-node
  runtime attempts.
- The packaged omo extension remains explicit in every child invocation, so memory is
  loaded independently of extension discovery.

Adding a guessed identity override or an undocumented `open_session` field would be less
safe: identity is session state, and a resume must honor the binding already persisted in
that session rather than silently rebinding it.

## Fresh reproduction evidence (live protocol probing)

The probe used a new temporary `XDG_STATE_HOME`, a separate temporary
`OMO_MEMORY_HOME`, and a real git project beneath the same temporary root. The built
webchat server spawned the daemon through the runtime ladder. A browser-equivalent flow
then performed `POST /api/login`, the v2 WebSocket hello, `chat.create`, and `chat.send`.

The prompt required a memory tool call to create `reference/web-memory-test.md` and read
it back. The observed sequence was:

1. `ready` returned durable session `01a066cd-a777-79d7-a8e2-3b63ac7601f7`.
2. Before the first user message, its session file recorded
   `senpi-memory.session-binding` with identity `project-53a45ec4` and repo-path hash
   `3f7e72d87bb92b46ed3f3acf6b29e85ad72fe7b36c4e86db70183ed934719923`.
3. The `memory` tool completed without error and committed `f5cebe6` as
   `project-53a45ec4 <project-53a45ec4@omo.local>`.
4. Reading the committed blob returned the exact `web-memory-test` observation from
   `<temp-memory>/agents/project-53a45ec4/repo/reference/web-memory-test.md`.
5. Runtime transcript and queue state appeared under
   `<temp-memory>/agents/project-53a45ec4/runtime`, proving initialization progressed
   beyond tool registration.

A CLI-started session in that exact project, with the exact same `OMO_MEMORY_HOME`,
recorded identity `project-53a45ec4` and the same repo-path hash. Live process probing also
showed the spawned rpc host retained `OMO_MEMORY_HOME`, `XDG_STATE_HOME`, `HOME`, and a
project `PWD`. There was no differing memory-home or agent-identity environment variable
between the two session paths.

## Root cause and upstream boundary

Live protocol probing isolates the old failure to the upstream per-session lifecycle: the
extension was loaded and exposed its tools, but daemon-created sessions did not acquire a
memory context during their one-time session-start initialization. That explains the old
exact error, `no memory identity bound to this session; enable omo memory and restart the
session so the memory tools can initialize`. It was not caused by a different store or
agent-id environment in this server. The current runtime now emits the session-start
binding for both daemon-opened and CLI-started sessions before their first prompt.

The binding is intentionally durable session data. Current live probing shows project
identity is derived consistently from the session cwd/config and that
`OMO_MEMORY_HOME` selects the common store root. The server controls those inputs; the
upstream extension owns creation and validation of `senpi-memory.session-binding`.

One adjacent lifecycle boundary remains: if the owned rpc host process is killed, the
current launcher chain exits and the already-running webchat process does not call
`EnsureDaemon` again. A subsequent server start does ensure a new daemon. This is a
general daemon availability limitation, not a memory rebinding failure, and broadening
Stage 10 into daemon supervision would be an unrelated lifecycle change.

## Respawn validation (live protocol probing)

After killing the ladder-spawned rpc host, a fresh server start invoked `EnsureDaemon`
and spawned a new ladder-owned daemon. A second browser-equivalent session then created
and read back `reference/web-memory-after-respawn.md`. The tool committed `c24ada4` to
the existing `project-53a45ec4` repo with the same omo-local author identity. Thus memory
identity and store selection survive a real daemon replacement; only automatic recovery
inside an already-running webchat remains outside this phase's binding scope.

## Regression coverage

- `internal/api/run_test.go` pins forwarding of `OMO_MEMORY_HOME` and the project working
  directory at the server-to-ensure boundary.
- `internal/omorpc/ensure_test.go` launches deterministic fake automatic and node attempts
  and asserts that both receive the identical `OMO_MEMORY_HOME`.
- Existing Stage 9 coverage continues to pin explicit extension forwarding and runtime
  fallback behavior.
