#!/usr/bin/env bash
# Health check for one ring: a real pacman in an Arch container syncs the
# ring's databases from the pool, lists them, and downloads one package with
# signature verification. Posts a `health` event either way.
#
# Usage: tests/health-check.sh <ring> [arch]   (arch: x86_64 | aarch64)
# Env:   OMARCHY_API, OMARCHY_POOL, OMARCHY_TOKEN
#        OMARCHY_KEYRINGS  directory from tests/fetch-keyrings.sh (omarchy.gpg verifies the OPR's packages)
# The container is what an Omarchy machine has: the distribution's keyring
# plus Omarchy's key. chaotic-aur is opt-in and needs its own keyring, so its
# database is left out of the check.
set -uo pipefail

RING="$1"
ARCH="${2:-x86_64}"
source "$(cd "$(dirname "$0")" && pwd)/images.env"
case "$ARCH" in
  x86_64)  IMAGE="$ARCHLINUX_BASE"; PLATFORM="linux/amd64"; KEYRING="archlinux" ;;
  aarch64) IMAGE="$ARCHLINUXARM_BASE"; PLATFORM="linux/arm64"; KEYRING="archlinuxarm" ;;
  *) echo "unknown arch $ARCH"; exit 1 ;;
esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_REPO="${PKG_REPO:-$ROOT/target/release/pkg-repo}"
RUNTIME="$(command -v docker || command -v podman)"
POOL="${OMARCHY_POOL:?}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ms() { python3 -c "import time; print(int(time.time()*1000))"; }
started=$(ms)

post() { # status summary payload
  "$PKG_REPO" event --kind health --ring "$RING" --source "$ARCH" --status "$1" --summary "$2" \
    --duration-ms $(( $(ms) - started )) --payload "$3" >/dev/null 2>&1 || true
}

# The ring's databases as the pool lists them, and the repositories exactly
# as the pool hands them to users (the include of routes/setup.ts: each
# database's directory — a source's own, <source>/<arch>; the optional
# sources, chaotic, are not in it). Both come from the head release's
# artifact rows, and both answers sit in the edge cache (a minute, two
# minutes): a check that runs right after a sync, a promotion or a
# fast-track created the head read snapshots from before its render — "no
# database is served" for edge x86_64 three seconds after five were
# rendered, an include with no [section] for rc that pacman called "no
# usable package repositories", a security fix rolled back on it
# (2026-09-17). So: fresh reads, and again every fifteen seconds until the
# head's databases are there — a render takes a minute or two — before
# the ring is called unserved.
repos=""; include=""
for try in $(seq 1 12); do
  bust="t=$(date +%s)$try"
  repos=$(curl -sf --max-time 20 "$OMARCHY_API/api/v1/stats?$bust" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for r in d["rings"]:
    if r["ring"] == sys.argv[1]:
        print(" ".join(sorted({a["repo"] for a in r["artifacts"] if a["kind"] == "db" and a["arch"] == sys.argv[2] and "-chaotic-" not in a["repo"]})))
' "$RING" "$ARCH")
  include=$(curl -sf --max-time 20 "$OMARCHY_API/api/v1/pacman.conf?ring=$RING&arch=$ARCH&$bust") || include=""
  if [[ -n "$repos" && -n "$include" ]] && grep -q '^\[' <<<"$include"; then break; fi
  echo "$RING $ARCH: no database listed yet (try $try of 12); the render may still be writing"; sleep 15
done
if [[ -z "$include" || -z "$repos" ]] || ! grep -q '^\[' <<<"$include"; then
  post error "$RING $ARCH: no database is served" '{}'
  echo "$RING $ARCH: nothing served"; exit 1
fi

{
  echo "[options]"
  echo "Architecture = $ARCH"
  echo "SigLevel = Required DatabaseRequired"
  echo
  echo "$include"
} > "$WORK/pacman.conf"
cp "$ROOT/docs/omarchy-staging.pub.asc" "$WORK/omarchy-poc.pub.asc"
# Every project's keyring the caller fetched (tests/fetch-keyrings.sh): the
# packages of a source verify against the key that project signs with —
# Omarchy's, the Asahi fork's (maralcbr's "Omarchy ARM Repository" key),
# asahi-alarm's, chaotic's. The base image's own keyring (archlinux /
# archlinuxarm) is populated inside. A source whose keyring is missing here
# fails the check on its first package, which is the right answer.
if [[ -n "${OMARCHY_KEYRINGS:-}" ]]; then
  for k in omarchy omarchy-asahi asahi-alarm chaotic; do [[ -f "$OMARCHY_KEYRINGS/$k.gpg" ]] && cp "$OMARCHY_KEYRINGS/$k.gpg" "$WORK/$k.gpg"; done
fi
# The check itself, run inside the container. Quoted heredoc: nothing in it
# expands on the host (an unquoted one silently produced an empty script —
# and an empty script exits 0, which read as "healthy").
cat > "$WORK/check.sh" <<'CHECK'
set -euo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --populate "$KEYRING" >/dev/null 2>&1 || true
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key staging@firemanxbr.org >/dev/null 2>&1
# Each project's keyring: imported, and every key in it locally signed —
# what `pacman-key --populate` does with a keyring package's trusted list.
for f in /repo/*.gpg; do
  [[ -f "$f" ]] || continue
  pacman-key --add "$f" >/dev/null 2>&1
  # The primary fingerprints in the file, read without a keyring (the mount
  # is read-only and a legacy keyring file misleads --keyring): lsigned, as
  # populate would from a keyring package's trusted list.
  for k in $(gpg --batch --with-colons --import-options show-only --import "$f" 2>/dev/null | awk -F: '$1=="pub"{p=1;next} $1=="sub"{p=0} $1=="fpr" && p {print $10; p=0}'); do pacman-key --lsign-key "$k" >/dev/null 2>&1 || true; done
done
pacman --config /repo/pacman.conf -Sy
total=0
for repo in $(grep -oE '^\[[a-z0-9-]+\]' /repo/pacman.conf | tr -d '[]' | grep -v options); do
  n=$(pacman --config /repo/pacman.conf -Sl "$repo" | wc -l); echo "$repo: $n packages"; total=$((total + n))
  # A sample per repository — the first, the last and a few at random —
  # downloaded and verified against its upstream signature. The OPR gets a
  # bigger sample: it rebuilds the same version per channel, which is where
  # a wrong signature beside an object showed up (2026-09-13).
  k=3; [[ "$repo" == *-packages-* ]] && k=8
  sample=$( { pacman --config /repo/pacman.conf -Sl "$repo" | awk '{print $2}' | head -1; pacman --config /repo/pacman.conf -Sl "$repo" | awk '{print $2}' | tail -1; pacman --config /repo/pacman.conf -Sl "$repo" | awk '{print $2}' | shuf -n "$k"; } | sort -u)
  [[ -n "$sample" ]] || { echo "$repo serves no package"; exit 1; }
  # --nodeps twice: the question is whether the sampled object downloads
  # and verifies, not whether its dependencies resolve — a package whose
  # dependency the upstream repository itself lacks (python2-wiringx-git in
  # Arch Linux ARM's alarm, an OPR build against a newer aquamarine than
  # ALARM ships) is upstream's inconsistency, and the sync's report, not a
  # broken pool.
  for name in $sample; do
    pacman --config /repo/pacman.conf -Sw --noconfirm --nodeps --nodeps "$repo/$name" >/dev/null || { echo "download or signature check of $repo/$name FAILED"; exit 1; }
  done
  echo "downloaded+verified $(wc -w <<<"$sample" | tr -d ' ') of $repo: $(tr '\n' ' ' <<<"$sample")"
done
echo "TOTAL=$total"
CHECK
[[ -s "$WORK/check.sh" ]] || { echo "check script was not written"; exit 1; }

out=$("$RUNTIME" run --rm --platform "$PLATFORM" -e KEYRING="$KEYRING" -v "$WORK:/repo:ro" "$IMAGE" bash /repo/check.sh 2>&1)
code=$?
total=$(grep -oE 'TOTAL=[0-9]+' <<<"$out" | tail -1 | cut -d= -f2)
echo "$out"
# A check that produced no total did not run: never call that healthy.
if [[ $code -eq 0 && -z "$total" ]]; then code=1; out="$out"$'\n'"no TOTAL line: the check did not run"; fi
if [[ $code -eq 0 ]]; then
  post ok "$RING $ARCH: pacman -Sy + signed download OK ($total packages across $(wc -w <<<"$repos" | tr -d " ") repos)" \
    "{\"repos\": \"$repos\", \"packages\": ${total:-0}}"
else
  post error "$RING $ARCH: pacman check failed (exit $code)" "{\"repos\": \"$repos\", \"tail\": $(tail -5 <<<"$out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"
fi
rm -rf "$WORK"
exit $code
