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
#   cosign, the new bundle format) and attests; verify-agents, a read-only
#   job with no OIDC token, verifies with every agent of the last 30 days
#   (each attested by release.yml on main); only then does
#   host-bundle-upload add the assets to the draft; publish-release
#   publishes it once every asset is there with the bytes the run made, and
#   deploy needs publish-release. factory/bin/publish-release and
#   factory/bin/verify-with-agents run here against a stubbed gh and stub
#   agents.
# - publish refuses a published release (#351, #311): it is immutable, and
#   anyone with write access can make a v* tag and a release, so a release
#   this run did not make is never reused; a draft an earlier run (or a
#   person) left is made again, so the draft carries only this run's bytes;
#   a v* tag of this version at another commit is refused before any draft
#   is deleted or created.
# - build-images (#312) resolves each task build image to a digest with
#   factory/bin/build-images, which fails when a tag does not resolve —
#   checked here against a stubbed buildx — and publish needs it and attaches
#   build-images.json in the step that creates the release. The script's
#   tags are pkg-repo's fallback tags (crates/pkg-repo/src/work.rs). Its
#   outputs (the two digests) are what host-bundle renders into the host
#   set's dispatcher and writes into manifest.json's inner.images.build, so
#   host-bundle needs it.
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
pub="$(job publish)"
[[ -n "$pub" ]] || fail "release.yml has a publish job"
refuse="$(line_of "$pub" 'if gh release view "$VERSION" >/dev/null 2>&1 && [[ "$(gh release view "$VERSION" --json isDraft --jq .isDraft)" != true ]]; then')"
tagged="$(line_of "$pub" 'at="$(gh api "repos/$GITHUB_REPOSITORY/commits/$VERSION" --jq .sha')"
remade="$(line_of "$pub" 'gh release delete "$VERSION" --yes')"
create="$(line_of "$pub" 'gh release create "$VERSION"')"
[[ -n "$refuse" && -n "$tagged" && -n "$remade" && -n "$create" ]] && (( refuse < tagged && tagged < remade && remade < create )) \
  || fail "publish refuses a published release, then a tag at another commit, before it deletes a stale draft and creates its own: ${refuse:-never}, ${tagged:-never}, ${remade:-never}, ${create:-never}"
sed -n "$((refuse + 1))p" <<<"$pub" | grep -qE '; exit 1$' || fail "a published release fails the run: $(sed -n "$((refuse + 1))p" <<<"$pub")"
sed -n "$((tagged + 1)),$((tagged + 2))p" <<<"$pub" | grep -qF '[[ -n "$at" && "$at" != "$GITHUB_SHA" ]]' || fail "a tag at another commit is compared with the run's commit"
sed -n "$((tagged + 2)),$((tagged + 3))p" <<<"$pub" | grep -qE '; exit 1$' || fail "a tag at another commit fails the run"
grep -qF -- '--cleanup-tag' <<<"$pub" && fail "deleting a stale draft removes no tag"
grep -qE 'exit 0|skipping' <<<"$pub" && fail "publish never skips to reuse a release it did not make: $(grep -nE 'exit 0|skipping' <<<"$pub")"
echo "ok: publish refuses a published release or a tag at another commit, and makes a stale draft again, so the release carries only this run's bytes"

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
needs_has "$leg" publish || fail "worker-image waits for publish: a run on a published release pushes no image: $(needs_of "$leg")"
grep -qF 'name: image-digest-${{ matrix.arch }}' <<<"$leg" || fail "each leg hands host-bundle the digest it pushed"
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
grep -q 'rust-cache' <<<"$agent" && fail "the agent job builds from scratch (no cache)"
echo "ok: the agent job builds the three agent binaries reproducibly"

hbj="$(job host-bundle)"
[[ -n "$hbj" ]] || fail "release.yml has a host-bundle job"
for need in publish agent worker-image-manifest; do needs_has "$hbj" "$need" || fail "host-bundle needs $need: $(needs_of "$hbj")"; done
grep -qE '^    environment: release$' <<<"$hbj" || fail "host-bundle signs in the release environment"
grep -qE '^      attestations: write$' <<<"$hbj" && grep -qE 'uses: actions/attest-build-provenance@[0-9a-f]{40} # v[0-9.]+$' <<<"$hbj" \
  || fail "host-bundle attests the agent binaries' provenance, the action pinned by commit"
lint="$(line_of "$hbj" 'lint-set "$set"')"; build="$(line_of "$hbj" 'factory/bin/host-bundle build --release "$VERSION"')"
sign="$(line_of "$hbj" 'cosign sign-blob --yes')"; attest="$(line_of "$hbj" 'uses: actions/attest-build-provenance@')"
handoff="$(line_of "$hbj" 'name: host-bundle')"
[[ -n "$lint" && -n "$build" && -n "$sign" && -n "$attest" && -n "$handoff" ]] && (( lint < build && build < sign && sign < attest && attest < handoff )) \
  || fail "host-bundle lints, writes, signs, attests, then hands the bundle over: ${lint:-never} ${build:-never} ${sign:-never} ${attest:-never} ${handoff:-never}"
sed -n "${attest},\$p" <<<"$hbj" | grep -qE '^ +out/install.sh$' || fail "host-bundle attests install.sh with the agents"
# No earlier agent runs where the signing identity is, and nothing reaches the draft from there.
grep -qF 'verify-with-agents "' <<<"$hbj" && fail "host-bundle runs no earlier agent: verify-agents does, with no signing token"
grep -qF 'gh release upload' <<<"$hbj" && fail "host-bundle uploads nothing: host-bundle-upload does, once verify-agents passed"
grep -qF -- '--new-bundle-format --bundle "$b.sigstore.json" "$b"' <<<"$hbj" || fail "the bundle is signed into a Sigstore bundle (v0.3), the format verify reads"
grep -qF 'factory/bin/host-bundle check-tools' <<<"$hbj" || fail "host-bundle checks the pinned tools against their downloads"
grep -qF 'factory/bin/host-bundle worker-image "$IMAGE" "$VERSION" --index "$INDEX"' <<<"$hbj" \
  && grep -qF 'INDEX: ${{ needs.worker-image-manifest.outputs.index }}' <<<"$hbj" \
  && grep -qF -- '--aarch64 "$(cat image-digest/aarch64)" --x86_64 "$(cat image-digest/x86_64)"' <<<"$hbj" \
  || fail "host-bundle signs the digests the image jobs handed over, not what a tag says after its review"
grep -qF 'index: ${{ steps.tags.outputs.index }}' <<<"$man" || fail "worker-image-manifest hands host-bundle the index it signed"
grep -q 'setup-buildx-action' <<<"$hbj" && fail "host-bundle runs no unpinned buildx setup with its signing token"
grep -qF -- '--probe' <<<"$hbj" || fail "host-bundle writes the probe (an extra outer field) and verifies it too"

va="$(job verify-agents)"
[[ -n "$va" ]] || fail "release.yml has a verify-agents job"
needs_has "$va" host-bundle || fail "verify-agents needs host-bundle: $(needs_of "$va")"
grep -qF 'bash factory/bin/verify-with-agents "out/omarchy-host-$VERSION.tar.gz" "out/probe/omarchy-host-$VERSION.tar.gz" agents/omarchy-agent-x86_64-linux-musl' <<<"$va" \
  || fail "verify-agents runs verify-with-agents on the bundle and the probe"
grep -qE '^    environment:' <<<"$va" && fail "verify-agents is outside the release environment"
grep -qE 'id-token|: write$' <<<"$va" && fail "verify-agents holds no OIDC token and no token that writes: $(grep -E 'id-token|: write' <<<"$va")"
grep -qE '^      contents: read$' <<<"$va" || fail "verify-agents declares its read-only permissions"
echo "ok: the earlier agents run in a read-only job with no signing token"

hbu="$(job host-bundle-upload)"
[[ -n "$hbu" ]] || fail "release.yml has a host-bundle-upload job"
needs_has "$hbu" verify-agents || fail "host-bundle-upload waits for verify-agents: $(needs_of "$hbu")"
grep -q 'id-token' <<<"$hbu" && fail "host-bundle-upload holds no OIDC token"
grep -qE '^ +(run: )?(bash )?(\./)?(agents|out)/' <<<"$hbu" && fail "host-bundle-upload runs no binary"
upload="$(line_of "$hbu" 'gh release upload "$VERSION"')"
[[ -n "$upload" ]] || fail "host-bundle-upload adds the assets to the draft"
up="$(sed -n "${upload},\$p" <<<"$hbu")"
for a in omarchy-agent-x86_64-linux-musl omarchy-agent-aarch64-linux-musl omarchy-agent-aarch64-darwin 'omarchy-host-$VERSION.tar.gz"' 'omarchy-host-$VERSION.tar.gz.sigstore.json' out/install.sh; do
  grep -qF -- "$a" <<<"$up" || fail "host-bundle-upload uploads $a to the draft"
done
# Every file the upload names is one publish-release waits for (one list drifting from the other keeps the release a draft).
for a in $(sed -n "${upload},\$p" <<<"$hbu" | tr -d '\\"' | tr ' ' '\n' | grep -E '^(agents|out)/'); do
  name="$(basename "$a")"; name="${name//\$VERSION/\$v}"
  grep -qF -- "$name" "$here/../factory/bin/publish-release" || fail "publish-release waits for $name, which host-bundle-upload uploads"
done
echo "ok: host-bundle lints, writes, signs and attests; the fleet's agents verify; then everything is added to the draft"

pr="$(job publish-release)"
needs_has "$pr" host-bundle-upload || fail "publish-release needs host-bundle-upload: $(needs_of "$pr")"
grep -qF 'factory/bin/publish-release "${{ needs.version.outputs.version }}" sums' <<<"$pr" || fail "publish-release runs factory/bin/publish-release with the run's own SHA-256"
for art in 'pattern: dist-*' 'pattern: agent-*' 'name: host-bundle'; do
  grep -qF -- "$art" <<<"$pr" || fail "publish-release hashes the run's own artifacts ($art)"
done
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
      *assets*) if [[ -f "$GH_ASSETS_DIR/$3" ]]; then cat "$GH_ASSETS_DIR/$3"; else cat "$GH_ASSETS"; fi ;;
    esac ;;
  "release edit") [[ "$*" == *"--draft=false"* ]] && echo false > "$GH_STATE" ;;
  "release list") cat "$GH_RELEASES" ;;
  "release download")
    tag="$3"; dir=""; while [[ $# -gt 0 ]]; do [[ "$1" == --dir ]] && dir="$2"; shift; done
    mkdir -p "$dir"
    if [[ "$tag" == "$PUBLISHING" ]]; then cp "$GH_DRAFT"/* "$dir/"; exit 0; fi
    [[ -f "$STUB_AGENTS/$tag" ]] || exit 1
    cp "$STUB_AGENTS/$tag" "$dir/omarchy-agent-x86_64-linux-musl" ;;
  "attestation verify")
    # Attested by release.yml on main: the agents named in $STUB_UNATTESTED are not.
    [[ "$*" == *"-R firemanxbr/omarchy-pool --signer-workflow firemanxbr/omarchy-pool/.github/workflows/release.yml --source-ref refs/heads/main"* ]] || exit 9
    for t in $STUB_UNATTESTED; do [[ "$3" == */"$t"/* ]] && { echo "no attestation"; exit 1; }; done
    exit 0 ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$tmp/bin/gh"
v=v1.2.3
export GH_LOG="$tmp/gh.log" GH_STATE="$tmp/state" GH_ASSETS="$tmp/assets" GH_ASSETS_DIR="$tmp/assets.d" GH_RELEASES="$tmp/releases" STUB_AGENTS="$tmp/agents" \
  GH_DRAFT="$tmp/draft" PUBLISHING="$v" STUB_UNATTESTED=""
all="omarchy-pool-$v-x86_64-linux.tar.gz omarchy-pool-$v-x86_64-linux.tar.gz.sha256 omarchy-pool-$v-aarch64-linux.tar.gz omarchy-pool-$v-aarch64-linux.tar.gz.sha256 omarchy-staging.pub.asc omarchy-agent-x86_64-linux-musl omarchy-agent-aarch64-linux-musl omarchy-agent-aarch64-darwin omarchy-host-$v.tar.gz omarchy-host-$v.tar.gz.sigstore.json install.sh build-images.json"
# The draft holds the bytes the run made; sums is their SHA-256, as release.yml's publish-release step writes it.
mkdir -p "$GH_DRAFT"
for a in $all; do echo "the run's $a" > "$GH_DRAFT/$a"; done
(cd "$GH_DRAFT" && for f in *; do if command -v sha256sum >/dev/null; then sha256sum "$f"; else shasum -a 256 "$f"; fi; done) > "$tmp/sums"
publish() { PATH="$tmp/bin:$PATH" "$here/../factory/bin/publish-release" "$v" "$tmp/sums" > "$tmp/out" 2>&1; }
for gone in omarchy-host-$v.tar.gz.sigstore.json omarchy-agent-aarch64-darwin install.sh build-images.json; do
  echo true > "$GH_STATE"; : > "$GH_LOG"; tr ' ' '\n' <<<"$all" | grep -vxF "$gone" > "$GH_ASSETS"
  publish && fail "a draft without $gone was published"
  grep -qF "lacks $gone; it stays a draft" "$tmp/out" || fail "the refusal names $gone: $(cat "$tmp/out")"
  grep -q 'release edit' "$GH_LOG" && fail "a draft without $gone was edited"
done
echo true > "$GH_STATE"; : > "$GH_LOG"; { tr ' ' '\n' <<<"$all"; echo notes.txt; } > "$GH_ASSETS"
publish || fail "a draft with every asset (and one more) is published: $(cat "$tmp/out")"
grep -qx "release edit $v --draft=false" "$GH_LOG" || fail "publish-release publishes the draft: $(cat "$GH_LOG")"
: > "$GH_LOG"; publish || fail "a published release with every asset: nothing to do"
grep -q 'release edit' "$GH_LOG" && fail "a published release is not edited again"
tr ' ' '\n' <<<"$all" | grep -vxF install.sh > "$GH_ASSETS"
publish && fail "a published release without install.sh is reported"
# A draft's asset replaced after the run uploaded it: the names are all there, the bytes are not the run's.
tr ' ' '\n' <<<"$all" > "$GH_ASSETS"
for swapped in install.sh "omarchy-pool-$v-aarch64-linux.tar.gz"; do
  echo true > "$GH_STATE"; : > "$GH_LOG"; cp "$GH_DRAFT/$swapped" "$tmp/kept"; echo "someone else's" > "$GH_DRAFT/$swapped"
  publish && fail "a draft whose $swapped was replaced was published"
  grep -qF "$swapped are not the bytes this run made; it stays a draft" "$tmp/out" || fail "the refusal names $swapped: $(cat "$tmp/out")"
  grep -q 'release edit' "$GH_LOG" && fail "a draft whose $swapped was replaced was edited"
  cp "$tmp/kept" "$GH_DRAFT/$swapped"
done
grep -vF ' install.sh' "$tmp/sums" > "$tmp/sums.short"; mv "$tmp/sums" "$tmp/sums.full"; mv "$tmp/sums.short" "$tmp/sums"
echo true > "$GH_STATE"; publish && fail "an asset the run's sums do not name is not published"
mv "$tmp/sums.full" "$tmp/sums"
echo "ok: publish-release publishes a draft only once every asset is on it, with the bytes the run made"

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
mkdir -p "$GH_ASSETS_DIR"
printf 'install.sh\nomarchy-agent-x86_64-linux-musl\n' > "$GH_ASSETS_DIR/v1.0.2"
printf 'omarchy-pool-v1.0.1-x86_64-linux.tar.gz\n' > "$GH_ASSETS_DIR/v1.0.1"
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
agent_stub "$STUB_AGENTS/v1.0.2" 0 0; : > "$tmp/ran"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "omarchy-agent fake"; exit 0; }\necho ran >> "%s"; exit 0\n' "$tmp/ran" > "$STUB_AGENTS/v1.0.2"
STUB_UNATTESTED=v1.0.2 withagents && fail "an earlier agent with no attestation by release.yml on main fails the release"
grep -qF "v1.0.2's omarchy-agent-x86_64-linux-musl is not attested by release.yml on refs/heads/main" "$tmp/out" || fail "the failure names the release: $(cat "$tmp/out")"
[[ -s "$tmp/ran" ]] && fail "an agent with no attestation is never run"
withagents || fail "the same agent, attested: $(cat "$tmp/out")"
[[ -s "$tmp/ran" ]] || fail "an attested agent is run"
grep -qF 'attestation verify' "$GH_LOG" || fail "verify-with-agents checks each earlier agent's attestation"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "omarchy-agent env"; exit 0; }\n[ -z "$GH_TOKEN$GITHUB_TOKEN" ]\n' > "$STUB_AGENTS/v1.0.2"
GH_TOKEN=secret GITHUB_TOKEN=secret withagents || fail "an agent runs without GH_TOKEN or GITHUB_TOKEN in its environment: $(cat "$tmp/out")"
rm "$STUB_AGENTS/v1.0.2"
withagents && fail "a release listing an agent that cannot be downloaded fails the release (a network error is not 'no agent')"
grep -qF "v1.0.2 ships omarchy-agent-x86_64-linux-musl but it cannot be downloaded" "$tmp/out" || fail "the failure names the release: $(cat "$tmp/out")"
echo "ok: verify-with-agents: the new agent and every earlier one of the last 30 days, the probe included; a refusal fails"

images="$(job build-images)"
[[ -n "$images" ]] || fail "release.yml has a build-images job"
grep -qF 'factory/bin/build-images dist/build-images.json' <<<"$images" || fail "build-images runs factory/bin/build-images"
grep -qF 'name: dist-build-images' <<<"$images" || fail "build-images uploads build-images.json beside the binaries (dist-*)"
pub="$(job publish)"
grep -qE '^    needs: \[[^]]*\bbuild-images\b[^]]*\]$' <<<"$pub" || fail "publish waits for the build images: $(grep needs: <<<"$pub")"
grep -qF 'pattern: dist-*' <<<"$pub" && grep -qF 'gh release create "$VERSION" "${args[@]}" dist/*' <<<"$pub" \
  || fail "publish attaches build-images.json when it creates the release (immutable releases)"
echo "ok: the release resolves both task build images to digests before it is published, and carries them"

# The host bundle renders the digests build-images resolved, not a stand-in (#311, #312).
grep -qF 'aarch64: ${{ steps.resolve.outputs.aarch64 }}' <<<"$images" && grep -qF 'x86_64: ${{ steps.resolve.outputs.x86_64 }}' <<<"$images" \
  || fail "build-images hands both digests over as its outputs"
needs_has "$hbj" build-images || fail "host-bundle needs build-images: $(needs_of "$hbj")"
grep -qF 'BUILD_AARCH64: ${{ needs.build-images.outputs.aarch64 }}' <<<"$hbj" && grep -qF 'BUILD_X86_64: ${{ needs.build-images.outputs.x86_64 }}' <<<"$hbj" \
  || fail "host-bundle renders the build images build-images resolved"
grep -qE '^      BUILD_(AARCH64|X86_64): docker\.io/' <<<"$hbj" && fail "host-bundle names no build image of its own"
grep -qF -- '--build-images build-images.json' <<<"$hbj" || fail "host-bundle writes the build images into manifest.json (inner.images.build)"
echo "ok: the host bundle carries the build images the release resolved"

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
resolve() { PATH="$tmp/bin:$PATH" GITHUB_STEP_SUMMARY="$tmp/summary" "$here/../factory/bin/build-images" "$tmp/build-images.json" 2>"$tmp/err"; }
: > "$tmp/summary"
resolve || { cat "$tmp/err" >&2; fail "both tags resolve"; }
want_arm="docker.io/menci/archlinuxarm@sha256:$(printf 'a%.0s' {1..64})"
want_x86="docker.io/library/archlinux@sha256:$(printf 'b%.0s' {1..64})"
python3 - "$tmp/build-images.json" "$want_arm" "$want_x86" <<'PY' || fail "build-images.json is the manifest's inner.images.build"
import json, sys
got = json.load(open(sys.argv[1]))
assert got == {"aarch64": sys.argv[2], "x86_64": sys.argv[3]}, got
PY
grep -qF "$want_arm" "$tmp/summary" && grep -qF "$want_x86" "$tmp/summary" || fail "the job summary shows both digests: $(cat "$tmp/summary")"
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
