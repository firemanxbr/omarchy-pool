#!/usr/bin/env bash
# The host set (factory/sets/host, #310), as release.yml will ship it:
#
# - `omarchy-agent lint-set factory/sets/host` is clean: the template and its
#   set.toml (schema 3) against design v2 §4.3 (the crate's own tests make a
#   second service, a missing role label and an interpolated agent key fail);
# - `docker compose config` loads the template once its placeholders are
#   filled as release.yml and the agent fill them: one service, the
#   dispatcher, its role label, the worker image by digest, the env file, the
#   socket, the work root at the same path inside and outside, capacity.json
#   read-only, its host worker token as a read-only file
#   (OMARCHY_WORKER_TOKEN_FILE, #327) and no token in its environment, no
#   port, and no variable left unset;
# - factory/sizing/tasks.toml is schema 1, and every network exception in it
#   is "direct" with its reason (the dispatcher reads them, #336).
#
# Needs cargo, docker compose (or docker-compose) and python3 (3.11+). CI runs
# it in the rust job; by hand: `bash tests/host-set.sh`.
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "==> lint-set factory/sets/host"
cargo run -q --locked -p omarchy-agent -- lint-set factory/sets/host

echo "==> docker compose config, the placeholders filled"
if docker compose version >/dev/null 2>&1; then compose=(docker compose)
elif docker-compose version >/dev/null 2>&1; then compose=(docker-compose)
else fail "no docker compose here"; fi
digest() { printf 'sha256:%s' "$(printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1)"; }
worker="ghcr.io/firemanxbr/omarchy-worker@$(digest worker)"
aarch64="docker.io/menci/archlinuxarm@$(digest aarch64)"
x86_64="docker.io/library/archlinux@$(digest x86_64)"
cp -R factory/sets/host "$tmp/set"
sed -e "s|@RELEASE_IMAGE@|$worker|" -e "s|@BUILD_AARCH64@|$aarch64|" -e "s|@BUILD_X86_64@|$x86_64|" \
  -e "s|@RELEASE@|@${worker#*@}|" factory/sets/host/compose.yml > "$tmp/set/compose.yml"
! grep -q '@[A-Z_0-9]*@' "$tmp/set/compose.yml" || fail "a placeholder left: $(grep '@[A-Z_0-9]*@' "$tmp/set/compose.yml")"
# What the agent writes before compose loads the set (set.toml [needs] env_files, capacity.json, the token file, #327).
mkdir -p "$tmp/set/etc" "$tmp/set/run/host/dispatcher"
printf '# worker: m1-rack-0a9z\nOMARCHY_HOST_ADDRESSES=192.168.1.20\n' > "$tmp/set/etc/dispatcher.env"
echo '{"schema":2}' > "$tmp/set/run/capacity.json"
printf 'omw_test\n' > "$tmp/set/run/host/dispatcher/token"; chmod 400 "$tmp/set/run/host/dispatcher/token"
project="$(sed -n 's/^project_default = "\(.*\)"$/\1/p' factory/sets/host/set.toml)"
[[ "$project" == omarchy-host ]] || fail "set.toml project_default: $project"
work=/srv/omarchy-pool/host
env -i PATH="$PATH" HOME="$tmp" DOCKER_CONFIG="$tmp/docker" \
  OMARCHY_WORK_ROOT="$work" OMARCHY_SECRETS_DIR=/srv/omarchy-pool/host-secrets OMARCHY_SOCKET=/var/run/docker.sock \
  "${compose[@]}" --project-directory "$tmp/set" -p "$project" -f "$tmp/set/compose.yml" config --format json \
  > "$tmp/config.json" 2> "$tmp/config.err" || { cat "$tmp/config.err" >&2; fail "docker compose config refused the template"; }
! grep -qi 'not set\|warn' "$tmp/config.err" || { cat "$tmp/config.err" >&2; fail "docker compose config warned"; }

python3 - "$tmp/config.json" "$tmp/set" "$work" "$worker" "$aarch64" "$x86_64" <<'EOF'
import json, sys
path, setdir, work, worker, aarch64, x86_64 = sys.argv[1:]
c = json.load(open(path))
def check(ok, what):
    if not ok:
        sys.exit(f"FAIL: compose config: {what}\n{json.dumps(c, indent=1)}")
check(c["name"] == "omarchy-host", "the project is omarchy-host")
check(list(c["services"]) == ["dispatcher"], "exactly one service, the dispatcher")
d = c["services"]["dispatcher"]
check(d["labels"] == {"org.omarchy-pool.role": "dispatcher"}, "the role label")
check(d["image"] == worker, "the worker image by digest")
env = d["environment"]
check(env["OMARCHY_WORKER_ROLE"] == "dispatcher", "OMARCHY_WORKER_ROLE")
check(env["OMARCHY_WORK_ROOT"] == work, "OMARCHY_WORK_ROOT")
check(env["OMARCHY_SECRETS_DIR"] == "/srv/omarchy-pool/host-secrets", "OMARCHY_SECRETS_DIR, a path only")
check(env["OMARCHY_CAPACITY_FILE"] == "/run/omarchy/capacity.json", "OMARCHY_CAPACITY_FILE")
check(env["OMARCHY_BUILD_IMAGE_AARCH64"] == aarch64 and env["OMARCHY_BUILD_IMAGE_X86_64"] == x86_64, "the build images")
check(env["OMARCHY_WORKER_IMAGE"] == worker, "OMARCHY_WORKER_IMAGE")
check(env["OMARCHY_TASK_SUBNETS"] == "10.231.0.0/16", "OMARCHY_TASK_SUBNETS's default")
check(env.get("OMARCHY_HOST_ADDRESSES") == "192.168.1.20", "the env file etc/dispatcher.env loaded")
check(env["OMARCHY_WORKER_TOKEN_FILE"] == "/run/omarchy/worker-token", "OMARCHY_WORKER_TOKEN_FILE, the token's read-only file")
check("OMARCHY_WORKER_TOKEN" not in env and not any("omw_" in str(v) for v in env.values()), "no worker token in the environment (#327)")
check(not any(k.startswith(("ANTHROPIC_", "OPENAI_", "GEMINI_", "XAI_")) or k in ("CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN") for k in env), "no agent key or GitHub token")
vols = {(v["source"], v["target"], v.get("read_only", False)) for v in d["volumes"]}
check(vols == {("/var/run/docker.sock", "/var/run/docker.sock", False),
               (work, work, False),
               (f"{setdir}/run/capacity.json", "/run/omarchy/capacity.json", True),
               (f"{setdir}/run/host/dispatcher/token", "/run/omarchy/worker-token", True)},
      f"the volumes: the socket, the work root at its own path, capacity.json and the token file read-only (got {vols})")
token = next(v for v in d["volumes"] if v["target"] == "/run/omarchy/worker-token")
check(token["type"] == "bind" and token.get("bind", {}).get("create_host_path") is False,
      f"the token file is a bind compose never makes a directory for (got {token})")
check(not any("host-secrets" in v["source"] for v in d["volumes"]), "the secrets directory is not mounted")
check("ports" not in d and not d.get("privileged") and "cap_add" not in d and "network_mode" not in d, "no port, privilege, capability or host network")
check(d["restart"] == "unless-stopped", "restart: unless-stopped")
check(d["stop_grace_period"] in ("1m0s", "60s", "1m"), f"stop_grace_period 60s (got {d['stop_grace_period']})")
print("    one dispatcher, as design v2 §4.2 has it")
EOF

echo "==> factory/sizing/tasks.toml"
python3 - <<'EOF'
import sys, tomllib
t = tomllib.load(open("factory/sizing/tasks.toml", "rb"))
if t.get("schema") != 1 or set(t) - {"schema", "package"}:
    sys.exit(f"FAIL: factory/sizing/tasks.toml must be schema 1, found {t}")
for name, e in t.get("package", {}).items():
    if set(e) - {"size", "disk_gb", "network", "reason"}:
        sys.exit(f"FAIL: factory/sizing/tasks.toml: {name} has a key outside schema 1: {e}")
    if "network" in e and (e["network"] != "direct" or not str(e.get("reason", "")).strip()):
        sys.exit(f"FAIL: factory/sizing/tasks.toml: {name}'s network exception must be \"direct\" with a reason: {e}")
print(f"    schema 1, {sum('network' in e for e in t.get('package', {}).values())} network exception(s)")
EOF

echo "host set: lint-set clean, compose loads it, sizing schema 1"
