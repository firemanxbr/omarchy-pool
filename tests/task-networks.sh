#!/usr/bin/env bash
# Task networks on a real engine (#336, design v2 §9.4, §9.5, §10.2 inv. 3, 6, 8):
# `pkg-repo dispatch` on this machine, a stubbed pool, the worker image for
# the sidecars (the real egress proxy and the real agent sidecar), and a stub
# release checkout whose build script is a probe task. Two tasks run at once:
# A, a draft (a model kind: an agent sidecar), and B, a contributor's build.
#
#   1. from inside a task container: a public mirror answers through its
#      egress sidecar (CONNECT and a plain GET); 169.254.169.254 is refused by
#      the egress and unreachable directly; a public name that resolves to
#      loopback is refused; a raw socket to a public address fails with
#      "Network is unreachable"; the host's LAN address and its upstream
#      router are unreachable; so is its own network's gateway (.1, where the
#      engine puts the host's own address on the bridge) on a listener this
#      test opens on 0.0.0.0, and on 22 and 53 — on docker (its isolated
#      gateway mode) and podman's CLI (no DNS on the network); behind podman's
#      docker API the engine cannot be asked, prep-root.sh's INPUT drop is the
#      seam there and the test says so; the other task's container, egress and agent
#      sidecar are unreachable directly and refused through the egress; the
#      task's own agent sidecar answers
#   2. the probe sidecar's word reaches the claim (`agent`): with a key the
#      provider refuses, it says so, which shows the agent sidecar's way out
#   3. a package with a signed exception in factory/sizing gets a bridge
#      network, and its raw socket reaches the internet
#   4. stopping A removes its container, its egress and agent sidecars and its
#      network, and nothing of B's
#
# Every container, network and image it makes is labelled with this run's own
# host id and removed at the end; nothing else on the engine is touched.
#
# Requires: cargo (or PKG_REPO=<a built pkg-repo>), python3, jq, docker or
# podman, the internet, and a worker image with this commit's pkg-repo,
# entrypoint and broker (WORKER_IMAGE, default omarchy-worker:ci, which the
# ci.yml image job builds).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
RT="${RUNTIME:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
WORKER_IMAGE="${WORKER_IMAGE:-omarchy-worker:ci}"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
host="h_net-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
stub="" disp="" gwl="" built=()
cleanup() {
  [[ -z "$disp" ]] || kill -9 "$disp" 2>/dev/null || true
  [[ -z "$stub" ]] || kill "$stub" 2>/dev/null || true
  [[ -z "$gwl" ]] || kill "$gwl" 2>/dev/null || true
  local c
  for c in $("$RT" ps -aq --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" kill "$c" >/dev/null 2>&1 || true; "$RT" rm -f "$c" >/dev/null 2>&1 || true; done
  for c in $("$RT" network ls -q --filter "label=org.omarchy-pool.agent.host=$host" 2>/dev/null); do "$RT" network rm "$c" >/dev/null 2>&1 || true; done
  for c in "${built[@]}"; do "$RT" rmi "$c" >/dev/null 2>&1 || true; done
  rm -rf "$tmp" 2>/dev/null || { "$RT" run --rm --entrypoint rm -v "$tmp:$tmp" "$build_id" -rf "$tmp/work" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null; } || true
}
trap cleanup EXIT
fail() {
  echo "task-networks: FAIL — $*" >&2
  [[ -f "$tmp/dispatcher.log" ]] && tail -n 40 "$tmp/dispatcher.log" >&2
  "$RT" ps -a --filter "label=org.omarchy-pool.agent.host=$host" --format '{{.Names}} {{.Status}}' >&2 || true
  local f; for f in "$tmp"/work/tasks/*/log/net.txt; do [[ -f "$f" ]] && { echo "== $f" >&2; cat "$f" >&2; }; done
  exit 1
}

if [[ -z "${PKG_REPO:-}" ]]; then
  (cd "$root" && cargo build -q -p pkg-repo)
  PKG_REPO="$root/target/debug/pkg-repo"
fi
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64
id_of() { local i; i="$("$RT" image inspect --format '{{.Id}}' "$1")"; echo "sha256:${i#sha256:}"; }
worker_id="$(id_of "$WORKER_IMAGE")" || fail "no worker image $WORKER_IMAGE (build it, or set WORKER_IMAGE)"
# The build image: the worker image without its entrypoint (it has bash and curl for the probe task).
# FROM names the image by its tag: BuildKit (docker's builder) reads a bare image id as a
# docker.io name and cannot resolve it; buildah (podman) takes either.
mkdir -p "$tmp/build-image"
printf 'FROM %s\nLABEL org.omarchy-pool.agent.host=%s\nENTRYPOINT []\n' "$WORKER_IMAGE" "$host" > "$tmp/build-image/Containerfile"
build_id="$("$RT" build -q -f "$tmp/build-image/Containerfile" "$tmp/build-image" | tail -n1)"; build_id="sha256:${build_id#sha256:}"
built+=("$build_id")
subnets="10.$((200 + RANDOM % 50)).$(( (RANDOM % 16) * 16 )).0/20"

# The host's LAN address and its upstream router, as this machine sees them (a container must reach neither).
if command -v ip >/dev/null 2>&1; then
  read -r router lan < <(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i <= NF; i++) { if ($i == "via") r = $(i + 1); if ($i == "src") s = $(i + 1) } } END { print r, s }')
else
  router="$(route -n get default 2>/dev/null | awk '/gateway:/ { print $2 }')"; lan="$(ipconfig getifaddr en0 2>/dev/null || true)"
fi
router="${router:-192.168.0.1}"; lan="${lan:-192.168.0.2}"

# A service of the host on every address: a task must not reach it through its network's gateway.
gw_port=$((22000 + RANDOM % 2000))
python3 -c 'import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", int(sys.argv[1]))); s.listen(16)
while True: s.accept()[0].close()' "$gw_port" & gwl=$!
# Behind podman's docker API the gateway stays the host's (the engine forces DNS on and drops docker's option).
gw_expected=closed
if [[ "$(basename "$RT")" != podman ]] && "$RT" version --format '{{json .Server.Components}}' 2>/dev/null | grep -q Podman; then gw_expected=seam; fi

# The release checkout: the probe task, and a sizing file that gives one package its exception.
mkdir -p "$tmp/checkout/factory/worker" "$tmp/checkout/factory/sizing" "$tmp/work" "$tmp/secrets"
printf 'schema = 1\n[package."probe-direct"]\nnetwork = "direct"\nreason = "the network test: a raw socket"\n' > "$tmp/checkout/factory/sizing/tasks.toml"
cat > "$tmp/checkout/factory/worker/omarchy-build-worker.sh" <<'STUB'
#!/usr/bin/env bash
# The probe task: once the test has written its targets, what this container can and cannot reach.
set -uo pipefail
source /task/in/meta.sh
exec > /task/log/task.log 2>&1
for _ in $(seq 120); do [[ -f /task/in/targets ]] && break; sleep 1; done
source /task/in/targets
out=/task/log/net.tmp; : > "$out"
say() { echo "$1=$2" >> "$out"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@" 2>/dev/null || true; }
raw() { timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2>&1 && echo reached || true; }
raw_patient() { local r; for _ in 1 2 3; do r="$(timeout 15 bash -c "exec 3<>/dev/tcp/$1/$2" 2>&1 && echo reached)"; [[ "$r" == *reached* || "$r" == *unreachable* ]] && break; sleep 2; done; echo "${r:-timed out}"; }
say pub_connect "$(code -I https://geo.mirror.pkgbuild.com/)"
say pub_get "$(code -I http://geo.mirror.pkgbuild.com/)"
say meta_proxy "$(code http://169.254.169.254/latest/meta-data/)"
say rebind_proxy "$(code http://localtest.me/)"
say meta_direct "$(curl -s --noproxy '*' --max-time 5 http://169.254.169.254/ >/dev/null 2>&1 && echo reached || echo failed)"
say raw_public "$(raw_patient 1.1.1.1 443 | tr '\n' ' ')"
say lan_direct "$(raw "$LAN" 22 | grep -c reached)"
say router_direct "$(raw "$ROUTER" 80 | grep -c reached)"
for p in $GW_PORT 22 53; do say "gw_direct_$p" "$(raw "$GATEWAY" "$p" | grep -c reached)"; done
for t in $OTHER; do say "other_direct_$t" "$(raw "${t%:*}" "${t#*:}" | grep -c reached)"; done
say other_agent_proxy "$(code "http://$OTHER_AGENT:8790/health")"
if [[ -n "${ANTHROPIC_BASE_URL:-}" ]]; then say own_agent "$(code "$ANTHROPIC_BASE_URL/health")"; fi
# Whole, then said done: a reader on the host (a VM's shared directory) never sees half of it.
mv /task/log/net.tmp /task/log/net.txt && touch /task/log/net.done
while [[ ! -e /task/in/finish ]]; do sleep 1; done
echo '{"status":4,"final":true,"needs_native":false,"error":"a probe task"}' > /task/out/verdict.json
exit 4
STUB
# The agent's keys: a key the provider refuses, so the probe's answer shows the sidecar reached it.
printf 'FACTORY_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-not-a-real-key\n' > "$tmp/secrets/agent.env"

# The pool: who the host is, tasks one per claim (then 204), heartbeats by beats/<id>, every request kept.
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
        with open(f"{d}/requests.jsonl", "a") as f: f.write(json.dumps({"method": self.command, "path": self.path, "body": body}) + "\n")
    def do_GET(self):
        self.record()
        # Who the host is answers only to its worker token, as the pool does.
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
        if m and os.path.exists(f"{d}/beats/{m.group(1)}"):
            return self.send(409, {"error": "stopped", "stop": True, "state": "cancelled"})
        return self.send(200, {})
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(f"{d}/port", "w").write(str(srv.server_address[1]))
srv.serve_forever()
P
python3 "$tmp/pool.py" "$tmp" "$host" & stub=$!
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(cat "$tmp/port")"; ready_port=$((20000 + RANDOM % 2000))
printf '{"schema":2,"at":"2026-10-02T00:00:00Z","cpus":12,"mem_gb":32,"page_kb":4,"disk_free_gb":{"work":200,"engine":150},"units":11,"job_reserved":1,"agent_slots":2,"lanes":[{"arch":"%s","mode":"native"}],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}\n' "$arch" > "$tmp/capacity.json"
gen() { printf 'g_%016x' "$1"; }
name() { echo "omarchy-task-$1-$(gen "$1")"; }
give() { # id name ref — one task for the next claim
  jq -cn --argjson id "$1" --arg n "$2" --arg r "$3" --arg a "$arch" --arg g "$(gen "$1")" \
    '{task:{id:$id,kind:"build",name:$n,arch:$a,trust:"community",pkgbuild_ref:$r,params:{},attempts:1,max_attempts:3,publish:1,lease_gen:$g,units:2,disk_gb:0,release:"v9.9.9"},token:("omj.secret-of-" + ($id|tostring)),lease_minutes:30}' >> "$tmp/tasks.jsonl"
}
until_() { local n="$1" what="$2"; shift 2; for _ in $(seq "$n"); do "$@" && return 0; sleep 1; done; fail "after ${n}s: $what"; }
running() { [[ "$("$RT" inspect --format '{{.State.Status}}' "$1" 2>/dev/null)" == running ]]; }
ip_on() { "$RT" inspect "$1" | jq -r --arg n "$2" '.[0].NetworkSettings.Networks[$n].IPAddress'; }
# A network's .1, where the engine would put the host's own address: from its subnet (an isolated one lists no gateway).
gateway_of() { "$RT" network inspect "$1" | jq -r '.[0] | (.IPAM.Config[0].Subnet // .subnets[0].subnet)' | awk -F'[./]' '{ print $1 "." $2 "." $3 "." $4 + 1 }'; }
result() { sed -n "s/^$2=//p" "$tmp/work/tasks/$1-$(gen "$1")/log/net.txt"; }
done_() { [[ -f "$tmp/work/tasks/$1-$(gen "$1")/log/net.done" ]]; }
gone() { ! "$RT" inspect --type container "$1" >/dev/null 2>&1; }
net_gone() { ! "$RT" network inspect "$1" >/dev/null 2>&1; }

give 1 probe-a "draft:probe-a"
give 2 probe-b "https://example.invalid/b@v1:PKGBUILD"
env -u SIGNING_KEY -u GITHUB_TOKEN -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u OPENAI_API_KEY -u GEMINI_API_KEY -u XAI_API_KEY OMARCHY_BUILD_IMAGE_AARCH64="$build_id" OMARCHY_BUILD_IMAGE_X86_64="$build_id" \
  OMARCHY_WORKER_IMAGE="$worker_id" OMARCHY_TASK_SUBNETS="$subnets" OMARCHY_SECRETS_DIR="$tmp/secrets" \
  "$PKG_REPO" dispatch --api "http://127.0.0.1:$port" --pool "http://127.0.0.1:$port" --worker-token omw_it \
    --work-root "$tmp/work" --capacity-file "$tmp/capacity.json" --checkout "$tmp/checkout" --ready "127.0.0.1:$ready_port" \
    --tick-s 1 --heartbeat-s 2 --idle-claim-s 1 >> "$tmp/dispatcher.log" 2>&1 & disp=$!
A="$(name 1)" B="$(name 2)"
until_ 180 "both probe tasks run" eval 'running "$A" && running "$B"'
running "$A-egress" && running "$A-agent" && running "$B-egress" || fail "the sidecars: $("$RT" ps -a --filter "label=org.omarchy-pool.agent.host=$host" --format '{{.Names}} {{.Status}}')"
running "$B-agent" && fail "a build without a model has an agent sidecar"
# Each task's targets: the host's addresses, and the other task's container, egress and agent.
targets() { # me other
  local o="$2"
  {
    echo "LAN=$lan"; echo "ROUTER=$router"; echo "GATEWAY=$(gateway_of "$1")"; echo "GW_PORT=$gw_port"
    echo "OTHER='$(ip_on "$o" "$o"):22 $(ip_on "$o-egress" "$o"):3128 $( [[ "$o" == "$A" ]] && echo "$(ip_on "$A-agent" "$A"):8790")'"
    echo "OTHER_AGENT=$(ip_on "$A-agent" "$A")"
  } > "$tmp/targets.tmp"
  # Whole, then there: the probe task starts on the file's existence.
  mv "$tmp/targets.tmp" "$tmp/work/tasks/$3-$(gen "$3")/in/targets"
}
targets "$A" "$B" 1; targets "$B" "$A" 2
until_ 240 "both probe tasks reported" eval 'done_ 1 && done_ 2'

# ---------- 1. what a task container can reach ----------
for t in 1 2; do
  [[ "$(result "$t" pub_connect)" =~ ^[23] ]] || fail "task $t: a public mirror through CONNECT answered $(result "$t" pub_connect)"
  [[ "$(result "$t" pub_get)" =~ ^[23] ]] || fail "task $t: a public mirror through a plain GET answered $(result "$t" pub_get)"
  [[ "$(result "$t" meta_proxy)" == 403 ]] || fail "task $t: cloud metadata through the egress: $(result "$t" meta_proxy)"
  [[ "$(result "$t" rebind_proxy)" == 403 ]] || fail "task $t: a public name resolving to loopback: $(result "$t" rebind_proxy)"
  [[ "$(result "$t" meta_direct)" == failed ]] || fail "task $t reached 169.254.169.254 directly"
  [[ "$(result "$t" raw_public)" == *"Network is unreachable"* ]] || fail "task $t: a raw socket: $(result "$t" raw_public)"
  [[ "$(result "$t" lan_direct)" == 0 && "$(result "$t" router_direct)" == 0 ]] || fail "task $t reached the host's LAN address or its upstream router"
  for p in "$gw_port" 22 53; do
    if [[ "$gw_expected" == closed ]]; then
      [[ "$(result "$t" "gw_direct_$p")" == 0 ]] || fail "task $t reached the host through its network's gateway ($p)"
    elif [[ "$(result "$t" "gw_direct_$p")" != 0 ]]; then
      echo "note: task $t reached its network's gateway on $p — podman behind docker's API; prep-root.sh's INPUT drop (rootful) is what closes it"
    fi
  done
  for k in $(sed -n 's/^\(other_direct_[^=]*\)=.*/\1/p' "$tmp/work/tasks/$t-$(gen "$t")/log/net.txt"); do
    [[ "$(result "$t" "$k")" == 0 ]] || fail "task $t reached the other task: $k"
  done
done
[[ "$(result 2 other_agent_proxy)" == 403 ]] || fail "task B reached A's agent through its egress: $(result 2 other_agent_proxy)"
[[ "$(result 1 own_agent)" =~ ^[2-5][0-9][0-9]$ ]] || fail "task A's own agent sidecar did not answer: $(result 1 own_agent)"
echo "ok: a task reaches a public mirror through its egress only — not metadata, a name resolving to loopback, a raw socket ('Network is unreachable'), the host's LAN address or upstream router, its network's gateway ($gw_expected), the other task's container, egress or agent; its own agent answers"

# ---------- 2. the probe sidecar ----------
probe_said() { jq -c 'select(.path == "/api/v1/factory/claim") | .body.agent // empty' "$tmp/requests.jsonl" | tail -n1; }
until_ 120 "a claim with the probe's word" eval '[[ "$(probe_said | jq -r .probe 2>/dev/null)" == error ]]'
probe_said | jq -e '.error | test("401|nauthori|invalid")' >/dev/null || fail "the probe's word: $(probe_said)"
"$RT" ps -a --format '{{.Names}}' | grep -q '^omarchy-task-0-' && fail "a probe container was left behind"
echo "ok: the probe sidecar's answer reaches the claim — the provider refused the key, so the agent's way out works"

# ---------- 3. a signed exception: a bridge network ----------
give 3 probe-direct "https://example.invalid/c@v1:PKGBUILD"
C="$(name 3)"
until_ 120 "the exception's task runs" running "$C"
"$RT" network inspect "$C" | jq -e '.[0] | (.Internal == true or .internal == true) | not' >/dev/null || fail "the exception's network is internal"
running "$C-egress" && fail "the exception's task has an egress sidecar"
targets "$C" "$B" 3
until_ 300 "the exception's task reported" done_ 3
[[ "$(result 3 raw_public)" == reached* ]] || fail "the exception's raw socket: $(result 3 raw_public)"
echo "ok: a package with a signed exception gets a bridge network and its raw socket goes out; without one a raw socket fails 'Network is unreachable'"

# ---------- 4. a stop removes only that task's ----------
touch "$tmp/beats/1"
until_ 60 "task A's container, sidecars and network removed" eval 'gone "$A" && gone "$A-egress" && gone "$A-agent" && net_gone "$A"'
running "$B" && running "$B-egress" && ! net_gone "$B" || fail "task B was touched by A's stop"
echo "ok: stopping task A removes its container, its egress and agent sidecars and its network, and nothing of B's"
echo "ok: task networks on a real engine ($RT, $WORKER_IMAGE)"
