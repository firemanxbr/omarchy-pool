#!/usr/bin/env bash
# The host agent's install against a real engine (#317; design v2 §9.4,
# §13.2, §13.3), with the pinned docker CLI of factory/bundle/manifest.toml:
#
#   - the egress probe: a task that reaches a stand-in "LAN" address (a
#     container answering on the probe's network, on an open port or a closed
#     one) fails it; one that reaches only the stand-in public address passes;
#     the probe's own network is created in the task subnets and removed
#     again, after a network a probe left on its /28 was swept;
#   - a task network's gateway and the host's loopback (#367, #372): a signed
#     exception's bridge reaches its gateway (the host itself on rootful
#     docker, the engine's namespace on rootless podman) and, rootful, does
#     not behind an INPUT drop for a test /28 of its own (the rule
#     prep-root.sh's OMARCHY-TASKS-HOST chain holds for each task subnet),
#     which this script adds for the run where it may (a rootful engine, and
#     root or `sudo -n`); a task's own network, made as the dispatcher makes
#     it (on podman through libpod's API: internal, DNS off, no gateway), has
#     no gateway a task reaches, on docker and podman alike; a rootless
#     engine's network stack, read in /proc while both probe tasks run as
#     preflight reads it, is seen and maps nothing to the host's loopback; on
#     rootless podman behind pasta, a service of the host's answers through
#     pasta's guest-mapped address exactly when pasta maps it (podman 5.3 on),
#     which preflight refuses with containers.conf's setting;
#   - the probe the way a task runs (#373): on a network made like a task's,
#     behind its egress sidecar — the worker image's egress role, started as
#     the dispatcher starts one, with its deny list (the task subnets, this
#     machine's own addresses) — the metadata address, this machine's router,
#     LAN and own addresses and the network's gateway are unreachable straight
#     and refused through the sidecar, and GitHub answers through it, so
#     preflight's egress check passes on rootful docker and rootless podman
#     alike; and it still fails where a task could reach what it must not: a
#     network made without --internal reaches the LAN, and a public address of
#     the host's the sidecar was not given (a stand-in: GitHub's) answers
#     through it until the sidecar is given it. The sidecar's image is
#     WORKER_IMAGE (ci.yml's image job passes the worker image it built), else
#     a stand-in built here: this commit's `pkg-repo egress` on the Arch base
#     the worker image is built from, for this machine's architecture
#     (ARCHLINUX_BASE on x86_64, ARCHLINUXARM_BASE on aarch64), started as its
#     entrypoint starts the egress role (the worker image itself needs the Arch
#     mirrors to build) — so on Linux only, x86_64 or aarch64: elsewhere (a Mac
#     against a podman machine) WORKER_IMAGE is needed. The probe task runs
#     twice, from busybox (sh and nc) and from that Arch base (bash, as the
#     release's build image has it), so both ways the script reaches a target
#     meet the real sidecar;
#   - the dispatcher's own task network on the same engine (pkg-repo's
#     dispatch::engine test, through the pinned docker CLI the agent's tests
#     fetched, the version the worker image runs): internal, no gateway
#     (docker's isolated mode; on podman made through libpod's API with DNS
#     off), nothing at its .1 for a task; and on it the probe's own argv
#     (#399) reading a 0600 keys file of the runner's as its owner as the
#     engine shows it (--user 0:0 rootless, the file's uid:gid rootful, where
#     the image's root with no capability cannot);
#   - a stand-in legacy compose project (two containers, a network, a bind
#     mount) is read as preflight reads it, and uninstall's removal takes the
#     new host's task container but leaves every legacy container running,
#     with the same ids before and after.
#
# Linger, the unit and a reboot need a VM (Ubuntu LTS, Fedora, Arch): see
# the runbook's host install. Needs a Linux engine: `docker` (rootful,
# /var/run/docker.sock) or `podman` (rootless, its API socket; started here
# when it is not); OMARCHY_AGENT_ENGINE_SOCKET names another socket (a
# podman machine's); and the internet (GitHub, through the egress sidecar).
# CI runs both (ci.yml), and the image job again with the worker image it
# built; by hand: `bash tests/agent-install.sh docker|podman`, with
# WORKER_IMAGE=<image> to use a worker image instead of the stand-in.
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

# An INPUT drop for one test /28, as prep-root.sh's OMARCHY-TASKS-HOST holds one for each task
# subnet, for this run only: a rootful engine's bridge gateway is the host, and behind the drop a
# task reaches nothing of it. A rootless engine's bridges live in its own namespace, which INPUT
# never sees: no drop there.
ipt() { if [[ $EUID -eq 0 ]]; then iptables -w "$@"; else sudo -n iptables -w "$@"; fi; }
drop=(INPUT -s 10.197.9.240/28 -j DROP)
dropped="" standin="" ctx=""
cleanup() {
  [[ -z "$dropped" ]] || ipt -D "${drop[@]}" 2>/dev/null || true
  [[ -z "$standin" ]] || cli rmi -f "$standin" >/dev/null 2>&1 || true
  [[ -z "$ctx" ]] || rm -rf "$ctx"
}
trap cleanup EXIT
rootful() { ! docker -H "unix://$socket" info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q name=rootless; }
if [[ "$engine" == docker ]] && rootful && ipt -S INPUT >/dev/null 2>&1; then
  ipt -I "${drop[@]}"
  dropped=1
  export OMARCHY_TEST_INPUT_DROP=10.197.9.240/28
fi

# The Arch base the worker image and the release's build image are built from, for this
# machine's architecture, as emulated-lane.sh picks it (a Mac's podman machine runs the Mac's).
case "$(uname -m)" in
  x86_64) arch_base="$ARCHLINUX_BASE" ;;
  aarch64|arm64) arch_base="$ARCHLINUXARM_BASE" ;;
  *) echo "agent-install.sh: no Arch base for $(uname -m) (x86_64 or aarch64)" >&2; exit 1 ;;
esac
# The probe task's image with bash (#373): the release's build image probes with bash's
# /dev/tcp, busybox with nc; the tests run both against the sidecar.
export OMARCHY_BASH_IMAGE="$arch_base"

# The egress sidecar's image (#373): WORKER_IMAGE, or a stand-in made here from this commit's
# `pkg-repo egress`, on the Arch base the worker image is built from (its glibc is the newest),
# started as factory/image/entrypoint.sh starts the egress role. Built with the engine's own CLI,
# into the store its socket serves. The binary is this machine's, so the stand-in needs a Linux
# one: elsewhere (a Mac against a podman machine) it would hold a binary the engine cannot run.
cli() { if [[ "$engine" == podman ]]; then podman "$@"; else docker -H "unix://$socket" "$@"; fi; }
if [[ -n "${WORKER_IMAGE:-}" ]]; then
  export OMARCHY_EGRESS_IMAGE="$WORKER_IMAGE"
else
  [[ "$(uname -s)" == Linux ]] || { echo "agent-install.sh: the egress stand-in is this machine's pkg-repo, which only a Linux one can run: set WORKER_IMAGE=<a worker image> here" >&2; exit 1; }
  cargo build --locked -q -p pkg-repo
  ctx="$(mktemp -d)"
  cp target/debug/pkg-repo "$ctx/pkg-repo"
  strip "$ctx/pkg-repo" 2>/dev/null || true
  cat > "$ctx/entrypoint" <<'SH'
#!/bin/sh
# A stand-in for factory/image/entrypoint.sh, its egress role only (#336).
[ "$OMARCHY_WORKER_ROLE" = egress ] || { echo "egress stand-in: OMARCHY_WORKER_ROLE=egress only" >&2; exit 2; }
exec pkg-repo egress "$@"
SH
  chmod 755 "$ctx/pkg-repo" "$ctx/entrypoint"
  printf 'FROM %s\nCOPY pkg-repo entrypoint /usr/local/bin/\nENTRYPOINT ["/usr/local/bin/entrypoint"]\n' "$arch_base" > "$ctx/Containerfile"
  standin="localhost/omarchy-egress-standin:$$"
  cli build -q -t "$standin" -f "$ctx/Containerfile" "$ctx" >/dev/null
  export OMARCHY_EGRESS_IMAGE="$standin"
fi

# One at a time: each probe sweeps every probe container and network it finds.
cargo test --locked -p omarchy-agent --lib -- --ignored --exact --test-threads=1 --nocapture \
  install::tests::engine_tests::real_engine_egress_probe_and_legacy_project \
  install::tests::engine_tests::real_engine_a_tasks_gateway_and_the_hosts_loopback \
  install::tests::engine_tests::real_engine_the_probe_runs_the_way_a_task_runs_and_fails_where_a_task_could_reach_the_lan
# The dispatcher's task network on the same engine, through the pinned docker CLI on this socket
# (#372): made the way the probe above made its own. The CLI is the one the agent's tests above
# fetched (OMARCHY_AGENT_DOCKER_CLI, or the release's pin for this platform under the temp
# directory), the version the worker image runs: on podman 4 docker's CLI from 29 on cannot read
# such a network's "<nil>" gateway, so the runner's own docker is not what the dispatcher runs.
platform="$(uname -m)-linux"
pin="$(sed -n "/^\[tools\.$platform\.docker\]/,/^sha256/s/^sha256 = \"\([0-9a-f]\{64\}\)\"$/\1/p" factory/bundle/manifest.toml)"
cli="${OMARCHY_AGENT_DOCKER_CLI:-${TMPDIR:-/tmp}/omarchy-agent-install-tools/$pin/docker}"
[[ -x "$cli" ]] || { echo "agent-install.sh: no pinned docker CLI at $cli" >&2; exit 1; }
OMARCHY_DISPATCH_CLI="$cli" DOCKER_HOST="unix://$socket" cargo test --locked -p pkg-repo --lib -- --ignored --exact --nocapture \
  dispatch::engine::tests::real_engine_a_task_network_made_here_has_no_gateway \
  dispatch::engine::tests::real_engine_the_probe_reads_owner_only_keys_as_their_owner
