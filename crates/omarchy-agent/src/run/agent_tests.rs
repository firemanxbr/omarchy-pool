//! #315's acceptance criteria, against a fake engine and a fake pool (the real-engine
//! test is `tests/agent-run-loop.sh`).

use std::fs;

use crate::dispatcher_env::{Budget, Sources};
use crate::run::agent::HostEnv;
use crate::run::fake::{publish, relay_statement, rendered_compose, World, T0, TOKEN, WORKER};
use crate::run::pool::{Follow, Net};
use crate::run::state::{Files, Phase, Step};
use crate::version::Release;

fn r(s: &str) -> Option<Release> {
    Release::parse(s)
}

#[test]
fn a_release_reaches_the_host_with_no_human_action_and_a_running_task_keeps_running() {
    let mut w = World::running_v1();
    let (task, started) = {
        let e = w.engine.borrow();
        (e.tasks()[0].id.clone(), e.tasks()[0].started_at)
    };
    let old = w.engine.borrow().dispatcher().unwrap().id.clone();
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(
        fs::read_to_string(w.set_dir().join("compose.yml")).unwrap(),
        rendered_compose("")
    );

    // A release: the pool names it, and the next poll rolls it out.
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    let start = w.journal().lines().count();
    w.tick(200);
    while w.step() != "idle" {
        w.tick(3);
    }
    // Every step, in order, each journaled as it was entered.
    let mut steps: Vec<String> = Vec::new();
    for line in w.journal().lines().skip(start) {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        if v["event"] == "step" {
            for k in ["from", "to"] {
                let s = v[k].as_str().unwrap().to_owned();
                if steps.last() != Some(&s) {
                    steps.push(s);
                }
            }
        }
    }
    assert_eq!(
        steps,
        ["render", "lint", "plan", "pull", "replace", "guard", "commit"]
    );
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    assert_eq!(w.agent.state.floor, r("v1.1.0"));

    let e = w.engine.borrow();
    // The task container was never touched (the fake engine panics if it is) and runs.
    let t = e.tasks();
    assert_eq!(
        (t.len(), t[0].id.as_str(), t[0].status.as_str()),
        (1, task.as_str(), "running")
    );
    assert_eq!(t[0].started_at, started, "the task was never restarted");
    // The old dispatcher was stopped (it saved its leases) and removed; the new one runs
    // the new release and re-adopted the running task.
    let d = e.dispatcher().unwrap();
    assert_ne!(d.id, old);
    assert_eq!(
        (d.release.as_str(), d.status.as_str(), d.readopted),
        ("v1.1.0", "running", 1)
    );
    let changes: Vec<&str> = e
        .changes
        .iter()
        .map(|c| c.split(' ').next().unwrap())
        .collect();
    assert_eq!(
        &changes[changes.len() - 4..],
        ["pull", "stop", "rm", "create"]
    );
    drop(e);
    // What really runs is what the set directory says.
    let compose = fs::read_to_string(w.set_dir().join("agent.yml")).unwrap();
    assert!(
        compose.contains("org.omarchy-pool.agent.release: \"v1.1.0\""),
        "{compose}"
    );
}

#[test]
fn a_broken_dispatcher_is_reverted_and_quarantined_and_an_update_order_lifts_it() {
    let mut w = World::running_v1();
    publish(
        &w.remote,
        "v1.1.0",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "    command: [broken]\n",
    );
    w.follow("v1.1.0", None);
    w.round();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "rolled-back", "{detail}");
    // The report names the release rolled back from.
    assert_eq!(w.agent.state.round.from, r("v1.1.0"));
    assert!(detail.contains("quarantined until"), "{detail}");
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(w.agent.state.floor, r("v1.0.0"));
    let q = w.agent.state.quarantine[&r("v1.1.0").unwrap()].clone();
    assert_eq!(q.reverts, 1);
    assert!((q.until.unwrap() - w.now - 3600).abs() <= 3, "{q:?}");
    {
        let e = w.engine.borrow();
        let d = e.dispatcher().unwrap();
        assert_eq!(
            (d.release.as_str(), d.status.as_str()),
            ("v1.0.0", "running")
        );
        assert_eq!(e.tasks().len(), 1);
    }
    assert_eq!(
        fs::read_to_string(w.set_dir().join("compose.yml")).unwrap(),
        rendered_compose("")
    );

    // Quarantined: the next polls change nothing and say why.
    let before = w.changes().len();
    w.tick(600);
    w.tick(600);
    assert_eq!(w.step(), "idle");
    assert_eq!(w.changes().len(), before);
    assert_eq!(w.outcome().0, "held");
    assert!(
        w.outcome().1.contains("v1.1.0 is quarantined until"),
        "{:?}",
        w.outcome()
    );

    // An Update order lifts the quarantine and starts a round at once.
    w.follow("v1.1.0", Some("ord_1"));
    w.tick(600);
    assert!(w.agent.state.quarantine.is_empty() || w.step() != "idle");
    assert_eq!(w.agent.state.rollout.target, r("v1.1.0"));
    assert!(w.journal().contains("quarantine-lifted"), "{}", w.journal());
    while w.step() != "idle" {
        w.tick(3);
    }
    // Still broken: reverted and quarantined again (the order was the retry).
    assert_eq!(w.outcome().0, "rolled-back");
    assert!(w.agent.state.quarantine[&r("v1.1.0").unwrap()]
        .until
        .is_some());
    // The same order seen again starts nothing.
    let before = w.changes().len();
    w.tick(600);
    assert_eq!((w.step(), w.changes().len()), ("idle", before));
}

#[test]
fn a_quarantine_ends_after_an_hour_with_one_retry() {
    let mut w = World::running_v1();
    publish(
        &w.remote,
        "v1.1.0",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "    command: [broken]\n",
    );
    w.follow("v1.1.0", None);
    w.round();
    assert_eq!(w.outcome().0, "rolled-back");
    w.tick(3601);
    assert_eq!(
        w.agent.state.rollout.target,
        r("v1.1.0"),
        "retried after the hour"
    );
    while w.step() != "idle" {
        w.tick(3);
    }
    // The one retry failed too: it waits for a newer release now.
    assert_eq!(w.outcome().0, "rolled-back");
    assert_eq!(w.agent.state.quarantine[&r("v1.1.0").unwrap()].until, None);
    w.tick(7200);
    assert_eq!((w.step(), w.outcome().0.as_str()), ("idle", "held"));
    assert!(
        w.outcome().1.contains("until a newer release"),
        "{:?}",
        w.outcome()
    );
    w.release("v1.1.1");
    w.follow("v1.1.1", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.1"));
}

#[test]
fn two_ordered_restarts_during_the_guard_do_not_fail_it() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.round_now();
    while w.step() != "guard" {
        w.tick(3);
    }
    let mut restarts = 0;
    while w.step() == "guard" {
        if restarts < 2 && w.agent.state.rollout.since + 20 * (restarts + 1) <= w.now {
            w.engine.borrow_mut().ordered_restart("dispatcher");
            restarts += 1;
        }
        w.tick(3);
    }
    assert_eq!(restarts, 2);
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    assert_eq!(w.engine.borrow().dispatcher().unwrap().restarts, 2);
}

#[test]
fn an_exit_other_than_75_during_the_guard_fails_it() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.round_now();
    while w.step() != "guard" {
        w.tick(3);
    }
    {
        let mut e = w.engine.borrow_mut();
        let at = e.clock;
        let d = e
            .containers
            .iter_mut()
            .find(|c| c.service == "dispatcher")
            .unwrap();
        d.exits.push(crate::run::driver::Exit { at, code: 1 });
        d.restarts += 1;
    }
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "rolled-back");
    assert!(
        w.outcome()
            .1
            .starts_with("guard: the dispatcher exited with 1"),
        "{:?}",
        w.outcome()
    );
    assert_eq!(w.agent.state.round.step, "revert");
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
}

#[test]
fn a_rollback_statement_mid_round_preempts_it_and_moves_the_host_down() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    let task = w.engine.borrow().tasks()[0].id.clone();

    // v1.2.0 is rolling out ...
    w.release("v1.2.0");
    w.follow("v1.2.0", None);
    w.round_now();
    while w.step() != "guard" {
        w.tick(3);
    }
    // ... when rollback.yml retracts everything above v1.0.0 and the pool goes back to it.
    relay_statement(&w.remote, 1, "v1.0.0", "v1.2.0", b"signed");
    w.follow("v1.0.0", None);
    w.round_now();
    assert!(
        w.journal().contains("\"event\":\"preempted\""),
        "{}",
        w.journal()
    );
    assert!(w.journal().contains("rollback-accepted"));
    assert_eq!(w.agent.state.rollout.target, r("v1.0.0"));
    assert!(w.agent.state.rollout.rollback);
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(w.agent.state.floor, r("v1.0.0"));
    assert_eq!(w.agent.state.statement_seq, Some(1));
    assert_eq!(w.engine.borrow().dispatcher().unwrap().release, "v1.0.0");
    assert_eq!(w.engine.borrow().tasks()[0].id, task);
    // A rollback never changes the agent: the state is still this agent's, and no
    // self-update was even considered.
    assert_eq!(w.agent.state.agent, crate::AGENT_VERSION);
    assert!(!w.journal().contains("agent-available"));

    // The same statement again is not a second rollback: going forward needs nothing.
    w.follow("v1.2.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"));
}

#[test]
fn forged_targets_are_refused_with_named_reasons_and_nothing_changes() {
    let mut w = World::running_v1();
    // v1.2.0's manifest raises min_release to v1.0.1 and revokes v1.2.5.
    publish(
        &w.remote,
        "v1.0.1",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "",
    );
    publish(
        &w.remote,
        "v1.2.0",
        "2027-01-14T08:00:00Z",
        "v1.0.1",
        &["v1.2.5"],
        "",
    );
    w.follow("v1.2.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"));
    let changes = w.changes().len();

    let refused = |w: &mut World, target: &str, reason: &str| {
        w.follow(target, None);
        w.round_now();
        let (outcome, detail) = w.outcome();
        assert_eq!(outcome, "refused", "{target}: {detail}");
        assert!(
            detail.contains(&format!("refused ({reason})")),
            "{target}: {detail}"
        );
        assert_eq!(w.step(), "idle", "{target}");
        assert_eq!(w.applied().as_deref(), Some("v1.2.0"), "{target}");
    };
    // Below the floor, with no statement.
    refused(&mut w, "v1.0.1", "below-floor");
    // Below the merged min_release.
    publish(
        &w.remote,
        "v0.9.0",
        "2027-01-14T08:00:00Z",
        "v0.9.0",
        &[],
        "",
    );
    refused(&mut w, "v0.9.0", "below-min-release");
    // Revoked by an earlier manifest, though above the floor.
    publish(
        &w.remote,
        "v1.2.5",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "",
    );
    refused(&mut w, "v1.2.5", "revoked");
    // A bundle whose signature does not verify.
    publish(
        &w.remote,
        "v1.3.0",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "",
    );
    w.remote.borrow_mut().assets.insert(
        "v1.3.0/omarchy-host-v1.3.0.tar.gz.sigstore.json".into(),
        b"forged".to_vec(),
    );
    refused(&mut w, "v1.3.0", "signature");
    // A statement signed 20 days after `to` was created: deeper than 14 days.
    publish(
        &w.remote,
        "v1.0.1",
        "2026-12-26T08:00:00Z",
        "v1.0.0",
        &[],
        "",
    );
    let _ = fs::remove_dir_all(w.agent.paths.bundles());
    relay_statement(&w.remote, 5, "v1.0.1", "v1.2.0", b"signed");
    *w.signed_at.borrow_mut() = T0 + 6 * 86_400;
    refused(&mut w, "v1.0.1", "statement-too-deep");
    // A statement that does not reach this host's floor.
    publish(
        &w.remote,
        "v1.0.1",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "",
    );
    let _ = fs::remove_dir_all(w.agent.paths.bundles());
    relay_statement(&w.remote, 6, "v1.0.1", "v1.1.0", b"signed");
    refused(&mut w, "v1.0.1", "statement-range");
    // A statement not signed by rollback.yml.
    relay_statement(&w.remote, 7, "v1.0.1", "v1.2.0", b"forged");
    refused(&mut w, "v1.0.1", "signature");

    assert_eq!(w.changes().len(), changes, "a refusal changed the engine");
    assert_eq!(w.agent.state.floor, r("v1.2.0"));
    assert_eq!(w.agent.state.statement_seq, None);
}

#[test]
fn storms_of_401_and_5xx_leave_everything_running_and_the_agent_recovers_by_itself() {
    let mut w = World::running_v1();
    let changes = w.changes().len();
    let (task, dispatcher) = {
        let e = w.engine.borrow();
        (e.tasks()[0].id.clone(), e.dispatcher().unwrap().id.clone())
    };

    // Two hours of 503s: back-off to 10 minutes, nothing changes.
    w.pool_answers(Net::NoAnswer("HTTP 503".into()));
    let polls = w.remote.borrow().follows;
    for _ in 0..(2 * 3600 / 30) {
        w.tick(30);
    }
    let asked = w.remote.borrow().follows - polls;
    assert!(
        (12..=30).contains(&asked),
        "{asked} polls in two hours of 5xx"
    );
    assert_eq!(w.agent.state.poll.backoff_s, 600);
    assert_eq!(w.outcome().0, "pool-unreachable");

    // Then four hours of 401s: hourly polls, nothing changes.
    w.pool_answers(Net::Unauthorized(401));
    w.tick(600);
    let polls = w.remote.borrow().follows;
    for _ in 0..(4 * 3600 / 60) {
        w.tick(60);
    }
    let asked = w.remote.borrow().follows - polls;
    assert!(
        (3..=5).contains(&asked),
        "{asked} polls in four hours of 401"
    );
    assert_eq!(w.outcome().0, "unauthorized");

    // Malformed answers count as none.
    w.pool_answers(Net::NoAnswer("follow: expected value".into()));
    w.tick(4000);
    assert_eq!(w.changes().len(), changes, "a storm changed the engine");
    {
        let e = w.engine.borrow();
        assert_eq!(e.tasks()[0].id, task);
        assert_eq!(e.dispatcher().unwrap().id, dispatcher);
        assert_eq!(e.dispatcher().unwrap().status, "running");
    }

    // The pool answers again, with a release: rolled out by the same process.
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    for _ in 0..400 {
        w.tick(5);
        if w.applied().as_deref() == Some("v1.1.0") {
            break;
        }
    }
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{:?}", w.outcome());
    assert_eq!(w.agent.state.poll.backoff_s, 0);
}

#[test]
fn with_the_dispatcher_env_or_its_token_file_missing_the_dispatcher_is_held_and_the_reason_reported(
) {
    let mut w = World::new();
    let env = w.set_dir().join("etc/dispatcher.env");
    fs::remove_file(&env).unwrap();
    fs::remove_file(w.token_file()).unwrap();
    w.release("v1.0.0");
    w.follow("v1.0.0", None);
    w.round();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "held");
    assert!(
        detail.contains("awaiting the owner's Confirm: etc/dispatcher.env is missing")
            && detail
                .contains("awaiting the owner's Confirm: run/host/dispatcher/token is missing"),
        "{detail}"
    );
    assert!(w.changes().is_empty(), "{:?}", w.changes());
    assert_eq!(w.applied(), None);
    // The env file alone (its token not written yet): still held, for the token file —
    // compose would make a directory where it belongs.
    fs::write(&env, format!("# worker: {WORKER}\n")).unwrap();
    w.round();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "held");
    assert!(
        detail.contains("run/host/dispatcher/token is missing")
            && !detail.contains("etc/dispatcher.env"),
        "{detail}"
    );
    assert!(w.changes().is_empty(), "{:?}", w.changes());

    // The owner confirms; the token arrives as the enrollment writes it; the next poll
    // starts the dispatcher.
    let r = crate::dispatcher_env::Rendered {
        addresses: Vec::new(),
        envelope: None,
        plain: false,
    };
    crate::dispatcher_env::write_token(&env, WORKER, TOKEN, &r).unwrap();
    w.round();
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
}

#[test]
fn a_rotation_writes_the_token_file_and_recreates_only_the_dispatcher_while_the_task_runs_on() {
    let mut w = World::running_v1();
    let (task, started) = {
        let e = w.engine.borrow();
        (e.tasks()[0].id.clone(), e.tasks()[0].started_at)
    };
    let first = w.engine.borrow().dispatcher().unwrap().id.clone();
    let env = w.set_dir().join("etc/dispatcher.env");
    let before = fs::read_to_string(&env).unwrap();
    let changes = w.changes().len();
    // `omarchy-agent token` (or #325's rotate-token order) writes the pool's answer through
    // the one place that knows where the token lives.
    let new = format!("omw_{}", "5e".repeat(24));
    let r = crate::dispatcher_env::Rendered::now(
        &Sources {
            proc_net: w.dir.join("no-proc-net"),
        },
        &w.agent.paths.data,
        None,
    );
    assert!(!r.plain, "every release here reads the token file");
    let worker = crate::enroll::write_worker_token(
        &env,
        &serde_json::json!({"worker": WORKER, "token": new, "rotate_after": "later"}),
        &r,
    )
    .unwrap();
    assert_eq!(worker, WORKER);
    assert_eq!(
        crate::dispatcher_env::read_token(&w.token_file()).unwrap(),
        Some((new.clone(), 0o400))
    );
    assert_eq!(
        fs::read_to_string(&env).unwrap(),
        before,
        "the env file holds no token"
    );
    // The next tick sees the changed input and recreates the dispatcher, and only it.
    w.tick(3);
    assert!(
        w.agent.state.rollout.why.contains("an input changed"),
        "{:?}",
        w.agent.state.rollout
    );
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    let second = w.engine.borrow().dispatcher().unwrap().id.clone();
    assert_ne!(
        first, second,
        "the dispatcher was recreated with the new token"
    );
    let e = w.engine.borrow();
    assert_eq!(e.tasks().len(), 1);
    assert_eq!(
        (e.tasks()[0].id.as_str(), e.tasks()[0].started_at),
        (task.as_str(), started),
        "the task runs on, never restarted"
    );
    assert!(
        e.containers
            .iter()
            .all(|c| c.project.is_empty() || c.service == "dispatcher"),
        "only the dispatcher is the agent's to replace"
    );
    let since: Vec<&String> = e.changes[changes..].iter().collect();
    assert!(
        !since.is_empty() && since.iter().all(|c| !c.contains(&task)),
        "{since:?}"
    );
    drop(e);
    // The round read the token file again: the journal scrubs the new token as it did the
    // old.
    crate::run::rollout::report(
        &mut w.agent.state,
        &w.agent.journal,
        w.now,
        crate::run::rollout::Outcome::EngineUnreachable,
        None,
        &format!("compose: echoed {new}"),
    );
    assert!(!w.agent.state.round.detail.contains(&new));
    assert!(!w.journal().contains(&new));
}

#[test]
fn an_upgraded_host_moves_its_token_to_the_file_and_keeps_it_in_the_env_file_only_for_an_older_release(
) {
    // A host of #371's time: the token in etc/dispatcher.env, no token file, and a release
    // from before #327 to run, whose dispatcher reads the token there.
    let mut w = World::new();
    let env = w.set_dir().join("etc/dispatcher.env");
    fs::remove_file(w.token_file()).unwrap();
    fs::write(
        &env,
        format!("# worker: {WORKER}\nOMARCHY_WORKER_TOKEN={TOKEN}\nTZ=UTC\n"),
    )
    .unwrap();
    w.agent.host_env = Some(HostEnv::new(Sources {
        proc_net: w.dir.join("no-proc-net"),
    }));
    w.release_before_token_file("v1.0.0");
    w.follow("v1.0.0", None);
    w.round();
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    let has_plain = |w: &World| {
        fs::read_to_string(w.set_dir().join("etc/dispatcher.env"))
            .unwrap()
            .contains(&format!("\nOMARCHY_WORKER_TOKEN={TOKEN}\n"))
    };
    // The token moved to its file, and stays in the env file too: v1.0.0 reads it there.
    assert_eq!(
        crate::dispatcher_env::read_token(&w.token_file()).unwrap(),
        Some((TOKEN.to_owned(), 0o400))
    );
    assert!(has_plain(&w));
    assert!(w
        .journal()
        .contains("moved from etc/dispatcher.env to run/host/dispatcher/token"));
    w.engine.borrow_mut().start_task();
    let task = w.engine.borrow().tasks()[0].id.clone();

    // A release that reads the token file: while it rolls out, the older one could be
    // reverted to, so the token stays in the env file.
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.round();
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    let v11 = w.engine.borrow().dispatcher().unwrap().id.clone();
    // Committed: no release here reads it from the env file any more. The next refresh takes
    // it out, and that change recreates the dispatcher, which reads its file.
    w.tick(61);
    assert!(!has_plain(&w));
    assert!(
        !fs::read_to_string(&env).unwrap().contains(TOKEN),
        "{}",
        fs::read_to_string(&env).unwrap()
    );
    assert!(fs::read_to_string(&env).unwrap().ends_with("\nTZ=UTC\n"));
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_ne!(w.engine.borrow().dispatcher().unwrap().id, v11);
    assert_eq!(
        crate::dispatcher_env::read_token(&w.token_file()).unwrap(),
        Some((TOKEN.to_owned(), 0o400))
    );
    // A rollback statement to v1.0.0: its round puts the token back where that release's
    // dispatcher reads it, before it creates it.
    relay_statement(&w.remote, 1, "v1.0.0", "v1.1.0", b"signed");
    w.follow("v1.0.0", None);
    w.round();
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert!(has_plain(&w));
    assert_eq!(
        w.engine.borrow().tasks()[0].id,
        task,
        "the task ran through it all"
    );
}

#[test]
fn the_host_s_addresses_reach_dispatcher_env_and_a_change_recreates_the_dispatcher_with_the_token_kept(
) {
    use std::os::unix::fs::PermissionsExt as _;
    let mut w = World::running_v1();
    // The host's interfaces, a copy of a fixture the test changes as the host would (#371).
    let net = w.dir.join("net");
    fs::create_dir_all(&net).unwrap();
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/addresses/home");
    for f in ["fib_trie", "if_inet6", "route"] {
        fs::copy(fixture.join(f), net.join(f)).unwrap();
    }
    w.agent.host_env = Some(HostEnv::new(Sources {
        proc_net: net.clone(),
    }));
    w.agent.cfg.agent_budget = Budget {
        calls_per_day: Some(900),
        ..Budget::default()
    };
    let env = w.set_dir().join("etc/dispatcher.env");
    let first = w.engine.borrow().dispatcher().unwrap().id.clone();

    // At its start: rendered with the registration kept, 0600, the token left in its file,
    // and a round recreates the dispatcher.
    w.tick(3);
    let text = fs::read_to_string(&env).unwrap();
    for want in [
        format!("\n# worker: {WORKER}\n"),
        "\nOMARCHY_HOST_ADDRESSES=10.8.0.2,192.168.1.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64\n".into(),
        format!("\nOMARCHY_SECRETS_DIR={}\nOMARCHY_AGENT_CALLS_PER_DAY=900\n", w.dir.join("secrets").display()),
    ] {
        assert!(text.contains(&want), "{want:?} in:\n{text}");
    }
    assert!(!text.contains(TOKEN), "{text}");
    assert_eq!(
        crate::dispatcher_env::read_token(&w.token_file()).unwrap(),
        Some((TOKEN.to_owned(), 0o400))
    );
    assert_eq!(
        fs::metadata(&env).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        w.agent.state.rollout.why.contains("an input changed"),
        "{:?}",
        w.agent.state.rollout
    );
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    let second = w.engine.borrow().dispatcher().unwrap().id.clone();
    assert_ne!(first, second, "the dispatcher was recreated with the file");
    assert!(
        w.journal().contains("\"event\":\"dispatcher-env\""),
        "{}",
        w.journal()
    );

    // Nothing changed: read again every minute, never written, no round.
    for _ in 0..3 {
        w.tick(61);
    }
    assert_eq!(w.step(), "idle");
    assert_eq!(fs::read_to_string(&env).unwrap(), text);
    assert_eq!(w.engine.borrow().dispatcher().unwrap().id, second);

    // The LAN address changes (a new DHCP lease): the addresses only, the token as it was.
    let fib = fs::read_to_string(net.join("fib_trie")).unwrap();
    fs::write(
        net.join("fib_trie"),
        fib.replace("192.168.1.20", "192.168.1.21"),
    )
    .unwrap();
    w.tick(61);
    let moved = fs::read_to_string(&env).unwrap();
    assert_eq!(moved, text.replace("192.168.1.20", "192.168.1.21"));
    assert_ne!(w.step(), "idle");
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_ne!(w.engine.borrow().dispatcher().unwrap().id, second);
    assert_eq!(w.engine.borrow().tasks().len(), 1, "the task runs on");

    // No file (the owner has not confirmed): none is made, the dispatcher is held.
    fs::remove_file(&env).unwrap();
    w.tick(61);
    assert!(!env.exists());
}

/// A world whose host's interfaces are a copy of the home fixture, with the run loop's half
/// of `etc/dispatcher.env` on (#371).
fn with_host_env() -> World {
    let mut w = World::running_v1();
    let net = w.dir.join("net");
    fs::create_dir_all(&net).unwrap();
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/addresses/home");
    for f in ["fib_trie", "if_inet6", "route"] {
        fs::copy(fixture.join(f), net.join(f)).unwrap();
    }
    w.agent.host_env = Some(HostEnv::new(Sources { proc_net: net }));
    w
}

fn settle(w: &mut World) {
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
}

#[test]
fn the_public_address_the_pool_s_edge_sees_is_asked_hourly_within_minutes_after_no_answer_and_a_new_one_refused_with_the_token_kept(
) {
    let mut w = with_host_env();
    let env = w.set_dir().join("etc/dispatcher.env");
    let addresses = |w: &World| {
        fs::read_to_string(w.set_dir().join("etc/dispatcher.env"))
            .unwrap()
            .lines()
            .find_map(|l| l.strip_prefix("OMARCHY_HOST_ADDRESSES="))
            .unwrap()
            .to_owned()
    };
    // Install saw 198.51.100.20; the pool's edge says the same at the loop's start.
    crate::dispatcher_env::addresses::keep_seen(
        &w.agent.paths.data,
        "198.51.100.20".parse().unwrap(),
        "2027-01-15T07:00:00Z",
    )
    .unwrap();
    w.remote.borrow_mut().public = Some(Net::Ok("198.51.100.20".parse().unwrap()));
    w.tick(3);
    assert_eq!(w.remote.borrow().publics, 1);
    assert_eq!(
        addresses(&w),
        "10.8.0.2,192.168.1.20,198.51.100.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64"
    );
    settle(&mut w);
    let text = fs::read_to_string(&env).unwrap();
    let dispatcher = w.engine.borrow().dispatcher().unwrap().id.clone();

    // The provider hands the home connection a new public address: within the hour the
    // edge is asked again, and every task's egress refuses the new one; the token stays.
    w.remote.borrow_mut().public = Some(Net::Ok("198.51.100.77".parse().unwrap()));
    for _ in 0..10 {
        w.tick(61);
    }
    assert_eq!(
        w.remote.borrow().publics,
        1,
        "asked hourly, not every minute"
    );
    assert_eq!(fs::read_to_string(&env).unwrap(), text);
    for _ in 0..55 {
        w.tick(61);
    }
    assert_eq!(w.remote.borrow().publics, 2);
    assert_eq!(
        fs::read_to_string(&env).unwrap(),
        text.replace("198.51.100.20", "198.51.100.77")
    );
    assert_eq!(
        crate::dispatcher_env::addresses::seen(&w.agent.paths.data),
        Some("198.51.100.77".parse().unwrap())
    );
    settle(&mut w);
    assert_ne!(w.engine.borrow().dispatcher().unwrap().id, dispatcher);

    // No answer (the pool down, an IPv6-only host): the address last seen stays, and the
    // edge is asked again within minutes, not the hour — after a power cut the loop often
    // starts before the network is up, and the provider's new address must not wait.
    let text = fs::read_to_string(&env).unwrap();
    w.remote.borrow_mut().public = Some(Net::NoAnswer("timed out".into()));
    for _ in 0..61 {
        if w.remote.borrow().publics == 3 {
            break;
        }
        w.tick(61);
    }
    assert_eq!(w.remote.borrow().publics, 3, "the hourly ask, unanswered");
    for _ in 0..10 {
        w.tick(61);
    }
    assert_eq!(
        w.remote.borrow().publics,
        6,
        "asked again after one, two and four minutes, then every five"
    );
    assert_eq!(fs::read_to_string(&env).unwrap(), text);
    // The edge answers again, with a new address: refused within five minutes.
    w.remote.borrow_mut().public = Some(Net::Ok("198.51.100.99".parse().unwrap()));
    for _ in 0..5 {
        w.tick(61);
    }
    assert_eq!(
        fs::read_to_string(&env).unwrap(),
        text.replace("198.51.100.77", "198.51.100.99")
    );
    // Answered: hourly again.
    let asked = w.remote.borrow().publics;
    for _ in 0..30 {
        w.tick(61);
    }
    assert_eq!(w.remote.borrow().publics, asked);
}

#[test]
fn agent_toml_is_read_again_so_the_loop_never_puts_back_what_a_rotation_or_dispatcher_env_wrote() {
    use std::os::unix::fs::PermissionsExt as _;
    let mut w = with_host_env();
    let env = w.set_dir().join("etc/dispatcher.env");
    let secrets = w.dir.join("secrets");
    // The loop started without a budget; the owner then gives agent.toml one.
    fs::write(
        w.agent.paths.data.join("agent.toml"),
        format!(
            "[set]\nsecrets_dir = \"{}\"\n[envelope]\nagent_budget = {{ calls_per_task = 40 }}\n",
            secrets.display()
        ),
    )
    .unwrap();
    w.tick(3);
    settle(&mut w);
    let text = fs::read_to_string(&env).unwrap();
    assert!(
        text.contains(&format!(
            "\nOMARCHY_SECRETS_DIR={}\nOMARCHY_AGENT_CALLS_PER_TASK=40\n",
            secrets.display()
        )),
        "{text}"
    );
    // Rendered every minute from then on, it stays as agent.toml says.
    for _ in 0..3 {
        w.tick(61);
    }
    assert_eq!(fs::read_to_string(&env).unwrap(), text);
    assert_eq!(w.step(), "idle");
    // An agent.toml that does not read now (an edit half done): what the loop started with.
    fs::write(
        w.agent.paths.data.join("agent.toml"),
        "[envelope]\nagent_budget = { calls_per_tusk = 40 }\n",
    )
    .unwrap();
    w.tick(61);
    assert!(
        !fs::read_to_string(&env)
            .unwrap()
            .contains("OMARCHY_AGENT_CALLS_PER_TASK"),
        "the start's configuration has no budget"
    );
    // One others may write, or a symbolic link, is refused as the loop's start refuses it
    // (design v2 §12): its budget never reaches the file.
    let toml = w.agent.paths.data.join("agent.toml");
    let budget = format!(
        "[set]\nsecrets_dir = \"{}\"\n[envelope]\nagent_budget = {{ calls_per_task = 99 }}\n",
        secrets.display()
    );
    let budgeted = |w: &World| {
        fs::read_to_string(w.set_dir().join("etc/dispatcher.env"))
            .unwrap()
            .contains("\nOMARCHY_AGENT_CALLS_PER_TASK=99\n")
    };
    fs::write(&toml, &budget).unwrap();
    fs::set_permissions(&toml, fs::Permissions::from_mode(0o664)).unwrap();
    w.tick(61);
    assert!(!budgeted(&w), "a group-writable agent.toml is not read");
    let elsewhere = w.dir.join("elsewhere.toml");
    fs::write(&elsewhere, &budget).unwrap();
    fs::remove_file(&toml).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &toml).unwrap();
    w.tick(61);
    assert!(!budgeted(&w), "a link is not followed");
    // Its own again: read.
    fs::remove_file(&toml).unwrap();
    fs::write(&toml, &budget).unwrap();
    w.tick(61);
    assert!(budgeted(&w));
}

#[test]
fn interpolated_output_and_the_token_never_reach_the_disk_or_a_report() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.round();
    let work_root = w.dir.join("work").display().to_string();
    let mut files = Vec::new();
    let mut stack = vec![w.dir.clone()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p != w.token_file() {
                files.push(p);
            }
        }
    }
    assert!(files.len() > 8, "{files:?}");
    // The token is in its own file, 0400 (#327), and in no other: not the env file either.
    assert_eq!(
        crate::dispatcher_env::read_token(&w.token_file()).unwrap(),
        Some((TOKEN.to_owned(), 0o400))
    );
    for f in &files {
        let text = String::from_utf8_lossy(&fs::read(f).unwrap()).into_owned();
        assert!(!text.contains(TOKEN), "{} holds the token", f.display());
        // compose's interpolated output would carry the work root where the template
        // says ${OMARCHY_WORK_ROOT}.
        assert!(
            !text.contains(&format!("{work_root}:{work_root}")),
            "{} holds interpolated output",
            f.display()
        );
    }
    // And an engine error that echoes the token is scrubbed before the journal.
    crate::run::rollout::report(
        &mut w.agent.state,
        &w.agent.journal,
        w.now,
        crate::run::rollout::Outcome::EngineUnreachable,
        None,
        &format!("compose: invalid value OMARCHY_WORKER_TOKEN={TOKEN}"),
    );
    assert!(!w.journal().contains(TOKEN));
    assert!(!w.agent.state.round.detail.contains(TOKEN));
}

#[test]
fn a_changed_capacity_file_starts_a_round_and_drift_is_repaired() {
    let mut w = World::running_v1();
    let before = w.engine.borrow().dispatcher().unwrap().id.clone();
    fs::write(
        w.set_dir().join("run/capacity.json"),
        r#"{"schema":2,"units":5}"#,
    )
    .unwrap();
    w.tick(3);
    assert_ne!(w.step(), "idle");
    assert!(w.agent.state.rollout.why.contains("an input changed"));
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    let after = w.engine.borrow().dispatcher().unwrap().id.clone();
    assert_ne!(
        before, after,
        "the dispatcher was recreated with the new capacity file"
    );

    // Someone removes the dispatcher by hand: the safety timer brings it back.
    w.engine
        .borrow_mut()
        .containers
        .retain(|c| c.service != "dispatcher");
    for _ in 0..400 {
        w.tick(5);
        if w.engine.borrow().dispatcher().is_some() && w.step() == "idle" {
            break;
        }
    }
    assert_eq!(w.engine.borrow().dispatcher().unwrap().status, "running");
    assert_eq!(w.engine.borrow().tasks().len(), 1);
}

#[test]
fn status_reads_the_state_with_the_pool_down() {
    let mut w = World::running_v1();
    w.pool_answers(Net::NoAnswer("connection refused".into()));
    w.tick(200);
    let text = crate::run::cli::summary(&w.agent.state, w.now);
    assert!(
        text.contains("applied v1.0.0, target v1.0.0, floor v1.0.0"),
        "{text}"
    );
    assert!(text.contains("rollout:   idle"), "{text}");
    assert!(text.contains("round:     pool-unreachable"), "{text}");
    assert!(text.contains("pool:      no-answer"), "{text}");
}

#[test]
fn the_agent_resumes_a_round_after_a_restart_at_every_step() {
    // The ticks of one good round, then the same round with a restart after each tick.
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.round_now();
    let mut ticks = 0;
    while w.step() != "idle" {
        w.tick(3);
        ticks += 1;
    }
    assert!(ticks > 10, "{ticks}");
    for at in 0..ticks {
        let mut w = World::running_v1();
        let task = w.engine.borrow().tasks()[0].id.clone();
        w.release("v1.1.0");
        w.follow("v1.1.0", None);
        w.round_now();
        for _ in 0..at {
            w.tick(3);
        }
        let step = w.step();
        w.restart();
        for _ in 0..300 {
            if w.step() == "idle" && w.applied().as_deref() == Some("v1.1.0") {
                break;
            }
            w.tick(3);
        }
        assert_eq!(
            w.applied().as_deref(),
            Some("v1.1.0"),
            "restart at {step} (tick {at}): {:?}",
            w.outcome()
        );
        let e = w.engine.borrow();
        let dispatchers: Vec<_> = e
            .containers
            .iter()
            .filter(|c| c.service == "dispatcher")
            .collect();
        assert_eq!(dispatchers.len(), 1, "restart at {step}");
        assert_eq!(
            (
                dispatchers[0].release.as_str(),
                dispatchers[0].status.as_str()
            ),
            ("v1.1.0", "running")
        );
        assert_eq!(e.tasks()[0].id, task, "restart at {step}");
    }
}

#[test]
fn a_reboot_during_the_ready_wait_or_the_guard_does_not_revert_a_good_release() {
    for at in ["ready", "guard"] {
        let mut w = World::running_v1();
        w.release("v1.1.0");
        w.follow("v1.1.0", None);
        w.round_now();
        let reached = |w: &World| match &w.agent.state.rollout.step {
            Step::Replace {
                files: Files::Staging,
                phase: Phase::Ready { .. },
            } => at == "ready",
            Step::Guard(_) => at == "guard",
            _ => false,
        };
        while !reached(&w) {
            assert_ne!(w.step(), "idle", "{at}");
            w.tick(3);
        }
        // The host is down for five minutes; at boot the engine brings the dispatcher
        // back, which answers /ready once it re-adopted its leases, 15 s later.
        w.now += 300;
        {
            let mut e = w.engine.borrow_mut();
            e.clock = w.now;
            let d = e
                .containers
                .iter_mut()
                .find(|c| c.service == "dispatcher")
                .unwrap();
            d.ready_at = w.now + 15;
        }
        let before = w.changes().len();
        w.restart();
        while w.step() != "idle" {
            w.tick(3);
        }
        assert_eq!(w.outcome().0, "ok", "{at}: {:?}", w.outcome());
        assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{at}");
        assert!(w.agent.state.quarantine.is_empty(), "{at}");
        assert_eq!(w.changes().len(), before, "{at}: nothing replaced again");
    }
}

#[test]
fn a_pull_failure_changes_nothing_and_the_next_poll_retries() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.engine.borrow_mut().pull_fails = true;
    w.round();
    assert_eq!(w.outcome().0, "pull-failed");
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(w.engine.borrow().dispatcher().unwrap().release, "v1.0.0");
    w.engine.borrow_mut().pull_fails = false;
    w.tick(200);
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
}

#[test]
fn a_lint_violation_is_refused_by_name() {
    let mut w = World::running_v1();
    fs::write(
        w.set_dir().join("compose.override.yml"),
        "services:\n  dispatcher:\n    environment:\n      GITHUB_TOKEN: ${GITHUB_TOKEN}\n",
    )
    .unwrap();
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.round();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "refused");
    assert!(detail.starts_with("lint: "), "{detail}");
    assert!(detail.contains("secret_interpolation"), "{detail}");
    assert_eq!(w.agent.state.round.step, "lint");
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
}

#[test]
fn an_engine_that_does_not_answer_changes_nothing_until_it_does() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.engine.borrow_mut().down = true;
    w.round_now();
    for _ in 0..20 {
        w.tick(3);
    }
    assert_eq!(w.step(), "plan");
    assert_eq!(w.outcome().0, "engine-unreachable");
    w.engine.borrow_mut().down = false;
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
}

#[test]
fn a_newer_release_preempts_a_round_before_its_commit() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.release("v1.2.0");
    w.follow("v1.1.0", None);
    w.round_now();
    while w.step() != "pull" {
        w.tick(3);
    }
    w.follow("v1.2.0", None);
    w.round_now();
    assert_eq!(w.agent.state.rollout.target, r("v1.2.0"));
    // Preempted at pull: the new round rendered v1.2.0 in the same tick.
    assert_eq!(w.agent.state.rollout.step, Step::Lint);
    assert!(
        w.journal()
            .contains(r#""by":"v1.2.0","event":"preempted","step":"pull""#),
        "{}",
        w.journal()
    );
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"));
    assert_eq!(w.agent.state.floor, r("v1.2.0"));
}

#[test]
fn a_follow_answer_without_a_release_changes_nothing() {
    let mut w = World::running_v1();
    let changes = w.changes().len();
    w.pool_answers(Net::Ok(Follow::default()));
    w.round_now();
    w.tick(300);
    assert_eq!(w.changes().len(), changes);
    assert_eq!(w.step(), "idle");
}

#[test]
fn an_older_release_does_not_preempt_a_round() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.release("v1.2.0");
    w.follow("v1.2.0", None);
    w.round_now();
    while w.step() != "pull" {
        w.tick(3);
    }
    // Admitted, but neither newer nor under a rollback statement: the round goes on.
    w.follow("v1.1.0", None);
    w.round_now();
    assert_eq!(w.agent.state.rollout.target, r("v1.2.0"));
    assert!(!w.journal().contains("\"preempted\""), "{}", w.journal());
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"));
}

#[test]
fn an_update_order_seen_while_a_revert_finishes_is_kept_for_the_next_poll() {
    let mut w = World::running_v1();
    publish(
        &w.remote,
        "v1.1.0",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "    command: [broken]\n",
    );
    w.follow("v1.1.0", None);
    w.round_now();
    while !matches!(
        w.agent.state.rollout.step,
        Step::Replace {
            files: crate::run::state::Files::LastGood,
            ..
        }
    ) {
        w.tick(3);
    }
    w.follow("v1.1.0", Some("ord_1"));
    w.round_now();
    assert_eq!(w.agent.state.update_seen, None);
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "rolled-back");
    assert!(!w.agent.state.quarantine.is_empty());
    // The next poll takes the order: the quarantine is lifted and the retry starts.
    w.round_now();
    assert_eq!(w.agent.state.update_seen.as_deref(), Some("ord_1"));
    assert_eq!(w.agent.state.rollout.target, r("v1.1.0"));
    assert_ne!(w.step(), "idle");
    assert!(w.journal().contains("quarantine-lifted"), "{}", w.journal());
}

/// Ticks a round to v1.1.0 until it is at `commit`.
fn at_commit() -> World {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.follow("v1.1.0", None);
    w.round_now();
    while w.step() != "commit" {
        w.tick(3);
    }
    w
}

fn assert_committed(w: &World) {
    assert_eq!(w.step(), "idle");
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{:?}", w.outcome());
    let good = w.agent.paths.last_good(&w.agent.cfg.set_name);
    assert!(good.join("compose.yml").exists());
    let overlay = fs::read_to_string(w.set_dir().join("agent.yml")).unwrap();
    assert!(
        overlay.contains("org.omarchy-pool.agent.release: \"v1.1.0\""),
        "{overlay}"
    );
}

#[test]
fn a_commit_that_died_after_its_rename_finishes_after_a_restart() {
    let mut w = at_commit();
    // What commit does up to its rename, then the process dies before state.json is saved.
    let (staging, good) = (
        w.agent.paths.staging(&w.agent.cfg.set_name),
        w.agent.paths.last_good(&w.agent.cfg.set_name),
    );
    fs::remove_dir_all(&good).unwrap();
    fs::rename(&staging, &good).unwrap();
    w.restart();
    assert_eq!(w.step(), "commit");
    w.tick(3);
    assert_committed(&w);
}

#[test]
fn a_commit_whose_set_directory_write_failed_finishes_once_it_can_write() {
    use std::os::unix::fs::PermissionsExt as _;
    let mut w = at_commit();
    let set = w.set_dir();
    fs::set_permissions(&set, fs::Permissions::from_mode(0o500)).unwrap();
    w.now += 3;
    let failed = w.agent.tick(w.now, false);
    fs::set_permissions(&set, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(failed.is_err(), "{failed:?}");
    // The step was not saved as done: it runs again, after a restart too.
    w.restart();
    assert_eq!(w.step(), "commit");
    w.tick(3);
    assert_committed(&w);
}
