#!/usr/bin/env bash
# What .github/workflows/rollback.yml runs (factory/bin/release-rollback,
# #277 part 3), against stubs: docker buildx imagetools, cosign, npm and
# wrangler (npx) record what they are asked; the pool's /version answers
# what a deploy made it run; git is a real repository with two release tags.
#
# `release-rollback v1.0.2` checks, before anything moves, that v1.0.2's
# multi-arch :v1.0.2 exists (written by a release only once both
# architectures' smoke starts passed) and that its Worker installs and
# builds; then re-points :x86_64 and :aarch64 at v1.0.2's own images
# (:<arch>-v1.0.2) and :latest at :v1.0.2, signs each new digest, deploys
# the Worker from the tag with POOL_VERSION=v1.0.2 and no migration,
# records a deploy event and checks the running version. A deploy that
# fails puts the three tags back where they were. Back past #277, the
# columns an older Worker's listing would serve are cleared before its
# deploy, again after it and once more once it runs — every column the
# Worker from #277 withholds but a person's drain, run here against a
# database built from the migrations (#295). A `to` that is not a release tag of the
# repository, a release whose images did not pass both smoke starts, a
# Worker that does not install or build, or a missing deploy token, moves
# nothing.
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
# imagetools create records; inspect answers a digest per reference (the sha256 of its name), and fails for one never pushed:
# the :<arch> tags of v9.9.8, and the multi-arch :v9.9.7 of a release whose smoke start failed (its :<arch>-v9.9.7 were pushed).
sha() { if command -v sha256sum >/dev/null; then printf %s "$1" | sha256sum | cut -c1-64; else printf %s "$1" | shasum -a 256 | cut -c1-64; fi; }
stub docker 'echo "docker $*" >> "$STUB_LOG"
[[ "$1 $2" == "buildx imagetools" ]] || exit 9
case "$3" in
  create) exit 0 ;;
  inspect) [[ "$4" == *"-v9.9.8" || "$4" == *":v9.9.7" ]] && { echo "not found" >&2; exit 1; }; [[ "$*" == *"--format"* ]] && printf "\"sha256:%s\"\n" "$( (if command -v sha256sum >/dev/null; then printf %s "$4" | sha256sum; else printf %s "$4" | shasum -a 256; fi) | cut -c1-64)"; exit 0 ;;
esac'
stub cosign 'echo "cosign $*" >> "$STUB_LOG"'
stub npm 'echo "npm $* (in $(basename "$(dirname "$PWD")")/$(basename "$PWD"), $(jq -c .next package.json))" >> "$STUB_LOG"; [[ -z "${STUB_NPM_FAIL:-}" ]]'
# wrangler deploy makes the pool run what it was given (or fails, with STUB_DEPLOY_FAIL); --dry-run builds; d1 execute records.
stub npx 'echo "npx $*" >> "$STUB_LOG"
[[ " $* " == *" deploy --dry-run "* ]] && exit 0
[[ " $* " == *" deploy "* && -n "${STUB_DEPLOY_FAIL:-}" ]] && { echo "✘ [ERROR] A request to the Cloudflare API failed." >&2; exit 1; }
for a in "$@"; do [[ "$a" == POOL_VERSION:* ]] && echo "${a#POOL_VERSION:}" > "$STUB_VERSION"; done; exit 0'
stub curl 'echo "curl ${@: -1}" >> "$STUB_LOG"; printf "{\"version\":\"%s\"}\n" "$(cat "$STUB_VERSION")"'
stub sleep 'exit 0'
export PATH="$tmp/bin:$PATH" IMAGE=ghcr.io/firemanxbr/omarchy-worker OMARCHY_API=http://pool.test CLOUDFLARE_API_TOKEN=cf-test-token
R="$root/factory/bin/release-rollback"

# The rollback: the architectures' tags from :<arch>-v1.0.2, :latest from :v1.0.2, each new digest signed, then the Worker of the tag.
out="$(cd "$tmp/repo" && "$R" v1.0.2 2>&1)" || fail "release-rollback v1.0.2 exited $?: $out"
creates="$(grep 'imagetools create' "$STUB_LOG")"
[[ "$creates" == "docker buildx imagetools create --prefer-index=false -t $IMAGE:x86_64 $IMAGE:x86_64-v1.0.2
docker buildx imagetools create --prefer-index=false -t $IMAGE:aarch64 $IMAGE:aarch64-v1.0.2
docker buildx imagetools create -t $IMAGE:latest $IMAGE:v1.0.2" ]] || fail "the three tags re-pointed at v1.0.2's images, the architectures first: $creates"
grep -q "^docker buildx imagetools inspect $IMAGE:v1.0.2$" "$STUB_LOG" || fail "the release's multi-arch tag, the mark that both smoke starts passed, is asked for first"
[[ "$(grep -cE "^cosign sign --yes --fulcio-url=https://fulcio.sigstore.dev --rekor-url=https://rekor.sigstore.dev $IMAGE@sha256:[0-9a-f]{64}$" "$STUB_LOG")" == 3 ]] || fail "each new digest signed"
grep -q "npm ci (in repo-at/worker, null)" <<<"$(sed -E 's#\(in [^/]+/worker#(in repo-at/worker#' "$STUB_LOG")" || fail "the Worker is built from the tag's own tree (v1.0.2's package.json): $(grep npm "$STUB_LOG")"
deploy="$(grep 'npx wrangler deploy --var' "$STUB_LOG")"
[[ "$deploy" == "npx wrangler deploy --var POOL_VERSION:v1.0.2 --var POOL_COMMIT:$(git -C "$tmp/repo" rev-parse 'v1.0.2^{commit}') --var POOL_DEPLOYED_AT:"* ]] || fail "the Worker deployed with the release's version and commit: $deploy"
grep -q "migrations apply" "$STUB_LOG" && fail "a rollback runs no migration: they are forward-only"
grep -q "UPDATE build_workers" "$STUB_LOG" && fail "a Worker from #277 on keeps its columns to itself: nothing to clear"
# Before any tag moves, the Worker is installed and built; the images move before the Worker is deployed (a pool at the older
# release never waits for images that are not there).
line() { grep -n -- "$1" "$STUB_LOG" | head -1 | cut -d: -f1; }
first_move="$(line 'imagetools create')"
(( $(line '^npm ci') < first_move && $(line 'wrangler deploy --dry-run') < first_move )) || fail "the Worker installs and builds before any tag moves: $(grep -nE 'npm|npx|create' "$STUB_LOG")"
(( $(line 'imagetools create -t .*:latest') < $(line 'wrangler deploy --var') )) || fail "the images before the Worker"
grep -q "npx wrangler d1 execute omarchy-repo --remote --command INSERT INTO events (kind, status, summary, payload) VALUES ('deploy', 'ok', 'omarchy-pool rolled back to v1.0.2 (from v1.0.3)'" "$STUB_LOG" || fail "a deploy event says it: $(grep d1 "$STUB_LOG")"
grep -q "running v1.0.2: every updater follows it within two minutes" <<<"$out" || fail "and the running version is checked: $out"
[[ -z "$(git -C "$tmp/repo" worktree list | sed 1d)" ]] || fail "the tag's checkout is removed: $(git -C "$tmp/repo" worktree list)"
echo "ok: the images and the Worker go back"

# Back past #277: what that Worker's listing would serve of #277's columns is cleared just before it is deployed, and once more right
# after — until it serves, the Worker from #277 writes them back at every claim, and the older one never writes them.
echo v1.0.3 > "$STUB_VERSION"; : > "$STUB_LOG"
out="$(cd "$tmp/repo" && "$R" v1.0.1 2>&1)" || fail "release-rollback v1.0.1 exited $?: $out"
clears="$(grep -n "^npx wrangler d1 execute omarchy-repo --remote --command UPDATE build_workers SET " "$STUB_LOG" | cut -d: -f1 | tr '\n' ' ')"
[[ "$(wc -w <<<"$clears" | tr -d ' ')" == 3 ]] || fail "a Worker from before #277: #277's columns cleared three times: $(grep d1 "$STUB_LOG")"
dep="$(line 'wrangler deploy --var')"; read -r c1 c2 c3 <<<"$clears"
last_version="$(grep -n '^curl http://pool.test/api/v1/version$' "$STUB_LOG" | tail -n1 | cut -d: -f1)"
(( c1 < dep && dep < c2 )) || fail "cleared just before that Worker is deployed, and again after: clears at $clears, deploy at $dep"
(( c2 < last_version && last_version < c3 )) || fail "and once more once it runs (an isolate of the newer Worker may have served a claim meanwhile): clears at $clears, the last /version at $last_version"
grep -q "is from before #277" <<<"$out" || fail "and says so: $out"
# The SQL itself, run for real against a database built from every migration (a grep cannot catch a NOT NULL it breaks): every
# column the Worker from #277 withholds is empty afterwards in what the older Worker's SELECT * serves, but drained_* — a person's
# standing drain — and instance_churn is its default 0; nothing else of the row changes; a task's stop fence is gone; a second run
# changes nothing.
sql="$(grep "^npx wrangler d1 execute omarchy-repo --remote --command UPDATE build_workers SET " "$STUB_LOG" | head -n1 | sed 's/^npx wrangler d1 execute omarchy-repo --remote --command //')"
python3 - "$root/worker/migrations" "$sql" <<'PY' || fail "the clear, run against the migrations' schema"
import glob, sqlite3, sys
migrations, sql = sys.argv[1], sys.argv[2]
db = sqlite3.connect(":memory:")
for f in sorted(glob.glob(migrations + "/*.sql")):
    db.executescript(open(f).read())
def seed(table, values):
    cols = [(r[1], r[2]) for r in db.execute(f"PRAGMA table_info({table})")]
    row = {c: values.get(c, 2 if t.upper() == "INTEGER" else f"x-{c}-{values['id']}") for c, t in cols}
    db.execute(f"INSERT INTO {table} ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", list(row.values()))
    return row
pid = "0123456789abcdef0123456789abcdef"
common = {"arch": "aarch64", "mode": "project", "trust": "project", "instance": pid, "instance_finished": pid}
worker = seed("build_workers", {**common, "id": "w-1", "revoked_at": None})
revoked = seed("build_workers", {**common, "id": "w-2"})  # /users/:login lists revoked workers too
task = seed("build_tasks", {"id": 1, "arch": "aarch64", "status": "leased", "trust": "project", "kind": "build", "lease_owner": "w-1", "stop_order": "o-1"})
db.commit()
withheld = ["instance", "instance_prev", "instance_since", "instance_conflict_at", "instance_other_at", "instance_churn", "instance_finished",
            "site", "auto_orders", "agent_error_class", "agent_probed_at", "rollout", "order_kinds", "watchdog_exits", "agent_error_since"]
kept = ["drained_at", "drained_by", "drain_reason"]
db.executescript(sql)
bad = []
db.row_factory = sqlite3.Row
for seeded in (worker, revoked):
    got = dict(db.execute("SELECT * FROM build_workers WHERE id = ?", (seeded["id"],)).fetchone())
    for c, v in got.items():
        want = (0 if c == "instance_churn" else None) if c in withheld else seeded[c]
        if v != want: bad.append(f"{seeded['id']}.{c} = {v!r}, not {want!r}")
    for c in kept:
        if got[c] is None: bad.append(f"{seeded['id']}.{c} was cleared: a person's drain")
t = dict(db.execute("SELECT * FROM build_tasks WHERE id = 1").fetchone())
for c, v in t.items():
    want = None if c == "stop_order" else task[c]
    if v != want: bad.append(f"task.{c} = {v!r}, not {want!r}")
before = db.total_changes
db.executescript(sql)
if db.total_changes != before: bad.append(f"a second run changed {db.total_changes - before} rows")
if bad:
    print("\n".join(bad), file=sys.stderr); sys.exit(1)
PY

# The deploy fails: the three tags go back to the digests they named before, nothing is recorded, and re-running is said safe.
echo v1.0.3 > "$STUB_VERSION"; : > "$STUB_LOG"
if out="$(cd "$tmp/repo" && STUB_DEPLOY_FAIL=1 "$R" v1.0.2 2>&1)"; then fail "a failed deploy must fail the rollback: $out"; fi
back="$(grep 'imagetools create' "$STUB_LOG" | tail -n 3)"
[[ "$back" == "docker buildx imagetools create --prefer-index=false -t $IMAGE:x86_64 $IMAGE@sha256:$(sha "$IMAGE:x86_64")
docker buildx imagetools create --prefer-index=false -t $IMAGE:aarch64 $IMAGE@sha256:$(sha "$IMAGE:aarch64")
docker buildx imagetools create --prefer-index=false -t $IMAGE:latest $IMAGE@sha256:$(sha "$IMAGE:latest")" ]] || fail "each tag back on the digest it named before the rollback: $back"
(( $(line 'wrangler deploy --var') < $(grep -n 'imagetools create' "$STUB_LOG" | tail -n 3 | head -1 | cut -d: -f1) )) || fail "put back after the deploy failed"
grep -q "the images are back where they were, and the pool still runs v1.0.3; nothing else moved — re-running rollback.yml -f to=v1.0.2 is safe" <<<"$out" || fail "and says so: $out"
grep -q "INSERT INTO events" "$STUB_LOG" && fail "a rollback that did not happen is not recorded as one"
[[ "$(cat "$STUB_VERSION")" == v1.0.3 ]] || fail "the pool still runs its release"
echo "ok: a deploy that fails puts the images back"

# Refused, nothing moved: not a tag, not a tag of this repository, a tag whose image was never pushed, no deploy token.
for bad in "" latest v1.0 "v1.0.2;rm -rf /" v9.9.9; do
  : > "$STUB_LOG"
  if out="$(cd "$tmp/repo" && "$R" "$bad" 2>&1)"; then fail "'$bad' must be refused: $out"; fi
  grep -qE 'imagetools create|wrangler|cosign' "$STUB_LOG" && fail "'$bad' moved something: $(cat "$STUB_LOG")"
  true
done
(cd "$tmp/repo" && git tag v9.9.8 && git tag v9.9.7)
: > "$STUB_LOG"
if out="$(cd "$tmp/repo" && "$R" v9.9.8 2>&1)"; then fail "a release whose image was never pushed must be refused: $out"; fi
grep -q "does not exist" <<<"$out" && ! grep -qE 'imagetools create|wrangler|cosign' "$STUB_LOG" || fail "and nothing moved: $out / $(cat "$STUB_LOG")"
# A release whose smoke start failed: its :<arch>-v9.9.7 were pushed, its git tag and GitHub release exist, but no :v9.9.7.
: > "$STUB_LOG"
if out="$(cd "$tmp/repo" && "$R" v9.9.7 2>&1)"; then fail "a release whose images did not pass both smoke starts must be refused: $out"; fi
grep -q "$IMAGE:v9.9.7 does not exist: v9.9.7's images never passed both architectures' smoke starts" <<<"$out" && ! grep -qE 'imagetools create|wrangler|cosign' "$STUB_LOG" \
  || fail "refused, nothing moved, nothing signed: $out / $(cat "$STUB_LOG")"
# A Worker that does not install: nothing moved.
: > "$STUB_LOG"
if out="$(cd "$tmp/repo" && STUB_NPM_FAIL=1 "$R" v1.0.2 2>&1)"; then fail "a Worker that does not install must stop the rollback: $out"; fi
grep -q "did not install (npm ci): nothing moved" <<<"$out" && ! grep -qE 'imagetools create|wrangler deploy --var|cosign' "$STUB_LOG" || fail "and nothing moved: $out / $(cat "$STUB_LOG")"
: > "$STUB_LOG"
if out="$(cd "$tmp/repo" && CLOUDFLARE_API_TOKEN= "$R" v1.0.2 2>&1)"; then fail "no deploy token must be refused: $out"; fi
grep -q "the Worker has to go back with the images" <<<"$out" && ! grep -q 'imagetools create' "$STUB_LOG" || fail "without the token, nothing moves: $out"
echo "ok: refused before anything moves"
echo "ROLLBACK WORKFLOW OK"
