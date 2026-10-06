//! The engine, as install sees it (#317, design v2 §13.2 step 4): which socket it
//! answers on, in v1 §10.5's order, and the pinned docker CLI to ask it with.
//!
//! A socket that refuses this user (`EACCES`) is a person's to fix — the docker group
//! applies to new logins only — so it is reported as "needs a person", never retried.

use std::io::ErrorKind;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// One engine call (design v2 §10: no call blocks longer than this); the egress probe and
/// image pulls get the longer one.
const CALL: Duration = Duration::from_secs(600);

/// The docker CLI (the pinned one) on one socket.
#[derive(Debug, Clone)]
pub(crate) struct Docker {
    pub cli: PathBuf,
    pub socket: PathBuf,
}

impl Docker {
    pub fn host(&self) -> String {
        format!("unix://{}", self.socket.display())
    }

    /// Runs the CLI under a cleared environment with `--host`, so no `DOCKER_HOST` or
    /// `DOCKER_CONTEXT` of the person's decides which engine is asked.
    pub fn run(&self, args: &[&str]) -> Result<String, String> {
        let mut c = Command::new(&self.cli);
        c.env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", std::env::var_os("HOME").unwrap_or_default())
            .args(["--host", &self.host()])
            .args(args);
        crate::capacity::probe::run(c, CALL)
    }

    /// Which engine answers on the socket ([`parse_server`]).
    pub fn server(&self) -> Result<Server, String> {
        parse_server(&self.run(&["version", "--format", "{{json .Server}}"])?)
    }

    /// podman's own version where podman answers on the socket ([`parse_podman`]).
    pub fn podman(&self) -> Result<Option<String>, String> {
        parse_podman(&self.run(&["version", "--format", "{{json .Server}}"])?)
    }
}

/// `version --format '{{json .Server}}'`'s `Podman Engine` component's version (the Quadlet
/// driver's keys need a podman recent enough, #330), or `None` where another engine answers.
pub(crate) fn parse_podman(json: &str) -> Result<Option<String>, String> {
    #[derive(serde::Deserialize)]
    struct Component {
        #[serde(rename = "Name", default)]
        name: String,
        #[serde(rename = "Version", default)]
        version: String,
    }
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(rename = "Components", default)]
        components: Option<Vec<Component>>,
    }
    let s: Raw = serde_json::from_str(json.trim())
        .map_err(|_| format!("the engine's version does not read: {:?}", json.trim()))?;
    Ok(s.components
        .unwrap_or_default()
        .into_iter()
        .find(|c| c.name == "Podman Engine")
        .map(|c| {
            c.version
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
                .take(40)
                .collect()
        }))
}

/// The engine behind the socket, as the dispatcher tells it apart (#367): podman behind its
/// docker-compatible API (whose task networks are made through libpod's, #372), or Docker and
/// its major version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Server {
    Podman,
    Docker(u32),
}

/// `version --format '{{json .Server}}'`, read the way the dispatcher reads it (pkg-repo's
/// `dispatch::engine::gateway_of`): podman names itself among the components.
pub(crate) fn parse_server(json: &str) -> Result<Server, String> {
    #[derive(serde::Deserialize)]
    struct Component {
        #[serde(rename = "Name", default)]
        name: String,
    }
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(rename = "Version", default)]
        version: String,
        #[serde(rename = "Components", default)]
        components: Option<Vec<Component>>,
    }
    let s: Raw = serde_json::from_str(json.trim())
        .map_err(|_| format!("the engine's version does not read: {:?}", json.trim()))?;
    if s.components
        .unwrap_or_default()
        .iter()
        .any(|c| c.name.contains("Podman"))
    {
        return Ok(Server::Podman);
    }
    s.version
        .split('.')
        .next()
        .and_then(|m| m.parse().ok())
        .map(Server::Docker)
        .ok_or_else(|| format!("the engine's version does not read: {:?}", s.version))
}

/// How a task's own network is made on this engine, as the dispatcher makes it (#336, #372;
/// pkg-repo's `dispatch::spec::Gateway`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TaskNetwork {
    /// Docker 28 or newer, by the CLI with these `network create` options: internal, with the
    /// isolated gateway mode, so no address of the host is on its bridge.
    Cli(Vec<&'static str>),
    /// podman, through libpod's own API ([`super::libpod`]): internal with DNS off, so it has
    /// no gateway. Its docker API would turn DNS on and drop docker's option.
    Libpod,
}

/// How a task's own network is made on this engine ([`TaskNetwork`]). An older Docker is
/// refused, as the dispatcher refuses it.
pub(crate) fn task_network(s: Server) -> Result<TaskNetwork, String> {
    match s {
        Server::Podman => Ok(TaskNetwork::Libpod),
        Server::Docker(m) if m >= 28 => Ok(TaskNetwork::Cli(vec![
            "--internal",
            "-o",
            "com.docker.network.bridge.gateway_mode_ipv4=isolated",
        ])),
        Server::Docker(m) => Err(format!(
            "docker {m} cannot keep a task network's gateway off the host (com.docker.network.bridge.gateway_mode_ipv4=isolated needs Docker 28 or newer), and the dispatcher refuses it: upgrade the engine"
        )),
    }
}

/// What connecting to a socket said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Socket {
    Answers,
    /// `EACCES`: the socket is there, this user may not use it (yet).
    Denied,
    Absent,
}

pub(crate) fn connect(path: &Path) -> Socket {
    match UnixStream::connect(path) {
        Ok(_) => Socket::Answers,
        Err(e) if e.kind() == ErrorKind::PermissionDenied => Socket::Denied,
        Err(_) => Socket::Absent,
    }
}

/// The sockets tried, in order (v1 §10.5): rootless podman's API socket, rootless docker,
/// the rootful daemon. Colima and other VM sockets are macOS's (P3).
pub(crate) fn candidates(xdg_runtime_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(r) = xdg_runtime_dir {
        out.push(r.join("podman/podman.sock"));
        out.push(r.join("docker.sock"));
    }
    out.push(PathBuf::from("/var/run/docker.sock"));
    out
}

/// The first socket that answers; `given` (`--socket`, or agent.toml's) alone when set.
pub(crate) fn discover(
    given: Option<&Path>,
    candidates: &[PathBuf],
    probe: impl Fn(&Path) -> Socket,
) -> Result<PathBuf, String> {
    let list: Vec<&Path> = match given {
        Some(g) => vec![g],
        None => candidates.iter().map(PathBuf::as_path).collect(),
    };
    let mut denied = None;
    for p in &list {
        match probe(p) {
            Socket::Answers => return Ok(p.to_path_buf()),
            Socket::Denied => {
                denied.get_or_insert(*p);
            }
            Socket::Absent => {}
        }
    }
    if let Some(p) = denied {
        return Err(denied_message(p));
    }
    Err(format!(
        "no container engine answers on {}: install rootless podman (its API socket: systemctl --user enable --now podman.socket) or docker (factory/host/prep-root.sh does either)",
        list.iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

pub(crate) fn denied_message(p: &Path) -> String {
    format!(
        "needs a person: {} refuses this user (EACCES); log out and back in, or reboot, so the docker group applies",
        p.display()
    )
}
