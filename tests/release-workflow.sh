#!/usr/bin/env bash
# The release's order of the worker image's tags (#277, part 3), read from
# .github/workflows/release.yml itself: no tag a host follows moves before
# both architectures' images started every role.
#
# - worker-image (a matrix leg per architecture) pushes the version's own
#   `:<arch>-vX.Y.Z` only, then runs tests/image-smoke.sh on it; it moves,
#   tags or signs nothing else. One leg's smoke start that fails moves no
#   tag at all — not even the other architecture's, which the Studio's
#   builders, brokers and agent proxy follow.
# - worker-image-manifest needs both legs, and moves every tag a host
#   follows: first the version's multi-arch `:vX.Y.Z` (the mark that both
#   smoke starts passed, which rollback.yml requires), then `:x86_64` and
#   `:aarch64` (a copy of each version's image), then `:latest`; each
#   signed. No other job moves them.
# - deploy needs worker-image-manifest: the pool moves to the release only
#   once the images exist.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$here/../.github/workflows/release.yml"
fail() { echo "FAIL: $*" >&2; exit 1; }
# A job's block: from `  <job>:` to the next job at the same indentation.
job() { awk -v j="  $1:" '$0 == j { on = 1; print; next } on && /^  [A-Za-z0-9_-]+:$/ { exit } on { print }' "$W"; }
line_of() { # block, fixed text → its first line number in the block, or nothing
  grep -nF -- "$2" <<<"$1" | head -1 | cut -d: -f1
}

leg="$(job worker-image)"
[[ -n "$leg" ]] || fail "release.yml has a worker-image job"
push="$(line_of "$leg" 'docker push "$tag-$VERSION"')"; smoke="$(line_of "$leg" 'bash tests/image-smoke.sh "$IMAGE:${{ matrix.arch }}-$VERSION"')"
[[ -n "$push" && -n "$smoke" ]] && (( push < smoke )) || fail "each leg pushes :<arch>-vX, then starts every role from it: push at ${push:-never}, smoke at ${smoke:-never}"
[[ "$(grep -c 'docker push' <<<"$leg")" == 1 ]] || fail "a leg pushes the version's tag and nothing else: $(grep 'docker push' <<<"$leg")"
for moves in "docker tag" "cosign sign" "imagetools create"; do
  grep -qF -- "$moves" <<<"$leg" && fail "a leg moves no tag a host follows ($moves): the manifest job does, once both legs passed"
done
echo "ok: each architecture's leg pushes its version's image and starts every role from it, and moves nothing"

man="$(job worker-image-manifest)"
[[ -n "$man" ]] || fail "release.yml has a worker-image-manifest job"
grep -qE '^    needs: \[[^]]*\bworker-image\b[^]]*\]$' <<<"$man" || fail "the manifest job needs both legs: $(grep needs: <<<"$man")"
version="$(line_of "$man" 'create -t "$IMAGE:$VERSION" "$IMAGE:x86_64-$VERSION" "$IMAGE:aarch64-$VERSION"')"
arches="$(line_of "$man" 'create --prefer-index=false -t "$IMAGE:$arch" "$IMAGE:$arch-$VERSION"')"
latest="$(line_of "$man" 'create -t "$IMAGE:latest" "$IMAGE:$VERSION"')"
[[ -n "$version" && -n "$arches" && -n "$latest" ]] && (( version < arches && arches < latest )) \
  || fail "the manifest job: the version's tag, then each architecture's (a copy of its version's image), then :latest: ${version:-never}, ${arches:-never}, ${latest:-never}"
grep -qF 'for arch in x86_64 aarch64; do' <<<"$man" || fail "both architectures' tags move there"
[[ "$(grep -cE '^ +sign "\$IMAGE:(\$VERSION|\$arch|latest)"$' <<<"$man")" == 3 ]] || fail "each one signed: $(grep sign <<<"$man")"
# Nowhere else: the whole file moves :latest and the architectures' tags once, in that job.
[[ "$(grep -cE -- '-t "\$IMAGE:(latest|\$arch|x86_64|aarch64)"' "$W")" == 2 ]] || fail "no other job moves :latest or an architecture's tag: $(grep -nE -- '-t "\$IMAGE:' "$W")"
echo "ok: the tags a host follows move in one job, once both architectures started, the version's first and :latest last"

deploy="$(job deploy)"
grep -qE '^    needs: \[[^]]*\bworker-image-manifest\b[^]]*\]$' <<<"$deploy" || fail "the deploy waits for the images: $(grep needs: <<<"$deploy")"
echo "ok: the pool is deployed once the images exist"
echo "RELEASE WORKFLOW OK"
