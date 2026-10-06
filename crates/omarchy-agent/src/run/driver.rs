//! The runtime driver interface (design v2 §15, v1 §10), cut to what the P1 rollout uses.
//! Synchronous; no method blocks longer than one engine call with a timeout, and anything
//! long (a pull, a stop) is started and then polled.
//!
//! The driver never learns about tasks: it sees only the set's compose project, and task
//! containers are the dispatcher's. The one other project it ever lists, stops and removes
//! is the legacy compose project `legacy.json` records, at the `retire-legacy` host order
//! (#344, design v2 §11.1 M4). It reads the dispatcher's last log lines for the
//! `diagnostics` order, says which engine answers on its socket and counts the host's task
//! containers there for the owner's runtime switch (#325). Capacity (`capacity()`, #333)
//! and fingerprinting (#317) join this trait in their own issues; the emulated lane's
//! smoke run (§15's `emulation(arch, image)`, #338) is `capacity::emulation::Smoke` on the
//! probe's engine CLI until then, and joins it with `capacity()` when the run loop detects
//! — then as a start and a poll, like a pull: its first run may pull the foreign build
//! image, longer than one engine call may block here.

use std::path::PathBuf;

use super::config::Runtime;

/// An engine answer. `NoAnswer` means "change nothing": the caller stays where it is.
/// (The design's names, kept.)
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Answer<T> {
    Yes(T),
    NotFound,
    NoAnswer(String),
}

/// The compose project a rollout acts on: its name, its directory (the set directory,
/// where relative paths resolve), the files compose loads, and the variables compose
/// interpolates (from agent.toml). Interpolated output is never written anywhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Project {
    pub name: String,
    pub dir: PathBuf,
    pub files: Vec<PathBuf>,
    pub env: Vec<(String, String)>,
}

/// One container of the set, as `observe` and `inspect` see it (never its environment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Unit {
    pub id: String,
    pub service: String,
    /// The engine's word: `running`, `restarting`, `exited`, `created`, `dead`, ...
    pub status: String,
    pub restarts: u64,
    pub exit_code: i64,
    /// compose's `com.docker.compose.config-hash` label.
    pub config_hash: String,
    /// The agent's `org.omarchy-pool.agent.release` label.
    pub release: String,
}

impl Unit {
    pub fn running(&self) -> bool {
        self.status == "running"
    }
    pub fn restarting(&self) -> bool {
        self.status == "restarting"
    }
    pub fn stopped(&self) -> bool {
        matches!(self.status.as_str(), "exited" | "dead" | "created")
    }
}

/// A container of another compose project, as `retire-legacy` reads it (#344): never its
/// environment, only what the order needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Foreign {
    pub id: String,
    pub status: String,
    /// compose's `com.docker.compose.project.working_dir` label: the project's directory.
    pub working_dir: String,
    /// The agent's `org.omarchy-pool.agent.host` label: a container of a host's bundle or
    /// one of its tasks, which `retire-legacy` never touches whatever project it names.
    pub agent_host: String,
}

impl Foreign {
    pub fn stopped(&self) -> bool {
        matches!(self.status.as_str(), "exited" | "dead" | "created")
    }

    pub fn running(&self) -> bool {
        matches!(self.status.as_str(), "running" | "restarting")
    }

    /// The container as `begin_drain`, `drained` and `remove` take one.
    pub fn unit(&self) -> Unit {
        Unit {
            id: self.id.clone(),
            service: String::new(),
            status: self.status.clone(),
            restarts: 0,
            exit_code: 0,
            config_hash: String::new(),
            release: String::new(),
        }
    }
}

/// An exit of a container: when (unix seconds) and with what code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Exit {
    pub at: i64,
    pub code: i64,
}

/// Which engine answers on a socket (`docker version`'s server components: podman's API
/// socket names its `Podman Engine`), its version, and whether it runs rootless.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EngineId {
    pub runtime: Runtime,
    pub version: String,
    pub rootless: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PullState {
    Running,
    Done,
    Failed(String),
}

pub(crate) trait Driver {
    /// The project's containers of `services`.
    fn observe(&mut self, p: &Project, services: &[String]) -> Answer<Vec<Unit>>;
    /// compose's config hash of `service` as `p` would create it.
    fn config_hash(&mut self, p: &Project, service: &str) -> Answer<String>;
    /// The images `p` names.
    fn images(&mut self, p: &Project) -> Answer<Vec<String>>;
    /// Starts pulling `services`' images; `poll_pull` follows it. `NotFound` from
    /// `poll_pull` means no pull is in flight (the agent restarted): start again.
    fn start_pull(&mut self, p: &Project, services: &[String]) -> Answer<()>;
    fn poll_pull(&mut self) -> Answer<PullState>;
    /// Sends the stop signal, the engine waiting up to `grace_s` before it kills.
    fn begin_drain(&mut self, u: &Unit, grace_s: u64) -> Answer<()>;
    fn drained(&mut self, u: &Unit) -> Answer<bool>;
    fn remove(&mut self, u: &Unit, force: bool) -> Answer<()>;
    /// Creates and starts `services` (their old containers are gone: this takes seconds).
    fn create(&mut self, p: &Project, services: &[String]) -> Answer<()>;
    fn inspect(&mut self, id: &str) -> Answer<Unit>;
    /// The container's exits since `since` (unix seconds).
    fn exits_since(&mut self, id: &str, since: i64) -> Answer<Vec<Exit>>;
    /// Whether `http` (`127.0.0.1:<port>/<path>`) answers inside the container.
    fn ready(&mut self, id: &str, http: &str) -> Answer<bool>;
    /// Removes an image no container uses; the engine refuses one in use.
    fn remove_image(&mut self, image: &str) -> Answer<()>;
    /// The containers labelled with compose project `project`, exactly (#344: only ever
    /// the legacy project `legacy.json` records).
    fn project_containers(&mut self, project: &str) -> Answer<Vec<Foreign>>;
    /// The ids of the networks labelled with compose project `project`, exactly.
    fn project_networks(&mut self, project: &str) -> Answer<Vec<String>>;
    /// Removes a network; the engine refuses one a container still uses.
    fn remove_network(&mut self, id: &str) -> Answer<()>;
    /// The last `lines` lines a container wrote, stdout and stderr in the order written,
    /// each with the engine's timestamp (#325's `diagnostics`; the caller scrubs them).
    fn logs(&mut self, id: &str, lines: u32) -> Answer<String>;
    /// Which engine answers on the driver's socket (#325's runtime switch).
    fn engine(&mut self) -> Answer<EngineId>;
    /// How many running containers carry the agent's host label `host` outside any compose
    /// project: the dispatcher's task containers and their sidecars (#325's runtime switch).
    fn host_tasks(&mut self, host: &str) -> Answer<usize>;
    /// Whether a task container runs on the engine ([`TASK_LABEL`]): what holds back a
    /// resize of a Mac's VM (#320), which would end it. The driver lists it; it never acts
    /// on one.
    fn tasks_running(&mut self) -> Answer<bool>;
}

/// The label the dispatcher gives every task container and every sidecar of one
/// (`com.omarchy.task=<id>`, pkg-repo's `stop::TASK_LABEL`); the role label
/// (`org.omarchy-pool.task.role`) is a sidecar's only, and a task with the signed `direct`
/// exception has none.
pub(crate) const TASK_LABEL: &str = "com.omarchy.task";
