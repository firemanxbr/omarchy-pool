#!/usr/bin/env bash
# The host agent's host orders against a real engine (#344; design v2 §11.1
# M4, M5, §13.4, §17.1, §21.1 step 6), with the pinned docker CLI and compose
# plugin of factory/bundle/manifest.toml: a stand-in dispatcher rolled out,
# a task container running, and beside them a stand-in legacy compose project
# (three services in a directory of their own, made by compose) and a
# project nobody recorded.
#
#   - reconcile-now: a round now, answered done; nothing replaced, nothing of
#     the legacy set touched;
#   - retire-legacy: the .omarchy-agent marker written into the legacy
#     project's directory first, then its containers stopped and removed and
#     its network removed — exactly that project's: the other project, the
#     task container and the dispatcher run on as they were, and the legacy
#     directory's files stay; legacy.json records the retirement and the
#     order is answered done;
#   - #325's settings, a narrowing of units end to end: set-units 2 and
#     set-emulate [] two seconds apart (the brake's pace), the dispatcher
#     recreated with the narrowed run/capacity.json it mounts while the task
#     container runs on; set-units 5, above what the host detected, refused
#     with nothing changed; diagnostics refused while the envelope does not
#     allow them, then the stand-in dispatcher's own log lines, the worker
#     token it printed scrubbed;
#   - #328's owner control without a visit: a passkey pinned at the host
#     (a virtual authenticator) signs a widening of max_units 2 → 6, counted
#     into the run/capacity.json the recreated dispatcher mounts while the
#     task runs on; the same document again refused as a replay; an agent
#     key sealed to the host's seal key written to the secrets directory's
#     agent.env and found in neither the dispatcher's env nor its mounts.
#
# The switch guards that then refuse in that directory (rollout.sh, setup.sh,
# omarchy-worker, the updater) run against the marker the agent writes in the
# crate's unit tests (run::orders). Needs a Linux engine: `docker` (rootful,
# /var/run/docker.sock) or `podman` (rootless, its API socket; started here
# when it is not). CI runs both (ci.yml); by hand:
# `bash tests/agent-host-orders.sh docker|podman`.
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=tests/images.env
source tests/images.env

engine="${1:?usage: agent-host-orders.sh docker|podman}"
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
  *) echo "agent-host-orders.sh: docker or podman, not $engine" >&2; exit 2 ;;
esac
[[ -S "$socket" ]] || { echo "agent-host-orders.sh: no engine socket at $socket" >&2; exit 1; }

# docker.io/library/busybox:1.37.0@sha256:… → docker.io/library/busybox@sha256:…
image="${BUSYBOX%%@*}"
export OMARCHY_STANDIN_IMAGE="${image%:*}@${BUSYBOX#*@}"
export OMARCHY_AGENT_ENGINE_SOCKET="$socket"
cargo test --locked -p omarchy-agent --lib -- --ignored --exact --test-threads 1 \
  run::engine_tests::real_engine_host_orders_reconcile_and_retire_the_legacy_set \
  run::engine_tests::real_engine_settings_narrow_the_mounted_capacity_and_diagnostics_are_scrubbed \
  run::engine_tests::real_engine_owner_widens_the_mounted_capacity_and_seals_keys_the_dispatcher_never_sees \
  --nocapture
