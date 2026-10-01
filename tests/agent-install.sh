#!/usr/bin/env bash
# The host agent's install against a real engine (#317; design v2 §9.4,
# §13.2, §13.3), with the pinned docker CLI of factory/bundle/manifest.toml:
#
#   - the egress probe: a task that reaches a stand-in "LAN" address (a
#     container answering on the probe's network, on an open port or a closed
#     one) fails it; one that reaches only the stand-in public address passes;
#     the probe's own network is created in the task subnets and removed
#     again, after a network a probe left on its /28 was swept;
#   - a stand-in legacy compose project (two containers, a network, a bind
#     mount) is read as preflight reads it, and uninstall's removal takes the
#     new host's task container but leaves every legacy container running,
#     with the same ids before and after.
#
# Linger, the unit and a reboot need a VM (Ubuntu LTS, Fedora, Arch): see
# the runbook's host install. Needs a Linux engine: `docker` (rootful,
# /var/run/docker.sock) or `podman` (rootless, its API socket; started here
# when it is not); OMARCHY_AGENT_ENGINE_SOCKET names another socket (a
# podman machine's). CI runs both (ci.yml); by hand:
# `bash tests/agent-install.sh docker|podman`.
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=tests/images.env
source tests/images.env

engine="${1:?usage: agent-install.sh docker|podman}"
case "$engine" in
  docker) socket="${OMARCHY_AGENT_ENGINE_SOCKET:-/var/run/docker.sock}" ;;
  podman)
    socket="${OMARCHY_AGENT_ENGINE_SOCKET:-${XDG_RUNTIME_DIR:?rootless podman needs XDG_RUNTIME_DIR}/podman/podman.sock}"
    if [[ ! -S "$socket" ]]; then
      systemctl --user start podman.socket 2>/dev/null \
        || { podman system service --time=0 "unix://$socket" & }
      for _ in $(seq 1 30); do [[ -S "$socket" ]] && break; sleep 1; done
    fi
    ;;
  *) echo "agent-install.sh: docker or podman, not $engine" >&2; exit 2 ;;
esac
[[ -S "$socket" ]] || { echo "agent-install.sh: no engine socket at $socket" >&2; exit 1; }

# docker.io/library/busybox:1.37.0@sha256:… → docker.io/library/busybox@sha256:…
image="${BUSYBOX%%@*}"
export OMARCHY_STANDIN_IMAGE="${image%:*}@${BUSYBOX#*@}"
export OMARCHY_AGENT_ENGINE_SOCKET="$socket"
cargo test --locked -p omarchy-agent --lib -- --ignored --exact \
  install::tests::engine_tests::real_engine_egress_probe_and_legacy_project --nocapture
