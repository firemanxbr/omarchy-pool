//! The owner's runtime switch (#325's acceptance criterion), against two fake engines: the
//! bundle moves from docker to podman with the round's guard, a switch whose guard fails
//! goes back to docker with nothing quarantined and agent.toml as it was, a restart mid-way
//! resumes on the engine it was on, and what refuses a switch changes nothing.

use std::fs;
use std::path::PathBuf;

use crate::run::config::Runtime;
use crate::run::fake::{Engine, World};

use super::{Request, SwitchStep, REQUEST};

const PODMAN: &str = "/run/podman/podman.sock";

/// A host running v1.0.0 on docker, drained (its task finished), with agent.toml on disk
/// and a rootful podman beside it.
fn drained_beside_podman() -> (World, Engine) {
    let w = World::running_v1();
    w.engine
        .borrow_mut()
        .containers
        .retain(|c| !c.project.is_empty());
    let toml = super::super::config::tests::example(
        &w.set_dir(),
        &w.dir.join("work"),
        &w.dir.join("secrets"),
    );
    fs::write(
        w.agent.paths.agent_toml(),
        format!("# The agent's envelope.\n{toml}"),
    )
    .unwrap();
    let podman = w.add_engine(PODMAN, Runtime::Podman, false);
    (w, podman)
}

/// What `omarchy-agent runtime switch` leaves for the loop.
fn ask(w: &World, driver: &str, socket: &str) {
    let req = Request {
        driver: driver.into(),
        socket: PathBuf::from(socket),
        asked_at: w.now,
    };
    fs::write(
        w.agent.paths.data.join(REQUEST),
        serde_json::to_vec(&req).unwrap(),
    )
    .unwrap();
}

/// Ticks until the switch ended.
fn through(w: &mut World) {
    w.tick(1);
    for _ in 0..400 {
        if w.agent.state.switch.is_none() && w.step() == "idle" {
            return;
        }
        w.tick(3);
    }
    panic!(
        "the switch did not end: {:?} {:?}",
        w.agent.state.switch, w.agent.state.rollout
    );
}

fn running_dispatcher(e: &Engine) -> Option<String> {
    e.borrow()
        .containers
        .iter()
        .find(|c| c.service == "dispatcher" && c.status == "running")
        .map(|c| c.release.clone())
}

#[test]
fn a_runtime_switch_moves_the_bundle_from_docker_to_podman_with_the_guard() {
    let (mut w, podman) = drained_beside_podman();
    ask(&w, "compose/podman", PODMAN);
    through(&mut w);
    let end = w.agent.state.switch_last.clone().unwrap();
    assert_eq!(
        (end.to.as_str(), end.outcome.as_str()),
        ("compose/podman", "done"),
        "{}",
        end.detail
    );
    assert_eq!(
        end.detail,
        format!("the bundle runs on compose/podman at {PODMAN}; agent.toml says so")
    );
    // The dispatcher runs on podman, guarded like any round, and nothing on docker.
    assert_eq!(running_dispatcher(&podman).as_deref(), Some("v1.0.0"));
    assert!(w.engine.borrow().dispatcher().is_none());
    assert!(w
        .journal()
        .contains("\"from\":\"replace\",\"target\":\"v1.0.0\",\"to\":\"guard\""));
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    // agent.toml names podman from now on; its comment and every other key stay.
    let toml = fs::read_to_string(w.agent.paths.agent_toml()).unwrap();
    assert!(toml.starts_with("# The agent's envelope.\n"), "{toml}");
    let cfg = super::super::config::Config::parse(&toml).unwrap();
    assert_eq!(
        (
            cfg.runtime,
            cfg.socket_cli.clone(),
            cfg.socket_mount.clone()
        ),
        (
            Runtime::Podman,
            PathBuf::from(PODMAN),
            PathBuf::from(PODMAN)
        )
    );
    assert_eq!(cfg.envelope, w.agent.cfg.envelope);
    // The dispatcher mounts podman's socket.
    let overlay_env = w.agent.cfg.interpolation();
    assert!(overlay_env.contains(&("OMARCHY_SOCKET".into(), PODMAN.into())));
    // A restart reads it back: the agent stays on podman, and drift finds nothing to do.
    w.restart_reading_agent_toml();
    let changes = podman.borrow().changes.len();
    for _ in 0..10 {
        w.tick(3);
    }
    assert_eq!(podman.borrow().changes.len(), changes);
    w.tick(300);
    assert_eq!(w.last_report()["runtime"]["driver"], "compose/podman");
}

#[test]
fn a_switch_whose_guard_fails_goes_back_to_docker_and_quarantines_nothing() {
    let (mut w, podman) = drained_beside_podman();
    podman.borrow_mut().broken = true;
    let toml = fs::read_to_string(w.agent.paths.agent_toml()).unwrap();
    ask(&w, "compose/podman", PODMAN);
    through(&mut w);
    let end = w.agent.state.switch_last.clone().unwrap();
    assert_eq!(end.outcome, "rolled-back", "{}", end.detail);
    assert!(
        // A dispatcher that never answers /ready: the ready wait fails, as the guard would.
        end.detail.starts_with(
            "the switch to compose/podman was rolled back (replace: dispatcher did not answer /ready within 120 s)"
        ),
        "{}",
        end.detail
    );
    assert!(
        end.detail.ends_with("; the way back: ok: host runs v1.0.0"),
        "{}",
        end.detail
    );
    // Back on docker, running; nothing left on podman; nothing quarantined; agent.toml as it was.
    assert_eq!(running_dispatcher(&w.engine).as_deref(), Some("v1.0.0"));
    assert!(podman.borrow().dispatcher().is_none());
    assert!(w.agent.state.quarantine.is_empty());
    assert_eq!(w.agent.cfg.runtime, Runtime::Docker);
    assert_eq!(
        fs::read_to_string(w.agent.paths.agent_toml()).unwrap(),
        toml
    );
    // The round says it, for the host page.
    assert_eq!(w.outcome().0, "rolled-back");
}

#[test]
fn a_switch_keeps_the_owners_comments_and_layout_in_agent_toml() {
    let (mut w, podman) = drained_beside_podman();
    let path = w.agent.paths.agent_toml();
    let toml = fs::read_to_string(&path).unwrap().replace(
        "max_units = 3\n",
        "# Three: the Studio also renders video at night.\nmax_units = 3 # not more\nagent_budget = { calls_per_task = 200 }\n",
    );
    fs::write(&path, &toml).unwrap();
    ask(&w, "compose/podman", PODMAN);
    through(&mut w);
    assert_eq!(
        w.agent.state.switch_last.as_ref().unwrap().outcome,
        "done",
        "{:?}",
        w.agent.state.switch_last
    );
    assert_eq!(running_dispatcher(&podman).as_deref(), Some("v1.0.0"));
    let after = fs::read_to_string(&path).unwrap();
    // Only [set]'s keys changed: its socket line in place, the keys it lacked after its
    // last one; every other line as the owner wrote it.
    let expected = toml.replace(
        "socket_cli = \"/var/run/docker.sock\"\n",
        &format!("socket_cli = \"{PODMAN}\"\ndriver = \"compose\"\nruntime = \"podman\"\nsocket_mount = \"{PODMAN}\"\nengine = \"rootful\"\n"),
    );
    assert_eq!(after, expected);
}

#[test]
fn a_switch_whose_agent_toml_cannot_be_written_goes_back() {
    let (mut w, podman) = drained_beside_podman();
    let toml = fs::read_to_string(w.agent.paths.agent_toml()).unwrap();
    ask(&w, "compose/podman", PODMAN);
    w.tick(1);
    for _ in 0..400 {
        if w.agent.state.switch.as_ref().map(|s| s.step) == Some(SwitchStep::Up)
            && w.step() == "guard"
        {
            break;
        }
        w.tick(3);
    }
    assert_eq!(w.step(), "guard");
    // Up on podman; then agent.toml is a file the agent cannot replace: a directory stands
    // where its temporary file goes.
    let blocker = w.agent.paths.agent_toml().with_file_name(".agent.toml.tmp");
    fs::create_dir_all(blocker.join("x")).unwrap();
    through(&mut w);
    fs::remove_dir_all(&blocker).unwrap();
    let end = w.agent.state.switch_last.clone().unwrap();
    assert_eq!(end.outcome, "rolled-back", "{}", end.detail);
    assert!(
        end.detail
            .starts_with("the switch to compose/podman was rolled back (agent.toml could not be written to name it ("),
        "{}",
        end.detail
    );
    // Back on docker, nothing left on podman, agent.toml as it was: a restart brings up no
    // second dispatcher.
    assert_eq!(running_dispatcher(&w.engine).as_deref(), Some("v1.0.0"));
    assert!(podman.borrow().dispatcher().is_none());
    assert_eq!(w.agent.cfg.runtime, Runtime::Docker);
    assert_eq!(
        fs::read_to_string(w.agent.paths.agent_toml()).unwrap(),
        toml
    );
}

#[test]
fn a_task_claimed_before_the_old_dispatcher_stopped_sends_the_switch_back() {
    let (mut w, podman) = drained_beside_podman();
    ask(&w, "compose/podman", PODMAN);
    // The request is checked with no task running...
    w.tick(1);
    assert_eq!(
        w.agent.state.switch.as_ref().map(|s| s.step),
        Some(SwitchStep::Stop)
    );
    // ...and the dispatcher claims one before its stop.
    let task = w.engine.borrow_mut().start_task();
    through(&mut w);
    let end = w.agent.state.switch_last.clone().unwrap();
    assert_eq!(end.outcome, "rolled-back", "{}", end.detail);
    assert!(
        end.detail.starts_with(
            "the switch to compose/podman was rolled back (1 task container(s) were claimed on compose/docker before its dispatcher stopped"
        ),
        "{}",
        end.detail
    );
    // Back on docker with its task, which runs on; nothing on podman.
    assert_eq!(running_dispatcher(&w.engine).as_deref(), Some("v1.0.0"));
    assert!(w.engine.borrow().tasks().iter().any(|c| c.id == task));
    assert!(podman.borrow().dispatcher().is_none());
    assert_eq!(w.agent.cfg.runtime, Runtime::Docker);
}

#[test]
fn a_restart_mid_switch_resumes_on_the_engine_it_was_on() {
    let (mut w, podman) = drained_beside_podman();
    ask(&w, "compose/podman", PODMAN);
    w.tick(1);
    for _ in 0..400 {
        if w.agent.state.switch.as_ref().map(|s| s.step) == Some(SwitchStep::Up)
            && w.step() == "pull"
        {
            break;
        }
        w.tick(3);
    }
    assert_eq!(w.step(), "pull");
    // The agent dies mid-pull on podman; agent.toml still names docker.
    w.restart_reading_agent_toml();
    assert_eq!(w.agent.cfg.runtime, Runtime::Podman);
    through(&mut w);
    assert_eq!(w.agent.state.switch_last.as_ref().unwrap().outcome, "done");
    assert_eq!(running_dispatcher(&podman).as_deref(), Some("v1.0.0"));
    assert!(w.engine.borrow().dispatcher().is_none());
}

#[test]
fn what_refuses_a_switch_changes_nothing() {
    let (mut w, podman) = drained_beside_podman();
    let refused = |w: &mut World, driver: &str, socket: &str| {
        let changes = (w.changes().len(), podman.borrow().changes.len());
        ask(w, driver, socket);
        through(w);
        let end = w.agent.state.switch_last.clone().unwrap();
        assert_eq!(end.outcome, "refused", "{}", end.detail);
        assert_eq!(
            (w.changes().len(), podman.borrow().changes.len()),
            changes,
            "{}",
            end.detail
        );
        assert_eq!(running_dispatcher(&w.engine).as_deref(), Some("v1.0.0"));
        end.detail
    };
    assert!(refused(&mut w, "quadlet", PODMAN)
        .starts_with("\"quadlet\" is not a driver this agent carries"));
    assert!(refused(&mut w, "compose/docker", "/var/run/docker.sock")
        .starts_with("the bundle runs on compose/docker at /var/run/docker.sock already"));
    assert!(refused(&mut w, "compose/podman", "/run/nothing.sock")
        .starts_with("no engine at /run/nothing.sock"));
    assert!(refused(&mut w, "compose/docker", PODMAN)
        .starts_with(&format!("{PODMAN} answers as podman 4.9.3, not docker")));
    // A task running on docker: drain first.
    w.engine.borrow_mut().start_task();
    assert!(refused(&mut w, "compose/podman", PODMAN)
        .starts_with("1 task container(s) run on compose/docker: task containers, named volumes and caches do not move between engines"));
    w.engine
        .borrow_mut()
        .containers
        .retain(|c| !c.project.is_empty());
    // The envelope's drivers name another.
    w.agent.cfg.policy.drivers = vec!["compose/docker".into()];
    assert!(refused(&mut w, "compose/podman", PODMAN)
        .starts_with("the envelope's drivers (compose/docker) do not name compose/podman"));
    // The pool cannot ask for one: nothing it sends names a driver, and the request is the
    // agent's own file.
    assert!(!w.agent.paths.data.join(REQUEST).exists());
}
