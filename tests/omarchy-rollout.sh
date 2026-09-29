#!/usr/bin/env bash
# omarchy-rollout (the updater role) and the Studio's factory/host/rollout.sh
# against a stubbed docker: a broker that changed is replaced first and
# waited for until it answers on :8790 inside its container — bounded, one
# bound for all the brokers together, with a warning and the rollout going
# on when one never does, and no wait at all for brokers compose could not
# start — before the services that call it (#273); those are replaced together in one `up`
# (each drains under its own grace; none idles refused while another
# drains), the updater replaces itself last through a detached one-off (a
# container cannot recreate itself from inside), only the images it
# replaced are removed, compose sees none of the container's own
# environment, --check changes nothing, and a directory without a compose
# file is refused.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/compose"
export STUB_LOG="$tmp/log" STUB_STATE="$tmp/state"
: > "$STUB_LOG"
# The state: one line per service — running image id, wanted image id.
cat > "$STUB_STATE" <<'S'
broker sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
worker sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
updater sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
S
touch "$tmp/compose/compose.yml"
# The stub carries its paths (the rollout runs compose with a scrubbed environment: no STUB_* reaches it).
cat > "$tmp/bin/docker" <<S
#!/usr/bin/env bash
STUB_LOG="$STUB_LOG"; STUB_STATE="$STUB_STATE"
S
cat >> "$tmp/bin/docker" <<'S'
# A docker that answers what omarchy-rollout asks, from STUB_STATE; every call is logged.
echo "docker $*" >> "$STUB_LOG"
# The container's own environment must not reach compose (it would be interpolated into the file).
[[ "$1" != compose || -z "${OMARCHY_WORKER_ROLE:-}${OMARCHY_WORK_DIR:-}" ]] || echo "ENVLEAK ${OMARCHY_WORKER_ROLE:-}${OMARCHY_WORK_DIR:-}" >> "$STUB_LOG"
running() { awk -v s="$1" '$1==s {print $2}' "$STUB_STATE"; }
wanted() { awk -v s="$1" '$1==s {print $3}' "$STUB_STATE"; }
case "$1" in
  info) exit 0 ;;
  compose)
    shift; [[ "$1" == --project-directory ]] && shift 2
    case "$1" in
      config)
        if [[ "${2:-}" == --services ]]; then awk '{print $1}' "$STUB_STATE"
        elif [[ "${2:-}" == --format ]]; then printf '{"services":{'; first=1; while read -r s _; do (( first )) || printf ','; first=0; role=worker; [[ "$s" == broker* || "$s" == agent-proxy ]] && role=broker; [[ "$s" == keyholder ]] && role=agent; printf '"%s":{"image":"img-%s","environment":{"OMARCHY_WORKER_ROLE":"%s"}}' "$s" "$s" "$role"; done < "$STUB_STATE"; printf '}}\n'
        elif [[ "${2:-}" == --hash ]]; then echo "$3 cfg-$3"; fi ;;
      pull) exit 0 ;;
      ps) echo "cid-$3" ;;
      up) shift; while [[ "$1" == -* ]]; do shift; done; for svc in "$@"; do [[ "$svc" == updater ]] && exit 137; grep -qx "$svc" "$STUB_STATE.upfail" 2>/dev/null && exit 1; awk -v s="$svc" '$1==s {$2=$3} {print}' "$STUB_STATE" > "$STUB_STATE.new" && mv "$STUB_STATE.new" "$STUB_STATE"; done ;;
      run) exit 0 ;;
    esac ;;
  image)
    if [[ "$2" == inspect ]]; then wanted "${5#img-}"; else exit 0; fi ;;
  inspect)
    cid="${@: -1}"; svc="${cid#cid-}"
    if [[ "$3" == "{{.Image}}" ]]; then running "$svc"; elif [[ "$svc" == worker && -f "$STUB_STATE.cfgold" ]]; then echo "cfg-old"; else echo "cfg-$svc"; fi ;;
  logs) echo "[12:00:00] task 42: felix for aarch64 (draft:https://x@1)" ;;
  # The broker's answer from inside its container: refused for its first STUB_STATE.late tries (default 1), never for one named in STUB_STATE.dead.
  exec)
    svc="${2#cid-}"; n=$(( $(cat "$STUB_STATE.tries-$svc" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_STATE.tries-$svc"
    grep -qx "$svc" "$STUB_STATE.dead" 2>/dev/null && exit 7
    (( n > $(cat "$STUB_STATE.late" 2>/dev/null || echo 1) )) || exit 7 ;;
  *) echo "unexpected docker $*" >&2; exit 9 ;;
esac
S
chmod +x "$tmp/bin/docker"
# rollout.sh asks getent whether the user is in the docker group without the shell carrying it: here, no.
printf '#!/bin/sh\nexit 2\n' > "$tmp/bin/getent"; chmod +x "$tmp/bin/getent"
# The wait's pauses are the stub's to skip: a try every 2 s, counted, not slept.
printf '#!/bin/sh\necho "sleep $*" >> "%s"\n' "$STUB_LOG" > "$tmp/bin/sleep"; chmod +x "$tmp/bin/sleep"
export PATH="$tmp/bin:$PATH" COMPOSE_DIR="$tmp/compose" OMARCHY_WORKER_ROLE=updater OMARCHY_WORK_DIR=/var/lib/omarchy-worker
R="$root/factory/bin/omarchy-rollout"

# --check: says what would change, changes nothing.
out="$("$R" --check)"
grep -q "broker: aaaaaaaaaaaa → bbbbbbbbbbbb" <<<"$out" || { echo "--check names the change: $out"; exit 1; }
grep -q "worker: .*(draining: task 42: felix for aarch64)" <<<"$out" || { echo "--check names the task a builder holds: $out"; exit 1; }
grep -qE "compose .* up " "$STUB_LOG" && { echo "--check must not replace anything: $(cat "$STUB_LOG")"; exit 1; }
[[ "$(awk '{print $2}' "$STUB_STATE" | sort -u)" == "sha256:aaaaaaaaaaaaaaaa" ]] || { echo "--check changed the state"; exit 1; }
grep -q ENVLEAK "$STUB_LOG" && { echo "the container's own environment reached compose: $(grep ENVLEAK "$STUB_LOG" | head -1)"; exit 1; }

# The run: the broker first, waited for until it answers inside its container (refused once, then up), then the
# worker in its own up (each drains under its own grace), the updater through a detached one-off, the old images removed.
: > "$STUB_LOG"
out="$("$R" --once)"
up_broker="$(grep -nE "compose .* up -d --no-deps --no-build broker$" "$STUB_LOG" | cut -d: -f1 || true)"
up_worker="$(grep -nE "compose .* up -d --no-deps --no-build worker$" "$STUB_LOG" | cut -d: -f1 || true)"
[[ -n "$up_broker" && -n "$up_worker" ]] || { echo "the broker in an up of its own, then the worker: $(grep ' up ' "$STUB_LOG")"; exit 1; }
[[ "$(grep -cE "^docker compose --project-directory [^ ]+ up -d " "$STUB_LOG")" == 2 ]] || { echo "two ups — the broker, then the rest — and none for the updater itself: $(grep ' up ' "$STUB_LOG")"; exit 1; }
tries="$(grep -nE "^docker exec cid-broker curl -s -o /dev/null --max-time 3 http://127.0.0.1:8790/$" "$STUB_LOG" | cut -d: -f1 | tr '\n' ' ' || true)"
[[ "$(wc -w <<<"$tries")" -eq 2 ]] || { echo "the broker is asked inside its container until it answers — refused once, then up: $(grep -E 'exec|sleep' "$STUB_LOG")"; exit 1; }
for n in $tries; do (( up_broker < n && n < up_worker )) || { echo "every try between the broker's up and the worker's: broker up at $up_broker, tries at $tries, worker up at $up_worker"; exit 1; }; done
[[ "$(grep -c '^sleep 2$' "$STUB_LOG")" == 1 ]] || { echo "a pause of 2 s between tries: $(grep sleep "$STUB_LOG")"; exit 1; }
grep -q "waiting for broker to answer on :8790 (at most 300 s in all) before the workers that call them are replaced" <<<"$out" || { echo "the wait is said, with its bound: $out"; exit 1; }
grep -q "broker: answering on :8790 after about 2 s" <<<"$out" || { echo "and its end: $out"; exit 1; }
grep -qE "compose .* run -d --rm --no-deps --entrypoint sh updater -c sleep 2; env -i .*docker compose --project-directory \"?$tmp/compose\"? up -d --no-deps --no-build updater" "$STUB_LOG" || { echo "the updater replaces itself through a detached one-off with a clean environment: $(grep ' run ' "$STUB_LOG")"; exit 1; }
grep -q "updater: replacing itself through a one-off" <<<"$out" || { echo "the updater says so: $out"; exit 1; }
[[ "$(awk '$1!="updater" {print $2}' "$STUB_STATE" | sort -u)" == "sha256:bbbbbbbbbbbbbbbb" ]] || { echo "broker and worker run the new image afterwards"; exit 1; }
[[ "$(grep -c "image rm sha256:aaaaaaaaaaaaaaaa" "$STUB_LOG")" == 3 ]] || { echo "only the images it replaced go, one rm each: $(grep 'image ' "$STUB_LOG")"; exit 1; }
grep -q "image prune" "$STUB_LOG" && { echo "no blanket prune of the machine's images"; exit 1; }
grep -q ENVLEAK "$STUB_LOG" && { echo "the container's own environment reached compose: $(grep ENVLEAK "$STUB_LOG" | head -1)"; exit 1; }

# Nothing changed (the updater's own image made current by hand): says so, replaces nothing.
sed -i.bak 's/^updater .*/updater sha256:bbbbbbbbbbbbbbbb sha256:bbbbbbbbbbbbbbbb/' "$STUB_STATE"
: > "$STUB_LOG"
out="$("$R")"
grep -q "nothing to roll out" <<<"$out" || { echo "a second run has nothing to do: $out"; exit 1; }
grep -qE " up -d | run -d " "$STUB_LOG" && { echo "nothing to replace, nothing replaced"; exit 1; }

# A broker that never answers: the wait is bounded (ROLLOUT_BROKER_WAIT), said as a warning, and the rollout goes on.
sed -i.bak -e 's/^broker .*/broker sha256:aaaaaaaaaaaaaaaa sha256:cccccccccccccccc/' -e 's/^worker .*/worker sha256:aaaaaaaaaaaaaaaa sha256:cccccccccccccccc/' "$STUB_STATE"
echo broker > "$STUB_STATE.dead"
: > "$STUB_LOG"
out="$(ROLLOUT_BROKER_WAIT=10 "$R")"
[[ "$(grep -c '^docker exec cid-broker ' "$STUB_LOG")" == 5 ]] || { echo "ten seconds is five tries, 2 s apart, no more: $(grep -cE '^docker exec' "$STUB_LOG")"; exit 1; }
grep -q "broker: WARNING — not answering on :8790 within the 10 s wait; replacing the workers anyway" <<<"$out" || { echo "a broker that never answers is said: $out"; exit 1; }
grep -qE " up -d --no-deps --no-build worker$" "$STUB_LOG" || { echo "and the rollout goes on to the worker: $(grep ' up ' "$STUB_LOG")"; exit 1; }
rm -f "$STUB_STATE.dead"

# A broker compose could not replace: said, not waited for (it would not answer), and the rollout goes on.
sed -i.bak -e 's/^broker .*/broker sha256:cccccccccccccccc sha256:dddddddddddddddd/' -e 's/^worker .*/worker sha256:cccccccccccccccc sha256:dddddddddddddddd/' "$STUB_STATE"
echo broker > "$STUB_STATE.upfail"
: > "$STUB_LOG"
out="$("$R")"
grep -q "FAILED to replace broker" <<<"$out" || { echo "a broker that did not start is said: $out"; exit 1; }
grep -qE '^docker exec |^sleep ' "$STUB_LOG" && { echo "and not waited for: $(grep -E 'exec|sleep' "$STUB_LOG")"; exit 1; }
grep -q "not waiting for broker: replacing the workers anyway" <<<"$out" || { echo "the skipped wait is said: $out"; exit 1; }
grep -qE " up -d --no-deps --no-build worker$" "$STUB_LOG" || { echo "and the rollout goes on to the worker: $(grep ' up ' "$STUB_LOG")"; exit 1; }
rm -f "$STUB_STATE.upfail"
sed -i.bak 's/^broker .*/broker sha256:dddddddddddddddd sha256:dddddddddddddddd/' "$STUB_STATE"

# A configuration change alone replaces the service too.
touch "$STUB_STATE.cfgold"
: > "$STUB_LOG"
out="$("$R")"
grep -q "worker: .*(configuration changed)" <<<"$out" || { echo "a changed configuration is a container to replace: $out"; exit 1; }
grep -qE " up -d --no-deps --no-build worker$" "$STUB_LOG" || { echo "and it is replaced: $(grep ' up ' "$STUB_LOG")"; exit 1; }
rm -f "$STUB_STATE.cfgold"

# No compose file: refused, with the reason.
rm "$tmp/compose/compose.yml"
if out="$("$R" 2>&1)"; then echo "a directory without a compose file must be refused: $out"; exit 1; fi
grep -q "no compose file" <<<"$out" || { echo "the reason: $out"; exit 1; }

# The Studio's rollout.sh (factory/host/, copied into POOL_ROOT by setup.sh), the same order: agent-proxy and
# the community broker in one up, each answering — the proxy late, after three refusals — before the review,
# community and pool workers are replaced together; a service with the agent role counts as a broker too.
mkdir -p "$tmp/host"; cp "$root/factory/host/rollout.sh" "$tmp/host/rollout.sh"; touch "$tmp/host/compose.yml"
cat > "$STUB_STATE" <<'S'
agent-proxy sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
broker-community-aarch64 sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
keyholder sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
community-aarch64 sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
review-aarch64 sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
pool-aarch64 sha256:aaaaaaaaaaaaaaaa sha256:bbbbbbbbbbbbbbbb
S
rm -f "$STUB_STATE".tries-*; echo 3 > "$STUB_STATE.late"
: > "$STUB_LOG"
out="$(env -u OMARCHY_WORKER_ROLE -u OMARCHY_WORK_DIR "$tmp/host/rollout.sh")"
ups="$(grep -nE '^docker compose up -d --no-deps --no-build ' "$STUB_LOG" || true)"
[[ "$(wc -l <<<"$ups" | tr -d ' ')" == 2 ]] || { echo "rollout.sh: two ups, the brokers and then the workers: $ups"; exit 1; }
grep -qE '^[0-9]+:docker compose up -d --no-deps --no-build agent-proxy broker-community-aarch64 keyholder$' <<<"$(head -1 <<<"$ups")" || { echo "rollout.sh: the brokers first, alone: $ups"; exit 1; }
grep -qE '^[0-9]+:docker compose up -d --no-deps --no-build community-aarch64 review-aarch64 pool-aarch64$' <<<"$(tail -1 <<<"$ups")" || { echo "rollout.sh: then the workers, together: $ups"; exit 1; }
first="$(head -1 <<<"$ups" | cut -d: -f1)"; second="$(tail -1 <<<"$ups" | cut -d: -f1)"
for svc in agent-proxy broker-community-aarch64 keyholder; do
  n="$(grep -nE "^docker exec cid-$svc curl -s -o /dev/null --max-time 3 http://127.0.0.1:8790/$" "$STUB_LOG" | cut -d: -f1 | tr '\n' ' ' || true)"
  [[ "$(wc -w <<<"$n")" -ge 1 ]] || { echo "rollout.sh: $svc is asked whether it answers: $(grep exec "$STUB_LOG")"; exit 1; }
  for i in $n; do (( first < i && i < second )) || { echo "rollout.sh: $svc asked between the two ups ($first, $second): $n"; exit 1; }; done
done
[[ "$(grep -c '^docker exec cid-agent-proxy ' "$STUB_LOG")" == 4 ]] || { echo "rollout.sh: agent-proxy refused three times, answering the fourth: $(grep -c 'exec cid-agent-proxy' "$STUB_LOG")"; exit 1; }
grep -q "agent-proxy: answering on :8790 after about 6 s" <<<"$out" || { echo "rollout.sh says when the proxy answered: $out"; exit 1; }
grep -q "waiting for agent-proxy broker-community-aarch64 keyholder to answer on :8790 (at most 300 s in all)" <<<"$out" || { echo "rollout.sh: the brokers waited for, a service with the agent role too, under one bound: $out"; exit 1; }
grep -qE "exec cid-(community|review|pool)-" "$STUB_LOG" && { echo "rollout.sh: a worker is not a broker: $(grep exec "$STUB_LOG")"; exit 1; }
[[ "$(awk '{print $2}' "$STUB_STATE" | sort -u)" == "sha256:bbbbbbbbbbbbbbbb" ]] || { echo "rollout.sh: everything runs the new image afterwards: $(cat "$STUB_STATE")"; exit 1; }
# A proxy and a keyholder that never answer: warned about within one ROLLOUT_BROKER_WAIT for all the brokers — not
# one each, one after another — and the workers are replaced anyway.
sed -i.bak 's/ sha256:bbbbbbbbbbbbbbbb$/ sha256:cccccccccccccccc/' "$STUB_STATE"; printf 'agent-proxy\nkeyholder\n' > "$STUB_STATE.dead"
: > "$STUB_LOG"
out="$(env -u OMARCHY_WORKER_ROLE -u OMARCHY_WORK_DIR ROLLOUT_BROKER_WAIT=6 "$tmp/host/rollout.sh")"
grep -q "agent-proxy: WARNING — not answering on :8790 within the 6 s wait; replacing the workers anyway" <<<"$out" || { echo "rollout.sh: a proxy that never answers is said: $out"; exit 1; }
grep -q "keyholder: WARNING — not answering on :8790 within the 6 s wait" <<<"$out" || { echo "rollout.sh: and the keyholder: $out"; exit 1; }
grep -q "broker-community-aarch64: answering on :8790" <<<"$out" || { echo "rollout.sh: the broker that answers is asked, the wait spent or not: $out"; exit 1; }
[[ "$(grep -c '^docker exec cid-agent-proxy ' "$STUB_LOG")" == 3 ]] || { echo "rollout.sh: six seconds is three tries: $(grep -c 'exec cid-agent-proxy' "$STUB_LOG")"; exit 1; }
[[ "$(grep -c '^docker exec cid-keyholder ' "$STUB_LOG")" == 1 ]] || { echo "rollout.sh: the wait spent, the keyholder is asked once: $(grep -c 'exec cid-keyholder' "$STUB_LOG")"; exit 1; }
[[ "$(grep -c '^sleep 2$' "$STUB_LOG")" == 2 ]] || { echo "rollout.sh: six seconds in all, not six per broker: $(grep -c '^sleep' "$STUB_LOG") pauses"; exit 1; }
grep -qE '^docker compose up -d --no-deps --no-build community-aarch64 review-aarch64 pool-aarch64$' "$STUB_LOG" || { echo "rollout.sh: and the workers are replaced anyway: $(grep ' up ' "$STUB_LOG")"; exit 1; }
rm -f "$STUB_STATE.dead"
# --check: says what would change, replaces and waits for nothing.
sed -i.bak -e 's/^\(agent-proxy .*\) sha256:c*$/\1 sha256:dddddddddddddddd/' -e 's/^\(review-aarch64 .*\) sha256:c*$/\1 sha256:dddddddddddddddd/' "$STUB_STATE"
: > "$STUB_LOG"
out="$(env -u OMARCHY_WORKER_ROLE -u OMARCHY_WORK_DIR "$tmp/host/rollout.sh" --check)"
grep -q "agent-proxy: cccccccccccc → dddddddddddd" <<<"$out" && grep -q "review-aarch64: cccccccccccc → dddddddddddd" <<<"$out" || { echo "rollout.sh --check names what would change: $out"; exit 1; }
grep -qE " up -d |^docker exec " "$STUB_LOG" && { echo "rollout.sh --check replaces and waits for nothing: $(cat "$STUB_LOG")"; exit 1; }
# Brokers compose could not replace: said, not waited for, and the workers replaced anyway.
sed -i.bak 's/ sha256:[0-9a-f]*$/ sha256:eeeeeeeeeeeeeeee/' "$STUB_STATE"; echo agent-proxy > "$STUB_STATE.upfail"
: > "$STUB_LOG"
out="$(env -u OMARCHY_WORKER_ROLE -u OMARCHY_WORK_DIR "$tmp/host/rollout.sh")"
grep -q "FAILED to replace agent-proxy broker-community-aarch64 keyholder" <<<"$out" || { echo "rollout.sh: a failed up of the brokers is said: $out"; exit 1; }
grep -qE '^docker exec |^sleep ' "$STUB_LOG" && { echo "rollout.sh: and not waited for: $(grep -E 'exec|sleep' "$STUB_LOG")"; exit 1; }
grep -qE '^docker compose up -d --no-deps --no-build community-aarch64 review-aarch64 pool-aarch64$' "$STUB_LOG" || { echo "rollout.sh: and the workers are replaced anyway: $(grep ' up ' "$STUB_LOG")"; exit 1; }
rm -f "$STUB_STATE.upfail"
echo "omarchy-rollout: ok"
