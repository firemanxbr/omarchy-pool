#!/usr/bin/env bash
# The image's entrypoint (factory/image/entrypoint.sh) and the worker token as
# a read-only file (#327, design v2 §14, D15): OMARCHY_WORKER_TOKEN_FILE wins
# over OMARCHY_WORKER_TOKEN, whose value `docker inspect` shows anyone who can
# talk to the engine's socket.
#
# - the dispatcher: pkg-repo dispatch is started with the file's path and no
#   token in its environment (pkg-repo reads the file itself; its own unit
#   tests prefer the file); a file that is named but missing, unreadable or
#   empty stops it before pkg-repo starts, never falling back to the plain
#   variable; the plain variable alone still starts it (a dispatcher started
#   from an older release's template); neither stops it;
# - the roles that hold the token in their processes (a project worker, the
#   broker): the file's token is the one the pool is asked with and the one
#   pkg-repo work and the broker get, the plain variable's ignored;
# - an agent sidecar and a builder behind a broker: no token, the file's path
#   dropped too (and named, for the builder).
#
# Stubs for curl, pkg-repo and python3 (the broker); no engine. CI runs it
# beside tests/entrypoint-agent.sh; by hand: `bash tests/entrypoint-token-file.sh`.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
export STUB_LOG="$tmp/log"
fail() { echo "entrypoint-token-file: FAIL — $*" >&2; exit 1; }
# The pool's workers/self: a project registration of this machine's architecture, for any bearer.
cat > "$tmp/bin/curl" <<'S'
#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
case "$*" in *"/api/v1/factory/workers/self"*) printf '{"id":"m1-rack-pool-7f3a","trust":"project","arch":"%s","owner":"m1"}\n' "$STUB_ARCH"; exit 0 ;; esac
exit 22
S
# pkg-repo and the broker (python3): what they were started with, and the token they hold.
cat > "$tmp/bin/pkg-repo" <<'S'
#!/usr/bin/env bash
echo "pkg-repo $* | wt=${OMARCHY_WORKER_TOKEN:-} wtf=${OMARCHY_WORKER_TOKEN_FILE:-}" >> "$STUB_LOG"
S
cat > "$tmp/bin/python3" <<'S'
#!/usr/bin/env bash
echo "python3 $* | wt=${OMARCHY_WORKER_TOKEN:-} wtf=${OMARCHY_WORKER_TOKEN_FILE:-}" >> "$STUB_LOG"
S
printf '#!/usr/bin/env bash\nshift; exec "$@"\n' > "$tmp/bin/timeout"
chmod +x "$tmp/bin/curl" "$tmp/bin/pkg-repo" "$tmp/bin/python3" "$tmp/bin/timeout"
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64

# The agent's file: one token on one line, 0400.
printf 'omw_from_the_file\n' > "$tmp/token"; chmod 400 "$tmp/token"
: > "$tmp/empty"
entry() { # NAME=value … — the entrypoint, from an empty environment but these
  : > "$STUB_LOG"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp/home" STUB_LOG="$STUB_LOG" STUB_ARCH="$arch" DOCKER_HOST=tcp://127.0.0.1:2375 "$@" \
    bash "$root/factory/image/entrypoint.sh" 2> "$tmp/stderr"
}

# 1. The dispatcher, as the host set starts it: the file's path, no token in its environment.
entry OMARCHY_WORKER_ROLE=dispatcher OMARCHY_WORKER_TOKEN_FILE="$tmp/token" || fail "the dispatcher with its token file: $(cat "$tmp/stderr")"
[[ "$(cat "$STUB_LOG")" == "pkg-repo dispatch | wt= wtf=$tmp/token" ]] || fail "pkg-repo dispatch gets the file, not a token: $(cat "$STUB_LOG")"
# The file wins: a plain variable beside it (the agent's file of an upgrade window) changes nothing here.
entry OMARCHY_WORKER_ROLE=dispatcher OMARCHY_WORKER_TOKEN_FILE="$tmp/token" OMARCHY_WORKER_TOKEN=omw_plain || fail "with both: $(cat "$tmp/stderr")"
grep -q "^pkg-repo dispatch | .* wtf=$tmp/token$" "$STUB_LOG" || fail "with both, the file's path still: $(cat "$STUB_LOG")"
echo "ok: the dispatcher starts with its token's file"

# 2. A file named but missing, unreadable or empty stops it before pkg-repo starts, whatever the plain variable says.
for f in "$tmp/missing" "$tmp/empty" "$tmp"; do
  if entry OMARCHY_WORKER_ROLE=dispatcher OMARCHY_WORKER_TOKEN_FILE="$f" OMARCHY_WORKER_TOKEN=omw_plain; then fail "the dispatcher started with OMARCHY_WORKER_TOKEN_FILE=$f"; fi
  [[ ! -s "$STUB_LOG" ]] || fail "pkg-repo ran with OMARCHY_WORKER_TOKEN_FILE=$f: $(cat "$STUB_LOG")"
  grep -q "OMARCHY_WORKER_TOKEN_FILE=$f" "$tmp/stderr" || fail "and says why: $(cat "$tmp/stderr")"
done
printf 'omw_a\nOMARCHY_API=http://elsewhere\n' > "$tmp/two"
if entry OMARCHY_WORKER_ROLE=dispatcher OMARCHY_WORKER_TOKEN_FILE="$tmp/two"; then fail "two lines are a token"; fi
grep -q 'holds no worker token (one token on one line)' "$tmp/stderr" || fail "two lines: $(cat "$tmp/stderr")"
if [[ "$(id -u)" != 0 ]]; then
  printf 'omw_x\n' > "$tmp/unreadable"; chmod 000 "$tmp/unreadable"
  if entry OMARCHY_WORKER_ROLE=dispatcher OMARCHY_WORKER_TOKEN_FILE="$tmp/unreadable"; then fail "an unreadable file is a token"; fi
  grep -q 'is not a file this container can read' "$tmp/stderr" || fail "unreadable: $(cat "$tmp/stderr")"
fi
echo "ok: a token file named but not there, empty or not one token stops the dispatcher, never falling back"

# 3. A dispatcher started from an older release's template: the plain variable still works; neither stops it.
entry OMARCHY_WORKER_ROLE=dispatcher OMARCHY_WORKER_TOKEN=omw_plain || fail "the plain variable: $(cat "$tmp/stderr")"
[[ "$(cat "$STUB_LOG")" == "pkg-repo dispatch | wt=omw_plain wtf=" ]] || fail "the plain variable reaches pkg-repo: $(cat "$STUB_LOG")"
if entry OMARCHY_WORKER_ROLE=dispatcher; then fail "a dispatcher with no token started"; fi
grep -q 'the dispatcher has no worker token' "$tmp/stderr" && [[ ! -s "$STUB_LOG" ]] || fail "no token: $(cat "$tmp/stderr" "$STUB_LOG")"
echo "ok: the plain variable still starts a dispatcher of an older release"

# 4. A project worker: the pool is asked with the file's token, and pkg-repo work holds it — not the plain one.
entry OMARCHY_WORKER_ROLE=pool OMARCHY_WORKER_TOKEN_FILE="$tmp/token" OMARCHY_WORKER_TOKEN=omw_plain OMARCHY_RUN_DIR="$tmp/run" OMARCHY_WORK_DIR="$tmp/work" \
  || fail "a pool worker with a token file: $(cat "$tmp/stderr")"
grep -q 'authorization: Bearer omw_from_the_file' "$STUB_LOG" || fail "the pool is asked with the file's token: $(cat "$STUB_LOG")"
grep -q 'omw_plain' "$STUB_LOG" && fail "the plain variable reached the pool or pkg-repo: $(cat "$STUB_LOG")"
grep -q '^pkg-repo work --arch .* | wt=omw_from_the_file wtf=$' "$STUB_LOG" || fail "pkg-repo work holds the file's token: $(cat "$STUB_LOG")"
# The broker: the file's token, in its process.
entry OMARCHY_WORKER_ROLE=broker OMARCHY_WORKER_TOKEN_FILE="$tmp/token" || fail "the broker: $(cat "$tmp/stderr")"
grep -q '^python3 /usr/local/lib/omarchy-factory/bin/broker | wt=omw_from_the_file wtf=$' "$STUB_LOG" || fail "the broker holds the file's token: $(cat "$STUB_LOG")"
if entry OMARCHY_WORKER_ROLE=broker OMARCHY_WORKER_TOKEN_FILE="$tmp/missing" OMARCHY_WORKER_TOKEN=omw_plain; then fail "the broker started without its file"; fi
[[ ! -s "$STUB_LOG" ]] || fail "the broker ran without its file: $(cat "$STUB_LOG")"
echo "ok: a project worker and the broker take the file's token"

# 5. An agent sidecar holds no token, the file's path included; a builder behind a broker drops it and says so.
printf 'ANTHROPIC_API_KEY=sk-ant-from-the-file\n' > "$tmp/agent.env"
entry OMARCHY_WORKER_ROLE=agent OMARCHY_AGENT_ENV="$tmp/agent.env" OMARCHY_WORKER_TOKEN_FILE="$tmp/token" || fail "an agent sidecar: $(cat "$tmp/stderr")"
grep -q '^python3 /usr/local/lib/omarchy-factory/bin/broker | wt= wtf=$' "$STUB_LOG" || fail "an agent sidecar holds no token: $(cat "$STUB_LOG")"
cat > "$tmp/bin/curl" <<'S'
#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
printf '{"id":"m1-laptop-0a9z","trust":"community","arch":"%s","owner":"m1"}\n' "$STUB_ARCH"
S
printf '#!/usr/bin/env bash\necho "builder | wt=${OMARCHY_WORKER_TOKEN:-} wtf=${OMARCHY_WORKER_TOKEN_FILE:-}" >> "$STUB_LOG"\n' > "$tmp/bin/omarchy-build-worker"
chmod +x "$tmp/bin/curl" "$tmp/bin/omarchy-build-worker"
entry OMARCHY_BROKER=http://broker:8790 OMARCHY_WORKER_TOKEN_FILE="$tmp/token" || fail "a builder: $(cat "$tmp/stderr")"
grep -q '^builder | wt= wtf=$' "$STUB_LOG" || fail "a builder behind a broker holds no token: $(cat "$STUB_LOG")"
grep -q 'OMARCHY_WORKER_TOKEN_FILE is set on a builder behind a broker' "$tmp/stderr" || fail "and says so: $(cat "$tmp/stderr")"
echo "ok: an agent sidecar and a builder behind a broker hold no token, nor its file"
echo "entrypoint token file: ok"
