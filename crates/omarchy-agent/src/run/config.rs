//! The agent's local configuration: `agent.toml` (design v2 §12) and the data directory.
//!
//! agent.toml is written by `omarchy-agent install` (#317: with the `host_id` and
//! `worker_id` the enrollment gave, #321), by a person at the host and by the person's
//! `omarchy-agent runtime switch` there (#325), never by the pool. It is refused when
//! group- or world-writable or owned by another user. Unknown keys are left alone
//! (capacity caps are #333's). What the pool may narrow inside it — units, emulated lanes
//! — and what it allows the pool to ask — diagnostics — is [`Policy`] (#325, design v2
//! §12). Any problem here is a local configuration error: the loop exits 78 and says why.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

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
    /// The host key the enrollment made (`crate::enroll::Paths`): the host state's and
    /// the report's requests are signed with it (#344).
    pub fn host_key(&self) -> PathBuf {
        self.data.join("state").join(crate::host::KEY_FILE)
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
    pub envelope: Envelope,
    /// What install detected behind the socket (`set.engine`, #317): the lint holds a
    /// rootful one to `rootful_ack` and `dedicated`. Absent, the strict (rootful) case.
    pub engine: Engine,
    /// The engine the compose driver talks to (`set.runtime`, `docker` or `podman`): what
    /// `runtime switch` moved the bundle to (#325). Absent, `docker`'s API, which podman's
    /// socket speaks too.
    pub runtime: Runtime,
    /// The envelope's bounds on what the pool may narrow and ask (#325).
    pub policy: Policy,
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
    /// both of this binary's).
    pub drivers: Vec<String>,
}

impl Policy {
    /// Whether the envelope lets the bundle run on `r`'s driver.
    pub fn allows_driver(&self, r: Runtime) -> bool {
        self.drivers
            .iter()
            .any(|d| d == "compose" || *d == r.driver())
    }

    /// Whether the envelope lets an emulated lane of `arch` run.
    pub fn allows_lane(&self, arch: &str) -> bool {
        self.emulate
            .as_ref()
            .is_none_or(|e| e.iter().any(|a| a == arch))
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
}

#[derive(Deserialize, Default)]
struct EnvelopePart {
    task_subnets: Option<String>,
    max_units: Option<u32>,
    emulate: Option<Vec<String>>,
    #[serde(default)]
    diagnostics: bool,
    drivers: Option<Vec<String>>,
}

/// The architectures a lane may be (design v2 §7.4).
pub(crate) const ARCHES: [&str; 2] = ["x86_64", "aarch64"];

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
        let engine = match f.set.engine.as_deref() {
            None | Some("rootful") => Engine::Rootful,
            Some("rootless") => Engine::Rootless,
            Some(other) => {
                return Err(format!(
                    "agent.toml: set.engine {other:?} is neither \"rootful\" nor \"rootless\""
                ))
            }
        };
        let runtime = match f.set.runtime.as_deref() {
            None => Runtime::Docker,
            Some(r) => Runtime::parse(r).ok_or_else(|| {
                format!("agent.toml: set.runtime {r:?} is neither \"docker\" nor \"podman\"")
            })?,
        };
        if let Some(bad) = f
            .envelope
            .emulate
            .iter()
            .flatten()
            .find(|a| !ARCHES.contains(&a.as_str()))
        {
            return Err(format!(
                "agent.toml: envelope.emulate names {bad:?}, which is neither x86_64 nor aarch64"
            ));
        }
        let policy = Policy {
            max_units: f.envelope.max_units,
            emulate: f.envelope.emulate,
            diagnostics: f.envelope.diagnostics,
            drivers: f
                .envelope
                .drivers
                .unwrap_or_else(|| vec!["compose".to_owned()]),
        };
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
            engine,
            runtime,
            policy,
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
            }
        );
        assert!(c.policy.allows_lane("x86_64") && !c.policy.allows_lane("aarch64"));
        assert!(c.policy.allows_driver(Runtime::Podman));
        assert_eq!(c.runtime, Runtime::Docker);
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
        assert_eq!(podman.runtime.driver(), "compose/podman");
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
