#!/usr/bin/env bash
# The host agent's Quadlet driver (#330; design v2 §15, v1 §10.2) on a real
# rootless podman under this user's own systemd, with no compose:
#
#   - podman's generator (`quadlet -dryrun -user`) reads the host set as the
#     agent renders it — the template as release.yml renders it, the agent's
#     label overlay, a stand-in's script with `$`, `%`, quotes and newlines —
#     and the `podman run` it writes carries what compose would run: the image,
#     the mounts, the env file, the stop timeout, the labels, the same argv;
#   - the run loop rolls a stand-in dispatcher out as a unit of the user's
#     systemd (`~/.config/containers/systemd/omarchy-it-<pid>-dispatcher.container`,
#     daemon-reload and restart): a first release, one with two ordered
#     restarts (exit 75) during its guard, counted as the service's restarts,
#     a broken one never ready and one that crashes in its guard, both reverted
#     and quarantined, and a rollback statement preempting a round — while a
#     long-running task container keeps running throughout; podman's
#     AutoUpdate= is never written. Decoy docker, compose, podman and systemctl
#     first in PATH prove the agent runs only the pinned docker CLI and the
#     system's systemctl.
#
# The driver's every answer, a crash loop, a unit stopped by hand, a user
# manager that does not answer and the owner's switch to and from Quadlet run
# against a fake user systemd in the crate's unit tests (run::quadlet,
# run::switch).
#
# Needs Linux with podman 4.4 or later (its Quadlet generator) and a systemd
# user manager (CI: ubuntu-latest with linger, as agent-self-update). By hand:
# `bash tests/agent-quadlet.sh`; it writes one unit into
# ~/.config/containers/systemd and removes it at its end.
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=tests/images.env
source tests/images.env

fail() { echo "agent-quadlet.sh: $*" >&2; exit 1; }

quadlet=""
for q in /usr/libexec/podman/quadlet /usr/lib/podman/quadlet; do
  [[ -x "$q" ]] && { quadlet="$q"; break; }
done
[[ -n "$quadlet" ]] || fail "no podman Quadlet generator (podman 4.4 or later ships it)"

echo "==> podman's generator reads the host set as the agent renders it ($quadlet)"
OMARCHY_QUADLET="$quadlet" cargo test --locked -p omarchy-agent --lib -- --ignored --exact \
  quadlet::tests::the_generator_reads_the_rendered_host_set

systemctl --user show-environment >/dev/null 2>&1 \
  || fail "no systemd user manager (systemctl --user): enable linger, log in"
socket="${XDG_RUNTIME_DIR:?rootless podman needs XDG_RUNTIME_DIR}/podman/podman.sock"
if [[ ! -S "$socket" ]]; then
  systemctl --user start podman.socket
  for _ in $(seq 1 30); do [[ -S "$socket" ]] && break; sleep 1; done
fi
[[ -S "$socket" ]] || fail "no rootless podman API socket at $socket"
podman info --format '{{.Host.Security.Rootless}}' | grep -qx true \
  || fail "podman here is not rootless"

echo "==> the run loop on the Quadlet driver, under systemd --user, with a task that survives every rollout"
# docker.io/library/busybox:1.37.0@sha256:… → docker.io/library/busybox@sha256:…
image="${BUSYBOX%%@*}"
export OMARCHY_STANDIN_IMAGE="${image%:*}@${BUSYBOX#*@}"
export OMARCHY_AGENT_ENGINE_SOCKET="$socket"
if ! cargo test --locked -p omarchy-agent --lib -- --ignored --exact \
  run::engine_tests::real_engine_quadlet_rollouts_keep_the_task_running --nocapture; then
  journalctl --user -n 80 --no-pager -t quadlet-generator -t systemd 2>/dev/null >&2 || true
  fail "the run loop on the Quadlet driver"
fi
echo "agent-quadlet.sh: ok"
