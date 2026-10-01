#!/usr/bin/env bash
# What the hosts' trust in a signature relies on inside this repository
# (#308, design v2 §20), read from the files themselves:
#
# - release.yml and rollback.yml install one exact cosign, through the
#   installer pinned by commit, and every `cosign sign` and `cosign
#   sign-blob` names the Fulcio and Rekor it signs against (the signing
#   config), the same in release.yml and factory/bin/release-rollback; a
#   `sign-blob` writes a Sigstore bundle (v0.3), the one format
#   `omarchy-agent verify` reads, and release-rollback signs the rollback
#   statement so (#314);
# - every release.yml job that can mint an OIDC token (`id-token: write`)
#   runs in the `release` environment; rollback.yml's one job in `pool`;
# - the documented identity is exact: release.yml on main, the GitHub
#   issuer, never a regexp;
# - the worker image's base images are pinned by digest and the docker CLI
#   download by SHA-256;
# - every maintainer owns the workflows, the host agent, the dispatcher that
#   starts task containers and the host sets (CODEOWNERS);
# - the v* tag rulesets the admin applies (.github/rulesets/tags.json,
#   tags-locked.json) leave creating tags to GitHub Actions alone, and moving
#   or deleting them to nobody;
# - release.yml's jobs that publish wait behind its gate, the `version` job
#   in the release environment, and nothing writes by default.
#
# The GitHub settings around them (the environments' reviewers and branch
# policy, the applied tag ruleset, immutable releases) live on GitHub, not here:
# the runbook's *The GitHub settings the signature relies on* checks them.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/.."
RELEASE="$root/.github/workflows/release.yml"
ROLLBACK="$root/.github/workflows/rollback.yml"
CONTAINERFILE="$root/factory/image/Containerfile"
fail() { echo "FAIL: $*" >&2; exit 1; }
# A job's block: from `  <job>:` to the next job at the same indentation.
job() { awk -v j="  $2:" '$0 == j { on = 1; print; next } on && /^  [A-Za-z0-9_-]+:$/ { exit } on { print }' "$1"; }
jobs_of() { awk '/^jobs:$/ { on = 1; next } on && /^  [A-Za-z0-9_-]+:$/ { sub(/:$/, ""); sub(/^  /, ""); print }' "$1"; }

# --- one exact cosign ---------------------------------------------------------
pins=""
for w in "$RELEASE" "$ROLLBACK"; do
  n="$(grep -c 'uses: sigstore/cosign-installer' "$w" || true)"
  (( n >= 1 )) || fail "$(basename "$w") installs cosign"
  bad="$(grep -nE 'uses: sigstore/cosign-installer' "$w" | grep -vE 'uses: sigstore/cosign-installer@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+$' || true)"
  [[ -z "$bad" ]] || fail "$(basename "$w"): the installer is pinned by commit: $bad"
  # Each installer step's own `with: cosign-release:` — the next two lines.
  while IFS= read -r pin; do pins+="$pin"$'\n'; done < <(awk '
    /uses: sigstore\/cosign-installer@/ { sha = $0; sub(/.*@/, "", sha); sub(/ .*/, "", sha); want = 3; rel = ""; next }
    want > 0 { want--; if ($0 ~ /cosign-release:/) { rel = $0; sub(/.*cosign-release: */, "", rel); gsub(/["\047]/, "", rel) }
               if (want == 0 || rel != "") { print sha " " (rel == "" ? "unpinned" : rel); want = 0 } }' "$w")
done
distinct="$(sort -u <<<"${pins%$'\n'}")"
[[ "$(wc -l <<<"$distinct" | tr -d ' ')" == 1 ]] || fail "one installer commit and one cosign release everywhere: $distinct"
[[ "$distinct" =~ ^[0-9a-f]{40}\ v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "an exact cosign-release (vX.Y.Z), not a range or the installer's default: $distinct"
echo "ok: release.yml and rollback.yml install one exact cosign (${distinct#* }) through one pinned installer"

# --- the signing config on every signature -------------------------------------
SIGN_FLAGS='--fulcio-url=https://fulcio.sigstore.dev --rekor-url=https://rekor.sigstore.dev'
for f in "$RELEASE" "$root/factory/bin/release-rollback"; do
  signs="$(grep -E 'cosign sign(-blob)?( |$)' "$f" | grep -v '^ *#' || true)"
  [[ -n "$signs" ]] || fail "$(basename "$f") signs"
  unpinned="$(grep -vF -- "cosign sign --yes $SIGN_FLAGS " <<<"$signs" | grep -vF -- "cosign sign-blob --yes $SIGN_FLAGS --new-bundle-format --bundle " || true)"
  [[ -z "$unpinned" ]] || fail "$(basename "$f"): every cosign sign and sign-blob names its Fulcio and Rekor, and a sign-blob writes a Sigstore bundle: $unpinned"
done
grep -v '^ *#' "$root/factory/bin/release-rollback" | grep -qF -- "cosign sign-blob --yes $SIGN_FLAGS --new-bundle-format --bundle " || fail "release-rollback signs the rollback statement into a Sigstore bundle (#314)"
grep -qE 'use-signing-config|--signing-config' "$RELEASE" "$root/factory/bin/release-rollback" && fail "no signing config fetched at run time"
echo "ok: every signature names the public-good Fulcio and Rekor, in release.yml and release-rollback, and the rollback statement is a Sigstore bundle"

# --- OIDC tokens only in the reviewed environments -----------------------------
signers=0
for j in $(jobs_of "$RELEASE"); do
  block="$(job "$RELEASE" "$j")"
  grep -qE '^      id-token: write$' <<<"$block" || continue
  signers=$((signers + 1))
  grep -qE '^    environment: release$' <<<"$block" || fail "release.yml's $j can mint an OIDC token outside the release environment"
done
(( signers >= 1 )) || fail "release.yml has a signing job"
grep -qE '^  id-token: write$' "$RELEASE" && fail "release.yml gives no job an OIDC token by default"
grep -v '^ *#' <<<"$(job "$RELEASE" worker-image)" | grep -q 'cosign' && fail "the image legs sign nothing and install no cosign"
# The gate before anything is published: `version`, which every other job
# needs, runs in the release environment, so a dispatch from another branch
# is refused and one from main waits before a binary is built, a tag or a
# release created or an image pushed; nothing writes by default.
awk '/^permissions:$/ { on = 1; next } on && /^[^ ]/ { exit } on { print }' "$RELEASE" | grep -q 'write' && fail "release.yml's default permissions are read-only"
grep -qE '^    environment: release$' <<<"$(job "$RELEASE" version)" || fail "release.yml's version job, the gate, runs in the release environment"
grep -qE '^    needs: \[ci, e2e\]$' <<<"$(job "$RELEASE" version)" || fail "release.yml's version job needs only ci and e2e"
writers=0
for j in $(jobs_of "$RELEASE"); do
  [[ "$j" == ci || "$j" == e2e || "$j" == version ]] && continue
  block="$(job "$RELEASE" "$j")"
  grep -qE '^    needs: (version|\[(.*, )?version(, .*)?\])$' <<<"$block" || fail "release.yml's $j waits behind the gate (needs: version)"
  grep -qE '^      (contents|packages): write$' <<<"$block" && writers=$((writers + 1))
done
(( writers >= 2 )) || fail "release.yml has its publishing jobs (contents: write, packages: write)"
for j in ci e2e version; do
  grep -qE '^      [a-z-]+: write$' <<<"$(job "$RELEASE" "$j")" && fail "release.yml's $j writes nothing: it runs before the gate or is the gate"
done
for j in $(jobs_of "$ROLLBACK"); do
  block="$(job "$ROLLBACK" "$j")"
  grep -qE '^      name: pool$' <<<"$block" || fail "rollback.yml's $j signs and deploys outside the pool environment"
done
echo "ok: every job that can sign runs in a reviewed environment (release.yml: release; rollback.yml: pool), and every release.yml job that publishes waits behind the release environment's gate"

# --- the exact identity in the docs --------------------------------------------
IDENTITY='https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main'
ISSUER='https://token.actions.githubusercontent.com'
for f in "$CONTAINERFILE" "$root/worker/src/docs/factory.md" "$root/worker/src/pages/docs-workers.ts"; do
  grep -qF -- "--certificate-identity $IDENTITY" "$f" || fail "$(basename "$f") shows the exact identity"
  grep -qF -- "--certificate-oidc-issuer $ISSUER" "$f" || fail "$(basename "$f") shows the issuer"
done
if grep -rn -- 'certificate-identity-regexp' "$root/factory" "$root/worker/src" "$root/docs" "$root/README.md" "$root/SECURITY.md" "$root/CONTRIBUTING.md" 2>/dev/null; then
  fail "no loose identity regexp left in the docs"
fi
echo "ok: the docs show the exact identity (release.yml@refs/heads/main) and issuer"

# --- supply chain: base images by digest, the docker CLI by SHA-256 ------------
grep -qE '^ARG BASE=[^ ]+@sha256:[0-9a-f]{64}$' "$CONTAINERFILE" || fail "the Containerfile's default base image is pinned by digest: $(grep '^ARG BASE' "$CONTAINERFILE")"
bad="$(grep -E '^FROM ' "$CONTAINERFILE" | grep -vE '^FROM (\$\{BASE\}|[^ ]+@sha256:[0-9a-f]{64})( AS [A-Za-z0-9_-]+)?$' || true)"
[[ -z "$bad" ]] || fail "every FROM is the pinned BASE or a digest: $bad"
bases="$(grep -E '^ +base: ' "$RELEASE")"
[[ "$(wc -l <<<"$bases" | tr -d ' ')" == 2 ]] || fail "release.yml names a base image per architecture: $bases"
bad="$(grep -vE '^ +base: [^ ]+@sha256:[0-9a-f]{64}$' <<<"$bases" || true)"
[[ -z "$bad" ]] || fail "release.yml's base images are pinned by digest: $bad"
x86_default="$(sed -n 's/^ARG BASE=//p' "$CONTAINERFILE")"
grep -qF -- "base: $x86_default" "$RELEASE" || fail "the Containerfile's default base is release.yml's x86_64 one: $x86_default"
# The RUN that downloads the docker CLI checks both architectures' sums before it unpacks.
docker_run="$(awk '/^RUN / { run = "" } /^RUN / || run != "" { run = run $0 "\n" } /[^\\]$/ && run != "" { if (run ~ /download\.docker\.com/) printf "%s", run; run = "" }' "$CONTAINERFILE")"
[[ -n "$docker_run" ]] || fail "the Containerfile downloads the docker CLI"
grep -qE 'x86_64\) sum=[0-9a-f]{64}' <<<"$docker_run" && grep -qE 'aarch64\) sum=[0-9a-f]{64}' <<<"$docker_run" || fail "the docker CLI has a SHA-256 per architecture"
grep -qF 'sha256sum -c -' <<<"$docker_run" || fail "the docker CLI download is checked before it is unpacked"
grep -qE 'curl [^|]*download\.docker\.com[^|]*\|' <<<"$docker_run" && fail "the docker CLI is never piped straight into tar"
echo "ok: the base images are pinned by digest and the docker CLI download by SHA-256"
# --- code owners for what the hosts run and trust -------------------------------
# CODEOWNERS is generated from factory/MAINTAINERS.toml (factory/bin/check-governance,
# which CI runs too); every maintainer owns each of these paths.
owners="$(python3 -c 'import tomllib,sys; print(" ".join("@" + m for m in sorted(dict.fromkeys(tomllib.load(open(sys.argv[1], "rb"))["maintainers"]), key=str.lower)))' "$root/factory/MAINTAINERS.toml")"
for path in .github/workflows/ crates/omarchy-agent/ 'crates/pkg-repo/src/dispatch*' factory/sets/; do
  grep -qxE "$(sed 's/[.*]/\\&/g' <<<"$path") +$owners" "$root/.github/CODEOWNERS" || fail "CODEOWNERS gives $path to every maintainer ($owners)"
done
echo "ok: code owners cover the workflows, the host agent, the dispatcher and the host sets"
# --- the v* tag rulesets the admin applies (runbook) -----------------------------
# Two rulesets: creation, which GitHub Actions alone bypasses (release.yml's
# publish creates the tag with its release), and update and deletion, which
# nobody bypasses (no workflow moves or deletes a git tag).
python3 - "$root/.github/rulesets/tags.json" "$root/.github/rulesets/tags-locked.json" <<'PY' || fail "the v* tag rulesets: GitHub Actions alone creates v* tags, nobody moves or deletes them"
import json, sys
create, locked = (json.load(open(p)) for p in sys.argv[1:3])
for r in (create, locked):
    assert r["target"] == "tag" and r["enforcement"] == "active", r
    assert r["conditions"]["ref_name"]["include"] == ["refs/tags/v*"], r["conditions"]
assert [x["type"] for x in create["rules"]] == ["creation"], create["rules"]
assert create["bypass_actors"] == [{"actor_id": 15368, "actor_type": "Integration", "bypass_mode": "always"}], create["bypass_actors"]
assert sorted(x["type"] for x in locked["rules"]) == ["deletion", "update"], locked["rules"]
assert locked["bypass_actors"] == [], locked["bypass_actors"]
PY
echo "ok: the v* tag rulesets let only GitHub Actions create a v* tag, and nobody move or delete one"
echo "TRUST PINS OK"
