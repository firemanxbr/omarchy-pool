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
