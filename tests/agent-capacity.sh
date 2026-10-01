#!/usr/bin/env bash
# The agent's capacity probes on real engines (#333, design v2 §7.1):
#
# - rootful docker: CPUs and memory from `docker info`, free disk on the work
#   root and on the engine's data root, and a probe container that shows
#   `--cpus`, `--memory` and `--pids-limit` landing in its cgroup;
# - the same inside a systemd scope with CPUQuota=100% and MemoryMax=1G: the
#   detected totals drop to 1 CPU and 1 GB;
# - rootless podman through its Docker-compatible socket: both free-disk
#   values, and the `user` isolation level.
#
# The unit arithmetic, the minimum, the owner's caps, the preflight blockers
# and capacity.json are the crate's own tests (src/capacity/tests.rs), against
# the signed constants' layout; units need a signed release, so this script
# checks the probes. CI runs it in the rust job (ubuntu, x86_64 and aarch64);
# by hand: `bash tests/agent-capacity.sh` (needs docker; sudo and systemd for
# the scope, podman for the rootless part, each skipped when absent outside CI).
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
tmp="$(mktemp -d)"; trap 'kill "${podman_pid:-}" 2>/dev/null || true; rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
skip() { if [[ -n "${CI:-}" ]]; then fail "$* (required in CI)"; fi; echo "skipped: $*"; }
image=docker.io/library/busybox:1.37

cargo build -q --locked -p omarchy-agent
agent="$root/target/debug/omarchy-agent"

# check <json> <python expression on j> <what>
check() {
  python3 -c 'import json, sys; j = json.loads(sys.argv[1]); sys.exit(0 if eval(sys.argv[2]) else 1)' "$1" "$2" \
    || fail "$3: $1"
}
disks='all(isinstance(j["disk_free_gb"][k], int) for k in ("work", "engine"))'

if ! docker info >/dev/null 2>&1; then
  skip "no docker engine here"
else
  echo "==> rootful docker"
  out="$("$agent" capacity --work-root "$tmp" --probe-image "$image")"
  echo "$out"
  check "$out" "$disks" "both free-disk values"
  check "$out" 'j["isolation"] == "root"' "rootful docker is the root level"
  check "$out" 'j["limits"] == {"cpus_hard": True, "memory_hard": True, "pids": True}' "the limits hold"
  check "$out" '1 <= j["cpus"] <= j["engine"]["cpus"] and 1 <= j["mem_gb"] <= j["engine"]["mem_gb"]' "at most the engine's view"

  if command -v systemd-run >/dev/null && sudo -n true 2>/dev/null; then
    echo "==> inside a systemd scope with CPUQuota=100% and MemoryMax=1G"
    out="$(sudo -n systemd-run --scope --quiet -p CPUQuota=100% -p MemoryMax=1G -- \
      "$agent" capacity --work-root "$tmp" --probe-image "$image")"
    echo "$out"
    check "$out" 'j["cgroup"] == {"cpus": 1, "mem_gb": 1}' "the scope's limits are read"
    check "$out" 'j["cpus"] == 1 and j["mem_gb"] == 1' "the scope lowers the totals"
    check "$out" "$disks" "both free-disk values in the scope"
  else
    skip "no systemd-run or passwordless sudo for the scope"
  fi
fi

if ! command -v podman >/dev/null; then
  skip "no podman for the rootless part"
elif [[ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" != true ]]; then
  skip "podman here is not rootless"
else
  echo "==> rootless podman, through its Docker-compatible socket"
  podman system service --time=0 "unix://$tmp/podman.sock" & podman_pid=$!
  for _ in $(seq 50); do [[ -S "$tmp/podman.sock" ]] && break; sleep 0.2; done
  out="$(DOCKER_HOST="unix://$tmp/podman.sock" "$agent" capacity --work-root "$tmp" --probe-image "$image")"
  echo "$out"
  check "$out" "$disks" "both free-disk values on rootless podman"
  check "$out" 'j["isolation"] == "user"' "rootless podman is the user level"
  # Whether the limits hold depends on this machine's delegation; the crate's
  # tests make a rootless runtime without it a preflight blocker.
  check "$out" 'all(isinstance(v, bool) for v in j["limits"].values())' "the limits are probed"
fi
echo "ok"
