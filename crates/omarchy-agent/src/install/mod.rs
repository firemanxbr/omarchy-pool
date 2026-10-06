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
//!    before anything else is written. The foreign architecture's lane (#338, design v2
//!    §7.5) is detected there too — binfmt, then a smoke run of the release's build image
//!    of that architecture — and only reported: a held lane never stops an install;
//! 3. prints the envelope (agent.toml) for the person to confirm on `/dev/tty` (`--yes`
//!    skips) and writes `run/capacity.json`;
//! 4. enrolls (#321): the owner's Confirm, then the host worker token, written into
//!    `etc/dispatcher.env` with the host's own addresses (#371: its interfaces' and the
//!    public one the egress probe saw tasks leave from, kept in `egress.json`);
//! 5. only then writes agent.toml, with the `host_id` and `worker_id` enrollment gave:
//!    before it there is no run loop, no dispatcher, and nothing claims; then
//!    `etc/dispatcher.env` gets the secrets directory and the agent budget from it (#371);
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
//! On a Mac (#320, [`mac`], [`launchd`]): preflight also asks for a GUI login (a
//! `LaunchAgent` is login-scoped), sizes and starts the `omarchy` Colima VM with only the
//! work root, the secrets and the set directories mounted (none under `~`), or takes
//! Docker Desktop's or `OrbStack`'s VM when one is here and its home mount is removed; the
//! envelope records the VM (`[vm]`) and the two sockets; the plist replaces the unit.
//!
//! Seams left for later issues, by name: the egress probe behind the egress sidecar on a
//! task's internal network (#373), and on podman the task network made through libpod's own
//! API with DNS off (#372), until which a rootless host fails the probe ([`egress`]); the
//! `subuid` level for rootless podman, once the dispatcher (#335) starts task containers with
//! `--userns=auto` (until then rootless podman reads as `user`); task containers and sidecars
//! carry `org.omarchy-pool.agent.host=<host>` (design v2 §9.3), which uninstall removes by.

pub mod checks;

pub(crate) mod egress;
pub(crate) mod engine;
pub(crate) mod envelope;
pub(crate) mod files;
pub(crate) mod launchd;
pub(crate) mod legacy;
pub(crate) mod loopback;
pub(crate) mod mac;
pub(crate) mod net;
pub(crate) mod secrets;
mod sys;
pub(crate) mod unit;

pub use sys::Machine;

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::capacity::{self, probe, Capacity, Caps, Facts, VmKind};
use crate::dispatcher_env::{self, addresses, Envelope, Refresh, Rendered, Sources};
use crate::enroll;
use crate::host::{HostKey, Identity, KEY_FILE};
use crate::manifest::Manifest;
use crate::run::{tools, Verifier};
use crate::verify::{cosignature, BundleOutcome};
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
    /// This user's uid: launchd's `gui/<uid>` domain (macOS).
    pub uid: u32,
    /// `$COLIMA_HOME` or `~/.colima` (macOS), and the variable when the person set it, for
    /// the `LaunchAgent`'s environment.
    pub colima_home: PathBuf,
    pub colima_home_env: Option<String>,
    /// `~/Library/LaunchAgents` and `~/Library/Logs/omarchy-agent` (macOS).
    pub launch_agents: PathBuf,
    pub logs: PathBuf,
    /// An SSH session (`SSH_CONNECTION` or `SSH_TTY`): said when there is no GUI login.
    pub ssh: bool,
    /// Rosetta 2's runtime, there once installed (macOS).
    pub rosetta: PathBuf,
    /// Where prep-mac.sh makes the work root, the secrets and the set directories.
    pub mac_root: PathBuf,
    /// Where the host's own addresses are read (`/proc/net`, #371), and a Mac's `ifconfig`
    /// (#320).
    pub proc_net: PathBuf,
    pub ifconfig: Option<PathBuf>,
    /// prep-root.sh's firewall script (world-readable): whether its INPUT drop for the task
    /// subnets is installed, and which command a rootful host without it is told to run (#367).
    pub task_firewall: PathBuf,
    /// `/etc/systemd/system` (world-readable): whether the unit that runs that script at boot
    /// is there and enabled, or a reboot takes the drop away (#367).
    pub systemd_system: PathBuf,
    /// Docker's `daemon.json` (world-readable): the address pool that command carries (#367).
    pub docker_daemon: PathBuf,
    /// Where processes are read (`/proc`): a rootless engine's network stack (#367).
    pub proc: PathBuf,
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
        let colima_env = std::env::var_os("COLIMA_HOME").filter(|v| !v.is_empty());
        let sources = Sources::system();
        Ok(Places {
            data: crate::run::config::data_dir(data_flag)?,
            config_home: var("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")),
            xdg_runtime_dir: var("XDG_RUNTIME_DIR"),
            user,
            os: std::env::consts::OS,
            linger_dir: PathBuf::from("/var/lib/systemd/linger"),
            routes: PathBuf::from("/proc/net/route"),
            binfmt: PathBuf::from("/proc/sys/fs/binfmt_misc"),
            uid: rustix::process::getuid().as_raw(),
            colima_home: crate::vm::colima_home(&home, colima_env.as_deref()),
            colima_home_env: colima_env.map(|v| v.to_string_lossy().into_owned()),
            launch_agents: home.join("Library/LaunchAgents"),
            logs: home.join("Library/Logs/omarchy-agent"),
            ssh: ["SSH_CONNECTION", "SSH_TTY"]
                .iter()
                .any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty())),
            rosetta: PathBuf::from(crate::vm::ROSETTA_RUNTIME),
            mac_root: PathBuf::from(crate::vm::MAC_ROOT),
            home,
            proc_net: sources.proc_net,
            ifconfig: sources.ifconfig,
            task_firewall: PathBuf::from("/usr/local/libexec/omarchy-task-firewall"),
            systemd_system: PathBuf::from("/etc/systemd/system"),
            docker_daemon: PathBuf::from("/etc/docker/daemon.json"),
            proc: PathBuf::from("/proc"),
        })
    }

    pub fn mac(&self) -> bool {
        self.os == "macos"
    }
    /// The set directory by default: under the data directory on Linux; on a Mac beside
    /// the work root, outside the home directory, since the VM mounts it (#320).
    pub fn set_dir(&self) -> PathBuf {
        if self.mac() {
            self.mac_root.join("set")
        } else {
            self.data.join("sets").join("host")
        }
    }
    fn default_dir(&self, name: &str) -> PathBuf {
        if self.mac() {
            self.mac_root.join(name)
        } else {
            self.data.join(name)
        }
    }
    pub fn unit_dir(&self) -> PathBuf {
        self.config_home.join("systemd").join("user")
    }
    /// The agent's own `DOCKER_CONFIG`, the run loop's: a Mac's Colima writes its Docker
    /// context there, never into the person's `~/.docker` (#320).
    pub fn docker_config(&self) -> PathBuf {
        crate::run::config::Paths {
            data: self.data.clone(),
        }
        .docker_config()
    }
    fn agent_toml(&self) -> PathBuf {
        self.data.join("agent.toml")
    }
    fn plist(&self) -> PathBuf {
        self.launch_agents.join(launchd::PLIST)
    }
    fn enroll_paths(&self, set_dir: &Path) -> enroll::Paths {
        enroll::Paths {
            data: self.data.clone(),
            state: self.data.join("state"),
            set: set_dir.to_owned(),
        }
    }
    /// The `LaunchAgent`'s plist for this data directory.
    fn render_plist(&self) -> Result<String, String> {
        let env: Vec<(&str, String)> = self
            .colima_home_env
            .iter()
            .map(|v| ("COLIMA_HOME", v.clone()))
            .collect();
        launchd::render(&self.data, &self.home, &self.logs, &env)
    }
    fn sources(&self) -> Sources {
        Sources {
            proc_net: self.proc_net.clone(),
            ifconfig: self.ifconfig.clone(),
        }
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
    /// The set directory (`<data>/sets/host` on Linux, prep-mac.sh's on a Mac).
    pub set_dir: Option<PathBuf>,
    pub socket: Option<PathBuf>,
    /// An `x86_64` lane through Rosetta in the Mac's VM: `--rosetta`, `--no-rosetta`, else
    /// what agent.toml's `[vm] rosetta` says, else on.
    pub rosetta: Option<bool>,
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
    fn run(&mut self, prog: &str, args: &[&str]) -> Result<String, String> {
        self.run_env(prog, args, &[])
    }
    /// [`Sys::run`] with `env` added to the environment (a Mac's `colima`, #320).
    fn run_env(
        &mut self,
        prog: &str,
        args: &[&str],
        env: &[(&'static str, String)],
    ) -> Result<String, String>;
    /// Shows `text` on `/dev/tty` and asks yes or no.
    fn confirm(&mut self, text: &str) -> Result<bool, String>;
    /// `KEY=value` lines typed on `/dev/tty` without echo, until an empty line.
    fn ask_keys(&mut self, text: &str) -> Result<String, String>;
    /// GitHub's `X-OAuth-Scopes` for `token` (`None` when it names none).
    fn github_scopes(&mut self, token: &str) -> Result<Option<String>, String>;
    /// A release asset or a pinned tool, over HTTPS.
    fn download(&mut self, url: &str) -> Result<Vec<u8>, String>;
    /// The same for an asset the release may not carry (a maintainer's co-signature,
    /// #330): `Ok(None)` when the server answers 404, an error when it does not answer.
    fn download_if_any(&mut self, url: &str) -> Result<Option<Vec<u8>>, String>;
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
    /// The public address the egress probe saw tasks leave from (#371).
    pub public: Option<std::net::IpAddr>,
}

/// What measures the host: preflight changes nothing but the agent's tool cache, and on a
/// Mac starts a stopped `omarchy` VM to measure it; install also makes the Mac's missing
/// directories and restarts a VM that differs (#320).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Preflight,
    Install,
}

fn say(out: &mut dyn Write, line: &str) {
    let _ = writeln!(out, "omarchy-agent: {line}");
}

/// The verified release: its manifest, once it carries the maintainers' co-signatures
/// this agent requires (#330, D1 b): the release's `<bundle>.<login>.sshsig` assets, or the
/// files of those names beside `--bundle`.
fn release(o: &Options, sys: &mut dyn Sys, verifier: &dyn Verifier) -> Result<Manifest, Failure> {
    let policy = verifier.cosignature();
    let mut cosignatures = BTreeMap::new();
    let (archive, sig) = match &o.source {
        Some(Source::Files(b, s)) => {
            let read = |p: &Path| std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()));
            if policy.threshold() > 0 {
                let name = b.file_name().map(|n| n.to_string_lossy().into_owned());
                for login in policy.logins() {
                    let beside = b.with_file_name(cosignature::file_name(
                        name.as_deref().unwrap_or_default(),
                        login,
                    ));
                    if let Ok(found) = std::fs::read(beside) {
                        cosignatures.insert(login.to_owned(), found);
                    }
                }
            }
            (
                read(b).map_err(Failure::Refused)?,
                read(s).map_err(Failure::Refused)?,
            )
        }
        Some(Source::Release(r)) => {
            let (name, sig) = crate::run::bundle_names(*r);
            let url = |n: &str| format!("{}/{r}/{n}", crate::run::RELEASES);
            if policy.threshold() > 0 {
                // One a maintainer did not make answers 404, which counts as none; GitHub not
                // answering is said as that, never as a release without its co-signature.
                for login in policy.logins() {
                    let asset = url(&cosignature::file_name(&name, login));
                    match sys.download_if_any(&asset) {
                        Ok(Some(found)) => {
                            cosignatures.insert(login.to_owned(), found);
                        }
                        Ok(None) => {}
                        Err(e) => {
                            return Err(Failure::Refused(format!(
                                "GitHub did not answer for the maintainers' co-signature {asset}: {e}; run it again"
                            )))
                        }
                    }
                }
            }
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
    let cosigned = || {
        policy
            .check(cosignature::BUNDLE_NAMESPACE, &archive, &cosignatures)
            .require(policy.threshold(), "the release bundle")
            .map_err(|e| {
                Failure::Refused(format!("the release bundle is refused (cosignature): {e}"))
            })
    };
    match verifier.bundle(&archive, &sig) {
        Ok(BundleOutcome::Current(b)) => {
            cosigned()?;
            Ok(b.manifest().clone())
        }
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
pub(crate) fn existing_ancestor(p: &Path) -> PathBuf {
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
/// the release's hash-checked tools (and, on a Mac, the `omarchy` VM it starts to measure).
pub fn preflight(o: &Options, sys: &mut dyn Sys) -> Result<Report, Failure> {
    measure_as(o, sys, &crate::run::Sigstore, None, Mode::Preflight).map(|(r, _)| r)
}

/// Install's measure: preflight's report, and what install needs when nothing blocks.
pub(crate) fn measure(
    o: &Options,
    sys: &mut dyn Sys,
    verifier: &dyn Verifier,
    docker_cli: Option<&Path>,
) -> Result<(Report, Option<Ready>), Failure> {
    measure_as(o, sys, verifier, docker_cli, Mode::Install)
}

/// Preflight's report, and what install needs when nothing blocks.
#[allow(clippy::too_many_lines, clippy::many_single_char_names)] // one check after another, in the screen's order
pub(crate) fn measure_as(
    o: &Options,
    sys: &mut dyn Sys,
    verifier: &dyn Verifier,
    docker_cli: Option<&Path>,
    mode: Mode,
) -> Result<(Report, Option<Ready>), Failure> {
    let p = &o.places;
    let mac = p.mac();
    let mut r = Report::default();
    if p.os != "linux" && !mac {
        r.blockers.push(format!(
            "this is {}: install runs on Linux and macOS (a Mac through its omarchy VM)",
            p.os
        ));
    }
    let existing = std::fs::read_to_string(p.agent_toml()).ok();
    let ex = existing.as_deref();
    let enrolled = Identity::read(&p.data.join("state")).ok().flatten();
    if enrolled.is_none() && o.token.is_none() {
        r.blockers.push(
            "enrollment: this machine has not enrolled yet, and OMARCHY_ENROLL is not set: add the host on your page and paste the command it prints".into(),
        );
    }

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
                    "the {} would start {}, which is not this release's agent ({e}); run install.sh, or give the data directory it used ({})",
                    if mac { "LaunchAgent" } else { "unit" },
                    current.display(),
                    p.data.display()
                ));
            }
        }
    }

    // Where things go: on a Mac outside the home directory, which the VM never mounts.
    let set_dir = o
        .set_dir
        .clone()
        .or_else(|| envelope::set_path(ex, "dir"))
        .unwrap_or_else(|| p.set_dir());
    let work_root = o
        .work_root
        .clone()
        .or_else(|| envelope::set_path(ex, "work_root"))
        .unwrap_or_else(|| p.default_dir("work"));
    let secrets_dir = o
        .secrets_dir
        .clone()
        .or_else(|| envelope::set_path(ex, "secrets_dir"))
        .unwrap_or_else(|| p.default_dir("secrets"));
    for (what, d) in [
        ("work root", &work_root),
        ("secrets directory", &secrets_dir),
        ("set directory", &set_dir),
    ] {
        if !crate::lint::is_plain_absolute(d) {
            r.blockers.push(format!(
                "the {what} {} is not a plain absolute path",
                d.display()
            ));
        }
    }
    // It reaches the dispatcher through etc/dispatcher.env (#371), which names its
    // agent.env in an agent sidecar's mount and refuses any other path.
    if crate::lint::is_plain_absolute(&secrets_dir)
        && !dispatcher_env::dispatcher_path(&secrets_dir)
    {
        r.blockers.push(format!(
            "the secrets directory {} has a character the dispatcher refuses: letters, digits and / . _ - + only",
            secrets_dir.display()
        ));
    }
    // The agent budget a re-run keeps reaches it too, and agent.toml is refused with a bad
    // one: said here, before the owner's Confirm, not after the token is written.
    if let Err(e) =
        dispatcher_env::Budget::from_envelope(envelope::envelope_value(ex, "agent_budget").as_ref())
    {
        r.blockers.push(e);
    }
    if let Err(e) = secrets::outside(&secrets_dir, &work_root, &set_dir) {
        r.blockers.push(e);
    }
    let service = if mac {
        p.render_plist()
    } else {
        unit::render(&p.data)
    };
    if let Err(e) = service {
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
    let mut dedicated = o.dedicated
        || envelope::envelope_value(ex, "dedicated").and_then(|v| v.as_bool()) == Some(true);
    let project = envelope::set_str(ex, "project").unwrap_or_else(|| envelope::PROJECT.to_owned());
    // The legacy project: `--legacy`, or the one an earlier install recorded, so running
    // install again repairs it without the flag (legacy.json's owner is checked below).
    // A project retire-legacy removed (#344) is no legacy set any more: nothing of it is
    // looked at again. The rootful exception it was recorded with stays until P6 (design v2
    // §19.3, §21.1): the Studio stays rootful after step 6, and install again repairs it.
    let recorded = std::fs::read(p.data.join(legacy::FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<legacy::Legacy>(&b).ok());
    let retired = recorded.as_ref().filter(|l| l.retired_at.is_some());
    let legacy_project = o.legacy.clone().or_else(|| {
        recorded
            .as_ref()
            .filter(|l| l.retired_at.is_none())
            .map(|l| l.project.clone())
    });
    let rootful_exception =
        legacy_project.is_some() || retired.is_some_and(|l| l.rootful_exception);
    if let (None, Some(l)) = (&legacy_project, retired) {
        r.notes.push(format!(
            "legacy: {} was retired at {} ({}); {}",
            l.project,
            l.retired_at.as_deref().unwrap_or_default(),
            l.retired_by.as_deref().unwrap_or("retire-legacy"),
            if l.rootful_exception {
                "its rootful exception stays until P6"
            } else {
                "nothing of it is looked at again"
            }
        ));
    }
    if let Some(l) = &legacy_project {
        if !legacy::valid_project(l) {
            r.blockers
                .push(format!("--legacy {l:?} is not a compose project name"));
        } else if *l == project {
            r.blockers
                .push(format!("--legacy {l:?} is the new bundle's own project"));
        } else if mac {
            r.blockers
                .push("--legacy is the Studio's (Linux): a Mac has no legacy set".into());
        }
    }

    // The owner files already there.
    let enroll_paths = p.enroll_paths(&set_dir);
    for f in [
        p.agent_toml(),
        set_dir.join("compose.override.yml"),
        set_dir.join(".env"),
        enroll_paths.dispatcher_env(),
        secrets_dir.join("agent.env"),
        p.data.join(legacy::FILE),
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
    let service_dir = if mac {
        p.launch_agents.clone()
    } else {
        p.unit_dir()
    };
    for d in [
        &p.data,
        &tools_dir,
        &set_dir,
        &work_root,
        &secrets_dir,
        &service_dir,
    ] {
        // ~/Library/LaunchAgents is the person's, shared with every other agent of theirs.
        if d.exists() && !(mac && *d == service_dir) {
            if let Err(e) = files::owned_dir(d) {
                trusted &= *d != p.data && *d != tools_dir;
                r.blockers.push(e);
            }
        }
    }
    // A work root to make (prep-root.sh makes it where root owns the parent) must be
    // makeable by this user, or apply would fail after the person confirmed. On a Mac the
    // VM mounts it before install writes anything: prep-mac.sh makes all three (below).
    if !work_root.exists() && !mac {
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

    // The release's pinned docker CLI, before the engine: on a Mac Colima needs it to start
    // the VM.
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
    // The engine: on a Mac in its VM, started and sized here when it is the omarchy one.
    let given = o
        .socket
        .clone()
        .or_else(|| envelope::set_path(ex, "socket_cli"));
    let caps = (
        o.max_cpus.or_else(|| envelope_u32(ex, "max_cpus")),
        o.max_mem_gb.or_else(|| envelope_u32(ex, "max_mem_gb")),
    );
    let vm_mounts = crate::vm::mounts(&work_root, &secrets_dir, &set_dir);
    let found = mac.then(|| {
        let min = manifest.as_ref().map(|m| {
            let c = m.capacity().constants();
            (c.min.cpus, c.min.mem_gb)
        });
        // The owner's choice of the x86_64 lane carries over, as the envelope's caps do.
        let rosetta = o
            .rosetta
            .or_else(|| {
                (envelope::table_str(ex, "vm", "runtime").as_deref() == Some("colima"))
                    .then(|| envelope::table_value(ex, "vm", "rosetta")?.as_bool())
                    .flatten()
            })
            .unwrap_or(true);
        let ask = mac::Ask {
            given: given.as_deref(),
            mounts: &vm_mounts,
            caps,
            rosetta,
            min,
            docker_cli: cli.as_deref(),
            subnets: &task,
            mode,
        };
        mac::engine(o, sys, &ask, &mut r)
    });
    let socket = match &found {
        Some(f) => f.socket.clone(),
        None => match engine::discover(
            given.as_deref(),
            &engine::candidates(p.xdg_runtime_dir.as_deref()),
            engine::connect,
        ) {
            Ok(s) => Some(s),
            Err(e) => {
                r.blockers.push(e);
                None
            }
        },
    };
    let docker = socket.zip(cli).map(|(socket, cli)| Docker { cli, socket });
    let image = manifest
        .as_ref()
        .and_then(|m| m.build_image(std::env::consts::ARCH))
        .map(ToString::to_string);
    // The emulated lane (#338): the release's build images for its smoke run (the foreign
    // one of the engine's architecture), within the envelope an earlier install's owner may
    // have narrowed (`emulate`).
    let images = capacity::emulation::images(None, manifest.as_ref());
    let emulate: Option<Vec<String>> = envelope::envelope_value(ex, "emulate").map(|v| {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str().map(str::to_owned))
            .collect()
    });
    let facts = docker.as_ref().and_then(|d| {
        let host = d.host();
        let how = probe::Probe {
            docker: &d.cli.to_string_lossy(),
            host: Some(&host),
            work_root: &existing_ancestor(&work_root),
            image: image.as_deref(),
            // A Mac's VM has its own binfmt table: its lane is Rosetta's ([`mac_facts`]).
            emulation: (!mac).then_some(capacity::emulation::Probe {
                binfmt: &p.binfmt,
                images: &images,
                emulate: emulate.as_deref(),
            }),
        };
        match probe::detect(&how) {
            Ok(f) => Some(f),
            Err(e) => {
                r.blockers.push(format!("the engine did not answer: {e}"));
                None
            }
        }
    });
    // A Mac: the level is the VM's, MemAvailable is the VM's own (M7), the x86_64 lane is
    // Rosetta's when its smoke run passes, and the VM sees the three directories only.
    let facts = match (facts, found.as_ref().and_then(|f| f.kind)) {
        (Some(f), Some(kind)) => Some(mac_facts(
            o,
            sys,
            f,
            kind,
            found.as_ref(),
            docker.as_ref(),
            image.as_deref(),
            manifest.as_ref(),
            ex,
            &vm_mounts,
            &mut r,
        )),
        (f, _) => f,
    };
    if found.as_ref().and_then(|f| f.kind) == Some(VmKind::Dedicated) {
        // The omarchy VM is a VM used only as a pool host (design v2 §19.1).
        dedicated = true;
    }
    let caps = Caps {
        max_units: o.max_units,
        max_cpus: o.max_cpus,
        max_mem_gb: o.max_mem_gb,
        dedicated,
        emulate,
        ..Caps::default()
    };
    let capacity = facts.as_ref().zip(manifest.as_ref()).map(|(f, m)| {
        let c = Capacity::new(f, &caps, m.capacity());
        r.blockers.extend(capacity::preflight(&c));
        let emulated: Vec<String> = c
            .emulated()
            .iter()
            .map(|l| format!(", the {} lane through {}", l.arch, l.via))
            .collect();
        r.notes.push(format!(
            "capacity: {} CPUs, {} GB, disks {} GB (work root) and {} GB (engine), {} units on the {} lane{}",
            c.cpus(),
            c.mem_gb(),
            c.disk_free_gb().work,
            c.disk_free_gb().engine,
            c.units(),
            f.arch(),
            emulated.concat()
        ));
        checks::emulation(&c, &mut r);
        c
    });
    if let Some(f) = &facts {
        checks::hosting(
            f.isolation(),
            !f.rootless(),
            dedicated,
            rootful_exception,
            &mut r,
        );
    }
    let creds = checks::credentials(&p.home);
    if found.as_ref().and_then(|f| f.kind).is_some() {
        // A Mac: an escape lands in the VM, which sees nothing of the home directory.
        if !creds.is_empty() {
            r.notes.push(format!(
                "credentials in your home directory stay out of the VM ({} found; nothing of ~ is mounted)",
                creds.len()
            ));
        }
    } else {
        checks::credentials_verdict(&creds, dedicated, &mut r);
    }
    if p.os == "linux" {
        checks::user_manager(&p.user, &p.linger_dir, p.xdg_runtime_dir.as_deref(), &mut r);
    }

    // Networks: the host's routes, other projects', egress.
    let routes = std::fs::read_to_string(&p.routes)
        .map(|t| net::parse_routes(&t))
        .unwrap_or_default();
    let gateway = found
        .as_ref()
        .map_or_else(|| net::default_gateway(&routes), |f| f.gateway);
    let mut legacy_seen = None;
    let mut public = None;
    if let Some(d) = &docker {
        match other_networks(d, &project, legacy_project.as_deref()) {
            Ok(n) => checks::subnets(&task, &routes, &n, &mut r),
            Err(e) => r.blockers.push(format!("the engine's networks: {e}")),
        }
        if let Some(l) = legacy_project
            .as_deref()
            .filter(|l| legacy::valid_project(l))
        {
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
                let rootful = facts.as_ref().is_none_or(|f| !f.rootless());
                let server = d.server();
                let vm = found.as_ref().and_then(|f| f.kind);
                // prep-root.sh's firewall is a Linux host's; a Mac's VM gets the agent's own
                // ([`mac`], before this probe), and none of prep-root.sh's files is on a Mac.
                let (firewall, unprepared) = if mac {
                    (String::new(), None)
                } else {
                    let script = std::fs::read_to_string(&p.task_firewall).ok();
                    let fw = egress::Firewall::read(script.as_deref(), &p.systemd_system);
                    (
                        egress::firewall_command(
                            fw,
                            std::fs::read_to_string(&p.docker_daemon).ok().as_deref(),
                            &task,
                            &p.user,
                            &work_root,
                            &task_subnets,
                        ),
                        egress::unprepared(fw, &task),
                    )
                };
                let host = egress::Host {
                    router: gateway,
                    lan: net::lan_address(),
                    pool: pool.as_deref(),
                    advice: egress::Advice {
                        rootful,
                        podman: server == Ok(engine::Server::Podman),
                        firewall,
                        vm,
                    },
                    server,
                    unprepared,
                    proc: &p.proc,
                    uid: rustix::process::getuid().as_raw(),
                };
                public = egress::check(d, img, subnet, &host, &mut r);
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
            let vm = found
                .as_ref()
                .filter(|f| f.kind.is_some())
                .map(|f| envelope::Vm {
                    runtime: mac::runtime_of(&socket, &p.colima_home),
                    rosetta: f.want.as_ref().is_some_and(|w| w.rosetta),
                    disk_gb: f.want.as_ref().map_or(crate::vm::DISK_GB, |w| w.disk_gb),
                    size: f.want.as_ref().map(|w| w.size),
                });
            let values = envelope::Values {
                pool: pool.clone(),
                set_dir,
                work_root,
                secrets_dir,
                socket_mount: if vm.is_some() {
                    PathBuf::from(crate::vm::SOCKET_MOUNT)
                } else {
                    socket.clone()
                },
                socket,
                task_subnets,
                rootful: !facts.rootless(),
                userns_remap: !facts.rootless()
                    && facts.inner_isolation() == capacity::Isolation::Subuid
                    && facts.vm().is_none(),
                dedicated,
                max_units: o.max_units,
                // The omarchy VM's size is the envelope's: written so the owner sees it.
                max_cpus: vm
                    .as_ref()
                    .and_then(|v| v.size)
                    .map(|s| s.cpus)
                    .or(o.max_cpus),
                max_mem_gb: vm
                    .as_ref()
                    .and_then(|v| v.size)
                    .map(|s| s.mem_gb)
                    .or(o.max_mem_gb),
                vm,
                emulate: capacity::emulation::foreign_of(facts.arch()).map(|f| vec![f.to_owned()]),
            };
            Some(Ready {
                manifest,
                pool,
                capacity,
                facts,
                values,
                legacy: legacy_seen,
                existing,
                public,
            })
        }
        _ => None,
    };
    if r.ok() && ready.is_none() && !found.as_ref().is_some_and(|f| f.deferred) {
        r.blockers
            .push("preflight could not measure this host".into());
    }
    Ok((r, ready))
}

/// An existing agent.toml's `[envelope].<key>` as a number.
fn envelope_u32(existing: Option<&str>, key: &str) -> Option<u32> {
    envelope::envelope_value(existing, key)
        .and_then(|v| v.as_integer())
        .and_then(|n| u32::try_from(n).ok())
}

/// The facts of an engine in a Mac's VM (#320, [`probe::in_mac_vm`]): the VM's level; on
/// the omarchy VM its own `MemAvailable` (M7) and, with Rosetta, the `x86_64` lane once its
/// smoke run passed and the envelope's `emulate` does not leave it out; and what the VM may
/// see.
#[allow(clippy::too_many_arguments)] // preflight's state, passed through once
fn mac_facts(
    o: &Options,
    sys: &mut dyn Sys,
    f: Facts,
    kind: VmKind,
    found: Option<&mac::Found>,
    docker: Option<&Docker>,
    image: Option<&str>,
    manifest: Option<&Manifest>,
    ex: Option<&str>,
    mounts: &[crate::vm::Mount],
    r: &mut Report,
) -> Facts {
    let meminfo = (kind == VmKind::Dedicated)
        .then(|| mac::meminfo(sys, found.map_or(&[][..], |x| &x.colima_env)))
        .flatten();
    let emulate: Option<Vec<String>> = envelope::envelope_value(ex, "emulate")
        .and_then(|v| v.as_array().cloned())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        });
    let x86 = manifest
        .and_then(|m| m.build_image("x86_64"))
        .map(ToString::to_string);
    let vm = probe::MacVm {
        kind,
        meminfo: meminfo.as_deref(),
        rosetta: found
            .and_then(|x| x.want.as_ref())
            .is_some_and(|w| w.rosetta),
        emulate: emulate.as_deref(),
        x86_64_image: x86.as_deref(),
    };
    let (f, said) = probe::in_mac_vm(f, &vm, &mut |img| {
        let d = docker.ok_or("no engine")?;
        let host = d.host();
        let how = probe::Probe {
            docker: &d.cli.to_string_lossy(),
            host: Some(&host),
            work_root: &o.places.home,
            image: None,
            emulation: None,
        };
        probe::rosetta_lane(&how, img)
    });
    match said {
        Some(probe::LaneSaid::Note(n)) => r.notes.push(n),
        Some(probe::LaneSaid::Warning(w)) => r.warnings.push(w),
        None => {}
    }
    if let (Some(d), Some(img)) = (docker, image) {
        let extra = if kind == VmKind::Shared {
            mac::home_parts(&o.places.home)
        } else {
            Vec::new()
        };
        mac::sees(d, img, &o.places.home, mounts, &extra, r);
    }
    f
}

/// What a finished install leaves for a person (linger, systemd), if anything.
#[derive(Debug, Default)]
pub struct Installed {
    pub needs_person: Vec<String>,
}

/// `omarchy-agent install`.
pub fn install(o: &Options, sys: &mut dyn Sys, out: &mut dyn Write) -> Result<Installed, Failure> {
    // install.sh refuses root too; this binary, run by hand as root, would make root the
    // agent's user.
    if files::euid() == 0 {
        return Err(Failure::Refused(
            "refusing to run as root: the agent never runs as root; run this as the user the agent will run as".into(),
        ));
    }
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
        if v.vm.is_some() {
            " (the dispatcher holds the VM's daemon socket: root in the VM, which sees nothing of your home directory)"
        } else if v.rootful {
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
    for d in [&p.data, &v.set_dir, &v.secrets_dir, &v.work_root] {
        files::make_dir(d).map_err(Failure::Refused)?;
    }
    let at = capacity::now();
    capacity::write_if_changed(&v.set_dir, &ready.capacity, &at)
        .map_err(|e| Failure::Refused(format!("{}/run/capacity.json: {e}", v.set_dir.display())))?;
    // The public address tasks leave from, before the token is written beside the host's
    // addresses (#371). Not seen this time: an earlier install's stays.
    if let Some(ip) = ready.public {
        addresses::keep_seen(&p.data, ip, &at).map_err(Failure::Refused)?;
    }

    // Enrollment: the owner's Confirm, then the host worker token.
    let eo = enroll::Options {
        pool: Some(ready.pool.clone()),
        paths: p.enroll_paths(&v.set_dir),
        token: o.token.clone(),
        wait: o.wait,
        poll: o.poll,
        sources: p.sources(),
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
    // The dispatcher's environment beside its token (#371): the secrets directory install
    // chose and the agent budget, now that agent.toml says them, and the host's addresses.
    let env_file = eo.paths.dispatcher_env();
    let rendered = Rendered::now(
        &p.sources(),
        &p.data,
        Some(Envelope::from_agent_toml(&text).map_err(Failure::Refused)?),
    );
    match dispatcher_env::refresh(&env_file, &rendered).map_err(Failure::Refused)? {
        Refresh::NoFile => {
            return Err(Failure::Refused(format!(
                "{} is gone since the enrollment wrote it",
                env_file.display()
            )))
        }
        Refresh::Written | Refresh::Unchanged => say(
            out,
            &format!(
                "{} (0600): the worker token, {}",
                env_file.display(),
                rendered.lines().map_err(Failure::Refused)?.join(", ")
            ),
        ),
    }

    agent_keys(o, v, sys, out)?;

    if let (Some(project), Some(seen)) = (&o.legacy, &ready.legacy) {
        let record = legacy::Legacy {
            project: project.clone(),
            recorded_at: at.clone(),
            containers: seen.containers.clone(),
            networks: seen.networks.clone(),
            rootful_exception: ready.facts.isolation() == capacity::Isolation::Root,
            // Where retire-legacy will write its marker (#344): compose's working directory.
            dir: seen.dir(),
            retired_at: None,
            retired_by: None,
        };
        legacy::record(&p.data, &record).map_err(Failure::Refused)?;
        say(
            out,
            &format!(
                "recorded the legacy project {project} in {}; nothing in it was changed",
                p.data.join(legacy::FILE).display()
            ),
        );
    }

    // The unit and linger, or the LaunchAgent; the service: its first round rolls the
    // bundle out.
    let first = format!(
        "its first round renders, pulls and starts release v{}'s bundle (omarchy-agent status)",
        ready.manifest.outer().release()
    );
    if p.mac() {
        let plist = p.render_plist().map_err(Failure::Refused)?;
        for d in [&p.launch_agents, &p.logs] {
            std::fs::create_dir_all(d)
                .map_err(|e| Failure::Refused(format!("{}: {e}", d.display())))?;
        }
        files::write(&p.launch_agents, launchd::PLIST, plist.as_bytes(), 0o644)
            .map_err(Failure::Refused)?;
        match launchd::start(sys, p.uid, &p.plist(), p.ssh) {
            Ok(()) => say(out, &format!("{} loaded (gui/{}), logs in {}: {first}; it starts again at each login (a LaunchAgent is login-scoped)", launchd::LABEL, p.uid, p.logs.display())),
            Err(e) => done.needs_person.push(e),
        }
    } else {
        let unit_text = unit::render(&p.data).map_err(Failure::Refused)?;
        files::make_dir(&p.unit_dir()).map_err(Failure::Refused)?;
        files::write(&p.unit_dir(), unit::NAME, unit_text.as_bytes(), 0o644)
            .map_err(Failure::Refused)?;
        if let Err(e) = unit::linger(sys, &p.user) {
            done.needs_person.push(e);
        }
        match unit::start(sys) {
            Ok(()) => say(out, &format!("{} started: {first}", unit::NAME)),
            Err(e) => done.needs_person.push(e),
        }
    }

    let fingerprint = HostKey::load_or_create(&eo.paths.state.join(KEY_FILE))
        .map_or_else(|e| e, |k| k.fingerprint());
    let c = &ready.capacity;
    let lanes = c
        .lanes()
        .iter()
        .map(|l| match l.via {
            Some(via) => format!("{} {} through {via}", l.arch, l.mode),
            None => format!("{} {}", l.arch, l.mode),
        })
        .collect::<Vec<_>>()
        .join(", ");
    say(
        out,
        &format!(
            "host {} on {}: {} CPUs, {} GB, lanes {lanes}, {} units ({} kept for pool jobs), isolation {}, host key {fingerprint}",
            id.host,
            ready.pool,
            c.cpus(),
            c.mem_gb(),
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
/// binaries and the secrets directory stay, so a new install keeps the identity. On a Mac
/// (#320) the `LaunchAgent` is booted out and its plist removed, the set directory (outside
/// the data directory) emptied, and the `omarchy` VM stopped, never deleted.
#[allow(clippy::too_many_lines)] // the uninstall's steps, in order
pub fn uninstall(
    places: &Places,
    sys: &mut dyn Sys,
    out: &mut dyn Write,
) -> Result<Vec<String>, String> {
    let mut left = Vec::new();
    if places.mac() {
        launchd::stop(sys, places.uid, places.ssh)?;
        files::remove(&places.launch_agents, launchd::PLIST)?;
        say(out, &format!("unloaded and removed {}", launchd::PLIST));
    } else {
        unit::stop(sys)?;
        files::remove(&places.unit_dir(), unit::NAME)?;
        unit::reload(sys);
        say(out, &format!("stopped and removed {}", unit::NAME));
    }

    let cfg = std::fs::read_to_string(places.agent_toml()).ok();
    let state = crate::run::state::load(&places.data.join("state.json"))
        .ok()
        .flatten();
    let cli = state
        .and_then(|s| s.tools)
        .and_then(|pins| tools::open(&places.data.join("tools"), &pins).ok())
        .map(|t| t.docker);
    // The omarchy VM is started (its saved configuration) for the containers to be removed;
    // Colima wants the pinned docker CLI on its PATH for that (#320).
    let colima = envelope::table_str(cfg.as_deref(), "vm", "runtime").as_deref() == Some("colima");
    let env = crate::vm::colima_env(cli.as_deref(), &places.docker_config());
    if colima
        && sys
            .run_env("colima", &["status", "--profile", crate::vm::PROFILE], &env)
            .is_err()
    {
        if let Err(e) = sys.run_env("colima", &["start", "--profile", crate::vm::PROFILE], &env) {
            left.push(format!(
                "needs a person: the {} VM did not start ({e})",
                crate::vm::PROFILE
            ));
        }
    }
    let legacy_record = std::fs::read(places.data.join(legacy::FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<legacy::Legacy>(&b).ok());
    let legacy_project = legacy_record.as_ref().map(|l| l.project.clone());
    let socket = envelope::set_path(cfg.as_deref(), "socket_cli");
    let project = envelope::set_str(cfg.as_deref(), "project")
        .unwrap_or_else(|| envelope::PROJECT.to_owned());
    let host = cfg
        .as_deref()
        .and_then(|t| toml::from_str::<toml::Table>(t).ok())
        .and_then(|t| t.get("host_id").and_then(|h| h.as_str().map(str::to_owned)));
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
    // A set directory outside the data directory (a Mac's, which the VM mounts): what is in
    // it goes, the directory prep-mac.sh made stays.
    if let Some(set) = envelope::set_path(cfg.as_deref(), "dir")
        .filter(|s| !keep_set && !s.starts_with(&places.data))
    {
        empty_set_dir(&set, places, cfg.as_deref())?;
    }
    if let Err(e) = forget_bundle(&places.data.join("state.json")) {
        left.push(format!("needs a person: state.json still names the removed bundle ({e}); a new install's first round may not start until an Update order"));
    }
    say(
        out,
        &format!(
            "removed the bundle's files under {}; the identity, agent.toml and the secrets stay",
            places.data.display()
        ),
    );
    match legacy_record {
        Some(l) if l.retired_at.is_some() => say(
            out,
            &format!(
                "the legacy project {} was retired already ({}); its marker stays in {}",
                l.project,
                l.retired_at.as_deref().unwrap_or_default(),
                l.dir
                    .as_ref()
                    .map_or_else(|| "its directory".to_owned(), |d| d.display().to_string())
            ),
        ),
        Some(l) => say(
            out,
            &format!("the legacy project {} was not touched", l.project),
        ),
        None => {}
    }
    if colima {
        match sys.run_env("colima", &["stop", "--profile", crate::vm::PROFILE], &env) {
            Ok(_) => say(
                out,
                &format!(
                    "stopped the {p} VM; `colima delete -p {p}` removes it and its disk",
                    p = crate::vm::PROFILE
                ),
            ),
            Err(e) => left.push(format!(
                "needs a person: the {} VM did not stop ({e})",
                crate::vm::PROFILE
            )),
        }
    }
    Ok(left)
}

/// Empties a set directory outside the data directory, when it is the agent's own and
/// holds none of the directories that stay (the data directory, the home directory, the
/// work root, the secrets directory).
fn empty_set_dir(set: &Path, places: &Places, cfg: Option<&str>) -> Result<(), String> {
    let keep = [
        Some(places.data.clone()),
        Some(places.home.clone()),
        envelope::set_path(cfg, "work_root"),
        envelope::set_path(cfg, "secrets_dir"),
    ];
    if keep.iter().flatten().any(|k| k.starts_with(set)) || files::owned_dir(set).is_err() {
        return Err(format!(
            "{}: not emptied (not the agent's own set directory)",
            set.display()
        ));
    }
    for e in std::fs::read_dir(set).map_err(|e| format!("{}: {e}", set.display()))? {
        let e = e.map_err(|e| format!("{}: {e}", set.display()))?;
        let p = e.path();
        let gone = if e.file_type().is_ok_and(|t| t.is_dir()) {
            std::fs::remove_dir_all(&p)
        } else {
            std::fs::remove_file(&p)
        };
        gone.map_err(|err| format!("{}: {err}", p.display()))?;
    }
    Ok(())
}

/// `state.json` without the bundle uninstall removed: no applied release and no round in
/// flight, so a new install's first round starts one again (a round that stops early on
/// "the pool names the release that runs" would leave the host with no dispatcher). The
/// trust floor, `min_release`, the revocations, the statement seq and the pinned tools
/// stay.
fn forget_bundle(path: &Path) -> Result<(), String> {
    let Some(mut state) = crate::run::state::load(path)? else {
        return Ok(());
    };
    state.applied = None;
    state.rollout = crate::run::state::Rollout::default();
    crate::run::state::save(path, &state)
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
