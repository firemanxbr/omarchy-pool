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
#     .env's POOL_ROOT is another directory, or .env's COMPOSE_FILE names a
#     file by an absolute or ../ path); a container of the project whose
#     service it does not run under this host's profiles is warned about (no
#     rollout reaches it)
#   - one run at a time: a second one while another holds
#     POOL_ROOT/.setup.lock is refused (exit 4, nothing changed)
#   - compose.yml (with the `updater` service), register.sh and rollout.sh
#     (which only wakes the updater) copied to POOL_ROOT — the copies they
#     replace kept in POOL_ROOT/setup-backup-<time>/, and the difference in
#     compose.yml shown; .env with POOL_ROOT and WHERE; and one etc/*.env,
#     mode 600, for every env_file compose.yml names (read from the file, so
#     none is ever missing: compose refuses to load a project without one),
#     the ones it wrote listed in the backup's created-env-files
#   - the systemd user timer of a host from before #277
#     (omarchy-pool-rollout.timer and its service) retired, and the updater
#     started in its place — see below
#
# Run again on a host that has run the pool since before #277, it is the
# one-time step of the runbook's *The Studio host* (Once: the updater). Then,
# before the timer is touched, it also checks that the updater image here
# (pulled first) is one from #277 on, that every service compose would
# run holds a worker token and that no rollout.sh started by hand still
# runs (exit 4, and only that image pulled); stops the
# timer — stopped, not disabled, so a reboot at any point before the updater
# is confirmed brings it back — and waits while a rollout it started still
# drains (a drain takes up to 3 h; it waits up to 4 h); installs the files;
# starts the updater and checks it stays up and passes its --self-test; and
# only then disables the timer and removes its units. When any of that
# fails, or it is interrupted (INT, TERM, HUP, or its output gone: PIPE),
# once the timer was stopped: the updater it started is stopped and removed,
# the old files are put back and the timer is enabled and started again, so
# the host goes on rolling out through it (exit 3: the timer or its last
# rollout; exit 5: the updater; 130, 143, 129 or 141: the signal). When the
# updater cannot be confirmed stopped (docker does not answer, or it still
# runs) or an old file does not copy back, the new files stay instead
# (their rollout.sh only wakes or starts the updater) and the timer is enabled all
# the same: never both rollouts, never neither. The put-back's docker and
# systemctl calls each end within 60 s.
#
# A step killed outright (kill -9, the OOM killer, a reboot) puts nothing
# back; run again while the new files it installed are in, setup.sh refuses
# (exit 4) before anything else, and points to the runbook's way back.
#
# It writes no secret: register.sh puts the worker tokens in etc/, and the
# agent key goes in etc/agent.env by hand.
#
# A POOL_ROOT the host agent retired carries its marker, .omarchy-agent
# (#313): setup.sh refuses there (exit 4) before it changes anything — the
# agent manages this machine, and this set stays retired.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 2; }
user="${SUDO_USER:-}"; [[ -n "$user" && "$user" != root ]] || { echo "run with sudo from your own user, not as root"; exit 2; }
root="${1:-/srv/omarchy-pool}"; root="${root%/}"
[[ ! -e "$root/.omarchy-agent" ]] || { printf '\nNot done, and nothing changed: this machine is a maintainer host managed by omarchy-agent, which retired this set (%s) — nothing needs to be run here; see: omarchy-agent status\n' "$root/.omarchy-agent" >&2; exit 4; }
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
pulled=0
refuse() { # why — before anything of the running host changed (only the updater image, once pulled)
  if (( pulled )); then
    printf '\nNot done, and nothing of the host'"'"'s files, units or containers changed (the updater image was pulled): %s\n' "$1" >&2
  else
    printf '\nNot done, and nothing changed: %s\n' "$1" >&2
  fi
  exit 4
}

echo "==> $root"
if [[ ! -d "$root" ]]; then
  parent="$(dirname "$root")"; mkdir -p "$parent"
  if [[ "$(stat -f -c %T "$parent")" == btrfs ]]; then
    btrfs subvolume create "$root" >/dev/null && echo "    btrfs subvolume (outside the root's snapshots)"
  else
    mkdir -p "$root"
  fi
fi
# One run at a time: a second paste (another tmux window, during the wait of up to 4 h) would interleave its backup, install and
# put-back with this one's.
exec 9>"$root/.setup.lock"
flock -n 9 || refuse "another setup.sh runs on $root (it holds $root/.setup.lock)"
home="$(getent passwd "$user" | cut -d: -f6)"
uid="$(id -u "$user")"
units="$home/.config/systemd/user"
# A host from before #277: the timer that ran the old rollout.sh is there.
migrating=0
[[ -e "$units/omarchy-pool-rollout.timer" || -e "$units/omarchy-pool-rollout.service" ]] && migrating=1
# The first check of the one-time step: a step killed outright (kill -9, the OOM killer, a reboot) after it installed a file left
# the new files in, or some of them. Run again from there, its backup, its put-back and its messages would all take the new files
# for the host's own. No release before #277 has the updater in compose.yml, so this never refuses a host that was not touched.
if (( migrating )) && { grep -q '^  updater:' "$root/compose.yml" 2>/dev/null || grep -qx '# omarchy-rollout: kick-v1' "$root/rollout.sh" 2>/dev/null; }; then
  refuse "a killed step (or a put-back that kept them) left the new files in $root (the timer may be stopped): take the runbook's way back (The Studio host, Once: the updater), then paste again"
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

# The put-back's docker, compose and systemctl calls: each ends within 60 s (a timeout counts as no answer). Set in put_back only:
# timeout runs a command, not a shell function, so it goes on the commands inside these. timeout runs them in a process group of their
# own, so a Ctrl-C at the terminal does not reach them: this bound is what ends a call that hangs.
limit=()
user_systemctl() { ${limit[@]+"${limit[@]}"} runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user "$@"; }
# A unit's ActiveState as its user's systemd says it; empty when that systemd does not answer.
state_of() { user_systemctl show -p ActiveState --value "$1" 2>/dev/null || true; }
rolling() { [[ "$(state_of omarchy-pool-rollout.service)" =~ ^(active|activating|deactivating|reloading)$ ]]; }
# compose as the updater runs it: the project's .env and nothing of this shell's environment (COMPOSE_PROFILES among it).
compose_in() { local d="$1"; shift; ${limit[@]+"${limit[@]}"} env -i PATH="$PATH" HOME=/root docker compose --project-directory "$d" "$@"; }

# What was done so far, and what the EXIT trap puts back when setup.sh ends before the updater is confirmed (see the top).
stage_dir=""; stopped=0; installed=0; started=0; retired=0; backup=""; created=()
# It runs with errexit off and INT, TERM, HUP and PIPE caught by a handler that does nothing (the trap sets that): with its terminal
# or its reader gone, a message it cannot write fails that message alone, and every step still runs. Caught, not ignored: its
# children start with those signals at their default. The messages come after the steps they report.
put_back() {
  (( migrating && ! retired )) || return 0
  limit=(timeout "${SETUP_PUT_BACK_TIMEOUT:-60}")
  local keep="" f rel ids
  if (( started )); then
    # Before compose.yml goes back: compose leaves a running updater alone once the file no longer names it.
    compose_in "$root" stop updater >/dev/null 2>&1
    compose_in "$root" rm -f updater >/dev/null 2>&1
    # Confirmed by its labels (running containers only). One that still runs, or an engine that does not answer, keeps the new
    # files, whose rollout.sh only wakes or starts the updater: the old rollout.sh never rolls out beside it (restart: unless-stopped).
    if ids="$("${limit[@]}" docker ps -q --filter "label=com.docker.compose.project=${project:-$(basename "$root")}" --filter label=com.docker.compose.service=updater 2>/dev/null)" && [[ -z "$ids" ]]; then
      # Its first round starts at once, and may be in the middle of a worker's drain: that worker finishes its drain (up to 3 h),
      # and the timer's next rollout then starts what is not running.
      echo "    the updater it started: stopped and removed (a worker its first round was draining finishes its drain, up to 3 h, and the timer's next rollout then starts it: up to about 3 h 20 min)" >&2
    else
      keep="the updater it started could not be confirmed stopped (docker did not answer, or it still runs)"
    fi
  fi
  if (( installed )); then
    # Each old file copied beside its place first, and renamed into it only once all of them copied: never one old file beside a
    # new one.
    if [[ -z "$keep" ]]; then
      for f in compose.yml rollout.sh register.sh; do
        [[ ! -f "$backup/$f" ]] || cp -p "$backup/$f" "$root/.$f.put-back" || { keep="$f did not come back from $backup"; break; }
      done
    fi
    if [[ -z "$keep" ]]; then
      for f in compose.yml rollout.sh register.sh; do
        if [[ -f "$backup/$f" ]]; then mv -f "$root/.$f.put-back" "$root/$f"; else rm -f "$root/$f"; fi
      done
      for rel in ${created[@]+"${created[@]}"}; do rm -f "$root/$rel"; done
      echo "    compose.yml, rollout.sh and register.sh: back as they were (copies in $backup)" >&2
    else
      rm -f "$root/.compose.yml.put-back" "$root/.rollout.sh.put-back" "$root/.register.sh.put-back"
      echo "    WARNING: $keep. The new compose.yml, rollout.sh and register.sh stay (their rollout.sh only wakes or starts the updater). Once that is fixed (docker answers, or the copy can succeed), take the runbook's way back (The Studio host, Once: the updater); setup.sh refuses to run again until then" >&2
    fi
  fi
  if (( stopped )); then
    # enable as well as start: a timer its operator disabled by hand, as an earlier exit 3 told them to, comes back after a reboot too.
    if user_systemctl enable --now omarchy-pool-rollout.timer >/dev/null 2>&1; then
      if [[ -n "$keep" ]]; then echo "    omarchy-pool-rollout.timer is enabled again: it runs the new rollout.sh, which only wakes or starts the updater" >&2
      else echo "    omarchy-pool-rollout.timer is enabled again: this host still rolls out through it" >&2; fi
    else
      echo "    WARNING: omarchy-pool-rollout.timer could not be enabled again — as $user: systemctl --user enable --now omarchy-pool-rollout.timer" >&2
    fi
  fi
}
trap 'rc=$?; set +e; trap : INT TERM HUP PIPE; put_back; [[ -z "$stage_dir" ]] || rm -rf "$stage_dir"; exit $rc' EXIT
# Every interrupt ends through the EXIT trap with its own code, never 0: a hung-up session (HUP) and a reader that is gone (PIPE,
# a `| tee` stopped by Ctrl-C) too — left to their default, a HUP runs it with $? 0 and a PIPE kills setup.sh with no trap at all.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 141' PIPE

echo "==> the new compose.yml, checked against this host's .env and etc/ before anything changes"
# A staged copy of the project: the new compose.yml, a copy of .env, and a link to everything else of the host's directory and of
# its etc/ — an override's own env_file, a file COMPOSE_FILE or an `extends:` names resolve there as they do in the host's — then,
# for each env file compose.yml names that is not there yet, what setup.sh would write. The directory is named as the host's, so
# compose names the project the same.
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/omarchy-pool-setup.XXXXXX")"
stage="$stage_dir/$(basename "$root")"
mkdir -p "$stage/etc"
cp "$here/compose.yml" "$stage/compose.yml"
if [[ -f "$root/.env" ]]; then cp "$root/.env" "$stage/.env"; else env_default > "$stage/.env"; fi
# .env's COMPOSE_FILE names compose files relative to the project directory, here the staged copy's. One named by an absolute path
# would not be the staged file (into POOL_ROOT: the host's old compose.yml would be checked), and one named by ../ resolves beside
# the stage, where it is not.
compose_file="$(sed -nE 's/^[[:space:]]*COMPOSE_FILE[[:space:]]*=[[:space:]]*//p' "$stage/.env" | tail -n1 | tr -d "\"'")"
case ":$compose_file" in
  *:/*|*:../*) refuse "$root/.env's COMPOSE_FILE=$compose_file names a file by an absolute or ../ path, which the check of the new compose.yml cannot follow: name the files relative to $root (COMPOSE_FILE=compose.yml:compose.override.yml, say), then run setup.sh again" ;;
esac
for p in "$root"/* "$root"/.[!.]* "$root"/etc/* "$root"/etc/.[!.]*; do
  [[ -e "$p" || -L "$p" ]] || continue
  rel="${p#"$root"/}"
  case "$rel" in compose.yml|compose.yaml|docker-compose.yml|docker-compose.yaml|.env|etc|setup-backup-*) continue ;; esac
  ln -s "$p" "$stage/$rel"
done
for rel in $env_files; do
  [[ -e "$stage/$rel" || -L "$stage/$rel" ]] || env_text "$rel" > "$stage/$rel"
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
config="$(compose_in "$stage" config --format json 2>/dev/null)" || refuse "compose did not print the new project"
# A container of this project whose service the new compose.yml does not run under this host's profiles (review2 moved behind a
# profile of its own, for one) keeps running on its image, outside every rollout: said, with what brings it back in.
project="$(jq -r '.name // empty' <<<"$config")" || refuse "compose printed no project jq reads"
services="$(jq -r '.services | keys[]' <<<"$config")" || refuse "compose printed no project jq reads"
left=""
if [[ -n "$project" ]]; then
  for svc in $(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.Label "com.docker.compose.service"}}' 2>/dev/null | sort -u); do
    grep -qxF -- "$svc" <<<"$services" || left+="$svc "
  done
fi
[[ -z "$left" ]] || echo "    WARNING: containers of services the new compose.yml does not run under this host's profiles: ${left}— they keep running on their image and no rollout reaches them. Add their profile to COMPOSE_PROFILES in $root/.env (review2: once etc/review2-*.env hold its tokens), or remove them (docker ps -a --filter label=com.docker.compose.service=<service>, then docker rm -f <that container>)." >&2
if (( migrating )); then
  # The updater that takes over must follow the pool (#277): an image from before it rounds every fifteen minutes and no more.
  out="$(compose_in "$stage" pull -q updater 2>&1)" || refuse "the updater's image did not pull ($(tail -n1 <<<"$out"))"
  pulled=1
  image="$(jq -r '.services.updater.image // empty' <<<"$config")" || refuse "compose printed no project jq reads"
  [[ -n "$image" ]] || refuse "the new compose.yml names no updater image"
  follows="$(docker image inspect -f '{{index .Config.Labels "com.omarchy.updater.follows"}}' "$image" 2>/dev/null || true)"
  [[ "$follows" == 1 ]] || refuse "the updater image here, $image, is from before #277 (no com.omarchy.updater.follows=1): wait until the release that carries #277 is out, then run setup.sh again"
  # Every service compose would run under this host's profiles that reads a worker token has one (register.sh writes them): a
  # worker without one exits at start and restarts, and the updater never adopts a set where one does. The values are not printed.
  missing="$(jq -r '[.services | to_entries[] | select((.value.environment // {}) | has("OMARCHY_WORKER_TOKEN")) | select((.value.environment.OMARCHY_WORKER_TOKEN // "") | startswith("omw_") | not) | .key] | sort | map(. + " ") | add // ""' <<<"$config")" \
    || refuse "compose printed no project jq reads"
  [[ -z "$missing" ]] || refuse "no worker token for ${missing}— run register.sh (a maintainer's token) for the community pair, or leave those services out of COMPOSE_PROFILES in $root/.env; a project service (pool, review, review2) is registered no more since #343, its work is a maintainer host's: https://omarchy-pool.org/docs/worker-host#maintainer-hosts"
  # A rollout.sh started by hand (not the timer's, which is waited for below) would drain beside the updater's first round.
  hand="$(pgrep -f 'rollout\.sh' | tr '\n' ' ' || true)"
  [[ -z "$hand" ]] || rolling || refuse "a rollout.sh runs outside the timer (pids ${hand}— pgrep -af rollout.sh): let it end, or stop it, then run setup.sh again"
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
  # updater is confirmed: a reboot or a power cut at any point before then
  # brings it back with the host's systemd. A SIGKILL (no EXIT trap) leaves
  # it stopped until the next reboot, or until its user starts it again —
  # only while no new file is in: the runbook says which, and sends a host
  # with the new files in to the way back.
  timer_left=""
  # Counted as stopped before the stop, whatever it answers: a signal during the stop runs the EXIT trap before anything after
  # it, and a client that timed out while systemd carried the stop out left the timer stopped all the same. The put-back's
  # enable --now costs nothing on a timer that never stopped. In a subshell, so no redirection of a function call is in effect
  # when the trap runs the put-back.
  stopped=1; stop_ok=0
  if ( user_systemctl stop omarchy-pool-rollout.timer ) >/dev/null 2>&1; then stop_ok=1; fi
  waited=0
  while rolling && (( waited < 4 * 3600 )); do
    (( waited )) || echo "    the timer's last rollout still runs (a drain takes up to 3 h): waiting for it to end before the updater takes over"
    sleep 15; waited=$(( waited + 15 ))
  done
  state="$(state_of omarchy-pool-rollout.timer)"
  if [[ -z "$state" ]]; then
    if (( stop_ok )); then timer_left="$user's systemd stopped answering after the timer was stopped"
    else timer_left="$user's systemd did not answer, and its stop of the timer may have taken all the same"; fi
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
    # Not done, and nothing installed; the EXIT trap enables the timer again, so the host goes on rolling out through it.
    printf '\nNot done, and nothing installed: the timer that ran the old rollout.sh is not retired (%s).\nIt is being enabled again (see below), so this host rolls out through it. Run this setup.sh again once its last rollout has ended\n(systemctl --user status omarchy-pool-rollout.service, as %s).\n' "$timer_left" "$user" >&2
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
# The way back removes the ones it wrote that are still the untouched placeholder: an older compose.yml put back must not find a
# placeholder for a pair nobody registered, and start it. Listed in the backup before any of them is written, so a kill in between
# leaves none that nothing lists; and each counted in created before it is written, so the put-back removes one an interrupt
# catches right after its write.
todo=()
for rel in $env_files; do [[ -f "$root/$rel" ]] || todo+=("$rel"); done
if [[ -n "$backup" ]] && (( ${#todo[@]} )); then printf '%s\n' "${todo[@]}" > "$backup/created-env-files"; chown "$user:$user" "$backup/created-env-files"; fi
for rel in $env_files; do
  f="$root/$rel"
  if [[ ! -f "$f" ]]; then created+=("$rel"); env_text "$rel" > "$f"; fi
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
  2. register the community pair (since #343 the project's services are a maintainer host's work, not registered here):
       OMARCHY_CONTRIBUTOR_TOKEN=omc_… $root/register.sh        (a maintainer's token; from the profile page, shown once)
  3. cd $root && docker compose pull && docker compose up -d        (the only bare up -d: after it, ./rollout.sh)
  4. the Workers page lists them within a minute; the updater keeps them on the pool's release from then on

On a host that runs the pool already: cd $root && ./rollout.sh        (starts the updater if it is not running, or wakes it)
NEXT
