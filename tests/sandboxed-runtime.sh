#!/usr/bin/env bash
# A sandboxed runtime for community tasks on a real engine (#330, design v2 §10.4; D43): a
# docker engine with gVisor's `runsc` registered (CI installs gVisor's pinned release and
# `runsc install`s it; by hand, any engine DOCKER_HOST names whose `docker info` lists runsc):
#
#   1. the agent's detection: `omarchy-agent capacity` finds runsc after its smoke run — the
#      Arch image by digest prints gVisor's kernel under `--runtime runsc`, not the engine's,
#      then answers `pacman --version` — and says {"runtime":"runsc","kind":"gvisor"}; the
#      envelope's `sandbox = "off"` runs nothing for it, one naming a runtime the engine does
#      not list holds it with why;
#   2. through the dispatcher, from a capacity file carrying what the agent found: a community
#      build runs in runsc — the engine's HostConfig.Runtime, the kernel its stub reads inside
#      gVisor's, its egress sidecar reached over its internal network — and completes; the
#      project's build beside it, and every sidecar, run on the engine's own runtime, on the
#      host's kernel; its claims say the sandbox it applies (`capacity.sandbox`);
#   3. a file naming a runtime the engine does not have: the community task fails `lost` before
#      anything of it runs, never on the engine's own runtime, and the claims hold (`want: 0`,
#      `capacity.sandbox_held` saying why).
#
# Every container it starts is labelled with this run's own host id and removed at the end.
#
# Requires: docker with runsc registered, python3, jq, cargo (or AGENT=<a built omarchy-agent> and
# PKG_REPO=<a built pkg-repo>).
#   STUB_IMAGE  an image with bash and coreutils for this machine's architecture (default debian:stable-slim)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
RT=docker
STUB_IMAGE="${STUB_IMAGE:-docker.io/library/debian:stable-slim}"
# shellcheck source=tests/images.env
source "$here/images.env"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
host="h_sbx-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
stub="" disp=""
cleanup() {
  [[ -z "$disp" ]] || kill -9 "$disp" 2>/dev/null || true
  [[ -z "$stub" ]] || kill "$stub" 2>/dev/null || true
  local c
  for c in $("$RT" ps -aq --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" rm -f "$c" >/dev/null 2>&1 || true; done
  for c in $("$RT" network ls -q --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" network rm "$c" >/dev/null 2>&1 || true; done
  [[ -z "${worker_id:-}" ]] || "$RT" rmi "$worker_id" >/dev/null 2>&1 || true
  # What the task containers wrote as root goes through one more container of the stand-in, on this run's directory only.
  rm -rf "$tmp" 2>/dev/null || { "$RT" run --rm -v "$tmp:$tmp" "$STUB_IMAGE" rm -rf "$tmp/work" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null; } || true
}
trap cleanup EXIT
fail() {
  echo "sandboxed-runtime: FAIL — $*" >&2
  [[ -f "$tmp/dispatcher.log" ]] && tail -n 40 "$tmp/dispatcher.log" >&2
  exit 1
}

if [[ "$("$RT" info --format '{{json .Runtimes}}' 2>/dev/null | jq -r 'has("runsc")')" != true ]]; then
  [[ -n "${CI:-}" ]] && fail "this engine lists no runsc runtime (CI installs gVisor before this script)"
  echo "skipped: this engine lists no runsc runtime (install gVisor and \`runsc install\`, or point DOCKER_HOST at an engine that has it)"
  exit 0
fi
native="$(uname -m)"; [[ "$native" == arm64 ]] && native=aarch64
case "$native" in
  x86_64) arch_image="$ARCHLINUX_BASE" ;;
  aarch64) arch_image="$ARCHLINUXARM_BASE" ;;
  *) fail "this machine is $native" ;;
esac
if [[ -z "${AGENT:-}" || -z "${PKG_REPO:-}" ]]; then
  (cd "$root" && cargo build -q --locked -p omarchy-agent -p pkg-repo)
  AGENT="${AGENT:-$root/target/debug/omarchy-agent}"
  PKG_REPO="${PKG_REPO:-$root/target/debug/pkg-repo}"
fi
engine_kernel="$("$RT" info --format '{{.KernelVersion}}')"

# ---------- 1. the agent's detection ----------
check() { python3 -c 'import json, sys; j = json.loads(sys.argv[1]); sys.exit(0 if eval(sys.argv[2]) else 1)' "$1" "$2" || fail "$3: $1"; }
mkdir -p "$tmp/work-root"
out="$("$AGENT" capacity --work-root "$tmp/work-root" --probe-image "$arch_image")" || fail "capacity: $out"
echo "$out" | jq -c '{arch, isolation, sandbox, sandbox_held}'
check "$out" "j['sandbox'] == {'runtime': 'runsc', 'kind': 'gvisor'}" "runsc is the sandbox after its smoke run"
sandbox="$(jq -c .sandbox <<<"$out")"
echo "ok: the agent finds gVisor's runsc after its smoke run ($arch_image under --runtime runsc, on a kernel that is not the engine's $engine_kernel)"
printf '[set]\nwork_root = "%s"\n[envelope]\nsandbox = "off"\n' "$tmp/work-root" > "$tmp/off.toml"
out="$("$AGENT" capacity --envelope "$tmp/off.toml" --probe-image "$arch_image")" || fail "capacity: $out"
check "$out" "j['sandbox'] is None and j['sandbox_held'] is None" "sandbox = \"off\" keeps none"
printf '[set]\nwork_root = "%s"\n[envelope]\nsandbox = "kata-not-here"\n' "$tmp/work-root" > "$tmp/named.toml"
out="$("$AGENT" capacity --envelope "$tmp/named.toml" --probe-image "$arch_image")" || fail "capacity: $out"
check "$out" "j['sandbox'] is None and j['sandbox_held'] == 'the envelope names kata-not-here: the engine lists no such runtime'" "a runtime the engine does not list"
echo "ok: the envelope's sandbox = \"off\" keeps none, and one naming a runtime the engine lacks is held with why"

# ---------- 2. through the dispatcher ----------
"$RT" image inspect "$STUB_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$STUB_IMAGE" >/dev/null
"$RT" image inspect "$BUSYBOX" >/dev/null 2>&1 || "$RT" pull -q "$BUSYBOX" >/dev/null
image_id="$("$RT" image inspect --format '{{.Id}}' "$STUB_IMAGE")"; image_id="sha256:${image_id#sha256:}"
# The worker image the sidecars run: a stand-in whose egress answers any GET with one line, whatever its arguments.
mkdir -p "$tmp/worker-image/www"
printf '#!/bin/sh\nexec httpd -f -p 3128 -h /www\n' > "$tmp/worker-image/e"; chmod 755 "$tmp/worker-image/e"
echo sandbox-egress-ok > "$tmp/worker-image/www/index.html"; chmod -R a+rX "$tmp/worker-image/www"
printf 'FROM %s\nCOPY e /e\nCOPY www /www\nLABEL org.omarchy-pool.agent.host=%s\nENTRYPOINT ["/e"]\n' "$BUSYBOX" "$host" > "$tmp/worker-image/Containerfile"
worker_id="$("$RT" build -q -f "$tmp/worker-image/Containerfile" "$tmp/worker-image" | tail -n1)"; worker_id="sha256:${worker_id#sha256:}"
subnets="10.$((200 + RANDOM % 50)).$(( (RANDOM % 16) * 16 )).0/20"

# The release checkout the task containers mount at /pool: a build script that says the kernel it runs on and what its
# egress sidecar answered, then builds once told to.
mkdir -p "$tmp/checkout/factory/worker" "$tmp/checkout/fixtures" "$tmp/work"
python3 - "$tmp/checkout/fixtures" "$native" <<'PY'
import io, sys, tarfile
for name in ("sbx", "proj"):
    info = f"pkgname = {name}\npkgver = 1.0-1\narch = {sys.argv[2]}\nsize = 1\n".encode()
    with tarfile.open(f"{sys.argv[1]}/{name}-1.0-1-{sys.argv[2]}.pkg.tar.zst", "w", format=tarfile.GNU_FORMAT) as t:
        ti = tarfile.TarInfo(".PKGINFO"); ti.size = len(info); t.addfile(ti, io.BytesIO(info))
PY
cat > "$tmp/checkout/factory/worker/omarchy-build-worker.sh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
source /task/in/meta.sh
exec > /task/log/task.log 2>&1
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64
echo "kernel: $(uname -r)"
# Its egress sidecar, on its own internal network: one GET through bash's /dev/tcp, within 20 s.
proxy="${HTTP_PROXY#http://}"
answer="$(timeout 20 bash -c 'exec 3<>"/dev/tcp/$0/$1" && printf "GET / HTTP/1.0\r\n\r\n" >&3 && cat <&3' "${proxy%:*}" "${proxy##*:}" 2>/dev/null | tail -n1)"
echo "egress: ${answer:-unreachable}"
while [[ ! -e /task/in/finish ]]; do sleep 1; done
cp "/pool/fixtures/$name-1.0-1-$arch.pkg.tar.zst" /task/out/; echo "pkgname=$name" > /task/out/PKGBUILD
echo '{"status":0,"final":false,"needs_native":false,"error":""}' > /task/out/verdict.json
echo "built $name"
STUB

# The pool: who the host is, the tasks of tasks.jsonl one per claim, every request in requests.jsonl.
: > "$tmp/tasks.jsonl"; : > "$tmp/requests.jsonl"
cat > "$tmp/pool.py" <<'P'
import json, sys
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
        with open(f"{d}/requests.jsonl", "a") as f: f.write(json.dumps({"method": self.command, "path": self.path, "body": body}) + "\n")
    def do_GET(self):
        self.record()
        if self.path == "/api/v1/factory/workers/self": return self.send(200, {"id": host})
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
        return self.send(200, {})
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(f"{d}/port", "w").write(str(srv.server_address[1]))
srv.serve_forever()
P
python3 "$tmp/pool.py" "$tmp" "$host" & stub=$!
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(cat "$tmp/port")"; ready_port=$((18000 + RANDOM % 2000))

capacity() { # the sandbox, as the agent wrote it
  printf '{"schema":2,"at":"2026-10-01T00:00:00Z","cpus":8,"mem_gb":16,"page_kb":4,"disk_free_gb":{"work":200,"engine":150},"units":7,"job_reserved":1,"agent_slots":1,"lanes":[{"arch":"%s","mode":"native"}],"held_lanes":[],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false,"sandbox":%s}\n' "$native" "$1" > "$tmp/capacity.json"
}
give() { # id name trust publish
  jq -cn --argjson id "$1" --arg n "$2" --arg a "$native" --arg t "$3" --argjson p "$4" --arg g "g_$(printf '%016x' "$1")" \
    '{task:{id:$id,kind:"build",name:$n,arch:$a,lane:"native",trust:$t,pkgbuild_ref:(if $t == "community" then "https://example.invalid/x@v1:PKGBUILD" else "0123abcd" end),params:{},attempts:1,max_attempts:3,publish:$p,lease_gen:$g,units:1,disk_gb:0,release:"v9.9.9"},token:("omj.secret-of-" + ($id|tostring)),lease_minutes:30}' >> "$tmp/tasks.jsonl"
}
gen() { printf 'g_%016x' "$1"; }
name() { echo "omarchy-task-$1-$(gen "$1")"; }
start() {
  env -u SIGNING_KEY -u OMARCHY_SECRETS_DIR -u GITHUB_TOKEN -u ANTHROPIC_API_KEY OMARCHY_BUILD_IMAGE_AARCH64="$image_id" OMARCHY_BUILD_IMAGE_X86_64="$image_id" \
    OMARCHY_WORKER_IMAGE="$worker_id" OMARCHY_TASK_SUBNETS="$subnets" \
    "$PKG_REPO" dispatch --api "http://127.0.0.1:$port" --pool "http://127.0.0.1:$port" --worker-token omw_it \
      --work-root "$tmp/work" --capacity-file "$tmp/capacity.json" --checkout "$tmp/checkout" --ready "127.0.0.1:$ready_port" \
      --tick-s 1 --heartbeat-s 2 --idle-claim-s 1 --disk-floor-gb 1 >> "$tmp/dispatcher.log" 2>&1 & disp=$!
  for _ in $(seq 60); do curl -sf "http://127.0.0.1:$ready_port/ready" >/dev/null 2>&1 && return 0; sleep 0.5; done
  fail "the dispatcher never answered /ready"
}
until_() { local n="$1" what="$2"; shift 2; for _ in $(seq "$n"); do "$@" && return 0; sleep 1; done; fail "after ${n}s: $what"; }
report() { jq -c --arg p "/api/v1/factory/tasks/$1/$2" 'select(.path == $p) | .body' "$tmp/requests.jsonl" | tail -n1; }
reported() { [[ -n "$(report "$1" "$2")" ]]; }
running() { [[ "$("$RT" inspect --format '{{.State.Status}}' "$(name "$1")" 2>/dev/null)" == running ]]; }
gone() { ! "$RT" inspect --type container "$(name "$1")" >/dev/null 2>&1; }
runtime_of() { "$RT" inspect --format '{{.HostConfig.Runtime}}' "$1"; }
log_of() { cat "$tmp/work/tasks/$1-$(gen "$1")/log/task.log" 2>/dev/null; }
said() { log_of "$1" | grep -q '^egress: '; }

capacity "$sandbox"
give 1 sbx community 1
give 2 proj project 0
start
both_running() { running 1 && running 2; }
both_done() { reported 1 complete && reported 2 complete; }
until_ 120 "both tasks run" both_running
until_ 60 "the community task said where it runs" said 1
until_ 60 "the project's task said where it runs" said 2
echo "community task: $(log_of 1 | tr '\n' ' ')"
echo "project's task: $(log_of 2 | tr '\n' ' ')"
[[ "$(runtime_of "$(name 1)")" == runsc ]] || fail "the community task's container runs on $(runtime_of "$(name 1)"), not runsc"
grep -qx "kernel: $engine_kernel" <<<"$(log_of 1)" && fail "the community task ran on the engine's own kernel: $(log_of 1)"
grep -qx "egress: sandbox-egress-ok" <<<"$(log_of 1)" || fail "the sandboxed task did not reach its egress sidecar: $(log_of 1)"
echo "ok: the community task runs in runsc — gVisor's kernel ($(log_of 1 | sed -n 's/^kernel: //p')), not the engine's — and reaches its egress sidecar on its internal network"
[[ "$(runtime_of "$(name 2)")" != runsc ]] || fail "the project's task runs in runsc"
grep -qx "kernel: $engine_kernel" <<<"$(log_of 2)" || fail "the project's task is not on the engine's kernel: $(log_of 2)"
for side in "$(name 1)-egress" "$(name 2)-egress"; do
  [[ "$(runtime_of "$side")" != runsc ]] || fail "$side runs in runsc"
done
echo "ok: the project's task and every sidecar run on the engine's own runtime ($(runtime_of "$(name 2)"))"
last_claim() { jq -c -s '[.[] | select(.path == "/api/v1/factory/claim") | .body] | last' "$tmp/requests.jsonl"; }
check "$(last_claim)" "j['capacity']['sandbox'] == {'runtime': 'runsc', 'kind': 'gvisor'}" "the claim says the sandbox it applies"
echo "ok: its claims say the sandbox it applies (capacity.sandbox)"
touch "$tmp/work/tasks/1-$(gen 1)/in/finish" "$tmp/work/tasks/2-$(gen 2)/in/finish"
until_ 120 "both tasks completed" both_done
until_ 30 "the community task's container removed" gone 1
echo "ok: both builds completed and went"

# ---------- 3. a runtime the engine does not have ----------
capacity '{"runtime":"runsc-not-here","kind":"gvisor"}'
give 3 sbx community 1
until_ 60 "task 3 failed" reported 3 fail
jq -e '.lost == true and .final == false' <<<"$(report 3 fail)" >/dev/null || fail "task 3: $(report 3 fail)"
gone 3 || fail "task 3's container is there"
grep -q "task 3: build sbx started" "$tmp/dispatcher.log" && fail "task 3 was started: $(grep 'task 3' "$tmp/dispatcher.log")"
held() { jq -e '.want == 0 and (.capacity.sandbox_held // "" | startswith("runsc-not-here refused task 3"))' <<<"$(last_claim)" >/dev/null; }
until_ 30 "a claim held for the sandbox" held
echo "ok: a runtime the engine does not have fails the community task lost before it runs, never on the engine's own runtime, and holds the claims: $(last_claim | jq -r .capacity.sandbox_held)"
kill "$disp" 2>/dev/null; wait "$disp" 2>/dev/null || true; disp=""
echo "ok: a sandboxed runtime on a real engine (docker $("$RT" version --format '{{.Server.Version}}'), runsc at $("$RT" info --format '{{json .Runtimes.runsc}}' | jq -r '.path // .runtimeType'))"
