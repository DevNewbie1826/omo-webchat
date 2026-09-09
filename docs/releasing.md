# Releasing omo-webchat

This document describes the implemented release pipeline: how the seven npm
packages and the GitHub release are built, verified, and published from one
immutable artifact set. It is written for the maintainer who runs a release.

Status: the pipeline is implemented and locally verified. No public npm or
GitHub release has been published yet; the first publication follows the
bootstrap procedure below.

## What gets published

Seven npm packages, always at the same version:

| Package | Contents |
|---|---|
| `omo-webchat` | Wrapper CLI (`bin: omo-webchat` -> `cli.js`), resolves the platform package |
| `omo-webchat-darwin-arm64` | Prebuilt server binary, `os: darwin`, `cpu: arm64` |
| `omo-webchat-darwin-x64` | `os: darwin`, `cpu: x64` |
| `omo-webchat-linux-x64` | `os: linux`, `cpu: x64` |
| `omo-webchat-linux-arm64` | `os: linux`, `cpu: arm64` |
| `omo-webchat-win32-x64` | `os: win32`, `cpu: x64` |
| `omo-webchat-win32-arm64` | `os: win32`, `cpu: arm64` |

The wrapper lists the six platform packages in `optionalDependencies` pinned
to its own version, so npm installs exactly the one matching the consumer's
platform. Consumers need Node 18 or newer (the wrapper's `engines` range),
or Bun when using `bunx` / `bunx --bun`. The official `omo` CLI is a runtime
prerequisite for chats; it stays external and is resolved through
`CHAT_PI_BINARY`, then `PATH` (see `npm/cli/README.md`).

The GitHub release carries the six GoReleaser archives
(`omo-webchat_<os>_<arch>.tar.gz`, `.zip` for Windows), `LICENSE`,
`THIRD_PARTY_NOTICES.md`, and `checksums.txt`. All packages and archives are
MIT licensed; see `LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Pinned toolchain

The workflows pin Node 24.15.0, npm 11.12.1, Bun 1.4.2, and Go 1.26. These
pins are for building, testing, and publishing. They do not change what
consumers need (Node 18+ or Bun).

## Pipeline shape

Two workflows implement the path:

- `.github/workflows/package-ci.yaml` runs on every pull request and as the
  reusable validation workflow for releases. It never publishes.
  1. `contracts`: package, publish-protocol, GitHub-release, registry-fixture,
     and workflow-contract test suites.
  2. `build`: one non-publishing GoReleaser build, then
     `node npm/release.mjs pack --out release-artifacts`. The exact
     `frontend/dist` of that build is stored in the same Actions artifact so
     native jobs compile the test fixture against identical bytes.
  3. `native`: six jobs, one per target, on their real hosted runners:

     | Target | Runner |
     |---|---|
     | darwin x64 | macos-15-intel |
     | darwin arm64 | macos-15 |
     | linux x64 | ubuntu-24.04 |
     | linux arm64 | ubuntu-24.04-arm |
     | win32 x64 | windows-2025 |
     | win32 arm64 | windows-11-arm |

     Each job asserts the actual Node/Bun OS and architecture, then runs
     `bun test/npm_native_smoke.mjs --manifest release-artifacts/manifest.json
     --fixture <native-fixture>` against the exact packed tarballs. The smoke
     driver exercises real `npx`, `bunx`, and `bunx --bun` installs, starts
     the packaged server, checks HTTP `/` and every embedded asset, verifies
     authentication (401 before login, 200 after), and proves cleanup.
  4. `gate`: succeeds only when the build and all six native jobs succeeded,
     and exposes the immutable `artifact-id` and `source-commit` as outputs.

- `.github/workflows/release.yaml` runs on `v*` tags. Its `validate` job is
  `package-ci.yaml`. The `publish` job runs only when validation succeeded,
  the ref is a `v*` tag, and the repository variable
  `RELEASE_PUBLISH_ENABLED` is exactly `'true'`. It downloads the validated
  artifact by ID (never rebuilds), re-verifies every byte with
  `node npm/release.mjs verify --manifest release-artifacts/manifest.json`,
  publishes to npm with provenance, then uploads the GitHub release assets
  from the same manifest. Publication logs and the manifest are uploaded as
  receipts on every outcome.

Only the `publish` job holds `contents: write` and `id-token: write`, inside
the `npm-release` GitHub environment. Everything else runs with
`contents: read`. There is no long-lived npm token; npm authentication uses
OIDC trusted publishing.

## Release tool interfaces

`npm/release.mjs` is the single pack/verify/publish entry point:

```sh
node npm/release.mjs pack --out <new-directory>
node npm/release.mjs verify --manifest <file>
node npm/release.mjs publish --manifest <file> --tag next|latest [--registry <url>] [--provenance]
```

- `pack` requires a directory that does not exist yet. It consumes
  `dist/metadata.json` and the six GoReleaser archives, runs the strict
  generator, packs all seven packages with real `npm pack`, and writes
  `<out>/manifest.json` plus the tarballs and `archives/`. It binds the
  version and the exact source commit (`metadata.commit`, checked against
  local `git rev-parse HEAD` and, in CI, against `GITHUB_SHA` and the tag).
- The manifest records `version`, `sourceCommit`, seven `packages` entries
  (`name`, `version`, relative `file`, `sha256`, npm-compatible SHA-512
  `integrity`, and `platform: {os, cpu}` for the six binary packages), and
  `archives` binding every release archive and notice file by path and hash.
- `verify` is read-only local validation of every record, payload member,
  and byte.
- `publish` validates all local bytes and inspects every remote version
  before the first write. Platform packages publish first, the wrapper last.
  A version that already exists with matching integrity and the requested
  tag is resumed without a write; any integrity, identity, payload, or tag
  mismatch fails. It never mutates dist-tags and never claims a tag moved.
  Prerelease versions require `--tag next`, stable versions `--tag latest`;
  the tool rejects a mismatch.

`npm/github-release.mjs --manifest <file>` re-verifies the same manifest and
uploads the exact archives, notices, and checksums. It creates a draft,
checks existing asset bytes before writing, resumes accepted uploads, and
makes the release public only after every byte is confirmed.

## Tag semantics

- Tags are `v<version>`, matching the manifest version exactly
  (`refs/tags/v0.1.0` for version `0.1.0`). The pack step fails on a
  tag/version mismatch when running in CI.
- Stable versions publish to npm with `--tag latest`.
- Prereleases (any version with a `-` suffix, for example `0.1.0-rc.1`)
  publish with `--tag next`.
- Pushing a tag while `RELEASE_PUBLISH_ENABLED` is unset or not `'true'`
  still runs the full build and six-native validation. Publication is
  skipped. This lets tags prepare and verify artifacts before the first
  package exists on npm.

## First-time bootstrap (lead only)

Performed once, by the maintainer, before the first public release:

1. Create the seven npm packages with a real release candidate, for example
   version `0.1.0-rc.1` tagged `v0.1.0-rc.1`, published under `next`. The
   first publication of each package must establish package ownership under
   the project's npm account.
2. In npm, configure a Trusted Publisher for each of the seven packages,
   pointing at this repository's `.github/workflows/release.yaml` workflow
   and the `npm-release` environment. The publishing caller is release.yaml;
   no other workflow may hold trusted-publisher status.
3. Confirm the `npm-release` GitHub environment exists; the publish job
   references it for OIDC.
4. Set the repository variable `RELEASE_PUBLISH_ENABLED` to `'true'`. Until
   then, tag runs validate but never publish.

After bootstrap, a normal release is: tag `vX.Y.Z` on the release commit,
push, and watch release.yaml. A prerelease tag (`vX.Y.Z-rc.N`) publishes
under `next`; a stable tag publishes under `latest`.

## Resume without rebuild

npm versions are immutable, so the pipeline never rebuilds to retry
publication. On a failed publish job, use GitHub's "re-run failed jobs" on
the same workflow run. The publish job downloads
`needs.validate.outputs.artifact-id`, which is the original successful
build's artifact, and `publish` skips versions already accepted by the
registry with matching bytes. Artifacts are retained for 30 days; an expired
artifact is not permission to rebuild an immutable version. The same
manifest drives the GitHub asset upload, which resumes accepted assets
without replacing them.

## Local verification

The publish path is tested against an isolated localhost registry fixture
(`test/npm_registry_fixture.mjs`) with real npm protocol behavior. No test
writes to the public registry. To exercise packed artifacts on a host:

```sh
node npm/release.mjs pack --out <out>          # after a GoReleaser build
node npm/release.mjs verify --manifest <out>/manifest.json
go build -trimpath -o native-fixture ./test/nativefixture
bun test/npm_native_smoke.mjs --manifest <out>/manifest.json --fixture "$PWD/native-fixture"
```

The smoke driver serves the exact tarballs through its local registry by
default. With `--registry <url>` it reads the given registry instead, in
read-only fashion, and never publishes.
