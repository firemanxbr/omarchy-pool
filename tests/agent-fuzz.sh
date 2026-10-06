#!/usr/bin/env bash
# Every parser the agent runs on a signed bundle, a statement, an owner's
# files or its own state, fuzzed for a short budget (design v2 §11.3): the
# manifest, the statement, the bundle archive, the set template with its
# override, state.json with the pool's host state and the follow answer
# of a pool from before it (#315, #344), run/capacity.json narrowed to the
# pool's settings (#325), GitHub's unauthenticated answer for its latest
# release, the tag freeze detection reads (#326), the maintainers'
# co-signature (#330: the pinned policy and an armored SSH signature), the
# owner's signed documents, passkey assertions, pins and COSE keys (#328),
# and a host key's TPM public area and the TPM's signatures (#330). Each
# target starts from the crate's fixtures as its corpus; a crash, a leak or
# a timeout fails the run and leaves the input under
# crates/omarchy-agent/fuzz/artifacts/.
#
# Needs the pinned nightly and cargo-fuzz (ci.yml installs both). By hand:
#   bash tests/agent-fuzz.sh [seconds per target, default 60]
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
seconds="${1:-60}"
toolchain="${OMARCHY_FUZZ_TOOLCHAIN:-nightly-2026-09-25}"
crate="$root/crates/omarchy-agent"
fixtures="$crate/tests/fixtures"
corpus="$crate/fuzz/corpus"

rm -rf "$corpus"
mkdir -p "$corpus"/{manifest,statement,bundle,set,state,cosignature}
cp "$fixtures"/manifest/*.json "$corpus/manifest/"
printf '%s' '{"schema":1,"seq":7,"to":"v1.13.4","retracts_through":"v1.14.2","issued":"2026-10-20T14:00:00Z","agent_to":null,"run":"https://github.com/firemanxbr/omarchy-pool/actions/runs/1"}' \
  >"$corpus/statement/example.json"
# state.json as the run loop writes it mid-round, a host state with its orders,
# and a follow answer (read only from a pool from before #344).
printf '%s' '{"state_schema":1,"agent":"0.2.0","floor":"v1.20.0","min_release":"v1.18.0","revoked":["v1.19.1"],"statement_seq":3,"applied":"v1.20.0","target":"v1.21.0","quarantine":{"v1.19.0":{"until":1800000000,"reverts":1}},"update_seen":"ord_1","tools":null,"pulled":{"v1.20.0":["ghcr.io/firemanxbr/omarchy-worker@sha256:1bc04b5291c26a46d918139138b992d2de976d6851d0893b0476b85bfbdfc6e6"]},"rollout":{"step":{"state":"replace","files":"staging","phase":"drain","since":1800000000},"since":1800000000,"target":"v1.21.0","from":"v1.20.0","rollback":false,"why":"the pool names v1.21.0","services":["dispatcher"],"reverting":null},"round":{"at":1,"outcome":"ok","from":null,"step":"commit","detail":""},"poll":{"next_at":2,"backoff_s":0,"last":"ok","last_at":1}}'   >"$corpus/state/state.json"
printf '%s' '{"host":"h_0123456789","status":"active","release":{"target":"v1.21.0","deployed_at":"2026-10-01T00:00:00Z"},"poll_s":120,"updates":["wo_1"],"orders":[{"id":"ho_1","kind":"retire-legacy","not_after":"2026-10-01T01:00:00.000Z"},{"id":"ho_2","kind":"reconcile-now","not_after":1790000000}]}'   >"$corpus/state/host-state.json"
# P4's host state (#325): the settings the pool keeps, and orders with their arguments;
# and run/capacity.json as the loop narrows it to settings.
printf '%s' '{"host":"h_0123456789","status":"active","release":{"target":"v1.21.0"},"settings":{"units":4,"emulate":["x86_64"]},"orders":[{"id":"ho_3","kind":"set-units","not_after":1790000000,"units":4},{"id":"ho_4","kind":"set-emulate","not_after":1790000000,"emulate":[]},{"id":"ho_5","kind":"set-units","not_after":1790000000,"units":null},{"id":"ho_6","kind":"diagnostics","not_after":1790000000}]}'   >"$corpus/state/host-state-p4.json"
printf '%s' '{"schema":2,"at":"2027-01-15T08:00:00Z","cpus":12,"mem_gb":32,"units":4,"job_reserved":1,"lanes":[{"arch":"aarch64","mode":"native"}],"detected":{"units":11,"job_reserved":1,"lanes":[{"arch":"aarch64","mode":"native"},{"arch":"x86_64","mode":"emulated"}]},"settings":{"units":4,"emulate":[]}}'   >"$corpus/state/capacity.json"
printf '%s' '{"latest":"v1.21.0","deployed_at":"2026-10-01T00:00:00Z","poll_s":120,"workers":[{"id":"w_fuzz","version":"v1.20.0","outdated":true,"update":"ord_1"}]}'   >"$corpus/state/follow.json"
# GitHub's answer for its latest release (#326): only tag_name is read.
printf '%s' '{"url":"https://api.github.com/repos/firemanxbr/omarchy-pool/releases/1","tag_name":"v1.21.0","name":"v1.21.0","draft":false,"prerelease":false,"published_at":"2026-10-01T00:00:00Z","assets":[{"name":"omarchy-host-v1.21.0.tar.gz","size":1}],"body":"notes"}'   >"$corpus/state/github-latest.json"
# The owner's documents as the pool writes them, an assertion and a pin as the
# browser answers them (#328): the recorded fixtures of tests/owner-fixtures.mjs.
owner="$fixtures/owner/cases.json"
jq -r '.widen.doc' "$owner" >"$corpus/state/owner-widen.json"
jq -r '.keys.doc' "$owner" >"$corpus/state/owner-keys.json"
jq -c '.widen.assertion' "$owner" >"$corpus/state/owner-assertion.json"
jq -r '.pins.es256' "$owner" >"$corpus/state/owner-pin.txt"
jq -c '{max_units: 8, emulate: ["x86_64"], agent_budget: {calls_per_day: 9000}}' -n >"$corpus/state/owner-envelope.json"
# The host key in a TPM (#330): its public area and the TPM's signatures, as swtpm wrote
# them (tests/tpm-fixtures.sh), and the public areas the agent refuses.
for f in host.tpm.pub exportable.pub storage.pub rsa.pub enroll.sig request.sig; do
  cp "$fixtures/tpm/$f" "$corpus/state/tpm-$f"
done
# A bundle archive as release.yml writes it: manifest.json and a set.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/sets/host"
cp "$fixtures/manifest/v2-example.json" "$tmp/manifest.json"
cp "$fixtures/lint/host/compose.yml" "$tmp/sets/host/compose.yml"
tar -C "$tmp" -czf "$corpus/bundle/example.tar.gz" manifest.json sets
n=0
for f in "$fixtures"/lint/host/compose.yml "$fixtures"/lint/template/*.yml; do
  n=$((n + 1)); cp "$f" "$corpus/set/template-$n.yml"
done
for f in "$fixtures"/lint/override/*.yml; do
  n=$((n + 1)); { cat "$fixtures/lint/host/compose.yml"; printf '\0'; cat "$f"; } >"$corpus/set/with-override-$n.yml"
done
# The template with its set.toml after the NUL: the target reads the second part as both.
{ cat "$fixtures/lint/host/compose.yml"; printf '\0'; cat "$fixtures/lint/host/set.toml"; } >"$corpus/set/with-set-toml.yml"

# The co-signature's fixtures as the target reads them: a policy, NUL, a
# signature, NUL, the bytes it signs.
c="$fixtures/cosignature"
for sig in "$c"/bundle.*.sshsig; do
  { printf 'threshold = 1\n[keys]\nalice = "%s"\n' "$(cut -d' ' -f1,2 "$c/alice.pub")"; printf '\0'; cat "$sig"; printf '\0'; cat "$c/bundle"; } \
    >"$corpus/cosignature/$(basename "$sig")"
done
{ printf '\0'; cat "$c/statement.json.alice.sshsig"; printf '\0'; cat "$c/statement.json"; } >"$corpus/cosignature/statement"
# A maintainer's backup key beside their own: a list (Carol's standing in for it).
{ printf 'threshold = 1\n[keys]\nalice = ["%s", "%s"]\n' "$(cut -d' ' -f1,2 "$c/alice.pub")" "$(cut -d' ' -f1,2 "$c/carol.pub")"; printf '\0'; cat "$c/bundle.carol.sshsig"; printf '\0'; cat "$c/bundle"; } \
  >"$corpus/cosignature/backup-key"

cd "$crate"
# cargo fuzz has no --locked: fail here if fuzz/Cargo.lock would have to change.
cargo "+$toolchain" metadata --locked --manifest-path fuzz/Cargo.toml --format-version 1 >/dev/null
# cargo fuzz builds for the triple it was itself built for unless told otherwise,
# and a prebuilt cargo-fuzz (ci.yml's) is a musl binary: the sanitizers need the
# toolchain's own host triple.
host="$(rustc "+$toolchain" -vV | sed -n 's/^host: //p')"
for target in manifest statement bundle set state cosignature; do
  echo "fuzz: $target for ${seconds}s"
  cargo "+$toolchain" fuzz run --target "$host" "$target" "fuzz/corpus/$target" -- \
    -max_total_time="$seconds" -rss_limit_mb=2048 -timeout=10 -print_final_stats=1 2>&1 | tail -n 12
done
echo "fuzz: every target ran ${seconds}s without a finding"
