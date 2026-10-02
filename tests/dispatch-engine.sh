#!/usr/bin/env bash
# The dispatcher against a real engine (#335, design v2 §9, §10.3): `pkg-repo
# dispatch` on this machine, a stubbed pool, and a stub release checkout whose
# build script plays the task — it exits normally, fails, is killed by its
# memory limit, writes an output outside its kind's list, or waits to be told
# to finish. Every container it starts is labelled with this run's own host id
# and removed at the end; nothing else on the engine is touched.
#
#   1. a task container holds no token, key or socket: its environment, its
#      mounts and its flags, read back from the engine, and what the stub saw
#      inside; a build completes through staging, `verdict.json` read
#   2. a build that fails reports its verdict; one killed by its memory limit
#      fails `oom` although its script said `final`; an output outside the list
#      is not uploaded and fails the task; one that exited 0 without a verdict
#      (a reboot, as podman shows it) fails `lost`
#   3. a dispatcher replaced while its task runs: the new one adopts the
#      container, which finishes and is completed; a task that ends while no
#      dispatcher runs is completed from its exited container; one killed
#      meanwhile (a reboot, as the engine sees it) fails `lost`; a container
#      of this host without a lease file is removed at start
#   4. a lease the pool stops hearing: its own watchdog kills its container
#      and reports nothing, while the other lease runs on; a stop (409) kills
#      and fails as stopped
#   5. the disk watcher: below the floor, the youngest build is killed `lost`
#      and the claims say want 0
#
# Requires: cargo (or PKG_REPO=<a built pkg-repo>), python3, jq, docker or podman.
#   STUB_IMAGE  an image with bash and coreutils for this machine's architecture
#               (default docker.io/library/debian:stable-slim; pulled when absent)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
RT="${RUNTIME:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
STUB_IMAGE="${STUB_IMAGE:-docker.io/library/debian:stable-slim}"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
host="h_it-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
stub="" disp=""
cleanup() {
  [[ -z "$disp" ]] || kill -9 "$disp" 2>/dev/null || true
  [[ -z "$stub" ]] || kill "$stub" 2>/dev/null || true
  # Only this run's containers: the ones labelled with its own host id.
  local c
  for c in $("$RT" ps -aq --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" rm -f "$c" >/dev/null 2>&1 || true; done
  # What the task containers wrote as root goes through one more container of this run's own image, on this run's directory only.
  rm -rf "$tmp" 2>/dev/null || { [[ -z "${image_id:-}" ]] || "$RT" run --rm -v "$tmp:$tmp" "$image_id" rm -rf "$tmp/work" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null; } || true
}
trap cleanup EXIT
fail() { echo "dispatch-engine: FAIL — $*" >&2; [[ -f "$tmp/dispatcher.log" ]] && tail -n 40 "$tmp/dispatcher.log" >&2; exit 1; }

if [[ -z "${PKG_REPO:-}" ]]; then
  (cd "$root" && cargo build -q -p pkg-repo)
  PKG_REPO="$root/target/debug/pkg-repo"
fi
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64
"$RT" image inspect "$STUB_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$STUB_IMAGE" >/dev/null
image_id="$("$RT" image inspect --format '{{.Id}}' "$STUB_IMAGE")"; image_id="sha256:${image_id#sha256:}"

# The release checkout the task containers mount at /pool: a build script that plays the task by its name.
mkdir -p "$tmp/checkout/factory/worker" "$tmp/checkout/fixtures" "$tmp/work"
python3 - "$tmp/checkout/fixtures" "$arch" <<'PY'
import io, sys, tarfile
for name in ("ok", "slow", "fill"):
    info = f"pkgname = {name}\npkgver = 1.0-1\narch = {sys.argv[2]}\nsize = 1\n".encode()
    with tarfile.open(f"{sys.argv[1]}/{name}-1.0-1-{sys.argv[2]}.pkg.tar.zst", "w", format=tarfile.GNU_FORMAT) as t:
        ti = tarfile.TarInfo(".PKGINFO"); ti.size = len(info); t.addfile(ti, io.BytesIO(info))
PY
cat > "$tmp/checkout/factory/worker/omarchy-build-worker.sh" <<'STUB'
#!/usr/bin/env bash
# The stub task: what the real script's --task mode leaves (outputs, verdict.json, the log), by the task's name.
set -uo pipefail
source /task/in/meta.sh
exec > /task/log/task.log 2>&1
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64
# What it was born with, for the test to read: its environment and whether anything of the host is here.
{ echo "== env"; env | sort; echo "== socket: $(ls /var/run/docker.sock /run/docker.sock /run/podman/podman.sock 2>&1 | tr '\n' ' ')"; echo "== meta"; cat /task/in/meta.sh; } >> /task/log/task.log
ok() { cp "/pool/fixtures/$name-1.0-1-$arch.pkg.tar.zst" /task/out/; echo 'pkgname=x' > /task/out/PKGBUILD; echo '{"status":0,"final":false,"needs_native":false,"error":""}' > /task/out/verdict.json; echo "built $name"; exit 0; }
case "$name" in
  ok) ok ;;
  fails) echo '{"status":4,"final":true,"needs_native":false,"error":"the recipe failed"}' > /task/out/verdict.json; echo "==> ERROR: the recipe failed"; exit 4 ;;
  oom) echo '{"status":4,"final":true,"needs_native":false,"error":"said final"}' > /task/out/verdict.json; x="$(head -c 3500000000 /dev/zero | tr '\0' x)"; echo "${#x}"; exit 0 ;;
  evil) echo 'pkgname=x' > /task/out/PKGBUILD; echo 'boom' > /task/out/evil.sh; echo '{"status":0}' > /task/out/verdict.json; exit 0 ;;
  slow) while [[ ! -e /task/in/finish ]]; do sleep 1; done; ok ;;
  quiet) exit 0 ;;   # what podman shows of a task a reboot killed: exited, its stale exit code 0, no verdict
  fill) head -c 50000000 /dev/zero > /build/fill; while :; do sleep 1; done ;;
  *) echo "unknown stub task $name"; exit 2 ;;
esac
STUB

# The pool: who the host is, tasks from tasks.jsonl one per claim (then 204), heartbeats by beats/<id> (ok | down | stop), every
# request kept in requests.jsonl.
mkdir -p "$tmp/beats"; : > "$tmp/tasks.jsonl"; : > "$tmp/requests.jsonl"
cat > "$tmp/pool.py" <<'P'
import json, os, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
d, host = sys.argv[1], sys.argv[2]
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
        return body
    def do_GET(self):
        self.record()
        # Who the host is answers only to its worker token, as the pool does (a dispatcher that asked without it never got ready).
        if self.path == "/api/v1/factory/workers/self": return self.send(200, {"id": host}) if self.headers.get("authorization") == "Bearer omw_it" else self.send(401, {"error": "unauthorized"})
        return self.send(404, {"error": "none"})
    def do_PUT(self):
        self.record(); return self.send(200, {})
    def do_POST(self):
        global served
        self.record()
        if self.path == "/api/v1/factory/claim":
            tasks = [l for l in open(f"{d}/tasks.jsonl").read().splitlines() if l.strip()]
            if served < len(tasks):
                served += 1
                return self.send(200, json.loads(tasks[served - 1]))
            return self.send(204)
        m = re.match(r"/api/v1/factory/tasks/(\d+)/heartbeat$", self.path)
        if m:
            mode = open(f"{d}/beats/{m.group(1)}").read().strip() if os.path.exists(f"{d}/beats/{m.group(1)}") else "ok"
            if mode == "down": return self.send(500, {"error": "down"})
            if mode == "stop": return self.send(409, {"error": "stopped", "stop": True, "state": "cancelled"})
            return self.send(200, {"token": f"omj.renewed-{m.group(1)}"})
        return self.send(200, {})
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(f"{d}/port", "w").write(str(srv.server_address[1]))
srv.serve_forever()
P
python3 "$tmp/pool.py" "$tmp" "$host" & stub=$!
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(cat "$tmp/port")"; ready_port=$((18000 + RANDOM % 2000))

capacity() { # units engine-free-gb
  printf '{"schema":2,"at":"2026-10-01T00:00:00Z","cpus":12,"mem_gb":32,"page_kb":4,"disk_free_gb":{"work":200,"engine":%s},"units":%s,"job_reserved":1,"agent_slots":1,"lanes":[{"arch":"%s","mode":"native"}],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}\n' "$2" "$1" "$arch" > "$tmp/capacity.json"
}
capacity 11 150
give() { # id name units — one task for the next claim, a community build with its own lease generation
  jq -cn --argjson id "$1" --arg n "$2" --arg a "$arch" --argjson u "$3" --arg g "g_$(printf '%016x' "$1")" \
    '{task:{id:$id,kind:"build",name:$n,arch:$a,trust:"community",pkgbuild_ref:"https://example.invalid/x@v1:PKGBUILD",params:{},attempts:1,max_attempts:3,publish:1,lease_gen:$g,units:$u,disk_gb:0,release:"v9.9.9"},token:("omj.secret-of-" + ($id|tostring)),lease_minutes:30}' >> "$tmp/tasks.jsonl"
}
gen() { printf 'g_%016x' "$1"; }
name() { echo "omarchy-task-$1-$(gen "$1")"; }
start() { # [extra flags…]: a dispatcher, in the background
  env -u SIGNING_KEY OMARCHY_BUILD_IMAGE_AARCH64="$image_id" OMARCHY_BUILD_IMAGE_X86_64="$image_id" \
    "$PKG_REPO" dispatch --api "http://127.0.0.1:$port" --pool "http://127.0.0.1:$port" --worker-token omw_it \
      --work-root "$tmp/work" --capacity-file "$tmp/capacity.json" --checkout "$tmp/checkout" --ready "127.0.0.1:$ready_port" \
      --tick-s 1 --heartbeat-s 2 --idle-claim-s 1 "$@" >> "$tmp/dispatcher.log" 2>&1 & disp=$!
  for _ in $(seq 60); do curl -sf "http://127.0.0.1:$ready_port/ready" >/dev/null 2>&1 && return 0; sleep 0.5; done
  fail "the dispatcher never answered /ready"
}
stop() { [[ -n "$disp" ]] && { kill "-${1:-9}" "$disp" 2>/dev/null; wait "$disp" 2>/dev/null || true; disp=""; }; }
until_() { # seconds what condition…
  local n="$1" what="$2"; shift 2
  for _ in $(seq "$n"); do "$@" && return 0; sleep 1; done
  fail "after ${n}s: $what"
}
report() { jq -c --arg p "/api/v1/factory/tasks/$1/$2" 'select(.path == $p) | .body' "$tmp/requests.jsonl" | tail -n1; }
reported() { [[ -n "$(report "$1" "$2")" ]]; }
all_failed() { local i; for i; do reported "$i" fail || return 1; done; }
all_running() { local i; for i; do running "$i" || return 1; done; }
exited() { [[ "$("$RT" inspect --format '{{.State.Status}}' "$(name "$1")" 2>/dev/null)" == exited ]]; }
running() { [[ "$("$RT" inspect --format '{{.State.Status}}' "$(name "$1")" 2>/dev/null)" == running ]]; }
gone() { ! "$RT" inspect "$(name "$1")" >/dev/null 2>&1; }
finish() { touch "$tmp/work/tasks/$1-$(gen "$1")/in/finish"; }

# ---------- 1. born with nothing; a build through staging ----------
give 1 slow 2
start
until_ 60 "task 1's container runs" running 1
c="$(name 1)"
env_names="$("$RT" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" | cut -d= -f1 | sort -u | tr '\n' ' ')"
for v in $env_names; do
  case "$v" in MAKEFLAGS|NINJAFLAGS|CARGO_BUILD_JOBS|PATH|HOME|HOSTNAME|TERM|LANG|LC_ALL|container|"") ;; *) fail "a variable outside the allowlist in the task container: $v ($env_names)" ;; esac
done
"$RT" inspect --format '{{json .Config.Env}}' "$c" | grep -qiE 'omj\.|omw_|token|_key|secret' && fail "a credential in the task container's environment"
mounts="$("$RT" inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$c" | tr ' ' '\n' | grep . | sort | tr '\n' ' ')"
[[ "$mounts" == "/build /pool /task/in /task/log /task/out /var/cache/pacman/pkg " ]] || fail "the task container's mounts: $mounts"
# Its flags: not privileged, not on the host's network, never removed by the engine, its pid limit, no engine-side log,
# and only the spec's capabilities (docker keeps CapDrop ["ALL"]; podman says what is left, EffectiveCaps).
"$RT" inspect "$c" | jq -e '.[0] as $c | ["CAP_CHOWN","CAP_DAC_OVERRIDE","CAP_FOWNER","CAP_FSETID","CAP_SETUID","CAP_SETGID","CAP_KILL"] as $ok
  | $c.HostConfig.Privileged == false and $c.HostConfig.NetworkMode != "host" and $c.HostConfig.AutoRemove == false and $c.HostConfig.PidsLimit == 8192
  and $c.HostConfig.LogConfig.Type == "none"
  and (if $c.EffectiveCaps then ($c.EffectiveCaps - $ok | length) == 0 else ($c.HostConfig.CapDrop | index("ALL")) != null end)' >/dev/null \
  || fail "the task container's flags: $("$RT" inspect "$c" | jq -c '.[0] | {HostConfig: (.HostConfig | {Privileged, NetworkMode, AutoRemove, PidsLimit, LogConfig, CapDrop, CapAdd}), EffectiveCaps}')"
log="$tmp/work/tasks/1-$(gen 1)/log/task.log"
until_ 10 "the stub wrote what it was born with" grep -q '== meta' "$log"
grep -q '== socket: ls: cannot access' "$log" || fail "a socket in the task container: $(grep '== socket' "$log")"
grep -qiE 'omj\.|omw_|OMARCHY_API|OMARCHY_WORKER_TOKEN' "$log" && fail "a token or the pool's API in the task container: $log"
echo "ok: a task container holds no token, key or socket — environment, mounts and flags from the engine, and from inside"
finish 1
until_ 30 "task 1 completed" reported 1 complete
[[ "$(jq -r 'select(.path | test("/factory/tasks/1/artifacts/")) | .path' "$tmp/requests.jsonl" | sed 's#.*/##' | tr '\n' ' ')" == "PKGBUILD build.log PKGINFO slow-1.0-1-$arch.pkg.tar.zst " ]] \
  || fail "task 1's uploads: $(jq -r 'select(.path | test("/artifacts/")) | .path' "$tmp/requests.jsonl")"
jq -e 'select(.path | test("/factory/tasks/1/")) | .auth == "Bearer omj.secret-of-1" or .auth == "Bearer omj.renewed-1"' "$tmp/requests.jsonl" | grep -qv true && fail "a call for task 1 without its own job token"
until_ 10 "task 1's container removed" gone 1
echo "ok: a build staged in and out, completed with its job token, its container removed"

# ---------- 2. a failure, an out-of-memory kill, an output outside the list ----------
give 2 fails 2; give 3 oom 1; give 4 evil 2; give 11 quiet 1
until_ 120 "tasks 2, 3, 4 and 11 reported" all_failed 2 3 4 11
jq -e '.final == true and .error == "the recipe failed"' <<<"$(report 2 fail)" >/dev/null || fail "task 2's report: $(report 2 fail)"
jq -e '.oom == true and .final == false' <<<"$(report 3 fail)" >/dev/null || fail "task 3 was not failed oom: $(report 3 fail)"
jq -e '.final == true and (.error | contains("evil.sh"))' <<<"$(report 4 fail)" >/dev/null || fail "task 4's report: $(report 4 fail)"
jq -r 'select(.path | test("/factory/tasks/4/artifacts/")) | .path' "$tmp/requests.jsonl" | grep -q . && fail "task 4 uploaded something"
jq -e '.lost == true and .final == false' <<<"$(report 11 fail)" >/dev/null || fail "task 11 was not failed lost: $(report 11 fail)"
echo "ok: a failure reports its verdict; the memory limit's kill fails oom although the script said final; an output outside the list is not uploaded and fails the task; an exit without a verdict fails lost"

# ---------- 3. restarts ----------
give 5 slow 2; give 6 slow 2; give 7 slow 2
until_ 60 "tasks 5, 6 and 7 run" all_running 5 6 7
stop 9                                   # the release replaces the dispatcher …
finish 6                                 # … task 6 ends while none runs …
until_ 30 "task 6's container exits" exited 6
"$RT" kill "$(name 7)" >/dev/null        # … task 7's is killed as a reboot kills it …
"$RT" run -d --name "omarchy-task-99-$(gen 99)" --label "com.omarchy.task=99" --label "org.omarchy-pool.agent.host=$host" "$image_id" sleep 600 >/dev/null
start                                    # … and a container of this host without a lease file waits for the new one
running 5 || fail "task 5's container did not survive the dispatcher's replacement"
until_ 30 "task 6 completed from its exited container" reported 6 complete
until_ 30 "task 7 failed lost" reported 7 fail
jq -e '.lost == true' <<<"$(report 7 fail)" >/dev/null || fail "task 7: $(report 7 fail)"
until_ 10 "the stranger removed" gone 99
finish 5
until_ 30 "task 5 completed by the new dispatcher" reported 5 complete
echo "ok: a replaced dispatcher's task finishes; one that ended meanwhile is completed from its container; one killed meanwhile fails lost; a stranger goes"

# ---------- 4. the pool stops hearing one lease; a stop ----------
stop 15
start --lease-s 20
give 8 slow 2; give 9 slow 2
until_ 60 "tasks 8 and 9 run" all_running 8 9
echo down > "$tmp/beats/8"
until_ 60 "task 8's watchdog kills its container" gone 8
running 9 || fail "task 9 was touched by task 8's watchdog"
reported 8 fail && fail "an expired lease was reported: $(report 8 fail)"
reported 8 complete && fail "an expired lease was completed"
echo stop > "$tmp/beats/9"
until_ 30 "task 9 stopped" reported 9 fail
jq -e '.error | contains("stopped by the pool (cancelled)")' <<<"$(report 9 fail)" >/dev/null || fail "task 9: $(report 9 fail)"
gone 9 || fail "task 9's container survived its stop"
echo "ok: an expired lease's container is killed by its own watchdog and nothing reported, the other runs on; a stop kills and fails as stopped"

# ---------- 5. the disk watcher ----------
stop 15
start
give 10 fill 2
until_ 60 "task 10 runs" running 10
until_ 20 "task 10 wrote to /build" test -s "$tmp/work/tasks/10-$(gen 10)/build/fill"
stop 15
free="$(df -Pk "$tmp/work" | awk 'NR == 2 { print int($4 / 1048576) }')"
start --disk-floor-gb "$((free + 5))"
until_ 30 "the disk watcher killed task 10" reported 10 fail
jq -e '.lost == true and (.error | contains("disk watcher"))' <<<"$(report 10 fail)" >/dev/null || fail "task 10: $(report 10 fail)"
gone 10 || fail "task 10's container survived the disk watcher"
sleep 3
jq -c 'select(.path == "/api/v1/factory/claim") | .body.want' "$tmp/requests.jsonl" | tail -n1 | grep -qx 0 || fail "the dispatcher still claims work with the disk below its floor"
echo "ok: below the floor the disk watcher kills the youngest build, lost, and the claims say want 0"
stop 15
echo "ok: the dispatcher on a real engine ($RT, $STUB_IMAGE)"
