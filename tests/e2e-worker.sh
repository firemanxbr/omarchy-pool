#!/usr/bin/env bash
# End-to-end through the edge worker, entirely local:
#   wrangler dev (local D1 + R2) → publish fixtures to edge → promote edge→rc→stable
#   → render databases (signed by the pool's own key) → pacman in a container
#   syncs from the worker mirror.
#
# Requires: cargo, gpg, node (worker deps installed), podman or docker.
# Usage: tests/e2e-worker.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E="$ROOT/target/e2e-worker"
GNUPGHOME="${OMARCHY_POC_GNUPGHOME:-$HOME/.cache/omarchy-cli-poc/gnupg}"
export GNUPGHOME
PORT="${OMARCHY_E2E_PORT:-8790}"
source "$ROOT/tests/images.env"; IMAGE="$ARCHLINUX_BASE"
RUNTIME="$(command -v podman || command -v docker)"
# How the container reaches the worker on the host.
if [[ "$RUNTIME" == *podman* ]]; then
  HOST_FROM_CONTAINER="host.containers.internal"; RUN_EXTRA=()
else
  HOST_FROM_CONTAINER="host.docker.internal"; RUN_EXTRA=(--add-host=host.docker.internal:host-gateway)
fi
export OMARCHY_API="http://127.0.0.1:$PORT"
# A job token for the local pool, minted the way the brain mints them
# (HMAC over the claims with JOB_TOKEN_SECRET): what a worker gets at claim
# time. Every scope, a day long — the e2e is the whole pipeline at once.
JOB_SECRET="e2e-jobs"
job_token() {
  local claims payload sig
  claims=$(jq -nc '{t:0,k:"e2e",s:["pool:write","release:edge","release:rc","release:stable","artifacts:*:edge","artifacts:*:rc","artifacts:*:stable","security:write","gc","events","factory:write"],e:((now|floor)+86400),w:"e2e"}')
  payload=$(printf %s "$claims" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  sig=$(printf %s "$payload" | openssl dgst -sha256 -hmac "$JOB_SECRET" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  echo "omj.$payload.$sig"
}
export OMARCHY_TOKEN="$(job_token)"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
cleanup() {
  local code=$?
  # What the local pool said, when a step failed: the Worker's own log is
  # the only place a 'Network connection lost' or a D1 error shows up.
  if [[ $code -ne 0 && -f "$E2E/wrangler.log" ]]; then
    printf '\n\033[1;31m==> the local pool (wrangler dev) log, last 80 lines:\033[0m\n' >&2
    tail -n 80 "$E2E/wrangler.log" >&2
  fi
  if [[ -n "${WRANGLER_PID:-}" ]]; then kill "$WRANGLER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

step "Throwaway signing key"
if ! gpg --list-secret-keys poc@omarchy.invalid >/dev/null 2>&1; then
  mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"
  gpg --batch --quiet --passphrase '' --quick-generate-key \
    "Omarchy POC Signing (throwaway, do not use) <poc@omarchy.invalid>" ed25519 sign 30d
fi
KEYID="$(gpg --list-keys --with-colons poc@omarchy.invalid | awk -F: '/^fpr/{print $10; exit}')"

step "Build publisher"
cargo build -q -p pkg-repo
PKG_REPO="$ROOT/target/debug/pkg-repo"

step "Fresh local worker on :$PORT"
rm -rf "$E2E" && mkdir -p "$E2E"
cd "$ROOT/worker"
WRANGLER_STATE="$E2E/wrangler-state"
# The pool holds the signing key (/docs/security-model): the throwaway key goes in as
# the Worker secret, armored on one dotenv line.
SIGNING_KEY="$(gpg --batch --armor --export-secret-keys "$KEYID" | awk '{printf "%s\\n", $0}')"
printf 'JOB_TOKEN_SECRET=%s\nSIGNING_KEY="%s"\n' "$JOB_SECRET" "$SIGNING_KEY" > "$E2E/.dev.vars"
npx wrangler d1 migrations apply omarchy-repo --local --persist-to "$WRANGLER_STATE" >/dev/null
# Two registered project workers (what POST /factory/workers + a maintainer's
# trust produce), seeded straight into the local index: their tokens are
# omw_e2e_w1 and omw_e2e_w2.
W1_HASH=$(printf %s omw_e2e_w1 | sha256sum | cut -d' ' -f1); W2_HASH=$(printf %s omw_e2e_w2 | sha256sum | cut -d' ' -f1); W3_HASH=$(printf %s omw_e2e_w3 | sha256sum | cut -d' ' -f1)
# …and the governance the brain would have applied from factory/MAINTAINERS.toml:
# one maintainer, the contributor 'e2e' (token omc_e2e).
C_HASH=$(printf %s omc_e2e | sha256sum | cut -d' ' -f1)
npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
     ('w1', 'aarch64', 'e2e', '$W1_HASH', 'shared', 'project', 'e2e', '2000-01-01T00:00:00Z'),
     ('w2', 'aarch64', 'e2e', '$W2_HASH', 'shared', 'project', 'e2e', '2000-01-01T00:00:00Z'),
     ('w3', 'aarch64', 'e2e-contributor', '$W3_HASH', 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z');
   INSERT INTO factory_maintainers (login) VALUES ('e2e');
   INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('e2e', '$C_HASH', '$(printf %s oms_e2e | sha256sum | cut -d' ' -f1)', 'maintainer'),
     ('e2e-contributor', '$(printf %s omc_e2e_contributor | sha256sum | cut -d' ' -f1)', NULL, 'contributor')" >/dev/null
# SOURCE_CHECK off: the package requests below name a source on a host nobody serves, and the pool would ask it (the vitest pool runs the same way).
npx wrangler dev --ip 0.0.0.0 --port "$PORT" --persist-to "$WRANGLER_STATE" \
  --env-file "$E2E/.dev.vars" --var "POOL_URL:http://$HOST_FROM_CONTAINER:$PORT/pool" --var "SOURCE_CHECK:off" > "$E2E/wrangler.log" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 60); do
  if grep -q "no release" <<<"$(curl -s "$OMARCHY_API/api/v1/releases/stable")"; then break; fi
  sleep 1
done
grep -q "no release" <<<"$(curl -s "$OMARCHY_API/api/v1/releases/stable")" || { cat "$E2E/wrangler.log"; exit 1; }
cd "$ROOT"

step "Sign fixture packages (stands in for the mirror / OPR signatures)"
mkdir -p "$E2E/pkgs"
cp "$ROOT"/crates/pkg-extract/tests/fixtures/*.pkg.tar.zst "$E2E/pkgs/"
for pkg in "$E2E"/pkgs/*.pkg.tar.zst; do
  gpg --batch --yes --detach-sign --no-armor --local-user "$KEYID" --output "$pkg.sig" "$pkg"
done

step "Publish to edge (pool upload happens once)"
"$PKG_REPO" publish --ring edge --source packages --note "zlib" "$E2E/pkgs/zlib-1:1.3.2-3-x86_64.pkg.tar.zst"
"$PKG_REPO" publish --ring edge --source packages --note "xz" "$E2E/pkgs/xz-5.8.4-1-x86_64.pkg.tar.zst"
"$PKG_REPO" publish --ring edge --source packages --note "re-publish is idempotent" "$E2E/pkgs/zlib-1:1.3.2-3-x86_64.pkg.tar.zst"

step "Promote edge → rc → stable (index writes only)"
"$PKG_REPO" promote --from edge --to rc --note "rc cut"
"$PKG_REPO" promote --from rc --to stable --note "ship"

step "Rollback: stable back to the zlib-only release, then forward again"
FIRST_EDGE=$("$PKG_REPO" releases --ring edge | awk '$2 == 1 {print $1}')
"$PKG_REPO" rollback --ring stable --to "$FIRST_EDGE" --note "rollback drill"
summary_body=$(curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary")
grep -q '"name":"zlib"' <<<"$summary_body" || { echo "rollback lost zlib"; exit 1; }
grep -q '"name":"xz"' <<<"$summary_body" && { echo "rollback still serves xz"; exit 1; }
"$PKG_REPO" promote --from rc --to stable --note "forward again"
"$PKG_REPO" releases --ring stable
# One architecture at a time: rc gets edge's aarch64 rows (there are none in the
# fixtures) while its x86_64 keeps what it serves; the response says x86_64 is unchanged.
"$PKG_REPO" promote --from edge --to rc --arch aarch64 --note "aarch64 only"
rc_arch=$(curl -s "$OMARCHY_API/api/v1/releases/rc?fields=summary&arch=x86_64"); grep -q '"name":"zlib"' <<<"$rc_arch" && grep -q '"name":"xz"' <<<"$rc_arch" || { echo "a per-arch promotion must keep the other architecture: $(head -c 200 <<<"$rc_arch")"; exit 1; }
# The diff between two releases: the rollback dropped xz, the promotion put it back.
diff_out=$("$PKG_REPO" diff --ring stable); grep -q "^+ xz 5.8.4-1 (x86_64)" <<<"$diff_out" || { echo "diff does not show xz coming back: $diff_out"; exit 1; }
diff_json=$("$PKG_REPO" diff --ring stable --json); python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["counts"]["added"]==1 and d["counts"]["removed"]==0 and d["from"]["id"] < d["to"]["id"], d["counts"]' <<<"$diff_json" || { echo "diff --json is off"; exit 1; }
rel_json=$("$PKG_REPO" releases --all --json); python3 -c 'import json,sys; d=json.load(sys.stdin); assert set(d)=={"edge","rc","stable","lab"} and d["stable"]["releases"][0]["is_head"]==1, list(d)' <<<"$rel_json" || { echo "releases --all --json is off"; exit 1; }
dpage=$(curl -s "$OMARCHY_API/diff?ring=stable"); grep -q "Release diff" <<<"$dpage" || { echo "diff page not served"; exit 1; }

step "Render databases for stable (the pool signs them)"
signing_key=$(curl -s "$OMARCHY_API/api/v1/signing-key")
grep -q "\"fingerprint\":\"$KEYID\"" <<<"$signing_key" || { echo "pool does not hold the signing key: $signing_key"; exit 1; }
"$PKG_REPO" render --ring stable
curl -so "$E2E/stable.db" "$OMARCHY_API/pool/packages/x86_64/omarchy-packages-stable.db"
curl -so "$E2E/stable.db.sig" "$OMARCHY_API/pool/packages/x86_64/omarchy-packages-stable.db.sig"
gpg --verify "$E2E/stable.db.sig" "$E2E/stable.db" 2>/dev/null || { echo "the pool's database signature does not verify"; exit 1; }
# The include names the directory the database is in — the source's own — and no other (nothing is moving).
inc=$(curl -s "$OMARCHY_API/api/v1/pacman.conf?ring=stable&arch=x86_64")
grep -q '^Server = .*/pool/packages/\$arch$' <<<"$inc" || { echo "the include does not name the source's directory: $inc"; exit 1; }
! grep -q '^Server = .*/pool/\$arch$' <<<"$inc" || { echo "the include still names the flat directory: $inc"; exit 1; }
# A client's own signature is not taken over the pool's.
sup=$(curl -s -X PUT "$OMARCHY_API/api/v1/releases/1/artifacts/db.sig?repo=omarchy-packages-stable&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary 'not a signature')
grep -q '"status":"superseded"' <<<"$sup" || { echo "client signature was not superseded: $sup"; exit 1; }
# Does what the pool serves verify? The fixtures were published with the
# pool's own key: clean. A signature of other bytes planted beside zlib is
# found; without an upstream channel serving those bytes it is reported for
# a replacement, not silently kept.
gpg --armor --export "$KEYID" > "$E2E/verify-key.asc"
vout=$("$PKG_REPO" verify --ring stable --arch x86_64 --keyring "$E2E/verify-key.asc" --work-dir "$E2E/verify-work" --pool "$OMARCHY_API/pool" 2>&1) || { echo "verify failed: $vout"; exit 1; }
grep -q "0 bad signature(s)" <<<"$vout" || { echo "verify must find the pool clean: $vout"; exit 1; }
zlib_sha=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print([p["sha256"] for p in d["packages"] if p["name"]=="zlib"][0])' <<<"$(curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary&arch=x86_64")")
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/pool/$zlib_sha/sig?filename=zlib-1:1.3.2-3-x86_64.pkg.tar.zst&source=packages&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/pkgs/xz-5.8.4-1-x86_64.pkg.tar.zst.sig"
vout=$("$PKG_REPO" verify --ring stable --arch x86_64 --keyring "$E2E/verify-key.asc" --work-dir "$E2E/verify-work" --pool "$OMARCHY_API/pool" --repair 2>&1 || true)
grep -q "1 bad signature(s)" <<<"$vout" && grep -q "needs replacing" <<<"$vout" || { echo "verify must find the planted signature: $vout"; exit 1; }
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/pool/$zlib_sha/sig?filename=zlib-1:1.3.2-3-x86_64.pkg.tar.zst&source=packages&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/pkgs/zlib-1:1.3.2-3-x86_64.pkg.tar.zst.sig"
# A release that only touches aarch64 keeps x86_64's rendered databases: the
# artifact rows carry over and the response says not to render it again.
# wrangler dev's proxy drops a request now and then on CI runners ("Network
# connection lost", the dev server continues — seen right here, never
# locally); one retry two seconds later tells that apart from a real error.
unch=""
for attempt in 1 2 3; do
  unch=$(curl -s -w '\nHTTP %{http_code} in %{time_total}s' -X POST "$OMARCHY_API/api/v1/releases" -H "Authorization: Bearer $OMARCHY_TOKEN" -H "content-type: application/json" -d "{\"ring\":\"stable\",\"remove\":[\"nothing-here\"],\"remove_arch\":\"aarch64\",\"note\":\"aarch64-only change (attempt $attempt)\"}")
  grep -q '"unchanged_arches":\["x86_64"\]' <<<"$unch" && break
  echo "attempt $attempt: the local pool did not answer the aarch64-scoped release: $unch"
  sleep 2
done
grep -q '"unchanged_arches":\["x86_64"\]' <<<"$unch" || { echo "an aarch64-scoped release must report x86_64 unchanged"; curl -s "$OMARCHY_API/api/v1/status"; echo; exit 1; }
carried=$(curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary"); grep -q '"repo":"omarchy-packages-stable","arch":"x86_64","kind":"db"' <<<"$carried" || { echo "the parent's x86_64 databases were not carried over: $(head -c 300 <<<"$carried")"; exit 1; }

step "Verify across rings: an any package is one object per architecture directory"
# An `any` package is one object per architecture directory, with different
# bytes (Arch Linux ARM rebuilds them). Pinned by two rings with a bad
# signature on the x86_64 copy, verify used to carry the aarch64 bytes into
# the x86_64 re-pin of the second ring (production, 2026-09-14: "packages
# not indexed"). Now: one bad signature, nothing re-pinned.
for a in x86_64 aarch64; do
  mkdir -p "$E2E/any/$a/root"
  printf 'pkgname = e2e-any\npkgver = 1-1\npkgdesc = one object per directory (%s)\narch = any\nsize = 1\n' "$a" > "$E2E/any/$a/root/.PKGINFO"
  (cd "$E2E/any/$a/root" && tar -cf - .PKGINFO | xz -c > "../e2e-any-1-1-any.pkg.tar.xz")
  gpg --batch --yes --detach-sign --no-armor --local-user "$KEYID" --output "$E2E/any/$a/e2e-any-1-1-any.pkg.tar.xz.sig" "$E2E/any/$a/e2e-any-1-1-any.pkg.tar.xz"
  for r in rc stable; do "$PKG_REPO" publish --ring "$r" --source packages --arch "$a" --note "e2e-any $a" "$E2E/any/$a/e2e-any-1-1-any.pkg.tar.xz" >/dev/null; done
done
any_x86=$(sha256sum "$E2E/any/x86_64/e2e-any-1-1-any.pkg.tar.xz" | cut -d' ' -f1)
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/pool/$any_x86/sig?filename=e2e-any-1-1-any.pkg.tar.xz&source=packages&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/any/aarch64/e2e-any-1-1-any.pkg.tar.xz.sig"
vout=$("$PKG_REPO" verify --keyring "$E2E/verify-key.asc" --work-dir "$E2E/verify-work" --pool "$OMARCHY_API/pool" --repair 2>&1 || true)
grep -q "1 bad signature(s)" <<<"$vout" && grep -q "0 pinned bytes the pool does not store (0 re-pinned)" <<<"$vout" || { echo "verify must find one bad signature and re-pin nothing: $vout"; exit 1; }
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/pool/$any_x86/sig?filename=e2e-any-1-1-any.pkg.tar.xz&source=packages&arch=x86_64" -H "Authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/any/x86_64/e2e-any-1-1-any.pkg.tar.xz.sig"

step "Pool sanity (one directory per source: databases beside the packages)"
for f in omarchy-packages-stable.db omarchy-packages-stable.db.sig omarchy-packages-stable.files "zlib-1:1.3.2-3-x86_64.pkg.tar.zst" "zlib-1:1.3.2-3-x86_64.pkg.tar.zst.sig"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/pool/packages/x86_64/$f")
  [[ "$code" == 200 ]] || { echo "unexpected $code for $f"; exit 1; }
done
[[ "$(curl -s -H 'Range: bytes=0-3' "$OMARCHY_API/pool/packages/x86_64/zlib-1:1.3.2-3-x86_64.pkg.tar.zst" | od -An -tx1 | tr -d ' \n')" == "28b52ffd" ]] || { echo "range request broken"; exit 1; }

# Read bodies fully before grepping: `curl | grep -q` under pipefail fails
# with exit 23 when grep closes the pipe early.
stats_body=$(curl -s "$OMARCHY_API/api/v1/stats")
grep -q '"kind":"render"' <<<"$stats_body" || { echo "render event missing from stats"; exit 1; }
dash_body=$(curl -s "$OMARCHY_API/")
grep -q "tested before they reach you" <<<"$dash_body" || {
  echo "dashboard not served; response head:"; head -c 600 <<<"$dash_body"; echo
  echo "--- worker log tail ---"; tail -20 "$E2E/wrangler.log"; exit 1; }
for p in /docs /docs/get-started /docs/workers /docs/how-it-works /docs/governance /docs/security /docs/glossary /docs/architecture /docs/runbook /docs/factory /status /api /factory /people; do
  body=$(curl -s "$OMARCHY_API$p"); grep -q "omarchy-pool" <<<"$body" || { echo "page $p not served"; exit 1; }
done
# The Factory is where a package is requested (#246): its request card for everyone, the send a sign-in for nobody; the request's old page redirects there with its query.
grep -q '>Sign in to send</a>' <<<"$(curl -s "$OMARCHY_API/factory")" || { echo "the Factory must offer a visitor Sign in to send"; exit 1; }
moved=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$OMARCHY_API/request?name=e2e-x")
[[ "${moved%#request}" == "301 $OMARCHY_API/factory?name=e2e-x" ]] || { echo "/request must redirect to the Factory's request card, the name kept: $moved"; exit 1; }
# The old addresses of the documentation chapters redirect into the section; the old addresses of two doors redirect to the door, and /me to the sign-in until a session says whose page it is.
[[ "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$OMARCHY_API/contribute")" == "301 $OMARCHY_API/factory" ]] || { echo "/contribute must redirect to /factory"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$OMARCHY_API/index.html")" == "301 $OMARCHY_API/" ]] || { echo "/index.html must redirect to /"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$OMARCHY_API/me")" == "302 $OMARCHY_API/auth/github?next=/me" ]] || { echo "/me must send a stranger to the sign-in"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$OMARCHY_API/how-it-works")" == "301 $OMARCHY_API/docs/how-it-works" ]] || { echo "/how-it-works must redirect to /docs/how-it-works"; exit 1; }
gpage=$(curl -s "$OMARCHY_API/governance" -L); grep -q "Becoming a maintainer" <<<"$gpage" || { echo "governance page not served"; exit 1; }
search_body=$(curl -s "$OMARCHY_API/api/v1/search?q=zlib&ring=stable")
grep -q '"name":"zlib"' <<<"$search_body" || { echo "search did not find zlib: $search_body"; exit 1; }
# The packages list (#245): the API filters it, and /packages draws it into the page, links and all, with script off.
list_body=$(curl -s "$OMARCHY_API/api/v1/packages?q=zlib&ring=stable")
grep -q '"name":"zlib"' <<<"$list_body" || { echo "the packages list did not find zlib: $list_body"; exit 1; }
list_page=$(curl -s "$OMARCHY_API/packages?q=zlib")
grep -q '<a class="pk-row" href="/package/zlib?ring=' <<<"$list_page" || { echo "/packages did not draw zlib's row: $(head -c 600 <<<"$list_page")"; exit 1; }
pkg_body=$(curl -s "$OMARCHY_API/api/v1/package/zlib?ring=stable")
grep -q '"shown_ring":"stable"' <<<"$pkg_body" || { echo "package page data missing: $pkg_body"; exit 1; }
# Security: an advisory on the served zlib object shows up in the ring's report,
# and what loads libz.so.1 counts as exposed.
zlib_sha=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print([p["sha256"] for p in d["packages"] if p["name"]=="zlib"][0])' <<<"$(curl -s "$OMARCHY_API/api/v1/releases/stable?fields=summary")")
auth=(-H "authorization: Bearer $OMARCHY_TOKEN" -H "content-type: application/json")
curl -sf -X PUT "$OMARCHY_API/api/v1/security/advisories" "${auth[@]}" -d '{"advisories":[{"id":"arch:AVG-9999:zlib","source":"arch","package":"zlib","cves":["CVE-2099-0001"],"severity":"high","status":"vulnerable","fixed":null,"url":"https://security.archlinux.org/AVG-9999"}],"cves":[{"cve":"CVE-2099-0001","kev":true,"epss":0.9}]}' >/dev/null
curl -sf -X PUT "$OMARCHY_API/api/v1/security/matches" "${auth[@]}" -d "{\"matches\":[{\"sha256\":\"$zlib_sha\",\"advisory\":\"arch:AVG-9999:zlib\",\"match\":\"exact\",\"status\":\"vulnerable\"}]}" >/dev/null
sec_body=$(curl -s "$OMARCHY_API/api/v1/security?ring=stable")
grep -q '"name":"zlib"' <<<"$sec_body" || { echo "security report missing zlib: $sec_body"; exit 1; }
grep -q '"kev":1\|"kev":true' <<<"$sec_body" || { echo "KEV flag missing: $sec_body"; exit 1; }
pkg_sec=$(curl -s "$OMARCHY_API/api/v1/package/xz?ring=stable")
grep -q '"via":"zlib"' <<<"$pkg_sec" || echo "note: xz is not exposed through zlib in the fixtures ($(python3 -c 'import json,sys; print(json.load(sys.stdin)["security"])' <<<"$pkg_sec"))"
status_body=$(curl -s "$OMARCHY_API/api/v1/status")
grep -q '"state":"online"' <<<"$status_body" || { echo "service status not online: $status_body"; exit 1; }
grep -q '"signing":true' <<<"$status_body" || { echo "status does not report signing: $status_body"; exit 1; }
# A cached API answer tells the browser to keep it no longer than our own
# expiry (the platform rewrites the stored copy's cache-control to hours).
miss_headers=$(curl -s -D - -o /dev/null "$OMARCHY_API/api/v1/stats"); hit_headers=$(curl -s -D - -o /dev/null "$OMARCHY_API/api/v1/stats")
grep -qi "x-pool-cache: hit" <<<"$hit_headers" || { echo "second /stats was not served from the cache: $hit_headers"; exit 1; }
max_age() { grep -i "^cache-control:" <<<"$1" | grep -o 'max-age=[0-9]*' | cut -d= -f2; }
ma=$(max_age "$hit_headers"); own=$(max_age "$miss_headers")
[[ -n "$ma" && -n "$own" && "$ma" -le "$own" ]] || { echo "a cache hit must not extend the browser's max-age past the answer's own ($own): $hit_headers"; exit 1; }
echo "databases, signatures, package blobs, Range requests, stats, pages, security and service status OK"

step "Factory: enqueue, claim with a lease, fail → requeue, complete after publish"
w1=(-H "authorization: Bearer omw_e2e_w1" -H "content-type: application/json")
w2=(-H "authorization: Bearer omw_e2e_w2" -H "content-type: application/json")
# The guard: xz is served by 'packages' for x86_64 → refused there; aarch64 has nobody → queued.
enq=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/enqueue" "${auth[@]}" -d '{"name":"xz","pkgbuild_ref":"deadbeef","reason":"pkgbuild-changed","arches":["x86_64","aarch64"]}')
grep -q '"arches":\["aarch64"\]' <<<"$enq" || { echo "enqueue did not skip the upstream-served arch: $enq"; exit 1; }
grep -q '"source":"packages"' <<<"$enq" || { echo "enqueue did not name who ships it: $enq"; exit 1; }
refused=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/enqueue" "${auth[@]}" -d '{"name":"xz","pkgbuild_ref":"deadbeef","reason":"x","arches":["x86_64"]}')
[[ "$refused" == 409 ]] || { echo "expected 409 for a name upstream ships, got $refused"; exit 1; }
tid=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["tasks"][0])' <<<"$enq")
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${auth[@]}" -d '{"arch":"aarch64"}')" == 403 ]] || { echo "a job token must not claim"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" -H "authorization: Bearer omw_unknown" -H "content-type: application/json" -d '{"arch":"aarch64"}')" == 401 ]] || { echo "an unregistered worker token must not claim"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w1[@]}" -d '{"arch":"x86_64"}')" == 400 ]] || { echo "a worker claims only its registered architecture"; exit 1; }
claim=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${w1[@]}" -d '{"arch":"aarch64","hostname":"e2e"}')
grep -q "\"id\":$tid," <<<"$claim" || { echo "claim did not return the queued task: $claim"; exit 1; }
job=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$claim")
[[ "$job" == omj.* ]] || { echo "claim did not issue a job token: $claim"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w2[@]}" -d '{"arch":"aarch64"}')" == 204 ]] || { echo "second worker must get nothing"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/heartbeat" "${w2[@]}")" == 409 ]] || { echo "a stranger must not heartbeat"; exit 1; }
curl -sf -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/heartbeat" -H "authorization: Bearer $job" >/dev/null || { echo "the job token must heartbeat its own task"; exit 1; }
failed=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/fail" "${w1[@]}" -d '{"error":"boom"}')
grep -q '"status":"queued"' <<<"$failed" || { echo "first failure must requeue: $failed"; exit 1; }
claim2=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${w2[@]}" -d '{"arch":"aarch64"}')
grep -q '"attempts":2' <<<"$claim2" || { echo "second claim must be attempt 2: $claim2"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/complete" "${w2[@]}" -d '{"sha256":"0000","filename":"nope"}')" == 409 ]] || { echo "complete before publish must be refused"; exit 1; }
# The "build result" must be in the pool: the xz object already published
# stands in for it (the fixtures are x86_64 packages; the brain checks the
# pool, not the architecture of the bytes).
xz_sha=$(sha256sum "$E2E/pkgs/xz-5.8.4-1-x86_64.pkg.tar.zst" | cut -d' ' -f1)
done_body=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/complete" "${w2[@]}" -d "{\"sha256\":\"$xz_sha\",\"filename\":\"xz-5.8.4-1-x86_64.pkg.tar.zst\",\"version\":\"5.8.4-1\",\"duration_ms\":1200}")
grep -q '"status":"done"' <<<"$done_body" || { echo "complete failed: $done_body"; exit 1; }
fac=$(curl -s "$OMARCHY_API/api/v1/factory")
grep -q '"builds_done":1' <<<"$fac" || { echo "worker stats missing: $fac"; exit 1; }
built=$(curl -s "$OMARCHY_API/api/v1/factory/built")
grep -q '"name":"xz","arch":"aarch64"' <<<"$built" || { echo "built list missing the task: $built"; exit 1; }
fpage=$(curl -s "$OMARCHY_API/factory"); grep -q "Factory" <<<"$fpage" || { echo "factory page not served"; exit 1; }
reg=$(curl -s "$OMARCHY_API/api/v1/factory/packages"); grep -q '"packages"' <<<"$reg" || { echo "registry not served: $reg"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/packages" -H "content-type: application/json" -d '{"url":"https://github.com/x/y"}')" == 401 ]] || { echo "registering without a contributor token must be refused"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$tid/artifacts/x.log" "${auth[@]}" --data 'x')" == 401 ]] || { echo "the publish token must not write to staging"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$tid/approve" "${auth[@]}" -d '{}')" == 401 ]] || { echo "approving needs a maintainer's contributor token"; exit 1; }
# Community tasks are their owner's first: a donated (--shared) worker sees
# someone else's only from shared_after on; without --shared, never.
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "INSERT INTO build_tasks (name, arch, pkgbuild_ref, reason, priority, publish, trust, owner, kind, shared_after) VALUES
     ('later', 'aarch64', 'draft:https://github.com/x/later@latest', 'bump to v2', 100, 0, 'community', 'someone-else', 'build', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+14 days')),
     ('nowish', 'aarch64', 'draft:https://github.com/x/nowish@latest', 'package-request #1', 100, 0, 'community', 'someone-else', 'build', NULL)" >/dev/null)
w3=(-H "authorization: Bearer omw_e2e_w3" -H "content-type: application/json")
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","agent":"openai/gpt-5","agent_status":"ok"}')" == 204 ]] || { echo "a worker not started --shared must only see its owner's tasks"; exit 1; }
# Sharing is the owner's word alone (2026-09-17): a contributor's --shared worker builds anyone's queued request — once its agent answers.
# A draft is the agent's work: a worker whose agent did not answer the probe gets nothing; one whose agent did gets it.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","shared":true,"agent":"openai/gpt-5","agent_status":"error","agent_error":"HTTP 402"}')" == 204 ]] || { echo "a worker whose agent is down must not be handed a draft"; exit 1; }
c3=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","shared":true,"agent":"openai/gpt-5","agent_status":"ok"}')
grep -q '"name":"nowish"' <<<"$c3" || { echo "a shared worker — any contributor's — must get the task that is shareable now: $c3"; exit 1; }
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command "UPDATE build_workers SET owner = 'e2e' WHERE id = 'w3'" >/dev/null)
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","shared":true,"agent":"openai/gpt-5","agent_status":"ok"}')" == 204 ]] || { echo "a shared worker must not get a task before its shared_after"; exit 1; }
fac3=$(curl -s "$OMARCHY_API/api/v1/factory?limit=50"); grep -q '"id":"w3","arch":"aarch64"' <<<"$fac3" && grep -q '"mode":"shared"' <<<"$fac3" && grep -q '"agent_status":"ok"' <<<"$fac3" && grep -q '"ready":true' <<<"$fac3" || { echo "the claim did not record the worker as shared and ready: $fac3"; exit 1; }
# The community build's evidence goes to staging with the job token; the
# builder cannot write the audit files. Staging it queues the second agent.
c3_id=$(jq -r .task.id <<<"$c3"); c3_tok=$(jq -r .token <<<"$c3"); c3j=(-H "authorization: Bearer $c3_tok")
for f in PKGBUILD build.log PKGINFO nowish-1.0-1-aarch64.pkg.tar.zst; do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/$f" "${c3j[@]}" --data-binary "evidence: $f")" == 201 ]] || { echo "the job token must upload $f to its own staging"; exit 1; }
done
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/audit.json" "${c3j[@]}" --data-binary '{"verdict":"ok"}')" == 403 ]] || { echo "a builder must not write the audit about its own build"; exit 1; }
st3=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$c3_id/complete" "${c3j[@]}" -H "content-type: application/json" -d '{"sha256":"1111","filename":"nowish-1.0-1-aarch64.pkg.tar.zst","version":"1.0-1"}'); grep -q '"status":"staged"' <<<"$st3" || { echo "the community build did not stage: $st3"; exit 1; }
review=$(curl -s "$OMARCHY_API/api/v1/factory/review"); grep -q '"staged"' <<<"$review" || { echo "review list not served: $review"; exit 1; }
python3 -c 'import json,sys; d=json.load(sys.stdin); t=[t for t in d["staged"] if t["id"]=='"$c3_id"'][0]; assert t["audit"]["status"]=="queued", t["audit"]' <<<"$review" || { echo "staging a build must queue its audit: $(head -c 400 <<<"$review")"; exit 1; }
[[ "$(curl -s "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/PKGINFO")" == "evidence: PKGINFO" ]] || { echo "the .PKGINFO is public evidence"; exit 1; }
# A project worker that declares the audit kind (it has an agent key) takes it;
# the report is attached to the staged build's evidence with the audit's own token.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w3[@]}" -d '{"arch":"aarch64","kinds":["audit"]}')" == 204 ]] || { echo "a community worker never audits"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/claim" "${w1[@]}" -d '{"arch":"aarch64","kinds":["audit"],"agent":"anthropic/claude-sonnet-5","agent_status":"error","agent_error":"no answer"}')" == 204 ]] || { echo "the second agent must answer the probe before it audits"; exit 1; }
au=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${w1[@]}" -d '{"arch":"aarch64","kinds":["audit"],"agent":"anthropic/claude-sonnet-5","agent_status":"ok"}'); grep -q '"kind":"audit"' <<<"$au" && grep -q "\"task\":$c3_id" <<<"$au" || { echo "the project worker did not get the audit: $au"; exit 1; }
# What the worker said it runs shows on the Workers page; the key itself never travels.
facw=$(curl -s "$OMARCHY_API/api/v1/factory?limit=10&after=agent")
python3 -c 'import json,sys; w=[w for w in json.load(sys.stdin)["workers"] if w["id"]=="w1"][0]; assert w["agent"]=="anthropic/claude-sonnet-5", w' <<<"$facw" || { echo "the worker's agent is not listed"; exit 1; }
au_id=$(jq -r .task.id <<<"$au"); auj=(-H "authorization: Bearer $(jq -r .token <<<"$au")")
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/PKGBUILD" "${auj[@]}" --data-binary 'x')" == 400 ]] || { echo "the audit writes its report only"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/audit.json" "${auj[@]}" --data-binary '{"verdict":"warn","summary":"SKIP checksum","findings":[{"severity":"high","area":"supply-chain","where":"sha256sums","what":"SKIP","fix":"pin it"}]}')" == 201 ]] || { echo "the audit could not attach its report"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/audit.md" "${auj[@]}" --data-binary '# Audit: warn')" == 201 ]] || { echo "the audit could not attach audit.md"; exit 1; }
aud=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$au_id/complete" "${auj[@]}" -H "content-type: application/json" -d '{"summary":"warn: SKIP checksum","result":{"verdict":"warn","summary":"SKIP checksum","model":"e2e","findings":[{"severity":"high","area":"supply-chain"}]}}'); grep -q '"status":"done"' <<<"$aud" || { echo "the audit did not complete: $aud"; exit 1; }
review=$(curl -s "$OMARCHY_API/api/v1/factory/review")
python3 -c 'import json,sys; d=json.load(sys.stdin); a=[t for t in d["staged"] if t["id"]=='"$c3_id"'][0]["audit"]; assert a["status"]=="done" and a["verdict"]=="warn" and a["findings"]==1 and a["high"]==1, a' <<<"$review" || { echo "review does not show the audit verdict: $(head -c 400 <<<"$review")"; exit 1; }
[[ "$(curl -s "$OMARCHY_API/api/v1/factory/tasks/$c3_id/artifacts/audit.md")" == "# Audit: warn" ]] || { echo "the audit report is public evidence"; exit 1; }
mlist=$(curl -s "$OMARCHY_API/api/v1/factory/maintainers"); grep -q '"login":"e2e"' <<<"$mlist" || { echo "maintainers not served from the governance table: $mlist"; exit 1; }
me=$(curl -s "$OMARCHY_API/api/v1/factory/me" -H "authorization: Bearer omc_e2e"); grep -q '"role":"maintainer"' <<<"$me" || { echo "the seeded maintainer is not one: $me"; exit 1; }
gpage=$(curl -s "$OMARCHY_API/docs/governance"); grep -q "Becoming a maintainer" <<<"$gpage" || { echo "governance page not served"; exit 1; }
# The browser session (cookie omc=oms_…) signs the dashboard in; signing out invalidates it on the server, not only in the browser.
sme=$(curl -s "$OMARCHY_API/auth/me" -H "cookie: omc=oms_e2e"); grep -q '"login":"e2e"' <<<"$sme" || { echo "the seeded session does not sign in: $sme"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/auth/logout" -H "cookie: omc=oms_e2e")" == 302 ]] || { echo "logout must redirect"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/auth/me" -H "cookie: omc=oms_e2e")" == 401 ]] || { echo "a signed-out session must stop working"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/api/v1/factory/me" -H "authorization: Bearer omc_e2e")" == 200 ]] || { echo "signing out of the browser must not revoke the CLI token"; exit 1; }
# A worker learns what its registration is (the image decides its mode from this).
wself=$(curl -s "$OMARCHY_API/api/v1/factory/workers/self" -H "authorization: Bearer omw_e2e_w3"); grep -q '"trust":"community"' <<<"$wself" && grep -q '"owner":"e2e"' <<<"$wself" || { echo "workers/self did not describe the registration: $wself"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/api/v1/factory/workers/self")" == 401 ]] || { echo "workers/self must need a worker token"; exit 1; }
upage=$(curl -s "$OMARCHY_API/api/v1/users/e2e"); grep -q '"role":"maintainer"' <<<"$upage" && grep -q '"github":"https://github.com/e2e"' <<<"$upage" || { echo "the profile API did not describe the seeded maintainer: $upage"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/api/v1/users/nobody-here")" == 404 ]] || { echo "an unknown login must be 404"; exit 1; }
upg=$(curl -s "$OMARCHY_API/user/e2e"); grep -q "omarchy-pool" <<<"$upg" || { echo "profile page not served"; exit 1; }
pkgm=$(curl -s "$OMARCHY_API/api/v1/package/zlib?ring=stable"); grep -q '"maintenance":{"packager":' <<<"$pkgm" || { echo "package view lacks maintenance: $(head -c 200 <<<"$pkgm")"; exit 1; }
# No shared secret: a maintainer runs jobs by hand (queued, not executed with their token); a contributor cannot.
mauth=(-H "authorization: Bearer omc_e2e" -H "content-type: application/json")
qj=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/jobs" "${mauth[@]}" -d '{"kind":"health","params":{"ring":"stable","arch":"x86_64"}}')
grep -q '"task":' <<<"$qj" || { echo "a maintainer could not queue a job: $qj"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/jobs" -H "authorization: Bearer omc_e2e_contributor" -H "content-type: application/json" -d '{"kind":"gc"}')" == 403 ]] || { echo "a contributor must not queue jobs"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/jobs" "${mauth[@]}" -d '{"kind":"promote","params":{"from":"edge","to":"edge"}}')" == 400 ]] || { echo "bad job params must be refused"; exit 1; }
rb=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/jobs" "${mauth[@]}" -d '{"kind":"rollback","params":{"ring":"stable","to":"1"}}'); grep -q '"kind":"rollback"' <<<"$rb" || { echo "a maintainer could not queue a rollback: $rb"; exit 1; }
# A promotion forced past its evidence takes the maintainer's passkey, in the browser (#284): the token forces nothing.
[[ "$(curl -s -X POST "$OMARCHY_API/api/v1/factory/jobs" "${mauth[@]}" -d '{"kind":"promote","params":{"from":"rc","to":"stable","force":"yes"}}' | jq -r .code)" == session_only ]] || { echo "a maintainer's token must not force a promotion"; exit 1; }
# A build queued by hand is a dry run (#284): the enqueue job's token publishes (above), the maintainer's token queues publish:false only.
[[ "$(curl -s -X POST "$OMARCHY_API/api/v1/factory/enqueue" "${mauth[@]}" -d '{"name":"e2e-sizing","pkgbuild_ref":"deadbeef","reason":"sizing","arches":["aarch64"]}' | jq -r .code)" == dry_run_only ]] || { echo "a build queued by hand must be a dry run"; exit 1; }
dry=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/enqueue" "${mauth[@]}" -d '{"name":"e2e-sizing","pkgbuild_ref":"deadbeef","reason":"sizing","arches":["aarch64"],"publish":false}')
dry_task=$(jq -r '.tasks[0]' <<<"$dry")
[[ "$(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --json --command "SELECT publish AS n FROM build_tasks WHERE id = $dry_task" | jq -r '.[0].results[0].n')" == 0 ]] || { echo "a dry run by hand must never publish: $dry"; exit 1; }
# Nothing of this run builds it: cancelled at once, so no later claim takes it.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$dry_task/cancel" "${mauth[@]}")" == 200 ]] || { echo "the dry run could not be cancelled"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/events" "${mauth[@]}" -d '{"kind":"note","status":"ok","summary":"a maintainer wrote this"}')" == 201 ]] || { echo "a maintainer must be able to write a journal note"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/pool/gc" "${mauth[@]}")" == 401 ]] || { echo "a maintainer token must not write to the pool directly (jobs do)"; exit 1; }
# Nobody approves their own package — and the only maintainer is no exception (docs/GOVERNANCE.md).
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "INSERT INTO build_tasks (name, arch, version, pkgbuild_ref, reason, priority, publish, trust, owner, kind, status, staged_prefix) VALUES
     ('mine', 'aarch64', '1.0-1', 'draft:https://github.com/e2e/mine@latest', 'contributor', 100, 0, 'community', 'e2e', 'build', 'staged', 'staging/e2e/mine/1/');
   INSERT INTO factory_maintainers (login) VALUES ('other')" >/dev/null)
mine=$(curl -s "$OMARCHY_API/api/v1/factory/review" | python3 -c 'import json,sys; print([t["id"] for t in json.load(sys.stdin)["staged"] if t["name"]=="mine"][0])')
# A contributor's build is evidence: approving it is refused before anything else. The owner rule shows on "build":
# a maintainer never has the project build their own package — with another maintainer around or as the sole one.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/approve" "${mauth[@]}" -d '{}')" == 409 ]] || { echo "a contributor's build must never be approvable"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/build" "${mauth[@]}" -d '{}')" == 403 ]] || { echo "a maintainer must not have the project build their own package when another maintainer exists"; exit 1; }
# The refusal names the conflict for an agent to read (#247): claiming one's own package, letting a claim on it go, asking for changes.
for act in build release changes; do
  own=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/$act" "${mauth[@]}" -d '{"note":"my own","reason":"my own"}')
  [[ "$(jq -r .code <<<"$own")" == conflict_of_interest ]] || { echo "the requester's $act must be refused as a conflict of interest: $own"; exit 1; }
done
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command "DELETE FROM factory_maintainers WHERE login = 'other'" >/dev/null)
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/build" "${mauth[@]}" -d '{}')" == 403 ]] || { echo "the sole maintainer must not have the project build their own package either"; exit 1; }
# The owner never decides on their own package — a rejection included — and what the page reads (GET .../can) refuses in the POST's words.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/reject" "${mauth[@]}" -d '{"note":"my own"}')" == 403 ]] || { echo "a maintainer must not reject their own package"; exit 1; }
mcan=$(curl -s "$OMARCHY_API/api/v1/factory/tasks/$mine/can" "${mauth[@]}")
[[ "$(jq -r .can.reject <<<"$mcan")" == false && "$(jq -r .can.why.reject <<<"$mcan")" == "$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/reject" "${mauth[@]}" -d '{"note":"my own"}' | jq -r .error)" ]] || { echo "can.reject must be false for the owner, with the POST's reason: $mcan"; exit 1; }
# Somebody else's package: a contributor's build is never approved — it is evidence. A maintainer has the project
# build it (review:<task>, the project's own recipe, its agent, a worker it trusts); the approval comes on that build.
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command "UPDATE build_tasks SET owner = 'someone-else' WHERE id = $mine" >/dev/null)
dec=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/approve" "${mauth[@]}" -d '{"note":"reads well"}'); [[ "$dec" == 409 ]] || { echo "a contributor's build must not be approvable (got $dec)"; exit 1; }
pb=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/build" "${mauth[@]}" -d '{"note":"reads well"}'); grep -q "\"from\":$mine" <<<"$pb" && grep -q '"by":"e2e"' <<<"$pb" || { echo "the project build must be queued from the staged evidence: $pb"; exit 1; }
ptask=$(jq -r .task <<<"$pb")
[[ "$(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --json --command "SELECT pkgbuild_ref || ' ' || trust || ' ' || publish AS r FROM build_tasks WHERE id = $ptask" | jq -r '.[0].results[0].r')" == "review:$mine project 0" ]] || { echo "the project build is a project-trust, staged (publish 0) build from review:$mine"; exit 1; }
[[ "$(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --json --command "SELECT COUNT(*) AS n FROM build_tasks WHERE kind = 'build' AND pkgbuild_ref LIKE 'staging:%'" | jq -r '.[0].results[0].n')" == 0 ]] || { echo "no build may start from a contributor's staged artifact"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$mine/build" "${mauth[@]}" -d '{}')" == 409 ]] || { echo "one project build at a time per staged build"; exit 1; }
# Nothing was approved yet: the profile's record says so.
rec=$(curl -s "$OMARCHY_API/api/v1/users/e2e?after=review")   # a fresh key: the profile is edge-cached for a minute
python3 -c 'import json,sys; r=json.load(sys.stdin)["record"]; assert r["maintained"]["approvals"]==0, r' <<<"$rec" || { echo "the profile record is off: $(python3 -c 'import json,sys; print(json.load(sys.stdin)["record"])' <<<"$rec")"; exit 1; }
rpage=$(curl -s "$OMARCHY_API/review"); grep -q "Review" <<<"$rpage" || { echo "review page not served"; exit 1; }
# A signature for bytes the pool does not serve under that filename is refused.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/pool/$(printf 'a%.0s' {1..64})/sig?filename=xz-5.8.4-1-x86_64.pkg.tar.zst&source=packages&arch=x86_64" -H "authorization: Bearer $OMARCHY_TOKEN" --data-binary "@$E2E/pkgs/xz-5.8.4-1-x86_64.pkg.tar.zst.sig")" == 409 ]] || { echo "a mismatching signature must be refused"; exit 1; }
echo "factory queue, lease, requeue, guard and completion OK"

step "Factory: one name, one package — built on x86_64, not on aarch64, reviewed once, published on x86_64 alone"
# A package is its name (#242): x86_64 and aarch64 are two targets of one
# package. A contributor requests it for both; their x86_64 worker builds
# it, their aarch64 worker gives up on it (the recipe's fault, final): that
# architecture is not supported and x86_64 goes on to the review alone. A
# maintainer who did not request it has the project build it again — the
# project's x86_64 worker, nothing for aarch64 — and approves it once; the
# publish job is x86_64's only, and what it carries into edge is the
# project's build, published here with the job's own token as work.rs does.
command -v zstd >/dev/null || { echo "zstd is needed to make the package the project builds"; exit 1; }
REQ_HASH=$(printf %s omc_e2e_req | sha256sum | cut -d' ' -f1)
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "INSERT INTO contributors (login, token_hash, role) VALUES ('e2e-req', '$REQ_HASH', 'contributor');
   INSERT INTO build_workers (id, arch, owner, token_hash, mode, trust, trusted_by, last_seen) VALUES
     ('wrx', 'x86_64', 'e2e-req', '$(printf %s omw_e2e_wrx | sha256sum | cut -d' ' -f1)', 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z'),
     ('wra', 'aarch64', 'e2e-req', '$(printf %s omw_e2e_wra | sha256sum | cut -d' ' -f1)', 'dedicated', 'community', NULL, '2000-01-01T00:00:00Z'),
     ('wpx', 'x86_64', 'e2e', '$(printf %s omw_e2e_wpx | sha256sum | cut -d' ' -f1)', 'shared', 'project', 'e2e', '2000-01-01T00:00:00Z')" >/dev/null)
d1n() { (cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --json --command "$1") | jq -r '.[0].results[0].n'; }
reqauth=(-H "authorization: Bearer omc_e2e_req" -H "content-type: application/json")
wrx=(-H "authorization: Bearer omw_e2e_wrx" -H "content-type: application/json")
wra=(-H "authorization: Bearer omw_e2e_wra" -H "content-type: application/json")
wpx=(-H "authorization: Bearer omw_e2e_wpx" -H "content-type: application/json")
agent='"agent":"e2e/agent","agent_status":"ok"'
ident_req='{"name":"e2e-ident","url":"https://e2e-ident.example","source":"https://e2e-ident.example/e2e-ident-1.0.tar.gz","version":"1.0","description":"One name, one package: the e2e test of it","license":"MIT","arches":["x86_64","aarch64"],"checklist":{"official":true,"license":true,"unshipped":true,"evidence":true}}'
# The request reserves the name, for both architectures; another contributor asking for it is refused.
rq=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/packages" "${reqauth[@]}" -d "$ident_req")
[[ "$(jq -r '.package.owner' <<<"$rq")" == e2e-req && "$(jq -r '.targets.x86_64.status + " " + .targets.aarch64.status' <<<"$rq")" == "building building" ]] || { echo "the request did not register e2e-ident for both architectures: $rq"; exit 1; }
taken=$(curl -s -w '\n%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/packages" -H "authorization: Bearer omc_e2e_contributor" -H "content-type: application/json" -d "$ident_req")
[[ "$(tail -n1 <<<"$taken")" == 409 && "$(head -n1 <<<"$taken" | jq -r .error)" == "e2e-ident is waiting, requested by e2e-req" ]] || { echo "the name must be reserved for its requester: $taken"; exit 1; }
# The Factory's live check says the same, in the same words: reserved, whose, and why.
named=$(curl -s "$OMARCHY_API/api/v1/factory/names/e2e-ident?arches=x86_64,aarch64")
[[ "$(jq -r '.state + " " + .owner + " " + .why' <<<"$named")" == "reserved e2e-req e2e-ident is waiting, requested by e2e-req" ]] || { echo "the live check must call e2e-ident reserved, in the request's words: $named"; exit 1; }
# x86_64: the requester's worker builds it and hands the evidence in; staged.
cx=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${wrx[@]}" -d "{\"arch\":\"x86_64\",$agent}")
[[ "$(jq -r '.task.name + " " + .task.arch' <<<"$cx")" == "e2e-ident x86_64" ]] || { echo "the x86_64 worker did not get the x86_64 build: $cx"; exit 1; }
x86=$(jq -r .task.id <<<"$cx"); cxj=(-H "authorization: Bearer $(jq -r .token <<<"$cx")")
# What runs now, as the Factory's workers card polls it (?live=1): the build the worker holds, only tasks in flight, no counts.
live=$(curl -s "$OMARCHY_API/api/v1/factory?live=1&limit=20&t=$x86")
[[ "$(jq -r --argjson id "$x86" '[.tasks[] | select(.id == $id) | .status] | join(",")' <<<"$live") $(jq -r '[.tasks[].status | select(. != "leased" and . != "queued")] | length' <<<"$live") $(jq -r '.counts | length' <<<"$live")" == "leased 0 0" ]] || { echo "the live read must show the x86_64 build leased, and nothing but tasks in flight: $live"; exit 1; }
for f in PKGBUILD build.log PKGINFO e2e-ident-1.0-1-x86_64.pkg.tar.zst; do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$x86/artifacts/$f" "${cxj[@]}" --data-binary "the contributor's $f")" == 201 ]] || { echo "the contributor's build could not stage $f"; exit 1; }
done
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/factory/tasks/$x86/artifacts/vet.json" "${cxj[@]}" --data-binary '{"schema":"omarchy-pool/vet/1","verdict":"pass","checks":[{"name":"smoke","status":"pass","detail":""}]}'
st=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$x86/complete" "${cxj[@]}" -H "content-type: application/json" -d '{"sha256":"2222","filename":"e2e-ident-1.0-1-x86_64.pkg.tar.zst","version":"1.0-1"}')
[[ "$(jq -r .status <<<"$st")" == staged ]] || { echo "the x86_64 build did not stage: $st"; exit 1; }
# One review covers every architecture: none starts while aarch64 still builds.
early=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$x86/build" "${mauth[@]}" -d '{}')
[[ "$(jq -r .error <<<"$early")" == "aarch64 is still building (task "*"): one review covers every architecture — it starts once each is built or not supported" ]] || { echo "the review must wait for aarch64: $early"; exit 1; }
# aarch64: the requester's other worker gives up on the recipe (final) — not supported.
ca=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${wra[@]}" -d "{\"arch\":\"aarch64\",$agent}")
[[ "$(jq -r '.task.name + " " + .task.arch' <<<"$ca")" == "e2e-ident aarch64" ]] || { echo "the aarch64 worker did not get the aarch64 build: $ca"; exit 1; }
arm=$(jq -r .task.id <<<"$ca")
fa=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$arm/fail" -H "authorization: Bearer $(jq -r .token <<<"$ca")" -H "content-type: application/json" -d '{"error":"exit 4: no linker for aarch64 in the recipe","final":true}')
[[ "$(jq -r .status <<<"$fa")" == failed ]] || { echo "the aarch64 build must fail for good: $fa"; exit 1; }
story=$(curl -s "$OMARCHY_API/api/v1/factory/packages/e2e-ident/story?at=built")
[[ "$(jq -r '.targets.x86_64.status + " " + .targets.aarch64.status' <<<"$story")" == "built not_supported" && "$(jq -r .targets.aarch64.task <<<"$story")" == "$arm" ]] || { echo "the package must say x86_64 built, aarch64 not supported: $(jq -c .targets <<<"$story")"; exit 1; }
rv=$(curl -s "$OMARCHY_API/api/v1/factory/review" "${mauth[@]}")
[[ "$(jq -r '.packages[] | select(.name == "e2e-ident") | "\(.lead) \(.waits) \(.rows | length)"' <<<"$rv")" == "$x86 true 1" ]] || { echo "Review must list e2e-ident once, waiting, its x86_64 build speaking for it: $(jq -c '.packages' <<<"$rv")"; exit 1; }
# The review: the project builds again what its contributor built — x86_64 only — on its own worker.
# A claim can be let go (#247): the maintainer who claimed it releases it — the queued rebuild cancelled once, a second release refused,
# a line in the journal and a record the pool signed — and the package is claimed again.
pb=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$x86/build" "${mauth[@]}" -d '{"note":"reads well"}')
first=$(jq -r .task <<<"$pb")
rl=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$x86/release" "${mauth[@]}" -d '{"reason":"released by the e2e, claimed again below"}')
[[ "$(jq -r '"\(.released) \(.claimed_by) \(.by) \(.via) \(.tasks | map(tostring) | join(","))"' <<<"$rl")" == "e2e-ident e2e e2e token $first" ]] || { echo "the claim must be released: $rl"; exit 1; }
[[ "$(d1n "SELECT COUNT(*) AS n FROM build_tasks WHERE id = $first AND status = 'cancelled'")" == 1 ]] || { echo "the released rebuild must be cancelled"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$x86/release" "${mauth[@]}" -d '{"reason":"a second release"}')" == 409 ]] || { echo "a second release must be refused"; exit 1; }
grep -q "e2e's claim released" <<<"$(curl -s "$OMARCHY_API/api/v1/events?kind=review&limit=5")" || { echo "the release must be in the journal"; exit 1; }
# A decision's record, signed by the pool's key: read from the local bucket, the detached signature verified with gpg.
record_ok() {
  local key="${1#*/pool/}" out="$E2E/record-${2//\//-}"
  (cd "$ROOT/worker" && npx wrangler r2 object get "omarchy-packages/$key" --local --persist-to "$WRANGLER_STATE" --file "$out.json" >/dev/null 2>&1 && npx wrangler r2 object get "omarchy-packages/$key.sig" --local --persist-to "$WRANGLER_STATE" --file "$out.sig" >/dev/null 2>&1) || { echo "the record $key is not in the bucket"; return 1; }
  gpg --batch --verify "$out.sig" "$out.json" 2>/dev/null || { echo "the record $key does not verify with the pool's key"; return 1; }
  jq -e --arg d "$2" '(.decision // .schema) == $d' "$out.json" >/dev/null || { echo "the record $key is not a $2: $(cat "$out.json")"; return 1; }
}
record_ok "$(jq -r .record <<<"$rl")" release || exit 1
pb=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$x86/build" "${mauth[@]}" -d '{"note":"reads well"}')
[[ "$(jq -c .arches <<<"$pb")" == '["x86_64"]' && "$(jq -r '.tasks | length' <<<"$pb")" == 1 ]] || { echo "the project must build x86_64 again, and nothing for aarch64: $pb"; exit 1; }
px=$(jq -r .task <<<"$pb")
[[ "$(d1n "SELECT COUNT(*) AS n FROM build_tasks WHERE name = 'e2e-ident' AND arch = 'aarch64' AND trust = 'project'")" == 0 ]] || { echo "no project build may be queued for an architecture that is not supported"; exit 1; }
# The claim is a decision too, signed on the record; its rebuild is let go through a release, never stopped by the cancel door by hand.
record_ok "$(jq -r .record <<<"$pb")" claim || exit 1
byhand=$(curl -s -w '\n%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$px/cancel" "${mauth[@]}")
[[ "$(tail -n1 <<<"$byhand")" == 409 ]] && grep -q "/release" <<<"$(head -n1 <<<"$byhand")" || { echo "the cancel door must send a claim's rebuild to its release: $byhand"; exit 1; }
cp=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${wpx[@]}" -d "{\"arch\":\"x86_64\",\"kinds\":[\"build\"],$agent}")
[[ "$(jq -r .task.id <<<"$cp")" == "$px" && "$(jq -r .task.pkgbuild_ref <<<"$cp")" == "review:$x86" ]] || { echo "the project's x86_64 worker did not get the review build: $cp"; exit 1; }
cpj=(-H "authorization: Bearer $(jq -r .token <<<"$cp")")
# The project's build is a real package: the one the publish job carries into edge.
mkdir -p "$E2E/ident/root"
printf 'pkgname = e2e-ident\npkgver = 1.0-1\npkgdesc = One name, one package: the e2e test of it\narch = x86_64\nsize = 1\n' > "$E2E/ident/root/.PKGINFO"
(cd "$E2E/ident/root" && tar -cf - .PKGINFO | zstd -q -c > "../e2e-ident-1.0-1-x86_64.pkg.tar.zst")
ident_sha=$(sha256sum "$E2E/ident/e2e-ident-1.0-1-x86_64.pkg.tar.zst" | cut -d' ' -f1)
for f in PKGBUILD build.log PKGINFO; do curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/factory/tasks/$px/artifacts/$f" "${cpj[@]}" --data-binary "the project's $f"; done
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$OMARCHY_API/api/v1/factory/tasks/$px/artifacts/e2e-ident-1.0-1-x86_64.pkg.tar.zst" "${cpj[@]}" --data-binary "@$E2E/ident/e2e-ident-1.0-1-x86_64.pkg.tar.zst")" == 201 ]] || { echo "the project's build could not stage its package"; exit 1; }
curl -s -o /dev/null -X PUT "$OMARCHY_API/api/v1/factory/tasks/$px/artifacts/vet.json" "${cpj[@]}" --data-binary '{"schema":"omarchy-pool/vet/1","verdict":"pass","checks":[{"name":"smoke","status":"pass","detail":""}]}'
pst=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$px/complete" "${cpj[@]}" -H "content-type: application/json" -d "{\"sha256\":\"$ident_sha\",\"filename\":\"e2e-ident-1.0-1-x86_64.pkg.tar.zst\",\"version\":\"1.0-1\"}")
[[ "$(jq -r .status <<<"$pst")" == staged ]] || { echo "the project's build did not stage: $pst"; exit 1; }
# Approve and block are decided in the browser with the maintainer's passkey (#271): no token decides them, the maintainer's own
# included — refused once the act itself is allowed (a contributor's build above was refused as evidence first, 409).
tok=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$px/approve" "${mauth[@]}" -d '{"note":"x86_64 only; aarch64 needs a linker"}')
[[ "$(jq -r .code <<<"$tok")" == session_only ]] || { echo "a maintainer's token must not approve: $tok"; exit 1; }
# e2e signs in again (the session ended with the sign-out above) and registers their first passkey on their page with the session
# alone — the pool's options, a software authenticator's answer (tests/passkey.mjs), the POST. The page's origin is the one the
# Worker sees, wrangler dev's first route (the relying party's id, https): the agents' step below reads the same from a draft's link.
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command "UPDATE contributors SET session_hash = '$(printf %s oms_e2e_web | sha256sum | cut -d' ' -f1)' WHERE login = 'e2e'" >/dev/null)
web=(-H "cookie: omc=oms_e2e_web" -H "origin: $OMARCHY_API" -H "content-type: application/json")
pkopts=$(curl -s -X POST "$OMARCHY_API/auth/passkeys/challenge" "${web[@]}" -d '{}')
[[ "$(jq -r '.publicKey.authenticatorSelection.userVerification + " " + .publicKey.attestation' <<<"$pkopts")" == "required none" ]] || { echo "a passkey's options must ask for user verification and no attestation: $pkopts"; exit 1; }
rp_origin="https://$(jq -r .publicKey.rp.id <<<"$pkopts")"
pkreg=$(node "$ROOT/tests/passkey.mjs" register "$E2E/passkey.json" "$rp_origin" "E2E key" <<<"$pkopts" | curl -s -X POST "$OMARCHY_API/auth/passkeys" "${web[@]}" --data-binary @-)
[[ "$(jq -r '.passkey.alg' <<<"$pkreg")" == ES256 ]] || { echo "e2e's first passkey must be registered with the session: $pkreg"; exit 1; }
pkid=$(jq -r '.passkey.id' <<<"$pkreg")
grep -q "e2e registered a passkey (ES256, $pkid)" <<<"$(curl -s "$OMARCHY_API/api/v1/events?kind=passkey&limit=5")" || { echo "the passkey's registration must be journaled"; exit 1; }
# A second passkey needs an answer from the first: the session alone enrols nothing more.
pk2opts=$(curl -s -X POST "$OMARCHY_API/auth/passkeys/challenge" "${web[@]}" -d '{}')
pk2=$(node "$ROOT/tests/passkey.mjs" register "$E2E/passkey-2.json" "$rp_origin" "E2E second" <<<"$pk2opts" | curl -s -X POST "$OMARCHY_API/auth/passkeys" "${web[@]}" --data-binary @-)
[[ "$(jq -r .code <<<"$pk2")" == passkey_required ]] || { echo "a second passkey must need the first's answer: $pk2"; exit 1; }
# The page's script, played by curl and the authenticator: the pool's challenge for exactly this act, the passkey's answer, as JSON.
web_answer() { curl -s -X POST "$OMARCHY_API/auth/passkeys/assert" "${web[@]}" -d "{\"for\":\"$1\"}" | node "$ROOT/tests/passkey.mjs" assert "$E2E/passkey.json" "$rp_origin" json; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$px/approve" "${web[@]}" -d '{"note":"x86_64 only; aarch64 needs a linker"}')" == 403 ]] || { echo "the session alone must not approve"; exit 1; }
# One decision for the package: x86_64 approved, aarch64 named not supported, one publish job — x86_64's.
ap=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$px/approve" "${web[@]}" -d "$(jq -nc --argjson a "$(web_answer "approve:$px")" '{note: "x86_64 only; aarch64 needs a linker", assertion: $a}')")
[[ "$(jq -c .arches <<<"$ap")" == '["x86_64"]' && "$(jq -r .not_supported.aarch64 <<<"$ap")" == "$arm" && "$(jq -r '.publishes | keys | join(",")' <<<"$ap")" == x86_64 ]] || { echo "the approval must cover x86_64 alone: $ap"; exit 1; }
pub=$(jq -r .publish <<<"$ap")
[[ "$(d1n "SELECT COUNT(*) AS n FROM build_tasks WHERE name = 'e2e-ident' AND kind = 'publish'")" == 1 ]] || { echo "one publish job, and only one, for e2e-ident"; exit 1; }
[[ "$(d1n "SELECT COUNT(*) AS n FROM reviews WHERE name = 'e2e-ident' AND decision = 'approved' AND arches = '[\"x86_64\"]'")" == 1 ]] || { echo "one review of e2e-ident on the record"; exit 1; }
# Signed and journaled (#247): who, the door, the passkey (#271) and the agent of the review worker that rebuilt what ships.
[[ "$(jq -r '"\(.by) \(.via) \(.passkey) \(.agent)"' <<<"$ap")" == "e2e web $pkid e2e/agent" ]] || { echo "the approval must say who, the door, the passkey and the agent: $ap"; exit 1; }
record_ok "$(jq -r .record <<<"$ap")" approve || exit 1
[[ "$(curl -s "$OMARCHY_API/api/v1/events?kind=approve&limit=5" | jq -r '[.events[] | select(.payload.name == "e2e-ident")][0].payload | "\(.by) \(.via) \(.passkey) \(.agent)"')" == "e2e web $pkid e2e/agent" ]] || { echo "the approval's journal line must say who, the door, the passkey and the agent"; exit 1; }
# The publish job, as a project worker runs it: the staged package fetched with the job's token, published into edge as source factory (the pool signs), the job completed.
cj=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/claim" "${wpx[@]}" -d '{"arch":"x86_64","kinds":["publish"]}')
[[ "$(jq -r .task.id <<<"$cj")" == "$pub" && "$(jq -r .task.arch <<<"$cj")" == x86_64 ]] || { echo "the project's worker did not get the publish job: $cj"; exit 1; }
# It names its review as review_id: `review` in a task's params is the contributor's build a project's build answers — a publish job has no staging of its own to upload to.
[[ "$(jq -r .task.params.review_id <<<"$cj")" == "$(jq -r .review <<<"$ap")" && "$(jq -r '.task.params | has("review")' <<<"$cj")" == false && "$(jq -r .upload <<<"$cj")" == null ]] || { echo "the publish job must carry its review as review_id, and no upload: $cj"; exit 1; }
pj=$(jq -r .token <<<"$cj")
mkdir -p "$E2E/ident/publish"
curl -sf -o "$E2E/ident/publish/e2e-ident-1.0-1-x86_64.pkg.tar.zst" "$OMARCHY_API/api/v1/factory/tasks/$px/artifacts/e2e-ident-1.0-1-x86_64.pkg.tar.zst" -H "authorization: Bearer $pj" || { echo "the publish job could not fetch the project's build"; exit 1; }
[[ "$(sha256sum "$E2E/ident/publish/e2e-ident-1.0-1-x86_64.pkg.tar.zst" | cut -d' ' -f1)" == "$ident_sha" ]] || { echo "the publish job fetched other bytes than the project's build"; exit 1; }
OMARCHY_TOKEN="$pj" "$PKG_REPO" publish --ring edge --source factory --arch x86_64 --note "factory task $px: e2e-ident approved (e2e)" "$E2E/ident/publish/e2e-ident-1.0-1-x86_64.pkg.tar.zst"
done_pub=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$pub/complete" -H "authorization: Bearer $pj" -H "content-type: application/json" -d "{\"summary\":\"published\",\"result\":{\"sha256\":\"$ident_sha\",\"filename\":\"e2e-ident-1.0-1-x86_64.pkg.tar.zst\",\"version\":\"1.0-1\",\"task\":$px}}")
[[ "$(jq -r .status <<<"$done_pub")" == done ]] || { echo "the publish job did not complete: $done_pub"; exit 1; }
# In edge on x86_64, and on x86_64 alone; the package says aarch64 is not supported.
grep -q '"name":"e2e-ident"' <<<"$(curl -s "$OMARCHY_API/api/v1/releases/edge?fields=summary&arch=x86_64")" || { echo "edge must serve e2e-ident on x86_64"; exit 1; }
! grep -q '"name":"e2e-ident"' <<<"$(curl -s "$OMARCHY_API/api/v1/releases/edge?fields=summary&arch=aarch64")" || { echo "edge must not serve e2e-ident on aarch64"; exit 1; }
story=$(curl -s "$OMARCHY_API/api/v1/factory/packages/e2e-ident/story?at=published")
[[ "$(jq -r '.package.status + " " + .targets.x86_64.status + " " + .targets.aarch64.status' <<<"$story")" == "published published not_supported" ]] || { echo "the package must say published on x86_64, not supported on aarch64: $(jq -c '{status: .package.status, targets}' <<<"$story")"; exit 1; }
[[ "$(jq -r '[.rings[] | select(.arch == "aarch64")] | length' <<<"$story")" == 0 && "$(jq -r '[.rings[] | select(.arch == "x86_64" and .ring == "edge")] | length' <<<"$story")" == 1 ]] || { echo "the rings must serve e2e-ident on x86_64 only: $(jq -c .rings <<<"$story")"; exit 1; }
decided=$(curl -s "$OMARCHY_API/api/v1/factory/approvals?at=published" | jq -c '.approvals[] | select(.name == "e2e-ident")')
[[ "$(jq -r '"\(.standing) \(.arches | join(",")) \(.not_supported | keys | join(",")) \(.rings | join(","))"' <<<"$decided")" == "true x86_64 aarch64 edge" ]] || { echo "the record must hold one standing review of e2e-ident, x86_64 in edge, aarch64 not supported: $decided"; exit 1; }
echo "one name, one package: x86_64 published, aarch64 not supported, one review, one publish job"
# The package page (#244): e2e-ident's data says where each architecture is served — x86_64 in edge, aarch64 nowhere — and whose it is in the pool: the maintainer whose approval stands. Its page is served.
pv=$(curl -s "$OMARCHY_API/api/v1/package/e2e-ident?ring=edge&arch=x86_64&at=page")
[[ "$(jq -r '"\(.arches.x86_64.rings | map(.ring) | join(",")) \(.arches.aarch64.rings | length) \(.maintenance.maintainer.login)"' <<<"$pv")" == "edge 0 e2e" ]] || { echo "the package page's data must say x86_64 in edge, aarch64 nowhere, e2e its maintainer: $(jq -c '{arches, maintenance}' <<<"$pv")"; exit 1; }
grep -q '<h1 id="title">e2e-ident</h1>' <<<"$(curl -s "$OMARCHY_API/package/e2e-ident?ring=edge&arch=x86_64")" || { echo "the package page of e2e-ident is not served"; exit 1; }
# aarch64 is not supported: its answer is a 404 that still says where e2e-ident is served, whether an advisory is open there and whose it is — the page reads the same package on either architecture.
pa=$(curl -s "$OMARCHY_API/api/v1/package/e2e-ident?ring=edge&arch=aarch64&at=page")
[[ "$(jq -r '"\(.arches.x86_64.rings | map(.ring) | join(",")) \(.arches.x86_64.open) \(.maintenance.maintainer.login)"' <<<"$pa")" == "edge 0 e2e" ]] || { echo "e2e-ident's aarch64 answer must say x86_64 in edge, nothing open there, e2e its maintainer: $(head -c 400 <<<"$pa")"; exit 1; }
# Adopt: a synced package gets its maintainer in the pool — a maintainer's act, once, on the journal.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/packages/zlib/adopt" -H "authorization: Bearer omc_e2e_contributor" -H "content-type: application/json" -d '{}')" == 403 ]] || { echo "a contributor must not adopt a package"; exit 1; }
ad=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/packages/zlib/adopt" "${mauth[@]}" -d '{}')
[[ "$(jq -r '.adopted + " " + .by' <<<"$ad")" == "zlib e2e" ]] || { echo "the maintainer could not adopt zlib: $ad"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/packages/zlib/adopt" "${mauth[@]}" -d '{}')" == 409 ]] || { echo "zlib is adopted once"; exit 1; }
jq -e '[.events[] | select(.kind == "adopt" and .summary == "zlib adopted by e2e: its maintainer in the pool")] | length == 1' <<<"$(curl -s "$OMARCHY_API/api/v1/events?kind=adopt&limit=5")" >/dev/null || { echo "the journal must say who adopted zlib"; exit 1; }
[[ "$(jq -r .maintenance.maintainer.login <<<"$(curl -s "$OMARCHY_API/api/v1/package/zlib?ring=stable&arch=x86_64&at=adopted")")" == e2e ]] || { echo "zlib's page must name its maintainer"; exit 1; }
# Block, from the page's You: e2e-ident leaves every ring, its review withdrawn — on the journal, with the reason. The token blocks
# nothing (#271); the passkey's answer for this block, and only this one, does.
[[ "$(curl -s -X POST "$OMARCHY_API/api/v1/factory/packages/e2e-ident/block" "${mauth[@]}" -d '{"reason":"the e2e test of the brake"}' | jq -r .code)" == session_only ]] || { echo "a maintainer's token must not block"; exit 1; }
[[ "$(curl -s -X POST "$OMARCHY_API/api/v1/factory/packages/e2e-ident/block" "${web[@]}" -d "$(jq -nc --argjson a "$(web_answer "approve:$px")" '{reason: "the e2e test of the brake", assertion: $a}')" | jq -r .code)" == challenge ]] || { echo "an answer for another act must not block"; exit 1; }
bl=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/packages/e2e-ident/block" "${web[@]}" -d "$(jq -nc --argjson a "$(web_answer "block:package:e2e-ident")" '{reason: "the e2e test of the brake", assertion: $a}')")
[[ "$(jq -r '.blocked + " " + (.rings | map(.ring) | join(",")) + " " + .passkey' <<<"$bl")" == "e2e-ident edge $pkid" ]] || { echo "the block must take e2e-ident out of edge, with e2e's passkey: $bl"; exit 1; }
jq -e '[.events[] | select(.kind == "block" and (.summary | startswith("e2e-ident blocked by e2e: the e2e test of the brake")))] | length == 1' <<<"$(curl -s "$OMARCHY_API/api/v1/events?kind=block&limit=5")" >/dev/null || { echo "the journal must say who blocked e2e-ident, and why"; exit 1; }
# A promotion forced past its evidence (#284): the passkey's answer for exactly this promotion queues it, and the journal names the
# passkey; an answer for another promotion forces nothing. No worker of this run promotes: the task is cancelled at once.
[[ "$(curl -s -X POST "$OMARCHY_API/api/v1/factory/jobs" "${web[@]}" -d "$(jq -nc --argjson a "$(web_answer "promote:force:edge:rc")" '{kind: "promote", params: {from: "rc", to: "stable", force: "yes", note: "the e2e forces a promotion"}, assertion: $a}')" | jq -r .code)" == challenge ]] || { echo "an answer for another promotion must force nothing"; exit 1; }
fp=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/jobs" "${web[@]}" -d "$(jq -nc --argjson a "$(web_answer "promote:force:rc:stable")" '{kind: "promote", params: {from: "rc", to: "stable", force: "yes", note: "the e2e forces a promotion"}, assertion: $a}')")
[[ "$(jq -r '"\(.job.params.force) \(.passkey)"' <<<"$fp")" == "yes $pkid" ]] || { echo "a forced promotion must be queued with e2e's passkey: $fp"; exit 1; }
fp_task=$(jq -r .task <<<"$fp")
[[ "$(curl -s "$OMARCHY_API/api/v1/events?kind=dispatch&limit=5" | jq -r --argjson t "$fp_task" '[.events[] | select(.payload.task == $t)][0].payload | "\(.by) \(.via) \(.passkey)"')" == "e2e web $pkid" ]] || { echo "the forced promotion's journal line must name the passkey"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OMARCHY_API/api/v1/factory/tasks/$fp_task/cancel" "${mauth[@]}")" == 200 ]] || { echo "the forced promotion could not be cancelled"; exit 1; }
echo "the package page: every architecture on its data, Adopt and Block on the journal; approve, block and a forced promotion with a passkey, never a token"

step "Agents (#252): omarchy-cli login in the browser, a request through the agent, a block it drafts and the person confirms with a passkey (#257)"
# The loopback login as a person runs it, the browser played by curl with
# the person's session: omarchy-cli listens on 127.0.0.1 and prints the
# grant page's address; the page's form is posted with the session, its
# Origin and its nonce; the pool sends the browser to the command's
# loopback address with the code; the command swaps it with its verifier.
cargo build -q -p omarchy-cli
CLI="$ROOT/target/debug/omarchy-cli"
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "UPDATE contributors SET session_hash = '$(printf %s oms_e2e_req | sha256sum | cut -d' ' -f1)' WHERE login = 'e2e-req';
   UPDATE contributors SET session_hash = '$(printf %s oms_e2e_agent | sha256sum | cut -d' ' -f1)' WHERE login = 'e2e'" >/dev/null)
# The page's hidden fields, as a browser would post them back.
form_of() { python3 -c 'import html,re,sys,urllib.parse as u; print(u.urlencode([(k, html.unescape(v)) for k, v in re.findall(r"<input type=\"hidden\" name=\"([a-z_]+)\" value=\"([^\"]*)\">", sys.stdin.read())]))'; }
agent_login() { # <config dir> <session> [--maintain]
  local dir="$1" cookie="omc=$2"; shift 2
  mkdir -p "$dir"
  XDG_CONFIG_HOME="$dir" "$CLI" --api "$OMARCHY_API" login --agent "E2E Agent" --no-browser "$@" > "$dir/login.out" 2> "$dir/login.err" &
  local pid=$! url="" i
  for i in $(seq 1 50); do url=$(grep -o "$OMARCHY_API/auth/agent?[^[:space:]]*" "$dir/login.err" || true); [[ -n "$url" ]] && break; sleep 0.2; done
  [[ -n "$url" ]] || { echo "omarchy-cli login printed no grant page: $(cat "$dir/login.err")"; return 1; }
  grep -q "code_verifier\|verifier=" <<<"$url" && { echo "the verifier must never be in the browser's address: $url"; return 1; }
  local page back
  page=$(curl -s "$url" -H "cookie: $cookie")
  grep -q "Let E2E Agent act as" <<<"$page" || { echo "the grant page did not ask: $(head -c 400 <<<"$page")"; return 1; }
  back=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$OMARCHY_API/auth/agent" -H "cookie: $cookie" -H "origin: $OMARCHY_API" --data "$(form_of <<<"$page")&action=grant")
  [[ "$back" == http://127.0.0.1:*"/?state="*"&code="* ]] || { echo "Grant must send the browser to the command's loopback address: $back"; return 1; }
  curl -s "$back" | grep -q "Granted" || { echo "the command did not take the code"; return 1; }
  wait "$pid" || { echo "omarchy-cli login failed: $(cat "$dir/login.err")"; return 1; }
  [[ "$(stat -c %a "$dir/omarchy-cli/credentials.toml" 2>/dev/null || stat -f %Lp "$dir/omarchy-cli/credentials.toml")" == 600 ]] || { echo "the credentials file must be 0600"; return 1; }
}
mcp_call() { # <config dir> <tool> <arguments JSON> → the tool's result
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}" \
    | XDG_CONFIG_HOME="$1" "$CLI" --api "$OMARCHY_API" mcp | jq -c 'select(.id == 2) | .result'
}
agent_login "$E2E/agent-contributor" oms_e2e_req || exit 1
tl=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | XDG_CONFIG_HOME="$E2E/agent-contributor" "$CLI" --api "$OMARCHY_API" mcp)
[[ "$(jq -r '[.result.tools[].name] | join(",")' <<<"$tl")" == status,check,info,search,list,security,request_package,request_status ]] || { echo "a contributor's grant lists the six reads and its two tools: $tl"; exit 1; }
# A request through the agent: not confirmed through a link, and said so on the row and the journal line.
rq=$(mcp_call "$E2E/agent-contributor" request_package '{"url":"https://e2e-agent.example","source":"https://e2e-agent.example/e2e-agent-1.0.tar.gz","version":"1.0","name":"e2e-agent","description":"Requested through an agent, for the e2e","license":"MIT","arches":["x86_64"],"checklist":{"official":true,"license":true,"unshipped":true,"evidence":true}}')
[[ "$(jq -r '.isError' <<<"$rq")" == false && "$(jq -r '.structuredContent.package.owner' <<<"$rq")" == e2e-req ]] || { echo "request_package through the agent failed: $rq"; exit 1; }
grep -q "e2e-agent 1.0 requested by e2e-req through E2E Agent" <<<"$(curl -s "$OMARCHY_API/api/v1/events?kind=request&limit=5")" || { echo "the request's journal line must name the agent"; exit 1; }
# The maintainer's agent: review and block, seven days; its token decides nothing on the web's doors.
agent_login "$E2E/agent-maintainer" oms_e2e_agent --maintain || exit 1
mtoken=$(sed -n 's/^token = "\(oma_[0-9a-f]*\)"$/\1/p' "$E2E/agent-maintainer/omarchy-cli/credentials.toml")
refused=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/tasks/$px/approve" -H "authorization: Bearer $mtoken" -H "content-type: application/json" -d '{}')
[[ "$(jq -r .code <<<"$refused")" == agent_token ]] || { echo "an agent's token must be refused on approve: $refused"; exit 1; }
blk=$(mcp_call "$E2E/agent-maintainer" block '{"name":"e2e-agent","reason":"the e2e blocks what its agent drafted"}')
# The link names the dashboard's origin (wrangler dev serves this Worker under the first route's name); the draft is the same on this address.
draft_id=$(jq -r '.structuredContent.draft' <<<"$blk")
[[ "$draft_id" == d_* && "$(jq -r '.structuredContent.confirm_url' <<<"$blk")" == */auth/confirm/"$draft_id" ]] || { echo "the block must come back as a draft with its link: $blk"; exit 1; }
curl_url="$OMARCHY_API/auth/confirm/$draft_id"
# The package page's step blocked e2e-ident by e2e already: the draft's own package is what must be missing from the journal.
grep -q "e2e-agent blocked by" <<<"$(curl -s "$OMARCHY_API/api/v1/events?kind=block&limit=5")" && { echo "a draft must write no journal line"; exit 1; }
# e2e lost their passkey (#271): a second maintainer resets it — their own passkey, a reason — journaled, signed on the record, and
# e2e signed out of the browser; e2e's token and their agent's grant go with it, a line each (#284). Nobody resets their own.
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command \
  "INSERT INTO factory_maintainers (login) VALUES ('e2e-second');
   INSERT INTO contributors (login, token_hash, session_hash, role) VALUES ('e2e-second', '$(printf %s omc_e2e_second | sha256sum | cut -d' ' -f1)', '$(printf %s oms_e2e_second | sha256sum | cut -d' ' -f1)', 'maintainer')" >/dev/null)
second=(-H "cookie: omc=oms_e2e_second" -H "origin: $OMARCHY_API" -H "content-type: application/json")
node "$ROOT/tests/passkey.mjs" register "$E2E/passkey-second.json" "$rp_origin" "Second's key" <<<"$(curl -s -X POST "$OMARCHY_API/auth/passkeys/challenge" "${second[@]}" -d '{}')" | curl -s -o /dev/null -X POST "$OMARCHY_API/auth/passkeys" "${second[@]}" --data-binary @-
[[ "$(curl -s -X POST "$OMARCHY_API/auth/passkeys/reset" -H "cookie: omc=oms_e2e_agent" -H "origin: $OMARCHY_API" -H "content-type: application/json" -d '{"login":"e2e","reason":"my own reset"}' | jq -r .code)" == second_maintainer ]] || { echo "nobody resets their own passkeys"; exit 1; }
reset_answer=$(curl -s -X POST "$OMARCHY_API/auth/passkeys/assert" "${second[@]}" -d '{"for":"passkey:reset:e2e"}' | node "$ROOT/tests/passkey.mjs" assert "$E2E/passkey-second.json" "$rp_origin" json)
rs=$(curl -s -X POST "$OMARCHY_API/auth/passkeys/reset" "${second[@]}" -d "$(jq -nc --argjson a "$reset_answer" '{login: "e2e", reason: "lost the e2e laptop", assertion: $a}')")
[[ "$(jq -r '"\(.reset) \(.by) \(.passkeys | map(.id) | join(",")) \(.signed_out) \(.token_revoked) \(.grants_revoked | map(.agent) | join(","))"' <<<"$rs")" == "e2e e2e-second $pkid true true E2E Agent" ]] || { echo "the second maintainer must reset e2e's passkeys, token and agent grant: $rs"; exit 1; }
rs_lines=$(curl -s "$OMARCHY_API/api/v1/events?kind=passkey&limit=10")
grep -q "e2e-second reset e2e's passkeys (1 removed; e2e signed out): lost the e2e laptop" <<<"$rs_lines" || { echo "the reset must be journaled with who and why"; exit 1; }
grep -q "e2e-second reset e2e's passkeys: e2e's command-line token revoked" <<<"$rs_lines" || { echo "the token's revocation must be journaled"; exit 1; }
grep -q "e2e-second reset e2e's passkeys: the grant to E2E Agent (g_[0-9a-f]*) revoked" <<<"$rs_lines" || { echo "the agent grant's revocation must be journaled"; exit 1; }
record_ok "$(jq -r .record <<<"$rs")" "omarchy-pool/passkey-reset/1" || exit 1
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/auth/me" -H "cookie: omc=oms_e2e_agent")" == 401 ]] || { echo "a reset must sign the login out of the browser"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/api/v1/factory/me" -H "authorization: Bearer omc_e2e")" == 401 ]] || { echo "a reset must revoke the login's token"; exit 1; }
[[ "$(curl -s "$OMARCHY_API/api/v1/factory/me" -H "authorization: Bearer $mtoken" | jq -r .code)" == grant_invalid ]] || { echo "a reset must revoke the login's agent grants"; exit 1; }
# e2e signs in again with GitHub (seeded here, as every session of this run is): the agent's draft was discarded with its grant, and
# e2e makes a new token on their page — it works — and logs the agent in again, which drafts the block anew.
(cd "$ROOT/worker" && npx wrangler d1 execute omarchy-repo --local --persist-to "$WRANGLER_STATE" --command "UPDATE contributors SET session_hash = '$(printf %s oms_e2e_agent | sha256sum | cut -d' ' -f1)' WHERE login = 'e2e'" >/dev/null)
[[ "$(curl -s "$OMARCHY_API/api/v1/factory/me" -H "cookie: omc=oms_e2e_agent" | jq -r --arg d "$draft_id" '.drafts[] | select(.id == $d) | .state')" == discarded ]] || { echo "a reset must discard the waiting drafts of the grants it revokes"; exit 1; }
newtok=$(curl -s -X POST "$OMARCHY_API/api/v1/factory/token" -H "cookie: omc=oms_e2e_agent" -H "content-type: application/json" -d '{}' | jq -r .token)
[[ "$newtok" == omc_* && "$(curl -s "$OMARCHY_API/api/v1/factory/me" -H "authorization: Bearer $newtok" | jq -r .contributor.login)" == e2e ]] || { echo "after a reset the person must be able to make a new token: $newtok"; exit 1; }
agent_login "$E2E/agent-maintainer" oms_e2e_agent --maintain || exit 1
mtoken=$(sed -n 's/^token = "\(oma_[0-9a-f]*\)"$/\1/p' "$E2E/agent-maintainer/omarchy-cli/credentials.toml")
blk=$(mcp_call "$E2E/agent-maintainer" block '{"name":"e2e-agent","reason":"the e2e blocks what its agent drafted"}')
draft_id=$(jq -r '.structuredContent.draft' <<<"$blk")
[[ "$draft_id" == d_* ]] || { echo "the agent logged in again must draft the block: $blk"; exit 1; }
curl_url="$OMARCHY_API/auth/confirm/$draft_id"
# The draft's link: no passkey any more.
cpage=$(curl -s "$curl_url" -H "cookie: omc=oms_e2e_agent")
grep -q "Block e2e-agent?" <<<"$cpage" || { echo "the confirm page did not show the draft: $(head -c 400 <<<"$cpage")"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$curl_url" -H "authorization: Bearer $mtoken" -H "origin: $OMARCHY_API" --data "$(form_of <<<"$cpage")&action=confirm&name=e2e-agent")" == 403 ]] || { echo "a confirmation must refuse a token"; exit 1; }
# A block is confirmed with a passkey (#257), and e2e has none since the reset: the page says so and offers no Confirm, and the POST decides nothing.
grep -q "Register a passkey first." <<<"$cpage" || { echo "the confirm page must ask for a passkey to be registered first: $(grep -o '<section class="refused"[^<]*<b>[^<]*' <<<"$cpage" | head -3)"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$curl_url" -H "cookie: omc=oms_e2e_agent" -H "origin: $OMARCHY_API" --data "$(form_of <<<"$cpage")&action=confirm&name=e2e-agent")" == 403 ]] || { echo "a block must not be confirmed without a passkey"; exit 1; }
# e2e registers one again on their own page — their first since the reset, with the session alone — as the browser does, and the
# pool verifies it. The page's origin is the confirm link's, the relying party's the approval above was made on.
[[ "$(jq -r '.structuredContent.confirm_url' <<<"$blk")" == "$rp_origin/auth/confirm/$draft_id" ]] || { echo "the draft's link must name the relying party's origin: $blk"; exit 1; }
pkopts=$(curl -s -X POST "$OMARCHY_API/auth/passkeys/challenge" -H "cookie: omc=oms_e2e_agent" -H "origin: $OMARCHY_API" -H "content-type: application/json" -d '{}')
[[ "$(jq -r '.publicKey.authenticatorSelection.userVerification + " " + .publicKey.attestation' <<<"$pkopts")" == "required none" ]] || { echo "a passkey's options must ask for user verification and no attestation: $pkopts"; exit 1; }
pkreg=$(node "$ROOT/tests/passkey.mjs" register "$E2E/passkey.json" "$rp_origin" "E2E key" <<<"$pkopts" | curl -s -X POST "$OMARCHY_API/auth/passkeys" -H "cookie: omc=oms_e2e_agent" -H "origin: $OMARCHY_API" -H "content-type: application/json" --data-binary @-)
[[ "$(jq -r '.passkey.alg' <<<"$pkreg")" == ES256 ]] || { echo "e2e's passkey must be registered: $pkreg"; exit 1; }
grep -q "e2e registered a passkey (ES256, $(jq -r '.passkey.id' <<<"$pkreg"))" <<<"$(curl -s "$OMARCHY_API/api/v1/events?kind=passkey&limit=5")" || { echo "the passkey's registration must be journaled"; exit 1; }
cpage=$(curl -s "$curl_url" -H "cookie: omc=oms_e2e_agent")
grep -q 'id="pk-confirm"' <<<"$cpage" || { echo "with a passkey, the confirm page must ask for it"; exit 1; }
# The page's script, played by curl and the authenticator: a challenge for this draft, the passkey's answer, the form.
passkey_answer() { curl -s -X POST "$curl_url/challenge" -H "cookie: omc=oms_e2e_agent" -H "origin: $OMARCHY_API" --data "$(form_of <<<"$cpage")" | node "$ROOT/tests/passkey.mjs" assert "$E2E/passkey.json" "$rp_origin"; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$curl_url" -H "cookie: omc=oms_e2e_agent" -H "origin: $OMARCHY_API" --data "$(form_of <<<"$cpage")&$(passkey_answer)&action=confirm")" == 400 ]] || { echo "a block must be confirmed with the package's name typed"; exit 1; }
answer=$(passkey_answer)
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$curl_url" -H "cookie: omc=oms_e2e_agent" -H "origin: $OMARCHY_API" --data "$(form_of <<<"$cpage")&$answer&action=confirm&name=e2e-agent")" == 200 ]] || { echo "the person's confirmation with their passkey must block it"; exit 1; }
grep -q "e2e-agent blocked by e2e — drafted by E2E Agent, confirmed in the browser with a passkey" <<<"$(curl -s "$OMARCHY_API/api/v1/events?kind=block&limit=5")" || { echo "the block's journal line must say it was drafted by the agent and confirmed in the browser with a passkey"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$curl_url" -H "cookie: omc=oms_e2e_agent" -H "origin: $OMARCHY_API" --data "$(form_of <<<"$cpage")&$answer&action=confirm&name=e2e-agent")" == 409 ]] || { echo "a draft decides once"; exit 1; }
# Logout revokes on the pool, then deletes the file.
ctoken=$(sed -n 's/^token = "\(oma_[0-9a-f]*\)"$/\1/p' "$E2E/agent-contributor/omarchy-cli/credentials.toml")
XDG_CONFIG_HOME="$E2E/agent-contributor" "$CLI" --api "$OMARCHY_API" logout | grep -q "Revoked the grant to E2E Agent" || { echo "logout must revoke the grant"; exit 1; }
[[ ! -e "$E2E/agent-contributor/omarchy-cli/credentials.toml" ]] || { echo "logout must delete the credentials"; exit 1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$OMARCHY_API/api/v1/factory/me" -H "authorization: Bearer $ctoken")" == 401 ]] || { echo "a revoked agent token must stop working"; exit 1; }
echo "agents: a grant in the browser, a request through the agent, a block drafted and confirmed once with a passkey, logout"

step "pacman in $IMAGE against the worker mirror"
gpg --armor --export "$KEYID" > "$E2E/omarchy-poc.pub.asc"
cat > "$E2E/pacman.conf" <<CONF
[options]
Architecture = x86_64
SigLevel = Required DatabaseRequired

[omarchy-packages-stable]
Server = http://$HOST_FROM_CONTAINER:$PORT/pool/packages/\$arch
CONF
cat > "$E2E/check.sh" <<'CHECK'
set -euo pipefail
pacman-key --init >/dev/null 2>&1
pacman-key --add /repo/omarchy-poc.pub.asc >/dev/null 2>&1
pacman-key --lsign-key poc@omarchy.invalid >/dev/null 2>&1
echo "--- pacman -Sy"; pacman --config /repo/pacman.conf -Sy
echo "--- pacman -Sl omarchy-packages-stable"; pacman --config /repo/pacman.conf -Sl omarchy-packages-stable
echo "--- pacman -Sp zlib xz"; pacman --config /repo/pacman.conf -Sp zlib xz
echo "--- pacman -Fy && -Fl xz (files database must carry file lists)"
pacman --config /repo/pacman.conf -Fy >/dev/null
pacman --config /repo/pacman.conf -Fl xz | grep -q 'usr/bin/xz$' || { echo "files database is empty"; exit 1; }
echo "--- pacman -Sw xz && -U"; pacman --config /repo/pacman.conf -Sw --noconfirm xz >/dev/null
pacman --config /repo/pacman.conf -U --noconfirm /var/cache/pacman/pkg/xz-5.8.4-1-x86_64.pkg.tar.zst 2>&1 | grep -E "upgrading|installing|error"
pacman -Q xz
CHECK
"$RUNTIME" run --rm --platform linux/amd64 ${RUN_EXTRA[@]+"${RUN_EXTRA[@]}"} -v "$E2E:/repo:ro" "$IMAGE" bash /repo/check.sh

step "OK — pacman consumed a release served by the worker"
