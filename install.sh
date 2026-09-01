#!/bin/sh
# Install script for omo-webchat.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/DevNewbie1826/omo-webchat/main/install.sh | sh
#
# Environment variables:
#   VERSION      Install a specific release tag (e.g. v0.1.0). Default: latest.
#   INSTALL_DIR  Install location. Default: /usr/local/bin (falls back to sudo).

set -eu

REPO="DevNewbie1826/omo-webchat"
BINARY="omo-webchat"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "'curl' is required but not installed."
command -v tar  >/dev/null 2>&1 || fail "'tar' is required but not installed."

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
  darwin|linux) ;;
  *) fail "unsupported OS: $os (supported: darwin, linux)" ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)   arch="amd64" ;;
  arm64|aarch64)  arch="arm64" ;;
  *) fail "unsupported architecture: $arch (supported: amd64, arm64)" ;;
esac

if [ -n "${VERSION:-}" ]; then
  tag="$VERSION"
else
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
fi
[ -n "$tag" ] || fail "could not determine the latest release. Set VERSION=vX.Y.Z explicitly."
info "installing ${BINARY} ${tag} (${os}/${arch})"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

asset="${BINARY}_${os}_${arch}.tar.gz"
base="https://github.com/${REPO}/releases/download/${tag}"

curl -fsSL "${base}/${asset}"      -o "${tmp}/${asset}"      || fail "download failed: ${base}/${asset}"
curl -fsSL "${base}/checksums.txt" -o "${tmp}/checksums.txt" || fail "download failed: ${base}/checksums.txt"

expected="$(awk -v a="$asset" '$2 == a { print $1 }' "${tmp}/checksums.txt")"
if [ -z "$expected" ]; then
  fail "checksum for ${asset} not found in checksums.txt"
fi
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${tmp}/${asset}" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp}/${asset}" | awk '{print $1}')"
else
  fail "shasum or sha256sum is required for checksum verification."
fi
if [ "$actual" != "$expected" ]; then
  fail "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"
fi

tar -xzf "${tmp}/${asset}" -C "$tmp"
[ -f "${tmp}/${BINARY}" ] || fail "archive did not contain ${BINARY}"

if [ -d "$INSTALL_DIR" ]; then
  target_dir="$INSTALL_DIR"
else
  target_dir="$(dirname "$INSTALL_DIR")"
fi
if [ ! -w "$target_dir" ]; then
  command -v sudo >/dev/null 2>&1 || fail "cannot write to ${INSTALL_DIR}; set INSTALL_DIR (e.g. INSTALL_DIR=~/.local/bin) or run as root."
  sudo mkdir -p "$INSTALL_DIR"
  sudo install -m 0755 "${tmp}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
else
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "${tmp}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
fi
info "installed ${INSTALL_DIR}/${BINARY}"

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *) warn "${INSTALL_DIR} is not on your PATH." ;;
esac

if ! command -v omo >/dev/null 2>&1; then
  warn "'omo' is required at runtime to create chats but was not found on your PATH."
  warn "install it with:  npm install -g omo-ai@beta"
fi

printf '\nDone. Run it with:\n\n  %s --password <secret>\n\nthen open http://localhost:8080 in your browser.\n' "$BINARY"
