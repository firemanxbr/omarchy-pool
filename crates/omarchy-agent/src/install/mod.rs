//! `omarchy-agent install`, `preflight` and `uninstall` on Linux (P1, #317; design v2
//! §13.2, §13.3, §19.1).
//!
//! install, in order:
//! 1. verifies the release bundle (`--release`, which install.sh passes, or `--bundle`
//!    with `--sig`) and that this binary is the agent it ships; refuses a `--pool`
//!    outside its signed `pools`;
//! 2. finds the engine's socket (rootless podman's API socket, rootless docker, the
//!    rootful daemon), fetches the release's pinned docker CLI and compose plugin into the
//!    agent's own `tools/` (hash-checked; preflight measures through them), and runs
//!    **preflight**: any blocker stops it, with one screen listing everything to fix,
//!    before anything else is written;
//! 3. prints the envelope (agent.toml) for the person to confirm on `/dev/tty` (`--yes`
//!    skips) and writes `run/capacity.json`;
//! 4. enrolls (#321): the owner's Confirm, then the host worker token;
//! 5. only then writes agent.toml, with the `host_id` and `worker_id` enrollment gave:
//!    before it there is no run loop, no dispatcher, and nothing claims;
//! 6. the agent keys into `OMARCHY_SECRETS_DIR/agent.env`, outside the work root;
//! 7. with `--legacy <project>`, `legacy.json`, changing nothing in that project;
//! 8. the systemd --user unit, linger, and the service started: the run loop's first
//!    round renders, pulls and starts the bundle — the same code as every later round,
//!    not a second copy of it here;
//! 9. prints the host, its capacity, lane, units, isolation and the host key fingerprint.
//!
//! Re-running it repairs the install and keeps the identity and the owner's envelope.
//! Every owner file is written through [`files`] (`openat`, `O_NOFOLLOW`).
//!
//! Seams left for later issues, by name: macOS (launchd, Colima) is P3; the egress probe
//! behind the egress sidecar on an internal network, once the worker image has it
//! ([`egress`]); the `subuid` level for rootless podman, once the dispatcher (#335) starts
//! task containers with `--userns=auto` (until then rootless podman reads as `user`); the
//! emulated lane's smoke run (#338, reported only here); task containers and sidecars
//! carry `org.omarchy-pool.agent.host=<host>` (design v2 §9.3), which uninstall removes by.

pub mod checks;

pub(crate) mod egress;
pub(crate) mod engine;
pub(crate) mod envelope;
pub(crate) mod files;
pub(crate) mod legacy;
pub(crate) mod net;
pub(crate) mod secrets;
mod sys;
pub(crate) mod unit;

pub use sys::Machine;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::capacity::{self, probe, Capacity, Caps, Facts};
use crate::enroll;
use crate::host::{HostKey, Identity, KEY_FILE};
use crate::manifest::Manifest;
use crate::run::{tools, Verifier};
use crate::verify::BundleOutcome;
use crate::version::Release;

pub use checks::Report;
use engine::Docker;
use net::Cidr;

/// The task subnets when none are given (the host set's own default).
pub const TASK_SUBNETS: &str = "10.231.0.0/16";
const HOST_LABEL: &str = "org.omarchy-pool.agent.host";
const PROJECT_LABEL: &str = "com.docker.compose.project";

/// Where things are on this machine; from the environment in production, temporary
/// directories in the tests.
#[derive(Debug, Clone)]
pub struct Places {
    pub data: PathBuf,
    pub home: PathBuf,
    /// `$XDG_CONFIG_HOME`: the unit goes to its `systemd/user/`.
    pub config_home: PathBuf,
    pub xdg_runtime_dir: Option<PathBuf>,
    pub user: String,
    pub os: &'static str,
    pub linger_dir: PathBuf,
    pub routes: PathBuf,
    pub binfmt: PathBuf,
}

impl Places {
    pub fn from_env(data_flag: Option<&str>) -> Result<Self, String> {
        let var = |k: &str| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        let home = var("HOME").ok_or("HOME is not set")?;
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .ok()
            .filter(|u| !u.is_empty())
            .ok_or("USER is not set")?;
        Ok(Places {
            data: crate::run::config::data_dir(data_flag)?,
            config_home: var("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")),
            home,
            xdg_runtime_dir: var("XDG_RUNTIME_DIR"),
            user,
            os: std::env::consts::OS,
            linger_dir: PathBuf::from("/var/lib/systemd/linger"),
            routes: PathBuf::from("/proc/net/route"),
            binfmt: PathBuf::from("/proc/sys/fs/binfmt_misc"),
        })
    }

    pub fn set_dir(&self) -> PathBuf {
        self.data.join("sets").join("host")
    }
    pub fn unit_dir(&self) -> PathBuf {
        self.config_home.join("systemd").join("user")
    }
    fn agent_toml(&self) -> PathBuf {
        self.data.join("agent.toml")
    }
    fn enroll_paths(&self) -> enroll::Paths {
        enroll::Paths::under(&self.data)
    }
}

/// Which release to install.
#[derive(Debug, Clone)]
pub enum Source {
    /// From GitHub: what install.sh passes (`--release`).
    Release(Release),
    /// Local files: `--bundle` and `--sig`.
    Files(PathBuf, PathBuf),
}

/// What `install` and `preflight` are told.
#[derive(Debug, Clone)]
#[allow(clippy::struct_excessive_bools)] // the person's switches, one for one
pub struct Options {
    pub places: Places,
    pub source: Option<Source>,
    pub pool: Option<String>,
    pub work_root: Option<PathBuf>,
    pub secrets_dir: Option<PathBuf>,
    pub socket: Option<PathBuf>,
    pub task_subnets: Option<String>,
    /// The person says this is a machine or VM used only as a pool host (design v2 §19.1).
    pub dedicated: bool,
    pub legacy: Option<String>,
    pub agent_env_from: Option<PathBuf>,
    pub max_units: Option<u32>,
    pub max_cpus: Option<u32>,
    pub max_mem_gb: Option<u32>,
    pub yes: bool,
    /// `OMARCHY_ENROLL`, from the environment only.
    pub token: Option<String>,
    pub wait: Duration,
    pub poll: Duration,
    /// The binary whose hash must be the release's agent (this one, by default).
    pub exe: Option<PathBuf>,
}

/// What the person's machine does for install: the terminal, the network, systemd.
pub trait Sys {
    /// `systemctl` or `loginctl` with `args`: its stdout, or why it failed.
    fn run(&mut self, prog: &str, args: &[&str]) -> Result<String, String>;
    /// Shows `text` on `/dev/tty` and asks yes or no.
    fn confirm(&mut self, text: &str) -> Result<bool, String>;
    /// `KEY=value` lines typed on `/dev/tty` without echo, until an empty line.
    fn ask_keys(&mut self, text: &str) -> Result<String, String>;
    /// GitHub's `X-OAuth-Scopes` for `token` (`None` when it names none).
    fn github_scopes(&mut self, token: &str) -> Result<Option<String>, String>;
    /// A release asset or a pinned tool, over HTTPS.
    fn download(&mut self, url: &str) -> Result<Vec<u8>, String>;
}

#[derive(Debug)]
pub enum Failure {
    /// Preflight's blockers, a refusal, or the person said no: nothing past it was done.
    Refused(String),
    NeedsNewerAgent(String),
    /// Nobody confirmed the host in time; re-running continues.
    TimedOut(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Refused(s) | Failure::NeedsNewerAgent(s) | Failure::TimedOut(s) => {
                f.write_str(s)
            }
        }
    }
}

/// Everything preflight measured, for the steps after it.
pub(crate) struct Ready {
    pub manifest: Manifest,
    pub pool: String,
    pub capacity: Capacity,
    pub facts: Facts,
    pub values: envelope::Values,
    pub legacy: Option<legacy::Seen>,
    pub existing: Option<String>,
}

fn say(out: &mut dyn Write, line: &str) {
    let _ = writeln!(out, "omarchy-agent: {line}");
}

/// The verified release: its manifest.
fn release(o: &Options, sys: &mut dyn Sys, verifier: &dyn Verifier) -> Result<Manifest, Failure> {
    let (archive, sig) = match &o.source {
        Some(Source::Files(b, s)) => {
            let read = |p: &Path| std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()));
            (
                read(b).map_err(Failure::Refused)?,
                read(s).map_err(Failure::Refused)?,
            )
        }
        Some(Source::Release(r)) => {
            let (name, sig) = crate::run::bundle_names(*r);
            let url = |n: &str| format!("{}/{r}/{n}", crate::run::RELEASES);
            (
                sys.download(&url(&name)).map_err(Failure::Refused)?,
                sys.download(&url(&sig)).map_err(Failure::Refused)?,
            )
        }
        None => {
            return Err(Failure::Refused(
                "give --release vX.Y.Z (install.sh passes it) or --bundle with --sig".into(),
            ))
        }
    };
    match verifier.bundle(&archive, &sig) {
        Ok(BundleOutcome::Current(b)) => Ok(b.manifest().clone()),
        Ok(BundleOutcome::NeedsNewerAgent { why, .. }) => Err(Failure::NeedsNewerAgent(format!(
            "needs a newer agent: {why}"
        ))),
        Err(r) => Err(Failure::Refused(format!(
            "the release bundle is refused ({}): {r}",
            r.reason()
        ))),
    }
}

/// This binary is the agent the release ships for this platform.
fn own_hash(m: &Manifest, exe: &Path) -> Result<(), String> {
    let platform = tools::platform().ok_or("no agent ships for this platform")?;
    let asset = m.outer().agent().asset(platform).ok_or_else(|| {
        format!(
            "release v{} ships no agent for {platform}",
            m.outer().release()
        )
    })?;
    let want = hex::encode(asset.sha256().as_bytes());
    let have = tools::file_sha256(exe)?;
    if have == want {
        Ok(())
    } else {
        Err(format!(
            "{}: SHA-256 {have} is not the agent release v{} ships ({want}); run the release's install.sh",
            exe.display(),
            m.outer().release()
        ))
    }
}

/// The pool: `--pool` when it is one of the signed `pools`, else the one this machine
/// enrolled with, else the first signed one.
pub(crate) fn choose_pool(
    given: Option<&str>,
    enrolled: Option<&str>,
    signed: &[String],
) -> Result<String, String> {
    let want = given
        .or(enrolled)
        .unwrap_or_else(|| signed.first().map_or("", String::as_str));
    let want = want.trim_end_matches('/');
    if signed.iter().any(|p| p.trim_end_matches('/') == want) {
        Ok(want.to_owned())
    } else {
        Err(format!(
            "the pool {want:?} is not one this release signs ({})",
            signed.join(", ")
        ))
    }
}

/// The nearest directory that exists, from `p` up: where free disk is measured for a work
/// root install has not made yet.
fn existing_ancestor(p: &Path) -> PathBuf {
    let mut d = p.to_path_buf();
    while !d.is_dir() {
        if !d.pop() {
            return PathBuf::from("/");
        }
    }
    d
}

/// The engine's networks other than the agent's own and the legacy project's: `(name,
/// subnets)`.
fn other_networks(
    docker: &Docker,
    project: &str,
    legacy: Option<&str>,
) -> Result<Vec<(String, Vec<Cidr>)>, String> {
    let ids = docker.run(&["network", "ls", "-q", "--no-trunc"])?;
    let ids: Vec<&str> = ids.split_whitespace().collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec![
        "network",
        "inspect",
        "--format",
        "{{.Name}}\t{{index .Labels \"com.docker.compose.project\"}}\t{{index .Labels \"org.omarchy-pool.agent.host\"}}\t{{range .IPAM.Config}}{{.Subnet}} {{end}}",
    ];
    args.extend(ids);
    Ok(docker
        .run(&args)?
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').map(str::trim).collect();
            let (name, proj, host) = (*f.first()?, *f.get(1)?, *f.get(2)?);
            let ours = proj == project
                || Some(proj) == legacy
                || !host.is_empty()
                || name.starts_with("omarchy-egress-probe-");
            (!name.is_empty() && !ours).then(|| {
                (
                    name.to_owned(),
                    f.get(3)
                        .map(|s| s.split_whitespace().filter_map(Cidr::parse).collect())
                        .unwrap_or_default(),
                )
            })
        })
        .collect())
}

/// `omarchy-agent preflight`: one screen, changing nothing but the agent's own cache of
/// the release's hash-checked tools.
pub fn preflight(o: &Options, sys: &mut dyn Sys) -> Result<Report, Failure> {
    measure(o, sys, &crate::run::Sigstore, None).map(|(r, _)| r)
}

/// Preflight's report, and what install needs when nothing blocks.
#[allow(clippy::too_many_lines, clippy::many_single_char_names)] // one check after another, in the screen's order
pub(crate) fn measure(
    o: &Options,
    sys: &mut dyn Sys,
    verifier: &dyn Verifier,
    docker_cli: Option<&Path>,
) -> Result<(Report, Option<Ready>), Failure> {
    let p = &o.places;
    let mut r = Report::default();
    if p.os != "linux" {
        r.blockers.push(format!(
            "this is {}: install runs on Linux in P1; macOS (launchd, the Colima VM) comes in P3",
            p.os
        ));
    }
    let existing = std::fs::read_to_string(p.agent_toml()).ok();
    let ex = existing.as_deref();
    let enrolled = Identity::read(&p.enroll_paths().state).ok().flatten();

    // The release, the pool and this binary.
    let manifest = match release(o, sys, verifier) {
        Ok(m) => Some(m),
        Err(Failure::Refused(e)) => {
            r.blockers.push(e);
            None
        }
        Err(other) => return Err(other),
    };
    let mut pool = None;
    if let Some(m) = &manifest {
        r.notes.push(format!(
            "release: v{}, agent {}",
            m.outer().release(),
            m.outer().agent().version()
        ));
        match choose_pool(
            o.pool.as_deref(),
            enrolled.as_ref().map(|i| i.pool.as_str()),
            m.pools(),
        ) {
            Ok(x) => pool = Some(x),
            Err(e) => r.blockers.push(e),
        }
        let exe = o.exe.clone().or_else(|| std::env::current_exe().ok());
        match &exe {
            Some(exe) => {
                if let Err(e) = own_hash(m, exe) {
                    r.blockers.push(e);
                }
            }
            None => r
                .blockers
                .push("this binary's path is unknown, so its hash cannot be checked".into()),
        }
        // The unit starts `<data>/current/omarchy-agent`, where install.sh puts it: a
        // `--data-dir` or `OMARCHY_AGENT_DATA` other than install.sh's has no agent there.
        let current = p.data.join("current").join("omarchy-agent");
        let same = |a: &Path| a.canonicalize().ok() == current.canonicalize().ok();
        if !exe.as_deref().is_some_and(same) {
            if let Err(e) = own_hash(m, &current) {
                r.blockers.push(format!(
                    "the unit would start {}, which is not this release's agent ({e}); run install.sh, or give the data directory it used ({})",
                    current.display(),
                    p.data.display()
                ));
            }
        }
    }

    // Where things go.
    let set_dir = p.set_dir();
    let work_root = o
        .work_root
        .clone()
        .or_else(|| envelope::set_path(ex, "work_root"))
        .unwrap_or_else(|| p.data.join("work"));
    let secrets_dir = o
        .secrets_dir
        .clone()
        .or_else(|| envelope::set_path(ex, "secrets_dir"))
        .unwrap_or_else(|| p.data.join("secrets"));
    for (what, d) in [
        ("work root", &work_root),
        ("secrets directory", &secrets_dir),
    ] {
        if !crate::lint::is_plain_absolute(d) {
            r.blockers.push(format!(
                "the {what} {} is not a plain absolute path",
                d.display()
            ));
        }
    }
    if let Err(e) = secrets::outside(&secrets_dir, &work_root, &set_dir) {
        r.blockers.push(e);
    }
    if let Err(e) = unit::render(&p.data) {
        r.blockers.push(e);
    }
    let task_subnets = o
        .task_subnets
        .clone()
        .or_else(|| {
            envelope::envelope_value(ex, "task_subnets").and_then(|v| v.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| TASK_SUBNETS.to_owned());
    let task = match net::parse_list(&task_subnets) {
        Ok(t) => t,
        Err(e) => {
            r.blockers.push(format!("task subnets: {e}"));
            Vec::new()
        }
    };
    let dedicated = o.dedicated
        || envelope::envelope_value(ex, "dedicated").and_then(|v| v.as_bool()) == Some(true);
    let project = envelope::set_str(ex, "project").unwrap_or_else(|| envelope::PROJECT.to_owned());
    if let Some(l) = &o.legacy {
        if !legacy::valid_project(l) {
            r.blockers
                .push(format!("--legacy {l:?} is not a compose project name"));
        } else if *l == project {
            r.blockers
                .push(format!("--legacy {l:?} is the new bundle's own project"));
        }
    }

    // The owner files already there.
    for f in [
        p.agent_toml(),
        set_dir.join("compose.override.yml"),
        set_dir.join(".env"),
        p.enroll_paths().dispatcher_env(),
        secrets_dir.join("agent.env"),
    ] {
        if let Err(e) = files::check_owner_file(&f) {
            r.blockers.push(e);
        }
    }
    // The directories install would write into, where they exist already (prep-root.sh
    // makes the work root): the agent's own, writable by it alone.
    // Nothing in a data directory that fails it is run (its tools/ above all).
    let tools_dir = p.data.join("tools");
    let mut trusted = true;
    for d in [&p.data, &tools_dir, &set_dir, &work_root, &secrets_dir] {
        if d.exists() {
            if let Err(e) = files::owned_dir(d) {
                trusted &= *d != p.data && *d != tools_dir;
                r.blockers.push(e);
            }
        }
    }
    // A work root to make (prep-root.sh makes it where root owns the parent) must be
    // makeable by this user, or apply would fail after the person confirmed.
    if !work_root.exists() {
        let parent = existing_ancestor(&work_root);
        if rustix::fs::access(&parent, rustix::fs::Access::WRITE_OK).is_err() {
            r.blockers.push(format!(
                "the work root {} does not exist and {} is not writable by this user: run factory/host/prep-root.sh --work-root {}",
                work_root.display(),
                parent.display(),
                work_root.display()
            ));
        }
    }

    // The engine.
    let given = o
        .socket
        .clone()
        .or_else(|| envelope::set_path(ex, "socket_cli"));
    let socket = match engine::discover(
        given.as_deref(),
        &engine::candidates(p.xdg_runtime_dir.as_deref()),
        engine::connect,
    ) {
        Ok(s) => Some(s),
        Err(e) => {
            r.blockers.push(e);
            None
        }
    };
    let cli = match (docker_cli, &manifest) {
        _ if !trusted => {
            r.notes.push(
                "the engine was not measured: the data directory's tools are not run until it is fixed".into(),
            );
            None
        }
        (Some(c), _) => Some(c.to_path_buf()),
        (None, Some(m)) => match tools::platform() {
            Some(platform) => {
                match tools::ensure(&tools_dir, m, platform, &mut |u| sys.download(u)) {
                    Ok(t) => Some(t.docker),
                    Err(e) => {
                        r.blockers
                            .push(format!("the release's pinned docker CLI: {e}"));
                        None
                    }
                }
            }
            None => None,
        },
        (None, None) => None,
    };
    let docker = socket.zip(cli).map(|(socket, cli)| Docker { cli, socket });
    let image = manifest
        .as_ref()
        .and_then(|m| m.build_image(std::env::consts::ARCH))
        .map(ToString::to_string);
    let facts = docker.as_ref().and_then(|d| {
        let host = d.host();
        let how = probe::Probe {
            docker: &d.cli.to_string_lossy(),
            host: Some(&host),
            work_root: &existing_ancestor(&work_root),
            image: image.as_deref(),
        };
        match probe::detect(&how) {
            Ok(f) => Some(f),
            Err(e) => {
                r.blockers.push(format!("the engine did not answer: {e}"));
                None
            }
        }
    });
    let caps = Caps {
        max_units: o.max_units,
        max_cpus: o.max_cpus,
        max_mem_gb: o.max_mem_gb,
        dedicated,
        ..Caps::default()
    };
    let capacity = facts.as_ref().zip(manifest.as_ref()).map(|(f, m)| {
        let c = Capacity::new(f, &caps, m.capacity());
        r.blockers.extend(capacity::preflight(&c));
        r.notes.push(format!(
            "capacity: {} CPUs, {} GB, disks {} GB (work root) and {} GB (engine), {} units on the {} lane",
            c.cpus(),
            c.mem_gb(),
            c.disk_free_gb().work,
            c.disk_free_gb().engine,
            c.units(),
            f.arch()
        ));
        c
    });
    if let Some(f) = &facts {
        checks::hosting(
            f.isolation(),
            !f.rootless(),
            dedicated,
            o.legacy.is_some(),
            &mut r,
        );
        checks::emulation(f.arch(), Some(f.page_kb()), &p.binfmt, &mut r);
    }
    checks::credentials_verdict(&checks::credentials(&p.home), dedicated, &mut r);
    if p.os == "linux" {
        checks::user_manager(&p.user, &p.linger_dir, p.xdg_runtime_dir.as_deref(), &mut r);
    }

    // Networks: the host's routes, other projects', egress.
    let routes = std::fs::read_to_string(&p.routes)
        .map(|t| net::parse_routes(&t))
        .unwrap_or_default();
    let mut legacy_seen = None;
    if let Some(d) = &docker {
        match other_networks(d, &project, o.legacy.as_deref()) {
            Ok(n) => checks::subnets(&task, &routes, &n, &mut r),
            Err(e) => r.blockers.push(format!("the engine's networks: {e}")),
        }
        if let Some(l) = o.legacy.as_deref().filter(|l| legacy::valid_project(l)) {
            match legacy::look(d, l) {
                Ok(seen) => {
                    r.blockers
                        .extend(legacy::check(l, &seen, &work_root, &task));
                    r.notes.push(format!(
                        "legacy: {l}, {} container(s), recorded only and left running",
                        seen.containers.len()
                    ));
                    legacy_seen = Some(seen);
                }
                Err(e) => r.blockers.push(format!("legacy: {e}")),
            }
        }
        match (task.first().and_then(|t| t.last_28()), &image) {
            (Some(subnet), Some(img)) => {
                let t = egress::Targets::of_host(net::default_gateway(&routes), net::lan_address());
                match egress::probe(d, img, subnet, &t) {
                    Ok(out) => {
                        let b = egress::verdict(&out, &t);
                        if b.is_empty() {
                            r.notes
                                .push("egress: a task reaches public addresses only".into());
                        }
                        r.blockers.extend(b);
                    }
                    Err(e) => r.blockers.push(format!("egress: {e}")),
                }
            }
            _ => r
                .blockers
                .push("egress: not probed (no task subnet or release image)".into()),
        }
    } else {
        checks::subnets(&task, &routes, &[], &mut r);
        r.notes.push("egress: not probed without an engine".into());
    }

    // A GITHUB_TOKEN in the file to copy, or in the agent.env a re-run keeps, is probed
    // now, before anything is written: its scopes can widen on GitHub with the same value.
    let kept = secrets_dir.join("agent.env");
    let keys_from = o
        .agent_env_from
        .as_ref()
        .map(|f| ("--agent-env-from", f.clone()))
        .or_else(|| {
            (kept.is_file() && files::check_owner_file(&kept).is_ok())
                .then_some(("agent.env", kept))
        });
    if let Some((what, f)) = keys_from {
        match std::fs::read_to_string(&f)
            .map_err(|e| format!("{}: {e}", f.display()))
            .and_then(|t| secrets::parse(&t))
        {
            Ok(keys) => {
                if let Some((_, t)) = keys.iter().find(|(k, _)| k == "GITHUB_TOKEN") {
                    if let Err(e) = checks::github_token(sys.github_scopes(t)) {
                        r.blockers.push(format!("{}: {e}", f.display()));
                    }
                }
            }
            Err(e) => r.blockers.push(format!("{what}: {e}")),
        }
    }

    let ready = match (manifest, pool, docker, capacity, facts) {
        (Some(manifest), Some(pool), Some(docker), Some(capacity), Some(facts)) if r.ok() => {
            let socket = docker.socket;
            let values = envelope::Values {
                pool: pool.clone(),
                set_dir,
                work_root,
                secrets_dir,
                socket,
                task_subnets,
                rootful: !facts.rootless(),
                userns_remap: !facts.rootless() && facts.isolation() == capacity::Isolation::Subuid,
                dedicated,
                max_units: o.max_units,
                max_cpus: o.max_cpus,
                max_mem_gb: o.max_mem_gb,
            };
            Some(Ready {
                manifest,
                pool,
                capacity,
                facts,
                values,
                legacy: legacy_seen,
                existing,
            })
        }
        _ => None,
    };
    if r.ok() && ready.is_none() {
        r.blockers
            .push("preflight could not measure this host".into());
    }
    Ok((r, ready))
}

/// What a finished install leaves for a person (linger, systemd), if anything.
#[derive(Debug, Default)]
pub struct Installed {
    pub needs_person: Vec<String>,
}

/// `omarchy-agent install`.
pub fn install(o: &Options, sys: &mut dyn Sys, out: &mut dyn Write) -> Result<Installed, Failure> {
    install_with(o, sys, &crate::run::Sigstore, None, out)
}

pub(crate) fn install_with(
    o: &Options,
    sys: &mut dyn Sys,
    verifier: &dyn Verifier,
    docker_cli: Option<&Path>,
    out: &mut dyn Write,
) -> Result<Installed, Failure> {
    let (report, ready) = measure(o, sys, verifier, docker_cli)?;
    let _ = write!(out, "{}", report.screen());
    match ready {
        Some(ready) if report.ok() => apply(o, &ready, sys, out),
        _ => Err(Failure::Refused(format!(
            "preflight found {} thing(s) to fix; nothing was installed",
            report.blockers.len()
        ))),
    }
}

/// The steps after preflight.
#[allow(clippy::too_many_lines)] // the install's steps, in order
pub(crate) fn apply(
    o: &Options,
    ready: &Ready,
    sys: &mut dyn Sys,
    out: &mut dyn Write,
) -> Result<Installed, Failure> {
    let p = &o.places;
    let v = &ready.values;
    let mut done = Installed::default();

    // The envelope, confirmed before anything is written.
    let shown = envelope::render(ready.existing.as_deref(), v, None).map_err(Failure::Refused)?;
    let exception = ready.legacy.is_some() && ready.facts.isolation() == capacity::Isolation::Root;
    let ask = format!(
        "{shown}\nThe host's envelope{}{}. Write it and enroll this host?",
        if v.rootful {
            " (rootful: the dispatcher holds a root daemon's socket, root-equivalent)"
        } else {
            ""
        },
        if exception {
            "; --legacy makes this daemon without userns-remap the recorded exception until P6"
        } else {
            ""
        }
    );
    if o.yes {
        let _ = write!(out, "{shown}");
    } else if !sys
        .confirm(&ask)
        .map_err(|e| Failure::Refused(format!("{e}: pass --yes to confirm without a terminal")))?
    {
        return Err(Failure::Refused(
            "the envelope was not confirmed; nothing was written".into(),
        ));
    }

    // The directories, and the capacity report enrollment sends.
    for d in [&p.data, &p.set_dir(), &v.secrets_dir, &v.work_root] {
        files::make_dir(d).map_err(Failure::Refused)?;
    }
    let at = capacity::now();
    capacity::write_if_changed(&v.set_dir, &ready.capacity, &at)
        .map_err(|e| Failure::Refused(format!("{}/run/capacity.json: {e}", v.set_dir.display())))?;

    // Enrollment: the owner's Confirm, then the host worker token.
    let eo = enroll::Options {
        pool: Some(ready.pool.clone()),
        paths: p.enroll_paths(),
        token: o.token.clone(),
        wait: o.wait,
        poll: o.poll,
    };
    // Its lines (the fingerprint, where to confirm) are shown as they come: the person
    // compares them while it waits.
    let mut shown_now = &mut *out;
    match enroll::run(&eo, &mut shown_now) {
        Ok(()) => {}
        Err(enroll::Failure::Refused(e)) => return Err(Failure::Refused(e)),
        Err(enroll::Failure::TimedOut(e)) => return Err(Failure::TimedOut(e)),
    }
    let id = Identity::read(&eo.paths.state)
        .map_err(Failure::Refused)?
        .ok_or_else(|| Failure::Refused("enrollment left no host.json".into()))?;
    let worker = enroll::worker_of(&eo.paths.dispatcher_env()).ok_or_else(|| {
        Failure::Refused(format!(
            "{} names no registration and token",
            eo.paths.dispatcher_env().display()
        ))
    })?;

    // agent.toml, now that the owner confirmed the host: the run loop can start.
    let text = envelope::render(ready.existing.as_deref(), v, Some((&id.host, &worker)))
        .map_err(Failure::Refused)?;
    crate::run::config::Config::parse(&text).map_err(Failure::Refused)?;
    files::write(&p.data, "agent.toml", text.as_bytes(), 0o600).map_err(Failure::Refused)?;
    say(
        out,
        &format!(
            "wrote {} (host {}, registration {worker})",
            p.agent_toml().display(),
            id.host
        ),
    );

    agent_keys(o, v, sys, out)?;

    if let (Some(project), Some(seen)) = (&o.legacy, &ready.legacy) {
        let record = legacy::Legacy {
            project: project.clone(),
            recorded_at: at.clone(),
            containers: seen.containers.clone(),
            networks: seen.networks.clone(),
            rootful_exception: ready.facts.isolation() == capacity::Isolation::Root,
        };
        let body =
            serde_json::to_vec_pretty(&record).map_err(|e| Failure::Refused(e.to_string()))?;
        files::write(&p.data, legacy::FILE, &body, 0o600).map_err(Failure::Refused)?;
        say(
            out,
            &format!(
                "recorded the legacy project {project} in {}; nothing in it was changed",
                p.data.join(legacy::FILE).display()
            ),
        );
    }

    // The unit, linger, the service: its first round rolls the bundle out.
    let unit_text = unit::render(&p.data).map_err(Failure::Refused)?;
    files::make_dir(&p.unit_dir()).map_err(Failure::Refused)?;
    files::write(&p.unit_dir(), unit::NAME, unit_text.as_bytes(), 0o644)
        .map_err(Failure::Refused)?;
    if let Err(e) = unit::linger(sys, &p.user) {
        done.needs_person.push(e);
    }
    match unit::start(sys) {
        Ok(()) => say(out, &format!("{} started: its first round renders, pulls and starts release v{}'s bundle (omarchy-agent status)", unit::NAME, ready.manifest.outer().release())),
        Err(e) => done.needs_person.push(e),
    }

    let fingerprint = HostKey::load_or_create(&eo.paths.state.join(KEY_FILE))
        .map_or_else(|e| e, |k| k.fingerprint());
    let c = &ready.capacity;
    say(
        out,
        &format!(
            "host {} on {}: {} CPUs, {} GB, lane {} native, {} units ({} kept for pool jobs), isolation {}, host key {fingerprint}",
            id.host,
            ready.pool,
            c.cpus(),
            c.mem_gb(),
            ready.facts.arch(),
            c.units(),
            c.job_reserved(),
            checks::level(c.isolation()),
        ),
    );
    for n in &done.needs_person {
        say(out, n);
    }
    Ok(done)
}

/// The agent keys into `OMARCHY_SECRETS_DIR/agent.env`.
fn agent_keys(
    o: &Options,
    v: &envelope::Values,
    sys: &mut dyn Sys,
    out: &mut dyn Write,
) -> Result<(), Failure> {
    let target = v.secrets_dir.join("agent.env");
    let text = if let Some(f) = &o.agent_env_from {
        let t = std::fs::read_to_string(f)
            .map_err(|e| Failure::Refused(format!("{}: {e}", f.display())))?;
        let keys =
            secrets::parse(&t).map_err(|e| Failure::Refused(format!("{}: {e}", f.display())))?;
        let names: Vec<&str> = keys.iter().map(|(k, _)| k.as_str()).collect();
        let ask = format!(
            "{} holds {}. Copy them into {}?",
            f.display(),
            names.join(", "),
            target.display()
        );
        if o.yes {
            say(out, &format!("{} holds {}", f.display(), names.join(", ")));
        } else if !sys.confirm(&ask).map_err(Failure::Refused)? {
            return Err(Failure::Refused("the agent keys were not copied".into()));
        }
        Some(keys)
    } else if target.exists() {
        say(
            out,
            &format!("{} kept (--agent-env-from replaces it)", target.display()),
        );
        None
    } else if o.yes {
        say(
            out,
            "no agent keys: this host takes no model kinds (--agent-env-from adds them)",
        );
        None
    } else {
        let typed = sys
            .ask_keys("Agent keys and a public-read GITHUB_TOKEN, one KEY=value a line (not shown); an empty line ends, and none at all leaves this host without model kinds:")
            .map_err(Failure::Refused)?;
        let keys = secrets::parse(&typed).map_err(Failure::Refused)?;
        (!keys.is_empty()).then_some(keys)
    };
    if let Some(keys) = text {
        if let Some((_, t)) = keys.iter().find(|(k, _)| k == "GITHUB_TOKEN") {
            checks::github_token(sys.github_scopes(t)).map_err(Failure::Refused)?;
        }
        files::write(
            &v.secrets_dir,
            "agent.env",
            secrets::render(&keys).as_bytes(),
            0o600,
        )
        .map_err(Failure::Refused)?;
        say(
            out,
            &format!("wrote {} (0600, outside the work root)", target.display()),
        );
    }
    Ok(())
}

/// `omarchy-agent uninstall`: stops the agent, removes its unit, the bundle's containers
/// and networks, task containers and sidecars (only here), an egress probe's leftovers,
/// and the bundle's files. A user manager it cannot reach stops it before anything goes. The
/// recorded legacy project is never touched; the host identity, agent.toml, the agent
/// binaries and the secrets directory stay, so a new install keeps the identity.
pub fn uninstall(
    places: &Places,
    sys: &mut dyn Sys,
    out: &mut dyn Write,
) -> Result<Vec<String>, String> {
    let mut left = Vec::new();
    unit::stop(sys)?;
    files::remove(&places.unit_dir(), unit::NAME)?;
    unit::reload(sys);
    say(out, &format!("stopped and removed {}", unit::NAME));

    let cfg = std::fs::read_to_string(places.agent_toml()).ok();
    let legacy_project = std::fs::read(places.data.join(legacy::FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<legacy::Legacy>(&b).ok())
        .map(|l| l.project);
    let socket = envelope::set_path(cfg.as_deref(), "socket_cli");
    let project = envelope::set_str(cfg.as_deref(), "project")
        .unwrap_or_else(|| envelope::PROJECT.to_owned());
    let host = cfg
        .as_deref()
        .and_then(|t| toml::from_str::<toml::Table>(t).ok())
        .and_then(|t| t.get("host_id").and_then(|h| h.as_str().map(str::to_owned)));
    let state = crate::run::state::load(&places.data.join("state.json"))
        .ok()
        .flatten();
    let cli = state
        .and_then(|s| s.tools)
        .and_then(|pins| tools::open(&places.data.join("tools"), &pins).ok())
        .map(|t| t.docker);
    // Containers that could not be removed keep their set (its dispatcher.env) until a
    // later uninstall removes them.
    let mut keep_set = false;
    match (socket, cli) {
        (Some(socket), Some(cli)) => {
            let d = Docker { cli, socket };
            match remove_containers(&d, &project, host.as_deref(), legacy_project.as_deref()) {
                Ok(n) => say(out, &format!("removed {n} container(s) of {project} and its tasks")),
                Err(e) => {
                    keep_set = true;
                    left.push(format!("needs a person: the containers were not removed ({e}); sets/ is kept, run uninstall again"));
                }
            }
        }
        _ => left.push(format!(
            "needs a person: no agent.toml socket or pinned docker CLI to remove the containers with; remove those labelled {PROJECT_LABEL}={project} and {HOST_LABEL}=<host>"
        )),
    }
    for d in ["bundles", "staging", "last-good", "sets"] {
        if keep_set && d == "sets" {
            continue;
        }
        let path = places.data.join(d);
        match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() => {
                std::fs::remove_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            }
            Ok(_) => return Err(format!("{}: not a directory; left alone", path.display())),
            Err(_) => {}
        }
    }
    say(
        out,
        &format!(
            "removed the bundle's files under {}; the identity, agent.toml and the secrets stay",
            places.data.display()
        ),
    );
    if let Some(l) = legacy_project {
        say(out, &format!("the legacy project {l} was not touched"));
    }
    Ok(left)
}

/// The containers and networks labelled with the bundle's project or this host, `(id or
/// name, compose project)`.
fn labelled(
    d: &Docker,
    what: &[&str],
    filters: &[String],
) -> Result<Vec<(String, String)>, String> {
    let mut ids: Vec<String> = Vec::new();
    for f in filters {
        let mut args = what.to_vec();
        args.extend(["-q", "--no-trunc", "--filter", f.as_str()]);
        if what == ["ps"] {
            args.push("-a");
        }
        for id in d.run(&args)?.split_whitespace() {
            if !ids.iter().any(|i| i == id) {
                ids.push(id.to_owned());
            }
        }
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let (inspect, labels): (&[&str], &str) = if what == ["ps"] {
        (&["inspect"], ".Config.Labels")
    } else {
        (&["network", "inspect"], ".Labels")
    };
    let format = format!("{{{{.Id}}}}\t{{{{index {labels} \"{PROJECT_LABEL}\"}}}}");
    let mut args = inspect.to_vec();
    args.extend(["--format", format.as_str()]);
    args.extend(ids.iter().map(String::as_str));
    Ok(d.run(&args)?
        .lines()
        .filter_map(|l| {
            let (id, proj) = l.split_once('\t')?;
            Some((id.trim().to_owned(), proj.trim().to_owned()))
        })
        .filter(|(id, _)| !id.is_empty())
        .collect())
}

fn remove_containers(
    d: &Docker,
    project: &str,
    host: Option<&str>,
    legacy: Option<&str>,
) -> Result<usize, String> {
    let mut filters = vec![format!("label={PROJECT_LABEL}={project}")];
    if let Some(h) = host {
        filters.push(format!("label={HOST_LABEL}={h}"));
    }
    egress::sweep(d)?;
    let containers = labelled(d, &["ps"], &filters)?;
    let ids = legacy::removable(&containers, legacy);
    if !ids.is_empty() {
        let mut args = vec!["rm", "-f"];
        args.extend(ids.iter().copied());
        d.run(&args)?;
    }
    let networks = labelled(d, &["network", "ls"], &filters)?;
    for id in legacy::removable(&networks, legacy) {
        let _ = d.run(&["network", "rm", id]);
    }
    Ok(ids.len())
}

#[cfg(test)]
mod tests;
