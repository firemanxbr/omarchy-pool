#!/usr/bin/env bash
# The image's entrypoint (factory/image/entrypoint.sh) in the agent role,
# with a Claude subscription as the agent (#277): a `claude` that does not
# answer `claude --version` — an install cut short, which `docker restart`
# keeps — is removed and installed again (a stubbed installer); one that
# answers is left alone; none at all is installed. A restart of the agent
# service, by an order or by hand, then fixes a broken install too. The
# broker it starts is a stub that says it ran. And on a maintainer host
# (#336): the egress role is `pkg-repo egress` with the dispatcher's
# arguments; an agent sidecar reads its keys from the read-only file
# OMARCHY_AGENT_ENV names — the agent's settings only, a worker token in the
# file or the environment dropped, nothing in it run — and `--probe` runs
# agent.py's probe instead of the broker. The legacy sets' updater and
# broker roles are gone (#346): a container that asks for one is refused,
# with the pointer to the maintainer-host docs, before anything starts; and
# a project worker writes no id for an updater any more.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
export STUB_LOG="$tmp/log"
# The installer claude.ai serves, as curl would hand it to bash: it writes a claude that answers. The pool's workers/self: a legacy project registration.
cat > "$tmp/bin/curl" <<'S'
#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
case "$*" in *"/api/v1/factory/workers/self"*) printf '{"id":"m1-studio-pool-aarch64-7f3a","trust":"project","arch":"%s","owner":"m1"}\n' "$STUB_ARCH"; exit 0 ;; esac
cat <<'I'
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\necho "2.0.0 (Claude Code)"\n' > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
echo "installed" >> "$STUB_LOG"
I
S
# The broker, as the entrypoint starts it at its end; pkg-repo, as a project worker's entrypoint starts it at its end.
cat > "$tmp/bin/python3" <<'S'
#!/usr/bin/env bash
echo "broker started: $*" >> "$STUB_LOG"
echo "env: key=${ANTHROPIC_API_KEY:-} gh=${GITHUB_TOKEN:-} model=${FACTORY_MODEL:-} wt=${OMARCHY_WORKER_TOKEN:-} ft=${FACTORY_TOKEN:-} evil=${EVIL:-}" >> "$STUB_LOG"
S
cat > "$tmp/bin/pkg-repo" <<'S'
#!/usr/bin/env bash
echo "pkg-repo $*" >> "$STUB_LOG"
S
chmod +x "$tmp/bin/curl" "$tmp/bin/python3" "$tmp/bin/pkg-repo"
# timeout is coreutils' on the image; here it only runs the command.
printf '#!/usr/bin/env bash\nshift; exec "$@"\n' > "$tmp/bin/timeout"; chmod +x "$tmp/bin/timeout"

run() { # home — the agent role, with the subscription token
  : > "$STUB_LOG"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$1" STUB_LOG="$STUB_LOG" OMARCHY_WORKER_ROLE=agent CLAUDE_CODE_OAUTH_TOKEN=stub-token bash "$root/factory/image/entrypoint.sh" 2> "$tmp/stderr"
}

# 1. None there: installed, then the broker starts.
run "$tmp/none"
grep -q '^installed$' "$STUB_LOG" && grep -q '^broker started' "$STUB_LOG" || { echo "installed when missing: $(cat "$STUB_LOG" "$tmp/stderr")"; exit 1; }

# 2. One that answers: left alone.
run "$tmp/none"
! grep -q '^installed$' "$STUB_LOG" && grep -q '^broker started' "$STUB_LOG" || { echo "one that answers is not installed again: $(cat "$STUB_LOG")"; exit 1; }

# 3. One that is there and does not answer — cut short: removed and installed again, and it answers now.
mkdir -p "$tmp/broken/.local/bin"
printf '#!/bin/sh\nexit 1\n' > "$tmp/broken/.local/bin/claude"; chmod +x "$tmp/broken/.local/bin/claude"
run "$tmp/broken"
grep -q '^installed$' "$STUB_LOG" || { echo "a claude that does not answer is installed again: $(cat "$STUB_LOG" "$tmp/stderr")"; exit 1; }
grep -q 'does not answer --version' "$tmp/stderr" || { echo "and says why: $(cat "$tmp/stderr")"; exit 1; }
"$tmp/broken/.local/bin/claude" --version | grep -q 'Claude Code' || { echo "the new one answers"; exit 1; }

# 4. Without the subscription token, nothing is installed.
: > "$STUB_LOG"
env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/other" STUB_LOG="$STUB_LOG" OMARCHY_WORKER_ROLE=agent bash "$root/factory/image/entrypoint.sh" 2>/dev/null
! grep -q '^curl' "$STUB_LOG" || { echo "no token, no install: $(cat "$STUB_LOG")"; exit 1; }

# 5. A legacy project worker (the pool role) goes on to pkg-repo work, and writes no id for an updater (#346): there is none.
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64
: > "$STUB_LOG"
env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/proj" STUB_LOG="$STUB_LOG" STUB_ARCH="$arch" OMARCHY_WORKER_ROLE=pool OMARCHY_WORKER_TOKEN=omw_secret_token \
  OMARCHY_RUN_DIR="$tmp/run/omarchy" DOCKER_HOST=tcp://127.0.0.1:2375 OMARCHY_WORK_DIR="$tmp/work" bash "$root/factory/image/entrypoint.sh" 2> "$tmp/stderr"
grep -q '^pkg-repo work --arch' "$STUB_LOG" || { echo "a project worker goes on to pkg-repo work: $(cat "$STUB_LOG" "$tmp/stderr")"; exit 1; }
[[ ! -e "$tmp/run/omarchy/worker-id" ]] || { echo "a project worker writes no worker-id: nothing reads it"; exit 1; }
# The updater and the broker roles: refused before anything runs, with where a maintainer's machine goes now.
for gone in updater broker; do
  : > "$STUB_LOG"
  if env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/gone" STUB_LOG="$STUB_LOG" OMARCHY_WORKER_ROLE="$gone" OMARCHY_WORKER_TOKEN=omw_x bash "$root/factory/image/entrypoint.sh" 2> "$tmp/stderr"; then
    echo "the $gone role started"; exit 1
  fi
  grep -q "the $gone role is gone (#346)" "$tmp/stderr" && grep -q 'docs/worker-host' "$tmp/stderr" && [[ ! -s "$STUB_LOG" ]] || { echo "the $gone role: $(cat "$tmp/stderr" "$STUB_LOG")"; exit 1; }
done
# 6. The egress role (#336): pkg-repo egress, with what the dispatcher passed.
: > "$STUB_LOG"
env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/eg" STUB_LOG="$STUB_LOG" OMARCHY_WORKER_ROLE=egress bash "$root/factory/image/entrypoint.sh" --listen 10.231.0.2:3128 --deny 10.231.0.0/16 2> "$tmp/stderr"
grep -qx 'pkg-repo egress --listen 10.231.0.2:3128 --deny 10.231.0.0/16' "$STUB_LOG" || { echo "the egress role: $(cat "$STUB_LOG" "$tmp/stderr")"; exit 1; }

# 7. An agent sidecar: its keys from the file, quoted or not; a worker token in the file or the environment dropped; a line that would run something is only text.
cat > "$tmp/agent.env" <<'E'
# the agent's keys, written by omarchy-agent
ANTHROPIC_API_KEY="sk-ant-from-the-file"
export GITHUB_TOKEN=github_pat_public_read
FACTORY_MODEL='claude-sonnet-5'
OMARCHY_WORKER_TOKEN=omw_must_not_load
EVIL=$(touch /tmp/omarchy-entrypoint-pwned)
E
: > "$STUB_LOG"
env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/side" STUB_LOG="$STUB_LOG" OMARCHY_WORKER_ROLE=agent OMARCHY_AGENT_ENV="$tmp/agent.env" OMARCHY_WORKER_TOKEN=omw_env FACTORY_TOKEN=omw_env2 bash "$root/factory/image/entrypoint.sh" 2> "$tmp/stderr"
grep -qx 'env: key=sk-ant-from-the-file gh=github_pat_public_read model=claude-sonnet-5 wt= ft= evil=' "$STUB_LOG" || { echo "an agent sidecar's keys: $(cat "$STUB_LOG" "$tmp/stderr")"; exit 1; }
grep -q 'broker started: /usr/local/lib/omarchy-factory/bin/broker' "$STUB_LOG" || { echo "the sidecar is the broker: $(cat "$STUB_LOG")"; exit 1; }
grep -q 'OMARCHY_WORKER_TOKEN is not an agent setting; ignored' "$tmp/stderr" && grep -q 'EVIL is not an agent setting' "$tmp/stderr" || { echo "what it ignores, it names: $(cat "$tmp/stderr")"; exit 1; }
[[ ! -e /tmp/omarchy-entrypoint-pwned ]] || { echo "a line of the keys file ran"; exit 1; }
# 8. The probe sidecar: agent.py --probe, with the file's keys; a missing file is a refusal, not an agent without keys.
: > "$STUB_LOG"
env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/side" STUB_LOG="$STUB_LOG" OMARCHY_WORKER_ROLE=agent OMARCHY_AGENT_ENV="$tmp/agent.env" bash "$root/factory/image/entrypoint.sh" --probe 2> "$tmp/stderr"
grep -q 'broker started: /usr/local/lib/omarchy-factory/bin/agent.py --probe' "$STUB_LOG" && grep -q 'key=sk-ant-from-the-file' "$STUB_LOG" || { echo "the probe: $(cat "$STUB_LOG" "$tmp/stderr")"; exit 1; }
: > "$STUB_LOG"
if env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/side" STUB_LOG="$STUB_LOG" OMARCHY_WORKER_ROLE=agent OMARCHY_AGENT_ENV="$tmp/missing.env" bash "$root/factory/image/entrypoint.sh" 2> "$tmp/stderr"; then
  echo "a missing keys file must stop the sidecar"; exit 1
fi
grep -q "no agent keys at $tmp/missing.env" "$tmp/stderr" && [[ ! -s "$STUB_LOG" ]] || { echo "and say so: $(cat "$tmp/stderr" "$STUB_LOG")"; exit 1; }
echo "entrypoint agent: ok"
