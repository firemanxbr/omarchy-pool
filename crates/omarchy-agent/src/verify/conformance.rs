//! The cryptographic check against the sigstore-conformance vectors
//! (<https://github.com/sigstore/sigstore-conformance>, `test/assets/bundle-verify`).
//!
//! That repository carries no license file, so its vectors are not copied here: CI checks
//! out a pinned commit and runs
//! `OMARCHY_SIGSTORE_CONFORMANCE=<checkout> cargo test -p omarchy-agent -- --ignored conformance`.
//! Only message-signature bundles over an artifact are in scope ([`super::sigstore`]
//! refuses DSSE, and managed keys are not keyless); every `_fail` vector must be refused,
//! every other must verify.

use std::path::Path;

use super::sigstore::SigstoreVerifier;
use super::BundleVerifier;

const PRODUCTION_ROOT: &str = include_str!("trusted_root.json");

#[test]
#[ignore = "needs a sigstore-conformance checkout (OMARCHY_SIGSTORE_CONFORMANCE); CI runs it"]
fn conformance_vectors() {
    let root = std::env::var("OMARCHY_SIGSTORE_CONFORMANCE")
        .expect("OMARCHY_SIGSTORE_CONFORMANCE names a checkout");
    let cases = Path::new(&root).join("test/assets/bundle-verify");
    let default_artifact = std::fs::read(cases.join("a.txt")).unwrap();
    let mut dirs: Vec<_> = std::fs::read_dir(&cases)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    let (mut checked, mut skipped, mut wrong) = (0, Vec::new(), Vec::new());
    for dir in dirs {
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let bundle = std::fs::read(dir.join("bundle.sigstore.json")).unwrap();
        let text = String::from_utf8_lossy(&bundle);
        let expect_ok = !name.ends_with("_fail");
        let out_of_scope = dir.join("key.pub").exists()
            || name.starts_with("managed-key")
            || text.contains("\"dsseEnvelope\"");
        if out_of_scope && expect_ok {
            skipped.push(name);
            continue;
        }
        let artifact =
            std::fs::read(dir.join("artifact")).unwrap_or_else(|_| default_artifact.clone());
        let trusted_root = std::fs::read_to_string(dir.join("trusted_root.json"))
            .unwrap_or_else(|_| PRODUCTION_ROOT.to_owned());
        let result =
            SigstoreVerifier::with_root(&trusted_root).and_then(|v| v.verify(&artifact, &bundle));
        checked += 1;
        if result.is_ok() != expect_ok {
            wrong.push(format!(
                "{name}: expected {}, got {:?}",
                if expect_ok { "ok" } else { "a refusal" },
                result.map(|_| ())
            ));
        }
    }
    eprintln!("conformance: {checked} vectors checked; out of scope: {skipped:?}");
    assert!(
        checked >= 40,
        "only {checked} vectors: is {root} a sigstore-conformance checkout?"
    );
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
