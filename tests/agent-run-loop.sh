#!/usr/bin/env bash
# The host agent's run loop against a real engine (#315; design v2 §16.2):
# the pinned docker CLI and compose plugin of factory/bundle/manifest.toml,
# downloaded and checked like a host does, roll a stand-in dispatcher out
# release after release — a first release, one with two ordered restarts
# (exit 75) during its guard, a broken one the guard reverts and quarantines,
# and a rollback statement that preempts a round — while a long-running task
# container keeps running throughout. Decoy docker, compose and podman
# binaries first in PATH prove the agent runs only the pinned ones.
#
# Needs a Linux engine: `docker` (rootful, /var/run/docker.sock) or `podman`
# (rootless, its API socket; started here when it is not). CI runs both
# (ci.yml); by hand: `bash tests/agent-run-loop.sh docker|podman`.
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=tests/images.env
source tests/images.env

engine="${1:?usage: agent-run-loop.sh docker|podman}"
case "$engine" in
  docker) socket=/var/run/docker.sock ;;
  podman)
    socket="${XDG_RUNTIME_DIR:?rootless podman needs XDG_RUNTIME_DIR}/podman/podman.sock"
    if [[ ! -S "$socket" ]]; then
      systemctl --user start podman.socket 2>/dev/null \
        || { podman system service --time=0 "unix://$socket" & }
      for _ in $(seq 1 30); do [[ -S "$socket" ]] && break; sleep 1; done
    fi
    ;;
  *) echo "agent-run-loop.sh: docker or podman, not $engine" >&2; exit 2 ;;
esac
[[ -S "$socket" ]] || { echo "agent-run-loop.sh: no engine socket at $socket" >&2; exit 1; }

# docker.io/library/busybox:1.37.0@sha256:… → docker.io/library/busybox@sha256:…
image="${BUSYBOX%%@*}"
export OMARCHY_STANDIN_IMAGE="${image%:*}@${BUSYBOX#*@}"
export OMARCHY_AGENT_ENGINE_SOCKET="$socket"
cargo test --locked -p omarchy-agent --lib -- --ignored --exact \
  run::engine_tests::real_engine_rollouts_keep_the_task_running --nocapture
