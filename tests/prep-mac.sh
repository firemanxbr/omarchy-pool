#!/usr/bin/env bash
# factory/host/prep-mac.sh (#320), against stubs: what a Mac needs once before
# the install, and nothing else, without sudo.
#
# - A fresh Mac: `brew install colima lima` (only those), the three
#   directories the omarchy VM mounts made 0700 under /Users/Shared/omarchy-pool,
#   Rosetta 2's absence and Docker Desktop's presence said (never installed),
#   and the next step. Run again: no brew install, nothing changed.
# - --dry-run: nothing made, nothing installed, every step said.
# - --root elsewhere: the install flags that go with it are printed.
# - Refused (exit 2): root, Linux, an Intel Mac, macOS 12, no Homebrew, a
#   root under the home directory (in any case) or holding it, a relative
#   root, a root with ':' (Colima's --mount syntax), a root directory another
#   user owns, a root that is a symbolic link.
#
# OMARCHY_PREP_FS points the script's system paths at a temporary tree; uname,
# id, sw_vers, brew and stat are stubs on PATH.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
export STUB_LOG="$tmp/log" STATE="$tmp/state"
fail() { echo "FAIL: $*" >&2; echo "--- log ---" >&2; cat "$STUB_LOG" >&2 || true; echo "--- out ---" >&2; cat "$tmp/out" >&2 || true; exit 1; }

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$tmp/bin/$1"; chmod +x "$tmp/bin/$1"; }
stub uname 'case "$1" in -s) echo "$STUB_OS" ;; -m) echo "$STUB_ARCH" ;; esac'
stub id 'case "$1" in -u) echo "$STUB_UID" ;; -un) echo me ;; *) exit 1 ;; esac'
stub sw_vers 'echo "$STUB_MACOS"'
stub brew 'echo "brew $*" >> "$STUB_LOG"
case "$1" in
  list) [[ -e "$STATE/installed-$3" ]] ;;
  install) shift; for f in "$@"; do touch "$STATE/installed-$f"; done ;;
esac'
stub stat '[[ "$1 $2" == "-f %Su" ]] || exit 1; if [[ -e "$3/.other" ]]; then echo other; else echo me; fi'

fresh() {
  rm -rf "$tmp/fs" "$STATE"; mkdir -p "$tmp/fs/Users/Shared" "$tmp/fs/Users/me" "$tmp/fs/Applications/Docker.app" "$STATE"
  export STUB_OS=Darwin STUB_ARCH=arm64 STUB_UID=501 STUB_MACOS=15.1
}
prep() { # args… → $status, $tmp/out; the log starts empty
  : > "$STUB_LOG"
  set +e
  PATH="${PREP_PATH:-$tmp/bin:$PATH}" OMARCHY_PREP_FS="$tmp/fs" HOME="${PREP_HOME:-$tmp/fs/Users/me}" sh "$root/factory/host/prep-mac.sh" "$@" > "$tmp/out" 2>&1
  status=$?
  set -e
}
said() { grep -qF -- "$1" "$tmp/out" || fail "not said: $1"; }
mode() { /usr/bin/stat -c %a "$1"; }
shared="$tmp/fs/Users/Shared/omarchy-pool"

# --- a fresh Mac -------------------------------------------------------------------
fresh
prep
[[ $status == 0 ]] || fail "a fresh Mac: exit $status"
grep -qx 'brew install colima lima' "$STUB_LOG" || fail "Colima and Lima from Homebrew"
[[ "$(grep -c '^brew install' "$STUB_LOG")" == 1 ]] || fail "nothing else from Homebrew"
for d in "$shared" "$shared/work" "$shared/secrets" "$shared/set"; do
  [[ -d "$d" && "$(mode "$d")" == 700 ]] || fail "$d made 0700"
done
said "the only directories the omarchy VM mounts"
said "Rosetta 2 is not installed"
said "Docker is here: the agent uses the omarchy Colima VM, never installs Docker"
said "done. Next, from Terminal on this Mac"
grep -q -- '--work-root' "$tmp/out" && fail "the default root needs no flags"
echo "ok: a fresh Mac: Colima and Lima only, the three directories 0700, Rosetta and Docker Desktop said"

# Again: nothing to install, nothing changed.
before="$(ls -lR "$shared")"
touch "$tmp/fs/Library" 2>/dev/null || true
prep
[[ $status == 0 ]] || fail "again: exit $status"
grep -q '^brew install' "$STUB_LOG" && fail "again: nothing is installed"
[[ "$(ls -lR "$shared")" == "$before" ]] || fail "again: nothing changed"
said "Colima and Lima are installed"
echo "ok: run again, nothing changes"

# Rosetta installed is said so.
rm -f "$tmp/fs/Library"; mkdir -p "$tmp/fs/Library/Apple/usr/libexec/oah"; : > "$tmp/fs/Library/Apple/usr/libexec/oah/libRosettaRuntime"
prep
said "Rosetta 2 is installed: the VM gets an x86_64 lane"
echo "ok: Rosetta 2 said when it is installed"

# --- --dry-run ---------------------------------------------------------------------
fresh
prep --dry-run
[[ $status == 0 ]] || fail "dry run: exit $status"
[[ ! -e "$shared" ]] || fail "dry run: nothing made"
grep -q '^brew install' "$STUB_LOG" && fail "dry run: nothing installed"
said "would run: "
said "would make $shared/work (0700)"
said "done (dry run: nothing was changed)"
echo "ok: --dry-run says every step and changes nothing"

# --- another root ------------------------------------------------------------------
fresh
mkdir -p "$tmp/fs/Volumes/fast"
prep --root "$tmp/fs/Volumes/fast/omarchy"
[[ $status == 0 ]] || fail "another root: exit $status"
said "--work-root $tmp/fs/Volumes/fast/omarchy/work --secrets-dir $tmp/fs/Volumes/fast/omarchy/secrets --set-dir $tmp/fs/Volumes/fast/omarchy/set"
echo "ok: --root elsewhere prints the install flags that go with it"

# --- refusals ----------------------------------------------------------------------
refused() { # why, then prep's arguments
  local why="$1"; shift
  prep "$@"
  [[ $status == 2 ]] || fail "$why: exit $status"
  said "$why"
  grep -q '^brew install' "$STUB_LOG" && fail "$why: nothing installed"
  return 0
}
fresh; STUB_UID=0 refused "refusing to run as root: no sudo"
fresh; STUB_OS=Linux refused "prep-root.sh"
fresh; STUB_ARCH=x86_64 refused "Apple silicon (arm64) only"
fresh; STUB_MACOS=12.7 refused "needs macOS 13 or later"
fresh; PREP_PATH="$tmp/nobrew:$(dirname "$(command -v sh)"):/usr/bin:/bin"
mkdir -p "$tmp/nobrew"; for b in uname id sw_vers stat; do cp "$tmp/bin/$b" "$tmp/nobrew/"; done
refused "Homebrew is not installed"; unset PREP_PATH
fresh; refused "is under your home directory" --root "$tmp/fs/Users/me/omarchy"
fresh; refused "is under your home directory" --root "$tmp/fs/USERS/ME/omarchy"
fresh; refused "holds your home directory" --root "$tmp/fs/Users"
fresh; refused "is not an absolute path" --root omarchy
fresh; refused "holds ':' or ','" --root "$tmp/fs/Volumes/a:b"
fresh; mkdir -p "$shared"; touch "$shared/.other"; refused "belongs to other, not me"
fresh; mkdir -p "$tmp/fs/Users/me/x"; ln -s "$tmp/fs/Users/me/x" "$shared"; refused "is a symbolic link: refused"
echo "ok: refused: root, Linux, Intel, macOS 12, no Homebrew, a root under or holding the home directory, relative, with ':', another user's, a link"

echo "PREP-MAC OK"
