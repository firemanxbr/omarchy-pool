//! The state machine's pieces; whole rounds are in `agent_tests.rs`.

use std::fs;

use super::*;
use crate::run::state::{tempdir, Quarantine, Rollout};

#[test]
fn only_steps_before_commit_are_preemptible() {
    for (step, yes) in [
        (Step::Idle, false),
        (Step::Render, true),
        (Step::Lint, true),
        (Step::Plan, true),
        (Step::Pull, true),
        (
            Step::Replace {
                files: Files::Staging,
                phase: Phase::Stop,
            },
            true,
        ),
        (
            Step::Replace {
                files: Files::LastGood,
                phase: Phase::Stop,
            },
            false,
        ),
        (
            Step::Guard(Guard {
                started: 0,
                container: String::new(),
                restarts0: 0,
                streak: 0,
                last_sample: 0,
            }),
            true,
        ),
        (Step::Commit, false),
        (Step::Revert { why: String::new() }, false),
    ] {
        assert_eq!(preemptible(&step), yes, "{step:?}");
    }
}

#[test]
fn the_inputs_hash_follows_the_override_etc_and_the_capacity_file() {
    let dir = tempdir();
    let h0 = inputs_hash(&dir);
    fs::create_dir_all(dir.join("etc")).unwrap();
    fs::create_dir_all(dir.join("run")).unwrap();
    fs::write(dir.join("etc/dispatcher.env"), "T=1").unwrap();
    let h1 = inputs_hash(&dir);
    fs::write(dir.join("run/capacity.json"), "{}").unwrap();
    let h2 = inputs_hash(&dir);
    fs::write(dir.join("compose.override.yml"), "services: {}").unwrap();
    let h3 = inputs_hash(&dir);
    fs::write(dir.join("unrelated"), "x").unwrap();
    assert_eq!(inputs_hash(&dir), h3);
    let all = [h0, h1, h2, h3];
    for (i, a) in all.iter().enumerate() {
        assert!(a.starts_with("sha256:"));
        assert!(all[i + 1..].iter().all(|b| b != a), "{all:?}");
    }
}

#[test]
fn quarantine_waits_an_hour_then_for_a_newer_release() {
    let r = Release::parse("v1.1.0").unwrap();
    let mut s = State::default();
    assert_eq!(quarantined(&s, r, 0), None);
    s.quarantine.insert(
        r,
        Quarantine {
            until: Some(100),
            reverts: 1,
        },
    );
    assert!(quarantined(&s, r, 99).is_some());
    assert_eq!(quarantined(&s, r, 100), None);
    s.quarantine.insert(
        r,
        Quarantine {
            until: None,
            reverts: 2,
        },
    );
    assert!(quarantined(&s, r, i64::MAX)
        .unwrap()
        .contains("newer release"));
    assert_eq!(quarantined(&s, Release::parse("v1.2.0").unwrap(), 0), None);
}

#[test]
fn the_lint_reads_the_rendered_template_as_written() {
    let compose = crate::run::fake::rendered_compose("");
    let m = crate::verify::tests_support::manifest_json("v1.0.0", "v1.0.0", &[]);
    let pins = Pins {
        release: Release::parse("v1.0.0").unwrap(),
        created: "2027-01-14T08:00:00Z".into(),
        worker: format!(
            "{}@{}",
            m["inner"]["images"]["worker"]["repo"].as_str().unwrap(),
            m["inner"]["images"]["worker"]["index"].as_str().unwrap()
        ),
        build_aarch64: m["inner"]["images"]["build"]["aarch64"]
            .as_str()
            .unwrap()
            .into(),
        build_x86_64: m["inner"]["images"]["build"]["x86_64"]
            .as_str()
            .unwrap()
            .into(),
    };
    let view = pins.lint_view(&compose);
    assert!(
        view.contains("image: ghcr.io/firemanxbr/omarchy-worker@RELEASE@"),
        "{view}"
    );
    assert!(view.contains("\"@BUILD_AARCH64@\""), "{view}");
    lint::lint_compose(&view, None, &lint::Envelope::reference(), Engine::Rootful).unwrap();
    // An image the manifest does not name stays a literal digest, and is refused.
    let other = compose.replace(
        &pins.worker,
        &format!(
            "ghcr.io/firemanxbr/omarchy-worker@sha256:{}",
            "0".repeat(64)
        ),
    );
    assert!(lint::lint_compose(
        &pins.lint_view(&other),
        None,
        &lint::Envelope::reference(),
        Engine::Rootful
    )
    .is_err());
}

#[test]
fn a_round_with_no_target_ends_refused() {
    let w = crate::run::fake::World::new();
    let mut state = State {
        rollout: Rollout {
            step: Step::Render,
            ..Rollout::default()
        },
        ..State::default()
    };
    let mut ctx = Ctx {
        cfg: &w.agent.cfg,
        paths: &w.agent.paths,
        driver: None,
        journal: &w.agent.journal,
        now: 5,
    };
    step(&mut state, None, &mut ctx).unwrap();
    assert_eq!(
        (state.rollout.step.name(), state.round.outcome.as_str()),
        ("idle", "refused")
    );
}

#[test]
fn the_guard_forgives_ordered_restarts_and_nothing_else() {
    let g0 = Guard {
        started: 100,
        container: "c".into(),
        restarts0: 3,
        streak: 0,
        last_sample: 100,
    };
    let unit = |status: &str, restarts: u64| Unit {
        id: "c".into(),
        service: "dispatcher".into(),
        status: status.into(),
        restarts,
        exit_code: 0,
        config_hash: String::new(),
        release: String::new(),
    };
    let exit = |at, code| Exit { at, code };
    let judged = |u: &Unit, exits: &[Exit]| judge(&mut g0.clone(), u, exits, false);
    // Two ordered restarts (exit 75): not a failure.
    assert_eq!(
        judged(&unit("running", 5), &[exit(110, 75), exit(130, 75)]),
        Ok(true)
    );
    // Two restarts that were not ordered, a non-zero exit, a stopped dispatcher: failures.
    assert!(judged(&unit("running", 5), &[])
        .unwrap_err()
        .contains("restarted 2 times"));
    assert!(judged(&unit("running", 5), &[exit(110, 0), exit(120, 75)]).is_ok());
    assert!(judged(&unit("running", 4), &[exit(110, 1)])
        .unwrap_err()
        .contains("exited with 1"));
    assert!(judged(&unit("running", 4), &[exit(110, 137)]).is_err());
    assert!(judged(&unit("exited", 3), &[])
        .unwrap_err()
        .contains("not restarting"));
    // Restarting once is a sample to wait on; twice in a row is a streak.
    let mut g = g0.clone();
    assert_eq!(judge(&mut g, &unit("restarting", 3), &[], false), Ok(false));
    assert!(judge(&mut g, &unit("restarting", 3), &[], false)
        .unwrap_err()
        .contains("keeps restarting"));
    let mut g = g0;
    assert_eq!(
        judge(&mut g, &unit("restarting", 4), &[exit(110, 75)], true),
        Ok(false)
    );
    assert_eq!(
        judge(&mut g, &unit("running", 4), &[exit(110, 75)], true),
        Ok(true)
    );
    assert_eq!(g.streak, 0);
    // Podman has no `restarting`: right after an ordered restart a stopped sample is the
    // gap before the engine restarts it, not a failure; outside that window it is.
    assert_eq!(
        judge(&mut g, &unit("exited", 4), &[exit(110, 75)], true),
        Ok(false)
    );
    assert!(judge(&mut g, &unit("exited", 4), &[exit(110, 75)], false)
        .unwrap_err()
        .contains("not restarting"));
}
