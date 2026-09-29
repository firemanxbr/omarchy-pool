#!/usr/bin/env bash
# The restart policy a worker counts on when it declares `restart` (#277,
# its design's §1.9), on a real engine: under `on-failure:N` the engine
# starts an exit 75 again N times in the container's whole life, and then
# leaves it down — a healthy run between two exits does not give one back
# (only a manual start or a recreated container resets the count). So a
# worker declares restart under on-failure only with three or more
# restarts left, and says how many it has (restarts_left): a restart order
# must never be the one that stops it for good. Needs docker (CI's runner).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$here/images.env"
RUNTIME="${RUNTIME:-docker}"
name="omarchy-restart-policy-$$"; runs="omarchy-restart-policy-runs-$$"
cleanup() { "$RUNTIME" rm -f "$name" >/dev/null 2>&1 || true; "$RUNTIME" volume rm -f "$runs" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$RUNTIME" volume create "$runs" >/dev/null
# Each run counts itself in the volume and exits 75, as a worker's restart does; the second one first runs 15 s — healthy, past the
# engine's 10 s — before it exits.
"$RUNTIME" run -d --name "$name" --restart on-failure:2 -v "$runs:/runs" "$ARCHLINUX_BASE" \
  sh -c 'n=$(( $(cat /runs/n 2>/dev/null || echo 0) + 1 )); echo "$n" > /runs/n; [ "$n" = 2 ] && sleep 15; exit 75' >/dev/null
state() { "$RUNTIME" inspect -f '{{.State.Status}} {{.RestartCount}} {{.State.ExitCode}}' "$name"; }
for _ in $(seq 1 120); do [[ "$(state)" == "exited 2 75" ]] && break; sleep 1; done
[[ "$(state)" == "exited 2 75" ]] || { echo "on-failure:2 restarts an exit 75 twice, then leaves it down: $(state)"; exit 1; }
sleep 20
[[ "$(state)" == "exited 2 75" ]] || { echo "and it stays down: $(state)"; exit 1; }
n="$("$RUNTIME" run --rm -v "$runs:/runs" "$ARCHLINUX_BASE" cat /runs/n)"
[[ "$n" == 3 ]] || { echo "three runs in all — the healthy one did not give a restart back: $n"; exit 1; }
echo "restart policy: on-failure:2 took two exits 75 and no more, a healthy run between them counted nothing back"
