#!/usr/bin/env bash
# The Rust worker (`pkg-repo work`) sends a build that died of emulation back
# for a native worker (#281): `pkg-repo work --once` against a stubbed pool
# that hands it the project's x86_64 review build, with a stubbed podman
# that plays the build container. On an emulated worker (the Studio's
# review-x86_64), the build script's exit 96 (a toolchain that cannot
# start) and a library the loader could not map (sudo through libldap)
# are reported `needs_native: true, final: false`; the same loader line on
# a native worker is a plain failure, retried; the gate's failure is final
# and a recipe's is neither. The log is on the record either way.
#
# Requires: cargo (or PKG_REPO=<a built pkg-repo>), python3, jq.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
stub_pid=""
trap '[[ -n "$stub_pid" ]] && kill "$stub_pid" 2>/dev/null; rm -rf "$tmp"' EXIT

if [[ -z "${PKG_REPO:-}" ]]; then
  (cd "$root" && cargo build -q -p pkg-repo)
  PKG_REPO="$root/target/debug/pkg-repo"
fi

# The pool: the first claim hands out task 7, the project's review build of
# rusty for x86_64 (review:5); every request goes to STUB_REQUESTS, one JSON
# line each, the body parsed where it is JSON.
cat > "$tmp/pool.py" <<'P'
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
log = os.environ["STUB_REQUESTS"]
claimed = False
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def answer(self, code, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def record(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        try: body = json.loads(raw)
        except Exception: body = {"bytes": len(raw)}
        with open(log, "a") as f: f.write(json.dumps({"method": self.command, "path": self.path, "body": body}) + "\n")
    def do_POST(self):
        global claimed
        self.record()
        if self.path == "/api/v1/factory/claim":
            if claimed: return self.answer(204)
            claimed = True
            return self.answer(200, {"task": {"id": 7, "kind": "build", "name": "rusty", "arch": "x86_64", "trust": "project",
                "pkgbuild_ref": "review:5", "params": {"review": 5, "project": "https://rusty.example"}, "attempts": 1, "max_attempts": 3}, "token": "omj.stub"})
        return self.answer(200, {})
    def do_PUT(self):
        self.record()
        return self.answer(200, {})
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(os.environ["STUB_PORT"], "w").write(str(srv.server_address[1]))
srv.serve_forever()
P

# The build container: what it prints is the build's log, its status the container's.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/podman" <<'S'
#!/usr/bin/env bash
[[ "$1" == --version ]] && { echo "podman version 5.0.0 (stub)"; exit 0; }
printf '%b' "$STUB_BUILD_LOG"
exit "$STUB_BUILD_STATUS"
S
chmod +x "$tmp/bin/podman"

# One task, one worker: a fresh pool and work directory, the keyrings
# already fetched (the worker fetches them at start otherwise), the report
# the pool heard printed.
run() { # labels status log
  local work="$tmp/work"
  rm -rf "$work"; mkdir -p "$work/keyrings"; : > "$work/keyrings/archlinux.gpg"; : > "$work/keyrings/.fetched"
  : > "$tmp/requests"; rm -f "$tmp/port"
  STUB_REQUESTS="$tmp/requests" STUB_PORT="$tmp/port" python3 "$tmp/pool.py" & stub_pid=$!
  for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
  [[ -s "$tmp/port" ]] || { echo "the stub pool did not start"; exit 1; }
  PATH="$tmp/bin:$PATH" STUB_BUILD_STATUS="$2" STUB_BUILD_LOG="$3" \
    "$PKG_REPO" work --api "http://127.0.0.1:$(cat "$tmp/port")" --pool "http://127.0.0.1:1/pool" --worker-token omw_stub \
      --arch x86_64 --kind build --labels "$1" --once --work-dir "$work" --repo-dir "$root" 2>"$tmp/stderr" \
    || { echo "pkg-repo work failed: $(cat "$tmp/stderr")"; exit 1; }
  kill "$stub_pid" 2>/dev/null; wait "$stub_pid" 2>/dev/null || true; stub_pid=""
  report="$(jq -c 'select(.path == "/api/v1/factory/tasks/7/fail") | .body' "$tmp/requests")"
  [[ -n "$report" ]] || { echo "no fail report reached the pool: $(cat "$tmp/requests")"; exit 1; }
}
expect() { # jq-filter what
  jq -e "$1" <<<"$report" >/dev/null || { echo "$2: $report"; exit 1; }
}
emulated='{"where":"omarchy-studio","emulated":true,"role":"review"}'
native='{"where":"x86-box","role":"review"}'
rustc='==> Installing dependencies\n==> rustc cannot start on this worker: emulated x86_64 under qemu on a host whose page size is not the guest'"'"'s — a native worker is needed for this package\n'
sudo='==> Starting build()...\nsudo: error while loading shared libraries: libldap.so.2: failed to map segment from shared object\n==> ERROR: A failure occurred in build().\n'

# 1. Emulated, the build script's exit 96: back for a native worker, not final, with the reason.
run "$emulated" 96 "$rustc"
expect '.needs_native == true and .final == false' "exit 96 on an emulated worker is needs_native, not final"
expect '.error | contains("rustc cannot start on this worker")' "the report says why"
grep -q '"path": "/api/v1/factory/tasks/7/artifacts/build.log"' "$tmp/requests" || { echo "the log is on the record: $(cat "$tmp/requests")"; exit 1; }
grep -q 'back in the queue for a native x86_64 worker' "$tmp/stderr" || { echo "the worker's log says where the build went: $(cat "$tmp/stderr")"; exit 1; }

# 2. Emulated, a library qemu could not map (no probe sees it coming): the same.
run "$emulated" 4 "$sudo"
expect '.needs_native == true and .final == false' "a segment qemu could not map on an emulated worker is needs_native"
expect '.error | contains("libldap.so.2: failed to map segment from shared object")' "the loader's line is the reason"

# 3. The same line on a native worker is a real failure: retried, not sent anywhere.
run "$native" 4 "$sudo"
expect '.needs_native == false and .final == false' "a native worker's loader failure is a plain one"

# 4. The gate's failure is the recipe's: final. 5. A recipe that does not compile: neither.
run "$emulated" 5 '==> The gate: FAIL (1 failing check(s), 0 warning(s))\n'
expect '.needs_native == false and .final == true' "the gate's failure stays final on an emulated worker"
run "$emulated" 4 '==> Starting build()...\nerror: could not compile `rusty`\n'
expect '.needs_native == false and .final == false' "a recipe's failure is not the worker's"

echo "ok: the Rust worker sends needs_native for a build that died of emulation, and only then"
