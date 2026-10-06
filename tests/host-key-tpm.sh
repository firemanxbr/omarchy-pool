#!/usr/bin/env bash
# The host key in a TPM, end to end (#330, the Linux half of hardware-bound
# host keys; design v2 §14): the real omarchy-agent against a real Worker
# (wrangler dev, local D1) and a TPM 2.0 — swtpm, behind tpm2-abrmd as the
# kernel's /dev/tpmrm0 would be (a resource manager flushes what each tool
# loaded when it exits; the agent reaches a TPM through nothing else).
#
#   OMARCHY_HOST_KEY=tpm: the agent makes its key in the TPM with tpm2-tools —
#   an ECDSA P-256 key, fixedtpm and fixedparent, so the TPM never lets it
#   out — keeps only its public area and its TPM-sealed private blob (0600),
#   no host.ed25519, and enrolls with the TPM's signature as its proof → the
#   pool takes it (key_store tpm), and the owner's page shows the same
#   fingerprint and where the key lives → Confirm: the token is fetched with
#   a TPM-signed request → a rotation, without the TCTI in the environment
#   (the key's own file names its TPM) → `status` says where the key lives →
#   the key's two files, copied, load in no other TPM → a cleared TPM signs
#   nothing more, and the agent says why, changing nothing → with no TPM in
#   reach (auto) a file key, and the page says why not the TPM → asked for the
#   TPM with none in reach, nothing is enrolled and the token is still good.
#
# Requires: cargo, node (worker deps installed: cd worker && npm ci), jq, curl,
# swtpm, tpm2-tools, tpm2-abrmd with its TCTI (libtss2-tcti-tabrmd0) and
# dbus-run-session. CI: ci.yml's "Host key in a TPM" job.
# Usage: bash tests/host-key-tpm.sh
set -euo pipefail

# tpm2-abrmd is reached over D-Bus: a session bus of this script's own.
if [[ -z ${OMARCHY_TPM_TEST_BUS:-} ]]; then
  exec env OMARCHY_TPM_TEST_BUS=1 dbus-run-session -- bash "$0" "$@"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E="$ROOT/target/e2e-host-key-tpm"
PORT="${OMARCHY_E2E_TPM_PORT:-8794}"
TPM_PORT="${OMARCHY_E2E_SWTPM_PORT:-23410}"
POOL="http://127.0.0.1:$PORT"
ORIGIN_HDR="origin: $POOL"
SESSION="omc=oms_e2e"
TCTI="tabrmd:bus_type=session"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
sha256() { printf %s "$1" | sha256sum | cut -d' ' -f1; }
mode_of() { stat -c %a "$1"; }
cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    for log in agent agent-file abrmd; do
      [[ -f "$E2E/$log.log" ]] && { printf '\n==> %s.log:\n' "$log" >&2; cat "$E2E/$log.log" >&2; }
    done
    [[ -f "$E2E/wrangler.log" ]] && { printf '\n==> the local pool (wrangler dev), last 60 lines:\n' >&2; tail -n 60 "$E2E/wrangler.log" >&2; }
  fi
  for pid in "${AGENT_PID:-}" "${WRANGLER_PID:-}" "${ABRMD_PID:-}"; do
    if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  for f in "$E2E/swtpm.pid" "$E2E/other-swtpm.pid"; do
    if [[ -f $f ]]; then kill "$(cat "$f")" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

for tool in swtpm tpm2-abrmd tpm2_createprimary tpm2_load tpm2_print tpm2_clear jq curl npx; do
  command -v "$tool" >/dev/null || fail "$tool is not installed"
done

step "Build the agent"
cargo build -q -p omarchy-agent
AGENT="$ROOT/target/debug/omarchy-agent"

step "A TPM 2.0 (swtpm) behind tpm2-abrmd, on this script's session bus"
rm -rf "$E2E" && mkdir -p "$E2E/tpm"
swtpm socket --tpm2 --tpmstate dir="$E2E/tpm" --flags not-need-init,startup-clear \
  --server type=tcp,port="$TPM_PORT",bindaddr=127.0.0.1 --ctrl type=tcp,port=$((TPM_PORT + 1)),bindaddr=127.0.0.1 \
  --daemon --pid file="$E2E/swtpm.pid"
abrmd_root=()
[[ $(id -u) == 0 ]] && abrmd_root=(--allow-root)
tpm2-abrmd --session "${abrmd_root[@]}" --tcti="swtpm:host=127.0.0.1,port=$TPM_PORT" > "$E2E/abrmd.log" 2>&1 &
ABRMD_PID=$!
for _ in $(seq 1 50); do tpm2_getcap -T "$TCTI" properties-fixed >/dev/null 2>&1 && break; sleep 0.2; done
tpm2_getcap -T "$TCTI" properties-fixed >/dev/null || fail "tpm2-abrmd does not answer"

step "Fresh local pool on :$PORT, one maintainer (e2e, GitHub user id 4242)"
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

case "$(uname -m)" in x86_64 | amd64) ARCH=x86_64 ;; aarch64 | arm64) ARCH=aarch64 ;; *) fail "no lane for $(uname -m)" ;; esac
mint() { # name → token
  curl -fs -X POST "$POOL/api/v1/hosts/enrollments" -H "cookie: $SESSION" -H "$ORIGIN_HDR" -H 'content-type: application/json' -d "{\"name\":\"$1\"}" | jq -r .token
}
machine() { # data directory: a capacity report, as install's preflight writes it
  mkdir -p "$1/omarchy-agent/sets/host/run"
  chmod -R 700 "$1"
  cat > "$1/omarchy-agent/sets/host/run/capacity.json" <<JSON
{"schema":2,"cpus":8,"mem_gb":16,"page_kb":4,"disk_free_gb":{"work":120,"engine":80},"units":7,"job_reserved":1,"agent_slots":2,
 "lanes":[{"arch":"$ARCH","mode":"native"}],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}
JSON
}
host_named() { curl -fs "$POOL/api/v1/hosts?owner=e2e" -H "cookie: $SESSION" | jq -c --arg n "$1" '.hosts[] | select(.name == $n)'; }

step "OMARCHY_HOST_KEY=tpm: the key is made in the TPM, and the enrollment's proof is its signature"
DATA="$E2E/data"
STATE_DIR="$DATA/omarchy-agent/state"
machine "$DATA"
TOKEN=$(mint e2e-tpm)
[[ $TOKEN =~ ^ome_[0-9a-f]{48}$ ]] || fail "no token"
XDG_DATA_HOME="$DATA" OMARCHY_ENROLL="$TOKEN" OMARCHY_HOST_KEY=tpm OMARCHY_TPM_TCTI="$TCTI" \
  "$AGENT" enroll --pool "$POOL" --wait-minutes 3 > "$E2E/agent.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 60); do grep -q "waiting for e2e" "$E2E/agent.log" && break; sleep 1; done
grep -q "waiting for e2e" "$E2E/agent.log" || fail "the agent did not reach the wait"
FP=$(sed -n 's/^omarchy-agent: host key fingerprint: //p' "$E2E/agent.log")
[[ $FP == SHA256:* ]] || fail "no fingerprint printed"
grep -qF "omarchy-agent: host key: in the TPM ($TCTI; ECDSA P-256): made inside it, and it never leaves it" "$E2E/agent.log" || fail "the agent does not say the key is in the TPM"
for f in host.tpm.pub host.tpm.priv host.tpm.json; do
  [[ $(mode_of "$STATE_DIR/$f") == 600 ]] || fail "$f is not 0600"
done
[[ ! -e $STATE_DIR/host.ed25519 ]] || fail "a host.ed25519 beside the TPM's key"
# No work directory of the tools is left behind.
[[ -z $(find "$STATE_DIR" -name '.tpm-*') ]] || fail "a .tpm-* work directory left in the state directory"
# What the TPM holds: an ECC P-256 key that only signs, which it made and never lets out.
public=$(tpm2_print -t TPM2B_PUBLIC "$STATE_DIR/host.tpm.pub")
attrs=$(awk '/^attributes:/ {getline; print $2}' <<<"$public")
for a in fixedtpm fixedparent sensitivedataorigin sign; do
  [[ "|$attrs|" == *"|$a|"* ]] || fail "the key lacks $a: $attrs"
done
for a in decrypt restricted; do
  [[ "|$attrs|" != *"|$a|"* ]] || fail "the key has $a: $attrs"
done
grep -q 'NIST p256' <<<"$public" || fail "not a P-256 key: $public"

step "Before Confirm: the page shows the same fingerprint, and that the key is in the TPM"
h=$(host_named e2e-tpm)
HOST=$(jq -r .id <<<"$h")
[[ $(jq -r .status <<<"$h") == pending-owner ]] || fail "not pending: $h"
[[ $(jq -r .fingerprint <<<"$h") == "$FP" ]] || fail "the page's fingerprint is not the agent's: $h"
[[ $(jq -c .host_key <<<"$h") == '{"store":"tpm","alg":"p256","held":null}' ]] || fail "host_key: $h"

step "Confirm: the token comes with a TPM-signed request"
confirm=$(curl -fs -X POST "$POOL/api/v1/hosts/$HOST/confirm" -H "cookie: $SESSION" -H "$ORIGIN_HDR" -H 'content-type: application/json' -d '{}')
WORKER=$(jq -r .worker <<<"$confirm")
[[ $WORKER == e2e-e2e-tpm-* ]] || fail "confirm: $confirm"
wait "$AGENT_PID" || fail "the agent did not finish its enrollment"
AGENT_PID=
TOKEN_FILE="$DATA/omarchy-agent/sets/host/run/host/dispatcher/token"
[[ $(mode_of "$TOKEN_FILE") == 400 ]] || fail "run/host/dispatcher/token is not 0400"
OMW=$(cat "$TOKEN_FILE")
[[ $OMW =~ ^omw_[0-9a-f]{48}$ ]] || fail "no worker token"
[[ $(curl -fs "$POOL/api/v1/factory/workers/self" -H "authorization: Bearer $OMW" | jq -r .id) == "$WORKER" ]] || fail "the token is not $WORKER's"

step "A rotation signs in the TPM the key's file names, with no TCTI in the environment"
XDG_DATA_HOME="$DATA" "$AGENT" token >> "$E2E/agent.log" 2>&1 || fail "the rotation"
ROTATED=$(cat "$TOKEN_FILE")
[[ $ROTATED =~ ^omw_[0-9a-f]{48}$ && $ROTATED != "$OMW" ]] || fail "the token did not rotate"
status_out=$(XDG_DATA_HOME="$DATA" "$AGENT" status)
grep -qF "host key:  $FP in the TPM ($TCTI; ECDSA P-256)" <<<"$status_out" || fail "status: $status_out"

step "The key's files, copied, load in no other TPM; in this one they do"
OTHER_PORT=$((TPM_PORT + 10))
mkdir -p "$E2E/other-tpm" "$E2E/copy"
cp "$STATE_DIR/host.tpm.pub" "$STATE_DIR/host.tpm.priv" "$E2E/copy/"
swtpm socket --tpm2 --tpmstate dir="$E2E/other-tpm" --flags not-need-init,startup-clear \
  --server type=tcp,port="$OTHER_PORT",bindaddr=127.0.0.1 --ctrl type=tcp,port=$((OTHER_PORT + 1)),bindaddr=127.0.0.1 \
  --daemon --pid file="$E2E/other-swtpm.pid"
# The agent's own storage key arguments (crates/omarchy-agent/src/host/tpm.rs PRIMARY).
primary=(-Q -C o -g sha256 -G ecc256:aes128cfb -a 'restricted|decrypt|fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda')
OTHER="swtpm:host=127.0.0.1,port=$OTHER_PORT"
for _ in $(seq 1 50); do tpm2_getcap -T "$OTHER" properties-fixed >/dev/null 2>&1 && break; sleep 0.2; done
tpm2_createprimary -T "$OTHER" "${primary[@]}" -c "$E2E/copy/primary.ctx"
tpm2_flushcontext -T "$OTHER" -t
if tpm2_load -T "$OTHER" -Q -C "$E2E/copy/primary.ctx" -u "$E2E/copy/host.tpm.pub" -r "$E2E/copy/host.tpm.priv" -c "$E2E/copy/key.ctx" 2> "$E2E/copy/load.err"; then
  fail "another TPM loaded the host key"
fi
tpm2_createprimary -T "$TCTI" "${primary[@]}" -c "$E2E/copy/here.ctx"
tpm2_load -T "$TCTI" -Q -C "$E2E/copy/here.ctx" -u "$E2E/copy/host.tpm.pub" -r "$E2E/copy/host.tpm.priv" -c "$E2E/copy/here-key.ctx" || fail "this TPM does not load its own key"

step "A cleared TPM signs nothing more: the agent says why, and changes nothing"
tpm2_clear -T "$TCTI" -c p
if XDG_DATA_HOME="$DATA" "$AGENT" token > "$E2E/cleared.log" 2>&1; then
  fail "a rotation with a cleared TPM"
fi
grep -q "the TPM does not load the host key: was it cleared" "$E2E/cleared.log" || fail "the agent does not say why: $(cat "$E2E/cleared.log")"
[[ $(cat "$TOKEN_FILE") == "$ROTATED" ]] || fail "the token file changed"

step "No TPM in reach (auto): a file key, and the page says why not the TPM"
FDATA="$E2E/data-file"
machine "$FDATA"
FTOKEN=$(mint e2e-file)
XDG_DATA_HOME="$FDATA" OMARCHY_ENROLL="$FTOKEN" OMARCHY_TPM_TCTI=device:/dev/tpmrm97 \
  "$AGENT" enroll --pool "$POOL" --wait-minutes 1 > "$E2E/agent-file.log" 2>&1 &
AGENT_PID=$!
for _ in $(seq 1 60); do grep -q "waiting for e2e" "$E2E/agent-file.log" && break; sleep 1; done
grep -q "omarchy-agent: host key: a file (Ed25519, host.ed25519, mode 0600); not in the TPM: no TPM: /dev/tpmrm97 is not there" "$E2E/agent-file.log" \
  || fail "the agent does not say why the key is a file"
kill "$AGENT_PID" 2>/dev/null || true
AGENT_PID=
[[ $(mode_of "$FDATA/omarchy-agent/state/host.ed25519") == 600 ]] || fail "the file key is not 0600"
[[ ! -e $FDATA/omarchy-agent/state/host.tpm.json ]] || fail "TPM files beside a file key"
[[ $(host_named e2e-file | jq -c .host_key) == '{"store":"file","alg":"ed25519","held":"no TPM: /dev/tpmrm97 is not there"}' ]] \
  || fail "host_key: $(host_named e2e-file)"

step "Asked for the TPM with none in reach: nothing enrolled, the token still good"
NDATA="$E2E/data-none"
machine "$NDATA"
NTOKEN=$(mint e2e-none)
if XDG_DATA_HOME="$NDATA" OMARCHY_ENROLL="$NTOKEN" OMARCHY_HOST_KEY=tpm OMARCHY_TPM_TCTI=device:/dev/tpmrm97 \
  "$AGENT" enroll --pool "$POOL" --wait-minutes 1 > "$E2E/agent-none.log" 2>&1; then
  fail "an enrollment with no TPM, asked for one"
fi
grep -q "OMARCHY_HOST_KEY=tpm, but the TPM holds no host key" "$E2E/agent-none.log" || fail "$(cat "$E2E/agent-none.log")"
[[ -z $(host_named e2e-none) ]] || fail "a host was registered"
[[ -z $(find "$NDATA/omarchy-agent/state" -type f 2>/dev/null) ]] || fail "a key was made"

printf '\n\033[1;32mThe host key in a TPM: made there, used there, never out of it; a file where there is none.\033[0m\n'
