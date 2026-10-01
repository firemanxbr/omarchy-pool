#!/usr/bin/env bash
# prep-root.sh — the root-only steps a new maintainer host needs once before
# the host agent installs (design v2 §4.1, §7.5, §9.4, §19.1; epic #307).
# A person runs it; the agent never does: the agent only reports what is
# missing ("needs a person", set.toml [needs]). Arch Linux (and Arch Linux
# ARM) or Ubuntu LTS, as root:
#
#   sudo factory/host/prep-root.sh --work-root /srv/omarchy-pool/host \
#     [--user omarchy] [--runtime rootful|rootless] \
#     [--task-subnets 10.231.0.0/16[,…]] [--address-pool 172.17.0.0/12] [--dry-run]
#
#   --user          the Unix user the agent runs as (default: the one who ran sudo)
#   --runtime       rootful: docker's system daemon (default); rootless: podman
#                   as that user (a shared machine, design v2 §19.1, 2.)
#   --task-subnets  what the agent's --task-subnets will be (default 10.231.0.0/16)
#   --address-pool  the base of docker's default address pools, cut in /24s
#                   (default 172.17.0.0/12); must not overlap the task subnets
#   --dry-run       say what would change, change nothing
#
# Each step, idempotent (a second run changes nothing), and nothing else:
#   1. packages: the runtime, qemu-user-static with its binfmt handlers,
#      btrfs-progs, jq (and the runtime's service enabled)
#   2. rootful: the user in the docker group
#   3. binfmt: the foreign architecture's qemu handler, with the F flag so
#      containers use it (for the emulated lane, design v2 §7.5)
#   4. rootful: docker's default address pools (daemon.json), so its own
#      networks never take the task subnets
#   5. rootful: userns-remap (daemon.json), on a new daemon only (no
#      container and no image yet): turning it on later changes the data
#      root and strands what is there (the Studio's recorded exception,
#      design v2 §19.1); docker restarted only when no container runs
#   6. the work root: a btrfs subvolume when its parent is btrfs (outside the
#      root's snapshots), a directory otherwise; owned by the user, 0750
#   7. linger for the user, so its systemd --user unit runs without a login
#   8. rootless: cgroup v2 delegation (cpu, cpuset, io, memory, pids) to the
#      user's systemd, so task limits hold
#   9. rootful: DOCKER-USER drop rules from the task subnets to RFC 1918 and
#      link-local addresses, and an INPUT drop from them to the host, kept
#      across reboots by omarchy-task-firewall.service (design v2 §9.4)
#
# Exit status: 0 done (or nothing to do), 1 done but something needs a person
# (listed at the end), 2 usage, or not root.
set -euo pipefail

# The filesystem's root, for tests/prep-root.sh only (it runs this script against a temporary directory).
fs="${OMARCHY_PREP_FS:-}"

usage() {
  cat >&2 <<'EOF_USAGE'
usage: prep-root.sh --work-root <path> [--user <name>] [--runtime rootful|rootless]
                    [--task-subnets <cidr>[,<cidr>…]] [--address-pool <cidr>] [--dry-run]
EOF_USAGE
  exit 2
}

user="${SUDO_USER:-}"
runtime=rootful
work_root=""
task_subnets="10.231.0.0/16"
address_pool="172.17.0.0/12"
dry=0
while (($#)); do
  case "$1" in
    --user) user="${2:?}"; shift 2 ;;
    --runtime) runtime="${2:?}"; shift 2 ;;
    --work-root) work_root="${2:?}"; shift 2 ;;
    --task-subnets) task_subnets="${2:?}"; shift 2 ;;
    --address-pool) address_pool="${2:?}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h | --help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "prep-root.sh: run as root (sudo)" >&2; exit 2; }
[[ -n "$user" && "$user" != root ]] || { echo "prep-root.sh: --user: the agent's own user, never root" >&2; exit 2; }
id -u "$user" >/dev/null 2>&1 || { echo "prep-root.sh: no user $user (create it first)" >&2; exit 2; }
[[ "$runtime" == rootful || "$runtime" == rootless ]] || { echo "prep-root.sh: --runtime is rootful or rootless" >&2; exit 2; }
[[ "$work_root" == /* && "$work_root" != */../* && "$work_root" != */.. && "$work_root" != / ]] \
  || { echo "prep-root.sh: --work-root: an absolute path" >&2; exit 2; }
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
for s in "${subnets[@]}"; do
  if overlaps "$s" "$address_pool"; then
    echo "prep-root.sh: the task subnet $s overlaps docker's address pool $address_pool" >&2; exit 2
  fi
done

attention=()
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

echo "==> 1. packages ($distro, $runtime)"
if [[ "$distro" == arch ]]; then
  pkgs=(qemu-user-static qemu-user-static-binfmt btrfs-progs jq)
  if [[ "$runtime" == rootful ]]; then pkgs+=(docker); else pkgs+=(podman); fi
  run pacman -S --needed --noconfirm "${pkgs[@]}"
else
  pkgs=(qemu-user-static binfmt-support btrfs-progs jq)
  if [[ "$runtime" == rootful ]]; then pkgs+=(docker.io); else pkgs+=(podman uidmap); fi
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

if [[ "$runtime" == rootful ]]; then
  daemon_json="/etc/docker/daemon.json"
  current="{}"
  [[ -s "$fs$daemon_json" ]] && current="$(cat "$fs$daemon_json")"
  want="$(POOL_BASE="$address_pool" jq -S '. + {"default-address-pools": [{"base": env.POOL_BASE, "size": 24}]}' <<<"$current")"

  echo "==> 4. docker's default address pools"
  echo "    $address_pool in /24s"

  echo "==> 5. userns-remap (a new daemon only)"
  if jq -e 'has("userns-remap")' <<<"$current" >/dev/null; then
    echo "    already set: $(jq -r '."userns-remap"' <<<"$current")"
  else
    counts="$(docker info --format '{{.Containers}} {{.Images}}' 2>/dev/null || echo unknown)"
    if [[ "$counts" == "0 0" ]]; then
      want="$(jq -S '. + {"userns-remap": "default"}' <<<"$want")"
      changed "turned on: a container escape lands in an unprivileged subuid"
    else
      attention+=("userns-remap: left off, the daemon already holds containers or images ($counts), or did not answer; turning it on would strand them (design v2 §19.1: a recorded exception, or a new daemon)")
    fi
  fi

  if [[ "$(jq -S . <<<"$current")" != "$want" ]]; then
    put "$daemon_json" 0644 "$want" || true
    running="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "$running" == 0 ]]; then
      run systemctl restart docker.service
    else
      attention+=("docker: daemon.json changed while $running container(s) run; restart docker.service when none does")
    fi
  else
    echo "    daemon.json: as wanted"
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
    "# prep-root.sh (omarchy-pool): task subnets reach no private, link-local or host address (design v2 §9.4)."
    "# Rebuilt whole on every start; the chains are this file's own."
    "set -e"
    "iptables -N OMARCHY-TASKS 2>/dev/null || true"
    "iptables -N OMARCHY-TASKS-HOST 2>/dev/null || true"
    "iptables -F OMARCHY-TASKS"
    "iptables -F OMARCHY-TASKS-HOST")
  for s in "${subnets[@]}"; do
    # A task's own network (its egress sidecar) is in the subnet; docker's isolation chains, after DOCKER-USER, keep tasks apart.
    rules+=("iptables -A OMARCHY-TASKS -s $s -d $s -j RETURN")
    for d in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
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
  elif systemctl is-active --quiet omarchy-task-firewall.service; then
    echo "    in place"
  else
    run systemctl enable --now omarchy-task-firewall.service
  fi
fi

if ((${#attention[@]})); then
  echo "==> needs a person"
  printf '    %s\n' "${attention[@]}"
  exit 1
fi
echo "==> done$( ((dry)) && echo ' (dry run: nothing changed)')"
