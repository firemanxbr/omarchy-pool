//! The binary as release.yml and a person run it: exit status and what it prints.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_omarchy-agent"))
        .args(args)
        .output()
        .unwrap()
}

fn text(o: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

fn fx(rel: &str) -> String {
    fixtures().join(rel).to_string_lossy().into_owned()
}

#[test]
fn lint_set_is_clean_on_the_host_set_and_names_each_violation() {
    let o = run(&["lint-set", &fx("lint/host")]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    let o = run(&[
        "lint-set",
        &fx("lint/host"),
        "--envelope",
        &fx("lint/envelope/studio.toml"),
    ]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));

    let o = run(&[
        "lint-set",
        &fx("lint/host"),
        "--override",
        &fx("lint/override/github-token.yml"),
    ]);
    assert_eq!(o.status.code(), Some(1));
    assert!(
        text(&o).contains("secret_interpolation: ${GITHUB_TOKEN}"),
        "{}",
        text(&o)
    );

    let o = run(&[
        "lint-set",
        &fx("lint/host"),
        "--envelope",
        &fx("lint/envelope/no-socket.toml"),
    ]);
    assert_eq!(o.status.code(), Some(1));
    assert!(text(&o).contains("socket:"), "{}", text(&o));
}

#[test]
fn verify_checks_the_signature_before_it_reads_anything() {
    let artifact = fx("release-v1.0.5/artifact");
    let sig = fx("release-v1.0.5/bundle.sigstore.json");
    // A real release.yml signing on main: signature and pins hold, so the content is read,
    // and this artifact (the image signature's payload) is not a bundle archive.
    let o = run(&["verify", "--bundle", &artifact, "--sig", &sig]);
    assert_eq!(o.status.code(), Some(1));
    assert!(
        text(&o).contains("refused (bundle): bundle: bundle is not a gzip archive"),
        "{}",
        text(&o)
    );
    // The same signing is no rollback statement: refused on the pin, content unread.
    let o = run(&["verify", "--statement", &artifact, "--sig", &sig]);
    assert_eq!(o.status.code(), Some(1));
    assert!(text(&o).contains("refused (workflow)"), "{}", text(&o));
    // Another artifact under that signature.
    let o = run(&[
        "verify",
        "--bundle",
        &fx("manifest/v2-example.json"),
        "--sig",
        &sig,
    ]);
    assert_eq!(o.status.code(), Some(1));
    assert!(text(&o).contains("refused (signature)"), "{}", text(&o));
}

#[test]
fn usage_errors_exit_2() {
    for args in [
        &["verify", "--bundle", "x"][..],
        &["verify", "--bundle", "a", "--statement", "b", "--sig", "c"],
        &["lint-set"],
        &["lint-set", "a", "b"],
        &["lint-set", "a", "--override"],
        &["frobnicate"],
    ] {
        assert_eq!(run(args).status.code(), Some(2), "{args:?}");
    }
    let o = run(&["--version"]);
    assert_eq!(
        String::from_utf8_lossy(&o.stdout).trim(),
        format!("omarchy-agent {}", env!("CARGO_PKG_VERSION"))
    );
}
