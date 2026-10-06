#!/usr/bin/env bash
# The recorded TPM answers the agent's and the pool's tests check (#330, the
# hardware-bound host key on Linux): what tpm2-tools and a TPM 2.0 (swtpm,
# libtpms) write for a host key made the way the agent makes it — the key's
# public area (TPM2B_PUBLIC, tpm2_create -u) and its private blob — and its
# signatures (TPMT_SIGNATURE, tpm2_sign -d) of an enrollment's proof and of a
# signed request, with the messages they sign. Beside them, public areas the
# agent refuses as a host key: one the TPM would let leave it (no fixedtpm, no
# fixedparent), the storage key it is made under (restricted, decrypt) and an
# RSA key.
#
# Writes crates/omarchy-agent/tests/fixtures/tpm/: host.tpm.pub, host.tpm.priv,
# exportable.pub, storage.pub, rsa.pub, enroll.sig, request.sig and
# cases.json — the key as the pool keeps it (the uncompressed P-256 point,
# base64url), its fingerprint, and each message with its signature as the
# agent sends it (r and s, 64 bytes, base64url). The agent's unit tests
# (host::tpm) and worker/test/host-key.test.ts read the files, never run this:
# run it again only when the scheme changes, and commit what it wrote.
#
# Requires: swtpm, tpm2-tools (5.x), python3. Usage: bash tests/tpm-fixtures.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/crates/omarchy-agent/tests/fixtures/tpm"
WORK="$(mktemp -d)"
PORT="${OMARCHY_TPM_FIXTURES_PORT:-23310}"
cleanup() {
  if [[ -f "$WORK/swtpm.pid" ]]; then kill "$(cat "$WORK/swtpm.pid")" 2>/dev/null || true; fi
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

mkdir -p "$WORK/state" "$OUT"
swtpm socket --tpm2 --tpmstate dir="$WORK/state" --flags not-need-init,startup-clear \
  --server type=tcp,port="$PORT",bindaddr=127.0.0.1 --ctrl type=tcp,port=$((PORT + 1)),bindaddr=127.0.0.1 \
  --daemon --pid file="$WORK/swtpm.pid"
export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=$PORT"
for _ in $(seq 1 50); do tpm2_getcap properties-fixed >/dev/null 2>&1 && break; sleep 0.1; done
cd "$WORK"
# No resource manager in front of the simulator: every tool's objects stay loaded, so
# each step flushes them (the agent reaches a TPM through one, and flushes nothing).
flush() { tpm2_flushcontext -t; }

# The agent's own arguments (crates/omarchy-agent/src/host/tpm.rs).
primary() { tpm2_createprimary -Q -C o -g sha256 -G ecc256:aes128cfb -a 'restricted|decrypt|fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda' -c primary.ctx; flush; }
primary
tpm2_create -Q -C primary.ctx -g sha256 -G ecc256:ecdsa-sha256 -a 'fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda|sign' -u host.tpm.pub -r host.tpm.priv
flush
tpm2_create -Q -C primary.ctx -g sha256 -G ecc256:ecdsa-sha256 -a 'sensitivedataorigin|userwithauth|noda|sign' -u exportable.pub -r exportable.priv
flush
tpm2_create -Q -C primary.ctx -g sha256 -G rsa2048:rsassa-sha256 -a 'fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda|sign' -u rsa.pub -r rsa.priv
flush
tpm2_readpublic -Q -c primary.ctx -o storage.pub
flush

# The messages the agent signs (host.rs enroll_message, signed_message) and their SHA-256.
python3 - "$WORK" <<'PY'
import base64, hashlib, json, struct, sys
work = sys.argv[1]
pub = open(f"{work}/host.tpm.pub", "rb").read()
# TPM2B_PUBLIC of an ECC key with no policy and a NULL symmetric: x and y close it.
y_len = struct.unpack(">H", pub[-34:-32])[0]
x_len = struct.unpack(">H", pub[-68:-66])[0]
assert (x_len, y_len) == (32, 32), (x_len, y_len)
point = b"\x04" + pub[-66:-34] + pub[-32:]
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
pubkey = b64u(point)
fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(point).digest()).rstrip(b"=").decode()
token = "ome_" + "ab" * 24
enroll = f"omarchy-host-enroll-v1\n{token}\n{pubkey}"
body = '{"agent":{"version":"0.4.0"}}'
request = {"host": "h_0123456789", "method": "POST", "path": "/api/v1/hosts/self/report", "body": body,
           "ts": 1800000000, "nonce": "00112233445566778899aabbccddeeff"}
message = "omarchy-host-v1\n{host}\n{method}\n{path}\n{sha}\n{ts}\n{nonce}".format(sha=hashlib.sha256(body.encode()).hexdigest(), **request)
open(f"{work}/enroll.digest", "wb").write(hashlib.sha256(enroll.encode()).digest())
open(f"{work}/request.digest", "wb").write(hashlib.sha256(message.encode()).digest())
json.dump({"pubkey": pubkey, "fingerprint": fingerprint, "enroll": {"token": token, "message": enroll},
           "request": {**request, "message": message}}, open(f"{work}/cases.json", "w"))
PY

for m in enroll request; do
  primary
  tpm2_load -Q -C primary.ctx -u host.tpm.pub -r host.tpm.priv -c key.ctx
  flush
  tpm2_sign -Q -c key.ctx -g sha256 -s ecdsa -d -o "$m.sig" "$m.digest"
  flush
done

python3 - "$WORK" "$OUT" <<'PY'
import base64, json, struct, sys
work, out = sys.argv[1], sys.argv[2]
cases = json.load(open(f"{work}/cases.json"))
def p1363(path):
    # TPMT_SIGNATURE: ECDSA (0x0018), SHA-256 (0x000b), then r and s as TPM2B.
    b = open(path, "rb").read()
    alg, hash_alg, r_len = struct.unpack(">HHH", b[:6])
    assert (alg, hash_alg) == (0x0018, 0x000B), (alg, hash_alg)
    r = b[6:6 + r_len]
    (s_len,) = struct.unpack(">H", b[6 + r_len:8 + r_len])
    s = b[8 + r_len:8 + r_len + s_len]
    return base64.urlsafe_b64encode(r.rjust(32, b"\0") + s.rjust(32, b"\0")).rstrip(b"=").decode()
cases["enroll"]["sig"] = p1363(f"{work}/enroll.sig")
cases["request"]["sig"] = p1363(f"{work}/request.sig")
with open(f"{out}/cases.json", "w") as f:
    json.dump(cases, f, indent=2)
    f.write("\n")
PY
for f in host.tpm.pub host.tpm.priv exportable.pub storage.pub rsa.pub enroll.sig request.sig; do
  cp "$WORK/$f" "$OUT/$f"
done
echo "tpm-fixtures: wrote $OUT"
