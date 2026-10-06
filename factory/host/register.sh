#!/usr/bin/env bash
# register.sh — registers this host's community pair with the pool, writing
# each worker token into etc/<service>.env beside this script; nothing is
# printed but the ids. Per-worker trust is gone (#343: the trust door
# answers 410), so a project service (pool, review and the second review
# pair) whose env file has no token yet is skipped before anything is
# registered: a registration nobody can trust would only leave its role
# container exiting at start and the updater holding the set back. That
# work is the host's the agent runs (docs/worker-host#maintainer-hosts);
# the project services registered and trusted before #343 keep their
# tokens and run on.
#
#   OMARCHY_CONTRIBUTOR_TOKEN=omc_… ./register.sh        a maintainer's token (profile page)
#
# A service whose etc/*.env already holds a token is left alone, so the
# script is safe to run again after adding a worker or losing one. To
# replace a community registration, revoke it on the dashboard (or DELETE
# /factory/workers/<id>), blank the token in its env file, run again; a
# project service's cannot be replaced since #343 (runbook, *Tokens*).
set -euo pipefail
: "${OMARCHY_API:=https://pkgs.omarchy-pool.org}"
: "${OMARCHY_CONTRIBUTOR_TOKEN:?OMARCHY_CONTRIBUTOR_TOKEN is required: the contributor token of a maintainer, from the profile page (never paste it anywhere else)}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
where="$(sed -n 's/^WHERE=//p' "$here/.env" 2>/dev/null | head -1)"; where="${where:-$(hostname -s)}"
command -v jq >/dev/null || { echo "jq is required (pacman -S jq)"; exit 2; }

api() { curl -sS --fail-with-body --max-time 30 -X "$1" "$OMARCHY_API/api/v1$2" -H "authorization: Bearer $OMARCHY_CONTRIBUTOR_TOKEN" -H "content-type: application/json" ${3:+-d "$3"}; }

me="$(api GET /factory/me)" || { echo "the pool did not accept the contributor token: $me" >&2; exit 2; }
login="$(jq -r .contributor.login <<<"$me")"; role="$(jq -r .contributor.role <<<"$me")"
[[ "$role" == maintainer ]] || { echo "$login is a $role; a maintainer's token is needed to register workers (#331)" >&2; exit 2; }

for svc in pool-x86_64 pool-aarch64 review-x86_64 review-aarch64 review2-x86_64 review2-aarch64 community-x86_64 community-aarch64; do
  f="$here/etc/$svc.env"; role="${svc%-*}"; role="${role%2}"; arch="${svc##*-}"
  if [[ -f "$f" ]] && grep -qE '^OMARCHY_WORKER_TOKEN=omw_' "$f"; then
    prev="$(sed -n 's/^# worker: //p' "$f" | head -1)"
    echo "$svc: already registered ($prev); skipping"
    continue
  fi
  if [[ "$role" != community ]]; then
    echo "$svc: not registered: per-worker trust is gone (#343), so a project service is no longer added — this work is the host's: https://omarchy-pool.org/docs/worker-host#maintainer-hosts" >&2
    continue
  fi
  body="$(jq -n --arg n "$where-${svc%-*}-$arch" --arg a "$arch" --arg w "$where" --arg r "$role" '{name: $n, arch: $a, labels: {where: $w, role: $r}}')"
  reg="$(api POST /factory/workers "$body")" || { echo "$svc: registration failed: $reg" >&2; exit 1; }
  id="$(jq -r .worker <<<"$reg")"; token="$(jq -r .token <<<"$reg")"
  umask 077
  printf '# %s\n# worker: %s\nOMARCHY_WORKER_TOKEN=%s\n' "$svc" "$id" "$token" > "$f"
  echo "$svc: $id (community: contributors' builds)"
done
echo "tokens are in $here/etc/*.env (mode 600); docker compose up -d starts the workers"
