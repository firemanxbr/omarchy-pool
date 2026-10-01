#!/usr/bin/env bash
# Every parser the agent runs on a signed bundle, a statement or an owner's
# files, fuzzed for a short budget (design v2 §11.3): the manifest, the
# statement, the bundle archive and the set template with its override. Each
# target starts from the crate's fixtures as its corpus; a crash, a leak or a
# timeout fails the run and leaves the input under
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
mkdir -p "$corpus"/{manifest,statement,bundle,set}
cp "$fixtures"/manifest/*.json "$corpus/manifest/"
printf '%s' '{"schema":1,"seq":7,"to":"v1.13.4","retracts_through":"v1.14.2","issued":"2026-10-20T14:00:00Z","agent_to":null,"run":"https://github.com/firemanxbr/omarchy-pool/actions/runs/1"}' \
  >"$corpus/statement/example.json"
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

cd "$crate"
# cargo fuzz has no --locked: fail here if fuzz/Cargo.lock would have to change.
cargo "+$toolchain" metadata --locked --manifest-path fuzz/Cargo.toml --format-version 1 >/dev/null
# cargo fuzz builds for the triple it was itself built for unless told otherwise,
# and a prebuilt cargo-fuzz (ci.yml's) is a musl binary: the sanitizers need the
# toolchain's own host triple.
host="$(rustc "+$toolchain" -vV | sed -n 's/^host: //p')"
for target in manifest statement bundle set; do
  echo "fuzz: $target for ${seconds}s"
  cargo "+$toolchain" fuzz run --target "$host" "$target" "fuzz/corpus/$target" -- \
    -max_total_time="$seconds" -rss_limit_mb=2048 -timeout=10 -print_final_stats=1 2>&1 | tail -n 12
done
echo "fuzz: every target ran ${seconds}s without a finding"
