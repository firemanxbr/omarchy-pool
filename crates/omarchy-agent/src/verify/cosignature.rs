//! The maintainers' co-signature (#330, design v2 D1 b and D25): an offline signature by
//! maintainers' FIDO security keys (`ssh-keygen -Y sign`, [`super::sshsig`]) beside the
//! keyless one `release.yml` or `rollback.yml` makes.
//!
//! **Where the requirement lives.** The keys and the threshold are pinned in this binary
//! ([`PINNED`], `maintainers.toml` beside this file), written from `factory/MAINTAINERS.toml`
//! by `factory/bin/check-governance --write`, which CI holds the two to. Nothing the pool
//! says and nothing a release's manifest says can lower it: an agent requires what the
//! release it shipped in pinned, and it moves to another agent only from a bundle that
//! satisfies its own requirement (self-update is upward only, D8; a rollback's `agent_to`
//! only from a target co-signed as below). A new key, a removed one or another threshold is
//! therefore a new agent, taken under the old one's requirement: the chain never breaks.
//! What it does not cover, stated plainly: a host installed from nothing trusts the agent
//! `install.sh` fetched, which `release.yml`'s signature vouches for (the runbook's
//! verifying install); the requirement holds from its first agent on.
//!
//! **What it covers.**
//! - A host bundle: `threshold` of the pinned maintainers signed the archive's bytes (the
//!   bytes `release.yml` signs) under [`BUNDLE_NAMESPACE`], each as the release asset
//!   `omarchy-host-vX.Y.Z.tar.gz.<login>.sshsig`, uploaded to the draft before
//!   `factory/bin/publish-release` publishes it. With `threshold = 0` nothing is asked.
//! - A rollback statement: one that goes back more than 14 days (D25) is taken only with
//!   [`Policy::deep_rollback`] co-signatures over the statement's bytes under
//!   [`ROLLBACK_NAMESPACE`], which the pool relays beside it. A co-signed statement also
//!   vouches for its target's bundle, so a host can go back to a release published before
//!   the threshold rose (an immutable release takes no asset later).
//!
//! A namespace per kind keeps a signature over a bundle from counting for a statement.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

pub(crate) use super::sshsig::MAX_ARMORED;
use super::sshsig::{self, PublicKey};

/// The namespace a host bundle's co-signature is made in (`ssh-keygen -Y sign -n`).
pub const BUNDLE_NAMESPACE: &str = "host-bundle@omarchy-pool.org";
/// The namespace a rollback statement's co-signature is made in.
pub const ROLLBACK_NAMESPACE: &str = "rollback@omarchy-pool.org";

/// The requirement this agent pins: `factory/MAINTAINERS.toml`'s `[cosignature]`, as
/// `factory/bin/check-governance --write` writes it.
pub const PINNED: &str = include_str!("maintainers.toml");

/// At most this many keys are read: no governance file lists more maintainers.
const MAX_KEYS: usize = 64;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyRaw {
    threshold: usize,
    #[serde(default)]
    keys: BTreeMap<String, String>,
}

/// Which maintainers' keys count, and how many must sign.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Policy {
    threshold: usize,
    keys: BTreeMap<String, PublicKey>,
}

/// A GitHub login, as `factory/bin/check-governance` reads one.
pub(crate) fn is_login(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=39).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

impl Policy {
    /// The pinned requirement. A pinned file that does not read (CI's tests read it, so a
    /// build never has one) yields a requirement nothing meets: refused, never skipped.
    pub fn pinned() -> Policy {
        static PINNED_POLICY: OnceLock<Policy> = OnceLock::new();
        PINNED_POLICY
            .get_or_init(|| {
                Self::parse(PINNED).unwrap_or(Policy {
                    threshold: usize::MAX,
                    keys: BTreeMap::new(),
                })
            })
            .clone()
    }

    /// Reads `threshold` and `[keys]` (`login = "<type> <base64> [comment]"`): every key a
    /// FIDO key, no key under two logins, and a threshold the keys can meet.
    pub fn parse(text: &str) -> Result<Policy, String> {
        let raw: PolicyRaw =
            toml::from_str(text).map_err(|e| format!("co-signature policy: {e}"))?;
        if raw.keys.len() > MAX_KEYS {
            return Err(format!("co-signature policy: more than {MAX_KEYS} keys"));
        }
        let mut keys = BTreeMap::new();
        for (login, line) in raw.keys {
            if !is_login(&login) {
                return Err(format!("co-signature policy: {login:?} is not a login"));
            }
            let key = PublicKey::parse(&line)
                .map_err(|e| format!("co-signature policy: {login}'s key: {e}"))?;
            if !key.is_fido() {
                return Err(format!(
                    "co-signature policy: {login}'s key is a {}, not a FIDO key ({} or {}): a key in a file is not offline",
                    key.kind(),
                    sshsig::ED25519_SK,
                    sshsig::ECDSA_SK
                ));
            }
            if let Some((other, _)) = keys.iter().find(|(_, k)| *k == &key) {
                return Err(format!(
                    "co-signature policy: {login} and {other} have the same key: one person, one co-signature"
                ));
            }
            keys.insert(login, key);
        }
        if raw.threshold > keys.len() {
            return Err(format!(
                "co-signature policy: a threshold of {} with {} key(s) is never met",
                raw.threshold,
                keys.len()
            ));
        }
        Ok(Policy {
            threshold: raw.threshold,
            keys,
        })
    }

    /// How many maintainers must co-sign a bundle; 0 asks nothing.
    pub fn threshold(&self) -> usize {
        self.threshold
    }

    /// How many must co-sign a rollback statement that goes back more than 14 days (D25):
    /// the threshold, and at least one. With no key pinned, none can.
    pub fn deep_rollback(&self) -> usize {
        self.threshold.max(1)
    }

    /// The pinned maintainers' logins, sorted.
    pub fn logins(&self) -> impl Iterator<Item = &str> {
        self.keys.keys().map(String::as_str)
    }

    /// Which of `signatures` (login → `ssh-keygen -Y sign` output) are the pinned
    /// maintainers' over `message` in `namespace`. A login with no pinned key, another key's
    /// signature, a signature made without a touch or over other bytes counts for nothing,
    /// and says why.
    pub fn check(
        &self,
        namespace: &str,
        message: &[u8],
        signatures: &BTreeMap<String, Vec<u8>>,
    ) -> Cosigned {
        let mut out = Cosigned::default();
        for (login, armored) in signatures {
            match self.keys.get(login) {
                None => out.refused.push(format!(
                    "{login}: no key of theirs is pinned (factory/MAINTAINERS.toml)"
                )),
                Some(key) => match sshsig::verify(key, namespace, message, armored) {
                    Ok(()) => out.by.push(login.clone()),
                    Err(e) => out.refused.push(format!("{login}: {e}")),
                },
            }
        }
        out
    }
}

/// The maintainers whose co-signature verified, and why the others did not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cosigned {
    by: Vec<String>,
    refused: Vec<String>,
}

impl Cosigned {
    /// The logins whose co-signature verified, sorted.
    pub fn by(&self) -> &[String] {
        &self.by
    }

    pub fn count(&self) -> usize {
        self.by.len()
    }

    /// Why each signature that did not count did not (`login: why`).
    pub fn refused(&self) -> &[String] {
        &self.refused
    }

    /// `Ok` when at least `need` maintainers co-signed `what`; otherwise why not, with each
    /// signature that did not count.
    pub fn require(&self, need: usize, what: &str) -> Result<(), String> {
        if self.count() >= need {
            return Ok(());
        }
        let mut why = format!(
            "{what} needs {need} maintainer co-signature(s) (factory/MAINTAINERS.toml); {} verif{}",
            self.count(),
            if self.count() == 1 { "ies" } else { "y" }
        );
        if !self.by.is_empty() {
            why = format!("{why} ({})", self.by.join(", "));
        }
        if !self.refused.is_empty() {
            why = format!("{why}; {}", self.refused.join("; "));
        }
        Err(why)
    }
}

/// The name a co-signature of `file` (a release asset, or a file beside it) goes by.
pub fn file_name(file: &str, login: &str) -> String {
    format!("{file}.{login}.sshsig")
}

#[cfg(test)]
#[path = "cosignature_tests.rs"]
mod tests;

/// Maintainers' security keys played in tests: Ed25519 and P-256 key pairs that sign as a
/// FIDO authenticator does (`PROTOCOL.u2f`), and `ssh-keygen -Y sign`'s armor around it.
#[cfg(test)]
pub(crate) mod tests_support {
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{
        EcdsaKeyPair, Ed25519KeyPair, KeyPair as _, ECDSA_P256_SHA256_FIXED_SIGNING,
    };
    use base64::Engine as _;
    use sha2::{Digest as _, Sha256, Sha512};

    use super::super::sshsig::{put_string, ECDSA_SK, ED25519_SK};
    use super::Policy;

    enum Pair {
        Ed25519(Ed25519KeyPair),
        Ecdsa(EcdsaKeyPair),
    }

    /// A maintainer's security key.
    pub(crate) struct TestKey {
        pub login: String,
        pair: Pair,
    }

    impl TestKey {
        /// An `ed25519-sk` key from a fixed seed: the same key every run.
        pub fn ed25519(login: &str, seed: u8) -> Self {
            TestKey {
                login: login.into(),
                pair: Pair::Ed25519(Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap()),
            }
        }

        /// An `ecdsa-sk` (P-256) key, new every run.
        pub fn ecdsa(login: &str) -> Self {
            TestKey {
                login: login.into(),
                pair: Pair::Ecdsa(
                    EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap(),
                ),
            }
        }

        fn kind(&self) -> &'static str {
            match self.pair {
                Pair::Ed25519(_) => ED25519_SK,
                Pair::Ecdsa(_) => ECDSA_SK,
            }
        }

        fn blob(&self) -> Vec<u8> {
            let mut b = Vec::new();
            put_string(&mut b, self.kind().as_bytes());
            match &self.pair {
                Pair::Ed25519(k) => put_string(&mut b, k.public_key().as_ref()),
                Pair::Ecdsa(k) => {
                    put_string(&mut b, b"nistp256");
                    put_string(&mut b, k.public_key().as_ref());
                }
            }
            put_string(&mut b, b"ssh:");
            b
        }

        /// `<type> <base64> <login>@security-key`, as `ssh-keygen -t ed25519-sk` writes it.
        pub fn public_line(&self) -> String {
            format!(
                "{} {} {}@security-key",
                self.kind(),
                base64::engine::general_purpose::STANDARD.encode(self.blob()),
                self.login
            )
        }

        /// `ssh-keygen -Y sign -n <namespace>` with a touch.
        pub fn sign(&self, namespace: &str, message: &[u8]) -> Vec<u8> {
            self.sign_with(namespace, message, 0x01, "sha512")
        }

        /// The same, with the authenticator's `flags` and the hash named.
        pub fn sign_with(&self, namespace: &str, message: &[u8], flags: u8, hash: &str) -> Vec<u8> {
            let digest = match hash {
                "sha256" => Sha256::digest(message).to_vec(),
                _ => Sha512::digest(message).to_vec(),
            };
            let mut signed = b"SSHSIG".to_vec();
            for part in [namespace.as_bytes(), b"", hash.as_bytes(), &digest] {
                put_string(&mut signed, part);
            }
            let counter: u32 = 7;
            let mut data = Sha256::digest(b"ssh:").to_vec();
            data.push(flags);
            data.extend_from_slice(&counter.to_be_bytes());
            data.extend_from_slice(&Sha256::digest(&signed));
            let raw = match &self.pair {
                Pair::Ed25519(k) => k.sign(&data).as_ref().to_vec(),
                Pair::Ecdsa(k) => {
                    let fixed = k.sign(&SystemRandom::new(), &data).unwrap();
                    let mut sig = Vec::new();
                    for half in fixed.as_ref().chunks(32) {
                        let digits = &half[half.iter().take_while(|b| **b == 0).count()..];
                        let mut mpint = Vec::new();
                        if digits.first().is_some_and(|b| b & 0x80 != 0) {
                            mpint.push(0);
                        }
                        mpint.extend_from_slice(digits);
                        put_string(&mut sig, &mpint);
                    }
                    sig
                }
            };
            let mut sig_blob = Vec::new();
            put_string(&mut sig_blob, self.kind().as_bytes());
            put_string(&mut sig_blob, &raw);
            sig_blob.push(flags);
            sig_blob.extend_from_slice(&counter.to_be_bytes());
            let mut blob = b"SSHSIG".to_vec();
            blob.extend_from_slice(&1u32.to_be_bytes());
            put_string(&mut blob, &self.blob());
            put_string(&mut blob, namespace.as_bytes());
            put_string(&mut blob, b"");
            put_string(&mut blob, hash.as_bytes());
            put_string(&mut blob, &sig_blob);
            let b64 = base64::engine::general_purpose::STANDARD.encode(blob);
            let mut out = String::from("-----BEGIN SSH SIGNATURE-----\n");
            for line in b64.as_bytes().chunks(70) {
                out.push_str(std::str::from_utf8(line).unwrap());
                out.push('\n');
            }
            out.push_str("-----END SSH SIGNATURE-----\n");
            out.into_bytes()
        }
    }

    /// The `[cosignature]` table a governance file would carry for `keys`.
    pub(crate) fn policy_toml(threshold: usize, keys: &[&TestKey]) -> String {
        let lines: Vec<String> = keys
            .iter()
            .map(|k| format!("{} = \"{}\"\n", k.login, k.public_line()))
            .collect();
        format!("threshold = {threshold}\n\n[keys]\n{}", lines.concat())
    }

    /// `threshold` of `keys`.
    pub(crate) fn policy(threshold: usize, keys: &[&TestKey]) -> Policy {
        Policy::parse(&policy_toml(threshold, keys)).unwrap()
    }
}
