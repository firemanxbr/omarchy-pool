//! #316's acceptance criteria against the fake engine and pool: the version rule, the
//! download, the self-test (a real child process), the swap, the counted starts, the
//! health gate and the rollback. `tests/agent-self-update.sh` runs real builds under a
//! real `systemd --user`.

use std::fs;
use std::path::Path;

use super::{count_start, Pending, Start, DEADLINE_S, MAX_TRIES};
use crate::dispatcher_env::Sources;
use crate::run::agent::HostEnv;
use crate::run::fake::{
    publish_agent, publish_agent_as, publish_agent_before_token_file, relay_statement_agent, Ships,
    World, TOKEN,
};
use crate::run::pool::{HostState, Net};
use crate::run::state::State;
use crate::version::{self, Release, Version};

fn me() -> Version {
    version::agent()
}

/// An agent version above this one by `minor` minors.
fn above(minor: u64) -> Version {
    Version(me().0, me().1 + minor, 0)
}

/// What a new agent's binary does in these tests: answers `self-test --data-dir <dir>
/// --release <vX.Y.Z>`, and nothing else.
fn binary(ok: bool) -> Vec<u8> {
    let answer = if ok {
        "echo ok; exit 0"
    } else {
        "echo 'agent.toml: no'; exit 1"
    };
    format!(
        "#!/bin/sh\n[ \"$1 $2 $4\" = 'self-test --data-dir --release' ] && {{ {answer}; }}\nexit 2\n"
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
    w.target("v1.1.0", None);
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
    let polls = w.remote.borrow().polls;
    w.tick(1);
    assert!(w.agent.gate.is_none(), "{}", w.journal());
    assert!(!data.join("pending").exists());
    assert!(w.journal().contains("\"event\":\"agent-updated\""));
    assert_eq!(w.remote.borrow().polls, polls + 1, "the gate's report");
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

    // A later release with the same agent rolls out with no update at all (ten minutes on:
    // the brake takes one release change every ten minutes, #325).
    w.tick(600);
    publish_agent(
        &w.remote,
        "v1.2.0",
        &Ships {
            version: &new.to_string(),
            min_agent: "0.1.0",
            binary: &binary(true),
        },
    );
    w.target("v1.2.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"));
    assert_eq!(w.agent.exit, None);
    assert_eq!(link(&data.join("current")), format!("versions/{new}"));
}

#[test]
fn a_higher_agent_waits_for_the_owners_soak_unless_its_release_is_urgent() {
    // Not urgent: the agent waits with its release (#326) — nothing downloaded, no swap.
    let new = above(7);
    let mut w = host_with(new, "0.1.0", &binary(true));
    w.agent.cfg.policy.soak_minutes = 30;
    w.tick(200);
    assert_eq!(w.agent.exit, None, "{}", w.journal());
    assert!(!w.agent.paths.pending().exists());
    assert!(!w.agent.paths.binary(new).exists());
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "held");
    assert!(
        detail.starts_with("v1.1.0 waits for the owner's soak")
            && detail.contains(&format!("and the agent {new} it ships with it")),
        "{detail}"
    );
    // The soak over, the agent updates itself first, as with none.
    for _ in 0..40 {
        w.tick(60);
        if w.agent.exit.is_some() {
            break;
        }
    }
    assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
    assert_eq!(link(&w.agent.paths.current()), format!("versions/{new}"));

    // Urgent (only a security release sets agent.urgent): the agent updates itself at once,
    // and the release itself still waits for the soak.
    let mut w = World::running_v1();
    w.install_layout();
    publish_agent_as(
        &w.remote,
        "v1.1.0",
        &Ships {
            version: &new.to_string(),
            min_agent: "0.1.0",
            binary: &binary(true),
        },
        true,
    );
    w.target("v1.1.0", None);
    w.agent.cfg.policy.soak_minutes = 30;
    w.tick(200);
    assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
    assert_eq!(link(&w.agent.paths.current()), format!("versions/{new}"));
    let changes = w.changes().len();
    w.restart_as(new);
    w.tick(1);
    assert!(w.agent.gate.is_none(), "{}", w.journal());
    w.poll();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "held");
    assert!(
        detail.starts_with("v1.1.0 waits for the owner's soak") && !detail.contains("agent"),
        "{detail}"
    );
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(w.changes().len(), changes);
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
fn a_bundle_only_a_higher_agent_reads_waits_for_the_soak_too() {
    let new = above(3);
    let mut w = host_with(new, &new.to_string(), &binary(true));
    w.agent.cfg.policy.soak_minutes = 30;
    w.tick(200);
    assert_eq!(w.agent.exit, None, "{}", w.journal());
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "held");
    assert!(
        detail.contains(&format!("and the agent {new} it ships with it")),
        "{detail}"
    );
    for _ in 0..40 {
        w.tick(60);
        if w.agent.exit.is_some() {
            break;
        }
    }
    assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
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
        // Ten minutes on: the brake takes one release change every ten minutes (#325).
        w.tick(600);
        w.target("v1.2.0", None);
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
        w.target("v1.3.0", None);
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
    w.target("v1.2.0", None);
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
    w.target("v1.1.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));

    // A rollback statement without agent_to: the release goes down, the agent stays.
    relay_statement_agent(&w.remote, 1, "v1.0.0", "v1.1.0", b"signed", None);
    w.target("v1.0.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"), "{:?}", w.outcome());
    assert_eq!(w.agent.exit, None);
    assert_eq!(link(&w.agent.paths.current()), format!("versions/{}", me()));

    // Forward again, then a statement with agent_to: the agent moves down to the agent
    // the release ships, through the same steps, and the statement is accepted with it.
    w.target("v1.1.0", None);
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
    w.target("v1.0.1", None);
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
    // v1.0.1 reads the token from its file: the env file still holds none (#327).
    assert!(!env_has_token(&w));
}

/// Whether `etc/dispatcher.env` carries the host worker token as `OMARCHY_WORKER_TOKEN`.
fn env_has_token(w: &World) -> bool {
    fs::read_to_string(w.set_dir().join("etc/dispatcher.env"))
        .unwrap()
        .contains(&format!("\nOMARCHY_WORKER_TOKEN={TOKEN}\n"))
}

#[test]
fn an_agent_to_a_release_from_before_the_token_file_puts_the_token_back_before_the_agent_moves_down(
) {
    // A settled host past #327: v1.1.0 applied, which ships this agent and reads the token
    // from its file, the run loop's minute refresh on, no token line. Then v1.0.1, from
    // before #327 and shipping agent 0.1.0 (also from before it), and a statement that moves
    // the host and its agent down to them: the agent below runs that round and writes no
    // token line, so this one puts the line back before it moves.
    let host = |self_test: bool| {
        let mut w = World::running_v1();
        w.install_layout();
        w.agent.host_env = Some(HostEnv::new(Sources {
            proc_net: w.dir.join("no-proc-net"),
            ifconfig: None,
        }));
        publish_agent(
            &w.remote,
            "v1.1.0",
            &Ships {
                version: &me().to_string(),
                min_agent: "0.1.0",
                binary: &binary(true),
            },
        );
        w.target("v1.1.0", None);
        w.round();
        while w.step() != "idle" {
            w.tick(3);
        }
        assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{:?}", w.outcome());
        assert!(!env_has_token(&w));
        publish_agent_before_token_file(
            &w.remote,
            "v1.0.1",
            &Ships {
                version: "0.1.0",
                min_agent: "0.1.0",
                binary: &binary(self_test),
            },
        );
        relay_statement_agent(&w.remote, 1, "v1.0.1", "v1.1.0", b"signed", Some("0.1.0"));
        w.target("v1.0.1", None);
        w
    };

    // The agent below fails its self-test: the statement waits, and the line is out again,
    // so no round recreates the dispatcher for it.
    let mut w = host(false);
    let env = fs::read_to_string(w.set_dir().join("etc/dispatcher.env")).unwrap();
    let changes = w.changes().len();
    w.round_now();
    assert_eq!(w.agent.exit, None);
    assert_eq!(w.outcome().0, "held", "{:?}", w.outcome());
    assert!(w.outcome().1.contains("self-test"), "{:?}", w.outcome());
    assert_eq!(w.agent.state.statement_seq, None, "not accepted");
    assert_eq!(link(&w.agent.paths.current()), format!("versions/{}", me()));
    assert_eq!(
        fs::read_to_string(w.set_dir().join("etc/dispatcher.env")).unwrap(),
        env
    );
    assert_eq!(w.step(), "idle");
    assert_eq!(w.changes().len(), changes);

    // It passes: when this agent exits, the token is where v1.0.1's dispatcher reads it, and
    // still in its file.
    let mut w = host(true);
    let changes = w.changes().len();
    w.round_now();
    assert_eq!(w.agent.exit, Some(0), "{}", w.journal());
    assert_eq!(link(&w.agent.paths.current()), "versions/0.1.0");
    assert_eq!(w.agent.state.statement_seq, Some(1));
    assert!(env_has_token(&w));
    assert_eq!(
        crate::dispatcher_env::read_token(&w.token_file()).unwrap(),
        Some((TOKEN.to_owned(), 0o400))
    );
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
    w.target("v1.1.0", None);
    w.round();
    // v1.0.0 ships agent 0.1.0; the statement says 0.0.9.
    relay_statement_agent(&w.remote, 1, "v1.0.0", "v1.1.0", b"signed", Some("0.0.9"));
    w.target("v1.0.0", None);
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
    w.pool_answers(Net::Ok(HostState::default()));
}

#[test]
fn a_new_agent_that_hangs_is_ended_past_its_gates_deadline_and_its_next_start_rolls_it_back() {
    // launchd restarts the agent only when it exits (#320): the progress watchdog ends a
    // candidate whose loop hangs with its gate shut, and the start that follows flips back.
    use crate::run::cli::{watchdog_look, watchdog_verdict, Look};
    let new = above(1);
    let mut w = host_with(new, "0.1.0", &binary(true));
    w.tick(200);
    let data = w.agent.paths.data.clone();
    let start = w.now;
    assert_eq!(count_start(&data, new, start), Start::Run);
    let p = super::candidate(&data, new).unwrap();
    assert!(p.deadline > start && p.deadline <= start + DEADLINE_S);
    // The loop moves (a download, a tick): nothing until the gate's deadline and its grace.
    assert_eq!(
        watchdog_verdict(p.deadline, p.deadline, Some(p.deadline)),
        None
    );
    assert_eq!(
        watchdog_verdict(p.deadline + 30, p.deadline + 30, Some(p.deadline)),
        None
    );
    let why = watchdog_verdict(p.deadline + 31, p.deadline + 31, Some(p.deadline)).unwrap();
    assert!(
        why.contains("health gate is still shut 31 s past its deadline"),
        "{why}"
    );
    // Without a gate: fifteen minutes without progress, as before.
    assert_eq!(watchdog_verdict(start + 900, start, None), None);
    assert!(watchdog_verdict(start + 901, start, None)
        .unwrap()
        .contains("no progress for 901 s"));
    // A Mac that slept an hour: the first look after the wake sees the loop's progress an
    // hour old, and starts the count again instead of ending it; the looks after it judge.
    let woke = start + 3600;
    assert_eq!(watchdog_look(woke, start + 10, start, None), Look::Woke);
    assert_eq!(watchdog_look(woke + 10, woke, woke, None), Look::Fine);
    assert!(matches!(
        watchdog_look(woke + 910, woke + 900, woke, None),
        Look::Abort(_)
    ));
    // Looks that come on time judge as before.
    assert!(matches!(
        watchdog_look(start + 901, start + 891, start, None),
        Look::Abort(_)
    ));
    // launchd starts it again: past the deadline, `current` points back.
    match count_start(&data, new, p.deadline + 41) {
        Start::RolledBack(why) => assert!(why.contains("did not pass within 10 minutes"), "{why}"),
        Start::Run => panic!("not rolled back"),
    }
    assert_eq!(link(&data.join("current")), format!("versions/{}", me()));
}

#[test]
fn under_launchd_a_refused_configuration_waits_for_agent_toml_to_change() {
    // launchd's KeepAlive starts the agent again 10 s after any exit (#320); a refused
    // agent.toml is waited on instead, not said every 10 s.
    use crate::run::cli::{under_launchd, wait_for_change};
    use std::time::{Duration, Instant};
    assert!(under_launchd(Some("org.omarchy-pool.agent")));
    assert!(!under_launchd(Some("application.com.apple.Terminal.1234")));
    assert!(!under_launchd(None));
    let dir = crate::run::state::tempdir();
    let toml = dir.join("agent.toml");
    fs::write(&toml, "pool = \"x\"\n").unwrap();
    let t = Instant::now();
    assert!(!wait_for_change(
        &toml,
        Duration::from_millis(20),
        Duration::from_millis(100)
    ));
    assert!(t.elapsed() >= Duration::from_millis(100));
    let edit = {
        let toml = toml.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            fs::write(&toml, "pool = \"https://pkgs.omarchy-pool.org\"\n").unwrap();
        })
    };
    assert!(wait_for_change(
        &toml,
        Duration::from_millis(20),
        Duration::from_secs(30)
    ));
    edit.join().unwrap();
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
