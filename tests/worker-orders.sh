#!/usr/bin/env bash
# The community builder follows the brain (#277): omarchy-build-worker.sh
# --container's claim loop against a scripted pool — each claim's answer
# taken in turn from a queue, every call recorded — on a fake clock. The
# claim says what this process takes (orders, instance, started_at,
# agent_via); an order is obeyed once and answered with this process's
# instance: a re-check probes without moving the worker's own backoff, a
# restart answers accepted and exits 0 (the restart policy starts the next
# container, as after every task), a drain is a notice, a kind it does not
# know is refused by name; a reason is printed stripped and never run; an
# answer it cannot read is logged and slept on; three answers with orders in
# a row slow it to the idle poll; a deliberate exit leaves a note the next
# process sends once; a complete the pool refuses is logged and the builder
# exits 0; a task it cannot read is failed at once.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
script="$root/factory/worker/omarchy-build-worker.sh"
sed '/^hold_secrets$/,$d' "$script" > "$tmp/worker.sh"

mkdir -p "$tmp/lib/bin" "$tmp/bin" "$tmp/state"
touch "$tmp/lib/omarchy-staging.pub.asc"; printf '#!/bin/sh\n' > "$tmp/lib/bin/draft-pkgbuild"; chmod +x "$tmp/lib/bin/draft-pkgbuild"
# The stub agent: refused while STUB_AGENT says down, answering otherwise; each probe noted with the fake time.
cat > "$tmp/lib/bin/agent.py" <<'P'
import json, os, sys
now = int(open(os.environ["STUB_CLOCK"]).read())
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(f"probe {now}\n")
if open(os.environ["STUB_AGENT"]).read().strip() == "down":
    print(json.dumps({"ok": False, "error": "URLError: <urlopen error [Errno 111] Connection refused>"}))
    sys.exit(1)
print(json.dumps({"ok": True, "ms": 42, "agent": "anthropic/claude-sonnet-5"}))
P
printf '#!/usr/bin/env bash\nshift; exec "$@"\n' > "$tmp/bin/timeout"; chmod +x "$tmp/bin/timeout"

ID="wo_0123456789abcdef0123456789abcdef"; ID2="wo_fedcba9876543210fedcba9876543210"; ID3="wo_00000000000000000000000000000003"
order() { # id kind [reason] [issued_by] [unless]
  jq -cn --arg i "$1" --arg k "$2" --arg r "${3:-because}" --arg b "${4:-m1}" --argjson u "${5:-false}" '{id:$i,kind:$k,reason:$r,issued_by:$b,issued_at:"2026-09-29T12:00:00Z",expires_at:"2026-09-29T18:00:00Z",unless_agent_ok:$u,notice:($k == "drain")}'
}
orders() { jq -cn --argjson o "[$(IFS=,; echo "$*")]" '{task:null,orders:$o}'; }

# One run of the loop: the claim answers are the lines of $tmp/answers ("<code> <body>"), each used once; past the last, 204.
# Every call is noted in $STUB_LOG; sleep moves the fake clock; IDLE_EXIT ends the run.
run_worker() { # idle-exit [env...]
  local idle="$1"; shift
  : > "$STUB_LOG"; echo 1000000 > "$STUB_CLOCK"; : > "$tmp/answers.used"
  env "$@" IDLE_EXIT="$idle" bash -c '
    set -euo pipefail
    source "$0"
    prepare_container() { :; }; add_pool_repos() { :; }
    sleep() { echo $(( $(cat "$STUB_CLOCK") + ${1%.*} )) > "$STUB_CLOCK"; echo "sleep ${1%.*}" >> "$STUB_LOG"; }
    date() { if [[ "$*" == +%s ]]; then cat "$STUB_CLOCK"; else command date "$@"; fi; }
    SECONDS="${STUB_SECONDS:-1000}"
    api() { # method path [json]
      echo "call $1 $2 $(jq -c . <<<"${3:-null}" 2>/dev/null || echo "${3:-}")" >> "$STUB_LOG"
      if [[ "$2" == /factory/claim ]]; then
        local n; n=$(wc -l < "$STUB_ANSWERS.used" | tr -d " "); echo x >> "$STUB_ANSWERS.used"
        local line; line="$(sed -n "$((n + 1))p" "$STUB_ANSWERS")"
        [[ -n "$line" ]] || { printf "\n204"; return 0; }
        local code="${line%% *}" body="${line#* }"
        printf "%s\n%s" "$body" "$code"
        [[ "$code" == 2* ]]
        return
      fi
      if [[ "$2" == /factory/tasks/*/complete ]]; then printf "%s\n%s" "${STUB_COMPLETE_BODY:-{\"status\":\"staged\"}}" "${STUB_COMPLETE:-200}"; [[ "${STUB_COMPLETE:-200}" == 2* ]]; return; fi
      printf "{}\n200"
    }
    container_worker
  ' "$tmp/worker.sh" 2>"$tmp/stderr"
}
export STUB_LOG="$tmp/calls" STUB_CLOCK="$tmp/clock" STUB_AGENT="$tmp/agent" STUB_ANSWERS="$tmp/answers" PATH="$tmp/bin:$PATH"
common=(WORKER_LOG="$tmp/worker.log" OMARCHY_FACTORY_LIB="$tmp/lib" OMARCHY_WORKER_TOKEN=omw_stub WORKER_ID=alice-box-aarch64-1f2e ANTHROPIC_API_KEY=stub-key OMARCHY_STATE_DIR="$tmp/state")
claims() { grep '^call POST /factory/claim ' "$STUB_LOG" | cut -d' ' -f4-; }
answers_to() { grep "^call POST /factory/workers/self/orders/$1 " "$STUB_LOG" | cut -d' ' -f4- || true; }

# 1. The claim says what this process takes, which process it is, and where its agent is.
echo down > "$STUB_AGENT"; : > "$STUB_ANSWERS"
run_worker 60 "${common[@]}"
first="$(claims | head -n1)"
[[ "$(jq -c .orders <<<"$first")" == '["drain","recheck-agent","restart"]' ]] || { echo "the claim declares the orders it takes: $first"; exit 1; }
instance="$(jq -r .instance <<<"$first")"
[[ "$instance" =~ ^[0-9a-f]{32}$ ]] || { echo "an instance of 32 hex digits: $instance"; exit 1; }
[[ "$(jq -r .agent_via <<<"$first")" == direct && "$(jq -r .started_at <<<"$first")" =~ ^20[0-9-]+T ]] || { echo "agent_via and started_at: $first"; exit 1; }
[[ "$(claims | jq -r .instance | sort -u | wc -l | tr -d ' ')" == 1 ]] || { echo "one instance for the process's life"; exit 1; }
# …and an idle exit leaves a note, which the next process sends once, in its first claim.
[[ "$(jq -r .why "$tmp/state/last-exit")" == idle ]] || { echo "an idle exit leaves its note"; exit 1; }
run_worker 60 "${common[@]}"
[[ "$(claims | head -n1 | jq -r .previous_exit.why)" == idle ]] || { echo "the next process sends it: $(claims | head -n1)"; exit 1; }
[[ "$(claims | sed -n 2p | jq -r '.previous_exit // "none"')" == none ]] || { echo "once"; exit 1; }
[[ "$(claims | head -n1 | jq -r .instance)" != "$instance" ]] || { echo "a new process, a new instance"; exit 1; }
# Through a broker: its agent is the broker's.
cat > "$tmp/bin/curl" <<'S'
#!/usr/bin/env bash
echo '{"ok":true,"ms":7,"agent":"claude-code/claude-sonnet-5"}'
S
chmod +x "$tmp/bin/curl"
run_worker 30 WORKER_LOG="$tmp/worker.log" WORKER_ID=alice-box-aarch64-1f2e OMARCHY_BROKER=http://broker:8790 OMARCHY_STATE_DIR="$tmp/state"
[[ "$(claims | head -n1 | jq -r .agent_via)" == broker ]] || { echo "behind a broker: agent_via broker: $(claims | head -n1)"; exit 1; }
rm -f "$tmp/bin/curl" "$tmp/state/last-exit"

# 2. A re-check: the pool's probes now, answered done with what the agent said — and the worker's own backoff does not move.
echo down > "$STUB_AGENT"
echo "200 $(orders "$(order "$ID" recheck-agent "stale" pool)")" > "$STUB_ANSWERS"
run_worker 100 "${common[@]}"
# The start's probe and the ordered one at once; then the worker's own, at 15 s and 30 s after them, as if the ordered one had not
# failed (counted, it would have made the second own re-check wait 60 s: +92).
[[ "$(awk '/^probe / { print $2 - 1000000 }' "$STUB_LOG" | tr '\n' ' ')" == "0 0 32 62 " ]] || { echo "the ordered probe moved the worker's own backoff: $(grep '^probe ' "$STUB_LOG" | tr '\n' ' ')"; exit 1; }
a="$(answers_to "$ID")"
[[ "$(jq -r '"\(.outcome) \(.code) \(.instance == "'"$(claims | head -n1 | jq -r .instance)"'")"' <<<"$a")" == "done probed true" ]] || { echo "answered done/probed by this process: $a"; exit 1; }
[[ "$(jq -r .agent.status <<<"$a")" == error ]] || { echo "with what the agent said: $a"; exit 1; }

# 3. A restart: refused when the process is under two minutes old; accepted and exit 0 otherwise, leaving its note; a conditional one refused when the agent answers.
echo down > "$STUB_AGENT"
echo "200 $(orders "$(order "$ID" restart "stuck" m1)")" > "$STUB_ANSWERS"
run_worker 60 "${common[@]}" STUB_SECONDS=5
[[ "$(jq -r '"\(.outcome) \(.code)"' <<<"$(answers_to "$ID")")" == "refused too-young" ]] || { echo "too young: $(answers_to "$ID")"; exit 1; }
set +e; run_worker 600 "${common[@]}"; status=$?; set -e
[[ "$status" == 0 ]] || { echo "a restart exits 0, as after every task: $status"; exit 1; }
[[ "$(jq -r '"\(.outcome) \(.code)"' <<<"$(answers_to "$ID")")" == "accepted exiting" ]] || { echo "accepted: $(answers_to "$ID")"; exit 1; }
[[ "$(jq -r .why "$tmp/state/last-exit")" == restart ]] || { echo "the restart's note"; exit 1; }
[[ "$(claims | wc -l | tr -d ' ')" == 1 ]] || { echo "nothing claimed after the restart"; exit 1; }
rm -f "$tmp/state/last-exit"
echo up > "$STUB_AGENT"
echo "200 $(orders "$(order "$ID" restart "if down" pool true)")" > "$STUB_ANSWERS"
run_worker 60 "${common[@]}"
[[ "$(jq -r '"\(.outcome) \(.code)"' <<<"$(answers_to "$ID")")" == "refused agent-ok" ]] || { echo "a conditional restart with the agent answering: $(answers_to "$ID")"; exit 1; }

# 4. A drain is a notice: logged, not answered. A kind it does not know is refused by name; an id is executed once; a reason is printed stripped and never run.
evil="\$(touch $tmp/pwned) $(printf '\033[31mred\033[0m\r\nnext')"
echo "200 $(orders "$(order "$ID" drain "disk full" m2)" "$(order "$ID2" reboot-the-host "$evil" m1)" "$(order "$ID2" reboot-the-host "again" m1)")" > "$STUB_ANSWERS"
run_worker 60 "${common[@]}"
grep -q 'drained by m2 — the pool hands me nothing until it is resumed' "$tmp/stderr" || { echo "the drain's notice: $(cat "$tmp/stderr")"; exit 1; }
[[ -z "$(answers_to "$ID")" ]] || { echo "a notice is not answered"; exit 1; }
[[ "$(answers_to "$ID2" | wc -l | tr -d ' ')" == 1 && "$(answers_to "$ID2" | jq -r .code)" == unknown-kind ]] || { echo "refused once, by name: $(answers_to "$ID2")"; exit 1; }
grep -q "order $ID2: executed already; ignored" "$tmp/stderr" || { echo "the second copy is ignored"; exit 1; }
[[ ! -e "$tmp/pwned" ]] || { echo "a reason was run"; exit 1; }
grep -q 'red' "$tmp/stderr" && ! grep -q $'\033' "$tmp/stderr" || { echo "the reason printed stripped: $(grep 'reboot' "$tmp/stderr" | od -c | head -3)"; exit 1; }

# 5. What it cannot read is logged and slept on; three answers with orders in a row slow it to the idle poll.
printf '200 not json at all\n200 [1,2]\n' > "$STUB_ANSWERS"
run_worker 60 "${common[@]}"
[[ "$(grep -c 'claim answer not understood' "$tmp/stderr")" == 2 ]] || { echo "logged, twice: $(cat "$tmp/stderr")"; exit 1; }
[[ "$(claims | wc -l | tr -d ' ')" -ge 3 ]] || { echo "and the loop goes on"; exit 1; }
{ echo "200 $(orders "$(order "wo_00000000000000000000000000000001" recheck-agent x m1)")"; echo "200 $(orders "$(order "wo_00000000000000000000000000000002" recheck-agent x m1)")"; echo "200 $(orders "$(order "$ID3" recheck-agent x m1)")"; } > "$STUB_ANSWERS"
run_worker 30 "${common[@]}"
[[ "$(grep '^sleep ' "$STUB_LOG" | head -n3 | tr '\n' ' ')" == "sleep 2 sleep 2 sleep 30 " ]] || { echo "2 s, 2 s, then the idle poll: $(grep '^sleep ' "$STUB_LOG" | tr '\n' ' ')"; exit 1; }
grep -q 'the pool keeps sending orders; slowing to 30 s' "$tmp/stderr" || { echo "and says so"; exit 1; }

# 6. AGENT_RETRY_SECONDS can only make the backoff slower.
echo down > "$STUB_AGENT"; : > "$STUB_ANSWERS"
run_worker 60 "${common[@]}" AGENT_RETRY_SECONDS=3
grep -q 'checking again in 15 s' "$tmp/stderr" || { echo "3 s is 15 s: $(cat "$tmp/stderr")"; exit 1; }

# 7. A task without a readable id is no task: said, and the builder exits 0 (its next container claims). One whose id reads and
#    whose rest does not is failed at once, and the builder exits 0.
echo '200 {"task":42}' > "$STUB_ANSWERS"
set +e; run_worker 600 "${common[@]}"; status=$?; set -e
[[ "$status" == 0 ]] && grep -q 'claim answer not understood' "$tmp/stderr" || { echo "no id, no task: $status $(cat "$tmp/stderr")"; exit 1; }
echo '200 {"task":{"id":812,"name":7},"token":"x"}' > "$STUB_ANSWERS"
set +e; run_worker 600 "${common[@]}"; status=$?; set -e
[[ "$status" == 0 ]] || { echo "exit 0: $status $(cat "$tmp/stderr")"; exit 1; }
grep -q '^call POST /factory/tasks/812/fail .*could not read this task' "$STUB_LOG" || { echo "failed at once: $(cat "$STUB_LOG")"; exit 1; }

# 8. A complete the pool refuses — the task stopped or cancelled just as it finished (409), a pool that does not answer (503) —
#    is logged, and the builder goes on to its end and exits 0 as after every task: set -e does not end it with curl's 22, and no
#    fail follows. A complete the pool takes says so as before.
for refusal in '409 {"error":"task 813 is cancelled","stop":true,"state":"stopping"}' '503 {"error":"internal error"}' '200 {"task":813,"status":"staged"}'; do
  : > "$STUB_LOG"
  set +e
  env WORKER_LOG="$tmp/worker.log" STUB_CODE="${refusal%% *}" STUB_BODY="${refusal#* }" bash -c '
    set -euo pipefail
    source "$0"
    api() { echo "call $1 $2" >> "$STUB_LOG"; printf "%s\n%s" "$STUB_BODY" "$STUB_CODE"; [[ "$STUB_CODE" == 2* ]]; }
    report_complete 813 "$(printf %064d 0)" felix-1.0-1-aarch64.pkg.tar.zst 1.0-1 42000 "\"the log\""
    echo "went on" >&2
  ' "$tmp/worker.sh" 2>"$tmp/stderr"
  status=$?
  set -e
  [[ "$status" == 0 ]] && grep -q "went on" "$tmp/stderr" || { echo "a complete answered ${refusal%% *} ends nothing: $status $(cat "$tmp/stderr")"; exit 1; }
  if [[ "${refusal%% *}" == 200 ]]; then grep -q "task 813: staged" "$tmp/stderr" || { echo "staged: $(cat "$tmp/stderr")"; exit 1; }
  else grep -q "the pool refused the report of task 813: ${refusal%% *}" "$tmp/stderr" || { echo "and says so: $(cat "$tmp/stderr")"; exit 1; }; fi
  grep -q '/fail' "$STUB_LOG" && { echo "no fail after a refused complete"; exit 1; }
done
echo "worker orders: ok"
