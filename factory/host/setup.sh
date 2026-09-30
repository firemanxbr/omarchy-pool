#!/usr/bin/env bash
# setup.sh — prepares an Arch Linux host (Omarchy, Arch Linux ARM, Arch) to
# run the project's workers (compose.yml beside this script; RUNBOOK,
# *The Studio host*). Run once, as root:
#
#   sudo ./setup.sh [POOL_ROOT]          default POOL_ROOT: /srv/omarchy-pool
#
# What it does, all of it idempotent:
#   - POOL_ROOT: a btrfs subvolume when / is btrfs (outside the root's
#     snapshots), a directory otherwise; work/, cache/pacman/<arch>, etc/
#     owned by the user who ran sudo
#   - docker, docker compose, jq, qemu-user-static(-binfmt) installed and the
#     docker and binfmt services enabled — x86_64 containers on an aarch64
#     host (and the other way round) run under user-mode emulation
#   - the invoking user in the docker group (a new login picks it up)
#   - before anything of a running host changes, the new compose.yml checked
#     against a staged copy of this host's .env and etc/ (exit 4, nothing of
#     the host's files, units or containers changed, when it does not load,
#     under this host's profiles or under every profile it names, or when
#     .env's POOL_ROOT is another directory)
#   - compose.yml (with the `updater` service), register.sh and rollout.sh
#     (which only wakes the updater) copied to POOL_ROOT — the copies they
#     replace kept in POOL_ROOT/setup-backup-<time>/, and the difference in
#     compose.yml shown; .env with POOL_ROOT and WHERE; and one etc/*.env,
#     mode 600, for every env_file compose.yml names (read from the file, so
#     none is ever missing: compose refuses to load a project without one)
#   - the systemd user timer of a host from before #277
#     (omarchy-pool-rollout.timer and its service) retired, and the updater
#     started in its place — see below
#
# Run again on a host that has run the pool since before #277, it is the
# one-time step of the runbook's *The Studio host* (Once: the updater). Then,
# before the timer is touched, it also checks that the updater image here
# (pulled first) is one from #277 on and that every service compose would
# run holds a worker token (exit 4, and only that image pulled); stops the
# timer — stopped, not disabled, so a reboot at any point before the updater
# is confirmed brings it back — and waits while a rollout it started still
# drains (a drain takes up to 3 h; it waits up to 4 h); installs the files;
# starts the updater and checks it stays up and passes its --self-test; and
# only then disables the timer and removes its units. When any of that
# fails, or it is interrupted (INT, TERM, HUP, or its output gone: PIPE),
# once the timer was stopped: the updater it started is stopped and removed,
# the old files are put back and the timer is enabled and started again, so
# the host goes on rolling out through it (exit 3: the timer or its last
# rollout; exit 5: the updater; 130, 143, 129 or 141: the signal).
#
# It writes no secret: register.sh puts the worker tokens in etc/, and the
# agent key goes in etc/agent.env by hand.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 2; }
user="${SUDO_USER:-}"; [[ -n "$user" && "$user" != root ]] || { echo "run with sudo from your own user, not as root"; exit 2; }
root="${1:-/srv/omarchy-pool}"; root="${root%/}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64

# Every env file compose.yml names, from the file itself (`env_file: [etc/a.env, etc/b.env]`, the only form it uses): #198 added
# the review2 pair to compose.yml and not to a list here, and compose refuses to load a project whose env file is missing (#295).
flow_list() { # key → the entries of every `key: [a, b]` line of compose.yml, one a line, sorted, unique
  sed -nE "s/^[[:space:]]*$1:[[:space:]]*\\[(.*)\\][[:space:]]*(#.*)?\$/\\1/p" "$here/compose.yml" | tr ',' '\n' | tr -d " \"'" | sed '/^$/d' | sort -u
}
other_form="$(grep -E '^[[:space:]]*(env_file|profiles):' "$here/compose.yml" | grep -vE ':[[:space:]]*\[[^]]*\][[:space:]]*(#.*)?$' || true)"
[[ -z "$other_form" ]] || { echo "setup.sh reads env_file and profiles in compose.yml only as [a, b]: $(head -n1 <<<"$other_form")" >&2; exit 2; }
env_files="$(flow_list env_file)"
profiles="$(flow_list profiles)"
for rel in $env_files; do
  [[ "$rel" =~ ^etc/[A-Za-z0-9._-]+\.env$ ]] || { echo "compose.yml names an env file outside etc/: $rel" >&2; exit 2; }
done
env_text() { # etc/<name>.env → what setup.sh writes there before anyone fills it in
  if [[ "$1" == etc/agent.env ]]; then
    cat <<'AGENT'
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
  else
    printf '# %s — written by register.sh (the worker token, shown once by the pool)\nOMARCHY_WORKER_TOKEN=\n' "$(basename "$1" .env)"
  fi
}
env_default() { printf 'POOL_ROOT=%s\nWHERE=%s\n' "$root" "$(hostname -s)"; }

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
pacman -S --needed --noconfirm docker docker-compose jq qemu-user-static qemu-user-static-binfmt >/dev/null
systemctl enable --now docker >/dev/null 2>&1
systemctl restart systemd-binfmt >/dev/null 2>&1 || true
usermod -aG docker "$user"
other=x86_64; [[ "$arch" == x86_64 ]] && other=aarch64
if [[ -f "/proc/sys/fs/binfmt_misc/qemu-$other" ]]; then echo "    $other containers: emulated (binfmt)"; else echo "    WARNING: no binfmt handler for $other — $other builds will fail on this host" >&2; fi

home="$(getent passwd "$user" | cut -d: -f6)"
uid="$(id -u "$user")"
units="$home/.config/systemd/user"
user_systemctl() { runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user "$@"; }
# A unit's ActiveState as its user's systemd says it; empty when that systemd does not answer.
state_of() { user_systemctl show -p ActiveState --value "$1" 2>/dev/null || true; }
rolling() { [[ "$(state_of omarchy-pool-rollout.service)" =~ ^(active|activating|deactivating|reloading)$ ]]; }
# compose as the updater runs it: the project's .env and nothing of this shell's environment (COMPOSE_PROFILES among it).
compose_in() { local d="$1"; shift; env -i PATH="$PATH" HOME=/root docker compose --project-directory "$d" "$@"; }
# A host from before #277: the timer that ran the old rollout.sh is there.
migrating=0
[[ -e "$units/omarchy-pool-rollout.timer" || -e "$units/omarchy-pool-rollout.service" ]] && migrating=1

# What was done so far, and what the EXIT trap puts back when setup.sh ends before the updater is confirmed (see the top).
stage_dir=""; stopped=0; installed=0; started=0; retired=0; pulled=0; backup=""; created=()
# It runs with errexit off and SIGPIPE and SIGHUP ignored (the trap sets that): with its terminal or its reader gone, a message it
# cannot write fails that message alone, and every step still runs. The messages come after the steps they report.
put_back() {
  (( migrating && ! retired )) || return 0
  if (( started )); then
    # Before compose.yml goes back: compose leaves a running updater alone once the file no longer names it.
    compose_in "$root" stop updater >/dev/null 2>&1
    compose_in "$root" rm -f updater >/dev/null 2>&1
    echo "    the updater it started: stopped and removed" >&2
  fi
  if (( installed )); then
    local f rel
    for f in compose.yml rollout.sh register.sh; do
      if [[ -f "$backup/$f" ]]; then cp -p "$backup/$f" "$root/$f"; else rm -f "$root/$f"; fi
    done
    for rel in ${created[@]+"${created[@]}"}; do rm -f "$root/$rel"; done
    echo "    compose.yml, rollout.sh and register.sh: back as they were (copies in $backup)" >&2
  fi
  if (( stopped )); then
    # enable as well as start: a timer its operator disabled by hand, as an earlier exit 3 told them to, comes back after a reboot too.
    if user_systemctl enable --now omarchy-pool-rollout.timer >/dev/null 2>&1; then
      echo "    omarchy-pool-rollout.timer is enabled again: this host still rolls out through it" >&2
    else
      echo "    WARNING: omarchy-pool-rollout.timer could not be enabled again — as $user: systemctl --user enable --now omarchy-pool-rollout.timer" >&2
    fi
  fi
}
trap 'rc=$?; set +e; trap "" INT TERM HUP PIPE; put_back; [[ -z "$stage_dir" ]] || rm -rf "$stage_dir"; exit $rc' EXIT
# Every interrupt ends through the EXIT trap with its own code, never 0: a hung-up session (HUP) and a reader that is gone (PIPE,
# a `| tee` stopped by Ctrl-C) too — left to their default, a HUP runs it with $? 0 and a PIPE kills setup.sh with no trap at all.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 141' PIPE
refuse() { # why — before anything of the running host changed (only the updater image, once pulled)
  if (( pulled )); then
    printf '\nNot done, and nothing of the host'"'"'s files, units or containers changed (the updater image was pulled): %s\n' "$1" >&2
  else
    printf '\nNot done, and nothing changed: %s\n' "$1" >&2
  fi
  exit 4
}

echo "==> the new compose.yml, checked against this host's .env and etc/ before anything changes"
# A staged copy of the project: the new compose.yml, the host's override, .env and every env file there, and for each one that is
# not there yet what setup.sh would write — the directory named as the host's, so compose names the project the same.
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/omarchy-pool-setup.XXXXXX")"
stage="$stage_dir/$(basename "$root")"
mkdir -p "$stage/etc"
cp "$here/compose.yml" "$stage/compose.yml"
for f in compose.override.yml compose.override.yaml; do [[ ! -e "$root/$f" ]] || ln -s "$root/$f" "$stage/$f"; done
if [[ -f "$root/.env" ]]; then cp "$root/.env" "$stage/.env"; else env_default > "$stage/.env"; fi
for rel in $env_files; do
  if [[ -f "$root/$rel" ]]; then ln -s "$root/$rel" "$stage/$rel"; else env_text "$rel" > "$stage/$rel"; fi
done
out="$(compose_in "$stage" config -q 2>&1)" \
  || refuse "the new compose.yml does not load with this host's .env and etc/ ($(tail -n2 <<<"$out" | tr '\n' ' '))"
pflags=(); for p in $profiles; do pflags+=(--profile "$p"); done
out="$(compose_in "$stage" ${pflags[@]+"${pflags[@]}"} config -q 2>&1)" \
  || refuse "the new compose.yml does not load with every profile it names, $(tr '\n' ' ' <<<"$profiles")($(tail -n2 <<<"$out" | tr '\n' ' '))"
# The directory the updater mounts and recreates the services from is .env's POOL_ROOT (compose's default /srv/omarchy-pool).
pool_root="$(sed -nE 's/^[[:space:]]*POOL_ROOT[[:space:]]*=[[:space:]]*//p' "$stage/.env" | tail -n1 | tr -d "\"'")"
[[ "${pool_root:-/srv/omarchy-pool}" == "$root" ]] \
  || refuse "$root/.env says POOL_ROOT=${pool_root:-(nothing: /srv/omarchy-pool)}, not $root — the updater would mount and read another directory; fix .env or run setup.sh with that root"
echo "    it loads with this host's .env, etc/ and every profile ($(tr '\n' ' ' <<<"$profiles" | sed 's/ $//'))"
if (( migrating )); then
  # The updater that takes over must follow the pool (#277): an image from before it rounds every fifteen minutes and no more.
  out="$(compose_in "$stage" pull -q updater 2>&1)" || refuse "the updater's image did not pull ($(tail -n1 <<<"$out"))"
  pulled=1
  config="$(compose_in "$stage" config --format json 2>/dev/null)" || refuse "compose did not print the new project"
  image="$(jq -r '.services.updater.image // empty' <<<"$config")" || refuse "compose printed no project jq reads"
  [[ -n "$image" ]] || refuse "the new compose.yml names no updater image"
  follows="$(docker image inspect -f '{{index .Config.Labels "com.omarchy.updater.follows"}}' "$image" 2>/dev/null || true)"
  [[ "$follows" == 1 ]] || refuse "the updater image here, $image, is from before #277 (no com.omarchy.updater.follows=1): wait until the release that carries #277 is out, then run setup.sh again"
  # Every service compose would run under this host's profiles that reads a worker token has one (register.sh writes them): a
  # worker without one exits at start and restarts, and the updater never adopts a set where one does. The values are not printed.
  missing="$(jq -r '[.services | to_entries[] | select((.value.environment // {}) | has("OMARCHY_WORKER_TOKEN")) | select((.value.environment.OMARCHY_WORKER_TOKEN // "") | startswith("omw_") | not) | .key] | sort | map(. + " ") | add // ""' <<<"$config")" \
    || refuse "compose printed no project jq reads"
  [[ -z "$missing" ]] || refuse "no worker token for ${missing}— run register.sh (a maintainer's token) or leave those services out of COMPOSE_PROFILES in $root/.env"
  echo "    the updater image follows the pool, and every service it would run has its worker token"
fi

if (( migrating )); then
  echo "==> rolling upgrades: the updater service (compose.yml), no host timer"
  # The user timer a host from before #277 ran rollout.sh with is stopped,
  # as the user who owns it, before anything is installed: a rollout of the
  # old timer that is still running would read the new compose.yml and
  # start the updater beside itself. A rollout it started may still be
  # draining (a drain takes up to 3 h; the old rollout pulls and waits for
  # its brokers too): this waits up to 4 h for it to end, so the updater
  # never rounds beside it. The timer is stopped, not disabled, until the
  # updater is confirmed: a reboot, a power cut or a SIGKILL (no EXIT trap)
  # at any point before then brings it back with the host's systemd.
  timer_left=""
  if user_systemctl stop omarchy-pool-rollout.timer >/dev/null 2>&1; then stopped=1; fi
  waited=0
  while rolling && (( waited < 4 * 3600 )); do
    (( waited )) || echo "    the timer's last rollout still runs (a drain takes up to 3 h): waiting for it to end before the updater takes over"
    sleep 15; waited=$(( waited + 15 ))
  done
  state="$(state_of omarchy-pool-rollout.timer)"
  if [[ -z "$state" ]]; then
    timer_left="$user's systemd did not answer: nothing was changed there"
  elif rolling; then
    timer_left="its last rollout, omarchy-pool-rollout.service, still runs after 4 h"
  elif [[ "$state" != inactive ]]; then
    timer_left="$user's systemd says the timer is $state"
  else
    (( waited == 0 )) || echo "    it ended after about $(( waited / 60 )) min"
    echo "    omarchy-pool-rollout.timer stopped, not disabled (a reboot brings it back); disabled and removed once the updater runs"
  fi
  if [[ -n "$timer_left" ]]; then
    echo "    WARNING: omarchy-pool-rollout.timer is not retired: $timer_left" >&2
    if (( stopped )); then
      # Not done, and nothing installed; the EXIT trap enables the timer again, so the host goes on rolling out through it.
      printf '\nNot done, and nothing installed: the timer that ran the old rollout.sh is not retired (%s).\nIt is enabled again, so this host still rolls out through it. Run this setup.sh again once its last rollout has ended\n(systemctl --user status omarchy-pool-rollout.service, as %s).\n' "$timer_left" "$user" >&2
    else
      # Not done, and nothing installed: an updater started now would round beside the old timer's rollout.sh (the pool would say "two rollouts").
      cat >&2 <<LEFT

Not done, and nothing installed: the timer that ran the old rollout.sh is not retired ($timer_left).
Do not start the updater beside it. As $user: systemctl --user stop omarchy-pool-rollout.timer
(and systemctl --user stop omarchy-pool-rollout.service for a rollout that never ends), then run this setup.sh again.
LEFT
    fi
    exit 3
  fi
fi

echo "==> $root/compose.yml"
# What it replaces is kept: always on a host from before #277 (with the timer's units: the way back), and whenever one of the
# files differs from the new one — a host's copy may carry local edits, which belong in compose.override.yml instead.
changed=""
for f in compose.yml rollout.sh register.sh; do [[ ! -f "$root/$f" ]] || cmp -s "$here/$f" "$root/$f" || changed+="$f "; done
if (( migrating )) || [[ -n "$changed" ]]; then
  backup="$root/setup-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$backup"
  for f in compose.yml compose.override.yml rollout.sh register.sh .env; do [[ ! -f "$root/$f" ]] || cp -p "$root/$f" "$backup/$f"; done
  if (( migrating )); then
    mkdir -p "$backup/systemd-user"
    for f in omarchy-pool-rollout.timer omarchy-pool-rollout.service; do [[ ! -f "$units/$f" ]] || cp -p "$units/$f" "$backup/systemd-user/$f"; done
  fi
  chown -R "$user:$user" "$backup"
  echo "    the copies it replaces: $backup/"
  if [[ -f "$backup/compose.yml" ]] && ! cmp -s "$backup/compose.yml" "$here/compose.yml"; then
    # What the host's copy has that the new one does not comes first: a local edit among it is gone from compose.yml (kept in the copy).
    removed="$( { diff -u "$backup/compose.yml" "$here/compose.yml" || true; } | grep -E '^-' | grep -vE '^---' | head -n 60 || true)"
    echo "    compose.yml changes; all of it: diff -u $backup/compose.yml $root/compose.yml"
    if [[ -n "$removed" ]]; then
      echo "    lines of the host's copy that the new one does not have (the first 60):"
      sed 's/^/      /' <<<"$removed"
    fi
    echo "    Local changes belong in $root/compose.override.yml: compose and the updater read it, and setup.sh never touches it."
  fi
fi
installed=1
install -m 644 -o "$user" -g "$user" "$here/compose.yml" "$root/compose.yml"
install -m 755 -o "$user" -g "$user" "$here/register.sh" "$root/register.sh"
install -m 755 -o "$user" -g "$user" "$here/rollout.sh" "$root/rollout.sh"

[[ -f "$root/.env" ]] || env_default > "$root/.env"
chown "$user:$user" "$root/.env"
for rel in $env_files; do
  f="$root/$rel"
  if [[ ! -f "$f" ]]; then env_text "$rel" > "$f"; created+=("$rel"); fi
  chown "$user:$user" "$f"; chmod 600 "$f"
done
(( ${#created[@]} == 0 )) || echo "    written, to fill in: ${created[*]}"

if (( migrating )); then
  echo "==> the updater, started and checked before the timer's units go"
  started=1
  out="$(compose_in "$root" up -d --no-deps --no-recreate updater 2>&1)" \
    || { printf '\nNot done: the updater did not start (%s). Putting back what was here.\n' "$(tail -n2 <<<"$out" | tr '\n' ' ')" >&2; exit 5; }
  cid="$(compose_in "$root" ps -a -q updater 2>/dev/null | head -n1)"
  [[ -n "$cid" ]] || { printf '\nNot done: compose started no updater container. Putting back what was here.\n' >&2; exit 5; }
  # It stays up: running, and not restarted, at every look for 30 s.
  first=""
  for i in 0 1 2 3 4 5 6; do
    look="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$cid" 2>/dev/null || echo "gone -")"
    [[ -n "$first" ]] || first="${look#* }"
    [[ "${look%% *}" == running && "${look#* }" == "$first" ]] \
      || { printf '\nNot done: the updater does not stay up (%s; docker compose logs updater). Putting back what was here.\n' "$look" >&2; exit 5; }
    (( i == 6 )) || sleep 5
  done
  # Its own check, as it runs: the runtime's socket answers, compose reads this directory, and it follows the pool.
  out="$(compose_in "$root" exec -T updater /usr/local/lib/omarchy-factory/bin/omarchy-rollout --self-test 2>&1)" && grep -qx 'follows 1' <<<"$out" \
    || { printf '\nNot done: the updater fails its self-test (%s). Putting back what was here.\n' "$(tail -n1 <<<"$out")" >&2; exit 5; }
  echo "    the updater runs, stays up and passes its self-test"
  # From here on, nothing is put back: the updater rolls the host out. Only now is the timer disabled (it was stopped) and removed.
  retired=1
  user_systemctl disable --now omarchy-pool-rollout.timer >/dev/null 2>&1 || true
  rm -f "$units/omarchy-pool-rollout.timer" "$units/omarchy-pool-rollout.service"
  user_systemctl daemon-reload >/dev/null 2>&1 || true
  state="$(state_of omarchy-pool-rollout.timer)"
  if [[ "$state" == inactive ]]; then echo "    omarchy-pool-rollout.timer retired (stopped, disabled, removed)"
  else
    # One that somehow survives runs the new rollout.sh, which only wakes the updater.
    echo "    WARNING: $user's systemd says omarchy-pool-rollout.timer is ${state:-nothing (it stopped answering)} after its units were removed. It runs the new rollout.sh, which only wakes the updater; as $user, when it answers: systemctl --user disable --now omarchy-pool-rollout.timer" >&2
  fi
  cat <<DONE

Done: the updater rolls this host out now, following the pool's release, and its first round runs at once.
  cd $root && ./rollout.sh        (from now on only wakes the updater: a round now)
  docker compose logs -f updater  (its rounds)
The way back, should it misbehave here: the runbook's The Studio host (Once: the updater), from $backup/.
DONE
  exit 0
fi

cat <<NEXT

Done. Next, as $user (log in again so the docker group applies):
  1. put your agent key in $root/etc/agent.env
  2. register the workers and trust the project's:
       OMARCHY_CONTRIBUTOR_TOKEN=omc_… $root/register.sh        (a maintainer's token; from the profile page, shown once)
  3. cd $root && docker compose pull && docker compose up -d        (the only bare up -d: after it, ./rollout.sh)
  4. the Workers page lists them within a minute; the updater keeps them on the pool's release from then on

On a host that runs the pool already: cd $root && ./rollout.sh        (starts the updater if it is not running, or wakes it)
NEXT
