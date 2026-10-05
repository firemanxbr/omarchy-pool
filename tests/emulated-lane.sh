#!/usr/bin/env bash
# An emulated lane on a real engine (#338, design v2 §7.5; D33): on a machine
# whose kernel has qemu-user-static's binfmt handler for the other
# architecture (with the F flag), CI's x86_64 and aarch64 runners each
# emulating the other:
#
#   1. the agent's capacity probe turns the foreign lane on after its smoke
#      run — the foreign Arch image by digest runs /usr/bin/true, then
#      `pacman --version`, under --platform — and says how (`via: qemu`,
#      `page16k`); the envelope's `emulate = []` holds it off and runs
#      nothing for it; the handler disabled, the lane is held for a person
#      and the native lane stays (where this script may write the binfmt
#      table: root, or passwordless sudo);
#   2. one emulated build through the dispatcher: a stubbed pool hands it a
#      build of the foreign architecture on the emulated lane; its task
#      container runs that architecture under qemu (`uname -m` inside), told
#      `WORKER_LABELS={"emulated":true}` and nothing else of it; the stub
#      build script builds a real package there with the image's own bsdtar
#      and zstd (its .PKGINFO says the foreign architecture), and the
#      dispatcher uploads it and completes the task with its job token.
#
# Every container it starts is labelled with this run's own host id and
# removed at the end; the images it pulls are left for the next run.
#
# Requires: docker, qemu-user-static's binfmt handler for the other architecture, python3, jq,
# cargo (or AGENT=<a built omarchy-agent> and PKG_REPO=<a built pkg-repo>).
#   STUB_IMAGE  an image with bash, coreutils and df for this machine's architecture (default debian:stable-slim)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
RT=docker
STUB_IMAGE="${STUB_IMAGE:-docker.io/library/debian:stable-slim}"
# shellcheck source=tests/images.env
source "$here/images.env"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
host="h_emu-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
stub="" disp="" restore=""
cleanup() {
  [[ -z "$disp" ]] || kill -9 "$disp" 2>/dev/null || true
  [[ -z "$stub" ]] || kill "$stub" 2>/dev/null || true
  [[ -z "$restore" ]] || binfmt_write 1 || true
  local c
  for c in $("$RT" ps -aq --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" rm -f "$c" >/dev/null 2>&1 || true; done
  for c in $("$RT" network ls -q --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" network rm "$c" >/dev/null 2>&1 || true; done
  [[ -z "${worker_id:-}" ]] || "$RT" rmi "$worker_id" >/dev/null 2>&1 || true
  # What the task container wrote as root goes through one more container of the native stand-in, on this run's directory only.
  rm -rf "$tmp" 2>/dev/null || { "$RT" run --rm -v "$tmp:$tmp" "$STUB_IMAGE" rm -rf "$tmp/work" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null; } || true
}
trap cleanup EXIT
fail() {
  echo "emulated-lane: FAIL — $*" >&2
  [[ -f "$tmp/dispatcher.log" ]] && tail -n 40 "$tmp/dispatcher.log" >&2
  exit 1
}

native="$(uname -m)"; [[ "$native" == arm64 ]] && native=aarch64
case "$native" in
  x86_64) foreign=aarch64 platform=linux/arm64 image="$ARCHLINUXARM_BASE" ;;
  aarch64) foreign=x86_64 platform=linux/amd64 image="$ARCHLINUX_BASE" ;;
  *) fail "this machine is $native" ;;
esac
handler="/proc/sys/fs/binfmt_misc/qemu-$foreign"
if ! grep -qx enabled "$handler" 2>/dev/null || ! grep -q '^flags: .*F' "$handler"; then
  fail "no qemu-$foreign binfmt handler with the F flag here (CI installs qemu-user-static; by hand: factory/host/prep-root.sh)"
fi
# Writes the handler's switch (1 on, 0 off) as root.
binfmt_write() {
  if [[ "$(id -u)" == 0 ]]; then echo "$1" > "$handler"; else echo "$1" | sudo -n tee "$handler" >/dev/null; fi
}

if [[ -z "${AGENT:-}" || -z "${PKG_REPO:-}" ]]; then
  (cd "$root" && cargo build -q --locked -p omarchy-agent -p pkg-repo)
  AGENT="${AGENT:-$root/target/debug/omarchy-agent}"
  PKG_REPO="${PKG_REPO:-$root/target/debug/pkg-repo}"
fi
"$RT" image inspect "$STUB_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$STUB_IMAGE" >/dev/null
"$RT" image inspect "$image" >/dev/null 2>&1 || "$RT" pull -q --platform "$platform" "$image" >/dev/null
native_id="$("$RT" image inspect --format '{{.Id}}' "$STUB_IMAGE")"; native_id="sha256:${native_id#sha256:}"

# ---------- 1. the agent's capacity probe ----------
check() { python3 -c 'import json, sys; j = json.loads(sys.argv[1]); sys.exit(0 if eval(sys.argv[2]) else 1)' "$1" "$2" || fail "$3: $1"; }
mkdir -p "$tmp/work-root"
out="$("$AGENT" capacity --work-root "$tmp/work-root" --probe-image "$STUB_IMAGE" --emulate-image "$image")" || fail "capacity: $out"
echo "$out"
check "$out" "j['arch'] == '$native'" "the native lane"
check "$out" "j['emulation']['emulated'] == [{'arch': '$foreign', 'via': 'qemu', 'page16k': j['page_kb'] >= 16}]" "the $foreign lane is on after the smoke run"
check "$out" "j['emulation']['held_lanes'] == []" "nothing held"
echo "ok: the $foreign lane is on after its smoke run (pacman --version of $image under $platform)"

printf '[set]\nwork_root = "%s"\n[envelope]\nemulate = []\n' "$tmp/work-root" > "$tmp/agent.toml"
out="$("$AGENT" capacity --envelope "$tmp/agent.toml" --probe-image "$STUB_IMAGE" --emulate-image "$image")" || fail "capacity: $out"
check "$out" "j['emulation'] == {'emulated': [], 'held_lanes': [{'arch': '$foreign', 'reason': \"off: the envelope's emulate does not list it\"}]}" "emulate = [] keeps it off"
echo "ok: the envelope's emulate = [] keeps the lane off"

if [[ "$(id -u)" == 0 ]] || sudo -n true 2>/dev/null; then
  binfmt_write 0; restore=1
  out="$("$AGENT" capacity --work-root "$tmp/work-root" --probe-image "$STUB_IMAGE" --emulate-image "$image")" || fail "capacity: $out"
  binfmt_write 1; restore=""
  check "$out" "j['arch'] == '$native' and j['emulation']['emulated'] == []" "the native lane stays, the foreign one is off"
  check "$out" "j['emulation']['held_lanes'][0]['reason'].startswith('needs a person: prep-root.sh installs qemu-user-static-binfmt')" "held for a person"
  echo "ok: the handler disabled, the lane is held for a person and the native lane stays"
elif [[ -n "${CI:-}" ]]; then
  fail "CI must be able to switch the binfmt handler (root or passwordless sudo)"
else
  echo "skipped: switching the binfmt handler off needs root or passwordless sudo"
fi

# ---------- 2. one emulated build through the dispatcher ----------
# The worker image the sidecars run: a native stand-in that only sleeps (the egress proxy is tests/task-networks.sh's).
mkdir -p "$tmp/worker-image"
printf '#!/bin/sh\nexec sleep 100000\n' > "$tmp/worker-image/e"; chmod 755 "$tmp/worker-image/e"
printf 'FROM %s\nCOPY e /e\nLABEL org.omarchy-pool.agent.host=%s\nENTRYPOINT ["/e"]\n' "$STUB_IMAGE" "$host" > "$tmp/worker-image/Containerfile"
worker_id="$("$RT" build -q -f "$tmp/worker-image/Containerfile" "$tmp/worker-image" | tail -n1)"; worker_id="sha256:${worker_id#sha256:}"
subnets="10.$((200 + RANDOM % 50)).$(( (RANDOM % 16) * 16 )).0/20"

# The release checkout the task container mounts at /pool: a build script that builds a package where it runs, once told to.
mkdir -p "$tmp/checkout/factory/worker" "$tmp/work"
cat > "$tmp/checkout/factory/worker/omarchy-build-worker.sh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
source /task/in/meta.sh
exec > /task/log/task.log 2>&1
echo "uname -m: $(uname -m)"
echo "WORKER_LABELS=${WORKER_LABELS:-}"
while [[ ! -e /task/in/finish ]]; do sleep 1; done
mkdir -p /build/pkg/usr/share/emu
echo "built under $(uname -m)" > /build/pkg/usr/share/emu/hello
printf 'pkgname = %s\npkgver = 1.0-1\npkgdesc = an emulated build\narch = %s\nsize = 16\n' "$name" "$(uname -m)" > /build/pkg/.PKGINFO
(cd /build/pkg && bsdtar --zstd -cf "/task/out/$name-1.0-1-$(uname -m).pkg.tar.zst" .PKGINFO usr) || { echo '{"status":4,"final":true,"needs_native":false,"error":"bsdtar"}' > /task/out/verdict.json; exit 4; }
printf 'pkgname=%s\narch=(%s)\n' "$name" "$(uname -m)" > /task/out/PKGBUILD
echo '{"status":0,"final":false,"needs_native":false,"error":""}' > /task/out/verdict.json
echo "built $name for $(uname -m)"
STUB

# The pool: who the host is, the tasks of tasks.jsonl one per claim, every request in requests.jsonl, uploads under uploads/.
mkdir -p "$tmp/uploads"; : > "$tmp/tasks.jsonl"; : > "$tmp/requests.jsonl"
cat > "$tmp/pool.py" <<'P'
import json, os, sys
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
        return raw
    def do_GET(self):
        self.record()
        if self.path == "/api/v1/factory/workers/self": return self.send(200, {"id": host})
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
        if self.path.endswith("/heartbeat"): return self.send(200, {})
        return self.send(200, {})
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(f"{d}/port", "w").write(str(srv.server_address[1]))
srv.serve_forever()
P
python3 "$tmp/pool.py" "$tmp" "$host" & stub=$!
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(cat "$tmp/port")"; ready_port=$((18000 + RANDOM % 2000))
# The agent's file: this machine native, the foreign architecture emulated through qemu.
printf '{"schema":2,"at":"2026-10-01T00:00:00Z","cpus":4,"mem_gb":8,"page_kb":4,"disk_free_gb":{"work":200,"engine":150},"units":3,"job_reserved":1,"agent_slots":1,"lanes":[{"arch":"%s","mode":"native"},{"arch":"%s","mode":"emulated","via":"qemu","page16k":false}],"held_lanes":[],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}\n' "$native" "$foreign" > "$tmp/capacity.json"
gen=g_00000000000000e1
jq -cn --arg a "$foreign" --arg g "$gen" \
  '{task:{id:1,kind:"build",name:"emu",arch:$a,lane:"emulated",trust:"community",pkgbuild_ref:"https://example.invalid/emu@v1:PKGBUILD",params:{},attempts:1,max_attempts:3,publish:1,lease_gen:$g,units:2,disk_gb:0,release:"v9.9.9"},token:"omj.secret-of-1",lease_minutes:30}' >> "$tmp/tasks.jsonl"
var=OMARCHY_BUILD_IMAGE_X86_64; [[ "$foreign" == aarch64 ]] && var=OMARCHY_BUILD_IMAGE_AARCH64
other=OMARCHY_BUILD_IMAGE_AARCH64; [[ "$foreign" == aarch64 ]] && other=OMARCHY_BUILD_IMAGE_X86_64
env -u SIGNING_KEY -u OMARCHY_SECRETS_DIR -u GITHUB_TOKEN -u ANTHROPIC_API_KEY "$var=$image" "$other=$native_id" \
  OMARCHY_WORKER_IMAGE="$worker_id" OMARCHY_TASK_SUBNETS="$subnets" \
  "$PKG_REPO" dispatch --api "http://127.0.0.1:$port" --pool "http://127.0.0.1:$port" --worker-token omw_it \
    --work-root "$tmp/work" --capacity-file "$tmp/capacity.json" --checkout "$tmp/checkout" --ready "127.0.0.1:$ready_port" \
    --tick-s 1 --heartbeat-s 2 --idle-claim-s 1 --disk-floor-gb 1 >> "$tmp/dispatcher.log" 2>&1 & disp=$!
until_() { local n="$1" what="$2"; shift 2; for _ in $(seq "$n"); do "$@" && return 0; sleep 1; done; fail "after ${n}s: $what"; }
running() { [[ "$("$RT" inspect --format '{{.State.Status}}' "omarchy-task-1-$gen" 2>/dev/null)" == running ]]; }
reported() { jq -e --arg p "/api/v1/factory/tasks/1/$1" 'select(.path == $p)' "$tmp/requests.jsonl" >/dev/null 2>&1; }
both_lanes() { jq -e 'select(.path == "/api/v1/factory/claim") | .body.capacity.lanes | length == 2' "$tmp/requests.jsonl" >/dev/null 2>&1; }
log="$tmp/work/tasks/1-$gen/log/task.log"
until_ 60 "the dispatcher claimed with both lanes" both_lanes
until_ 180 "the emulated task's container runs (its image pulled for $platform)" running
said() { grep -q '^WORKER_LABELS=' "$log" 2>/dev/null; }
until_ 60 "the stub said where it runs" said
grep -qx "uname -m: $foreign" "$log" || fail "the task container does not run $foreign: $(cat "$log")"
grep -qx 'WORKER_LABELS={"emulated":true}' "$log" || fail "the emulated lane's container was not told so: $(cat "$log")"
env_names="$("$RT" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "omarchy-task-1-$gen" | cut -d= -f1 | sort -u | tr '\n' ' ')"
for v in $env_names; do
  case "$v" in MAKEFLAGS|NINJAFLAGS|CARGO_BUILD_JOBS|HTTP_PROXY|http_proxy|HTTPS_PROXY|https_proxy|NO_PROXY|no_proxy|WORKER_LABELS|PATH|HOME|HOSTNAME|TERM|LANG|LC_ALL|container|"") ;; *) fail "a variable outside the allowlist: $v ($env_names)" ;; esac
done
echo "ok: the emulated lane's task container runs $foreign under qemu, told WORKER_LABELS={\"emulated\":true} and nothing more"
touch "$tmp/work/tasks/1-$gen/in/finish"
until_ 300 "the emulated build completed" reported complete
done_body="$(jq -c 'select(.path == "/api/v1/factory/tasks/1/complete") | .body' "$tmp/requests.jsonl" | tail -n1)"
jq -e --arg f "emu-1.0-1-$foreign.pkg.tar.zst" '.filename == $f' <<<"$done_body" >/dev/null || fail "the completed build: $done_body"
[[ -s "$tmp/uploads/emu-1.0-1-$foreign.pkg.tar.zst" ]] || fail "the package was not uploaded: $(ls "$tmp/uploads")"
grep -q "arch=($foreign)" "$tmp/uploads/PKGBUILD" || fail "the recipe it staged: $(cat "$tmp/uploads/PKGBUILD")"
jq -e 'select(.path | test("/factory/tasks/1/")) | .auth == "Bearer omj.secret-of-1" or (.auth | startswith("Bearer omj."))' "$tmp/requests.jsonl" | grep -qv true && fail "a call for task 1 without its job token"
echo "ok: one emulated $foreign build on this $native machine — built under qemu, uploaded and completed with its job token"
kill "$disp" 2>/dev/null; wait "$disp" 2>/dev/null || true; disp=""
echo "ok: an emulated lane on a real engine ($native emulating $foreign)"
