#!/usr/bin/env bash
# The host agent's self-update under a real `systemd --user` (#316; design v2
# §16.3): the agent's unit (crates/omarchy-agent/src/run/omarchy-agent.service,
# Type=notify, Restart=always) starts `current` after a swap, as it does after
# the agent's exit on a host, and deliberately broken builds of a higher agent
# version are rolled back to the running one:
#
#   good               passes its health gate: pending goes, nothing restarts,
#                      and the previous agent then reads the state it wrote
#   panic-at-config    panics while loading its configuration, every start:
#                      its third start points current back
#   hang-before-ready  never says READY=1: TimeoutStartSec fails each start
#   hang-after-ready   says READY=1, then its loop never runs: WatchdogSec
#
# The agent it rolls back to reports `agent-rollback` (its round, in the
# journal) and skips the version (status).
# A container started before keeps running, untouched, through every restart.
# The swap is written here as the agent writes it (`pending`, then `previous`
# and `current`; the unit tests pin that line); the decision, the download, the
# SHA-256 check (a wrong hash) and the self-test before it need a release
# signed by release.yml, and run against the fake pool in the unit tests.
#
# The unit's timers are shortened here (a drop-in) so a run takes minutes; the
# mechanism is the unit's. Test builds get their version and fault at build
# time (OMARCHY_AGENT_TEST_VERSION, OMARCHY_AGENT_TEST_FAULT); a build without
# them has neither.
#
# Needs Linux with a systemd user manager (CI: ubuntu-latest with linger); the
# container check needs docker. By hand: `bash tests/agent-self-update.sh`.
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"

systemctl --user show-environment >/dev/null 2>&1 \
  || { echo "agent-self-update.sh: no systemd user manager (systemctl --user)" >&2; exit 1; }

me="$(sed -n 's/^version = "\([0-9.]*\)"$/\1/p' crates/omarchy-agent/Cargo.toml | head -1)"
new=99.0.0
unit=omarchy-agent-selfupdate-test
work="$(mktemp -d "${TMPDIR:-/tmp}/agent-self-update.XXXXXX")"
task=""
cleanup() {
  systemctl --user stop "$unit.service" 2>/dev/null || true
  rm -rf "$HOME/.config/systemd/user/$unit.service" "$HOME/.config/systemd/user/$unit.service.d"
  systemctl --user daemon-reload 2>/dev/null || true
  [[ -z "$task" ]] || docker rm -f "$task" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "agent-self-update.sh: $*" >&2; journalctl --user -u "$unit" --no-pager -n 60 >&2 || true; exit 1; }

# The builds: the running agent, and four of a higher version.
export CARGO_TARGET_DIR="$root/target/agent-self-update"
build() { # name version fault
  OMARCHY_AGENT_TEST_VERSION="$2" OMARCHY_AGENT_TEST_FAULT="$3" \
    cargo build --locked --quiet -p omarchy-agent --bin omarchy-agent
  cp "$CARGO_TARGET_DIR/debug/omarchy-agent" "$work/omarchy-agent-$1"
  got="$("$work/omarchy-agent-$1" --version)"
  [[ "$got" == "omarchy-agent $2" ]] || fail "the $1 build says $got, not $2"
}
build old "$me" ""
for b in good panic-at-config hang-before-ready hang-after-ready; do
  build "$b" "$new" "$([[ $b == good ]] || echo "$b")"
done

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  # shellcheck source=tests/images.env
  source tests/images.env
  task="$(docker run -d --label org.omarchy-pool.test=self-update "$BUSYBOX" sleep 3600)"
  started="$(docker inspect -f '{{.State.StartedAt}}' "$task")"
fi

# A host after a swap to `$1`: the old agent installed by install.sh, the new
# one beside it, `pending` with no start counted, `previous` and `current`.
host() {
  data="$work/data-$1"
  rm -rf "$data"
  mkdir -p "$data/versions/$me" "$data/versions/$new" "$data/set"
  chmod 700 "$data"
  install -m 0755 "$work/omarchy-agent-old" "$data/versions/$me/omarchy-agent"
  install -m 0755 "$work/omarchy-agent-$1" "$data/versions/$new/omarchy-agent"
  # A pool that refuses connections: explicitly unreachable, which never stops the agent.
  cat > "$data/agent.toml" <<EOF
pool = "https://127.0.0.1:9"
host_id = "h_selfupdate"
worker_id = "w_selfupdate"
[set]
dir = "$data/set"
work_root = "$data/work"
secrets_dir = "$data/secrets"
socket_cli = "$data/no.sock"
EOF
  chmod 600 "$data/agent.toml"
  printf 'from=%s to=%s tries=0 deadline=%s\n' "$me" "$new" "$(( $(date +%s) + 600 ))" > "$data/pending"
  ln -s "versions/$me" "$data/previous"
  ln -s "versions/$new" "$data/current"

  mkdir -p "$HOME/.config/systemd/user/$unit.service.d"
  sed "s|^ExecStart=.*|ExecStart=$data/current/omarchy-agent run --data $data|" \
    crates/omarchy-agent/src/run/omarchy-agent.service > "$HOME/.config/systemd/user/$unit.service"
  printf '[Service]\nTimeoutStartSec=10\nWatchdogSec=30\nRestartSec=1\n' \
    > "$HOME/.config/systemd/user/$unit.service.d/fast.conf"
  systemctl --user daemon-reload
  systemctl --user reset-failed "$unit.service" 2>/dev/null || true
  systemctl --user start --no-block "$unit.service"
}

# (Whole outputs into grep, never `grep -q` in a pipe: the agent's status would
# meet a closed pipe.)
status() { "$data/current/omarchy-agent" status --data "$data"; }
restarts() { systemctl --user show -p NRestarts --value "$unit.service"; }
# The running agent's version, from the binary systemd started.
running() {
  pid="$(systemctl --user show -p MainPID --value "$unit.service")"
  [[ "$pid" != 0 ]] && "$(readlink -f "/proc/$pid/exe")" --version 2>/dev/null
}

wait_for() { # seconds, then a condition
  local until=$(( $(date +%s) + $1 )); shift
  until "$@"; do
    (( $(date +%s) < until )) || return 1
    sleep 1
  done
}

active_as() { [[ "$(systemctl --user is-active "$unit.service")" == active && "$(running)" == "omarchy-agent $1" ]]; }
gone() { [[ ! -e "$data/pending" ]]; }
rolled_back() {
  active_as "$me" && gone && grep -q '"outcome":"agent-rollback"' "$data/journal.ndjson"
}

# 1. A good build passes its gate: pending goes, it runs on, nothing restarts.
host good
wait_for 60 gone || fail "good: pending is still there: $(cat "$data/pending")"
wait_for 30 active_as "$new" || fail "good: not running as $new"
sleep 5
[[ "$(restarts)" == 0 ]] || fail "good: restarted $(restarts) times"
grep -q '"event":"agent-updated"' "$data/journal.ndjson" || fail "good: no agent-updated in the journal"
# The previous agent reads the state.json the new one wrote (a signed agent_to,
# or a rollback, puts it back).
grep -q "\"agent\": \"$new\"" "$data/state.json" || fail "good: state.json was not written by $new"
"$data/versions/$me/omarchy-agent" status --data "$data" | grep "state written by $new" >/dev/null \
  || fail "good: the previous agent does not read the new one's state.json"
echo "good: $new passed its health gate and runs; $me reads its state.json"
systemctl --user stop "$unit.service"

# 2-4. Broken builds are rolled back to the running agent, which skips them.
for b in panic-at-config hang-before-ready hang-after-ready; do
  host "$b"
  wait_for 240 rolled_back || fail "$b: not rolled back: $(status 2>&1 || true)"
  (( $(restarts) >= 3 )) || fail "$b: rolled back after $(restarts) restarts, not 3 starts"
  status | grep "$new was rolled back here and is skipped until a higher one" >/dev/null \
    || fail "$b: the skip is not recorded: $(status)"
  readlink "$data/current" | grep -qx "versions/$me" || fail "$b: current is $(readlink "$data/current")"
  echo "$b: rolled back to $me after $(restarts) restarts; $new skipped"
  systemctl --user stop "$unit.service"
done

if [[ -n "$task" ]]; then
  [[ "$(docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' "$task")" == "true $started" ]] \
    || fail "the container was stopped or restarted"
  echo "the container ran untouched throughout"
fi
echo "agent-self-update.sh: ok"
