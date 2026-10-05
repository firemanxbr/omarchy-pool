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
        &["enroll", "--pool", "http://127.0.0.1:9"],
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

/// A pool on loopback whose host calls are refused as a suspended host's (403) for the
/// first `refusals` requests, then answered as an active host's: the suspension, then
/// the owner's Resume.
fn pool_suspended_then_resumed(refusals: usize) -> String {
    use std::io::{BufRead, BufReader, Read, Write};
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", l.local_addr().unwrap());
    std::thread::spawn(move || {
        for (n, c) in l.incoming().flatten().enumerate() {
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut len = 0;
            loop {
                let mut line = String::new();
                if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let _ = r.take(len).read_to_end(&mut Vec::new());
            let (status, body) = if n < refusals {
                (403, r#"{"error":"box is suspended (by m2: fans failing)","code":"host_status","status":"suspended"}"#.to_owned())
            } else {
                (
                    200,
                    format!(
                        r#"{{"worker":"m1-box-0a9z","token":"omw_{}","rotate_after":"in 30 days"}}"#,
                        "1e".repeat(24)
                    ),
                )
            };
            let _ = (&c).write_all(
                format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes(),
            );
        }
    });
    origin
}

#[test]
fn on_a_suspended_host_the_agent_changes_nothing_and_after_a_resume_it_works_again() {
    use std::os::unix::fs::PermissionsExt;
    let data = std::env::temp_dir().join(format!(
        "omarchy-agent-suspended-cli-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&data);
    let pool = pool_suspended_then_resumed(3);
    // An enrolled machine: its identity, and the worker token its dispatcher runs with.
    let state = data.join("omarchy-agent/state");
    let etc = data.join("omarchy-agent/sets/host/etc");
    for dir in [&state, &etc] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::write(
        state.join("host.json"),
        format!(r#"{{"pool":"{pool}","host":"h_0000000001"}}"#),
    )
    .unwrap();
    let env = etc.join("dispatcher.env");
    let before = format!(
        "# worker: m1-box-0a9z\nOMARCHY_WORKER_TOKEN=omw_{}\n",
        "0f".repeat(24)
    );
    std::fs::write(&env, &before).unwrap();
    // Suspended: every call refused with the pool's words; the dispatcher's token, byte for byte, and the identity stay.
    for _ in 0..3 {
        let o = run_env(&["token"], &data, None);
        assert_eq!(o.status.code(), Some(1), "{}", text(&o));
        assert!(
            text(&o).contains("box is suspended (by m2: fans failing)"),
            "{}",
            text(&o)
        );
        assert_eq!(std::fs::read_to_string(&env).unwrap(), before);
        assert!(state.join("host.json").exists());
    }
    // Resumed on the site: the same identity and key work again, nothing done on the machine.
    let o = run_env(&["token"], &data, None);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(std::fs::read_to_string(&env)
        .unwrap()
        .contains(&format!("OMARCHY_WORKER_TOKEN=omw_{}", "1e".repeat(24))));
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
    // install and preflight need a release (install.sh passes --release); an option they do
    // not know is a usage error, a token on the command line too (#321), and the run loop's
    // commands take the one --data-dir every command takes (#317).
    let data = std::env::temp_dir().join(format!("omarchy-agent-cli-{}", std::process::id()));
    for args in [
        &["install"][..],
        &["preflight"],
        &["install", "--release", "latest"],
        &["install", "--bundle", "b.tar.gz"],
        &[
            "install",
            "--release",
            "v1.2.3",
            "--bundle",
            "b",
            "--sig",
            "s",
        ],
        &["install", "--release", "v1.2.3", "--any-option"],
        &["install", "--release", "v1.2.3", "--max-units", "many"],
        &["enroll", "--token", "ome_x"],
        &["token", "extra"],
        &["status", "--data", "/tmp"],
        &["uninstall", "extra"],
        &["runtime"],
        &["runtime", "switch"],
        &["runtime", "swap", "compose/podman"],
        &["runtime", "switch", "compose/podman", "--pool", "https://x"],
    ] {
        assert_eq!(
            run_env(args, &data, None).status.code(),
            Some(2),
            "{args:?}"
        );
    }

    assert!(!data.join("omarchy-agent").exists(), "nothing was written");

    let o = run(&["--version"]);
    assert_eq!(
        String::from_utf8_lossy(&o.stdout).trim(),
        format!("omarchy-agent {}", env!("CARGO_PKG_VERSION"))
    );
}

/// `runtime switch` (#325): a driver this binary does not carry, or a socket nothing
/// answers on, is refused at the host with nothing asked of the running agent.
#[test]
fn a_runtime_switch_the_host_cannot_make_is_refused_and_asks_nothing() {
    let data = scratch("runtime-switch");
    for (args, why) in [
        (
            &["runtime", "switch", "quadlet"][..],
            "\"quadlet\" is not a driver this agent carries: compose/docker or compose/podman",
        ),
        (
            &[
                "runtime",
                "switch",
                "compose/podman",
                "--socket",
                "/nonexistent/podman.sock",
            ],
            "nothing answers on /nonexistent/podman.sock",
        ),
        (
            &[
                "runtime",
                "switch",
                "compose/podman",
                "--socket",
                "relative/podman.sock",
            ],
            "relative/podman.sock is not a plain absolute path",
        ),
    ] {
        let o = run_env(args, &data, None);
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}", text(&o));
        assert!(text(&o).contains(why), "{args:?}: {}", text(&o));
    }
    assert!(
        !data.join("omarchy-agent/runtime-switch.json").exists(),
        "nothing was asked of the agent"
    );
}

#[test]
fn preflight_prints_one_screen_and_writes_nothing() {
    let data = scratch("preflight");
    let o = run_env(
        &[
            "preflight",
            "--bundle",
            "/nonexistent/omarchy-host.tar.gz",
            "--sig",
            "/nonexistent/omarchy-host.tar.gz.sigstore.json",
            "--socket",
            "/nonexistent/engine.sock",
            "--task-subnets",
            "10.0.0.0/33",
        ],
        &data,
        None,
    );
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    let t = text(&o);
    for want in [
        "thing(s) to fix before the install; nothing was changed",
        "/nonexistent/omarchy-host.tar.gz",
        "no container engine answers on /nonexistent/engine.sock",
        "task subnets",
    ] {
        assert!(t.contains(want), "{want}: {t}");
    }
    assert!(
        !data.join("omarchy-agent").exists(),
        "nothing was written: {t}"
    );
    let _ = std::fs::remove_dir_all(&data);
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
    let o = run(&["run", "--data-dir", &d]);
    assert_eq!(o.status.code(), Some(78), "{}", text(&o));
    assert!(text(&o).contains("agent.toml"), "{}", text(&o));
    // One that others may write is refused the same way.
    let toml = data.join("agent.toml");
    std::fs::write(&toml, "pool = \"https://pkgs.omarchy-pool.org\"\n").unwrap();
    std::fs::set_permissions(&toml, std::fs::Permissions::from_mode(0o666)).unwrap();
    let o = run(&["run", "--data-dir", &d]);
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
    let o = run(&["run", "--data-dir", &d]);
    assert_eq!(o.status.code(), Some(78), "{}", text(&o));
    assert!(text(&o).contains("state.json"), "{}", text(&o));
}

#[test]
fn status_logs_and_round_read_the_data_directory() {
    let data = scratch("status");
    let d = data.to_string_lossy().into_owned();
    let o = run(&["status", "--data-dir", &d]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(text(&o).contains("no state yet"), "{}", text(&o));

    std::fs::write(
        data.join("state.json"),
        r#"{"floor":"v1.2.0","applied":"v1.2.0","target":"v1.3.0","round":{"at":1,"outcome":"rolled-back","from":"v1.3.0","step":"revert","detail":"guard: the dispatcher exited with 1"},"quarantine":{"v1.3.0":{"until":null,"reverts":2}}}"#,
    )
    .unwrap();
    let o = run(&["status", "--data-dir", &d]);
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
    let o = run(&["logs", "--data-dir", &d, "-n", "2"]);
    assert_eq!(String::from_utf8_lossy(&o.stdout), "{\"n\":2}\n{\"n\":3}\n");
    assert_eq!(
        run(&["logs", "--data-dir", &d, "-n", "x"]).status.code(),
        Some(2)
    );

    // No agent runs here: `round` says so.
    let o = run(&["round", "--data-dir", &d]);
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
        .args(["run", "--data-dir", &d])
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
    let o = run(&["round", "--data-dir", &d]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(wait(2), "SIGUSR1 started no poll");
    assert!(child.try_wait().unwrap().is_none(), "the agent stopped");
    let o = run(&["status", "--data-dir", &d]);
    assert!(text(&o).contains("pool:      no-answer"), "{}", text(&o));
    child.kill().unwrap();
    child.wait().unwrap();
}

/// A data directory laid out as install.sh and a self-update leave it (#316): this binary
/// as `versions/<its version>/`, a stand-in older agent, `current` at this one and
/// `pending` from the older one with `tries` starts counted.
fn swapped(name: &str, tries: u32) -> (PathBuf, String) {
    let data = scratch(name);
    let me = env!("CARGO_PKG_VERSION");
    for v in [me, "0.0.1"] {
        std::fs::create_dir_all(data.join("versions").join(v)).unwrap();
    }
    std::fs::copy(
        env!("CARGO_BIN_EXE_omarchy-agent"),
        data.join("versions").join(me).join("omarchy-agent"),
    )
    .unwrap();
    std::os::unix::fs::symlink(format!("versions/{me}"), data.join("current")).unwrap();
    std::fs::write(
        data.join("pending"),
        format!("from=0.0.1 to={me} tries={tries} deadline=99999999999\n"),
    )
    .unwrap();
    let d = data.to_string_lossy().into_owned();
    (data, d)
}

fn current(data: &Path) -> String {
    std::fs::read_link(data.join("current"))
        .unwrap()
        .display()
        .to_string()
}

#[test]
fn a_new_agent_counts_its_start_before_its_configuration_and_its_third_rolls_back() {
    // Its third start: counted first, then current points back, with nothing else read.
    let (data, d) = swapped("third", 2);
    let o = Command::new(data.join("current/omarchy-agent"))
        .args(["run", "--data-dir", &d])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(text(&o).contains("3 starts"), "{}", text(&o));
    assert_eq!(current(&data), "versions/0.0.1");
    assert!(std::fs::read_to_string(data.join("pending"))
        .unwrap()
        .contains("tries=3"));

    // A configuration the new agent refuses is a failed start, not exit 78 (which the
    // service manager would leave stopped): counted, and current points back at once.
    let (data, d) = swapped("config", 0);
    let o = run(&["run", "--data-dir", &d]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert!(
        text(&o).contains("refused its configuration"),
        "{}",
        text(&o)
    );
    assert_eq!(current(&data), "versions/0.0.1");
    assert!(std::fs::read_to_string(data.join("pending"))
        .unwrap()
        .contains("tries=1"));

    // `status` shows the update in flight.
    let (_, d) = swapped("status-pending", 1);
    let o = run(&["status", "--data-dir", &d]);
    assert!(
        text(&o).contains("update:    agent 0.0.1 to"),
        "{}",
        text(&o)
    );
}

#[test]
fn self_test_says_ok_only_when_it_verified_the_release() {
    let data = scratch("self-test");
    let d = data.to_string_lossy().into_owned();
    let toml = data.join("agent.toml");
    std::fs::write(
        &toml,
        "pool = \"https://pkgs.omarchy-pool.org\"\nhost_id = \"h_1\"\nworker_id = \"w_1\"\n[set]\ndir = \"/srv/set\"\nwork_root = \"/srv/work\"\nsecrets_dir = \"/srv/secrets\"\nsocket_cli = \"/var/run/docker.sock\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&toml, std::fs::Permissions::from_mode(0o600)).unwrap();
    // No bundle of that release here.
    let o = run(&["self-test", "--data-dir", &d, "--release", "v1.2.3"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(
        text(&o).contains("omarchy-host-v1.2.3.tar.gz"),
        "{}",
        text(&o)
    );
    assert!(!String::from_utf8_lossy(&o.stdout).contains("ok"));
    // One that does not verify (a signature by nobody).
    let bundles = data.join("bundles");
    std::fs::create_dir_all(&bundles).unwrap();
    std::fs::write(bundles.join("omarchy-host-v1.2.3.tar.gz"), b"archive").unwrap();
    std::fs::write(
        bundles.join("omarchy-host-v1.2.3.tar.gz.sigstore.json"),
        b"{}",
    )
    .unwrap();
    let o = run(&["self-test", "--data-dir", &d, "--release", "v1.2.3"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("refused"), "{}", text(&o));
    // Usage.
    assert_eq!(run(&["self-test", "--data-dir", &d]).status.code(), Some(2));
    let o = run(&["self-test", "--data-dir", &d, "--release", "latest"]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
}

/// A docker CLI stand-in: `info` prints `$STUB_INFO`, `run` prints `$STUB_RUN` (and fails
/// when `$STUB_REFUSE_LIMITS` is set and limits were asked for), every call is logged.
fn stub_docker(dir: &Path) -> String {
    let path = dir.join("docker");
    std::fs::write(
        &path,
        r#"#!/bin/sh
echo "$*" >> "$STUB_LOG"
case " $* " in
  *" info "*) [ -n "$STUB_INFO" ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
              printf '%s\n' "$STUB_INFO" ;;
  *" run "*) case " $* " in *" --memory "*) [ -z "$STUB_REFUSE_LIMITS" ] || { echo "cgroup not delegated" >&2; exit 125; } ;; esac
             printf '%s\n' "$STUB_RUN" ;;
  *) exit 2 ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

fn info(root_dir: &str, extra: &str) -> String {
    format!(
        r#"{{"NCPU":12,"MemTotal":33443418112,"DockerRootDir":"{root_dir}","Architecture":"aarch64",
"CgroupVersion":"2","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true{extra}}}"#
    )
}

fn capacity(dir: &Path, env: &[(&str, &str)], args: &[&str]) -> (Output, serde_json::Value) {
    let docker = stub_docker(dir);
    let work = dir.to_string_lossy().into_owned();
    let mut c = Command::new(env!("CARGO_BIN_EXE_omarchy-agent"));
    c.args(["capacity", "--docker", &docker, "--work-root", &work])
        .args(args)
        .env("STUB_LOG", dir.join("log"))
        .env_remove("STUB_INFO")
        .env_remove("STUB_RUN")
        .env_remove("STUB_REFUSE_LIMITS");
    for (k, v) in env {
        c.env(k, v);
    }
    let o = c.output().unwrap();
    let v = serde_json::from_slice(&o.stdout).unwrap_or(serde_json::Value::Null);
    (o, v)
}

#[test]
fn capacity_reports_both_disks_on_a_visible_engine_root_and_through_a_probe_container() {
    let dir = std::env::temp_dir().join(format!("omarchy-agent-cap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let here = dir.to_string_lossy().into_owned();

    // Rootful docker: the data root is visible here, so statvfs reads both disks.
    let (o, v) = capacity(&dir, &[("STUB_INFO", &info(&here, ""))], &[]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    // The engine's view, or less where this test's own cgroup is limited (a CI runner).
    assert_eq!(v["engine"]["cpus"], 12, "{v}");
    assert_eq!(v["engine"]["mem_gb"], 31, "{v}");
    assert!(
        v["cpus"].as_u64().is_some_and(|c| (1..=12).contains(&c)),
        "{v}"
    );
    assert!(v["disk_free_gb"]["work"].as_u64().is_some(), "{v}");
    assert!(v["disk_free_gb"]["engine"].as_u64().is_some(), "{v}");
    assert_eq!(v["isolation"], "root");
    assert_eq!(v["arch"], "aarch64");

    // Rootless podman whose storage this process cannot see: the probe container measures
    // it, and shows whether the three limits landed in its cgroup.
    let podman = info(
        "/nonexistent/containers/storage",
        r#","SecurityOptions":["name=rootless"]"#,
    );
    let probe = "cpu.max=50000 100000\nmemory.max=max\npids.max=32\n\
                 overlay 482344960 1 230686720 1% /";
    let (o, v) = capacity(
        &dir,
        &[("STUB_INFO", &podman), ("STUB_RUN", probe)],
        &["--probe-image", "docker.io/library/busybox@sha256:00"],
    );
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert_eq!(v["disk_free_gb"]["engine"], 220, "{v}");
    assert_eq!(v["isolation"], "user");
    assert_eq!(
        v["limits"],
        serde_json::json!({"cpus_hard": true, "memory_hard": false, "pids": true})
    );
    let log = std::fs::read_to_string(dir.join("log")).unwrap();
    assert!(
        log.contains("run --rm --network none --cpus 0.5 --memory 64m --pids-limit 32"),
        "{log}"
    );

    // Podman's API says `CpuCfsQuota: false` while `--cpus` lands: the probe's cgroup wins.
    let (o, v) = capacity(
        &dir,
        &[
            (
                "STUB_INFO",
                &podman.replace(r#""CpuCfsQuota":true"#, r#""CpuCfsQuota":false"#),
            ),
            ("STUB_RUN", probe),
        ],
        &["--probe-image", "img"],
    );
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert_eq!(v["limits"]["cpus_hard"], true, "{v}");

    // A runtime that refuses the limits outright: none holds, and the disk is still read.
    let (o, v) = capacity(
        &dir,
        &[
            ("STUB_INFO", &podman),
            ("STUB_RUN", probe),
            ("STUB_REFUSE_LIMITS", "1"),
        ],
        &["--probe-image", "img"],
    );
    assert_eq!(o.status.code(), Some(0), "{}", text(&o));
    assert_eq!(v["disk_free_gb"]["engine"], 220, "{v}");
    assert_eq!(
        v["limits"],
        serde_json::json!({"cpus_hard": false, "memory_hard": false, "pids": false})
    );

    // Not visible and no probe image: no answer, so nothing changes.
    let (o, _) = capacity(&dir, &[("STUB_INFO", &podman)], &[]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("not visible from here"), "{}", text(&o));
    assert!(text(&o).contains("nothing was changed"), "{}", text(&o));

    // An engine that does not answer.
    let (o, _) = capacity(&dir, &[], &[]);
    assert_eq!(o.status.code(), Some(1), "{}", text(&o));
    assert!(text(&o).contains("docker info"), "{}", text(&o));

    // Units, preflight and capacity.json need a verified release.
    let (o, _) = capacity(
        &dir,
        &[("STUB_INFO", &info(&here, ""))],
        &["--write", &here],
    );
    assert_eq!(o.status.code(), Some(2), "{}", text(&o));
    assert!(!dir.join("run").exists());
    let o = run(&["capacity"]);
    assert_eq!(o.status.code(), Some(2), "{}", text(&o));
    assert!(text(&o).contains("--work-root"), "{}", text(&o));
    std::fs::remove_dir_all(&dir).unwrap();
}
