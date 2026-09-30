#!/usr/bin/env bash
# Two builds of the same commit give the same omarchy-agent binary (design v2
# D17, §4.4): an unchanged agent keeps its hash from release to release, so a
# host never restarts for nothing, and anyone can rebuild the binary a release
# ships and compare.
#
# What makes it so: --locked, the toolchain rust-toolchain.toml pins,
# SOURCE_DATE_EPOCH from the commit, the build directories remapped
# (--remap-path-prefix for Rust, -ffile-prefix-map for the C that aws-lc
# compiles and, on macOS, -oso_prefix so the linker's UUID does not hash the
# object paths), and no release tag in the binary (the agent carries its own
# version only). Each build runs on its own copy of the commit, in its own
# directory, so a path or a time that leaked into the binary would show.
# release.yml's agent builds (#311) use the same flags.
#
# CI runs it per platform (ci.yml); by hand, on a committed tree:
#   bash tests/agent-reproducible.sh [target-triple]
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
target="${1:-}"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

export SOURCE_DATE_EPOCH="$(git -C "$root" log -1 --format=%ct HEAD)"
export CARGO_INCREMENTAL=0
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
# The physical path: macOS's /var is a link to /private/var, and the compiler sees the latter.
work="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$work"' EXIT

sums=()
for n in first second; do
  src="$work/$n/omarchy-pool"
  mkdir -p "$src"
  git -C "$root" archive HEAD | tar -x -C "$src"
  map="-ffile-prefix-map=$src=/build -ffile-prefix-map=$cargo_home=/cargo"
  rustflags="--remap-path-prefix=$src=/build --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$rustup_home=/rustup"
  if [[ "$target" == *-apple-darwin || ( -z "$target" && "$(uname -s)" == Darwin ) ]]; then
    rustflags="$rustflags -C link-arg=-Wl,-oso_prefix,$src/"
  fi
  (
    cd "$src"
    export RUSTFLAGS="$rustflags"
    export CFLAGS="$map" CXXFLAGS="$map"
    cargo build --quiet --release --locked -p omarchy-agent ${target:+--target "$target"}
  )
  bin="$src/target/${target:+$target/}release/omarchy-agent"
  "$bin" --version >/dev/null
  sum="$(sha256 "$bin")"
  sums+=("$sum")
  echo "$n build: $sum"
done

if [[ "${sums[0]}" != "${sums[1]}" ]]; then
  echo "omarchy-agent is not reproducible${target:+ for $target}: ${sums[0]} != ${sums[1]}" >&2
  exit 1
fi
echo "omarchy-agent${target:+ ($target)}: two builds of $(git -C "$root" rev-parse --short HEAD), one binary: ${sums[0]}"
