#!/usr/bin/env bash
# main_package: the task's own package among what makepkg wrote — never a
# stray file from the working directory (2026-09-17: `ls` with a glob that
# matched nothing listed /build under nullglob, attempt.log became the
# package, and the worker died with the lease). And the shell's last words:
# a command that fails outside the build's subshell is reported to the pool
# with the command that ended the script, not left to a lease expiry.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
script="$root/factory/worker/omarchy-build-worker.sh"

awk '/^main_package\(\)/,/^}/' "$script" > "$tmp/fn.sh"
# shellcheck source=/dev/null
source "$tmp/fn.sh"

mkdir -p "$tmp/build/out"; cd "$tmp/build"; touch attempt.log build.log
# Empty: nothing, not attempt.log.
[[ -z "$(main_package omarchy-cli "$tmp/build/out")" ]] || { echo "an empty out/ must yield no package: $(main_package omarchy-cli "$tmp/build/out")"; exit 1; }
# A prebuilt binary is named <name>-bin: found under the task's name.
touch out/omarchy-cli-bin-0.0.168-1-aarch64.pkg.tar.zst
[[ "$(main_package omarchy-cli "$tmp/build/out")" == "$tmp/build/out/omarchy-cli-bin-0.0.168-1-aarch64.pkg.tar.zst" ]] || { echo "the -bin package is the task's own: $(main_package omarchy-cli "$tmp/build/out")"; exit 1; }
# The task's own name wins over its -bin and over a split package that sorts first.
touch out/omarchy-cli-0.0.168-1-aarch64.pkg.tar.zst out/aaa-docs-0.0.168-1-any.pkg.tar.zst out/omarchy-cli-debug-0.0.168-1-aarch64.pkg.tar.zst
[[ "$(main_package omarchy-cli "$tmp/build/out")" == "$tmp/build/out/omarchy-cli-0.0.168-1-aarch64.pkg.tar.zst" ]] || { echo "the task's own package first: $(main_package omarchy-cli "$tmp/build/out")"; exit 1; }
# A name that matches nothing: the first package there is, never a file outside out/.
[[ "$(main_package felix "$tmp/build/out")" == "$tmp/build/out/aaa-docs-0.0.168-1-any.pkg.tar.zst" ]] || { echo "no match: whatever makepkg wrote, from out/: $(main_package felix "$tmp/build/out")"; exit 1; }
# Called in a command substitution: the caller's own options are its own.
! shopt -q nullglob || { echo "main_package runs in its substitution; the caller's nullglob is the caller's"; exit 1; }

# The last words: the EXIT trap, as container_worker installs it, reports a
# death outside the subshell — the failing command, its status — through
# the pool's fail route, once; a reported task says nothing more.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/api-stub.sh" <<'S'
api() { printf '%s %s %s\n' "$1" "$2" "${3:-}" >> "$STUB_LOG"; echo 200; }
upload_staging() { printf 'upload %s %s %s\n' "$1" "$2" "$3" >> "$STUB_LOG"; }
log() { :; }
S
awk '/^last_words\(\)/,/^}/' "$script" > "$tmp/last.sh"
export STUB_LOG="$tmp/calls"; : > "$STUB_LOG"
set +e
bash -c "
  set -euo pipefail
  source '$tmp/bin/api-stub.sh'; source '$tmp/last.sh'
  id=463; REPORTED=0
  trap 's=\$?; c=\$BASH_COMMAND; kill \"\${BEAT:-}\" 2>/dev/null || true; (( REPORTED )) || last_words \"\$id\" \"\$s\" \"\$c\"' EXIT
  main=attempt.log
  version=\"\$(tar -xOf \"\$main\" .PKGINFO 2>/dev/null | awk -F' = ' '\$1==\"pkgver\"{print \$2}')\"
  echo unreachable
"
rc=$?
set -e
(( rc != 0 )) || { echo "the tar on a log must end the shell (the bug being reproduced)"; exit 1; }
grep -q '^POST /factory/tasks/463/fail ' "$STUB_LOG" || { echo "the death must reach the pool's fail route: $(cat "$STUB_LOG")"; exit 1; }
grep -q 'the worker ended (exit [0-9]*) at: version=' "$STUB_LOG" || { echo "the report names the command that ended the shell: $(cat "$STUB_LOG")"; exit 1; }
grep -qE '"final": ?false' "$STUB_LOG" || { echo "a death is not the recipe's failure — not final: $(cat "$STUB_LOG")"; exit 1; }
[[ "$(grep -c '/fail' "$STUB_LOG")" == 1 ]] || { echo "one report: $(cat "$STUB_LOG")"; exit 1; }
: > "$STUB_LOG"
bash -c "
  set -euo pipefail
  source '$tmp/bin/api-stub.sh'; source '$tmp/last.sh'
  id=463; REPORTED=0
  trap 's=\$?; c=\$BASH_COMMAND; (( REPORTED )) || last_words \"\$id\" \"\$s\" \"\$c\"' EXIT
  REPORTED=1; api POST /factory/tasks/463/complete '{}' >/dev/null
" || { echo "a normal end exits 0"; exit 1; }
[[ "$(grep -c '/fail' "$STUB_LOG")" == 0 ]] || { echo "a reported task has no last words: $(cat "$STUB_LOG")"; exit 1; }
echo "worker-main-package: ok"
