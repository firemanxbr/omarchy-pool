//! #316's acceptance criteria against the fake engine and pool: the version rule, the
//! download, the self-test (a real child process), the swap, the counted starts, the
//! health gate and the rollback. `tests/agent-self-update.sh` runs real builds under a
//! real `systemd --user`.

use std::fs;
use std::path::Path;

use super::{count_start, Pending, Start, DEADLINE_S, MAX_TRIES};
use crate::run::fake::{publish_agent, relay_statement_agent, Ships, World};
use crate::run::pool::{Follow, Net};
use crate::run::state::State;
use crate::version::{self, Release, Version};

fn me() -> Version {
    version::agent()
}

/// An agent version above this one by `minor` minors.
fn above(minor: u64) -> Version {
    Version(me().0, me().1 + minor, 0)
}

/// What a new agent's binary does in these tests: answers `self-test --data <dir>
/// --release <vX.Y.Z>`, and nothing else.
fn binary(ok: bool) -> Vec<u8> {
    let answer = if ok {
        "echo ok; exit 0"
    } else {
        "echo 'agent.toml: no'; exit 1"
    };
    format!(
        "#!/bin/sh\n[ \"$1 $2 $4\" = 'self-test --data --release' ] && {{ {answer}; }}\nexit 2\n"
    )
    .into_bytes()
}

fn link(path: &Path) -> String {
    fs::read_link(path)
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

/// A host on v1.0.0 with the agent installed as install.sh does, and v1.1.0 published
/// shipping `ships` with `min_agent`.
fn host_with(ships: Version, min_agent: &str, bin: &[u8]) -> World {
    let mut w = World::running_v1();
    w.install_layout();
    publish_agent(
        &w.remote,
        "v1.1.0",
        &Ships {
            version: &ships.to_string(),
            min_agent,
            binary: bin,
        },
    );
    w.follow("v1.1.0", None);
    w
}

#[test]
fn pending_is_one_line_and_a_start_is_counted_before_anything_else() {
    let p = Pending {
        from: Version(0, 2, 0),
        to: Version(0, 3, 0),
        tries: 1,
        deadline: 1_800_000_600,
    };
    assert_eq!(
        p.render(),
        "from=0.2.0 to=0.3.0 tries=1 deadline=1800000600\n"
    );
    assert_eq!(Pending::parse(&p.render()), Some(p.clone()));
    for bad in [
        "",
        "from=0.2.0 to=0.3.0 tries=1",
        "from=x to=0.3.0 tries=1 deadline=1",
    ] {
        assert_eq!(Pending::parse(bad), None, "{bad:?}");
    }

    let dir = crate::run::state::tempdir();
    fs::create_dir_all(dir.join("versions/0.2.0")).unwrap();
    std::os::unix::fs::symlink("versions/0.3.0", dir.join("current")).unwrap();
    // No pending, or one for another agent: nothing is counted.
    assert_eq!(count_start(&dir, Version(0, 3, 0), 10), Start::Run);
    let other = Pending {
        to: Version(0, 4, 0),
        tries: 0,
        ..p.clone()
    };
    fs::write(dir.join("pending"), other.render()).unwrap();
    assert_eq!(count_start(&dir, Version(0, 3, 0), 10), Start::Run);
    assert_eq!(
        fs::read_to_string(dir.join("pending")).unwrap(),
        other.render()
    );

    // The candidate: its first two starts are counted, its third points current back.
    let mine = Pending {
        tries: 0,
        deadline: 100,
        ..p.clone()
    };
    fs::write(dir.join("pending"), mine.render()).unwrap();
    for n in 1..=MAX_TRIES {
        assert_eq!(count_start(&dir, Version(0, 3, 0), 10), Start::Run);
        let now = Pending::parse(&fs::read_to_string(dir.join("pending")).unwrap()).unwrap();
        assert_eq!(now.tries, n);
        assert_eq!(link(&dir.join("current")), "versions/0.3.0");
    }
    match count_start(&dir, Version(0, 3, 0), 10) {
        Start::RolledBack(why) => assert!(why.contains("3 starts"), "{why}"),
        Start::Run => panic!("the third start was not rolled back"),
    }
    assert_eq!(link(&dir.join("current")), "versions/0.2.0");

    // A start past the deadline rolls back at once.
    fs::remove_file(dir.join("current")).unwrap();
    std::os::unix::fs::symlink("versions/0.3.0", dir.join("current")).unwrap();
    fs::write(dir.join("pending"), mine.render()).unwrap();
    match count_start(&dir, Version(0, 3, 0), 101) {
        Start::RolledBack(why) => assert!(why.contains("10 minutes"), "{why}"),
        Start::Run => panic!("a start past the deadline ran"),
    }
    assert_eq!(link(&dir.join("current")), "versions/0.2.0");
}

#[test]
fn a_release_with_a_higher_agent_updates_the_agent_first_and_the_same_one_does_not_restart_it() {
    let new = above(7);
    let mut w = host_with(new, "0.1.0", &binary(true));
    let changes = w.changes().len();
    let task = w.engine.borrow().tasks()[0].clone();

    // The poll finds v1.1.0 shipping a higher agent: it updates itself before the round.
    w.tick(200);
    assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
    assert_eq!(w.step(), "idle", "the round waits for the new agent");
    let data = w.agent.paths.data.clone();
    let p = Pending::parse(&fs::read_to_string(data.join("pending")).unwrap()).unwrap();
    assert_eq!((p.from, p.to, p.tries), (me(), new, 0));
    assert!((p.deadline - w.now - DEADLINE_S).abs() <= 1);
    assert_eq!(link(&data.join("current")), format!("versions/{new}"));
    assert_eq!(
        link(&data.join("previous")),
        format!("versions/{me}", me = me())
    );
    let installed = w.agent.paths.binary(new);
    assert_eq!(fs::read(&installed).unwrap(), binary(true));
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&installed).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
    // The state was saved before the exit; no container was touched.
    assert!(crate::run::state::load(&w.agent.paths.state())
        .unwrap()
        .is_some());
    assert_eq!(w.changes().len(), changes);

    // The service manager starts `current`: the new agent counts its start, keeps its
    // health gate shut for the rollout, and opens it after one verify + observe + report.
    assert_eq!(count_start(&data, new, w.now), Start::Run);
    w.restart_as(new);
    assert!(w.agent.gate.is_some());
    let follows = w.remote.borrow().follows;
    w.tick(1);
    assert!(w.agent.gate.is_none(), "{}", w.journal());
    assert!(!data.join("pending").exists());
    assert!(w.journal().contains("\"event\":\"agent-updated\""));
    assert_eq!(w.remote.borrow().follows, follows + 1, "the gate's report");
    assert_eq!(w.changes().len(), changes, "the gate touched nothing");

    // Then the round: v1.1.0 ships this agent's version, so nothing restarts it.
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{:?}", w.outcome());
    assert_eq!(w.agent.exit, None);
    assert_eq!(w.agent.state.agent, crate::AGENT_VERSION);
    let t = w.engine.borrow().tasks()[0].clone();
    assert_eq!(
        (t.id, t.started_at, t.status.as_str()),
        (task.id, task.started_at, "running")
    );

    // A later release with the same agent rolls out with no update at all.
    publish_agent(
        &w.remote,
        "v1.2.0",
        &Ships {
            version: &new.to_string(),
            min_agent: "0.1.0",
            binary: &binary(true),
        },
    );
    w.follow("v1.2.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"));
    assert_eq!(w.agent.exit, None);
    assert_eq!(link(&data.join("current")), format!("versions/{new}"));
}

#[test]
fn a_bundle_only_a_higher_agent_reads_updates_the_agent_from_its_outer_layer() {
    let new = above(3);
    let mut w = host_with(new, &new.to_string(), &binary(true));
    w.tick(200);
    assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
    assert_eq!(link(&w.agent.paths.current()), format!("versions/{new}"));
    // The bundle was kept for the new agent's self-test and gate.
    assert!(w
        .agent
        .paths
        .bundles()
        .join("omarchy-host-v1.1.0.tar.gz")
        .exists());
}

#[test]
fn a_wrong_hash_or_a_failing_self_test_changes_nothing_and_this_agent_applies_the_release() {
    for (what, bin) in [("SHA-256", None), ("self-test", Some(binary(false)))] {
        let new = above(1);
        let mut w = host_with(new, "0.1.0", &binary(true));
        let asset = w
            .remote
            .borrow()
            .assets
            .keys()
            .find(|k| k.starts_with("v1.1.0/omarchy-agent-"))
            .unwrap()
            .clone();
        // The asset served differs from the one the signed manifest lists.
        let served = bin
            .clone()
            .unwrap_or_else(|| b"#!/bin/sh\necho ok\n".to_vec());
        w.remote.borrow_mut().assets.insert(asset, served);
        if let Some(b) = &bin {
            // A matching hash, but a binary whose self-test fails.
            publish_agent(
                &w.remote,
                "v1.1.0",
                &Ships {
                    version: &new.to_string(),
                    min_agent: "0.1.0",
                    binary: b,
                },
            );
        }
        w.round();
        assert_eq!(w.agent.exit, None, "{what}");
        assert!(!w.agent.paths.pending().exists(), "{what}");
        assert_eq!(
            link(&w.agent.paths.current()),
            format!("versions/{}", me()),
            "{what}"
        );
        assert!(w.journal().contains(what), "{what}: {}", w.journal());
        // This agent's min_agent admits the release: it applies it meanwhile.
        assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{what}");
        if bin.is_none() {
            assert!(!w.agent.paths.binary(new).exists(), "nothing was installed");
        }
        // Not tried again at every poll (the next release ships the same agent): after
        // an hour, when it is.
        let journal = w.journal().matches("not updated").count();
        let ships = Ships {
            version: &new.to_string(),
            min_agent: "0.1.0",
            binary: &binary(true),
        };
        publish_agent(&w.remote, "v1.2.0", &ships);
        w.follow("v1.2.0", None);
        w.round();
        assert_eq!(
            w.journal().matches("not updated").count(),
            journal,
            "{what}"
        );
        assert_eq!(
            (w.applied().as_deref(), w.agent.exit),
            (Some("v1.2.0"), None)
        );
        publish_agent(&w.remote, "v1.3.0", &ships);
        w.follow("v1.3.0", None);
        w.tick(3600);
        assert_eq!(w.agent.exit, Some(0), "{what}: {}", w.journal());
    }
}

#[test]
fn a_failed_update_is_tried_again_for_the_same_release_after_an_hour_or_a_restart() {
    for after_restart in [false, true] {
        let new = above(1);
        let mut w = host_with(new, "0.1.0", &binary(true));
        let asset = w
            .remote
            .borrow()
            .assets
            .keys()
            .find(|k| k.starts_with("v1.1.0/omarchy-agent-"))
            .unwrap()
            .clone();
        // One download fails: this agent applies v1.1.0 meanwhile.
        let good = w.remote.borrow_mut().assets.remove(&asset).unwrap();
        w.round();
        assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
        assert_eq!(w.agent.exit, None);
        assert_eq!(w.journal().matches("not updated").count(), 1);
        // The asset is there again; the pool still names v1.1.0.
        w.remote.borrow_mut().assets.insert(asset, good);
        w.tick(120);
        w.tick(120);
        assert_eq!(w.agent.exit, None, "not at every poll");
        assert_eq!(w.journal().matches("not updated").count(), 1);
        if after_restart {
            w.restart();
            w.agent.exe = Some(w.agent.paths.binary(me()));
            // The next poll (120 s with its jitter), well within the hour.
            w.tick(150);
        } else {
            w.tick(3600);
        }
        assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
        assert_eq!(link(&w.agent.paths.current()), format!("versions/{new}"));
        assert!(w.agent.paths.pending().exists());
    }
}

#[test]
fn a_binary_with_the_right_hash_and_the_wrong_mode_is_made_executable() {
    use std::os::unix::fs::PermissionsExt;
    let new = above(1);
    let mut w = host_with(new, "0.1.0", &binary(true));
    // A crash between the write and the chmod left this behind.
    let bin = w.agent.paths.binary(new);
    fs::create_dir_all(bin.parent().unwrap()).unwrap();
    fs::write(&bin, binary(true)).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o644)).unwrap();
    w.tick(200);
    assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
    assert_eq!(
        fs::metadata(&bin).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[test]
fn a_self_update_needs_the_layout_install_sh_makes() {
    let new = above(1);
    let mut w = host_with(new, "0.1.0", &binary(true));
    w.agent.exe = Some(w.dir.join("somewhere/omarchy-agent"));
    w.round();
    assert_eq!(w.agent.exit, None);
    assert!(
        w.journal().contains("as install.sh installs it"),
        "{}",
        w.journal()
    );
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
}

#[test]
fn a_new_agent_that_fails_its_gate_is_rolled_back_skipped_and_reported() {
    let new = above(2);
    let mut w = host_with(new, "0.1.0", &binary(true));
    w.tick(200);
    assert_eq!(w.agent.exit, Some(0));
    let data = w.agent.paths.data.clone();
    let changes = w.changes().len();

    // The new build dies at every start (a panic at config load): its starts are
    // counted, the third points current back at this agent.
    assert_eq!(count_start(&data, new, w.now + 5), Start::Run);
    assert_eq!(count_start(&data, new, w.now + 10), Start::Run);
    assert!(matches!(
        count_start(&data, new, w.now + 15),
        Start::RolledBack(_)
    ));
    assert_eq!(link(&data.join("current")), format!("versions/{}", me()));

    // The agent it rolled back to records the skip and reports agent-rollback.
    w.restart_as(me());
    assert!(w.agent.gate.is_none());
    assert!(!data.join("pending").exists());
    assert_eq!(w.agent.state.agent_skip, Some(new));
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "agent-rollback");
    assert!(
        detail.contains("3 starts") && detail.contains("skipped until a higher"),
        "{detail}"
    );
    let saved = crate::run::state::load(&w.agent.paths.state())
        .unwrap()
        .unwrap();
    assert_eq!(
        (saved.agent_skip, saved.round.outcome.as_str()),
        (Some(new), "agent-rollback")
    );
    assert_eq!(
        w.changes().len(),
        changes,
        "no container touched by the rollback"
    );

    // The skipped version is not tried again: this agent applies the release itself.
    w.round();
    assert_eq!(w.agent.exit, None);
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    assert!(w.journal().contains("agent-skipped"));

    // A higher one updates again.
    let higher = above(3);
    publish_agent(
        &w.remote,
        "v1.2.0",
        &Ships {
            version: &higher.to_string(),
            min_agent: "0.1.0",
            binary: &binary(true),
        },
    );
    w.follow("v1.2.0", None);
    w.tick(200);
    assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
    assert_eq!(link(&data.join("current")), format!("versions/{higher}"));
}

#[test]
fn a_new_agent_whose_gate_stays_shut_rolls_itself_back_at_the_deadline() {
    let new = above(2);
    let mut w = host_with(new, "0.1.0", &binary(true));
    w.tick(200);
    let data = w.agent.paths.data.clone();
    assert_eq!(count_start(&data, new, w.now), Start::Run);
    w.restart_as(new);
    // The engine does not answer: the gate stays shut and nothing else runs.
    w.engine.borrow_mut().down = true;
    let changes = w.changes().len();
    for _ in 0..10 {
        w.tick(30);
        assert!(w.agent.gate.is_some());
    }
    assert!(
        w.journal().contains("the engine does not answer"),
        "{}",
        w.journal()
    );
    w.tick(DEADLINE_S);
    assert!(w.agent.gate.is_none());
    assert_eq!(w.agent.exit, Some(0));
    assert_eq!(link(&data.join("current")), format!("versions/{}", me()));
    assert_eq!(w.changes().len(), changes);
    // The old agent finds pending with a counted start: a rollback, reported.
    w.engine.borrow_mut().down = false;
    w.restart_as(me());
    assert_eq!(w.outcome().0, "agent-rollback");
    assert!(w.outcome().1.contains("10 minutes"), "{:?}", w.outcome());
}

#[test]
fn a_rollback_keeps_the_running_agent_and_only_agent_to_moves_it_down() {
    // v1.1.0 ships this agent's own version; v1.0.0 (the example) an older one.
    let mut w = World::running_v1();
    w.install_layout();
    publish_agent(
        &w.remote,
        "v1.1.0",
        &Ships {
            version: &me().to_string(),
            min_agent: "0.1.0",
            binary: &binary(true),
        },
    );
    w.follow("v1.1.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));

    // A rollback statement without agent_to: the release goes down, the agent stays.
    relay_statement_agent(&w.remote, 1, "v1.0.0", "v1.1.0", b"signed", None);
    w.follow("v1.0.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"), "{:?}", w.outcome());
    assert_eq!(w.agent.exit, None);
    assert_eq!(link(&w.agent.paths.current()), format!("versions/{}", me()));

    // Forward again, then a statement with agent_to: the agent moves down to the agent
    // the release ships, through the same steps, and the statement is accepted with it.
    w.follow("v1.1.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    let old = Version(0, 1, 0);
    assert!(old < me());
    publish_agent(
        &w.remote,
        "v1.0.1",
        &Ships {
            version: "0.1.0",
            min_agent: "0.1.0",
            binary: &binary(true),
        },
    );
    relay_statement_agent(&w.remote, 2, "v1.0.1", "v1.1.0", b"signed", Some("0.1.0"));
    w.follow("v1.0.1", None);
    let changes = w.changes().len();
    w.round_now();
    assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
    assert_eq!(link(&w.agent.paths.current()), "versions/0.1.0");
    let p = Pending::parse(&fs::read_to_string(w.agent.paths.pending()).unwrap()).unwrap();
    assert_eq!((p.from, p.to), (me(), old));
    // The agent below applies v1.0.1: the floor is already there.
    assert_eq!(w.agent.state.statement_seq, Some(2));
    assert_eq!(w.agent.state.floor, Release::parse("v1.0.1"));
    assert_eq!(w.changes().len(), changes);
}

#[test]
fn an_agent_to_the_release_does_not_ship_waits_and_changes_nothing() {
    let mut w = World::running_v1();
    w.install_layout();
    publish_agent(
        &w.remote,
        "v1.1.0",
        &Ships {
            version: &me().to_string(),
            min_agent: "0.1.0",
            binary: &binary(true),
        },
    );
    w.follow("v1.1.0", None);
    w.round();
    // v1.0.0 ships agent 0.1.0; the statement says 0.0.9.
    relay_statement_agent(&w.remote, 1, "v1.0.0", "v1.1.0", b"signed", Some("0.0.9"));
    w.follow("v1.0.0", None);
    w.round_now();
    assert_eq!(w.agent.exit, None);
    assert_eq!(w.agent.state.statement_seq, None, "not accepted");
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    assert_eq!(w.outcome().0, "held");
    assert!(
        w.outcome().1.contains("ships agent 0.1.0"),
        "{:?}",
        w.outcome()
    );
}

#[test]
fn three_versions_are_kept() {
    let new = above(5);
    let mut w = host_with(new, "0.1.0", &binary(true));
    for v in ["0.0.1", "0.0.2", "0.0.3"] {
        fs::create_dir_all(w.agent.paths.versions().join(v)).unwrap();
    }
    fs::create_dir_all(w.agent.paths.versions().join("not-a-version")).unwrap();
    w.tick(200);
    assert_eq!(count_start(&w.agent.paths.data, new, w.now), Start::Run);
    w.restart_as(new);
    w.tick(1);
    assert!(w.agent.gate.is_none());
    let mut left: Vec<String> = fs::read_dir(w.agent.paths.versions())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    let mut want = vec![
        new.to_string(),
        me().to_string(),
        "0.0.3".into(),
        "not-a-version".into(),
    ];
    want.sort();
    assert_eq!(left, want);
}

#[test]
fn a_stale_pending_is_removed_and_one_that_never_started_is_not_a_rollback() {
    let mut w = World::running_v1();
    let data = w.agent.paths.data.clone();
    // The swap did not complete (no start counted): this agent stays, nothing recorded.
    let p = Pending {
        from: me(),
        to: above(1),
        tries: 0,
        deadline: w.now + 600,
    };
    fs::write(data.join("pending"), p.render()).unwrap();
    w.restart_as(me());
    assert!(!data.join("pending").exists());
    assert_eq!(w.agent.state.agent_skip, None);
    assert_ne!(w.outcome().0, "agent-rollback");
    // Garbage goes too.
    fs::write(data.join("pending"), "nonsense").unwrap();
    w.restart_as(me());
    assert!(!data.join("pending").exists());
}

#[test]
fn the_pool_not_answering_does_not_keep_the_gate_shut() {
    let new = above(1);
    let mut w = host_with(new, "0.1.0", &binary(true));
    w.tick(200);
    assert_eq!(count_start(&w.agent.paths.data, new, w.now), Start::Run);
    w.restart_as(new);
    w.pool_answers(Net::NoAnswer("connection refused".into()));
    w.tick(1);
    assert!(w.agent.gate.is_none(), "{}", w.journal());
    w.pool_answers(Net::Ok(Follow::default()));
}

#[test]
fn the_unit_is_type_notify_with_the_start_and_watchdog_timers() {
    let unit = include_str!("omarchy-agent.service");
    for line in [
        "Type=notify",
        "ExecStart=%h/.local/share/omarchy-agent/current/omarchy-agent run",
        "Restart=always",
        "TimeoutStartSec=120",
        "WatchdogSec=300",
        "RestartPreventExitStatus=78",
    ] {
        assert!(unit.lines().any(|l| l == line), "{line}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn notify_reaches_the_service_manager_socket() {
    let dir = crate::run::state::tempdir();
    let path = dir.join("notify");
    let s = std::os::unix::net::UnixDatagram::bind(&path).unwrap();
    super::notify_to(path.as_os_str(), "READY=1");
    let mut buf = [0u8; 32];
    let n = s.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"READY=1");
}

#[test]
fn state_written_by_this_agent_keeps_the_skip() {
    let s = State {
        agent_skip: Some(Version(0, 3, 0)),
        ..State::default()
    };
    let text = serde_json::to_string(&s).unwrap();
    assert!(text.contains("\"agent_skip\":\"0.3.0\""), "{text}");
    assert_eq!(crate::run::state::parse(text.as_bytes()).unwrap(), s);
}
