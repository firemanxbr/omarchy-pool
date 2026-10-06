#!/usr/bin/env bash
# A host enrolls end to end, entirely local (#321, design v2 §6.1): the real
# omarchy-agent against a real Worker (wrangler dev, local D1).
#
#   a maintainer presses Add a host (POST /api/v1/hosts/enrollments, the
#   session) → the agent runs with OMARCHY_ENROLL in its environment, makes
#   its host key, enrolls with a capacity report and prints the fingerprint →
#   nothing is registered and the token is in no process's argv → the owner's
#   page shows the same fingerprint, and Confirm → the agent fetches the host
#   worker token with a host-key-signed request into its own file,
#   run/host/dispatcher/token (0400, #327), and its registration into
#   etc/dispatcher.env (0600) beside the host's own addresses (#371), the env
#   file holding no token → that token claims → a rotation rewrites the file
#   with a new one while the old one still claims, keeping the addresses and
#   an owner's own line, and writing agent.toml's secrets directory and agent
#   budget → the journal has the new-host line → running it again keeps the
#   identity and the worker token → (#322) a suspension refuses its claims,
#   its follow and the agent's token call, changing nothing on the machine,
#   and the owner's Resume with a passkey brings the same token back → (#328)
#   no widening is signed before a passkey is pinned at the host; the host's
#   page makes a pin of the owner's passkey and the real agent pins it, a pin
#   changed on the way refused → Retire burns it, and a new enrollment with a
#   new token enrolls the machine as a new host, with a new key.
#
# The agent runs `omarchy-agent enroll`, the enrollment step `install` runs
# after its preflight and the envelope's confirm (#317): the same code
# (enroll::run), without what install needs a signed release, an engine and
# systemd --user for — those are its unit tests (agent.toml with host_id and
# worker_id only after Confirm) and tests/agent-install.sh.
#
# What stands in for the rest: the capacity report is a file this script
# writes (install's preflight writes it; the detection is #333), and the claim
# is a curl with the token (the dispatcher is #335).
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
# The file key (host.ed25519) whatever the runner has: the key in a TPM is tests/host-key-tpm.sh's (#330).
export OMARCHY_HOST_KEY=file
XDG_DATA_HOME="$DATA" OMARCHY_ENROLL="$TOKEN" "$AGENT" enroll --pool "$POOL" --wait-minutes 3 > "$E2E/agent.log" 2>&1 &
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
# Where the key lives (#330): a file, as asked, and the page says so.
[[ $(jq -c '.hosts[0].host_key' <<<"$hosts") == '{"store":"file","alg":"ed25519","held":"the owner asked for a file (OMARCHY_HOST_KEY=file)"}' ]] || fail "host_key: $hosts"
[[ $(jq -r '.hosts[0].units' <<<"$hosts") == 7 ]] || fail "units: $hosts"
[[ $(curl -fs "$POOL/api/v1/factory?limit=50" | jq '[.workers[] | select(.kind == "host")] | length') == 0 ]] || fail "a registration before Confirm"
# No envelope either: install writes agent.toml only after Confirm, and enrollment never does.
[[ ! -e "$DATA/omarchy-agent/agent.toml" ]] || fail "an agent.toml before Confirm"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$POOL/api/v1/hosts/enroll" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}")
[[ $code == 400 || $code == 401 ]] || fail "the token again: $code"

step "Confirm: the agent gets its worker token"
confirm=$(curl -fs -X POST "$POOL/api/v1/hosts/$HOST/confirm" -H "cookie: $SESSION" -H "$ORIGIN_HDR" -H 'content-type: application/json' -d '{}')
WORKER=$(jq -r .worker <<<"$confirm")
[[ $WORKER == e2e-e2e-vm-* ]] || fail "confirm: $confirm"
wait "$AGENT_PID" || fail "the agent did not finish its enrollment"
AGENT_PID=
ENV_FILE="$DATA/omarchy-agent/sets/host/etc/dispatcher.env"
TOKEN_FILE="$DATA/omarchy-agent/sets/host/run/host/dispatcher/token"
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
[[ $(mode_of "$ENV_FILE") == 600 ]] || fail "dispatcher.env is not 0600"
# The token in its own file (#327), which the host set mounts read-only into the dispatcher; none in the env file.
[[ $(mode_of "$TOKEN_FILE") == 400 && $(mode_of "$(dirname "$TOKEN_FILE")") == 700 ]] || fail "run/host/dispatcher/token is not 0400 in a 0700 directory"
OMW=$(cat "$TOKEN_FILE")
[[ $OMW == omw_* ]] || fail "no worker token in run/host/dispatcher/token"
grep -q 'OMARCHY_WORKER_TOKEN\|omw_' "$ENV_FILE" && fail "a worker token in dispatcher.env"
# The registration beside it is what install writes into agent.toml's worker_id (#317).
[[ $(sed -n 's/^# worker: //p' "$ENV_FILE") == "$WORKER" ]] || fail "dispatcher.env does not name $WORKER"
# The host's own addresses beside the token (#371), its LAN address among them, where the agent reads
# the kernel's interface lists (Linux); no agent.toml yet, so no secrets directory and no budget (the
# dispatcher's defaults).
ADDRS=$(sed -n 's/^OMARCHY_HOST_ADDRESSES=//p' "$ENV_FILE")
if [[ -r /proc/net/fib_trie ]]; then
  [[ -n $ADDRS ]] || fail "no OMARCHY_HOST_ADDRESSES in dispatcher.env"
  if command -v ip >/dev/null; then
    LAN=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')
    [[ -z $LAN || ",$ADDRS," == *",$LAN,"* ]] || fail "OMARCHY_HOST_ADDRESSES ($ADDRS) lacks the LAN address $LAN"
  fi
fi
grep -Eq '^(OMARCHY_SECRETS_DIR|OMARCHY_AGENT_)' "$ENV_FILE" && fail "a secrets directory or a budget before agent.toml"

step "The host claims with it (nothing queued: 204)"
# A host registration claims with its capacity, a claim_id new per attempt, want
# and every lease it holds (#334); the dispatcher (#335) will send these itself.
host_claim_body() {
  printf '%s' "{\"arch\":\"$ARCH\",\"claim_id\":\"c_e2e_${RANDOM}${RANDOM}${RANDOM}\",\"want\":1,\"leases\":[],\"capacity\":{\"cpus\":8,\"mem_gb\":16,\"disk_free_gb\":{\"work\":100,\"engine\":100},\"lanes\":[{\"arch\":\"$ARCH\",\"mode\":\"native\"}]}}"
}
host_claim() { # token
  curl -s -o /dev/null -w '%{http_code}' -X POST "$POOL/api/v1/factory/claim" -H "authorization: Bearer $1" -H 'content-type: application/json' -d "$(host_claim_body)"
}
code=$(host_claim "$OMW")
[[ $code == 204 ]] || fail "the claim: $code"
[[ $(curl -fs "$POOL/api/v1/factory/workers/self" -H "authorization: Bearer $OMW" | jq -r .id) == "$WORKER" ]] || fail "the token is not $WORKER's"

step "A rotation: a new token, the old one still good for ten minutes; the rest kept, agent.toml's keys written"
# What install writes after the Confirm (the envelope's secrets directory and a budget), and an owner's own line.
cat > "$DATA/omarchy-agent/agent.toml" <<TOML
[set]
secrets_dir = "$DATA/omarchy-agent/secrets"
[envelope]
agent_budget = { calls_per_task = 50, calls_per_day = 900 }
TOML
echo 'TZ=UTC' >> "$ENV_FILE"
XDG_DATA_HOME="$DATA" "$AGENT" token >> "$E2E/agent.log" 2>&1 || fail "the rotation"
NEW=$(cat "$TOKEN_FILE")
[[ $NEW == omw_* && $NEW != "$OMW" ]] || fail "no new token"
for t in "$OMW" "$NEW"; do
  code=$(host_claim "$t")
  [[ $code == 204 ]] || fail "a claim after the rotation: $code"
done
[[ $(mode_of "$ENV_FILE") == 600 && $(mode_of "$TOKEN_FILE") == 400 ]] || fail "dispatcher.env is not 0600, or the token file 0400, after the rotation"
[[ $(sed -n 's/^OMARCHY_HOST_ADDRESSES=//p' "$ENV_FILE") == "$ADDRS" ]] || fail "the rotation did not keep the host's addresses"
[[ $(sed -n 's/^TZ=//p' "$ENV_FILE") == UTC ]] || fail "the rotation did not keep the owner's line"
[[ $(sed -n 's/^OMARCHY_SECRETS_DIR=//p' "$ENV_FILE") == "$DATA/omarchy-agent/secrets" ]] || fail "no OMARCHY_SECRETS_DIR from agent.toml"
[[ $(sed -n 's/^OMARCHY_AGENT_CALLS_PER_TASK=//p' "$ENV_FILE")/$(sed -n 's/^OMARCHY_AGENT_CALLS_PER_DAY=//p' "$ENV_FILE") == 50/900 ]] || fail "the agent budget: $(grep OMARCHY_AGENT_ "$ENV_FILE")"
grep -Eq '^OMARCHY_AGENT_(TOKENS|MINUTES)_PER_TASK=' "$ENV_FILE" && fail "a budget key agent.toml does not set"
grep -q 'OMARCHY_WORKER_TOKEN\|omw_' "$ENV_FILE" && fail "the rotation wrote a token into dispatcher.env"

step "The journal, the notice's words, and a second run that keeps the identity"
curl -fs "$POOL/api/v1/events?kind=host" | jq -e --arg h "$HOST" '.events[] | select(.payload.host == $h) | select(.summary | startswith("new host of e2e: 8 cores, 16 GB, '"$ARCH"' native, isolation root (dedicated)"))' >/dev/null || fail "no journal line"
XDG_DATA_HOME="$DATA" "$AGENT" enroll > "$E2E/again.log" 2>&1 || { cat "$E2E/again.log"; fail "the second run"; }
grep -q "this machine is host $HOST" "$E2E/again.log" || fail "the second run did not keep the identity"
# ...and the worker token: a fetch rotates, so a second one would cut off the token a running dispatcher holds.
grep -q "keeps its worker token" "$E2E/again.log" || fail "the second run fetched a token again"
[[ $(cat "$TOKEN_FILE") == "$NEW" ]] || fail "the second run replaced the worker token"
[[ $(curl -fs "$POOL/api/v1/hosts?owner=e2e" -H "cookie: $SESSION" | jq '.hosts | length') == 1 ]] || fail "a second host"

step "Suspend (#322): the claims and the agent's calls refused, nothing changed on the machine; the owner's Resume, with a passkey"
WEB=(-H "cookie: $SESSION" -H "$ORIGIN_HDR" -H 'content-type: application/json')
pkopts=$(curl -fs -X POST "$POOL/auth/passkeys/challenge" "${WEB[@]}" -d '{}')
RP_ORIGIN="https://$(jq -r .publicKey.rp.id <<<"$pkopts")"
node "$ROOT/tests/passkey.mjs" register "$E2E/passkey.json" "$RP_ORIGIN" "E2E key" <<<"$pkopts" | curl -fs -o /dev/null -X POST "$POOL/auth/passkeys" "${WEB[@]}" --data-binary @- || fail "the owner's passkey"
answer() { curl -fs -X POST "$POOL/auth/passkeys/assert" "${WEB[@]}" -d "{\"for\":\"$1\"}" | node "$ROOT/tests/passkey.mjs" assert "$E2E/passkey.json" "$RP_ORIGIN" json; }
susp=$(curl -fs -X POST "$POOL/api/v1/hosts/$HOST/suspend" "${WEB[@]}" -d '{"reason":"e2e: the fans"}')
[[ $(jq -r .status <<<"$susp") == suspended ]] || fail "suspend: $susp"
[[ $(curl -s -X POST "$POOL/api/v1/factory/claim" -H "authorization: Bearer $NEW" -H 'content-type: application/json' -d "$(host_claim_body)" | jq -r .code) == host_suspended ]] || fail "a suspended host claimed"
XDG_DATA_HOME="$DATA" "$AGENT" token > "$E2E/suspended.log" 2>&1 && fail "a suspended host got a worker token"
grep -q "e2e-vm is suspended (by e2e: e2e: the fans)" "$E2E/suspended.log" || { cat "$E2E/suspended.log"; fail "the agent did not say why"; }
[[ $(cat "$TOKEN_FILE") == "$NEW" ]] || fail "the suspension changed the dispatcher's token"
[[ $(curl -s -o /dev/null -w '%{http_code}' "$POOL/api/v1/factory/follow?ids=$WORKER") == 403 ]] || fail "a suspended host's follow"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$POOL/api/v1/hosts/$HOST/resume" "${WEB[@]}" -d '{}')
[[ $code == 403 ]] || fail "a resume with no passkey: $code"
res=$(curl -fs -X POST "$POOL/api/v1/hosts/$HOST/resume" "${WEB[@]}" -d "$(jq -nc --argjson a "$(answer "host:resume:$HOST")" '{assertion: $a}')")
[[ $(jq -r .status <<<"$res") == active ]] || fail "resume: $res"
[[ $(host_claim "$NEW") == 204 ]] || fail "the same token after the resume"
[[ $(curl -s -o /dev/null -w '%{http_code}' "$POOL/api/v1/factory/follow?ids=$WORKER") == 200 ]] || fail "the follow after the resume"

step "Owner control without a visit (#328): the owner's passkey pinned at the host, from a pin its page made"
# Nothing is signed for a host before its agent says a passkey is pinned there.
code=$(curl -s -o "$E2E/unpinned.json" -w '%{http_code}' -X POST "$POOL/api/v1/hosts/$HOST/owner/challenge" "${WEB[@]}" -d '{"act":"widen-envelope","envelope":{"max_units":8}}')
[[ $code == 409 && $(jq -r .code "$E2E/unpinned.json") == not_pinned ]] || fail "a widening before a pin: $code $(cat "$E2E/unpinned.json")"
# The page asks the pool for the pin's document, the owner's passkey signs it, the pool checks that and prints the pin.
pinopts=$(curl -fs -X POST "$POOL/api/v1/hosts/$HOST/owner/challenge" "${WEB[@]}" -d '{"act":"pin-passkey"}')
pinsig=$(node "$ROOT/tests/passkey.mjs" assert "$E2E/passkey.json" "$RP_ORIGIN" json <<<"$pinopts")
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$POOL/api/v1/hosts/$HOST/owner/pin" "${WEB[@]}" -d "$(jq -nc --arg d "$(jq -r .doc <<<"$pinopts" | sed 's/"by":"e2e"/"by":"e2f"/')" --argjson a "$pinsig" '{doc: $d, assertion: $a}')")
[[ $code == 400 ]] || fail "a pin of a document the page was not given: $code"
pinres=$(curl -fs -X POST "$POOL/api/v1/hosts/$HOST/owner/pin" "${WEB[@]}" -d "$(jq -nc --arg d "$(jq -r .doc <<<"$pinopts")" --argjson a "$pinsig" '{doc: $d, assertion: $a}')")
PIN=$(jq -r .pin <<<"$pinres")
[[ $(jq -r .command <<<"$pinres") == "omarchy-agent envelope pin-passkey $PIN" ]] || fail "the pin: $pinres"
# At the host, as the agent's user: the agent.toml install writes after the Confirm (the pool by its
# production name, which wrangler dev answers as, so the pin's relying party is this host's pool's),
# the one the token step wrote kept aside for the re-install below.
cp "$DATA/omarchy-agent/agent.toml" "$E2E/agent.toml.kept"
cat > "$DATA/omarchy-agent/agent.toml" <<TOML
pool = "https://pkgs.omarchy-pool.org"
host_id = "$HOST"
worker_id = "$WORKER"
[set]
dir = "$DATA/omarchy-agent/sets/host"
work_root = "$E2E/work"
secrets_dir = "$DATA/omarchy-agent/secrets"
socket_cli = "$E2E/no-engine.sock"
TOML
chmod 600 "$DATA/omarchy-agent/agent.toml"
# A pin someone changed on the way (another document under the same signature) is refused, nothing pinned.
unb64url() { local b; b=$(tr '_-' '/+' <<<"$1"); while (( ${#b} % 4 )); do b+="="; done; base64 -d <<<"$b"; }
forged=$(unb64url "$PIN" | jq -c '.doc |= sub("\"by\":\"e2e\""; "\"by\":\"e2f\"")' | base64 | tr -d '\n=' | tr '/+' '_-')
[[ $(unb64url "$forged" | jq -r .doc) == *'"by":"e2f"'* ]] || fail "the changed pin"
XDG_DATA_HOME="$DATA" "$AGENT" envelope pin-passkey "$forged" > "$E2E/pin.log" 2>&1 && fail "the agent pinned a changed pin"
[[ ! -e "$DATA/omarchy-agent/state/owner.json" ]] || fail "a changed pin left a record"
XDG_DATA_HOME="$DATA" "$AGENT" envelope pin-passkey "$PIN" > "$E2E/pin.log" 2>&1 || { cat "$E2E/pin.log"; fail "the agent refused the pin"; }
grep -q "^pinned e2e's passkey (ES256, credential $(jq -r .credentialId "$E2E/passkey.json" | cut -c1-12)…) for omarchy-pool.org on https://omarchy-pool.org" "$E2E/pin.log" || { cat "$E2E/pin.log"; fail "the agent's words"; }
[[ $(stat -c %a "$DATA/omarchy-agent/state/owner.json" 2>/dev/null || stat -f %Lp "$DATA/omarchy-agent/state/owner.json") == 600 ]] || fail "owner.json is not 0600"
[[ $(jq -r .passkey.credential "$DATA/omarchy-agent/state/owner.json") == $(jq -r .credentialId "$E2E/passkey.json") ]] || fail "the pinned credential is not the owner's passkey"
XDG_DATA_HOME="$DATA" "$AGENT" envelope unpin-passkey | grep -q "^unpinned e2e's passkey" || fail "unpin"
mv "$E2E/agent.toml.kept" "$DATA/omarchy-agent/agent.toml"

step "Retire (#322): the key and the token burnt; a new enrollment enrolls the machine as a new host, with a new key"
ret=$(curl -fs -X POST "$POOL/api/v1/hosts/$HOST/retire" "${WEB[@]}" -d '{"reason":"e2e: moving it"}')
[[ $(jq -r .status <<<"$ret") == retired ]] || fail "retire: $ret"
[[ $(host_claim "$NEW") == 401 ]] || fail "a retired host's token claimed"
TOKEN2=$(curl -fs -X POST "$POOL/api/v1/hosts/enrollments" "${WEB[@]}" -d '{"name":"e2e-vm"}' | jq -r .token)
XDG_DATA_HOME="$DATA" OMARCHY_ENROLL="$TOKEN2" "$AGENT" enroll --wait-minutes 3 > "$E2E/reinstall.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 60); do grep -q "waiting for e2e" "$E2E/reinstall.log" && break; sleep 1; done
grep -q "host $HOST was retired: this install enrolls the machine as a new host" "$E2E/reinstall.log" || { cat "$E2E/reinstall.log"; fail "the re-install did not see the retirement"; }
HOST2=$(curl -fs "$POOL/api/v1/hosts?owner=e2e" -H "cookie: $SESSION" | jq -r '.hosts[] | select(.status == "pending-owner") | .id')
[[ $HOST2 == h_* && $HOST2 != "$HOST" ]] || fail "no new host"
FP2=$(sed -n 's/^omarchy-agent: host key fingerprint: //p' "$E2E/reinstall.log" | tail -1)
[[ $FP2 == SHA256:* && $FP2 != "$FP" ]] || fail "the new host's key is the old one"
curl -fs -o /dev/null -X POST "$POOL/api/v1/hosts/$HOST2/confirm" "${WEB[@]}" -d '{}' || fail "confirm the new host"
wait "$AGENT_PID" || { cat "$E2E/reinstall.log"; fail "the re-install did not finish"; }
AGENT_PID=
[[ $(host_claim "$(cat "$TOKEN_FILE")") == 204 ]] || fail "the new host's token"

printf '\n\033[1;32mhost enrollment: ok\033[0m (%s, %s, %s; suspended, resumed, a passkey pinned, retired, then %s)\n' "$HOST" "$WORKER" "$FP" "$HOST2"
