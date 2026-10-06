//! The Quadlet driver (#330): the commands it runs, with what and in what environment, and
//! whole rounds of the rollout on it against a fake user systemd and podman
//! ([`crate::run::fake_quadlet`]) — a first release with no human action, a second one
//! that survives an ordered restart in its guard while a task keeps running, a broken one
//! reverted and quarantined, a crash loop the guard catches, the safety timer bringing back
//! a unit stopped by hand, a user manager that does not answer changing nothing, and an
//! owner's override Quadlet cannot render refused at the lint; and #327's token file on
//! it — a rotation restarting the dispatcher's unit alone, a dispatcher held while its
//! file is missing, which podman never makes in its place, and an override mounting a
//! secret file not its own refused. The same rounds on a real rootless podman under a real
//! user manager are `tests/agent-quadlet.sh`'s.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::*;
use crate::run::compose::Compose;
use crate::run::fake::{publish, World, QUADLET_SOCKET, TOKEN, WORKER};
use crate::run::state::{tempdir, Step, ToolPins};
use crate::run::tools::Tools;
use crate::version::Release;

const NAME: &str = "omarchy-host-dispatcher";

/// A script that logs its argv and environment to `log`, then runs `body`.
fn script(path: &Path, log: &Path, body: &str) {
    fs::write(
        path,
        format!(
            "#!/bin/sh\n{{ echo \"$0 $*\"; env | sort | tr '\\n' ' '; echo; }} >> {}\n{body}\n",
            log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// The driver over a recording `systemctl` and pinned `docker`, and the set's project.
fn recording(systemctl: &str, docker: &str) -> (Quadlet, Project, PathBuf, PathBuf) {
    let dir = tempdir();
    let log = dir.join("calls");
    script(&dir.join("systemctl"), &log, systemctl);
    script(&dir.join("docker"), &log, docker);
    script(&dir.join("docker-compose"), &log, "exit 1");
    let tools = Tools {
        docker: dir.join("docker"),
        compose: dir.join("docker-compose"),
        pins: ToolPins {
            docker: "0".repeat(64),
            compose: "1".repeat(64),
        },
    };
    fs::create_dir_all(dir.join("docker-config")).unwrap();
    let api = Compose::new(tools, Path::new(QUADLET_SOCKET), &dir.join("docker-config"));
    let set = dir.join("set");
    fs::create_dir_all(&set).unwrap();
    fs::write(
        set.join("compose.yml"),
        crate::run::fake::rendered_compose(""),
    )
    .unwrap();
    fs::write(
        set.join("agent.yml"),
        "services:\n  dispatcher:\n    labels:\n      org.omarchy-pool.agent.service: \"dispatcher\"\n      org.omarchy-pool.agent.release: \"v1.0.0\"\n",
    )
    .unwrap();
    let p = Project {
        name: "omarchy-host".into(),
        dir: set.clone(),
        files: vec![set.join("compose.yml"), set.join("agent.yml")],
        env: vec![
            ("OMARCHY_WORK_ROOT".into(), "/srv/work".into()),
            ("OMARCHY_SECRETS_DIR".into(), "/srv/secrets".into()),
            ("OMARCHY_SOCKET".into(), QUADLET_SOCKET.into()),
        ],
    };
    let units = dir.join("units");
    let q = Quadlet::new(
        Box::new(api),
        Box::new(Systemctl::at(
            &dir.join("systemctl"),
            &[("XDG_RUNTIME_DIR", "/run/user/1000")],
        )),
        &units,
    );
    (q, p, units, log)
}

/// `systemctl show` of an active unit, restarted twice.
const SHOW: &str = r"case $* in *show*) printf 'LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=2\nExecMainStatus=0\n';; esac";

/// `docker inspect` of the unit's container: no compose label, the agent's.
fn inspect_line(hash: &str) -> String {
    format!(
        r#"case "$1" in inspect) echo '{{"id":"{}","status":"running","exit_code":0,"restarts":0,"service":null,"config_hash":null,"agent_service":"dispatcher","agent_hash":"{hash}","release":"v1.0.0"}}';; esac"#,
        "a".repeat(64)
    )
}

/// Each logged call as `<program> <args>`, and the environments it ran with.
fn calls(log: &Path) -> (Vec<String>, Vec<String>) {
    let text = fs::read_to_string(log).unwrap();
    let argv = text
        .lines()
        .step_by(2)
        .map(|l| {
            let (prog, rest) = l.split_once(' ').unwrap_or((l, ""));
            format!(
                "{} {rest}",
                Path::new(prog).file_name().unwrap().to_string_lossy()
            )
        })
        .collect();
    let envs = text.lines().skip(1).step_by(2).map(str::to_owned).collect();
    (argv, envs)
}

#[test]
fn applies_a_unit_with_daemon_reload_and_restart_and_runs_only_systemctl_and_the_pinned_docker() {
    std::env::set_var("OMARCHY_LEAK_CHECK", "inherited");
    let (mut q, p, units, log) = recording(SHOW, &inspect_line("h1"));
    assert_eq!(q.create(&p, &["dispatcher".into()]), Answer::Yes(()));
    let text = fs::read_to_string(units.join(format!("{NAME}.container"))).unwrap();
    assert!(text.contains(&format!("ContainerName={NAME}\n")), "{text}");
    assert!(!text.contains("AutoUpdate"), "{text}");
    let (argv, envs) = calls(&log);
    assert_eq!(
        argv,
        [
            "systemctl --user daemon-reload".to_owned(),
            format!("systemctl --user show --property=LoadState,ActiveState,SubState,NRestarts,ExecMainStatus {NAME}.service"),
            format!("systemctl --user restart {NAME}.service"),
        ]
    );
    // Nothing inherited: the runtime directory the user manager is found through, alone.
    for env in envs {
        assert!(env.contains("XDG_RUNTIME_DIR=/run/user/1000"), "{env}");
        assert!(
            !env.contains("OMARCHY_LEAK_CHECK") && !env.contains("PATH="),
            "{env}"
        );
    }

    // The unit as the rollout reads it: the service's state and restarts, the container's
    // labels, by the unit's name.
    fs::write(&log, "").unwrap();
    assert_eq!(
        q.observe(&p, &["dispatcher".into()]),
        Answer::Yes(vec![Unit {
            id: NAME.into(),
            service: "dispatcher".into(),
            status: "running".into(),
            restarts: 2,
            exit_code: 0,
            config_hash: "h1".into(),
            release: "v1.0.0".into(),
        }])
    );
    let (argv, _) = calls(&log);
    assert!(
        argv.iter().any(
            |a| a.starts_with("docker inspect --type container --format ")
                && a.ends_with(&format!(" {NAME}"))
        ),
        "{argv:?}"
    );
}

#[test]
fn drains_by_the_unit_and_removes_its_file_so_nothing_starts_it_again() {
    let (mut q, p, units, log) = recording(SHOW, &inspect_line("h1"));
    assert_eq!(q.create(&p, &["dispatcher".into()]), Answer::Yes(()));
    let u = match q.observe(&p, &["dispatcher".into()]) {
        Answer::Yes(mut u) => u.remove(0),
        other => panic!("{other:?}"),
    };
    fs::write(&log, "").unwrap();
    assert_eq!(q.begin_drain(&u, 60), Answer::Yes(()));
    // Active still: not drained.
    assert_eq!(q.drained(&u), Answer::Yes(false));
    assert_eq!(q.remove(&u, true), Answer::Yes(()));
    assert!(!units.join(format!("{NAME}.container")).exists());
    let (argv, _) = calls(&log);
    let argv: Vec<&String> = argv.iter().filter(|a| !a.contains(" show ")).collect();
    assert_eq!(
        argv,
        [
            &format!("systemctl --user stop --no-block {NAME}.service"),
            &format!("systemctl --user kill --signal=SIGKILL {NAME}.service"),
            &format!("docker rm --force {NAME}"),
            &"systemctl --user daemon-reload".to_owned(),
            &format!("systemctl --user reset-failed {NAME}.service"),
        ]
    );
    // A container of another compose project, by its id — the legacy set `retire-legacy`
    // stops and removes (#344) — is the engine's, as on compose.
    fs::write(&log, "").unwrap();
    let legacy = Unit {
        id: "b".repeat(64),
        ..u.clone()
    };
    assert_eq!(q.begin_drain(&legacy, 60), Answer::Yes(()));
    // The stop is a child the engine carries: logged whole before the next call.
    for _ in 0..500 {
        let text = fs::read_to_string(&log).unwrap();
        if text.lines().count() == 2 && text.ends_with('\n') {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(q.remove(&legacy, true), Answer::Yes(()));
    let (argv, _) = calls(&log);
    assert!(
        argv.contains(&format!("docker stop --time 60 {}", legacy.id))
            && argv.contains(&format!("docker rm --force {}", legacy.id))
            && !argv.iter().any(|a| a.starts_with("systemctl")),
        "{argv:?}"
    );
    // Names that are neither its own nor a container's never reach a command line.
    let bad = Unit {
        id: "--all".into(),
        ..u.clone()
    };
    for a in [
        q.begin_drain(&bad, 60),
        q.remove(&bad, true),
        q.drained(&bad).map_none(),
        q.inspect("--all").map_none(),
        q.ready("../x", "127.0.0.1:8791/ready").map_none(),
        q.exits_since("dispatcher", 0).map_none(),
    ] {
        assert!(matches!(a, Answer::NoAnswer(_)), "{a:?}");
    }
}

#[test]
fn pulls_the_images_it_renders_and_follows_the_container_by_name() {
    let docker = format!(
        "{}\n{}",
        inspect_line("h1"),
        r#"case "$1" in events) echo '{"status":"die","id":"x","Actor":{"ID":"x","Attributes":{"containerExitCode":"75"}},"time":1800000001}';; esac"#
    );
    let (mut q, p, _, log) = recording(SHOW, &docker);
    assert_eq!(q.start_pull(&p, &["dispatcher".into()]), Answer::Yes(()));
    let mut polls = 0;
    while q.poll_pull() == Answer::Yes(PullState::Running) {
        polls += 1;
        assert!(polls < 500, "the pull did not end");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let image = match q.images(&p) {
        Answer::Yes(i) => i[0].clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        q.exits_since(NAME, 1_800_000_000),
        Answer::Yes(vec![Exit {
            at: 1_800_000_001,
            code: 75
        }])
    );
    let (argv, _) = calls(&log);
    assert!(
        argv.contains(&format!("docker pull --quiet {image}")),
        "{argv:?}"
    );
    assert!(
        argv.iter()
            .any(|a| a.contains(&format!("--filter container={NAME} --filter event=die"))),
        "{argv:?}"
    );
    // The hash the planner compares is the rendered unit's.
    let Answer::Yes(h) = q.config_hash(&p, "dispatcher") else {
        panic!("no hash");
    };
    assert_eq!(h.len(), 64);
}

#[test]
fn a_unit_the_generator_did_not_take_or_a_user_manager_that_does_not_answer_is_said() {
    let (mut q, p, _, _) = recording(
        r"case $* in *show*) printf 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nNRestarts=0\nExecMainStatus=0\n';; esac",
        "exit 0",
    );
    let Answer::NoAnswer(e) = q.create(&p, &["dispatcher".into()]) else {
        panic!("created");
    };
    assert!(e.contains("podman's generator made no unit of"), "{e}");
    // Nothing there: nothing observed.
    assert_eq!(
        q.observe(&p, &["dispatcher".into()]),
        Answer::Yes(Vec::new())
    );
    let (mut q, p, _, _) = recording(
        "echo 'Failed to connect to bus: No medium found' >&2; exit 1",
        "exit 0",
    );
    assert_eq!(
        q.observe(&p, &["dispatcher".into()]),
        Answer::NoAnswer(
            "systemctl --user: exit 1: Failed to connect to bus: No medium found".into()
        )
    );
}

// ---------------------------------------------------------------------------------------
// Whole rounds on a fake user systemd and podman.

fn r(s: &str) -> Option<Release> {
    Release::parse(s)
}

/// Ticks until the round in flight reached its guard.
fn to_the_guard(w: &mut World) {
    w.tick(200);
    while !matches!(w.agent.state.rollout.step, Step::Guard(_)) {
        assert_ne!(w.step(), "idle", "{:?}", w.outcome());
        w.tick(3);
    }
}

fn to_idle(w: &mut World) {
    for _ in 0..400 {
        if w.step() == "idle" {
            return;
        }
        w.tick(3);
    }
    panic!("the round did not end: {:?}", w.agent.state.rollout);
}

#[test]
fn a_release_reaches_a_quadlet_host_with_no_human_action_and_a_task_keeps_running() {
    let mut w = World::quadlet_running_v1();
    let q = w.quadlet_host();
    let unit = q.borrow().units.join(format!("{NAME}.container"));
    assert!(fs::read_to_string(&unit)
        .unwrap()
        .contains("Label=\"org.omarchy-pool.agent.release=v1.0.0\""));
    let (task, started, old) = {
        let s = q.borrow();
        let t = s.tasks()[0];
        (
            t.id.clone(),
            t.started_at,
            s.running(NAME).unwrap().id.clone(),
        )
    };
    w.tick(300);
    assert_eq!(w.last_report()["runtime"]["driver"], "quadlet");

    w.release("v1.1.0");
    w.target("v1.1.0", None);
    to_the_guard(&mut w);
    // The pool's ordered restart during the guard: exit 75, the unit restarts it, and
    // neither its exit nor the service's restart counts.
    q.borrow_mut().ordered_restart(NAME);
    to_idle(&mut w);
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
    let s = q.borrow();
    let d = s.running(NAME).unwrap();
    assert_eq!(
        d.labels["org.omarchy-pool.agent.release"].as_str(),
        "v1.1.0"
    );
    // The old dispatcher was stopped by its unit (it saved its leases); the new one runs.
    assert!(s.saved.contains(&old), "{:?}", s.saved);
    assert_ne!(d.id, old);
    assert_eq!(s.service(NAME).unwrap().restarts, 1);
    // The task was never touched (the fake panics if it is) and runs; the new dispatcher
    // found it to re-adopt.
    assert_eq!(s.tasks().len(), 1);
    assert_eq!(
        (s.tasks()[0].id.as_str(), s.tasks()[0].started_at),
        (task.as_str(), started)
    );
    assert_eq!(d.readopted, 1);
    let changes: Vec<&str> = s.changes.iter().map(String::as_str).collect();
    let at = changes
        .iter()
        .rposition(|c| c.starts_with("pull "))
        .unwrap();
    assert!(
        changes[at].starts_with("pull ghcr.io/firemanxbr/omarchy-worker@sha256:"),
        "{changes:?}"
    );
    assert_eq!(
        &changes[at + 1..],
        [
            format!("stop {NAME}").as_str(),
            "daemon-reload",
            "daemon-reload",
            format!("restart {NAME}").as_str(),
        ]
    );
    drop(s);
    assert!(fs::read_to_string(&unit)
        .unwrap()
        .contains("Label=\"org.omarchy-pool.agent.release=v1.1.0\""));
    // What runs is what the set directory says, as on compose.
    let overlay = fs::read_to_string(w.set_dir().join("agent.yml")).unwrap();
    assert!(overlay.contains("org.omarchy-pool.agent.release: \"v1.1.0\""));
}

#[test]
fn a_broken_release_on_quadlet_is_reverted_and_quarantined_as_on_compose() {
    let mut w = World::quadlet_running_v1();
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
    assert_eq!(w.agent.state.round.from, r("v1.1.0"));
    assert!(detail.contains("quarantined until"), "{detail}");
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    assert_eq!(w.agent.state.quarantine[&r("v1.1.0").unwrap()].reverts, 1);
    let q = w.quadlet_host();
    let s = q.borrow();
    let d = s.running(NAME).unwrap();
    assert_eq!(
        d.labels["org.omarchy-pool.agent.release"].as_str(),
        "v1.0.0"
    );
    assert!(!d.broken);
    assert_eq!(s.tasks().len(), 1);
    // last-good's unit is the one on disk: nothing brings the broken one back at boot.
    let unit = fs::read_to_string(s.units.join(format!("{NAME}.container"))).unwrap();
    assert!(!unit.contains("broken"), "{unit}");
}

#[test]
fn a_dispatcher_that_keeps_crashing_on_quadlet_fails_its_guard() {
    let mut w = World::quadlet_running_v1();
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    to_the_guard(&mut w);
    // It crashes, exit 1, and its unit restarts it: the exit and the service's restarts
    // say so, though a container runs at every look.
    let q = w.quadlet_host();
    q.borrow_mut().broken = true;
    for c in q
        .borrow_mut()
        .containers
        .iter_mut()
        .filter(|c| c.name == NAME)
    {
        c.broken = true;
    }
    w.tick(6);
    q.borrow_mut().broken = false;
    to_idle(&mut w);
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "rolled-back", "{detail}");
    assert!(
        detail.starts_with("guard: the dispatcher exited with 1"),
        "{detail}"
    );
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
}

#[test]
fn the_safety_timer_brings_back_a_unit_stopped_by_hand() {
    let mut w = World::quadlet_running_v1();
    let q = w.quadlet_host();
    // `systemctl --user stop` by a person: the unit stays stopped, as a stop by hand does.
    q.borrow_mut()
        .systemctl(&["stop", "--no-block", &format!("{NAME}.service")]);
    assert!(q.borrow().running(NAME).is_none());
    w.tick(901);
    to_idle(&mut w);
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert!(q.borrow().running(NAME).is_some());
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
}

#[test]
fn a_user_manager_that_does_not_answer_changes_nothing() {
    let mut w = World::quadlet_running_v1();
    let q = w.quadlet_host();
    q.borrow_mut().down = true;
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    let before = q.borrow().changes.len();
    for _ in 0..20 {
        w.tick(30);
    }
    assert_eq!(q.borrow().changes.len(), before);
    assert_eq!(w.outcome().0, "engine-unreachable", "{:?}", w.outcome());
    assert!(
        w.outcome().1.contains("Failed to connect to bus"),
        "{:?}",
        w.outcome()
    );
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    // Back: the round goes on where it was.
    q.borrow_mut().down = false;
    to_idle(&mut w);
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert_eq!(w.applied().as_deref(), Some("v1.1.0"));
}

#[test]
fn a_quadlet_host_s_lint_holds_the_owner_s_override_to_what_it_renders() {
    let mut w = World::quadlet_running_v1();
    fs::write(
        w.set_dir().join("compose.override.yml"),
        "services:\n  dispatcher:\n    networks: [default]\n",
    )
    .unwrap();
    w.release("v1.1.0");
    w.target("v1.1.0", None);
    w.round();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "refused", "{detail}");
    assert!(
        detail.contains("quadlet: dispatcher: networks is not rendered for Quadlet"),
        "{detail}"
    );
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
}

// ---------------------------------------------------------------------------------------
// #327's token file on the Quadlet driver.

/// The unit's line mounting the set's token file read-only.
fn token_volume(w: &World) -> String {
    format!(
        "Volume={}:/run/omarchy/worker-token:ro",
        w.token_file().display()
    )
}

/// What `omarchy-agent token` (and #325's rotate-token order) does: the pool's answer
/// written through `enroll::write_worker_token`.
fn rotate(w: &World, token: &str) {
    let r = crate::dispatcher_env::Rendered {
        addresses: Vec::new(),
        envelope: None,
        plain: false,
    };
    crate::enroll::write_worker_token(
        &w.set_dir().join("etc/dispatcher.env"),
        &serde_json::json!({"worker": WORKER, "token": token}),
        &r,
    )
    .unwrap();
}

#[test]
fn a_rotation_on_quadlet_restarts_the_dispatcher_s_unit_alone_and_the_task_runs_on() {
    let mut w = World::quadlet_running_v1();
    let q = w.quadlet_host();
    let unit = q.borrow().units.join(format!("{NAME}.container"));
    let before = fs::read_to_string(&unit).unwrap();
    // The file by path, read-only, and its name for the dispatcher: never the token.
    assert!(
        before.lines().any(|l| l == token_volume(&w))
            && before.contains("\"OMARCHY_WORKER_TOKEN_FILE=/run/omarchy/worker-token\"")
            && !before.contains(TOKEN),
        "{before}"
    );
    let env = w.set_dir().join("etc/dispatcher.env");
    let env_before = fs::read_to_string(&env).unwrap();
    let (task, started, old) = {
        let s = q.borrow();
        let t = s.tasks()[0];
        (
            t.id.clone(),
            t.started_at,
            s.running(NAME).unwrap().id.clone(),
        )
    };
    let changes = q.borrow().changes.len();
    let new = format!("omw_{}", "5e".repeat(24));
    rotate(&w, &new);
    assert_eq!(
        crate::dispatcher_env::read_token(&w.token_file()).unwrap(),
        Some((new.clone(), 0o400))
    );
    // The next tick sees the changed input: a round that restarts the unit, and only it.
    w.tick(3);
    assert!(
        w.agent.state.rollout.why.contains("an input changed"),
        "{:?}",
        w.agent.state.rollout
    );
    to_idle(&mut w);
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    let s = q.borrow();
    let d = s.running(NAME).unwrap();
    assert_ne!(
        d.id, old,
        "the dispatcher was started again with the new token"
    );
    assert!(s.saved.contains(&old), "the old one saved its leases");
    assert_eq!(d.readopted, 1);
    assert_eq!(
        d.labels["org.omarchy-pool.agent.release"].as_str(),
        "v1.0.0"
    );
    assert_eq!(s.tasks().len(), 1);
    assert_eq!(
        (s.tasks()[0].id.as_str(), s.tasks()[0].started_at),
        (task.as_str(), started),
        "the task runs on, never restarted"
    );
    let since = &s.changes[changes..];
    assert!(
        since.contains(&format!("restart {NAME}"))
            && since.iter().all(|c| c == "daemon-reload"
                || c == &format!("stop {NAME}")
                || c == &format!("restart {NAME}")
                || c.starts_with("pull ")),
        "{since:?}"
    );
    drop(s);
    // The unit changed by its inputs label alone; it holds neither token, and podman's env
    // file none either.
    let after = fs::read_to_string(&unit).unwrap();
    assert_ne!(after, before);
    assert!(
        after.lines().any(|l| l == token_volume(&w))
            && !after.contains(&new)
            && !after.contains(TOKEN),
        "{after}"
    );
    assert_eq!(fs::read_to_string(&env).unwrap(), env_before);
    // The round read the token file again: the journal scrubs the new token.
    crate::run::rollout::report(
        &mut w.agent.state,
        &w.agent.journal,
        w.now,
        crate::run::rollout::Outcome::EngineUnreachable,
        None,
        &format!("systemctl --user: echoed {new}"),
    );
    assert!(!w.agent.state.round.detail.contains(&new));
    assert!(!w.journal().contains(&new));
}

#[test]
fn a_quadlet_host_holds_its_dispatcher_while_the_token_file_is_missing_and_podman_makes_nothing_there(
) {
    // Enrolled, the token not written yet: held, and no unit written.
    let mut w = World::quadlet();
    let q = w.quadlet_host();
    let file = w.token_file();
    let unit = q.borrow().units.join(format!("{NAME}.container"));
    fs::remove_file(&file).unwrap();
    w.release("v1.0.0");
    w.target("v1.0.0", None);
    w.round();
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "held");
    assert!(
        detail.contains("awaiting the owner's Confirm: run/host/dispatcher/token is missing"),
        "{detail}"
    );
    assert!(q.borrow().changes.is_empty(), "{:?}", q.borrow().changes);
    assert!(!unit.exists() && !file.exists());
    assert_eq!(w.applied(), None);
    // The token arrives as the enrollment writes it: the next round starts the unit.
    rotate(&w, &format!("omw_{}", "4d".repeat(24)));
    w.round();
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    assert!(q.borrow().running(NAME).is_some());
    let task = q.borrow_mut().start_task();

    // The file gone on a running host, and the dispatcher's container restarts (the pool's
    // ordered restart): podman refuses to start it without its bind's source — nothing is
    // made where the file belongs — and systemd keeps trying.
    fs::remove_file(&file).unwrap();
    let changes = q.borrow().changes.len();
    let good = fs::read_to_string(&unit).unwrap();
    q.borrow_mut().ordered_restart(NAME);
    assert!(q.borrow().running(NAME).is_none());
    assert!(!file.exists(), "a directory where the token file belongs");
    // The run loop sees the input change: its round is held, and touches no unit.
    w.tick(3);
    to_idle(&mut w);
    let (outcome, detail) = w.outcome();
    assert_eq!(outcome, "held", "{detail}");
    assert!(
        detail.contains("run/host/dispatcher/token is missing"),
        "{detail}"
    );
    {
        let s = q.borrow();
        assert_eq!(s.changes.len(), changes, "{:?}", &s.changes[changes..]);
        assert!(s.running(NAME).is_none());
        // podman's exit 125, and systemd trying again (`Restart=always`).
        assert_eq!(s.service(NAME).unwrap().sub, "auto-restart");
        assert!(
            s.exits.iter().any(|(n, e)| n == NAME && e.code == 125),
            "{:?}",
            s.exits
        );
        assert_eq!(s.tasks().len(), 1);
        assert_eq!(s.tasks()[0].id, task);
    }
    assert!(!file.exists());
    assert_eq!(fs::read_to_string(&unit).unwrap(), good);
    assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    // A new token (`omarchy-agent token`): the next round restarts the unit with it.
    rotate(&w, &format!("omw_{}", "6f".repeat(24)));
    w.tick(3);
    to_idle(&mut w);
    assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
    let s = q.borrow();
    assert_eq!(s.running(NAME).unwrap().readopted, 1);
    assert_eq!(s.tasks()[0].id, task);
}

#[test]
fn a_quadlet_host_s_override_mounting_a_secret_file_not_its_own_is_refused() {
    let mut w = World::quadlet_running_v1();
    let q = w.quadlet_host();
    // Quadlet would render it as any bind; the round's compose lint, which a Quadlet host
    // runs too, refuses another service's token file and its own mounted writable.
    for over in [
        "services:\n  dispatcher:\n    volumes:\n      - ./run/host/agent/token:/run/omarchy/agent-token:ro\n",
        "services:\n  dispatcher:\n    volumes:\n      - ./run/host/dispatcher/token:/run/omarchy/worker-token\n",
    ] {
        fs::write(w.set_dir().join("compose.override.yml"), over).unwrap();
        let changes = q.borrow().changes.len();
        w.round();
        let (outcome, detail) = w.outcome();
        assert_eq!(outcome, "refused", "{detail}");
        assert!(detail.contains("lint: secret_file: dispatcher: "), "{detail}");
        assert_eq!(q.borrow().changes.len(), changes);
        assert_eq!(w.applied().as_deref(), Some("v1.0.0"));
    }
}
