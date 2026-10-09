# Add a detach_session command so clients can leave a session without ending it

## Environment

`@code-yeongyu/senpi` 2026.10.10-3, rpc host mode, several clients per host.

## Problem

A client has two ways to give up a session today:

- **Close the socket.** The host releases every session the connection held, with detach semantics (`releaseOwnedSession`, dist/modes/rpc/session-command-router.js:693-716). That works only per connection, not per session.
- **`close_session`.** `close()` (dist/modes/rpc/session-command-router.js:745-785) releases the caller's attachment without the detach flag. At the last attachment `beginSessionClose` (dist/modes/rpc/session-teardown.js:19-41) moves the entry to `closing`. The retention branch at lines 26-35 only applies to a detach, so a retained session ends too.

So there's no per-session detach. A client that views many sessions has to open one connection per session just to be able to leave one of them safely.

## Incident class

A client that means "I'm done watching this" sends `close_session` and ends a session another client is running, including its in-flight turn. We hit this in a web client that attaches to sessions a TUI or another host user opened: idle eviction, stop and shutdown paths all used `close_session` and would end the owner's session whenever the web client held the last attachment.

## Proposal

1. A new command:

   ```json
   {"id":"7","type":"detach_session","sessionId":"s-123"}
   ```

2. A capability in `get_protocol_info` (for example `"detach_session"`) so clients know the host supports it.

Semantics:

- Requires the caller to hold an attachment, same ownership check as `close_session` (dist/modes/rpc/session-command-router.js:759-761); otherwise `unknown_session`.
- Releases the caller's attachment with detach semantics, the same path as `releaseOwnedSession`. Other attachments are untouched. A retained session at its last attachment stays open with zero attachments, as on disconnect.
- For a **non-retained** session where this is the last attachment, answer error `would_close` and keep the attachment. Detach never ends a session. Ending stays explicit through `close_session`.

## Why a command, not a close_session flag

A flag like `close_session{detach:true}` fails unsafe. Old hosts silently ignore extra fields on `close_session`, so the request would end the session, the exact incident this is meant to stop. An unknown command, on the other hand, is rejected (dist/modes/rpc/connection-handler.js:1374, `Unknown command: ...`), so a new client talking to an old host gets an error and nothing ends.

## Client fallback

When the capability is missing, clients hold each attached session on a dedicated connection and detach by closing that connection. This is what we ship now. It costs one socket per attached session.

## Test idea

Two connections attached to one session: `detach_session` from one leaves the other streaming. Retained session, single attachment: detach leaves it open with zero attachments. Non-retained, single attachment: `would_close`, session still running, caller still attached. Caller not attached: `unknown_session`.
