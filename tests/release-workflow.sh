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
# - build-images (#312) resolves each task build image to a digest with
#   factory/bin/build-images, which fails when a tag does not resolve —
#   checked here against a stubbed buildx — and publish needs it and attaches
#   build-images.json in the step that creates the release. The script's
#   tags are pkg-repo's fallback tags (crates/pkg-repo/src/work.rs).
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

images="$(job build-images)"
[[ -n "$images" ]] || fail "release.yml has a build-images job"
grep -qF 'factory/bin/build-images dist/build-images.json' <<<"$images" || fail "build-images runs factory/bin/build-images"
grep -qF 'aarch64: ${{ steps.resolve.outputs.aarch64 }}' <<<"$images" && grep -qF 'x86_64: ${{ steps.resolve.outputs.x86_64 }}' <<<"$images" \
  || fail "build-images hands both digests on as outputs"
grep -qF 'name: dist-build-images' <<<"$images" || fail "build-images uploads build-images.json beside the binaries (dist-*)"
pub="$(job publish)"
grep -qE '^    needs: \[[^]]*\bbuild-images\b[^]]*\]$' <<<"$pub" || fail "publish waits for the build images: $(grep needs: <<<"$pub")"
grep -qF 'pattern: dist-*' <<<"$pub" && grep -qF 'gh release create "$VERSION" "${args[@]}" dist/*' <<<"$pub" \
  || fail "publish attaches build-images.json when it creates the release (immutable releases)"
echo "ok: the release resolves both task build images to digests before it is published, and carries them"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
# A stubbed buildx: the digest STUB_<repo> names for that tag, or what STUB_FAIL says.
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
[[ "$1 $2 $3" == "buildx imagetools inspect" ]] || { echo "unexpected: $*" >&2; exit 2; }
case "$4" in
  docker.io/menci/archlinuxarm:base-devel) d="sha256:$(printf 'a%.0s' {1..64})" ;;
  docker.io/library/archlinux:base-devel) d="sha256:$(printf 'b%.0s' {1..64})" ;;
  *) echo "no such tag $4" >&2; exit 1 ;;
esac
[[ "${STUB_FAIL:-}" == "$4" ]] && { echo "manifest unknown" >&2; exit 1; }
[[ "${STUB_GARBAGE:-}" == "$4" ]] && d="${STUB_VALUE-}"
printf '"%s"\n' "$d"
STUB
chmod +x "$tmp/bin/docker"
resolve() { PATH="$tmp/bin:$PATH" GITHUB_OUTPUT="$tmp/out" "$here/../factory/bin/build-images" "$tmp/build-images.json" 2>"$tmp/err"; }
: > "$tmp/out"
resolve || { cat "$tmp/err" >&2; fail "both tags resolve"; }
want_arm="docker.io/menci/archlinuxarm@sha256:$(printf 'a%.0s' {1..64})"
want_x86="docker.io/library/archlinux@sha256:$(printf 'b%.0s' {1..64})"
python3 - "$tmp/build-images.json" "$want_arm" "$want_x86" <<'PY' || fail "build-images.json is the manifest's inner.images.build"
import json, sys
got = json.load(open(sys.argv[1]))
assert got == {"aarch64": sys.argv[2], "x86_64": sys.argv[3]}, got
PY
[[ "$(cat "$tmp/out")" == "aarch64=$want_arm"$'\n'"x86_64=$want_x86" ]] || fail "the job's outputs: $(cat "$tmp/out")"
for tag in docker.io/menci/archlinuxarm:base-devel docker.io/library/archlinux:base-devel; do
  rm -f "$tmp/build-images.json"
  STUB_FAIL="$tag" resolve && fail "$tag not answering fails the release"
  grep -qF "$tag" "$tmp/err" || fail "the failure names $tag: $(cat "$tmp/err")"
  [[ -e "$tmp/build-images.json" ]] && fail "no build-images.json when $tag does not resolve"
  for value in "" "<nil>" "sha256:abc" "sha512:$(printf 'c%.0s' {1..128})"; do
    STUB_GARBAGE="$tag" STUB_VALUE="$value" resolve && fail "$tag answering ${value:-nothing} fails the release"
    [[ -e "$tmp/build-images.json" ]] && fail "no build-images.json when $tag answers ${value:-nothing}"
  done
done
echo "ok: build-images resolves both tags to digests, and fails when either does not resolve"

# The tags the release resolves are the ones pkg-repo falls back to.
for tag in $(sed -n 's/^[A-Z0-9_]*_TAG=//p' "$here/../factory/bin/build-images"); do
  grep -qF "tag: \"$tag\"," "$here/../crates/pkg-repo/src/work.rs" || fail "pkg-repo falls back to $tag"
done
[[ "$(grep -c '^[A-Z0-9_]*_TAG=' "$here/../factory/bin/build-images")" == 2 ]] || fail "one tag per architecture"
echo "ok: the release resolves the tags pkg-repo falls back to"
echo "RELEASE WORKFLOW OK"
