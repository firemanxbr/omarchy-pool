#!/usr/bin/env bash
# What .github/workflows/rollback.yml runs (factory/bin/release-rollback,
# #277 part 3), against stubs: docker buildx imagetools, cosign, npm and
# wrangler (npx) record what they are asked; the pool's /version answers
# what a deploy made it run; git is a real repository with two release tags.
#
# `release-rollback v1.0.2` re-points :x86_64, :aarch64 and :latest at
# v1.0.2's images (:<arch>-v1.0.2) and signs each new digest, deploys the
# Worker from the tag with POOL_VERSION=v1.0.2 and no migration, records a
# deploy event and checks the running version. A `to` that is not a release
# tag of the repository, or a missing deploy token, moves nothing.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/repo"
export STUB_LOG="$tmp/log" STUB_VERSION="$tmp/version"
: > "$STUB_LOG"; echo v1.0.3 > "$STUB_VERSION"
fail() { echo "FAIL: $*" >&2; echo "--- log ---" >&2; cat "$STUB_LOG" >&2; exit 1; }

# A repository with three releases, each with a worker/ to deploy: v1.0.1 from before #277 (no worker/src/orders.ts), v1.0.2 and v1.0.3 after.
(
  cd "$tmp/repo"
  git init -q; git config user.email ci@example.invalid; git config user.name ci
  mkdir -p worker/src; echo '{"name":"worker","version":"0.0.0"}' > worker/package.json
  git add -A; git commit -qm "v1.0.1"; git tag v1.0.1
  echo '// the orders' > worker/src/orders.ts
  git add -A; git commit -qm "v1.0.2"; git tag v1.0.2
  echo '{"name":"worker","version":"0.0.0","next":true}' > worker/package.json
  git commit -qam "v1.0.3"; git tag v1.0.3
)

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$tmp/bin/$1"; chmod +x "$tmp/bin/$1"; }
# imagetools create records; inspect answers a digest per tag, and fails for an image never pushed.
stub docker 'echo "docker $*" >> "$STUB_LOG"
[[ "$1 $2" == "buildx imagetools" ]] || exit 9
case "$3" in
  create) exit 0 ;;
  inspect) [[ "$4" == *"-v9.9.8" ]] && { echo "not found" >&2; exit 1; }; [[ "$*" == *"--format"* ]] && printf "\"sha256:%s\"\n" "$( (if command -v sha256sum >/dev/null; then printf %s "$4" | sha256sum; else printf %s "$4" | shasum -a 256; fi) | cut -c1-64)"; exit 0 ;;
esac'
stub cosign 'echo "cosign $*" >> "$STUB_LOG"'
stub npm 'echo "npm $* (in $(basename "$(dirname "$PWD")")/$(basename "$PWD"), $(jq -c .next package.json))" >> "$STUB_LOG"'
# wrangler deploy makes the pool run what it was given; d1 execute records.
stub npx 'echo "npx $*" >> "$STUB_LOG"
for a in "$@"; do [[ "$a" == POOL_VERSION:* ]] && echo "${a#POOL_VERSION:}" > "$STUB_VERSION"; done; exit 0'
stub curl 'echo "curl ${@: -1}" >> "$STUB_LOG"; printf "{\"version\":\"%s\"}\n" "$(cat "$STUB_VERSION")"'
stub sleep 'exit 0'
export PATH="$tmp/bin:$PATH" IMAGE=ghcr.io/firemanxbr/omarchy-worker OMARCHY_API=http://pool.test CLOUDFLARE_API_TOKEN=cf-test-token
R="$root/factory/bin/release-rollback"

# The rollback: the three tags from :<arch>-v1.0.2, each new digest signed, then the Worker of the tag.
out="$(cd "$tmp/repo" && "$R" v1.0.2 2>&1)" || fail "release-rollback v1.0.2 exited $?: $out"
creates="$(grep 'imagetools create' "$STUB_LOG")"
[[ "$creates" == "docker buildx imagetools create -t $IMAGE:x86_64 $IMAGE:x86_64-v1.0.2
docker buildx imagetools create -t $IMAGE:aarch64 $IMAGE:aarch64-v1.0.2
docker buildx imagetools create -t $IMAGE:latest $IMAGE:x86_64-v1.0.2 $IMAGE:aarch64-v1.0.2" ]] || fail "the three tags re-pointed at v1.0.2's images, the architectures first: $creates"
[[ "$(grep -cE "^cosign sign --yes $IMAGE@sha256:[0-9a-f]{64}$" "$STUB_LOG")" == 3 ]] || fail "each new digest signed"
grep -q "npm ci (in repo-at/worker, null)" <<<"$(sed -E 's#\(in [^/]+/worker#(in repo-at/worker#' "$STUB_LOG")" || fail "the Worker is built from the tag's own tree (v1.0.2's package.json): $(grep npm "$STUB_LOG")"
deploy="$(grep 'npx wrangler deploy' "$STUB_LOG")"
[[ "$deploy" == "npx wrangler deploy --var POOL_VERSION:v1.0.2 --var POOL_COMMIT:$(git -C "$tmp/repo" rev-parse 'v1.0.2^{commit}') --var POOL_DEPLOYED_AT:"* ]] || fail "the Worker deployed with the release's version and commit: $deploy"
grep -q "migrations apply" "$STUB_LOG" && fail "a rollback runs no migration: they are forward-only"
grep -q "UPDATE build_workers" "$STUB_LOG" && fail "a Worker from #277 on keeps its columns to itself: nothing to clear"
# The images move before the Worker: a pool at the older release never waits for images that are not there.
[[ "$(grep -n 'imagetools create -t .*:latest' "$STUB_LOG" | cut -d: -f1)" -lt "$(grep -n 'wrangler deploy' "$STUB_LOG" | cut -d: -f1)" ]] || fail "the images before the Worker"
grep -q "npx wrangler d1 execute omarchy-repo --remote --command INSERT INTO events (kind, status, summary, payload) VALUES ('deploy', 'ok', 'omarchy-pool rolled back to v1.0.2 (from v1.0.3)'" "$STUB_LOG" || fail "a deploy event says it: $(grep d1 "$STUB_LOG")"
grep -q "running v1.0.2: every updater follows it within two minutes" <<<"$out" || fail "and the running version is checked: $out"
[[ -z "$(git -C "$tmp/repo" worktree list | sed 1d)" ]] || fail "the tag's checkout is removed: $(git -C "$tmp/repo" worktree list)"
echo "ok: the images and the Worker go back"

# Back past #277: what that Worker's listing would serve of #277's columns is cleared, before it is deployed.
echo v1.0.3 > "$STUB_VERSION"; : > "$STUB_LOG"
out="$(cd "$tmp/repo" && "$R" v1.0.1 2>&1)" || fail "release-rollback v1.0.1 exited $?: $out"
clear="$(grep -n "npx wrangler d1 execute omarchy-repo --remote --command UPDATE build_workers SET site = NULL, instance = NULL, instance_prev = NULL, auto_orders = NULL" "$STUB_LOG" | cut -d: -f1)"
[[ -n "$clear" ]] || fail "a Worker from before #277: site, instance and the rules' state cleared: $(grep d1 "$STUB_LOG")"
(( clear < $(grep -n 'wrangler deploy' "$STUB_LOG" | cut -d: -f1) )) || fail "cleared before that Worker is deployed"
grep -q "is from before #277" <<<"$out" || fail "and says so: $out"

# Refused, nothing moved: not a tag, not a tag of this repository, a tag whose image was never pushed, no deploy token.
for bad in "" latest v1.0 "v1.0.2;rm -rf /" v9.9.9; do
  : > "$STUB_LOG"
  if out="$(cd "$tmp/repo" && "$R" "$bad" 2>&1)"; then fail "'$bad' must be refused: $out"; fi
  grep -qE 'imagetools create|wrangler|cosign' "$STUB_LOG" && fail "'$bad' moved something: $(cat "$STUB_LOG")"
  true
done
(cd "$tmp/repo" && git tag v9.9.8)
: > "$STUB_LOG"
if out="$(cd "$tmp/repo" && "$R" v9.9.8 2>&1)"; then fail "a release whose image was never pushed must be refused: $out"; fi
grep -q "x86_64-v9.9.8 does not exist" <<<"$out" && ! grep -qE 'imagetools create|wrangler' "$STUB_LOG" || fail "and nothing moved: $out / $(cat "$STUB_LOG")"
: > "$STUB_LOG"
if out="$(cd "$tmp/repo" && CLOUDFLARE_API_TOKEN= "$R" v1.0.2 2>&1)"; then fail "no deploy token must be refused: $out"; fi
grep -q "the Worker has to go back with the images" <<<"$out" && ! grep -q 'imagetools create' "$STUB_LOG" || fail "without the token, nothing moves: $out"
echo "ok: refused before anything moves"
echo "ROLLBACK WORKFLOW OK"
