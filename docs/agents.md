# Making an agent session visible in webchat

Webchat watches `rpc.sock` and shows every daemon session whose working directory matches a registered workspace path under the server's `--root` as one row.

1. In webchat, create a workspace whose path is exactly the session's working directory. Workspace paths must be inside the server's `--root`.
2. Connect to the daemon's `rpc.sock` using its NDJSON RPC protocol and send an `open_session` request with `cwd` set to that workspace path. The request object's discriminator key is `type`.
3. The session appears as one row in that workspace, usually within a few seconds and at most about 20 seconds. Expanding or re-expanding the workspace refreshes its live sessions immediately.
4. Click the row in webchat to register it as a chat and attach to the same live route. You can then converse with the agent in the UI; the row shows its running or blocked status as applicable.

| Status | Meaning |
| --- | --- |
| `blocked` | The session has one or more pending questions. |
| `working` | The session is streaming or compacting. |
| `done` | The session completed work. |
| `idle` | The session is neither blocked nor working and has no completed-work status to show. |

Webchat is intended for loopback use only. Do not expose it directly to an untrusted network.
