#!/usr/bin/env bash
# omarchy-rollout: kick-v1
# rollout.sh — wakes this host's updater (#277). The rollout itself runs in the image (omarchy-rollout, the `updater` service of
# compose.yml): it follows the pool's release by itself, brokers first, every stop a drain. No rollout code lives on the host.
#   ./rollout.sh          a round now: SIGUSR1 to the running updater; one that is not running is started as it is (never
#                         recreated, whatever compose thinks changed: which image it runs is its guard's call), and rounds at start
#   ./rollout.sh --check  ask it what a round would change; nothing changes. Both refuse, exit 4, beside omarchy-agent's marker (#313)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[[ ! -e .omarchy-agent ]] || { echo "rollout.sh: not done, and nothing changed: this machine is a maintainer host managed by omarchy-agent, which retired this set ($PWD/.omarchy-agent) — nothing needs to be run here; see: omarchy-agent status" >&2; exit 4; }
# A member of the docker group whose shell does not carry it yet re-enters with it (the socket is root:docker).
if ! id -Gn | tr ' ' '\n' | grep -qx docker && getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then exec newgrp docker <<<"exec $(printf '%q ' "${BASH_SOURCE[0]}" "$@")"; fi
[[ "${1:-}" == --check ]] && exec docker compose exec -T updater /usr/local/lib/omarchy-factory/bin/omarchy-rollout --check
[[ -n "$(docker compose ps -q --status running updater 2>/dev/null)" ]] && exec docker compose kill -s USR1 updater
exec docker compose up -d --no-deps --no-recreate updater
