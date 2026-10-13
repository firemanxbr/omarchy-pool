#!/usr/bin/env bash
# The build script's --task mode (factory/worker/omarchy-build-worker.sh, #335):
# what `pkg-repo dispatch` runs in a task container. Run here in a container of
# STUB_IMAGE with the mounts and the capabilities the spec gives it (/task/in read-only, /task/out,
# /task/log, the checkout at /pool read-only) and the kinds that need no
# network: a trial's helper that passes and one that fails, the log cut at its
# cap with a marker while the task's own status survives the cut (no SIGPIPE),
# a kind the release does not know, and a verdict whose error carries quotes
# and backslashes — `verdict.json` must stay JSON. And an audit (#319), in
# PY_IMAGE with a fake agent sidecar: the auditor reaches it with the task's
# environment as the dispatcher gives it (the placeholder as its key), as a
# draft does — not "FACTORY_PROVIDER=anthropic but ANTHROPIC_API_KEY is not
# set", which every audit on a host stopped on (task 1627). A build's own
# path is the P1 host's run (it installs from the network).
#
# Requires: docker or podman, jq. STUB_IMAGE: an image with bash and coreutils (default debian:stable-slim);
# PY_IMAGE: one with python3 too (default python:3.12-slim).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="${RUNTIME:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
STUB_IMAGE="${STUB_IMAGE:-docker.io/library/debian:stable-slim}"
PY_IMAGE="${PY_IMAGE:-docker.io/library/python:3.12-slim}"
tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp" 2>/dev/null || "$RT" run --rm -v "$tmp:$tmp" "$STUB_IMAGE" sh -c "rm -rf $tmp/t*" >/dev/null 2>&1; rm -rf "$tmp" 2>/dev/null || true' EXIT
fail() { echo "worker-task-mode: FAIL — $*" >&2; exit 1; }
"$RT" image inspect "$STUB_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$STUB_IMAGE" >/dev/null

# The capabilities the spec keeps after --cap-drop ALL (crates/pkg-repo/src/dispatch/spec.rs, CAPS):
# without DAC_OVERRIDE the container's root cannot write to /task/out and /task/log, which belong to
# the host's user (the runner's uid on CI) — the redirection fails, the task dies of SIGPIPE (141) and
# no verdict is written. Rootless podman hides that: there the container's root owns them.
caps=()
while read -r c; do caps+=(--cap-add "$c"); done < <(sed -n '/^pub const CAPS/,/^];/s/^ *"\([A-Z_]*\)",$/\1/p' "$root/crates/pkg-repo/src/dispatch/spec.rs")
(( ${#caps[@]} > 0 )) || fail "no CAPS in crates/pkg-repo/src/dispatch/spec.rs"

runs=0
run() { # kind check-script [env…] → $t/{out,log}, a new directory each time; the status in $status
  local kind="$1" check="$2"; shift 2
  runs=$((runs + 1)); t="$tmp/t$runs"
  mkdir -p "$t/in" "$t/out" "$t/log"
  printf "staged=1\nkind='%s'\nname='felix'\narch='x86_64'\nkeyring='archlinux'\n" "$kind" > "$t/in/meta.sh"
  printf '%s\n' "$check" > "$t/in/check.sh"
  local e=() kv
  for kv in "$@"; do e+=(-e "$kv"); done
  status=0
  "$RT" run --rm --cap-drop ALL "${caps[@]}" --security-opt no-new-privileges ${e[@]+"${e[@]}"} \
    -v "$t/in:/task/in:ro" -v "$t/out:/task/out" -v "$t/log:/task/log" -v "$root:/pool:ro" \
    "$STUB_IMAGE" bash /pool/factory/worker/omarchy-build-worker.sh --task >/dev/null 2>&1 || status=$?
  [[ -f "$t/out/verdict.json" ]] || fail "$kind: no verdict.json (status $status)"
  jq -e . "$t/out/verdict.json" >/dev/null || fail "$kind: verdict.json is not JSON: $(cat "$t/out/verdict.json")"
}

# A trial's helper that installs: its transcript in the log, status 0 in the verdict and the container's.
run trial 'echo "== pacman -Sy"; echo "TRIAL=ok"'
[[ "$status" == 0 ]] || fail "a passing trial exited $status"
jq -e '.status == 0 and .final == false and .needs_native == false' "$t/out/verdict.json" >/dev/null || fail "$(cat "$t/out/verdict.json")"
grep -qx 'TRIAL=ok' "$t/log/task.log" || fail "the transcript: $(cat "$t/log/task.log")"
echo "ok: a trial's helper that passes"

# One that fails: its status, and the line that says why.
run trial 'echo "== pacman -S felix"; echo "TRIAL=install-failed"; exit 1'
[[ "$status" == 1 ]] || fail "a failing trial exited $status"
jq -e '.status == 1 and .final == false and (.error | contains("TRIAL=install-failed"))' "$t/out/verdict.json" >/dev/null || fail "$(cat "$t/out/verdict.json")"
echo "ok: a trial's helper that fails"

# The log, cut at its cap with a marker; the task's own status, not the pipe's.
run trial 'head -c 3000000 /dev/zero | tr "\0" x; echo; echo "TRIAL=ok"; exit 7' TASK_LOG_CAP=1000000
[[ "$status" == 7 ]] || fail "the cut changed the task's status: $status"
size="$(wc -c < "$t/log/task.log" | tr -d ' ')"
(( size >= 1000000 && size < 1001000 )) || fail "the log is $size bytes, not cut at 1000000"
grep -q 'the log was cut here at 1000000 bytes' "$t/log/task.log" || fail "no marker where the log was cut"
echo "ok: the log is cut at its cap with a marker, and the task's status survives the cut"

# A model kind's agent sidecar that binds late (a subscription's sidecar installs Claude Code first):
# the task waits for its port, then goes on; one that never answers is waited for its bound only.
late() { # wrapper-before-the-script [env…] — a trial, with the agent at 127.0.0.1:8790
  local pre="$1"; shift
  runs=$((runs + 1)); t="$tmp/t$runs"
  mkdir -p "$t/in" "$t/out" "$t/log"
  printf "staged=1\nkind='trial'\nname='felix'\narch='x86_64'\nkeyring='archlinux'\n" > "$t/in/meta.sh"
  printf '%s\n' 'echo "TRIAL=ok"' > "$t/in/check.sh"
  local e=() kv
  for kv in ANTHROPIC_BASE_URL=http://127.0.0.1:8790 "$@"; do e+=(-e "$kv"); done
  status=0
  "$RT" run --rm --cap-drop ALL "${caps[@]}" --security-opt no-new-privileges "${e[@]}" \
    -v "$t/in:/task/in:ro" -v "$t/out:/task/out" -v "$t/log:/task/log" -v "$root:/pool:ro" \
    "$STUB_IMAGE" bash -c "$pre exec bash /pool/factory/worker/omarchy-build-worker.sh --task" >/dev/null 2>&1 || status=$?
}
late '(sleep 4; exec perl -MIO::Socket::INET -e '"'"'my $s = IO::Socket::INET->new(LocalAddr => "127.0.0.1:8790", Listen => 5, ReuseAddr => 1) or die; while (my $c = $s->accept) { close $c }'"'"') &'
[[ "$status" == 0 ]] || fail "a task whose agent binds late exited $status: $(cat "$t/log/task.log")"
grep -q 'the agent sidecar at 127.0.0.1:8790 answers (after [1-9]' "$t/log/task.log" || fail "the wait for a late agent: $(cat "$t/log/task.log")"
grep -qx 'TRIAL=ok' "$t/log/task.log" || fail "the task after the wait: $(cat "$t/log/task.log")"
late '' AGENT_READY_S=2
[[ "$status" == 0 ]] && grep -q 'did not answer in 2 s; going on' "$t/log/task.log" || fail "an agent that never answers: $status $(cat "$t/log/task.log")"
echo "ok: a model task waits for its agent sidecar's port, bounded, before its first call"

# An audit (#319): the staged build's recipe and log in /task/in/artifacts/<task>, a fake agent sidecar on
# 127.0.0.1:8790 that keeps what each call carried, and the model environment the dispatcher gives every model kind
# (crates/pkg-repo/src/dispatch/spec.rs, env_of). The script holds ANTHROPIC_API_KEY back from its children; the
# auditor must get it back as the drafter does (with_secrets), or agent.py stops before any call.
"$RT" image inspect "$PY_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$PY_IMAGE" >/dev/null
runs=$((runs + 1)); t="$tmp/t$runs"
mkdir -p "$t/in/artifacts/40" "$t/out" "$t/log"
printf "staged=1\nkind='audit'\nname='felix'\narch='x86_64'\nstaged_task='40'\n" > "$t/in/meta.sh"
printf 'pkgname=felix\npkgver=1.0\npkgrel=1\narch=(any)\nlicense=(MIT)\npackage() { :; }\n' > "$t/in/artifacts/40/PKGBUILD"
printf '==> Making package: felix 1.0-1\n==> Finished making: felix 1.0-1\n' > "$t/in/artifacts/40/build.log"
cat > "$t/in/fake-agent.py" <<'PY'
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        with open("/task/log/agent-seen.jsonl", "a") as f:
            f.write(json.dumps({"path": self.path, "key": self.headers.get("x-api-key")}) + "\n")
        report = {"verdict": "ok", "summary": "a fake review", "findings": []}
        out = json.dumps({"model": "fake-model", "content": [{"type": "text", "text": json.dumps(report)}], "usage": {}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
HTTPServer(("127.0.0.1", 8790), H).serve_forever()
PY
status=0
"$RT" run --rm --cap-drop ALL "${caps[@]}" --security-opt no-new-privileges \
  -e FACTORY_PROVIDER=anthropic -e ANTHROPIC_BASE_URL=http://127.0.0.1:8790 -e ANTHROPIC_API_KEY=via-agent-sidecar \
  -e GITHUB_API=http://127.0.0.1:8790/github -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1 \
  -v "$t/in:/task/in:ro" -v "$t/out:/task/out" -v "$t/log:/task/log" -v "$root:/pool:ro" \
  "$PY_IMAGE" bash -c 'printf "[options]\n" > /etc/pacman.conf; python3 /task/in/fake-agent.py & exec bash /pool/factory/worker/omarchy-build-worker.sh --task' >/dev/null 2>&1 || status=$?
[[ "$status" == 0 ]] || fail "an audit exited $status: $(cat "$t/log/task.log")"
jq -e '.verdict == "ok" and .model == "fake-model"' "$t/out/audit.json" >/dev/null || fail "the audit's report: $(cat "$t/out/audit.json" 2>/dev/null)"
[[ -s "$t/out/audit.md" ]] || fail "no audit.md"
jq -se 'length >= 1 and all(.path == "/v1/messages" and .key == "via-agent-sidecar")' "$t/log/agent-seen.jsonl" >/dev/null \
  || fail "the auditor's calls to its agent sidecar: $(cat "$t/log/agent-seen.jsonl" 2>/dev/null)"
! grep -q via-agent-sidecar "$t/log/task.log" || fail "the key's placeholder is in the task's log"
echo "ok: an audit reaches its agent sidecar with the placeholder as its key, as a draft does, and writes audit.json and audit.md"

# A kind this release's script does not know.
run nonsense 'true'
[[ "$status" == 2 ]] || fail "an unknown kind exited $status"
jq -e '.status == 2 and (.error | contains("does not know the task kind"))' "$t/out/verdict.json" >/dev/null || fail "$(cat "$t/out/verdict.json")"
echo "ok: a kind it does not know"

# An error line with quotes, backslashes and a tab: the verdict stays JSON and says it.
run trial 'printf "error: \"quoted\" back\\\\slash\there\n"; exit 3'
jq -e '.status == 3 and (.error | contains("\"quoted\"")) and (.error | contains("back\\slash"))' "$t/out/verdict.json" >/dev/null || fail "$(cat "$t/out/verdict.json")"
echo "ok: a verdict whose error carries quotes and backslashes is JSON"
echo "ok: the build script's --task mode"
