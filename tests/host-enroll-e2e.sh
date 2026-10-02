#!/usr/bin/env bash
# A host enrolls end to end, entirely local (#321, design v2 §6.1): the real
# omarchy-agent against a real Worker (wrangler dev, local D1).
#
#   a maintainer presses Add a host (POST /api/v1/hosts/enrollments, the
#   session) → the agent runs with OMARCHY_ENROLL in its environment, makes
#   its host key, enrolls with a capacity report and prints the fingerprint →
#   nothing is registered and the token is in no process's argv → the owner's
#   page shows the same fingerprint, and Confirm → the agent fetches the host
#   worker token with a host-key-signed request into etc/dispatcher.env (0600)
#   → that token claims → a rotation gives a new one while the old one still
#   claims → the journal has the new-host line → running it again keeps the
#   identity and the worker token.
#
# What stands in for the parts of P1 still to come: the capacity report is a
# file this script writes (the detection is #333), and the claim is a curl
# with the token (the dispatcher is #335).
#
# Requires: cargo, node (worker deps installed: cd worker && npm ci), jq, curl.
# Usage: tests/host-enroll-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E="$ROOT/target/e2e-host-enroll"
PORT="${OMARCHY_E2E_HOST_PORT:-8793}"
POOL="http://127.0.0.1:$PORT"
ORIGIN_HDR="origin: $POOL"
SESSION="omc=oms_e2e"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then printf %s "$1" | sha256sum | cut -d' ' -f1; else printf %s "$1" | shasum -a 256 | cut -d' ' -f1; fi; }
cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    [[ -f "$E2E/agent.log" ]] && { printf '\n==> the agent said:\n' >&2; cat "$E2E/agent.log" >&2; }
    [[ -f "$E2E/wrangler.log" ]] && { printf '\n==> the local pool (wrangler dev), last 60 lines:\n' >&2; tail -n 60 "$E2E/wrangler.log" >&2; }
  fi
  [[ -n "${AGENT_PID:-}" ]] && kill "$AGENT_PID" 2>/dev/null || true
  [[ -n "${WRANGLER_PID:-}" ]] && kill "$WRANGLER_PID" 2>/dev/null || true
}
trap cleanup EXIT

case "$(uname -m)" in x86_64 | amd64) ARCH=x86_64 ;; aarch64 | arm64) ARCH=aarch64 ;; *) fail "no lane for $(uname -m)" ;; esac

step "Build the agent"
cargo build -q -p omarchy-agent
AGENT="$ROOT/target/debug/omarchy-agent"

step "Fresh local pool on :$PORT, one maintainer (e2e, GitHub user id 4242)"
rm -rf "$E2E" && mkdir -p "$E2E"
cd "$ROOT/worker"
STATE="$E2E/wrangler-state"
printf 'JOB_TOKEN_SECRET=e2e-jobs\n' > "$E2E/.dev.vars"
npx wrangler d1 migrations apply omarchy-repo --local --persist-to "$STATE" >/dev/null
npx wrangler d1 execute omarchy-repo --local --persist-to "$STATE" --command \
  "INSERT INTO factory_maintainers (login) VALUES ('e2e');
   INSERT INTO contributors (login, token_hash, session_hash, role, github_id) VALUES ('e2e', '$(sha256 omc_e2e)', '$(sha256 oms_e2e)', 'maintainer', 4242);" >/dev/null
npx wrangler dev --ip 127.0.0.1 --port "$PORT" --persist-to "$STATE" --env-file "$E2E/.dev.vars" --var "SOURCE_CHECK:off" > "$E2E/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 60); do curl -fs "$POOL/api/v1/version" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "$POOL/api/v1/version" >/dev/null || fail "the local pool did not start"
cd "$ROOT"

step "Add a host: nobody signed in is refused, the maintainer gets the one command"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$POOL/api/v1/hosts/enrollments" -H 'content-type: application/json' -d '{"name":"vm"}')
[[ $code == 401 ]] || fail "nobody signed in: $code"
mint=$(curl -fs -X POST "$POOL/api/v1/hosts/enrollments" -H "cookie: $SESSION" -H "$ORIGIN_HDR" -H 'content-type: application/json' -d '{"name":"e2e-vm","where":"the CI runner"}')
TOKEN=$(jq -r .token <<<"$mint")
COMMAND=$(jq -r .command <<<"$mint")
[[ $TOKEN =~ ^ome_[0-9a-f]{48}$ ]] || fail "no token: $mint"
# The token is the environment of sh, after the pipe; nothing after sh names it. (wrangler dev answers as the
# production names, so the command names no --pool here; the agent below is given it.)
[[ $COMMAND == "curl --proto '=https' --tlsv1.2 -fsSL https://github.com/firemanxbr/omarchy-pool/releases/"*"/install.sh | OMARCHY_ENROLL=$TOKEN sh"* ]] || fail "the command: $COMMAND"
[[ ${COMMAND#*OMARCHY_ENROLL=$TOKEN sh} != *ome_* ]] || fail "the token after sh: $COMMAND"

step "The machine: capacity report (the detection is #333), then the agent with the token in its environment"
DATA="$E2E/data"
mkdir -p "$DATA/omarchy-agent/sets/host/run"
chmod -R 700 "$DATA"
cat > "$DATA/omarchy-agent/sets/host/run/capacity.json" <<JSON
{"schema":2,"cpus":8,"mem_gb":16,"page_kb":4,"disk_free_gb":{"work":120,"engine":80},"units":7,"job_reserved":1,"agent_slots":2,
 "lanes":[{"arch":"$ARCH","mode":"native"}],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}
JSON
XDG_DATA_HOME="$DATA" OMARCHY_ENROLL="$TOKEN" "$AGENT" install --pool "$POOL" --wait-minutes 3 > "$E2E/agent.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 60); do grep -q "host key fingerprint:" "$E2E/agent.log" && grep -q "waiting for e2e" "$E2E/agent.log" && break; sleep 1; done
grep -q "waiting for e2e" "$E2E/agent.log" || fail "the agent did not reach the wait"
FP=$(sed -n 's/^omarchy-agent: host key fingerprint: //p' "$E2E/agent.log")
[[ $FP == SHA256:* ]] || fail "no fingerprint printed"
# The token is in the agent's environment, never in a command line: no process shows it.
if ps -A -o args= | grep -F "$TOKEN" | grep -vq grep; then fail "the token shows in ps"; fi
grep -qF "$TOKEN" "$E2E/agent.log" && fail "the agent printed the token"
[[ $(stat -c %a "$DATA/omarchy-agent/state/host.ed25519" 2>/dev/null || stat -f %Lp "$DATA/omarchy-agent/state/host.ed25519") == 600 ]] || fail "the host key is not 0600"

step "Before Confirm: pending-owner, the same fingerprint on the page, no registration"
hosts=$(curl -fs "$POOL/api/v1/hosts?owner=e2e" -H "cookie: $SESSION")
HOST=$(jq -r '.hosts[0].id' <<<"$hosts")
[[ $(jq -r '.hosts[0].status' <<<"$hosts") == pending-owner ]] || fail "not pending: $hosts"
[[ $(jq -r '.hosts[0].fingerprint' <<<"$hosts") == "$FP" ]] || fail "the page's fingerprint is not the agent's: $hosts"
[[ $(jq -r '.hosts[0].units' <<<"$hosts") == 7 ]] || fail "units: $hosts"
[[ $(curl -fs "$POOL/api/v1/factory?limit=50" | jq '[.workers[] | select(.kind == "host")] | length') == 0 ]] || fail "a registration before Confirm"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$POOL/api/v1/hosts/enroll" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}")
[[ $code == 400 || $code == 401 ]] || fail "the token again: $code"

step "Confirm: the agent gets its worker token"
confirm=$(curl -fs -X POST "$POOL/api/v1/hosts/$HOST/confirm" -H "cookie: $SESSION" -H "$ORIGIN_HDR" -H 'content-type: application/json' -d '{}')
WORKER=$(jq -r .worker <<<"$confirm")
[[ $WORKER == e2e-e2e-vm-* ]] || fail "confirm: $confirm"
wait "$AGENT_PID" || fail "the agent did not finish its enrollment"
AGENT_PID=
ENV_FILE="$DATA/omarchy-agent/sets/host/etc/dispatcher.env"
[[ $(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE") == 600 ]] || fail "dispatcher.env is not 0600"
OMW=$(sed -n 's/^OMARCHY_WORKER_TOKEN=//p' "$ENV_FILE")
[[ $OMW == omw_* ]] || fail "no worker token in dispatcher.env"

step "The host claims with it (nothing queued: 204)"
# A host registration claims with its capacity, a claim_id new per attempt, want
# and every lease it holds (#334); the dispatcher (#335) will send these itself.
host_claim() { # token
  curl -s -o /dev/null -w '%{http_code}' -X POST "$POOL/api/v1/factory/claim" -H "authorization: Bearer $1" -H 'content-type: application/json' \
    -d "{\"arch\":\"$ARCH\",\"claim_id\":\"c_e2e_${RANDOM}${RANDOM}${RANDOM}\",\"want\":1,\"leases\":[],\"capacity\":{\"cpus\":8,\"mem_gb\":16,\"disk_free_gb\":{\"work\":100,\"engine\":100},\"lanes\":[{\"arch\":\"$ARCH\",\"mode\":\"native\"}]}}"
}
code=$(host_claim "$OMW")
[[ $code == 204 ]] || fail "the claim: $code"
[[ $(curl -fs "$POOL/api/v1/factory/workers/self" -H "authorization: Bearer $OMW" | jq -r .id) == "$WORKER" ]] || fail "the token is not $WORKER's"

step "A rotation: a new token, the old one still good for ten minutes"
XDG_DATA_HOME="$DATA" "$AGENT" token >> "$E2E/agent.log" 2>&1 || fail "the rotation"
NEW=$(sed -n 's/^OMARCHY_WORKER_TOKEN=//p' "$ENV_FILE")
[[ $NEW == omw_* && $NEW != "$OMW" ]] || fail "no new token"
for t in "$OMW" "$NEW"; do
  code=$(host_claim "$t")
  [[ $code == 204 ]] || fail "a claim after the rotation: $code"
done

step "The journal, the notice's words, and a second run that keeps the identity"
curl -fs "$POOL/api/v1/events?kind=host" | jq -e --arg h "$HOST" '.events[] | select(.payload.host == $h) | select(.summary | startswith("new host of e2e: 8 cores, 16 GB, '"$ARCH"' native, isolation root (dedicated)"))' >/dev/null || fail "no journal line"
XDG_DATA_HOME="$DATA" "$AGENT" install > "$E2E/again.log" 2>&1 || { cat "$E2E/again.log"; fail "the second run"; }
grep -q "this machine is host $HOST" "$E2E/again.log" || fail "the second run did not keep the identity"
# ...and the worker token: a fetch rotates, so a second one would cut off the token a running dispatcher holds.
grep -q "keeps its worker token" "$E2E/again.log" || fail "the second run fetched a token again"
[[ $(sed -n 's/^OMARCHY_WORKER_TOKEN=//p' "$ENV_FILE") == "$NEW" ]] || fail "the second run replaced the worker token"
[[ $(curl -fs "$POOL/api/v1/hosts?owner=e2e" -H "cookie: $SESSION" | jq '.hosts | length') == 1 ]] || fail "a second host"

printf '\n\033[1;32mhost enrollment: ok\033[0m (%s, %s, %s)\n' "$HOST" "$WORKER" "$FP"
