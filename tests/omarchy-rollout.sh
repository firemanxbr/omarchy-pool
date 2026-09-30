#!/usr/bin/env bash
# omarchy-rollout (the updater role: every contributor's set, and the
# Studio's since its one-time step) against a stubbed docker and a stubbed
# pool.
#
# #278's order: a broker that changed is replaced first and waited for
# until it answers on :8790 inside its container — bounded, one bound for
# all the brokers together, with a warning and the rollout going on when
# one never does, and no wait at all for brokers compose could not start —
# before the services that call it; those are replaced together in one
# `up` (each drains under its own grace; none idles refused while another
# drains); the updater replaces itself last through a detached one-off (a
# container cannot recreate itself from inside); only the images it
# replaced are removed; compose sees none of the container's own
# environment; --check changes nothing; a directory without a compose file
# is refused. The Studio's services the same way (agent-proxy, a community
# broker, a service with the agent role), now that its updater rolls it
# out.
#
# #277: the loop follows the pool (a round for a new release, a rollback,
# an Update not acted on yet; the pool's /version when follow is gone, a
# rollback past #277 among them; the fifteen-minute round without an
# answer; SIGUSR1 now), names its set's workers by id (a project worker's
# from its own file, a builder's from its broker, never from a builder's
# container); the lock (a round that holds it, one whose holder is gone,
# not running, started again or stuck past its expiry — broken by the id
# it was judged by, so two rounds that judged it dead never both hold it;
# released at the end of every round and before the self-replacing
# one-off, never another round's; an EXIT mid-round releases it); the
# guard (restarting at two samples in a row, restarts that grow, a service
# that stays down, a service not replaced, a new updater that fails its
# self-test — and a busy builder, which is none of those; an updater image
# from before #277, which has no self-test, adopted on the set's guard
# alone); --self-test.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
LOOP_PID=""
cleanup() { [[ -z "$LOOP_PID" ]] || kill "$LOOP_PID" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
mkdir -p "$tmp/bin" "$tmp/compose" "$tmp/run"
export STUB_LOG="$tmp/log" STUB_STATE="$tmp/state"
: > "$STUB_LOG"
# The state: one line per service — running image id, wanted image id.
cat > "$STUB_STATE" <<'S'
broker sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
worker sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
updater sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
S
touch "$tmp/compose/compose.yml"
# This process's own container, as its mounts and the engine say (the design's §1.14): the lock's holder.
SELF="$(printf 'c%.0s' $(seq 1 64))"
printf '812 800 0:52 /var/lib/docker/containers/%s/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw\n' "$SELF" > "$tmp/mountinfo"
export STUB_SELF="$SELF" STUB_SELF_STARTED="2026-09-30T13:40:00.000000000Z" OMARCHY_RUN_DIR="$tmp/run" ROLLOUT_MOUNTINFO="$tmp/mountinfo"
# The stub carries its paths (the rollout runs compose with a scrubbed environment: no STUB_* reaches it).
cat > "$tmp/bin/docker" <<S
#!/usr/bin/env bash
STUB_LOG="$STUB_LOG"; STUB_STATE="$STUB_STATE"; STUB_SELF="$STUB_SELF"; STUB_SELF_STARTED="$STUB_SELF_STARTED"; RUN_DIR="$tmp/run"
S
cat >> "$tmp/bin/docker" <<'S'
# A docker that answers what omarchy-rollout asks, from STUB_STATE; every call is logged.
echo "docker $*" >> "$STUB_LOG"
# The container's own environment must not reach compose (it would be interpolated into the file).
[[ "$1" != compose || -z "${OMARCHY_WORKER_ROLE:-}${OMARCHY_WORK_DIR:-}" ]] || echo "ENVLEAK ${OMARCHY_WORKER_ROLE:-}${OMARCHY_WORK_DIR:-}" >> "$STUB_LOG"
running() { awk -v s="$1" '$1==s {print $2}' "$STUB_STATE"; }
wanted() { awk -v s="$1" '$1==s {print $3}' "$STUB_STATE"; }
services() { awk '{print $1}' "$STUB_STATE"; }
role_of() { case "$1" in broker*|agent-proxy) echo broker ;; keyholder) echo agent ;; community-*) echo community ;; updater) echo updater ;; pool-*) echo pool ;; review-*) echo review ;; *) echo "" ;; esac; }
# A hook: once, what the file says, on the call it names (up, run).
hook() { [[ -f "$STUB_STATE.on-$1" ]] || return 0; local h; h="$(cat "$STUB_STATE.on-$1")"; rm -f "$STUB_STATE.on-$1"; eval "$h"; }
case "$1" in
  info) exit 0 ;;
  compose)
    shift; [[ "$1" == --project-directory ]] && shift 2
    case "$1" in
      config)
        if [[ "${2:-}" == --services ]]; then services
        elif [[ "${2:-}" == --format ]]; then printf '{"name":"proj","services":{'; first=1; while read -r s _; do (( first )) || printf ','; first=0; r="$(role_of "$s")"; printf '"%s":{"image":"img-%s","environment":{"OMARCHY_WORKER_ROLE":"%s"}}' "$s" "$s" "$r"; done < "$STUB_STATE"; printf '}}\n'
        elif [[ "${2:-}" == --hash ]]; then echo "$3 cfg-$3"
        elif [[ "${2:-}" == -q ]]; then exit 0; fi ;;
      pull) exit 0 ;;
      ps) echo "cid-$3" ;;
      up) hook up; shift; while [[ "$1" == -* ]]; do shift; done; for svc in "$@"; do [[ "$svc" == updater ]] && exit 137; grep -qx "$svc" "$STUB_STATE.upfail" 2>/dev/null && exit 1; awk -v s="$svc" '$1==s {$2=$3} {print}' "$STUB_STATE" > "$STUB_STATE.new" && mv "$STUB_STATE.new" "$STUB_STATE"; done ;;
      run)
        if [[ " $* " == *" --self-test "* ]]; then [[ -f "$STUB_STATE.selftest-fail" ]] && { echo "self-test: the runtime's socket does not answer"; exit 1; }; echo "self-test: the socket answers; compose reads /compose"; echo "follows 1"; exit 0; fi
        exit 0 ;;
    esac ;;
  image)
    # inspect -f {{.Id}} img-<service>: the id it names; inspect -f <the follows label> <id>: "1", "<no value>" for an image from before #277.
    if [[ "$2" == inspect && "$4" == *com.omarchy.updater.follows* ]]; then [[ -f "$STUB_STATE.nolabel" ]] && echo "<no value>" || echo 1
    elif [[ "$2" == inspect ]]; then wanted "${5#img-}"; else exit 0; fi ;;
  ps)
    # The project's containers: running ones (-q), or all of them (-aq); those in STUB_STATE.stopped are not running.
    for s in $(services); do if [[ "$2" == -aq ]] || ! grep -qx "$s" "$STUB_STATE.stopped" 2>/dev/null; then echo "cid-$s"; fi; done ;;
  create)
    # The lock: one container by name, atomic — a second create fails while it exists; each one created gets an id of its own.
    shift; name=""; by=""; holder=""; started=""; until=""; nonce=""
    while [[ $# -gt 0 ]]; do case "$1" in --name) name="$2"; shift 2 ;; --label) k="${2%%=*}"; v="${2#*=}"; case "$k" in *.by) by="$v" ;; *.holder) holder="$v" ;; *.started) started="$v" ;; *.until) until="$v" ;; *.nonce) nonce="$v" ;; esac; shift 2 ;; *) shift ;; esac; done
    [[ -f "$STUB_STATE.lock" ]] && { echo "Conflict. The container name \"/$name\" is already in use" >&2; exit 1; }
    printf '%s|%s|%s|%s|2026-09-30T13:47:05.000Z|%s|lock%s\n' "$by" "$holder" "$started" "$until" "$nonce" "$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')" > "$STUB_STATE.lock" ;;
  # rm -f <the lock's id, or its name>: only that container — an id another lock has since replaced removes nothing. A hook first.
  rm) hook rm; [[ -f "$STUB_STATE.lock" ]] || { echo "Error: No such container: $3" >&2; exit 1; }
    IFS='|' read -r _ _ _ _ _ _ lid < "$STUB_STATE.lock"
    [[ "$3" == "$lid" || "$3" == proj-rollout-lock ]] || { echo "Error: No such container: $3" >&2; exit 1; }
    rm -f "$STUB_STATE.lock" ;;
  inspect)
    t="$3"; cid="${@: -1}"; svc="${cid#cid-}"
    case "$t" in
      *com.omarchy.lock.by*) [[ -f "$STUB_STATE.lock" ]] || exit 1; IFS='|' read -r by holder started until created nonce lid < "$STUB_STATE.lock"; echo "$by|$holder|$started|$until|$created|$lid" ;;
      *com.omarchy.lock.nonce*) [[ -f "$STUB_STATE.lock" ]] || exit 1; IFS='|' read -r by holder started until created nonce lid < "$STUB_STATE.lock"; echo "$holder|$started|$nonce|$lid" ;;
      "{{.State.Running}} {{.State.StartedAt}}") line="$(awk -v c="$cid" '$1==c {print $2, $3}' "$STUB_STATE.holders" 2>/dev/null)"; [[ -n "$line" ]] || { echo "Error: No such object: $cid" >&2; exit 1; }; echo "$line" ;;
      "{{.Id}}") echo "$cid" ;;
      "{{.State.StartedAt}}") [[ "$cid" == "$STUB_SELF" ]] && echo "$STUB_SELF_STARTED" ;;
      "{{.Image}}") if [[ "$cid" == "$STUB_SELF" ]]; then echo sha256:self; else running "$svc"; fi ;;
      *com.docker.compose.config-hash*) if [[ "$svc" == worker && -f "$STUB_STATE.cfgold" ]]; then echo "cfg-old"; else echo "cfg-$svc"; fi ;;
      *"com.docker.compose.service\"}} {{.Image}}"*) echo "$svc $(running "$svc") False" ;;
      *com.docker.compose.service*) echo "$svc" ;;
      *OMARCHY_WORKER_ROLE*) r="$(role_of "$svc")"; [[ -n "$r" ]] && echo "OMARCHY_WORKER_ROLE=$r" ;;
      *OMARCHY_BROKER*) [[ "$svc" == worker ]] && echo set ;;
      "{{.State.Status}} {{.RestartCount}} {{.State.ExitCode}}")
        # A sequence per service, one line a call, the last one again and again.
        f="$STUB_STATE.status-$svc"; [[ -f "$f" ]] || { echo "running 0 0"; exit 0; }
        n=$(( $(cat "$f.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f.n"
        line="$(sed -n "${n}p" "$f")"; [[ -n "$line" ]] || line="$(tail -n1 "$f")"; echo "$line" ;;
      *) echo "unexpected inspect $*" >&2; exit 9 ;;
    esac ;;
  logs) echo "[12:00:00] task 42: felix for aarch64 (draft:https://x@1)" ;;
  exec)
    cid="$2"; svc="${cid#cid-}"; shift 2
    case "$*" in
      "cat $RUN_DIR/instance") [[ "$cid" == "$STUB_SELF" ]] && cat "$RUN_DIR/instance" || exit 1 ;;
      "cat /run/omarchy/worker-id") if [[ -f "$STUB_STATE.wid-$svc" ]]; then cat "$STUB_STATE.wid-$svc"; else echo "w-$svc"; fi ;;
      *"/pool/factory/workers/self") printf '{"id":"w-%s","trust":"community"}\n' "$svc" ;;
      # The broker's answer from inside its container: refused for its first STUB_STATE.late tries (default 1), never for one named in STUB_STATE.dead.
      *"http://127.0.0.1:8790/")
        n=$(( $(cat "$STUB_STATE.tries-$svc" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_STATE.tries-$svc"
        grep -qx "$svc" "$STUB_STATE.dead" 2>/dev/null && exit 7
        (( n > $(cat "$STUB_STATE.late" 2>/dev/null || echo 1) )) || exit 7 ;;
      *) echo "unexpected exec $*" >&2; exit 9 ;;
    esac ;;
  *) echo "unexpected docker $*" >&2; exit 9 ;;
esac
S
chmod +x "$tmp/bin/docker"
# The pool's follow: what STUB_STATE.follow says, a 404 when it says 404, nothing when it is not there.
cat > "$tmp/bin/curl" <<S
#!/usr/bin/env bash
STUB_LOG="$STUB_LOG"; STUB_STATE="$STUB_STATE"
S
cat >> "$tmp/bin/curl" <<'S'
url="${@: -1}"; echo "curl $url" >> "$STUB_LOG"
# /api/v1/version: what STUB_STATE.version says, nothing when it is not there.
if [[ "$url" == */api/v1/version ]]; then [[ -f "$STUB_STATE.version" ]] || exit 7; cat "$STUB_STATE.version"; exit 0; fi
[[ -f "$STUB_STATE.follow" ]] || exit 7
[[ "$(cat "$STUB_STATE.follow")" == 404 ]] && exit 22
cat "$STUB_STATE.follow"
S
chmod +x "$tmp/bin/curl"
# The pauses are the stub's to count, not to sleep: a try every 2 s, a guard's sample every 5 — but the loop's own poll (STUB_POLL) sleeps a little, for real.
cat > "$tmp/bin/sleep" <<S
#!/usr/bin/env bash
echo "sleep \$*" >> "$STUB_LOG"
[[ "\$1" == "\${STUB_POLL:-none}" ]] && exec /bin/sleep "\${STUB_POLL_REAL:-0.2}"
exit 0
S
chmod +x "$tmp/bin/sleep"
export PATH="$tmp/bin:$PATH" COMPOSE_DIR="$tmp/compose" OMARCHY_WORKER_ROLE=updater OMARCHY_WORK_DIR=/var/lib/omarchy-worker OMARCHY_API=http://pool.test OMARCHY_IMAGE=v1.0.2
# The guard, quick: two samples, five seconds apart (stubbed).
export ROLLOUT_GUARD_SECONDS=10 ROLLOUT_GUARD_EVERY=5
R="$root/factory/bin/omarchy-rollout"
fail() { echo "FAIL: $*" >&2; echo "--- log ---" >&2; tail -n 60 "$STUB_LOG" >&2; exit 1; }
reset_lock() { rm -f "$STUB_STATE.lock" "$STUB_STATE.holders" "$STUB_STATE".status-* "$STUB_STATE.stopped" "$STUB_STATE.selftest-fail" "$STUB_STATE".on-*; }

# ------------------------------------------------------------- #278's order --
# --check: says what would change, changes nothing, takes no lock.
out="$("$R" --check)"
grep -q "broker: aaaaaaaaaaaa → bbbbbbbbbbbb" <<<"$out" || fail "--check names the change: $out"
grep -q "worker: .*(draining: task 42: felix for aarch64)" <<<"$out" || fail "--check names the task a builder holds: $out"
grep -qE "compose .* up |^docker create " "$STUB_LOG" && fail "--check must not replace anything, nor take the lock"
[[ "$(awk '{print $2}' "$STUB_STATE" | sort -u)" == "sha256:aaaaaaaaaaaaaaaa" ]] || fail "--check changed the state"
grep -q ENVLEAK "$STUB_LOG" && fail "the container's own environment reached compose: $(grep ENVLEAK "$STUB_LOG" | head -1)"

# The run: the broker first, waited for until it answers inside its container (refused once, then up), then the
# worker in its own up (each drains under its own grace), the updater through a detached one-off, the old images removed.
: > "$STUB_LOG"
out="$("$R" --once)"
up_broker="$(grep -nE "compose .* up -d --no-deps --no-build broker$" "$STUB_LOG" | cut -d: -f1 || true)"
up_worker="$(grep -nE "compose .* up -d --no-deps --no-build worker$" "$STUB_LOG" | cut -d: -f1 || true)"
[[ -n "$up_broker" && -n "$up_worker" ]] || fail "the broker in an up of its own, then the worker: $(grep ' up ' "$STUB_LOG")"
[[ "$(grep -cE "^docker compose --project-directory [^ ]+ up -d " "$STUB_LOG")" == 2 ]] || fail "two ups — the broker, then the rest — and none for the updater itself: $(grep ' up ' "$STUB_LOG")"
tries="$(grep -nE "^docker exec cid-broker curl -s -o /dev/null --max-time 3 http://127.0.0.1:8790/$" "$STUB_LOG" | cut -d: -f1 | tr '\n' ' ' || true)"
[[ "$(wc -w <<<"$tries")" -eq 2 ]] || fail "the broker is asked inside its container until it answers — refused once, then up: $(grep -E 'exec|sleep' "$STUB_LOG")"
for n in $tries; do (( up_broker < n && n < up_worker )) || fail "every try between the broker's up and the worker's: broker up at $up_broker, tries at $tries, worker up at $up_worker"; done
[[ "$(grep -c '^sleep 2$' "$STUB_LOG")" == 1 ]] || fail "a pause of 2 s between tries: $(grep sleep "$STUB_LOG")"
grep -q "waiting for broker to answer on :8790 (at most 300 s in all) before the workers that call them are replaced" <<<"$out" || fail "the wait is said, with its bound: $out"
grep -q "broker: answering on :8790 after about 2 s" <<<"$out" || fail "and its end: $out"
grep -qE "compose .* run -d --rm --no-deps --entrypoint sh updater -c sleep 2; env -i .*docker compose --project-directory \"?$tmp/compose\"? up -d --no-deps --no-build updater" "$STUB_LOG" || fail "the updater replaces itself through a detached one-off with a clean environment: $(grep ' run ' "$STUB_LOG")"
grep -q "updater: replacing itself through a one-off" <<<"$out" || fail "the updater says so: $out"
[[ "$(awk '$1!="updater" {print $2}' "$STUB_STATE" | sort -u)" == "sha256:bbbbbbbbbbbbbbbb" ]] || fail "broker and worker run the new image afterwards"
[[ "$(grep -c "image rm sha256:aaaaaaaaaaaaaaaa" "$STUB_LOG")" == 3 ]] || fail "only the images it replaced go, one rm each: $(grep 'image ' "$STUB_LOG")"
grep -q "image prune" "$STUB_LOG" && fail "no blanket prune of the machine's images"
grep -q ENVLEAK "$STUB_LOG" && fail "the container's own environment reached compose: $(grep ENVLEAK "$STUB_LOG" | head -1)"
# #277: the round held the lock, named its holder — this container, verified — and released it before the one-off.
create="$(grep -n '^docker create --name proj-rollout-lock ' "$STUB_LOG" || true)"
[[ -n "$create" ]] || fail "a round takes the lock: $(grep create "$STUB_LOG")"
grep -q -- "--label com.omarchy.lock.by=once --label com.omarchy.lock.holder=$SELF --label com.omarchy.lock.started=$STUB_SELF_STARTED" <<<"$create" || fail "the lock names its holder and when it started: $create"
rm_at="$(grep -nE '^docker rm -f lock[0-9a-f]+$' "$STUB_LOG" | cut -d: -f1 | tail -1)"; run_at="$(grep -n ' run -d --rm ' "$STUB_LOG" | cut -d: -f1)"
[[ -n "$rm_at" && -n "$run_at" ]] && (( rm_at < run_at )) || fail "the lock is released before the one-off that replaces the updater: rm at ${rm_at:-never}, run at ${run_at:-never}"
[[ ! -f "$STUB_STATE.lock" ]] || fail "no lock is left after the round"
# The guard ran before it: the new updater's self-test, and the samples, before any image went.
st_at="$(grep -n ' run --rm --no-deps -T --entrypoint /usr/local/lib/omarchy-factory/bin/omarchy-rollout updater --self-test' "$STUB_LOG" | cut -d: -f1)"
img_at="$(grep -n 'image rm ' "$STUB_LOG" | head -1 | cut -d: -f1)"
[[ -n "$st_at" && -n "$img_at" ]] && (( st_at < img_at )) || fail "the new image's updater passes its self-test before an old image goes: self-test at ${st_at:-never}, rm at ${img_at:-never}"
[[ "$(grep -c '^sleep 5$' "$STUB_LOG")" == 2 ]] || fail "the guard samples every ROLLOUT_GUARD_EVERY for ROLLOUT_GUARD_SECONDS: $(grep -c '^sleep 5$' "$STUB_LOG")"

# Nothing changed (the updater's own image made current by hand): says so, replaces nothing.
sed -i.bak 's/^updater .*/updater sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb/' "$STUB_STATE"
: > "$STUB_LOG"
out="$("$R")"
grep -q "nothing to roll out" <<<"$out" || fail "a second run has nothing to do: $out"
grep -qE " up -d | run -d |^sleep 5" "$STUB_LOG" && fail "nothing to replace, nothing replaced, nothing guarded"
[[ ! -f "$STUB_STATE.lock" ]] || fail "a round with nothing to do releases its lock too"

# A broker that never answers: the wait is bounded (ROLLOUT_BROKER_WAIT), said as a warning, and the rollout goes on.
sed -i.bak -e 's/^broker .*/broker sha256:aaaaaaaaaaaaaaaa sha256:cccccccccccccccc/' -e 's/^worker .*/worker sha256:aaaaaaaaaaaaaaaa sha256:cccccccccccccccc/' "$STUB_STATE"
echo broker > "$STUB_STATE.dead"
: > "$STUB_LOG"
out="$(ROLLOUT_BROKER_WAIT=10 "$R")"
[[ "$(grep -c '^docker exec cid-broker ' "$STUB_LOG")" == 5 ]] || fail "ten seconds is five tries, 2 s apart, no more: $(grep -cE '^docker exec' "$STUB_LOG")"
grep -q "broker: WARNING — not answering on :8790 within the 10 s wait; replacing the workers anyway" <<<"$out" || fail "a broker that never answers is said: $out"
grep -qE " up -d --no-deps --no-build worker$" "$STUB_LOG" || fail "and the rollout goes on to the worker: $(grep ' up ' "$STUB_LOG")"
rm -f "$STUB_STATE.dead"

# A broker compose could not replace: said, not waited for (it would not answer), and the rollout goes on.
sed -i.bak -e 's/^broker .*/broker sha256:cccccccccccccccc sha256:dddddddddddddddd/' -e 's/^worker .*/worker sha256:cccccccccccccccc sha256:dddddddddddddddd/' "$STUB_STATE"
echo broker > "$STUB_STATE.upfail"
: > "$STUB_LOG"
out="$("$R")"
grep -q "FAILED to replace broker" <<<"$out" || fail "a broker that did not start is said: $out"
grep -qE '^docker exec cid-broker curl -s -o|^sleep 2' "$STUB_LOG" && fail "and not waited for: $(grep -E 'exec|sleep' "$STUB_LOG")"
grep -q "not waiting for broker: replacing the workers anyway" <<<"$out" || fail "the skipped wait is said: $out"
grep -qE " up -d --no-deps --no-build worker$" "$STUB_LOG" || fail "and the rollout goes on to the worker: $(grep ' up ' "$STUB_LOG")"
# #277: a round that failed to replace something keeps the old images (a rollback reaches the set with no download).
grep -q "the new image does not stay up here (broker not replaced this round)" <<<"$out" || fail "the guard names what this round could not replace: $out"
grep -q 'image rm' "$STUB_LOG" && fail "the old images stay when the guard fails: $(grep 'image rm' "$STUB_LOG")"
rm -f "$STUB_STATE.upfail"
sed -i.bak 's/^broker .*/broker sha256:dddddddddddddddd sha256:dddddddddddddddd/' "$STUB_STATE"

# A configuration change alone replaces the service too.
touch "$STUB_STATE.cfgold"
: > "$STUB_LOG"
out="$("$R")"
grep -q "worker: .*(configuration changed)" <<<"$out" || fail "a changed configuration is a container to replace: $out"
grep -qE " up -d --no-deps --no-build worker$" "$STUB_LOG" || fail "and it is replaced: $(grep ' up ' "$STUB_LOG")"
rm -f "$STUB_STATE.cfgold"

# No compose file: refused, with the reason.
rm "$tmp/compose/compose.yml"
if out="$("$R" 2>&1)"; then fail "a directory without a compose file must be refused: $out"; fi
grep -q "no compose file" <<<"$out" || fail "the reason: $out"
touch "$tmp/compose/compose.yml"
echo "ok: #278's order"

# The Studio's services the same way, now that its updater rolls it out: agent-proxy and the community broker in one up, each
# answering — the proxy late, after three refusals — before the review, community and pool workers are replaced together; a
# service with the agent role counts as a broker too.
cat > "$STUB_STATE" <<'S'
agent-proxy sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
broker-community-aarch64 sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
keyholder sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
community-aarch64 sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
review-aarch64 sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
pool-aarch64 sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
updater sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb
S
rm -f "$STUB_STATE".tries-*; echo 3 > "$STUB_STATE.late"
: > "$STUB_LOG"
out="$("$R")"
ups="$(grep -nE '^docker compose --project-directory [^ ]+ up -d --no-deps --no-build ' "$STUB_LOG" || true)"
[[ "$(wc -l <<<"$ups" | tr -d ' ')" == 2 ]] || fail "the Studio: two ups, the brokers and then the workers: $ups"
grep -qE 'up -d --no-deps --no-build agent-proxy broker-community-aarch64 keyholder$' <<<"$(head -1 <<<"$ups")" || fail "the Studio: the brokers first, alone: $ups"
grep -qE 'up -d --no-deps --no-build community-aarch64 review-aarch64 pool-aarch64$' <<<"$(tail -1 <<<"$ups")" || fail "the Studio: then the workers, together: $ups"
first="$(head -1 <<<"$ups" | cut -d: -f1)"; second="$(tail -1 <<<"$ups" | cut -d: -f1)"
for svc in agent-proxy broker-community-aarch64 keyholder; do
  n="$(grep -nE "^docker exec cid-$svc curl -s -o /dev/null --max-time 3 http://127.0.0.1:8790/$" "$STUB_LOG" | cut -d: -f1 | tr '\n' ' ' || true)"
  [[ "$(wc -w <<<"$n")" -ge 1 ]] || fail "the Studio: $svc is asked whether it answers"
  for i in $n; do (( first < i && i < second )) || fail "the Studio: $svc asked between the two ups ($first, $second): $n"; done
done
[[ "$(grep -c '^docker exec cid-agent-proxy curl -s -o' "$STUB_LOG")" == 4 ]] || fail "the Studio: agent-proxy refused three times, answering the fourth"
grep -q "agent-proxy: answering on :8790 after about 6 s" <<<"$out" || fail "the Studio: says when the proxy answered: $out"
grep -q "waiting for agent-proxy broker-community-aarch64 keyholder to answer on :8790 (at most 300 s in all)" <<<"$out" || fail "the Studio: the brokers waited for under one bound: $out"
grep -qE "exec cid-(community|review|pool)-.* curl" "$STUB_LOG" && fail "the Studio: a worker is not a broker"
# Its builder (the community role) is not watched by the guard; its project workers are. Nothing is read of a builder's container.
grep -qE "^docker exec cid-community" "$STUB_LOG" && fail "nothing is read of a builder's container: $(grep 'exec cid-community' "$STUB_LOG")"
grep -q "docker inspect -f {{.State.Status}} {{.RestartCount}} {{.State.ExitCode}} cid-community-aarch64" "$STUB_LOG" && fail "a builder is not sampled: it exits after every task"
grep -q "docker inspect -f {{.State.Status}} {{.RestartCount}} {{.State.ExitCode}} cid-review-aarch64" "$STUB_LOG" || fail "a project worker is sampled"
# Brokers that never answer: warned about within one ROLLOUT_BROKER_WAIT for all of them, and the workers replaced anyway.
sed -i.bak '/^updater/!s/ sha256:bbbbbbbbbbbbbbbb$/ sha256:cccccccccccccccc/' "$STUB_STATE"; printf 'agent-proxy\nkeyholder\n' > "$STUB_STATE.dead"
: > "$STUB_LOG"
out="$(ROLLOUT_BROKER_WAIT=6 "$R")"
grep -q "agent-proxy: WARNING — not answering on :8790 within the 6 s wait; replacing the workers anyway" <<<"$out" || fail "the Studio: a proxy that never answers is said: $out"
grep -q "keyholder: WARNING — not answering on :8790 within the 6 s wait" <<<"$out" || fail "the Studio: and the keyholder: $out"
[[ "$(grep -c '^sleep 2$' "$STUB_LOG")" == 2 ]] || fail "the Studio: six seconds in all, not six per broker: $(grep -c '^sleep 2$' "$STUB_LOG") pauses"
grep -qE 'up -d --no-deps --no-build community-aarch64 review-aarch64 pool-aarch64$' "$STUB_LOG" || fail "the Studio: and the workers are replaced anyway"
rm -f "$STUB_STATE.dead" "$STUB_STATE.late"
echo "ok: the Studio's services"

# -------------------------------------------------------------------- lock --
cat > "$STUB_STATE" <<'S'
broker sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
worker sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb
project sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
updater sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb
S
changed() { sed -i.bak -e 's/^broker .*/broker sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb/' -e 's/^project .*/project sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb/' "$STUB_STATE"; }
future=$(( $(date +%s) + 3600 )); past=$(( $(date +%s) - 60 ))
lock_held() { # by holder started until
  printf '%s|%s|%s|%s|2026-09-30T13:47:05.000Z|n0|lockheld0\n' "$1" "$2" "$3" "$4" > "$STUB_STATE.lock"
}
# A round runs already in the loop, its holder alive and the lock before its expiry: --once skips, and says so.
reset_lock; changed
lock_held loop cid-updater 2026-09-30T13:40:00Z "$future"; echo "cid-updater true 2026-09-30T13:40:00Z" > "$STUB_STATE.holders"
: > "$STUB_LOG"
out="$("$R" --once)" || fail "a skipped round is no failure: $out"
grep -q "a round runs already in the updater (loop, since 13:47)" <<<"$out" || fail "--once says a round runs already: $out"
grep -q " up -d " "$STUB_LOG" && fail "a skipped round replaces nothing"
[[ -f "$STUB_STATE.lock" ]] || fail "and leaves the other round's lock"
# Its holder is gone, not running, or started again since: broken at once, with the line, whatever its expiry — then the round runs.
for holders in "" "cid-updater false 2026-09-30T13:40:00Z" "cid-updater true 2026-09-30T14:02:00Z"; do
  reset_lock; changed
  lock_held once cid-updater 2026-09-30T13:40:00Z "$future"; [[ -n "$holders" ]] && echo "$holders" > "$STUB_STATE.holders"
  : > "$STUB_LOG"
  out="$("$R" --once)"
  grep -q "a lock held by cid-updater (once, since 13:47), which is not running any more: broken" <<<"$out" || fail "a dead holder's lock is broken (${holders:-gone}): $out"
  grep -q " up -d --no-deps --no-build broker$" "$STUB_LOG" || fail "and the round runs (${holders:-gone})"
  [[ ! -f "$STUB_STATE.lock" ]] || fail "and releases the lock it took (${holders:-gone})"
done
# Two rounds that both judged the same dead lock: the other broke it and took the lock between this round's read and its removal.
# This round removes the lock it judged by its id — gone already, so nothing — and the create decides: it skips, and the other
# round's lock stays. (Removed by name, it would remove the other's fresh lock and take one too: two rounds holding the lock.)
reset_lock; changed
lock_held once cid-updater 2026-09-30T13:40:00Z "$future"
echo "printf '%s\n' 'loop|cid-other|2026-09-30T14:00:00Z|$future|2026-09-30T14:00:01.000Z|n9|lockother9' > \"\$STUB_STATE.lock\"; echo 'cid-other true 2026-09-30T14:00:00Z' > \"\$STUB_STATE.holders\"" > "$STUB_STATE.on-rm"
: > "$STUB_LOG"
out="$("$R" --once)" || fail "a round that lost the lock is no failure: $out"
grep -q " up -d " "$STUB_LOG" && fail "two rounds hold the lock: the one that lost the race replaced services too: $(grep ' up ' "$STUB_LOG")"
[[ "$(cut -d'|' -f7 "$STUB_STATE.lock")" == lockother9 ]] || fail "the other round's lock stays: $(cat "$STUB_STATE.lock")"
grep -q "another round took the lock first; skipping" <<<"$out" || fail "the round that lost says so: $out"
grep -q "^docker rm -f lockheld0$" "$STUB_LOG" && ! grep -q "^docker rm -f proj-rollout-lock$" "$STUB_LOG" || fail "the dead lock is removed by the id it was judged by, never by its name: $(grep '^docker rm' "$STUB_LOG")"
# Its holder alive, past its expiry: stuck — broken, with the line.
reset_lock; changed
lock_held loop cid-updater 2026-09-30T13:40:00Z "$past"; echo "cid-updater true 2026-09-30T13:40:00Z" > "$STUB_STATE.holders"
out="$("$R" --once)"
grep -q "a lock from 13:47 outlived its 4 h: broken" <<<"$out" || fail "a lock past its expiry is broken: $out"
# No holder named: before its expiry it is kept, after it broken.
reset_lock; changed
lock_held once "" "" "$future"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q "a round runs already (once, since 13:47; its holder named no container" <<<"$out" && ! grep -q " up -d " "$STUB_LOG" || fail "a lock with no holder is kept until its expiry: $out"
reset_lock; changed
lock_held once "" "" "$past"
out="$("$R" --once)"
grep -q "a lock from 13:47 outlived its 4 h: broken" <<<"$out" || fail "and broken after it: $out"
# A release never removes a lock that is not its own: another round broke this one's and took it meanwhile.
reset_lock; changed
echo "printf '%s\n' 'loop|cid-other|2026-09-30T14:00:00Z|$future|2026-09-30T14:00:01.000Z|n9|lockother9' > \"\$STUB_STATE.lock\"" > "$STUB_STATE.on-up"
: > "$STUB_LOG"
out="$("$R" --once)"
grep -q "the lock proj-rollout-lock is another round's now; leaving it" <<<"$out" || fail "a lock another round took is not released: $out"
[[ "$(cut -d'|' -f2 "$STUB_STATE.lock")" == cid-other ]] || fail "the other round's lock stays"
# An EXIT during a round (a stop of the updater mid-round) releases the lock it holds.
reset_lock; changed
echo 'kill -TERM $PPID' > "$STUB_STATE.on-up"
set +e; "$R" --once > "$tmp/out" 2>&1; rc=$?; set -e
(( rc == 143 )) || fail "the stop ends the round: exit $rc: $(cat "$tmp/out")"
[[ ! -f "$STUB_STATE.lock" ]] || fail "an EXIT mid-round releases the lock: $(cat "$STUB_STATE.lock")"
echo "ok: the lock"

# ------------------------------------------------------------------- guard --
guarded() { # → the round's output; STUB_LOG holds its calls
  reset_lock; changed; : > "$STUB_LOG"
  "$R" --once
}
# A service replaced this round, restarting at two samples in a row: no self-replacement, the old images kept.
sed -i.bak 's/^updater .*/updater sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb/' "$STUB_STATE"
reset_lock; changed
printf 'running 0 0\nrestarting 1 1\nrestarting 3 1\n' > "$STUB_STATE.status-project"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q "the new image does not stay up here (project restarting): staying on v1.0.2 and keeping the old images, so a rollback reaches this set" <<<"$out" || fail "restarting at two samples fails the guard: $out"
grep -qE ' run -d |image rm' "$STUB_LOG" && fail "no self-replacement and no old image removed when the guard fails: $(grep -E 'run -d|image rm' "$STUB_LOG")"
[[ ! -f "$STUB_STATE.lock" ]] || fail "the lock is released after a failed guard too"
# At one sample only (a restart order's exit 75): passes.
reset_lock; changed
printf 'running 0 0\nrestarting 1 75\nrunning 1 0\n' > "$STUB_STATE.status-project"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q "updater: replacing itself through a one-off" <<<"$out" || fail "one restart is ordinary: $out"
# A service this round did not replace, on the new image already, whose restarts grow by three: fails.
sed -i.bak 's/^updater .*/updater sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb/' "$STUB_STATE"
reset_lock; changed; sed -i.bak 's/^project .*/project sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb/' "$STUB_STATE"
printf 'running 0 0\nrunning 2 0\nrunning 3 0\n' > "$STUB_STATE.status-project"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q " up -d --no-deps --no-build project" "$STUB_LOG" && fail "project was not to be replaced this round"
grep -q "does not stay up here (project restarted 3 times in 10 s)" <<<"$out" || fail "a service already on the new image that keeps restarting fails the guard: $out"
# A busy builder — the contributor's worker (OMARCHY_BROKER) — restarting at every sample, its restarts up by four, exits 0 and 1:
# the guard passes, reading its role and OMARCHY_BROKER with a template that prints them alone, never through exec.
reset_lock; changed
printf 'running 0 0\nrestarting 2 1\nrestarting 4 0\n' > "$STUB_STATE.status-worker"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q "updater: replacing itself through a one-off" <<<"$out" || fail "a busy builder is no crash loop: $out"
grep -q 'docker inspect -f {{range .Config.Env}}{{if eq (index (split . "=") 0) "OMARCHY_BROKER"}}set{{end}}{{end}} cid-worker' "$STUB_LOG" || fail "a builder is known by OMARCHY_BROKER, through the one-variable template"
grep -qE '^docker exec cid-worker|^docker inspect cid-worker$' "$STUB_LOG" && fail "nothing is read of a builder's container but that"
# A container that was running and ends exited non-zero: fails; one a person stopped before the round: ignored.
reset_lock; changed
printf 'running 0 0\nrunning 0 0\nexited 0 1\n' > "$STUB_STATE.status-project"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q "does not stay up here (project exited with 1 and stays down)" <<<"$out" || fail "a service that stays down fails the guard: $out"
reset_lock; changed
printf 'exited 0 0\n' > "$STUB_STATE.status-project"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q "updater: replacing itself through a one-off" <<<"$out" || fail "a service stopped before the round is not the image's fault: $out"
# The new image's own updater failing its self-test: no self-replacement, the old images kept.
reset_lock; changed; touch "$STUB_STATE.selftest-fail"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q "does not stay up here (its updater fails its self-test: self-test: the runtime's socket does not answer)" <<<"$out" || fail "a new updater that fails its self-test is not adopted: $out"
grep -qE ' run -d |image rm' "$STUB_LOG" && fail "no self-replacement and no image removed"
rm -f "$STUB_STATE.selftest-fail"
# The image its service now names is from before #277 (a rollback past it: no com.omarchy.updater.follows label, and an updater
# that answers --self-test with its usage): adopted on the guard of the set alone, said, and the old images go — never a rollback
# the set refuses, round after round, with a self-test the older updater cannot run.
reset_lock; changed; touch "$STUB_STATE.nolabel" "$STUB_STATE.selftest-fail"
sed -i.bak 's/^updater .*/updater sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb/' "$STUB_STATE"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q "updater: the image it now names (bbbbbbbbbbbb) is from before #277 — no --self-test to run: adopted on the guard alone" <<<"$out" || fail "an updater from before #277 is adopted on the guard alone: $out"
grep -q -- "--self-test" "$STUB_LOG" && fail "and no self-test is asked of it: $(grep -- --self-test "$STUB_LOG")"
grep -q "updater: replacing itself through a one-off" <<<"$out" && grep -q 'image rm sha256:aaaaaaaaaaaaaaaa' "$STUB_LOG" || fail "it replaces itself, and the old images go: $out"
# But the guard of the set still holds it back: an older image under which a service keeps restarting is not adopted either.
reset_lock; changed; touch "$STUB_STATE.nolabel"
sed -i.bak 's/^updater .*/updater sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb/' "$STUB_STATE"
printf 'running 0 0\nrestarting 1 1\nrestarting 3 1\n' > "$STUB_STATE.status-project"; : > "$STUB_LOG"
out="$("$R" --once)"
grep -q "does not stay up here (project restarting)" <<<"$out" && ! grep -qE ' run -d |image rm' "$STUB_LOG" || fail "the set's guard holds for an older image too: $out"
rm -f "$STUB_STATE.nolabel" "$STUB_STATE.selftest-fail"
echo "ok: the guard"

# --self-test: the socket answers, compose reads the project, and it follows.
out="$("$R" --self-test)"
[[ "$(tail -n1 <<<"$out")" == "follows 1" ]] || fail "--self-test says it follows: $out"

# ---------------------------------------------------------------- the loop --
# The loop's poll sleeps a little for real (STUB_POLL); everything else is counted.
reset_lock
cat > "$STUB_STATE" <<'S'
broker sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb
worker sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb
project sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb
community-aarch64 sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb
updater sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb
S
UPD="wo_$(printf 'a%.0s' $(seq 1 32))"
follow() { # latest [update-for-w-project]
  jq -cn --arg l "$1" --arg u "${2:-}" '{latest:$l, deployed_at:"2026-09-30T14:02:11Z", workers:[{id:"w-broker",version:$l,outdated:false,update:null},{id:"w-project",version:"v1.0.2",outdated:true,update:(if $u == "" then null else $u end)}]}' > "$STUB_STATE.follow"
}
rounds() { grep -c "a round: " "$tmp/loop.out" || true; }
until_rounds() { # n — up to 10 s
  local i; for i in $(seq 1 50); do (( $(rounds) >= $1 )) && return 0; /bin/sleep 0.2; done
  fail "waited for $1 round(s), saw $(rounds): $(cat "$tmp/loop.out")"
}
start_loop() { STUB_POLL="$ROLLOUT_POLL" "$R" --loop > "$tmp/loop.out" 2>&1 & LOOP_PID=$!; }
stop_loop() { kill -TERM "$LOOP_PID" 2>/dev/null || true; wait "$LOOP_PID" 2>/dev/null || true; LOOP_PID=""; }

follow v1.0.3
: > "$STUB_LOG"
export ROLLOUT_POLL=1 ROLLOUT_EVERY=3600
start_loop
until_rounds 1
grep -q "a round: the pool's release is v1.0.3" "$tmp/loop.out" || fail "a new release is a round: $(cat "$tmp/loop.out")"
/bin/sleep 1.5
(( $(rounds) == 1 )) || fail "the same release again is no round until ROLLOUT_EVERY: $(cat "$tmp/loop.out")"
# The ids: a builder's through its broker, a project worker's through its own file — cached per container, follow asked with ids only.
grep -q '^curl http://pool.test/api/v1/factory/follow?ids=w-broker,w-project$' "$STUB_LOG" || fail "follow is asked with the set's ids, sorted: $(grep curl "$STUB_LOG" | sort -u)"
[[ "$(grep -c '^docker exec cid-broker curl -s --max-time 5 http://127.0.0.1:8790/pool/factory/workers/self$' "$STUB_LOG")" == 1 ]] || fail "a builder's id is asked of its broker, once: $(grep -c 'workers/self' "$STUB_LOG")"
[[ "$(grep -c '^docker exec cid-project cat /run/omarchy/worker-id$' "$STUB_LOG")" == 1 ]] || fail "a project worker's id is read from its file, once"
grep -qE '^docker exec cid-(worker|community-aarch64)' "$STUB_LOG" && fail "nothing is read of a builder's container: $(grep -E 'exec cid-(worker|community)' "$STUB_LOG")"
# An open Update for one of its workers: one round, and not a second for the same order.
follow v1.0.3 "$UPD"
until_rounds 2
grep -q "a round: Update $UPD for w-project" "$tmp/loop.out" || fail "an Update is a round: $(cat "$tmp/loop.out")"
/bin/sleep 1.5
(( $(rounds) == 2 )) || fail "the same Update is one round: $(cat "$tmp/loop.out")"
# The two rounds in a row each took the lock: the first released it at its end.
grep -q "a round runs already" "$tmp/loop.out" && fail "a round's own next round is never skipped: $(cat "$tmp/loop.out")"
# A rollback: a lower release, one round.
follow v1.0.2 "$UPD"
until_rounds 3
grep -q "a round: the pool's release is v1.0.2 (was v1.0.3)" "$tmp/loop.out" || fail "a rollback is a round: $(cat "$tmp/loop.out")"
# The pool answering 404 (a Worker from before #277), garbage or nothing, and no /version either: no round until ROLLOUT_EVERY.
for answer in 404 "not json" ""; do
  if [[ -n "$answer" ]]; then printf '%s' "$answer" > "$STUB_STATE.follow"; else rm -f "$STUB_STATE.follow"; fi
  /bin/sleep 1.2
  (( $(rounds) == 3 )) || fail "a pool that says ${answer:-nothing} starts no round before ROLLOUT_EVERY: $(cat "$tmp/loop.out")"
done
# A rollback past #277: follow is gone (404), and the older Worker's /version says its release. The same release, no round; a
# lower one, a round at the next poll — not at the fifteen-minute round.
echo 404 > "$STUB_STATE.follow"; echo '{"version":"v1.0.2","commit":"abc"}' > "$STUB_STATE.version"; : > "$STUB_LOG"
/bin/sleep 1.2
grep -q '^curl http://pool.test/api/v1/version$' "$STUB_LOG" || fail "without follow, the pool's /version is asked: $(grep curl "$STUB_LOG" | sort -u)"
(( $(rounds) == 3 )) || fail "the release /version says is the one the last round ran for: no round: $(cat "$tmp/loop.out")"
echo '{"version":"v1.0.1","commit":"def"}' > "$STUB_STATE.version"
until_rounds 4
grep -q "a round: the pool's release is v1.0.1 (was v1.0.2)" "$tmp/loop.out" || fail "a rollback past #277 is a round within one poll: $(cat "$tmp/loop.out")"
rm -f "$STUB_STATE.version"
stop_loop
[[ ! -f "$STUB_STATE.lock" ]] || fail "a stopped loop leaves no lock"
# A malformed id file is skipped: the set's other ids are asked.
echo 'bad id!' > "$STUB_STATE.wid-project"; follow v1.0.3; : > "$STUB_LOG"
start_loop; until_rounds 1; stop_loop
grep -q '^curl http://pool.test/api/v1/factory/follow?ids=w-broker$' "$STUB_LOG" || fail "a malformed id is left out: $(grep curl "$STUB_LOG" | sort -u)"
rm -f "$STUB_STATE.wid-project"
# Without an answer, the fifteen-minute round (here two seconds): rounds come, each saying why.
rm -f "$STUB_STATE.follow"
ROLLOUT_EVERY=2 start_loop
until_rounds 2
grep -c "a round: every 2 s: the pool did not answer follow" "$tmp/loop.out" | grep -qE '^[2-9]' || fail "without an answer, a round every ROLLOUT_EVERY: $(cat "$tmp/loop.out")"
stop_loop
# SIGUSR1 during the poll's sleep: a round within 2 s.
follow v1.0.3
export ROLLOUT_POLL=30 STUB_POLL_REAL=30
start_loop; until_rounds 1; /bin/sleep 0.5
kill -USR1 "$LOOP_PID"
until_rounds 2
grep -q "a round: woken (rollout.sh, omarchy-worker update)" "$tmp/loop.out" || fail "a kick is a round: $(cat "$tmp/loop.out")"
stop_loop
# SIGUSR1 during a round: one more round after it.
export ROLLOUT_POLL=1 STUB_POLL_REAL=0.2
sed -i.bak 's/^project .*/project sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb/' "$STUB_STATE"
echo 'kill -USR1 $PPID' > "$STUB_STATE.on-up"
start_loop; until_rounds 2; stop_loop
[[ "$(grep -m2 "a round: " "$tmp/loop.out" | tail -1)" == *"a round: woken"* ]] || fail "a kick mid-round is one more round after it: $(cat "$tmp/loop.out")"
echo "ok: the loop follows the pool"
echo "omarchy-rollout: ok"
