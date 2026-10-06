//! #326's soak against the fake engine and pool, on the test clock: a new release waits the
//! owner's minutes from when the pool first names it — another landing meanwhile waits its
//! own —, the report says until when for the pool's claim grace, a rollback statement
//! applies at once, `reconcile-now`, an Update and SIGUSR1 never skip it, and no soak keeps
//! a host more than `MAX_BEHIND_S` (100 minutes) behind. The agent's own update waits with its release unless
//! `agent.urgent` (`selfupdate_tests.rs`).

use crate::run::fake::{publish, relay_statement, World};
use crate::run::orders::iso;
use crate::version::Release;

use super::MAX_BEHIND_S;

fn r(s: &str) -> Option<Release> {
    Release::parse(s)
}

/// A host on v1.0.0 whose owner set a soak of `minutes`.
fn soaking(minutes: u32) -> World {
    let mut w = World::running_v1();
    w.agent.cfg.policy.soak_minutes = minutes;
    w
}

/// Ticks `secs` on, a minute at a time (the pool polled as it falls due, every two minutes).
fn wait(w: &mut World, secs: i64) {
    let mut left = secs;
    while left > 0 {
        let step = left.min(60);
        w.tick(step);
        left -= step;
    }
}

/// Ticks on until `at`.
fn wait_until(w: &mut World, at: i64) {
    let secs = at - w.now;
    wait(w, secs);
}

/// Ticks (3 s apart) until the round in flight is over.
fn settle(w: &mut World) {
    for _ in 0..400 {
        if w.step() == "idle" {
            return;
        }
        w.tick(3);
    }
    panic!("the round did not end: {:?}", w.agent.state.rollout);
}

/// The kept answer of host order `id`: its outcome and words.
fn answer(w: &World, id: &str) -> (String, String) {
    let a = w
        .agent
        .state
        .orders
        .answers
        .iter()
        .find(|a| a.id == id)
        .unwrap_or_else(|| panic!("{id} was not answered"));
    (a.outcome.clone(), a.detail.clone())
}

#[test]
fn a_new_release_waits_the_soak_and_two_landing_meanwhile_keep_the_host_soaking() {
    let mut w = soaking(30);
    let changes = w.changes().len();
    // v1.1.0 lands: the next poll names it and the soak starts there.
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.poll();
    let first = w.now;
    assert_eq!(w.step(), "idle");
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "held");
    assert!(
        detail.starts_with(&format!(
            "v1.1.0 waits for the owner's soak until {} (soak_minutes = 30)",
            iso(first + 1800)
        )),
        "{detail}"
    );
    // Its bundle was fetched and verified meanwhile (a soaking host learns revocations).
    assert!(w
        .agent
        .paths
        .bundles()
        .join("omarchy-host-v1.1.0.tar.gz")
        .exists());
    w.tick(20);
    let report = w.last_report();
    assert_eq!(report["release"]["soak_minutes"], 30);
    assert_eq!(report["release"]["soaking_until"], iso(first + 1800));
    assert_eq!(report["release"]["target"], "v1.1.0");

    // Ten minutes on, v1.2.0 lands too: it waits its own thirty minutes from then.
    wait(&mut w, 600);
    w.release("v1.2.0");
    w.target("v1.2.0", None);
    w.poll();
    let second = w.now;
    assert_eq!(w.outcome().0, "held");
    assert!(
        w.outcome().1.starts_with("v1.2.0 waits"),
        "{:?}",
        w.outcome()
    );
    w.tick(20);
    assert_eq!(
        w.last_report()["release"]["soaking_until"],
        iso(second + 1800)
    );
    // Said once: the poll every two minutes does not journal it again.
    wait(&mut w, 600);
    assert_eq!(
        w.journal()
            .matches("v1.2.0 waits for the owner's soak")
            .count(),
        1
    );

    // Past v1.1.0's thirty minutes nothing moves: the pool names v1.2.0.
    wait_until(&mut w, first + 1800 + 60);
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(w.changes().len(), changes, "nothing touched while it soaks");

    // Thirty minutes after v1.2.0 was named, the next poll takes it.
    wait_until(&mut w, second + 1800 - 30);
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    wait(&mut w, 200);
    assert_ne!(w.step(), "idle", "its round: {:?}", w.outcome());
    let started = w.agent.state.rollout.since;
    assert!(started >= second + 1800 && started < second + 1800 + 200);
    // While its round runs the report keeps the soak's end, so the pool's grace covers it.
    w.tick(10);
    assert_eq!(
        w.last_report()["release"]["soaking_until"],
        iso(second + 1800)
    );
    settle(&mut w);
    assert_eq!(w.applied().as_deref(), Some("v1.2.0"), "{:?}", w.outcome());
    assert_eq!(w.outcome().0, "ok");
    w.tick(20);
    assert_eq!(
        w.last_report()["release"]["soaking_until"],
        serde_json::Value::Null
    );
    // The next poll names what runs: the soak's record goes.
    w.poll();
    assert_eq!(w.agent.state.soak, None);
    // A running task kept running throughout.
    assert_eq!(w.engine.borrow().tasks()[0].status, "running");
}

#[test]
fn a_rollback_statement_is_applied_at_once_on_a_soaking_host() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    // Its owner sets a soak; v1.2.0 lands and waits.
    w.agent.cfg.policy.soak_minutes = 60;
    wait(&mut w, 600);
    w.release("v1.2.0");
    w.target("v1.2.0", None);
    w.poll();
    assert_eq!(w.outcome().0, "held");
    // rollback.yml retracts everything above v1.0.0: the pool names v1.0.0 and relays the
    // statement — the host applies it now, not an hour later.
    wait(&mut w, 120);
    relay_statement(&w.remote, 1, "v1.0.0", "v1.2.0", b"signed");
    w.target("v1.0.0", None);
    w.poll();
    assert!(w.agent.state.rollout.rollback, "{:?}", w.outcome());
    assert_eq!(w.agent.state.rollout.target, r("v1.0.0"));
    settle(&mut w);
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"), "{:?}", w.outcome());
    assert_eq!(w.agent.state.floor, r("v1.0.0"));
    assert_eq!(w.agent.state.soak, None);
    w.tick(20);
    assert_eq!(
        w.last_report()["release"]["soaking_until"],
        serde_json::Value::Null
    );
}

#[test]
fn reconcile_now_an_update_and_sigusr1_never_skip_the_soak() {
    let mut w = soaking(30);
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.poll();
    assert_eq!(w.outcome().0, "held");
    let changes = w.changes().len();
    // reconcile-now: answered, and no round started — the soak holds it like any.
    w.orders(&[("reconcile-now", "ho_r", 3600)]);
    w.poll();
    assert_eq!(w.step(), "idle");
    let (outcome, detail) = answer(&w, "ho_r");
    assert_eq!(outcome, "done");
    assert!(
        detail.starts_with(
            "no round started; the last round says held: v1.1.0 waits for the owner's soak"
        ),
        "{detail}"
    );
    // An Update (the pool's "reconcile now" for the agent) and SIGUSR1 neither.
    wait(&mut w, 5);
    w.target("v1.1.0", Some("wo_1"));
    w.poll();
    assert!(w.agent.state.orders.seen("wo_1"));
    assert_eq!(w.step(), "idle");
    w.round_now();
    assert_eq!(w.step(), "idle");
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(w.changes().len(), changes);
    assert_eq!(w.outcome().0, "held");
    // A round to the release that runs has nothing to wait for.
    w.target("v1.0.0", None);
    w.round_now();
    assert_ne!(w.step(), "idle");
    assert_eq!(w.agent.state.soak, None);
}

#[test]
fn no_soak_for_the_first_release_nor_with_soak_minutes_zero() {
    // The first release a host applies: nothing runs that the soak would protect.
    let mut w = World::new();
    w.agent.cfg.policy.soak_minutes = 30;
    w.release("v1.0.0");
    w.target("v1.0.0", None);
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"), "{:?}", w.outcome());
    // No soak set: a new release goes at the next poll, and the report says none.
    w.agent.cfg.policy.soak_minutes = 0;
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.poll();
    assert_ne!(w.step(), "idle");
    assert_eq!(w.agent.state.soak, None);
    w.tick(20);
    let report = w.last_report();
    assert_eq!(report["release"]["soak_minutes"], 0);
    assert_eq!(report["release"]["soaking_until"], serde_json::Value::Null);
}

#[test]
fn a_quarantined_release_reports_no_soak() {
    let mut w = soaking(30);
    publish(
        &w.remote,
        "v1.1.0",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "    command: [broken]\n",
    );
    w.target("v1.1.0", None);
    w.poll();
    // Its soak over, its round's guard reverts it.
    wait(&mut w, 1800 + 200);
    settle(&mut w);
    assert_eq!(w.outcome().0, "rolled-back", "{:?}", w.outcome());
    assert!(w.agent.state.quarantine.contains_key(&r("v1.1.0").unwrap()));
    w.tick(20);
    // The host reverted it: it is not waiting for it, and the pool's grace is not its.
    assert_eq!(
        w.last_report()["release"]["soaking_until"],
        serde_json::Value::Null
    );
}

#[test]
fn releases_landing_faster_than_the_soak_keep_a_host_at_most_100_minutes_behind() {
    // An hour's soak, and a release every forty minutes: each would wait its hour, so none
    // would ever go; the host takes the one named when it has been behind for 100 minutes,
    // the longest soak an owner may set — inside the pool's two-hour grace with its round.
    let mut w = soaking(60);
    let mut behind_since = None;
    for (i, rel) in ["v1.1.0", "v1.2.0", "v1.3.0"].iter().enumerate() {
        if i > 0 {
            wait(&mut w, 2400);
        }
        w.release(rel);
        w.target(rel, None);
        w.poll();
        behind_since.get_or_insert(w.now);
        assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    }
    assert_eq!(MAX_BEHIND_S, 100 * 60);
    let bound = behind_since.unwrap() + MAX_BEHIND_S;
    assert_eq!(w.agent.state.soak.as_ref().unwrap().until, bound);
    w.tick(20);
    assert_eq!(w.last_report()["release"]["soaking_until"], iso(bound));
    wait_until(&mut w, bound - 30);
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    wait(&mut w, 200);
    settle(&mut w);
    assert_eq!(w.applied().as_deref(), Some("v1.3.0"), "{:?}", w.outcome());
}

#[test]
fn the_soak_survives_a_restart() {
    let mut w = soaking(30);
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.poll();
    let first = w.now;
    wait(&mut w, 900);
    w.restart();
    w.agent.cfg.policy.soak_minutes = 30;
    w.poll();
    assert_eq!(w.outcome().0, "held");
    assert_eq!(w.agent.state.soak.as_ref().unwrap().until, first + 1800);
    // `omarchy-agent status` says it.
    let text = crate::run::cli::summary(&w.agent.state, w.now);
    assert!(text.contains("soak:      v1.1.0 waits"), "{text}");
}

/// The report with a soak and `pool-behind-github` as the pool reads them
/// (`tests/fixtures/host-api/report-soak.json`, which worker/test/host-soak.test.ts posts,
/// signed, and reads back for its claim grace and the host page): a host whose owner set a
/// 30-minute soak, soaking v1.1.0, while GitHub has shown v1.2.0 for more than a day. The
/// contract both sides read, written once.
#[test]
fn the_report_with_a_soak_and_a_freeze_keeps_the_shape_the_pool_reads() {
    use crate::run::orders::tests::{fixture, shape};
    let mut w = soaking(30);
    w.remote.borrow_mut().github = Some(crate::run::pool::Net::Ok(r("v1.2.0").unwrap()));
    w.agent.state.github.next_at = 0;
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.poll();
    let seen = w.now;
    w.agent.state.github.ahead_since = Some(w.now - super::super::freeze::AHEAD_S - 60);
    w.tick(20);
    let report = w.last_report();
    if std::env::var_os("OMARCHY_DUMP_REPORT").is_some() {
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    }
    assert_eq!(report["release"]["soaking_until"], iso(seen + 1800));
    assert_eq!(report["release"]["github_latest"], "v1.2.0");
    assert_eq!(report["release"]["pool_behind_github"]["pool"], "v1.1.0");
    assert_eq!(report["round"]["outcome"], "held");
    assert_eq!(shape(&report), shape(&fixture("report-soak.json")));
}
