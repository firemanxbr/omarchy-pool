#!/usr/bin/env bash
# The trial: a real pacman, in a clean container, installs the lab's build
# against edge — the include of `--ring lab`, the lab's sections above
# edge's — and the transcript is the evidence a maintainer reads beside
# the gate and the audit. Not a download check (the health check does
# that): the package is installed, its hooks run, its files verified.
# Posts a `trial` event either way; writes the transcript for the job to
# attach to the staged build (trial.log).
#
# Usage: tests/trial.sh <arch> <task> <package>...   (task: the staged build the trial is of)
# Env:   OMARCHY_API, OMARCHY_POOL, OMARCHY_TOKEN, OMARCHY_WORK_DIR
#        OMARCHY_KEYRINGS  directory from tests/fetch-keyrings.sh (every project's keyring)
#        PKG_REPO          path to the pkg-repo binary (default target/release/pkg-repo)
#        TRIAL_LOG         where to write the transcript (default $OMARCHY_WORK_DIR/tmp/trial-<task>.log)
set -uo pipefail
ARCH="${1:?arch}"; TASK="${2:?task}"; shift 2
PKGS=("$@"); [[ ${#PKGS[@]} -gt 0 ]] || { echo "trial: no package named" >&2; exit 2; }
source "$(cd "$(dirname "$0")" && pwd)/images.env"
case "$ARCH" in
  x86_64)  IMAGE="$ARCHLINUX_BASE"; PLATFORM="linux/amd64"; KEYRING="archlinux" ;;
  aarch64) IMAGE="$ARCHLINUXARM_BASE"; PLATFORM="linux/arm64"; KEYRING="archlinuxarm" ;;
  *) echo "unknown arch $ARCH"; exit 1 ;;
esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_REPO="${PKG_REPO:-$ROOT/target/release/pkg-repo}"
RUNTIME="$(command -v docker || command -v podman)"
LOG="${TRIAL_LOG:-${OMARCHY_WORK_DIR:-/tmp}/tmp/trial-$TASK.log}"; mkdir -p "$(dirname "$LOG")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ms() { python3 -c "import time; print(int(time.time()*1000))"; }
started=$(ms)

post() { # status summary payload
  "$PKG_REPO" event --kind trial --ring lab --source "$ARCH" --status "$1" --summary "$2" \
    --duration-ms $(( $(ms) - started )) --payload "$3" >/dev/null 2>&1 || true
}
names=$(IFS=,; echo "${PKGS[*]}")

# The include exactly as `--ring lab` hands it to a machine: the lab's
# sections above edge's; what is tried wins by order, its dependencies
# resolve from edge.
include=$(curl -sf --max-time 20 "$OMARCHY_API/api/v1/pacman.conf?ring=lab&arch=$ARCH") || include=""
if [[ -z "$include" ]] || ! grep -q '^\[omarchy-.*-lab\]' <<<"$include"; then
  echo "the lab serves no database for $ARCH" | tee "$LOG"
  post error "trial of task $TASK ($names, $ARCH): the lab serves no database" "{\"task\": $TASK, \"packages\": \"$names\"}"
  exit 1
fi
{
  echo "[options]"; echo "Architecture = $ARCH"; echo "SigLevel = Required DatabaseRequired"; echo
  echo "$include"
} > "$WORK/pacman.conf"
cp "$ROOT/docs/omarchy-staging.pub.asc" "$WORK/omarchy-poc.pub.asc"
if [[ -n "${OMARCHY_KEYRINGS:-}" ]]; then
  for k in omarchy omarchy-asahi asahi-alarm chaotic; do [[ -f "$OMARCHY_KEYRINGS/$k.gpg" ]] && cp "$OMARCHY_KEYRINGS/$k.gpg" "$WORK/$k.gpg"; done
fi
printf '%s\n' "${PKGS[@]}" > "$WORK/packages.txt"
cat > "$WORK/check.sh" <<'CHECK'
set -uo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --populate "$KEYRING" >/dev/null 2>&1 || true
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key staging@firemanxbr.org >/dev/null 2>&1
for f in /repo/*.gpg; do
  [[ -f "$f" ]] || continue
  pacman-key --add "$f" >/dev/null 2>&1
  # The primary fingerprints in the file, read without a keyring (the mount
  # is read-only and a legacy keyring file misleads --keyring): lsigned, as
  # populate would from a keyring package's trusted list.
  for k in $(gpg --batch --with-colons --import-options show-only --import "$f" 2>/dev/null | awk -F: '$1=="pub"{p=1;next} $1=="sub"{p=0} $1=="fpr" && p {print $10; p=0}'); do pacman-key --lsign-key "$k" >/dev/null 2>&1 || true; done
done
mapfile -t pkgs < /repo/packages.txt
echo "== pacman -Sy (the lab above edge)"
pacman --config /repo/pacman.conf -Sy || { echo "TRIAL=sync-failed"; exit 1; }
for p in "${pkgs[@]}"; do
  from=$(pacman --config /repo/pacman.conf -Sp --print-format '%r' "$p" 2>/dev/null | head -1)
  echo "== $p comes from [${from:-?}]"
  [[ "$from" == *-lab ]] || { echo "$p would not come from the lab: [$from] wins the include"; echo "TRIAL=not-from-lab"; exit 1; }
done
echo "== pacman -S ${pkgs[*]} (a real install: dependencies from edge, hooks run)"
pacman --config /repo/pacman.conf -S --noconfirm --needed "${pkgs[@]}" || { echo "TRIAL=install-failed"; exit 1; }
for p in "${pkgs[@]}"; do
  echo "== $p installed: $(pacman -Q "$p")"
  pacman -Qkk "$p" >/dev/null 2>&1 && echo "== $p: every file present and unaltered" || { echo "== $p: pacman -Qkk found altered or missing files"; pacman -Qkk "$p" 2>&1 | tail -5; echo "TRIAL=files-differ"; exit 1; }
done
echo "== the system after: $(pacman -Q | wc -l) packages, $(pacman -Qdt 2>/dev/null | wc -l) orphan(s)"
echo "TRIAL=ok"
CHECK
[[ -s "$WORK/check.sh" ]] || { echo "check script was not written"; exit 1; }

out=$("$RUNTIME" run --rm --platform "$PLATFORM" -e KEYRING="$KEYRING" -v "$WORK:/repo:ro" "$IMAGE" bash /repo/check.sh 2>&1)
code=$?
verdict=$(grep -oE '^TRIAL=[a-z-]+' <<<"$out" | tail -1 | cut -d= -f2)
[[ $code -eq 0 && -z "$verdict" ]] && { code=1; out="$out"$'\n'"no TRIAL line: the trial did not run"; verdict="did-not-run"; }
{ echo "# trial of task $TASK — $names on $ARCH, the lab above edge — $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "$out"; } > "$LOG"
echo "$out"
tail_json=$(tail -40 <<<"$out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
if [[ $code -eq 0 ]]; then
  post ok "trial of task $TASK: $names installed on $ARCH from the lab, hooks ran, files verified" \
    "{\"task\": $TASK, \"arch\": \"$ARCH\", \"packages\": \"$names\", \"verdict\": \"ok\", \"tail\": $tail_json}"
else
  post error "trial of task $TASK: $names on $ARCH failed (${verdict:-exit $code})" \
    "{\"task\": $TASK, \"arch\": \"$ARCH\", \"packages\": \"$names\", \"verdict\": \"${verdict:-failed}\", \"tail\": $tail_json}"
fi
exit $code
