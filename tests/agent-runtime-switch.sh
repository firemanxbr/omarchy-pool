#!/usr/bin/env bash
# The owner's runtime switch against two real engines (#325; design v2 §15,
# v1 §10.4), with the pinned docker CLI and compose plugin of
# factory/bundle/manifest.toml: a stand-in dispatcher rolled out on the
# first engine, then `omarchy-agent runtime switch` asked at the host.
#
#   - refused, with nothing changed, while a task container of the host runs
#     on the engine the bundle runs on (tasks, named volumes and caches do
#     not move between engines);
#   - drained, the dispatcher stopped on the first engine and brought up on
#     the second through a whole round — pull, replace, the guard — with
#     nothing of the set left on the first, and agent.toml naming the second
#     engine's socket and runtime at its end.
#
# The way back when the new engine's guard fails, a restart mid-switch and
# every refusal run against two fake engines in the crate's unit tests
# (run::switch). Needs two Linux engines: rootful docker
# (OMARCHY_AGENT_ENGINE_SOCKET, /var/run/docker.sock) and the one to switch
# to (OMARCHY_AGENT_SWITCH_SOCKET; by default rootless podman's API socket,
# started here when it is not). CI runs docker to rootless podman (ci.yml);
# by hand: `bash tests/agent-runtime-switch.sh`.
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=tests/images.env
source tests/images.env

from="${OMARCHY_AGENT_ENGINE_SOCKET:-/var/run/docker.sock}"
to="${OMARCHY_AGENT_SWITCH_SOCKET:-}"
if [[ -z "$to" ]]; then
  to="${XDG_RUNTIME_DIR:?rootless podman needs XDG_RUNTIME_DIR}/podman/podman.sock"
  if [[ ! -S "$to" ]]; then
    systemctl --user start podman.socket || { podman system service --time=0 "unix://$to" & }
    for _ in $(seq 1 30); do [[ -S "$to" ]] && break; sleep 1; done
  fi
fi
[[ -S "$from" ]] || { echo "agent-runtime-switch.sh: no engine socket at $from" >&2; exit 1; }
[[ -S "$to" ]] || { echo "agent-runtime-switch.sh: no engine socket at $to" >&2; exit 1; }

# docker.io/library/busybox:1.37.0@sha256:… → docker.io/library/busybox@sha256:…
image="${BUSYBOX%%@*}"
export OMARCHY_STANDIN_IMAGE="${image%:*}@${BUSYBOX#*@}"
export OMARCHY_AGENT_ENGINE_SOCKET="$from"
export OMARCHY_AGENT_SWITCH_SOCKET="$to"
cargo test --locked -p omarchy-agent --lib -- --ignored --exact \
  run::engine_tests::real_engine_runtime_switch_moves_the_dispatcher_to_the_other_engine --nocapture
