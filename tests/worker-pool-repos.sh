#!/usr/bin/env bash
# add_pool_repos against the pool's source directories (packages/, factory/),
# not the old flat $pool/$arch/$repo.db that 404s after the layout change.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/etc" "$tmp/build/pool/docs"
touch "$tmp/build/pool/docs/omarchy-staging.pub.asc"

awk '/^add_pool_repos\(\)/,/^}/' "$root/factory/worker/omarchy-build-worker.sh" \
  | sed "s|/etc/pacman.conf|$tmp/etc/pacman.conf|g; s|/build/pool|$tmp/build/pool|g" \
  > "$tmp/fn.sh"
# shellcheck source=/dev/null
source "$tmp/fn.sh"

cat > "$tmp/bin/curl" <<'S'
#!/usr/bin/env bash
url="${@: -1}"
echo "curl $url" >> "$STUB_LOG"
case "$url" in
  */packages/aarch64/omarchy-packages-edge.db|*/factory/aarch64/omarchy-factory-edge.db) exit 0 ;;
  *) exit 22 ;;
esac
S
cat > "$tmp/bin/pacman-key" <<'S'
#!/usr/bin/env bash
echo "pacman-key $*" >> "$STUB_LOG"
S
cat > "$tmp/bin/gpg" <<'S'
#!/usr/bin/env bash
echo "fpr:::::::::ABCDEF:"
S
cat > "$tmp/bin/pacman" <<'S'
#!/usr/bin/env bash
echo "pacman $*" >> "$STUB_LOG"
S
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH" STUB_LOG="$tmp/log"
: > "$STUB_LOG"
printf '[options]\nArchitecture = aarch64\n' > "$tmp/etc/pacman.conf"

fail() { echo "FAIL: $*" >&2; echo "--- pacman.conf ---" >&2; cat "$tmp/etc/pacman.conf" >&2; echo "--- log ---" >&2; cat "$STUB_LOG" >&2; exit 1; }

add_pool_repos aarch64 https://pool.test

grep -q '^\[omarchy-packages-edge\]' "$tmp/etc/pacman.conf" || fail "packages-edge was not added"
grep -q '^\[omarchy-factory-edge\]' "$tmp/etc/pacman.conf" || fail "factory-edge was not added"
grep -q '^Server = https://pool.test/packages/\$arch$' "$tmp/etc/pacman.conf" || fail "packages Server is not the source directory"
grep -q '^Server = https://pool.test/factory/\$arch$' "$tmp/etc/pacman.conf" || fail "factory Server is not the source directory"
! grep -q 'Server = https://pool.test/\$arch$' "$tmp/etc/pacman.conf" || fail "Server still names the flat directory"
grep -q 'curl https://pool.test/packages/aarch64/omarchy-packages-edge.db' "$STUB_LOG" || fail "did not probe packages/"
grep -q 'curl https://pool.test/factory/aarch64/omarchy-factory-edge.db' "$STUB_LOG" || fail "did not probe factory/"
! grep -q 'curl https://pool.test/aarch64/' "$STUB_LOG" || fail "probed the flat directory"
grep -q 'pacman -Sy' "$STUB_LOG" || fail "no pacman -Sy after adding repos"

# A second call must not append the sections again.
add_pool_repos aarch64 https://pool.test
[[ "$(grep -c '^\[omarchy-packages-edge\]' "$tmp/etc/pacman.conf")" == 1 ]] || fail "packages-edge added twice"
echo "ok"
