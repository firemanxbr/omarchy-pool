#!/usr/bin/env bash
# Builds the keyring files the sync verifies upstream package signatures
# against:
#   archlinux.gpg     from the archlinux-keyring package (Arch core, x86_64)
#   archlinuxarm.gpg  from the archlinuxarm-keyring package (Arch Linux ARM core)
#   omarchy.gpg       Omarchy's signing key, as shipped in omarchy-iso
#
# The keyring packages are fetched over HTTPS from the mirrors and are the one
# trust-on-first-use step of the pipeline; everything imported afterwards must
# verify against them.
#
# Every job that checks a ring's health runs this first (#414), so each keyring
# is fetched on its own: a source that does not answer, or stalls past its
# timeout, leaves the others refreshed and its own file as it was (yesterday's,
# or none), never a truncated one: each is written beside the old and moved
# into place only when whole. The script then exits 1, naming what it could
# not refresh, and the worker goes on with the files here when they are all
# it needs.
#
# Usage: tests/fetch-keyrings.sh <out dir>
set -euo pipefail
# GNU tar needs --wildcards for patterns; bsdtar (macOS) matches them by default.
TARW=(); [[ "$(tar --version 2>/dev/null)" == *GNU* ]] && TARW=(--wildcards)
# A source that stalls fails as one that refuses does, rather than hold the job that waits on it (#414);
# either says why (-S).
CURL=(curl -sSfL --connect-timeout 15 --max-time 120)

OUT="$1"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# These run as keyring()'s condition, where set -e does not hold: each step says when it failed.
extract_keyring() { # base-url db-name package-name path-in-archive out — the package's filename from the sync db
  local file
  "${CURL[@]}" -A "pkg-repo" "$1/$2.db" -o "$TMP/$2.db" || return 1
  # GNU tar detects gzip/xz/zstd on its own; %FILENAME% precedes %NAME% in a desc. awk leaves at the match and may break
  # tar's pipe: the name it printed is the answer.
  file="$(tar -xOf "$TMP/$2.db" ${TARW[@]+"${TARW[@]}"} '*/desc' 2>/dev/null \
    | awk -v want="$3" '/^%FILENAME%$/ { getline f } /^%NAME%$/ { getline n; if (n == want) { print f; exit } }')" || true
  [[ -n "$file" ]] || { echo "$3 is not in $1/$2.db" >&2; return 1; }
  "${CURL[@]}" -A "pkg-repo" "$1/$file" -o "$TMP/$file" || return 1
  from="from $file"
  case "$file" in
    *.zst) tar --use-compress-program=unzstd -xOf "$TMP/$file" "$4" > "$5" ;;
    *) tar -xOf "$TMP/$file" "$4" > "$5" ;;
  esac
}
dearmor() { # armored-key out
  gpg --batch --yes --dearmor -o "$2" "$1"
}
failed=()
keyring() { # name source command… — the command writes the keyring to the path given last
  local name="$1" new="$OUT/.$1.gpg.new"
  from="$2"; shift 2
  rm -f "$new"
  if "$@" "$new" && [[ -s "$new" ]]; then
    mv -f "$new" "$OUT/$name.gpg"
    echo "$OUT/$name.gpg: $(stat -c%s "$OUT/$name.gpg" 2>/dev/null || stat -f%z "$OUT/$name.gpg") bytes ($from)"
  else
    rm -f "$new"
    failed+=("$name")
    echo "$OUT/$name.gpg: not refreshed ($from); the one here, if any, stays" >&2
  fi
}

keyring archlinux archlinux-keyring \
  extract_keyring "https://mirror.omarchy.org/core/os/x86_64" core archlinux-keyring usr/share/pacman/keyrings/archlinux.gpg

keyring archlinuxarm archlinuxarm-keyring \
  extract_keyring "http://os.archlinuxarm.org/aarch64/core" core archlinuxarm-keyring usr/share/pacman/keyrings/archlinuxarm.gpg

keyring omarchy "omarchy-iso builder/omarchy.gpg" \
  "${CURL[@]}" "https://raw.githubusercontent.com/omacom/omarchy-iso/quattro/builder/omarchy.gpg" -o

keyring chaotic chaotic-keyring \
  extract_keyring "https://builds.garudalinux.org/repos/chaotic-aur/x86_64" chaotic-aur chaotic-keyring usr/share/pacman/keyrings/chaotic.gpg

# Asahi Linux on Arch Linux ARM: the asahi-alarm repository ships its keyring package.
keyring asahi-alarm asahi-alarm-keyring \
  extract_keyring "https://github.com/asahi-alarm/asahi-alarm/releases/download/aarch64" asahi-alarm asahi-alarm-keyring usr/share/pacman/keyrings/asahi-alarm.gpg

# Omarchy for Apple Silicon (maralcbr/omarchy-pkgs): packages and database are
# signed by "Omarchy ARM Repository", a key no package ships; the public key
# is kept in this repository (tests/keys/omarchy-asahi.asc, fingerprint
# C81AC3E2A99556F9B21D5FEA3DD49BC9F8360BDC, signing subkey …7AC186E4).
keyring omarchy-asahi tests/keys/omarchy-asahi.asc dearmor "$(dirname "${BASH_SOURCE[0]}")/keys/omarchy-asahi.asc"

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "fetch-keyrings: not refreshed: ${failed[*]}" >&2
  exit 1
fi
