//! A legacy set beside the new bundle (#317, design v2 §13.2 step 8, §21): with
//! `--legacy <compose project>` the project is only recorded, in `legacy.json`, and
//! nothing in it is changed — no container, file or network, and no marker (that is the
//! `retire-legacy` host order's, #344, `crate::run`'s). Preflight checks that it exists
//! and that the new work root and task subnets do not overlap its paths and networks;
//! uninstall never touches it. The record keeps the project's directory (compose's
//! working directory, where its `compose.yml` is), the one `retire-legacy` writes its
//! marker into, and once retired, when and by which order.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::engine::Docker;
use super::net::Cidr;

pub(crate) const FILE: &str = "legacy.json";
const PROJECT_LABEL: &str = "com.docker.compose.project";
const DIR_LABEL: &str = "com.docker.compose.project.working_dir";

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
    /// The project's directory, when its containers named one (a record from before #344
    /// has none: `retire-legacy` then reads it from the containers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<PathBuf>,
    /// `retire-legacy` stopped and removed it (#344): when, and the order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_by: Option<String>,
}

/// `legacy.json` under the data directory: `Ok(None)` when there is none. The file is the
/// agent's own (install wrote it 0600): one that is a link, another user's or writable by
/// others is refused.
pub(crate) fn recorded(data: &Path) -> Result<Option<Legacy>, String> {
    let path = data.join(FILE);
    super::files::check_owner_file(&path)?;
    match std::fs::read(&path) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Writes `legacy.json` (0600, through `openat` with `O_NOFOLLOW`).
pub(crate) fn record(data: &Path, l: &Legacy) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(l).map_err(|e| e.to_string())?;
    super::files::write(data, FILE, &body, 0o600)
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
    /// The working directories its containers name (compose's label), each once.
    pub dirs: Vec<PathBuf>,
}

impl Seen {
    /// The project's one directory, when its containers agree on one absolute path.
    pub fn dir(&self) -> Option<PathBuf> {
        match self.dirs.as_slice() {
            [d] if d.is_absolute() => Some(d.clone()),
            _ => None,
        }
    }
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
        let format = format!("{{{{index .Config.Labels \"{DIR_LABEL}\"}}}}");
        let mut args = vec!["inspect", "--format", format.as_str()];
        args.extend(seen.containers.iter().map(String::as_str));
        for d in lines(&docker.run(&args)?) {
            let d = PathBuf::from(d);
            if !seen.dirs.contains(&d) {
                seen.dirs.push(d);
            }
        }
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
