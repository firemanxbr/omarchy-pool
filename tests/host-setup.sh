#!/usr/bin/env bash
# The Studio's host files (factory/host/, #277 part 3), against stubs: the
# one-time step of the runbook's *The Studio host*, which moves the host to
# the updater.
#
# - setup.sh installs a compose.yml whose `updater` service has the
#   runtime's socket and POOL_ROOT at the same path, read-only, and no
#   token; and a rollout.sh whose second line is the marker a project
#   worker reports (`# omarchy-rollout: kick-v1`).
# - On a host from before #277 it disables, stops and removes the user
#   timer that ran the old rollout.sh, as the user who owns it; on a fresh
#   host it writes no timer at all.
# - rollout.sh only wakes the updater: `up -d --no-deps updater`, then
#   `kill -s USR1 updater`, and `--check` asks the updater's own
#   omarchy-rollout; it runs no rollout of its own.
#
# setup.sh runs as root on a real host: here its root check is lifted in a
# copy, and pacman, systemctl, runuser, chown, install's owner and the rest
# are stubs on PATH that record what they were asked.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/src" "$tmp/home"
export STUB_LOG="$tmp/log" STUB_HOME="$tmp/home"
: > "$STUB_LOG"
fail() { echo "FAIL: $*" >&2; echo "--- log ---" >&2; cat "$STUB_LOG" >&2; exit 1; }

# The host files as a checkout has them, setup.sh's root check lifted (EUID is read-only in bash).
cp "$root/factory/host/compose.yml" "$root/factory/host/register.sh" "$root/factory/host/rollout.sh" "$tmp/src/"
sed 's/\[\[ \$EUID -eq 0 \]\]/[[ 0 -eq 0 ]]/' "$root/factory/host/setup.sh" > "$tmp/src/setup.sh"
grep -q '\[\[ 0 -eq 0 \]\]' "$tmp/src/setup.sh" || fail "the root check was not found to lift"

stub() { # name body
  printf '#!/usr/bin/env bash\n%s\n' "$2" > "$tmp/bin/$1"; chmod +x "$tmp/bin/$1"
}
stub pacman 'echo "pacman $*" >> "$STUB_LOG"'
stub systemctl 'echo "systemctl $*" >> "$STUB_LOG"'
stub usermod 'echo "usermod $*" >> "$STUB_LOG"'
stub chown 'echo "chown $*" >> "$STUB_LOG"'
stub loginctl 'echo "loginctl $*" >> "$STUB_LOG"'
stub btrfs 'echo "btrfs $*" >> "$STUB_LOG"; mkdir -p "${@: -1}"'
stub hostname 'echo omarchy-studio'
# stat -f -c %T: not btrfs here.
stub stat 'if [[ "$1" == -f ]]; then echo ext2/ext3; else exec /usr/bin/stat "$@"; fi'
# install -m MODE -o U -g G SRC DST: the copy and the mode, without an owner (no root here).
stub install 'args=(); while [[ $# -gt 0 ]]; do case "$1" in -o|-g) shift 2 ;; -d) shift; mkdir -p "$@"; exit 0 ;; -m) m="$2"; shift 2 ;; *) args+=("$1"); shift ;; esac; done; cp "${args[0]}" "${args[1]}"; chmod "${m:-644}" "${args[1]}"'
stub getent 'case "$1 $2" in "passwd firemanxbr") echo "firemanxbr:x:1000:1000::$STUB_HOME:/bin/bash" ;; "group docker") echo "docker:x:970:firemanxbr" ;; *) exit 2 ;; esac'
stub runuser 'echo "runuser $*" >> "$STUB_LOG"'
stub id 'case "$1" in -u) [[ -n "${2:-}" ]] && echo 1000 || echo 1000 ;; -Gn) echo "firemanxbr docker" ;; -un) echo firemanxbr ;; *) exec /usr/bin/id "$@" ;; esac'
stub docker 'echo "docker $*" >> "$STUB_LOG"'
export PATH="$tmp/bin:$PATH"

# 1. A host from before #277: the timer and its service are there.
units="$tmp/home/.config/systemd/user"
mkdir -p "$units"
printf '[Timer]\nOnUnitActiveSec=15min\n' > "$units/omarchy-pool-rollout.timer"
printf '[Service]\nExecStart=/srv/omarchy-pool/rollout.sh\n' > "$units/omarchy-pool-rollout.service"
POOL="$tmp/srv/omarchy-pool"
SUDO_USER=firemanxbr bash "$tmp/src/setup.sh" "$POOL" > "$tmp/out" 2>&1 || fail "setup.sh exited $?: $(cat "$tmp/out")"

# The compose file has the updater: the socket, the directory at the same path read-only, the role, no token.
updater="$(awk '/^  updater:$/ { on = 1; print; next } on && /^  [a-z#]/ { exit } on && /^[^ ]/ { exit } on { print }' "$POOL/compose.yml")"
[[ -n "$updater" ]] || fail "the installed compose.yml has an updater service"
for want in "image: ghcr.io/firemanxbr/omarchy-worker:latest" "restart: unless-stopped" "OMARCHY_WORKER_ROLE: updater" 'COMPOSE_DIR: ${POOL_ROOT:-/srv/omarchy-pool}' \
  "- /var/run/docker.sock:/var/run/docker.sock" '- ${POOL_ROOT:-/srv/omarchy-pool}:${POOL_ROOT:-/srv/omarchy-pool}:ro' "security_opt: [label=disable]"; do
  grep -qF -- "$want" <<<"$updater" || fail "the updater service has: $want — it has: $updater"
done
grep -qiE "token|env_file|api_key" <<<"$updater" && fail "the updater holds no token and no key: $updater"
grep -q "stop_grace_period" <<<"$updater" && fail "the updater drains nothing: $updater"
# rollout.sh: the marker on its second line (what a project worker reports), and no rollout of its own.
[[ -x "$POOL/rollout.sh" ]] || fail "rollout.sh is installed, executable"
[[ "$(sed -n 2p "$POOL/rollout.sh")" == "# omarchy-rollout: kick-v1" ]] || fail "rollout.sh's second line is the marker: $(sed -n 2p "$POOL/rollout.sh")"
(( $(wc -l < "$POOL/rollout.sh") <= 15 )) || fail "rollout.sh is a wake-up, not a rollout: $(wc -l < "$POOL/rollout.sh") lines"
grep -qE "pull|image rm|config --hash" "$POOL/rollout.sh" && fail "rollout.sh pulls and replaces nothing itself"
# The timer is retired, as its user, and its units are gone; nothing writes a new one.
grep -q "runuser -u firemanxbr -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user disable --now omarchy-pool-rollout.timer" "$STUB_LOG" || fail "the timer is disabled and stopped as its user"
[[ ! -e "$units/omarchy-pool-rollout.timer" && ! -e "$units/omarchy-pool-rollout.service" ]] || fail "the timer's units are removed"
grep -q "omarchy-pool-rollout.timer retired" "$tmp/out" || fail "setup.sh says so: $(cat "$tmp/out")"
grep -q "systemctl --user enable" "$STUB_LOG" "$tmp/out" && fail "nothing enables a timer"
grep -q "docker compose up -d --no-deps updater" "$tmp/out" || fail "setup.sh names the one-time step's up: $(cat "$tmp/out")"
# What setup.sh did before stays: the env files, mode 600, and .env.
[[ -f "$POOL/.env" && -f "$POOL/etc/agent.env" && -f "$POOL/etc/pool-aarch64.env" ]] || fail "the env files are written"
[[ "$(/usr/bin/stat -c %a "$POOL/etc/agent.env" 2>/dev/null || /usr/bin/stat -f %Lp "$POOL/etc/agent.env")" == 600 ]] || fail "agent.env is mode 600"
echo "ok: a host from before #277 — the updater in, the timer out"

# 2. A fresh host: no timer to retire, and none written.
rm -rf "$units"; : > "$STUB_LOG"
SUDO_USER=firemanxbr bash "$tmp/src/setup.sh" "$tmp/srv/fresh" > "$tmp/out" 2>&1 || fail "setup.sh on a fresh host exited $?: $(cat "$tmp/out")"
grep -q "runuser" "$STUB_LOG" && fail "a fresh host has no timer to retire: $(grep runuser "$STUB_LOG")"
[[ ! -e "$units/omarchy-pool-rollout.timer" ]] || fail "no timer is written"
echo "ok: a fresh host — no timer"

# 3. rollout.sh wakes the updater: started if it is not running, then SIGUSR1; --check asks the updater's own omarchy-rollout.
: > "$STUB_LOG"
bash "$POOL/rollout.sh" || fail "rollout.sh exited $?"
[[ "$(cat "$STUB_LOG")" == "docker compose up -d --no-deps updater
docker compose kill -s USR1 updater" ]] || fail "rollout.sh starts the updater, then wakes it, and does nothing else: $(cat "$STUB_LOG")"
: > "$STUB_LOG"
bash "$POOL/rollout.sh" --check || fail "rollout.sh --check exited $?"
[[ "$(cat "$STUB_LOG")" == "docker compose exec -T updater /usr/local/lib/omarchy-factory/bin/omarchy-rollout --check" ]] || fail "--check asks the updater what it would do: $(cat "$STUB_LOG")"
echo "ok: rollout.sh only wakes the updater"
echo "HOST SETUP OK"
