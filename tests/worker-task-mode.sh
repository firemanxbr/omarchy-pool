#!/usr/bin/env bash
# The build script's --task mode (factory/worker/omarchy-build-worker.sh, #335):
# what `pkg-repo dispatch` runs in a task container. Run here in a container of
# STUB_IMAGE with the mounts the spec gives it (/task/in read-only, /task/out,
# /task/log, the checkout at /pool read-only) and the kinds that need no
# network: a trial's helper that passes and one that fails, the log cut at its
# cap with a marker while the task's own status survives the cut (no SIGPIPE),
# a kind the release does not know, and a verdict whose error carries quotes
# and backslashes — `verdict.json` must stay JSON. A build's own path is the
# P1 host's run (it installs from the network).
#
# Requires: docker or podman, jq. STUB_IMAGE: an image with bash and coreutils (default debian:stable-slim).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="${RUNTIME:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
STUB_IMAGE="${STUB_IMAGE:-docker.io/library/debian:stable-slim}"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp" 2>/dev/null || "$RT" run --rm -v "$tmp:$tmp" "$STUB_IMAGE" sh -c "rm -rf $tmp/t*" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null || true' EXIT
fail() { echo "worker-task-mode: FAIL — $*" >&2; exit 1; }
"$RT" image inspect "$STUB_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$STUB_IMAGE" >/dev/null

runs=0
run() { # kind check-script [env…] → $t/{out,log}, a new directory each time; the status in $status
  local kind="$1" check="$2"; shift 2
  runs=$((runs + 1)); t="$tmp/t$runs"
  mkdir -p "$t/in" "$t/out" "$t/log"
  printf "staged=1\nkind='%s'\nname='felix'\narch='x86_64'\nkeyring='archlinux'\n" "$kind" > "$t/in/meta.sh"
  printf '%s\n' "$check" > "$t/in/check.sh"
  local e=() kv
  for kv in "$@"; do e+=(-e "$kv"); done
  status=0
  "$RT" run --rm --cap-drop ALL --security-opt no-new-privileges ${e[@]+"${e[@]}"} \
    -v "$t/in:/task/in:ro" -v "$t/out:/task/out" -v "$t/log:/task/log" -v "$root:/pool:ro" \
    "$STUB_IMAGE" bash /pool/factory/worker/omarchy-build-worker.sh --task >/dev/null 2>&1 || status=$?
  [[ -f "$t/out/verdict.json" ]] || fail "$kind: no verdict.json (status $status)"
  jq -e . "$t/out/verdict.json" >/dev/null || fail "$kind: verdict.json is not JSON: $(cat "$t/out/verdict.json")"
}

# A trial's helper that installs: its transcript in the log, status 0 in the verdict and the container's.
run trial 'echo "== pacman -Sy"; echo "TRIAL=ok"'
[[ "$status" == 0 ]] || fail "a passing trial exited $status"
jq -e '.status == 0 and .final == false and .needs_native == false' "$t/out/verdict.json" >/dev/null || fail "$(cat "$t/out/verdict.json")"
grep -qx 'TRIAL=ok' "$t/log/task.log" || fail "the transcript: $(cat "$t/log/task.log")"
echo "ok: a trial's helper that passes"

# One that fails: its status, and the line that says why.
run trial 'echo "== pacman -S felix"; echo "TRIAL=install-failed"; exit 1'
[[ "$status" == 1 ]] || fail "a failing trial exited $status"
jq -e '.status == 1 and .final == false and (.error | contains("TRIAL=install-failed"))' "$t/out/verdict.json" >/dev/null || fail "$(cat "$t/out/verdict.json")"
echo "ok: a trial's helper that fails"

# The log, cut at its cap with a marker; the task's own status, not the pipe's.
run trial 'head -c 3000000 /dev/zero | tr "\0" x; echo; echo "TRIAL=ok"; exit 7' TASK_LOG_CAP=1000000
[[ "$status" == 7 ]] || fail "the cut changed the task's status: $status"
size="$(wc -c < "$t/log/task.log" | tr -d ' ')"
(( size >= 1000000 && size < 1001000 )) || fail "the log is $size bytes, not cut at 1000000"
grep -q 'the log was cut here at 1000000 bytes' "$t/log/task.log" || fail "no marker where the log was cut"
echo "ok: the log is cut at its cap with a marker, and the task's status survives the cut"

# A kind this release's script does not know.
run nonsense 'true'
[[ "$status" == 2 ]] || fail "an unknown kind exited $status"
jq -e '.status == 2 and (.error | contains("does not know the task kind"))' "$t/out/verdict.json" >/dev/null || fail "$(cat "$t/out/verdict.json")"
echo "ok: a kind it does not know"

# An error line with quotes, backslashes and a tab: the verdict stays JSON and says it.
run trial 'printf "error: \"quoted\" back\\\\slash\there\n"; exit 3'
jq -e '.status == 3 and (.error | contains("\"quoted\"")) and (.error | contains("back\\slash"))' "$t/out/verdict.json" >/dev/null || fail "$(cat "$t/out/verdict.json")"
echo "ok: a verdict whose error carries quotes and backslashes is JSON"
echo "ok: the build script's --task mode"
