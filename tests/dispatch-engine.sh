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
#      and fails as stopped; the pool's word that a lease's release is revoked
#      (409, state `revoked`, #342) kills it with its sidecar and network —
#      made through libpod's API behind docker's CLI on podman (#372) — and
#      fails it revoked and lost
#   5. the disk watcher: below the floor, the youngest build is killed `lost`
#      and the claims say want 0
#   6. pool jobs (#340): a health check runs in a child process of the
#      dispatcher under its 2 GB data rlimit, which its script inherits, and
#      its check container goes through omarchy-task-run — on
#      the job's own internal network with its egress sidecar, its scratch
#      directory read-only, no token, no socket — while any other engine call
#      of the job is refused; a job that hangs is killed at its timeout and
#      failed, with what it started, while a build's lease beats on and
#      completes
#   7. the task caches (#341): two community builds of packages that need the
#      same dependency, at once — each mounts its own package's build cache
#      (a project cache of the same name and the other package's out of its
#      reach) and the shared pacman cache read-only, and downloads into a
#      cache of its own; after them, only the bytes the pool's signed
#      databases list (the fixture databases, served by the stub pool, signed
#      by their own key) are merged into the shared cache — a planted file, an
#      unlisted one and one two databases list otherwise are not; the next
#      build finds it there, read-only
#
# Every task runs on its own internal network with its egress sidecar (#336);
# here the worker image the sidecars run is a stand-in that only sleeps (the
# egress proxy itself is tests/task-networks.sh's): the network is internal,
# the task is on it alone, its egress on it and on omarchy-egress, and all of
# it goes with the lease — a stopped one's, never the other lease's.
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
  # Its networks (its tasks', and omarchy-egress when this run made it and nothing else is on it), and its stand-in image.
  for c in $("$RT" network ls -q --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" network rm "$c" >/dev/null 2>&1 || true; done
  [[ -z "${worker_id:-}" ]] || "$RT" rmi "$worker_id" >/dev/null 2>&1 || true
  # What the task containers wrote as root goes through one more container of this run's own image, on this run's directory only.
  rm -rf "$tmp" 2>/dev/null || { [[ -z "${image_id:-}" ]] || "$RT" run --rm -v "$tmp:$tmp" "$image_id" rm -rf "$tmp/work" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null; } || true
}
trap cleanup EXIT
fail() {
  echo "dispatch-engine: FAIL — $*" >&2; [[ -f "$tmp/dispatcher.log" ]] && tail -n 40 "$tmp/dispatcher.log" >&2
  echo "this run's containers:" >&2; "$RT" ps -a --filter "label=org.omarchy-pool.agent.host=$host" --format '{{.Names}} {{.Status}}' >&2 || true
  exit 1
}

if [[ -z "${PKG_REPO:-}" ]]; then
  (cd "$root" && cargo build -q -p pkg-repo)
  PKG_REPO="$root/target/debug/pkg-repo"
fi
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64
"$RT" image inspect "$STUB_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$STUB_IMAGE" >/dev/null
image_id="$("$RT" image inspect --format '{{.Id}}' "$STUB_IMAGE")"; image_id="sha256:${image_id#sha256:}"
# The worker image the sidecars run: a stand-in of this run's own that sleeps whatever its role (by its content id, as a digest).
mkdir -p "$tmp/worker-image"
printf '#!/bin/sh\nexec sleep 100000\n' > "$tmp/worker-image/e"; chmod 755 "$tmp/worker-image/e"
printf 'FROM %s\nCOPY e /e\nLABEL org.omarchy-pool.agent.host=%s\nENTRYPOINT ["/e"]\n' "$STUB_IMAGE" "$host" > "$tmp/worker-image/Containerfile"
worker_id="$("$RT" build -q -f "$tmp/worker-image/Containerfile" "$tmp/worker-image" | tail -n1)"; worker_id="sha256:${worker_id#sha256:}"
# Task networks from a range of this run's own, so nothing else on the engine is in the way.
subnets="10.$((200 + RANDOM % 50)).$(( (RANDOM % 16) * 16 )).0/20"

# The release checkout the task containers mount at /pool: a build script that plays the task by its name.
mkdir -p "$tmp/checkout/factory/worker" "$tmp/checkout/fixtures" "$tmp/work"
python3 - "$tmp/checkout/fixtures" "$arch" <<'PY'
import io, sys, tarfile
for name in ("ok", "slow", "fill", "cache-a", "cache-b", "cache-c"):
    info = f"pkgname = {name}\npkgver = 1.0-1\narch = {sys.argv[2]}\nsize = 1\n".encode()
    with tarfile.open(f"{sys.argv[1]}/{name}-1.0-1-{sys.argv[2]}.pkg.tar.zst", "w", format=tarfile.GNU_FORMAT) as t:
        ti = tarfile.TarInfo(".PKGINFO"); ti.size = len(info); t.addfile(ti, io.BytesIO(info))
PY
# Where the work root is on this host, for a stub recipe that tries the host's own paths to the caches (#341).
printf '%s\n' "$tmp/work" > "$tmp/checkout/fixtures/work-root"
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
  cache-*)
    # What it sees of the caches (#341): its own package's build cache, the shared pacman cache read-only.
    echo "== build cache: $(ls -A /build/cache | tr '\n' ' ')"
    echo "== shared: $(ls -A /var/cache/pacman/shared | tr '\n' ' ')"
    echo "== shared write: $(touch /var/cache/pacman/shared/planted 2>&1 || true)"
    for f in /var/cache/pacman/shared/*.pkg.tar.zst; do [[ -f "$f" ]] && echo "== shared sha: $(sha256sum "$f" | cut -c1-64) $(basename "$f")"; done
    echo "$name" > "/build/cache/own-$name"
    # A recipe that writes outside its cache: the cache tree is not mounted, and /build/cache/.. is its own /build.
    echo "== outside: $(ls -A /build/cache/.. | tr '\n' ' ')"
    if [[ "$name" == cache-a ]]; then
      # Every road it has to a project cache of its own name and to the other package's (AC1): up from its cache,
      # and the host's own paths of them (the test wrote its work root here). Each lands in the container, if anywhere.
      w="$(cat /pool/fixtures/work-root)"
      for d in "/build/cache/../../cache/build/project/$arch/cache-a" "/build/cache/../cache-b" "/build/cache/../../../cache-b" \
               "$w/cache/build/project/$arch/cache-a" "$w/cache/build/community/$arch/cache-b" "$w/cache"; do
        mkdir -p "$d" 2>/dev/null; echo "planted by cache-a's recipe" > "$d/planted" 2>/dev/null
      done
      echo "== escapes tried"
    fi
    [[ "$name" == cache-c ]] && ok
    # pacman's downloads go to its own cache, the dependency both builds need first as a .part, held until both are in flight.
    lib="libfixture-1.0-1-$arch.pkg.tar.zst"
    printf 'omarchy-pool fixture package %s (%s) for %s\n' libfixture libfixture "$arch" > "/var/cache/pacman/pkg/$lib.part"
    echo "== downloading"
    while [[ ! -e /task/in/finish ]]; do sleep 1; done
    mv "/var/cache/pacman/pkg/$lib.part" "/var/cache/pacman/pkg/$lib"
    if [[ "$name" == cache-a ]]; then
      echo "planted by cache-a's recipe" > "/var/cache/pacman/pkg/evil-1.0-1-$arch.pkg.tar.zst"
      echo x > "/var/cache/pacman/pkg/stranger-1.0-1-$arch.pkg.tar.zst"
    else
      printf 'omarchy-pool fixture package %s (%s) for %s\n' twin core "$arch" > "/var/cache/pacman/pkg/twin-1.0-1-$arch.pkg.tar.zst"
    fi
    ok ;;
  *) echo "unknown stub task $name"; exit 2 ;;
esac
STUB

# The release's health check, as a pool job runs it (#340): its check container through $RUNTIME in the shape tests/health-check.sh
# uses, the image the release pins (tests/images.env: this run's stub image by its content id); then two engine calls the shim must
# refuse. "hang" is a check that never ends.
mkdir -p "$tmp/checkout/tests"
printf 'STUB_BASE="%s"\n' "$image_id" > "$tmp/checkout/tests/images.env"
cat > "$tmp/checkout/tests/health-check.sh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
RING="$1"; ARCH="${2:-x86_64}"
source "$(cd "$(dirname "$0")" && pwd)/images.env"
case "$ARCH" in x86_64) PLATFORM=linux/amd64 KEYRING=archlinux ;; *) PLATFORM=linux/arm64 KEYRING=archlinuxarm ;; esac
RUNTIME="${RUNTIME:-$(command -v docker || command -v podman)}"
out="$OMARCHY_WORK_DIR/health-$RING.out"
if [[ "$RING" == hang ]]; then echo $$ > "$OMARCHY_WORK_DIR/hang.pid"; exec sleep 600; fi
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/check.sh" <<'CHECK'
echo "== env"; env | sort
echo "== repo: $(touch /repo/x 2>&1 || true)"
echo "== socket: $(ls /var/run/docker.sock /run/docker.sock /run/podman/podman.sock 2>&1 | tr '\n' ' ')"
sleep 4
echo "TOTAL=3"
exit 0
CHECK
"$RUNTIME" run --rm --platform "$PLATFORM" -e KEYRING="$KEYRING" -v "$WORK:/repo:ro" "$STUB_BASE" bash /repo/check.sh > "$out" 2>&1
code=$?
"$RUNTIME" run --rm --privileged --platform "$PLATFORM" -v "$WORK:/repo:ro" "$STUB_BASE" bash /repo/check.sh >/dev/null 2>&1; echo "== privileged: $?" >> "$out"
docker ps >/dev/null 2>&1; echo "== docker ps: $?" >> "$out"
echo "== runtime: $RUNTIME" >> "$out"
echo "== data: $(ulimit -d) $(ulimit -H -d)" >> "$out"
exit "$code"
STUB
chmod +x "$tmp/checkout/tests/health-check.sh"

# The pool: who the host is, tasks from tasks.jsonl one per claim (then 204), heartbeats by beats/<id> (ok | down | stop | revoked), every
# request kept in requests.jsonl.
mkdir -p "$tmp/beats"; : > "$tmp/tasks.jsonl"; : > "$tmp/requests.jsonl"
cat > "$tmp/pool.py" <<'P'
import json, os, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
d, host, dbs = sys.argv[1], sys.argv[2], sys.argv[3]
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
        # The pool's package repositories (#341): the fixture databases and their signatures, for either architecture.
        m = re.match(r"/(core|packages)/(x86_64|aarch64)/(omarchy-(core|packages)-edge\.db(\.sig)?)$", self.path)
        if m and m.group(1) == m.group(4) and os.path.exists(f"{dbs}/{m.group(3)}"):
            data = open(f"{dbs}/{m.group(3)}", "rb").read()
            self.send_response(200); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data); return
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
            if mode == "revoked": return self.send(409, {"error": "revoked", "stop": True, "state": "revoked"})
            return self.send(200, {"token": f"omj.renewed-{m.group(1)}"})
        return self.send(200, {})
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(f"{d}/port", "w").write(str(srv.server_address[1]))
srv.serve_forever()
P
python3 "$tmp/pool.py" "$tmp" "$host" "$root/crates/pkg-repo/tests/fixtures/pool-dbs" & stub=$!
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
give_health() { # id ring — a pool job for the next claim: the health check of this machine's ring arch (#340)
  jq -cn --argjson id "$1" --arg r "$2" --arg a "$arch" --arg g "g_$(printf '%016x' "$1")" \
    '{task:{id:$id,kind:"health",name:"health",arch:$a,trust:"project",pkgbuild_ref:"-",params:{ring:$r,arch:$a},attempts:1,max_attempts:3,publish:1,lease_gen:$g,units:1,disk_gb:0,release:"v9.9.9"},token:("omj.secret-of-" + ($id|tostring)),lease_minutes:30}' >> "$tmp/tasks.jsonl"
}
gen() { printf 'g_%016x' "$1"; }
name() { echo "omarchy-task-$1-$(gen "$1")"; }
start() { # [extra flags…]: a dispatcher, in the background
  env -u SIGNING_KEY -u OMARCHY_SECRETS_DIR -u GITHUB_TOKEN -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u OPENAI_API_KEY -u GEMINI_API_KEY -u XAI_API_KEY OMARCHY_BUILD_IMAGE_AARCH64="$image_id" OMARCHY_BUILD_IMAGE_X86_64="$image_id" \
    OMARCHY_WORKER_IMAGE="$worker_id" OMARCHY_TASK_SUBNETS="$subnets" \
    "$PKG_REPO" dispatch --api "http://127.0.0.1:$port" --pool "http://127.0.0.1:$port" --worker-token omw_it \
      --work-root "$tmp/work" --capacity-file "$tmp/capacity.json" --checkout "$tmp/checkout" --ready "127.0.0.1:$ready_port" \
      --tick-s 1 --heartbeat-s 2 --idle-claim-s 1 --pool-key "$root/crates/pkg-repo/tests/fixtures/pool-dbs/pool.pub.asc" "$@" >> "$tmp/dispatcher.log" 2>&1 & disp=$!
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
gone() { ! "$RT" inspect --type container "$(name "$1")" >/dev/null 2>&1; }
side_gone() { ! "$RT" inspect --type container "$(name "$1")-egress" >/dev/null 2>&1 && ! "$RT" network inspect "$(name "$1")" >/dev/null 2>&1; }
side_there() { [[ "$("$RT" inspect --format '{{.State.Status}}' "$(name "$1")-egress" 2>/dev/null)" == running ]] && "$RT" network inspect "$(name "$1")" >/dev/null 2>&1; }
nets_of() { "$RT" inspect "$1" | jq -r '.[0].NetworkSettings.Networks | keys | sort | join(" ")'; }
finish() { touch "$tmp/work/tasks/$1-$(gen "$1")/in/finish"; }

# ---------- 1. born with nothing; a build through staging ----------
give 1 slow 2
start
until_ 60 "task 1's container runs" running 1
c="$(name 1)"
env_names="$("$RT" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$c" | cut -d= -f1 | sort -u | tr '\n' ' ')"
for v in $env_names; do
  case "$v" in MAKEFLAGS|NINJAFLAGS|CARGO_BUILD_JOBS|HTTP_PROXY|http_proxy|HTTPS_PROXY|https_proxy|NO_PROXY|no_proxy|PATH|HOME|HOSTNAME|TERM|LANG|LC_ALL|container|"") ;; *) fail "a variable outside the allowlist in the task container: $v ($env_names)" ;; esac
done
"$RT" inspect --format '{{json .Config.Env}}' "$c" | grep -qiE 'omj\.|omw_|token|_key|secret' && fail "a credential in the task container's environment"
mounts="$("$RT" inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$c" | tr ' ' '\n' | grep . | sort | tr '\n' ' ')"
[[ "$mounts" == "/build /build/cache /pool /task/in /task/log /task/out /var/cache/pacman/pkg /var/cache/pacman/shared " ]] || fail "the task container's mounts: $mounts"
# Its caches (#341): its own package's build cache on its side, the shared pacman cache read-only, a pacman cache of its own.
"$RT" inspect "$c" | jq -e --arg w "$tmp/work" --arg a "$arch" --arg t "$tmp/work/tasks/1-$(gen 1)" '.[0].Mounts as $m
  | ($m[] | select(.Destination == "/build/cache") | .Source == "\($w)/cache/build/community/\($a)/slow" and .RW == true)
  and ($m[] | select(.Destination == "/var/cache/pacman/shared") | .Source == "\($w)/cache/pacman/\($a)" and .RW == false)
  and ($m[] | select(.Destination == "/var/cache/pacman/pkg") | .Source == "\($t)/pkgcache" and .RW == true)' >/dev/null \
  || fail "the task container's caches: $("$RT" inspect "$c" | jq -c '[.[0].Mounts[] | {Source, Destination, RW}]')"
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
# Its network (#336): internal, its own; the task on it alone; its egress sidecar on it and on omarchy-egress, holding nothing.
"$RT" network inspect "$c" | jq -e '.[0] | (.Internal == true or .internal == true)' >/dev/null || fail "task 1's network is not internal: $("$RT" network inspect "$c" | jq -c '.[0] | {Internal, internal}')"
[[ "$(nets_of "$c")" == "$c" ]] || fail "task 1's container is on: $(nets_of "$c")"
[[ "$(nets_of "$c-egress")" == "$(printf '%s\n' "$c" omarchy-egress | sort | tr '\n' ' ' | sed 's/ $//')" ]] || fail "task 1's egress is on: $(nets_of "$c-egress")"
"$RT" inspect "$c-egress" | jq -e '.[0] | (.Mounts | length) == 0 and .HostConfig.Privileged == false and .HostConfig.ReadonlyRootfs == true' >/dev/null || fail "task 1's egress: $("$RT" inspect "$c-egress" | jq -c '.[0] | {Mounts, HostConfig: (.HostConfig | {Privileged, ReadonlyRootfs})}')"
"$RT" inspect --format '{{json .Config.Env}}' "$c-egress" | grep -qiE 'omj\.|omw_|token|_key|secret' && fail "a credential in the egress sidecar's environment"
"$RT" inspect --format '{{json .Config.Env}}' "$c" | grep -q "HTTPS_PROXY=http://" || fail "task 1 has no proxy: $("$RT" inspect --format '{{json .Config.Env}}' "$c")"
echo "ok: the task's own internal network, the task alone on it, its egress sidecar on it and on omarchy-egress"
finish 1
until_ 30 "task 1 completed" reported 1 complete
[[ "$(jq -r 'select(.path | test("/factory/tasks/1/artifacts/")) | .path' "$tmp/requests.jsonl" | sed 's#.*/##' | tr '\n' ' ')" == "PKGBUILD build.log PKGINFO slow-1.0-1-$arch.pkg.tar.zst " ]] \
  || fail "task 1's uploads: $(jq -r 'select(.path | test("/artifacts/")) | .path' "$tmp/requests.jsonl")"
jq -e 'select(.path | test("/factory/tasks/1/")) | .auth == "Bearer omj.secret-of-1" or .auth == "Bearer omj.renewed-1"' "$tmp/requests.jsonl" | grep -qv true && fail "a call for task 1 without its own job token"
until_ 10 "task 1's container removed" gone 1
until_ 10 "task 1's sidecar and network removed" side_gone 1
echo "ok: a build staged in and out, completed with its job token, its container, its sidecar and its network removed"

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
"$RT" run -d --name "omarchy-task-98-$(gen 98)-egress" --label "com.omarchy.task=98" --label "org.omarchy-pool.agent.host=$host" "$image_id" sleep 600 >/dev/null
"$RT" network create --label "org.omarchy-pool.agent.host=$host" "omarchy-task-98-$(gen 98)" >/dev/null
start                                    # … and a container, a sidecar and a network of this host without a lease file wait for the new one
running 5 || fail "task 5's container did not survive the dispatcher's replacement"
until_ 30 "task 6 completed from its exited container" reported 6 complete
until_ 30 "task 7 failed lost" reported 7 fail
jq -e '.lost == true' <<<"$(report 7 fail)" >/dev/null || fail "task 7: $(report 7 fail)"
until_ 10 "the stranger removed" gone 99
"$RT" inspect --type container "omarchy-task-98-$(gen 98)-egress" >/dev/null 2>&1 && fail "an orphan sidecar of this host survived the start"
"$RT" network inspect "omarchy-task-98-$(gen 98)" >/dev/null 2>&1 && fail "an orphan network of this host survived the start"
side_there 5 || fail "task 5's sidecar or network did not survive the dispatcher's replacement"
finish 5
until_ 30 "task 5 completed by the new dispatcher" reported 5 complete
echo "ok: a replaced dispatcher's task finishes; one that ended meanwhile is completed from its container; one killed meanwhile fails lost; a stranger, an orphan sidecar and an orphan network go"

# ---------- 4. the pool stops hearing one lease; a stop; a revoked release ----------
stop 15
start --lease-s 20
give 8 slow 2; give 9 slow 2
until_ 60 "tasks 8 and 9 run" all_running 8 9
echo down > "$tmp/beats/8"
until_ 60 "task 8's watchdog kills its container" gone 8
running 9 || fail "task 9 was touched by task 8's watchdog"
until_ 10 "task 8's sidecar and network removed" side_gone 8
side_there 9 || fail "task 9's sidecar or network was touched by task 8's end"
reported 8 fail && fail "an expired lease was reported: $(report 8 fail)"
reported 8 complete && fail "an expired lease was completed"
echo stop > "$tmp/beats/9"
until_ 30 "task 9 stopped" reported 9 fail
jq -e '.error | contains("stopped by the pool (cancelled)")' <<<"$(report 9 fail)" >/dev/null || fail "task 9: $(report 9 fail)"
gone 9 || fail "task 9's container survived its stop"
until_ 10 "task 9's sidecar and network removed" side_gone 9
give 12 slow 1
until_ 60 "task 12 runs" running 12
side_there 12 || fail "task 12's sidecar or network is missing"
echo revoked > "$tmp/beats/12"
until_ 30 "task 12 killed as revoked" reported 12 fail
jq -e '.revoked == true and .lost == true and .final == false and (.error | contains("is revoked"))' <<<"$(report 12 fail)" >/dev/null || fail "task 12: $(report 12 fail)"
gone 12 || fail "task 12's container survived its release's revocation"
until_ 10 "task 12's sidecar and network removed" side_gone 12
reported 12 complete && fail "a revoked lease was completed"
echo "ok: an expired lease's container is killed by its own watchdog and nothing reported, the other runs on; a stop kills and fails as stopped; a revoked one is killed with its sidecar and network and fails revoked and lost"

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

# ---------- 6. pool jobs (#340) ----------
stop 15
start --job-timeout-s 30
[[ "$arch" == x86_64 || "$arch" == aarch64 ]] || fail "no lane of $arch"
helper="$(name 20)-helper"
give_health 20 rc
helper_running() { [[ "$("$RT" inspect --format '{{.State.Status}}' "$(name "$1")-helper" 2>/dev/null)" == running ]]; }
until_ 60 "task 20's check container runs" helper_running 20
# Its check container: the job's own internal network, alone on it with its egress sidecar; its scratch directory read-only at /repo
# and nothing else mounted; no credential; the spec's capabilities and flags.
[[ "$(nets_of "$helper")" == "$(name 20)" ]] || fail "task 20's helper is on: $(nets_of "$helper")"
"$RT" network inspect "$(name 20)" | jq -e '.[0] | (.Internal == true or .internal == true)' >/dev/null || fail "task 20's network is not internal"
[[ "$(nets_of "$(name 20)-egress")" == "$(printf '%s\n' "$(name 20)" omarchy-egress | sort | tr '\n' ' ' | sed 's/ $//')" ]] || fail "task 20's egress is on: $(nets_of "$(name 20)-egress")"
"$RT" inspect "$helper" | jq -e --arg w "$tmp/work/tasks/20-$(gen 20)/tmp/" '.[0] as $c | ["CAP_CHOWN","CAP_DAC_OVERRIDE","CAP_FOWNER","CAP_FSETID","CAP_SETUID","CAP_SETGID","CAP_KILL"] as $ok
  | $c.HostConfig.Privileged == false and $c.HostConfig.PidsLimit == 8192 and $c.HostConfig.LogConfig.Type == "none"
  and ($c.Mounts | length) == 1 and $c.Mounts[0].Destination == "/repo" and $c.Mounts[0].RW == false and ($c.Mounts[0].Source | startswith($w))
  and (if $c.EffectiveCaps then ($c.EffectiveCaps - $ok | length) == 0 else ($c.HostConfig.CapDrop | index("ALL")) != null end)' >/dev/null \
  || fail "task 20's helper: $("$RT" inspect "$helper" | jq -c '.[0] | {Mounts, HostConfig: (.HostConfig | {Privileged, PidsLimit, LogConfig, CapDrop, CapAdd}), EffectiveCaps}')"
"$RT" inspect --format '{{json .Config.Env}}' "$helper" | grep -qiE 'omj\.|omw_|token|secret|OMARCHY_' && fail "a credential in task 20's helper: $("$RT" inspect --format '{{json .Config.Env}}' "$helper")"
until_ 60 "task 20 completed" reported 20 complete
jq -e '.summary == "rc/'"$arch"' healthy"' <<<"$(report 20 complete)" >/dev/null || fail "task 20's report: $(report 20 complete)"
out="$tmp/work/jobs/health-rc.out"
grep -q '^TOTAL=3$' "$out" || fail "the check's output did not reach the script: $(cat "$out")"
grep -qx "KEYRING=archlinux\(arm\)\?" "$out" && grep -q '^HTTPS_PROXY=http://' "$out" || fail "the check's environment: $(cat "$out")"
grep -qiE 'omj\.|omw_|OMARCHY_TOKEN|OMARCHY_API' "$out" && fail "a token or the pool's API in the check container: $(cat "$out")"
grep -q '== repo: .*Read-only' "$out" || fail "the check's /repo is writable: $(grep '== repo' "$out")"
grep -q '== socket: ls: cannot access' "$out" || fail "a socket in the check container: $(grep '== socket' "$out")"
grep -qx '== privileged: 125' "$out" && grep -qx '== docker ps: 125' "$out" || fail "the shim took a shape it must refuse: $(grep '^== [pd]' "$out")"
grep -qx "== runtime: $tmp/work/state/bin/omarchy-task-run" "$out" || fail "the job's RUNTIME: $(grep '== runtime' "$out")"
# The job's 2 GB data rlimit, which pkg-repo pool-job set on itself before anything ran: its script inherits it, soft and hard.
grep -qx '== data: 2097152 2097152' "$out" || fail "the job's memory limit: $(grep '== data' "$out")"
until_ 10 "task 20's helper, sidecar and network removed" side_gone 20
"$RT" inspect --type container "$helper" >/dev/null 2>&1 && fail "task 20's helper survived it"
claims_jobs() { jq -c 'select(.path == "/api/v1/factory/claim") | .body.kinds' "$tmp/requests.jsonl" | tail -n1 | grep -q '"health"'; }
until_ 10 "the claims list the pool's kinds again, its unit free" claims_jobs
echo "ok: a pool job's check container goes through omarchy-task-run: its own internal network and egress, its scratch read-only, no token or socket; any other engine call refused"
# A job that hangs, beside a build: killed at its timeout and failed, with what it started; the build beats on and completes.
give 21 slow 2
until_ 60 "task 21 runs" running 21
give_health 22 hang
until_ 30 "task 22's check hangs" test -s "$tmp/work/jobs/hang.pid"
beats() { jq -c --arg p "/api/v1/factory/tasks/$1/heartbeat" 'select(.path == $p)' "$tmp/requests.jsonl" | wc -l; }
b21="$(beats 21)"
until_ 60 "task 22 failed at its timeout" reported 22 fail
jq -e '.timed_out == true and .final == false and (.error | contains("ran past its timeout"))' <<<"$(report 22 fail)" >/dev/null || fail "task 22: $(report 22 fail)"
# Killed, or a zombie its new parent has not reaped yet.
script_gone() { local p; p="$(cat "$tmp/work/jobs/hang.pid")"; ! kill -0 "$p" 2>/dev/null || [[ "$(awk '{ print $3 }' "/proc/$p/stat" 2>/dev/null)" == Z ]]; }
until_ 10 "the hung job's script killed with it" script_gone
[[ "$(beats 21)" -gt "$b21" ]] || fail "task 21's heartbeats stopped while task 22 hung"
running 21 || fail "task 21 was touched by task 22's kill"
finish 21
until_ 30 "task 21 completed" reported 21 complete
echo "ok: a pool job that hangs is killed at its timeout and failed, with its script; a build's lease beats on and completes"

# ---------- 7. the task caches (#341) ----------
# A project cache of the same name as a community package's: a community build never reaches it.
mkdir -p "$tmp/work/cache/build/project/$arch/cache-a"; echo project > "$tmp/work/cache/build/project/$arch/cache-a/marker-project"
give 30 cache-a 2; give 31 cache-b 2
until_ 60 "tasks 30 and 31 run" all_running 30 31
log_of() { echo "$tmp/work/tasks/$1-$(gen "$1")/log/task.log"; }
downloading() { local i; for i; do grep -q '^== downloading' "$(log_of "$i")" 2>/dev/null || return 1; done; }
until_ 30 "both builds download the dependency they share, at once" downloading 30 31
all_running 30 31 || fail "tasks 30 and 31 do not run at once"
for i in 30 31; do
  n="cache-$([[ $i == 30 ]] && echo a || echo b)"
  "$RT" inspect "$(name "$i")" | jq -e --arg w "$tmp/work" --arg a "$arch" --arg n "$n" '.[0].Mounts as $m
    | ($m[] | select(.Destination == "/build/cache") | .Source == "\($w)/cache/build/community/\($a)/\($n)" and .RW == true)
    and ($m[] | select(.Destination == "/var/cache/pacman/shared") | .RW == false)
    and ([$m[] | select(.Source | startswith("\($w)/cache"))] | length) == 2' >/dev/null \
    || fail "task $i's caches: $("$RT" inspect "$(name "$i")" | jq -c '[.[0].Mounts[] | {Source, Destination, RW}]')"
  grep -q '^== shared write: .*Read-only' "$(log_of "$i")" || fail "task $i could write the shared pacman cache: $(grep '== shared write' "$(log_of "$i")")"
  grep -qx '== build cache: ' "$(log_of "$i")" || fail "task $i saw another cache: $(grep '== build cache' "$(log_of "$i")")"
  grep -q '^== outside: .*cache' "$(log_of "$i")" || fail "task $i's /build: $(grep '== outside' "$(log_of "$i")")"
  grep -q 'marker-project\|own-cache-[ab]' <(grep '== outside' "$(log_of "$i")") && fail "task $i reached past its cache: $(grep '== outside' "$(log_of "$i")")"
done
grep -q '^== escapes tried' "$(log_of 30)" || fail "cache-a's recipe did not try its escapes: $(cat "$(log_of 30)")"
# Both downloaded into their own caches meanwhile, never into the shared one.
[[ -z "$(ls -A "$tmp/work/cache/pacman/$arch")" ]] || fail "a build wrote into the shared pacman cache: $(ls -A "$tmp/work/cache/pacman/$arch")"
finish 30; finish 31
all_completed() { local i; for i; do reported "$i" complete || return 1; done; }
until_ 60 "tasks 30 and 31 completed" all_completed 30 31
lib="libfixture-1.0-1-$arch.pkg.tar.zst"
merged() { [[ -f "$tmp/work/cache/pacman/$arch/$lib" ]]; }
until_ 60 "the dependency merged into the shared pacman cache" merged
want_sha="$(printf 'omarchy-pool fixture package %s (%s) for %s\n' libfixture libfixture "$arch" | sha256sum | cut -c1-64)"
[[ "$(sha256sum "$tmp/work/cache/pacman/$arch/$lib" | cut -c1-64)" == "$want_sha" ]] || fail "the merged dependency is not the bytes the signed database lists"
sleep 2
[[ "$(ls -A "$tmp/work/cache/pacman/$arch")" == "$lib" ]] || fail "the shared pacman cache holds more than the signed bytes: $(ls -A "$tmp/work/cache/pacman/$arch")"
[[ -z "$(ls -A "$tmp/work/cache/incoming/$arch" 2>/dev/null)" ]] || fail "downloads left aside: $(ls -A "$tmp/work/cache/incoming/$arch")"
grep -q 'caches: the downloads of' "$tmp/dispatcher.log" || fail "the merge-back was not said"
jq -r 'select(.path | test("^/(core|packages)/")) | .path' "$tmp/requests.jsonl" | grep -qx "/core/$arch/omarchy-core-edge.db.sig" || fail "the databases' signatures were not asked of the pool"
# Each build's cache holds what it wrote, and only that; the project cache of the same name is untouched.
[[ "$(ls -A "$tmp/work/cache/build/community/$arch/cache-a")" == own-cache-a ]] || fail "cache-a's build cache: $(ls -A "$tmp/work/cache/build/community/$arch/cache-a")"
[[ "$(ls -A "$tmp/work/cache/build/community/$arch/cache-b")" == own-cache-b ]] || fail "cache-b's build cache: $(ls -A "$tmp/work/cache/build/community/$arch/cache-b")"
[[ "$(ls -A "$tmp/work/cache/build/project/$arch/cache-a")" == marker-project ]] || fail "the project cache was touched: $(ls -A "$tmp/work/cache/build/project/$arch/cache-a")"
# cache-a's recipe tried to write past its cache, by every road it had: nothing it planted is anywhere in the host's cache tree.
planted="$(find "$tmp/work/cache" -name planted -print 2>/dev/null)"
[[ -z "$planted" ]] || fail "a recipe wrote past its own cache: $planted"
echo "ok: two builds at once each mount their own package's build cache and the shared pacman cache read-only; only the signed bytes are merged back"
# The next build finds the dependency there, read-only, as merged.
give 32 cache-c 1
until_ 60 "task 32 completed" reported 32 complete
tail32="$(report 32 complete | jq -r '.log_tail')"
grep -qx "== shared sha: $want_sha $lib" <<<"$tail32" || fail "task 32 did not find the merged dependency: $tail32"
grep -q '^== shared write: .*Read-only' <<<"$tail32" || fail "task 32 could write the shared pacman cache: $tail32"
echo "ok: the next build finds the merged dependency in the shared pacman cache, read-only"
stop 15
echo "ok: the dispatcher on a real engine ($RT, $STUB_IMAGE)"
