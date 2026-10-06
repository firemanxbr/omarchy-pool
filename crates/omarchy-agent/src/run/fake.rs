//! Test doubles for the run loop: an engine that behaves like docker for the set's
//! dispatcher (and holds task containers the rollout must never touch), a pool that
//! answers what a test says, and signed content from the real verify path with a
//! vouching signature check.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::rc::Rc;

use sha2::{Digest as _, Sha256};

use crate::verify::tests_support;
use crate::verify::{BundleOutcome, Rejection, StatementOutcome};
use crate::version::Release;

use super::agent::Verifier;
use super::config::Runtime;
use super::driver::{Answer, Driver, EngineId, Exit, Foreign, Project, PullState, Unit};
use super::pool::{Follow, HostState, Net, Order, OrderKind, Pool, Relayed};

// ---------------------------------------------------------------------------------------
// The engine.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Behavior {
    Good,
    /// Exits 1 again and again: the engine restarts it.
    Broken,
}

#[derive(Debug, Clone)]
pub(crate) struct Container {
    pub id: String,
    /// Empty for a task container: the dispatcher made it, not compose.
    pub project: String,
    pub service: String,
    pub status: String,
    pub restarts: u64,
    pub config_hash: String,
    pub release: String,
    pub behavior: Behavior,
    pub exits: Vec<Exit>,
    /// `/ready` answers from this time on.
    pub ready_at: i64,
    /// For a dispatcher: it saved its leases when stopped; how many tasks it re-adopted.
    pub saved_leases: bool,
    pub readopted: usize,
    pub started_at: i64,
    /// compose's working directory label (a legacy project's container, #344).
    pub working_dir: String,
    /// The agent's host label: a task's, or a container that claims a host and a project.
    pub agent_host: String,
}

#[derive(Default)]
#[allow(clippy::struct_excessive_bools)] // an engine's switches, each a test's to flip
pub(crate) struct EngineState {
    pub clock: i64,
    pub containers: Vec<Container>,
    /// Every call that changes something, in order.
    pub changes: Vec<String>,
    pub down: bool,
    pub pull_polls: u32,
    pub pull_fails: bool,
    pull_left: Option<u32>,
    pub removed_images: Vec<String>,
    /// Networks: (id, compose project, used by a container that stays).
    pub networks: Vec<(String, String, bool)>,
    next: u64,
    /// Which engine this is (#325's runtime switch): docker unless a test says podman.
    pub runtime: Option<Runtime>,
    pub rootless: bool,
    /// What the dispatcher wrote, a line each (#325's `diagnostics`).
    pub log: Vec<String>,
    /// Every container this engine creates is broken (#325: a runtime that cannot run the
    /// release, which the switch's guard catches).
    pub broken: bool,
}

impl EngineState {
    /// What an agent restart loses: the pull child it was polling.
    pub fn forget_pull(&mut self) {
        self.pull_left = None;
    }

    fn id(&mut self) -> String {
        self.next += 1;
        format!("{:064x}", self.next)
    }

    /// A task container the dispatcher started.
    pub fn start_task(&mut self) -> String {
        let id = self.id();
        let at = self.clock;
        self.containers.push(Container {
            id: id.clone(),
            project: String::new(),
            service: "task".into(),
            status: "running".into(),
            restarts: 0,
            config_hash: String::new(),
            release: String::new(),
            behavior: Behavior::Good,
            exits: Vec::new(),
            ready_at: 0,
            saved_leases: false,
            readopted: 0,
            started_at: at,
            working_dir: String::new(),
            agent_host: "h_0123456789".into(),
        });
        id
    }

    /// A container of another compose project — the legacy set's (#344) — running, made
    /// by compose in `dir`.
    pub fn start_foreign(&mut self, project: &str, service: &str, dir: &str) -> String {
        let id = self.id();
        let at = self.clock;
        self.containers.push(Container {
            id: id.clone(),
            project: project.into(),
            service: service.into(),
            status: "running".into(),
            restarts: 0,
            config_hash: String::new(),
            release: String::new(),
            behavior: Behavior::Good,
            exits: Vec::new(),
            ready_at: 0,
            saved_leases: false,
            readopted: 0,
            started_at: at,
            working_dir: dir.into(),
            agent_host: String::new(),
        });
        id
    }

    /// A network of compose project `project`; `used` by a container of another project.
    pub fn add_network(&mut self, project: &str, used: bool) -> String {
        let id = self.id();
        self.networks.push((id.clone(), project.into(), used));
        id
    }

    pub fn of_project(&self, project: &str) -> Vec<&Container> {
        self.containers
            .iter()
            .filter(|c| c.project == project)
            .collect()
    }

    /// The pool's restart order (#277): the dispatcher exits 75, the engine restarts it,
    /// and `/ready` comes back once it re-adopted its leases.
    pub fn ordered_restart(&mut self, service: &str) {
        let at = self.clock;
        let tasks = self.tasks().len();
        let c = self
            .containers
            .iter_mut()
            .find(|c| c.service == service && c.status == "running")
            .expect("a running dispatcher");
        c.exits.push(Exit { at, code: 75 });
        c.restarts += 1;
        c.ready_at = at + 8;
        c.readopted = tasks;
    }

    pub fn tasks(&self) -> Vec<&Container> {
        self.containers
            .iter()
            .filter(|c| c.project.is_empty())
            .collect()
    }

    pub fn dispatcher(&self) -> Option<&Container> {
        self.containers.iter().find(|c| c.service == "dispatcher")
    }

    fn unit(c: &Container) -> Unit {
        Unit {
            id: c.id.clone(),
            service: c.service.clone(),
            status: c.status.clone(),
            restarts: c.restarts,
            exit_code: c.exits.last().map_or(0, |e| e.code),
            config_hash: c.config_hash.clone(),
            release: c.release.clone(),
        }
    }

    fn touch(&mut self, what: &str, id: &str) {
        if let Some(c) = self.containers.iter().find(|c| c.id == id) {
            assert!(
                !c.project.is_empty(),
                "the rollout touched a task container: {what}"
            );
        }
        self.changes
            .push(format!("{what} {}", &id[id.len().saturating_sub(4)..]));
    }

    /// A broken container crashes again at every look.
    fn crash_loop(&mut self) {
        let at = self.clock;
        for c in self
            .containers
            .iter_mut()
            .filter(|c| c.behavior == Behavior::Broken && c.status != "exited")
        {
            c.exits.push(Exit { at, code: 1 });
            c.restarts += 1;
            c.status = "restarting".into();
        }
    }
}

pub(crate) type Engine = Rc<RefCell<EngineState>>;

/// The driver over a shared [`EngineState`], so a test can look while the agent owns it.
pub(crate) struct FakeDriver(pub Engine);

fn hash_of(p: &Project, service: &str) -> String {
    let mut h = Sha256::new();
    for f in &p.files {
        h.update(fs::read(f).unwrap_or_default());
    }
    for (k, v) in &p.env {
        h.update(format!("{k}={v}\n"));
    }
    h.update(service);
    hex::encode(h.finalize())
}

fn label(p: &Project, key: &str) -> String {
    p.files
        .iter()
        .filter_map(|f| fs::read_to_string(f).ok())
        .find_map(|t| {
            t.lines().find_map(|l| {
                l.trim()
                    .strip_prefix(&format!("{key}: "))
                    .map(|v| v.trim_matches('"').to_owned())
            })
        })
        .unwrap_or_default()
}

impl Driver for FakeDriver {
    fn observe(&mut self, p: &Project, services: &[String]) -> Answer<Vec<Unit>> {
        let mut e = self.0.borrow_mut();
        if e.down {
            return Answer::NoAnswer("Cannot connect to the Docker daemon".into());
        }
        e.crash_loop();
        Answer::Yes(
            e.containers
                .iter()
                .filter(|c| c.project == p.name && services.contains(&c.service))
                .map(EngineState::unit)
                .collect(),
        )
    }

    fn config_hash(&mut self, p: &Project, service: &str) -> Answer<String> {
        if self.0.borrow().down {
            return Answer::NoAnswer("down".into());
        }
        Answer::Yes(hash_of(p, service))
    }

    fn images(&mut self, p: &Project) -> Answer<Vec<String>> {
        let text: String = p
            .files
            .iter()
            .filter_map(|f| fs::read_to_string(f).ok())
            .collect();
        Answer::Yes(
            text.lines()
                .filter_map(|l| l.trim().strip_prefix("image: "))
                .map(str::to_owned)
                .collect(),
        )
    }

    fn start_pull(&mut self, _: &Project, services: &[String]) -> Answer<()> {
        let mut e = self.0.borrow_mut();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        e.pull_left = Some(e.pull_polls);
        e.changes.push(format!("pull {}", services.join(",")));
        Answer::Yes(())
    }

    fn poll_pull(&mut self) -> Answer<PullState> {
        let mut e = self.0.borrow_mut();
        match e.pull_left {
            None => Answer::NotFound,
            Some(0) => {
                e.pull_left = None;
                Answer::Yes(if e.pull_fails {
                    PullState::Failed("manifest unknown".into())
                } else {
                    PullState::Done
                })
            }
            Some(n) => {
                e.pull_left = Some(n - 1);
                Answer::Yes(PullState::Running)
            }
        }
    }

    fn begin_drain(&mut self, u: &Unit, _: u64) -> Answer<()> {
        let mut e = self.0.borrow_mut();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        e.touch("stop", &u.id);
        if let Some(c) = e.containers.iter_mut().find(|c| c.id == u.id) {
            c.status = "exited".into();
            c.saved_leases = true;
        }
        Answer::Yes(())
    }

    fn drained(&mut self, u: &Unit) -> Answer<bool> {
        let e = self.0.borrow();
        Answer::Yes(
            e.containers
                .iter()
                .find(|c| c.id == u.id)
                .is_none_or(|c| c.status == "exited"),
        )
    }

    fn remove(&mut self, u: &Unit, force: bool) -> Answer<()> {
        let mut e = self.0.borrow_mut();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        e.touch(if force { "rm -f" } else { "rm" }, &u.id);
        e.containers.retain(|c| c.id != u.id);
        Answer::Yes(())
    }

    fn create(&mut self, p: &Project, services: &[String]) -> Answer<()> {
        let mut e = self.0.borrow_mut();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        let broken = e.broken
            || p.files
                .iter()
                .any(|f| fs::read_to_string(f).is_ok_and(|t| t.contains("command: [broken]")));
        let release = label(p, "org.omarchy-pool.agent.release");
        for s in services {
            let hash = hash_of(p, s);
            if e.containers.iter().any(|c| {
                c.project == p.name
                    && &c.service == s
                    && c.config_hash == hash
                    && c.status == "running"
            }) {
                continue;
            }
            let old: Vec<String> = e
                .containers
                .iter()
                .filter(|c| c.project == p.name && &c.service == s)
                .map(|c| c.id.clone())
                .collect();
            for id in old {
                e.touch("recreate", &id);
                e.containers.retain(|c| c.id != id);
            }
            let id = e.id();
            e.touch("create", &id);
            let (at, tasks) = (e.clock, e.tasks().len());
            e.containers.push(Container {
                id,
                project: p.name.clone(),
                service: s.clone(),
                status: "running".into(),
                restarts: 0,
                config_hash: hash,
                release: release.clone(),
                behavior: if broken {
                    Behavior::Broken
                } else {
                    Behavior::Good
                },
                exits: Vec::new(),
                ready_at: if broken { i64::MAX } else { at },
                saved_leases: false,
                readopted: tasks,
                started_at: at,
                working_dir: p.dir.display().to_string(),
                agent_host: label(p, "org.omarchy-pool.agent.host"),
            });
        }
        Answer::Yes(())
    }

    fn inspect(&mut self, id: &str) -> Answer<Unit> {
        let mut e = self.0.borrow_mut();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        e.crash_loop();
        e.containers
            .iter()
            .find(|c| c.id == id)
            .map_or(Answer::NotFound, |c| Answer::Yes(EngineState::unit(c)))
    }

    fn exits_since(&mut self, id: &str, since: i64) -> Answer<Vec<Exit>> {
        let e = self.0.borrow();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        Answer::Yes(
            e.containers
                .iter()
                .find(|c| c.id == id)
                .map(|c| c.exits.iter().copied().filter(|x| x.at >= since).collect())
                .unwrap_or_default(),
        )
    }

    fn ready(&mut self, id: &str, _: &str) -> Answer<bool> {
        let e = self.0.borrow();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        match e.containers.iter().find(|c| c.id == id) {
            None => Answer::NotFound,
            Some(c) => Answer::Yes(c.status == "running" && e.clock >= c.ready_at),
        }
    }

    fn remove_image(&mut self, image: &str) -> Answer<()> {
        self.0.borrow_mut().removed_images.push(image.to_owned());
        Answer::Yes(())
    }

    fn project_containers(&mut self, project: &str) -> Answer<Vec<Foreign>> {
        let e = self.0.borrow();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        Answer::Yes(
            e.containers
                .iter()
                .filter(|c| c.project == project)
                .map(|c| Foreign {
                    id: c.id.clone(),
                    status: c.status.clone(),
                    working_dir: c.working_dir.clone(),
                    agent_host: c.agent_host.clone(),
                })
                .collect(),
        )
    }

    fn project_networks(&mut self, project: &str) -> Answer<Vec<String>> {
        let e = self.0.borrow();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        Answer::Yes(
            e.networks
                .iter()
                .filter(|n| n.1 == project)
                .map(|n| n.0.clone())
                .collect(),
        )
    }

    fn remove_network(&mut self, id: &str) -> Answer<()> {
        let mut e = self.0.borrow_mut();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        if e.networks.iter().any(|n| n.0 == id && n.2) {
            return Answer::NoAnswer(format!(
                "Error response from daemon: network {} has active endpoints",
                &id[id.len() - 4..]
            ));
        }
        e.touch_network(id);
        e.networks.retain(|n| n.0 != id);
        Answer::Yes(())
    }
    fn logs(&mut self, id: &str, lines: u32) -> Answer<String> {
        let e = self.0.borrow();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        if !e.containers.iter().any(|c| c.id == id) {
            return Answer::NotFound;
        }
        let skip = e.log.len().saturating_sub(lines as usize);
        Answer::Yes(e.log[skip..].iter().fold(String::new(), |mut out, l| {
            out.push_str(l);
            out.push('\n');
            out
        }))
    }

    fn engine(&mut self) -> Answer<EngineId> {
        let e = self.0.borrow();
        if e.down {
            return Answer::NoAnswer("Cannot connect to the Docker daemon".into());
        }
        let runtime = e.runtime.unwrap_or(Runtime::Docker);
        Answer::Yes(EngineId {
            runtime,
            version: if runtime == Runtime::Podman {
                "4.9.3"
            } else {
                "29.6.2"
            }
            .into(),
            rootless: e.rootless,
        })
    }

    fn host_tasks(&mut self, _host: &str) -> Answer<usize> {
        let e = self.0.borrow();
        if e.down {
            return Answer::NoAnswer("down".into());
        }
        Answer::Yes(e.tasks().iter().filter(|c| c.status == "running").count())
    }
}

impl EngineState {
    fn touch_network(&mut self, id: &str) {
        self.changes
            .push(format!("network rm {}", &id[id.len().saturating_sub(4)..]));
    }
}

// ---------------------------------------------------------------------------------------
// The pool and GitHub.

#[derive(Default)]
pub(crate) struct PoolState {
    pub state: Option<Net<HostState>>,
    /// What the pool's edge says the host comes from; `None` answers nothing.
    pub public: Option<Net<std::net::IpAddr>>,
    pub publics: u32,
    pub assets: BTreeMap<String, Vec<u8>>,
    pub statements: BTreeMap<Release, Relayed>,
    /// How many times the host state was asked for.
    pub polls: u32,
    /// The host reports posted, as JSON; `report_answer` is what posting one answers.
    pub reports: Vec<serde_json::Value>,
    pub report_answer: Option<Net<()>>,
    /// How many times a report was posted, whatever the answer.
    pub report_tries: u32,
    /// The public `follow` a pool from before #344 answers, and the workers it was asked for.
    pub follow: Option<Net<Follow>>,
    pub follows: Vec<String>,
    /// What `POST /hosts/self/token` answers (#325): a new token each time unless a test
    /// says otherwise; how many were asked for.
    pub token_answer: Option<Net<serde_json::Value>>,
    pub tokens: u32,
    /// The diagnostics posted (#325), as JSON, and what posting answers.
    pub diagnostics: Vec<serde_json::Value>,
    pub diagnostics_answer: Option<Net<()>>,
    /// What GitHub says its latest release is (#326); `None` answers nothing. How many
    /// times it was read.
    pub github: Option<Net<Release>>,
    pub github_reads: u32,
}

pub(crate) type Remote = Rc<RefCell<PoolState>>;

pub(crate) struct FakePool(pub Remote);

impl Pool for FakePool {
    fn state(&mut self) -> Net<HostState> {
        let mut s = self.0.borrow_mut();
        s.polls += 1;
        s.state.clone().unwrap_or(Net::NoAnswer("no pool".into()))
    }

    fn follow(&mut self, worker_id: &str) -> Net<Follow> {
        let mut s = self.0.borrow_mut();
        s.follows.push(worker_id.to_owned());
        s.follow.clone().unwrap_or(Net::NoAnswer("HTTP 404".into()))
    }

    fn report(&mut self, body: &[u8]) -> Net<()> {
        let mut s = self.0.borrow_mut();
        s.report_tries += 1;
        let answer = s.report_answer.clone().unwrap_or(Net::Ok(()));
        if answer == Net::Ok(()) {
            s.reports
                .push(serde_json::from_slice(body).expect("a report is JSON"));
        }
        answer
    }

    fn rollback(&mut self, to: Release) -> Net<Option<Relayed>> {
        Net::Ok(self.0.borrow().statements.get(&to).cloned())
    }

    fn release_asset(&mut self, r: Release, name: &str) -> Net<Vec<u8>> {
        self.0
            .borrow()
            .assets
            .get(&format!("{r}/{name}"))
            .cloned()
            .map_or_else(|| Net::NoAnswer("HTTP 404".into()), Net::Ok)
    }

    fn download(&mut self, url: &str) -> Net<Vec<u8>> {
        Net::NoAnswer(format!("{url}: no downloads in tests"))
    }

    fn token(&mut self) -> Net<serde_json::Value> {
        let mut s = self.0.borrow_mut();
        s.tokens += 1;
        let n = s.tokens;
        s.token_answer.clone().unwrap_or_else(|| {
            Net::Ok(serde_json::json!({
                "worker": "m1-test-0a9z",
                "token": format!("omw_{n:048x}"),
                "issued_at": "2027-01-15T08:00:00.000Z",
                "rotate_after": "2027-02-14T08:00:00.000Z",
                "previous_valid_until": "2027-01-15T08:10:00.000Z",
            }))
        })
    }

    fn diagnostics(&mut self, body: &[u8]) -> Net<()> {
        let mut s = self.0.borrow_mut();
        let answer = s.diagnostics_answer.clone().unwrap_or(Net::Ok(()));
        if answer == Net::Ok(()) {
            s.diagnostics
                .push(serde_json::from_slice(body).expect("diagnostics are JSON"));
        }
        answer
    }

    fn public_address(&mut self) -> Net<std::net::IpAddr> {
        let mut s = self.0.borrow_mut();
        s.publics += 1;
        s.public.clone().unwrap_or(Net::NoAnswer("no pool".into()))
    }

    fn github_latest(&mut self) -> Net<Release> {
        let mut s = self.0.borrow_mut();
        s.github_reads += 1;
        s.github
            .clone()
            .unwrap_or(Net::NoAnswer("no GitHub".into()))
    }
}

// ---------------------------------------------------------------------------------------
// Signed content.

/// Verifies for real but for the cryptographic check, which vouches at `signed_at`.
pub(crate) struct TestVerifier(pub Rc<RefCell<i64>>);

impl Verifier for TestVerifier {
    fn bundle(&self, archive: &[u8], sig: &[u8]) -> Result<BundleOutcome, Rejection> {
        tests_support::verify_bundle(archive, sig, *self.0.borrow())
    }
    fn statement(&self, json: &[u8], sig: &[u8]) -> Result<StatementOutcome, Rejection> {
        tests_support::verify_statement(json, sig, *self.0.borrow())
    }
}

pub(crate) const HOST_COMPOSE: &str = include_str!("../../../../factory/sets/host/compose.yml");
pub(crate) const HOST_SET: &str = include_str!("../../../../factory/sets/host/set.toml");

/// The host template rendered as release.yml renders it, with the example manifest's
/// images; `extra` lines are appended to the dispatcher (`command: [broken]`).
pub(crate) fn rendered_compose(extra: &str) -> String {
    let m = tests_support::manifest_json("v1.0.0", "v1.0.0", &[]);
    let index = m["inner"]["images"]["worker"]["index"]
        .as_str()
        .unwrap()
        .to_owned();
    let repo = m["inner"]["images"]["worker"]["repo"]
        .as_str()
        .unwrap()
        .to_owned();
    let b = &m["inner"]["images"]["build"];
    format!(
        "{}{extra}",
        HOST_COMPOSE
            .replace("@RELEASE_IMAGE@", &format!("{repo}@{index}"))
            .replace("@RELEASE@", &format!("@{index}"))
            .replace("@BUILD_AARCH64@", b["aarch64"].as_str().unwrap())
            .replace("@BUILD_X86_64@", b["x86_64"].as_str().unwrap())
    )
}

/// Publishes release `r` (created at `created`) on the fake GitHub: its bundle and a
/// signature the test verifier accepts. `extra` goes into the dispatcher's service.
pub(crate) fn publish(
    remote: &Remote,
    r: &str,
    created: &str,
    min_release: &str,
    revoked: &[&str],
    extra: &str,
) {
    let m = tests_support::manifest_json(r, min_release, revoked);
    publish_manifest(remote, r, created, m, extra);
}

/// The agent a release ships (#316): its version, its `min_agent`, and the binary for
/// this platform, published as the release asset the manifest names with its SHA-256.
pub(crate) struct Ships<'a> {
    pub version: &'a str,
    pub min_agent: &'a str,
    pub binary: &'a [u8],
}

/// Publishes `r` (created a day before T0) shipping `agent`.
pub(crate) fn publish_agent(remote: &Remote, r: &str, agent: &Ships) {
    publish_agent_as(remote, r, agent, false);
}

/// The same, its manifest's `agent.urgent` as given (#326: only a security release sets
/// it, and its agent does not wait for the owner's soak).
pub(crate) fn publish_agent_as(remote: &Remote, r: &str, agent: &Ships, urgent: bool) {
    let mut m = tests_support::manifest_json(r, "v1.0.0", &[]);
    m["agent"]["version"] = agent.version.into();
    m["agent"]["urgent"] = urgent.into();
    m["min_agent"] = agent.min_agent.into();
    let platform = super::tools::platform().expect("a platform with an agent build");
    m["agent"][platform]["sha256"] = super::tools::sha256_hex(agent.binary).into();
    let asset = m["agent"][platform]["asset"].as_str().unwrap().to_owned();
    remote
        .borrow_mut()
        .assets
        .insert(format!("{r}/{asset}"), agent.binary.to_vec());
    publish_manifest(remote, r, "2027-01-14T08:00:00Z", m, "");
}

fn publish_manifest(
    remote: &Remote,
    r: &str,
    created: &str,
    mut m: serde_json::Value,
    extra: &str,
) {
    m["created"] = created.into();
    m["inner"]["pools"] = serde_json::json!(["https://pkgs.omarchy-pool.org"]);
    let compose = rendered_compose(extra);
    let archive = tests_support::bundle_archive(
        m,
        &[
            ("compose.yml", compose.as_bytes()),
            ("set.toml", HOST_SET.as_bytes()),
        ],
    );
    let mut s = remote.borrow_mut();
    s.assets
        .insert(format!("{r}/omarchy-host-{r}.tar.gz"), archive);
    s.assets.insert(
        format!("{r}/omarchy-host-{r}.tar.gz.sigstore.json"),
        b"signed".to_vec(),
    );
}

/// A rollback statement rollback.yml "signed", relayed by the pool.
pub(crate) fn relay_statement(remote: &Remote, seq: u64, to: &str, through: &str, sig: &[u8]) {
    relay_statement_agent(remote, seq, to, through, sig, None);
}

/// The same, with an `agent_to` (#316).
pub(crate) fn relay_statement_agent(
    remote: &Remote,
    seq: u64,
    to: &str,
    through: &str,
    sig: &[u8],
    agent_to: Option<&str>,
) {
    let agent_to = agent_to.map_or_else(|| "null".to_owned(), |a| format!("\"{a}\""));
    let json = format!(
        r#"{{"schema":1,"seq":{seq},"to":"{to}","retracts_through":"{through}","issued":"2026-10-20T14:00:00Z","agent_to":{agent_to},"run":"https://github.com/firemanxbr/omarchy-pool/actions/runs/{seq}"}}"#
    );
    remote.borrow_mut().statements.insert(
        Release::parse(to).unwrap(),
        Relayed {
            statement: json.into_bytes(),
            bundle: sig.to_vec(),
        },
    );
}

// ---------------------------------------------------------------------------------------
// A host: the agent with its set directory, a fake engine and a fake pool.

use std::path::PathBuf;

use super::agent::{Agent, Drivers};
use super::config::{Config, Paths};
use super::state::{self, State, Step};

pub(crate) const TOKEN: &str = "omw_test_token_0123456789";

pub(crate) struct World {
    pub agent: Agent,
    pub engine: Engine,
    pub remote: Remote,
    pub signed_at: Rc<RefCell<i64>>,
    pub dir: PathBuf,
    pub now: i64,
    /// The engines by socket (#325's runtime switch): the agent's driver is the one its
    /// agent.toml names, and a switch reaches another through here.
    pub sockets: Sockets,
}

pub(crate) type Sockets = Rc<RefCell<BTreeMap<PathBuf, Engine>>>;

/// 2027-01-15T08:00:00Z.
pub(crate) const T0: i64 = 1_800_000_000;

impl World {
    pub fn new() -> Self {
        let dir = super::state::tempdir();
        let set = dir.join("set");
        fs::create_dir_all(set.join("etc")).unwrap();
        fs::create_dir_all(set.join("run")).unwrap();
        fs::write(
            set.join("etc/dispatcher.env"),
            format!("OMARCHY_WORKER_TOKEN={TOKEN}\n"),
        )
        .unwrap();
        fs::write(set.join("run/capacity.json"), r#"{"schema":2,"units":3}"#).unwrap();
        let cfg = Config::parse(&super::config::tests::example(
            &set,
            &dir.join("work"),
            &dir.join("secrets"),
        ))
        .unwrap();
        let paths = Paths {
            data: dir.join("data"),
        };
        fs::create_dir_all(&paths.data).unwrap();
        let engine: Engine = Rc::new(RefCell::new(EngineState {
            clock: T0,
            ..EngineState::default()
        }));
        let remote: Remote = Rc::new(RefCell::new(PoolState::default()));
        let signed_at = Rc::new(RefCell::new(T0));
        let sockets: Sockets = Rc::new(RefCell::new(BTreeMap::from([(
            cfg.socket_cli.clone(),
            Rc::clone(&engine),
        )])));
        let agent = Self::agent(cfg, paths, State::default(), &sockets, &remote, &signed_at);
        World {
            agent,
            engine,
            remote,
            signed_at,
            dir,
            now: T0,
            sockets,
        }
    }

    fn agent(
        cfg: Config,
        paths: Paths,
        state: State,
        sockets: &Sockets,
        remote: &Remote,
        signed_at: &Rc<RefCell<i64>>,
    ) -> Agent {
        let mut a = Agent::new(
            cfg,
            paths,
            state,
            Box::new(FakePool(Rc::clone(remote))),
            Box::new(TestVerifier(Rc::clone(signed_at))),
            Drivers::Fixed,
        );
        let by_socket = Rc::clone(sockets);
        a.drivers_on = Some(Box::new(move |socket| {
            by_socket
                .borrow()
                .get(socket)
                .map(|e| Box::new(FakeDriver(Rc::clone(e))) as Box<dyn Driver>)
        }));
        Self::drive(&mut a, sockets);
        a
    }

    /// The agent's driver: the engine its configuration names now.
    fn drive(a: &mut Agent, sockets: &Sockets) {
        let e = sockets
            .borrow()
            .get(&a.cfg.socket_cli)
            .cloned()
            .expect("an engine on the configured socket");
        a.driver = Some(Box::new(FakeDriver(e)));
    }

    /// Another engine on `socket` (#325): podman's API socket, say.
    pub fn add_engine(&self, socket: &str, runtime: Runtime, rootless: bool) -> Engine {
        let e: Engine = Rc::new(RefCell::new(EngineState {
            clock: self.now,
            runtime: Some(runtime),
            rootless,
            ..EngineState::default()
        }));
        self.sockets
            .borrow_mut()
            .insert(PathBuf::from(socket), Rc::clone(&e));
        e
    }

    /// The agent process ends and starts again: only what is on disk survives.
    pub fn restart(&mut self) {
        let cfg = self.agent.cfg.clone();
        self.restart_with(cfg);
    }

    /// A restart that reads agent.toml again, as `run` does (#325's runtime switch: the
    /// in-memory engine is the switch's, the file's the one it began on).
    pub fn restart_reading_agent_toml(&mut self) {
        let text = fs::read_to_string(self.agent.paths.agent_toml()).expect("agent.toml");
        self.restart_with(Config::parse(&text).unwrap());
    }

    fn restart_with(&mut self, cfg: Config) {
        let paths = self.agent.paths.clone();
        let state = state::load(&paths.state()).unwrap().unwrap_or_default();
        for e in self.sockets.borrow().values() {
            e.borrow_mut().forget_pull();
        }
        self.agent = Self::agent(
            cfg,
            paths,
            state,
            &self.sockets,
            &self.remote,
            &self.signed_at,
        );
        self.agent.resume(self.now);
        Self::drive(&mut self.agent, &self.sockets);
    }

    /// The running agent installed as install.sh installs it (#316):
    /// `versions/<it>/omarchy-agent`, `current` pointing there, and running from there.
    pub fn install_layout(&mut self) {
        let me = self.agent.version;
        let bin = self.agent.paths.binary(me);
        fs::create_dir_all(bin.parent().unwrap()).unwrap();
        fs::write(&bin, b"#!/bin/sh\nexit 0\n").unwrap();
        let current = self.agent.paths.current();
        let _ = fs::remove_file(&current);
        std::os::unix::fs::symlink(format!("versions/{me}"), &current).unwrap();
        self.agent.exe = Some(bin);
    }

    /// The agent exits and the service manager starts what `current` points at, played
    /// by an agent of `version` (only what is on disk survives).
    pub fn restart_as(&mut self, version: crate::version::Version) {
        self.restart();
        self.agent.version = version;
        self.agent.exe = Some(self.agent.paths.binary(version));
        self.agent.settle(self.now).unwrap();
    }

    pub fn set_dir(&self) -> PathBuf {
        self.dir.join("set")
    }

    /// The pool's host state names `latest`, with an open Update `update` and no host
    /// order.
    pub fn target(&self, latest: &str, update: Option<&str>) {
        self.remote.borrow_mut().state = Some(Net::Ok(HostState {
            target: Release::parse(latest),
            updates: update.map(str::to_owned).into_iter().collect(),
            orders: Vec::new(),
            poll_s: Some(120),
            older_pool: false,
            settings: None,
        }));
    }

    /// The host state carries `orders` (kind, id, seconds from now to its `not_after`)
    /// beside what it names already.
    pub fn orders(&self, orders: &[(&str, &str, i64)]) {
        let now = self.now;
        let mut r = self.remote.borrow_mut();
        let mut s = match r.state.take() {
            Some(Net::Ok(s)) => s,
            _ => HostState::default(),
        };
        s.orders = orders
            .iter()
            .map(|(kind, id, left)| Order {
                id: (*id).into(),
                kind: OrderKind::parse(kind),
                not_after: Some(now + left),
            })
            .collect();
        r.state = Some(Net::Ok(s));
    }

    pub fn pool_answers(&self, answer: Net<HostState>) {
        self.remote.borrow_mut().state = Some(answer);
    }

    /// The last host report posted.
    pub fn last_report(&self) -> serde_json::Value {
        self.remote
            .borrow()
            .reports
            .last()
            .cloned()
            .expect("a report was posted")
    }

    /// `secs` later, one tick.
    pub fn tick(&mut self, secs: i64) {
        self.now += secs;
        self.clocks();
        self.agent.tick(self.now, false).unwrap();
    }

    fn clocks(&self) {
        self.engine.borrow_mut().clock = self.now;
        for e in self.sockets.borrow().values() {
            e.borrow_mut().clock = self.now;
        }
    }

    /// The pool asked now, as when a poll falls due (no SIGUSR1: nothing forces a round).
    pub fn poll(&mut self) {
        self.agent.state.poll.next_at = 0;
        self.tick(1);
    }

    /// A round asked for now (SIGUSR1).
    pub fn round_now(&mut self) {
        self.now += 1;
        self.clocks();
        self.agent.tick(self.now, true).unwrap();
    }

    pub fn step(&self) -> &'static str {
        self.agent.state.rollout.step.name()
    }

    /// Ticks (3 s apart) until the rollout is idle again after leaving it.
    pub fn round(&mut self) {
        self.round_now();
        for _ in 0..400 {
            if self.agent.state.rollout.step == Step::Idle {
                return;
            }
            self.tick(3);
        }
        panic!("the round did not end: {:?}", self.agent.state.rollout);
    }

    pub fn applied(&self) -> Option<String> {
        self.agent.state.applied.map(|r| r.to_string())
    }

    pub fn outcome(&self) -> (String, String) {
        (
            self.agent.state.round.outcome.clone(),
            self.agent.state.round.detail.clone(),
        )
    }

    pub fn changes(&self) -> Vec<String> {
        self.engine.borrow().changes.clone()
    }

    pub fn journal(&self) -> String {
        fs::read_to_string(self.agent.paths.journal()).unwrap_or_default()
    }

    /// Publishes `r` (created a day before T0, floor values v1.0.0 / none).
    pub fn release(&self, r: &str) {
        publish(&self.remote, r, "2027-01-14T08:00:00Z", "v1.0.0", &[], "");
    }

    /// A host running v1.0.0 with one task container: the usual start.
    pub fn running_v1() -> Self {
        let mut w = World::new();
        w.release("v1.0.0");
        w.target("v1.0.0", None);
        w.round();
        assert_eq!(w.outcome().0, "ok", "{:?}", w.outcome());
        w.engine.borrow_mut().start_task();
        w
    }
}
