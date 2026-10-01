#!/usr/bin/env bash
# factory/host/prep-root.sh (#310), against stubs: the root-only steps a new
# maintainer host needs once, each of them, and nothing else.
#
# - Arch, rootful, aarch64, a btrfs /srv, a new daemon: the packages
#   (qemu-user-static-binfmt included) and docker enabled; the user in the
#   docker group; daemon.json with docker's default address pools and
#   userns-remap, docker restarted; the work root a btrfs subvolume owned by
#   the user, 0750; linger; the DOCKER-USER rules for the task subnets
#   (RFC 1918 and link-local dropped, the subnet itself returned first, the
#   host dropped in INPUT) in a script a boot unit runs. No delegation file.
# - Run again: nothing changes — no file, no group, no subvolume, no restart.
# - Ubuntu, rootless, x86_64, ext4: apt-get with podman, a plain directory,
#   linger, cgroup v2 delegation; no docker group, daemon.json or firewall.
#   Again: nothing changes.
# - A daemon that already holds containers: userns-remap left off and docker
#   not restarted, both said under "needs a person" (exit 1).
# - binfmt without the F flag: said (exit 1).
# - --dry-run: nothing written, no command that changes the host.
# - Usage (exit 2): an unknown runtime, no work root, a task subnet inside
#   the address pool, root as the user.
# - The firewall script, run against a stubbed iptables: its own chains
#   flushed and rebuilt in order, the jumps added once.
#
# prep-root.sh runs as root on a real host: here its root check is lifted in
# a copy, OMARCHY_PREP_FS points it at a temporary root, and pacman, apt-get,
# systemctl, usermod, loginctl, btrfs, docker, id, stat, chown, uname and
# iptables are stubs on PATH that record what they were asked.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
export STUB_LOG="$tmp/log" STATE="$tmp/state"
fail() { echo "FAIL: $*" >&2; echo "--- log ---" >&2; cat "$STUB_LOG" >&2 || true; echo "--- out ---" >&2; cat "$tmp/out" >&2 || true; exit 1; }

sed 's/\[\[ \$EUID -eq 0 \]\]/[[ 0 -eq 0 ]]/' "$root/factory/host/prep-root.sh" > "$tmp/prep-root.sh"
grep -q '\[\[ 0 -eq 0 \]\]' "$tmp/prep-root.sh" || fail "the root check was not found to lift"

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$tmp/bin/$1"; chmod +x "$tmp/bin/$1"; }
log='echo "$(basename "$0") $*" >> "$STUB_LOG"'
stub pacman "$log"
stub apt-get "$log"
stub usermod "$log"'; [[ "$1 $2" == "-aG docker" ]] && echo " docker" >> "$STATE/groups"'
stub loginctl "$log"'; mkdir -p "$OMARCHY_PREP_FS/var/lib/systemd/linger"; touch "$OMARCHY_PREP_FS/var/lib/systemd/linger/$2"'
stub btrfs "$log"'; mkdir -p "$3"'
stub chown "$log"'; echo "$1" > "$STATE/owner"'
stub uname 'echo "$STUB_ARCH"'
stub id 'case "$1" in -u) echo 1000 ;; -nG) cat "$STATE/groups" | tr -d "\n" ; echo ;; -gn) echo omarchy ;; *) exit 1 ;; esac'
# stat -f -c %T: the filesystem type; stat -c "%U:%G %a": the owner chown set, and the mode.
stub stat 'if [[ "$1" == -f ]]; then echo "$STUB_FSTYPE"; else printf "%s %s\n" "$(cat "$STATE/owner" 2>/dev/null || echo root:root)" "$(cat "$STATE/mode" 2>/dev/null || echo 755)"; fi'
stub chmod 'if [[ "$1" == 0750 ]]; then echo "chmod $*" >> "$STUB_LOG"; echo 750 > "$STATE/mode"; fi; exec /bin/chmod "$@"'
stub docker 'echo "docker $*" >> "$STUB_LOG.read"; case "$1" in info) echo "$STUB_DOCKER_COUNTS" ;; ps) printf "%s" "$STUB_DOCKER_PS" ;; esac'
stub systemctl "$log"'
case "$1" in
  is-active) [[ -e "$STATE/active-${3%.service}" ]] ;;
  restart|enable) [[ "$*" == *omarchy-task-firewall* && "$*" != "enable omarchy-task-firewall.service" ]] && touch "$STATE/active-omarchy-task-firewall"; true ;;
esac'

# A fresh host: os-release, the binfmt handler with the F flag (the packages put it there), cgroup v2.
fresh() { # id arch fstype
  rm -rf "$tmp/fs" "$STATE"; mkdir -p "$tmp/fs/etc" "$tmp/fs/srv" "$tmp/fs/proc/sys/fs/binfmt_misc" "$tmp/fs/sys/fs/cgroup" "$STATE"
  printf 'ID=%s\n' "$1" > "$tmp/fs/etc/os-release"
  local foreign=x86_64; [[ "$2" == x86_64 ]] && foreign=aarch64
  printf 'enabled\ninterpreter /usr/bin/qemu-%s-static\nflags: POCF\n' "$foreign" > "$tmp/fs/proc/sys/fs/binfmt_misc/qemu-$foreign"
  : > "$tmp/fs/sys/fs/cgroup/cgroup.controllers"
  echo omarchy > "$STATE/groups"
  export STUB_ARCH="$2" STUB_FSTYPE="$3" STUB_DOCKER_COUNTS="0 0" STUB_DOCKER_PS=""
}
prep() { # args… → $status, $tmp/out; the log starts empty
  : > "$STUB_LOG"; : > "$STUB_LOG.read"
  set +e
  PATH="$tmp/bin:$PATH" OMARCHY_PREP_FS="$tmp/fs" SUDO_USER=omarchy bash "$tmp/prep-root.sh" "$@" > "$tmp/out" 2>&1
  status=$?
  set -e
}
tree() { (cd "$tmp/fs" && find . -type f -print0 | sort -z | xargs -0 shasum 2>/dev/null; find . | sort) ; cat "$STATE/groups"; }
logged() { grep -qxF -- "$1" "$STUB_LOG" || fail "not run: $1"; }
not_logged() { ! grep -q -- "^$1" "$STUB_LOG" || fail "run, and must not be: $1"; } # a line that starts with it
# Nothing else: every command that changes the host is one of these.
only() { # allowed command names…
  local cmd
  while read -r cmd _; do
    [[ " $* " == *" $cmd "* ]] || fail "an unexpected command: $cmd"
  done < "$STUB_LOG"
}

wr=/srv/omarchy-pool/host

# --- Arch, rootful, aarch64, btrfs, a new daemon.
fresh arch aarch64 btrfs
prep --work-root "$wr" --task-subnets 10.231.0.0/16
[[ $status -eq 0 ]] || fail "arch rootful: exit $status"
logged "pacman -S --needed --noconfirm qemu-user-static qemu-user-static-binfmt btrfs-progs jq docker"
logged "systemctl enable --now docker.service"
logged "usermod -aG docker omarchy"
[[ "$(jq -cS . "$tmp/fs/etc/docker/daemon.json")" == '{"default-address-pools":[{"base":"172.17.0.0/12","size":24}],"userns-remap":"default"}' ]] \
  || fail "daemon.json: $(cat "$tmp/fs/etc/docker/daemon.json")"
logged "systemctl restart docker.service"
logged "btrfs subvolume create $tmp/fs$wr"
logged "chown omarchy:omarchy $tmp/fs$wr"
logged "chmod 0750 $tmp/fs$wr"
[[ -e "$tmp/fs/var/lib/systemd/linger/omarchy" ]] || fail "no linger"
[[ ! -e "$tmp/fs/etc/systemd/system/user@.service.d/delegate.conf" ]] || fail "delegation on a rootful host"
fw="$tmp/fs/usr/local/libexec/omarchy-task-firewall"
[[ -x "$fw" ]] || fail "no firewall script"
for rule in \
  "iptables -A OMARCHY-TASKS -s 10.231.0.0/16 -d 10.231.0.0/16 -j RETURN" \
  "iptables -A OMARCHY-TASKS -s 10.231.0.0/16 -d 10.0.0.0/8 -j DROP" \
  "iptables -A OMARCHY-TASKS -s 10.231.0.0/16 -d 172.16.0.0/12 -j DROP" \
  "iptables -A OMARCHY-TASKS -s 10.231.0.0/16 -d 192.168.0.0/16 -j DROP" \
  "iptables -A OMARCHY-TASKS -s 10.231.0.0/16 -d 169.254.0.0/16 -j DROP" \
  "iptables -A OMARCHY-TASKS-HOST -s 10.231.0.0/16 -j DROP"; do
  grep -qxF "$rule" "$fw" || fail "firewall: no $rule"
done
grep -qxF 'ExecStart=/usr/local/libexec/omarchy-task-firewall' "$tmp/fs/etc/systemd/system/omarchy-task-firewall.service" || fail "no firewall unit"
logged "systemctl enable omarchy-task-firewall.service"
logged "systemctl restart omarchy-task-firewall.service"
not_logged "apt-get"
only pacman systemctl usermod btrfs chown chmod loginctl
before="$(tree)"

# --- Again: nothing changes.
prep --work-root "$wr" --task-subnets 10.231.0.0/16
[[ $status -eq 0 ]] || fail "arch rootful, again: exit $status"
[[ "$(tree)" == "$before" ]] || fail "a second run changed files"
for c in usermod btrfs chown chmod loginctl "systemctl restart docker" "systemctl daemon-reload" "systemctl enable omarchy-task-firewall" "systemctl restart omarchy-task-firewall"; do not_logged "$c"; done
grep -q "in place" "$tmp/out" || fail "the firewall not said in place"

# --- Ubuntu, rootless, x86_64, ext4.
fresh ubuntu x86_64 ext4
prep --work-root "$wr" --runtime rootless
[[ $status -eq 0 ]] || fail "ubuntu rootless: exit $status"
logged "apt-get update"
logged "apt-get install -y --no-install-recommends qemu-user-static binfmt-support btrfs-progs jq podman uidmap"
[[ -d "$tmp/fs$wr" ]] || fail "no work root"
not_logged "btrfs"
grep -qxF 'Delegate=cpu cpuset io memory pids' "$tmp/fs/etc/systemd/system/user@.service.d/delegate.conf" || fail "no delegation"
logged "systemctl daemon-reload"
[[ -e "$tmp/fs/var/lib/systemd/linger/omarchy" ]] || fail "no linger"
[[ ! -e "$tmp/fs/etc/docker/daemon.json" && ! -e "$fw" ]] || fail "rootless: daemon.json or the firewall written"
[[ ! -s "$STUB_LOG.read" ]] || fail "rootless: docker asked: $(cat "$STUB_LOG.read")"
only apt-get systemctl chown chmod loginctl
before="$(tree)"
prep --work-root "$wr" --runtime rootless
[[ $status -eq 0 && "$(tree)" == "$before" ]] || fail "ubuntu rootless, again: exit $status or files changed"
for c in "systemctl daemon-reload" chown chmod loginctl; do not_logged "$c"; done

# --- A daemon that already holds containers.
fresh arch aarch64 btrfs
STUB_DOCKER_COUNTS="3 5" STUB_DOCKER_PS=$'abc\ndef\n'
prep --work-root "$wr"
[[ $status -eq 1 ]] || fail "busy daemon: exit $status, want 1"
[[ "$(jq -cS . "$tmp/fs/etc/docker/daemon.json")" == '{"default-address-pools":[{"base":"172.17.0.0/12","size":24}]}' ]] \
  || fail "busy daemon: daemon.json $(cat "$tmp/fs/etc/docker/daemon.json")"
not_logged "systemctl restart docker"
grep -q "needs a person" "$tmp/out" && grep -q "userns-remap: left off" "$tmp/out" && grep -q "restart docker.service when none does" "$tmp/out" \
  || fail "busy daemon: not said"

# --- binfmt without the F flag.
fresh arch aarch64 btrfs
printf 'enabled\ninterpreter /usr/bin/qemu-x86_64-static\nflags: POC\n' > "$tmp/fs/proc/sys/fs/binfmt_misc/qemu-x86_64"
prep --work-root "$wr"
[[ $status -eq 1 ]] && grep -q "binfmt: qemu-x86_64 is not enabled with the F flag" "$tmp/out" || fail "binfmt without F: exit $status"
logged "systemctl restart systemd-binfmt.service"

# --- --dry-run: nothing written, nothing changed.
fresh arch aarch64 btrfs
before="$(tree)"
prep --work-root "$wr" --dry-run
[[ $status -eq 0 ]] || fail "dry run: exit $status"
[[ "$(tree)" == "$before" ]] || fail "a dry run changed files"
[[ ! -s "$STUB_LOG" ]] || fail "a dry run ran: $(cat "$STUB_LOG")"
grep -q "would run: pacman" "$tmp/out" && grep -q "would write /etc/docker/daemon.json" "$tmp/out" || fail "a dry run did not say what it would do"

# --- Usage.
fresh arch aarch64 btrfs
for args in "--work-root $wr --runtime podman" "--runtime rootful" "--work-root relative/path" \
  "--work-root $wr --task-subnets 172.20.0.0/16" "--work-root $wr --user root" "--work-root $wr --task-subnets 10.231.0.0"; do
  # shellcheck disable=SC2086
  prep $args
  [[ $status -eq 2 ]] || fail "usage: $args: exit $status, want 2"
  [[ ! -s "$STUB_LOG" ]] || fail "usage: $args ran something"
done

# --- The firewall script, against a stubbed iptables: rebuilt whole, jumps added once.
fresh arch aarch64 btrfs
prep --work-root "$wr" --task-subnets 10.231.0.0/16,10.232.0.0/16
[[ $status -eq 0 ]] || fail "two subnets: exit $status"
mkdir -p "$tmp/ipt"
printf '#!/usr/bin/env bash\necho "iptables $*" >> "%s/ipt/log"\ncase "$1" in -C) [[ -e "%s/ipt/jump-$2" ]] ;; -I) touch "%s/ipt/jump-$2" ;; esac\n' "$tmp" "$tmp" "$tmp" > "$tmp/ipt/iptables"
chmod +x "$tmp/ipt/iptables"
PATH="$tmp/ipt:$PATH" sh "$fw"; PATH="$tmp/ipt:$PATH" sh "$fw"
[[ "$(grep -c -- '-I DOCKER-USER -j OMARCHY-TASKS' "$tmp/ipt/log")" == 1 && "$(grep -c -- '-I INPUT -j OMARCHY-TASKS-HOST' "$tmp/ipt/log")" == 1 ]] \
  || fail "firewall: the jumps not added exactly once"
[[ "$(grep -c -- '-F OMARCHY-TASKS$' "$tmp/ipt/log")" == 2 ]] || fail "firewall: its chain not flushed at each start"
first="$(grep -n -- '-A OMARCHY-TASKS -s 10.232.0.0/16' "$tmp/ipt/log" | head -1)"
[[ "$first" == *"-d 10.232.0.0/16 -j RETURN" ]] || fail "firewall: the subnet's own RETURN is not first: $first"

echo "prep-root.sh: every root-only step, idempotent, nothing else"
