//! The one place the Sigstore crate is used (design v2 D2): [`SigstoreVerifier`] is the
//! production [`BundleVerifier`].
//!
//! It checks, offline, against the trusted root embedded in this binary: the bundle's
//! structure (an inclusion proof is required), the signing certificate's chain to Fulcio
//! and its SCT, at the time the log signed (Rekor's integrated time or an RFC 3161
//! timestamp, never the host clock), the signature over the artifact's bytes, and the log
//! entry's consistency with them. It deliberately authorizes nobody: that is
//! [`super::identity`], which a fallback verifier shares.
//!
//! One limit of `sigstore-verify` 0.14, stated plainly: it reads the host clock twice, to
//! refuse an integrated time in the future and to pick the checkpoint keys already valid.
//! Both can only refuse (a host whose clock is behind the signing time fails closed);
//! neither makes it accept a certificate outside its validity at the signed time.

use sigstore_verify::trust_root::TrustedRoot;
use sigstore_verify::types::{Bundle, SignatureContent};
use sigstore_verify::{VerificationPolicy, Verifier};

use super::{BundleVerifier, SignedBy};

/// The Sigstore public-good trusted root (Fulcio CAs, Rekor and CT log keys), refreshed by
/// each agent release from <https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json>
/// (through Sigstore's TUF root, as `sigstore-trust-root` embeds it).
const TRUSTED_ROOT: &str = include_str!("trusted_root.json");

pub(crate) struct SigstoreVerifier {
    verifier: Verifier,
}

impl SigstoreVerifier {
    /// The verifier every host and CI use: the embedded public-good root.
    pub(crate) fn production() -> Self {
        Self::with_root(TRUSTED_ROOT).expect("the embedded trusted root loads")
    }

    pub(crate) fn with_root(json: &str) -> Result<Self, String> {
        let root = TrustedRoot::from_json(json).map_err(|e| format!("trusted root: {e}"))?;
        let verifier = Verifier::new(&root).map_err(|e| format!("trusted root: {e}"))?;
        Ok(SigstoreVerifier { verifier })
    }
}

impl BundleVerifier for SigstoreVerifier {
    fn verify(&self, artifact: &[u8], sigstore_bundle: &[u8]) -> Result<SignedBy, String> {
        let json = std::str::from_utf8(sigstore_bundle)
            .map_err(|_| "the bundle is not UTF-8".to_owned())?;
        let bundle = Bundle::from_json(json).map_err(|e| format!("not a Sigstore bundle: {e}"))?;
        // `cosign sign-blob --bundle` signs the bytes themselves; an attestation (DSSE) over
        // them is another kind of statement and is not what release.yml produces.
        if !matches!(bundle.content, SignatureContent::MessageSignature(_)) {
            return Err("the bundle does not sign the artifact's bytes (message signature)".into());
        }
        // Authorization is ours, on every pinned claim (identity.rs), not the policy's.
        let policy = VerificationPolicy::any_identity();
        let result = self
            .verifier
            .verify(artifact, &bundle, &policy)
            .map_err(|e| e.to_string())?;
        if !(result.certificate_verified() && result.sct_verified() && result.tlog_verified()) {
            return Err("the certificate chain, its SCT or the log entry went unchecked".into());
        }
        let cert = bundle
            .signing_certificate()
            .ok_or("the bundle carries no signing certificate")?;
        let signed_at = result
            .verified_timestamps()
            .iter()
            .map(|t| t.as_second())
            .min()
            .ok_or("no verified signing time")?;
        Ok(SignedBy {
            certificate: cert.as_bytes().to_vec(),
            signed_at,
        })
    }
}
