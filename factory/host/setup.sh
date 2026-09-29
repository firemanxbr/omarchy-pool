#!/usr/bin/env bash
# setup.sh — prepares an Arch Linux host (Omarchy, Arch Linux ARM, Arch) to
# run the project's eight workers (compose.yml beside this script; RUNBOOK,
# *The Studio host*). Run once, as root:
#
#   sudo ./setup.sh [POOL_ROOT]          default POOL_ROOT: /srv/omarchy-pool
#
# What it does, all of it idempotent:
#   - POOL_ROOT: a btrfs subvolume when / is btrfs (outside the root's
#     snapshots), a directory otherwise; work/, cache/pacman/<arch>, etc/
#     owned by the user who ran sudo
#   - docker, docker compose, qemu-user-static(-binfmt) installed and the
#     docker and binfmt services enabled — x86_64 containers on an aarch64
#     host (and the other way round) run under user-mode emulation
#   - the invoking user in the docker group (a new login picks it up)
#   - compose.yml (with the `updater` service), register.sh and rollout.sh
#     (which only wakes the updater) copied to POOL_ROOT, .env with
#     POOL_ROOT and WHERE, and one etc/*.env per service to fill in (mode 600)
#   - the systemd user timer of a host from before #277
#     (omarchy-pool-rollout.timer and its service) disabled and removed:
#     the updater rolls the host out now, following the pool's release
#
# Run again on a host that has run the pool since before #277, it is the
# one-time step of the runbook's *The Studio host* (Once: the updater).
#
# It writes no secret: register.sh puts the worker tokens in etc/, and the
# agent key goes in etc/agent.env by hand.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 2; }
user="${SUDO_USER:-}"; [[ -n "$user" && "$user" != root ]] || { echo "run with sudo from your own user, not as root"; exit 2; }
root="${1:-/srv/omarchy-pool}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64

echo "==> $root"
if [[ ! -d "$root" ]]; then
  parent="$(dirname "$root")"; mkdir -p "$parent"
  if [[ "$(stat -f -c %T "$parent")" == btrfs ]]; then
    btrfs subvolume create "$root" >/dev/null && echo "    btrfs subvolume (outside the root's snapshots)"
  else
    mkdir -p "$root"
  fi
fi
for d in work cache/pacman/x86_64 cache/pacman/aarch64 cache/build/project/x86_64 cache/build/project/aarch64 cache/build/community/x86_64 cache/build/community/aarch64 etc; do mkdir -p "$root/$d"; done
chown -R "$user:$user" "$root"
chmod 700 "$root/etc"

echo "==> packages and services"
pacman -S --needed --noconfirm docker docker-compose qemu-user-static qemu-user-static-binfmt >/dev/null
systemctl enable --now docker >/dev/null 2>&1
systemctl restart systemd-binfmt >/dev/null 2>&1 || true
usermod -aG docker "$user"
other=x86_64; [[ "$arch" == x86_64 ]] && other=aarch64
if [[ -f "/proc/sys/fs/binfmt_misc/qemu-$other" ]]; then echo "    $other containers: emulated (binfmt)"; else echo "    WARNING: no binfmt handler for $other — $other builds will fail on this host" >&2; fi

echo "==> $root/compose.yml"
install -m 644 -o "$user" -g "$user" "$here/compose.yml" "$root/compose.yml"
install -m 755 -o "$user" -g "$user" "$here/register.sh" "$root/register.sh"
install -m 755 -o "$user" -g "$user" "$here/rollout.sh" "$root/rollout.sh"

echo "==> rolling upgrades: the updater service (compose.yml), no host timer"
# The updater (#277) follows the pool's release from inside the image. The
# user timer a host from before #277 ran rollout.sh with is retired, as the
# user who owns it: disabled, stopped and removed. One that somehow
# survives runs the new rollout.sh, which only wakes the updater.
home="$(getent passwd "$user" | cut -d: -f6)"
uid="$(id -u "$user")"
units="$home/.config/systemd/user"
if [[ -e "$units/omarchy-pool-rollout.timer" || -e "$units/omarchy-pool-rollout.service" ]]; then
  runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user disable --now omarchy-pool-rollout.timer >/dev/null 2>&1 || true
  rm -f "$units/omarchy-pool-rollout.timer" "$units/omarchy-pool-rollout.service"
  runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user daemon-reload >/dev/null 2>&1 || true
  echo "    omarchy-pool-rollout.timer retired (disabled, removed)"
fi
[[ -f "$root/.env" ]] || printf 'POOL_ROOT=%s\nWHERE=%s\n' "$root" "$(hostname -s)" > "$root/.env"
chown "$user:$user" "$root/.env"
for svc in pool-x86_64 pool-aarch64 review-x86_64 review-aarch64 community-x86_64 community-aarch64; do
  f="$root/etc/$svc.env"
  [[ -f "$f" ]] || printf '# %s — written by register.sh (the worker token, shown once by the pool)\nOMARCHY_WORKER_TOKEN=\n' "$svc" > "$f"
  chown "$user:$user" "$f"; chmod 600 "$f"
done
f="$root/etc/agent.env"
if [[ ! -f "$f" ]]; then
  cat > "$f" <<'AGENT'
# The agent the review and community workers run — your key, your cost; the
# pool never holds one. One provider is enough; FACTORY_MODEL picks the model.
GEMINI_API_KEY=
FACTORY_PROVIDER=gemini
FACTORY_MODEL=
# Reasoning models think first and the budget goes there: low keeps a Flash
# model's answers complete (and cheap). Unset for a model that rejects it.
FACTORY_REASONING=low
# Drafts read the upstream repository through GitHub's API: 60 requests an
# hour per address without a token, 5000 with one — a fine-grained token
# with no permissions at all is enough (public repositories only).
GITHUB_TOKEN=
#ANTHROPIC_API_KEY=
#OPENAI_API_KEY=
#XAI_API_KEY=
# Or a Claude subscription instead of a key: `claude setup-token` on a
# machine where Claude Code is logged in prints the token; the worker
# installs Claude Code at start and runs it in print mode (no tools). Set
# FACTORY_PROVIDER=claude-code when a key sits in this file too. Your
# subscription, your rate limits, your terms with Anthropic.
#CLAUDE_CODE_OAUTH_TOKEN=
AGENT
fi
chown "$user:$user" "$f"; chmod 600 "$f"

cat <<NEXT

Done. Next, as $user (log in again so the docker group applies):
  1. put your agent key in $root/etc/agent.env
  2. register the eight workers and trust the project's six:
       OMARCHY_CONTRIBUTOR_TOKEN=omc_… $root/register.sh        (a maintainer's token; from the profile page, shown once)
  3. cd $root && docker compose pull && docker compose up -d        (the only bare up -d: after it, ./rollout.sh)
  4. the Workers page lists them within a minute; the updater keeps them on the pool's release from then on

On a host that runs the pool already, the one-time step instead (runbook, The Studio host):
  cd $root && docker compose up -d --no-deps updater
NEXT
