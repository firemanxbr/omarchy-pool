#!/usr/bin/env bash
# The worker checks its agent again until it answers (#273): the claim loop
# of omarchy-build-worker.sh --container, driven on a fake clock against a
# stub agent that is refused at start — the agent proxy replaced in the same
# rollout, not listening yet — and comes up a minute and a half later. The
# worker must report `ok` with its next claim after that, with no restart;
# the re-checks back off (15 s, doubled, back to AGENT_PROBE_MINUTES — an
# agent that fails for good is asked no more often than a healthy one once
# the backoff is spent) instead of waiting half an hour at once or
# spinning; the failure is logged once, not at every re-check; a healthy
# agent keeps its half-hour probe. (The same through a broker went with the
# broker's builder relay, #346.)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
script="$root/factory/worker/omarchy-build-worker.sh"

# The script's functions and settings, up to its dispatch line (docs: testing.md, *The agent sidecar, and the worker script's secrets*).
sed '/^hold_secrets$/,$d' "$script" > "$tmp/worker.sh"

# The pool's tooling where factory_lib looks for it, with a stub agent.py:
# refused until the fake clock reaches STUB_UP_AT, then a tiny completion.
mkdir -p "$tmp/lib/bin" "$tmp/bin"
touch "$tmp/lib/omarchy-staging.pub.asc"; printf '#!/bin/sh\n' > "$tmp/lib/bin/draft-pkgbuild"; chmod +x "$tmp/lib/bin/draft-pkgbuild"
cat > "$tmp/lib/bin/agent.py" <<'P'
import json, os, sys
now = int(open(os.environ["STUB_CLOCK"]).read())
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(f"probe {now} key={'yes' if os.environ.get('ANTHROPIC_API_KEY') else 'no'}\n")
if now < int(os.environ["STUB_UP_AT"]):
    print(json.dumps({"ok": False, "error": "URLError: <urlopen error [Errno 111] Connection refused>"}))
    sys.exit(1)
print(json.dumps({"ok": True, "ms": 42, "agent": "anthropic/claude-sonnet-5"}))
P
# `timeout` is coreutils' on the image; here it only runs the command.
printf '#!/usr/bin/env bash\nshift; exec "$@"\n' > "$tmp/bin/timeout"; chmod +x "$tmp/bin/timeout"

# One run of the claim loop: the pool answers every claim with 204 (no
# work), each claim's agent report goes to STUB_LOG with the fake time,
# `sleep` moves the clock instead of waiting, and IDLE_EXIT ends the run.
# What the worker logs is read from its stderr (its log file is emptied by
# every claim, which carries it to the pool).
run_worker() { # idle-exit-seconds up-at [env...]
  local idle="$1" up="$2"; shift 2
  : > "$STUB_LOG"; echo 1000000 > "$STUB_CLOCK"
  env "$@" STUB_UP_AT=$((1000000 + up)) IDLE_EXIT="$idle" bash -c '
    set -euo pipefail
    source "$0"
    prepare_container() { :; }; add_pool_repos() { :; }
    sleep() { echo $(( $(cat "$STUB_CLOCK") + ${1%.*} )) > "$STUB_CLOCK"; }
    date() { if [[ "$*" == +%s ]]; then cat "$STUB_CLOCK"; else command date "$@"; fi; }
    api() { # method path [json]
      [[ "$2" == /factory/claim ]] && echo "claim $(cat "$STUB_CLOCK") $(jq -c "with_entries(select(.key | startswith(\"agent\")))" <<<"$3")" >> "$STUB_LOG"
      printf "\n204"
    }
    container_worker
  ' "$tmp/worker.sh" 2>"$tmp/stderr"
}
export STUB_LOG="$tmp/calls" STUB_CLOCK="$tmp/clock" PATH="$tmp/bin:$PATH"
common=(WORKER_LOG="$tmp/worker.log" OMARCHY_FACTORY_LIB="$tmp/lib" OMARCHY_WORKER_TOKEN=omw_stub WORKER_ID=studio-review-aarch64 ANTHROPIC_API_KEY=stub-key)

# 1. Refused at start, up after 100 s: ok from the claim after the next re-check, no restart.
run_worker 900 100 "${common[@]}"
probes="$(grep -c '^probe ' "$STUB_LOG")"
first="$(grep -m1 '^claim ' "$STUB_LOG")"
grep -q '"agent_status":"error"' <<<"$first" || { echo "the first claim reports the refusal: $first"; exit 1; }
grep -q 'Connection refused' <<<"$first" || { echo "with the reason: $first"; exit 1; }
ok_at="$(awk '/^claim / && /"agent_status":"ok"/ { print $2; exit }' "$STUB_LOG")"
[[ -n "$ok_at" ]] || { echo "the worker must report ok once the agent answers, without a restart: $(cat "$STUB_LOG")"; exit 1; }
(( ok_at - 1000000 <= 100 + 60 )) || { echo "ok within the backoff of the agent coming up (at +100 s), not at the next half-hour probe: at +$((ok_at - 1000000)) s"; exit 1; }
[[ "$(grep '^claim ' "$STUB_LOG" | tail -1)" == *'"agent_status":"ok"'* ]] || { echo "and ok stays: $(grep '^claim ' "$STUB_LOG" | tail -1)"; exit 1; }
grep -q 'key=yes' "$STUB_LOG" || { echo "the probe gets the agent's key (with_secrets)"; exit 1; }
# Probes at +0, +30, +60 (the 15 s and 30 s re-checks, at the loop's 30 s pace), +120 (60 s): ok. Then nothing for half an hour.
[[ "$probes" == 4 ]] || { echo "four probes — three refused, one answered — then the healthy half-hour probe: $probes: $(grep '^probe ' "$STUB_LOG" | tr '\n' ' ')"; exit 1; }
[[ "$(grep -c 'NOT ready' "$tmp/stderr")" == 1 ]] || { echo "the refusal is logged once, not once per check: $(grep 'agent' "$tmp/stderr")"; exit 1; }
grep -q 'checking again in 15 s, then less often (up to every 1800 s) until it answers' "$tmp/stderr" || { echo "the log says what happens next: $(cat "$tmp/stderr")"; exit 1; }
grep -q 'agent anthropic/claude-sonnet-5: ok (42 ms) — answering again after 3 failed check(s)' "$tmp/stderr" || { echo "and when it answers again: $(cat "$tmp/stderr")"; exit 1; }

# 2. Never up in two hours: bounded — gaps that double back to the half-hour
# probe (AGENT_PROBE_MINUTES) and stay there, one log line.
run_worker 7200 999999 "${common[@]}"
at="$(awk '/^probe / { print $2 - 1000000 }' "$STUB_LOG" | tr '\n' ' ')"
gaps="$(awk '/^probe / { if (last) print $2 - last; last = $2 }' "$STUB_LOG" | tr '\n' ' ')"
[[ "$at" == "0 30 60 120 240 480 960 1920 3720 5520 " ]] || { echo "15 s, doubled, at the loop's 30 s pace, then every half hour: probes at $at"; exit 1; }
prev=0; for g in $gaps; do
  (( g >= prev )) || { echo "the gaps never shrink while the agent is down: $gaps"; exit 1; }
  (( g <= 1830 )) || { echo "and never pass the half-hour probe (at the loop's 30 s pace): $gaps"; exit 1; }
  prev=$g
done
[[ "$(grep -c 'NOT ready' "$tmp/stderr")" == 1 ]] || { echo "the same failure is logged once: $(grep -c 'NOT ready' "$tmp/stderr") lines"; exit 1; }
[[ "$(grep -c '"agent_status":"error"' "$STUB_LOG")" == "$(grep -c '^claim ' "$STUB_LOG")" ]] || { echo "every claim meanwhile says error"; exit 1; }

# 3. Healthy from the start: one probe in half an hour, and a second one after it.
run_worker 1900 0 "${common[@]}"
[[ "$(grep -c '^probe ' "$STUB_LOG")" == 2 ]] || { echo "a healthy agent keeps its AGENT_PROBE_MINUTES probe (at +0 and +30 min): $(grep '^probe ' "$STUB_LOG" | tr '\n' ' ')"; exit 1; }
grep -q '"agent_status":"error"' "$STUB_LOG" && { echo "a healthy agent is never reported in error"; exit 1; }

echo "worker agent re-check: ok"
