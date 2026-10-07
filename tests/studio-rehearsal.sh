#!/usr/bin/env bash
# The Studio's dress rehearsal tool (factory/host/studio-rehearsal.sh, #319,
# #345), on a real engine — docker with its compose plugin, CI's runner:
#
#   - stand-in lays out a copy of the Studio's legacy compose project from
#     factory/host/compose.yml in a directory of its own and starts it as the
#     Studio runs it (COMPOSE_PROFILES=emulated): every service of the profile
#     up, each a busybox sleeper — none runs the worker image, so a
#     placeholder token never reaches the pool —, every env file the compose
#     file names a placeholder (agent.env without GITHUB_TOKEN), the review2
#     pair named and not started, the directory itself and the engine's
#     socket bind-mounted as on the Studio, the release's rollout.sh beside
#     it; it refuses a directory holding a compose file it did not lay out,
#     and — in a directory of its own, before it writes anything — a project
#     that runs from elsewhere;
#   - ids and compare: the same ids after a restart of a container, and an id
#     gone and a new one named after a recreation;
#   - check, with a host root of the test's own (OMARCHY_REHEARSAL_FS) and a
#     stand-in GitHub: a work root or a secrets directory under the bind-mounted
#     directory refused, as install's preflight refuses it; task subnets on a
#     legacy network refused; linger, binfmt and the task firewall each a
#     person's step until they are there; the legacy directory writable by
#     its group a person's step (retire-legacy's marker), and so its
#     rollout.sh without the marker's guard; a GITHUB_TOKEN with a scope, or
#     one GitHub names no scopes for, refused, one with none taken — curl
#     given the header from a file, never the token in its arguments (a curl
#     first on PATH keeps every argument list it is given);
#   - remove takes the stand-in away and nothing else: another compose
#     project beside it runs on.
#
# Run it under the engine lock where the daemon is shared:
#   flock /tmp/omarchy-engine.lock bash tests/studio-rehearsal.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tool="$here/../factory/host/studio-rehearsal.sh"
# shellcheck source=/dev/null
source "$here/images.env"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null; then echo "needs docker with its compose plugin"; exit 1; fi
command -v jq >/dev/null || { echo "needs jq"; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/studio-rehearsal.XXXXXX")"
dir="$work/omarchy-pool"
project="omarchy-rehearsal-$$"
other="omarchy-rehearsal-other-$$"
stub_pid=""
cleanup() {
  if [[ -n "$stub_pid" ]]; then kill "$stub_pid" 2>/dev/null || true; fi
  for p in "$project" "$other"; do
    ids="$(docker ps -aq --filter "label=com.docker.compose.project=$p")"
    # shellcheck disable=SC2086
    [[ -z "$ids" ]] || docker rm -f $ids >/dev/null 2>&1 || true
    nets="$(docker network ls -q --filter "label=com.docker.compose.project=$p")"
    # shellcheck disable=SC2086
    [[ -z "$nets" ]] || docker network rm $nets >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

install -d -m 0755 "$dir"

# ---------------------------------------------------------------- stand-in
printf 'services: {}\n' >"$dir/compose.yml"
if out="$("$tool" stand-in --dir "$dir" --project "$project" 2>&1)"; then fail "stand-in over a compose file it did not lay out: $out"; fi
[[ "$out" == *"did not lay out: never over a real set"* ]] || fail "its refusal: $out"
rm "$dir/compose.yml"
ok "stand-in refuses a directory holding a compose file it did not lay out"

"$tool" stand-in --dir "$dir" --project "$project" >/dev/null
want="$(cd "$dir" && docker compose config --services | sort)"
running="$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Label "com.docker.compose.service"}}' | sort)"
[[ "$running" == "$want" ]] || fail "every service of the profile up: want $(echo "$want" | tr '\n' ' '), runs $(echo "$running" | tr '\n' ' ')"
[[ "$(echo "$running" | wc -l)" -eq 10 ]] || fail "the Studio's ten under COMPOSE_PROFILES=emulated: $(echo "$running" | tr '\n' ' ')"
for s in pool-x86_64 pool-aarch64 review-aarch64 review-x86_64 agent-proxy broker-community-aarch64 community-aarch64 broker-community-x86_64 community-x86_64 updater; do
  grep -qx "$s" <<<"$running" || fail "$s runs"
done
! grep -q review2 <<<"$running" || fail "the review2 pair is behind its own profile: not started"
for id in $(docker ps -q --filter "label=com.docker.compose.project=$project"); do
  image="$(docker inspect --format '{{.Config.Image}}' "$id")"
  [[ "$image" == "$BUSYBOX" ]] || fail "every service a busybox sleeper, none the worker image: $image"
done
for f in "$dir"/etc/*.env; do
  [[ "$(stat -c %a "$f")" == 600 ]] || fail "$f is 0600"
  case "$f" in
    */agent.env) if ! grep -qx 'ANTHROPIC_API_KEY=placeholder-not-a-key' "$f" || grep -q GITHUB_TOKEN "$f"; then fail "agent.env: a placeholder key, no GITHUB_TOKEN: $(cat "$f")"; fi ;;
    *) grep -qx 'OMARCHY_WORKER_TOKEN=omw_placeholder_[a-z0-9_]*' "$f" || fail "$f: a placeholder token: $(cat "$f")" ;;
  esac
done
[[ -f "$dir/etc/review2-aarch64.env" ]] || fail "the review2 pair's env files are there: compose loads them all"
pool="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=pool-aarch64")"
mounts="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}} {{end}}{{end}}' "$pool")"
[[ " $mounts " == *" $dir "* && " $mounts " == *" /var/run/docker.sock "* ]] || fail "a project worker mounts the directory itself and the engine's socket, as on the Studio: $mounts"
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$pool")" == "$dir" ]] || fail "compose's working directory is the stand-in's"
[[ "$(stat -c %u "$dir/cache/pacman/x86_64")" == "$(id -u)" ]] || fail "the bind mounts' sources made as this login, not the engine's root"
if ! cmp -s "$dir/rollout.sh" "$here/../factory/host/rollout.sh" || [[ ! -x "$dir/rollout.sh" ]]; then fail "the release's rollout.sh beside it, as setup.sh installs it"; fi
ok "stand-in runs the Studio's ten services as sleepers, placeholders in every env file, its mounts as on the Studio"

# Another compose project beside it: never one remove or ids touches.
mkdir -p "$work/other"
printf 'services:\n  x:\n    image: %s\n    command: ["sleep", "3600"]\n' "$BUSYBOX" >"$work/other/compose.yml"
(cd "$work/other" && docker compose -p "$other" up -d --quiet-pull >/dev/null 2>&1)
# In a directory of its own, empty: the refusal is the running project's, not the compose file's, and comes before anything is written.
install -d -m 0755 "$work/elsewhere"
if out="$("$tool" stand-in --dir "$work/elsewhere" --project "$other" 2>&1)"; then fail "stand-in where the project runs from elsewhere: $out"; fi
[[ "$out" == *"the compose project $other runs already, from elsewhere: give another --project"* ]] || fail "its refusal: $out"
[[ -z "$(ls -A "$work/elsewhere")" ]] || fail "nothing written before the refusal: $(ls -A "$work/elsewhere")"
ok "stand-in refuses a project that runs from elsewhere, writing nothing"

# ---------------------------------------------------------- ids and compare
"$tool" ids --project "$project" >"$work/before"
[[ "$(grep -c '^container ' "$work/before")" -eq 10 && "$(grep -c '^network ' "$work/before")" -ge 4 ]] || fail "ids: ten containers and the project's networks: $(cat "$work/before")"
! grep -q "$other" "$work/before" || fail "ids names only its project"
docker restart -t 1 "$pool" >/dev/null
"$tool" compare "$work/before" --project "$project" >/dev/null || fail "a restart keeps every id"
(cd "$dir" && docker compose up -d --force-recreate --no-deps pool-aarch64 >/dev/null 2>&1)
if out="$("$tool" compare "$work/before" --project "$project")"; then fail "a recreated container is a new id: $out"; fi
[[ "$out" == *"gone: container $pool"* && "$out" == *"new:  container "* ]] || fail "compare names the gone and the new: $out"
ok "ids and compare: the same after a restart, the gone and the new named after a recreation"

# ------------------------------------------------------------------- check
fs="$work/fs"
mkdir -p "$fs/proc/sys/fs/binfmt_misc" "$fs/var/lib/systemd/linger" "$fs/usr/local/libexec" "$fs/etc/systemd/system/multi-user.target.wants"
foreign=x86_64; [[ "$(uname -m)" == x86_64 ]] && foreign=aarch64
# A curl first on PATH that keeps every argument list it is given, then runs the real one: what any process could read of it (ps).
real_curl="$(command -v curl)"
mkdir -p "$work/shim"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s"\nexec "%s" "$@"\n' "$work/curl-argv" "$real_curl" >"$work/shim/curl"
chmod 0755 "$work/shim/curl"
check() { PATH="$work/shim:$PATH" OMARCHY_REHEARSAL_FS="$fs" OMARCHY_REHEARSAL_GITHUB="http://127.0.0.1:$port" "$tool" check --project "$project" "$@"; }
# A stand-in GitHub: the scopes header as the token file says, and every request's command line kept, to see the token in none.
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
cat >"$work/github.py" <<'PY'
import http.server, sys
answers = {"tok_none": "", "tok_repo": "repo, workflow"}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        token = (self.headers.get("authorization") or "").removeprefix("token ")
        self.send_response(200 if token != "tok_bad" else 401)
        if token in answers:
            self.send_header("X-OAuth-Scopes", answers[token])
        self.end_headers()
    def log_message(self, *a):
        pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
python3 -I "$work/github.py" "$port" &
stub_pid=$!
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$port/" -o /dev/null && break; sleep 0.1; done

if out="$(check --work-root "$dir/host" --secrets-dir "$dir/host-secrets" --task-subnets 10.232.0.0/16)"; then fail "a work root under the bind-mounted directory: $out"; fi
grep -q "refused  the work root $dir/host overlaps $dir, which the legacy project bind-mounts" <<<"$out" || fail "the work root refused: $out"
grep -q "refused  the secrets directory $dir/host-secrets overlaps $dir" <<<"$out" || fail "the secrets directory refused: $out"
set +e; check --work-root "$dir/host" --task-subnets 10.232.0.0/16 >/dev/null; rc=$?; set -e
[[ $rc -eq 2 ]] || fail "refused is exit 2: $rc"
ok "check refuses a work root and a secrets directory under the directory the legacy project mounts (the design's /srv/omarchy-pool/host)"

net="$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "${project}_review")"
if out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets "$net")"; then fail "task subnets on a legacy network: $out"; fi
grep -q "refused  the task subnets $net overlap the legacy project's network $net" <<<"$out" || fail "the task subnets refused: $out"
ok "check refuses task subnets on a legacy network"

set +e; out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets 10.232.0.0/16)"; rc=$?; set -e
[[ $rc -eq 1 ]] || fail "linger, binfmt and the firewall are a person's steps (exit 1): $rc: $out"
for want in "person   binfmt: qemu-$foreign is not enabled with the F flag" "person   linger: off for $(id -un)" "person   task firewall: no drop for 10.232.0.0/16 — sudo factory/host/prep-root.sh --user $(id -un) --work-root $work/omarchy-host --task-subnets 10.232.0.0/16" "ok       the work root $work/omarchy-host is outside every path the legacy project mounts" "ok       legacy directory $dir: $(id -un)'s, mode 755"; do
  grep -qF "$want" <<<"$out" || fail "check says \"$want\": $out"
done
printf 'enabled\ninterpreter /usr/bin/qemu-%s-static\nflags: POCF\n' "$foreign" >"$fs/proc/sys/fs/binfmt_misc/qemu-$foreign"
touch "$fs/var/lib/systemd/linger/$(id -un)"
printf '#!/bin/sh\niptables -A OMARCHY-TASKS-HOST -s 10.232.0.0/16 -j DROP\n' >"$fs/usr/local/libexec/omarchy-task-firewall"
touch "$fs/etc/systemd/system/multi-user.target.wants/omarchy-task-firewall.service"
out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets 10.232.0.0/16)" || fail "all there, all ok: $out"
[[ "$(tail -n 1 <<<"$out")" == "all ok" ]] || fail "all ok: $out"
# A second task subnet the firewall does not drop yet.
set +e; out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets 10.232.0.0/16,10.233.0.0/16)"; rc=$?; set -e
[[ $rc -eq 1 && "$out" == *"no drop for 10.233.0.0/16"* ]] || fail "each task subnet dropped: $out"
rm "$fs/etc/systemd/system/multi-user.target.wants/omarchy-task-firewall.service"
set +e; out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets 10.232.0.0/16)"; rc=$?; set -e
[[ $rc -eq 1 && "$out" == *"task firewall: its unit is not enabled"* ]] || fail "the unit enabled for the next boot: $out"
touch "$fs/etc/systemd/system/multi-user.target.wants/omarchy-task-firewall.service"
ok "check: linger, binfmt with the F flag and the task firewall a person's steps until they are there"

chmod 0775 "$dir"
set +e; out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets 10.232.0.0/16)"; rc=$?; set -e
[[ $rc -eq 1 && "$out" == *"retire-legacy writes its .omarchy-agent marker there only when $(id -un) owns it and nobody else may write it: sudo chown $(id -un) $dir && sudo chmod go-w $dir"* ]] || fail "a legacy directory its group may write: $out"
chmod 0755 "$dir"
ok "check: a legacy directory others may write is a person's step, for retire-legacy's marker"

grep -qF "ok       legacy directory $dir: its rollout.sh has the guard for retire-legacy's .omarchy-agent marker" <<<"$out" || fail "the stand-in's rollout.sh has the guard: $out"
cp "$dir/rollout.sh" "$work/rollout.sh.release"
printf '#!/usr/bin/env bash\n# a copy from before #313\ndocker compose up -d updater\n' >"$dir/rollout.sh"
set +e; out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets 10.232.0.0/16)"; rc=$?; set -e
[[ $rc -eq 1 && "$out" == *"person   legacy directory $dir: its rollout.sh has no guard for retire-legacy's .omarchy-agent marker — paste the runbook's *Once: the updater* block now"* ]] || fail "a rollout.sh without the marker's guard: $out"
rm "$dir/rollout.sh"
out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets 10.232.0.0/16)" || fail "no rollout.sh is fine: $out"
grep -qF "ok       legacy directory $dir: no rollout.sh to bring its updater back" <<<"$out" || fail "it says there is none: $out"
install -m 0755 "$work/rollout.sh.release" "$dir/rollout.sh"
ok "check: a rollout.sh without the marker's guard is a person's step, before the last visit ends"

env_file="$work/agent.env"
for case in "tok_none:0:its GITHUB_TOKEN is a classic token with no scope" "tok_repo:2:carries the scopes repo, workflow" "tok_fine:2:GitHub names no scopes for its GITHUB_TOKEN (a fine-grained or app token)" "tok_bad:2:GitHub answers 401"; do
  IFS=: read -r token code words <<<"$case"
  printf 'ANTHROPIC_API_KEY=placeholder\nGITHUB_TOKEN=%s\n' "$token" >"$env_file"
  # The token in no process's arguments while check asks GitHub: curl reads the header from a file (-H @file), as its arguments say.
  : >"$work/curl-argv"
  set +e; out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets 10.232.0.0/16 --agent-env-from "$env_file")"; rc=$?; set -e
  [[ $rc -eq $code && "$out" == *"$words"* ]] || fail "GITHUB_TOKEN $token: exit $code saying \"$words\": $rc: $out"
  grep -q -- "-H @" "$work/curl-argv" || fail "curl asked GitHub with the header from a file: $(cat "$work/curl-argv")"
  ! grep -qF -- "$token" "$work/curl-argv" || fail "the token was in curl's arguments: $(cat "$work/curl-argv")"
  [[ "$out" != *"$token"* ]] || fail "the token is never printed: $out"
done
printf 'ANTHROPIC_API_KEY=placeholder\n' >"$env_file"
out="$(check --work-root "$work/omarchy-host" --secrets-dir "$work/host-secrets" --task-subnets 10.232.0.0/16 --agent-env-from "$env_file")" || fail "no GITHUB_TOKEN is fine: $out"
grep -q "no GITHUB_TOKEN" <<<"$out" || fail "it says there is none: $out"
ok "check: a GITHUB_TOKEN as install takes it — a classic one with no scope, never one with a scope or none named — never printed"

# ------------------------------------------------------------------ remove
if out="$("$tool" remove --dir "$work/other" --project "$other" 2>&1)"; then fail "remove of a project it did not lay out: $out"; fi
"$tool" remove --dir "$dir" --project "$project" >/dev/null
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] || fail "remove takes its containers"
[[ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ]] || fail "remove takes its networks"
[[ -z "$(ls -A "$dir")" ]] || fail "remove takes its files: $(ls -A "$dir")"
[[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$other")" ]] || fail "the other project runs on"
ok "remove takes the stand-in away and nothing else"
echo "studio-rehearsal: the stand-in, ids, compare, check and remove as the runbook uses them"
