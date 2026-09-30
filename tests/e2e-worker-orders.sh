# shellcheck shell=bash
# Workers follow the brain for their health (#277, parts 1, 2 and 3) — the E2E's
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
# a 402. The scenarios run side by side. The breaker counts failing sites
# per provider, and trips at three: D's provider (anthropic) is its own
# among the scenarios that fail in a class it counts — E's anthropic agent
# answers 402, which it does not count — and A and A′ share openai, two
# sites that can never make three. So D's count is exactly its worker and
# its two rows, and no scenario's worker holds another's restart:
#
#   A   a re-check is enough: up after the first failed probe; one re-check,
#       no restart, no exit
#   A′  up just after the re-check answered error: the conditional restart is
#       refused (agent-ok) — "restarted only if needed"
#   B   a restart is needed, on a worker whose clock is 10 min fast
#       (libfaketime): re-check, restart, exit 75, a new process, ok — the
#       order closed by observation. On the worker's own clock its probe
#       would never look stale and its process would look ten minutes old:
#       the re-check that comes, and the restart that waits 120 s of the
#       pool's uptime, show both are measured on the pool's clock
#   C   the bound: never up — exactly two restarts, one "stops restarting"
#       line, then nothing
#   D   the breaker holds an outage older than any window: two more sites of
#       its provider have had an open spell for an hour (rows); the restart
#       is held, one trip line, none after
#   E   a class the pool cannot help (402): no order at all, and the page says
#       why
#   F   (part 2) drain and resume: a maintainer drains a worker; its next claim
#       hears the notice once and the drain is done; Resume ends it, done at
#       issue — the worker never exits
#   G   (part 2) Stop its task: a project worker runs a check that hangs (a
#       stub checkout's health script, which creates a labelled container and
#       leaves a child that never ends); its claim declares stop-task, so the
#       dialog words the stop as a child's; a maintainer stops it; the task stays
#       leased to it — no second runner — until its next heartbeat brings the
#       stop: the child's process group killed, the created container removed,
#       and its next claim gives the task back to the queue
#   H   (part 3) Update through the set's updater: the real
#       factory/bin/omarchy-rollout --loop, against a stubbed engine whose
#       broker answers for the builder w5h, asks this pool's follow with that
#       id, runs one round for the Update and no second one; the round's
#       replacement of the builder claims on the pool's release, and the
#       Update closes done. This local pool runs no release (dev), so the
#       door refuses Update ("nothing to update to") and the order is
#       written as a release's door writes it — its issue line included.
#
# Needs from the caller: ROOT, E2E, OMARCHY_API, PKG_REPO, WRANGLER_STATE, and
# the maintainer's token omc_e2e. Needs libfaketime for B. A scenario that
# fails still stops its worker and its stub agent (w5_cleanup, which the
# E2E's own EXIT trap runs too): nothing of it keeps a port or a loop.

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
# A task's status, past the edge's cache: the URL in double quotes, so the cache-buster is expanded here — inside a bash -c string's
# single quotes it went to curl as "$(date +%s%N)", a URL with a space that curl refuses (exit 3), and the wait read nothing for its whole time.
w5_task_is() { [[ "$(curl -s "$OMARCHY_API/api/v1/factory/tasks/$1?fresh=$(date +%s%N)" | jq -r .task.status)" == "$2" ]]; }
w5_has() { (( $(w5_count "$1" "$2" "${3:-}") >= ${4:-1} )); }

# Every scenario's worker, registered at once (a community registration of a login with nothing queued: it is handed no task), and
# D's two other failing sites: rows whose spell opened an hour ago and whose last claim is now, of D's provider (anthropic, as its
# worker reports it while its agent does not answer). One statement: the local database takes one writer beside wrangler dev.
w5_seed_all() {
  local id values=()
  for id in w5a w5a2 w5b w5c w5d w5e w5f w5h; do
    values+=("('$id', '$W5_ARCH', 'e2e-w5', '$(printf %s "omw_e2e_$id" | sha256sum | cut -d' ' -f1)', 'dedicated', 'community', NULL, NULL, NULL, NULL, NULL, NULL, '2000-01-01T00:00:00Z', NULL)")
  done
  # G's worker is the project's: it runs pool jobs, the check that hangs among them.
  values+=("('w5g', '$W5_ARCH', 'e2e', '$(printf %s "omw_e2e_w5g" | sha256sum | cut -d' ' -f1)', 'shared', 'project', 'e2e', NULL, NULL, NULL, NULL, NULL, '2000-01-01T00:00:00Z', NULL)")
  for id in 1 2; do
    values+=("('w5d$id', '$W5_ARCH', 'e2e-w5', NULL, 'dedicated', 'community', NULL, 'anthropic/claude-sonnet-5', 'error', 'URLError: <urlopen error [Errno 111] Connection refused>', 'refused', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'e2e-d$id')")
  done
  w5_d1 "INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, agent, agent_status, agent_error, agent_error_class, agent_error_since, last_seen, site) VALUES $(IFS=,; echo "${values[*]}")"
}
w5_agent() { # id mode — the stub's word: down, up, credit
  printf %s "$2" > "$W5/$1/agent"
}
w5_listening() { # port — a bare connect, no request: the stub counts no probe for it
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
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
  # A skewed clock would see a stamp made now in its future or its past: an hour old, it is fresh on either clock (GNU touch; the
  # skew is Linux's alone).
  [[ -z "$skew" ]] || touch -d "@$(( $(date +%s) - 3600 ))" "$W5/$id/work/keyrings/.fetched"
  python3 "$ROOT/tests/agent-late.py" "$port" "$W5/$id/agent" > "$W5/$id/agent.log" 2>&1 &
  echo $! > "$W5/$id/agent.pid"; disown $!
  # A stub told to listen does so before the worker's first probe: a probe that beats Python's start reads "Connection refused",
  # a class the pool re-checks, not the one the scenario set (E's first probe must be its 402).
  if [[ "$(cat "$W5/$id/agent")" != down ]]; then
    w5_until 30 "$id's stub agent listening on $port" w5_listening "$port" || return 1
  fi
  # The supervisor: whatever the worker exits with is noted, and it starts again — a non-zero exit is what it is here for, never the end of the loop.
  (
    set +e
    while :; do
      code=0
      env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" ${preload[@]+"${preload[@]}"} \
        OMARCHY_WORKER_TOKEN="omw_e2e_$id" OMARCHY_SUPERVISED=1 AGENT_RETRY_FIRST_SECONDS=1800 \
        FACTORY_PROVIDER="$provider" "$key=stub-key" "$base=http://127.0.0.1:$port" \
        "$PKG_REPO" work --api "$OMARCHY_API" --arch "$W5_ARCH" --kind "${W5_KIND:-build}" --repo-dir "${W5_REPO:-$ROOT}" --work-dir "$W5/$id/work" >> "$W5/$id/log" 2>&1 || code=$?
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
  mkdir -p "$W5/$id"; w5_agent $id down; w5_start $id openai 18801
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

# B: a restart is needed, on a worker whose clock is 10 minutes fast: the re-check comes on the pool's clock, the restart after 120 s of the pool's uptime, exit 75, a new process, ok.
w5_scenario_b() {
  local id=w5b
  mkdir -p "$W5/$id"; w5_agent $id down
  printf '#!/usr/bin/env bash\nprintf up > %q\n' "$W5/$id/agent" > "$W5/$id/on-exit"; chmod +x "$W5/$id/on-exit"
  w5_start $id gemini 18803 "+10m" || return 1
  w5_until 120 "$id's first claim says its agent does not answer" w5_is $id .worker.agent_status error || w5_fail $id "no failed probe"
  local spell up checked started
  spell="$(w5_field $id .worker.not_ready_since)"; up="$(w5_field $id .worker.up_since)"; checked="$(w5_field $id .worker.agent_checked_at)"; started="$(w5_field $id .worker.started_at)"
  # Its own clock stamps its probe ten minutes after the pool first heard of it; a start in the pool's future is kept by nobody.
  (( $(w5_iso "$checked") - $(w5_iso "$up") >= 9 * 60 )) || w5_fail $id "the worker's clock is not skewed: probed $checked, up since $up"
  [[ "$started" == null ]] || w5_fail $id "a start ten minutes in the pool's future was kept: $started"
  # On the worker's clock its probe is always fresh, so a re-check that comes is the pool's clock's: RECHECK_AFTER_MIN (scaled: 5 s) after the spell began.
  w5_until 150 "the pool re-checks $id" w5_has $id recheck-agent || w5_fail $id "no re-check: the probe's age was read on the worker's clock"
  local recheck; recheck="$(w5_view $id | jq -r '[.orders[] | select(.kind == "recheck-agent")][0].issued_at')"
  (( $(w5_iso "$recheck") - $(w5_iso "$spell") >= 5 )) || w5_fail $id "the re-check came too soon: spell $spell, re-check $recheck"
  w5_until 240 "the pool restarts $id" w5_has $id restart || w5_fail $id "no restart"
  local restart; restart="$(w5_view $id | jq -r '[.orders[] | select(.kind == "restart")][0].issued_at')"
  # On its own clock the process was ten minutes old at its first claim: a restart under 120 s of the pool's uptime would be that clock's.
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

# F (#277, part 2): a maintainer drains a worker — it hears the notice with its next claim, once, and the drain is done — then resumes it,
# done at issue. The worker never exits: the pool holds both.
w5_scenario_f() {
  local id=w5f
  mkdir -p "$W5/$id"; w5_agent $id up; w5_start $id openai 18807
  w5_until 120 "$id's first claim" w5_is $id .worker.agent_status ok || w5_fail $id "no claim"
  local d; d="$(curl -s -X POST "$OMARCHY_API/api/v1/factory/workers/$id/orders" -H "authorization: Bearer omc_e2e" -H "content-type: application/json" -d '{"kind":"drain","reason":"e2e: a disk swap"}')"
  [[ "$(jq -r .order.kind <<<"$d")" == drain ]] || w5_fail $id "the drain was refused: $d"
  [[ "$(w5_field $id .worker.drained.by)" == e2e ]] || w5_fail $id "drained at once, by whom"
  w5_until 90 "$id hears the drain with its next claim" grep -q "drained by e2e — the pool hands me nothing until it is resumed" "$W5/$id/log" || w5_fail $id "no notice in its log"
  w5_until 30 "the drain is done" w5_has $id drain done || w5_fail $id "the drain did not close"
  [[ "$(grep -c "drained by e2e" "$W5/$id/log")" == 1 ]] || w5_fail $id "the notice came more than once"
  local r; r="$(curl -s -X POST "$OMARCHY_API/api/v1/factory/workers/$id/orders" -H "authorization: Bearer omc_e2e" -H "content-type: application/json" -d '{"kind":"resume"}')"
  [[ "$(jq -r .order.state <<<"$r")" == done ]] || w5_fail $id "the resume: $r"
  [[ "$(w5_field $id .worker.drained)" == null ]] || w5_fail $id "still drained after the resume"
  sleep 35
  [[ -z "$(w5_exits $id)" ]] || w5_fail $id "it exited: $(w5_exits $id)"
  w5_stop $id; w5_revoke $id
  echo "F: $id drained, heard it once, resumed — no exit"
}

# G (#277, part 2): Stop its task. A project worker takes a health check from a stub checkout whose script hangs: it creates a container
# labelled with its task (when the runner has an engine) and leaves a child that never ends. A maintainer stops the task: it stays leased
# to the worker until the worker's next heartbeat (every 5 min) brings the stop — the script's process group killed, the task's container
# removed — and the worker's next claim gives it back to the queue. The script does not hang a second time, so the task runs again, done.
w5_scenario_g() {
  local id=w5g repo="$W5/w5g/repo"
  mkdir -p "$W5/$id" "$repo/tests"; w5_agent $id up
  cat > "$repo/tests/health-check.sh" <<SH
#!/usr/bin/env bash
# The E2E's check that hangs, once (#277, part 2).
set -u
source "$ROOT/tests/images.env"
[[ -e "$W5/$id/hung" ]] && exit 0
echo "\${OMARCHY_TASK_ID:-none}" > "$W5/$id/hung"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker create --name "omarchy-task-\$OMARCHY_TASK_ID-e2e-\$\$" --label "com.omarchy.task=\$OMARCHY_TASK_ID" "\$ARCHLINUX_BASE" true > "$W5/$id/created" 2>/dev/null || true
fi
sleep 900 & echo \$! > "$W5/$id/child"
wait
SH
  chmod +x "$repo/tests/health-check.sh"
  local task; task="$(w5_d1_json "INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, status, publish, trust, kind, params) VALUES ('health', '$W5_ARCH', '-', 'e2e: a check that hangs', 1, 'queued', 1, 'project', 'health', '{\"ring\":\"edge\",\"arch\":\"$W5_ARCH\"}') RETURNING id" | jq -r '.[0].id')"
  [[ "$task" =~ ^[0-9]+$ ]] || w5_fail $id "the task was not queued: $task"
  W5_KIND=health W5_REPO="$repo" w5_start $id anthropic 18808
  w5_until 120 "$id takes task $task" w5_is $id .worker.current_task "$task" || w5_fail $id "it never took the check"
  w5_until 60 "the check hangs" test -s "$W5/$id/child" || w5_fail $id "the stub check never ran"
  [[ "$(cat "$W5/$id/hung")" == "$task" ]] || w5_fail $id "the script was not told its task: $(cat "$W5/$id/hung")"
  # It says it stops on the pool's word — its claim declares stop-task —, so /can words a check's stop as a child's: within 5 minutes.
  [[ "$(w5_field $id '.worker.takes_orders | index("stop-task") != null')" == true ]] || w5_fail $id "its claim declares stop-task: $(w5_view $id | jq -c .worker.takes_orders)"
  local can; can="$(curl -s "$OMARCHY_API/api/v1/factory/workers/$id/can" -H "authorization: Bearer omc_e2e")"
  [[ "$(jq -r '"\(.stop.task) \(.stop.stops)"' <<<"$can")" == "$task child" ]] || w5_fail $id "a check stops as a child: $(jq -c .stop <<<"$can")"
  local s; s="$(curl -s -X POST "$OMARCHY_API/api/v1/factory/workers/$id/orders" -H "authorization: Bearer omc_e2e" -H "content-type: application/json" -d "{\"kind\":\"stop-task\",\"task\":$task,\"reason\":\"e2e: a check that hangs\"}")"
  [[ "$(jq -r .order.kind <<<"$s")" == stop-task ]] || w5_fail $id "the stop was refused: $s"
  local tv; tv="$(curl -s "$OMARCHY_API/api/v1/factory/tasks/$task?fresh=$(date +%s%N)")"
  [[ "$(jq -r '"\(.task.status) \(.task.lease_owner) \(.task.stop_order != null)"' <<<"$tv")" == "leased $id true" ]] || w5_fail $id "fenced, still its worker's: $(jq -c '.task | {status, lease_owner, stop_order}' <<<"$tv")"
  # The latest it goes back to the queue: the fenced lease's end, never renewed — the page says it on its reader's clock, the door's note in UTC.
  [[ "$(jq -r .order.until <<<"$s")" == "$(jq -r .task.lease_expires_at <<<"$tv")" ]] || w5_fail $id "the stop's until is its lease's end: $s"
  jq -r .note <<<"$s" | grep -q " UTC at the latest)" || w5_fail $id "the door's note says the pool's clock: $(jq -r .note <<<"$s")"
  [[ "$(w5_field $id .worker.stopping.task)" == "$task" ]] || w5_fail $id "its page says it is stopping"
  # The next heartbeat brings the stop (within 5 min of the task's start), then the claim after it gives the task back.
  w5_until 420 "$id hears the stop at its heartbeat" grep -q "task $task: the pool took it back (stopping); stopping its processes" "$W5/$id/log" || w5_fail $id "no stop in its log"
  w5_until 60 "the stop is done: $id claimed again" w5_has $id stop-task done || w5_fail $id "the stop did not close"
  w5_view $id | jq -r '[.orders[] | select(.kind == "stop-task")][0].detail' | grep -q "task #$task is back in the queue" || w5_fail $id "the stop's words"
  ! kill -0 "$(cat "$W5/$id/child")" 2>/dev/null || w5_fail $id "the check's child outlived the stop"
  if [[ -s "$W5/$id/created" ]]; then
    [[ -z "$(docker ps -aq --filter "label=com.omarchy.task=$task")" ]] || w5_fail $id "the task's created container outlived the stop"
  fi
  w5_lines "health for $W5_ARCH" build | grep -q "stopped on $id by e2e: e2e: a check that hangs — back in the queue" || w5_fail $id "the build line names the stop"
  # Back in the queue, it runs again — the script does not hang twice — and is done: nothing was cancelled.
  w5_until 90 "the check runs again, done" w5_task_is "$task" done || w5_fail $id "the task did not run again"
  [[ -z "$(w5_exits $id)" ]] || w5_fail $id "it exited: $(w5_exits $id)"
  w5_stop $id; w5_revoke $id
  echo "G: $id's hung check stopped at its heartbeat — its child killed, its container removed — back in the queue, and done"
}

# H (#277, part 3): an Update, carried out by the set's updater — the real omarchy-rollout --loop against this pool — and closed by the claim that follows.
w5_closed() { w5_view "$1" | jq -e --arg o "$2" '[.orders[] | select(.id == $o and .state == "done" and .detail == "now runs dev")] | length == 1' >/dev/null; }
w5_scenario_h() {
  local id=w5h dir="$W5/w5h" order
  mkdir -p "$dir/bin" "$dir/set" "$dir/run"
  : > "$dir/set/compose.yml"
  # The builder claims on an older release; on a pool that runs no release, the door has nothing to update it to.
  local claim; claim="$(jq -cn --arg a "$W5_ARCH" '{arch:$a, version:"v0.9.0"}')"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" -H "authorization: Bearer omw_e2e_$id" -H 'content-type: application/json' -d "$claim")" == 204 ]] || w5_fail $id "its first claim"
  local door; door="$(curl -s -X POST "$OMARCHY_API/api/v1/factory/workers/$id/orders" -H 'authorization: Bearer omc_e2e' -H 'content-type: application/json' -d '{"kind":"update"}')"
  [[ "$(jq -r .error <<<"$door")" == "the pool runs no release (dev): there is nothing to update to" ]] || w5_fail $id "the door on a pool that runs no release: $door"
  # The set: a broker that answers for the builder, the builder, and the updater. The engine is a stub: it records, answers from its
  # state, and its `up` of the builder is the new container's first claim, on the pool's release.
  cat > "$dir/bin/docker" <<S
#!/usr/bin/env bash
LOG="$dir/docker.log"; STATE="$dir/state"; API="$OMARCHY_API"; ARCH="$W5_ARCH"
S
  cat >> "$dir/bin/docker" <<'S'
echo "docker $*" >> "$LOG"
img() { awk -v s="$1" '$1==s {print $2}' "$STATE"; }
case "$1" in
  info) exit 0 ;;
  compose) shift; [[ "$1" == --project-directory ]] && shift 2
    case "$1" in
      config) case "${2:-}" in
          --services) printf '%s\n' broker worker updater ;;
          --format) echo '{"name":"e2e-h","services":{"broker":{"image":"img","environment":{"OMARCHY_WORKER_ROLE":"broker"}},"worker":{"image":"img","environment":{}},"updater":{"image":"img","environment":{"OMARCHY_WORKER_ROLE":"updater"}}}}' ;;
          --hash) echo "$3 cfg" ;;
        esac ;;
      ps) echo "cid-$3" ;;
      up) for a in "$@"; do [[ "$a" == worker ]] || continue
            awk '$1=="worker" {$2="sha256:new"} {print}' "$STATE" > "$STATE.n" && mv "$STATE.n" "$STATE"
            body="$(jq -cn --arg a "$ARCH" '{arch:$a, version:"dev"}')"
            curl -s -o /dev/null -X POST "$API/api/v1/factory/claim" -H "authorization: Bearer omw_e2e_w5h" -H 'content-type: application/json' -d "$body"; done ;;
      run) [[ " $* " == *" --self-test "* ]] && echo "follows 1" ;;
    esac ;;
  image) [[ "$2" == inspect ]] && { [[ "$4" == *com.omarchy.updater.follows* ]] && echo 1 || echo sha256:new; } ;;
  ps) printf '%s\n' cid-broker cid-worker cid-updater ;;
  # The lock: created by name once, its labels read back as the engine would.
  create) [[ -f "$STATE.lock" ]] && exit 1; by=""; holder=""; started=""; until=""; nonce=""
    while [[ $# -gt 0 ]]; do [[ "$1" == --label ]] && { k="${2%%=*}"; v="${2#*=}"; case "$k" in *.by) by="$v" ;; *.holder) holder="$v" ;; *.started) started="$v" ;; *.until) until="$v" ;; *.nonce) nonce="$v" ;; esac; shift; }; shift; done
    printf '%s|%s|%s|%s|2026-01-01T00:00:00Z|%s\n' "$by" "$holder" "$started" "$until" "$nonce" > "$STATE.lock" ;;
  rm) rm -f "$STATE.lock" ;;
  inspect) c="${@: -1}"; s="${c#cid-}"
    case "$3" in
      *com.omarchy.lock.by*) [[ -f "$STATE.lock" ]] || exit 1; IFS='|' read -r by holder started until created nonce < "$STATE.lock"; echo "$by|$holder|$started|$until|$created|lock-$nonce" ;;
      *com.omarchy.lock.nonce*) [[ -f "$STATE.lock" ]] || exit 1; IFS='|' read -r by holder started until created nonce < "$STATE.lock"; echo "$holder|$started|$nonce|lock-$nonce" ;;
      "{{.Image}}") img "$s" ;;
      *config-hash*) echo cfg ;;
      *'service"}} {{.Image}}'*) echo "$s $(img "$s") False" ;;
      *compose.service*) echo "$s" ;;
      *OMARCHY_WORKER_ROLE*) case "$s" in broker) echo OMARCHY_WORKER_ROLE=broker ;; updater) echo OMARCHY_WORKER_ROLE=updater ;; esac ;;
      *OMARCHY_BROKER*) [[ "$s" == worker ]] && echo set ;;
      *) echo "running 0 0" ;;
    esac ;;
  exec) [[ "$2" == cid-broker && "$*" == *"/pool/factory/workers/self" ]] && echo '{"id":"w5h"}' ;;
  logs) : ;;
esac
exit 0
S
  chmod +x "$dir/bin/docker"
  printf '%s\n' "broker sha256:new" "worker sha256:new" "updater sha256:new" > "$dir/state"
  PATH="$dir/bin:$PATH" OMARCHY_API="$OMARCHY_API" COMPOSE_DIR="$dir/set" OMARCHY_RUN_DIR="$dir/run" ROLLOUT_POLL=2 ROLLOUT_EVERY=3600 ROLLOUT_GUARD_SECONDS=0 \
    "$ROOT/factory/bin/omarchy-rollout" --loop > "$dir/updater.log" 2>&1 &
  echo $! > "$dir/updater.pid"
  w5_until 30 "the updater's first round" grep -q "a round: the pool's release is dev" "$dir/updater.log" || w5_fail $id "no first round: $(cat "$dir/updater.log")"
  grep -q "^docker exec cid-broker curl -s --max-time 5 http://127.0.0.1:8790/pool/factory/workers/self$" "$dir/docker.log" || w5_fail $id "the builder's id is asked of its broker"
  grep -qE "^docker exec cid-worker" "$dir/docker.log" && w5_fail $id "nothing is read of a builder's container"
  # The Update, as a release's door writes it (its issue line too), and a builder behind the release: the updater's next poll past
  # the edge's thirty seconds sees it.
  order="wo_$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  awk '$1=="worker" {$2="sha256:old"} {print}' "$dir/state" > "$dir/state.n" && mv "$dir/state.n" "$dir/state"
  # One command, three statements: the local database takes one writer beside wrangler dev.
  w5_d1 "INSERT INTO worker_orders (id, worker_id, kind, reason, issued_by, via, expires_at) VALUES ('$order', '$id', 'update', 'the E2E: as a release''s door issues it', 'e2e', 'token', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+6 hours'));
    UPDATE build_workers SET open_orders = json_array(json_object('id', '$order', 'kind', 'update', 'state', 'pending', 'by', 'e2e', 'at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) WHERE id = '$id';
    INSERT INTO events (kind, ring, source, status, summary, payload) VALUES ('order', NULL, 'factory', 'ok', '$id: update ordered by e2e — the E2E', json_object('order', '$order', 'worker', '$id', 'kind', 'update', 'by', 'e2e', 'state', 'pending'))"
  w5_until 90 "the updater's round for the Update" grep -q "a round: Update $order for $id" "$dir/updater.log" || w5_fail $id "no round for the Update: $(cat "$dir/updater.log")"
  w5_until 30 "the Update closed by the builder's claim on the pool's release" w5_closed $id "$order" || w5_fail $id "the Update did not close"
  # The edge keeps follow's answer thirty seconds: the updater sees the same Update again, and runs no second round for it.
  sleep 35
  [[ "$(grep -c "a round: " "$dir/updater.log")" == 2 ]] || w5_fail $id "one round for the release, one for the Update, and no other: $(grep 'a round' "$dir/updater.log")"
  kill -TERM "$(cat "$dir/updater.pid")" 2>/dev/null || true
  w5_revoke $id
  echo "H: the set's updater asked follow for $id, ran one round for its Update, and the Update closed on its claim of the pool's release"
}

# Every scenario's worker, its supervisor and its stub agent stopped, whatever became of the scenario: a failed one returns before its
# own w5_stop, and its loop would restart pkg-repo against a pool that is gone, its stub keeping its port for the next run.
w5_cleanup() {
  local id; for id in w5a w5a2 w5b w5c w5d w5e w5f w5g; do [[ -e "$W5/$id/pid" ]] && w5_stop "$id"; done
  # G's hung child, if the scenario failed before its stop killed it. Under the E2E's set -e, a kill that fails as the last command
  # of an && list ends the script: after a stop that worked, the child is gone and kill answers 1.
  if [[ -s "$W5/w5g/child" ]]; then kill "$(cat "$W5/w5g/child")" 2>/dev/null || true; fi
  # H's updater is gone already when H passed: a kill that finds nothing is not a failure (under set -e, the last command of an &&
  # list that fails ends the E2E, with nothing said).
  if [[ -e "$W5/w5h/updater.pid" ]]; then kill -TERM "$(cat "$W5/w5h/updater.pid")" 2>/dev/null || true; fi
  return 0
}

# All nine side by side; each one's result, then the record: every order of theirs has one issue line and one final line.
w5_scenarios() {
  mkdir -p "$W5"
  w5_seed_all
  local s pids=() names=() failed=0
  for s in a a2 b c d e f g h; do
    ( set -eo pipefail; "w5_scenario_$s" ) > "$W5/scenario-$s.out" 2>&1 &
    pids+=("$!"); names+=("$s")
  done
  local i; for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then cat "$W5/scenario-${names[$i]}.out"
    else failed=1; echo "scenario ${names[$i]} failed:" >&2; cat "$W5/scenario-${names[$i]}.out" >&2; fi
  done
  w5_cleanup
  (( failed == 0 )) || return 1
  local bad tries
  for tries in 1 2 3; do bad="$(w5_d1_json "SELECT o.id, o.state, (SELECT COUNT(*) FROM events e WHERE e.kind = 'order' AND json_extract(e.payload, '\$.order') = o.id) AS lines FROM worker_orders o WHERE o.worker_id LIKE 'w5%'" | jq -c '[.[] | select(.lines != 2)]')" && break; sleep 3; done
  [[ "$bad" == "[]" ]] || { echo "orders without exactly one issue line and one final line: $bad" >&2; return 1; }
  echo "orders: every scenario's order has its issue line and its final line"
}
