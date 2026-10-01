#!/usr/bin/env bash
# The same agent gives the same omarchy-agent binary (design v2 D17, §4.4):
# an unchanged agent keeps its hash from release to release, so a host never
# restarts for nothing, and anyone can rebuild the binary a release ships and
# compare.
#
# Two builds through factory/bin/build-agent (the script release.yml's agent
# job runs, #311), each on its own copy of the commit in its own directory,
# so a path that leaked into the binary would show. The second copy is a
# later release with no agent change: another file of the repository differs
# (README.md), as it would at the next release, and the binary must not.
# build-agent takes SOURCE_DATE_EPOCH from the agent's own last commit, never
# the release's; this test gives both copies the value the repository's
# history yields, as release.yml's checkout (full history) does.
#
# CI runs it per platform (ci.yml); by hand, on a committed tree:
#   bash tests/agent-reproducible.sh [target-triple]
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
target="${1:-$(rustc -vV | sed -n 's/^host: //p')}"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

SOURCE_DATE_EPOCH="$(git -C "$root" log -1 --format=%ct -- crates/omarchy-agent)"
export SOURCE_DATE_EPOCH
# The physical path: macOS's /var is a link to /private/var, and the compiler sees the latter.
work="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$work"' EXIT

sums=()
for n in first second; do
  src="$work/$n/omarchy-pool"
  mkdir -p "$src"
  git -C "$root" archive HEAD | tar -x -C "$src"
  [[ "$n" == second ]] && echo "A later release: this file changed, the agent did not." >> "$src/README.md"
  bash "$src/factory/bin/build-agent" "$target" "$work/$n/omarchy-agent"
  "$work/$n/omarchy-agent" --version >/dev/null
  sum="$(sha256 "$work/$n/omarchy-agent")"
  sums+=("$sum")
  echo "$n build: $sum"
done

if [[ "${sums[0]}" != "${sums[1]}" ]]; then
  echo "omarchy-agent is not reproducible for $target: ${sums[0]} != ${sums[1]}" >&2
  exit 1
fi
echo "omarchy-agent ($target): two builds of $(git -C "$root" rev-parse --short HEAD), the second with another file changed, one binary: ${sums[0]}"
