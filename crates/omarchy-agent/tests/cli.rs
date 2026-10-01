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

/// The binary with its data directory under `data` (`XDG_DATA_HOME`) and, when given, an
/// enrollment token in its environment.
fn run_env(args: &[&str], data: &Path, enroll: Option<&str>) -> Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_omarchy-agent"));
    c.args(args)
        .env("XDG_DATA_HOME", data)
        .env_remove("OMARCHY_ENROLL");
    if let Some(t) = enroll {
        c.env("OMARCHY_ENROLL", t);
    }
    c.output().unwrap()
}

#[test]
fn enroll_needs_the_token_in_the_environment_and_a_capacity_report_before_it_sends_anything() {
    let data =
        std::env::temp_dir().join(format!("omarchy-agent-enroll-cli-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let o = run_env(&["enroll", "--pool", "http://127.0.0.1:9"], &data, None);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(
        text(&o).contains("OMARCHY_ENROLL is not set"),
        "{}",
        text(&o)
    );
    let token = format!("ome_{}", "ab".repeat(24));
    let o = run_env(
        &["install", "--pool", "http://127.0.0.1:9"],
        &data,
        Some(&token),
    );
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("capacity.json"), "{}", text(&o));
    // The token is never printed; the key was made, 0600, and nothing else claims an identity.
    assert!(!text(&o).contains(&token));
    let key = data.join("omarchy-agent/state/host.ed25519");
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&key).unwrap().permissions())
            & 0o777,
        0o600
    );
    assert!(!data.join("omarchy-agent/state/host.json").exists());
    // A pool over plain http elsewhere than this machine is refused.
    let o = run_env(
        &["enroll", "--pool", "http://pkgs.omarchy-pool.org"],
        &data,
        Some(&token),
    );
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    // Rotating needs an enrolled machine.
    let o = run_env(&["token"], &data, None);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("has not enrolled"), "{}", text(&o));
    let _ = std::fs::remove_dir_all(&data);
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

    // #312: a dispatcher whose build image is a tag, not the release's digest.
    let o = run(&[
        "lint-set",
        &fx("lint/host"),
        "--override",
        &fx("lint/override/build-image-tag.yml"),
    ]);
    assert_eq!(o.status.code(), Some(1));
    assert!(
        text(&o).contains("build_images:") && text(&o).contains("OMARCHY_BUILD_IMAGE_X86_64"),
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
fn lint_set_is_clean_on_the_real_host_set_and_reads_its_set_toml() {
    let real = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../factory/sets/host");
    let real = real.to_string_lossy();
    let o = run(&["lint-set", &real]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(text(&o).contains(": clean"), "{}", text(&o));
    let o = run(&[
        "lint-set",
        &real,
        "--override",
        &fx("lint/override/second-service.yml"),
    ]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("services:"), "{}", text(&o));

    // A set directory without set.toml cannot be read as a set: a usage error, not a lint.
    let tmp = std::env::temp_dir().join(format!("omarchy-agent-cli-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::copy(
        fixtures().join("lint/host/compose.yml"),
        tmp.join("compose.yml"),
    )
    .unwrap();
    let o = run(&["lint-set", &tmp.to_string_lossy()]);
    assert_eq!(o.status.code(), Some(2), "{}", text(&o));
    assert!(text(&o).contains("set.toml"), "{}", text(&o));
    // One that disagrees with its template is refused under set_toml.
    std::fs::write(
        tmp.join("set.toml"),
        std::fs::read_to_string(fixtures().join("lint/host/set.toml"))
            .unwrap()
            .replace("schema = 3", "schema = 2"),
    )
    .unwrap();
    let o = run(&["lint-set", &tmp.to_string_lossy()]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(
        text(&o).contains("set_toml: set.toml: schema must be 3"),
        "{}",
        text(&o)
    );
    std::fs::remove_dir_all(&tmp).unwrap();
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
    // A file that cannot be read is not a refused template.
    let host = fx("lint/host");
    for args in [
        &["lint-set", "/nonexistent"][..],
        &["lint-set", &host, "--override", "/nonexistent.yml"],
        &["lint-set", &host, "--envelope", "/nonexistent.toml"],
    ] {
        let o = run(args);
        assert_eq!(o.status.code(), Some(2), "{args:?}: {}", text(&o));
    }
    // install.sh's last step: without a token or an identity it changes nothing yet (#317);
    // an option it does not know is a usage error, a token on the command line too (#321).
    let data = std::env::temp_dir().join(format!("omarchy-agent-cli-{}", std::process::id()));
    let o = run_env(&["install"], &data, None);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(text(&o).contains("arrives in P1"), "{}", text(&o));
    assert!(!data.join("omarchy-agent").exists(), "nothing was written");
    for args in [
        &["install", "--any-option"][..],
        &["enroll", "--token", "ome_x"],
        &["token", "extra"],
    ] {
        assert_eq!(
            run_env(args, &data, None).status.code(),
            Some(2),
            "{args:?}"
        );
    }

    let o = run(&["--version"]);
    assert_eq!(
        String::from_utf8_lossy(&o.stdout).trim(),
        format!("omarchy-agent {}", env!("CARGO_PKG_VERSION"))
    );
}
