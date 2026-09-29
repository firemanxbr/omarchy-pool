#!/usr/bin/env bash
# The image's entrypoint (factory/image/entrypoint.sh) in the agent role,
# with a Claude subscription as the agent (#277): a `claude` that does not
# answer `claude --version` — an install cut short, which `docker restart`
# keeps — is removed and installed again (a stubbed installer); one that
# answers is left alone; none at all is installed. A restart of the agent
# service, by an order or by hand, then fixes a broken install too. The
# broker it starts is a stub that says it ran.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
export STUB_LOG="$tmp/log"
# The installer claude.ai serves, as curl would hand it to bash: it writes a claude that answers.
cat > "$tmp/bin/curl" <<'S'
#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
cat <<'I'
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\necho "2.0.0 (Claude Code)"\n' > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
echo "installed" >> "$STUB_LOG"
I
S
# The broker, as the entrypoint starts it at its end.
cat > "$tmp/bin/python3" <<'S'
#!/usr/bin/env bash
echo "broker started: $*" >> "$STUB_LOG"
S
chmod +x "$tmp/bin/curl" "$tmp/bin/python3"
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
echo "entrypoint agent: ok"
