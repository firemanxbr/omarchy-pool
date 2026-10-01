#!/usr/bin/env bash
# factory/bin/agent-version-check (design v2 D17, #311) on a throwaway
# repository: a change to what goes into the agent's binary since the previous
# release fails without a version raise and passes with one; a change
# elsewhere, to the agent's tests, or to a dev-dependency's lock entry needs
# none; a release with no agent yet leaves nothing to compare; a tag on HEAD
# itself is not the previous release.
#
# Needs git and python3 (3.11+). CI runs it in the worker job; by hand:
#   bash tests/agent-version.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$here/../factory/bin/agent-version-check"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
n=0
r="$tmp/repo"
g() { git -C "$r" -c user.name=t -c user.email=t@example.org -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
commit() { g add -A && g commit -qm "$1"; }
passes() { "$check" --repo "$r" >"$tmp/out" 2>&1 || { cat "$tmp/out" >&2; fail "$1"; }; n=$((n + 1)); }
fails() { # what, the message it must give
  if "$check" --repo "$r" >"$tmp/out" 2>&1; then cat "$tmp/out" >&2; fail "$1 passed"; fi
  grep -qF -- "$2" "$tmp/out" || { cat "$tmp/out" >&2; fail "$1: the message names $2"; }
  n=$((n + 1))
}
lock() { # the agent's normal dependency foo (which needs baz), its dev-dependency bar, and other
  cat > "$r/Cargo.lock" <<EOF
version = 4

[[package]]
name = "omarchy-agent"
version = "$1"
dependencies = ["foo", "bar"]

[[package]]
name = "foo"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aa"
dependencies = ["baz"]

[[package]]
name = "baz"
version = "$2"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "$2"

[[package]]
name = "bar"
version = "$3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "$3"

[[package]]
name = "other"
version = "$4"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "$4"
EOF
}
crate() {
  cat > "$r/crates/omarchy-agent/Cargo.toml" <<EOF
[package]
name = "omarchy-agent"
version = "$1"

[dependencies]
foo = "1"

[dev-dependencies]
bar = "1"
EOF
}

mkdir -p "$r/crates/omarchy-agent/src" "$r/crates/omarchy-agent/tests" "$r/crates/other"
g init -q
echo 'fn main() {}' > "$r/crates/other/main.rs"
echo '[profile.release]' > "$r/Cargo.toml"; echo 'lto = "thin"' >> "$r/Cargo.toml"
echo '[toolchain]' > "$r/rust-toolchain.toml"
commit "before the agent"
g tag v1.0.0
echo 'fn main() {}' > "$r/crates/omarchy-agent/src/main.rs"
crate 0.1.0; lock 0.1.0 1.0.0 1.0.0 1.0.0
commit "the agent arrives"
passes "a previous release with no agent: nothing to compare"
grep -qF "v1.0.0 has no agent" "$tmp/out" || fail "it says the previous release has no agent: $(cat "$tmp/out")"
g tag v1.0.1
passes "HEAD's own tag is not the previous release"
grep -qF "v1.0.0 has no agent" "$tmp/out" || fail "with HEAD tagged, v1.0.0 is the previous release: $(cat "$tmp/out")"

echo '// a comment' >> "$r/crates/other/main.rs"; echo '#[test] fn t() {}' > "$r/crates/omarchy-agent/tests/cli.rs"
lock 0.1.0 1.0.0 1.0.1 1.0.1
commit "another crate, the agent's tests, a dev-dependency and an unrelated lock entry"
passes "changes outside the agent's binary need no raise"
grep -qF "unchanged since v1.0.1" "$tmp/out" || fail "it compares with v1.0.1: $(cat "$tmp/out")"

echo 'fn helper() {}' >> "$r/crates/omarchy-agent/src/main.rs"; commit "the agent's code"
fails "a change to the agent's src without a raise" "crates/omarchy-agent/src/main.rs changed"
crate 0.1.1; lock 0.1.1 1.0.0 1.0.1 1.0.1; commit "raise"
passes "the same change with the version raised"
g tag v1.0.2

lock 0.1.1 1.0.2 1.0.1 1.0.1; commit "a transitive dependency of the agent"
fails "a lock entry of a crate the agent builds with, without a raise" "Cargo.lock: baz 1.0.2"
g reset -q --hard v1.0.2

printf '[toolchain]\nchannel = "9.9.9"\n' > "$r/rust-toolchain.toml"; commit "toolchain"
fails "a new toolchain without a raise" "rust-toolchain.toml changed"
g reset -q --hard v1.0.2

echo 'codegen-units = 1' >> "$r/Cargo.toml"; commit "profile"
fails "a release profile change without a raise" "[profile.*] changed"
g reset -q --hard v1.0.2

echo 'fn helper2() {}' >> "$r/crates/omarchy-agent/src/main.rs"; crate 0.1.0; lock 0.1.0 1.0.0 1.0.1 1.0.1; commit "lowered"
fails "a version lowered" "raise it above 0.1.1"

echo "AGENT VERSION OK ($n checks)"
