# open_session rollback can leave a ghost session in the registry

## Environment

- `@code-yeongyu/senpi` 2026.10.10-3, rpc host mode over the unix socket.
- Several clients sharing one host (for example a TUI plus a web client).

## Reproduction

1. Client A opens a session (`open_session`, retained or not).
2. Client B sends `open_session` for the same session in a way that fails after the registry open succeeded, for example when building the state or the binding throws.
3. Client B gets an error reply, then call `list_sessions` and act on the listed route.

## Observed

- `list_sessions` still lists the session.
- `prompt`, `set_session_name` and `close_session` on the route answer `unknown_session`.
- `open_session` with the same `durableSessionId` answers `session_id_in_use` (dist/modes/rpc/session-registry.js:67-76).
- Only `open_session{sessionPath}` brings it back, because it recreates the missing binding (dist/modes/rpc/session-command-router.js:534).

## Expected

A failed `open_session` leaves the host as it was before the request. If the request attached to a live session, the session keeps running for its other clients, unchanged.

## Root cause

In `open()` (dist/modes/rpc/session-command-router.js), the catch at lines 596-605 calls `this.registry.close(opened.sessionId)` and swallows any failure:

```js
catch (cause) {
    if (opened) {
        try {
            await this.registry.close(opened.sessionId);
        }
        catch {
            /* The open rollback has already removed the entry. */
        }
    }
    return error(command.id, "open_session", this.code(cause), this.detail(cause));
}
```

Two problems:

1. Bookkeeping done before the failure isn't undone: `setSessionKind`/`setSessionMedia` (lines 519-520), `attachConnectionToSession` (line 524) and the `sessionsByConnection` count (lines 529-533). The connection stays wired to the fanout, and the ownership map counts an attachment the client was told it doesn't have.
2. When `opened.attached` is true the open joined a session someone else owns. Rolling that back with `registry.close` treats it as the opener's session. The right undo is to drop this caller's attachment with detach semantics, as `releaseOwnedSession` does (lines 693-716). A swallowed close failure here hides a registry entry that's now out of sync with `bindings`.

## Proposed fix

- Track each side effect in `open()` and undo it in the catch: detach the connection from the fanout, decrement or delete the `sessionsByConnection` count, forget kind/media only when the session itself is being removed.
- If `opened.attached`, release the caller's attachment (detach path) instead of calling `registry.close`.
- If the session was newly created, close it, and log (don't swallow) a close failure so a half-removed entry is visible.

## Compatibility

No protocol change. Clients see the same error reply. The only difference is that a failed attach no longer damages a session other clients are using.

## Test idea

Make binding creation (or state build) throw for a second `open_session{sessionPath}` on a live session. Assert: the error reply; the first client can still `prompt` and `close_session`; `attachments` is back to its earlier value; the failed connection gets no session events; no `session_id_in_use` on a later durable open after the session closes normally.
