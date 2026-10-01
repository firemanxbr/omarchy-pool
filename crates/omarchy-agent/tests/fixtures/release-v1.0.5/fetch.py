#!/usr/bin/env python3
"""Rebuild this fixture from public reads only: no signing, no release, no token.

release.yml signed the worker image of v1.0.5 keyless on main (run 36757291845,
`cosign sign` in the worker-image-manifest job). cosign stored that signature in
ghcr.io as a `sha256-<digest>.sig` manifest: the signed payload is a layer, the
Fulcio certificate and the Rekor entry are annotations. Rekor serves the entry's
inclusion proof. This script puts those pieces into a Sigstore bundle v0.3, the
format `cosign sign-blob --bundle` writes for the host bundle (#311), so `verify`
is checked against a real signing by release.yml@refs/heads/main.

    python3 fetch.py            # writes artifact and bundle.sigstore.json here
"""
import base64
import hashlib
import json
import os
import urllib.request

REPO = "firemanxbr/omarchy-worker"
TAG = "v1.0.5"
HERE = os.path.dirname(os.path.abspath(__file__))
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), r.headers


def main():
    token = json.loads(get(f"https://ghcr.io/token?scope=repository:{REPO}:pull")[0])["token"]
    auth = {"Authorization": f"Bearer {token}", "Accept": ACCEPT}
    _, headers = get(f"https://ghcr.io/v2/{REPO}/manifests/{TAG}", auth)
    digest = headers["Docker-Content-Digest"]
    sig_tag = "sha256-" + digest.split(":", 1)[1] + ".sig"
    manifest = json.loads(get(f"https://ghcr.io/v2/{REPO}/manifests/{sig_tag}", auth)[0])
    layer = manifest["layers"][0]
    notes = layer["annotations"]
    payload = get(f"https://ghcr.io/v2/{REPO}/blobs/{layer['digest']}", auth)[0]
    assert "sha256:" + hashlib.sha256(payload).hexdigest() == layer["digest"]

    rekor = json.loads(notes["dev.sigstore.cosign/bundle"])
    log_index = rekor["Payload"]["logIndex"]
    entries = json.loads(get(f"https://rekor.sigstore.dev/api/v1/log/entries?logIndex={log_index}")[0])
    (entry,) = entries.values()
    assert entry["body"] == rekor["Payload"]["body"], "Rekor serves another body"
    proof = entry["verification"]["inclusionProof"]

    pem = notes["dev.sigstore.cosign/certificate"]
    der = base64.b64decode("".join(l for l in pem.splitlines() if "-----" not in l))
    b64 = lambda raw: base64.b64encode(raw).decode()
    bundle = {
        "mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json",
        "verificationMaterial": {
            "certificate": {"rawBytes": b64(der)},
            "tlogEntries": [{
                "logIndex": str(log_index),
                "logId": {"keyId": b64(bytes.fromhex(rekor["Payload"]["logID"]))},
                "kindVersion": {"kind": "hashedrekord", "version": "0.0.1"},
                "integratedTime": str(rekor["Payload"]["integratedTime"]),
                "inclusionPromise": {"signedEntryTimestamp": rekor["SignedEntryTimestamp"]},
                "inclusionProof": {
                    "logIndex": str(proof["logIndex"]),
                    "rootHash": b64(bytes.fromhex(proof["rootHash"])),
                    "treeSize": str(proof["treeSize"]),
                    "hashes": [b64(bytes.fromhex(h)) for h in proof["hashes"]],
                    "checkpoint": {"envelope": proof["checkpoint"]},
                },
                "canonicalizedBody": rekor["Payload"]["body"],
            }],
        },
        "messageSignature": {
            "messageDigest": {"algorithm": "SHA2_256", "digest": b64(hashlib.sha256(payload).digest())},
            "signature": notes["dev.cosignproject.cosign/signature"],
        },
    }
    with open(os.path.join(HERE, "artifact"), "wb") as f:
        f.write(payload)
    with open(os.path.join(HERE, "bundle.sigstore.json"), "w") as f:
        json.dump(bundle, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
