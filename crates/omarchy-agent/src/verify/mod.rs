//! Verify, then parse (design v2 §5.1, §11.3).
//!
//! Signed bytes go through the cryptographic check ([`BundleVerifier`]) and the identity
//! pins ([`identity`]) before `serde` sees them. Only then is the bundle unpacked and its
//! manifest read; [`VerifiedBundle`] and [`VerifiedStatement`] have no other constructor,
//! so later code that takes them can only ever see signed content.
//!
//! [`cosignature`] is the second signature (#330, design v2 D1 b): the maintainers' FIDO
//! keys over a bundle or a statement, against the requirement this binary pins. It is
//! checked where a host decides to take one (the run loop, install), since `verify
//! --bundle` also runs on a release before anyone co-signed it.

pub mod cosignature;
pub mod identity;
mod sigstore;
mod sshsig;

use std::collections::BTreeMap;
use std::fmt;

use sha2::{Digest as _, Sha256};

use crate::manifest::{self, Manifest, Outer, Parsed};
use crate::statement::{self, ParsedStatement, Statement};
pub use identity::{Mismatch, Pins, RELEASE, ROLLBACK};

/// The cryptographic check of a Sigstore bundle over an artifact (design v2 D2): the
/// pinned `sigstore-verify` today ([`sigstore::SigstoreVerifier`]); a minimal verifier of
/// the bundle v0.3 format is the prepared fallback if that crate stalls. Implementations
/// check signature, chain and log at the signed time, and authorize nobody.
pub(crate) trait BundleVerifier {
    fn verify(&self, artifact: &[u8], sigstore_bundle: &[u8]) -> Result<SignedBy, String>;
}

/// What the cryptographic check vouches for: this leaf certificate signed the artifact at
/// this (log-signed) time.
#[derive(Debug)]
pub(crate) struct SignedBy {
    pub(crate) certificate: Vec<u8>,
    pub(crate) signed_at: i64,
}

/// Why signed content was refused. Each pin has its own reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// The bytes, the signature, the certificate chain or the log entry do not hold up.
    Signature(String),
    /// A valid signature by someone other than the pinned workflow run.
    Signer(Mismatch),
    /// Signed, but not a bundle archive this agent can read.
    Bundle(String),
    /// Signed, but its manifest or statement is refused.
    Content(String),
}

impl Rejection {
    /// A short, stable name for the reason.
    pub fn reason(&self) -> &'static str {
        match self {
            Rejection::Signature(_) => "signature",
            Rejection::Signer(m) => m.pin(),
            Rejection::Bundle(_) => "bundle",
            Rejection::Content(_) => "content",
        }
    }
}

impl fmt::Display for Rejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Rejection::Signature(why) => write!(f, "signature: {why}"),
            Rejection::Signer(m) => write!(f, "{m}"),
            Rejection::Bundle(why) => write!(f, "bundle: {why}"),
            Rejection::Content(why) => write!(f, "content: {why}"),
        }
    }
}

/// The signer of verified content: the pinned identity, and when the log signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signer {
    identity: String,
    signed_at: i64,
}

impl Signer {
    /// The certificate's SAN: the workflow file and ref that signed.
    pub fn identity(&self) -> &str {
        &self.identity
    }
    /// Unix seconds, from the transparency log (or a timestamp authority), never the host.
    pub fn signed_at(&self) -> i64 {
        self.signed_at
    }
}

fn check_signature_with(
    verifier: &dyn BundleVerifier,
    artifact: &[u8],
    sigstore_bundle: &[u8],
    pins: &Pins,
) -> Result<Signer, Rejection> {
    let signed = verifier
        .verify(artifact, sigstore_bundle)
        .map_err(Rejection::Signature)?;
    let id = identity::Identity::from_der(&signed.certificate).map_err(Rejection::Signer)?;
    id.check(pins).map_err(Rejection::Signer)?;
    Ok(Signer {
        identity: id.san,
        signed_at: signed.signed_at,
    })
}

/// Checks that `pins`' workflow signed `artifact`; no content is read. This is the whole of
/// the trust decision, shared by [`bundle`] and [`statement`].
pub fn check_signature(
    artifact: &[u8],
    sigstore_bundle: &[u8],
    pins: &Pins,
) -> Result<Signer, Rejection> {
    check_signature_with(
        &sigstore::SigstoreVerifier::production(),
        artifact,
        sigstore_bundle,
        pins,
    )
}

/// A host bundle `release.yml` signed on main, with the manifest this agent knows.
#[derive(Debug)]
pub struct VerifiedBundle {
    signer: Signer,
    sha256: String,
    manifest: Box<Manifest>,
    files: BTreeMap<String, Vec<u8>>,
}

impl VerifiedBundle {
    pub fn signer(&self) -> &Signer {
        &self.signer
    }
    /// `sha256:<hex>` of the archive as signed.
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    /// A file of the archive, by its path in it (`sets/host/compose.yml`).
    pub fn file(&self, path: &str) -> Option<&[u8]> {
        self.files.get(path).map(Vec::as_slice)
    }
}

/// The outcome of verifying a host bundle whose signature holds.
#[derive(Debug)]
pub enum BundleOutcome {
    Current(Box<VerifiedBundle>),
    /// Signed and pinned, but this agent must update itself first; only the (frozen,
    /// lenient) outer layer was read, which says how.
    NeedsNewerAgent {
        signer: Signer,
        outer: Outer,
        why: String,
    },
}

/// `omarchy-agent verify --bundle`: signature and pins first, then the archive and its
/// manifest.
pub fn bundle(archive: &[u8], sigstore_bundle: &[u8]) -> Result<BundleOutcome, Rejection> {
    bundle_with(
        &sigstore::SigstoreVerifier::production(),
        archive,
        sigstore_bundle,
    )
}

fn bundle_with(
    verifier: &dyn BundleVerifier,
    archive: &[u8],
    sigstore_bundle: &[u8],
) -> Result<BundleOutcome, Rejection> {
    let signer = check_signature_with(verifier, archive, sigstore_bundle, &RELEASE)?;
    let sha256 = format!("sha256:{}", hex::encode(Sha256::digest(archive)));
    let files = crate::archive::read(archive).map_err(Rejection::Bundle)?;
    let json = files
        .get("manifest.json")
        .ok_or_else(|| Rejection::Bundle("no manifest.json".into()))?;
    let manifest = match manifest::parse(json).map_err(|e| Rejection::Content(e.0))? {
        Parsed::NeedsNewerAgent { outer, why } => {
            return Ok(BundleOutcome::NeedsNewerAgent { signer, outer, why })
        }
        Parsed::Current(m) => m,
    };
    // Every file the manifest lists is in the archive with that hash, so a set's files can
    // be taken from the archive by the manifest's word (P1), and release.yml's own
    // `verify` of its output catches a manifest written from other files.
    for (set, listed) in manifest.set_files_all() {
        for (path, digest) in listed {
            let full = format!("sets/{set}/{path}");
            let data = files
                .get(&full)
                .ok_or_else(|| Rejection::Bundle(format!("{full} is listed but missing")))?;
            if Sha256::digest(data).as_slice() != digest.as_bytes() {
                return Err(Rejection::Bundle(format!(
                    "{full} does not match its hash in the manifest"
                )));
            }
        }
    }
    Ok(BundleOutcome::Current(Box::new(VerifiedBundle {
        signer,
        sha256,
        manifest,
        files,
    })))
}

/// A rollback statement `rollback.yml` signed on main.
#[derive(Debug)]
pub struct VerifiedStatement {
    signer: Signer,
    statement: Statement,
}

impl VerifiedStatement {
    pub fn signer(&self) -> &Signer {
        &self.signer
    }
    pub fn statement(&self) -> &Statement {
        &self.statement
    }
}

#[derive(Debug)]
pub enum StatementOutcome {
    Current(VerifiedStatement),
    NeedsNewerAgent { signer: Signer, why: String },
}

/// `omarchy-agent verify --statement`: pinned to `rollback.yml`.
pub fn statement(json: &[u8], sigstore_bundle: &[u8]) -> Result<StatementOutcome, Rejection> {
    statement_with(
        &sigstore::SigstoreVerifier::production(),
        json,
        sigstore_bundle,
    )
}

fn statement_with(
    verifier: &dyn BundleVerifier,
    json: &[u8],
    sigstore_bundle: &[u8],
) -> Result<StatementOutcome, Rejection> {
    let signer = check_signature_with(verifier, json, sigstore_bundle, &ROLLBACK)?;
    Ok(
        match statement::parse(json).map_err(|e| Rejection::Content(e.0))? {
            ParsedStatement::Current(statement) => {
                StatementOutcome::Current(VerifiedStatement { signer, statement })
            }
            ParsedStatement::NeedsNewerAgent { why } => {
                StatementOutcome::NeedsNewerAgent { signer, why }
            }
        },
    )
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod conformance;

/// Signed content for the run loop's tests: the pins and parsing are real, the
/// cryptographic check vouches ("this certificate signed it at `signed_at`"), and a
/// signature of `b"forged"` is refused as a bad signature would be.
#[cfg(test)]
pub(crate) mod tests_support {
    use super::identity::tests::Claims;
    use super::{
        bundle_with, statement_with, BundleOutcome, BundleVerifier, Rejection, SignedBy,
        StatementOutcome, ROLLBACK,
    };
    use crate::manifest::{self, Manifest, Parsed};
    use sha2::{Digest as _, Sha256};

    const EXAMPLE: &str = include_str!("../../tests/fixtures/manifest/v2-example.json");

    struct Vouching {
        certificate: Vec<u8>,
        signed_at: i64,
    }

    impl BundleVerifier for Vouching {
        fn verify(&self, _: &[u8], sig: &[u8]) -> Result<SignedBy, String> {
            if sig == b"forged" {
                return Err("signature verification failed".into());
            }
            Ok(SignedBy {
                certificate: self.certificate.clone(),
                signed_at: self.signed_at,
            })
        }
    }

    /// The example manifest as release `release`, with these floor values.
    pub(crate) fn manifest_json(
        release: &str,
        min_release: &str,
        revoked: &[&str],
    ) -> serde_json::Value {
        let mut v: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        v["release"] = release.into();
        v["inner"]["min_release"] = min_release.into();
        v["inner"]["revoked"] = revoked
            .iter()
            .map(|r| serde_json::Value::from(*r))
            .collect();
        v
    }

    fn parse(v: &serde_json::Value) -> Manifest {
        match manifest::parse(v.to_string().as_bytes()).unwrap() {
            Parsed::Current(m) => *m,
            Parsed::NeedsNewerAgent { why, .. } => panic!("{why}"),
        }
    }

    pub(crate) fn manifest(release: &str, min_release: &str, revoked: &[&str]) -> Manifest {
        parse(&manifest_json(release, min_release, revoked))
    }

    /// The example manifest with only these tools for `platform`: (name, url, sha256 hex).
    pub(crate) fn manifest_with_tools(platform: &str, tools: &[(&str, &str, &str)]) -> Manifest {
        let mut v = manifest_json("v1.20.0", "v1.0.0", &[]);
        let named: serde_json::Map<String, serde_json::Value> = tools
            .iter()
            .map(|(n, u, s)| ((*n).to_owned(), serde_json::json!({"url": u, "sha256": s})))
            .collect();
        v["inner"]["tools"] = serde_json::json!({ platform: named });
        parse(&v)
    }

    /// A bundle archive: `manifest` with the host set's `files` listed and packed.
    pub(crate) fn bundle_archive(
        mut manifest: serde_json::Value,
        files: &[(&str, &[u8])],
    ) -> Vec<u8> {
        let listed: serde_json::Map<String, serde_json::Value> = files
            .iter()
            .map(|(p, d)| {
                (
                    (*p).to_owned(),
                    format!("sha256:{}", hex::encode(Sha256::digest(d))).into(),
                )
            })
            .collect();
        manifest["inner"]["sets"] = serde_json::json!({"host": {"files": listed}});
        let text = manifest.to_string();
        let mut all: Vec<(String, &[u8])> = vec![("manifest.json".into(), text.as_bytes())];
        all.extend(files.iter().map(|(p, d)| (format!("sets/host/{p}"), *d)));
        let refs: Vec<(&str, &[u8])> = all.iter().map(|(p, d)| (p.as_str(), *d)).collect();
        crate::archive::tests::pack(&refs)
    }

    pub(crate) fn verify_bundle(
        archive: &[u8],
        sig: &[u8],
        signed_at: i64,
    ) -> Result<BundleOutcome, Rejection> {
        let v = Vouching {
            certificate: Claims::default().certificate(),
            signed_at,
        };
        bundle_with(&v, archive, sig)
    }

    pub(crate) fn verify_statement(
        json: &[u8],
        sig: &[u8],
        signed_at: i64,
    ) -> Result<StatementOutcome, Rejection> {
        let v = Vouching {
            certificate: Claims {
                san: ROLLBACK.san(),
                ..Claims::default()
            }
            .certificate(),
            signed_at,
        };
        statement_with(&v, json, sig)
    }
}
