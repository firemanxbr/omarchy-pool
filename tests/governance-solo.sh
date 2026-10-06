#!/usr/bin/env bash
# The solo-maintainer exception's switch (#394): factory/MAINTAINERS.toml's
# `[solo]` table, as factory/bin/check-governance (CI) holds it.
#
# - a table that is exactly the exception — one maintainer of the list, a
#   date written "YYYY-MM-DD", a reason on one line — is taken, and the check
#   says it is in force;
# - one that is not is refused, with its reason: an unknown login, a login
#   that is not a maintainer, more than one maintainer (a list), no reason, a
#   reason over more than one line, a date that does not parse (or is no
#   date at all, or a TOML date not written as a string), a field it does not
#   know, a value that is no table;
# - the table changes neither CODEOWNERS nor the host agent's pin of the
#   co-signature (crates/omarchy-agent/src/verify/maintainers.toml): turning
#   the exception on or off is a governance pull request, never a new agent;
# - without the table, the check reads as it did before #394;
# - the repository's own file passes, and names the exception while it is on.
#
# The Worker reads the same table the same way (worker/src/governance.ts
# parseSolo, worker/test/governance.test.ts). Needs python3 (3.11+, tomllib).
# CI runs it (ci.yml); by hand: `bash tests/governance-solo.sh`.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

tree="$tmp/tree"
mkdir -p "$tree/factory/bin" "$tree/.github" "$tree/crates/omarchy-agent/src/verify"
cp "$root/factory/bin/check-governance" "$root/factory/bin/co-sign" "$tree/factory/bin/"
gov() { python3 "$tree/factory/bin/check-governance" "$@" > "$tmp/out" 2>&1; }
file() { # the [solo] table's lines, after a list of two maintainers and no co-signature
  printf 'maintainers = ["alice", "bob"]\n\n%s\n[cosignature]\nthreshold = 0\n' "$1" > "$tree/factory/MAINTAINERS.toml"
}
refuses() { # why, [solo] lines
  file "$2"
  gov --write && fail "check-governance takes: $2"
  grep -qF "$1" "$tmp/out" || fail "the refusal says '$1': $(cat "$tmp/out")"
}

# 1. Without the table: as before #394 — written, consistent, and no word of an exception.
file ""
gov --write || fail "no [solo]: $(cat "$tmp/out")"
gov || fail "no [solo], consistent once written: $(cat "$tmp/out")"
grep -qF "governance ok: 2 maintainer(s): alice, bob; co-signature: 0 of 0 maintainer(s) with a key (none yet)" "$tmp/out" || fail "it reads as before: $(cat "$tmp/out")"
grep -q "solo" "$tmp/out" && fail "no exception is said without the table: $(cat "$tmp/out")"
cp "$tree/.github/CODEOWNERS" "$tmp/codeowners"
cp "$tree/crates/omarchy-agent/src/verify/maintainers.toml" "$tmp/pin"
echo "ok: without [solo], check-governance reads as it did before #394"

# 2. The exception, as the file turns it on: taken, said, and nothing else written changes.
ok='[solo]
maintainer = "alice"
since = "2026-10-06"
reason = "bob has no time or machines for the pool: one active maintainer and one host"'
file "$ok"
gov || fail "CODEOWNERS and the pin do not depend on [solo]: $(cat "$tmp/out")"
grep -qF "; solo-maintainer exception: alice since 2026-10-06" "$tmp/out" || fail "it says the exception is in force: $(cat "$tmp/out")"
gov --write || fail "the exception: $(cat "$tmp/out")"
cmp -s "$tree/.github/CODEOWNERS" "$tmp/codeowners" || fail "[solo] changed CODEOWNERS"
cmp -s "$tree/crates/omarchy-agent/src/verify/maintainers.toml" "$tmp/pin" || fail "[solo] changed the host agent's pin: it is no agent's business"
# A date TOML reads as a string or a reason with spaces around it: the same exception.
file "$(printf '[solo]\nmaintainer = "bob"\nsince = "2028-02-29"\nreason = "  leap day, one line  "')"
gov || fail "a leap day: $(cat "$tmp/out")"
grep -qF "solo-maintainer exception: bob since 2028-02-29" "$tmp/out" || fail "bob, since a leap day: $(cat "$tmp/out")"
echo "ok: a [solo] table that is exactly the exception is taken and said, and changes neither CODEOWNERS nor the agent's pin"

# 3. Anything else is refused, with why.
refuses "[solo] maintainer carol is not in \`maintainers\`" '[solo]
maintainer = "carol"
since = "2026-10-06"
reason = "carol is nobody here"'
refuses "[solo] maintainer must be a GitHub login" '[solo]
maintainer = "not a login!"
since = "2026-10-06"
reason = "a bad login"'
refuses "[solo] maintainer must be a GitHub login" '[solo]
since = "2026-10-06"
reason = "nobody named"'
refuses "[solo] maintainer names one maintainer, never a list" '[solo]
maintainer = ["alice", "bob"]
since = "2026-10-06"
reason = "two at once"'
refuses "[solo] maintainer names one maintainer, never a list" '[solo]
maintainer = ["alice"]
since = "2026-10-06"
reason = "a list of one is a list"'
refuses "[solo] has unknown field(s) maintainers" '[solo]
maintainer = "alice"
maintainers = ["bob"]
since = "2026-10-06"
reason = "a second maintainer slipped in"'
refuses "[solo] reason is required: why, in one line" '[solo]
maintainer = "alice"
since = "2026-10-06"'
refuses "[solo] reason is required: why, in one line" '[solo]
maintainer = "alice"
since = "2026-10-06"
reason = "   "'
refuses "[solo] reason is one line of 300 characters at most" '[solo]
maintainer = "alice"
since = "2026-10-06"
reason = """
two
lines"""'
refuses "[solo] reason is one line of 300 characters at most" "$(printf '[solo]\nmaintainer = "alice"\nsince = "2026-10-06"\nreason = "%s"' "$(printf 'x%.0s' {1..301})")"
refuses '[solo] since must be a date, written "YYYY-MM-DD"' '[solo]
maintainer = "alice"
since = "2026-02-30"
reason = "no such day"'
refuses '[solo] since must be a date, written "YYYY-MM-DD"' '[solo]
maintainer = "alice"
since = "06/10/2026"
reason = "another way to write it"'
refuses '[solo] since must be a date, written "YYYY-MM-DD"' '[solo]
maintainer = "alice"
since = "soon"
reason = "no date"'
refuses '[solo] since must be a date, written "YYYY-MM-DD"' '[solo]
maintainer = "alice"
reason = "no date at all"'
refuses '[solo] since must be a date, written "YYYY-MM-DD"' '[solo]
maintainer = "alice"
since = 2026-10-06
reason = "a TOML date, not a string"'
refuses "[solo] must be a table" 'solo = "alice"'
echo "ok: check-governance refuses a malformed [solo]: an unknown or unlisted login, more than one maintainer, no reason or more than one line of it, a date that does not parse, an unknown field"

# 4. The repository's own file passes, and says whether the exception is on.
cp "$root/factory/MAINTAINERS.toml" "$tree/factory/MAINTAINERS.toml"
gov --write || fail "the repository's own file: $(cat "$tmp/out")"
gov || fail "the repository's own file, consistent once written: $(cat "$tmp/out")"
if python3 -c 'import sys, tomllib; sys.exit(0 if "solo" in tomllib.load(open(sys.argv[1], "rb")) else 1)' "$root/factory/MAINTAINERS.toml"; then
  grep -qF "; solo-maintainer exception: " "$tmp/out" || fail "the repository's exception is said: $(cat "$tmp/out")"
fi
cmp -s "$tree/.github/CODEOWNERS" "$root/.github/CODEOWNERS" || fail "the repository's CODEOWNERS is what its file writes"
echo "ok: the repository's own MAINTAINERS.toml passes, its [solo] said when it is there"
