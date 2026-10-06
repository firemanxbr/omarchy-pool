//! A user's systemd running the Quadlet driver's units over a rootless podman (#330), for
//! the tests: what `systemctl --user` answers, and what the pinned docker CLI on podman's
//! API socket says of the containers those units start. Like Quadlet's `--rm` units, a
//! container is replaced at every restart, so a unit's restarts are the service's count,
//! never the container's; a unit stopped by hand is not restarted; a broken one (its
//! `Exec=` says `broken`) exits 1 at every look and is restarted at once. Task containers
//! are the dispatcher's: the fake panics if anything removes one.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;

use crate::quadlet::tests::systemd_words;
use crate::quadlet::HASH_LABEL;

use super::config::Runtime;
use super::driver::{Answer, Driver, EngineId, Exit, Foreign, Project, PullState, Unit};
use super::exec;
use super::quadlet::Systemd;

#[derive(Debug, Clone)]
pub(crate) struct Ctr {
    pub id: String,
    pub name: String,
    pub status: String,
    pub labels: BTreeMap<String, String>,
    pub broken: bool,
    pub ready_at: i64,
    pub started_at: i64,
    /// The tasks it found running when it started (a dispatcher re-adopts them).
    pub readopted: usize,
    pub exit_code: i64,
    pub task: bool,
}

/// A loaded unit's service.
#[derive(Debug, Clone)]
pub(crate) struct Svc {
    pub active: String,
    pub sub: String,
    pub restarts: u64,
    pub status: i64,
}

#[derive(Default)]
#[allow(clippy::struct_excessive_bools)] // a user systemd's switches, each a test's to flip
pub(crate) struct QState {
    pub clock: i64,
    /// The user's Quadlet directory.
    pub units: PathBuf,
    /// The unit files systemd read at its last `daemon-reload`, by unit name.
    pub loaded: BTreeMap<String, String>,
    pub services: BTreeMap<String, Svc>,
    pub containers: Vec<Ctr>,
    pub exits: Vec<(String, Exit)>,
    /// Every call that changes something, in order.
    pub changes: Vec<String>,
    /// The containers that saved their leases when stopped.
    pub saved: Vec<String>,
    pub pull_polls: u32,
    pull_left: Option<u32>,
    pub pull_fails: bool,
    pub removed_images: Vec<String>,
    /// The user manager does not answer (no user bus).
    pub down: bool,
    /// Every container its units start is broken (a podman that cannot run the release,
    /// which a runtime switch's guard catches).
    pub broken: bool,
    /// The podman answers as a rootful one.
    pub rootful: bool,
    /// The podman's version, when not 4.9.3.
    pub podman: Option<String>,
    pub reloads: u32,
    next: u64,
}

pub(crate) type QHost = Rc<RefCell<QState>>;

/// A fresh user systemd whose Quadlet directory is `units`.
pub(crate) fn host(units: PathBuf, clock: i64) -> QHost {
    Rc::new(RefCell::new(QState {
        clock,
        units,
        ..QState::default()
    }))
}

fn output(code: i32, stdout: &str, stderr: &str) -> exec::Output {
    exec::Output {
        program: "systemctl".into(),
        code: Some(code),
        stdout: stdout.into(),
        stderr: stderr.into(),
    }
}

impl QState {
    /// What an agent restart loses: the pull child it was polling.
    pub fn forget_pull(&mut self) {
        self.pull_left = None;
    }

    fn id(&mut self) -> String {
        self.next += 1;
        format!("{:064x}", 0xc0de_0000 + self.next)
    }

    /// A task container the dispatcher started.
    pub fn start_task(&mut self) -> String {
        let id = self.id();
        let at = self.clock;
        self.containers.push(Ctr {
            id: id.clone(),
            name: format!("task-{}", self.next),
            status: "running".into(),
            labels: BTreeMap::from([
                ("com.omarchy.task".into(), "1".into()),
                ("org.omarchy-pool.agent.host".into(), "h_test".into()),
            ]),
            broken: false,
            ready_at: 0,
            started_at: at,
            readopted: 0,
            exit_code: 0,
            task: true,
        });
        id
    }

    pub fn tasks(&self) -> Vec<&Ctr> {
        self.containers.iter().filter(|c| c.task).collect()
    }

    /// The container a unit runs now.
    pub fn running(&self, name: &str) -> Option<&Ctr> {
        self.containers.iter().find(|c| c.name == name && !c.task)
    }

    pub fn service(&self, name: &str) -> Option<&Svc> {
        self.services.get(name)
    }

    /// The pool's restart order (#277): the dispatcher exits 75, its unit restarts it, and
    /// `/ready` comes back once it re-adopted its leases.
    pub fn ordered_restart(&mut self, name: &str) {
        self.exit(name, 75);
        if let Some(s) = self.services.get_mut(name) {
            s.restarts += 1;
        }
        self.start(name, 8);
    }

    fn exit(&mut self, name: &str, code: i64) {
        let at = self.clock;
        if let Some(i) = self
            .containers
            .iter()
            .position(|c| c.name == name && !c.task)
        {
            let c = self.containers.remove(i);
            if code == 0 {
                self.saved.push(c.id.clone());
            }
            self.exits.push((name.to_owned(), Exit { at, code }));
        }
    }

    /// Starts the unit's container from what systemd loaded; `/ready` after `ready_in`.
    fn start(&mut self, name: &str, ready_in: i64) {
        let text = self.loaded.get(name).cloned().unwrap_or_default();
        let mut labels = BTreeMap::new();
        let mut broken = false;
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("Label=") {
                for w in systemd_words(v) {
                    if let Some((k, v)) = w.split_once('=') {
                        labels.insert(k.to_owned(), v.to_owned());
                    }
                }
            }
            if let Some(v) = line.strip_prefix("Exec=") {
                broken |= systemd_words(v).iter().any(|w| w == "broken");
            }
        }
        broken |= self.broken;
        let id = self.id();
        let (at, tasks) = (self.clock, self.tasks().len());
        self.containers.push(Ctr {
            id,
            name: name.to_owned(),
            status: "running".into(),
            labels,
            broken,
            ready_at: if broken { i64::MAX } else { at + ready_in },
            started_at: at,
            readopted: tasks,
            exit_code: 0,
            task: false,
        });
        let s = self.services.entry(name.to_owned()).or_insert(Svc {
            active: String::new(),
            sub: String::new(),
            restarts: 0,
            status: 0,
        });
        s.active = "active".into();
        s.sub = "running".into();
    }

    /// A broken container exits 1 at every look, and its unit (`Restart=always`) starts the
    /// next one at once.
    fn crash_loop(&mut self) {
        let broken: Vec<String> = self
            .containers
            .iter()
            .filter(|c| c.broken && !c.task)
            .map(|c| c.name.clone())
            .collect();
        for name in broken {
            self.exit(&name, 1);
            if let Some(s) = self.services.get_mut(&name) {
                s.restarts += 1;
                s.status = 1;
            }
            self.start(&name, 0);
        }
    }

    pub(crate) fn systemctl(&mut self, args: &[&str]) -> exec::Output {
        if self.down {
            return output(1, "", "Failed to connect to bus: No medium found");
        }
        let unit = |svc: &str| svc.strip_suffix(".service").unwrap_or(svc).to_owned();
        match args {
            ["daemon-reload"] => {
                self.reloads += 1;
                self.loaded.clear();
                for e in fs::read_dir(&self.units).into_iter().flatten().flatten() {
                    let n = e.file_name().to_string_lossy().into_owned();
                    if let Some(name) = n.strip_suffix(".container") {
                        let text = fs::read_to_string(e.path()).unwrap();
                        self.loaded.insert(name.to_owned(), text);
                    }
                }
                self.changes.push("daemon-reload".into());
                output(0, "", "")
            }
            ["show", props, svc] => {
                assert!(props.starts_with("--property="), "{props}");
                self.crash_loop();
                let name = unit(svc);
                let load = if self.loaded.contains_key(&name) {
                    "loaded"
                } else {
                    "not-found"
                };
                let s = self.services.get(&name);
                output(
                    0,
                    &format!(
                        "LoadState={load}\nActiveState={}\nSubState={}\nNRestarts={}\nExecMainStatus={}\n",
                        s.map_or("inactive", |s| s.active.as_str()),
                        s.map_or("dead", |s| s.sub.as_str()),
                        s.map_or(0, |s| s.restarts),
                        s.map_or(0, |s| s.status),
                    ),
                    "",
                )
            }
            ["restart", svc] => {
                let name = unit(svc);
                if !self.loaded.contains_key(&name) {
                    return output(
                        5,
                        "",
                        &format!("Failed to restart {svc}: Unit {svc} not found."),
                    );
                }
                self.exit(&name, 0);
                self.changes.push(format!("restart {name}"));
                // A start by hand counts restarts from naught.
                if let Some(s) = self.services.get_mut(&name) {
                    s.restarts = 0;
                }
                self.start(&name, 0);
                output(0, "", "")
            }
            ["stop", "--no-block", svc] => {
                let name = unit(svc);
                self.changes.push(format!("stop {name}"));
                self.exit(&name, 0);
                if let Some(s) = self.services.get_mut(&name) {
                    s.active = "inactive".into();
                    s.sub = "dead".into();
                }
                output(0, "", "")
            }
            ["kill", "--signal=SIGKILL", svc] => {
                let name = unit(svc);
                self.changes.push(format!("kill {name}"));
                self.exit(&name, 137);
                if let Some(s) = self.services.get_mut(&name) {
                    s.active = "failed".into();
                    s.sub = "failed".into();
                }
                output(0, "", "")
            }
            ["reset-failed", svc] => {
                let name = unit(svc);
                if let Some(s) = self.services.get_mut(&name) {
                    if s.active == "failed" {
                        s.active = "inactive".into();
                        s.sub = "dead".into();
                    }
                }
                output(0, "", "")
            }
            other => panic!("systemctl --user {other:?} is not a call the driver makes"),
        }
    }
}

/// `systemctl --user` on the fake.
pub(crate) struct FakeSystemd(pub QHost);

impl Systemd for FakeSystemd {
    fn user(&mut self, args: &[&str]) -> Result<exec::Output, String> {
        Ok(self.0.borrow_mut().systemctl(args))
    }
}

/// The pinned docker CLI on podman's API socket, on the fake: only what the Quadlet driver
/// asks of the engine (compose's own calls panic).
pub(crate) struct FakeApi(pub QHost);

fn not_asked<T>(what: &str) -> Answer<T> {
    panic!("the Quadlet driver asked the engine's API for {what}: compose's, not its own")
}

impl Driver for FakeApi {
    fn observe(&mut self, _: &Project, _: &[String]) -> Answer<Vec<Unit>> {
        not_asked("observe")
    }
    fn config_hash(&mut self, _: &Project, _: &str) -> Answer<String> {
        not_asked("config_hash")
    }
    fn images(&mut self, _: &Project) -> Answer<Vec<String>> {
        not_asked("images")
    }
    fn start_pull(&mut self, _: &Project, _: &[String]) -> Answer<()> {
        not_asked("start_pull")
    }
    /// Another project's container (`retire-legacy`'s): the engine stops it.
    fn begin_drain(&mut self, u: &Unit, _: u64) -> Answer<()> {
        let mut q = self.0.borrow_mut();
        q.changes.push(format!("stop {}", u.id));
        match q.containers.iter_mut().find(|c| c.id == u.id) {
            Some(c) => {
                assert!(!c.task, "a task container was stopped");
                c.status = "exited".into();
                Answer::Yes(())
            }
            None => Answer::NotFound,
        }
    }
    fn drained(&mut self, u: &Unit) -> Answer<bool> {
        let q = self.0.borrow();
        Answer::Yes(
            q.containers
                .iter()
                .find(|c| c.id == u.id)
                .is_none_or(|c| c.status == "exited"),
        )
    }
    fn create(&mut self, _: &Project, _: &[String]) -> Answer<()> {
        not_asked("create")
    }

    fn pull_images(&mut self, images: &[String]) -> Answer<()> {
        let mut q = self.0.borrow_mut();
        q.pull_left = Some(q.pull_polls);
        q.changes.push(format!("pull {}", images.join(",")));
        Answer::Yes(())
    }

    fn poll_pull(&mut self) -> Answer<PullState> {
        let mut q = self.0.borrow_mut();
        match q.pull_left {
            None => Answer::NotFound,
            Some(0) => {
                q.pull_left = None;
                Answer::Yes(if q.pull_fails {
                    PullState::Failed("manifest unknown".into())
                } else {
                    PullState::Done
                })
            }
            Some(n) => {
                q.pull_left = Some(n - 1);
                Answer::Yes(PullState::Running)
            }
        }
    }

    fn remove(&mut self, u: &Unit, force: bool) -> Answer<()> {
        let mut q = self.0.borrow_mut();
        if let Some(c) = q.containers.iter().find(|c| c.name == u.id || c.id == u.id) {
            assert!(!c.task, "a task container was removed");
        }
        q.changes
            .push(format!("rm{} {}", if force { " -f" } else { "" }, u.id));
        let id = u.id.clone();
        q.containers.retain(|c| c.name != id && c.id != id);
        Answer::Yes(())
    }

    fn inspect(&mut self, id: &str) -> Answer<Unit> {
        let mut q = self.0.borrow_mut();
        q.crash_loop();
        q.containers
            .iter()
            .find(|c| c.name == id || c.id == id)
            .map_or(Answer::NotFound, |c| {
                let label = |k: &str| c.labels.get(k).cloned().unwrap_or_default();
                Answer::Yes(Unit {
                    id: c.id.clone(),
                    service: label("org.omarchy-pool.agent.service"),
                    status: c.status.clone(),
                    restarts: 0,
                    exit_code: c.exit_code,
                    config_hash: label(HASH_LABEL),
                    release: label("org.omarchy-pool.agent.release"),
                })
            })
    }

    fn exits_since(&mut self, id: &str, since: i64) -> Answer<Vec<Exit>> {
        Answer::Yes(
            self.0
                .borrow()
                .exits
                .iter()
                .filter(|(n, e)| n == id && e.at >= since)
                .map(|(_, e)| *e)
                .collect(),
        )
    }

    fn ready(&mut self, id: &str, _: &str) -> Answer<bool> {
        let q = self.0.borrow();
        match q.running(id) {
            None => Answer::NotFound,
            Some(c) => Answer::Yes(c.status == "running" && q.clock >= c.ready_at),
        }
    }

    fn remove_image(&mut self, image: &str) -> Answer<()> {
        self.0.borrow_mut().removed_images.push(image.to_owned());
        Answer::Yes(())
    }

    fn project_containers(&mut self, _: &str) -> Answer<Vec<Foreign>> {
        Answer::Yes(Vec::new())
    }

    fn project_networks(&mut self, _: &str) -> Answer<Vec<String>> {
        Answer::Yes(Vec::new())
    }

    fn remove_network(&mut self, _: &str) -> Answer<()> {
        Answer::Yes(())
    }

    fn logs(&mut self, id: &str, _: u32) -> Answer<String> {
        match self.0.borrow().running(id) {
            Some(_) => Answer::Yes(String::new()),
            None => Answer::NotFound,
        }
    }

    fn engine(&mut self) -> Answer<EngineId> {
        let q = self.0.borrow();
        Answer::Yes(EngineId {
            runtime: Runtime::Podman,
            version: q.podman.clone().unwrap_or_else(|| "4.9.3".into()),
            rootless: !q.rootful,
        })
    }

    fn host_tasks(&mut self, _: &str) -> Answer<usize> {
        Answer::Yes(self.0.borrow().tasks().len())
    }

    fn tasks_running(&mut self) -> Answer<bool> {
        Answer::Yes(!self.0.borrow().tasks().is_empty())
    }
}

/// The Quadlet driver on the fake: its API and systemd both `q`'s.
pub(crate) fn driver(q: &QHost) -> Box<dyn Driver> {
    let units = q.borrow().units.clone();
    Box::new(super::quadlet::Quadlet::new(
        Box::new(FakeApi(Rc::clone(q))),
        Box::new(FakeSystemd(Rc::clone(q))),
        &units,
    ))
}
