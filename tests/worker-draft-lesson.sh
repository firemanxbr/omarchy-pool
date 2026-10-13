#!/usr/bin/env bash
# A draft that learns from a recipe of another version gets its checksums
# made again (#435, lesson_sums in fetch_pkgbuild's draft branch). A bump
# drafted after a failed one (updates.ts) learns from that bump's recipe,
# whose sha256 updpkgsums set to the old tag's tarball; drafts keep such a
# sum more often than not (draft 1628 called its lesson's real sha256 "a
# placeholder"), and makepkg's validity check then fails the new tag and
# spends a drafter turn on it. Here lesson_sums runs updpkgsums exactly when
# the draft's pkgver is not the lesson's.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
script="$root/factory/worker/omarchy-build-worker.sh"

awk '/^lesson_sums\(\)/,/^}/' "$script" > "$tmp/fn.sh"
grep -q '^lesson_sums()' "$tmp/fn.sh" || { echo "lesson_sums is in the worker script"; exit 1; }
# shellcheck source=/dev/null
source "$tmp/fn.sh"
# fetch_pkgbuild calls it on a draft written from a lesson, after the drafter and before anything builds.
# shellcheck disable=SC2016 # the script's own text, $( and all
grep -A2 -- '--previous /build/PKGBUILD.prev \$( \[\[ -s /build/lesson.log' "$script" | grep -q '^      lesson_sums /build/PKGBUILD.prev /build/pkg$' \
  || { echo "fetch_pkgbuild's draft branch runs lesson_sums right after drafting from a lesson"; exit 1; }

# The worker's tools, as far as this goes: the build user and updpkgsums, which says where it ran.
chown() { :; }
as_builder() { "$@"; }
mkdir -p "$tmp/bin"
# shellcheck disable=SC2016 # $PWD is the stub's, when it runs
printf '#!/bin/sh\necho ran > "$PWD/.updpkgsums"\n' > "$tmp/bin/updpkgsums"
chmod +x "$tmp/bin/updpkgsums"
export PATH="$tmp/bin:$PATH"

# The lesson: task 1608's recipe, pkgver 1.1.4 with v1.1.4's tarball sum.
printf "pkgname=omarchy-cli\npkgver=1.1.4\npkgrel=1\nsha256sums=('9fb9d0d875e538a1fc74d70142923f2575ec4fe6129447706348d829370af643')\n" > "$tmp/lesson"
draft() { # pkgver → a draft directory whose recipe kept the lesson's sum
  rm -rf "$tmp/pkg"; mkdir -p "$tmp/pkg"
  sed "s/^pkgver=.*/pkgver=$1/" "$tmp/lesson" > "$tmp/pkg/PKGBUILD"
}

# A draft for v1.1.5 that kept v1.1.4's sum: made again.
draft 1.1.5
out="$(lesson_sums "$tmp/lesson" "$tmp/pkg")"
[[ -f "$tmp/pkg/.updpkgsums" ]] || { echo "a draft of 1.1.5 from a 1.1.4 lesson gets its sums made again"; exit 1; }
[[ "$out" == *"pkgver 1.1.5 is not the lesson's (1.1.4)"* ]] || { echo "the log says why: '$out'"; exit 1; }
# A draft of the lesson's own version (a contributor's second try, task 1628 after 1626): the sums stay.
draft 1.1.4
out="$(lesson_sums "$tmp/lesson" "$tmp/pkg")"
[[ ! -f "$tmp/pkg/.updpkgsums" && -z "$out" ]] || { echo "a draft of the lesson's own version keeps its sums: '$out'"; exit 1; }
# A lesson with no pkgver line (a recipe that computes it) is another version: made again.
printf "pkgname=omarchy-cli\n_v=1.1.4\npkgver=\$_v\n" > "$tmp/lesson2"
draft 1.1.5; lesson_sums "$tmp/lesson2" "$tmp/pkg" >/dev/null
[[ -f "$tmp/pkg/.updpkgsums" ]] || { echo "a lesson whose pkgver line is not the draft's: made again"; exit 1; }
# No recipe written (the drafter failed): nothing to do, and nothing fails here — the build says what went wrong.
rm -rf "$tmp/pkg"; mkdir -p "$tmp/pkg"
lesson_sums "$tmp/lesson" "$tmp/pkg" || { echo "no draft, no sums, no failure"; exit 1; }
[[ ! -f "$tmp/pkg/.updpkgsums" ]] || { echo "no draft, no updpkgsums"; exit 1; }
# updpkgsums failing (no network) is said, and the build goes on to tell.
printf '#!/bin/sh\nexit 1\n' > "$tmp/bin/updpkgsums"
draft 1.1.5
out="$(lesson_sums "$tmp/lesson" "$tmp/pkg")" || { echo "a failed updpkgsums does not stop the draft"; exit 1; }
[[ "$out" == *"updpkgsums failed; the build will tell"* ]] || { echo "a failed updpkgsums is said: '$out'"; exit 1; }

echo "worker-draft-lesson: ok"
