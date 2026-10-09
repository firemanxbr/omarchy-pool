#!/usr/bin/env bash
# The build user's environment (factory/worker/omarchy-build-worker.sh, as_builder): an allowlist that
# keeps the egress proxy's variables when the task has them — on a host a task's network is internal with
# no DNS, so makepkg reaches a source only through its sidecar (#319, #413) — and nothing else of root's.
# Run in a container of STUB_IMAGE as root, with a `builder` user, the function taken from the script.
#
# Requires: docker or podman. STUB_IMAGE: an image with bash and runuser (default debian:stable-slim).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="${RUNTIME:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
STUB_IMAGE="${STUB_IMAGE:-docker.io/library/debian:stable-slim}"
fail() { echo "builder-env: FAIL — $*" >&2; exit 1; }
fn="$(sed -n '/^as_builder() {/p' "$root/factory/worker/omarchy-build-worker.sh")"
[[ -n "$fn" ]] || fail "no as_builder in factory/worker/omarchy-build-worker.sh"
"$RT" image inspect "$STUB_IMAGE" >/dev/null 2>&1 || "$RT" pull -q "$STUB_IMAGE" >/dev/null
probe() { # [-e K=V …] → the builder's environment, one line each
  "$RT" run --rm "$@" -e AS_BUILDER="$fn" "$STUB_IMAGE" bash -c 'set -euo pipefail; useradd -m builder; eval "$AS_BUILDER"; as_builder env'
}
with="$(probe -e HTTPS_PROXY=http://10.231.0.2:3128 -e https_proxy=http://10.231.0.2:3128 -e HTTP_PROXY=http://10.231.0.2:3128 -e http_proxy=http://10.231.0.2:3128 -e NO_PROXY=localhost,127.0.0.1 -e no_proxy=localhost,127.0.0.1 -e OMARCHY_SECRET=root-only)"
for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy; do
  grep -qx "$v=http://10.231.0.2:3128" <<<"$with" || fail "the builder has no $v: $with"
done
grep -qx 'no_proxy=localhost,127.0.0.1' <<<"$with" || fail "the builder has no no_proxy"
! grep -q '^OMARCHY_SECRET=' <<<"$with" || fail "root's other variables reach the builder"
grep -qx 'USER=builder' <<<"$with" || fail "not the builder's environment: $with"
without="$(probe)"
! grep -qi '_proxy=' <<<"$without" || fail "a proxy variable appeared with none set: $without"
echo "builder-env: ok"
