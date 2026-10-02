//! A legacy set beside the new bundle (#317, design v2 §13.2 step 8, §21): with
//! `--legacy <compose project>` the project is only recorded, in `legacy.json`, and
//! nothing in it is changed — no container, file or network, and no marker (that is
//! `retire-legacy`'s, P3). Preflight checks that it exists and that the new work root and
//! task subnets do not overlap its paths and networks; uninstall never touches it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::engine::Docker;
use super::net::Cidr;

pub(crate) const FILE: &str = "legacy.json";
const PROJECT_LABEL: &str = "com.docker.compose.project";

/// `legacy.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Legacy {
    pub project: String,
    pub recorded_at: String,
    /// The project's container ids and networks when it was recorded.
    pub containers: Vec<String>,
    pub networks: Vec<String>,
    /// A rootful daemon without userns-remap, allowed beside the legacy set until P6.
    pub rootful_exception: bool,
}

/// A compose project name as compose takes it.
pub(crate) fn valid_project(p: &str) -> bool {
    (1..=64).contains(&p.len())
        && p.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && p.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
}

/// What the engine has of the project: its containers, networks, bind-mount sources and
/// subnets. Read only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Seen {
    pub containers: Vec<String>,
    pub networks: Vec<String>,
    pub paths: Vec<PathBuf>,
    pub subnets: Vec<Cidr>,
}

fn lines(s: &str) -> Vec<String> {
    s.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

pub(crate) fn look(docker: &Docker, project: &str) -> Result<Seen, String> {
    let filter = format!("label={PROJECT_LABEL}={project}");
    let containers = lines(&docker.run(&["ps", "-aq", "--no-trunc", "--filter", &filter])?);
    let networks =
        lines(&docker.run(&["network", "ls", "-q", "--no-trunc", "--filter", &filter])?);
    let mut seen = Seen {
        containers,
        networks,
        ..Seen::default()
    };
    if !seen.containers.is_empty() {
        let mut args = vec![
            "inspect",
            "--format",
            "{{range .Mounts}}{{if eq .Type \"bind\"}}{{.Source}}\n{{end}}{{end}}",
        ];
        args.extend(seen.containers.iter().map(String::as_str));
        seen.paths = lines(&docker.run(&args)?)
            .into_iter()
            .map(PathBuf::from)
            .collect();
    }
    if !seen.networks.is_empty() {
        let mut args = vec![
            "network",
            "inspect",
            "--format",
            "{{range .IPAM.Config}}{{.Subnet}}\n{{end}}",
        ];
        args.extend(seen.networks.iter().map(String::as_str));
        seen.subnets = lines(&docker.run(&args)?)
            .iter()
            .filter_map(|s| Cidr::parse(s))
            .collect();
    }
    Ok(seen)
}

/// Preflight's part: the project exists, and the new work root and task subnets stay
/// clear of its paths and networks.
pub(crate) fn check(project: &str, seen: &Seen, work_root: &Path, task: &[Cidr]) -> Vec<String> {
    let mut out = Vec::new();
    if seen.containers.is_empty() {
        out.push(format!(
            "legacy: no container of the compose project {project:?} on this engine (docker ps -a --filter label={PROJECT_LABEL}={project})"
        ));
    }
    for p in &seen.paths {
        if p.starts_with(work_root) || work_root.starts_with(p) {
            out.push(format!(
                "legacy: the work root {} overlaps the legacy project's {}; give a new --work-root beside it",
                work_root.display(),
                p.display()
            ));
        }
    }
    for t in task {
        if let Some(s) = seen.subnets.iter().find(|s| t.overlaps(**s)) {
            out.push(format!(
                "legacy: the task subnets {t} overlap the legacy project's network {s}; give other --task-subnets"
            ));
        }
    }
    out
}

/// Of `containers` (id, compose project), the ones uninstall removes: never one of the
/// recorded legacy project.
pub(crate) fn removable<'a>(
    containers: &'a [(String, String)],
    legacy: Option<&str>,
) -> Vec<&'a str> {
    containers
        .iter()
        .filter(|(_, project)| Some(project.as_str()) != legacy)
        .map(|(id, _)| id.as_str())
        .collect()
}
