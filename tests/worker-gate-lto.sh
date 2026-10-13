#!/usr/bin/env bash
# The gate's lto check (#435): a recipe that runs cargo with makepkg's lto
# option on is a warning. Arch's makepkg.conf turns lto on, makepkg puts
# -flto=auto in CFLAGS, the cc crate compiles a crate's C (ring, aws-lc-sys)
# with it, and Arch's rust links through ld.lld, which cannot read GCC's
# LTO objects: omarchy-cli v1.1.4's x86_64 link failed on every
# ring_core_0_17_14__* symbol, while aarch64, whose makepkg.conf (Arch
# Linux ARM's) has !lto, linked. Here cargo_lto_on reads recipes the ways
# they write their options — through the options makepkg itself reads
# (--printsrcinfo), and by the recipe's text, comments aside, where makepkg
# cannot read it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
script="$root/factory/worker/omarchy-build-worker.sh"

# Each function whole: a one-line one ends on its own line, a longer one at the first `}` alone.
: > "$tmp/fn.sh"
for f in recipe_code cargo_runs cargo_lto_on; do
  awk -v f="$f" 'index($0, f "() ") == 1 {on=1} on {print} on && (/^}/ || /; }$/) {on=0}' "$script" >> "$tmp/fn.sh"
  grep -q "^$f()" "$tmp/fn.sh" || { echo "$f is in the worker script"; exit 1; }
done
# shellcheck source=/dev/null
source "$tmp/fn.sh"
# vet_package runs it on the recipe it built, as a warning (4c), and says so when lto is off.
grep -qE '^  if cargo_lto_on /build/pkg/PKGBUILD; then vet_add lto warn ' "$script" || { echo "vet_package warns on a cargo recipe with lto on"; exit 1; }
grep -qE "^  elif cargo_runs /build/pkg/PKGBUILD; then vet_add lto pass " "$script" || { echo "vet_package passes a cargo recipe with lto off"; exit 1; }

# The recipe of omarchy-cli's bump to v1.1.4 (task 1608, trimmed): cargo, and no options at all.
cat > "$tmp/approved" <<'P'
# Maintainer: omarchy-pool factory <https://github.com/firemanxbr/omarchy-pool>
pkgname=omarchy-cli
pkgver=1.1.4
pkgrel=1
arch=('x86_64' 'aarch64')
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
mkdir -p "$tmp/base"; cp "$tmp/approved" "$tmp/base/PKGBUILD"
# recipe <first line> → the approved recipe, that line first, in a directory of its own (makepkg reads ./PKGBUILD).
n=0
recipe() { n=$((n + 1)); mkdir -p "$tmp/r$n"; { printf '%s\n' "$1"; cat "$tmp/approved"; } > "$tmp/r$n/PKGBUILD"; echo "$tmp/r$n/PKGBUILD"; }

# Every way a recipe says !lto turns it off; options that do not say it leave it on — a commented-out line, a
# trailing comment and an options line that names other options alone (#435's review: the text was grepped whole).
OFF=("options=('!lto')" 'options=("!lto")' "options=(!lto)" "options=('!debug' '!lto')" $'options=(\n  \'!strip\'\n  \'!lto\'\n)')
ON=("options=('lto')" "options=('!ltofoo')" "options=('!debug')" "# options=('!lto') -- off until upstream fixes it" "options=('!debug') # '!lto' next time" "  #options=(!lto)")

weigh() { # mode — every case, the way the mode reads it
  local o p
  cargo_lto_on "$tmp/base/PKGBUILD" || { echo "$1: task 1608's recipe runs cargo with lto on"; exit 1; }
  for o in "${OFF[@]}"; do p="$(recipe "$o")"; ! cargo_lto_on "$p" || { echo "$1: lto is off with: $o"; exit 1; }; done
  for o in "${ON[@]}"; do p="$(recipe "$o")"; cargo_lto_on "$p" || { echo "$1: lto stays on with: $o"; exit 1; }; done
  # cargo by its path is cargo all the same.
  p="$(recipe '')"; sed -e 's|^  cargo build |  /usr/bin/cargo build |' -e '/cargo fetch/d' "$p" > "$p.new" && mv "$p.new" "$p"
  { grep -q '^  /usr/bin/cargo build' "$p" && ! grep -qE '(^|[[:space:]])cargo fetch' "$p"; } || { echo "$1: the fixture runs /usr/bin/cargo alone"; exit 1; }
  cargo_runs "$p" || { echo "$1: /usr/bin/cargo build runs cargo"; exit 1; }
  cargo_lto_on "$p" || { echo "$1: /usr/bin/cargo build with lto on is the check's"; exit 1; }
  # A recipe that runs no cargo is not the check's — cargo in makedepends or in a comment only; no recipe is nothing.
  mkdir -p "$tmp/nocargo"; printf "pkgname=x\npkgver=1\npkgrel=1\narch=('any')\nmakedepends=('cargo')\nbuild() {\n  make # not cargo build\n}\npackage() { :; }\n" > "$tmp/nocargo/PKGBUILD"
  ! cargo_runs "$tmp/nocargo/PKGBUILD" || { echo "$1: a recipe that runs no cargo is not the check's"; exit 1; }
  ! cargo_lto_on "$tmp/nocargo/PKGBUILD" || { echo "$1: a recipe that runs no cargo is not the check's"; exit 1; }
  ! cargo_lto_on "$tmp/missing/PKGBUILD" || { echo "$1: no recipe, no warning"; exit 1; }
}

# 1. Where makepkg cannot read the recipe (as_builder fails, as it does here): the text, comments aside.
# shellcheck disable=SC2329 # cargo_lto_on calls it
as_builder() { return 127; }
weigh "by the text"
# What only makepkg can tell: "!lto" in a function body is no option. The text says off; makepkg says on (step 2).
body="$(recipe '')"; printf "check() {\n  echo '!lto'\n}\n" >> "$body"
! cargo_lto_on "$body" || { echo "by the text: '!lto' anywhere in the code reads as off (only makepkg tells options apart)"; exit 1; }

# 2. The options makepkg reads (--printsrcinfo, as install_deps reads the dependencies): Arch's makepkg when this
# runs where it is (an Arch container, not as root), elsewhere a stand-in that does what makepkg does for this —
# sources the recipe in bash and prints its options as .SRCINFO's lines.
mkdir -p "$tmp/bin"
if command -v makepkg >/dev/null 2>&1 && [[ "$(id -u)" != 0 ]]; then
  mode="Arch's makepkg --printsrcinfo"
else
  mode="makepkg --printsrcinfo's stand-in"
  cat > "$tmp/bin/makepkg" <<'M'
#!/usr/bin/env bash
[[ "$1" == --printsrcinfo ]] || exit 2
source ./PKGBUILD || exit 1
printf 'pkgbase = %s\n' "${pkgbase:-$pkgname}"
for o in "${options[@]}"; do printf '\toptions = %s\n' "$o"; done
printf '\npkgname = %s\n' "$pkgname"
M
  chmod +x "$tmp/bin/makepkg"
fi
as_builder() { PATH="$tmp/bin:$PATH" "$@"; }
weigh "$mode"
cargo_lto_on "$body" || { echo "$mode: an echo of '!lto' in check() is no option: lto stays on"; exit 1; }

echo "worker-gate-lto: ok ($mode)"
