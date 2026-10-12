#!/usr/bin/env bash
# prep-root.sh — the root-only steps a new maintainer host needs once before
# the host agent installs (design v2 §4.1, §7.5, §9.4, §19.1; epic #307).
# A person runs it; the agent never does: the agent only reports what is
# missing ("needs a person", set.toml [needs]). Arch Linux (and Arch Linux
# ARM) or Ubuntu LTS, as root:
#
#   sudo factory/host/prep-root.sh --user omarchy --work-root /srv/omarchy-pool/host \
#     [--runtime rootful|rootless] \
#     [--task-subnets 10.231.0.0/16[,…]] [--address-pool 172.16.0.0/12] \
#     [--remap-existing-daemon] [--dry-run]
#
#   --user          the Unix user the agent runs as, required: never root, and
#                   best never a person's daily login (rootful puts it in the
#                   docker group, root-equivalent; design v2 §19.1)
#   --runtime       rootful: docker's system daemon (default); rootless: podman
#                   as that user (a shared machine, design v2 §19.1, 2.)
#   --task-subnets  what the agent's --task-subnets will be (default 10.231.0.0/16)
#   --address-pool  the base of docker's default address pools, cut in /24s
#                   (default 172.16.0.0/12); a network address (no host bits),
#                   not overlapping the task subnets
#   --remap-existing-daemon
#                   rootful: turn userns-remap on (step 5) for a docker daemon that
#                   already holds images or containers, once none of them runs (#407).
#                   The remapped daemon starts empty, in a data root of its own
#                   (<data root>/<uid>.<gid>, and its own containerd namespace), and
#                   never looks at the old one, which stays as it is: the way back is
#                   daemon.json as it was, kept as daemon.json.pre-remap, and a
#                   restart. Refused (exit 3, nothing changed) while the agent runs as
#                   --user (its round starts a stopped dispatcher again) or a container
#                   runs, when docker does not answer, or when daemon.json cannot take it
#   --dry-run       say what would change, change nothing (with
#                   --remap-existing-daemon, refused the same way)
#
# Each step, idempotent (a second run changes nothing), and nothing else:
#   1. packages: the runtime, qemu-user-static with its binfmt handlers,
#      btrfs-progs, jq (and the runtime's service enabled); tpm2-tools where
#      the machine has a TPM (/dev/tpmrm0), for the host key (#330)
#   2. rootful: the user in the docker group; a TPM: the user in the tss
#      group, which opens /dev/tpmrm0 — before linger (7.) starts its user
#      manager, which keeps the groups it started with; one running without
#      the group is said under "needs a person" (restart it, or reboot), on
#      every run until it has it
#   3. binfmt: the foreign architecture's qemu handler, with the F flag so
#      containers use it (for the emulated lane, design v2 §7.5)
#   4. rootful: docker's default address pools (daemon.json), so its own
#      networks never take the task subnets
#   5. rootful: userns-remap (daemon.json), on a new daemon (no container
#      and no image yet), or with --remap-existing-daemon on one that holds
#      them while none runs (#407): turning it on changes the data root and
#      leaves what is there behind, so without the flag an existing daemon is
#      left as it is and said (design v2 §19.1); docker restarted only when
#      no container runs, and with the flag docker info must then list
#      name=userns; a docker that does not start again, or starts without
#      it, is said under "needs a person" with the way back, and the steps
#      after still run. The daemon.json it had is kept beside it as
#      daemon.json.pre-remap, and the old data root is said: both are the way
#      back. First the dockremap user, with a subordinate range of its own in
#      /etc/subuid and /etc/subgid (#405): without one docker makes the user
#      and takes 100000-165535, the default range of the host's first user,
#      whose own may be added later. The agent reads this range for the one
#      remapped uid its sidecars read the keys as (65533 in, which agent.env's
#      ACL names)
#   6. the work root: a btrfs subvolume when its parent is btrfs (outside the
#      root's snapshots), a directory otherwise; owned by the user, 0750; a
#      symlink is refused (root would hand its target to the user)
#   7. linger for the user, so its systemd --user unit runs without a login
#   8. rootless: cgroup v2 delegation (cpu, cpuset, io, memory, pids) to the
#      user's systemd, so task limits hold
#   9. rootful: DOCKER-USER drop rules from the task subnets to RFC 1918,
#      CGNAT (100.64.0.0/10, Tailscale's range) and link-local addresses, and
#      an INPUT drop from them to the host, kept across reboots by
#      omarchy-task-firewall.service (design v2 §9.4), and applied again
#      after a restart of docker here. IPv4 only: task networks are IPv4
#      (nothing here turns IPv6 on for them)
#
# Exit status: 0 done (or nothing to do), 1 done but something needs a person
# (listed at the end), 2 usage, or not root, 3 --remap-existing-daemon
# refused before anything changed.
set -euo pipefail

# The filesystem's root, for tests/prep-root.sh only (it runs this script against a temporary directory).
fs="${OMARCHY_PREP_FS:-}"

usage() {
  cat >&2 <<'EOF_USAGE'
usage: prep-root.sh --user <name> --work-root <path> [--runtime rootful|rootless]
                    [--task-subnets <cidr>[,<cidr>…]] [--address-pool <cidr>]
                    [--remap-existing-daemon] [--dry-run]
EOF_USAGE
  exit 2
}

user=""
runtime=rootful
work_root=""
task_subnets="10.231.0.0/16"
address_pool="172.16.0.0/12"
dry=0
remap_existing=0
while (($#)); do
  case "$1" in
    --user) user="${2:?}"; shift 2 ;;
    --runtime) runtime="${2:?}"; shift 2 ;;
    --work-root) work_root="${2:?}"; shift 2 ;;
    --task-subnets) task_subnets="${2:?}"; shift 2 ;;
    --address-pool) address_pool="${2:?}"; shift 2 ;;
    --remap-existing-daemon) remap_existing=1; shift ;;
    --dry-run) dry=1; shift ;;
    -h | --help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "prep-root.sh: run as root (sudo)" >&2; exit 2; }
[[ -n "$user" && "$user" != root ]] || { echo "prep-root.sh: --user: the agent's own user, required, never root" >&2; exit 2; }
id -u "$user" >/dev/null 2>&1 || { echo "prep-root.sh: no user $user (create it first)" >&2; exit 2; }
[[ "$runtime" == rootful || "$runtime" == rootless ]] || { echo "prep-root.sh: --runtime is rootful or rootless" >&2; exit 2; }
((remap_existing == 0)) || [[ "$runtime" == rootful ]] \
  || { echo "prep-root.sh: --remap-existing-daemon is for docker's system daemon (--runtime rootful)" >&2; exit 2; }
[[ "$work_root" == /* && "$work_root" != */../* && "$work_root" != */.. && "$work_root" != / ]] \
  || { echo "prep-root.sh: --work-root: an absolute path" >&2; exit 2; }
[[ ! -L "$fs$work_root" ]] || { echo "prep-root.sh: --work-root: $work_root is a symlink; give the real path" >&2; exit 2; }
cidr='^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'
IFS=, read -r -a subnets <<<"$task_subnets"
((${#subnets[@]})) || { echo "prep-root.sh: --task-subnets: at least one" >&2; exit 2; }
for s in "${subnets[@]}" "$address_pool"; do
  [[ "$s" =~ $cidr ]] || { echo "prep-root.sh: $s is not an IPv4 CIDR" >&2; exit 2; }
done
ip2int() { local IFS=.; local -a o; read -r -a o <<<"$1"; echo $(((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3])); }
overlaps() { # two CIDRs share an address
  local a="${1%/*}" b="${2%/*}" m="${1#*/}"
  ((${2#*/} < m)) && m="${2#*/}"
  (($(ip2int "$a") >> (32 - m) == $(ip2int "$b") >> (32 - m)))
}
pool_bits="${address_pool#*/}"
((pool_bits <= 32 && ($(ip2int "${address_pool%/*}") & ((1 << (32 - pool_bits)) - 1)) == 0)) \
  || { echo "prep-root.sh: --address-pool: $address_pool has host bits set (a network address, e.g. 172.16.0.0/12)" >&2; exit 2; }
for s in "${subnets[@]}"; do
  if overlaps "$s" "$address_pool"; then
    echo "prep-root.sh: the task subnet $s overlaps docker's address pool $address_pool" >&2; exit 2
  fi
done

attention=()
docker_restarted=0
changed() { echo "    $*"; }
run() { # a command that changes the host
  if ((dry)); then echo "    would run: $*"; else "$@"; fi
}
# put <path> <mode> <content>: written only when it differs; returns 0 when it changed (or would).
put() {
  local path="$fs$1" mode="$2" content="$3"
  if [[ -f "$path" ]] && [[ "$(cat "$path")" == "$content" ]]; then return 1; fi
  if ((dry)); then echo "    would write $1"; return 0; fi
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$content" >"$path.prep-root.tmp"
  chmod "$mode" "$path.prep-root.tmp"
  mv "$path.prep-root.tmp" "$path"
  echo "    wrote $1"
}

# dockremap: the user docker's "userns-remap": "default" remaps to, made here with a subordinate
# range of its own (#405) before docker would make it with 100000-165535, the default range of the
# host's first user. Its 65536 ids start past every range /etc/subuid and /etc/subgid list, and
# never below 165536 (past that first user's default); the same in both files. The agent reads it
# for the one remapped uid its sidecars read the keys as. One that has a range keeps it.
dockremap() {
  local start=165536 f s n add=()
  if getent passwd dockremap >/dev/null; then
    echo "    the dockremap user: there"
  else
    run useradd --system --user-group --no-create-home --shell /bin/false dockremap
    changed "the dockremap user (docker's userns-remap: default)"
  fi
  for f in /etc/subuid /etc/subgid; do
    [[ -r "$fs$f" ]] || continue
    while IFS=: read -r _ s n; do
      if [[ "$s" =~ ^[0-9]+$ && "$n" =~ ^[0-9]+$ ]] && ((s + n > start)); then start=$((s + n)); fi
    done < "$fs$f"
  done
  grep -qs '^dockremap:' "$fs/etc/subuid" || add+=(--add-subuids "$start-$((start + 65535))")
  grep -qs '^dockremap:' "$fs/etc/subgid" || add+=(--add-subgids "$start-$((start + 65535))")
  if ((${#add[@]} == 0)); then
    echo "    dockremap's subordinate ids: $(grep -h '^dockremap:' "$fs/etc/subuid" | head -n1 | cut -d: -f2-), its own"
    return
  fi
  for f in /etc/subuid /etc/subgid; do
    [[ -e "$fs$f" ]] || run install -m 0644 /dev/null "$fs$f"
  done
  if run usermod "${add[@]}" dockremap; then
    changed "dockremap's subordinate ids: $start-$((start + 65535)), its own (the agent sidecars read the keys as one of them)"
  else
    attention+=("dockremap: its subordinate ids were not added (usermod ${add[*]}); docker takes a range of its own when it starts")
  fi
}

distro=""
if [[ -r "$fs/etc/os-release" ]]; then
  # os-release, under the test's root too.
  # shellcheck disable=SC1090,SC1091
  distro="$(. "$fs/etc/os-release"; echo "${ID:-} ${ID_LIKE:-}")"
fi
case " $distro " in
  *" arch "* | *" archarm "*) distro=arch ;;
  *" ubuntu "* | *" debian "*) distro=ubuntu ;;
  *) echo "prep-root.sh: Arch Linux or Ubuntu LTS only (/etc/os-release: ${distro:-none})" >&2; exit 2 ;;
esac
arch="$(uname -m)"
case "$arch" in
  aarch64 | arm64) arch=aarch64; foreign=x86_64 ;;
  x86_64) foreign=aarch64 ;;
  *) echo "prep-root.sh: $arch hosts are not supported" >&2; exit 2 ;;
esac

# A TPM behind the kernel's resource manager: the agent makes the host key in it (#330).
tpm=0
[[ -e "$fs/dev/tpmrm0" ]] && tpm=1

# Whether docker's running daemon remaps users: it lists name=userns among its security options.
# Never in a pipe: grep -q stopping early would fail docker's write, and pipefail with it.
remapped() { local o; o="$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null)" && [[ "$o" == *name=userns* ]]; }
# The daemon's storage driver and data root, "<driver> <data root>", as docker info says them.
data_root() { docker info --format '{{.Driver}} {{.DockerRootDir}}' 2>/dev/null || true; }
# The containerd namespace its containers (and, with the containerd image store, its images) live
# in; empty where the CLI does not know the field.
containerd_ns() { docker info --format '{{.Containerd.Namespaces.Containers}}' 2>/dev/null || true; }

# --remap-existing-daemon (#407): asked before any step changes anything, a dry run's too, and
# refused (exit 3) unless the agent is stopped and the daemon answers, runs no container and can
# take the remapping.
if ((remap_existing)); then
  refuse() { echo "prep-root.sh: --remap-existing-daemon: $*; nothing changed" >&2; exit 3; }
  command -v jq >/dev/null || refuse "no jq (a host whose daemon is in use has it from this script's earlier run)"
  # The agent's round starts a stopped dispatcher again: between this check and docker's restart
  # on the old daemon (daemon.json then changed while a container runs), or after it on the
  # remapped one before its install says so (agent.toml's userns_remap still false).
  command -v pgrep >/dev/null || refuse "no pgrep (procps) to see whether the agent runs"
  found=0
  agent_pids="$(pgrep -u "$user" -x omarchy-agent)" || found=$?
  case "$found" in
    0) refuse "the agent runs as $user (omarchy-agent, pid $(tr '\n' ' ' <<<"$agent_pids" | sed 's/ *$//')): stop it first, as $user — systemctl --user stop omarchy-agent — or its next round starts the dispatcher again" ;;
    1) ;; # none
    *) refuse "pgrep did not say whether the agent runs as $user (exit $found)" ;;
  esac
  docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || refuse "docker does not answer (its daemon must run to be looked at first)"
  names="$(docker ps --format '{{.Names}}' 2>/dev/null)" || refuse "docker does not answer"
  if [[ -n "$names" ]]; then
    refuse "$(grep -c . <<<"$names") container(s) run ($(tr '\n' ' ' <<<"$names" | sed 's/ *$//')): stop every one first — on a pool host its agent first (systemctl --user stop omarchy-agent, as the agent's user), then docker stop each; a stopped container stays in the old data root"
  fi
  if [[ -s "$fs/etc/docker/daemon.json" ]]; then
    jq -e 'type == "object"' "$fs/etc/docker/daemon.json" >/dev/null 2>&1 || refuse "/etc/docker/daemon.json is not a JSON object"
    # dockerd turns the containerd image store off by itself under userns-remap, but refuses to
    # start when daemon.json turns it on by name (moby #47377).
    if jq -e '.features["containerd-snapshotter"] == true' "$fs/etc/docker/daemon.json" >/dev/null 2>&1; then
      refuse "/etc/docker/daemon.json turns the containerd image store on by name (features.containerd-snapshotter: true), which dockerd refuses to start with beside userns-remap: take that key out first"
    fi
  fi
fi

echo "==> 1. packages ($distro, $runtime)"
if [[ "$distro" == arch ]]; then
  pkgs=(qemu-user-static qemu-user-static-binfmt btrfs-progs jq)
  if [[ "$runtime" == rootful ]]; then pkgs+=(docker); else pkgs+=(podman); fi
  if ((tpm)); then pkgs+=(tpm2-tools); fi
  run pacman -S --needed --noconfirm "${pkgs[@]}"
else
  pkgs=(qemu-user-static binfmt-support btrfs-progs jq)
  if [[ "$runtime" == rootful ]]; then pkgs+=(docker.io); else pkgs+=(podman uidmap); fi
  if ((tpm)); then pkgs+=(tpm2-tools); fi
  run apt-get update
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${pkgs[@]}"
fi
if [[ "$runtime" == rootful ]]; then run systemctl enable --now docker.service; fi

if [[ "$runtime" == rootful ]]; then
  echo "==> 2. the docker group"
  if id -nG "$user" | tr ' ' '\n' | grep -qx docker; then
    echo "    $user is in it"
  else
    run usermod -aG docker "$user"
    changed "$user added (a new login picks it up)"
  fi
fi

if ((tpm)); then
  echo "==> 2. the tss group (the TPM, where the host key is made)"
  added=0
  if id -nG "$user" | tr ' ' '\n' | grep -qx tss; then
    echo "    $user is in it"
  else
    run usermod -aG tss "$user"
    changed "$user added (a new login picks it up)"
    added=1
  fi
  # The user manager runs the agent's service and keeps the groups it started with: one
  # already running (linger on, or a login open) when the group was added — by this run or
  # an earlier one — never opens the TPM until it restarts. Asked on every run: its main
  # process's gid and groups (/proc/<pid>/status) against tss's; when they cannot be read,
  # only a group this run added is said.
  uid="$(id -u "$user")"
  if systemctl is-active --quiet "user@$uid.service"; then
    tss_gid="$(getent group tss | cut -d: -f3)" || tss_gid=""
    pid="$(systemctl show -p MainPID --value "user@$uid.service")" || pid=""
    manager_groups=""
    if [[ "$pid" =~ ^[1-9][0-9]*$ && -r "$fs/proc/$pid/status" ]]; then
      manager_groups="$(sed -n -e 's/^Gid:[[:space:]]*\([0-9]*\).*/\1/p' -e 's/^Groups:[[:space:]]*//p' "$fs/proc/$pid/status" | tr '\n' ' ')"
    fi
    if ((added)) || [[ -n "$tss_gid" && -n "$manager_groups" && " $manager_groups " != *" $tss_gid "* ]]; then
      attention+=("tss: $user's user manager already runs, without the group: systemctl restart user@$uid.service (it stops $user's processes), or reboot, so the agent's service opens the TPM")
    fi
  fi
fi

echo "==> 3. binfmt for $foreign (the emulated lane)"
handler="$fs/proc/sys/fs/binfmt_misc/qemu-$foreign"
has_f() { [[ -f "$handler" ]] && grep -q '^enabled' "$handler" && grep -q '^flags:.*F' "$handler"; }
if ! has_f; then
  if [[ "$distro" == arch ]]; then
    run systemctl restart systemd-binfmt.service || true
  else
    run systemctl restart binfmt-support.service || true
  fi
fi
if has_f; then
  echo "    qemu-$foreign: enabled, with the F flag"
elif ((dry)); then
  echo "    qemu-$foreign: not yet (the packages above install it)"
else
  attention+=("binfmt: qemu-$foreign is not enabled with the F flag ($handler); the $foreign lane stays off")
fi

if [[ "$runtime" == rootful ]] && ! command -v jq >/dev/null; then
  # A dry run before step 1 installed anything; a real run has jq from step 1.
  echo "==> 4. docker's default address pools / 5. userns-remap (a new daemon only)"
  if ((dry)); then
    echo "    would write /etc/docker/daemon.json: $address_pool in /24s, and userns-remap if the daemon is new (jq comes with the packages above)"
  else
    attention+=("daemon.json: no jq (step 1 should have installed it); the address pools and userns-remap are not set")
  fi
elif [[ "$runtime" == rootful ]]; then
  daemon_json="/etc/docker/daemon.json"
  current="{}"
  [[ -s "$fs$daemon_json" ]] && current="$(cat "$fs$daemon_json")"
  want="$(POOL_BASE="$address_pool" jq -S '. + {"default-address-pools": [{"base": env.POOL_BASE, "size": 24}]}' <<<"$current")"

  echo "==> 4. docker's default address pools"
  echo "    $address_pool in /24s"

  restart=0
  if ((remap_existing)); then
    echo "==> 5. userns-remap (an existing daemon: --remap-existing-daemon)"
  else
    echo "==> 5. userns-remap (a new daemon only)"
  fi
  if jq -e 'has("userns-remap")' <<<"$current" >/dev/null; then
    echo "    already set: $(jq -r '."userns-remap"' <<<"$current")"
    # Written by an earlier run while containers ran, and docker not restarted since: with the
    # flag, nothing runs now (asked above), so the restart that applies it is this run's.
    if ((remap_existing)) && ! remapped; then
      echo "    the daemon does not remap users yet: docker is restarted to apply it"
      restart=1
    elif ((remap_existing)); then
      read -r new_driver new_root <<<"$(data_root)"
      echo "    docker remaps users: its data root ${new_root:-?}, storage driver ${new_driver:-?}"
    fi
  elif ((remap_existing)); then
    counts="$(docker info --format '{{.Containers}} {{.Images}}' 2>/dev/null || echo '? ?')"
    echo "    the daemon holds ${counts% *} container(s) and ${counts#* } image(s), none of them running"
    dockremap
    want="$(jq -S '. + {"userns-remap": "default"}' <<<"$want")"
    changed "turned on: a container escape lands in an unprivileged subuid"
    # The way back: what the daemon holds now stays where it is, and daemon.json as it was.
    read -r old_driver old_root <<<"$(data_root)"
    old_ns="$(containerd_ns)"
    echo "    the old data root, ${old_root:-?} (storage driver ${old_driver:-?}$([[ -n "$old_ns" ]] && echo ", containerd namespace $old_ns")), stays as it is: the remapped daemon starts empty in a data root of its own and never looks at it"
    echo "    the way back: install -m 0644 $daemon_json.pre-remap $daemon_json && systemctl restart docker.service — that daemon, with everything it held"
    put "$daemon_json.pre-remap" 0644 "$current" || true
  else
    counts="$(docker info --format '{{.Containers}} {{.Images}}' 2>/dev/null || echo unknown)"
    if [[ "$counts" == "0 0" ]]; then
      dockremap
      want="$(jq -S '. + {"userns-remap": "default"}' <<<"$want")"
      changed "turned on: a container escape lands in an unprivileged subuid"
    elif ((dry)) && [[ "$counts" == unknown ]]; then
      echo "    would turn on userns-remap if the daemon is new (docker did not answer: not installed or not running yet)"
    else
      attention+=("userns-remap: left off, the daemon already holds containers or images ($counts), or did not answer; turning it on changes the data root and leaves them behind (design v2 §19.1): --remap-existing-daemon does it once no container runs, the old data root the way back (#407)")
    fi
  fi

  if [[ "$(jq -S . <<<"$current")" != "$want" ]]; then
    put "$daemon_json" 0644 "$want" || true
    restart=1
  else
    echo "    daemon.json: as wanted"
  fi
  if ((restart)); then
    # docker ps on its own (never in a pipe): a daemon that does not answer is said, not fatal.
    if ids="$(docker ps -q 2>/dev/null)"; then running="$(grep -c . <<<"$ids" || true)"; else running=unknown; fi
    if [[ "$running" == 0 ]] || { ((dry)) && [[ "$running" == unknown ]]; }; then
      if [[ -e "$fs$daemon_json.pre-remap" ]]; then
        back="install -m 0644 $daemon_json.pre-remap $daemon_json && systemctl restart docker.service"
      else
        back="take userns-remap out of $daemon_json, then systemctl restart docker.service"
      fi
      if ! run systemctl restart docker.service; then
        # dockerd refused the new daemon.json, or did not start for another reason: docker is down,
        # said with the way back, and the steps after still run. docker_restarted stays 0: the
        # firewall's chains are as they were (docker's stop leaves them), and restarting its unit
        # now would start docker again through its Wants=.
        if ((remap_existing)); then
          attention+=("userns-remap: docker did not start with it, and is down (journalctl -u docker says why); the way back: $back")
        else
          attention+=("docker: did not start again with $daemon_json as written, and is down (journalctl -u docker says why)")
        fi
      else
        docker_restarted=1
        if ((remap_existing && dry)); then
          echo "    would check that docker info lists name=userns, and say the remapped daemon's data root and storage driver"
        elif ((remap_existing)); then
          for _ in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
          if remapped; then
            read -r new_driver new_root <<<"$(data_root)"
            changed "docker remaps users (docker info lists name=userns): its data root ${new_root:-?}, storage driver ${new_driver:-?}$([[ -n "$(containerd_ns)" ]] && echo ", containerd namespace $(containerd_ns)"), empty until images are pulled into it"
            echo "    next, as the agent's user: its install again, which records envelope.userns_remap and writes the agent keys with their ACL"
          else
            attention+=("userns-remap: docker info does not list name=userns after the restart (journalctl -u docker says why); the way back: $back")
          fi
        fi
      fi
    elif [[ "$running" == unknown ]]; then
      attention+=("docker: daemon.json changed and the daemon did not answer; restart docker.service once it does")
    else
      attention+=("docker: daemon.json changed while $running container(s) run; restart docker.service when none does")
    fi
  fi
fi

echo "==> 6. the work root: $work_root"
if [[ -d "$fs$work_root" ]]; then
  echo "    there"
else
  parent="$(dirname "$work_root")"
  run mkdir -p "$fs$parent"
  if [[ "$(stat -f -c %T "$fs$parent" 2>/dev/null)" == btrfs ]]; then
    run btrfs subvolume create "$fs$work_root"
    changed "a btrfs subvolume (outside the root's snapshots)"
  else
    run mkdir -p "$fs$work_root"
    changed "a directory"
  fi
fi
group="$(id -gn "$user")"
if [[ -d "$fs$work_root" ]] && [[ "$(stat -c '%U:%G %a' "$fs$work_root")" != "$user:$group 750" ]]; then
  run chown "$user:$group" "$fs$work_root"
  run chmod 0750 "$fs$work_root"
  changed "owned by $user:$group, 0750"
fi

echo "==> 7. linger for $user"
if [[ -e "$fs/var/lib/systemd/linger/$user" ]]; then
  echo "    on"
else
  run loginctl enable-linger "$user"
  changed "on"
fi

if [[ "$runtime" == rootless ]]; then
  echo "==> 8. cgroup v2 delegation"
  [[ -f "$fs/sys/fs/cgroup/cgroup.controllers" ]] \
    || attention+=("cgroup: not cgroup v2 (no /sys/fs/cgroup/cgroup.controllers); boot with the unified hierarchy")
  if put /etc/systemd/system/user@.service.d/delegate.conf 0644 "$(printf '%s\n' \
    '# prep-root.sh (omarchy-pool): the user manager may set task limits (design v2 §19.1).' \
    '[Service]' \
    'Delegate=cpu cpuset io memory pids')"; then
    run systemctl daemon-reload
    changed "on, for $user's next login (or: systemctl restart user@$(id -u "$user").service)"
  else
    echo "    on"
  fi
fi

if [[ "$runtime" == rootful ]]; then
  echo "==> 9. DOCKER-USER rules for the task subnets (${subnets[*]})"
  rules=("#!/bin/sh"
    "# prep-root.sh (omarchy-pool): task subnets reach no private, CGNAT, link-local or host address (design v2 §9.4)."
    "# Rebuilt whole on every start; the chains are this file's own."
    "set -e"
    "iptables -N OMARCHY-TASKS 2>/dev/null || true"
    "iptables -N OMARCHY-TASKS-HOST 2>/dev/null || true"
    "iptables -F OMARCHY-TASKS"
    "iptables -F OMARCHY-TASKS-HOST")
  for s in "${subnets[@]}"; do
    # A task's own network (its egress sidecar) is in the subnet; docker's isolation chains, after DOCKER-USER, keep tasks apart.
    rules+=("iptables -A OMARCHY-TASKS -s $s -d $s -j RETURN")
    for d in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
      rules+=("iptables -A OMARCHY-TASKS -s $s -d $d -j DROP")
    done
    # The host's own addresses are reached through INPUT, never FORWARD.
    rules+=("iptables -A OMARCHY-TASKS-HOST -s $s -j DROP")
  done
  rules+=("iptables -N DOCKER-USER 2>/dev/null || true"
    "iptables -C DOCKER-USER -j OMARCHY-TASKS 2>/dev/null || iptables -I DOCKER-USER -j OMARCHY-TASKS"
    "iptables -C INPUT -j OMARCHY-TASKS-HOST 2>/dev/null || iptables -I INPUT -j OMARCHY-TASKS-HOST")
  script_changed=0
  unit_changed=0
  put /usr/local/libexec/omarchy-task-firewall 0755 "$(printf '%s\n' "${rules[@]}")" && script_changed=1
  put /etc/systemd/system/omarchy-task-firewall.service 0644 "$(printf '%s\n' \
    '# prep-root.sh (omarchy-pool): the task subnets'"'"' drop rules, after docker, at every boot.' \
    '[Unit]' \
    'Description=omarchy-pool: task subnets reach no private, link-local or host address' \
    'After=docker.service' \
    'Wants=docker.service' \
    '' \
    '[Service]' \
    'Type=oneshot' \
    'RemainAfterExit=yes' \
    'ExecStart=/usr/local/libexec/omarchy-task-firewall' \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target')" && unit_changed=1
  if ((unit_changed)); then run systemctl daemon-reload; fi
  if ((script_changed || unit_changed)); then
    run systemctl enable omarchy-task-firewall.service
    run systemctl restart omarchy-task-firewall.service
  elif systemctl is-active --quiet omarchy-task-firewall.service \
    && systemctl is-enabled --quiet omarchy-task-firewall.service; then
    if ((docker_restarted)); then
      # Docker keeps DOCKER-USER across its restart, but the unit rebuilds its chains whole: run
      # again, so the drop is in place whatever the restart did.
      run systemctl restart omarchy-task-firewall.service
      echo "    in place, applied again after docker's restart"
    else
      echo "    in place"
    fi
  else
    # Stopped, or running but not enabled (a reboot would take the drop away): the agent's
    # preflight refuses either (#367).
    run systemctl enable omarchy-task-firewall.service
    run systemctl restart omarchy-task-firewall.service
  fi
fi

if ((${#attention[@]})); then
  echo "==> needs a person"
  printf '    %s\n' "${attention[@]}"
  exit 1
fi
echo "==> done$( ((dry)) && echo ' (dry run: nothing changed)')"
