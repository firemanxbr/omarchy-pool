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
# - The signed host bundle (#311): the release is created as a draft;
#   worker-image builds from the run's own binaries (a draft serves nothing);
#   the agent job builds the three agent binaries with factory/bin/build-agent;
#   host-bundle, in the release environment, lints, writes, signs (the exact
#   cosign, the new bundle format), verifies with every agent of the last 30
#   days and only then adds its assets to the draft; publish-release
#   publishes it once every asset is there, and deploy needs publish-release.
#   factory/bin/publish-release and factory/bin/verify-with-agents run here
#   against a stubbed gh and stub agents.
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

# --- the signed host bundle (#311) -------------------------------------------------
needs_of() { grep -E '^    needs: ' <<<"$1"; }
needs_has() { grep -qE "^    needs: (\[[^]]*\b$2\b[^]]*\]|$2)$" <<<"$1"; }

pub="$(job publish)"
grep -qF 'args=(--draft --target "$GITHUB_SHA"' <<<"$pub" || fail "publish creates the release as a draft"
grep -qF 'gh release create "$VERSION" "${args[@]}" dist/*' <<<"$pub" || fail "publish attaches the binaries when it creates the draft"
grep -qF 'already published and cannot change' <<<"$pub" || fail "publish refuses to run again on a published (immutable) release"
grep -q -- '--draft=false' "$W" && fail "release.yml publishes nothing itself: factory/bin/publish-release does, once every asset is there"
echo "ok: the release is created as a draft"

leg="$(job worker-image)"
needs_has "$leg" build || fail "worker-image builds from the run's binaries: $(needs_of "$leg")"
grep -qF 'name: dist-${{ matrix.arch }}' <<<"$leg" && grep -qF -- '--build-arg TOOLS_URL=http://127.0.0.1:8765' <<<"$leg" \
  || fail "worker-image serves the run's own binaries to the build (the draft serves nothing)"
echo "ok: the worker image is built from the run's own binaries"

agent="$(job agent)"
[[ -n "$agent" ]] || fail "release.yml has an agent job"
for t in "x86_64-unknown-linux-musl omarchy-agent-x86_64-linux-musl" "aarch64-unknown-linux-musl omarchy-agent-aarch64-linux-musl" "aarch64-apple-darwin omarchy-agent-aarch64-darwin"; do
  read -r target asset <<<"$t"
  grep -qF "target: $target" <<<"$agent" && grep -qF "asset: $asset" <<<"$agent" || fail "the agent job builds $target as $asset"
done
grep -qF 'bash factory/bin/build-agent ${{ matrix.target }} agent/${{ matrix.asset }}' <<<"$agent" || fail "the agent job builds with factory/bin/build-agent (the build tests/agent-reproducible.sh checks)"
grep -qF 'fetch-depth: 0' <<<"$agent" || fail "the agent job has the history build-agent takes SOURCE_DATE_EPOCH from"
grep -q 'rust-cache' <<<"$agent" && fail "the agent job builds from scratch (no cache)"
echo "ok: the agent job builds the three agent binaries reproducibly"

hbj="$(job host-bundle)"
[[ -n "$hbj" ]] || fail "release.yml has a host-bundle job"
for need in publish agent worker-image-manifest; do needs_has "$hbj" "$need" || fail "host-bundle needs $need: $(needs_of "$hbj")"; done
grep -qE '^    environment: release$' <<<"$hbj" || fail "host-bundle signs in the release environment"
grep -qE '^      attestations: write$' <<<"$hbj" && grep -qE 'uses: actions/attest-build-provenance@[0-9a-f]{40} # v[0-9.]+$' <<<"$hbj" \
  || fail "host-bundle attests the agent binaries' provenance, the action pinned by commit"
lint="$(line_of "$hbj" 'lint-set "$set"')"; build="$(line_of "$hbj" 'factory/bin/host-bundle build --release "$VERSION"')"
sign="$(line_of "$hbj" 'cosign sign-blob --yes')"; verify="$(line_of "$hbj" 'bash factory/bin/verify-with-agents')"
upload="$(line_of "$hbj" 'gh release upload "$VERSION"')"
[[ -n "$lint" && -n "$build" && -n "$sign" && -n "$verify" && -n "$upload" ]] && (( lint < build && build < sign && sign < verify && verify < upload )) \
  || fail "host-bundle lints, writes, signs, verifies, then uploads: ${lint:-never} ${build:-never} ${sign:-never} ${verify:-never} ${upload:-never}"
grep -qF -- '--new-bundle-format --bundle "$b.sigstore.json" "$b"' <<<"$hbj" || fail "the bundle is signed into a Sigstore bundle (v0.3), the format verify reads"
grep -qF 'factory/bin/host-bundle check-tools' <<<"$hbj" || fail "host-bundle checks the pinned tools against their downloads"
grep -qF 'factory/bin/host-bundle worker-image "$IMAGE" "$VERSION"' <<<"$hbj" || fail "host-bundle reads the pushed worker image's digests"
grep -qF -- '--probe' <<<"$hbj" || fail "host-bundle writes the probe (an extra outer field) and verifies it too"
up="$(sed -n "${upload},\$p" <<<"$hbj")"
for a in omarchy-agent-x86_64-linux-musl omarchy-agent-aarch64-linux-musl omarchy-agent-aarch64-darwin 'omarchy-host-$VERSION.tar.gz"' 'omarchy-host-$VERSION.tar.gz.sigstore.json' out/install.sh; do
  grep -qF -- "$a" <<<"$up" || fail "host-bundle uploads $a to the draft"
done
echo "ok: host-bundle lints, writes, signs, verifies with the fleet's agents, then adds everything to the draft"

pr="$(job publish-release)"
needs_has "$pr" host-bundle || fail "publish-release needs host-bundle: $(needs_of "$pr")"
grep -qF 'factory/bin/publish-release "${{ needs.version.outputs.version }}"' <<<"$pr" || fail "publish-release runs factory/bin/publish-release"
deploy="$(job deploy)"
needs_has "$deploy" publish-release || fail "deploy needs publish-release: $(needs_of "$deploy")"
echo "ok: the release is published only after host-bundle, and the pool deployed only after that"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
# A stubbed gh: the release's state and assets from files, every edit recorded.
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "release view")
    case "$*" in
      *isDraft*) cat "$GH_STATE" ;;
      *assets*) cat "$GH_ASSETS" ;;
    esac ;;
  "release edit") [[ "$*" == *"--draft=false"* ]] && echo false > "$GH_STATE" ;;
  "release list") cat "$GH_RELEASES" ;;
  "release download")
    tag="$3"; dir=""; while [[ $# -gt 0 ]]; do [[ "$1" == --dir ]] && dir="$2"; shift; done
    [[ -f "$STUB_AGENTS/$tag" ]] || exit 1
    mkdir -p "$dir"; cp "$STUB_AGENTS/$tag" "$dir/omarchy-agent-x86_64-linux-musl" ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$tmp/bin/gh"
export GH_LOG="$tmp/gh.log" GH_STATE="$tmp/state" GH_ASSETS="$tmp/assets" GH_RELEASES="$tmp/releases" STUB_AGENTS="$tmp/agents"
v=v1.2.3
all="omarchy-pool-$v-x86_64-linux.tar.gz omarchy-pool-$v-x86_64-linux.tar.gz.sha256 omarchy-pool-$v-aarch64-linux.tar.gz omarchy-pool-$v-aarch64-linux.tar.gz.sha256 omarchy-staging.pub.asc omarchy-agent-x86_64-linux-musl omarchy-agent-aarch64-linux-musl omarchy-agent-aarch64-darwin omarchy-host-$v.tar.gz omarchy-host-$v.tar.gz.sigstore.json install.sh"
publish() { PATH="$tmp/bin:$PATH" "$here/../factory/bin/publish-release" "$v" > "$tmp/out" 2>&1; }
for gone in omarchy-host-$v.tar.gz.sigstore.json omarchy-agent-aarch64-darwin install.sh; do
  echo true > "$GH_STATE"; : > "$GH_LOG"; tr ' ' '\n' <<<"$all" | grep -vxF "$gone" > "$GH_ASSETS"
  publish && fail "a draft without $gone was published"
  grep -qF "lacks $gone; it stays a draft" "$tmp/out" || fail "the refusal names $gone: $(cat "$tmp/out")"
  grep -q 'release edit' "$GH_LOG" && fail "a draft without $gone was edited"
done
echo true > "$GH_STATE"; : > "$GH_LOG"; { tr ' ' '\n' <<<"$all"; echo build-images.json; } > "$GH_ASSETS"
publish || fail "a draft with every asset (and one more) is published: $(cat "$tmp/out")"
grep -qx "release edit $v --draft=false" "$GH_LOG" || fail "publish-release publishes the draft: $(cat "$GH_LOG")"
: > "$GH_LOG"; publish || fail "a published release with every asset: nothing to do"
grep -q 'release edit' "$GH_LOG" && fail "a published release is not edited again"
tr ' ' '\n' <<<"$all" | grep -vxF install.sh > "$GH_ASSETS"
publish && fail "a published release without install.sh is reported"
echo "ok: publish-release publishes a draft only once every asset is on it"

# verify-with-agents: stub agents answer as their name says.
mkdir -p "$STUB_AGENTS"
agent_stub() { # path, exit code on the bundle, exit code on the probe
  printf '#!/bin/sh\n[ "$1" = --version ] && { echo "omarchy-agent %s"; exit 0; }\ncase "$3" in *probe*) exit %s ;; *) exit %s ;; esac\n' "$(basename "$1")" "$3" "$2" > "$1"
  chmod +x "$1"
}
recent="$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) - d.timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
mkdir -p "$tmp/out-bundle/probe"; touch "$tmp/out-bundle/b.tar.gz" "$tmp/out-bundle/probe/b.tar.gz"
withagents() { PATH="$tmp/bin:$PATH" "$here/../factory/bin/verify-with-agents" "$tmp/out-bundle/b.tar.gz" "$tmp/out-bundle/probe/b.tar.gz" "$tmp/new" > "$tmp/out" 2>&1; }
# Releases: v1.0.2 (2 days ago, an agent), v1.0.1 (2 days ago, no agent), the jq filter drops older ones.
printf 'v1.0.2\nv1.0.1\n' > "$GH_RELEASES"
agent_stub "$tmp/new" 0 0; agent_stub "$STUB_AGENTS/v1.0.2" 0 0
withagents || fail "every agent takes the bundle: $(cat "$tmp/out")"
grep -qF "skip: v1.0.1 ships no agent" "$tmp/out" && grep -qF "and 1 earlier agent(s)" "$tmp/out" || fail "a release with no agent is skipped: $(cat "$tmp/out")"
grep -qF 'release list --exclude-drafts' "$GH_LOG" && grep -qF 'select(.publishedAt >= ' "$GH_LOG" || fail "the releases of the last 30 days, drafts excluded: $(grep 'release list' "$GH_LOG")"
agent_stub "$STUB_AGENTS/v1.0.2" 3 3
withagents || fail "an earlier agent that needs a newer agent is fine (it updates itself first): $(cat "$tmp/out")"
agent_stub "$STUB_AGENTS/v1.0.2" 0 1
withagents && fail "an earlier agent whose outer parser refuses the probe's extra field fails the release"
grep -qF "v1.0.2's agent" "$tmp/out" && grep -qF "refuses the probe" "$tmp/out" || fail "the failure names the agent and the probe: $(cat "$tmp/out")"
agent_stub "$STUB_AGENTS/v1.0.2" 1 0
withagents && fail "an earlier agent refusing the bundle fails the release"
agent_stub "$STUB_AGENTS/v1.0.2" 0 0; agent_stub "$tmp/new" 3 0
withagents && fail "the new agent must verify the bundle itself (exit 0), not ask for a newer agent"
agent_stub "$tmp/new" 0 0; cp "$tmp/new" "$STUB_AGENTS/v1.0.2"
withagents || fail "an earlier release shipping this very agent: $(cat "$tmp/out")"
grep -qF "skip: v1.0.2's agent was already run" "$tmp/out" || fail "one binary runs once: $(cat "$tmp/out")"
echo "ok: verify-with-agents: the new agent and every earlier one of the last 30 days, the probe included; a refusal fails"
echo "RELEASE WORKFLOW OK"
