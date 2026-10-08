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
//! **The sandbox** (#330, design v2 §10.4; D43): a task that runs what a
//! contributor wrote — everything but the project's own recipe
//! ([`spec::sandboxed`]) — starts in the sandboxed runtime
//! `run/capacity.json` names — gVisor's `runsc` or Kata Containers, which
//! the agent found after a smoke run on a kernel that is not the engine's —
//! read again before each start; its sidecars and the project's own recipes
//! run on the engine's own runtime. The claim's `capacity.sandbox` says the
//! runtime it applies, so the pool hands a sandboxed host's emulated lanes —
//! which a sandbox's kernel cannot run, their binfmt handler being the
//! host's — the project's own recipes only; one that reaches them anyway is
//! handed back `lost` before anything runs. A start the runtime refuses fails
//! `lost` — nothing runs outside the sandbox the file says the host has —
//! and holds the claims (`want: 0`, the reason in the claim's
//! `capacity.sandbox_held`) for [`SANDBOX_HOLD`], twice as long after each
//! further refusal in a row and [`SANDBOX_HOLD_MAX`] at most: a runtime gone
//! or broken since the count loses a task now and then, not every one the
//! pool hands the host, and a host whose runtime was fixed claims again by
//! itself. A restart of the dispatcher (the `restart` order, or the round a
//! changed `run/capacity.json` starts) ends the hold at once, and so does a
//! new count in the file (`at`) this dispatcher reads. Only an error that is
//! the runtime's ([`runtime_refused`]) holds: a pull or an engine that did
//! not answer fails that one start, as on any host.
//!
//! **Lanes** (#338, design v2 §7.4, §7.5): a build or a trial runs on the
//! lane the pool leased it on — its architecture's `--platform`, natively
//! or emulated through the host's binfmt handler when `run/capacity.json`
//! lists that emulated lane — and only a container on an emulated lane is
//! told so (`WORKER_LABELS={"emulated":true}`); an audit runs natively. A
//! lease on a lane the host does not run now is handed back `lost` before
//! anything starts — checked when it is taken and again before its
//! container starts (a lease prepared across a restart, or while the file
//! changed) — and the claim offers no emulated lane without its build image
//! by digest.
//!
//! **Caches** (#341, design v2 §9.3; D52, [`cache`]): a build mounts its own
//! package's build cache on its own side and nothing else of the cache tree,
//! every task its lane's pacman cache read-only beside a writable one of its
//! own; what a lease downloaded is merged into the shared cache, in a thread of
//! the dispatcher's, only when the pool's signed databases list its bytes, and
//! both caches are pruned to the envelope's `cache_caps`.
//!
//! **A remapped daemon** (#405, design v2 §19.1): with `userns-remap` every
//! task container and sidecar stays remapped while the dispatcher runs in the
//! init user namespace (the agent's overlay: `userns_mode: host`), so a task's
//! root is the remapped range's first uid on the host, "other" on what the
//! dispatcher makes. It asks the engine for that uid and gid at start
//! ([`engine::Cli::task_root`]; a dispatcher remapped itself refuses to start)
//! and gives each task's writable directories ([`kinds::WRITABLE`]) and its
//! build cache to it before the container starts, or hands the lease back
//! `lost`; the task directory, `tasks/`, `cache/` and `in` stay its own. Every
//! other engine has no such root, and nothing changes owner.
//!
//! **Orders** at host level: drain and resume are the pool's (it hands a
//! drained host nothing), stop-task fences one lease (its heartbeat's 409),
//! restart makes the dispatcher exit 75 (tasks survive), recheck-agent and
//! restart-agent run a fresh probe.
//!
//! **Revoked releases** (#342, design v2 §9.1, §16.2; D55): a new release
//! never interrupts a task — a re-adopted lease finishes on the release it
//! started with — except a revoked one. A lease whose release is in this
//! host's merged revoked set ([`revoked`]: the signed manifest built in, with
//! every list a dispatcher of this host kept) is killed in whatever phase and
//! reported `revoked`; the pool refuses what it would upload or report, and
//! requeues it. The pool's own word at a heartbeat (409 `stop`, state
//! `revoked`) does the same for that lease, and is not kept. A dispatcher
//! whose own release is in that set takes no new task: it claims with
//! `want: 0`, for its leases and orders only.
//!
//! **Pool jobs** (#340, design v2 §7.3, §9.2; D34): sync, render, promote,
//! rollback, security, gc, verify, relayout, enqueue, publish and health run
//! here, each in a child process of the dispatcher ([`jobs`]): a 2 GB memory
//! limit, a per-kind timeout past which the dispatcher kills its process group
//! and its helper containers and fails it, its job token as today, its report
//! made by the loop once the child is gone. They take the unit kept for them,
//! one at a time — the claim lists the pool's kinds while no job is held and
//! wants one even when every other unit is busy — and run arch-neutral, in
//! this native process. The helper containers their scripts start (a health
//! check, an ABI gate's references) reach the engine only through the
//! `omarchy-task-run` shim ([`shim`]), which takes the one shape the scripts
//! use and makes it through the task spec on the job's own /28, on a lane of
//! the ring's architecture. A job does not survive its dispatcher: one that
//! was running when a new dispatcher starts is failed `lost`.
//!
//! **Its environment** (#371): the agent writes `etc/dispatcher.env` (0600,
//! the host set's `env_file`) with the host's worker token, the host's own
//! addresses for the egress to refuse (`OMARCHY_HOST_ADDRESSES`: its
//! interfaces', read again by the run loop every minute, and the public one
//! its tasks leave from, which install's egress probe saw and the run loop
//! asks the pool's edge for again every hour; rendered again when they
//! change, never touching the token),
//! `OMARCHY_SECRETS_DIR` as install chose it (a path only: never mounted
//! here) and the envelope's agent budget (`OMARCHY_AGENT_CALLS_PER_TASK`,
//! `…_TOKENS_PER_TASK`, `…_MINUTES_PER_TASK`, `…_CALLS_PER_DAY`), each only
//! when agent.toml sets it, so the defaults below hold otherwise, and
//! `OMARCHY_DIRECT_NETWORK=1` when the envelope grants a signed exception's
//! bridge network (#373), which install's egress probe then checked: without
//! it a package with `network = "direct"` is handed back; and the envelope's
//! `cache_caps` (`OMARCHY_CACHE_PACMAN_GB`, `OMARCHY_CACHE_BUILD_GB`, #341),
//! each only when agent.toml sets it; and who the agent sidecars and the
//! probe run as (#399): `OMARCHY_AGENT_USER=<uid>:<gid>`, the keys file's
//! owner as the engine shows it to a container ([`spec::AgentUser`]) — the
//! file stays 0600 and the sidecars keep every capability dropped, so they
//! read it as its owner — or, where no container user may be that owner (a
//! remapped daemon, whose task containers and sidecars stay remapped, design
//! v2 §19.1), `OMARCHY_AGENT_HELD=<code>` ([`AgentHeld`]): no probe and no
//! model task runs, and the claim's `agent` says why. A changed
//! file recreates the dispatcher, which re-adopts its tasks. The dispatcher
//! keeps the registration's id it learned in `state/host`.

pub mod budget;
pub mod cache;
pub mod capacity;
pub mod engine;
pub mod jobs;
pub mod kinds;
pub mod lease;
pub mod libpod;
pub mod pool;
pub mod probe;
pub mod revoked;
pub mod shim;
pub mod sizing;
pub mod spec;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
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

/// The tasks a host claims (design v2 §8.2): builds of every trust, trials and audits, each in
/// a task container. Pool jobs ([`jobs::POOL_KINDS`], #340) join them in the claim while the
/// unit kept for them is free; those with helper containers (`health`, `promote`'s ABI gates
/// and health checks, `security`'s) take a lane of each ring architecture they check, native
/// or emulated, as selection decides (#338).
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
/// After a first start its sandbox's runtime refused, no claim for this long (#330); each
/// further refusal in a row doubles it, up to [`SANDBOX_HOLD_MAX`].
pub const SANDBOX_HOLD: u64 = 30 * 60;
/// The longest a run of refused sandboxed starts holds the claims: a host whose runtime was
/// fixed, or whose start failed for a reason the dispatcher took for the runtime's, claims
/// again within a day with nobody at it.
pub const SANDBOX_HOLD_MAX: u64 = 24 * 3600;
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
    /// Every pool job's timeout instead of its kind's (the engine tests' hidden flag, #340).
    pub job_timeout: Option<Duration>,
    /// The task caches' caps (#341): `OMARCHY_CACHE_PACMAN_GB`, `OMARCHY_CACHE_BUILD_GB`.
    pub cache_caps: cache::Caps,
    /// The key the pool's databases are verified with instead of the one built in (the engine tests' hidden flag).
    pub pool_key: Option<PathBuf>,
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
    /// Who the agent sidecars and the probe run as (#399): the keys file's owner as the engine
    /// shows it (`OMARCHY_AGENT_USER`, which the agent writes); `None` from an agent before it,
    /// the image's own user.
    pub agent_user: Option<spec::AgentUser>,
    /// The agent holds this host's model kinds though it has keys (#399, `OMARCHY_AGENT_HELD`):
    /// no probe and no agent sidecar runs.
    pub agent_held: Option<AgentHeld>,
    pub caps: budget::Caps,
    /// How the engine keeps a task network's gateway off the host: asked of the engine at start.
    pub gateway: spec::Gateway,
    /// The owner's envelope grants a signed exception's bridge network (`OMARCHY_DIRECT_NETWORK`,
    /// #373): only then is a package with `network = "direct"` started, on the bridge install's
    /// egress probe checked; otherwise it is handed back.
    pub direct: bool,
    /// A task container's root as the host sees it on a daemon that remaps users (#405,
    /// `userns-remap`), asked of the engine at start ([`engine::Cli::task_root`]): the
    /// directories this dispatcher makes for a task to write are given to it before its
    /// container starts, since a remapped root is "other" on what host root made. `None` on
    /// every other engine, where nothing changes owner.
    pub task_root: Option<engine::TaskRoot>,
}

impl Default for Net {
    fn default() -> Self {
        Self {
            worker_image: String::new(),
            subnets: spec::Subnets::parse("10.231.0.0/16").expect("the default range"),
            deny: Vec::new(),
            secrets_dir: None,
            agent_user: None,
            agent_held: None,
            caps: budget::Caps::default(),
            gateway: spec::Gateway::Isolated,
            direct: false,
            task_root: None,
        }
    }
}

impl Net {
    /// The keys file an agent sidecar mounts: none on a host without keys, or whose agent holds them.
    fn env_file(&self) -> Option<PathBuf> {
        if self.agent_held.is_some() {
            return None;
        }
        self.secrets_dir.as_ref().map(|d| d.join("agent.env"))
    }

    /// Why no agent sidecar runs here, when none does: the claim's `agent` error and the answer
    /// to `recheck-agent` and `restart-agent`.
    fn no_agent(&self) -> Option<String> {
        if self.secrets_dir.is_none() {
            return Some("no agent key on this host (OMARCHY_SECRETS_DIR is not set)".into());
        }
        self.agent_held.as_ref().map(AgentHeld::reason)
    }
}

/// Why a host's agent holds its model kinds though it has keys (#399): `OMARCHY_AGENT_HELD`, a
/// short code the agent writes into `etc/dispatcher.env` where no container user may read the
/// owner-only keys file — a remapped daemon (`userns-remap`), whose agent sidecars stay remapped
/// as every task container does (design v2 §19.1), and whose remapped uids are none of the
/// owner's. The claim's `agent` says it in the probe's place, so the pool hands the host no
/// model work and its page says why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentHeld(String);

impl AgentHeld {
    /// A code: a lowercase letter, then lowercase letters, digits or `-`, at most 40; empty, none.
    pub fn parse(code: &str) -> Result<Option<Self>, String> {
        let code = code.trim();
        if code.is_empty() {
            return Ok(None);
        }
        let ok = code.len() <= 40
            && code.starts_with(|c: char| c.is_ascii_lowercase())
            && code
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-');
        if !ok {
            return Err(format!(
                "OMARCHY_AGENT_HELD={code:?} is not a code (a lowercase letter, then lowercase letters, digits or -, at most 40)"
            ));
        }
        Ok(Some(Self(code.to_owned())))
    }

    /// What the claim's `agent` error says (worded as none of the classes the pool restarts on):
    /// the codes this release knows, and a newer agent's by its code.
    pub fn reason(&self) -> String {
        match self.0.as_str() {
            "userns-remap" => "model kinds held: this daemon remaps users (userns-remap), so no container user is agent.env's owner, and the agent sidecars stay remapped (design v2 §19.1); how they read the keys here is a maintainer's decision (#399)".into(),
            code => format!("model kinds held by this host's agent (OMARCHY_AGENT_HELD={code}, #399)"),
        }
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
    /// A pool job's child process while it runs (#340).
    child: Option<jobs::Child>,
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
            child: None,
        }
    }

    fn is_job(&self) -> bool {
        jobs::is_job(&self.lease.task.kind)
    }
}

/// What the dispatcher runs its pool jobs with (#340).
pub struct JobConf {
    /// How a job's child starts: this binary's `pool-job`.
    pub launch: Arc<dyn jobs::Launch>,
    /// `<work root>/state/bin`: the shim, as `omarchy-task-run`, `docker` and `podman`, first on a job's `PATH`.
    pub bin: PathBuf,
    /// The engine's CLI by absolute path: what the shim runs, never itself.
    pub engine: PathBuf,
    /// Every job's timeout instead of its kind's (the engine tests' hidden flag).
    pub timeout: Option<Duration>,
}

impl JobConf {
    fn timeout(&self, kind: &str) -> Duration {
        self.timeout.unwrap_or_else(|| jobs::timeout(kind))
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
    /// The sandbox's runtime refused a task container's start (#330): no claim while it holds.
    sandbox_hold: Option<SandboxHold>,
    /// The sandboxed starts refused in a row: each doubles the next hold.
    sandbox_refusals: u32,
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
    /// This host's merged revoked set (#342, [`revoked`]): a lease of one of these is killed and reported.
    revoked: BTreeSet<String>,
    /// Pool jobs (#340).
    pub jobs: JobConf,
    /// The task caches' caps (#341): the envelope's `cache_caps`, or the defaults.
    pub cache_caps: cache::Caps,
    caches: Caches,
}

/// The task caches' upkeep (#341, [`cache`]): its pass running now, when the next one is due,
/// whether a lease left downloads since the last.
#[derive(Default)]
struct Caches {
    job: Option<Job<cache::Report>>,
    next_at: u64,
    dirty: bool,
}

/// A hold on the claims after the sandbox's runtime refused a start (#330): the count it was
/// refused under (the capacity file's `at`), until when and why.
#[derive(Debug, Clone)]
struct SandboxHold {
    at: Option<String>,
    until: u64,
    why: String,
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
            sandbox_hold: None,
            sandbox_refusals: 0,
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
            revoked: revoked::merged(&ctx_work_root, &revoked::signed()),
            ledger: budget::Ledger::new(&ctx_work_root),
            probe: Prober::default(),
            jobs: JobConf {
                launch: Arc::new(jobs::Exe(
                    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("pkg-repo")),
                )),
                bin: ctx_work_root.join("state").join("bin"),
                engine: PathBuf::from("docker"),
                timeout: None,
            },
            cache_caps: cache::Caps::default(),
            caches: Caches::default(),
        })
    }

    /// Merges a signed `revoked` list into this host's set (the manifest built into this binary
    /// does at start; the tests hand a stub manifest's): it is kept for every later dispatcher.
    pub fn revoke_signed(&mut self, signed: &BTreeSet<String>) {
        self.revoked = revoked::merged(
            &self.ctx.work_root,
            &self.revoked.union(signed).cloned().collect(),
        );
    }

    /// Whether a lease's release is revoked here.
    fn revoked(&self, l: &Lease) -> bool {
        self.revoked.contains(&l.release)
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
        if self.revoked.contains(pkg_manifest::BUILD_VERSION) {
            say(format!("this dispatcher runs {}, a revoked release: its tasks are killed, and it takes no new work (its claims say `want: 0`, for its leases and orders) until the agent applies another", pkg_manifest::BUILD_VERSION));
        }
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
            if live.lease.ending.is_none() && live.is_job() {
                self.readopt_job(&mut live);
            } else if live.lease.ending.is_none() {
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

    /// A pool job a previous dispatcher ran (#340): its child went with that dispatcher. One that
    /// had written its result is reported from it; one that was still running is lost — its
    /// attempt given back, and whatever its helpers left removed; one being prepared is prepared
    /// again; one being reported is reported again.
    fn readopt_job(&self, live: &mut Live) {
        let id = live.lease.task.id;
        match live.lease.phase {
            Phase::Preparing => say(format!(
                "task {id}: prepared again, the dispatcher restarted before its job started"
            )),
            Phase::Finishing => {}
            Phase::Running if jobs::read_result(&self.ctx.task_dir(&live.lease)).is_some() => {
                say(format!(
                    "task {id}: its job ended while no dispatcher ran; reporting what it left"
                ));
                live.lease.phase = Phase::Finishing;
                self.save(&live.lease);
            }
            Phase::Running => self.begin_ending(
                live,
                Ending::Lost(
                    "its job's process ended with the dispatcher that ran it (a pool job runs in the dispatcher's own process tree)"
                        .into(),
                ),
            ),
        }
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
            self.step_caches(now);
            self.step_probe(now);
            self.claim(now);
        }
    }

    // ---------- the task caches (#341) ----------

    /// Starts the caches' upkeep when a lease left downloads or its pass is due, in a thread of
    /// its own (it fetches the pool's databases and hashes what it merges), and says what a
    /// finished pass did.
    fn step_caches(&mut self, now: u64) {
        if self.caches.job.is_none() && (self.caches.dirty || now >= self.caches.next_at) {
            self.caches.dirty = false;
            self.caches.next_at = now + cache::EVERY;
            let u = cache::Upkeep {
                pool: Arc::clone(&self.ctx.pool),
                pool_url: self.ctx.pool_url.clone(),
                work_root: self.ctx.work_root.clone(),
                key: self.ctx.pool_key.clone(),
                caps: self.cache_caps,
                in_use: self.caches_in_use(),
            };
            let work = move || cache::upkeep(&u);
            self.caches.job = Some(if self.inline {
                Job::Done(work())
            } else {
                Job::Running(std::thread::spawn(work))
            });
        }
        if let Some(r) = poll(&mut self.caches.job) {
            if let Some(line) = r.said() {
                say(line);
            }
        }
    }

    /// The build caches this host's leases mount, or are about to: never pruned.
    fn caches_in_use(&self) -> BTreeSet<PathBuf> {
        self.leases
            .values()
            .filter_map(|v| {
                let l = &v.lease;
                let builds = kinds::kind_of(l).is_some_and(spec::Kind::builds);
                let trust = spec::Trust::of(&l.task.trust)?;
                builds.then(|| cache::build_dir(&self.ctx.work_root, trust, l.arch(), &l.task.name))
            })
            .collect()
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
                    user: net.agent_user,
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

    /// The claim's `agent`: the probe's last answer; on a host with no agent key, or whose agent
    /// holds its model kinds (#399), why none runs.
    fn agent_field(&self) -> Option<Value> {
        if let Some(why) = self.net.no_agent() {
            return Some(json!({ "probe": "error", "error": why }));
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
                Ending::Revoked(release) => format!("its release {release} is revoked; killing its containers — the pool takes nothing of it and requeues it"),
            }
        ));
        l.ending = Some(end);
        self.save(l);
        live.stop.store(true, Ordering::SeqCst);
        // A pool job's process group goes first: a script of it would start another helper.
        if let Some(mut c) = live.child.take() {
            c.kill();
        }
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
            // The pool decides by its own revoked list; `lost` is what a pool from before #342 reads (the attempt back).
            Some(Ending::Revoked(release)) => Some(
                json!({ "error": format!("release {release} is revoked: task {}'s containers were killed before it ended, and nothing of it is taken", l.task.id), "revoked": true, "lost": true, "final": false }),
            ),
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
        // What its pacman downloaded goes aside for the verified merge-back (#341), whatever
        // ended it: only what the pool's signed databases list is ever merged.
        match cache::collect(
            &self.ctx.task_dir(l),
            &self.ctx.work_root,
            l.arch(),
            l.task.id,
            &l.gen,
        ) {
            Ok(true) => self.caches.dirty = true,
            Ok(false) => {}
            Err(e) => say(format!(
                "task {}: its downloads could not be set aside for the shared pacman cache ({e}); they go with its directory",
                l.task.id
            )),
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

    /// A pool job's report, once its child is gone (#340).
    fn spawn_fin_job(&self, live: &mut Live, now: u64) {
        let (ctx, lease) = (Arc::clone(&self.ctx), live.lease.clone());
        let work = move || kinds::finish_job(&ctx, &lease, now);
        live.fin = Some(if self.inline {
            Job::Done(work())
        } else {
            Job::Running(std::thread::spawn(work))
        });
    }

    /// A running pool job (#340): its child's end, or its timeout — past it, its process group
    /// and its helper containers are killed and it is failed. Either way its report follows, once
    /// what its helpers left is gone.
    fn step_job(&mut self, mut live: Live, now: u64) -> Option<Live> {
        let limit = self.jobs.timeout(&live.lease.task.kind);
        let started = live.lease.started_at.unwrap_or(now);
        let Some(child) = live.child.as_mut() else {
            self.begin_ending(
                &mut live,
                Ending::Lost("its job's process is not this dispatcher's".into()),
            );
            return Some(live);
        };
        let end = match child.try_wait() {
            Ok(Some(status)) => {
                // What it left of its process group: a script still running, its engine client.
                child.kill_group();
                jobs::End::of(status, limit)
            }
            Ok(None) if now >= started + limit.as_secs() => {
                child.kill();
                jobs::End {
                    timed_out: true,
                    limit_s: limit.as_secs(),
                    ..jobs::End::default()
                }
            }
            Ok(None) => return Some(live),
            Err(e) => {
                say(format!(
                    "task {}: its job's process cannot be read ({e}); killing it",
                    live.lease.task.id
                ));
                let status = child.kill();
                status.map_or_else(
                    || jobs::End {
                        limit_s: limit.as_secs(),
                        ..jobs::End::default()
                    },
                    |s| jobs::End::of(s, limit),
                )
            }
        };
        live.child = None;
        // The helper containers a killed shim left, and their network.
        self.engine
            .remove_lease(live.lease.task.id, &live.lease.gen);
        let reported = jobs::read_result(&self.ctx.task_dir(&live.lease)).is_some();
        say(format!(
            "task {}: {} {}",
            live.lease.task.id,
            live.lease.task.kind,
            if reported && !end.timed_out {
                "ended; reporting what it returned".to_owned()
            } else {
                end.words()
            }
        ));
        live.lease.notes["job"] = serde_json::to_value(&end).unwrap_or_default();
        live.lease.phase = Phase::Finishing;
        self.save(&live.lease);
        self.spawn_fin_job(&mut live, now);
        self.after_fin(live, now)
    }

    /// The job token a heartbeat renewed, where a running pool job reads it (#340): its scripts get
    /// the freshest at their start, its calls that take the token again (relayout's pages) too.
    fn write_job_token(&self, l: &Lease) {
        let dir = self.ctx.task_dir(l);
        if dir.is_dir() {
            if let Err(e) = jobs::write_private(&dir.join(jobs::TOKEN_FILE), l.token.as_bytes()) {
                say(format!(
                    "task {}: its renewed token could not be written for its job: {e}",
                    l.task.id
                ));
            }
        }
    }

    /// Kills every pool job's process group (the dispatcher exits): a job does not outlive it,
    /// and the next one fails what was running `lost`.
    pub fn kill_jobs(&mut self) {
        for live in self.leases.values_mut() {
            if let Some(mut c) = live.child.take() {
                c.kill();
            }
        }
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
        // A lease of a revoked release (#342, §9.1): killed and reported, in every phase — what it
        // would upload or report is refused anyway. A task of any other release runs on.
        if self.revoked(&live.lease) {
            let release = live.lease.release.clone();
            self.begin_ending(&mut live, Ending::Revoked(release));
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
                        if live.is_job() && live.lease.phase == Phase::Running {
                            self.write_job_token(&live.lease);
                        }
                    }
                    self.save(&live.lease);
                }
                // The pool's word that its release is revoked (#342): this lease only, never kept.
                Beat::Stop(state) if state == "revoked" => {
                    let release = live.lease.release.clone();
                    self.begin_ending(&mut live, Ending::Revoked(release));
                    return Some(live);
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
            Phase::Running if live.is_job() => return self.step_job(live, now),
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
            Phase::Finishing if live.is_job() => {
                if live.fin.is_none() && now >= live.retry_at {
                    self.spawn_fin_job(&mut live, now);
                }
                return self.after_fin(live, now);
            }
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
        if live.is_job() {
            return self.start_job(live, now);
        }
        let Some(kind) = kinds::kind_of(&live.lease) else {
            self.begin_ending(&mut live, Ending::Lost("no container kind".into()));
            return live;
        };
        // Its lane against what `run/capacity.json` says now (#338), as `take` checked it: a
        // lease on an emulated lane the agent has since turned off (the owner's `emulate`,
        // binfmt gone) — prepared again after a dispatcher restart, or while the file changed —
        // goes back lost before anything starts, its attempt with it.
        if live.lease.emulated() {
            let arch = live.lease.arch().to_owned();
            if !capacity::read(&self.capacity_file).is_some_and(|c| c.emulated.contains(&arch)) {
                let why = format!(
                    "this host runs no emulated lane of {arch} now (run/capacity.json): handed back"
                );
                self.begin_ending(&mut live, Ending::Lost(why));
                return live;
            }
        }
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
        // Its bridge only where the owner's envelope grants it, which install's egress probe
        // then checked (#373): a rootless engine's bridge reaches the LAN through its user-mode
        // network stack. Elsewhere it goes back for a host that runs it. Seam: the claim does not
        // say yet whether a host runs such packages, so the pool may offer one here again, and a
        // lost lease's attempt is given back only for a task's first HOST_LOSSES_MAX losses
        // (worker/src/routes/factory.ts): where only hosts without the grant claim it, it fails.
        if direct && !self.net.direct {
            let why = format!(
                "{}'s signed network exception (factory/sizing: network = \"direct\") needs a bridge network, which this host's envelope does not grant (agent.toml's direct_network): handed back",
                live.lease.task.name
            );
            self.begin_ending(&mut live, Ending::Lost(why));
            return live;
        }
        // What a contributor wrote runs in the host's sandboxed runtime when the agent found one
        // (#330, D43), read now as the lane is. A file that does not read now, or a lease on an
        // emulated lane of a host that has one (the pool hands them none: a lease leased before
        // the count found it), is handed back: it never runs outside a sandbox the host may have.
        let t = &live.lease.task;
        let review = t.params.get("review").is_some() || t.pkgbuild_ref.starts_with("review:");
        let runtime = if spec::sandboxed(&t.trust, &t.kind, review) {
            match capacity::read(&self.capacity_file).map(|c| c.sandbox) {
                None => {
                    let why = "run/capacity.json does not read now: a task of a contributor's waits for the sandbox this host may have".to_owned();
                    lost(self, &mut live, why);
                    return live;
                }
                Some(Some(_)) if live.lease.emulated() => {
                    let why = format!(
                        "this host's sandbox does not cover its emulated {} lane, which runs the project's own recipes only: handed back",
                        live.lease.arch()
                    );
                    lost(self, &mut live, why);
                    return live;
                }
                Some(s) => s.map(|s| s.runtime),
            }
        } else {
            None
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
        // Its caches (#341): its lane's shared pacman cache and, for a build, its own package's
        // build cache on its own side, made and stamped as used before anything mounts them.
        let Some(trust) = spec::Trust::of(&live.lease.task.trust) else {
            let why = format!(
                "trust {:?} is neither community nor project",
                live.lease.task.trust
            );
            lost(self, &mut live, why);
            return live;
        };
        if let Err(e) = cache::ready(
            &self.ctx.work_root,
            trust,
            live.lease.arch(),
            &live.lease.task.name,
            kind.builds(),
            self.net.task_root,
        ) {
            lost(self, &mut live, format!("its caches: {e}"));
            return live;
        }
        // A model kind on a host whose agent holds them (#399; the pool hands it none while the
        // claim says so: a lease from before) is handed back, its sidecar never started.
        if let Some(why) = self
            .net
            .agent_held
            .as_ref()
            .filter(|_| kind.model())
            .map(AgentHeld::reason)
        {
            lost(self, &mut live, why);
            return live;
        }
        // On a remapped daemon (#405) the task's root is "other" on what this dispatcher made:
        // what it writes is given to it, or the lease goes back before anything runs — never
        // opened to every user, where its `builder` could plant outputs the dispatcher uploads.
        if let Some(root) = self.net.task_root {
            if let Err(e) = kinds::give_writable(&tdir, root) {
                lost(
                    self,
                    &mut live,
                    format!(
                        "its directories for the remapped task root {}:{}: {e}",
                        root.uid, root.gid
                    ),
                );
                return live;
            }
        }
        // A model kind's agent sidecar writes its usage as the keys file's owner (#399).
        if let Some(u) = self.net.agent_user.filter(|_| kind.model()) {
            if let Err(e) = budget::usage_dir_for(&tdir, u.uid, u.gid) {
                lost(
                    self,
                    &mut live,
                    format!("its agent sidecar's usage directory: {e}"),
                );
                return live;
            }
        }
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
            trust,
            cpus,
            mem_gb,
            image: &image,
            work_root: &self.ctx.work_root,
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
                user: self.net.agent_user,
                calls: agent_calls.unwrap_or(1),
                tokens: self.net.caps.tokens_per_task,
                wall_s: self.net.caps.minutes_per_task * 60,
            }),
            runtime: runtime.as_deref(),
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
            .map_err(|e| (0, format!("the egress bridge: {e}"), false))
            .and_then(|()| {
                plan.iter().enumerate().try_for_each(|(i, c)| {
                    self.engine.run(c).map_err(|e| {
                        // The task container's own start, refused by the sandbox's runtime (#330).
                        let refused = c[0] == "run"
                            && runtime.as_deref().is_some_and(|r| runtime_refused(r, &e));
                        (
                            i,
                            format!("{} did not start: {}", what(c), clean_line(&e)),
                            refused,
                        )
                    })
                })
            });
        if let Err((i, why, refused)) = failed {
            // A sidecar that never started spent nothing of the day.
            if agent_start.is_none_or(|a| i <= a) {
                live.lease.agent_calls = None;
            }
            // The sandbox's runtime refused the task: the claims hold (#330).
            if let Some(r) = runtime.as_deref().filter(|_| refused) {
                self.hold_sandbox(now, r, live.lease.task.id, &why);
            }
            // A `run` that did not answer may still have made the container: the ending removes it, its sidecars and network.
            self.begin_ending(&mut live, Ending::Lost(why));
            return live;
        }
        say(format!(
            "task {}: {} {} started ({cpus} CPUs, {mem_gb} GB, {} network {}{}{})",
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
            )),
            runtime
                .as_deref()
                .map_or(String::new(), |r| format!(", in the sandbox {r}"))
        ));
        if runtime.is_some() {
            self.sandbox_refusals = 0;
        }
        live
    }

    /// The sandbox's runtime refused a task container (#330): no claim for [`SANDBOX_HOLD`],
    /// twice as long after each further refusal in a row, [`SANDBOX_HOLD_MAX`] at most — the
    /// pool would hand it task after task, each lost, each loss of the same task past the
    /// second spending its attempt (worker/src/routes/factory.ts `HOST_LOSSES_MAX`). Bounded in
    /// time, so that a runtime fixed since claims again without a recount, which writes nothing
    /// when it finds the host as it was. A refusal while a hold is in effect is the same outage
    /// — a lease claimed before it, still preparing in its thread when the runtime broke — and
    /// neither counts nor lengthens it: only a refusal after a hold doubles the next.
    fn hold_sandbox(&mut self, now: u64, runtime: &str, task: u64, why: &str) {
        if self.sandbox_hold.as_ref().is_some_and(|h| now < h.until) {
            say(format!(
                "the sandbox: {runtime} refused task {task}'s start too ({}), a lease claimed before the hold: the hold stands as it was",
                why.chars().take(160).collect::<String>()
            ));
            return;
        }
        self.sandbox_refusals = self.sandbox_refusals.saturating_add(1);
        let hold = sandbox_hold_for(self.sandbox_refusals);
        let why = format!(
            "{runtime} refused task {task}'s start ({}): no claim for {}{}; the dispatcher's Restart ends it sooner",
            why.chars().take(160).collect::<String>(),
            span(hold),
            match self.sandbox_refusals {
                1 => String::new(),
                n => format!(" ({n} refusals in a row)"),
            }
        );
        say(format!("the sandbox: {why}"));
        self.sandbox_hold = Some(SandboxHold {
            at: capacity::read(&self.capacity_file).map(|c| c.at),
            until: now + hold,
            why,
        });
    }

    /// Whether the claims hold for the sandbox now: until its time, or until the capacity
    /// file says another count than the one it was refused under (one that found something
    /// changed: a count that finds the host as it was writes nothing).
    fn sandbox_held(&mut self, now: u64, at: Option<&str>) -> Option<String> {
        let h = self.sandbox_hold.as_ref()?;
        // A file that does not read now is no new count: the claims wait for it anyway.
        let counted = at.is_some() && h.at.as_deref() != at;
        if !counted && now < h.until {
            return Some(h.why.clone());
        }
        say(format!(
            "the sandbox: claiming again ({})",
            if counted {
                "the agent counted the host again"
            } else {
                "its hold is over"
            }
        ));
        if counted {
            self.sandbox_refusals = 0;
        }
        self.sandbox_hold = None;
        None
    }

    /// The architectures this host runs a lane of now (`run/capacity.json`): its native one, and the emulated.
    fn lanes_now(&self) -> Vec<String> {
        capacity::read(&self.capacity_file)
            .map(|c| std::iter::once(c.arch).chain(c.emulated).collect())
            .unwrap_or_default()
    }

    /// Starts a prepared pool job (#340): its helpers' lanes checked again and their /28, its
    /// files — the job, its token, the shim's context — and its child process, in a process group
    /// of its own, with the shim first on its `PATH` as the only engine it reaches.
    #[allow(clippy::too_many_lines)] // the checks, the files, then the child's environment, in order
    fn start_job(&mut self, mut live: Live, now: u64) -> Live {
        let kind = live.lease.task.kind.clone();
        let tdir = self.ctx.task_dir(&live.lease);
        let rdir = self.ctx.release_dir(&live.lease.release);
        let scratch = tdir.join("tmp");
        let lanes = self.lanes_now();
        let native = capacity::read(&self.capacity_file).map_or_else(native_arch, |c| c.arch);
        let missing: Vec<String> = jobs::helper_arches(&live.lease.task, &native)
            .into_iter()
            .filter(|a| !lanes.contains(a))
            .collect();
        if !missing.is_empty() {
            let why = format!(
                "its helper containers run {}, and this host runs no lane of it now (run/capacity.json): handed back",
                missing.join(" and ")
            );
            self.begin_ending(&mut live, Ending::Lost(why));
            return live;
        }
        let slot = if jobs::has_helpers(&kind) {
            let Some(slot) = self.free_slot() else {
                let why = format!(
                    "every task network of {} is in use: its helpers have none",
                    self.net.subnets.cidr()
                );
                self.begin_ending(&mut live, Ending::Lost(why));
                return live;
            };
            Some(slot)
        } else {
            None
        };
        let spec = jobs::Spec {
            task: live.lease.task.clone(),
            api: self.ctx.pool.api_url().to_owned(),
            pool: self.ctx.pool_url.clone(),
            arch: native.clone(),
            work_dir: self.ctx.work_root.join("jobs"),
            repo_dir: rdir.clone(),
            scratch: scratch.clone(),
        };
        let context = slot.map(|slot| shim::Context {
            task: live.lease.task.id,
            gen: live.lease.gen.clone(),
            host: self.host.clone(),
            scratch: scratch.clone(),
            arches: lanes.clone(),
            images: shim::pinned_images(&rdir),
            units: live.lease.units,
            unit_cpus: self.ctx.constants.unit_cpus,
            unit_mem_gb: self.ctx.constants.unit_mem_gb,
            worker_image: self.net.worker_image.clone(),
            subnets: self.net.subnets.cidr(),
            slot,
            deny: self.net.deny.clone(),
            engine: self.jobs.engine.clone(),
        });
        let written = std::fs::create_dir_all(&scratch)
            .and_then(|()| {
                jobs::write_private(
                    &tdir.join(jobs::SPEC_FILE),
                    &serde_json::to_vec(&spec).unwrap_or_default(),
                )
            })
            .and_then(|()| {
                jobs::write_private(&tdir.join(jobs::TOKEN_FILE), live.lease.token.as_bytes())
            })
            .and_then(|()| match &context {
                Some(c) => jobs::write_private(
                    &tdir.join(jobs::CONTEXT_FILE),
                    &serde_json::to_vec(c).unwrap_or_default(),
                ),
                None => Ok(()),
            });
        if let Err(e) = written {
            self.begin_ending(
                &mut live,
                Ending::Lost(format!("its job's files could not be written: {e}")),
            );
            return live;
        }
        let mut cmd = self.jobs.launch.command(&tdir);
        let path = std::env::var_os("PATH").unwrap_or_default();
        let path = std::env::join_paths(
            std::iter::once(self.jobs.bin.clone()).chain(std::env::split_paths(&path)),
        )
        .unwrap_or(path);
        // Its token is in its directory (renewed there at each heartbeat), never the host's worker token,
        // nor the name of the file that holds it (#327: a `pkg-repo` call of its scripts would read it there);
        // what would put a container outside the spec (a shared pacman cache, a task's name and label) is not passed.
        crate::worker_token::withhold(&mut cmd)
            .env("PATH", path)
            .env("RUNTIME", self.jobs.bin.join(shim::NAME))
            .env("TMPDIR", &scratch)
            .env_remove("OMARCHY_TASK_ID")
            .env_remove("OMARCHY_PKG_CACHE");
        match &context {
            Some(_) => cmd.env(shim::CONTEXT_VAR, tdir.join(jobs::CONTEXT_FILE)),
            None => cmd.env_remove(shim::CONTEXT_VAR),
        };
        live.lease.phase = Phase::Running;
        live.lease.started_at = Some(now);
        live.lease.net_slot = slot;
        self.save(&live.lease);
        match jobs::Child::spawn(cmd) {
            Ok(c) => live.child = Some(c),
            Err(e) => {
                self.begin_ending(
                    &mut live,
                    Ending::Lost(format!("its job's process did not start: {e}")),
                );
                return live;
            }
        }
        say(format!(
            "task {}: {kind} started in a process of its own ({} at most, 2 GB{})",
            live.lease.task.id,
            jobs::span(self.jobs.timeout(&kind).as_secs()),
            slot.and_then(|s| self.net.subnets.slot(s))
                .map(|s| format!(
                    "; its helpers on {} through {}, network {}",
                    jobs::helper_arches(&live.lease.task, &native).join(" and "),
                    shim::NAME,
                    s.cidr()
                ))
                .unwrap_or_default()
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
        let jobs_used: u32 = self
            .leases
            .values()
            .filter(|v| v.is_job())
            .map(|v| v.lease.units)
            .sum();
        // What a task may take now (§7.6, #337): the units beside its leases and the job unit — none when
        // fewer units than leases remain (a cap lowered: nothing running is killed, it claims nothing until
        // they fit) — and, when MemAvailable is below the largest task it could receive, only what the memory
        // still holds: another workload on the machine leaves it what still fits, or nothing this round.
        // A pool job running holds the job unit, never a task's (#340, design v2 §7.3: the minimum host runs
        // its one build beside it), as the pool counts it (selection.ts roomOf).
        let free = cap.as_ref().map_or(0, |c| {
            c.units
                .saturating_sub(c.job_reserved.max(jobs_used))
                .saturating_sub(used - jobs_used)
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
        // The unit kept for pool jobs (#340): one job at a time, in it (or in a unit still free), while
        // the memory holds it — offered even when every other unit is busy, so rings keep moving.
        let job_free = cap.as_ref().map_or(0, |c| {
            if self.leases.values().any(Live::is_job) {
                0
            } else {
                c.units.saturating_sub(used).min(1)
            }
        });
        let job_offer = self.ctx.constants.offer(job_free, mem);
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
        let sandbox_held = self.sandbox_held(now, cap.as_ref().map(|c| c.at.as_str()));
        // A dispatcher whose own release is in its revoked set (#342) takes no task: one leased on its
        // release would be killed at the next tick, and a pool whose release does not revoke it (a Worker
        // rolled back past the revocation) would hand it another each round, each a host loss. Its claims
        // go on with `want: 0`, for its leases and its orders (said once, at re-adoption).
        let want = cap.as_ref().is_some_and(|c| {
            !c.below_minimum
                && (offer > 0 || job_offer > 0)
                && c.engine_free_gb >= self.floor_gb
                && spec::digest_ok(self.images.of(&c.arch))
        }) && !self.disk_low
            // A sandbox hold (#330) holds the pool jobs' unit too (#340): one claim, one `want`.
            && sandbox_held.is_none()
            && !self.revoked.contains(pkg_manifest::BUILD_VERSION);
        // What a task, and a pool job, may take: the units this claim offered, none when it said `want: 0`.
        let room = if want { (offer, job_offer) } else { (0, 0) };
        // Its kinds: builds left out while a disk hold lasts; the pool's while a job holds its unit.
        let mut kinds: Vec<&str> = if self.disk_hold > 0 {
            KINDS_HELD.to_vec()
        } else {
            KINDS.to_vec()
        };
        if job_offer > 0 {
            kinds.extend(jobs::POOL_KINDS);
        }
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
            "kinds": kinds, "labels": { "role": "dispatcher" }, "log": crate::work::log_chunk(),
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
            // Why the claims hold for the sandbox (#330), for the host page.
            if let Some(why) = &sandbox_held {
                body["capacity"]["sandbox_held"] = json!(why);
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
        room: (u32, u32),
        cap: Option<&capacity::File>,
        now: u64,
    ) {
        let task = t.task;
        let job = jobs::is_job(&task.kind);
        let room = if job { room.1 } else { room.0 };
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
        // A task container's build cache is its side's (#341): a trust that is neither is no task to start.
        if !job && spec::Trust::of(&task.trust).is_none() {
            return refuse(
                self,
                &format!("trust {:?} is neither community nor project", task.trust),
                true,
            );
        }
        if !KINDS.contains(&task.kind.as_str()) && !job {
            return refuse(
                self,
                &format!(
                    "this dispatcher runs builds, trials, audits and pool jobs, not {}",
                    task.kind
                ),
                false,
            );
        }
        // A pool job whose helpers run a ring's architecture (#340): a lane of it here now, native or
        // emulated, or it is given back, its attempt with it.
        if job {
            let lanes: Vec<String> = cap
                .map(|c| {
                    std::iter::once(c.arch.clone())
                        .chain(c.emulated.iter().cloned())
                        .collect()
                })
                .unwrap_or_default();
            let native = cap.map_or_else(native_arch, |c| c.arch.clone());
            let missing: Vec<String> = jobs::helper_arches(&task, &native)
                .into_iter()
                .filter(|a| !lanes.contains(a))
                .collect();
            if !missing.is_empty() {
                let why = format!(
                    "its helper containers run {}, and this host runs no lane of it (its lanes: {}): handed back",
                    missing.join(" and "),
                    lanes.join(", ")
                );
                say(format!("task {}: refused — {why}", task.id));
                let _ = self.pool().fail(
                    task.id,
                    &token,
                    &json!({ "error": why, "lost": true, "final": false }),
                );
                return;
            }
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
            OrderKind::RecheckAgent | OrderKind::RestartAgent if self.net.no_agent().is_some() => {
                let code = if o.kind == OrderKind::RecheckAgent {
                    "probe-failed"
                } else {
                    "not-answering"
                };
                answer(
                    self,
                    "failed",
                    code,
                    &self.net.no_agent().unwrap_or_default(),
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

/// Whether a failed `run` of a task container is its sandbox's runtime refusing it (#330):
/// docker's "unknown or invalid runtime name", an OCI runtime's or its containerd shim's error
/// (runsc's, Kata's: `/dev/kvm` gone), or one that names the runtime — not a pull that failed
/// (the spec does not pull ahead: a missing image is pulled within `run`), a name in use or an
/// engine that did not answer, which any start can meet and which hold nothing.
fn runtime_refused(runtime: &str, err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("runtime") || e.contains("shim") || e.contains(&runtime.to_ascii_lowercase())
}

/// How long the `n`th refused sandboxed start in a row holds the claims (#330): 30 minutes,
/// 1, 2, 4, 8, 16 hours, then a day (the shift stops at 8, past the day: it never overflows).
fn sandbox_hold_for(n: u32) -> u64 {
    (SANDBOX_HOLD << n.clamp(1, 8).saturating_sub(1)).min(SANDBOX_HOLD_MAX)
}

/// A hold's length as the host page says it: minutes below an hour, else hours.
fn span(s: u64) -> String {
    match s / 3600 {
        0 => format!("{} minutes", s / 60),
        1 => "1 hour".to_owned(),
        h => format!("{h} hours"),
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
    let mut engine = engine::Cli::find()
        .ok_or_else(|| anyhow!("no container engine answers (docker, or podman)"))?;
    let engine_runtime = engine.runtime.clone();
    let gateway = engine.gateway().map_err(|e| anyhow!("{e}"))?;
    if let Some(l) = &engine.libpod {
        say(format!(
            "podman {} behind docker's CLI: task networks are made through libpod's API on {}, internal with DNS off, so none has a gateway",
            l.version,
            l.socket.display()
        ));
    }
    // A remapped daemon's task root (#405), read with the worker image the sidecars run; none
    // on every other engine.
    let task_root = engine
        .task_root(&opts.net.worker_image)
        .map_err(|e| anyhow!("{e}"))?;
    if let Some(r) = task_root {
        say(format!(
            "this daemon remaps users (userns-remap): a task's root is host uid {}, gid {}, and what a task writes is given to it before its container starts (#405)",
            r.uid, r.gid
        ));
    }
    if opts.net.secrets_dir.is_some() {
        say(match (&opts.net.agent_held, opts.net.agent_user) {
            (Some(h), _) => format!("no probe and no agent sidecar: {}", h.reason()),
            (None, Some(u)) => format!(
                "agent sidecars and the probe run as {}:{}, agent.env's owner as the engine shows it (#399)",
                u.uid, u.gid
            ),
            (None, None) => "agent sidecars and the probe run as the worker image's user: etc/dispatcher.env names no OMARCHY_AGENT_USER (an agent from before #399), so a 0600 agent.env of another user's does not read".into(),
        });
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
        pool_key: opts.pool_key.clone(),
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
    d.net.task_root = task_root;
    d.cache_caps = opts.cache_caps;
    // Pool jobs (#340): the shim first on their PATH, as the only engine their scripts reach; the real one by its path.
    let exe = std::env::current_exe().context("this binary's path, for the pool jobs' shim")?;
    jobs::install_shim(&d.jobs.bin, &exe).context("the pool jobs' shim (state/bin)")?;
    d.jobs.engine = jobs::engine_path(
        &engine_runtime,
        &d.jobs.bin,
        std::env::var_os("PATH").as_deref(),
    )
    .ok_or_else(|| anyhow!("{engine_runtime} is not on PATH by an absolute path"))?;
    d.jobs.timeout = opts.job_timeout;
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
        "dispatcher {} ready — host {host}, {} lease(s) re-adopted — asking {} for {}, and pool jobs ({}) in the unit kept for them",
        pkg_manifest::BUILD_VERSION,
        d.holds().len(),
        opts.api,
        KINDS.join(", "),
        jobs::POOL_KINDS.join(", ")
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
            d.kill_jobs();
            std::process::exit(code);
        }
        if terminating.load(Ordering::SeqCst) {
            d.kill_jobs();
            say(format!(
                "stopping: no claim since the signal; {} lease(s) written, their containers run on (a pool job ends with its dispatcher)",
                d.holds().len()
            ));
            return Ok(());
        }
        std::thread::sleep(opts.timing.tick);
    }
}
