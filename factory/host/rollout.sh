#!/usr/bin/env bash
# rollout.sh — a rolling upgrade of the six workers to the image the pool's
# latest release published: what Kubernetes calls a rolling update, at the
# size of one host.
#
# Every service whose image (or configuration) changed is replaced in one
# `up`: compose stops each running container — SIGTERM, which the worker
# takes as *drain*: it finishes the task it holds, reports it, claims
# nothing new and exits (up to the compose file's stop_grace_period) — and
# starts one from the new image, each on its own clock. The unchanged ones
# keep working; no task is ever killed, none is handed to another worker by
# an expired lease, and none idles on the old image while another drains
# (the pool refuses an outdated worker 45 minutes after a deploy —
# worker/src/update.ts; contributors' sets have the same in the updater,
# factory/bin/omarchy-rollout). Nothing to do when nothing changed, so a
# timer runs this every few minutes (setup.sh installs one:
# omarchy-pool-rollout.timer, every 15 minutes).
#
#   ./rollout.sh            upgrade what changed
#   ./rollout.sh --check    say what would change, change nothing
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
check=0; [[ "${1:-}" == "--check" ]] && check=1
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# The socket is root:docker. A login shell carries the group; the user
# manager that runs the timer may predate the membership and not — then
# every docker call is "permission denied", the pipefail took the script
# down at the first one and the journal showed exit 1 and nothing else
# (omarchy-studio, every 15 minutes from 2026-09-14 to 09-15). A member
# without the group re-enters with it; anyone else hears why.
if ! id -Gn | tr ' ' '\n' | grep -qx docker && getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
  exec newgrp docker <<<"exec $(printf '%q ' "${BASH_SOURCE[0]}" "$@")"
fi
docker info >/dev/null 2>&1 || { log "docker is not reachable: $(docker info 2>&1 | tail -n1)"; exit 1; }

docker compose pull --quiet 2>&1 | grep -viE "pulled|pulling|^\s*$" || true
# What changed is replaced in ONE `up`: compose stops and recreates the
# services together, each draining under its own stop_grace_period, so no
# worker idles on the old image while another drains for hours — the pool
# hands nothing to an outdated worker 45 minutes after a deploy
# (worker/src/update.ts), and pool-aarch64 once waited three hours on the
# old image for pool-x86_64's drain (2026-09-15).
# Only the services the active profiles enable (compose.yml: `emulated`).
enabled="$(docker compose config --services 2>/dev/null | tr '\n' ' ')"
replace=(); old_images=()
config="$(docker compose config --format json 2>/dev/null || echo '{}')"
for svc in agent-proxy broker-community-x86_64 broker-community-aarch64 community-x86_64 community-aarch64 review-x86_64 review-aarch64 pool-x86_64 pool-aarch64; do
  [[ " $enabled " == *" $svc "* ]] || continue
  image="$(jq -r ".services[\"$svc\"].image" <<<"$config")"
  wanted="$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)"
  cid="$(docker compose ps -q "$svc" 2>/dev/null | head -1)"
  if [[ -z "$cid" ]]; then
    log "$svc: not running; starting"
    replace+=("$svc"); continue
  fi
  running="$(docker inspect -f '{{.Image}}' "$cid")"
  # The image, and the service's configuration: an environment or a volume
  # changed in compose.yml is a container to replace too (community-x86_64
  # kept its old environment for an hour after the agent-proxy landed,
  # 2026-09-15). compose stamps every container with its config hash.
  wanted_cfg="$(docker compose config --hash "$svc" 2>/dev/null | awk '{print $2}')"
  running_cfg="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$cid" 2>/dev/null || true)"
  [[ "$running" == "$wanted" && ( -z "$wanted_cfg" || "$running_cfg" == "$wanted_cfg" ) ]] && continue
  task="$(docker logs --tail 40 "$cid" 2>&1 | grep -oE '^(\[[0-9:]+\] )?task [0-9]+: [^(]*\(' | tail -1 | sed -E 's/^\[[0-9:]+\] //; s/ ?\($//' || true)"
  log "$svc: ${running:7:12} → ${wanted:7:12}$( [[ "$running_cfg" != "$wanted_cfg" && -n "$wanted_cfg" ]] && echo " (configuration changed)")${task:+ (draining: $task)}"
  old_images+=("$running"); replace+=("$svc")
done
if (( ${#replace[@]} == 0 )); then log "nothing to roll out: every service runs the latest image"; exit 0; fi
(( check )) && exit 0
# up -d recreates a container whose image changed: stop (drain), remove, start — all of them at once.
if docker compose up -d --no-deps --no-build "${replace[@]}" >/dev/null 2>&1; then
  for svc in "${replace[@]}"; do log "$svc: running $(docker inspect -f '{{.Image}}' "$(docker compose ps -q "$svc" | head -1)" 2>/dev/null | cut -c8-19)"; done
else
  log "FAILED to replace ${replace[*]} — docker compose logs"
fi
# Only what this run replaced goes.
for img in "${old_images[@]}"; do docker image rm "$img" >/dev/null 2>&1 || true; done
