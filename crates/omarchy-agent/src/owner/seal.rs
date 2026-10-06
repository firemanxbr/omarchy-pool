//! The host's seal key (#328, design v2 §14): an X25519 key the agent makes once, whose
//! public half it reports (signed with the host key) and whose fingerprint the owner
//! confirms once on the site. From then on the owner's browser seals each agent key to it
//! and the pool relays only ciphertext: the pool never holds a key it could read.
//!
//! The scheme, the browser's side being worker/src/seal.ts (`WebCrypto`) and this file the
//! host's (aws-lc-rs, the agent's crypto already):
//!
//! ```text
//! info   = "omarchy-agent/seal/1\n" ‖ host id ‖ "\n" ‖ the key's name
//! shared = X25519(ephemeral private, host public)          (32 bytes, never all zero)
//! key    = HKDF-SHA256(ikm = shared, salt = epk ‖ host public, info) → 32 bytes
//! ct     = AES-256-GCM(key, nonce (12 random bytes), the value, aad = info)
//! sealed = {name, epk, nonce, ct}, each base64url
//! ```
//!
//! A fresh ephemeral key per value makes every AES key used once; the salt binds the
//! derivation to both public keys and `info` binds the ciphertext to this host and to the
//! key's name, so a value sealed for one name or one host never opens as another. Sealing
//! gives secrecy, not authorship — anyone may seal to a public key — which is why the
//! sealed values reach the host only inside a document the owner's passkey signed
//! ([`super::verify_signed`]).
//!
//! At rest the private half is `state/seal.x25519` (mode 0600, beside the host key), or on
//! a Mac the person's login keychain ([`super::keychain`]); `state/seal.pub` keeps the
//! public half for `omarchy-agent status` either way.

use std::fs;
use std::path::Path;

use aws_lc_rs::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use aws_lc_rs::agreement::{self, PrivateKey, UnparsedPublicKey, X25519};
use aws_lc_rs::encoding::AsBigEndian;
use aws_lc_rs::hkdf;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::keychain::Security;
use super::webauthn::{b64, unb64};

/// The private half's file in the state directory (Linux).
pub const KEY_FILE: &str = "seal.x25519";
/// The public half, base64url on one line.
pub const PUB_FILE: &str = "seal.pub";
/// What every derivation and ciphertext is bound to, before the host and the name.
pub const INFO: &str = "omarchy-agent/seal/1";
/// The longest value a sealed key may hold, in bytes: API keys and OAuth tokens are a few
/// hundred at most.
pub const MAX_VALUE: usize = 1024;
/// AES-GCM's tag.
const TAG: usize = 16;

/// One key as the owner's browser sealed it, or its removal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sealed {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ct: Option<String>,
    /// The key taken out of `agent.env` instead (nothing sealed).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remove: bool,
}

/// The host's seal key.
pub struct SealKey {
    private: PrivateKey,
    public: [u8; 32],
}

impl std::fmt::Debug for SealKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SealKey({})", self.fingerprint())
    }
}

/// The keychain account of the seal key of the agent whose data directory is `data`: one
/// per data directory, as the file is.
pub fn keychain_account(data: &Path) -> String {
    let h = Sha256::digest(data.display().to_string().as_bytes());
    format!("seal-key-{}", hex::encode(&h[..8]))
}

/// `SHA256:` and the unpadded base64 of the key's SHA-256, as the host key's fingerprint
/// is written (and the pool's page shows it).
pub fn fingerprint_of(public: &[u8]) -> String {
    format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(public)))
}

/// The public half as `state/seal.pub` says it, when there is one.
pub fn read_public(state: &Path) -> Option<String> {
    let t = fs::read_to_string(state.join(PUB_FILE)).ok()?;
    let t = t.trim();
    (unb64(t, "", 64).ok()?.len() == 32).then(|| t.to_owned())
}

impl SealKey {
    fn from_private(bytes: &[u8]) -> Result<Self, String> {
        let private = PrivateKey::from_private_key(&X25519, bytes)
            .map_err(|_| "the seal key is not an X25519 key".to_owned())?;
        let public: [u8; 32] = private
            .compute_public_key()
            .map_err(|_| "the seal key's public half cannot be computed".to_owned())?
            .as_ref()
            .try_into()
            .map_err(|_| "the seal key's public half is not 32 bytes".to_owned())?;
        Ok(Self { private, public })
    }

    fn generate() -> Result<(Self, Vec<u8>), String> {
        let private = PrivateKey::generate(&X25519)
            .map_err(|_| "the system could not make a key".to_owned())?;
        let bytes: Vec<u8> =
            AsBigEndian::<aws_lc_rs::encoding::Curve25519SeedBin>::as_be_bytes(&private)
                .map_err(|_| "the seal key cannot be written".to_owned())?
                .as_ref()
                .to_vec();
        Ok((Self::from_private(&bytes)?, bytes))
    }

    /// The seal key in `state` (the state directory the enrollment made, 0700):
    /// `seal.x25519`, made there the first time.
    pub fn load_or_create(state: &Path) -> Result<Self, String> {
        crate::host::private_dir(state)?;
        let path = state.join(KEY_FILE);
        let key = match fs::symlink_metadata(&path) {
            Ok(m) => {
                use std::os::unix::fs::PermissionsExt;
                if !m.file_type().is_file() || m.permissions().mode() & 0o077 != 0 {
                    return Err(format!(
                        "{}: not a regular file of its owner's alone",
                        path.display()
                    ));
                }
                Self::from_private(
                    &fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?,
                )?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let (key, bytes) = Self::generate()?;
                crate::host::replace(&path, &bytes)?;
                key
            }
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        key.keep_public(state)?;
        Ok(key)
    }

    /// [`SealKey::load_or_create`] on a Mac: the private half in the login keychain under
    /// `account` ([`keychain_account`]), made there the first time.
    pub fn load_or_create_in(
        state: &Path,
        keychain: &mut dyn Security,
        account: &str,
    ) -> Result<Self, String> {
        crate::host::private_dir(state)?;
        let key = if let Some(t) = keychain.find(account)? {
            Self::from_private(&unb64(&t, "the keychain's seal key", 64)?)?
        } else {
            let (key, bytes) = Self::generate()?;
            keychain.put(account, &b64(&bytes))?;
            key
        };
        key.keep_public(state)?;
        Ok(key)
    }

    /// `seal.pub` says this key's public half (a key made again — its private half lost —
    /// has another: the site then asks the owner to confirm it again).
    fn keep_public(&self, state: &Path) -> Result<(), String> {
        if read_public(state).as_deref() != Some(self.public_b64u().as_str()) {
            crate::host::replace(
                &state.join(PUB_FILE),
                format!("{}\n", self.public_b64u()).as_bytes(),
            )?;
        }
        Ok(())
    }

    /// The public half, base64url without padding.
    pub fn public_b64u(&self) -> String {
        b64(&self.public)
    }

    pub fn fingerprint(&self) -> String {
        fingerprint_of(&self.public)
    }

    /// Opens one sealed value for this host: the value, or why not. `name` and the host are
    /// bound into the derivation and the ciphertext; the value must be printable ASCII with
    /// no space, at most [`MAX_VALUE`] bytes — what a key or a token is, and what
    /// `agent.env` holds on one line.
    pub fn open(&self, host: &str, s: &Sealed) -> Result<String, String> {
        let (Some(epk), Some(nonce), Some(ct)) = (&s.epk, &s.nonce, &s.ct) else {
            return Err(format!("{}: nothing sealed", s.name));
        };
        let epk = unb64(epk, "epk", 64)?;
        let nonce = unb64(nonce, "nonce", 32)?;
        let mut ct = unb64(ct, "ct", (MAX_VALUE + TAG) * 4 / 3 + 4)?;
        let nonce: [u8; NONCE_LEN] = nonce
            .try_into()
            .map_err(|_| format!("{}: the nonce is not {NONCE_LEN} bytes", s.name))?;
        if epk.len() != 32 || ct.len() <= TAG || ct.len() > MAX_VALUE + TAG {
            return Err(format!(
                "{}: the ephemeral key or the ciphertext has a length no seal writes",
                s.name
            ));
        }
        let info = info(host, &s.name);
        let mut salt = epk.clone();
        salt.extend_from_slice(&self.public);
        let key = agreement::agree(
            &self.private,
            UnparsedPublicKey::new(&X25519, &epk),
            format!("{}: the ephemeral key is not an X25519 key", s.name),
            |shared| {
                if shared.iter().all(|b| *b == 0) {
                    return Err(format!(
                        "{}: the ephemeral key is a low-order point",
                        s.name
                    ));
                }
                let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(shared);
                let parts = [info.as_bytes()];
                let okm = prk
                    .expand(&parts, &AES_256_GCM)
                    .map_err(|_| "HKDF failed".to_owned())?;
                Ok(UnboundKey::from(okm))
            },
        )?;
        let plain = LessSafeKey::new(key)
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(info.as_bytes()),
                &mut ct,
            )
            .map_err(|_| {
                format!(
                    "{}: it does not open with this host's seal key (sealed to another key, for another host or name, or changed on the way)",
                    s.name
                )
            })?;
        let value =
            std::str::from_utf8(plain).map_err(|_| format!("{}: the value is not text", s.name))?;
        if value.is_empty() || !value.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
            return Err(format!(
                "{}: the value holds a space, a control or a non-ASCII character: a key or a token holds none",
                s.name
            ));
        }
        Ok(value.to_owned())
    }
}

/// What a value of `name` sealed for `host` is bound to.
pub fn info(host: &str, name: &str) -> String {
    format!("{INFO}\n{host}\n{name}")
}

/// Seals `value` to `public` for `host` and `name`, as the owner's browser does
/// (worker/src/seal.ts): what the tests hand the agent.
///
/// # Panics
///
/// When the system has no randomness or `public` is not an X25519 key: a test's mistake.
#[cfg(any(test, feature = "fuzzing"))]
pub fn seal(public: &[u8], host: &str, name: &str, value: &str) -> Sealed {
    use aws_lc_rs::rand::{SecureRandom, SystemRandom};
    let eph = PrivateKey::generate(&X25519).unwrap();
    let epk = eph.compute_public_key().unwrap().as_ref().to_vec();
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).unwrap();
    let info = info(host, name);
    let mut salt = epk.clone();
    salt.extend_from_slice(public);
    let key = agreement::agree(
        &eph,
        UnparsedPublicKey::new(&X25519, public),
        (),
        |shared| {
            let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(shared);
            let parts = [info.as_bytes()];
            Ok(UnboundKey::from(prk.expand(&parts, &AES_256_GCM).unwrap()))
        },
    )
    .unwrap();
    let mut ct = value.as_bytes().to_vec();
    LessSafeKey::new(key)
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(info.as_bytes()),
            &mut ct,
        )
        .unwrap();
    Sealed {
        name: name.to_owned(),
        epk: Some(b64(&epk)),
        nonce: Some(b64(&nonce)),
        ct: Some(b64(&ct)),
        remove: false,
    }
}
