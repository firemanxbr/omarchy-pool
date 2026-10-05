//! `pkg-repo dispatch` (#335, design v2 §9; D27, D37, D47, D53): the one
//! service of a maintainer host's bundle. It holds the host's leases — as
//! many as its capacity allows — and starts one isolated, credential-less
//! container per lease, through one function ([`spec::task_container`]).
//!
//! **Start.** It refuses a package signing key in its environment (S5: the
//! pool signs what is published), learns its host's id, then re-adopts what
//! a previous dispatcher left ([`Dispatcher::readopt`]): a running task
//! container with a lease file is adopted, an exited one is completed from
//! its exit code, `OOMKilled` and outputs, a container without a lease file
//! goes, a lease file whose container is gone fails `lost`. Only then does
//! it answer `/ready` (on loopback only, with `/leases`).
//!
//! **The loop**, every few seconds ([`Dispatcher::tick`]): per lease — its
//! heartbeat when due (a `409` with `stop` kills its containers and fails it
//! as stopped, #277), its local expiry (the last accepted heartbeat plus the
//! lease and a grace: its own containers killed, nothing reported), its
//! container's state (exited: outputs checked against the kind's closed
//! list, uploaded with the job token, reported); then the disk watcher
//! (free space on the work root, or the engine's, below the floor kills the
//! youngest build, `lost`, and stops the claims until it is back; a build
//! refused at start for its budget keeps builds out of the claims — trials
//! and audits go on — until that budget plus the floor is free, for 30
//! minutes at most); then a claim — `want: 1` while units, memory, disk
//! and the lane's image allow, every 30 s with `want: 0` otherwise. The pool
//! selects (#337: as many leases as the units hold, native first, emulated
//! after a threshold); before each claim the dispatcher checks `MemAvailable`
//! against the largest task it could receive, less the shares of the leases
//! it started in the last few minutes (their containers have not grown to
//! them yet), and offers only what the memory still holds (the claim's
//! `offer`) — another workload on the machine leaves it what fits, or
//! nothing that round — and after a task it claims again at the next tick
//! while units are free. Fewer units than leases (a cap lowered) claims
//! nothing until they fit; nothing running is killed for it. There is no
//! queue on the host: a task is started the moment it is leased. A lease
//! ends (its report, its lease file, its units) only once the engine says
//! its container is gone. A tick spends at most a third of the stall on the
//! pool's heartbeats and reports; the rest wait for the next tick, and every
//! lease's own watchdog runs whatever the pool does. A loop that makes no
//! progress for 15 minutes exits 75 without touching a task container; the
//! next dispatcher re-adopts them. SIGTERM stops the claims and exits; the
//! lease files are always current, so tasks run on.
//!
//! **Networks and sidecars** (#336, design v2 §9.4, §9.5): every lease gets
//! its own internal network on a /28 of `OMARCHY_TASK_SUBNETS`, an egress
//! sidecar that reaches public addresses only and, for a model kind, its own
//! agent sidecar with per-task caps; a package with a signed exception in
//! `factory/sizing` gets a bridge network instead. All of it is made by
//! [`spec::plan`] and removed with the lease. The per-day agent budget is
//! kept here ([`budget`]); when it is spent, no model task starts and the
//! claim offers no agent slot. The dispatcher never joins a task network.
//! A probe sidecar ([`probe`]) says who this host's agent is with every
//! claim (`agent`) and answers `recheck-agent` and `restart-agent`.
//!
//! **Lanes** (#338, design v2 §7.4, §7.5): a build or a trial runs on the
//! lane the pool leased it on — its architecture's `--platform`, natively
//! or emulated through the host's binfmt handler when `run/capacity.json`
//! lists that emulated lane — and only a container on an emulated lane is
//! told so (`WORKER_LABELS={"emulated":true}`); an audit runs natively. A
//! lease on a lane the host does not run now is handed back `lost` before
//! anything starts, and the claim offers no emulated lane without its
//! build image by digest.
//!
//! **Orders** at host level: drain and resume are the pool's (it hands a
//! drained host nothing), stop-task fences one lease (its heartbeat's 409),
//! restart makes the dispatcher exit 75 (tasks survive), recheck-agent and
//! restart-agent run a fresh probe.
//!
//! Seams for #317 (install): the agent writes `etc/dispatcher.env` with the
//! host's worker token, the agent budget of the envelope
//! (`OMARCHY_AGENT_CALLS_PER_TASK`, `…_TOKENS_PER_TASK`, `…_MINUTES_PER_TASK`,
//! `…_CALLS_PER_DAY`) and the host's own addresses for the egress to refuse
//! (`OMARCHY_HOST_ADDRESSES`); the dispatcher keeps the registration's id it
//! learned in `state/host`.

pub mod budget;
pub mod capacity;
pub mod engine;
pub mod kinds;
pub mod lease;
pub mod pool;
pub mod probe;
pub mod sizing;
pub mod spec;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use self::capacity::Constants;
use self::engine::Engine;
use self::kinds::{Ctx, Prep, Retry};
use self::lease::{Ending, Lane, Lease, Phase, Store};
use self::pool::Pool;
use crate::orders::{self, clean_line, ClaimAnswer, Order, OrderKind};
use crate::stop::Beat;
use crate::work::{say, Task};
use crate::RepoError;

/// What a host claims in P1 (design v2 §8.2): builds of every trust, trials and audits.
pub const KINDS: [&str; 3] = ["build", "trial", "audit"];
/// The orders the dispatcher executes: drain (a notice), stop-task (the heartbeat's 409), restart (exit 75),
/// recheck-agent and restart-agent (a fresh probe).
pub const TAKES: [&str; 5] = [
    "drain",
    "recheck-agent",
    "restart",
    "restart-agent",
    "stop-task",
];
/// The exit a restart, or a loop that stopped making progress, ends with: the restart policy starts the next dispatcher.
pub const EXIT_RESTART: i32 = 75;
/// A dispatcher younger than this refuses a restart: one this soon would loop.
const RESTART_MIN_UPTIME: u64 = 120;
/// After a preparation or a finish that must be tried again.
const RETRY_AFTER: u64 = 60;
/// After a claim that failed.
const CLAIM_RETRY: u64 = 60;
/// The longest a build refused at start for its disk budget keeps builds out of the claims:
/// a budget this host can never fit does not strand it (the pool does not select by disk yet).
pub const DISK_HOLD: u64 = 30 * 60;
/// What a host claims while a disk hold keeps builds out.
const KINDS_HELD: [&str; 2] = ["trial", "audit"];
/// How long after its container starts a lease's memory share still counts as promised before a
/// claim (#337, design v2 §7.6): a container just started has not grown to its share, so
/// `MemAvailable` does not show it yet, and claims that follow each other at once would each offer
/// the same memory again. Past this, `MemAvailable` is taken to hold what the container uses.
pub const MEM_RAMP: u64 = 5 * 60;

/// The environment variables that would put a package signing key in the dispatcher (S5).
const SIGNING_VARS: [&str; 4] = [
    "SIGNING_KEY",
    "SIGNING_KEY_PASSPHRASE",
    "OMARCHY_GPG_KEYID",
    "OMARCHY_SIGNING_KEY",
];

/// The dispatcher refuses to start with a package signing key in its
/// environment (S5): by its variable's name, or an armored private key in any
/// variable's value. The pool signs what is published; nothing on a host does.
pub fn refuse_signing_key(env: impl IntoIterator<Item = (String, String)>) -> Result<()> {
    for (k, v) in env {
        if SIGNING_VARS.contains(&k.as_str()) && !v.is_empty() {
            anyhow::bail!("{k} is set: the dispatcher never holds a package signing key — the pool signs what is published (design v2 §9.6); remove it from etc/dispatcher.env");
        }
        if v.contains("PRIVATE KEY BLOCK") || v.contains("BEGIN PGP PRIVATE") {
            anyhow::bail!("{k} holds a private key: the dispatcher never holds a package signing key — the pool signs what is published (design v2 §9.6)");
        }
    }
    Ok(())
}

/// The variables that would put an agent key or a GitHub token in the dispatcher (invariant 5).
const AGENT_VARS: [&str; 6] = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "XAI_API_KEY",
    "GITHUB_TOKEN",
];

/// The dispatcher refuses to start with an agent key or a GitHub token in its environment
/// (design v2 §10.2, invariant 5): they belong in `OMARCHY_SECRETS_DIR/agent.env`, which only a
/// task's agent sidecar mounts.
pub fn refuse_agent_key(env: impl IntoIterator<Item = (String, String)>) -> Result<()> {
    for (k, v) in env {
        if AGENT_VARS.contains(&k.as_str()) && !v.is_empty() {
            anyhow::bail!("{k} is set: the dispatcher never holds an agent key or a GitHub token — they belong in OMARCHY_SECRETS_DIR/agent.env, which only a task's agent sidecar mounts (design v2 §10.2); remove it from etc/dispatcher.env");
        }
    }
    Ok(())
}

/// The loop's rhythm (design v2 §9.1). The hidden flags of `pkg-repo dispatch` shorten them for the engine tests.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub tick: Duration,
    pub heartbeat: Duration,
    /// The lease, and the grace after it, from the last accepted heartbeat.
    pub lease: Duration,
    pub grace: Duration,
    /// No loop progress for this long exits 75.
    pub stall: Duration,
    /// Between claims that brought nothing, and between `want: 0` claims.
    pub idle_claim: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            tick: Duration::from_secs(3),
            heartbeat: Duration::from_secs(300),
            lease: Duration::from_secs(30 * 60),
            grace: Duration::from_secs(5 * 60),
            stall: Duration::from_secs(15 * 60),
            idle_claim: Duration::from_secs(30),
        }
    }
}

pub struct Options {
    pub api: String,
    pub pool: String,
    pub worker_token: String,
    pub work_root: PathBuf,
    pub capacity_file: PathBuf,
    pub checkout: Option<PathBuf>,
    pub ready: String,
    pub timing: Timing,
    pub disk_floor_gb: Option<u64>,
    pub net: Net,
}

/// What the dispatcher needs for its tasks' networks and sidecars (#336).
#[derive(Debug, Clone)]
pub struct Net {
    /// The worker image by digest (`OMARCHY_WORKER_IMAGE`): the sidecars run it.
    pub worker_image: String,
    /// `OMARCHY_TASK_SUBNETS`.
    pub subnets: spec::Subnets,
    /// The host's own addresses (`OMARCHY_HOST_ADDRESSES`): the egress refuses them too.
    pub deny: Vec<String>,
    /// `OMARCHY_SECRETS_DIR` on the host: its `agent.env` is mounted into agent sidecars, never read here.
    pub secrets_dir: Option<PathBuf>,
    pub caps: budget::Caps,
    /// How the engine keeps a task network's gateway off the host: asked of the engine at start.
    pub gateway: spec::Gateway,
}

impl Default for Net {
    fn default() -> Self {
        Self {
            worker_image: String::new(),
            subnets: spec::Subnets::parse("10.231.0.0/16").expect("the default range"),
            deny: Vec::new(),
            secrets_dir: None,
            caps: budget::Caps::default(),
            gateway: spec::Gateway::Isolated,
        }
    }
}

impl Net {
    fn env_file(&self) -> Option<PathBuf> {
        self.secrets_dir.as_ref().map(|d| d.join("agent.env"))
    }
}

/// What the loop reads of the host besides the engine and the pool: the clock, the work root's free disk, the free memory.
pub trait Probes: Send {
    fn now(&self) -> u64;
    fn work_free_gb(&self) -> Option<u64>;
    fn mem_available_gb(&self) -> Option<u64>;
}

struct RealProbes {
    work_root: PathBuf,
}

impl Probes for RealProbes {
    fn now(&self) -> u64 {
        epoch_now()
    }
    fn work_free_gb(&self) -> Option<u64> {
        capacity::free_gb(&self.work_root)
    }
    fn mem_available_gb(&self) -> Option<u64> {
        capacity::mem_available_gb()
    }
}

fn epoch_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// A preparation or a finish, in a thread of its own (the loop never waits on an upload), or done already.
enum Job<T> {
    Running(JoinHandle<T>),
    Done(T),
}

fn poll<T>(slot: &mut Option<Job<T>>) -> Option<T> {
    match slot.take()? {
        Job::Done(v) => Some(v),
        Job::Running(h) if h.is_finished() => h.join().ok(),
        running @ Job::Running(_) => {
            *slot = Some(running);
            None
        }
    }
}

fn busy<T>(slot: Option<&Job<T>>) -> bool {
    matches!(slot, Some(Job::Running(h)) if !h.is_finished())
}

struct Live {
    lease: Lease,
    stop: Arc<AtomicBool>,
    prep: Option<Job<Result<Value, Prep>>>,
    fin: Option<Job<Result<String, Retry>>>,
    retry_at: u64,
    beat_at: u64,
}

impl Live {
    fn new(lease: Lease) -> Self {
        Self {
            lease,
            stop: Arc::new(AtomicBool::new(false)),
            prep: None,
            fin: None,
            retry_at: 0,
            beat_at: 0,
        }
    }
}

/// A task as a host's claim answer carries it (#334): the row, with its lease's generation, units, disk budget and release.
#[derive(Deserialize)]
struct HostTask {
    #[serde(flatten)]
    task: Task,
    #[serde(default)]
    lease_gen: Option<String>,
    /// The lane the pool leased it on (`build_tasks.lane`, #338): `native`, `emulated`, or
    /// none for a kind that carries no lane.
    #[serde(default)]
    lane: Option<String>,
    #[serde(default)]
    units: Option<u32>,
    #[serde(default)]
    disk_gb: Option<u64>,
    #[serde(default)]
    release: Option<String>,
}

/// What `/ready` and `/leases` answer.
#[derive(Default)]
pub struct Snapshot {
    pub ready: bool,
    pub leases: Value,
}

pub struct Dispatcher {
    ctx: Arc<Ctx>,
    engine: Arc<dyn Engine>,
    store: Store,
    probes: Box<dyn Probes>,
    timing: Timing,
    host: String,
    floor_gb: u64,
    capacity_file: PathBuf,
    images: Images,
    leases: BTreeMap<(u64, String), Live>,
    /// Preparations and finishes run in the loop's own thread (the loop's tests).
    inline: bool,
    claim_id: Option<String>,
    next_claim: u64,
    disk_low: bool,
    /// A build refused at start for its budget: no build claimed until this much is free on both
    /// disks, or until `hold_until` (trials and audits are claimed meanwhile).
    disk_hold: u64,
    hold_until: u64,
    /// The capacity file's `at` when the watcher last killed on the engine's value: once per probe.
    engine_kill_at: Option<String>,
    /// What the memory available let the last claim offer, when it was below its free units (said once per change).
    mem_held: Option<u32>,
    /// This tick's heartbeats and reports wait for the next tick past this.
    pool_until: Instant,
    instance: String,
    started: u64,
    seen: orders::Seen,
    brake: orders::Brake,
    pub terminating: Arc<AtomicBool>,
    /// An order asked the process to exit with this code.
    pub exit: Option<i32>,
    /// Networks and sidecars (#336).
    pub net: Net,
    ledger: budget::Ledger,
    probe: Prober,
}

/// The probe sidecar's standing: its last answer, the probe running now, when the next one is due, the orders waiting for it.
#[derive(Default)]
struct Prober {
    last: Option<probe::Report>,
    job: Option<Job<probe::Report>>,
    /// The /28 and the generation the running probe holds.
    holds: Option<(u32, String)>,
    failures: u32,
    next_at: u64,
    orders: Vec<(String, OrderKind)>,
}

impl Dispatcher {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ctx: Ctx,
        engine: Arc<dyn Engine>,
        probes: Box<dyn Probes>,
        timing: Timing,
        host: String,
        capacity_file: PathBuf,
        images: Images,
        floor_gb: Option<u64>,
        inline: bool,
    ) -> Result<Self> {
        let store = Store::open(&ctx.work_root).context("the lease files' directory")?;
        let started = probes.now();
        let ctx_work_root = ctx.work_root.clone();
        Ok(Self {
            floor_gb: floor_gb.unwrap_or(ctx.constants.floor_gb),
            ctx: Arc::new(ctx),
            engine,
            store,
            probes,
            timing,
            host,
            capacity_file,
            images,
            leases: BTreeMap::new(),
            inline,
            claim_id: None,
            next_claim: 0,
            disk_low: false,
            disk_hold: 0,
            hold_until: 0,
            engine_kill_at: None,
            mem_held: None,
            pool_until: Instant::now(),
            instance: orders::new_instance(),
            started,
            seen: orders::Seen::default(),
            brake: orders::Brake::default(),
            terminating: Arc::new(AtomicBool::new(false)),
            exit: None,
            net: Net::default(),
            ledger: budget::Ledger::new(&ctx_work_root),
            probe: Prober::default(),
        })
    }

    fn pool(&self) -> &dyn Pool {
        &*self.ctx.pool
    }

    fn save(&self, l: &Lease) {
        if let Err(e) = self.store.save(l) {
            say(format!(
                "task {}: its lease file could not be written: {e}",
                l.task.id
            ));
        }
    }

    /// What `/leases` shows: no token, ever.
    pub fn snapshot(&self) -> Value {
        Value::Array(
            self.leases
                .values()
                .map(|v| {
                    let l = &v.lease;
                    json!({ "task": l.task.id, "gen": l.gen, "kind": l.task.kind, "name": l.task.name, "arch": l.task.arch,
                        "lane": l.lane, "units": l.units, "release": l.release, "phase": l.phase, "ending": l.ending,
                        "last_beat": l.last_beat, "started_at": l.started_at })
                })
                .collect(),
        )
    }

    pub fn holds(&self) -> Vec<(u64, String)> {
        self.leases.keys().cloned().collect()
    }

    // ---------- re-adoption (§9.8) ----------

    /// Re-adopts what a previous dispatcher left; `/ready` answers only after it.
    pub fn readopt(&mut self) -> Result<()> {
        let found = self.store.load().context("reading the lease files")?;
        for p in &found.unreadable {
            say(format!("readopt-failed: {} does not read; its container goes, and the pool requeues the lease", p.display()));
            if let Some((id, gen)) = Store::named(p) {
                self.engine.remove_name(&spec::container_name(id, &gen));
            }
            let _ = std::fs::remove_file(p);
        }
        let held: Vec<(u64, String)> = found.leases.iter().map(Lease::key).collect();
        self.sweep(&held).map_err(|e| anyhow!(e))?;
        let now = self.probes.now();
        for lease in found.leases {
            let name = spec::container_name(lease.task.id, &lease.gen);
            let mut live = Live::new(lease);
            if live.lease.ending.is_none() {
                let state = self
                    .engine
                    .inspect(&name)
                    .map_err(|e| anyhow!("reading {name}: {e}"))?;
                match state {
                    Some(s) if s.running() => {
                        say(format!("task {}: adopted, its container runs on", live.lease.task.id));
                        if live.lease.phase != Phase::Running {
                            live.lease.phase = Phase::Running;
                            live.lease.started_at.get_or_insert(now);
                            self.save(&live.lease);
                        }
                    }
                    Some(s) if s.exited() => {
                        say(format!("task {}: its container ended while no dispatcher ran; completing it from what it left", live.lease.task.id));
                        live.lease.phase = Phase::Finishing;
                        self.save(&live.lease);
                    }
                    Some(s) => self.begin_ending(&mut live, Ending::Lost(format!("its container was {} when the dispatcher came back", s.status))),
                    None if live.lease.phase == Phase::Preparing => {
                        say(format!("task {}: prepared again, the dispatcher restarted before its container started", live.lease.task.id));
                    }
                    None => self.begin_ending(
                        &mut live,
                        Ending::Lost("its container is gone: the engine lost it (a reboot or an engine restart)".into()),
                    ),
                }
            }
            self.leases.insert(live.lease.key(), live);
        }
        Ok(())
    }

    /// Orphans of this host — task containers, their sidecars, a probe's, their networks — that no
    /// lease (`held`) owns go; never anything another host or another compose project labelled (the
    /// legacy set has none of these labels). At re-adoption, and before every /28 is chosen: a
    /// teardown that failed once (an engine call past its deadline) leaves a network on its /28,
    /// which the next `network create` there would overlap.
    fn sweep(&self, held: &[(u64, String)]) -> Result<(), String> {
        let names = self
            .engine
            .list(&self.host)
            .map_err(|e| format!("listing this host's task containers: {e}"))?;
        for name in &names {
            if spec::owner_of_name(name).is_some_and(|k| !held.contains(&k)) {
                say(format!(
                    "{name}: a container of this host without a lease file; removed"
                ));
                self.engine.remove_name(name);
            }
        }
        let networks = self
            .engine
            .networks(&self.host)
            .map_err(|e| format!("listing this host's task networks: {e}"))?;
        for name in &networks {
            if spec::owner_of_name(name).is_some_and(|k| !held.contains(&k)) {
                say(format!(
                    "{name}: a task network of this host without a lease file; removed"
                ));
                self.engine.remove_network(name);
            }
        }
        Ok(())
    }

    // ---------- the loop ----------

    pub fn tick(&mut self) {
        let now = self.probes.now();
        // A pool that does not answer costs each call about two minutes with its retries: N leases'
        // heartbeats in a row would outlast the loop watchdog, so a tick stops calling it here.
        self.pool_until = Instant::now() + self.timing.stall / 3;
        let keys: Vec<(u64, String)> = self.leases.keys().cloned().collect();
        for key in keys {
            // SIGTERM: no pool call more this tick (the lease files are current); the exit follows it.
            if self.terminating.load(Ordering::SeqCst) {
                self.pool_until = Instant::now();
            }
            if let Some(live) = self.leases.remove(&key) {
                if let Some(live) = self.step(live, now) {
                    self.leases.insert(key, live);
                }
            }
        }
        self.watch_disk(now);
        if !self.terminating.load(Ordering::SeqCst) {
            self.step_probe(now);
            self.claim(now);
        }
    }

    // ---------- the probe sidecar (§9.5) ----------

    /// Starts the next probe when one is due, and takes a finished probe's answer (answering the orders that waited for it).
    fn step_probe(&mut self, now: u64) {
        if self.probe.job.is_none() && now >= self.probe.next_at {
            self.spawn_probe(now);
        }
        let Some(r) = poll(&mut self.probe.job) else {
            return;
        };
        self.probe.holds = None;
        if r.ran {
            // A probe that ran made (at most) one model call: the day's budget counts it.
            self.ledger.add(now, 1);
        }
        self.probe.failures = if r.ok { 0 } else { self.probe.failures + 1 };
        self.probe.next_at = probe::next_after(now, self.probe.failures);
        let changed = self
            .probe
            .last
            .as_ref()
            .is_none_or(|l| l.ok != r.ok || l.error != r.error);
        if changed {
            say(format!("probe: {}", r.detail()));
        }
        for (id, kind) in std::mem::take(&mut self.probe.orders) {
            let (outcome, code) = match (&kind, r.ok, r.ran) {
                (OrderKind::RestartAgent, true, _) => ("done", "restarted"),
                (OrderKind::RestartAgent, false, _) => ("failed", "not-answering"),
                (_, _, true) => ("done", "probed"),
                (_, _, false) => ("failed", "probe-failed"),
            };
            self.answer_order(&id, outcome, code, &r.detail());
        }
        self.probe.last = Some(r);
    }

    /// A probe on a /28 of its own, in a thread (inline in the loop's tests).
    fn spawn_probe(&mut self, now: u64) {
        let Some(env_file) = self.net.env_file() else {
            return;
        };
        let Some(slot) = self.free_slot() else {
            self.probe.next_at = now + probe::EVERY;
            return;
        };
        let gen = format!("g_{}", &orders::new_instance()[..16]);
        self.probe.holds = Some((slot, gen.clone()));
        let (engine, host, net) = (
            Arc::clone(&self.engine),
            self.host.clone(),
            self.net.clone(),
        );
        let work = move || {
            probe::ask(
                &*engine,
                &spec::Probe {
                    gen: &gen,
                    host: &host,
                    worker_image: &net.worker_image,
                    subnets: net.subnets,
                    slot,
                    gateway: net.gateway,
                    deny: &net.deny,
                    env_file: &env_file,
                },
                || iso(epoch_now()),
            )
        };
        self.probe.job = Some(if self.inline {
            Job::Done(work())
        } else {
            Job::Running(std::thread::spawn(work))
        });
    }

    /// The claim's `agent`: the probe's last answer; on a host with no agent key, that it has none.
    fn agent_field(&self) -> Option<Value> {
        if self.net.secrets_dir.is_none() {
            return Some(
                json!({ "probe": "error", "error": "no agent key on this host (OMARCHY_SECRETS_DIR is not set)" }),
            );
        }
        self.probe.last.as_ref().map(probe::Report::claim)
    }

    fn answer_order(&self, id: &str, outcome: &str, code: &str, detail: &str) {
        let body = json!({ "instance": self.instance, "outcome": outcome, "code": code, "detail": detail });
        if let Err(e) = self.pool().answer(id, &body) {
            say(format!(
                "order {id}: the answer did not reach the pool ({}); it closes the order by what it sees",
                clean_line(&e.to_string())
            ));
        }
    }

    fn begin_ending(&self, live: &mut Live, end: Ending) {
        let l = &mut live.lease;
        say(format!(
            "task {}: {}",
            l.task.id,
            match &end {
                Ending::Stopped(state) => format!("the pool took it back ({state}); killing its containers"),
                Ending::Expired => "its lease expired here (no heartbeat accepted for the lease and its grace); killing its containers, reporting nothing".into(),
                Ending::Lost(why) => format!("lost: {why}"),
            }
        ));
        l.ending = Some(end);
        self.save(l);
        live.stop.store(true, Ordering::SeqCst);
        self.engine.remove_lease(l.task.id, &l.gen);
    }

    /// The end of a lease the dispatcher ends itself, once its threads are done: the report its ending calls for, then the cleanup.
    fn end(&mut self, live: &Live) {
        let l = &live.lease;
        let body = match l.ending.as_ref() {
            Some(Ending::Stopped(state)) => Some(
                json!({ "error": format!("task {} was stopped by the pool ({state}); stopped its containers", l.task.id), "final": false }),
            ),
            Some(Ending::Lost(why)) => Some(json!({ "error": why, "lost": true, "final": false })),
            Some(Ending::Expired) | None => None,
        };
        if let Some(body) = body {
            if let Err(e) = self.pool().fail(l.task.id, &l.token, &body) {
                say(format!(
                    "task {}: its report did not reach the pool ({}); the claims stop listing it",
                    l.task.id,
                    clean_line(&e.to_string())
                ));
            }
        }
        self.cleanup(l);
    }

    fn cleanup(&mut self, l: &Lease) {
        self.engine.remove_lease(l.task.id, &l.gen);
        // Its agent sidecar's calls, from the file the task container never mounted, into the day's.
        if let Some(cap) = l.agent_calls {
            self.ledger
                .add(self.probes.now(), budget::used(&self.ctx.task_dir(l), cap));
        }
        let _ = std::fs::remove_dir_all(self.ctx.task_dir(l));
        self.store.remove(l.task.id, &l.gen);
        self.prune_releases(l);
    }

    /// `work/releases/<vX>/` goes once no lease uses it (§9.7); this release's stays.
    fn prune_releases(&self, ended: &Lease) {
        if self.ctx.checkout.is_some() || ended.release == pkg_manifest::BUILD_VERSION {
            return;
        }
        if self
            .leases
            .values()
            .any(|v| v.lease.release == ended.release)
        {
            return;
        }
        if spec::name_ok(&ended.release) {
            let _ =
                std::fs::remove_dir_all(self.ctx.work_root.join("releases").join(&ended.release));
        }
    }

    fn spawn_prep(&self, live: &mut Live) {
        let (ctx, lease, stop) = (
            Arc::clone(&self.ctx),
            live.lease.clone(),
            Arc::clone(&live.stop),
        );
        let work = move || kinds::prepare(&ctx, &lease, &stop);
        live.prep = Some(if self.inline {
            Job::Done(work())
        } else {
            Job::Running(std::thread::spawn(work))
        });
    }

    fn spawn_fin(&self, live: &mut Live, state: engine::State, now: u64) {
        let (ctx, lease) = (Arc::clone(&self.ctx), live.lease.clone());
        let work = move || kinds::finish(&ctx, &lease, &state, now);
        live.fin = Some(if self.inline {
            Job::Done(work())
        } else {
            Job::Running(std::thread::spawn(work))
        });
    }

    #[allow(clippy::too_many_lines)]
    fn step(&mut self, mut live: Live, now: u64) -> Option<Live> {
        let name = spec::container_name(live.lease.task.id, &live.lease.gen);
        if live.lease.ending.is_some() {
            if busy(live.prep.as_ref()) || busy(live.fin.as_ref()) {
                return Some(live);
            }
            // The report and the cleanup only once the engine says its container is gone: a kill
            // that did not take keeps the lease, and its units, and is tried again.
            match self.engine.inspect(&name) {
                Ok(None) if Instant::now() >= self.pool_until => return Some(live),
                Ok(None) => {
                    self.end(&live);
                    return None;
                }
                Ok(Some(s)) => say(format!(
                    "task {}: its container is still {} after the kill; killing it again",
                    live.lease.task.id, s.status
                )),
                Err(e) => say(format!(
                    "task {}: the engine did not say its container is gone ({}); its lease stays until it does",
                    live.lease.task.id,
                    clean_line(&e)
                )),
            }
            self.engine
                .remove_lease(live.lease.task.id, &live.lease.gen);
            self.engine.remove_name(&name);
            return Some(live);
        }
        // The heartbeat: the lease and its job token move together.
        if now >= live.beat_at + self.timing.heartbeat.as_secs() && Instant::now() < self.pool_until
        {
            live.beat_at = now;
            match self.pool().heartbeat(live.lease.task.id, &live.lease.token) {
                Beat::Accepted(fresh) => {
                    live.lease.last_beat = now;
                    if let Some(t) = fresh {
                        live.lease.token = t;
                    }
                    self.save(&live.lease);
                }
                Beat::Stop(state) => {
                    self.begin_ending(&mut live, Ending::Stopped(state));
                    return Some(live);
                }
                Beat::Nothing => {}
            }
        }
        // The per-lease watchdog: past its lease and the grace, the pool has requeued it; only its own containers go.
        if now > live.lease.last_beat + (self.timing.lease + self.timing.grace).as_secs() {
            self.begin_ending(&mut live, Ending::Expired);
            return Some(live);
        }
        match live.lease.phase {
            Phase::Preparing => {
                if live.prep.is_none() && now >= live.retry_at {
                    self.spawn_prep(&mut live);
                }
                let Some(prepared) = poll(&mut live.prep) else {
                    return Some(live);
                };
                match prepared {
                    Ok(notes) => {
                        live.lease.notes = notes;
                        return Some(self.start(live, now));
                    }
                    Err(Prep::Retry(why)) => {
                        say(format!(
                            "task {}: preparing it again in {RETRY_AFTER} s: {why}",
                            live.lease.task.id
                        ));
                        live.retry_at = now + RETRY_AFTER;
                    }
                    Err(Prep::Fail(body)) => {
                        let error = clean_line(
                            body.get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("failed"),
                        );
                        say(format!(
                            "task {}: failed before its container — {error}",
                            live.lease.task.id
                        ));
                        let _ = self
                            .pool()
                            .fail(live.lease.task.id, &live.lease.token, &body);
                        self.cleanup(&live.lease);
                        return None;
                    }
                }
            }
            Phase::Running => match self.engine.inspect(&name) {
                Err(e) => say(format!(
                    "task {}: {}; asking again",
                    live.lease.task.id,
                    clean_line(&e)
                )),
                Ok(Some(s)) if s.running() => {}
                Ok(Some(s)) if s.exited() => {
                    live.lease.phase = Phase::Finishing;
                    self.save(&live.lease);
                    self.spawn_fin(&mut live, s, now);
                    return self.after_fin(live, now);
                }
                Ok(Some(s))
                    if matches!(s.status.as_str(), "created" | "configured" | "initialized")
                        && now < live.lease.started_at.unwrap_or(now) + 60 => {}
                Ok(Some(s)) => self.begin_ending(
                    &mut live,
                    Ending::Lost(format!("its container is {}", s.status)),
                ),
                Ok(None) => self.begin_ending(
                    &mut live,
                    Ending::Lost("its container is gone: the engine lost it".into()),
                ),
            },
            Phase::Finishing => {
                if live.fin.is_none() && now >= live.retry_at {
                    match self.engine.inspect(&name) {
                        Err(e) => {
                            say(format!(
                                "task {}: {}; asking again",
                                live.lease.task.id,
                                clean_line(&e)
                            ));
                            live.retry_at = now + 1;
                        }
                        Ok(Some(s)) if s.exited() => self.spawn_fin(&mut live, s, now),
                        Ok(Some(s)) => self.begin_ending(
                            &mut live,
                            Ending::Lost(format!("its container is {} after it ended", s.status)),
                        ),
                        Ok(None) => self.begin_ending(
                            &mut live,
                            Ending::Lost(
                                "its container is gone before its outputs were collected".into(),
                            ),
                        ),
                    }
                }
                return self.after_fin(live, now);
            }
        }
        Some(live)
    }

    fn after_fin(&mut self, mut live: Live, now: u64) -> Option<Live> {
        match poll(&mut live.fin) {
            None => Some(live),
            Some(Ok(said)) => {
                say(format!("task {}: {said}", live.lease.task.id));
                self.cleanup(&live.lease);
                None
            }
            Some(Err(Retry(why))) => {
                say(format!(
                    "task {}: finishing it again in {RETRY_AFTER} s: {why}",
                    live.lease.task.id
                ));
                live.retry_at = now + RETRY_AFTER;
                Some(live)
            }
        }
    }

    /// Starts a prepared lease's network, sidecars and container: a build only with its disk budget plus the floor free (D53).
    #[allow(clippy::too_many_lines)] // the checks before the engine runs, then the plan, in order
    fn start(&mut self, mut live: Live, now: u64) -> Live {
        let Some(kind) = kinds::kind_of(&live.lease) else {
            self.begin_ending(&mut live, Ending::Lost("no container kind".into()));
            return live;
        };
        if live.lease.task.kind == "build" {
            let need = live.lease.disk_gb + self.floor_gb;
            let work = self.probes.work_free_gb();
            let engine = capacity::read(&self.capacity_file).map(|c| c.engine_free_gb);
            if work.is_some_and(|w| w < need) || engine.is_some_and(|e| e < need) {
                // No build claimed until this budget fits again, or for DISK_HOLD at most: the pool
                // would hand the same build straight back. Seam (#334): the pool selects a host's
                // builds by its claim's disk_free_gb against disk_gb plus the floor; this hold is then
                // only a backstop.
                self.disk_hold = self.disk_hold.max(need);
                self.hold_until = now + DISK_HOLD;
                let why = format!(
                    "not started: {} GB free on the work root and {} on the engine's, below its budget of {} GB plus the floor of {}",
                    work.map_or("?".into(), |w| w.to_string()),
                    engine.map_or("?".into(), |e| e.to_string()),
                    live.lease.disk_gb,
                    self.floor_gb
                );
                self.begin_ending(&mut live, Ending::Lost(why));
                return live;
            }
        }
        let (cpus, mem_gb) = self.ctx.constants.share(live.lease.units);
        // The lane's build image: the task's architecture on its lane, the host's own for an audit.
        let image = self.images.of(live.lease.arch()).to_owned();
        let tdir = self.ctx.task_dir(&live.lease);
        let rdir = self.ctx.release_dir(&live.lease.release);
        let lost = |this: &Self, live: &mut Live, why: String| {
            this.begin_ending(
                live,
                Ending::Lost(format!("failed before docker ran — {why}")),
            );
        };
        // The package's signed network exception, from the release's own factory/sizing.
        let direct = match sizing::direct(&rdir, &live.lease.task.name) {
            Ok(d) => d,
            Err(why) => {
                lost(self, &mut live, why);
                return live;
            }
        };
        let Some(slot) = self.free_slot() else {
            let why = format!(
                "every task network of {} is in use",
                self.net.subnets.cidr()
            );
            lost(self, &mut live, why);
            return live;
        };
        // A model kind's sidecar may spend what the day has left once the running sidecars' caps are set aside (D45).
        let agent_calls = if kind.model() {
            let grant = budget::grant(&self.net.caps, self.ledger.spent(now), self.reserved());
            if grant == 0 {
                let why = format!(
                    "this host's agent budget for today ({} calls) is spent; the claims offer no agent slot until tomorrow (UTC)",
                    self.net.caps.calls_per_day
                );
                lost(self, &mut live, why);
                return live;
            }
            Some(grant)
        } else {
            None
        };
        let env_file = self.net.env_file();
        let plan = spec::plan(&spec::Spec {
            task: live.lease.task.id,
            gen: &live.lease.gen,
            host: &self.host,
            release: &live.lease.release,
            arch: live.lease.arch(),
            emulated: live.lease.emulated(),
            name: &live.lease.task.name,
            kind,
            cpus,
            mem_gb,
            image: &image,
            task_dir: &tdir,
            release_dir: &rdir,
            worker_image: &self.net.worker_image,
            subnets: self.net.subnets,
            slot,
            direct,
            gateway: self.net.gateway,
            deny: &self.net.deny,
            agent: env_file.as_deref().map(|f| spec::Agent {
                env_file: f,
                calls: agent_calls.unwrap_or(1),
                tokens: self.net.caps.tokens_per_task,
                wall_s: self.net.caps.minutes_per_task * 60,
            }),
        });
        let plan = match plan {
            Ok(p) => p,
            Err(why) => {
                // The task's own values (name, arch, generation, release) passed the grammar in
                // take(): what fails here is this host's (its images, its id, its paths, its keys), never the task's.
                lost(self, &mut live, why);
                return live;
            }
        };
        live.lease.phase = Phase::Running;
        live.lease.started_at = Some(now);
        live.lease.net_slot = Some(slot);
        live.lease.agent_calls = agent_calls;
        self.save(&live.lease);
        // What an earlier start of this lease left (a dispatcher that restarted half-way) goes first.
        self.engine
            .remove_lease(live.lease.task.id, &live.lease.gen);
        let bridge = if direct {
            Ok(())
        } else {
            engine::ensure_bridge(&*self.engine, &self.host)
        };
        let agent_start = plan
            .iter()
            .position(|c| c[0] == "start" && c.get(1).is_some_and(|n| n.ends_with("-agent")));
        let failed = bridge
            .map_err(|e| (0, format!("the egress bridge: {e}")))
            .and_then(|()| {
                plan.iter().enumerate().try_for_each(|(i, c)| {
                    self.engine
                        .run(c)
                        .map_err(|e| (i, format!("{} did not start: {}", what(c), clean_line(&e))))
                })
            });
        if let Err((i, why)) = failed {
            // A sidecar that never started spent nothing of the day.
            if agent_start.is_none_or(|a| i <= a) {
                live.lease.agent_calls = None;
            }
            // A `run` that did not answer may still have made the container: the ending removes it, its sidecars and network.
            self.begin_ending(&mut live, Ending::Lost(why));
            return live;
        }
        say(format!(
            "task {}: {} {} started ({cpus} CPUs, {mem_gb} GB, {} network {}{})",
            live.lease.task.id,
            live.lease.task.kind,
            live.lease.task.name,
            if direct { "bridge" } else { "internal" },
            self.net
                .subnets
                .slot(slot)
                .map(spec::Slot::cidr)
                .unwrap_or_default(),
            agent_calls.map_or(String::new(), |c| format!(
                ", an agent sidecar of {c} calls"
            ))
        ));
        live
    }

    /// The lowest /28 no lease and no probe holds, once what no lease or probe owns is swept.
    fn free_slot(&self) -> Option<u32> {
        let held: Vec<(u64, String)> = self
            .leases
            .keys()
            .cloned()
            .chain(self.probe.holds.as_ref().map(|(_, g)| (0, g.clone())))
            .collect();
        if let Err(e) = self.sweep(&held) {
            say(format!("the sweep before a task network: {e}"));
        }
        let used: Vec<u32> = self
            .leases
            .values()
            .filter_map(|v| v.lease.net_slot)
            .chain(self.probe.holds.as_ref().map(|(s, _)| *s))
            .collect();
        (0..self.net.subnets.slots()).find(|i| !used.contains(i))
    }

    /// The calls the running agent sidecars may still make: set aside from the day's budget.
    fn reserved(&self) -> u32 {
        self.leases
            .values()
            .filter_map(|v| v.lease.agent_calls)
            .sum()
    }

    /// Whether the day's budget leaves a new agent sidecar anything.
    fn agent_day_left(&self, now: u64) -> bool {
        budget::grant(&self.net.caps, self.ledger.spent(now), self.reserved()) > 0
    }

    /// The disk watcher (D53): free space below the floor, on the work root (measured now) or the
    /// engine's (the agent's last probe, acted on once per probe), kills the youngest running
    /// build, `lost`, one at a time, and stops the claims until it is back. A build refused at
    /// start keeps builds out of the claims until its budget plus the floor is free on both, or
    /// for [`DISK_HOLD`] at most.
    fn watch_disk(&mut self, now: u64) {
        let work = self.probes.work_free_gb();
        let cap = capacity::read(&self.capacity_file);
        let engine = cap.as_ref().map(|c| c.engine_free_gb);
        let short = |v: Option<u64>, need: u64| v.is_some_and(|v| v < need);
        let show = |v: Option<u64>| v.map_or("?".into(), |v| v.to_string());
        if self.disk_hold > 0
            && (now >= self.hold_until
                || (!short(work, self.disk_hold) && !short(engine, self.disk_hold)))
        {
            say(format!(
                "{} GB free on the work root and {} on the engine's, a hold of {} GB: claiming builds again",
                show(work),
                show(engine),
                self.disk_hold
            ));
            self.disk_hold = 0;
        }
        let need = self.floor_gb;
        if !short(work, need) && !short(engine, need) {
            if self.disk_low {
                say(format!(
                    "{} GB free on the work root and {} on the engine's again: claiming again",
                    show(work),
                    show(engine)
                ));
            }
            self.disk_low = false;
            return;
        }
        if !self.disk_low {
            say(format!("{} GB free on the work root and {} on the engine's, below {need} GB: no claim until it is back", show(work), show(engine)));
        }
        self.disk_low = true;
        let engine_low = short(engine, self.floor_gb)
            && cap.as_ref().map(|c| &c.at) != self.engine_kill_at.as_ref();
        if !short(work, self.floor_gb) && !engine_low {
            return;
        }
        if self
            .leases
            .values()
            .any(|v| matches!(v.lease.ending, Some(Ending::Lost(_))))
        {
            return;
        }
        let youngest = self
            .leases
            .iter()
            .filter(|(_, v)| {
                v.lease.task.kind == "build"
                    && v.lease.phase == Phase::Running
                    && v.lease.ending.is_none()
            })
            .max_by_key(|(_, v)| v.lease.started_at.unwrap_or(0))
            .map(|(k, _)| k.clone());
        if let Some(key) = youngest {
            if let Some(mut live) = self.leases.remove(&key) {
                if engine_low {
                    self.engine_kill_at = cap.map(|c| c.at);
                }
                let why = format!("the disk watcher killed it: {} GB free on the work root and {} on the engine's, below the floor of {} GB", show(work), show(engine), self.floor_gb);
                self.begin_ending(&mut live, Ending::Lost(why));
                self.leases.insert(key, live);
            }
        }
    }

    // ---------- the claim (§8.1) ----------

    #[allow(clippy::too_many_lines)] // the claim's body, then each answer the pool may give
    fn claim(&mut self, now: u64) {
        if now < self.next_claim {
            return;
        }
        let cap = capacity::read(&self.capacity_file);
        let used: u32 = self.leases.values().map(|v| v.lease.units).sum();
        // What a task may take now (§7.6, #337): the units beside its leases and the job unit — none when
        // fewer units than leases remain (a cap lowered: nothing running is killed, it claims nothing until
        // they fit) — and, when MemAvailable is below the largest task it could receive, only what the memory
        // still holds: another workload on the machine leaves it what still fits, or nothing this round.
        let free = cap.as_ref().map_or(0, |c| {
            c.units.saturating_sub(c.job_reserved).saturating_sub(used)
        });
        // What the leases just started still owe the memory: their whole share, from their claim until
        // MEM_RAMP after their container started — a burst of claims never offers the same memory twice.
        let promised: u64 = self
            .leases
            .values()
            .filter(|v| {
                v.lease.ending.is_none()
                    && match v.lease.phase {
                        Phase::Preparing => true,
                        Phase::Running => now < v.lease.started_at.unwrap_or(now) + MEM_RAMP,
                        Phase::Finishing => false,
                    }
            })
            .map(|v| u64::from(self.ctx.constants.share(v.lease.units).1))
            .sum();
        let available = self.probes.mem_available_gb();
        let mem = available.map(|m| m.saturating_sub(promised));
        let offer = self.ctx.constants.offer(free, mem);
        if offer < free {
            if self.mem_held != Some(offer) {
                let owed = if promised > 0 {
                    format!(" ({promised} GB of it promised to leases just started)")
                } else {
                    String::new()
                };
                say(format!(
                    "{} GB available in memory{owed}: this claim offers {offer} of {free} free unit(s)",
                    available.unwrap_or_default()
                ));
            }
            self.mem_held = Some(offer);
        } else {
            self.mem_held = None;
        }
        let want = cap.as_ref().is_some_and(|c| {
            !c.below_minimum
                && offer > 0
                && c.engine_free_gb >= self.floor_gb
                && spec::digest_ok(self.images.of(&c.arch))
        }) && !self.disk_low;
        // What a task may take: the units this claim offered, none when it said `want: 0`.
        let room = if want { offer } else { 0 };
        let claim_id = self
            .claim_id
            .get_or_insert_with(|| format!("c_{}", &orders::new_instance()[..24]))
            .clone();
        let arch = cap.as_ref().map_or_else(native_arch, |c| c.arch.clone());
        let leases: Vec<Value> = self
            .leases
            .values()
            .map(|v| json!({ "task": v.lease.task.id, "gen": v.lease.gen }))
            .collect();
        let mut body = json!({
            "arch": arch, "version": pkg_manifest::BUILD_VERSION, "hostname": crate::work::hostname(),
            "kinds": if self.disk_hold > 0 { &KINDS_HELD[..] } else { &KINDS[..] }, "labels": { "role": "dispatcher" }, "log": crate::work::log_chunk(),
            "orders": TAKES, "instance": self.instance, "started_at": iso(self.started),
            "claim_id": claim_id, "want": u8::from(want), "leases": leases,
        });
        // What the memory holds back bounds this claim only (#337): the pool hands no task above `offer`,
        // and still counts the host by its units — its builds, the largest size it runs, its owner's share —
        // so a large build waits for memory rather than be leased smaller.
        if want && offer < free {
            body["offer"] = json!(offer);
        }
        if let Some(c) = &cap {
            body["capacity"] = c.claim.clone();
            // An emulated lane whose build image this host was not given by digest is not offered:
            // its tasks would only be given back (#338).
            if let Some(lanes) = body["capacity"]["lanes"].as_array_mut() {
                lanes.retain(|l| {
                    l["mode"] != "emulated"
                        || l["arch"].as_str().is_some_and(|a| {
                            spec::platform_of(a).is_some() && spec::digest_ok(self.images.of(a))
                        })
                });
            }
            // The work root as measured now, when it has less than the agent's last probe said.
            if let (Some(w), Some(f)) = (
                self.probes.work_free_gb(),
                c.claim["disk_free_gb"]["work"].as_u64(),
            ) {
                body["capacity"]["disk_free_gb"]["work"] = json!(w.min(f));
            }
            // The day's agent budget spent: no model work until tomorrow (the pool counts agent slots like units).
            if !self.agent_day_left(now) {
                body["capacity"]["agent_slots"] = json!(0);
            }
        }
        if let Some(agent) = self.agent_field() {
            body["agent"] = agent;
        }
        let idle = self.timing.idle_claim.as_secs();
        match self.pool().claim(&body) {
            Ok(None) => {
                self.claim_id = None;
                self.brake.after(false, self.timing.idle_claim);
                self.next_claim = now + idle;
            }
            Ok(Some(v)) => {
                self.claim_id = None;
                let staging_full = v.get("staging").is_some_and(|s| {
                    match (
                        s.get("bytes").and_then(Value::as_u64),
                        s.get("quota_bytes").and_then(Value::as_u64),
                    ) {
                        (Some(b), Some(q)) => b >= q,
                        _ => false,
                    }
                });
                match orders::read_claim::<HostTask>(&v) {
                    ClaimAnswer::Task(t, token) => {
                        self.brake.after(false, self.timing.idle_claim);
                        self.take(t, token, staging_full, room, cap.as_ref(), now);
                        self.next_claim = now;
                    }
                    ClaimAnswer::Orders(list) => {
                        for o in &list {
                            self.obey(o, now);
                        }
                        self.next_claim =
                            now + self.brake.after(true, self.timing.idle_claim).as_secs();
                    }
                    ClaimAnswer::BadTask { id, token, why } => {
                        say(format!(
                            "task {id}: this dispatcher could not read it: {why}; reported failed"
                        ));
                        let _ = self.pool().fail(id, &token, &json!({ "error": format!("dispatcher {} could not read this task: {why}", pkg_manifest::BUILD_VERSION), "final": false }));
                        self.next_claim = now + idle;
                    }
                    ClaimAnswer::Unreadable(what) => {
                        say(format!(
                            "claim answer not understood ({what}); waiting {idle} s"
                        ));
                        self.next_claim = now + idle;
                    }
                }
            }
            Err(RepoError::Api { status: 426, body }) => {
                self.claim_id = None;
                let v: Value = serde_json::from_str(&body).unwrap_or_default();
                say(format!(
                    "update required: {}",
                    clean_line(v["error"].as_str().unwrap_or(&body))
                ));
                for o in &orders::orders_in(&v).unwrap_or_default() {
                    self.obey(o, now);
                }
                self.next_claim = now + 300;
            }
            Err(RepoError::Api { status, body })
                if (400..500).contains(&status) && status != 429 =>
            {
                self.claim_id = None;
                say(format!(
                    "the pool refused the claim ({status}): {}",
                    clean_line(&body)
                ));
                self.next_claim = now + CLAIM_RETRY;
            }
            Err(e) => {
                // A lost answer: the next claim sends the same claim_id, and gets the same lease back (§8.1).
                say(format!(
                    "claim failed: {}; retrying in {CLAIM_RETRY} s",
                    clean_line(&e.to_string())
                ));
                self.next_claim = now + CLAIM_RETRY;
            }
        }
    }

    #[allow(clippy::too_many_lines)] // every refusal of a lease, then the lease
    fn take(
        &mut self,
        t: HostTask,
        token: String,
        staging_full: bool,
        room: u32,
        cap: Option<&capacity::File>,
        now: u64,
    ) {
        let task = t.task;
        let refuse = |this: &Self, why: &str, is_final: bool| {
            say(format!("task {}: refused — {why}", task.id));
            let _ = this
                .pool()
                .fail(task.id, &token, &json!({ "error": why, "final": is_final }));
        };
        let Some(gen) = t.lease_gen.filter(|g| spec::gen_ok(g)) else {
            return refuse(
                self,
                "the pool handed a host a lease without a generation",
                false,
            );
        };
        if self.leases.contains_key(&(task.id, gen.clone())) {
            return;
        }
        // The pool selects; this host still holds its envelope: a task above the units this claim
        // offered (none, with `want: 0`) is given back, never started.
        let units = t.units.unwrap_or(1).max(1);
        if units > room {
            say(format!(
                "task {}: refused — {units} unit(s), and this claim offered {room}",
                task.id
            ));
            let _ = self.pool().fail(task.id, &token, &json!({ "error": format!("this host offered {room} unit(s) and was handed {units}"), "lost": true, "final": false }));
            return;
        }
        if spec::platform_of(&task.arch).is_none() || !spec::name_ok(&task.name) {
            return refuse(
                self,
                &format!(
                    "{:?} for {:?} is outside the grammar of names and lanes",
                    task.name, task.arch
                ),
                true,
            );
        }
        if !KINDS.contains(&task.kind.as_str()) {
            return refuse(
                self,
                &format!(
                    "this dispatcher runs builds, trials and audits in P1, not {}",
                    task.kind
                ),
                false,
            );
        }
        // Its lane (#338, design v2 §7.4): one this host runs now, or it is given back, its
        // attempt with it — never started on a lane the agent has since turned off.
        let lane = match lane_of(&task, t.lane.as_deref(), cap, &self.images) {
            Ok(l) => l,
            Err(why) => {
                say(format!("task {}: refused — {why}", task.id));
                let _ = self.pool().fail(
                    task.id,
                    &token,
                    &json!({ "error": why, "lost": true, "final": false }),
                );
                return;
            }
        };
        let release = t
            .release
            .filter(|r| spec::name_ok(r))
            .unwrap_or_else(|| pkg_manifest::BUILD_VERSION.to_owned());
        say(format!(
            "task {}: {} {} for {}{} (attempt {}/{}), lease {gen}",
            task.id,
            task.kind,
            task.name,
            task.arch,
            if lane.emulated { ", emulated" } else { "" },
            task.attempts,
            task.max_attempts
        ));
        let lease = Lease {
            task,
            gen,
            token,
            units,
            disk_gb: t.disk_gb.unwrap_or(0),
            release,
            staging_full,
            claimed_at: now,
            last_beat: now,
            started_at: None,
            phase: Phase::Preparing,
            ending: None,
            notes: Value::Null,
            net_slot: None,
            agent_calls: None,
            lane: Some(lane),
        };
        self.save(&lease);
        let mut live = Live::new(lease);
        live.beat_at = now;
        self.leases.insert(live.lease.key(), live);
    }

    fn obey(&mut self, o: &Order, now: u64) {
        if !self.seen.first(&o.id) {
            return;
        }
        say(format!(
            "order {}: {} from {} — {}",
            o.id,
            o.kind.name(),
            o.issued_by,
            o.reason
        ));
        let answer = |this: &Self, outcome: &str, code: &str, detail: &str| {
            this.answer_order(&o.id, outcome, code, detail);
        };
        match &o.kind {
            OrderKind::Drain => say(format!(
                "drained by {} — the pool hands this host nothing until it is resumed",
                o.issued_by
            )),
            OrderKind::Restart if now.saturating_sub(self.started) < RESTART_MIN_UPTIME => {
                answer(
                    self,
                    "refused",
                    "too-young",
                    &format!(
                        "started {} s ago: a restart this soon would loop",
                        now.saturating_sub(self.started)
                    ),
                );
            }
            // No long-running agent on a host: a restart of the agent is a fresh probe sidecar, answered when it has spoken.
            OrderKind::RecheckAgent | OrderKind::RestartAgent if self.net.secrets_dir.is_none() => {
                let code = if o.kind == OrderKind::RecheckAgent {
                    "probe-failed"
                } else {
                    "not-answering"
                };
                answer(
                    self,
                    "failed",
                    code,
                    "no agent key on this host (OMARCHY_SECRETS_DIR is not set)",
                );
            }
            OrderKind::RecheckAgent | OrderKind::RestartAgent => {
                self.probe.orders.push((o.id.clone(), o.kind.clone()));
                if self.probe.job.is_none() {
                    self.probe.next_at = now;
                }
            }
            OrderKind::Restart => {
                answer(self, "accepted", "exiting", "exit 75; the restart policy starts the dispatcher again, and it re-adopts every task");
                say(format!(
                    "order {}: restarting — exit 75; every task container runs on",
                    o.id
                ));
                self.exit = Some(EXIT_RESTART);
            }
            other @ OrderKind::Unknown(_) => {
                let code = "unknown-kind";
                answer(
                    self,
                    "refused",
                    code,
                    &format!(
                        "this dispatcher ({}) does not take {}",
                        pkg_manifest::BUILD_VERSION,
                        other.name()
                    ),
                );
            }
        }
    }
}

/// What a spec call makes, for a message: `network omarchy-task-…`, `omarchy-task-…-egress`, the task container.
fn what(c: &[String]) -> String {
    match c.first().map(String::as_str) {
        Some("network") => format!("network {}", c.last().map_or("", String::as_str)),
        Some("start") => c.get(1).cloned().unwrap_or_default(),
        _ => c
            .iter()
            .position(|x| x == "--name")
            .and_then(|i| c.get(i + 1))
            .cloned()
            .unwrap_or_else(|| "the container".into()),
    }
}

/// The lane a leased task runs on (#338, design v2 §7.4, §7.5): a build or a trial runs
/// its own architecture — natively when it is this host's (`lane` `native`, or none from a
/// pool that leased before lanes), emulated when the pool leased it on an emulated lane this
/// host runs now (`run/capacity.json`) with that architecture's build image by digest.
/// Every other kind (an audit reads its build as data) runs on this host's own. Anything
/// else is not this host's to start.
fn lane_of(
    task: &Task,
    lane: Option<&str>,
    cap: Option<&capacity::File>,
    images: &Images,
) -> Result<Lane, String> {
    let native = cap.map_or_else(native_arch, |c| c.arch.clone());
    if !LANE_KINDS.contains(&task.kind.as_str()) {
        return Ok(Lane {
            arch: native,
            emulated: false,
        });
    }
    match lane {
        None | Some("native") if task.arch == native => Ok(Lane {
            arch: native,
            emulated: false,
        }),
        Some("emulated")
            if task.arch != native && cap.is_some_and(|c| c.emulated.contains(&task.arch)) =>
        {
            // The host's image, not the task: given back like any lane it cannot run.
            let image = images.of(&task.arch);
            if !spec::digest_ok(image) {
                return Err(format!(
                    "build image {image:?} of the {} lane is not an image by digest (repository@sha256:…)",
                    task.arch
                ));
            }
            Ok(Lane {
                arch: task.arch.clone(),
                emulated: true,
            })
        }
        other => {
            let word = match other {
                None | Some("native") => "native",
                Some("emulated") => "emulated",
                Some(_) => "such",
            };
            let emulated = cap.map_or_else(
                || "unknown".to_owned(),
                |c| {
                    if c.emulated.is_empty() {
                        "none".to_owned()
                    } else {
                        c.emulated.join(", ")
                    }
                },
            );
            Err(format!(
                "this host runs no {word} lane of {} (its native lane is {native}, its emulated ones {emulated}): handed back",
                task.arch
            ))
        }
    }
}

/// The kinds that run a task's own architecture, on the lane the pool leased (design v2 §7.4).
pub const LANE_KINDS: [&str; 2] = ["build", "trial"];

/// The lanes' build images, as the release renders them into the host set
/// (`OMARCHY_BUILD_IMAGE_AARCH64`, `OMARCHY_BUILD_IMAGE_X86_64`, by digest, #353). No tag
/// fallback here: an image that is not a digest fails the task before `docker` runs.
#[derive(Debug, Clone, Default)]
pub struct Images {
    pub aarch64: String,
    pub x86_64: String,
}

impl Images {
    pub fn from_env() -> Self {
        let var = |v: &str| std::env::var(v).unwrap_or_default().trim().to_owned();
        Self {
            aarch64: var("OMARCHY_BUILD_IMAGE_AARCH64"),
            x86_64: var("OMARCHY_BUILD_IMAGE_X86_64"),
        }
    }

    fn of(&self, arch: &str) -> &str {
        if arch == "aarch64" {
            &self.aarch64
        } else {
            &self.x86_64
        }
    }
}

fn native_arch() -> String {
    match std::env::consts::ARCH {
        "arm64" | "aarch64" => "aarch64".into(),
        other => other.into(),
    }
}

/// Seconds since the epoch as RFC 3339, UTC.
fn iso(secs: u64) -> String {
    crate::work::iso_of(secs)
}

// ---------- the process ----------

/// The registration's id: the pool's word when it answers, kept in `state/host` for a start when it does not.
fn host_id(pool: &dyn Pool, work_root: &Path, term: &AtomicBool) -> Result<String> {
    let file = work_root.join("state").join("host");
    let mut wait = 5;
    loop {
        match pool.whoami() {
            Ok(id) if spec::host_ok(&id) => {
                let _ = std::fs::write(&file, &id);
                return Ok(id);
            }
            Ok(id) => anyhow::bail!("the pool names this registration {id:?}, outside the grammar"),
            Err(RepoError::Api {
                status: 401 | 403,
                body,
            }) => {
                anyhow::bail!(
                    "the pool refused the host's worker token: {}",
                    clean_line(&body)
                )
            }
            Err(e) => {
                if let Some(id) = std::fs::read_to_string(&file)
                    .ok()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| spec::host_ok(s))
                {
                    say(format!(
                        "the pool did not answer ({}); going on as {id}",
                        clean_line(&e.to_string())
                    ));
                    return Ok(id);
                }
                say(format!(
                    "the pool did not answer ({}); asking again in {wait} s",
                    clean_line(&e.to_string())
                ));
            }
        }
        if term.load(Ordering::SeqCst) {
            anyhow::bail!("stopped before the pool answered");
        }
        std::thread::sleep(Duration::from_secs(wait));
        wait = (wait * 2).min(120);
    }
}

/// `/ready` (200 once re-adoption is done, 503 before) and `/leases`, on the loopback address only.
pub fn serve(listener: std::net::TcpListener, snap: Arc<Mutex<Snapshot>>) {
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut c) = conn else { continue };
            let _ = c.set_read_timeout(Some(Duration::from_secs(5)));
            // The request line and headers, whole (a client may send them in pieces), 4 KiB at most.
            let mut buf = Vec::new();
            let mut chunk = [0u8; 512];
            while buf.len() < 4096 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match c.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let req = String::from_utf8_lossy(&buf);
            let path = req
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .unwrap_or("");
            let (code, body) = {
                let s = snap
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                match path {
                    "/ready" if s.ready => ("200 OK", "ready\n".to_owned()),
                    "/ready" => ("503 Service Unavailable", "re-adopting\n".to_owned()),
                    "/leases" => ("200 OK", format!("{}\n", s.leases)),
                    _ => ("404 Not Found", "not found\n".to_owned()),
                }
            };
            let _ = write!(c, "HTTP/1.1 {code}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
}

/// The loop watchdog: no progress for `stall` exits with 75 through `exit`, and touches nothing else (never a task container).
pub fn loop_watchdog(
    progress: Arc<AtomicU64>,
    stall: Duration,
    every: Duration,
    now: impl Fn() -> u64 + Send + 'static,
    exit: impl Fn(i32) + Send + 'static,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(every);
        let last = progress.load(Ordering::SeqCst);
        if now().saturating_sub(last) > stall.as_secs() {
            say(format!("the loop made no progress for {} min: exit 75 — task containers run on, the next dispatcher re-adopts them", stall.as_secs() / 60));
            exit(EXIT_RESTART);
            return;
        }
    });
}

/// `pkg-repo dispatch`.
#[allow(clippy::too_many_lines)] // the start, in its order, then the loop
pub fn run(opts: &Options) -> Result<()> {
    refuse_signing_key(std::env::vars())?;
    refuse_agent_key(std::env::vars())?;
    anyhow::ensure!(
        spec::path_ok(&opts.work_root),
        "the work root {} must be an absolute path of letters, digits and / . _ - + (it is mounted into task containers as such)",
        opts.work_root.display()
    );
    if let Some(c) = &opts.checkout {
        anyhow::ensure!(
            spec::path_ok(c),
            "--checkout {} must be an absolute plain path",
            c.display()
        );
    }
    anyhow::ensure!(
        spec::digest_ok(&opts.net.worker_image),
        "OMARCHY_WORKER_IMAGE {:?} is not an image by digest: every task's egress and agent sidecars run it",
        opts.net.worker_image
    );
    if let Some(d) = &opts.net.secrets_dir {
        anyhow::ensure!(
            spec::path_ok(d),
            "OMARCHY_SECRETS_DIR {} must be an absolute plain path (its agent.env is mounted into agent sidecars)",
            d.display()
        );
    }
    for a in &opts.net.deny {
        a.parse::<crate::egress::Cidr>()
            .map_err(|e| anyhow!("OMARCHY_HOST_ADDRESSES: {e}"))?;
    }
    std::fs::create_dir_all(&opts.work_root)
        .with_context(|| format!("creating {}", opts.work_root.display()))?;
    let engine = engine::Cli::find()
        .ok_or_else(|| anyhow!("no container engine answers (docker, or podman)"))?;
    let gateway = engine.gateway().map_err(|e| anyhow!("{e}"))?;
    if gateway == spec::Gateway::Engine {
        say("podman behind docker's API: a task network's gateway is the host's own address on its bridge; prep-root.sh's INPUT drop for the task subnets (rootful) is what keeps tasks off it");
    }
    let terminating = Arc::new(AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(sig, Arc::clone(&terminating)).context("signal handler")?;
    }
    let pool: Arc<dyn Pool> = Arc::new(pool::Http {
        api: opts.api.clone(),
        worker_token: opts.worker_token.clone(),
        stop: Some(Arc::clone(&terminating)),
    });
    let snap = Arc::new(Mutex::new(Snapshot {
        ready: false,
        leases: json!([]),
    }));
    let listener = std::net::TcpListener::bind(&opts.ready)
        .with_context(|| format!("listening on {}", opts.ready))?;
    anyhow::ensure!(
        listener.local_addr().is_ok_and(|a| a.ip().is_loopback()),
        "{} is not a loopback address: /ready and /leases answer on loopback only",
        opts.ready
    );
    serve(listener, Arc::clone(&snap));
    std::fs::create_dir_all(opts.work_root.join("state"))?;
    let host = host_id(&*pool, &opts.work_root, &terminating)?;
    let ctx = Ctx {
        pool,
        work_root: opts.work_root.clone(),
        pool_url: opts.pool.clone(),
        checkout: opts.checkout.clone(),
        constants: Constants::signed(),
    };
    let mut d = Dispatcher::new(
        ctx,
        Arc::new(engine),
        Box::new(RealProbes {
            work_root: opts.work_root.clone(),
        }),
        opts.timing,
        host.clone(),
        opts.capacity_file.clone(),
        Images::from_env(),
        opts.disk_floor_gb,
        false,
    )?;
    d.terminating = Arc::clone(&terminating);
    d.net = opts.net.clone();
    d.net.gateway = gateway;
    let progress = Arc::new(AtomicU64::new(epoch_now()));
    loop_watchdog(
        Arc::clone(&progress),
        opts.timing.stall,
        Duration::from_secs(5).min(opts.timing.stall),
        epoch_now,
        |c| std::process::exit(c),
    );
    loop {
        match d.readopt() {
            Ok(()) => break,
            Err(e) => say(format!(
                "re-adoption failed ({e:#}); trying again in 15 s, not ready until it works"
            )),
        }
        if terminating.load(Ordering::SeqCst) {
            return Ok(());
        }
        progress.store(epoch_now(), Ordering::SeqCst);
        std::thread::sleep(Duration::from_secs(15));
    }
    say(format!(
        "dispatcher {} ready — host {host}, {} lease(s) re-adopted — asking {} for {}",
        pkg_manifest::BUILD_VERSION,
        d.holds().len(),
        opts.api,
        KINDS.join(", ")
    ));
    loop {
        d.tick();
        progress.store(epoch_now(), Ordering::SeqCst);
        {
            let mut s = snap
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            s.ready = true;
            s.leases = d.snapshot();
        }
        if let Some(code) = d.exit {
            std::process::exit(code);
        }
        if terminating.load(Ordering::SeqCst) {
            say(format!(
                "stopping: no claim since the signal; {} lease(s) written, their containers run on",
                d.holds().len()
            ));
            return Ok(());
        }
        std::thread::sleep(opts.timing.tick);
    }
}
