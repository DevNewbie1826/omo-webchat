# Agent sessions and webchat

This page is for agents (and the people who run them) that talk to the omo rpc daemon directly. It explains what webchat does when you open a session, so you know where your work will show up and how it behaves afterwards.

## The shared daemon socket

Every omo rpc client on a machine shares one daemon. It listens on a Unix socket at:

```
~/.omo/agent/rpc/rpc.sock
```

Webchat connects to that same socket and watches the daemon's session list. You don't need to tell webchat anything. If your session is open on the daemon, webchat can see it.

## What happens when you open a session

Open a session the usual way, with `open_session` and a `cwd`. If that `cwd` sits inside the directory webchat was started with (its `--root`), webchat enrolls the session on its own:

1. **Workspace.** If no webchat workspace covers that directory yet, webchat creates one. Its name is the directory's basename, so a session in `<root>/acme/api` gets a workspace called `api`.
2. **Chat row.** The session appears as an ordinary chat row in that workspace. It's bound in place to the session's own file and durable id. Webchat doesn't copy it or start a second session.
3. **Live status.** While the session is running, its row shows as active. Nobody has to click anything, and tabs that are already open pick up the new workspace and row without a reload.

Discovery runs on a short cycle, so expect the row within about 20 seconds of opening the session. An open browser tab can take a little longer to redraw, but it gets there by itself.

There's no special "external session" row and no click-to-activate step. A session you opened over the socket looks exactly like a chat someone started from webchat.

## Opening the row in webchat

When someone opens your enrolled row while the session is running, webchat attaches to the daemon session that's already there. It doesn't call `open_session` again, so you won't see a second session or a `session_path_in_use` error. Both of you are on the same session and the same history.

If the same durable id comes back later (for example, the session file is reopened), webchat binds it to the existing row instead of adding a duplicate. A new session with a new durable id is a new chat, even in the same directory, so it gets its own row.

## After the session ends

Ending a session doesn't remove its row. It stays in the list as a normal stored chat and can be reopened or deleted like any other.

## Deleting a row

Deleting an enrolled row works the same way as deleting any chat, with one detail worth knowing:

- **Attached chat.** If webchat is attached to the session, deleting the row stops it, which is the usual chat deletion behaviour.
- **Unattached running session.** If webchat only discovered the session and never attached, deleting the row doesn't stop it. Your session keeps running on the daemon. Webchat records a tombstone for that durable id, though, so the session won't be enrolled again on later discovery passes.
- **New sessions.** The tombstone covers one durable id only. Any new session you open under `--root` enrolls normally.

## Sessions outside the root

Sessions whose `cwd` is outside webchat's `--root` are ignored. Webchat won't create a workspace or a chat for them, and they don't appear anywhere in the UI. If you want a session to show up in webchat, open it in a directory under the root.
