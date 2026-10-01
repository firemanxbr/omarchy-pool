//! `verify` against a real signing by release.yml on main (tests/fixtures/release-v1.0.5,
//! rebuilt from public reads by its fetch.py), and every pin failing with its own reason.

use sha2::{Digest as _, Sha256};

use super::identity::tests::Claims;
use super::sigstore::SigstoreVerifier;
use super::{
    bundle_with, check_signature, check_signature_with, statement_with, BundleOutcome,
    BundleVerifier, Pins, Rejection, SignedBy, StatementOutcome, RELEASE, ROLLBACK,
};

const REAL_ARTIFACT: &[u8] = include_bytes!("../../tests/fixtures/release-v1.0.5/artifact");
const REAL_BUNDLE: &[u8] =
    include_bytes!("../../tests/fixtures/release-v1.0.5/bundle.sigstore.json");
const MANIFEST: &str = include_str!("../../tests/fixtures/manifest/v2-example.json");

#[test]
fn a_real_release_yml_signing_on_main_verifies() {
    let signer = check_signature(REAL_ARTIFACT, REAL_BUNDLE, &RELEASE).unwrap();
    assert_eq!(
        signer.identity(),
        "https://github.com/firemanxbr/omarchy-pool/.github/workflows/release.yml@refs/heads/main"
    );
    // Rekor's integrated time for log index 3023590432 (2026-09-30T18:26:06Z).
    assert_eq!(signer.signed_at(), 1_790_792_766);
}

#[test]
fn a_changed_byte_is_refused() {
    let mut artifact = REAL_ARTIFACT.to_vec();
    artifact[40] ^= 1;
    let r = check_signature(&artifact, REAL_BUNDLE, &RELEASE).unwrap_err();
    assert_eq!(r.reason(), "signature", "{r}");

    // A changed byte of the signature itself.
    let text = std::str::from_utf8(REAL_BUNDLE).unwrap();
    let sig = "MEUCIHCMs3ndaaR0D8U0LppWcOyPGU9l70m";
    assert!(text.contains(sig));
    let forged = text.replace(sig, "MEUCIHCMs3ndaaR0D8U0LppWcOyPGU9l70n");
    let r = check_signature(REAL_ARTIFACT, forged.as_bytes(), &RELEASE).unwrap_err();
    assert_eq!(r.reason(), "signature", "{r}");
}

#[test]
fn the_real_signing_is_refused_for_any_other_pin() {
    // The same real certificate, held to pins it does not match: each names its pin.
    let cases: [(Pins, &str); 6] = [
        (ROLLBACK, "workflow"),
        (
            Pins {
                git_ref: "refs/heads/other",
                ..RELEASE
            },
            "ref",
        ),
        (
            Pins {
                repository: "firemanxbr/omarchy-fork",
                ..RELEASE
            },
            "repository",
        ),
        (
            Pins {
                repository_id: "1",
                ..RELEASE
            },
            "repository_id",
        ),
        (
            Pins {
                repository_owner_id: "1",
                ..RELEASE
            },
            "repository_owner_id",
        ),
        (
            Pins {
                event_name: "push",
                ..RELEASE
            },
            "event_name",
        ),
    ];
    for (pins, reason) in cases {
        let r = check_signature(REAL_ARTIFACT, REAL_BUNDLE, &pins).unwrap_err();
        assert_eq!(r.reason(), reason, "{r}");
    }
}

/// Stands in for the cryptographic check: "this certificate signed it", so the pins and
/// the parsing after them can be exercised on certificates Fulcio would never issue us.
struct Vouches(Vec<u8>);

impl BundleVerifier for Vouches {
    fn verify(&self, _: &[u8], _: &[u8]) -> Result<SignedBy, String> {
        Ok(SignedBy {
            certificate: self.0.clone(),
            signed_at: 1_790_792_766,
        })
    }
}

struct Refuses;

impl BundleVerifier for Refuses {
    fn verify(&self, _: &[u8], _: &[u8]) -> Result<SignedBy, String> {
        Err("signature verification failed".into())
    }
}

fn pinned() -> Vouches {
    Vouches(Claims::default().certificate())
}

#[test]
fn signers_other_than_the_pinned_workflow_run_are_refused_with_a_named_reason() {
    let base = Claims::default();
    let cases = [
        (
            Claims {
                san: RELEASE.san().replace("refs/heads/main", "refs/heads/other"),
                ..base.clone()
            },
            "ref",
        ),
        (
            Claims {
                san: RELEASE.san().replace("release.yml", "ci.yml"),
                ..base.clone()
            },
            "workflow",
        ),
        (
            Claims {
                repository_id: "999",
                ..base.clone()
            },
            "repository_id",
        ),
        (
            Claims {
                repository_owner_id: "999",
                ..base.clone()
            },
            "repository_owner_id",
        ),
        (
            Claims {
                event_name: "push",
                ..base.clone()
            },
            "event_name",
        ),
    ];
    let archive = crate::archive::tests::pack(&[("manifest.json", MANIFEST.as_bytes())]);
    for (claims, reason) in cases {
        let v = Vouches(claims.certificate());
        let r = bundle_with(&v, &archive, b"{}").unwrap_err();
        assert_eq!(r.reason(), reason, "{r}");
        assert!(matches!(r, Rejection::Signer(_)));
        // Nothing is unpacked or parsed for a refused signer: a broken archive gives the
        // same answer.
        assert_eq!(
            bundle_with(&v, b"not an archive", b"{}")
                .unwrap_err()
                .reason(),
            reason
        );
    }
}

fn with_set_files(manifest: &str, files: &[(&str, &[u8])]) -> String {
    let mut v: serde_json::Value = serde_json::from_str(manifest).unwrap();
    let listed: serde_json::Map<String, serde_json::Value> = files
        .iter()
        .map(|(p, d)| {
            (
                (*p).to_owned(),
                format!("sha256:{}", hex::encode(Sha256::digest(d))).into(),
            )
        })
        .collect();
    v["inner"]["sets"]["host"]["files"] = listed.into();
    v.to_string()
}

#[test]
fn verify_first_then_parse() {
    // A refused signature is the answer, whatever the archive holds.
    let r = bundle_with(&Refuses, b"anything", b"{}").unwrap_err();
    assert_eq!(r.reason(), "signature");

    let compose: &[u8] = b"services: {}\n";
    let manifest = with_set_files(MANIFEST, &[("compose.yml", compose)]);
    let archive = crate::archive::tests::pack(&[
        ("manifest.json", manifest.as_bytes()),
        ("sets/host/compose.yml", compose),
    ]);
    let BundleOutcome::Current(b) = bundle_with(&pinned(), &archive, b"{}").unwrap() else {
        panic!()
    };
    assert_eq!(b.manifest().outer().release().to_string(), "1.20.0");
    assert_eq!(b.file("sets/host/compose.yml"), Some(compose));
    assert!(b.sha256().starts_with("sha256:"));
    assert!(b
        .signer()
        .identity()
        .ends_with("release.yml@refs/heads/main"));

    // A manifest whose listed file is not the archive's.
    let tampered = crate::archive::tests::pack(&[
        ("manifest.json", manifest.as_bytes()),
        ("sets/host/compose.yml", b"x"),
    ]);
    assert_eq!(
        bundle_with(&pinned(), &tampered, b"{}")
            .unwrap_err()
            .reason(),
        "bundle"
    );
    let missing = crate::archive::tests::pack(&[("sets/host/compose.yml", compose)]);
    assert_eq!(
        bundle_with(&pinned(), &missing, b"{}")
            .unwrap_err()
            .reason(),
        "bundle"
    );
}

#[test]
fn a_signed_bundle_for_a_newer_agent_says_so_instead_of_failing() {
    let mut v: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
    v["future_outer_field"] = true.into();
    v["inner"] = serde_json::json!({"schema": 4, "shape": "unknown"});
    let archive = crate::archive::tests::pack(&[("manifest.json", v.to_string().as_bytes())]);
    match bundle_with(&pinned(), &archive, b"{}").unwrap() {
        BundleOutcome::NeedsNewerAgent { outer, why, .. } => {
            assert!(why.contains("inner.schema 4"), "{why}");
            assert_eq!(outer.agent().version().to_string(), "0.1.0");
        }
        BundleOutcome::Current(_) => panic!("expected needs a newer agent"),
    }
}

#[test]
fn statements_are_pinned_to_rollback_yml() {
    let json = br#"{"schema":1,"seq":7,"to":"v1.13.4","retracts_through":"v1.14.2","issued":"2026-10-20T14:00:00Z","agent_to":null,"run":"https://github.com/firemanxbr/omarchy-pool/actions/runs/1"}"#;
    // A release.yml certificate does not sign statements.
    let r = statement_with(&pinned(), json, b"{}").unwrap_err();
    assert_eq!(r.reason(), "workflow");
    let rollback = Vouches(
        Claims {
            san: ROLLBACK.san(),
            ..Claims::default()
        }
        .certificate(),
    );
    let StatementOutcome::Current(s) = statement_with(&rollback, json, b"{}").unwrap() else {
        panic!()
    };
    assert_eq!(s.statement().seq(), 7);
    assert!(matches!(
        statement_with(&rollback, br#"{"schema":2}"#, b"{}").unwrap(),
        StatementOutcome::NeedsNewerAgent { .. }
    ));
    // And the real release.yml signing is not a statement signature.
    let r = check_signature_with(
        &SigstoreVerifier::production(),
        REAL_ARTIFACT,
        REAL_BUNDLE,
        &ROLLBACK,
    )
    .unwrap_err();
    assert_eq!(r.reason(), "workflow");
}

/// What factory/bin/release-rollback writes (tests/rollback-workflow.sh holds the script to
/// this file's shape, byte for byte but `issued` and `run`).
const RELEASE_ROLLBACK_STATEMENT: &[u8] =
    include_bytes!("../../tests/fixtures/statement/release-rollback.json");

#[test]
fn the_statement_release_rollback_writes_is_accepted_from_rollback_yml_on_main_only() {
    let signed_by = |san: String| {
        Vouches(
            Claims {
                san,
                ..Claims::default()
            }
            .certificate(),
        )
    };
    let StatementOutcome::Current(s) = statement_with(
        &signed_by(ROLLBACK.san()),
        RELEASE_ROLLBACK_STATEMENT,
        b"{}",
    )
    .unwrap() else {
        panic!("expected a current statement")
    };
    let st = s.statement();
    assert_eq!(
        (
            st.seq(),
            st.to().to_string(),
            st.retracts_through().to_string(),
            st.agent_to()
        ),
        (1, "1.0.2".into(), "1.0.3".into(), None)
    );
    assert!(s
        .signer()
        .identity()
        .ends_with("/.github/workflows/rollback.yml@refs/heads/main"));
    // The same bytes signed by release.yml, or by rollback.yml from any other ref.
    let r = statement_with(&pinned(), RELEASE_ROLLBACK_STATEMENT, b"{}").unwrap_err();
    assert_eq!(r.reason(), "workflow", "{r}");
    for other in ["refs/heads/other", "refs/tags/v1.0.2", "refs/pull/1/merge"] {
        let v = signed_by(ROLLBACK.san().replace("refs/heads/main", other));
        let r = statement_with(&v, RELEASE_ROLLBACK_STATEMENT, b"{}").unwrap_err();
        assert_eq!(r.reason(), "ref", "{other}: {r}");
    }
    // A statement changed after signing is the cryptographic check's to refuse; one whose
    // signature holds but whose content the agent cannot take is refused as content.
    let mut v: serde_json::Value = serde_json::from_slice(RELEASE_ROLLBACK_STATEMENT).unwrap();
    v["retracts_through"] = "v1.0.2".into();
    let r =
        statement_with(&signed_by(ROLLBACK.san()), v.to_string().as_bytes(), b"{}").unwrap_err();
    assert_eq!(r.reason(), "content", "{r}");
}

#[test]
fn a_bundle_that_is_not_a_message_signature_or_not_json_is_refused() {
    let v = SigstoreVerifier::production();
    assert!(v.verify(REAL_ARTIFACT, b"{").is_err());
    let mut dsse: serde_json::Value = serde_json::from_slice(REAL_BUNDLE).unwrap();
    let obj = dsse.as_object_mut().unwrap();
    obj.remove("messageSignature");
    obj.insert(
        "dsseEnvelope".into(),
        serde_json::json!({"payload": "e30=", "payloadType": "application/vnd.in-toto+json", "signatures": [{"sig": "MEUCIQ==", "keyid": ""}]}),
    );
    let e = v
        .verify(REAL_ARTIFACT, dsse.to_string().as_bytes())
        .unwrap_err();
    assert!(e.contains("message signature"), "{e}");
}
