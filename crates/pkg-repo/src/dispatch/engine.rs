//! The container engine as the dispatcher uses it: make a lease's network,
//! sidecars and container from the spec's calls, read a container's state
//! (its exit code and `OOMKilled` survive a dispatcher restart, since nothing
//! is started with `--rm`), list this host's task containers and networks,
//! remove one lease's. Through the engine's CLI (`docker`, or `podman` where
//! that is what answers), each call with a deadline. A trait, so the loop's
//! tests run on a fake engine.

use std::time::{Duration, Instant};

use serde::Deserialize;

use super::spec::{self, EGRESS_NETWORK, GEN_LABEL, HOST_LABEL};
use crate::stop::{self, TASK_LABEL};

/// A container's state, as `inspect` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct State {
    /// `running`, `exited`, `created`, `paused`, `dead`, …
    pub status: String,
    pub exit_code: i32,
    /// The engine's out-of-memory kill: the task's memory limit, whatever its script reported.
    pub oom_killed: bool,
}

impl State {
    pub fn running(&self) -> bool {
        self.status == "running"
    }
    pub fn exited(&self) -> bool {
        self.status == "exited" || self.status == "stopped"
    }
}

pub trait Engine: Send + Sync {
    /// `<engine> <args…>`, one of the spec's calls (`network create`, `create`, `network connect`,
    /// `start`, `run -d`): `Ok` when the engine did it.
    fn run(&self, args: &[String]) -> Result<(), String>;
    /// `<engine> <args…>` for its output: (stdout, stderr), whatever its exit code; `Err` when the engine did not answer.
    fn output(&self, args: &[String]) -> Result<(String, String), String>;
    /// The container's state; `Ok(None)` when the engine has no such container, `Err` when the
    /// engine did not answer (a busy daemon is not a lost container: the loop asks again).
    fn inspect(&self, name: &str) -> Result<Option<State>, String>;
    /// The names of every container (any state) labelled with this host and a task: task containers and their sidecars.
    fn list(&self, host: &str) -> Result<Vec<String>, String>;
    /// The names of every network labelled with this host: task networks.
    fn networks(&self, host: &str) -> Result<Vec<String>, String>;
    /// Kills and removes one lease's containers (by its task and generation labels) — its task
    /// container and its sidecars — then its network.
    fn remove_lease(&self, task: u64, gen: &str);
    /// Removes one network by its name: one re-adoption found with no lease file to say what it is.
    fn remove_network(&self, name: &str);
    /// Kills and removes one container by its name: one re-adoption found with no lease file to say what it is.
    fn remove_name(&self, name: &str);
}

/// The shared `omarchy-egress` bridge, made once (labelled with this host): every egress sidecar is attached to it.
pub fn ensure_bridge(engine: &dyn Engine, host: &str) -> Result<(), String> {
    let inspect = ["network", "inspect", EGRESS_NETWORK].map(str::to_owned);
    if engine.run(&inspect).is_ok() {
        return Ok(());
    }
    let create = [
        "network".to_owned(),
        "create".to_owned(),
        "--label".to_owned(),
        format!("{HOST_LABEL}={host}"),
        EGRESS_NETWORK.to_owned(),
    ];
    // Made meanwhile by another call of this dispatcher: there it is.
    engine
        .run(&create)
        .or_else(|e| engine.run(&inspect).map_err(|_| e))
}

/// The engine's CLI.
pub struct Cli {
    pub runtime: String,
}

/// How long one engine call may take: a `run` pulls nothing (the image is pinned and
/// present, or it is pulled within this), the others answer in seconds.
const CALL: Duration = Duration::from_secs(300);

impl Cli {
    /// `docker` when it answers, `podman` otherwise (the worker image carries docker's CLI
    /// for whatever socket is mounted; a podman host's tests run podman's).
    pub fn find() -> Option<Self> {
        let answers = |r: &str| {
            std::process::Command::new(r)
                .arg("--version")
                .output()
                .is_ok_and(|o| o.status.success())
        };
        ["docker", "podman"]
            .into_iter()
            .find(|r| answers(r))
            .map(|r| Self {
                runtime: r.to_owned(),
            })
    }

    /// SIGKILL, then removed: podman's `rm -f` stops with SIGTERM and waits ten seconds first, and a
    /// sidecar's process, pid 1 without a handler, ignores SIGTERM.
    fn kill_rm(&self, name: &str) {
        let _ = self.call(&["kill", name]);
        let _ = self.call(&["rm", "-f", name]);
    }

    fn call(&self, args: &[&str]) -> Result<std::process::Output, String> {
        stop::real_engine(&self.runtime, args, Instant::now() + CALL).ok_or_else(|| {
            format!(
                "{} {} did not answer",
                self.runtime,
                args.first().unwrap_or(&"")
            )
        })
    }
}

#[derive(Deserialize)]
struct RawState {
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "ExitCode", default)]
    exit_code: i32,
    #[serde(rename = "OOMKilled", default)]
    oom_killed: bool,
}

/// Whether `inspect`'s error says the container does not exist — docker: "No such container: …"
/// (or "No such object"), podman: "no such container" — and not that the engine did not answer
/// ("dial unix …: connect: no such file or directory" is a socket that is not there).
fn missing(stderr: &str) -> bool {
    let e = stderr.to_ascii_lowercase();
    e.contains("no such container") || e.contains("no such object")
}

/// `inspect --format '{{json .State}}'`, read.
pub fn parse_state(json: &str) -> Option<State> {
    let raw: RawState = serde_json::from_str(json.trim()).ok()?;
    Some(State {
        status: raw.status.to_ascii_lowercase(),
        exit_code: raw.exit_code,
        oom_killed: raw.oom_killed,
    })
}

impl Engine for Cli {
    fn run(&self, args: &[String]) -> Result<(), String> {
        let a: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = self.call(&a)?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{} run: {}",
                self.runtime,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    fn output(&self, args: &[String]) -> Result<(String, String), String> {
        let a: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = self.call(&a)?;
        Ok((
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ))
    }

    fn inspect(&self, name: &str) -> Result<Option<State>, String> {
        let out = self.call(&[
            "inspect",
            "--type",
            "container",
            "--format",
            "{{json .State}}",
            name,
        ])?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            if missing(&err) {
                return Ok(None);
            }
            return Err(format!("{} inspect: {}", self.runtime, err.trim()));
        }
        parse_state(&String::from_utf8_lossy(&out.stdout))
            .map(Some)
            .ok_or_else(|| format!("{} inspect: an answer that does not read", self.runtime))
    }

    fn list(&self, host: &str) -> Result<Vec<String>, String> {
        let host_filter = format!("label={HOST_LABEL}={host}");
        let task_filter = format!("label={TASK_LABEL}");
        let out = self.call(&[
            "ps",
            "-a",
            "--filter",
            &host_filter,
            "--filter",
            &task_filter,
            "--format",
            "{{.Names}}",
        ])?;
        if !out.status.success() {
            return Err(format!(
                "{} ps: {}",
                self.runtime,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect())
    }

    fn networks(&self, host: &str) -> Result<Vec<String>, String> {
        let host_filter = format!("label={HOST_LABEL}={host}");
        let out = self.call(&[
            "network",
            "ls",
            "--filter",
            &host_filter,
            "--format",
            "{{.Name}}",
        ])?;
        if !out.status.success() {
            return Err(format!(
                "{} network ls: {}",
                self.runtime,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect())
    }

    fn remove_name(&self, name: &str) {
        self.kill_rm(name);
    }

    fn remove_network(&self, name: &str) {
        let _ = self.call(&["network", "rm", name]);
    }

    fn remove_lease(&self, task: u64, gen: &str) {
        let t = format!("label={TASK_LABEL}={task}");
        let g = format!("label={GEN_LABEL}={gen}");
        let Ok(out) = self.call(&["ps", "-aq", "--filter", &t, "--filter", &g]) else {
            return;
        };
        for id in String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric()))
        {
            self.kill_rm(id);
        }
        // Its network once nothing is attached to it (`rm -f` returns once the container is gone).
        let _ = self.call(&["network", "rm", &spec::container_name(task, gen)]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_docker_and_podman_print() {
        let docker = r#"{"Status":"exited","Running":false,"Paused":false,"Restarting":false,"OOMKilled":true,"Dead":false,"Pid":0,"ExitCode":137,"Error":"","StartedAt":"2026-10-01T10:00:00Z","FinishedAt":"2026-10-01T10:05:00Z"}"#;
        assert_eq!(
            parse_state(docker),
            Some(State {
                status: "exited".into(),
                exit_code: 137,
                oom_killed: true
            })
        );
        let podman = r#"{"OciVersion":"1.2.0","Status":"running","Running":true,"Paused":false,"Restarting":false,"OOMKilled":false,"Dead":false,"Pid":42,"ExitCode":0}"#;
        let s = parse_state(podman).unwrap();
        assert!(s.running() && !s.oom_killed);
        assert_eq!(parse_state("no such container"), None);
    }

    #[test]
    fn a_missing_container_is_not_an_engine_that_does_not_answer() {
        assert!(missing(
            "Error: No such container: omarchy-task-7-g_0123456789abcdef"
        ));
        assert!(missing("Error response from daemon: No such object: x"));
        assert!(missing("Error: no such container \"x\""));
        assert!(!missing(
            "Error: dial unix /run/podman/podman.sock: connect: no such file or directory"
        ));
        assert!(!missing("failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory"));
    }
}
