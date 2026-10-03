//! #315's acceptance criteria, against a fake engine and a fake pool (the real-engine
//! test is `tests/agent-run-loop.sh`).

use std::fs;

use crate::run::fake::{publish, relay_statement, rendered_compose, World, T0, TOKEN};
use crate::run::pool::{HostState, Net};
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
    w.target("v1.1.0", None);
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
    w.target("v1.1.0", None);
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
    w.target("v1.1.0", Some("ord_1"));
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
    w.target("v1.1.0", None);
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
    w.target("v1.1.1", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.1"));
}

#[test]
fn two_ordered_restarts_during_the_guard_do_not_fail_it() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.target("v1.1.0", None);
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
    w.target("v1.1.0", None);
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
    w.target("v1.1.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    let task = w.engine.borrow().tasks()[0].id.clone();

    // v1.2.0 is rolling out ...
    w.release("v1.2.0");
    w.target("v1.2.0", None);
    w.round_now();
    while w.step() != "guard" {
        w.tick(3);
    }
    // ... when rollback.yml retracts everything above v1.0.0 and the pool goes back to it.
    relay_statement(&w.remote, 1, "v1.0.0", "v1.2.0", b"signed");
    w.target("v1.0.0", None);
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
    w.target("v1.2.0", None);
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
    w.target("v1.2.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"));
    let changes = w.changes().len();

    let refused = |w: &mut World, target: &str, reason: &str| {
        w.target(target, None);
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
    let polls = w.remote.borrow().polls;
    for _ in 0..(2 * 3600 / 30) {
        w.tick(30);
    }
    let asked = w.remote.borrow().polls - polls;
    assert!(
        (12..=30).contains(&asked),
        "{asked} polls in two hours of 5xx"
    );
    assert_eq!(w.agent.state.poll.backoff_s, 600);
    assert_eq!(w.outcome().0, "pool-unreachable");

    // Then four hours of 401s: hourly polls, nothing changes.
    w.pool_answers(Net::Unauthorized(401));
    w.tick(600);
    let polls = w.remote.borrow().polls;
    for _ in 0..(4 * 3600 / 60) {
        w.tick(60);
    }
    let asked = w.remote.borrow().polls - polls;
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
    w.target("v1.1.0", None);
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
fn with_the_dispatcher_env_missing_the_dispatcher_is_held_and_the_reason_reported() {
    let mut w = World::new();
    fs::remove_file(w.set_dir().join("etc/dispatcher.env")).unwrap();
    w.release("v1.0.0");
    w.target("v1.0.0", None);
    w.round();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "held");
    assert!(
        detail.contains("awaiting the owner's Confirm: etc/dispatcher.env is missing"),
        "{detail}"
    );
    assert!(w.changes().is_empty(), "{:?}", w.changes());
    assert_eq!(w.applied(), None);

    // The owner confirms; the token arrives; the next poll starts the dispatcher.
    fs::write(
        w.set_dir().join("etc/dispatcher.env"),
        format!("OMARCHY_WORKER_TOKEN={TOKEN}\n"),
    )
    .unwrap();
    w.round();
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
}

#[test]
fn interpolated_output_and_the_token_never_reach_the_disk_or_a_report() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.round();
    let work_root = w.dir.join("work").display().to_string();
    let mut files = Vec::new();
    let mut stack = vec![w.dir.clone()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if !p.ends_with("etc/dispatcher.env") {
                files.push(p);
            }
        }
    }
    assert!(files.len() > 8, "{files:?}");
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
    w.target("v1.1.0", None);
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
        w.target("v1.1.0", None);
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
        w.target("v1.1.0", None);
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
    w.target("v1.1.0", None);
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
    w.target("v1.1.0", None);
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
    w.target("v1.1.0", None);
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
    w.target("v1.1.0", None);
    w.round_now();
    while w.step() != "pull" {
        w.tick(3);
    }
    w.target("v1.2.0", None);
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
fn a_host_state_without_a_release_changes_nothing() {
    let mut w = World::running_v1();
    let changes = w.changes().len();
    w.pool_answers(Net::Ok(HostState::default()));
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
    w.target("v1.2.0", None);
    w.round_now();
    while w.step() != "pull" {
        w.tick(3);
    }
    // Admitted, but neither newer nor under a rollback statement: the round goes on.
    w.target("v1.1.0", None);
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
    w.target("v1.1.0", None);
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
    w.target("v1.1.0", Some("ord_1"));
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
    w.target("v1.1.0", None);
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
