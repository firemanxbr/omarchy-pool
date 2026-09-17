#!/usr/bin/env bash
# omarchy-rollout (the updater role) against a stubbed docker: the services
# whose image changed are replaced together in one `up` (each drains under
# its own grace; none idles refused while another drains), the updater
# replaces itself last through a detached one-off (a container cannot
# recreate itself from inside), only the images it replaced are removed,
# compose sees none of the container's own environment, --check changes
# nothing, and a directory without a compose file is refused.
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
        elif [[ "${2:-}" == --format ]]; then printf '{"services":{'; first=1; while read -r s _; do (( first )) || printf ','; first=0; printf '"%s":{"image":"img-%s"}' "$s" "$s"; done < "$STUB_STATE"; printf '}}\n'
        elif [[ "${2:-}" == --hash ]]; then echo "$3 cfg-$3"; fi ;;
      pull) exit 0 ;;
      ps) echo "cid-$3" ;;
      up) shift; while [[ "$1" == -* ]]; do shift; done; for svc in "$@"; do [[ "$svc" == updater ]] && exit 137; awk -v s="$svc" '$1==s {$2=$3} {print}' "$STUB_STATE" > "$STUB_STATE.new" && mv "$STUB_STATE.new" "$STUB_STATE"; done ;;
      run) exit 0 ;;
    esac ;;
  image)
    if [[ "$2" == inspect ]]; then wanted "${5#img-}"; else exit 0; fi ;;
  inspect)
    cid="${@: -1}"; svc="${cid#cid-}"
    if [[ "$3" == "{{.Image}}" ]]; then running "$svc"; elif [[ "$svc" == worker && -f "$STUB_STATE.cfgold" ]]; then echo "cfg-old"; else echo "cfg-$svc"; fi ;;
  logs) echo "[12:00:00] task 42: felix for aarch64 (draft:https://x@1)" ;;
  *) echo "unexpected docker $*" >&2; exit 9 ;;
esac
S
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH" COMPOSE_DIR="$tmp/compose" OMARCHY_WORKER_ROLE=updater OMARCHY_WORK_DIR=/var/lib/omarchy-worker
R="$root/factory/bin/omarchy-rollout"

# --check: says what would change, changes nothing.
out="$("$R" --check)"
grep -q "broker: aaaaaaaaaaaa → bbbbbbbbbbbb" <<<"$out" || { echo "--check names the change: $out"; exit 1; }
grep -q "worker: .*(draining: task 42: felix for aarch64)" <<<"$out" || { echo "--check names the task a builder holds: $out"; exit 1; }
grep -qE "compose .* up " "$STUB_LOG" && { echo "--check must not replace anything: $(cat "$STUB_LOG")"; exit 1; }
[[ "$(awk '{print $2}' "$STUB_STATE" | sort -u)" == "sha256:aaaaaaaaaaaaaaaa" ]] || { echo "--check changed the state"; exit 1; }
grep -q ENVLEAK "$STUB_LOG" && { echo "the container's own environment reached compose: $(grep ENVLEAK "$STUB_LOG" | head -1)"; exit 1; }

# The run: broker and worker in ONE up (each drains under its own grace), the updater through a detached one-off, the old images removed.
: > "$STUB_LOG"
out="$("$R" --once)"
grep -qE "compose .* up -d --no-deps --no-build broker worker$" "$STUB_LOG" || { echo "the changed services are replaced together, in one up: $(grep ' up ' "$STUB_LOG")"; exit 1; }
[[ "$(grep -cE "^docker compose --project-directory [^ ]+ up -d " "$STUB_LOG")" == 1 ]] || { echo "one up for the services, none for the updater itself: $(grep ' up ' "$STUB_LOG")"; exit 1; }
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
echo "omarchy-rollout: ok"
