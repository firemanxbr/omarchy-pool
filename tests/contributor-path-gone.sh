#!/usr/bin/env bash
# The contributor worker path and the community-worker claim code are gone
# (#343, design v2 §21.4; S8, S9, D56): no identifier of them may come back
# into the Worker's sources — the code, the pages and the docs it serves
# (worker/src). The D1 columns stay as history (no DROP), so the migrations
# (worker/migrations) and the tests that seed rows from before #343
# (worker/test) may still name them; nothing under worker/src reads or
# writes them. The command a maintainer's legacy set ran with until P3 is
# gone from the repository too (#346, tests/legacy-path-gone.sh), and the
# pool no longer bundles nor serves it.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/worker/src"
fail=0
say() { printf 'contributor-path-gone: %s\n' "$*" >&2; fail=1; }

# What the claim's community-worker branch, the mode and trust doors and the served command were made of.
GONE=(
  shared_after          # the bump's days for its owner's worker (build_tasks.shared_after)
  mode_by               # who set a worker's mode (build_workers.mode_by)
  betterIdleWorker      # the best idle shared worker's first pick
  FIRST_PICK_MINUTES first_pick_minutes firstPick IDLE_SEEN_MINUTES workerRank
  SHARED_AFTER_DAYS     # the bump's fourteen days
  handleWorkerMode      # POST /factory/workers/self/mode, /factory/workers/:id/mode (410 now)
  handleTrustWorker     # POST /factory/workers/:id/trust (410 now)
  share_worker own_only # the person's page's Share / Own only on a worker's row
  WORKER_SHARED --shared "share on|off" "share on | off"
  workerCli workerCompose
)
for word in "${GONE[@]}"; do
  if hits="$(grep -rnF -- "$word" "$src")"; then say "\`$word\` is back in worker/src:"; printf '%s\n' "$hits" >&2; fi
done
# A worker's mode compared or written as the community tier's word — whatever the quoting or the operator.
if hits="$(grep -rnE "mode ?(===?|!==?|=) ?[\"'](shared|dedicated)[\"']" "$src")"; then say "a worker's shared or dedicated mode is back in worker/src:"; printf '%s\n' "$hits" >&2; fi
# The column written at all, bound or literal: an UPDATE that sets it, an INSERT into build_workers that names it.
if hits="$(grep -rnE "SET[^;\`]*[ ,]mode ?=|INSERT INTO build_workers \([^)]*\bmode\b" "$src")"; then say "build_workers.mode is written again in worker/src (history since #343):"; printf '%s\n' "$hits" >&2; fi
# The claim's own scope: its \`shared\` read from the body (b.shared) or carried in a scope (s.shared, lg.shared), typed in, or the
# owner's-builds-only test — a spread (...shared) is no field read.
if hits="$(grep -rnE "[A-Za-z0-9_)]\.shared\b|\bshared\??: (boolean|unknown)|c\.owner === s\.owner" "$src")"; then say "the claim's shared scope is back in worker/src:"; printf '%s\n' "$hits" >&2; fi
# The command and the compose file the pool served: not bundled into the Worker any more.
[[ ! -e "$src/omarchy-worker.sh" ]] || say "worker/src/omarchy-worker.sh is back: the pool serves no command (a maintainer's machine joins as a host)"
if hits="$(grep -rnE "from [\"'][^\"']*(omarchy-worker(\.sh)?|image/compose\.yml)[\"']" "$src")"; then say "the Worker bundles the command or its compose file again:"; printf '%s\n' "$hits" >&2; fi
(( fail == 0 )) || exit 1
echo "contributor-path-gone: ok"
