#!/usr/bin/env bash
# Every container a task starts or creates carries the task's label (#277,
# part 2): a stop of the task removes its containers by it
# (`<runtime> ps -aq --filter label=com.omarchy.task=<id>`, then `rm -f`),
# because a container outlives its killed client — `bash`, its first
# process, ignores SIGTERM, and SIGKILL is never passed on — and a created
# one is not even running.
#
# 1. The static check: the scripts `pkg-repo work` runs through script()
#    (its calls `script(opts, token, "tests/…")` in crates/pkg-repo/src/work.rs;
#    its own tests call it otherwise), and the scripts those run, name
#    and label every `"$RUNTIME" run` and `"$RUNTIME" create`; a script of the
#    list that runs another script under tests/ the list does not name fails
#    too, so a container added or created later cannot escape a stop. And the
#    containers the Rust worker starts itself (crates/pkg-repo/src/*.rs): a
#    `Command::new(<runtime>)` that runs or creates one carries the task's
#    label (stop::TASK_LABEL) — the build's container, the enqueue job's
#    PKGBUILD reader.
# 2. tests/health-check.sh against a stub docker first on PATH and a stub
#    pool: with OMARCHY_TASK_ID=812 its run carries the task's name and
#    label; without it, the arguments it always had.
# 3. tests/abi-gate.sh's reference export, the same way (a `run` since #340,
#    which a pool job's shim takes; the script then ends on a reference the
#    stub did not export; only the recorded run is read).
#
# Requires: bash, python3, curl.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
stub_pid=""
trap '[[ -n "$stub_pid" ]] && { kill "$stub_pid" 2>/dev/null; wait "$stub_pid" 2>/dev/null || true; }; rm -rf "$tmp"' EXIT
fail() { echo "task-containers: $*" >&2; exit 1; }

# ---- 1. the static check ----
ran=()
while IFS= read -r s; do ran+=("$s"); done < <(grep -oE 'script\(opts, token, "tests/[a-z0-9-]+\.sh"' "$root/crates/pkg-repo/src/work.rs" | grep -oE 'tests/[a-z0-9-]+\.sh' | sort -u)
[[ ${#ran[@]} -ge 3 ]] || fail "work.rs runs fewer scripts than health-check, trial and abi-gate: ${ran[*]}"
# The scripts those run, known and checked with them.
nested=(tests/omarchy-rootfs.sh)
list=("${ran[@]}" "${nested[@]}")
for s in "${list[@]}"; do
  [[ -f "$root/$s" ]] || fail "$s is not in the repository"
  # Every container this script starts or creates: named and labelled with the task.
  while IFS= read -r line; do
    [[ "$line" == *com.omarchy.task* ]] || fail "$s starts or creates a container without the task's label (a stop could not remove it): $line"
  done < <(grep -nE '"\$RUNTIME" (run|create)\b' "$root/$s" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
  # Another script under tests/ this one runs, outside comments: it must be on the list.
  while IFS= read -r other; do
    [[ " ${list[*]} " == *" $other "* ]] || fail "$s runs $other, which this check does not read: add it to the list"
  done < <(grep -vE '^[[:space:]]*#' "$root/$s" | grep -oE '(\$ROOT|\$root|\$here|\./)?/?tests/[a-z0-9-]+\.sh' | grep -oE 'tests/[a-z0-9-]+\.sh' | grep -vx "$s" | sort -u || true)
done
echo "task-containers: every container of ${list[*]} carries the task's label"

# The containers the Rust worker starts or creates itself: every `Command::new(<a runtime variable>)` whose next lines say "run" or
# "create" carries the task's label in them too.
rust_check() { # dir → the unlabelled ones, one per line
  python3 - "$1" <<'RS'
import pathlib, re, sys
for f in sorted(pathlib.Path(sys.argv[1]).glob("*.rs")):
    lines = f.read_text().splitlines()
    for i, line in enumerate(lines):
        if not re.search(r'Command::new\((?!")[^)]*\)', line):
            continue
        # The statement's lines: up to 16, and never past the next Command::new — a runtime's `--version` probe is not the run after it.
        span = lines[i:i + 16]
        for j in range(1, len(span)):
            if "Command::new(" in span[j]:
                span = span[:j]
                break
        window = "\n".join(span)
        if re.search(r'"(run|create)"', window) and "TASK_LABEL" not in window and "com.omarchy.task" not in window:
            print(f"{f.name}:{i + 1}: {line.strip()}")
RS
}
bad_rust="$(rust_check "$root/crates/pkg-repo/src")"
[[ -z "$bad_rust" ]] || fail "the Rust worker starts or creates a container without the task's label (a stop could not remove it): $bad_rust"
mkdir -p "$tmp/rs"
printf '%s\n' 'fn meta(runtime: &str) {' '    let out = Command::new(runtime)' '        .args(["run", "--rm", "image"])' '        .output();' '}' > "$tmp/rs/bad.rs"
[[ "$(rust_check "$tmp/rs")" == "bad.rs:2: let out = Command::new(runtime)" ]] || fail "the Rust check would miss an unlabelled run: $(rust_check "$tmp/rs")"
echo "task-containers: every container the Rust worker starts itself carries the task's label"

# The static check catches what it is for: a script with an unlabelled run, and one with an unlabelled create.
for bad in 'out=$("$RUNTIME" run --rm "$IMAGE" true)' 'cid="$("$RUNTIME" create "$IMAGE" true)"'; do
  printf '%s\n' "$bad" > "$tmp/bad.sh"
  if grep -nE '"\$RUNTIME" (run|create)\b' "$tmp/bad.sh" | grep -vq com.omarchy.task; then :; else fail "the static check would miss: $bad"; fi
done

# ---- the stubs: a pool that serves one ring's database, docker and pkg-repo that record ----
cat > "$tmp/pool.py" <<'P'
import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/api/v1/stats"):
            body = json.dumps({"rings": [{"ring": "edge", "artifacts": [{"kind": "db", "arch": "aarch64", "repo": "edge-core"}]}]}).encode()
            ctype = "application/json"
        elif self.path.startswith("/api/v1/pacman.conf"):
            body = b"[edge-core]\nServer = http://127.0.0.1:1/pool/core/aarch64\n"
            ctype = "text/plain"
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(os.environ["STUB_PORT"], "w").write(str(srv.server_address[1]))
srv.serve_forever()
P
STUB_PORT="$tmp/port" python3 "$tmp/pool.py" & stub_pid=$!
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
[[ -s "$tmp/port" ]] || fail "the stub pool did not start"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'S'
#!/usr/bin/env bash
# Records each call, one argument per line after the verb's line; a check run prints what a passing check prints.
{ printf '== %s\n' "$1"; printf '%s\n' "${@:2}"; } >> "$STUB_DOCKER"
case "$1" in
  run) echo "TOTAL=5" ;;
  create) echo "0123456789ab" ;;
esac
exit 0
S
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/pkg-repo"
chmod +x "$tmp/bin/docker" "$tmp/bin/pkg-repo"
env_common=(PATH="$tmp/bin:$PATH" OMARCHY_API="http://127.0.0.1:$(cat "$tmp/port")" OMARCHY_POOL="http://127.0.0.1:1/pool" OMARCHY_TOKEN=omj.stub PKG_REPO="$tmp/bin/pkg-repo" OMARCHY_CLI=/bin/false STUB_DOCKER="$tmp/docker")
# The arguments of the recorded call with this verb, one per line.
call_of() { awk -v v="== $1" '$0 == v { on = 1; next } /^== / { on = 0 } on' "$tmp/docker"; }

# ---- 2. health-check.sh ----
: > "$tmp/docker"
env "${env_common[@]}" OMARCHY_TASK_ID=812 bash "$root/tests/health-check.sh" edge aarch64 >"$tmp/out" 2>&1 || fail "health-check.sh with a passing stub check failed: $(cat "$tmp/out")"
args="$(call_of run)"
grep -qx -- '--label' <<<"$args" && grep -qx 'com.omarchy.task=812' <<<"$args" || fail "the check's run carries the task's label: $args"
grep -qE '^omarchy-task-812-check-[0-9]+$' <<<"$args" || fail "the check's run carries the task's name: $args"
: > "$tmp/docker"
env -u OMARCHY_TASK_ID "${env_common[@]}" bash "$root/tests/health-check.sh" edge aarch64 >"$tmp/out" 2>&1 || fail "health-check.sh without a task failed: $(cat "$tmp/out")"
args="$(call_of run)"
[[ "$(head -n2 <<<"$args" | tr '\n' ' ')" == "--rm --platform " ]] || fail "without a task, the run is as it always was: $args"
grep -q 'com.omarchy.task' <<<"$args" && fail "without a task, no label: $args"

# ---- 3. abi-gate.sh's reference export ----
: > "$tmp/docker"
env "${env_common[@]}" OMARCHY_TASK_ID=812 bash "$root/tests/abi-gate.sh" edge aarch64 >"$tmp/out" 2>&1 || true
args="$(call_of run)"
grep -qx 'com.omarchy.task=812' <<<"$args" && grep -qE '^omarchy-task-812-ref-[0-9]+$' <<<"$args" || fail "the gate's reference run carries the task's name and label: $args"
: > "$tmp/docker"
env -u OMARCHY_TASK_ID "${env_common[@]}" bash "$root/tests/abi-gate.sh" edge aarch64 >"$tmp/out" 2>&1 || true
args="$(call_of run)"
[[ -n "$args" ]] || fail "the gate ran its reference's export: $(cat "$tmp/out")"
grep -q 'com.omarchy.task' <<<"$args" && fail "without a task, the run is the shape a pool job's shim takes: $args"
# What a pool job's omarchy-task-run takes (#340): --rm, the platform, one scratch directory at /repo, the pinned image, bash /repo/<script>.sh.
[[ "$(tr '\n' ' ' <<<"$args")" =~ ^--rm\ --platform\ linux/arm64\ -v\ [^\ ]+:/repo\ docker\.io/[^\ ]+@sha256:[0-9a-f]{64}\ bash\ /repo/export\.sh\ $ ]] || fail "the gate's reference run is not the shim's shape: $args"
grep -q 'create' "$tmp/docker" && fail "the gate creates no container any more (the shim takes run only): $(cat "$tmp/docker")"
echo "task-containers: ok"
