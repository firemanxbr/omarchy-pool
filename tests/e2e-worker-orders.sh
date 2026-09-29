# shellcheck shell=bash
# Workers follow the brain for their health (#277, part 1) — the E2E's
# scenarios, sourced by tests/e2e-worker.sh against its local pool (wrangler
# dev with WORKER_RULES_SCALE=60: the rules' step timings divided by 60,
# honoured because POOL_VERSION is "dev"; nothing else is scaled — the caps,
# the 120 s uptime gate, the breaker's windows, every TTL).
#
# Each scenario runs a real `pkg-repo work` of its own (a fresh worker per
# scenario: the per-worker caps are never scaled), under a supervisor loop
# that stands in for `restart: unless-stopped` (OMARCHY_SUPERVISED=1 says so
# to the worker), with AGENT_RETRY_FIRST_SECONDS=1800: the worker's own
# re-check waits half an hour, so what brings it back is the pool alone. Its
# agent is tests/agent-late.py, a stub the scenario switches down, up or to
# a 402. The scenarios run side by side, each on a provider of its own where
# the pool may restart, so one scenario's failing worker never counts in
# another's breaker:
#
#   A   a re-check is enough: up after the first failed probe; one re-check,
#       no restart, no exit
#   A′  up just after the re-check answered error: the conditional restart is
#       refused (agent-ok) — "restarted only if needed"
#   B   a restart is needed, on a worker whose clock is 10 min slow
#       (libfaketime): re-check, restart, exit 75, a new process, ok — the
#       order closed by observation, the re-check timed on the pool's clock
#   C   the bound: never up — exactly two restarts, one "stops restarting"
#       line, then nothing
#   D   the breaker holds an outage older than any window: two more sites of
#       its provider have had an open spell for an hour (rows); the restart
#       is held, one trip line, none after
#   E   a class the pool cannot help (402): no order at all, and the page says
#       why
#
# Needs from the caller: ROOT, E2E, OMARCHY_API, PKG_REPO, WRANGLER_STATE, and
# the maintainer's token omc_e2e. Needs libfaketime for B.

W5_ARCH=x86_64; [[ "$(uname -m)" == arm64 || "$(uname -m)" == aarch64 ]] && W5_ARCH=aarch64
W5="$E2E/w5"

w5_d1() { (cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command "$1") >/dev/null; }
w5_d1_json() { (cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --json --command "$1") | jq -c '.[0].results'; }
# The worker's page's read, past the edge's ten seconds (the key includes the query).
w5_view() { curl -s "$OMARCHY_API/api/v1/factory/workers/$1?orders=20&fresh=$(date +%s%N)"; }
w5_field() { w5_view "$1" | jq -r "$2"; }
w5_orders() { w5_view "$1" | jq -c '[.orders[] | {kind, state, code, issued_at, detail}] | reverse'; }
w5_count() { w5_view "$1" | jq "[.orders[] | select(.kind == \"$2\"$( [[ -n "${3:-}" ]] && echo " and .state == \"$3\"" ))] | length"; }
w5_lines() { curl -s "$OMARCHY_API/api/v1/events?kind=${2:-order}&limit=200" | jq -c --arg w "$1" '[.events[] | select(.summary | startswith($w + ":")) | .summary]'; }
w5_until() { # seconds what command... — polls every 2 s
  local most="$1" what="$2" deadline=$(( SECONDS + $1 )); shift 2
  until "$@"; do (( SECONDS < deadline )) || { echo "timed out after $most s waiting for: $what" >&2; return 1; }; sleep 2; done
}
w5_is() { [[ "$(w5_field "$1" "$2")" == "$3" ]]; }
w5_has() { (( $(w5_count "$1" "$2" "${3:-}") >= ${4:-1} )); }

# Every scenario's worker, registered at once (a community registration of a login with nothing queued: it is handed no task), and
# D's two other failing sites: rows whose spell opened an hour ago and whose last claim is now, of D's provider (anthropic, as its
# worker reports it while its agent does not answer). One statement: the local database takes one writer beside wrangler dev.
w5_seed_all() {
  local id values=()
  for id in w5a w5a2 w5b w5c w5d w5e; do
    values+=("('$id', '$W5_ARCH', 'e2e-w5', '$(printf %s "omw_e2e_$id" | sha256sum | cut -d' ' -f1)', 'dedicated', 'community', NULL, NULL, NULL, NULL, NULL, '2000-01-01T00:00:00Z', NULL)")
  done
  for id in 1 2; do
    values+=("('w5d$id', '$W5_ARCH', 'e2e-w5', NULL, 'dedicated', 'community', 'anthropic/claude-sonnet-5', 'error', 'URLError: <urlopen error [Errno 111] Connection refused>', 'refused', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'e2e-d$id')")
  done
  w5_d1 "INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, agent, agent_status, agent_error, agent_error_class, agent_error_since, last_seen, site) VALUES $(IFS=,; echo "${values[*]}")"
}
w5_agent() { # id mode — the stub's word: down, up, credit
  printf %s "$2" > "$W5/$1/agent"
}
w5_start() { # id provider port [skew]
  local id="$1" provider="$2" port="$3" skew="${4:-}" key base preload=()
  case "$provider" in
    anthropic) key=ANTHROPIC_API_KEY base=ANTHROPIC_BASE_URL ;;
    openai) key=OPENAI_API_KEY base=OPENAI_BASE_URL ;;
    gemini) key=GEMINI_API_KEY base=GEMINI_BASE_URL ;;
    xai) key=XAI_API_KEY base=XAI_BASE_URL ;;
  esac
  # A worker's clock off by $skew: libfaketime preloaded into this pkg-repo (dynamically linked), the monotonic clock left alone.
  if [[ -n "$skew" ]]; then
    local lib; lib="$(find /usr/lib /usr/local/lib /opt/homebrew/lib -name 'libfaketime.so.1' 2>/dev/null | head -n1)"
    [[ -n "$lib" ]] || { echo "scenario $id needs libfaketime (apt-get install faketime) to skew the worker's clock" >&2; return 1; }
    preload=(LD_PRELOAD="$lib" FAKETIME="$skew" FAKETIME_DONT_FAKE_MONOTONIC=1 FAKETIME_NO_CACHE=1)
  fi
  mkdir -p "$W5/$id/work/keyrings"
  # These workers run no sync: the keyrings' stamp stands in for GitHub's, so a start fetches nothing.
  touch "$W5/$id/work/keyrings/archlinux.gpg" "$W5/$id/work/keyrings/.fetched"
  # A slow clock would see a stamp made now in its future, and not fresh: an hour old, it is fresh on either clock (GNU touch; the
  # skew is Linux's alone).
  [[ -z "$skew" ]] || touch -d "@$(( $(date +%s) - 3600 ))" "$W5/$id/work/keyrings/.fetched"
  python3 "$ROOT/tests/agent-late.py" "$port" "$W5/$id/agent" > "$W5/$id/agent.log" 2>&1 &
  echo $! > "$W5/$id/agent.pid"; disown $!
  # The supervisor: whatever the worker exits with is noted, and it starts again — a non-zero exit is what it is here for, never the end of the loop.
  (
    set +e
    while :; do
      code=0
      env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" ${preload[@]+"${preload[@]}"} \
        OMARCHY_WORKER_TOKEN="omw_e2e_$id" OMARCHY_SUPERVISED=1 AGENT_RETRY_FIRST_SECONDS=1800 \
        FACTORY_PROVIDER="$provider" "$key=stub-key" "$base=http://127.0.0.1:$port" \
        "$PKG_REPO" work --api "$OMARCHY_API" --arch "$W5_ARCH" --kind build --repo-dir "$ROOT" --work-dir "$W5/$id/work" >> "$W5/$id/log" 2>&1 || code=$?
      echo "$code" >> "$W5/$id/exits"
      [[ -e "$W5/$id/stop" ]] && break
      [[ -x "$W5/$id/on-exit" ]] && "$W5/$id/on-exit"
      sleep 1
    done
  ) &
  echo $! > "$W5/$id/pid"
}
w5_stop() { # id — the supervisor, the worker under it, the stub
  touch "$W5/$1/stop"
  pkill -TERM -f -- "--work-dir $W5/$1/work" 2>/dev/null || true
  kill "$(cat "$W5/$1/agent.pid")" 2>/dev/null || true
  local i; for i in $(seq 1 30); do kill -0 "$(cat "$W5/$1/pid")" 2>/dev/null || break; sleep 1; done
  kill -KILL "$(cat "$W5/$1/pid")" 2>/dev/null || true
}
w5_revoke() { # id... — its open orders cancelled with it, a line each
  local id code; for id in "$@"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$OMARCHY_API/api/v1/factory/workers/$id" -H "authorization: Bearer omc_e2e")"
    [[ "$code" == 200 ]] || { echo "revoking $id answered $code" >&2; return 1; }
  done
}
w5_exits() { [[ -s "$W5/$1/exits" ]] && tr '\n' ' ' < "$W5/$1/exits" || true; }
w5_fail() { echo "scenario $1: $2 — its orders: $(w5_orders "$1")" >&2; echo "--- $1's log:" >&2; tail -n 40 "$W5/$1/log" >&2; return 1; }
w5_iso() { python3 -c 'import sys, datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))' "$1"; }

# A: the agent answers after the first failed probe; the pool's re-check brings the worker back, with no restart and no exit.
w5_scenario_a() {
  local id=w5a
  mkdir -p "$W5/$id"; w5_agent $id down; w5_start $id anthropic 18801
  w5_until 120 "$id's first claim says its agent does not answer" w5_is $id .worker.agent_status error || w5_fail $id "no failed probe"
  w5_agent $id up
  w5_until 150 "the pool re-checks $id" w5_has $id recheck-agent done || w5_fail $id "no re-check"
  w5_until 60 "$id says its agent answers" w5_is $id .worker.agent_status ok || w5_fail $id "not ok after the re-check"
  sleep 40
  [[ "$(w5_orders $id | jq -c 'map([.kind, .state])')" == '[["recheck-agent","done"]]' ]] || w5_fail $id "one re-check, and nothing else"
  [[ -z "$(w5_exits $id)" ]] || w5_fail $id "it exited: $(w5_exits $id)"
  w5_stop $id; w5_revoke $id
  echo "A: $id re-checked once by the pool, ok, no restart"
}

# A′: down at the re-check, up just after it: the pool's conditional restart is refused, and nothing exits.
w5_scenario_a2() {
  local id=w5a2
  mkdir -p "$W5/$id"; w5_agent $id down; w5_start $id openai 18802
  w5_until 120 "$id's first claim says its agent does not answer" w5_is $id .worker.agent_status error || w5_fail $id "no failed probe"
  w5_until 150 "the pool re-checks $id, and the agent is still down" w5_has $id recheck-agent done || w5_fail $id "no re-check"
  w5_agent $id up
  w5_until 240 "the pool's conditional restart of $id, refused" w5_has $id restart refused || w5_fail $id "no restart refused"
  [[ "$(w5_view $id | jq -r '[.orders[] | select(.kind == "restart")][0] | "\(.code) \(.detail)"')" == "agent-ok its agent answers now: no restart needed" ]] || w5_fail $id "the restart's answer"
  w5_lines $id | grep -q "restart refused — its agent answers now: no restart needed" || w5_fail $id "the journal says it"
  sleep 5
  [[ -z "$(w5_exits $id)" ]] || w5_fail $id "it exited: $(w5_exits $id)"
  w5_stop $id; w5_revoke $id
  echo "A′: $id's restart refused by its own probe — restarted only if needed"
}

# B: a restart is needed, on a worker whose clock is 10 minutes slow: the re-check comes on the pool's clock, the restart after 120 s of the pool's uptime, exit 75, a new process, ok.
w5_scenario_b() {
  local id=w5b
  mkdir -p "$W5/$id"; w5_agent $id down
  printf '#!/usr/bin/env bash\nprintf up > %q\n' "$W5/$id/agent" > "$W5/$id/on-exit"; chmod +x "$W5/$id/on-exit"
  w5_start $id gemini 18803 "-10m" || return 1
  w5_until 120 "$id's first claim says its agent does not answer" w5_is $id .worker.agent_status error || w5_fail $id "no failed probe"
  local spell up started
  spell="$(w5_field $id .worker.not_ready_since)"; up="$(w5_field $id .worker.up_since)"; started="$(w5_field $id .worker.started_at)"
  # Its own clock says it started ten minutes before the pool first heard of it.
  (( $(w5_iso "$up") - $(w5_iso "$started") >= 9 * 60 )) || w5_fail $id "the worker's clock is not skewed: started $started, up since $up"
  w5_until 150 "the pool re-checks $id" w5_has $id recheck-agent || w5_fail $id "no re-check"
  local recheck; recheck="$(w5_view $id | jq -r '[.orders[] | select(.kind == "recheck-agent")][0].issued_at')"
  # On the pool's clock, RECHECK_AFTER_MIN (scaled: 5 s) after the spell began — not at the first claim, as a comparison with the worker's slow stamp would have it.
  (( $(w5_iso "$recheck") - $(w5_iso "$spell") >= 5 )) || w5_fail $id "the re-check came too soon: spell $spell, re-check $recheck"
  w5_until 240 "the pool restarts $id" w5_has $id restart || w5_fail $id "no restart"
  local restart; restart="$(w5_view $id | jq -r '[.orders[] | select(.kind == "restart")][0].issued_at')"
  (( $(w5_iso "$restart") - $(w5_iso "$up") >= 120 )) || w5_fail $id "restarted under 120 s of uptime: up $up, restart $restart"
  w5_until 60 "$id exits 75" grep -qx 75 "$W5/$id/exits" || w5_fail $id "no exit 75"
  w5_until 90 "the restart closed when the new process claimed" w5_has $id restart done || w5_fail $id "the restart did not close"
  w5_view $id | jq -r '[.orders[] | select(.kind == "restart")][0].detail' | grep -q "back as a new process" || w5_fail $id "closed by observation"
  w5_until 60 "$id says its agent answers" w5_is $id .worker.agent_status ok || w5_fail $id "not ok after the restart"
  w5_stop $id; w5_revoke $id
  echo "B: $id restarted once by the pool, on the pool's clock, and back"
}

# C: never up — exactly two restarts, one "stops restarting" line, then nothing.
w5_scenario_c() {
  local id=w5c
  mkdir -p "$W5/$id"; w5_agent $id down; w5_start $id xai 18804
  w5_until 600 "the pool gives $id up" bash -c "curl -s '$OMARCHY_API/api/v1/events?kind=order&limit=200' | jq -e '[.events[] | select(.summary | startswith(\"$id: the pool stops restarting it\"))] | length == 1' >/dev/null" || w5_fail $id "no give-up line"
  sleep 40
  [[ "$(w5_count $id restart)" == 2 ]] || w5_fail $id "two restarts, not $(w5_count $id restart)"
  [[ "$(w5_count $id recheck-agent)" == 1 ]] || w5_fail $id "one re-check"
  [[ "$(grep -cx 75 "$W5/$id/exits")" == 2 ]] || w5_fail $id "two exits 75: $(w5_exits $id)"
  [[ "$(w5_lines $id | jq '[.[] | select(startswith("'$id': the pool stops restarting it"))] | length')" == 1 ]] || w5_fail $id "one give-up line"
  w5_stop $id; w5_revoke $id
  echo "C: $id restarted twice, then left to a person, once"
}

# D: two more sites of its provider have had an open spell for an hour: the breaker trips at the first restart the rules propose, and holds.
w5_scenario_d() {
  local id=w5d
  mkdir -p "$W5/$id"; w5_agent $id down; w5_start $id anthropic 18805
  w5_until 120 "$id's first claim says its agent does not answer" w5_is $id .worker.agent_status error || w5_fail $id "no failed probe"
  local agent; agent="$(w5_field $id .worker.agent)"
  [[ "$agent" == anthropic/claude-sonnet-5 ]] || w5_fail $id "its agent is $agent, not the provider of the two other failing sites"
  w5_until 150 "the pool re-checks $id: the breaker holds only restarts" w5_has $id recheck-agent done || w5_fail $id "no re-check"
  local provider="${agent%%/*}"
  w5_until 240 "the breaker trips" bash -c "curl -s '$OMARCHY_API/api/v1/events?kind=order&limit=200' | jq -e '[.events[] | select(.summary | startswith(\"provider outage suspected: 3 $provider sites\"))] | length == 1' >/dev/null" || w5_fail $id "no trip line"
  sleep 40
  [[ "$(w5_count $id restart)" == 0 ]] || w5_fail $id "a restart went out while the breaker held"
  [[ "$(curl -s "$OMARCHY_API/api/v1/events?kind=order&limit=200" | jq '[.events[] | select(.summary | startswith("provider outage suspected"))] | length')" == 1 ]] || w5_fail $id "one trip line"
  [[ "$(w5_field $id .breaker.provider)" == "$provider" ]] || w5_fail $id "its page says why"
  w5_stop $id; w5_revoke $id w5d1 w5d2
  echo "D: the breaker held $id's restart through an outage an hour old, one line"
}

# E: no credit — the pool orders nothing, not even a re-check, and the page says why.
w5_scenario_e() {
  local id=w5e
  mkdir -p "$W5/$id"; w5_agent $id credit; w5_start $id anthropic 18806
  w5_until 120 "$id's first claim says its agent does not answer" w5_is $id .worker.agent_status error || w5_fail $id "no failed probe"
  sleep 90
  [[ "$(w5_view $id | jq '.orders | length')" == 0 ]] || w5_fail $id "an order for an error a restart cannot help"
  w5_field $id .worker.pool_waits | grep -q "credit" || w5_fail $id "the page does not say why the pool waits"
  w5_stop $id; w5_revoke $id
  echo "E: $id without credit: no order, and its page says why"
}

# All six side by side; each one's result, then the record: every order of theirs has one issue line and one final line.
w5_scenarios() {
  mkdir -p "$W5"
  w5_seed_all
  local s pids=() names=() failed=0
  for s in a a2 b c d e; do
    ( set -eo pipefail; "w5_scenario_$s" ) > "$W5/scenario-$s.out" 2>&1 &
    pids+=("$!"); names+=("$s")
  done
  local i; for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then cat "$W5/scenario-${names[$i]}.out"
    else failed=1; echo "scenario ${names[$i]} failed:" >&2; cat "$W5/scenario-${names[$i]}.out" >&2; fi
  done
  (( failed == 0 )) || return 1
  local bad tries
  for tries in 1 2 3; do bad="$(w5_d1_json "SELECT o.id, o.state, (SELECT COUNT(*) FROM events e WHERE e.kind = 'order' AND json_extract(e.payload, '\$.order') = o.id) AS lines FROM worker_orders o WHERE o.worker_id LIKE 'w5%'" | jq -c '[.[] | select(.lines != 2)]')" && break; sleep 3; done
  [[ "$bad" == "[]" ]] || { echo "orders without exactly one issue line and one final line: $bad" >&2; return 1; }
  echo "orders: every scenario's order has its issue line and its final line"
}
