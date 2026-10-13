#!/usr/bin/env bash
# The gate's lto check (#435): a recipe that runs cargo with makepkg's lto
# option on is a warning. Arch's makepkg.conf turns lto on, makepkg puts
# -flto=auto in CFLAGS, the cc crate compiles a crate's C (ring, aws-lc-sys)
# with it, and Arch's rust links through ld.lld, which cannot read GCC's
# LTO objects: omarchy-cli v1.1.4's x86_64 link failed on every
# ring_core_0_17_14__* symbol, while aarch64, whose makepkg.conf (Arch
# Linux ARM's) has !lto, linked. Here
# cargo_lto_on reads recipes the ways they write their options.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
script="$root/factory/worker/omarchy-build-worker.sh"

awk '/^cargo_lto_on\(\)/,/^}/' "$script" > "$tmp/fn.sh"
grep -q '^cargo_lto_on()' "$tmp/fn.sh" || { echo "cargo_lto_on is in the worker script"; exit 1; }
# shellcheck source=/dev/null
source "$tmp/fn.sh"
# vet_package runs it on the recipe it built, as a warning (4c), and says so when lto is off.
grep -qE '^  if cargo_lto_on /build/pkg/PKGBUILD; then vet_add lto warn ' "$script" || { echo "vet_package warns on a cargo recipe with lto on"; exit 1; }
grep -qE "^  elif .*; then vet_add lto pass " "$script" || { echo "vet_package passes a cargo recipe with lto off"; exit 1; }

# The recipe of omarchy-cli's bump to v1.1.4 (task 1608, trimmed): cargo, and no options at all.
cat > "$tmp/approved" <<'P'
# Maintainer: omarchy-pool factory <https://github.com/firemanxbr/omarchy-pool>
pkgname=omarchy-cli
pkgver=1.1.4
pkgrel=1
makedepends=('cargo' 'xz' 'zstd')
prepare() {
  cargo fetch --locked --target "$(rustc -vV | sed -n 's/host: //p')"
}
build() {
  export CARGO_TARGET_DIR=target
  cargo build --frozen --release --workspace
}
package() { :; }
P
cargo_lto_on "$tmp/approved" || { echo "task 1608's recipe runs cargo with lto on"; exit 1; }

# Every way a recipe says !lto turns it off.
for opts in "options=('!lto')" 'options=("!lto")' "options=(!lto)" "options=('!debug' '!lto')" $'options=(\n  \'!strip\'\n  \'!lto\'\n)'; do
  { printf '%s\n' "$opts"; cat "$tmp/approved"; } > "$tmp/off"
  ! cargo_lto_on "$tmp/off" || { echo "lto is off with: $opts"; exit 1; }
done
# Options that do not say !lto leave it on.
for opts in "options=('lto')" "options=('!ltofoo')" "options=('!debug')"; do
  { printf '%s\n' "$opts"; cat "$tmp/approved"; } > "$tmp/on"
  cargo_lto_on "$tmp/on" || { echo "lto stays on with: $opts"; exit 1; }
done
# A recipe that runs no cargo is not the check's, even with cargo in makedepends; no recipe is nothing.
printf "pkgname=x\nmakedepends=('cargo')\nbuild() {\n  make\n}\n" > "$tmp/nocargo"
! cargo_lto_on "$tmp/nocargo" || { echo "a recipe that runs no cargo is not the check's"; exit 1; }
! cargo_lto_on "$tmp/missing" || { echo "no recipe, no warning"; exit 1; }

echo "worker-gate-lto: ok"
