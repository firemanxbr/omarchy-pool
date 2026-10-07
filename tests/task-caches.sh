#!/usr/bin/env bash
# The task caches' pacman side (#341, design v2 §9.3, D52): what the build
# script's pacman makes of the two pacman caches a task container mounts — the
# host's, read-only, as its first CacheDir, and its own, writable, the second.
# (The dispatcher's side — the mounts it makes, the merge-back against the
# pool's signed databases, the caps — is crates/pkg-repo/src/dispatch/cache.rs's
# tests and tests/dispatch-engine.sh's section 7.)
#
#   1. pacman_ready (factory/worker/omarchy-build-worker.sh) names the shared
#      cache first and the task's own second, once, and only where the shared
#      cache is mounted
#   2. on a real engine with a real pacman (the pinned Arch base image of this
#      machine's architecture), two containers mounted as the spec mounts a
#      task's caches, with its capabilities, download the same packages from a
#      local repository at once — its packages signed by a throwaway key in the
#      containers' keyring, under the image's own `SigLevel = Required
#      DatabaseOptional`, which Arch's and Arch Linux ARM's sections keep: each
#      into its own cache, whole, the bytes the repository lists, each
#      package's .sig beside it; the shared cache is read-only in both and
#      stays empty
#   3. once those bytes are in the shared cache without their signatures, a
#      third container downloads them again and still fails (pacman checks the
#      package it found first, the shared cache's, by the .sig beside it:
#      `missing required signature`), as it does beside a .sig that is not the
#      package's; with each package's own .sig beside it (as the merge-back
#      puts them, the pool's copy), a fourth finds them there, checks them and
#      downloads nothing; a file there whose bytes are not the database's fails
#      the transaction, since pacman cannot delete it from a read-only cache —
#      what the merge-back's checks keep out
#
# Requires: bash, sed, grep, sha256sum; docker or podman for 2 and 3 (CI runs it
# on x86_64; on a shared machine under `flock /tmp/omarchy-engine.lock`). The
# base image comes from tests/images.env, pulled when absent; nothing is
# fetched from the network but that image.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="${RUNTIME:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
image=""
cleanup() {
  local c
  for c in a b c d e f; do "$RT" rm -f "omarchy-cachetest-$c-$$" >/dev/null 2>&1 || true; done
  # What the containers wrote as root goes through one more container of the same image, on this run's directory only.
  rm -rf "$tmp" 2>/dev/null || { [[ -z "$image" ]] || "$RT" run --rm -v "$tmp:$tmp" "$image" rm -rf "$tmp" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null; } || true
}
trap cleanup EXIT
fail() { echo "task-caches: FAIL — $*" >&2; exit 1; }

# ---------- 1. pacman_ready's CacheDir lines ----------
sed -n '/^pacman_ready() {/,/^}/p' "$root/factory/worker/omarchy-build-worker.sh" | sed "s|/etc/pacman.conf|$tmp/pacman.conf|g" > "$tmp/fn.sh"
grep -q 'CacheDir' "$tmp/fn.sh" || fail "pacman_ready names no CacheDir"
# shellcheck source=/dev/null
source "$tmp/fn.sh"
pacman-key() { :; }
printf '[options]\nArchitecture = auto\n#CacheDir    = /var/cache/pacman/pkg/\n\n[core]\nInclude = /etc/pacman.d/mirrorlist\n' > "$tmp/pacman.conf"
PACMAN_SHARED_CACHE="$tmp/nowhere" pacman_ready
grep -q '^CacheDir' "$tmp/pacman.conf" && fail "a CacheDir without the shared cache mounted: $(cat "$tmp/pacman.conf")"
mkdir -p "$tmp/shared-here"
PACMAN_SHARED_CACHE="$tmp/shared-here" pacman_ready
PACMAN_SHARED_CACHE="$tmp/shared-here" pacman_ready
[[ "$(grep '^CacheDir' "$tmp/pacman.conf" | tr -s ' ')" == "$(printf 'CacheDir = %s/\nCacheDir = /var/cache/pacman/pkg/' "$tmp/shared-here")" ]] \
  || fail "the CacheDir lines: $(cat "$tmp/pacman.conf")"
[[ "$(sed -n '2p' "$tmp/pacman.conf")" == "CacheDir = $tmp/shared-here/" ]] || fail "the shared cache is not first in [options]: $(cat "$tmp/pacman.conf")"
echo "ok: pacman_ready names the shared cache first and the task's own second, once, and only where it is mounted"

# ---------- 2. two containers at once, a real pacman ----------
command -v "$RT" >/dev/null 2>&1 || fail "no container engine ($RT)"
# shellcheck source=/dev/null
source "$root/tests/images.env"
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64
case "$arch" in
  x86_64) image="$ARCHLINUX_BASE" ;;
  aarch64) image="$ARCHLINUXARM_BASE" ;;
  *) fail "no pinned Arch base image for $arch" ;;
esac
"$RT" image inspect "$image" >/dev/null 2>&1 || "$RT" pull -q "$image" >/dev/null
# The capabilities a task container keeps (crates/pkg-repo/src/dispatch/spec.rs, CAPS).
caps=()
while read -r c; do caps+=(--cap-add "$c"); done < <(sed -n '/^pub const CAPS/,/^];/s/^ *"\([A-Z_]*\)",$/\1/p' "$root/crates/pkg-repo/src/dispatch/spec.rs")
(( ${#caps[@]} > 0 )) || fail "no CAPS in crates/pkg-repo/src/dispatch/spec.rs"
mkdir -p "$tmp/repo" "$tmp/shared" "$tmp/own-a" "$tmp/own-b" "$tmp/own-c" "$tmp/own-d" "$tmp/own-e" "$tmp/own-f" "$tmp/sync"
# A local repository of three packages, the dependency both builds need 48 MiB, made with pacman's own tools in the image;
# each package signed by a key made for this run and thrown away with it (key.asc, key.fpr: what the tasks' keyring takes),
# its .sig beside it and none in the database, as Arch's own repositories are now.
"$RT" run --rm -v "$tmp/repo:/repo" "$image" bash -c '
  set -e; cd /tmp; a="$(uname -m)"
  export GNUPGHOME=/tmp/gnupg; mkdir -m 700 "$GNUPGHOME"
  gpg --batch --quiet --pinentry-mode loopback --passphrase "" --quick-gen-key "omarchy-pool cache test (a throwaway key) <cachetest@omarchy-pool.invalid>" ed25519 sign never 2>/dev/null
  for p in cachefix-dep:50331648 cachefix-a:4096 cachefix-b:4096; do
    n="${p%%:*}"; size="${p#*:}"
    rm -rf pkg && mkdir -p "pkg/usr/share/$n"
    head -c "$size" /dev/urandom > "pkg/usr/share/$n/data"
    printf "pkgname = %s\npkgbase = %s\npkgver = 1.0-1\npkgdesc = a fixture\nurl = https://example.invalid\nbuilddate = 1700000000\npackager = omarchy-pool test\nsize = %s\narch = %s\nlicense = MIT\n" "$n" "$n" "$size" "$a" > pkg/.PKGINFO
    (cd pkg && bsdtar --zstd -cf "/repo/$n-1.0-1-$a.pkg.tar.zst" .PKGINFO usr)
    gpg --batch --quiet --detach-sign --no-armor "/repo/$n-1.0-1-$a.pkg.tar.zst"
  done
  gpg --batch --quiet --armor --export > /repo/key.asc 2>/dev/null
  gpg --batch --quiet --with-colons --list-keys 2>/dev/null | awk -F: "\$1 == \"fpr\" { print \$10; exit }" > /repo/key.fpr
  repo-add -q /repo/cachefix.db.tar.gz /repo/*.pkg.tar.zst
  chown -R "$0" /repo' "$(id -u):$(id -g)"
ls "$tmp"/repo/*.pkg.tar.zst >/dev/null || fail "the local repository was not made"
for f in "$tmp"/repo/*.pkg.tar.zst; do [[ -s "$f.sig" ]] || fail "$(basename "$f") was not signed"; done
grep -q "^[0-9A-F]\{40\}$" "$tmp/repo/key.fpr" || fail "the throwaway key's fingerprint: $(cat "$tmp/repo/key.fpr")"

# One task's pacman: the build script's pacman_ready, the shared cache read-only and its own cache mounted as the spec mounts them,
# the spec's capabilities; the image's repositories left out (no network here), the local one in, under the image's own SigLevel
# with its key in the keyring as the pool's is (add_pool_repos: added, locally signed). $3: wait for the other at the barrier
# first, so both download at once.
dl() { # name own [barrier-peer]
  "$RT" run --rm --name "omarchy-cachetest-$1-$$" --cap-drop ALL "${caps[@]}" --security-opt no-new-privileges \
    -v "$root:/pool:ro" -v "$tmp/repo:/repo:ro" -v "$tmp/sync:/sync" \
    -v "$tmp/shared:/var/cache/pacman/shared:ro" -v "$tmp/$2:/var/cache/pacman/pkg" \
    "$image" bash -c '
      set -uo pipefail
      source <(sed -n "/^pacman_ready() {/,/^}/p" /pool/factory/worker/omarchy-build-worker.sh)
      pacman_ready
      pacman-key --add /repo/key.asc >/dev/null 2>&1 && pacman-key --lsign-key "$(cat /repo/key.fpr)" >/dev/null 2>&1 || { echo "== no key"; exit 4; }
      echo "== cachedirs: $(pacman-conf CacheDir | tr "\n" " ")"
      awk "/^\\[/ { keep = (\$0 == \"[options]\") } keep" /etc/pacman.conf > /tmp/pacman.conf
      printf "\n[cachefix]\nSigLevel = Required DatabaseOptional\nServer = file:///repo\n" >> /tmp/pacman.conf
      echo "== shared write: $(touch /var/cache/pacman/shared/planted 2>&1 || true)"
      pacman --config /tmp/pacman.conf -Sy --noconfirm >/dev/null || exit 3
      echo "== synced"
      if [[ -n "$1" ]]; then touch "/sync/$0"; for _ in $(seq 120); do [[ -e "/sync/$1" ]] && break; sleep 0.25; done; fi
      pacman --config /tmp/pacman.conf -Sw --noconfirm cachefix-dep cachefix-a cachefix-b 2>&1
      echo "== exit: $?"' "$1" "${3:-}"
}
dl a own-a b > "$tmp/a.log" 2>&1 & pa=$!
dl b own-b a > "$tmp/b.log" 2>&1 & pb=$!
wait "$pa" || true; wait "$pb" || true
for t in a b; do
  grep -qx '== exit: 0' "$tmp/$t.log" || fail "task $t's pacman: $(cat "$tmp/$t.log")"
  grep -q "^== cachedirs: /var/cache/pacman/shared/ /var/cache/pacman/pkg/ $" "$tmp/$t.log" || fail "task $t's CacheDirs: $(grep '== cachedirs' "$tmp/$t.log")"
  grep -q '^== shared write: .*Read-only' "$tmp/$t.log" || fail "task $t could write the shared cache: $(grep '== shared write' "$tmp/$t.log")"
  for f in "$tmp"/repo/*.pkg.tar.zst; do
    cmp -s "$f" "$tmp/own-$t/$(basename "$f")" || fail "task $t's own cache does not hold $(basename "$f") whole: $(ls -la "$tmp/own-$t")"
    # What the merge-back must merge beside it: pacman downloads the signature of each package whose repository's SigLevel checks it.
    cmp -s "$f.sig" "$tmp/own-$t/$(basename "$f").sig" || fail "task $t's own cache does not hold $(basename "$f").sig: $(ls -la "$tmp/own-$t")"
  done
done
[[ -z "$(ls -A "$tmp/shared")" ]] || fail "a task wrote into the shared cache: $(ls -A "$tmp/shared")"
echo "ok: two tasks at once download the same packages and their signatures, each into its own cache, whole; the shared cache is read-only to both and stays as it was"

# ---------- 3. the shared cache, once merged ----------
# The bytes the database lists (here every one, from task a's cache, as the dispatcher copies them), without their signatures:
# pacman downloads each package again, then checks the one it found first — the shared cache's — by the .sig beside it, and
# there is none: the transaction fails. Why the merge-back never puts a package there without the pool's copy of its signature.
cp "$tmp"/own-a/*.pkg.tar.zst "$tmp/shared/"
dl c own-c > "$tmp/c.log" 2>&1 || true
grep -qx '== synced' "$tmp/c.log" || fail "task c did not get as far as the download: $(cat "$tmp/c.log")"
for f in "$tmp"/repo/*.pkg.tar.zst; do
  cmp -s "$f" "$tmp/own-c/$(basename "$f")" || fail "task c did not download $(basename "$f") again, its .sig in no cache: this pacman is not the one the merge-back's signatures are for: $(ls -A "$tmp/own-c")"
done
grep -qx '== exit: [1-9][0-9]*' "$tmp/c.log" && grep -q 'cachefix-dep: missing required signature' "$tmp/c.log" \
  || fail "a package of the shared cache without its .sig did not fail the task as pacman's own check says it does: $(cat "$tmp/c.log")"
echo "ok: a package in the shared cache without its .sig, of a repository whose SigLevel checks packages, is downloaded again and fails the task"
# A .sig beside it that is not its signature (another package's, by the same key): pacman cannot delete it, and the task fails.
dep="$(basename "$(ls "$tmp"/repo/cachefix-dep-*.pkg.tar.zst)")"
other="$(basename "$(ls "$tmp"/repo/cachefix-a-*.pkg.tar.zst)")"
cp "$tmp"/own-a/*.pkg.tar.zst.sig "$tmp/shared/"
cp "$tmp/own-a/$other.sig" "$tmp/shared/$dep.sig"
dl f own-f > "$tmp/f.log" 2>&1 || true
grep -qx '== synced' "$tmp/f.log" || fail "task f did not get as far as the download: $(cat "$tmp/f.log")"
grep -qx '== exit: [1-9][0-9]*' "$tmp/f.log" && grep -q "cachefix-dep.*signature" "$tmp/f.log" \
  || fail "a wrong .sig in the read-only cache went unnoticed: $(cat "$tmp/f.log")"
echo "ok: a .sig in the shared cache that is not its package's fails the task — why only the pool's copy goes there"
# With each package's own .sig beside it, as the merge-back puts them: found there, checked by its signature, nothing downloaded.
cp "$tmp/own-a/$dep.sig" "$tmp/shared/$dep.sig"
dl e own-e > "$tmp/e.log" 2>&1 || true
grep -qx '== exit: 0' "$tmp/e.log" || fail "task e's pacman: $(cat "$tmp/e.log")"
[[ -z "$(find "$tmp/own-e" -name '*.pkg.tar*' -print -quit)" ]] || fail "task e downloaded what the shared cache holds: $(ls -A "$tmp/own-e")"
echo "ok: a task finds what the shared cache holds with its signatures, checks them and downloads nothing"
# Bytes the database does not list under that name, in the read-only cache: pacman cannot delete them, and the transaction fails.
cp "$tmp/own-a/$other" "$tmp/shared/$dep"
dl d own-d > "$tmp/d.log" 2>&1 || true
# The transaction itself fails, for those bytes: the sync went through, pacman ran to its end and said why.
grep -qx '== synced' "$tmp/d.log" || fail "task d did not get as far as the download: $(cat "$tmp/d.log")"
grep -qx '== exit: [1-9][0-9]*' "$tmp/d.log" || fail "a corrupt file in the read-only cache went unnoticed: $(cat "$tmp/d.log")"
grep -qF "File /var/cache/pacman/shared/$dep is corrupted" "$tmp/d.log" || fail "task d's pacman failed, but not on the corrupt file of the shared cache: $(cat "$tmp/d.log")"
echo "ok: bytes the database does not list, in the read-only cache, fail the task — what the merge-back's check keeps out"
echo "ok: the task caches' pacman side ($RT, $image)"
