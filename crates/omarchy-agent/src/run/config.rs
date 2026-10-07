//! The agent's local configuration: `agent.toml` (design v2 §12) and the data directory.
//!
//! agent.toml is written by `omarchy-agent install` (#317: with the `host_id` and
//! `worker_id` the enrollment gave, #321), by a person at the host and by the person's
//! `omarchy-agent runtime switch` there (#325), never by the pool. It is refused when
//! group- or world-writable or owned by another user. Unknown keys are left alone
//! (capacity caps are #333's), but `[envelope].agent_budget`, `[envelope].direct_network`
//! and `[envelope].cache_caps`, which reach the dispatcher (#371, #373, #341), are read
//! strictly.
//! What the pool may narrow inside it — units, emulated lanes — and what it allows the pool
//! to ask — diagnostics — is [`Policy`] (#325, design v2 §12), with the owner's soak
//! (`soak_minutes`, #326). Any problem here is a local configuration error: the loop exits
//! 78 and says why.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::dispatcher_env::{Budget, CacheCaps};
use crate::lint::{Engine, Envelope};

/// Where the agent keeps everything (design v2 §13.1), for every command: `--data-dir`,
/// `$OMARCHY_AGENT_DATA`, `$XDG_DATA_HOME/omarchy-agent`, or
/// `~/.local/share/omarchy-agent` (install.sh's).
pub fn data_dir(flag: Option<&str>) -> Result<PathBuf, String> {
    if let Some(d) = flag.map(PathBuf::from).or_else(|| {
        std::env::var_os("OMARCHY_AGENT_DATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }) {
        return Ok(d);
    }
    if let Some(x) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(x).join("omarchy-agent"));
    }
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(|h| PathBuf::from(h).join(".local/share/omarchy-agent"))
        .ok_or_else(|| {
            "no data directory: give --data-dir, or set OMARCHY_AGENT_DATA or HOME".into()
        })
}

/// The files under the data directory.
#[derive(Debug, Clone)]
pub struct Paths {
    pub data: PathBuf,
}

impl Paths {
    pub fn agent_toml(&self) -> PathBuf {
        self.data.join("agent.toml")
    }
    pub fn state(&self) -> PathBuf {
        self.data.join("state.json")
    }
    pub fn journal(&self) -> PathBuf {
        self.data.join("journal.ndjson")
    }
    pub fn pid(&self) -> PathBuf {
        self.data.join("agent.pid")
    }
    pub fn bundles(&self) -> PathBuf {
        self.data.join("bundles")
    }
    pub fn tools(&self) -> PathBuf {
        self.data.join("tools")
    }
    pub fn docker_config(&self) -> PathBuf {
        self.data.join("docker-config")
    }
    pub fn staging(&self, set: &str) -> PathBuf {
        self.data.join("staging").join(set)
    }
    pub fn last_good(&self, set: &str) -> PathBuf {
        self.data.join("last-good").join(set)
    }
    /// `versions/<X.Y.Z>/omarchy-agent`: every agent binary on the host (install.sh puts
    /// the first one there), `current` and `previous` link to two of them (#316).
    pub fn versions(&self) -> PathBuf {
        self.data.join("versions")
    }
    pub fn binary(&self, v: crate::version::Version) -> PathBuf {
        self.versions().join(v.to_string()).join("omarchy-agent")
    }
    pub fn current(&self) -> PathBuf {
        self.data.join("current")
    }
    pub fn previous(&self) -> PathBuf {
        self.data.join("previous")
    }
    /// The self-update in flight: `from`, `to`, the starts counted, the deadline.
    pub fn pending(&self) -> PathBuf {
        self.data.join("pending")
    }
    /// Where the enrollment made the host key (`crate::enroll::Paths`' state directory): the
    /// host state's and the report's requests are signed with it (#344) — `host.ed25519`, or
    /// the files of a key in the TPM (#330).
    pub fn host_key_dir(&self) -> PathBuf {
        self.data.join("state")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// The pool origin (`https://...`); it must also be in a bundle's signed `pools`.
    pub pool: String,
    pub host_id: String,
    /// The host's worker registration (#321); its open Update orders reach the agent in
    /// the host state (#344).
    pub worker_id: String,
    pub set_name: String,
    pub set_dir: PathBuf,
    pub work_root: PathBuf,
    pub secrets_dir: PathBuf,
    /// The compose project; `set.toml`'s `project_default` when absent.
    pub project: Option<String>,
    /// The engine socket the pinned CLI talks to, and the one the dispatcher mounts.
    pub socket_cli: PathBuf,
    pub socket_mount: PathBuf,
    pub task_subnets: Option<String>,
    /// `[envelope].agent_budget` (#371): what `etc/dispatcher.env` gives the dispatcher.
    pub agent_budget: Budget,
    /// `[envelope].direct_network` (#373): the owner grants a signed exception's bridge
    /// network, which `etc/dispatcher.env` tells the dispatcher.
    pub direct_network: bool,
    /// `[envelope].cache_caps` (#341): the task caches' caps `etc/dispatcher.env` gives the dispatcher.
    pub cache_caps: CacheCaps,
    pub envelope: Envelope,
    /// What install detected behind the socket (`set.engine`, #317): the lint holds a
    /// rootful one to `rootful_ack` and `dedicated`. Absent, the strict (rootful) case.
    pub engine: Engine,
    /// The engine the compose driver talks to (`set.runtime`, `docker` or `podman`): what
    /// `runtime switch` moved the bundle to (#325). Absent — install writes none: it finds
    /// a socket, and podman's speaks docker's API — the run loop asks the engine behind
    /// the socket which it is ([`super::agent::Agent::identify_runtime`]). Podman's on a
    /// Quadlet host.
    pub runtime: Option<Runtime>,
    /// The driver that runs the set (`set.driver`): compose, or Quadlet (#330), chosen at
    /// install or by the owner's runtime switch at the host, never by the pool.
    pub driver: DriverKind,
    /// Where the Quadlet driver writes its units (`set.unit_dir`): podman's generator reads
    /// the user's `$XDG_CONFIG_HOME/containers/systemd/` (`~/.config/...`) when absent.
    pub unit_dir: Option<PathBuf>,
    /// The envelope's bounds on what the pool may narrow and ask (#325).
    pub policy: Policy,
    /// A Mac's `omarchy` Colima VM (#320, `[vm] runtime = "colima"`), which the loop keeps
    /// running, sized and on time. `None` on Linux, and for Docker Desktop's or `OrbStack`'s
    /// VM, which the agent uses but never manages.
    pub vm: Option<Vm>,
    /// agent.toml has `[vm]`, whatever its runtime (Colima, Docker Desktop, `OrbStack`):
    /// the host is a Mac, whose sleep the agent holds off and reports (#329) and whose
    /// runtime switch it refuses (#325), as it does on a Mac's build without `[vm]`.
    pub mac: bool,
}

/// The `omarchy` VM as agent.toml describes it (#320, design v2 §19.2): its size is the
/// envelope's `max_cpus` and `max_mem_gb` (install writes half the Mac's), its mounts the
/// set's three directories (`crate::vm::mounts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vm {
    pub cpus: u32,
    pub mem_gb: u32,
    pub disk_gb: u32,
    pub rosetta: bool,
}

/// The container engine behind the compose driver's socket: the drivers this binary
/// carries are `compose/docker` and `compose/podman` (design v2 §15, v1 §10.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Runtime {
    Docker,
    Podman,
}

impl Runtime {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "docker" | "compose/docker" => Some(Runtime::Docker),
            "podman" | "compose/podman" => Some(Runtime::Podman),
            _ => None,
        }
    }

    pub fn word(self) -> &'static str {
        match self {
            Runtime::Docker => "docker",
            Runtime::Podman => "podman",
        }
    }

    /// The driver's name, as the report and `runtime switch` say it.
    pub fn driver(self) -> String {
        format!("compose/{}", self.word())
    }
}

/// The drivers this binary carries (design v2 §15): compose — against docker's socket or
/// podman's API socket, [`Runtime`] — and Quadlet (#330): the set as systemd user units
/// podman's generator makes, on a rootless podman host with no compose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DriverKind {
    #[default]
    Compose,
    Quadlet,
}

impl DriverKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "compose" => Some(DriverKind::Compose),
            "quadlet" => Some(DriverKind::Quadlet),
            _ => None,
        }
    }

    /// `set.driver`'s word.
    pub fn word(self) -> &'static str {
        match self {
            DriverKind::Compose => "compose",
            DriverKind::Quadlet => "quadlet",
        }
    }
}

/// What the envelope says the pool may narrow and ask (design v2 §12, #325): the owner's
/// own words at the host. The pool's settings only ever narrow inside it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Policy {
    /// `max_units`: the most units the host gives, whatever the pool says.
    pub max_units: Option<u32>,
    /// `emulate`: the foreign architectures whose emulated lane may run; `None` (the key
    /// absent) leaves it to detection, `[]` turns emulated lanes off.
    pub emulate: Option<Vec<String>>,
    /// `diagnostics`: whether the pool may ask for the dispatcher's last log lines (M10).
    pub diagnostics: bool,
    /// `drivers`: the drivers `runtime switch` may move the bundle to (`compose` names
    /// both compose ones, `compose/docker` and `compose/podman`; `quadlet` the Quadlet
    /// driver, #330).
    pub drivers: Vec<String>,
    /// `soak_minutes` (#326, design v2 D16): how long a new release waits before this host
    /// takes it, from when the pool first names it; 0 (the default) takes it at once. A
    /// rollback statement skips it; nothing the pool sends does.
    pub soak_minutes: u32,
}

impl Policy {
    /// Whether the envelope lets the bundle run on `r`'s compose driver.
    pub fn allows_driver(&self, r: Runtime) -> bool {
        self.allows(&r.driver())
    }

    /// Whether the envelope lets the bundle run on `driver` (`compose/docker`,
    /// `compose/podman` or `quadlet`).
    pub fn allows(&self, driver: &str) -> bool {
        self.drivers
            .iter()
            .any(|d| d == driver || (d == "compose" && driver.starts_with("compose/")))
    }

    /// Whether the envelope lets an emulated lane of `arch` run.
    pub fn allows_lane(&self, arch: &str) -> bool {
        crate::capacity::emulation::allowed(self.emulate.as_deref(), arch)
    }
}

#[derive(Deserialize)]
struct File {
    pool: Option<String>,
    host_id: Option<String>,
    worker_id: Option<String>,
    #[serde(default)]
    set: SetPart,
    #[serde(default)]
    envelope: EnvelopePart,
    vm: Option<VmPart>,
}

#[derive(Deserialize)]
struct VmPart {
    runtime: String,
    profile: Option<String>,
    rosetta: Option<bool>,
    disk_gb: Option<u32>,
}

#[derive(Deserialize, Default)]
struct SetPart {
    name: Option<String>,
    dir: Option<PathBuf>,
    work_root: Option<PathBuf>,
    secrets_dir: Option<PathBuf>,
    project: Option<String>,
    driver: Option<String>,
    socket_cli: Option<PathBuf>,
    socket_mount: Option<PathBuf>,
    engine: Option<String>,
    runtime: Option<String>,
    unit_dir: Option<PathBuf>,
}

#[derive(Deserialize, Default)]
struct EnvelopePart {
    task_subnets: Option<String>,
    max_cpus: Option<u32>,
    max_mem_gb: Option<u32>,
    agent_budget: Option<toml::Value>,
    direct_network: Option<bool>,
    cache_caps: Option<toml::Value>,
    max_units: Option<u32>,
    emulate: Option<Vec<String>>,
    #[serde(default)]
    diagnostics: bool,
    drivers: Option<Vec<String>>,
    #[serde(default)]
    soak_minutes: u32,
}

/// The architectures a lane may be (design v2 §7.4): detection's own list (#338).
pub(crate) use crate::capacity::emulation::ARCHES;

/// The longest soak an owner may set (#326): the pool's claim grace for a soaking host ends
/// two hours after a deploy (worker/src/update.ts `SOAK_GRACE_MAX_MINUTES`), and the last 15
/// minutes of it are the round's — the pull, the replace, the guard — after the soak ends
/// (`SOAK_ROUND_MINUTES`); the 5 left cover the poll that first names the release, which
/// starts the soak's clock after the deploy. A longer soak would meet the 426 gate at its
/// end and idle the host it meant to protect.
pub const MAX_SOAK_MINUTES: u32 = 100;

/// An id the pool hands out (host and worker ids).
fn is_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_plain_absolute(p: &Path) -> bool {
    p.is_absolute()
        && p.components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}

fn is_https_origin(s: &str) -> bool {
    s.strip_prefix("https://").is_some_and(|h| {
        !h.is_empty()
            && h.len() <= 253
            && h.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
    })
}

impl Policy {
    /// The envelope's bounds as agent.toml says them; an architecture the pool does not
    /// build, or a soak longer than the pool's grace for one (#326), is refused.
    fn of(e: &EnvelopePart) -> Result<Self, String> {
        if let Some(bad) = e
            .emulate
            .iter()
            .flatten()
            .find(|a| !ARCHES.contains(&a.as_str()))
        {
            return Err(format!(
                "agent.toml: envelope.emulate names {bad:?}, which is neither x86_64 nor aarch64"
            ));
        }
        if e.soak_minutes > MAX_SOAK_MINUTES {
            return Err(format!(
                "agent.toml: envelope.soak_minutes {}: at most {MAX_SOAK_MINUTES} (the pool's claim grace for a soaking host ends two hours after a deploy, its round included)",
                e.soak_minutes
            ));
        }
        Ok(Policy {
            max_units: e.max_units,
            emulate: e.emulate.clone(),
            diagnostics: e.diagnostics,
            drivers: e
                .drivers
                .clone()
                .unwrap_or_else(|| vec!["compose".to_owned()]),
            soak_minutes: e.soak_minutes,
        })
    }
}

impl Vm {
    /// `[vm]`: the `omarchy` Colima profile, sized by the envelope; `None` for a VM the
    /// agent uses but never manages (Docker Desktop's, `OrbStack`'s).
    fn of(v: VmPart, e: &EnvelopePart) -> Result<Option<Self>, String> {
        match v.runtime.as_str() {
            "colima" => {
                if let Some(p) = v.profile.filter(|p| p != crate::vm::PROFILE) {
                    return Err(format!(
                        "agent.toml: vm.profile {p:?}: the agent's VM is the {} profile",
                        crate::vm::PROFILE
                    ));
                }
                let (Some(cpus), Some(mem_gb)) = (e.max_cpus, e.max_mem_gb) else {
                    return Err("agent.toml: [vm] runtime colima takes its size from envelope.max_cpus and envelope.max_mem_gb (install writes them)".into());
                };
                Ok(Some(Vm {
                    cpus,
                    mem_gb,
                    disk_gb: v.disk_gb.unwrap_or(crate::vm::DISK_GB),
                    rosetta: v.rosetta.unwrap_or(false),
                }))
            }
            "docker-desktop" | "orbstack" => Ok(None),
            other => Err(format!(
                "agent.toml: vm.runtime {other:?} is none of colima, docker-desktop, orbstack"
            )),
        }
    }
}

impl Config {
    pub fn parse(text: &str) -> Result<Self, String> {
        let f: File = toml::from_str(text).map_err(|e| format!("agent.toml: {e}"))?;
        let envelope = Envelope::from_agent_toml(text)?;
        let need =
            |v: Option<String>, k: &str| v.ok_or_else(|| format!("agent.toml: {k} is missing"));
        let need_path = |v: Option<PathBuf>, k: &str| -> Result<PathBuf, String> {
            let p = v.ok_or_else(|| format!("agent.toml: {k} is missing"))?;
            if is_plain_absolute(&p) {
                Ok(p)
            } else {
                Err(format!(
                    "agent.toml: {k} {} is not a plain absolute path",
                    p.display()
                ))
            }
        };
        let pool = need(f.pool, "pool")?;
        if !is_https_origin(&pool) {
            return Err(format!(
                "agent.toml: pool {pool:?} is not an https:// origin"
            ));
        }
        let host_id = need(f.host_id, "host_id")?;
        let worker_id = need(f.worker_id, "worker_id")?;
        for (k, v) in [("host_id", &host_id), ("worker_id", &worker_id)] {
            if !is_id(v) {
                return Err(format!("agent.toml: {k} {v:?} is not an id"));
            }
        }
        let (driver, engine, runtime) = Self::driver_of(&f.set, f.vm.is_some())?;
        let set_name = f.set.name.unwrap_or_else(|| "host".into());
        if set_name != "host" {
            return Err(format!(
                "agent.toml: set.name {set_name:?}: this agent runs the host set only"
            ));
        }
        let unit_dir = match f.set.unit_dir {
            None => None,
            Some(d) if is_plain_absolute(&d) => Some(d),
            Some(d) => {
                return Err(format!(
                    "agent.toml: set.unit_dir {} is not a plain absolute path",
                    d.display()
                ))
            }
        };
        let policy = Policy::of(&f.envelope)?;
        let socket_cli = need_path(f.set.socket_cli, "set.socket_cli")?;
        let socket_mount = match f.set.socket_mount {
            None => socket_cli.clone(),
            some => need_path(some, "set.socket_mount")?,
        };
        let mac = f.vm.is_some();
        let vm = match f.vm {
            None => None,
            Some(v) => Vm::of(v, &f.envelope)?,
        };
        Ok(Config {
            pool,
            host_id,
            worker_id,
            set_name,
            set_dir: need_path(f.set.dir, "set.dir")?,
            work_root: need_path(f.set.work_root, "set.work_root")?,
            secrets_dir: need_path(f.set.secrets_dir, "set.secrets_dir")?,
            project: f.set.project,
            socket_cli,
            socket_mount,
            task_subnets: f.envelope.task_subnets,
            agent_budget: Budget::from_envelope(f.envelope.agent_budget.as_ref())?,
            direct_network: f.envelope.direct_network.unwrap_or(false),
            cache_caps: CacheCaps::from_envelope(f.envelope.cache_caps.as_ref())?,
            envelope,
            engine,
            runtime,
            driver,
            unit_dir,
            policy,
            vm,
            mac,
        })
    }

    /// `[set]`'s driver, engine and runtime, held together: a Quadlet host (#330) runs
    /// rootless podman under a Linux user's systemd.
    fn driver_of(set: &SetPart, vm: bool) -> Result<(DriverKind, Engine, Option<Runtime>), String> {
        let driver = match set.driver.as_deref() {
            None => DriverKind::Compose,
            Some(d) => DriverKind::parse(d).ok_or_else(|| {
                format!("agent.toml: set.driver {d:?}: this agent carries the compose and quadlet drivers")
            })?,
        };
        let engine = match set.engine.as_deref() {
            // A Quadlet host's podman runs as the user, under the user's systemd.
            None if driver == DriverKind::Quadlet => Engine::Rootless,
            None | Some("rootful") => Engine::Rootful,
            Some("rootless") => Engine::Rootless,
            Some(other) => {
                return Err(format!(
                    "agent.toml: set.engine {other:?} is neither \"rootful\" nor \"rootless\""
                ))
            }
        };
        let runtime = match set.runtime.as_deref() {
            None => None,
            Some(r) => Some(Runtime::parse(r).ok_or_else(|| {
                format!("agent.toml: set.runtime {r:?} is neither \"docker\" nor \"podman\"")
            })?),
        };
        if driver == DriverKind::Compose {
            return Ok((driver, engine, runtime));
        }
        if vm {
            return Err("agent.toml: set.driver \"quadlet\" runs under a Linux user's systemd; a Mac's bundle runs in its VM (#320)".into());
        }
        if engine != Engine::Rootless || runtime == Some(Runtime::Docker) {
            return Err("agent.toml: set.driver \"quadlet\" is rootless podman's: set.engine \"rootless\", set.runtime \"podman\" or none".into());
        }
        Ok((driver, engine, Some(Runtime::Podman)))
    }

    /// The driver as the report and `runtime switch` say it: `quadlet`, or
    /// `compose/<runtime>` once the engine said which it is.
    pub fn driver_name(&self) -> Option<String> {
        match self.driver {
            DriverKind::Quadlet => Some(DriverKind::Quadlet.word().to_owned()),
            DriverKind::Compose => self.runtime.map(Runtime::driver),
        }
    }

    /// Where the Quadlet driver's units go: `set.unit_dir`, else where podman's generator
    /// reads a user's (`$XDG_CONFIG_HOME/containers/systemd`, `~/.config/...`).
    pub fn quadlet_dir(&self) -> Result<PathBuf, String> {
        if let Some(d) = &self.unit_dir {
            return Ok(d.clone());
        }
        let var = |k: &str| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        var("XDG_CONFIG_HOME")
            .or_else(|| var("HOME").map(|h| h.join(".config")))
            .map(|c| c.join("containers/systemd"))
            .ok_or_else(|| {
                "neither set.unit_dir, XDG_CONFIG_HOME nor HOME says where the Quadlet units go"
                    .into()
            })
    }

    /// Reads agent.toml, refusing one another user owns or others may write. `uid` is
    /// the agent's own (the owner of a file it just wrote).
    pub fn load(path: &Path, uid: u32) -> Result<Self, String> {
        let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if meta.uid() != uid {
            return Err(format!(
                "{}: owned by uid {}, not this agent's {uid}",
                path.display(),
                meta.uid()
            ));
        }
        if meta.mode() & 0o022 != 0 {
            return Err(format!(
                "{}: group- or world-writable (mode {:o})",
                path.display(),
                meta.mode() & 0o777
            ));
        }
        let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::parse(&text)
    }

    /// The variables the set template interpolates, from agent.toml only.
    pub(crate) fn interpolation(&self) -> Vec<(String, String)> {
        let mut env = vec![
            (
                "OMARCHY_WORK_ROOT".to_owned(),
                self.work_root.display().to_string(),
            ),
            (
                "OMARCHY_SECRETS_DIR".to_owned(),
                self.secrets_dir.display().to_string(),
            ),
            (
                "OMARCHY_SOCKET".to_owned(),
                self.socket_mount.display().to_string(),
            ),
        ];
        if let Some(s) = &self.task_subnets {
            env.push(("OMARCHY_TASK_SUBNETS".to_owned(), s.clone()));
        }
        env
    }
}

/// `text` with `[<table>]`'s `keys` set line by line — each `key = <TOML value>`, or taken
/// out when its value is `None` —: a key's line replaced (or dropped) where it is, a
/// missing one added after the section's last key, a missing section added at the end;
/// every other line as it was. agent.toml is the owner's policy document (design v2 §12),
/// so the runtime switch (#325, `[set]`) and a signed widening (#328, `[envelope]`) change
/// only their keys' lines, and the owner's comments and layout stay. A caller reads the
/// result back: a layout the line edit cannot name a value in (a dotted key, a sub-table, a
/// value over several lines) is written again from its table instead.
pub(crate) fn table_lines(text: &str, table: &str, keys: &[(&str, Option<String>)]) -> String {
    let mut out: Vec<String> = Vec::new();
    // A key to take out needs no line added when the file lacks it.
    let mut done: Vec<bool> = keys.iter().map(|(_, v)| v.is_none()).collect();
    // While in the table: the index of its last line that is a key or its header.
    let mut last: Option<usize> = None;
    let mut seen = false;
    let add = |out: &mut Vec<String>, done: &mut [bool], at: usize| {
        let missing: Vec<String> = keys
            .iter()
            .zip(done.iter())
            .filter(|(_, d)| !**d)
            .filter_map(|((k, v), _)| v.as_ref().map(|v| format!("{k} = {v}")))
            .collect();
        out.splice(at..at, missing);
        done.fill(true);
    };
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with('[') {
            if let Some(i) = last.take() {
                add(&mut out, &mut done, i + 1);
            }
            let name = t.trim_start_matches('[').split(']').next().unwrap_or("");
            if !t.starts_with("[[") && name.trim() == table {
                seen = true;
                last = Some(out.len());
            }
            out.push(line.to_owned());
            continue;
        }
        if let Some(i) = last.as_mut() {
            if !t.is_empty() && !t.starts_with('#') {
                let key = t.split_once('=').map(|(k, _)| k.trim().trim_matches('"'));
                if let Some(k) = key.and_then(|k| keys.iter().position(|(n, _)| *n == k)) {
                    done[k] = true;
                    if let Some(v) = &keys[k].1 {
                        *i = out.len();
                        let indent = &line[..line.len() - t.len()];
                        out.push(format!("{indent}{} = {v}", keys[k].0));
                    }
                    continue;
                }
                *i = out.len();
            }
        }
        out.push(line.to_owned());
    }
    if let Some(i) = last {
        add(&mut out, &mut done, i + 1);
    }
    if !seen && done.iter().any(|d| !d) {
        out.push(String::new());
        out.push(format!("[{table}]"));
        let at = out.len();
        add(&mut out, &mut done, at);
    }
    out.join("\n") + "\n"
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn example(set_dir: &Path, work_root: &Path, secrets: &Path) -> String {
        format!(
            r#"pool = "https://pkgs.omarchy-pool.org"
host_id = "h_test"
worker_id = "m1-test-0a9z"
[set]
dir = "{}"
work_root = "{}"
secrets_dir = "{}"
socket_cli = "/var/run/docker.sock"
[envelope]
allow_socket = true
rootful_ack = true
dedicated = true
max_units = 3
"#,
            set_dir.display(),
            work_root.display(),
            secrets.display()
        )
    }

    #[test]
    fn reads_the_design_example_and_refuses_what_it_cannot_run() {
        let studio = include_str!("../../tests/fixtures/lint/envelope/studio.toml");
        let e = Config::parse(studio).unwrap_err();
        assert!(e.contains("worker_id is missing"), "{e}");
        let c = Config::parse(&format!("worker_id = \"w_1\"\n{studio}")).unwrap();
        assert_eq!(c.project.as_deref(), Some("omarchy-host"));
        assert_eq!(c.task_subnets.as_deref(), Some("10.232.0.0/16"));
        assert!(c.envelope.allow_socket);
        // No `[vm]`: not a Mac, so nothing of its sleep (#329).
        assert!(!c.mac);
        // The design's budget, for etc/dispatcher.env (#371); the other two keep their defaults.
        assert_eq!(
            c.agent_budget,
            Budget {
                calls_per_task: Some(200),
                calls_per_day: Some(5000),
                ..Budget::default()
            }
        );
        // And its cache caps (#341), for the dispatcher's task caches.
        assert_eq!(
            c.cache_caps,
            CacheCaps {
                pacman_gb: Some(40),
                build_gb: Some(120)
            }
        );
        for (from, to, why) in [
            (
                "https://omarchy-pool.example.org",
                "http://x",
                "not an https://",
            ),
            (
                "driver       = \"compose\"",
                "driver = \"kube\"",
                "carries the compose and quadlet drivers",
            ),
            (
                "/var/run/docker.sock\"\nsocket_mount",
                "docker.sock\"\nsocket_mount",
                "plain absolute",
            ),
            (
                "calls_per_day = 5000",
                "calls_per_day = 0",
                "agent_budget.calls_per_day must be a whole number from 1",
            ),
            (
                "pacman_gb = 40",
                "pacman_gb = 0",
                "cache_caps.pacman_gb must be a whole number of GB from 1",
            ),
        ] {
            let text = format!("worker_id = \"w_1\"\n{}", studio.replacen(from, to, 1));
            let e = Config::parse(&text).unwrap_err();
            assert!(e.contains(why), "{why}: {e}");
        }
    }

    #[test]
    fn the_grant_of_a_signed_exception_s_bridge_is_read_strictly_and_reaches_the_dispatcher() {
        let studio = include_str!("../../tests/fixtures/lint/envelope/studio.toml");
        let with = |line: &str| {
            format!(
                "worker_id = \"w_1\"\n{}",
                studio.replacen("[envelope]\n", &format!("[envelope]\n{line}\n"), 1)
            )
        };
        let rendered = |c: &Config| {
            crate::dispatcher_env::Rendered {
                addresses: Vec::new(),
                envelope: Some(crate::dispatcher_env::Envelope::of_config(c)),
                plain: false,
                keys_user: None,
            }
            .lines()
            .unwrap()
        };
        // No key: no grant, and no line for the dispatcher, which hands such a package back.
        let c = Config::parse(&with("")).unwrap();
        assert!(!c.direct_network);
        assert!(!rendered(&c)
            .iter()
            .any(|l| l.starts_with("OMARCHY_DIRECT_NETWORK")));
        // The grant (#373): the run loop writes it into etc/dispatcher.env.
        let c = Config::parse(&with("direct_network = true")).unwrap();
        assert!(c.direct_network);
        assert!(rendered(&c).contains(&"OMARCHY_DIRECT_NETWORK=1".to_owned()));
        let c = Config::parse(&with("direct_network = false")).unwrap();
        assert!(!c.direct_network);
        assert!(!rendered(&c)
            .iter()
            .any(|l| l.starts_with("OMARCHY_DIRECT_NETWORK")));
        // Anything but true or false is a configuration error (the loop exits 78), never read
        // as a grant or as none.
        for bad in ["direct_network = \"yes\"", "direct_network = 1"] {
            let e = Config::parse(&with(bad)).unwrap_err();
            assert!(e.contains("direct_network"), "{bad}: {e}");
        }
    }

    #[test]
    fn the_envelope_bounds_what_the_pool_may_narrow_and_ask() {
        let studio = include_str!("../../tests/fixtures/lint/envelope/studio.toml");
        let c = Config::parse(&format!("worker_id = \"w_1\"\n{studio}")).unwrap();
        assert_eq!(
            c.policy,
            Policy {
                max_units: Some(11),
                emulate: Some(vec!["x86_64".into()]),
                diagnostics: false,
                drivers: vec!["compose".into()],
                soak_minutes: 0,
            }
        );
        // The owner's soak (#326): up to 100 minutes, so that it, its first poll and its round
        // fit in the pool's two-hour grace for a soaking host.
        let soak = |m: &str| {
            Config::parse(&format!(
                "worker_id = \"w_1\"\n{}",
                studio.replace("soak_minutes = 0", &format!("soak_minutes = {m}"))
            ))
        };
        assert_eq!(soak("30").unwrap().policy.soak_minutes, 30);
        assert_eq!(soak("100").unwrap().policy.soak_minutes, 100);
        assert!(soak("101").unwrap_err().contains("at most 100"));
        assert!(soak("120").unwrap_err().contains("at most 100"));
        assert!(soak("-5").is_err());
        assert!(c.policy.allows_lane("x86_64") && !c.policy.allows_lane("aarch64"));
        assert!(c.policy.allows_driver(Runtime::Podman));
        // No set.runtime (install writes none): the engine is asked which it is.
        assert_eq!(c.runtime, None);
        // No emulate key: detection decides; [] turns every emulated lane off.
        let open = Config::parse(&format!(
            "worker_id = \"w_1\"\n{}",
            studio.replace("emulate      = [\"x86_64\"]\n", "")
        ))
        .unwrap();
        assert!(open.policy.emulate.is_none() && open.policy.allows_lane("aarch64"));
        let only_docker = Config::parse(&format!(
            "worker_id = \"w_1\"\n{}",
            studio.replace(
                "drivers      = [\"compose\"]",
                "drivers = [\"compose/docker\"]"
            )
        ))
        .unwrap();
        assert!(!only_docker.policy.allows_driver(Runtime::Podman));
        for (from, to, why) in [
            (
                "emulate      = [\"x86_64\"]",
                "emulate = [\"riscv64\"]",
                "neither x86_64 nor aarch64",
            ),
            (
                "driver       = \"compose\"",
                "driver = \"compose\"\nruntime = \"lxc\"",
                "neither \"docker\" nor \"podman\"",
            ),
        ] {
            let e = Config::parse(&format!(
                "worker_id = \"w_1\"\n{}",
                studio.replacen(from, to, 1)
            ))
            .unwrap_err();
            assert!(e.contains(why), "{why}: {e}");
        }
        let podman = Config::parse(&format!(
            "worker_id = \"w_1\"\n{}",
            studio.replace(
                "driver       = \"compose\"",
                "driver = \"compose\"\nruntime = \"podman\""
            )
        ))
        .unwrap();
        assert_eq!(podman.runtime, Some(Runtime::Podman));
    }

    #[test]
    fn a_macs_vm_takes_its_size_from_the_envelope() {
        let mac = include_str!("../../tests/fixtures/lint/envelope/mac.toml");
        let c = Config::parse(&format!("worker_id = \"w_1\"\n{mac}")).unwrap();
        assert_eq!(
            c.vm,
            Some(Vm {
                cpus: 8,
                mem_gb: 32,
                disk_gb: 100,
                rosetta: true
            })
        );
        assert_eq!(c.socket_mount, Path::new("/var/run/docker.sock"));
        assert_eq!(c.envelope.vm_mounts.as_ref().map(Vec::len), Some(3));
        for (from, to, why) in [
            ("max_cpus     = 8\n", "", "takes its size"),
            (
                "profile = \"omarchy\"",
                "profile = \"default\"",
                "the omarchy profile",
            ),
            (
                "runtime = \"colima\"",
                "runtime = \"podman\"",
                "none of colima",
            ),
        ] {
            let e = Config::parse(&format!(
                "worker_id = \"w_1\"\n{}",
                mac.replacen(from, to, 1)
            ))
            .unwrap_err();
            assert!(e.contains(why), "{why}: {e}");
        }
        assert!(c.mac);
        // Docker Desktop's VM and OrbStack's are used, never managed; the host is a Mac all
        // the same (#329).
        for runtime in ["docker-desktop", "orbstack"] {
            let shared = mac.replace("runtime = \"colima\"", &format!("runtime = {runtime:?}"));
            let c = Config::parse(&format!("worker_id = \"w_1\"\n{shared}")).unwrap();
            assert_eq!(c.vm, None, "{runtime}");
            assert!(c.mac, "{runtime}");
        }
    }

    #[test]
    fn refuses_a_file_others_may_write() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::run::state::tempdir();
        let p = dir.join("agent.toml");
        fs::write(
            &p,
            example(&dir.join("set"), &dir.join("work"), &dir.join("secrets")),
        )
        .unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
        let uid = fs::metadata(&p).unwrap().uid();
        Config::load(&p, uid).unwrap();
        assert!(Config::load(&p, uid + 1)
            .unwrap_err()
            .contains("owned by uid"));
        fs::set_permissions(&p, fs::Permissions::from_mode(0o620)).unwrap();
        assert!(Config::load(&p, uid).unwrap_err().contains("writable"));
    }
}
