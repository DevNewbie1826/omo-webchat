#!/bin/sh
# Pack the CLI and host platform packages, install them into an isolated
# project, and exercise the actual npx bin surface.
set -eu

repo_dir=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
platform=$(node -p 'process.platform')
arch=$(node -p 'process.arch')
platform_dir="$repo_dir/npm/platform/${platform}-${arch}"

[ -f "$platform_dir/package.json" ] || {
  printf 'SKIP: no package fixture for %s-%s\n' "$platform" "$arch"
  exit 0
}

work=$(mktemp -d "${TMPDIR:-/tmp}/omo-webchat-npx-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$work/packages" "$work/tarballs" "$work/project"

node - "$repo_dir" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const cli = JSON.parse(fs.readFileSync(path.join(root, 'npm/cli/package.json')));
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
for (const platform of platforms) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'npm/platform', platform, 'package.json')));
  assert.equal(manifest.version, cli.version, `${manifest.name} version is not in lockstep`);
  assert.equal(cli.optionalDependencies[manifest.name], cli.version, `${manifest.name} dependency is not exact`);
}
NODE

cp -R "$repo_dir/npm/cli" "$work/packages/cli"
cp -R "$platform_dir" "$work/packages/platform"
rm -rf "$work/packages/platform/exe"

if (cd "$work/packages/platform" && npm pack --silent --pack-destination "$work/tarballs" > "$work/missing-pack.log" 2>&1); then
  printf 'FAIL: platform package packed without its executable\n' >&2
  exit 1
fi
grep -F 'expected executable exe/omo-webchat-bin is missing or not executable' "$work/missing-pack.log" >/dev/null

mkdir -p "$work/packages/platform/exe"
fake_binary="$work/packages/platform/exe/omo-webchat-bin"
printf '%s\n' \
  '#!/bin/sh' \
  "printf '%s\\n' \"\$@\" > \"\$OMO_WRAPPER_ARGV_LOG\"" \
  "exit \"\${OMO_WRAPPER_EXIT:-0}\"" > "$fake_binary"
if (cd "$work/packages/platform" && npm pack --silent --pack-destination "$work/tarballs" > "$work/nonexecutable-pack.log" 2>&1); then
  printf 'FAIL: platform package packed a non-executable binary\n' >&2
  exit 1
fi
grep -F 'expected executable exe/omo-webchat-bin is missing or not executable' "$work/nonexecutable-pack.log" >/dev/null
chmod +x "$fake_binary"

platform_tarball=$(
  cd "$work/packages/platform"
  npm pack --silent --pack-destination "$work/tarballs"
)
tar -tzf "$work/tarballs/$platform_tarball" | grep -Fx 'package/exe/omo-webchat-bin' >/dev/null
cli_tarball=$(
  cd "$work/packages/cli"
  npm pack --silent --pack-destination "$work/tarballs"
)

cd "$work/project"
npm init -y >/dev/null
npm install --silent --ignore-scripts --no-audit --no-fund \
  "$work/tarballs/$platform_tarball" \
  "$work/tarballs/$cli_tarball"

argv_log="$work/argv.log"
root_arg="$work/root with spaces"
mkdir "$root_arg"
OMO_WRAPPER_ARGV_LOG="$argv_log" CHAT_PI_BINARY=/fake/omo \
  npx --no-install omo-webchat --password secret --port 25999 --root "$root_arg"

expected="$work/expected.log"
printf '%s\n' \
  '--password' \
  'secret' \
  '--port' \
  '25999' \
  '--root' \
  "$root_arg" > "$expected"
diff -u "$expected" "$argv_log"

set +e
OMO_WRAPPER_ARGV_LOG="$argv_log" OMO_WRAPPER_EXIT=7 CHAT_PI_BINARY=/fake/omo \
  npx --no-install omo-webchat --status >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 7 ] || {
  printf 'FAIL: wrapper returned %s instead of child exit 7\n' "$status" >&2
  exit 1
}

printf 'PASS: platform versions are locked; prepack rejects missing/non-executable binaries; packed content includes the executable; npx forwards argv and propagates child status.\n'
