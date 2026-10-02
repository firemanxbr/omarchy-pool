//! The agent's local configuration: `agent.toml` (design v2 §12) and the data directory.
//!
//! agent.toml is written by `omarchy-agent install` (#317) and by a person at the host,
//! never by the pool. It is refused when group- or world-writable or owned by another
//! user. Unknown keys are left alone (capacity caps are #333's, settings P4's). Any
//! problem here is a local configuration error: the loop exits 78 and says why.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::lint::Envelope;

/// Where the agent keeps everything (design v2 §13.1): `--data`, `$OMARCHY_AGENT_DATA`,
/// `$XDG_DATA_HOME/omarchy-agent`, or `~/.local/share/omarchy-agent`.
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
        .ok_or_else(|| "no data directory: give --data, or set OMARCHY_AGENT_DATA or HOME".into())
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// The pool origin (`https://...`); it must also be in a bundle's signed `pools`.
    pub pool: String,
    pub host_id: String,
    /// The host's worker registration (#321), whose open Update `follow` reports.
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
    pub envelope: Envelope,
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
}

#[derive(Deserialize, Default)]
struct EnvelopePart {
    task_subnets: Option<String>,
}

/// An id the pool hands out (host and worker ids): what `follow` accepts.
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
        let set_name = f.set.name.unwrap_or_else(|| "host".into());
        if set_name != "host" {
            return Err(format!(
                "agent.toml: set.name {set_name:?}: this agent runs the host set only"
            ));
        }
        if let Some(d) = f.set.driver.filter(|d| d != "compose") {
            return Err(format!(
                "agent.toml: set.driver {d:?}: this agent has the compose driver only"
            ));
        }
        let socket_cli = need_path(f.set.socket_cli, "set.socket_cli")?;
        let socket_mount = match f.set.socket_mount {
            None => socket_cli.clone(),
            some => need_path(some, "set.socket_mount")?,
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
            envelope,
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn example(set_dir: &Path, work_root: &Path, secrets: &Path) -> String {
        format!(
            r#"pool = "https://pkgs.omarchy-pool.org"
host_id = "h_test"
worker_id = "w_test"
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
        for (from, to, why) in [
            (
                "https://omarchy-pool.example.org",
                "http://x",
                "not an https://",
            ),
            (
                "driver       = \"compose\"",
                "driver = \"quadlet\"",
                "compose driver only",
            ),
            (
                "/var/run/docker.sock\"\nsocket_mount",
                "docker.sock\"\nsocket_mount",
                "plain absolute",
            ),
        ] {
            let text = format!("worker_id = \"w_1\"\n{}", studio.replacen(from, to, 1));
            let e = Config::parse(&text).unwrap_err();
            assert!(e.contains(why), "{why}: {e}");
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
