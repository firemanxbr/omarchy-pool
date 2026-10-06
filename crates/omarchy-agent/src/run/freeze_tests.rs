//! #326's freeze detection against a stubbed pool and GitHub, on the test clock: GitHub's
//! latest release is read every six hours and nothing else; a pool that names an older one
//! for more than a day is reported `pool-behind-github`, never acted on; a revoked release
//! or a rollback statement that retracts GitHub's latest is no freeze.

use crate::run::fake::{relay_statement, World};
use crate::run::orders::iso;
use crate::run::pool::Net;
use crate::version::Release;

use super::{AHEAD_S, EVERY_S, RETRY_S};

fn r(s: &str) -> Release {
    Release::parse(s).unwrap()
}

/// GitHub says its latest release is `tag`, and is read at the next tick (the host's first
/// round read it already, unanswered).
fn github(w: &mut World, tag: &str) {
    w.remote.borrow_mut().github = Some(Net::Ok(r(tag)));
    w.agent.state.github.next_at = 0;
}

fn reads(w: &World) -> u32 {
    w.remote.borrow().github_reads
}

/// Ticks `secs` on, ten minutes at a time.
fn wait(w: &mut World, secs: i64) {
    let mut left = secs;
    while left > 0 {
        let step = left.min(600);
        w.tick(step);
        left -= step;
    }
}

fn behind(w: &mut World) -> serde_json::Value {
    w.tick(20);
    w.last_report()["release"]["pool_behind_github"].clone()
}

#[test]
fn a_pool_that_names_an_older_release_than_github_for_a_day_is_reported_and_nothing_changes() {
    let mut w = World::running_v1();
    // GitHub's latest is v1.1.0; the pool still names v1.0.0, which runs.
    github(&mut w, "v1.1.0");
    let before = reads(&w);
    w.tick(1);
    let first = w.now;
    assert_eq!(reads(&w), before + 1);
    assert_eq!(w.agent.state.github.latest, Some(r("v1.1.0")));
    assert_eq!(w.agent.state.github.ahead_since, Some(first));
    w.tick(20);
    let report = w.last_report();
    assert_eq!(report["release"]["github_latest"], "v1.1.0");
    assert_eq!(
        report["release"]["pool_behind_github"],
        serde_json::Value::Null
    );
    let changes = w.changes().len();

    // A day is not more than a day: nothing said yet. GitHub was read every six hours, and
    // only its tag: v1.1.0's bundle was never fetched.
    wait(&mut w, AHEAD_S - 60);
    assert_eq!(behind(&mut w), serde_json::Value::Null);
    assert_eq!(
        reads(&w),
        before + u32::try_from(AHEAD_S / EVERY_S).unwrap()
    );
    assert!(!w
        .agent
        .paths
        .bundles()
        .join("omarchy-host-v1.1.0.tar.gz")
        .exists());
    // More than a day: pool-behind-github, in the report and on the journal, once.
    wait(&mut w, 60);
    assert_eq!(
        behind(&mut w),
        serde_json::json!({"github": "v1.1.0", "pool": "v1.0.0", "since": iso(first)})
    );
    wait(&mut w, 3600);
    assert_eq!(w.journal().matches("pool-behind-github:").count(), 1);
    // Never acted on: no round, nothing touched, the target still the pool's.
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(w.agent.state.target, Some(r("v1.0.0")));
    assert_eq!(w.step(), "idle");
    assert_eq!(w.changes().len(), changes);
    let text = crate::run::cli::summary(&w.agent.state, w.now);
    assert!(text.contains("github:    latest release v1.1.0"), "{text}");
    assert!(text.contains("pool-behind-github"), "{text}");

    // The pool names v1.1.0 again: over, said once.
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.poll();
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(behind(&mut w), serde_json::Value::Null);
    assert_eq!(w.agent.state.github.ahead_since, None);
    assert_eq!(w.journal().matches("\"event\":\"freeze\"").count(), 2);
}

#[test]
fn a_revoked_release_or_one_a_rollback_statement_retracts_is_no_freeze() {
    // GitHub's latest is revoked by a release the host verified: the pool is right to
    // name an older one.
    let mut w = World::running_v1();
    w.agent.state.revoked.insert(r("v1.1.0"));
    github(&mut w, "v1.1.0");
    wait(&mut w, AHEAD_S + 3600);
    assert_eq!(behind(&mut w), serde_json::Value::Null);
    assert_eq!(w.agent.state.github.ahead_since, None);

    // rollback.yml retracted v1.1.0 and v1.2.0: the pool names v1.0.0 on purpose, and
    // GitHub's latest stays v1.2.0. The statement the pool relays, verified, says so.
    let mut w = World::running_v1();
    relay_statement(&w.remote, 1, "v1.0.0", "v1.2.0", b"signed");
    github(&mut w, "v1.2.0");
    wait(&mut w, AHEAD_S + 3600);
    assert_eq!(behind(&mut w), serde_json::Value::Null);
    assert_eq!(
        w.agent.state.github.retracted,
        Some((r("v1.0.0"), r("v1.2.0")))
    );
    // A forged one explains nothing; nor one that stops below GitHub's latest.
    for (sig, through) in [(&b"forged"[..], "v1.2.0"), (b"signed", "v1.1.0")] {
        let mut w = World::running_v1();
        relay_statement(&w.remote, 1, "v1.0.0", through, sig);
        github(&mut w, "v1.2.0");
        wait(&mut w, AHEAD_S + 3600);
        assert_eq!(behind(&mut w)["github"], "v1.2.0", "{through}");
    }
}

#[test]
fn a_github_that_does_not_answer_is_asked_again_within_the_hour_and_changes_nothing() {
    let mut w = World::running_v1();
    w.agent.state.github.next_at = 0;
    let before = reads(&w);
    w.tick(1);
    assert_eq!(reads(&w), before + 1);
    assert_eq!(w.agent.state.github.next_at, w.now + RETRY_S);
    assert_eq!(w.agent.state.github.latest, None);
    wait(&mut w, RETRY_S + 60);
    assert_eq!(reads(&w), before + 2);
    assert_eq!(behind(&mut w), serde_json::Value::Null);
    // A newer pool than GitHub (a release GitHub shows later, or a draft) is no freeze.
    github(&mut w, "v0.9.0");
    wait(&mut w, RETRY_S + 60);
    assert_eq!(w.agent.state.github.latest, Some(r("v0.9.0")));
    assert_eq!(w.agent.state.github.ahead_since, None);
    assert_eq!(w.last_report()["release"]["github_latest"], "v0.9.0");
}
