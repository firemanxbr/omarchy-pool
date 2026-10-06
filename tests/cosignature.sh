#!/usr/bin/env bash
# The maintainers' co-signature outside the agent (#330, design v2 D1 b and
# D25), against the fixtures the agent's own tests read
# (crates/omarchy-agent/tests/fixtures/cosignature/: Alice's ed25519-sk and
# Bob's ecdsa-sk security keys, played in Rust; Carol's, whom no
# MAINTAINERS.toml pins; one signature made without a touch, one made for a
# statement, and a plain ed25519 signature OpenSSH made):
#
# - OpenSSH's own `ssh-keygen -Y verify` takes the security-key signatures the
#   agent's tests make and verify, in their namespace only — the agent's
#   framing is OpenSSH's, both ways (the agent verifies the one OpenSSH made);
# - `factory/bin/co-sign check` counts a pinned maintainer's touch signature
#   only: 1-of-N, 2-of-N, a wrong key, someone not pinned, no touch, another
#   namespace, and an older release's policy beside this one's;
# - `factory/bin/check-governance` refuses a `[cosignature]` table the agent
#   would refuse, and pins the table into the agent with --write;
# - `factory/bin/publish-release` keeps a draft without the co-signature
#   this release's agent and the last 30 days' agents require, and
#   publishes it once they are on it;
# - a maintainer's `co-sign release` and `co-sign rollback` (a played
#   security key, a stubbed gh and agent, a stand-in pool): the keyless
#   signature checked first, what is signed shown, the pinned key only, a
#   touch, the draft or the pool given the signature.
#
# Needs ssh-keygen (OpenSSH 8.9 or later), python3. CI runs it (ci.yml); by
# hand: `bash tests/cosignature.sh`.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
fx="$root/crates/omarchy-agent/tests/fixtures/cosignature"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
B=host-bundle@omarchy-pool.org
R=rollback@omarchy-pool.org
key() { cut -d' ' -f1,2 "$fx/$1.pub"; }

# 1. OpenSSH and the agent read one format.
for who in alice bob carol; do printf '%s namespaces="%s,%s" %s\n' "$who" "$B" "$R" "$(key "$who")"; done > "$tmp/allowed"
verify() { ssh-keygen -Y verify -f "$tmp/allowed" -I "$1" -n "$2" -s "$3" < "$4" >/dev/null 2>&1; }
for who in alice bob carol; do
  verify "$who" "$B" "$fx/bundle.$who.sshsig" "$fx/bundle" || fail "ssh-keygen takes $who's security-key signature of the bundle"
  verify "$who" "$R" "$fx/bundle.$who.sshsig" "$fx/bundle" && fail "a bundle's signature is no statement's"
done
verify alice "$R" "$fx/statement.json.alice.sshsig" "$fx/statement.json" || fail "ssh-keygen takes Alice's statement signature"
verify alice "$B" "$fx/bundle.wrong-namespace.sshsig" "$fx/bundle" && fail "a signature made for a statement is no bundle's"
verify alice "$B" "$fx/bundle.carol.sshsig" "$fx/bundle" && fail "Carol's signature is not Alice's"
printf 'other bytes\n' > "$tmp/other"
verify alice "$B" "$fx/bundle.alice.sshsig" "$tmp/other" && fail "a signature over other bytes"
printf 'plain namespaces="%s" %s\n' "$B" "$(key plain)" > "$tmp/plain"
ssh-keygen -Y verify -f "$tmp/plain" -I plain -n "$B" -s "$fx/bundle.plain.sshsig" < "$fx/bundle" >/dev/null || fail "OpenSSH's own signature verifies"
echo "ok: ssh-keygen -Y verify takes the agent's security-key fixtures in their namespace only, and the agent's tests take OpenSSH's"

# 2. co-sign check: a governance file per case.
governance() { # threshold, logins with a key...
  local t="$1"; shift
  printf 'maintainers = ["alice", "bob", "carol"]\n\n[cosignature]\nthreshold = %s\n\n[cosignature.keys]\n' "$t"
  for who in "$@"; do printf '%s = "%s %s@security-key"\n' "$who" "$(key "$who")" "$who"; done
}
sigs() { # the files of these logins beside the bundle, from the fixtures named
  rm -rf "$tmp/sigs"; mkdir -p "$tmp/sigs"; cp "$fx/bundle" "$tmp/sigs/bundle"
  local pair
  for pair in "$@"; do cp "$fx/${pair#*=}" "$tmp/sigs/bundle.${pair%%=*}.sshsig"; done
}
check() { python3 "$root/factory/bin/co-sign" check "$tmp/sigs/bundle" --namespace "$B" --signatures "$tmp/sigs" "$@" > "$tmp/out" 2>&1; }
governance 1 alice bob > "$tmp/one-of-two.toml"
governance 2 alice bob > "$tmp/two-of-two.toml"
governance 0 alice > "$tmp/none.toml"
governance 1 bob > "$tmp/bob-only.toml"
sigs
check --policy "v1=$tmp/one-of-two.toml" && fail "1-of-2 with no co-signature"
grep -qF "NOT MET: v1: 0 of the 1 maintainer co-signature(s) it requires verify" "$tmp/out" || fail "the refusal says what is missing: $(cat "$tmp/out")"
check --policy "v1=$tmp/none.toml" || fail "threshold 0 asks nothing: $(cat "$tmp/out")"
sigs alice=bundle.alice.sshsig
check --policy "v1=$tmp/one-of-two.toml" || fail "1-of-2 with Alice's: $(cat "$tmp/out")"
grep -qF "v1: 1 of the 1 maintainer co-signature(s) it requires verify (alice)" "$tmp/out" || fail "it names who: $(cat "$tmp/out")"
check --policy "v1=$tmp/two-of-two.toml" && fail "2-of-2 with Alice's alone"
sigs alice=bundle.alice.sshsig bob=bundle.bob.sshsig
check --policy "v1=$tmp/two-of-two.toml" || fail "2-of-2 with both (ed25519-sk and ecdsa-sk): $(cat "$tmp/out")"
# Carol's valid signature, under her own name (not pinned) or put where Alice's goes.
sigs carol=bundle.carol.sshsig
check --policy "v1=$tmp/one-of-two.toml" && fail "Carol is pinned by no MAINTAINERS.toml"
sigs alice=bundle.carol.sshsig
check --policy "v1=$tmp/one-of-two.toml" && fail "Carol's signature is not Alice's"
grep -qF "alice:" "$tmp/out" || fail "the refusal names Alice's file: $(cat "$tmp/out")"
# No touch: ssh-keygen takes it, the agent does not, and neither does co-sign.
verify alice "$B" "$fx/bundle.untouched.sshsig" "$fx/bundle" || fail "ssh-keygen -Y verify takes a signature without a touch (it does not look)"
sigs alice=bundle.untouched.sshsig
check --policy "v1=$tmp/one-of-two.toml" && fail "a signature made without a touch counts"
grep -qF "alice: made without a touch" "$tmp/out" || fail "the refusal says no touch: $(cat "$tmp/out")"
sigs alice=bundle.wrong-namespace.sshsig
check --policy "v1=$tmp/one-of-two.toml" && fail "a statement's signature counts for a bundle"
# An older release's agent pinned Bob only: Alice's alone meets this release's and not that one's.
sigs alice=bundle.alice.sshsig
check --policy "v2=$tmp/one-of-two.toml" --policy "v1=$tmp/bob-only.toml" && fail "an older agent's policy is not met"
grep -qF "NOT MET: v1:" "$tmp/out" || fail "the older policy is named: $(cat "$tmp/out")"
sigs alice=bundle.alice.sshsig bob=bundle.bob.sshsig
check --policy "v2=$tmp/one-of-two.toml" --policy "v1=$tmp/bob-only.toml" || fail "both policies met: $(cat "$tmp/out")"
python3 "$root/factory/bin/co-sign" signers "$tmp/one-of-two.toml" > "$tmp/signers"
if ! { [[ "$(wc -l < "$tmp/signers")" -eq 2 ]] && grep -qF "alice namespaces=\"$B,$R\" $(key alice)" "$tmp/signers"; }; then fail "signers: $(cat "$tmp/signers")"; fi
echo "ok: co-sign check counts a pinned maintainer's touch signature in the bundle's namespace only: 1-of-N, 2-of-N, and every policy given"

# 3. check-governance: the table the agent would refuse is refused, and --write pins it.
tree="$tmp/tree"
mkdir -p "$tree/factory/bin" "$tree/.github" "$tree/crates/omarchy-agent/src/verify"
cp "$root/factory/bin/check-governance" "$root/factory/bin/co-sign" "$tree/factory/bin/"
gov() { python3 "$tree/factory/bin/check-governance" "$@" > "$tmp/out" 2>&1; }
refuses() { # why, file content
  printf '%s' "$2" > "$tree/factory/MAINTAINERS.toml"
  gov --write && fail "check-governance takes $1"
  grep -qF "$1" "$tmp/out" || fail "the refusal says '$1': $(cat "$tmp/out")"
}
refuses "is never met" "$(governance 2 alice)"
refuses "dave is not in \`maintainers\`" "$(governance 1 alice; printf 'dave = "%s"\n' "$(key carol)")"
refuses "not a FIDO key" "$(governance 1; printf 'alice = "%s"\n' "$(key plain)")"
refuses "have the same key" "$(governance 1 alice; printf 'bob = "%s"\n' "$(key alice)")"
refuses "unknown field" "$(printf 'maintainers = ["alice"]\n[cosignature]\nthreshold = 0\nmode = "on"\n')"
governance 1 alice bob > "$tree/factory/MAINTAINERS.toml"
gov --write || fail "check-governance --write: $(cat "$tmp/out")"
pinned="$tree/crates/omarchy-agent/src/verify/maintainers.toml"
if ! { grep -qx 'threshold = 1' "$pinned" && grep -qF "alice = \"$(key alice)\"" "$pinned" && grep -qF "bob = \"$(key bob)\"" "$pinned"; }; then
  fail "the agent's pin: $(cat "$pinned")"
fi
gov || fail "consistent once written: $(cat "$tmp/out")"
grep -qF "co-signature: 1 of 2 key(s) (alice, bob)" "$tmp/out" || fail "it says the policy: $(cat "$tmp/out")"
sed -i 's/^threshold = 1$/threshold = 0/' "$pinned"
gov && fail "an agent pin that differs from MAINTAINERS.toml"
grep -qF "maintainers.toml does not match" "$tmp/out" || fail "it names the agent's pin: $(cat "$tmp/out")"
# The repository's own pin is the one check-governance writes (CI runs it bare too).
cp "$root/factory/MAINTAINERS.toml" "$tree/factory/MAINTAINERS.toml"
gov --write >/dev/null
cmp -s "$pinned" "$root/crates/omarchy-agent/src/verify/maintainers.toml" || fail "the agent's pin is not what factory/MAINTAINERS.toml writes"
echo "ok: check-governance refuses what the agent would and pins [cosignature] into the agent"

# 4. publish-release, in a tree of its own: this release's governance file is the tree's.
rel="$tmp/rel"
mkdir -p "$rel/factory/bin" "$tmp/bin" "$tmp/draft" "$tmp/governance"
cp "$root/factory/bin/publish-release" "$root/factory/bin/co-sign" "$rel/factory/bin/"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "release view")
    case "$*" in
      *isDraft*) cat "$GH_STATE" ;;
      *assets*) ls "$GH_DRAFT" ;;
    esac ;;
  "release edit") [[ "$*" == *"--draft=false"* ]] && echo false > "$GH_STATE" ;;
  "release list") cat "$GH_RELEASES" ;;
  "release download")
    dir=""; pats=(); while [[ $# -gt 0 ]]; do case "$1" in --dir) dir="$2"; shift ;; --pattern) pats+=("$2"); shift ;; esac; shift; done
    mkdir -p "$dir"; for p in "${pats[@]}"; do cp "$GH_DRAFT/$p" "$dir/"; done ;;
  "api repos/{owner}/{repo}/contents/factory/MAINTAINERS.toml?ref="*)
    tag="${2##*ref=}"; [[ -f "$GH_GOVERNANCE/$tag" ]] && { cat "$GH_GOVERNANCE/$tag"; exit 0; }
    echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$tmp/bin/gh"
v=v1.2.3
export GH_LOG="$tmp/gh.log" GH_STATE="$tmp/state" GH_DRAFT="$tmp/draft" GH_RELEASES="$tmp/releases" GH_GOVERNANCE="$tmp/governance"
for a in "omarchy-pool-$v-x86_64-linux.tar.gz" "omarchy-pool-$v-x86_64-linux.tar.gz.sha256" "omarchy-pool-$v-aarch64-linux.tar.gz" \
  "omarchy-pool-$v-aarch64-linux.tar.gz.sha256" omarchy-staging.pub.asc omarchy-agent-x86_64-linux-musl omarchy-agent-aarch64-linux-musl \
  omarchy-agent-aarch64-darwin "omarchy-host-$v.tar.gz.sigstore.json" install.sh build-images.json; do echo "the run's $a" > "$tmp/draft/$a"; done
# The host bundle is the fixtures' bundle: what their signatures sign.
cp "$fx/bundle" "$tmp/draft/omarchy-host-$v.tar.gz"
(cd "$tmp/draft" && sha256sum -- *) > "$tmp/sums"
publish() { PATH="$tmp/bin:$PATH" "$rel/factory/bin/publish-release" "$v" "$tmp/sums" > "$tmp/out" 2>&1; }
cosign() { cp "$fx/$2" "$tmp/draft/omarchy-host-$v.tar.gz.$1.sshsig"; }
draft() { echo true > "$GH_STATE"; : > "$GH_LOG"; rm -f "$tmp/draft/"*.sshsig; }
# Nothing asked anywhere: published as before.
governance 0 alice bob > "$rel/factory/MAINTAINERS.toml"; : > "$GH_RELEASES"; draft
publish || fail "no threshold, no co-signature asked: $(cat "$tmp/out")"
grep -qx "release edit $v --draft=false" "$GH_LOG" || fail "published: $(cat "$GH_LOG")"
# 1-of-2: no co-signature, or Carol's (pinned nowhere), keeps the draft.
governance 1 alice bob > "$rel/factory/MAINTAINERS.toml"; draft
publish && fail "a draft without the co-signature its agent requires was published"
grep -qF "lacks the maintainers' co-signature its agents require; it stays a draft (factory/bin/co-sign release $v" "$tmp/out" || fail "the refusal says how: $(cat "$tmp/out")"
grep -q 'release edit' "$GH_LOG" && fail "a draft without its co-signature was edited"
draft; cosign carol bundle.carol.sshsig
publish && fail "Carol's co-signature counts"
draft; cosign alice bundle.untouched.sshsig
publish && fail "a co-signature made without a touch counts"
draft; cosign alice bundle.alice.sshsig
publish || fail "Alice's co-signature meets 1-of-2: $(cat "$tmp/out")"
grep -qx "release edit $v --draft=false" "$GH_LOG" || fail "published once co-signed: $(cat "$GH_LOG")"
# A release of the last 30 days pinned Bob only: its agents need his too.
echo v1.2.2 > "$GH_RELEASES"; governance 1 bob > "$GH_GOVERNANCE/v1.2.2"
draft; cosign alice bundle.alice.sshsig
publish && fail "the last 30 days' agents would refuse it"
grep -qF "NOT MET: v1.2.2:" "$tmp/out" || fail "the older release's policy is named: $(cat "$tmp/out")"
draft; cosign alice bundle.alice.sshsig; cosign bob bundle.bob.sshsig
publish || fail "both policies met: $(cat "$tmp/out")"
# A release from before the governance file had a table, or before the file, asks nothing.
printf 'v1.2.1\nv1.2.0\n' > "$GH_RELEASES"; printf 'maintainers = ["alice"]\n' > "$GH_GOVERNANCE/v1.2.1"
draft; cosign alice bundle.alice.sshsig
publish || fail "older releases with no policy ask nothing: $(cat "$tmp/out")"
# Published without it: a person must look.
echo false > "$GH_STATE"; rm -f "$tmp/draft/"*.sshsig
publish && fail "a published release without its co-signature is reported"
grep -qF "is published without the maintainers' co-signature its agents require: a person must look" "$tmp/out" || fail "$(cat "$tmp/out")"
echo "ok: publish-release keeps a draft until the co-signatures its agent and the last 30 days' agents require are on it"

# 5. A maintainer's side, `co-sign release` and `co-sign rollback`, with a played
# security key: `ssh-keygen -Y sign` hands over the fixture's signature (no
# key here to touch), every `-Y verify` is OpenSSH's own.
real_keygen="$(command -v ssh-keygen)"
mkdir -p "$tmp/mbin" "$tmp/keys"
cat > "$tmp/mbin/ssh-keygen" <<STUB
#!/usr/bin/env bash
if [[ "\$1 \$2" == "-Y sign" ]]; then
  echo "\$*" >> "\$KEYGEN_LOG"
  file="\${!#}"; [[ "\$*" == *"-n \$SIGN_NAMESPACE "* ]] || exit 9
  cp "\$SIGN_AS" "\$file.sig"; exit 0
fi
exec "$real_keygen" "\$@"
STUB
cat > "$tmp/mbin/omarchy-agent" <<'STUB'
#!/usr/bin/env bash
echo "omarchy-agent $*" >> "$KEYGEN_LOG"
[[ -z "${AGENT_REFUSES:-}" ]] || { echo "refused (signature): forged" >&2; exit 1; }
echo '{"verified":"'"${2#--}"'"}'
STUB
cat > "$tmp/mbin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "api user") echo "$GH_USER" ;;
  "release download")
    dir=""; pats=(); while [[ $# -gt 0 ]]; do case "$1" in --dir) dir="$2"; shift ;; --pattern) pats+=("$2"); shift ;; esac; shift; done
    for p in "${pats[@]}"; do cp "$GH_DRAFT/$p" "$dir/"; done ;;
  "release upload") cp "$4" "$GH_DRAFT/" ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$tmp/mbin/"*
governance 1 alice bob > "$rel/factory/MAINTAINERS.toml"
printf 'a security key handle, never a key\n' > "$tmp/keys/id_ed25519_sk"
cp "$fx/alice.pub" "$tmp/keys/id_ed25519_sk.pub"
export KEYGEN_LOG="$tmp/keygen.log" GH_USER=alice SIGN_NAMESPACE="$B" SIGN_AS="$fx/bundle.alice.sshsig"
mine() { PATH="$tmp/mbin:$PATH" python3 "$rel/factory/bin/co-sign" "$@" --key "$tmp/keys/id_ed25519_sk" --yes > "$tmp/out" 2>&1; }
draft; : > "$KEYGEN_LOG"
mine release "$v" || fail "co-sign release: $(cat "$tmp/out")"
cmp -s "$tmp/draft/omarchy-host-$v.tar.gz.alice.sshsig" "$fx/bundle.alice.sshsig" || fail "Alice's co-signature is on the draft"
grep -qF "release upload $v" "$GH_LOG" || fail "uploaded to the draft: $(cat "$GH_LOG")"
grep -qF "omarchy-agent verify --bundle" "$KEYGEN_LOG" || fail "release.yml's signature is checked first"
grep -qF "release v1.2.3, created 2027-01-14T08:00:00Z, agent 0.3.0" "$tmp/out" || fail "the manifest is shown: $(cat "$tmp/out")"
grep -qF "sha256:$(sha256sum "$fx/bundle" | cut -d' ' -f1)" "$tmp/out" || fail "the bundle's SHA-256 is shown"
publish || fail "publish-release takes what co-sign uploaded: $(cat "$tmp/out")"
# release.yml's signature refused: nothing is signed or uploaded.
draft; : > "$KEYGEN_LOG"
AGENT_REFUSES=1 mine release "$v" && fail "a bundle omarchy-agent refuses is co-signed"
grep -q -- '-Y sign' "$KEYGEN_LOG" && fail "signed what the agent refused"
ls "$tmp/draft/"*.sshsig >/dev/null 2>&1 && fail "uploaded what the agent refused"
# Another key than the one pinned for Alice, a login with no key, a signature without a touch.
cp "$fx/carol.pub" "$tmp/keys/id_ed25519_sk.pub"
mine release "$v" && fail "a key MAINTAINERS.toml does not pin for alice"
grep -qF "is the one MAINTAINERS.toml pins for alice" "$tmp/out" || fail "$(cat "$tmp/out")"
cp "$fx/alice.pub" "$tmp/keys/id_ed25519_sk.pub"
GH_USER=carol mine release "$v" && fail "carol has no key"
grep -qF "carol has no key in factory/MAINTAINERS.toml" "$tmp/out" || fail "$(cat "$tmp/out")"
draft
SIGN_AS="$fx/bundle.untouched.sshsig" mine release "$v" && fail "a signature made without a touch is uploaded"
ls "$tmp/draft/"*.sshsig >/dev/null 2>&1 && fail "uploaded a signature made without a touch"
echo "ok: co-sign release checks release.yml's signature, shows the manifest, signs with the pinned key and a touch, and uploads to the draft"

# co-sign rollback against a stand-in pool: the relay, and the maintainer's PUT.
cat > "$tmp/pool.py" <<'POOL'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
statement = open(sys.argv[1]).read()
out = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path != "/api/v1/factory/rollback/v1.0.1":
            self.send_response(404); self.end_headers(); return
        body = json.dumps({"to": "v1.0.1", "statement": statement, "bundle": "{}", "cosignatures": {}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
    def do_PUT(self):
        n = int(self.headers.get("content-length", 0))
        open(out, "w").write(json.dumps({"path": self.path, "auth": self.headers.get("authorization"), "body": self.rfile.read(n).decode()}))
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(b'{"to":"v1.0.1","login":"alice"}')
s = HTTPServer(("127.0.0.1", 0), H)
open(out + ".port", "w").write(str(s.server_port))
s.serve_forever()
POOL
python3 "$tmp/pool.py" "$fx/statement.json" "$tmp/put.json" & pool=$!
trap 'kill "$pool" 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 1 50); do [[ -s "$tmp/put.json.port" ]] && break; sleep 0.1; done
OMARCHY_API="http://127.0.0.1:$(cat "$tmp/put.json.port")"
export OMARCHY_API
SIGN_NAMESPACE="$R" SIGN_AS="$fx/statement.json.alice.sshsig" mine rollback v1.0.1 && fail "no token, no co-signature handed in"
grep -qF "OMARCHY_TOKEN is not set" "$tmp/out" || fail "$(cat "$tmp/out")"
OMARCHY_TOKEN=omc_alice SIGN_NAMESPACE="$R" SIGN_AS="$fx/statement.json.alice.sshsig" mine rollback v1.0.1 || fail "co-sign rollback: $(cat "$tmp/out")"
python3 - "$tmp/put.json" "$fx/statement.json.alice.sshsig" <<'PY' || fail "the pool got Alice's co-signature with her token: $(cat "$tmp/put.json")"
import json, sys
put = json.load(open(sys.argv[1]))
assert put["path"] == "/api/v1/factory/rollback/v1.0.1/cosignature", put
assert put["auth"] == "Bearer omc_alice", put
assert put["body"] == open(sys.argv[2]).read(), put
PY
grep -qF "omarchy-agent verify --statement" "$KEYGEN_LOG" || fail "rollback.yml's signature is checked first"
grep -qF "rollback statement 9: back to v1.0.1, retracting everything through v1.2.0" "$tmp/out" || fail "the statement is shown: $(cat "$tmp/out")"
OMARCHY_TOKEN=omc_alice mine rollback v1.0.2 && fail "a release the pool relays no statement for"
echo "ok: co-sign rollback checks rollback.yml's signature, shows the statement, signs it in its own namespace and hands it to the pool with the maintainer's token"
echo "COSIGNATURE OK"
