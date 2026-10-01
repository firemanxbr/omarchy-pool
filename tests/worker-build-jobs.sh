#!/usr/bin/env bash
# build_jobs (factory/worker/omarchy-build-worker.sh): a build container runs
# make, ninja and cargo with the job count the dispatcher set to match the
# task's --cpus (design v2 D32, #333), and with every core it sees only when
# nothing (or nothing sane) was set. CI runs it in the worker job; by hand:
# `bash tests/worker-build-jobs.sh`.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
awk '/^build_jobs\(\)/,/^}/' "$root/factory/worker/omarchy-build-worker.sh" > "$tmp/fn.sh"
[[ -s "$tmp/fn.sh" ]] || { echo "FAIL: no build_jobs in the worker script" >&2; exit 1; }
# shellcheck source=/dev/null
source "$tmp/fn.sh"
mkdir "$tmp/bin"; printf '#!/bin/sh\necho 12\n' > "$tmp/bin/nproc"; chmod +x "$tmp/bin/nproc"
export PATH="$tmp/bin:$PATH"

fail=0
expect() { # want var value
  local got
  if [[ "$3" == unset ]]; then got="$(unset "$2"; build_jobs "$2")"; else got="$(export "$2=$3"; build_jobs "$2")"; fi
  [[ "$got" == "$1" ]] || { echo "FAIL: $2=$3 gave $got, want $1" >&2; fail=1; }
}
expect 2 MAKEFLAGS -j2
expect 4 NINJAFLAGS -j4
expect 3 CARGO_BUILD_JOBS 3
expect 12 MAKEFLAGS unset
expect 12 MAKEFLAGS ""
expect 12 MAKEFLAGS "-j0"
expect 12 MAKEFLAGS "-j"
expect 12 MAKEFLAGS '-j2"; rm -rf /; "'
expect 12 CARGO_BUILD_JOBS "-1"
expect 12 NINJAFLAGS "-j99999"
(( fail == 0 )) && echo "ok"
exit "$fail"
