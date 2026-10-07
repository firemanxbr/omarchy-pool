#!/usr/bin/env bash
# The legacy worker path is gone (#346, design v2 §21.4; S3, S8): once every
# host had switched to the host agent, the files the legacy sets ran from left
# the repository, and nothing may bring them back or keep pointing at them:
#
# - the Studio's set (factory/host/{compose.yml,setup.sh,rollout.sh,register.sh}),
#   the command a maintainer's own set ran with (factory/host/omarchy-worker), the
#   Studio's dress rehearsal of its switch (factory/host/studio-rehearsal.sh), the
#   sets' compose file (factory/image/compose.yml) and their updater
#   (factory/bin/omarchy-rollout), with the tests that drove them; factory/host/
#   keeps the root-only prep-root.sh a new Linux host runs, and prep-mac.sh;
# - no file of the tree names one of them by its path: not CI, the release or
#   the rollback, not a test, not the code, not the docs;
# - the image starts no updater and no broker (the switch guard's marker checks
#   left with those tools), says no updater follows the pool, and copies no
#   omarchy-rollout; the broker keeps its agent role, the agent sidecar, and has
#   no pool path; the build script has no broker mode;
# - the docs (worker/src/docs, the READMEs) no longer describe role containers,
#   the updater, the broker's relay or a contributor-run worker.
#
# The Worker's own test (worker/test/legacy-path-gone.test.ts) checks the pages
# it serves. Run: bash tests/legacy-path-gone.sh
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
fail=0
say() { printf 'legacy-path-gone: %s\n' "$*" >&2; fail=1; }

GONE_FILES=(
  factory/host/compose.yml factory/host/setup.sh factory/host/rollout.sh factory/host/register.sh
  factory/host/omarchy-worker factory/host/studio-rehearsal.sh
  factory/image/compose.yml factory/bin/omarchy-rollout
  tests/omarchy-rollout.sh tests/host-setup.sh tests/omarchy-worker-cli.sh tests/studio-rehearsal.sh
)
for f in "${GONE_FILES[@]}"; do
  [[ ! -e "$f" ]] || say "$f is back: it left with the legacy sets (#346)"
done
for f in factory/host/prep-root.sh factory/host/prep-mac.sh; do
  [[ -f "$f" ]] || say "$f is missing: a new host still runs it"
done

# Their paths, anywhere in the tree but this guard and the Worker's: what CI, the release, a test, the code or a doc would run or
# point a reader at.
paths='factory/host/(compose\.yml|setup\.sh|rollout\.sh|register\.sh|omarchy-worker|studio-rehearsal\.sh)|factory/image/compose\.yml|factory/bin/omarchy-rollout|tests/(omarchy-rollout|host-setup|omarchy-worker-cli|studio-rehearsal)\.sh'
if hits="$(git grep -n -E "$paths" -- . ':!tests/legacy-path-gone.sh' ':!worker/test/legacy-path-gone.test.ts')"; then
  say "a file still names a legacy file by its path:"; printf '%s\n' "$hits" >&2
fi
# The workflows name none of them, nor the updater by its command.
if hits="$(grep -n -E 'omarchy-rollout|rollout\.sh|register\.sh|studio-rehearsal|host-setup\.sh|omarchy-worker-cli' .github/workflows/*.yml | grep -v 'tests/legacy-path-gone.sh' | grep -v 'name: The legacy worker path is gone')"; then
  say "a workflow still names a legacy tool:"; printf '%s\n' "$hits" >&2
fi

# The image: no updater, no broker relay, no omarchy-rollout copied, no label saying an updater follows the pool.
grep -q 'omarchy-rollout' factory/image/Containerfile && say "the Containerfile still copies omarchy-rollout"
grep -q 'com.omarchy.updater.follows' factory/image/Containerfile && say "the image still says an updater follows the pool"
grep -qE 'exec .*omarchy-rollout' factory/image/entrypoint.sh && say "the entrypoint still starts the updater"
grep -q 'OMARCHY_BROKER' factory/image/entrypoint.sh && say "the entrypoint still starts a builder behind a broker"
grep -q 'worker-id' factory/image/entrypoint.sh && say "the entrypoint still writes a worker id for an updater"
grep -qE '^ +updater\|broker\) .*is gone \(#346\)' factory/image/entrypoint.sh || say "the entrypoint does not refuse the updater and broker roles with the pointer"
# The broker: the agent sidecar, with no pool path and no worker token.
grep -qE 'POOL_ROUTES|/pool/|OMARCHY_WORKER_TOKEN|def pool\(' factory/bin/broker && say "the broker still relays the pool's calls"
grep -q '"/v1/messages"' factory/bin/broker || say "the broker lost its agent path"
grep -q 'OMARCHY_BROKER' factory/worker/omarchy-build-worker.sh && say "the build script still has a broker mode"

# The docs describe hosts: no role container, updater, broker relay or contributor-run worker. testing.md is the exception: it
# describes the tests of what the Worker and pkg-repo still keep for a legacy registration not yet retired (its Update order and
# set_rollout, `pkg-repo work`), which leave with that code; the paths above hold it to the files.
docs=()
for f in worker/src/docs/*.md README.md CONTRIBUTING.md SECURITY.md factory/sets/host/README.md; do [[ "$f" == worker/src/docs/testing.md ]] || docs+=("$f"); done
WORDS=(
  "role container" "role-container" "omarchy-rollout" "rollout.sh" "register.sh" "agent-proxy" "updater"
  "behind a broker" "builder relay" "community worker" "community set" "contributor-run" "a contributor's worker" "shared mode"
  "WORKER_SHARED" "OMARCHY_BROKER"
)
for w in "${WORDS[@]}"; do
  if hits="$(grep -n -i -F -- "$w" "${docs[@]}" | grep -v -i -E 'left with (the|them)|left the repository|retired|#346' || true)"; [[ -n "$hits" ]]; then
    say "the docs still say \`$w\`:"; printf '%s\n' "$hits" >&2
  fi
done

(( fail == 0 )) || exit 1
echo "legacy-path-gone: ok"
