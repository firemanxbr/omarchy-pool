//! OpenSSH signatures (`ssh-keygen -Y sign`, OpenSSH's `PROTOCOL.sshsig`) by FIDO security
//! keys (`PROTOCOL.u2f`): the format of the maintainers' co-signature (#330, design v2 D1 b).
//!
//! Verified here with the crypto the agent already carries (aws-lc-rs's Ed25519 and P-256,
//! sha2), so the co-signature adds no dependency (`tests/agent-deps.sh`). Two FIDO key types
//! are read, `sk-ssh-ed25519@openssh.com` and `sk-ecdsa-sha2-nistp256@openssh.com` (security
//! keys that predate Ed25519 support only the second), and a signature counts only with the
//! authenticator's user-presence flag: a touch, as `ssh-keygen -Y verify` requires by
//! default. A plain `ssh-ed25519` key is read too, only so a signature OpenSSH itself made
//! checks this framing (`tests/fixtures/cosignature/`); [`super::cosignature`] pins FIDO
//! keys only, since a key in a file is not offline. The webauthn signature variant, other
//! key types, a namespace other than the one asked for, and trailing bytes are refused.

use std::fmt;

use aws_lc_rs::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED, ED25519};
use base64::Engine as _;
use sha2::{Digest as _, Sha256, Sha512};

pub(crate) const ED25519_SK: &str = "sk-ssh-ed25519@openssh.com";
pub(crate) const ECDSA_SK: &str = "sk-ecdsa-sha2-nistp256@openssh.com";
const ED25519_PLAIN: &str = "ssh-ed25519";

const MAGIC: &[u8] = b"SSHSIG";
const BEGIN: &str = "-----BEGIN SSH SIGNATURE-----";
const END: &str = "-----END SSH SIGNATURE-----";
/// The authenticator's user-presence flag (a touch).
const USER_PRESENT: u8 = 0x01;
/// An armored signature is a few hundred bytes; nothing near this is one.
pub(crate) const MAX_ARMORED: usize = 8 << 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Ed25519,
    Ed25519Sk,
    EcdsaSk,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Ed25519 => ED25519_PLAIN,
            Kind::Ed25519Sk => ED25519_SK,
            Kind::EcdsaSk => ECDSA_SK,
        }
    }
}

/// An OpenSSH public key, as `authorized_keys` and `allowed_signers` write one.
#[derive(Clone, PartialEq, Eq)]
pub struct PublicKey {
    kind: Kind,
    /// The key's wire blob: what an `SSHSIG` names its signer by.
    blob: Vec<u8>,
    /// The Ed25519 key (32 bytes) or the uncompressed P-256 point (65 bytes).
    point: Vec<u8>,
    /// A FIDO key's application (`ssh:` unless the key was made with another).
    application: Vec<u8>,
}

impl fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.kind.name(), self.fingerprint())
    }
}

impl PublicKey {
    /// `<type> <base64> [comment]`; the type before the blob must be the blob's own.
    pub fn parse(line: &str) -> Result<Self, String> {
        let mut parts = line.split_whitespace();
        let (Some(named), Some(b64)) = (parts.next(), parts.next()) else {
            return Err("a public key is `<type> <base64> [comment]`".into());
        };
        let blob = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| "the key's blob is not base64".to_owned())?;
        let key = Self::from_blob(&blob)?;
        if key.kind.name() != named {
            return Err(format!(
                "the key says {named} but its blob is {}",
                key.kind.name()
            ));
        }
        Ok(key)
    }

    fn from_blob(blob: &[u8]) -> Result<Self, String> {
        let mut r = Reader::new(blob);
        let kind = match r.string()? {
            b if b == ED25519_PLAIN.as_bytes() => Kind::Ed25519,
            b if b == ED25519_SK.as_bytes() => Kind::Ed25519Sk,
            b if b == ECDSA_SK.as_bytes() => Kind::EcdsaSk,
            other => {
                return Err(format!(
                    "key type {:?} is neither {ED25519_SK} nor {ECDSA_SK}",
                    String::from_utf8_lossy(other)
                ))
            }
        };
        if kind == Kind::EcdsaSk && r.string()? != b"nistp256" {
            return Err("an ecdsa-sk key's curve is not nistp256".into());
        }
        let point = r.string()?.to_vec();
        let ok = match kind {
            Kind::Ed25519 | Kind::Ed25519Sk => point.len() == 32,
            Kind::EcdsaSk => point.len() == 65 && point[0] == 4,
        };
        if !ok {
            return Err(format!("a {} key of the wrong size", kind.name()));
        }
        let application = match kind {
            Kind::Ed25519 => Vec::new(),
            Kind::Ed25519Sk | Kind::EcdsaSk => r.string()?.to_vec(),
        };
        r.end()?;
        Ok(PublicKey {
            kind,
            blob: blob.to_vec(),
            point,
            application,
        })
    }

    /// Made on a FIDO security key: the private half never leaves it.
    pub fn is_fido(&self) -> bool {
        self.kind != Kind::Ed25519
    }

    pub fn kind(&self) -> &'static str {
        self.kind.name()
    }

    /// `SHA256:<base64>`, as `ssh-keygen -l` prints it.
    pub fn fingerprint(&self) -> String {
        format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(&self.blob))
        )
    }
}

/// Checks that `armored` (`ssh-keygen -Y sign`'s output) is `key`'s signature over `message`
/// in `namespace`, made with a touch when the key is a FIDO key.
pub fn verify(
    key: &PublicKey,
    namespace: &str,
    message: &[u8],
    armored: &[u8],
) -> Result<(), String> {
    let blob = dearmor(armored)?;
    let mut r = Reader::new(&blob);
    if r.take(MAGIC.len())? != MAGIC {
        return Err("not an SSH signature (no SSHSIG magic)".into());
    }
    if r.u32()? != 1 {
        return Err("SSH signature version is not 1".into());
    }
    let signer = r.string()?;
    let signed_namespace = r.string()?;
    let reserved = r.string()?;
    let hash = r.string()?;
    let signature = r.string()?;
    r.end()?;
    if signer != key.blob.as_slice() {
        return Err("signed by another key".into());
    }
    if signed_namespace != namespace.as_bytes() {
        return Err(format!(
            "signed for namespace {:?}, not {namespace:?}",
            String::from_utf8_lossy(signed_namespace)
        ));
    }
    let digest = match hash {
        b"sha512" => Sha512::digest(message).to_vec(),
        b"sha256" => Sha256::digest(message).to_vec(),
        other => {
            return Err(format!(
                "hash {:?} is neither sha512 nor sha256",
                String::from_utf8_lossy(other)
            ))
        }
    };
    // What OpenSSH signs (PROTOCOL.sshsig): the magic, then the namespace, the reserved
    // field, the hash's name and the message's hash, each as an SSH string.
    let mut signed = MAGIC.to_vec();
    for part in [namespace.as_bytes(), reserved, hash, &digest] {
        put_string(&mut signed, part);
    }
    check_signature(key, &signed, signature)
}

/// The signature blob: its type must be the key's; a FIDO signature carries the
/// authenticator's flags and counter, and the authenticator signed the SHA-256 of the
/// application, the flags, the counter and the SHA-256 of what OpenSSH signs
/// (`PROTOCOL.u2f`).
fn check_signature(key: &PublicKey, signed: &[u8], blob: &[u8]) -> Result<(), String> {
    let mut r = Reader::new(blob);
    if r.string()? != key.kind.name().as_bytes() {
        return Err(format!(
            "the signature is not a {} signature",
            key.kind.name()
        ));
    }
    let raw = r.string()?;
    if key.kind == Kind::Ed25519 {
        r.end()?;
        return UnparsedPublicKey::new(&ED25519, &key.point)
            .verify(signed, raw)
            .map_err(|_| "the signature does not verify".into());
    }
    let flags = r.u8()?;
    let counter = r.u32()?;
    r.end()?;
    if flags & USER_PRESENT == 0 {
        return Err("made without a touch (the security key's user-presence flag is off)".into());
    }
    let mut data = Sha256::digest(&key.application).to_vec();
    data.push(flags);
    data.extend_from_slice(&counter.to_be_bytes());
    data.extend_from_slice(&Sha256::digest(signed));
    let ok = match key.kind {
        Kind::Ed25519Sk => UnparsedPublicKey::new(&ED25519, &key.point)
            .verify(&data, raw)
            .is_ok(),
        Kind::EcdsaSk => {
            let fixed = ecdsa_fixed(raw)?;
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &key.point)
                .verify(&data, &fixed)
                .is_ok()
        }
        Kind::Ed25519 => unreachable!("handled above"),
    };
    if ok {
        Ok(())
    } else {
        Err("the signature does not verify".into())
    }
}

/// An SSH ECDSA signature (`mpint r`, `mpint s`) as the fixed 64 bytes `r || s`.
fn ecdsa_fixed(raw: &[u8]) -> Result<[u8; 64], String> {
    let mut r = Reader::new(raw);
    let mut out = [0u8; 64];
    for half in out.chunks_mut(32) {
        let mpint = r.string()?;
        if mpint.first().is_some_and(|b| b & 0x80 != 0) {
            return Err("a negative ECDSA signature value".into());
        }
        let digits = &mpint[mpint.iter().take_while(|b| **b == 0).count()..];
        if digits.len() > 32 {
            return Err("an ECDSA signature value wider than P-256's".into());
        }
        half[32 - digits.len()..].copy_from_slice(digits);
    }
    r.end()?;
    Ok(out)
}

fn dearmor(armored: &[u8]) -> Result<Vec<u8>, String> {
    if armored.len() > MAX_ARMORED {
        return Err("an SSH signature is never this large".into());
    }
    let text = std::str::from_utf8(armored).map_err(|_| "not an armored SSH signature")?;
    let inner = text
        .trim()
        .strip_prefix(BEGIN)
        .and_then(|t| t.strip_suffix(END))
        .ok_or_else(|| format!("not an armored SSH signature ({BEGIN} ... {END})"))?;
    let b64: String = inner.split_whitespace().collect();
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "the armored SSH signature is not base64".into())
}

pub(crate) fn put_string(out: &mut Vec<u8>, s: &[u8]) {
    let len = u32::try_from(s.len()).expect("no SSH string here is 4 GiB");
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(s);
}

/// The SSH wire format's reader: bytes, `uint32` and length-prefixed strings.
struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8]) -> Self {
        Reader { rest: b }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.rest.len() < n {
            return Err("truncated".into());
        }
        let (head, tail) = self.rest.split_at(n);
        self.rest = tail;
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn string(&mut self) -> Result<&'a [u8], String> {
        let n = usize::try_from(self.u32()?).map_err(|_| "a string too long".to_owned())?;
        self.take(n)
    }

    fn end(&self) -> Result<(), String> {
        if self.rest.is_empty() {
            Ok(())
        } else {
            Err("trailing bytes".into())
        }
    }
}
