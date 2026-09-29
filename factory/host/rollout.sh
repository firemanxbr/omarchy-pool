#!/usr/bin/env bash
# omarchy-rollout: kick-v1
# rollout.sh — wakes this host's updater (#277). The rollout itself runs in the image (omarchy-rollout, the `updater` service of
# compose.yml): it follows the pool's release by itself, brokers first, every stop a drain. No rollout code lives on the host.
#   ./rollout.sh          start the updater if it is not running, then wake it: a round now (it starts whatever is not running)
#   ./rollout.sh --check  ask it what a round would change; nothing changes
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# A member of the docker group whose shell does not carry it yet re-enters with it (the socket is root:docker).
if ! id -Gn | tr ' ' '\n' | grep -qx docker && getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then exec newgrp docker <<<"exec $(printf '%q ' "${BASH_SOURCE[0]}" "$@")"; fi
[[ "${1:-}" == --check ]] && exec docker compose exec -T updater /usr/local/lib/omarchy-factory/bin/omarchy-rollout --check
docker compose up -d --no-deps updater
docker compose kill -s USR1 updater
