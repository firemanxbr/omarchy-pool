//! The binary as release.yml and a person run it: exit status and what it prints.

use std::os::unix::fs::PermissionsExt;
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
    // install.sh's last step: a stub until P1 that changes nothing.
    let o = run(&["install", "--any-option"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(text(&o).contains("arrives in P1"), "{}", text(&o));

    let o = run(&["--version"]);
    assert_eq!(
        String::from_utf8_lossy(&o.stdout).trim(),
        format!("omarchy-agent {}", env!("CARGO_PKG_VERSION"))
    );
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("omarchy-agent-cli-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn run_stops_with_78_on_a_local_configuration_error_only() {
    let data = scratch("run");
    let d = data.to_string_lossy().into_owned();
    // No agent.toml: nothing the network could fix.
    let o = run(&["run", "--data", &d]);
    assert_eq!(o.status.code(), Some(78), "{}", text(&o));
    assert!(text(&o).contains("agent.toml"), "{}", text(&o));
    // One that others may write is refused the same way.
    let toml = data.join("agent.toml");
    std::fs::write(&toml, "pool = \"https://pkgs.omarchy-pool.org\"\n").unwrap();
    std::fs::set_permissions(&toml, std::fs::Permissions::from_mode(0o666)).unwrap();
    let o = run(&["run", "--data", &d]);
    assert_eq!(o.status.code(), Some(78), "{}", text(&o));
    assert!(text(&o).contains("writable"), "{}", text(&o));
    // A state.json that is there but unreadable is not "start from nothing".
    std::fs::set_permissions(&toml, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(
        &toml,
        "pool = \"https://pkgs.omarchy-pool.org\"\nhost_id = \"h_1\"\nworker_id = \"w_1\"\n[set]\ndir = \"/srv/set\"\nwork_root = \"/srv/work\"\nsecrets_dir = \"/srv/secrets\"\nsocket_cli = \"/var/run/docker.sock\"\n",
    )
    .unwrap();
    std::fs::write(data.join("state.json"), "{\"floor\": \"latest\"}").unwrap();
    let o = run(&["run", "--data", &d]);
    assert_eq!(o.status.code(), Some(78), "{}", text(&o));
    assert!(text(&o).contains("state.json"), "{}", text(&o));
}

#[test]
fn status_logs_and_round_read_the_data_directory() {
    let data = scratch("status");
    let d = data.to_string_lossy().into_owned();
    let o = run(&["status", "--data", &d]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(text(&o).contains("no state yet"), "{}", text(&o));

    std::fs::write(
        data.join("state.json"),
        r#"{"floor":"v1.2.0","applied":"v1.2.0","target":"v1.3.0","round":{"at":1,"outcome":"rolled-back","from":"v1.3.0","step":"revert","detail":"guard: the dispatcher exited with 1"},"quarantine":{"v1.3.0":{"until":null,"reverts":2}}}"#,
    )
    .unwrap();
    let o = run(&["status", "--data", &d]);
    let t = text(&o);
    assert_eq!(o.status.code(), Some(0), "{t}");
    assert!(
        t.contains("applied v1.2.0, target v1.3.0, floor v1.2.0"),
        "{t}"
    );
    assert!(
        t.contains("rolled-back") && t.contains("from v1.3.0"),
        "{t}"
    );
    assert!(t.contains("v1.3.0 until a newer release"), "{t}");

    std::fs::write(
        data.join("journal.ndjson"),
        "{\"n\":1}\n{\"n\":2}\n{\"n\":3}\n",
    )
    .unwrap();
    let o = run(&["logs", "--data", &d, "-n", "2"]);
    assert_eq!(String::from_utf8_lossy(&o.stdout), "{\"n\":2}\n{\"n\":3}\n");
    assert_eq!(
        run(&["logs", "--data", &d, "-n", "x"]).status.code(),
        Some(2)
    );

    // No agent runs here: `round` says so.
    let o = run(&["round", "--data", &d]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("is the agent running?"), "{}", text(&o));
}

#[test]
fn run_keeps_running_with_no_pool_and_round_asks_it_again() {
    let data = scratch("loop");
    let d = data.to_string_lossy().into_owned();
    let toml = data.join("agent.toml");
    // A pool that refuses connections: no answer, which never stops the agent.
    std::fs::write(
        &toml,
        format!(
            "pool = \"https://127.0.0.1:9\"\nhost_id = \"h_1\"\nworker_id = \"w_1\"\n[set]\ndir = \"{0}/set\"\nwork_root = \"{0}/work\"\nsecrets_dir = \"{0}/secrets\"\nsocket_cli = \"{0}/no.sock\"\n",
            data.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&toml, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_omarchy-agent"))
        .args(["run", "--data", &d])
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let journal = data.join("journal.ndjson");
    let polls = || {
        std::fs::read_to_string(&journal)
            .unwrap_or_default()
            .matches("pool-unreachable")
            .count()
    };
    let wait = |n: usize| {
        for _ in 0..100 {
            if polls() >= n {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        false
    };
    assert!(
        wait(1),
        "no first poll: {:?}",
        std::fs::read_to_string(&journal)
    );
    let o = run(&["round", "--data", &d]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(wait(2), "SIGUSR1 started no poll");
    assert!(child.try_wait().unwrap().is_none(), "the agent stopped");
    let o = run(&["status", "--data", &d]);
    assert!(text(&o).contains("pool:      no-answer"), "{}", text(&o));
    child.kill().unwrap();
    child.wait().unwrap();
}
