#!/usr/bin/env bash
# A plain build on a remapped daemon (#405, design v2 §19.1): a docker engine with
# "userns-remap": "default" (CI merges it into the runner's daemon.json and restarts docker,
# which makes `dockremap` and its subordinate range itself; by hand, any engine whose
# `docker info` says `name=userns`), and `pkg-repo dispatch` run the way the host set runs
# it there — root in the init user namespace (the agent's overlay gives it
# `userns_mode: host`) with docker's default capabilities — while every task container and
# sidecar stays remapped, its root the first uid of dockremap's range on the host:
#
#   0. the engine: the remapped root B:G, read from a container's uid_map and gid_map,
#      is not 0 (DockerRootDir's B.G and /etc/subuid's dockremap line said beside it);
#   1. the agent: its capacity probe says `isolation: "subuid"` — what install records as
#      `envelope.userns_remap` — and `omarchy-agent dispatcher-env --write` renders
#      `OMARCHY_AGENT_HELD=userns-remap` (#406) and no `OMARCHY_AGENT_USER` from that
#      envelope; the dispatcher's environment is that file and the token's own file;
#   2. a community build through the dispatcher, whose stub build script repeats the real
#      script's ownership steps one for one (its log and verdict as task_mode writes them,
#      the builder given /build/cache, its package's cache, /build/pkg and /build/out, the
#      package built as the builder, pacman's download directory given to its
#      DownloadUser): its container's root is B (uid_map inside, no UsernsMode, no User),
#      what it writes in its package's build cache is the builder's B+uid on the host, and it
#      is built, uploaded and completed with its job token, its containers and network gone;
#   3. the model kinds held: the dispatcher says so at start, every claim's `agent` says
#      why, a draft leased anyway is handed back `lost` before anything of it runs, and no
#      probe, agent sidecar or mount of agent.env is ever made;
#   4. nothing else moves: the dispatcher's real-engine tests on this engine (a task
#      network with no gateway; the probe's keys test takes its remapped branch).
#
# Every container it starts is labelled with this run's own host id and removed at the end;
# the dispatcher runs as root, so the work root it made goes with sudo.
#
# Requires: docker with userns-remap, root or passwordless sudo, setpriv (util-linux),
# python3, jq, cargo (or AGENT=<a built omarchy-agent> and PKG_REPO=<a built pkg-repo>).
#   WORKER_IMAGE  a worker image for the egress sidecars (default: a busybox stand-in built here)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
RT=docker
# shellcheck source=tests/images.env
source "$here/images.env"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
host="h_remap-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
stub="" built=""
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo -n "$@"; fi; }
cleanup() {
  [[ ! -s "$tmp/dispatcher.pid" ]] || as_root kill -9 "$(cat "$tmp/dispatcher.pid")" 2>/dev/null || true
  [[ -z "$stub" ]] || kill "$stub" 2>/dev/null || true
  local c
  for c in $("$RT" ps -aq --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" rm -f "$c" >/dev/null 2>&1 || true; done
  for c in $("$RT" network ls -q --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" network rm "$c" >/dev/null 2>&1 || true; done
  [[ -z "$built" ]] || "$RT" rmi "$built" >/dev/null 2>&1 || true
  # The work root is the dispatcher's (root), and what the tasks wrote there is B's.
  as_root rm -rf "$tmp" 2>/dev/null || rm -rf "$tmp" 2>/dev/null || true
}
trap cleanup EXIT
fail() {
  echo "userns-remap: FAIL — $*" >&2
  [[ -f "$tmp/dispatcher.log" ]] && tail -n 40 "$tmp/dispatcher.log" >&2
  "$RT" ps -a --filter "label=org.omarchy-pool.agent.host=$host" --format '{{.Names}} {{.Status}}' >&2 2>/dev/null || true
  local f
  for f in $(as_root find "$tmp/work/tasks" -name task.log 2>/dev/null); do echo "== $f" >&2; as_root tail -n 40 "$f" >&2 || true; done
  exit 1
}

# ---------- 0. the engine ----------
if ! "$RT" info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q 'name=userns'; then
  [[ -n "${CI:-}" ]] && fail "this daemon does not remap users (CI merges \"userns-remap\": \"default\" into daemon.json before this script)"
  echo "skipped: this daemon does not remap users (\"userns-remap\" in daemon.json, or point DOCKER_HOST at one that does)"
  exit 0
fi
if [[ $EUID -ne 0 ]] && ! sudo -n true 2>/dev/null; then
  [[ -n "${CI:-}" ]] && fail "the dispatcher runs as root here, as the host set runs it: CI needs root or passwordless sudo"
  echo "skipped: the dispatcher runs as root here, as the host set runs it (root or passwordless sudo)"
  exit 0
fi
command -v setpriv >/dev/null || fail "no setpriv (util-linux): the dispatcher runs with docker's default capabilities only"
native="$(uname -m)"; [[ "$native" == arm64 ]] && native=aarch64
case "$native" in
  x86_64) arch_image="$ARCHLINUX_BASE" ;;
  aarch64) arch_image="$ARCHLINUXARM_BASE" ;;
  *) fail "this machine is $native" ;;
esac
# A remapped daemon keeps images of its own (under DockerRootDir/B.G): pulled here, after its restart.
"$RT" image inspect "$BUSYBOX" >/dev/null 2>&1 || "$RT" pull -q "$BUSYBOX" >/dev/null
"$RT" image inspect "$arch_image" >/dev/null 2>&1 || "$RT" pull -q "$arch_image" >/dev/null
# A container's root as the host sees it: the outside id of the map's line whose inside id is 0.
root_of() { "$RT" run --rm --network none "$BUSYBOX" awk '$1 == 0 { print $2 }' "/proc/self/$1"; }
B="$(root_of uid_map)"; G="$(root_of gid_map)"
[[ "$B" =~ ^[0-9]+$ && "$G" =~ ^[0-9]+$ ]] || fail "a container's uid_map and gid_map do not say its root: '$B' '$G'"
[[ "$B" != 0 && "$G" != 0 ]] || fail "a container's root is the host's root ($B:$G) on a daemon that says name=userns"
data_root="$("$RT" info --format '{{.DockerRootDir}}')"
echo "the engine: docker $("$RT" version --format '{{.Server.Version}}') ($("$RT" info --format '{{.Driver}}')), a task's root is host $B:$G; DockerRootDir $data_root; $(grep -h '^dockremap:' /etc/subuid 2>/dev/null | head -n1 || echo 'no dockremap line in /etc/subuid')"
[[ "$(basename "$data_root")" == "$B.$G" ]] || echo "note: DockerRootDir is not <B>.<G> ($data_root)"
echo "ok: the daemon remaps users, a container's root is host uid $B, gid $G"

if [[ -z "${AGENT:-}" || -z "${PKG_REPO:-}" ]]; then
  (cd "$root" && cargo build -q --locked -p omarchy-agent -p pkg-repo)
  AGENT="${AGENT:-$root/target/debug/omarchy-agent}"
  PKG_REPO="${PKG_REPO:-$root/target/debug/pkg-repo}"
fi
# The dispatcher runs as root with an environment of its own: its binary by its absolute path.
PKG_REPO="$(cd "$(dirname "$PKG_REPO")" && pwd -P)/$(basename "$PKG_REPO")"

# ---------- 1. the agent ----------
check() { python3 -c 'import json, sys; j = json.loads(sys.argv[1]); sys.exit(0 if eval(sys.argv[2]) else 1)' "$1" "$2" || fail "$3: $1"; }
mkdir -p "$tmp/work-root"
out="$("$AGENT" capacity --work-root "$tmp/work-root" --probe-image "$arch_image")" || fail "capacity: $out"
echo "$out" | jq -c '{arch, isolation, dedicated}'
check "$out" "j['isolation'] == 'subuid'" "the agent sees the remapped daemon"
echo "ok: the agent's capacity probe says isolation: subuid (install records it as envelope.userns_remap)"
# The agent's data directory as install leaves it on such a host: the envelope with userns_remap,
# a 0600 agent.env of this user's (never read here: no container user may be its owner), and the
# env file the enrollment left with its worker token.
token="omw_$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
agent_data="$tmp/agent"; envfile="$agent_data/sets/host/etc/dispatcher.env"
mkdir -p "$(dirname "$envfile")" "$tmp/secrets" "$tmp/work" "$tmp/checkout/factory/worker"
chmod 700 "$agent_data" "$tmp/secrets"
printf 'FACTORY_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-not-a-real-key\n' > "$tmp/secrets/agent.env"; chmod 600 "$tmp/secrets/agent.env"
cat > "$agent_data/agent.toml" <<TOML
pool = "https://pkgs.omarchy-pool.org"
host_id = "h_0123456789"
worker_id = "remap-test-0a9z"
[set]
dir = "$agent_data/sets/host"
work_root = "$tmp/work"
secrets_dir = "$tmp/secrets"
socket_cli = "/var/run/docker.sock"
engine = "rootful"
[envelope]
allow_socket = true
rootful_ack = true
dedicated = true
userns_remap = true
TOML
chmod 600 "$agent_data/agent.toml"
printf '# worker: remap-test-0a9z\nOMARCHY_WORKER_TOKEN=%s\n' "$token" > "$envfile"; chmod 600 "$envfile"
"$AGENT" dispatcher-env --data-dir "$agent_data" --write > "$tmp/agent.out" 2>&1 || { cat "$tmp/agent.out" >&2; fail "omarchy-agent dispatcher-env --write"; }
key() { sed -n "s/^$1=//p" "$envfile"; }
[[ "$(key OMARCHY_AGENT_HELD)" == userns-remap && -z "$(key OMARCHY_AGENT_USER)" ]] \
  || fail "the agent did not hold the model kinds: $(grep -E '^OMARCHY_AGENT_(HELD|USER)=' "$envfile" || echo neither)"
[[ "$(key OMARCHY_SECRETS_DIR)" == "$tmp/secrets" ]] || fail "OMARCHY_SECRETS_DIR: $(key OMARCHY_SECRETS_DIR)"
tokenfile="$agent_data/sets/host/run/host/dispatcher/token"
[[ "$(cat "$tokenfile" 2>/dev/null)" == "$token" ]] || fail "the worker token is not in run/host/dispatcher/token"
from_agent=()
while IFS= read -r line; do [[ -z "$line" || "$line" == \#* ]] || from_agent+=("$line"); done < "$envfile"
echo "ok: the agent wrote OMARCHY_AGENT_HELD=userns-remap and no OMARCHY_AGENT_USER into etc/dispatcher.env"

# ---------- 2. a build through the dispatcher ----------
# The worker image the sidecars run: a stand-in whose egress answers any GET with one line, whatever its arguments.
if [[ -n "${WORKER_IMAGE:-}" ]]; then
  "$RT" image inspect "$WORKER_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$WORKER_IMAGE" >/dev/null
  worker_id="$("$RT" image inspect --format '{{.Id}}' "$WORKER_IMAGE")"
else
  mkdir -p "$tmp/worker-image/www"
  printf '#!/bin/sh\nexec httpd -f -p 3128 -h /www\n' > "$tmp/worker-image/e"; chmod 755 "$tmp/worker-image/e"
  echo remap-egress-ok > "$tmp/worker-image/www/index.html"; chmod -R a+rX "$tmp/worker-image/www"
  printf 'FROM %s\nCOPY e /e\nCOPY www /www\nLABEL org.omarchy-pool.agent.host=%s\nENTRYPOINT ["/e"]\n' "$BUSYBOX" "$host" > "$tmp/worker-image/Containerfile"
  worker_id="$("$RT" build -q -f "$tmp/worker-image/Containerfile" "$tmp/worker-image" | tail -n1)" || fail "the stand-in worker image did not build on this daemon"
  built="$worker_id"
fi
worker_id="sha256:${worker_id#sha256:}"
subnets="10.$((200 + RANDOM % 50)).$(( (RANDOM % 16) * 16 )).0/20"

# The release checkout the task containers mount at /pool: the real script's ownership steps, one
# for one, run as the task's root; it waits to be told to build so the test can look at it running.
cat > "$tmp/checkout/factory/worker/omarchy-build-worker.sh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
source /task/in/meta.sh
steps() {
  set -e
  echo "uid_map: $(awk 'NR == 1 { print $1, $2, $3 }' /proc/self/uid_map)"
  # prepare_container: the builder, and the build cache given to it.
  id builder >/dev/null 2>&1 || useradd -m -s /bin/bash builder
  install -d -o builder -g builder /build/cache
  echo "builder: $(id -u builder):$(id -g builder)"
  for _ in $(seq 600); do [[ -e /task/in/finish ]] && break; sleep 1; done
  # run_makepkg: /build/out and the recipe's directory, and its package's own caches, the builder's.
  rm -rf /build/out; mkdir -p "/build/pkg/usr/share/$name" /build/out && chown -R builder:builder /build/pkg /build/out
  install -d -o builder -g builder "/build/cache/$name" "/build/cache/$name/ccache"
  runuser -u builder -- env n="$name" bash -c '
    set -e
    echo "built as $(id -u):$(id -g)" > "/build/pkg/usr/share/$n/hello"
    printf "pkgname = %s\npkgver = 1.0-1\npkgdesc = a build on a remapped daemon\narch = %s\nsize = 16\n" "$n" "$(uname -m)" > /build/pkg/.PKGINFO
    cd /build/pkg && bsdtar --zstd -cf "/build/out/$n-1.0-1-$(uname -m).pkg.tar.zst" .PKGINFO usr
    date -u > "/build/cache/$n/used"'
  # pacman_ready's downloads: pacman makes a download directory in its cache and gives it to its DownloadUser.
  getent group alpm >/dev/null || groupadd -r alpm
  id alpm >/dev/null 2>&1 || useradd -r -M -g alpm -s /usr/bin/nologin alpm
  d="$(mktemp -d /var/cache/pacman/pkg/download-XXXXXX)"
  chown alpm:alpm "$d"
  runuser -u alpm -- touch "$d/part"
  cp /build/out/*.pkg.tar.zst /task/out/
  printf 'pkgname=%s\narch=(%s)\n' "$name" "$(uname -m)" > /task/out/PKGBUILD
  echo "built $name"
}
# task_mode's shape: the log through a pipe into /task/log/task.log, then the verdict whatever happened.
( steps ) 2>&1 | cat > /task/log/task.log
status="${PIPESTATUS[0]}"
printf '{"status":%d,"final":false,"needs_native":false,"error":""}\n' "$status" > /task/out/verdict.json
exit "$status"
STUB

# The pool: who the host is (to its worker token only), the tasks of tasks.jsonl one per claim,
# every request in requests.jsonl with its Authorization, uploads under uploads/.
mkdir -p "$tmp/uploads"; : > "$tmp/tasks.jsonl"; : > "$tmp/requests.jsonl"
cat > "$tmp/pool.py" <<'P'
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
d, host, token = sys.argv[1], sys.argv[2], sys.argv[3]
served = 0
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def record(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        try: body = json.loads(raw)
        except Exception: body = {"bytes": len(raw)}
        with open(f"{d}/requests.jsonl", "a") as f: f.write(json.dumps({"method": self.command, "path": self.path, "body": body, "auth": self.headers.get("authorization")}) + "\n")
        return raw
    def do_GET(self):
        self.record()
        if self.path == "/api/v1/factory/workers/self": return self.send(200, {"id": host}) if self.headers.get("authorization") == f"Bearer {token}" else self.send(401, {"error": "unauthorized"})
        return self.send(404, {"error": "none"})
    def do_PUT(self):
        raw = self.record()
        with open(f"{d}/uploads/{os.path.basename(self.path)}", "wb") as f: f.write(raw)
        return self.send(200, {})
    def do_POST(self):
        global served
        self.record()
        if self.path == "/api/v1/factory/claim":
            tasks = [l for l in open(f"{d}/tasks.jsonl").read().splitlines() if l.strip()]
            if served < len(tasks):
                served += 1
                return self.send(200, json.loads(tasks[served - 1]))
            return self.send(204)
        return self.send(200, {})
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(f"{d}/port", "w").write(str(srv.server_address[1]))
srv.serve_forever()
P
python3 "$tmp/pool.py" "$tmp" "$host" "$token" & stub=$!
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(cat "$tmp/port")"; ready_port=$((18000 + RANDOM % 2000))
# The agent's file: this machine native, its isolation the remapped daemon's, no sandbox.
printf '{"schema":2,"at":"2026-10-01T00:00:00Z","cpus":4,"mem_gb":8,"page_kb":4,"disk_free_gb":{"work":200,"engine":150},"units":3,"job_reserved":1,"agent_slots":1,"lanes":[{"arch":"%s","mode":"native"}],"held_lanes":[],"isolation":"subuid","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false,"sandbox":null}\n' "$native" > "$tmp/capacity.json"
gen() { printf 'g_%016x' "$1"; }
name() { echo "omarchy-task-$1-$(gen "$1")"; }
give() { # id name ref — one task for the next claim
  jq -cn --argjson id "$1" --arg n "$2" --arg r "$3" --arg a "$native" --arg g "$(gen "$1")" \
    '{task:{id:$id,kind:"build",name:$n,arch:$a,lane:"native",trust:"community",pkgbuild_ref:$r,params:{},attempts:1,max_attempts:3,publish:1,lease_gen:$g,units:1,disk_gb:0,release:"v9.9.9"},token:("omj.secret-of-" + ($id|tostring)),lease_minutes:30}' >> "$tmp/tasks.jsonl"
}
until_() { local n="$1" what="$2"; shift 2; for _ in $(seq "$n"); do "$@" && return 0; sleep 1; done; fail "after ${n}s: $what"; }
report() { jq -c --arg p "/api/v1/factory/tasks/$1/$2" 'select(.path == $p) | .body' "$tmp/requests.jsonl" | tail -n1; }
reported() { [[ -n "$(report "$1" "$2")" ]]; }
tdir() { echo "$tmp/work/tasks/$1-$(gen "$1")"; }
log_of() { as_root cat "$(tdir "$1")/log/task.log" 2>/dev/null; }
said() { log_of "$1" | grep -q '^builder: '; }
owner() { as_root stat -c '%u:%g' "$1"; }
mode() { as_root stat -c '%a' "$1"; }
gone() { ! "$RT" inspect --type container "$1" >/dev/null 2>&1; }
net_gone() { ! "$RT" network inspect "$1" >/dev/null 2>&1; }

give 1 uremap "https://example.invalid/uremap@v1:PKGBUILD"
t0="$(date +%s)"
# As the host set runs it on a remapped daemon: root in the init user namespace, docker's default
# capabilities and no other (the compose service sets no cap_drop), its environment the agent's
# env file and the token's file, the build image the pinned Arch base.
caps=chown,dac_override,fowner,fsetid,kill,setgid,setuid,setpcap,net_bind_service,net_raw,sys_chroot,mknod,audit_write,setfcap
as_root sh -c 'echo $$ > "$0"; exec "$@"' "$tmp/dispatcher.pid" \
  setpriv --bounding-set "-all,+${caps//,/,+}" --inh-caps -all \
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root "${from_agent[@]}" \
    OMARCHY_WORKER_TOKEN_FILE="$tokenfile" OMARCHY_BUILD_IMAGE_AARCH64="$arch_image" OMARCHY_BUILD_IMAGE_X86_64="$arch_image" \
    OMARCHY_WORKER_IMAGE="$worker_id" OMARCHY_TASK_SUBNETS="$subnets" \
  "$PKG_REPO" dispatch --api "http://127.0.0.1:$port" --pool "http://127.0.0.1:$port" \
    --work-root "$tmp/work" --capacity-file "$tmp/capacity.json" --checkout "$tmp/checkout" --ready "127.0.0.1:$ready_port" \
    --tick-s 1 --heartbeat-s 2 --idle-claim-s 1 --disk-floor-gb 1 >> "$tmp/dispatcher.log" 2>&1 &
ready() { curl -sf "http://127.0.0.1:$ready_port/ready" >/dev/null 2>&1; }
until_ 60 "the dispatcher answers /ready" ready
pid="$(cat "$tmp/dispatcher.pid")"
status_of() { awk -v k="$1:" '$1 == k { print $2 }' "/proc/$pid/status"; }
[[ "$(status_of Uid)" == 0 && "$(status_of CapEff)" == 00000000a80425fb ]] \
  || fail "the dispatcher is not root with docker's default capabilities: Uid $(status_of Uid), CapEff $(status_of CapEff)"
[[ "$(head -n1 "/proc/$pid/uid_map" | awk '{ print $1, $2, $3 }')" == "0 0 4294967295" ]] || fail "the dispatcher is not in the init user namespace"
echo "ok: the dispatcher runs as root in the init user namespace with docker's default capabilities (CapEff 00000000a80425fb)"
# The task root it learned from the engine at start (#405): the one a container here reads.
grep -q "this daemon remaps users (userns-remap): a task's root is host uid $B, gid $G," "$tmp/dispatcher.log" \
  || fail "the dispatcher did not say the task root $B:$G: $(grep -m1 'remaps users' "$tmp/dispatcher.log" || echo nothing)"
echo "ok: the dispatcher learned the task root at start ($B:$G)"

# The build: running (or failed before it built: what a remapped host did before #405).
said_or_failed() { said 1 || reported 1 fail; }
until_ 300 "task 1 ran (its image present) or failed" said_or_failed
reported 1 fail && fail "task 1 failed on the remapped daemon before it built: $(report 1 fail)"
log="$(log_of 1)"
[[ "$(sed -n 's/^uid_map: //p' <<<"$log")" == "0 $B "* ]] || fail "the task's root is not host uid $B: $log"
builder="$(sed -n 's/^builder: //p' <<<"$log")"
[[ "$builder" =~ ^[0-9]+:[0-9]+$ ]] || fail "the builder: $log"
for c in "$(name 1)" "$(name 1)-egress"; do
  "$RT" inspect "$c" | jq -e '.[0] | .HostConfig.UsernsMode == "" and .Config.User == ""' >/dev/null \
    || fail "$c leaves the daemon's remapping or names a user: $("$RT" inspect "$c" | jq -c '.[0] | {UsernsMode: .HostConfig.UsernsMode, User: .Config.User}')"
done
mounts="$("$RT" ps -aq --filter "label=org.omarchy-pool.agent.host=$host" | xargs -r "$RT" inspect --format '{{range .Mounts}}{{.Source}} {{end}}')"
grep -q 'agent\.env' <<<"$mounts" && fail "a container mounts agent.env: $mounts"
# What the task writes is its root's on the host; what it only reads, and the task directory, the dispatcher's.
for sub in out log build build/cache pkgcache; do
  [[ "$(owner "$(tdir 1)/$sub")" == "$B:$G" ]] || fail "$sub is $(owner "$(tdir 1)/$sub"), not the task's root $B:$G"
done
# in/ opened for reading to the task's root whatever made it (#405), its owner kept.
[[ "$(owner "$(tdir 1)/in") $(mode "$(tdir 1)/in")" == "0:0 755" ]] || fail "in/ is $(owner "$(tdir 1)/in") $(mode "$(tdir 1)/in"), not the dispatcher's 755"
[[ "$(owner "$(tdir 1)") $(mode "$(tdir 1)")" == "0:0 700" && "$(mode "$tmp/work/tasks")" == 700 ]] || fail "the task directory is $(owner "$(tdir 1)") $(mode "$(tdir 1)")"
echo "ok: the task runs remapped (uid_map 0 $B, no UsernsMode, no User, no agent.env mounted), its writable directories its root's ($B:$G), in/ (755) and the task directory the dispatcher's"
as_root touch "$(tdir 1)/in/finish"
done_or_failed() { reported 1 complete || reported 1 fail; }
until_ 300 "task 1 completed" done_or_failed
reported 1 fail && fail "task 1 failed on the remapped daemon: $(report 1 fail)"
jq -e --arg f "uremap-1.0-1-$native.pkg.tar.zst" '.filename == $f' <<<"$(report 1 complete)" >/dev/null || fail "the completed build: $(report 1 complete)"
[[ -s "$tmp/uploads/uremap-1.0-1-$native.pkg.tar.zst" ]] || fail "the package was not uploaded: $(ls "$tmp/uploads")"
grep -q "arch=($native)" "$tmp/uploads/PKGBUILD" || fail "the recipe it staged: $(cat "$tmp/uploads/PKGBUILD" 2>/dev/null)"
jq -se '[.[] | select(.path | test("/factory/tasks/1/"))] | length > 0 and all(.auth == "Bearer omj.secret-of-1")' "$tmp/requests.jsonl" >/dev/null \
  || fail "a call for task 1 without its job token: $(jq -c 'select(.path | test("/factory/tasks/1/")) | [.path, .auth]' "$tmp/requests.jsonl")"
until_ 60 "task 1's containers removed" gone "$(name 1)"
gone "$(name 1)-egress" || fail "task 1's egress sidecar is still there"
until_ 30 "task 1's network removed" net_gone "$(name 1)"
# The builder's writes in its package's build cache: the builder's uid in the task, B plus it on the host.
used="$tmp/work/cache/build/community/$native/uremap/uremap/used"
[[ "$(owner "$used")" == "$((B + ${builder%%:*})):$((G + ${builder##*:}))" ]] || fail "$used is $(owner "$used"), not the builder's $builder mapped from $B:$G"
grep -q 'could not be set aside' "$tmp/dispatcher.log" && fail "its downloads: $(grep 'could not be set aside' "$tmp/dispatcher.log")"
echo "ok: a community build on the remapped daemon — built as the builder ($builder in the task, $((B + ${builder%%:*})):$((G + ${builder##*:})) on the host), uploaded and completed with its job token, its containers and network gone"

# ---------- 3. the model kinds held ----------
grep -q 'no probe and no agent sidecar: model kinds held: this daemon remaps users (userns-remap)' "$tmp/dispatcher.log" \
  || fail "the dispatcher did not say the model kinds are held"
give 2 uremap-d "draft:uremap-d"
until_ 120 "the draft handed back" reported 2 fail
jq -e '.lost == true and .final == false and (tostring | contains("userns-remap"))' <<<"$(report 2 fail)" >/dev/null || fail "the draft: $(report 2 fail)"
grep -q "task 2: build uremap-d started" "$tmp/dispatcher.log" && fail "the draft was started: $(grep 'task 2' "$tmp/dispatcher.log")"
jq -se '[.[] | select(.path == "/api/v1/factory/claim") | .body.agent] | length > 0 and all(.probe == "error" and (.error | contains("userns-remap")))' "$tmp/requests.jsonl" >/dev/null \
  || fail "a claim whose agent does not say it is held: $(jq -c 'select(.path == "/api/v1/factory/claim") | .body.agent' "$tmp/requests.jsonl" | sort -u)"
made="$("$RT" events --since "$t0" --until "$(date +%s)" --filter type=container --filter event=create \
  --filter "label=org.omarchy-pool.agent.host=$host" --format '{{.Actor.Attributes.name}}' | sort -u | tr '\n' ' ')"
[[ "$made" == *"$(name 1) "* ]] || fail "docker events did not list task 1's container: $made"
# Task 1's container and its egress sidecar, and the dispatcher's two reads of the task root at
# start (#405: unnamed, from the worker image, so docker names them adjective_surname): nothing else.
for c in $made; do
  [[ "$c" == "$(name 1)" || "$c" == "$(name 1)-egress" || "$c" =~ ^[a-z]+_[a-z]+[0-9]*$ ]] \
    || fail "made on a host whose model kinds are held: $c ($made)"
done
echo "ok: the model kinds held — said at start and in every claim, the draft handed back lost before anything of it ran, no probe or agent sidecar made ($made)"
as_root kill "$pid" 2>/dev/null || true
for _ in $(seq 30); do [[ -d "/proc/$pid" ]] || break; sleep 1; done
rm -f "$tmp/dispatcher.pid"

# ---------- 4. the dispatcher's real-engine tests on this engine ----------
image="${BUSYBOX%%@*}"
(cd "$root" && OMARCHY_STANDIN_IMAGE="${image%:*}@${BUSYBOX#*@}" cargo test -q --locked -p pkg-repo --lib -- --ignored --exact --nocapture \
  dispatch::engine::tests::real_engine_a_task_network_made_here_has_no_gateway \
  dispatch::engine::tests::real_engine_the_probe_reads_owner_only_keys_as_their_owner) \
  || fail "the dispatcher's real-engine tests on the remapped daemon"
echo "ok: a plain build on a remapped daemon (docker $("$RT" version --format '{{.Server.Version}}'), a task's root host $B:$G)"
