//! The container engine as the dispatcher uses it: start a task container
//! from the spec's arguments, read a container's state (its exit code and
//! `OOMKilled` survive a dispatcher restart, since nothing is started with
//! `--rm`), list this host's task containers, remove one lease's. Through
//! the engine's CLI (`docker`, or `podman` where that is what answers), each
//! call with a deadline. A trait, so the loop's tests run on a fake engine.

use std::time::{Duration, Instant};

use serde::Deserialize;

use super::spec::{GEN_LABEL, HOST_LABEL};
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
    /// `<engine> <args…>`: the spec's `run -d …`.
    fn run(&self, args: &[String]) -> Result<(), String>;
    /// The container's state; `Ok(None)` when the engine has no such container, `Err` when the
    /// engine did not answer (a busy daemon is not a lost container: the loop asks again).
    fn inspect(&self, name: &str) -> Result<Option<State>, String>;
    /// The names of every container (any state) labelled with this host and a task.
    fn list(&self, host: &str) -> Result<Vec<String>, String>;
    /// Kills and removes one lease's containers (by its task and generation labels): the
    /// task container now, its sidecars once they exist.
    fn remove_lease(&self, task: u64, gen: &str);
    /// Kills and removes one container by its name: one re-adoption found with no lease file to say what it is.
    fn remove_name(&self, name: &str);
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
            // docker: "Error: No such container: …"; podman: "no such container …".
            if err.to_ascii_lowercase().contains("no such") {
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

    fn remove_name(&self, name: &str) {
        let _ = self.call(&["rm", "-f", name]);
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
            let _ = self.call(&["rm", "-f", id]);
        }
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
}
