//! The part of `WebAuthn` the host checks itself (#328, design v2 D6 b): an assertion the
//! owner's passkey made in the browser, verified against the public key pinned at this
//! host — never against anything the pool says. The pool's own checks (worker/src/
//! webauthn.ts) are the same rules; the host does not take the pool's word for them.
//!
//! - The COSE public key (RFC 9053) as the authenticator wrote it at registration: ES256
//!   (EC2 on P-256), `EdDSA` (OKP on Ed25519) or RS256 (RSA, 2048 bits at least), read with
//!   a CBOR reader of exactly what such a key holds — one map of integer labels to
//!   integers and byte strings, definite lengths, nothing after it.
//! - clientDataJSON: `webauthn.get`, the challenge the signed document commits to, the
//!   origin pinned with the key, and not made in a frame of another site.
//! - authenticatorData: the pinned RP id's hash, the user present (UP) and verified (UV):
//!   a touch and a PIN or a biometric, which neither the pool nor any software of the
//!   host can supply; no attested credential (that is a registration's).
//! - The signature over authenticatorData ‖ SHA-256(clientDataJSON), with aws-lc-rs (the
//!   crypto the agent has already, tests/agent-deps.sh): DER ECDSA, Ed25519, PKCS#1 v1.5.
//!
//! Every refusal says which check failed, in words the journal and the host page show.

use aws_lc_rs::signature::{
    RsaPublicKeyComponents, UnparsedPublicKey, ECDSA_P256_SHA256_ASN1, ED25519,
    RSA_PKCS1_2048_8192_SHA256,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// COSE's algorithm numbers (RFC 9053) the pool registers passkeys with.
pub const ES256: i64 = -7;
pub const EDDSA: i64 = -8;
pub const RS256: i64 = -257;

/// authenticatorData's flags (`WebAuthn` §6.1).
const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_AT: u8 = 0x40;

/// The longest field of an assertion the agent reads (base64url characters): the pool's
/// own bounds.
const MAX_CREDENTIAL: usize = 1400;
const MAX_CLIENT_DATA: usize = 4096;
const MAX_AUTH_DATA: usize = 2048;
const MAX_SIGNATURE: usize = 1024;
/// A COSE key of an RSA modulus of 8192 bits is about 1.1 KB; nothing a passkey holds is
/// larger.
const MAX_COSE: usize = 2048;

/// An assertion as the browser answers `navigator.credentials.get()`, in the fields the
/// pool's pages post (worker/src/routes/passkeys.ts `AssertionFields`): each base64url.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Assertion {
    /// Which credential answered (`rawId`).
    pub credential: String,
    pub client_data: String,
    pub authenticator_data: String,
    pub signature: String,
    /// The user handle the authenticator returned, if it did: not checked here (the pin
    /// names the credential itself).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_handle: Option<String>,
}

/// A passkey's public key, from its COSE form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// The uncompressed P-256 point: `04 ‖ x ‖ y`.
    Es256(Vec<u8>),
    Ed25519([u8; 32]),
    Rs256 {
        n: Vec<u8>,
        e: Vec<u8>,
    },
}

/// What an assertion must match: the challenge (base64url of the signed document's
/// SHA-256), and the relying party the key was pinned for.
#[derive(Debug, Clone, Copy)]
pub struct Expected<'a> {
    pub challenge: &'a str,
    pub origin: &'a str,
    pub rp_id: &'a str,
}

pub(crate) fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// base64url without padding, as `WebAuthn` and the pool write it; `what` names the field.
pub(crate) fn unb64(s: &str, what: &str, max: usize) -> Result<Vec<u8>, String> {
    if s.is_empty() || s.len() > max {
        return Err(format!("{what} is missing or too long"));
    }
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|_| format!("{what} is not base64url"))
}

/// base64url of the SHA-256 of `bytes`: the challenge a signed document commits to.
pub fn challenge_of(bytes: &[u8]) -> String {
    b64(&Sha256::digest(bytes))
}

impl Key {
    /// The key a COSE key (its bytes as the authenticator wrote them) holds, for one of the
    /// three algorithms the pool takes; anything else is refused.
    pub fn from_cose(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_COSE {
            return Err("the passkey's public key is too long".into());
        }
        let map = cose_map(bytes)?;
        let int = |label: i64| {
            map.iter().find_map(|(k, v)| match v {
                Item::Int(i) if *k == label => Some(*i),
                _ => None,
            })
        };
        let bytes_of = |label: i64| {
            map.iter().find_map(|(k, v)| match v {
                Item::Bytes(b) if *k == label => Some(b.as_slice()),
                _ => None,
            })
        };
        let (kty, alg) = (int(1), int(3));
        match alg {
            Some(ES256) => {
                let (Some(2), Some(1)) = (kty, int(-1)) else {
                    return Err("an ES256 key is an EC2 key on P-256".into());
                };
                let (Some(x), Some(y)) = (bytes_of(-2), bytes_of(-3)) else {
                    return Err("the ES256 key's x or y is missing".into());
                };
                if x.len() != 32 || y.len() != 32 {
                    return Err("the ES256 key's x or y is not 32 bytes".into());
                }
                let mut point = Vec::with_capacity(65);
                point.push(0x04);
                point.extend_from_slice(x);
                point.extend_from_slice(y);
                Ok(Key::Es256(point))
            }
            Some(EDDSA) => {
                let (Some(1), Some(6)) = (kty, int(-1)) else {
                    return Err("an EdDSA key is an OKP key on Ed25519".into());
                };
                let x = bytes_of(-2)
                    .and_then(|x| <[u8; 32]>::try_from(x).ok())
                    .ok_or("the EdDSA key's x is missing or not 32 bytes")?;
                Ok(Key::Ed25519(x))
            }
            Some(RS256) => {
                if kty != Some(3) {
                    return Err("an RS256 key is an RSA key".into());
                }
                let (Some(n), Some(e)) = (bytes_of(-1), bytes_of(-2)) else {
                    return Err("the RS256 key's modulus or exponent is missing".into());
                };
                let strip = |b: &[u8]| {
                    let lead = b.iter().take_while(|x| **x == 0).count();
                    b[lead.min(b.len().saturating_sub(1))..].to_vec()
                };
                let (n, e) = (strip(n), strip(e));
                if n.len() < 256 {
                    return Err(format!(
                        "an RS256 key of {} bits: 2048 or more is taken",
                        n.len() * 8
                    ));
                }
                Ok(Key::Rs256 { n, e })
            }
            other => Err(format!(
                "the passkey's algorithm ({}) is none the pool takes: ES256, EdDSA or RS256",
                other.map_or_else(|| "none".to_owned(), |a| a.to_string())
            )),
        }
    }

    /// Its COSE algorithm number.
    pub fn alg(&self) -> i64 {
        match self {
            Key::Es256(_) => ES256,
            Key::Ed25519(_) => EDDSA,
            Key::Rs256 { .. } => RS256,
        }
    }

    /// Its algorithm's name, as the pool says it.
    pub fn alg_name(&self) -> &'static str {
        alg_name(self.alg())
    }

    /// Whether `sig` is this key's signature over `msg`, in `WebAuthn`'s shape: DER for ES256,
    /// as it comes for `EdDSA` and RS256.
    fn verifies(&self, msg: &[u8], sig: &[u8]) -> bool {
        match self {
            Key::Es256(point) => UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, point)
                .verify(msg, sig)
                .is_ok(),
            Key::Ed25519(x) => UnparsedPublicKey::new(&ED25519, x).verify(msg, sig).is_ok(),
            Key::Rs256 { n, e } => RsaPublicKeyComponents { n, e }
                .verify(&RSA_PKCS1_2048_8192_SHA256, msg, sig)
                .is_ok(),
        }
    }
}

/// An algorithm number's name: ES256, `EdDSA`, RS256.
pub fn alg_name(alg: i64) -> &'static str {
    match alg {
        ES256 => "ES256",
        EDDSA => "EdDSA",
        RS256 => "RS256",
        _ => "?",
    }
}

/// What a COSE key's map holds: integers and byte strings (a text string, which a COSE
/// key may carry as a `kid`, is kept as text and never read).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Item {
    Int(i64),
    Bytes(Vec<u8>),
    Text,
}

/// The one CBOR map a COSE key is: at most 16 entries, each label an integer, each value an
/// integer, a byte string or a text string; definite lengths only, a label seen twice, a
/// nested item, a tag, a float or a byte after the map refused.
fn cose_map(b: &[u8]) -> Result<Vec<(i64, Item)>, String> {
    let bad = |why: &str| format!("the passkey's public key is not a COSE key: {why}");
    let mut at = 0usize;
    let (major, n) = head(b, &mut at).ok_or_else(|| bad("it ends early"))?;
    if major != 5 || n > 16 {
        return Err(bad("not a map of at most 16 entries"));
    }
    let mut out: Vec<(i64, Item)> = Vec::new();
    for _ in 0..n {
        let label = match head(b, &mut at).ok_or_else(|| bad("it ends early"))? {
            (0, v) => i64::try_from(v).map_err(|_| bad("a label too large"))?,
            (1, v) => -1 - i64::try_from(v).map_err(|_| bad("a label too large"))?,
            _ => return Err(bad("a label that is not an integer")),
        };
        if out.iter().any(|(l, _)| *l == label) {
            return Err(bad("a label given twice"));
        }
        let item = match head(b, &mut at).ok_or_else(|| bad("it ends early"))? {
            (0, v) => Item::Int(i64::try_from(v).map_err(|_| bad("an integer too large"))?),
            (1, v) => Item::Int(-1 - i64::try_from(v).map_err(|_| bad("an integer too large"))?),
            (major @ (2 | 3), len) => {
                let len = usize::try_from(len).map_err(|_| bad("a string too long"))?;
                let end = at.checked_add(len).filter(|e| *e <= b.len());
                let end = end.ok_or_else(|| bad("a string runs past the end"))?;
                let v = b[at..end].to_vec();
                at = end;
                if major == 2 {
                    Item::Bytes(v)
                } else {
                    Item::Text
                }
            }
            _ => return Err(bad("a value that is neither an integer nor a string")),
        };
        out.push((label, item));
    }
    if at != b.len() {
        return Err(bad("bytes after the map"));
    }
    Ok(out)
}

/// One CBOR head at `at`: its major type and its argument; `None` when it runs past the end
/// or is an indefinite length, a reserved value or a tag/float's (majors 6 and 7 are
/// returned and refused by the caller).
fn head(b: &[u8], at: &mut usize) -> Option<(u8, u64)> {
    let first = *b.get(*at)?;
    *at += 1;
    let (major, info) = (first >> 5, first & 0x1f);
    let n = match info {
        0..=23 => u64::from(info),
        24..=27 => {
            let len = 1usize << (info - 24);
            let end = at.checked_add(len)?;
            let bytes = b.get(*at..end)?;
            *at = end;
            bytes.iter().fold(0u64, |v, x| (v << 8) | u64::from(*x))
        }
        _ => return None,
    };
    Some((major, n))
}

/// An assertion checked against `key` (the one pinned for the credential that answered)
/// and `e`: clientDataJSON's type, challenge, origin and frame; authenticatorData's RP id,
/// user presence and verification; the signature. The authenticator's signature counter
/// on success (0 when it keeps none, as synced passkeys do).
pub fn verify(key: &Key, a: &Assertion, e: &Expected<'_>) -> Result<u32, String> {
    unb64(&a.credential, "the credential's id", MAX_CREDENTIAL)?;
    let cd = unb64(&a.client_data, "clientDataJSON", MAX_CLIENT_DATA)?;
    client_data(&cd, e)?;
    let raw = unb64(&a.authenticator_data, "authenticatorData", MAX_AUTH_DATA)?;
    if raw.len() < 37 {
        return Err("authenticatorData is shorter than 37 bytes".into());
    }
    if raw[..32] != Sha256::digest(e.rp_id.as_bytes())[..] {
        return Err(format!(
            "the passkey signed for another relying party, not {}",
            e.rp_id
        ));
    }
    let flags = raw[32];
    if flags & FLAG_UP == 0 {
        return Err("the authenticator says nobody was present (no UP flag)".into());
    }
    if flags & FLAG_UV == 0 {
        return Err(
            "the authenticator did not verify the user (no UV flag: no PIN, no biometric)".into(),
        );
    }
    if flags & FLAG_AT != 0 {
        return Err(
            "authenticatorData carries a new credential: that is a registration, not an assertion"
                .into(),
        );
    }
    let signature = unb64(&a.signature, "the signature", MAX_SIGNATURE)?;
    let mut signed = raw.clone();
    signed.extend_from_slice(&Sha256::digest(&cd));
    if !key.verifies(&signed, &signature) {
        return Err("the signature is not the pinned passkey's".into());
    }
    Ok(u32::from_be_bytes([raw[33], raw[34], raw[35], raw[36]]))
}

/// clientDataJSON (`WebAuthn` §5.8.1): an assertion's, for this challenge, made on the pinned
/// origin and not in a frame of another site.
fn client_data(bytes: &[u8], e: &Expected<'_>) -> Result<(), String> {
    let c: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "clientDataJSON is not JSON".to_owned())?;
    if !c.is_object() {
        return Err("clientDataJSON is not an object".into());
    }
    if c["type"] != "webauthn.get" {
        return Err(format!(
            "clientDataJSON says {}, not webauthn.get",
            short(&c["type"].to_string())
        ));
    }
    if c["challenge"].as_str() != Some(e.challenge) {
        return Err("the passkey's answer is not for this document (its challenge)".into());
    }
    if c["origin"].as_str() != Some(e.origin) {
        return Err(format!(
            "the passkey's answer was made on {}, not {}",
            short(&c["origin"].to_string()),
            e.origin
        ));
    }
    if c["crossOrigin"] == true {
        return Err("the passkey's answer was made in a frame of another site".into());
    }
    Ok(())
}

/// A value from the network as the journal says it: no control character, at most 80.
fn short(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(80).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A COSE key in CBOR, written here as an authenticator writes one.
    pub(crate) fn cose(entries: &[(i64, Result<i64, &[u8]>)]) -> Vec<u8> {
        fn head(major: u8, n: u64) -> Vec<u8> {
            let m = major << 5;
            if n < 24 {
                vec![m | u8::try_from(n).unwrap()]
            } else if n < 256 {
                vec![m | 0x18, u8::try_from(n).unwrap()]
            } else {
                let mut v = vec![m | 0x19];
                v.extend_from_slice(&u16::try_from(n).unwrap().to_be_bytes());
                v
            }
        }
        let int = |i: i64| {
            if i >= 0 {
                head(0, i.unsigned_abs())
            } else {
                head(1, (-1 - i).unsigned_abs())
            }
        };
        let mut out = head(5, entries.len() as u64);
        for (k, v) in entries {
            out.extend(int(*k));
            match v {
                Ok(i) => out.extend(int(*i)),
                Err(b) => {
                    out.extend(head(2, b.len() as u64));
                    out.extend_from_slice(b);
                }
            }
        }
        out
    }

    #[test]
    fn a_cose_key_of_each_algorithm_reads_and_anything_else_is_refused() {
        let xs = [7u8; 32];
        let ys = [9u8; 32];
        let es = cose(&[
            (1, Ok(2)),
            (3, Ok(ES256)),
            (-1, Ok(1)),
            (-2, Err(&xs)),
            (-3, Err(&ys)),
        ]);
        let Key::Es256(point) = Key::from_cose(&es).unwrap() else {
            panic!("ES256")
        };
        assert_eq!((point.len(), point[0], point[1], point[33]), (65, 4, 7, 9));
        let ed = cose(&[(1, Ok(1)), (3, Ok(EDDSA)), (-1, Ok(6)), (-2, Err(&xs))]);
        assert_eq!(Key::from_cose(&ed).unwrap(), Key::Ed25519(xs));
        let modulus = [0xc5u8; 256];
        let rs = cose(&[
            (1, Ok(3)),
            (3, Ok(RS256)),
            (-1, Err(&modulus)),
            (-2, Err(&[1, 0, 1])),
        ]);
        assert_eq!(Key::from_cose(&rs).unwrap().alg_name(), "RS256");
        for (bytes, why) in [
            (
                cose(&[
                    (1, Ok(3)),
                    (3, Ok(RS256)),
                    (-1, Err(&[0xc5; 128])),
                    (-2, Err(&[3])),
                ]),
                "1024 bits",
            ),
            (cose(&[(1, Ok(2)), (3, Ok(-35))]), "algorithm (-35)"),
            (cose(&[(1, Ok(2)), (3, Ok(ES256)), (-1, Ok(2))]), "P-256"),
            (
                cose(&[(1, Ok(1)), (3, Ok(EDDSA)), (-1, Ok(6)), (-2, Err(&[1; 31]))]),
                "32 bytes",
            ),
            (cose(&[(1, Ok(2)), (1, Ok(2))]), "twice"),
            ([cose(&[(1, Ok(1))]), vec![0]].concat(), "bytes after"),
            (vec![0xa1, 0x01], "ends early"),
            (vec![0xbf, 0xff], "ends early"),
            (vec![0x81, 0x01], "not a map"),
            (vec![0xa1, 0x01, 0xa0], "neither an integer"),
            (vec![0xa1, 0x61, 0x61, 0x01], "not an integer"),
            (
                vec![0xa1, 0x01, 0x5a, 0xff, 0xff, 0xff, 0xff],
                "past the end",
            ),
        ] {
            let e = Key::from_cose(&bytes).unwrap_err();
            assert!(e.contains(why), "{why}: {e}");
        }
    }
}
