# omo-webchat (npm wrapper)

`npx`-able wrapper that launches the prebuilt **omo-webchat** server binary for
your platform. You run one command; this package picks the right binary,
forwards all flags verbatim, and passes the exit code / signals through.

## Usage

```sh
npx omo-webchat@latest --password <secret> --port <port> --root <root>
```

Supported server flags: `--host`, `--port`, `--password`, `--root`,
`--state-dir`, `--provider`, `--daemon`, `--stop`, `--status`
(environment equivalents: `TH_HOST`, `TH_PORT`, `TH_PASSWORD`, `TH_ROOT`,
`TH_STATE_DIR`). Everything after `omo-webchat` is forwarded to the binary
untouched.

## How it works

- `optionalDependencies` pulls in exactly one matching binary package
  (`omo-webchat-darwin-arm64`, `omo-webchat-darwin-x64`,
  `omo-webchat-linux-x64`, `omo-webchat-linux-arm64`,
  `omo-webchat-win32-x64`) at the **same version**
  as this wrapper. npm skips the ones for other platforms.
- The shim resolves the platform package via `require.resolve`, loads its
  `index.js` entrypoint to obtain the absolute binary path, and execs it with
  `stdio: 'inherit'` and no shell.
- The child's exit code is propagated; `SIGINT`/`SIGTERM` are forwarded.
- If no package matches your `platform`/`arch`, you get an actionable error
  naming both and the shim exits non-zero.

Platform package contract (for maintainers): package named
`omo-webchat-<os>-<arch>`, versioned in lockstep with this wrapper, shipping
the goreleaser artifact (`omo-webchat_<os>_<arch>.tar.gz` -> `omo-webchat`
binary) under `exe/omo-webchat-bin`. Its `index.js` exports that binary's
absolute path. Windows x64 follows the same contract with the goreleaser zip
(`omo-webchat_windows_amd64.zip` -> `omo-webchat.exe`) shipped as
`omo-webchat-win32-x64` / `exe/omo-webchat-bin.exe`; windows/arm64 has no
release yet, so no package exists for it.

## Agent resolution (`CHAT_PI_BINARY`)

The webchat server spawns an omo agent per chat. Before launching, the shim
resolves the agent and injects it into the child environment as
`CHAT_PI_BINARY`, in this precedence:

1. `CHAT_PI_BINARY` if already set in your environment (used as-is);
2. `omo` found on your `PATH`;
3. an optionally bundled `omo-ai` package (its `bin/omo.js`), **only if
   present** — it is never a hard dependency;
4. otherwise a warning is printed with fix instructions; the server still
   launches so `--status`/`--stop`/`--provider` flows remain usable.

To override everything, point the variable at any agent binary:

```sh
CHAT_PI_BINARY=/usr/local/bin/omo npx omo-webchat@latest --password <secret> --port <port> --root <root>
```

## Enabling bundled omo

The `omo-ai` integration ships switched **off**: JSON cannot carry comments,
so it is not listed in `package.json`. To enable it, add **one line** to
`optionalDependencies` in `package.json`:

```json
"omo-ai": "<version-from-the-beta-dist-tag>"
```

(`omo-ai`'s `latest` dist-tag is a `0.0.0` placeholder — pin a real build
from the `beta` dist-tag.) On the next install the shim finds
`omo-ai/bin/omo.js`, exports it as `CHAT_PI_BINARY`, and the server runs
with bundled omo. Remove the line to revert.
