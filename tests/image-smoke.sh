#!/usr/bin/env bash
# Every role of the worker image starts (#277, part 3): the release runs this
# on the image it just pushed as `:<arch>-vX.Y.Z` only, before `:<arch>` and
# `:latest` move (release.yml), and CI on a local build of this commit
# (ci.yml). A role that does not start stops the release before any host can
# pull it: a dispatcher that crash-loops never claims, and every host's agent
# follows the release.
#
#   dispatcher  `pkg-repo dispatch` through its entrypoint (#335): refuses a signing key in its environment; without one it
#               re-adopts nothing, answers /ready on loopback, claims with want 0 (no capacity file) and leaves on SIGTERM —
#               its worker token from a read-only file, as the host set mounts it (OMARCHY_WORKER_TOKEN_FILE, #327)
#   egress      `pkg-repo egress` through its entrypoint (#336): it listens, and refuses cloud metadata (403) and a POST (405)
#   agent       a task's agent sidecar through its entrypoint (#336): its keys file read, it answers on :8790 (GET /, a 404:
#               /health would spend a completion) and has no pool path (#346: /pool/... is a 404 too)
#   builder     `omarchy-build-worker --self-test`
#   pool        a legacy project registration's worker, for whatever of a legacy set is left until it is retired (#346), against
#               a stub pool that answers who it is and has no work: `pkg-repo work --self-test`; then `pkg-repo work` itself
#               starts as a worker does — it identifies its container through the socket, reads its set, and sends its first
#               claim (#277's fields in it) — and exits on the empty answer (--idle-exit)
#   updater, broker  gone (#346): refused at once, with the pointer to the maintainer-host docs
#
# usage: tests/image-smoke.sh <image>      (docker; RUNTIME=podman for podman)
set -euo pipefail
image="${1:?usage: tests/image-smoke.sh <image>}"
RT="${RUNTIME:-docker}"
tmp="$(mktemp -d)"; sidecar=""; stub=""; egress=""; dispatcher=""
# The dispatcher writes its state under the work root as the container's user, which the
# runner's user may not remove: what rm cannot, a container of the image removes.
cleanup() {
  for c in "$sidecar" "$egress" "$dispatcher"; do [[ -z "$c" ]] || "$RT" rm -f "$c" >/dev/null 2>&1 || true; done; [[ -z "$stub" ]] || kill "$stub" 2>/dev/null || true
  rm -rf "$tmp" 2>/dev/null || { [[ -z "${image:-}" ]] || "$RT" run --rm --security-opt label=disable -v "$tmp:$tmp" --entrypoint rm "$image" -rf "$tmp/work" >/dev/null 2>&1; rm -rf "$tmp"; }
}
trap cleanup EXIT
fail() { echo "image smoke: FAIL — $*" >&2; exit 1; }
sock="${DOCKER_SOCKET:-/var/run/docker.sock}"
# The image by its content id: the dispatcher's sidecars run it (OMARCHY_WORKER_IMAGE must be a digest).
self_id="$("$RT" image inspect --format '{{.Id}}' "$image")"; self_id="sha256:${self_id#sha256:}"
arch="$(uname -m)"; [[ "$arch" == arm64 ]] && arch=aarch64

# The legacy sets' updater and broker roles are gone (#346): refused before anything starts, with where a machine goes now.
for gone in updater broker; do
  if out="$("$RT" run --rm -e OMARCHY_WORKER_ROLE="$gone" -e OMARCHY_WORKER_TOKEN=omw_smoke "$image" 2>&1)"; then fail "the $gone role started: $out"; fi
  grep -q "the $gone role is gone (#346)" <<<"$out" || fail "the $gone role's refusal: $out"
done
label="$("$RT" image inspect -f '{{index .Config.Labels "com.omarchy.updater.follows"}}' "$image")"
[[ -z "$label" || "$label" == "<no value>" ]] || fail "the image still says an updater follows the pool: $label"
echo "ok: no updater and no broker role"

# A stub pool on the runner: who a worker token is (a project registration of this architecture), and no work for its claim (204,
# the claim's body kept for the checks below); nothing else.
cat > "$tmp/pool.py" <<'P'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/v1/factory/workers/self" and self.headers.get("authorization") == "Bearer omw_smoke":
            body = json.dumps({"id": "smoke-pool-" + sys.argv[1], "trust": "project", "arch": sys.argv[1], "owner": "smoke"}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        if self.path == "/api/v1/factory/claim" and self.headers.get("authorization") == "Bearer omw_smoke":
            with open(sys.argv[2], "ab") as f: f.write(body + b"\n")
            self.send_response(204); self.end_headers()
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a): pass
s = HTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
P
python3 "$tmp/pool.py" "$arch" "$tmp/claims" > "$tmp/port" & stub=$!
for _ in $(seq 1 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(head -1 "$tmp/port")"; [[ -n "$port" ]] || fail "the stub pool did not start"

# A legacy project worker, through its entrypoint (the pool role): pkg-repo work's self-test, then the worker itself to its first
# claim and out on the empty answer. Its keyrings are marked fresh, so it fetches nothing upstream, and
# every call goes to the stub (OMARCHY_API, OMARCHY_POOL): nothing here reaches a real pool.
out="$("$RT" run --rm --network host -v "$sock:/var/run/docker.sock" -e OMARCHY_API="http://127.0.0.1:$port" -e OMARCHY_POOL="http://127.0.0.1:$port" \
  -e OMARCHY_WORKER_TOKEN=omw_smoke -e OMARCHY_WORKER_ROLE=pool -e OMARCHY_WORK_DIR=/var/tmp/omarchy-smoke \
  --entrypoint bash "$image" -c 'omarchy-worker --self-test && mkdir -p /var/tmp/omarchy-smoke/keyrings && touch /var/tmp/omarchy-smoke/keyrings/archlinux.gpg /var/tmp/omarchy-smoke/keyrings/.fetched && timeout 120 omarchy-worker --idle-exit 1' 2>&1)" \
  || fail "the project worker did not start: $out"
grep -q '^pkg-repo work --self-test: ok' <<<"$out" || fail "pkg-repo work's self-test: $out"
grep -q "worker ($arch) ready" <<<"$out" || fail "pkg-repo work did not start as a worker: $out"
grep -q "no work for 30s; exiting" <<<"$out" || fail "pkg-repo work did not claim and leave on the empty answer: $out"
[[ -s "$tmp/claims" ]] || fail "the stub pool received no claim: $out"
jq -e --arg a "$arch" '.arch == $a and (.instance != null) and (.orders | type == "array" and index("drain") != null) and (.rollout | type == "object")' <<<"$(head -n1 "$tmp/claims")" >/dev/null \
  || fail "its first claim does not say which process it is, what it takes and what rolls its set out: $(head -n1 "$tmp/claims")"
echo "ok: the project worker ($(grep -o '^pkg-repo work --self-test: ok ([^)]*)' <<<"$out"); started, claimed, and left on no work)"

# An agent sidecar: its keys file read (no key in it: GitHub only), it answers on :8790, and it has no pool path (#346).
printf 'FACTORY_MODEL=smoke\n' > "$tmp/agent.env"; chmod 644 "$tmp/agent.env"
sidecar="$("$RT" run -d --security-opt label=disable -v "$tmp/agent.env:/run/omarchy/agent.env:ro" -e OMARCHY_WORKER_ROLE=agent -e OMARCHY_AGENT_ENV=/run/omarchy/agent.env "$image")"
code=000
for _ in $(seq 1 60); do
  code="$("$RT" exec "$sidecar" curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8790/ 2>/dev/null || true)"
  [[ "$code" != 000 && -n "$code" ]] && break
  [[ "$("$RT" inspect -f '{{.State.Running}}' "$sidecar" 2>/dev/null)" == true ]] || fail "the agent sidecar exited: $("$RT" logs "$sidecar" 2>&1 | tail -n 20)"
  sleep 1
done
[[ "$code" == 404 ]] || fail "the agent sidecar does not answer on :8790 (got $code): $("$RT" logs "$sidecar" 2>&1 | tail -n 20)"
[[ "$("$RT" exec "$sidecar" curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST http://127.0.0.1:8790/pool/factory/claim 2>/dev/null)" == 404 ]] || fail "the agent sidecar has a pool path"
"$RT" rm -f "$sidecar" >/dev/null; sidecar=""
echo "ok: the agent sidecar answers, with no pool path"

# The builder.
out="$("$RT" run --rm --entrypoint omarchy-build-worker "$image" --self-test 2>&1)" || fail "the builder's self-test: $out"
grep -q '^omarchy-build-worker --self-test: ok' <<<"$out" || fail "the builder's self-test: $out"
echo "ok: the builder"

# The dispatcher: a signing key in its environment stops it at once (S5) …
out="$("$RT" run --rm --network host -v "$sock:/var/run/docker.sock" -e OMARCHY_WORKER_ROLE=dispatcher -e SIGNING_KEY=smoke \
  -e OMARCHY_WORKER_TOKEN=omw_smoke -e OMARCHY_WORK_ROOT="$tmp/work" -e OMARCHY_API="http://127.0.0.1:$port" "$image" 2>&1)" \
  && fail "the dispatcher started with a signing key: $out"
grep -q 'never holds a package signing key' <<<"$out" || fail "the dispatcher's refusal of a signing key: $out"
# … and without one it re-adopts (nothing here), answers /ready on loopback, claims with want 0 (no capacity file), and stops on SIGTERM.
# Its token is a read-only file, as the host set mounts the agent's run/host/dispatcher/token (#327): 0400 and the runner's,
# as the agent's is its user's, which the container's root reads as it does on a host; the stub pool takes the claim only
# with that token, and `docker inspect` shows none in the container's environment.
: > "$tmp/claims"; mkdir -p "$tmp/work"; printf 'omw_smoke\n' > "$tmp/token"; chmod 400 "$tmp/token"
dispatcher="omarchy-smoke-dispatcher-$$"
out="$("$RT" run --name "$dispatcher" --network host --security-opt label=disable -v "$sock:/var/run/docker.sock" -v "$tmp/work:$tmp/work" -e OMARCHY_WORKER_ROLE=dispatcher \
  -v "$tmp/token:/run/omarchy/worker-token:ro" -e OMARCHY_WORKER_TOKEN_FILE=/run/omarchy/worker-token \
  -e OMARCHY_WORK_ROOT="$tmp/work" -e OMARCHY_API="http://127.0.0.1:$port" -e OMARCHY_POOL="http://127.0.0.1:$port" \
  -e OMARCHY_WORKER_IMAGE="$self_id" --entrypoint bash "$image" -c 'omarchy-worker --ready 127.0.0.1:18791 & p=$!; ok=""; for _ in $(seq 1 60); do curl -sf http://127.0.0.1:18791/ready >/dev/null && { ok=1; break; }; sleep 1; done; sleep 4; kill -TERM $p; wait $p; echo "ready=${ok:-no}"' 2>&1)" \
  || fail "the dispatcher did not start: $out"
grep -q '^ready=1$' <<<"$out" || fail "the dispatcher never answered /ready: $out"
[[ -s "$tmp/claims" ]] || fail "the dispatcher sent no claim: $out"
jq -e '.want == 0 and (.claim_id | startswith("c_")) and .leases == [] and (.orders | index("stop-task") != null)' <<<"$(head -n1 "$tmp/claims")" >/dev/null \
  || fail "the dispatcher's first claim: $(head -n1 "$tmp/claims")"
cenv="$("$RT" inspect "$dispatcher" | jq -c '.[0].Config.Env')"
[[ "$cenv" != *omw_* && "$cenv" != *OMARCHY_WORKER_TOKEN=* ]] || fail "the dispatcher's environment holds the token: $cenv"
"$RT" rm -f "$dispatcher" >/dev/null; dispatcher=""
echo "ok: the dispatcher (refuses a signing key; ready, claimed with the token of its read-only file (0400), none in its environment, stopped on SIGTERM)"

# The egress sidecar's role: it listens, refuses cloud metadata and any method but CONNECT, GET and HEAD.
egress="omarchy-smoke-egress-$$"
"$RT" run -d --name "$egress" --network host --read-only --cap-drop ALL -e OMARCHY_WORKER_ROLE=egress "$image" --listen 127.0.0.1:18792 >/dev/null || fail "the egress did not start"
code=""; for _ in $(seq 1 30); do code="$(curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:18792 http://169.254.169.254/latest/meta-data/ || true)"; [[ "$code" == 000 ]] || break; sleep 1; done
[[ "$code" == 403 ]] || fail "the egress let cloud metadata through, or did not answer: $code ($("$RT" logs "$egress" 2>&1 | tail -n3))"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -x http://127.0.0.1:18792 -X POST http://example.org/)" == 405 ]] || fail "the egress took a POST"
echo "ok: the egress (refuses cloud metadata and a POST)"

echo "image smoke: every role of $image starts"
