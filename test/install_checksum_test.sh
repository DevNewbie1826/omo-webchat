#!/bin/sh
# Exercise install.sh against local release fixtures with an isolated PATH.
set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo_dir=$(CDPATH='' cd "$script_dir/.." && pwd)
installer="$repo_dir/install.sh"
shell_path=$(command -v sh)
binary=omo-webchat
tag=v9.9.9-test
valid_contents='verified fixture'
tampered_contents='tampered fixture'

work=$(mktemp -d "${TMPDIR:-/tmp}/omo-webchat-install-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail 'the test fixture requires shasum or sha256sum'
  fi
}

make_archive() {
  contents=$1
  archive=$2
  source_dir="$work/archive-${archive##*/}"
  mkdir "$source_dir"
  printf '%s\n' "$contents" > "$source_dir/$binary"
  tar -czf "$archive" -C "$source_dir" "$binary"
}

make_release() {
  release_dir=$1
  asset=$2
  archive=$3
  digest=$4
  mkdir "$release_dir"
  cp "$archive" "$release_dir/$asset"
  printf '%s  %s\n' "$digest" "$asset" > "$release_dir/checksums.txt"
}

make_mock_bin() {
  mock_bin=$1
  mkdir "$mock_bin"

  for tool in awk cat dirname grep install mkdir mktemp rm sed tar tr; do
    tool_path=$(command -v "$tool") || fail "required test tool is unavailable: $tool"
    ln -s "$tool_path" "$mock_bin/$tool"
  done

  cat > "$mock_bin/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in
  -s) printf '%s\n' "${MOCK_OS:?}" ;;
  -m) printf '%s\n' x86_64 ;;
  *) exit 2 ;;
esac
EOF

  cat > "$mock_bin/curl" <<'EOF'
#!/bin/sh
set -eu

output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    *) url=$1; shift ;;
  esac
done

case "$url" in
  https://api.github.com/repos/DevNewbie1826/omo-webchat/releases/latest)
    [ -z "$output" ] || exit 2
    printf '{"tag_name":"%s"}\n' "${MOCK_RELEASE_TAG:?}"
    ;;
  "https://github.com/DevNewbie1826/omo-webchat/releases/download/${MOCK_EXPECT_TAG:?}/"*)
    [ -n "$output" ] || exit 2
    asset=${url##*/}
    case "$asset" in
      omo-webchat_linux_amd64.tar.gz|omo-webchat_darwin_amd64.tar.gz|checksums.txt)
        cat "${MOCK_RELEASE_DIR:?}/$asset" > "$output"
        ;;
      *) exit 22 ;;
    esac
    ;;
  *) exit 22 ;;
esac
EOF

  chmod +x "$mock_bin/uname" "$mock_bin/curl"
}

add_hash_tool() {
  hash_tool=$1
  cat > "$mock_bin/$hash_tool" <<'EOF'
#!/bin/sh
set -eu

file=''
for argument in "$@"; do
  file=$argument
done
[ -n "$file" ] || exit 2
printf '%s  %s\n' "${MOCK_HASH_VALUE-}" "$file"
printf '%s\n' "$0 $*" > "${MOCK_HASH_LOG:?}"
EOF
  chmod +x "$mock_bin/$hash_tool"
}

run_installer() {
  platform=$1
  case_name=$2
  version_mode=$3
  hash_tool=$4
  archive=$5
  expected_digest=$6
  hash_value=$7
  precreate_mode=${8:-}

  case "$platform" in
    Linux) asset="${binary}_linux_amd64.tar.gz" ;;
    Darwin) asset="${binary}_darwin_amd64.tar.gz" ;;
    *) fail "unsupported test platform: $platform" ;;
  esac

  case_label="$platform/$case_name"
  run_dir="$work/$platform-$case_name"
  mock_bin="$run_dir/bin"
  install_dir="$run_dir/install"
  mkdir "$run_dir" "$run_dir/tmp"
  if [ "$precreate_mode" = missing-parent ]; then
    install_dir="$run_dir/home/.local/bin"
  elif [ -n "$precreate_mode" ]; then
    mkdir "$install_dir"
    chmod "$precreate_mode" "$install_dir"
  fi
  make_release "$run_dir/release" "$asset" "$archive" "$expected_digest"
  make_mock_bin "$mock_bin"
  if [ -n "$hash_tool" ]; then
    add_hash_tool "$hash_tool"
  fi

  if [ "$version_mode" = explicit ]; then
    mock_release_tag=unexpected-tag
  else
    mock_release_tag=$tag
  fi

  set +e
  (
    PATH=$mock_bin
    export PATH
    MOCK_OS=$platform
    MOCK_EXPECT_TAG=$tag
    MOCK_RELEASE_DIR="$run_dir/release"
    MOCK_RELEASE_TAG=$mock_release_tag
    MOCK_HASH_VALUE=$hash_value
    MOCK_HASH_LOG="$run_dir/hash.log"
    TMPDIR="$run_dir/tmp"
    export MOCK_OS MOCK_EXPECT_TAG MOCK_RELEASE_DIR MOCK_RELEASE_TAG MOCK_HASH_VALUE MOCK_HASH_LOG TMPDIR
    if [ "$version_mode" = explicit ]; then
      VERSION=$tag
      export VERSION
    else
      unset VERSION
    fi
    INSTALL_DIR=$install_dir
    export INSTALL_DIR
    "$shell_path" "$installer"
  ) > "$run_dir/stdout" 2> "$run_dir/stderr"
  run_status=$?
  set -e

  [ -z "$(find "$run_dir/tmp" -mindepth 1 -maxdepth 1 -print -quit)" ] || fail "$case_label: installer temporary files were not cleaned up"
}

expect_success() {
  [ "$run_status" -eq 0 ] || fail "$case_label: installer failed unexpectedly"
  [ -f "$install_dir/$binary" ] || fail "$case_label: installer did not install the binary"
  [ "$(cat "$install_dir/$binary")" = "$valid_contents" ] || fail "$case_label: installed binary contents differ"
  [ -s "$run_dir/hash.log" ] || fail "$case_label: checksum tool was not invoked"
}

expect_rejection() {
  error=$1
  [ "$run_status" -ne 0 ] || fail "$case_label: installer accepted an unverified archive"
  [ ! -e "$install_dir/$binary" ] || fail "$case_label: binary was installed after checksum rejection"
  grep -F "$error" "$run_dir/stderr" >/dev/null || fail "$case_label: missing rejection error"
}

expect_no_hash_rejection() {
  [ "$run_status" -ne 0 ] || fail "$case_label: installer succeeded without a checksum tool"
  [ ! -e "$install_dir/$binary" ] || fail "$case_label: tampered binary was installed without checksum verification"
  grep -F 'shasum or sha256sum is required for checksum verification' "$run_dir/stderr" >/dev/null || fail "$case_label: missing checksum-tool error"
}

expect_omo_warning() {
  grep -F "'omo' is required at runtime" "$run_dir/stderr" >/dev/null || fail "$case_label: missing omo runtime-dependency warning"
  if grep -F 'tmux' "$run_dir/stderr" >/dev/null; then
    fail "$case_label: stderr must not mention tmux"
  fi
}

expect_unwritable_failure() {
  [ "$run_status" -ne 0 ] || fail "$case_label: installer succeeded despite an unwritable install dir"
  [ ! -e "$install_dir/$binary" ] || fail "$case_label: binary was installed despite an unwritable install dir"
  grep -F 'cannot write to' "$run_dir/stderr" >/dev/null || fail "$case_label: missing 'cannot write to' error"
}

valid_archive="$work/valid.tar.gz"
tampered_archive="$work/tampered.tar.gz"
make_archive "$valid_contents" "$valid_archive"
make_archive "$tampered_contents" "$tampered_archive"
valid_digest=$(sha256 "$valid_archive")
tampered_digest=$(sha256 "$tampered_archive")

for platform in Linux Darwin; do
  run_installer "$platform" explicit-shasum explicit shasum "$valid_archive" "$valid_digest" "$valid_digest"
  expect_success

  run_installer "$platform" latest-sha256sum latest sha256sum "$valid_archive" "$valid_digest" "$valid_digest"
  expect_success

  run_installer "$platform" mismatch explicit shasum "$tampered_archive" "$valid_digest" "$tampered_digest"
  expect_rejection 'checksum mismatch'

  run_installer "$platform" no-hash-tool explicit '' "$tampered_archive" "$valid_digest" ''
  expect_no_hash_rejection

  run_installer "$platform" empty-hash-output explicit shasum "$valid_archive" "$valid_digest" ''
  expect_rejection 'checksum mismatch'
done

run_installer Linux omo-missing-warning latest shasum "$valid_archive" "$valid_digest" "$valid_digest"
expect_success
expect_omo_warning

run_installer Linux missing-install-parents explicit shasum "$valid_archive" "$valid_digest" "$valid_digest" missing-parent
expect_success

run_installer Linux unwritable-install-dir explicit shasum "$valid_archive" "$valid_digest" "$valid_digest" 0555
expect_unwritable_failure

printf 'PASS: Darwin and Linux explicit and latest verified installs succeed; nested user install dirs are created without sudo; mismatched, unverifiable, and empty checksums fail closed; missing runtime dependency warns without tmux; unwritable install dirs fail closed with guidance; temporary files are cleaned up.\n'
