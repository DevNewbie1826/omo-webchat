# Ghost sessions on the omo rpc host

A ghost is a session entry left in the rpc host registry with no binding behind it. It shows up after an `open_session` fails partway and the host's rollback doesn't fully undo the open (see [upstream draft](upstream/omo-open-rollback-ghost.md)). Facts below come from the installed host bundle (`@code-yeongyu/senpi` 2026.10.10-3) and live protocol probing.

## Symptoms

- `list_sessions` still lists the session, with its route and durable id.
- `prompt`, `set_session_name` and `close_session` on that route answer `unknown_session`.
- `open_session` with the same `durableSessionId` answers `session_id_in_use` (dist/modes/rpc/session-registry.js:67-76).
- `open_session` with `sessionPath` set to the session file works, and it heals the entry. The host creates the missing binding for the existing handle (dist/modes/rpc/session-command-router.js:534).

## What webchat does automatically

When webchat views an enrolled session (one another client opened), it attaches over a dedicated connection with `open_session{cwd, sessionPath}`. If the listed route is a ghost whose durable id (or session file, when the durable id is empty) matches the chat, webchat still treats it as the attach candidate, so that same sessionPath attach heals the binding. Nothing to do by hand in that case.

Closing that dedicated connection is how webchat detaches. Webchat never sends `close_session` for an enrolled session, because at the last attachment it ends the session even when the session is retained.

## Manual cleanup

Use this for a ghost webchat isn't viewing, or one you want gone.

1. Open a **new** connection to the rpc socket (`<agentDir>/rpc/rpc.sock`) and send `open_session` with `sessionPath` set to the session file. The reply carries the handle, the state and `attached: true`. The session now has a binding, and this connection holds an attachment.
2. Pick one:
   - **Leave the session as it was**: close that connection. The host releases the attachment with detach semantics. That keeps the session only if it's retained (`retain_on_disconnect`) or another client still holds an attachment. If this was the last attachment of a non-retained session, disconnecting ends it: the entry moves to `closing` (dist/modes/rpc/session-teardown.js:19-36).
   - **End the session**: send `close_session` for the handle from that **same** connection. Other connections get `unknown_session`, since the host only lets an attached connection close (dist/modes/rpc/session-command-router.js:759-761).

Example over the socket (one JSON object per line; `>` is sent, `<` is received, other event lines omitted):

```text
> {"id":"1","type":"open_session","cwd":"/path/to/project","sessionPath":"/path/to/session.jsonl"}
< {"id":"1","type":"response","command":"open_session","success":true,"data":{"sessionId":"s-123","state":{...},"attached":true}}
> {"id":"2","type":"close_session","sessionId":"s-123"}
< {"id":"2","type":"response","command":"close_session","success":true,"data":{}}
```

Skipping the second request and disconnecting keeps the session alive only when it's retained or another client is still attached. Otherwise the disconnect ends it as well.

One way to drive it by hand:

```sh
nc -U ~/.omo/agent/rpc/rpc.sock
```
