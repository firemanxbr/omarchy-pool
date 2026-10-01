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
//! refused at start for its budget holds the claims until that budget plus
//! the floor is free); then a claim — `want: 1` while units, memory, disk
//! and the lane's image allow, every 30 s with `want: 0` otherwise. A lease
//! ends (its report, its lease file, its units) only once the engine says
//! its container is gone. A tick spends at most a third of the stall on the
//! pool's heartbeats and reports; the rest wait for the next tick, and every
//! lease's own watchdog runs whatever the pool does. A loop that makes no
//! progress for 15 minutes exits 75 without touching a task container; the
//! next dispatcher re-adopts them. SIGTERM stops the claims and exits; the
//! lease files are always current, so tasks run on.
//!
//! Seams: task containers run on the engine's default bridge until the task
//! networks child issue gives each its own network; the model kinds'
//! `http://agent:8790` answers once the agent sidecars child issue starts
//! that sidecar (until then a review rebuild and an audit fail at their
//! model call).
//!
//! **Orders** at host level: drain and resume are the pool's (it hands a
//! drained host nothing), stop-task fences one lease (its heartbeat's 409),
//! restart makes the dispatcher exit 75 (tasks survive). Seam: re-check and
//! restart of the agent are answered by the probe sidecar the agent
//! sidecars child issue adds; until then the dispatcher does not declare
//! them, and the pool refuses them with its own words.
//!
//! Seams for #317 (install): the agent writes `etc/dispatcher.env` with the
//! host's worker token (and could add the host id; the dispatcher keeps the
//! registration's id it learned in `state/host`).

pub mod capacity;
pub mod engine;
pub mod kinds;
pub mod lease;
pub mod pool;
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
use self::lease::{Ending, Lease, Phase, Store};
use self::pool::Pool;
use crate::orders::{self, clean_line, ClaimAnswer, Order, OrderKind};
use crate::stop::Beat;
use crate::work::{say, Task};
use crate::RepoError;

/// What a host claims in P1 (design v2 §8.2): builds of every trust, trials and audits.
pub const KINDS: [&str; 3] = ["build", "trial", "audit"];
/// The orders the dispatcher executes: drain (a notice), stop-task (the heartbeat's 409), restart (exit 75).
pub const TAKES: [&str; 3] = ["drain", "restart", "stop-task"];
/// The exit a restart, or a loop that stopped making progress, ends with: the restart policy starts the next dispatcher.
pub const EXIT_RESTART: i32 = 75;
/// A dispatcher younger than this refuses a restart: one this soon would loop.
const RESTART_MIN_UPTIME: u64 = 120;
/// After a preparation or a finish that must be tried again.
const RETRY_AFTER: u64 = 60;
/// After a claim that failed.
const CLAIM_RETRY: u64 = 60;

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
    /// A build refused at start for its budget: no claim until this much is free on both disks.
    disk_hold: u64,
    /// The capacity file's `at` when the watcher last killed on the engine's value: once per probe.
    engine_kill_at: Option<String>,
    /// This tick's heartbeats and reports wait for the next tick past this.
    pool_until: Instant,
    instance: String,
    started: u64,
    seen: orders::Seen,
    brake: orders::Brake,
    pub terminating: Arc<AtomicBool>,
    /// An order asked the process to exit with this code.
    pub exit: Option<i32>,
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
            engine_kill_at: None,
            pool_until: Instant::now(),
            instance: orders::new_instance(),
            started,
            seen: orders::Seen::default(),
            brake: orders::Brake::default(),
            terminating: Arc::new(AtomicBool::new(false)),
            exit: None,
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
                        "units": l.units, "release": l.release, "phase": l.phase, "ending": l.ending,
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
        let names = self
            .engine
            .list(&self.host)
            .map_err(|e| anyhow!("listing this host's task containers: {e}"))?;
        for p in &found.unreadable {
            say(format!("readopt-failed: {} does not read; its container goes, and the pool requeues the lease", p.display()));
            if let Some((id, gen)) = Store::named(p) {
                self.engine.remove_name(&spec::container_name(id, &gen));
            }
            let _ = std::fs::remove_file(p);
        }
        let held: Vec<(u64, String)> = found.leases.iter().map(Lease::key).collect();
        for name in &names {
            match spec::lease_of_name(name) {
                Some(key) if held.contains(&key) => {}
                Some(_) => {
                    say(format!(
                        "{name}: a task container of this host without a lease file; removed"
                    ));
                    self.engine.remove_name(name);
                }
                None => {}
            }
        }
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

    // ---------- the loop ----------

    pub fn tick(&mut self) {
        let now = self.probes.now();
        // A pool that does not answer costs each call about two minutes with its retries: N leases'
        // heartbeats in a row would outlast the loop watchdog, so a tick stops calling it here.
        self.pool_until = Instant::now() + self.timing.stall / 3;
        let keys: Vec<(u64, String)> = self.leases.keys().cloned().collect();
        for key in keys {
            if let Some(live) = self.leases.remove(&key) {
                if let Some(live) = self.step(live, now) {
                    self.leases.insert(key, live);
                }
            }
        }
        self.watch_disk();
        if !self.terminating.load(Ordering::SeqCst) {
            self.claim(now);
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

    /// Starts a prepared lease's container: a build only with its disk budget plus the floor free (D53).
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
                // No claim until this budget fits again: the pool would hand the same build straight back.
                self.disk_low = true;
                self.disk_hold = self.disk_hold.max(need);
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
        let image = self.images.of(&live.lease.task.arch).to_owned();
        let tdir = self.ctx.task_dir(&live.lease);
        let rdir = self.ctx.release_dir(&live.lease.release);
        let args = spec::task_container(&spec::Spec {
            task: live.lease.task.id,
            gen: &live.lease.gen,
            host: &self.host,
            release: &live.lease.release,
            arch: &live.lease.task.arch,
            name: &live.lease.task.name,
            kind,
            cpus,
            mem_gb,
            image: &image,
            task_dir: &tdir,
            release_dir: &rdir,
        });
        let args = match args {
            Ok(a) => a,
            Err(why) => {
                // The task's own values (name, arch, generation, release) passed the grammar in
                // take(): what fails here is this host's (its image, its id, its paths), never the task's.
                self.begin_ending(
                    &mut live,
                    Ending::Lost(format!("failed before docker ran — {why}")),
                );
                return live;
            }
        };
        live.lease.phase = Phase::Running;
        live.lease.started_at = Some(now);
        self.save(&live.lease);
        if let Err(e) = self.engine.run(&args) {
            // A `run` that did not answer may still have made the container: the ending removes it.
            self.begin_ending(
                &mut live,
                Ending::Lost(format!(
                    "the task container did not start: {}",
                    clean_line(&e)
                )),
            );
            return live;
        }
        say(format!(
            "task {}: {} {} started ({cpus} CPUs, {mem_gb} GB)",
            live.lease.task.id, live.lease.task.kind, live.lease.task.name
        ));
        live
    }

    /// The disk watcher (D53): free space below the floor, on the work root (measured now) or the
    /// engine's (the agent's last probe, acted on once per probe), kills the youngest running
    /// build, `lost`, one at a time, and stops the claims until it is back. A build refused at
    /// start holds the claims until its budget plus the floor is free on both.
    fn watch_disk(&mut self) {
        let work = self.probes.work_free_gb();
        let cap = capacity::read(&self.capacity_file);
        let engine = cap.as_ref().map(|c| c.engine_free_gb);
        let short = |v: Option<u64>, need: u64| v.is_some_and(|v| v < need);
        let need = self.disk_hold.max(self.floor_gb);
        let show = |v: Option<u64>| v.map_or("?".into(), |v| v.to_string());
        if !short(work, need) && !short(engine, need) {
            if self.disk_low {
                say(format!(
                    "{} GB free on the work root and {} on the engine's again: claiming again",
                    show(work),
                    show(engine)
                ));
            }
            self.disk_low = false;
            self.disk_hold = 0;
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
        let mem_ok = self
            .probes
            .mem_available_gb()
            .is_none_or(|m| m >= u64::from(self.ctx.constants.unit_mem_gb));
        let want = cap.as_ref().is_some_and(|c| {
            !c.below_minimum
                && c.units > 0
                && used + 1 + c.job_reserved <= c.units
                && c.engine_free_gb >= self.floor_gb
                && spec::digest_ok(self.images.of(&c.arch))
        }) && !self.disk_low
            && mem_ok;
        // What a task may take: the units this claim offered, none when it said `want: 0`.
        let room = cap.as_ref().filter(|_| want).map_or(0, |c| {
            c.units.saturating_sub(c.job_reserved).saturating_sub(used)
        });
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
            "kinds": KINDS, "labels": { "role": "dispatcher" }, "log": crate::work::log_chunk(),
            "orders": TAKES, "instance": self.instance, "started_at": iso(self.started),
            "claim_id": claim_id, "want": u8::from(want), "leases": leases,
        });
        if let Some(c) = &cap {
            body["capacity"] = c.claim.clone();
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
                        self.take(t, token, staging_full, room, now);
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

    fn take(&mut self, t: HostTask, token: String, staging_full: bool, room: u32, now: u64) {
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
        let release = t
            .release
            .filter(|r| spec::name_ok(r))
            .unwrap_or_else(|| pkg_manifest::BUILD_VERSION.to_owned());
        say(format!(
            "task {}: {} {} for {} (attempt {}/{}), lease {gen}",
            task.id, task.kind, task.name, task.arch, task.attempts, task.max_attempts
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
            let body = json!({ "instance": this.instance, "outcome": outcome, "code": code, "detail": detail });
            if let Err(e) = this.pool().answer(&o.id, &body) {
                say(format!("order {}: the answer did not reach the pool ({}); it closes the order by what it sees", o.id, clean_line(&e.to_string())));
            }
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
            OrderKind::Restart => {
                answer(self, "accepted", "exiting", "exit 75; the restart policy starts the dispatcher again, and it re-adopts every task");
                say(format!(
                    "order {}: restarting — exit 75; every task container runs on",
                    o.id
                ));
                self.exit = Some(EXIT_RESTART);
            }
            other => {
                let code = if matches!(other, OrderKind::Unknown(_)) {
                    "unknown-kind"
                } else {
                    "other"
                };
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
    std::fs::create_dir_all(&opts.work_root)
        .with_context(|| format!("creating {}", opts.work_root.display()))?;
    let engine = engine::Cli::find()
        .ok_or_else(|| anyhow!("no container engine answers (docker, or podman)"))?;
    let pool: Arc<dyn Pool> = Arc::new(pool::Http {
        api: opts.api.clone(),
        worker_token: opts.worker_token.clone(),
    });
    let terminating = Arc::new(AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(sig, Arc::clone(&terminating)).context("signal handler")?;
    }
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
