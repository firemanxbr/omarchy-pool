#!/bin/sh
# install.sh: the one command that makes a maintainer's machine a pool host
# (design v2 §13.1; #311). Every release carries its own copy, rendered by
# factory/bin/host-bundle with that release's agent version and the SHA-256
# of each agent binary, so the download is checked against the release, not
# against whatever the server sends:
#
#   curl -fsSL https://github.com/firemanxbr/omarchy-pool/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/firemanxbr/omarchy-pool/releases/latest/download/install.sh | OMARCHY_ENROLL=... sh -s -- [install options]
#
# This file itself is not signed: its provenance is attested by release.yml on
# main, and the runbook (*The host bundle*) gives the install that checks that
# attestation before it runs it.
#
# It refuses root, downloads the agent into a fresh `mktemp -d` under the
# agent's data directory (never a predictable /tmp path), checks its SHA-256,
# installs it as versions/<agent version>/omarchy-agent, points `current` at
# it and runs `omarchy-agent install --release <this release>` with the
# options given (#317: the agent verifies that release's bundle and its own
# hash against it). An enrollment token travels in the environment
# (OMARCHY_ENROLL), never on a command line.
# Everything runs inside main, so a truncated download runs nothing.
set -eu

RELEASE='@RELEASE@'
AGENT_VERSION='@AGENT_VERSION@'
SHA256_X86_64_LINUX='@SHA256_X86_64_LINUX@'
SHA256_AARCH64_LINUX='@SHA256_AARCH64_LINUX@'
SHA256_AARCH64_DARWIN='@SHA256_AARCH64_DARWIN@'

say() { printf 'omarchy-agent install: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "neither sha256sum nor shasum is installed"; fi
}

main() {
  [ "$(id -u)" != 0 ] || die "refusing to run as root: the agent never runs as root; run this as the user the agent will run as"
  for arg in "$@"; do
    case "$arg" in
      --token* | --enroll*) die "a token never goes on the command line: pass it as OMARCHY_ENROLL in the environment" ;;
    esac
  done
  command -v curl >/dev/null 2>&1 || die "curl is not installed"

  os="$(uname -s)"; arch="$(uname -m)"
  case "$os/$arch" in
    Linux/x86_64 | Linux/amd64) asset=omarchy-agent-x86_64-linux-musl; want="$SHA256_X86_64_LINUX" ;;
    Linux/aarch64 | Linux/arm64) asset=omarchy-agent-aarch64-linux-musl; want="$SHA256_AARCH64_LINUX" ;;
    Darwin/arm64 | Darwin/aarch64) asset=omarchy-agent-aarch64-darwin; want="$SHA256_AARCH64_DARWIN" ;;
    *) die "no agent for $os on $arch (x86_64 or aarch64 Linux, or macOS on Apple silicon)" ;;
  esac
  page="$(getconf PAGESIZE 2>/dev/null || getconf PAGE_SIZE 2>/dev/null || echo unknown)"
  say "agent $AGENT_VERSION from release $RELEASE: $os $arch, page size $page"

  [ -n "${HOME:-}" ] || die "HOME is not set"
  data="${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-agent"
  umask 077
  mkdir -p "$data"
  tmp="$(mktemp -d "$data/download.XXXXXXXX")" || die "cannot make a download directory under $data"
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 1' HUP INT TERM

  base="https://github.com/firemanxbr/omarchy-pool/releases/download/$RELEASE"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/omarchy-agent" "$base/$asset" || die "the download of $base/$asset failed"
  got="$(sha256_of "$tmp/omarchy-agent")"
  [ "$got" = "$want" ] || die "$asset: SHA-256 $got is not the one release $RELEASE carries ($want); nothing was installed"

  dest="$data/versions/$AGENT_VERSION"
  mkdir -p "$dest"
  chmod 755 "$tmp/omarchy-agent"
  mv -f "$tmp/omarchy-agent" "$dest/omarchy-agent"
  ln -sfn "versions/$AGENT_VERSION" "$data/current"
  rm -rf "$tmp"
  trap - EXIT
  say "installed $dest/omarchy-agent; $data/current points at it"
  exec "$data/current/omarchy-agent" install --release "$RELEASE" "$@"
}

main "$@"
