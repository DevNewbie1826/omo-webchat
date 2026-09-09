# Releasing omo-webchat

This document describes the implemented release pipeline: how the seven npm
packages and the GitHub release are built, verified, and published from one
immutable artifact set. It is written for the maintainer who runs a release.

Status: the pipeline is implemented and locally verified. Publication is a
separate, lead-only step gated by the bootstrap procedure below, so whether a
given version is publicly available changes over time. Check the npm package
pages and GitHub Releases for the current state of any version.

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
`THIRD_PARTY_NOTICES.md`, and `checksums.txt`. The original omo-webchat code
and documentation are MIT licensed; see `LICENSE`. Bundled third-party
software, fonts, and artwork retain their own copyrights, license conditions,
patent terms, and disclaimers; see `THIRD_PARTY_NOTICES.md`. The app icon
artwork is not covered by the MIT license, and nothing in these notices grants
permission to redistribute or relicense it; rights must be obtained separately
from its copyright holder.

## Pinned toolchain

The workflows pin Node 24.15.0, npm 11.12.1, Bun 1.4.2, and Go 1.26. These
pins are for building, testing, and publishing. They do not change what
consumers need (Node 18+ or Bun).

## Pipeline shape

Three workflows implement the path:

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
     driver exercises real `npx` and `bunx` installs plus the wrapper under
     Bun's runtime, starts the packaged server, checks HTTP `/` and every
     embedded asset, verifies authentication (401 before login, 200 after),
     and proves cleanup. On darwin/linux the third consumer is the literal
     `bunx --bun`; on Windows with Bun 1.4.2 that literal command completes
     auto-install and exits 0 without executing the bin (preserved hosted
     receipts), so Windows instead installs the exact version with Bun and
     executes the installed wrapper under Bun directly — a scoped check that
     does not validate the literal `bunx --bun` command there. Windows
     interruption is verified through ConPTY terminal close with unforced
     completion and an empty process domain, which proves owned-resource
     teardown rather than application-level graceful shutdown.
  4. `gate`: succeeds only when the build and all six native jobs succeeded,
     and exposes the immutable `artifact-id` and `source-commit` as outputs.

- `.github/workflows/native-check.yaml` is the shared six-target native
  matrix. `package-ci.yaml` calls it in default local mode, where the smoke
  driver serves the exact packed tarballs through its localhost registry
  fixture. It is also callable with `public-registry: true` and dispatchable
  manually for read-only public verification (see below). It never publishes.

- `.github/workflows/release.yaml` runs on `v*` tags and orders publication
  after validation:

  `validate -> publish (npm) -> public-native -> github-release`

  1. `validate` is `package-ci.yaml`: contracts, one build/pack, six local
     native consumers, and the gate.
  2. `publish` runs only when validation succeeded, the ref is a `v*` tag,
     and the repository variable `RELEASE_PUBLISH_ENABLED` is exactly
     `'true'`. It downloads the validated artifact by ID (never rebuilds),
     re-verifies every byte with
     `node npm/release.mjs verify --manifest release-artifacts/manifest.json`,
     and publishes to npm with provenance.
  3. `public-native` calls `native-check.yaml` with `public-registry: true`
     against the same artifact ID, running the six native consumers again
     with real `npx`, `bunx`, and wrapper-under-Bun installs of the exact
     published versions from `https://registry.npmjs.org` (the Windows
     `bunx --bun` substitution described above applies there too).
  4. `github-release` downloads the same original artifact and uploads the
     GitHub release assets from the same manifest, only after all six public
     consumers succeeded.

  Publication logs and the manifest are uploaded as receipts on every
  outcome.

Only the `publish` job holds `id-token: write`, inside the `npm-release`
GitHub environment, and its contents permission is read. Only the
`github-release` job holds `contents: write`, and it has no OIDC permission.
The native jobs and their callers hold `contents: read` and `actions: read`
for exact-artifact retrieval. Everything else runs with `contents: read`.
There is no long-lived npm token; npm authentication uses OIDC trusted
publishing.

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
  A version that already exists is not accepted on advertised integrity
  alone: the tool anonymously fetches its actual `dist.tarball` bytes and
  requires both the local-manifest SHA-256 and SHA-512 to match before
  resuming it without a write. The same awaited byte check confirms each
  newly accepted publication before the next package proceeds. Any
  integrity, identity, payload, or tag mismatch fails. It never mutates
  dist-tags and never claims a tag moved. Prerelease versions require
  `--tag next`, stable versions `--tag latest`; the tool rejects a
  mismatch.

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

## Public verification of release candidates

`native-check.yaml` also has a manual `workflow_dispatch` route for
read-only verification of an already built artifact set against the public
registry. All four inputs are required strings with no defaults:

| Input | Value |
|---|---|
| `artifact-id` | The original `release-packages-<run>-<attempt>` Actions artifact ID (a positive decimal number, not a name) |
| `run-id` | The original `release.yaml` tag-push workflow run ID |
| `source-commit` | The original full 40-character lowercase commit SHA |
| `source-ref` | The original complete version-tag ref, for example `refs/tags/v0.1.0-rc.1` |

Dispatch at the original tag, not at a moving branch. The tag must contain
this workflow, and the workflow must also exist on the default branch for
GitHub to accept the dispatch. The route verifies the caller's SHA and ref
against the inputs, confirms the artifact belongs to the original run, is
unexpired, and comes from a build attempt whose `validate / gate` job
succeeded, then runs the six native consumers against
`https://registry.npmjs.org`. It has no publication switch, registry
override, build step, npm OIDC permission, or contents-write permission, and
`RELEASE_PUBLISH_ENABLED` does not affect it. It never publishes and never
rebuilds; it checks that exact public versions install and run on all six
platforms.

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
   then, tag runs validate but never publish: the npm, public-native, and
   GitHub publication jobs stay skipped while contracts, build/pack, and the
   six local native consumers still run and produce a validated artifact.

While publication is disabled, or after RC packages exist, the manual
`native-check.yaml` dispatch above can verify those original artifacts
against the public registry on all six hosts without publishing anything.

After bootstrap, a normal release is: tag `vX.Y.Z` on the release commit,
push, and watch release.yaml. Validation runs first, then npm publication,
then the six public native consumers, then the GitHub release. A prerelease
tag (`vX.Y.Z-rc.N`) publishes under `next`; a stable tag publishes under
`latest`.

## Resume without rebuild

npm versions are immutable, so the pipeline never rebuilds to retry
publication. On a failed publish job, use GitHub's "re-run failed jobs" on
the same workflow run, not "re-run all jobs". The publish job downloads
`needs.validate.outputs.artifact-id`, which is the original successful
build's artifact, and `publish` resumes a version already accepted by the
registry only after fetching its remote tarball and confirming both SHA-256
and SHA-512 match the manifest. Artifacts are retained for 30 days; an
expired artifact is a hard failure, not permission to rebuild an immutable
version. The same manifest drives the GitHub asset upload, which resumes
accepted assets without replacing them.

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
