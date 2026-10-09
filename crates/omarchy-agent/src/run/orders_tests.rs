//! #344's acceptance criteria on the agent's side, against the fake engine and pool (the
//! real-engine test is `tests/agent-host-orders.sh`): the release target from the host
//! state, `reconcile-now`, `retire-legacy` against a stand-in legacy project, the refusals
//! (an unknown kind, an expired order, a repeated id), and the report that carries the
//! answers. The legacy tools whose #313 guards refused on the marker the agent writes
//! left the repository with the legacy sets (#346); the marker itself is checked here.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::install::legacy::{self, Legacy};
use crate::run::fake::World;
use crate::run::pool::{Follow, HostState, Net};
use crate::run::state::{RetireStep, SEEN_RING};
use crate::version::Release;

const LEGACY: &str = "omarchy-pool";
const OTHER: &str = "omarchy-other";

/// A host running v1.0.0 beside a stand-in legacy set: three containers of `omarchy-pool`
/// made by compose in its directory, one that names the legacy project and this host
/// (never the legacy project's to touch), a project nobody recorded, and a network of
/// each. `legacy.json` records the project (`with_dir`: and its directory).
fn beside_a_legacy_set(with_dir: bool) -> (World, PathBuf) {
    let w = World::running_v1();
    let dir = w.dir.join("srv-omarchy-pool");
    fs::create_dir_all(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(dir.join("compose.yml"), "services: {}\n").unwrap();
    let d = dir.display().to_string();
    {
        let mut e = w.engine.borrow_mut();
        for s in ["pool-aarch64", "review-aarch64", "updater"] {
            e.start_foreign(LEGACY, s, &d);
        }
        let stray = e.start_foreign(LEGACY, "stray", &d);
        let c = e.containers.iter_mut().find(|c| c.id == stray).unwrap();
        c.agent_host = "h_test".into();
        e.start_foreign(OTHER, "worker", "/home/someone/.config/omarchy-worker");
        e.add_network(LEGACY, false);
        e.add_network(OTHER, false);
    }
    record(&w, with_dir.then(|| dir.clone()), None);
    (w, dir)
}

fn record(w: &World, dir: Option<PathBuf>, project: Option<&str>) {
    legacy::record(
        &w.agent.paths.data,
        &Legacy {
            project: project.unwrap_or(LEGACY).into(),
            recorded_at: "2027-01-01T08:00:00Z".into(),
            containers: Vec::new(),
            networks: Vec::new(),
            rootful_exception: true,
            dir,
            retired_at: None,
            retired_by: None,
        },
    )
    .unwrap();
}

/// The answers the agent kept: (id, kind, outcome, detail).
fn answers(w: &World) -> Vec<(String, String, String, String)> {
    w.agent
        .state
        .orders
        .answers
        .iter()
        .map(|a| {
            (
                a.id.clone(),
                a.kind.clone(),
                a.outcome.clone(),
                a.detail.clone(),
            )
        })
        .collect()
}

fn answer_of(w: &World, id: &str) -> (String, String) {
    let a = w
        .agent
        .state
        .orders
        .answers
        .iter()
        .find(|a| a.id == id)
        .unwrap_or_else(|| panic!("{id} was not answered: {:?}", answers(w)));
    (a.outcome.clone(), a.detail.clone())
}

/// The running containers of `project`, but the one that also carries the agent's host
/// label (which no order touches).
fn running(w: &World, project: &str) -> Vec<String> {
    w.engine
        .borrow()
        .of_project(project)
        .iter()
        .filter(|c| c.status == "running" && c.agent_host.is_empty())
        .map(|c| c.service.clone())
        .collect()
}

/// The journal's `order` lines about order `id`.
fn order_lines(w: &World, id: &str) -> Vec<serde_json::Value> {
    w.journal()
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|l| l["event"] == "order" && l["id"] == id)
        .collect()
}

#[test]
fn the_release_target_comes_from_the_host_state() {
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    let polls = w.remote.borrow().polls;
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{:?}", w.outcome());
    assert!(w.remote.borrow().polls > polls);
    // The report says what runs, and the pool reads its release from it.
    w.tick(20);
    let r = w.last_report();
    assert_eq!(r["release"]["applied"], "v1.1.0");
    assert_eq!(r["agent"]["version"], w.agent.version.to_string());
    assert_eq!(r["round"]["outcome"], "ok");
    assert_eq!(r["legacy"], serde_json::Value::Null);
}

#[test]
fn a_pool_from_before_the_host_state_names_its_target_by_its_follow_and_only_it() {
    // rollback.yml deploys the Worker of the tag it goes back to: below #344 its host state
    // names no release at all, and without its follow a host on agent 0.3.0 would never see
    // the rollback's target (nor fetch its statement).
    let mut w = World::running_v1();
    w.release("v1.1.0");
    w.pool_answers(Net::Ok(HostState {
        older_pool: true,
        ..HostState::default()
    }));
    w.remote.borrow_mut().follow = Some(Net::Ok(Follow {
        latest: Release::parse("v1.1.0"),
        update: None,
        poll_s: Some(120),
    }));
    w.round();
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{:?}", w.outcome());
    let worker = w.agent.cfg.worker_id.clone();
    assert!(w.remote.borrow().follows.iter().all(|f| *f == worker));
    assert_eq!(
        w.journal().matches("a pool from before #344").count(),
        1,
        "said once: {}",
        w.journal()
    );
    // Its follow's open Update for this host's worker is an Update order, as before 0.3.0.
    w.remote.borrow_mut().follow = Some(Net::Ok(Follow {
        latest: Release::parse("v1.1.0"),
        update: Some("wo_9".into()),
        poll_s: Some(120),
    }));
    w.poll();
    assert_eq!(w.agent.state.rollout.why, "Update order wo_9");
    while w.step() != "idle" {
        w.tick(3);
    }
    // A follow that does not answer is a pool that does not: nothing changes, it backs off.
    w.remote.borrow_mut().follow = Some(Net::NoAnswer("HTTP 502".into()));
    let changes = w.changes().len();
    w.poll();
    assert_eq!(w.agent.state.poll.last, "no-answer");
    assert_eq!(w.agent.state.poll.backoff_s, 60);
    assert_eq!(w.changes().len(), changes);
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    // A pool from #344 on is never asked its follow, even one that runs no release.
    let asked = w.remote.borrow().follows.len();
    w.target("v1.1.0", None);
    w.poll();
    w.target("dev", None);
    w.poll();
    assert_eq!(w.remote.borrow().follows.len(), asked);
}

#[test]
fn reconcile_now_starts_a_round_now_and_is_taken_once() {
    let mut w = World::running_v1();
    w.target("v1.0.0", None);
    w.tick(200);
    assert_eq!(w.step(), "idle");
    w.orders(&[("reconcile-now", "ho_1", 3600)]);
    w.poll();
    assert_ne!(w.step(), "idle", "a round started: {:?}", w.outcome());
    assert_eq!(w.agent.state.rollout.why, "host order ho_1 (reconcile-now)");
    let (outcome, detail) = answer_of(&w, "ho_1");
    assert_eq!(outcome, "done");
    assert!(
        detail.starts_with("a round now: host order ho_1"),
        "{detail}"
    );
    while w.step() != "idle" {
        w.tick(3);
    }
    assert_eq!(w.outcome().0, "no-change", "{:?}", w.outcome());
    // The report carries the answer, for the pool to close the order with.
    w.tick(20);
    let r = w.last_report();
    assert_eq!(r["orders"][0]["id"], "ho_1");
    assert_eq!(r["orders"][0]["outcome"], "done");
    assert_eq!(r["orders"][0]["kind"], "reconcile-now");

    // The same id again — the pool had not closed it yet, or a pool that resends it —
    // starts nothing, and its first answer stands.
    let before = (w.changes().len(), answers(&w));
    for _ in 0..3 {
        w.poll();
        w.tick(200);
    }
    assert_eq!(w.step(), "idle");
    assert_eq!((w.changes().len(), answers(&w)), before);
    assert_eq!(w.journal().matches("seen already").count(), 1, "said once");
    // And said as no answer: the journal's one outcome for the id is its first.
    let lines = order_lines(&w, "ho_1");
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(lines[0]["outcome"], "done");
    assert!(
        lines[1]["detail"]
            .as_str()
            .is_some_and(|d| d.starts_with("seen already"))
            && lines[1].get("outcome").is_none(),
        "{lines:?}"
    );
}

#[test]
fn reconcile_now_lifts_no_quarantine_and_says_why_no_round_started() {
    let mut w = World::running_v1();
    crate::run::fake::publish(
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
    w.orders(&[("reconcile-now", "ho_q", 3600)]);
    w.poll();
    assert_eq!(w.step(), "idle");
    assert!(!w.agent.state.quarantine.is_empty());
    let (outcome, detail) = answer_of(&w, "ho_q");
    assert_eq!(outcome, "done");
    assert!(
        detail.starts_with("no round started; the last round says held: v1.1.0 is quarantined"),
        "{detail}"
    );
    // The pool names no release (a pool from before #344): nothing to roll out.
    w.target("dev", None);
    w.orders(&[("reconcile-now", "ho_none", 3600)]);
    // Two seconds after the last: the brake paces orders (#325).
    w.tick(1);
    w.poll();
    assert_eq!(
        answer_of(&w, "ho_none").1,
        "the pool names no release for this host: no round"
    );
}

#[test]
fn reconcile_now_waits_while_a_revert_finishes() {
    let mut w = World::running_v1();
    crate::run::fake::publish(
        &w.remote,
        "v1.1.0",
        "2027-01-14T08:00:00Z",
        "v1.0.0",
        &[],
        "    command: [broken]\n",
    );
    w.target("v1.1.0", None);
    w.poll();
    while !matches!(
        w.agent.state.rollout.step,
        crate::run::state::Step::Replace {
            files: crate::run::state::Files::LastGood,
            ..
        }
    ) {
        w.tick(3);
    }
    w.orders(&[("reconcile-now", "ho_w", 3600)]);
    w.poll();
    assert!(!w.agent.state.orders.seen("ho_w"), "kept for the next poll");
    assert!(answers(&w).is_empty());
    while w.step() != "idle" {
        w.tick(3);
    }
    w.poll();
    assert!(w.agent.state.orders.seen("ho_w"));
    assert_eq!(answer_of(&w, "ho_w").0, "done");
}

#[test]
fn an_unknown_kind_an_expired_order_and_one_without_a_deadline_are_refused() {
    let (mut w, dir) = beside_a_legacy_set(true);
    let changes = w.changes().len();
    w.orders(&[
        ("drain-host", "ho_u", 3600),
        ("shell", "ho_s", 3600),
        ("retire-legacy", "ho_x", -1),
        ("reconcile-now", "ho_y", 0),
    ]);
    // An order with no not_after the agent can read.
    {
        let mut r = w.remote.borrow_mut();
        if let Some(Net::Ok(s)) = r.state.as_mut() {
            s.orders.push(crate::run::pool::Order {
                id: "ho_n".into(),
                kind: crate::run::pool::OrderKind::RetireLegacy,
                not_after: None,
            });
        }
    }
    w.poll();
    let got = answers(&w);
    assert_eq!(got.len(), 5, "{got:?}");
    assert!(got.iter().all(|a| a.2 == "refused"), "{got:?}");
    assert!(
        got[0].3.starts_with("unknown kind \"drain-host\": agent "),
        "{got:?}"
    );
    assert!(got[1].3.starts_with("unknown kind \"shell\""), "{got:?}");
    assert!(got[2].3.starts_with("expired at 2027-01-15T"), "{got:?}");
    assert!(got[3].3.starts_with("expired at"), "{got:?}");
    assert_eq!(got[4].3, "it carries no not_after the agent can read");
    // Nothing was done: no round, no container, no marker.
    assert_eq!(w.changes().len(), changes);
    assert_eq!(w.step(), "idle");
    assert!(!dir.join(".omarchy-agent").exists());
    assert_eq!(running(&w, LEGACY).len(), 3);
    // A refused id is taken once too: sent again, it is not answered again.
    w.poll();
    assert_eq!(answers(&w).len(), 5);
}

#[test]
fn the_ring_keeps_the_last_512_ids() {
    let mut o = crate::run::state::Orders::default();
    for n in 0..600 {
        o.remember(&format!("ho_{n}"));
    }
    o.remember("ho_599");
    assert_eq!(o.seen.len(), SEEN_RING);
    assert!(!o.seen("ho_87") && o.seen("ho_88") && o.seen("ho_599"));
    for n in 0..20 {
        o.answer(crate::run::state::OrderAnswer {
            id: format!("ho_{n}"),
            kind: "reconcile-now".into(),
            outcome: "done".into(),
            detail: String::new(),
            at: n,
        });
    }
    assert_eq!(o.answers.len(), crate::run::state::ANSWERS_KEPT);
    assert_eq!(o.answers.last().unwrap().id, "ho_19");
}

#[test]
#[allow(clippy::too_many_lines)] // one legacy set, one story: before, in flight, retired, again
fn retire_legacy_stops_and_removes_exactly_the_recorded_project_writes_the_marker_and_reports_it() {
    let (mut w, dir) = beside_a_legacy_set(false);
    let (task, dispatcher) = {
        let e = w.engine.borrow();
        (e.tasks()[0].id.clone(), e.dispatcher().unwrap().id.clone())
    };
    // Before: the report says the legacy set runs, and where.
    w.tick(20);
    let r = w.last_report();
    assert_eq!(r["legacy"]["project"], LEGACY);
    assert_eq!(r["legacy"]["state"], "running");
    assert_eq!(r["legacy"]["running"], 3);
    assert_eq!(r["legacy"]["dir"], dir.display().to_string());
    assert_eq!(r["legacy"]["blocked"], serde_json::Value::Null);

    w.orders(&[("retire-legacy", "ho_r1", 3600)]);
    w.poll();
    // The marker first, before anything stops.
    let marker = fs::read_to_string(dir.join(".omarchy-agent")).unwrap();
    let lines: Vec<&str> = marker.lines().collect();
    assert_eq!(lines[0], format!("agent={}", w.agent.version));
    assert_eq!(lines[1], "host=h_test");
    assert!(
        lines[2].starts_with("since=2027-01-15T") && lines[2].ends_with('Z'),
        "{marker}"
    );
    let mode = fs::metadata(dir.join(".omarchy-agent"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o644);
    let retire = w.agent.state.orders.retire.clone().unwrap();
    assert_eq!(
        (retire.order.as_str(), retire.project.as_str()),
        ("ho_r1", LEGACY)
    );
    assert_eq!(retire.dir, dir);
    // A poll while its containers stop lists the order again (the pool keeps it open
    // until a report answers it): it is being carried out, not refused, and goes on.
    assert_eq!(retire.step, RetireStep::Stop);
    assert!(answers(&w).is_empty());
    w.poll();
    assert!(order_lines(&w, "ho_r1").is_empty(), "{}", w.journal());
    assert!(answers(&w).is_empty());
    // Then stopped, then removed, across ticks; answered at the end.
    for _ in 0..5 {
        w.tick(3);
    }
    assert!(w.agent.state.orders.retire.is_none());
    let (outcome, detail) = answer_of(&w, "ho_r1");
    assert_eq!(outcome, "done", "{detail}");
    // The journal's one word on the order is its answer.
    let lines = order_lines(&w, "ho_r1");
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0]["outcome"], "done");
    assert!(
        detail.starts_with(
            "stopped and removed 3 container(s) and 1 network(s) of compose project omarchy-pool; the marker is in "
        ),
        "{detail}"
    );
    let changes = w.changes();
    let stops = changes.iter().position(|c| c.starts_with("stop ")).unwrap();
    let rms = changes
        .iter()
        .position(|c| c.starts_with("rm -f "))
        .unwrap();
    assert!(stops < rms, "stopped, then removed: {changes:?}");
    {
        let e = w.engine.borrow();
        // Exactly the recorded project's containers went; the one with the agent's host
        // label stays, as do the other project, the task and the dispatcher.
        let left: Vec<&str> = e
            .of_project(LEGACY)
            .iter()
            .map(|c| c.service.as_str())
            .collect();
        assert_eq!(left, ["stray"]);
        assert_eq!(e.of_project(OTHER).len(), 1);
        assert_eq!(e.of_project(OTHER)[0].status, "running");
        assert_eq!(e.tasks()[0].id, task);
        assert_eq!(e.dispatcher().unwrap().id, dispatcher);
        assert_eq!(e.dispatcher().unwrap().status, "running");
        let nets: Vec<&str> = e.networks.iter().map(|n| n.1.as_str()).collect();
        assert_eq!(nets, [OTHER]);
    }
    // legacy.json says so, with the directory the containers named.
    let l = legacy::recorded(&w.agent.paths.data).unwrap().unwrap();
    assert_eq!(l.retired_by.as_deref(), Some("ho_r1"));
    assert!(l.retired_at.unwrap().starts_with("2027-01-15T"));
    assert_eq!(l.dir.as_deref(), Some(dir.as_path()));
    // And the report says it: the legacy set retired, the order done.
    w.tick(20);
    let r = w.last_report();
    assert_eq!(r["legacy"]["state"], "retired");
    assert_eq!(r["legacy"]["order"], "ho_r1");
    let a = r["orders"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == "ho_r1")
        .unwrap();
    assert_eq!(
        (a["kind"].as_str(), a["outcome"].as_str()),
        (Some("retire-legacy"), Some("done"))
    );
    assert!(
        w.journal().contains("\"event\":\"retire-legacy\""),
        "{}",
        w.journal()
    );

    // A second order finds it retired: refused, nothing done.
    let before = w.changes().len();
    w.orders(&[("retire-legacy", "ho_r2", 3600)]);
    w.poll();
    assert_eq!(answer_of(&w, "ho_r2").0, "refused");
    assert!(answer_of(&w, "ho_r2")
        .1
        .starts_with("omarchy-pool was retired already, at 2027-01-15T"));
    assert_eq!(w.changes().len(), before);
}

#[test]
fn retire_legacy_is_refused_with_nothing_changed_when_it_cannot_be_done_safely() {
    let refused = |w: &mut World, id: &str| -> String {
        let changes = w.changes().len();
        w.orders(&[("retire-legacy", id, 3600)]);
        w.poll();
        w.tick(3);
        assert_eq!(w.changes().len(), changes, "{id} changed the engine");
        assert!(w.agent.state.orders.retire.is_none());
        let (outcome, detail) = answer_of(w, id);
        assert_eq!(outcome, "refused", "{detail}");
        detail
    };
    // Nothing recorded.
    let mut w = World::running_v1();
    assert!(refused(&mut w, "ho_1").starts_with("no legacy project is recorded on this host"));

    // A record naming the bundle's own project.
    let (mut w, dir) = beside_a_legacy_set(true);
    record(&w, Some(dir.clone()), Some("omarchy-host"));
    assert_eq!(
        refused(&mut w, "ho_2"),
        "legacy.json names omarchy-host, this host's own bundle: never retired"
    );

    // A directory others may write: the report says so before anyone asks, and the
    // marker is not written there.
    record(&w, Some(dir.clone()), None);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o775)).unwrap();
    w.agent.legacy_seen = None;
    w.tick(20);
    let blocked = w.last_report()["legacy"]["blocked"].clone();
    assert!(
        blocked
            .as_str()
            .is_some_and(|b| b.starts_with("the marker cannot be written: ")
                && b.contains("group- or world-writable")),
        "{blocked}"
    );
    let d = refused(&mut w, "ho_3");
    assert!(d.starts_with("the marker could not be written ("), "{d}");
    assert!(
        d.contains("group- or world-writable") && d.ends_with("nothing changed"),
        "{d}"
    );
    assert!(!dir.join(".omarchy-agent").exists());
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    w.agent.legacy_seen = None;
    w.tick(20);
    assert_eq!(
        w.last_report()["legacy"]["blocked"],
        serde_json::Value::Null
    );

    // A directory with no compose file in it.
    fs::rename(dir.join("compose.yml"), dir.join("compose.yml.bak")).unwrap();
    let d = refused(&mut w, "ho_4");
    assert!(d.contains("holds no compose file"), "{d}");
    fs::rename(dir.join("compose.yml.bak"), dir.join("compose.yml")).unwrap();

    // A record whose directory its containers contradict.
    record(&w, Some(w.dir.join("elsewhere")), None);
    let d = refused(&mut w, "ho_5");
    assert!(d.starts_with("legacy.json records the directory "), "{d}");
    // Containers that name two directories, and none recorded.
    record(&w, None, None);
    w.engine
        .borrow_mut()
        .start_foreign(LEGACY, "odd", "/srv/other");
    let d = refused(&mut w, "ho_6");
    assert!(d.contains("name more than one directory"), "{d}");

    // A legacy.json others may write is not read.
    let (mut w, dir) = beside_a_legacy_set(true);
    let file = w.agent.paths.data.join("legacy.json");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o666)).unwrap();
    let d = refused(&mut w, "ho_7");
    assert!(d.contains("group- or world-writable"), "{d}");
    assert!(!dir.join(".omarchy-agent").exists());
    assert_eq!(running(&w, LEGACY).len(), 3);
}

#[test]
fn a_retire_legacy_resumes_after_a_restart_and_waits_for_an_engine_that_does_not_answer() {
    let (mut w, dir) = beside_a_legacy_set(true);
    w.orders(&[("retire-legacy", "ho_r", 3600)]);
    w.poll();
    assert!(dir.join(".omarchy-agent").exists());
    w.engine.borrow_mut().down = true;
    for _ in 0..10 {
        w.tick(3);
    }
    assert_eq!(
        w.agent.state.orders.retire.as_ref().map(|r| r.step),
        Some(RetireStep::Stop)
    );
    // `omarchy-agent status` says it, from state.json alone.
    let text = crate::run::cli::summary(&w.agent.state, w.now);
    assert!(
        text.contains("retiring:  legacy project omarchy-pool (")
            && text.contains("at its stop step (order ho_r)"),
        "{text}"
    );
    // The agent restarts mid-way: only state.json survives.
    w.restart();
    w.engine.borrow_mut().down = false;
    for _ in 0..5 {
        w.tick(3);
    }
    assert_eq!(answer_of(&w, "ho_r").0, "done");
    let text = crate::run::cli::summary(&w.agent.state, w.now);
    assert!(
        text.contains("order:     ho_r retire-legacy done "),
        "{text}"
    );
    assert!(!text.contains("retiring:"), "{text}");
    assert_eq!(running(&w, LEGACY).len(), 0);
    assert_eq!(
        w.engine.borrow().of_project(LEGACY).len(),
        1,
        "the stray stays"
    );
}

#[test]
fn a_retire_legacy_that_cannot_finish_fails_after_its_limit_and_a_used_network_is_said() {
    let (mut w, dir) = beside_a_legacy_set(true);
    w.orders(&[("retire-legacy", "ho_r", 3600)]);
    w.poll();
    w.engine.borrow_mut().down = true;
    // Another order meanwhile is refused: one at a time (taken two seconds after the
    // first: the brake paces orders, #325).
    w.orders(&[("retire-legacy", "ho_r2", 3600)]);
    w.poll();
    w.tick(2);
    assert!(answer_of(&w, "ho_r2")
        .1
        .starts_with("a retire-legacy is in flight already (order ho_r"));
    for _ in 0..40 {
        w.tick(60);
    }
    let (outcome, detail) = answer_of(&w, "ho_r");
    assert_eq!(outcome, "failed");
    assert!(
        detail.starts_with("not finished within 30 min at the stop step; the marker stays in "),
        "{detail}"
    );
    assert!(dir.join(".omarchy-agent").exists());
    assert!(w.agent.state.orders.retire.is_none());

    // Given again with an engine that answers, and a network another project still uses.
    w.engine.borrow_mut().down = false;
    w.engine.borrow_mut().add_network(LEGACY, true);
    w.orders(&[("retire-legacy", "ho_r3", 3600)]);
    w.poll();
    for _ in 0..5 {
        w.tick(3);
    }
    let (outcome, detail) = answer_of(&w, "ho_r3");
    assert_eq!(outcome, "done");
    assert!(
        detail.contains("and 1 network(s) of compose project omarchy-pool"),
        "{detail}"
    );
    assert!(detail.contains("; networks left: "), "{detail}");
    assert!(detail.contains("has active endpoints"), "{detail}");
}

#[test]
fn reports_go_on_change_and_every_five_minutes_and_one_that_failed_is_retried() {
    let mut w = World::running_v1();
    w.tick(20);
    let sent = w.remote.borrow().reports.len();
    assert!(sent >= 1);
    // Nothing changed: the next one in five minutes.
    for _ in 0..9 {
        w.tick(30);
    }
    assert_eq!(w.remote.borrow().reports.len(), sent);
    w.tick(30);
    assert_eq!(w.remote.borrow().reports.len(), sent + 1);
    // The pool does not take it: tried again a minute later, said once.
    w.remote.borrow_mut().report_answer = Some(Net::NoAnswer("HTTP 503".into()));
    w.orders(&[("reconcile-now", "ho_1", 3600)]);
    w.poll();
    for _ in 0..30 {
        w.tick(10);
    }
    assert_eq!(w.journal().matches("\"event\":\"report\"").count(), 1);
    w.remote.borrow_mut().report_answer = None;
    w.tick(61);
    let r = w.last_report();
    assert_eq!(r["orders"][0]["id"], "ho_1");
    // A secret of the set's env files never reaches it.
    let text = r.to_string();
    assert!(!text.contains(crate::run::fake::TOKEN), "{text}");
}

#[test]
fn a_report_the_pool_refuses_is_tried_again_hourly_and_at_once_when_the_pool_takes_the_host_again()
{
    let mut w = World::running_v1();
    w.target("v1.0.0", None);
    w.tick(20);
    // Suspended (or a clock too far off): every host call answers 403.
    w.remote.borrow_mut().report_answer = Some(Net::Unauthorized(403));
    w.pool_answers(Net::Unauthorized(403));
    w.agent.state.round.detail = "something to report".into();
    let tries = w.remote.borrow().report_tries;
    for _ in 0..58 {
        w.tick(60);
    }
    let tried = w.remote.borrow().report_tries - tries;
    assert_eq!(tried, 1, "one try in the hour, not one a minute");
    assert!(
        w.journal()
            .contains("not sent: HTTP 403; tried again in 3600 s"),
        "{}",
        w.journal()
    );
    // Resumed: the next poll that gets through sends the report at once.
    w.target("v1.0.0", None);
    w.remote.borrow_mut().report_answer = None;
    let reports = w.remote.borrow().reports.len();
    w.poll();
    assert_eq!(w.remote.borrow().reports.len(), reports + 1);
}

#[test]
fn a_step_that_cannot_write_lets_a_retire_legacy_go_on_and_the_report_go_out() {
    let (mut w, dir) = beside_a_legacy_set(true);
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.round_now();
    while w.step() != "commit" {
        w.tick(3);
    }
    // The set directory cannot be written (a full disk, a path in the way): the commit
    // fails every tick until it can.
    let set = w.set_dir();
    let aside = w.dir.join("set-aside");
    fs::rename(&set, &aside).unwrap();
    fs::write(&set, "in the way").unwrap();
    w.orders(&[("retire-legacy", "ho_e", 3600)]);
    w.agent.state.poll.next_at = 0;
    for _ in 0..5 {
        w.now += 20;
        w.engine.borrow_mut().clock = w.now;
        let failed = w.agent.tick(w.now, false);
        assert!(failed.is_err(), "{failed:?}");
    }
    assert_eq!(w.step(), "commit");
    assert!(dir.join(".omarchy-agent").exists());
    assert_eq!(answer_of(&w, "ho_e").0, "done");
    assert_eq!(running(&w, LEGACY).len(), 0);
    let r = w.last_report();
    assert!(
        r["orders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == "ho_e" && a["outcome"] == "done"),
        "{r}"
    );
    assert_eq!(r["legacy"]["state"], "retired");
    // Once it can write, the commit finishes.
    fs::remove_file(&set).unwrap();
    fs::rename(&aside, &set).unwrap();
    w.tick(3);
    assert_eq!(w.step(), "idle");
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"), "{:?}", w.outcome());
}

#[test]
fn a_retire_legacy_marks_retired_only_the_project_it_retired() {
    let (mut w, _dir) = beside_a_legacy_set(true);
    w.orders(&[("retire-legacy", "ho_r", 3600)]);
    w.poll();
    // install --legacy records another project while the order runs.
    record(&w, None, Some(OTHER));
    for _ in 0..5 {
        w.tick(3);
    }
    let (outcome, detail) = answer_of(&w, "ho_r");
    assert_eq!(outcome, "done", "{detail}");
    assert!(
        detail.ends_with(
            "; legacy.json was not updated: it names omarchy-other now, not omarchy-pool"
        ),
        "{detail}"
    );
    let l = legacy::recorded(&w.agent.paths.data).unwrap().unwrap();
    assert_eq!(l.project, OTHER);
    assert_eq!((l.retired_at, l.retired_by), (None, None));
    assert_eq!(running(&w, LEGACY).len(), 0);
    assert_eq!(running(&w, OTHER).len(), 1);
}

/// A JSON value's shape: its keys and each value's type, an array by its first item. The
/// same as worker/test/host-orders.test.ts's.
pub(crate) fn shape(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value as V;
    match v {
        V::Null => "null".into(),
        V::Bool(_) => "boolean".into(),
        V::Number(_) => "number".into(),
        V::String(_) => "string".into(),
        V::Array(a) => V::Array(a.first().map(shape).into_iter().collect()),
        V::Object(o) => V::Object(o.iter().map(|(k, v)| (k.clone(), shape(v))).collect()),
    }
}

pub(crate) fn fixture(name: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/host-api")
        .join(name);
    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap()
}

/// The reports as the pool reads them (`tests/fixtures/host-api/report-*.json`, which
/// worker/test/host-orders.test.ts posts, signed, and reads back field by field): before an
/// order, with a legacy set a retire-legacy would be refused for, and after a done
/// retire-legacy and a refused (expired) reconcile-now. The contract both sides read,
/// written once.
#[test]
fn the_reports_keep_the_shape_the_pool_reads() {
    let (mut w, dir) = beside_a_legacy_set(true);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o775)).unwrap();
    w.agent.legacy_seen = None;
    w.tick(20);
    let before = w.last_report();
    assert_eq!(shape(&before), shape(&fixture("report-blocked.json")));
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    w.agent.legacy_seen = None;
    let (retire, refused) = (
        format!("ho_{}", "1".repeat(32)),
        format!("ho_{}", "2".repeat(32)),
    );
    w.orders(&[
        ("retire-legacy", &retire, 3600),
        ("reconcile-now", &refused, -1),
    ]);
    w.poll();
    for _ in 0..5 {
        w.tick(3);
    }
    w.tick(20);
    let after = w.last_report();
    let outcomes: Vec<(&str, &str)> = after["orders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (a["id"].as_str().unwrap(), a["outcome"].as_str().unwrap()))
        .collect();
    assert_eq!(
        outcomes,
        [(refused.as_str(), "refused"), (retire.as_str(), "done")]
    );
    assert_eq!(shape(&after), shape(&fixture("report.json")));
}

#[test]
fn an_update_the_agent_before_took_is_not_taken_again_and_a_new_one_starts_a_round() {
    // state.json as agent 0.2.0 left it: the last Update it took, and no ring.
    let mut w = World::running_v1();
    w.agent.state.update_seen = Some("wo_old".into());
    w.target("v1.0.0", Some("wo_old"));
    let changes = w.changes().len();
    w.poll();
    assert_eq!((w.step(), w.changes().len()), ("idle", changes));
    // A new Update: a round now, and its id joins the ring.
    w.target("v1.0.0", Some("wo_new"));
    w.poll();
    assert_ne!(w.step(), "idle");
    assert_eq!(w.agent.state.rollout.why, "Update order wo_new");
    assert!(w.agent.state.orders.seen("wo_new"));
    assert_eq!(w.agent.state.update_seen.as_deref(), Some("wo_new"));
}
