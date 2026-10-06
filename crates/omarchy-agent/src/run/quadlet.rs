//! The Quadlet driver (design v2 §15, v1 §10.2; #330): for a rootless podman host with no
//! compose. Each service of the set renders to `<unit>.container` in the user's Quadlet
//! directory ([`crate::quadlet`]), and apply is `systemctl --user daemon-reload` plus
//! `restart`: podman's generator turns the file into a user service that runs the
//! container, restarts it as compose's restart policy would, and starts it at boot.
//! podman's `AutoUpdate=` is never used: the agent alone moves the host to a release,
//! behind the same guard, revert and quarantine as the compose driver's rounds — the
//! rollout state machine is the same code, and only this driver's answers differ.
//!
//! What it runs: `systemctl --user` (the agent's own user manager; it never runs as root)
//! and, for everything it asks of the engine — a container's state and labels, its exits,
//! its `/ready`, a pull, an image's removal, the host's task containers — the pinned
//! docker CLI on podman's API socket, as the compose driver does ([`super::compose`]). The
//! podman CLI itself is never run by the agent, so `NoNewPrivileges=yes` in the agent's
//! unit does not meet rootless podman's `newuidmap`: the user manager starts the unit.
//!
//! The container is replaced at each restart (Quadlet's `--rm`), so a unit is followed by
//! its name — the container's, the unit's — never by a container id: its state is the
//! service's (`activating` between restarts is `restarting`), its restart count the
//! service's `NRestarts`, its exits the engine's `die` events for that name. Task
//! containers stay the dispatcher's: nothing here lists, stops or removes one.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::quadlet::{self, Rendered, Source, HASH_LABEL};

use super::compose::CALL;
use super::driver::{Answer, Driver, EngineId, Exit, Foreign, Project, PullState, Unit};
use super::exec;

/// The user's systemd, as the driver asks it.
pub(crate) trait Systemd {
    /// `systemctl --user <args>` to its end, within [`CALL`]: its output, whatever its exit.
    fn user(&mut self, args: &[&str]) -> Result<exec::Output, String>;
}

/// `systemctl --user`, the agent's own user manager: an empty environment but the runtime
/// directory (and the user bus, when the agent was given one) it is found through.
pub(crate) struct Systemctl {
    program: PathBuf,
    env: Vec<(String, String)>,
}

impl Systemctl {
    /// `systemctl` where the distribution puts it, with this process's runtime directory
    /// (`/run/user/<uid>` when the environment names none).
    pub fn from_env() -> Self {
        let program = systemctl_path();
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let runtime = var("XDG_RUNTIME_DIR")
            .unwrap_or_else(|| format!("/run/user/{}", rustix::process::getuid().as_raw()));
        let mut env = vec![("XDG_RUNTIME_DIR".to_owned(), runtime)];
        if let Some(bus) = var("DBUS_SESSION_BUS_ADDRESS") {
            env.push(("DBUS_SESSION_BUS_ADDRESS".to_owned(), bus));
        }
        Systemctl { program, env }
    }

    #[cfg(test)]
    pub fn at(program: &Path, env: &[(&str, &str)]) -> Self {
        Systemctl {
            program: program.to_owned(),
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        }
    }
}

/// The system's `systemctl`, where distributions put it: never one `PATH` finds first.
pub(crate) fn systemctl_path() -> PathBuf {
    ["/usr/bin/systemctl", "/bin/systemctl"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("/usr/bin/systemctl"))
}

impl Systemd for Systemctl {
    fn user(&mut self, args: &[&str]) -> Result<exec::Output, String> {
        let mut c = Command::new(&self.program);
        c.env_clear()
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .current_dir("/")
            .arg("--user")
            .args(args);
        exec::run(c, CALL)
    }
}

/// podman's Quadlet generator, where systemd looks for a user generator (podman 4.4 on).
pub(crate) fn generator() -> Option<PathBuf> {
    [
        "/usr/lib/systemd/user-generators/podman-user-generator",
        "/lib/systemd/user-generators/podman-user-generator",
        "/usr/local/lib/systemd/user-generators/podman-user-generator",
        "/etc/systemd/user-generators/podman-user-generator",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
}

pub(crate) struct Quadlet {
    /// The pinned docker CLI on podman's API socket (the compose driver's), for what the
    /// driver asks of the engine.
    api: Box<dyn Driver>,
    systemd: Box<dyn Systemd>,
    /// The user's Quadlet directory, where the units go.
    units: PathBuf,
}

/// What `systemctl --user show` says of a unit.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Shown {
    load: String,
    active: String,
    sub: String,
    restarts: u64,
    status: i64,
}

fn parse_show(stdout: &str) -> Shown {
    let mut s = Shown::default();
    for line in stdout.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim();
        match k {
            "LoadState" => v.clone_into(&mut s.load),
            "ActiveState" => v.clone_into(&mut s.active),
            "SubState" => v.clone_into(&mut s.sub),
            "NRestarts" => s.restarts = v.parse().unwrap_or(0),
            "ExecMainStatus" => s.status = v.parse().unwrap_or(0),
            _ => {}
        }
    }
    s
}

/// A unit (and container) name the driver writes: its own, never an option.
fn is_unit(s: &str) -> bool {
    s.starts_with("omarchy-")
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// Why `systemctl` failed: its last word.
fn failed(o: &exec::Output) -> String {
    let last = o
        .stderr
        .lines()
        .chain(o.stdout.lines())
        .map(str::trim)
        .rfind(|l| !l.is_empty());
    let code = o
        .code
        .map_or_else(|| "ended by a signal".into(), |c| format!("exit {c}"));
    match last {
        Some(l) => format!("systemctl --user: {code}: {l}"),
        None => format!("systemctl --user: {code}"),
    }
}

/// The value of label `key` in a unit the driver wrote (one `Label="key=value"` a line).
fn label_in(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| {
        l.strip_prefix("Label=\"")?
            .strip_suffix('"')?
            .strip_prefix(key)?
            .strip_prefix('=')
            .map(str::to_owned)
    })
}

impl Quadlet {
    pub fn new(api: Box<dyn Driver>, systemd: Box<dyn Systemd>, units: &Path) -> Self {
        Quadlet {
            api,
            systemd,
            units: units.to_owned(),
        }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.units.join(format!("{name}.container"))
    }

    /// `p`'s services as units, from the files compose would load.
    fn render(p: &Project) -> Result<Vec<Rendered>, String> {
        let texts: Vec<(String, String)> = p
            .files
            .iter()
            .map(|f| {
                fs::read_to_string(f)
                    .map(|t| (f.display().to_string(), t))
                    .map_err(|e| format!("{}: {e}", f.display()))
            })
            .collect::<Result<_, _>>()?;
        let sources: Vec<Source> = texts
            .iter()
            .map(|(name, text)| Source { name, text })
            .collect();
        quadlet::render(&p.name, &p.dir, &sources, &p.env)
    }

    fn systemctl(&mut self, args: &[&str]) -> Answer<exec::Output> {
        match self.systemd.user(args) {
            Ok(o) if o.ok() => Answer::Yes(o),
            Ok(o) => Answer::NoAnswer(failed(&o)),
            Err(e) => Answer::NoAnswer(e),
        }
    }

    fn show(&mut self, name: &str) -> Answer<Shown> {
        let service = format!("{name}.service");
        self.systemctl(&[
            "show",
            "--property=LoadState,ActiveState,SubState,NRestarts,ExecMainStatus",
            &service,
        ])
        .map(|o| parse_show(&o.stdout))
    }

    /// The unit `name` of `service`, as the rollout reads one; `None` when systemd has no
    /// such unit.
    fn unit(&mut self, name: &str, service: &str) -> Answer<Option<Unit>> {
        let shown = match self.show(name) {
            Answer::Yes(s) => s,
            Answer::NotFound => return Answer::Yes(None),
            Answer::NoAnswer(e) => return Answer::NoAnswer(e),
        };
        if shown.load == "not-found" {
            return Answer::Yes(None);
        }
        let container = match self.api.inspect(name) {
            Answer::Yes(c) => Some(c),
            Answer::NotFound => None,
            Answer::NoAnswer(e) => return Answer::NoAnswer(e),
        };
        let status = match (shown.active.as_str(), &container) {
            ("active", Some(c)) if c.running() => "running",
            // Between two containers: the old one exited, the next is being started.
            ("active" | "activating" | "reloading", _) => "restarting",
            ("deactivating", _) => "stopping",
            _ => "exited",
        };
        // What runs says what it is; between two containers, the unit that starts the next.
        let written = fs::read_to_string(self.file(name)).unwrap_or_default();
        let (config_hash, release) = match &container {
            Some(c) if !c.config_hash.is_empty() => (c.config_hash.clone(), c.release.clone()),
            _ => (
                label_in(&written, HASH_LABEL).unwrap_or_default(),
                label_in(&written, "org.omarchy-pool.agent.release").unwrap_or_default(),
            ),
        };
        Answer::Yes(Some(Unit {
            id: name.to_owned(),
            service: service.to_owned(),
            status: status.to_owned(),
            restarts: shown.restarts,
            exit_code: container
                .as_ref()
                .filter(|c| c.stopped())
                .map_or(shown.status, |c| c.exit_code),
            config_hash,
            release,
        }))
    }

    fn reload(&mut self) -> Answer<()> {
        self.systemctl(&["daemon-reload"]).map_none()
    }
}

impl Driver for Quadlet {
    fn observe(&mut self, p: &Project, services: &[String]) -> Answer<Vec<Unit>> {
        let mut out = Vec::new();
        for s in services {
            let name = quadlet::unit_name(&p.name, s);
            if !is_unit(&name) {
                return Answer::NoAnswer(format!("{name:?} is not a unit name"));
            }
            match self.unit(&name, s) {
                Answer::Yes(Some(u)) => out.push(u),
                Answer::Yes(None) | Answer::NotFound => {}
                Answer::NoAnswer(e) => return Answer::NoAnswer(e),
            }
        }
        Answer::Yes(out)
    }

    fn config_hash(&mut self, p: &Project, service: &str) -> Answer<String> {
        match Self::render(p) {
            Ok(units) => units
                .into_iter()
                .find(|u| u.service == service)
                .map_or_else(
                    || Answer::NoAnswer(format!("the set has no service {service}")),
                    |u| Answer::Yes(u.hash),
                ),
            Err(e) => Answer::NoAnswer(format!("quadlet: {e}")),
        }
    }

    fn images(&mut self, p: &Project) -> Answer<Vec<String>> {
        match Self::render(p) {
            Ok(units) => Answer::Yes(units.into_iter().map(|u| u.image).collect()),
            Err(e) => Answer::NoAnswer(format!("quadlet: {e}")),
        }
    }

    fn start_pull(&mut self, p: &Project, services: &[String]) -> Answer<()> {
        let units = match Self::render(p) {
            Ok(u) => u,
            Err(e) => return Answer::NoAnswer(format!("quadlet: {e}")),
        };
        let mut images: Vec<String> = units
            .into_iter()
            .filter(|u| services.contains(&u.service))
            .map(|u| u.image)
            .collect();
        images.sort();
        images.dedup();
        self.api.pull_images(&images)
    }

    fn poll_pull(&mut self) -> Answer<PullState> {
        self.api.poll_pull()
    }

    fn pull_images(&mut self, images: &[String]) -> Answer<()> {
        self.api.pull_images(images)
    }

    /// The unit's stop, queued: systemd stops the container with the template's
    /// `stop_grace_period` (`--stop-timeout`, then a kill), and a unit stopped by hand is not
    /// restarted; `grace_s` is that same grace, rendered into the unit. A container of
    /// another compose project, by its id — the legacy set `retire-legacy` stops (#344) —
    /// is the engine's to stop, as on compose.
    fn begin_drain(&mut self, u: &Unit, grace_s: u64) -> Answer<()> {
        if !is_unit(&u.id) {
            return self.api.begin_drain(u, grace_s);
        }
        let service = format!("{}.service", u.id);
        self.systemctl(&["stop", "--no-block", &service]).map_none()
    }

    fn drained(&mut self, u: &Unit) -> Answer<bool> {
        if !is_unit(&u.id) {
            return self.api.drained(u);
        }
        match self.show(&u.id) {
            Answer::Yes(s) => Answer::Yes(
                s.load == "not-found" || matches!(s.active.as_str(), "inactive" | "failed"),
            ),
            Answer::NotFound => Answer::Yes(true),
            Answer::NoAnswer(e) => Answer::NoAnswer(e),
        }
    }

    /// The unit's file gone and systemd told, so nothing starts it again (at boot, say);
    /// `force`: what is left of it killed first, the container removed by force. Another
    /// project's container (`retire-legacy`) is the engine's to remove.
    fn remove(&mut self, u: &Unit, force: bool) -> Answer<()> {
        if !is_unit(&u.id) {
            return self.api.remove(u, force);
        }
        let service = format!("{}.service", u.id);
        if force {
            // A unit that is gone already has nothing to kill.
            let _ = self.systemd.user(&["kill", "--signal=SIGKILL", &service]);
            if let Answer::NoAnswer(e) = self.api.remove(u, true) {
                return Answer::NoAnswer(e);
            }
        }
        match fs::remove_file(self.file(&u.id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Answer::NoAnswer(format!("{}: {e}", self.file(&u.id).display())),
        }
        if let Answer::NoAnswer(e) = self.reload() {
            return Answer::NoAnswer(e);
        }
        // A unit that failed stays listed until it is reset.
        let _ = self.systemd.user(&["reset-failed", &service]);
        Answer::Yes(())
    }

    /// Writes the units of `services`, has the generator read them, and (re)starts them:
    /// `restart` returns once podman says the container runs (`Type=notify`).
    fn create(&mut self, p: &Project, services: &[String]) -> Answer<()> {
        let units = match Self::render(p) {
            Ok(u) => u,
            Err(e) => return Answer::NoAnswer(format!("quadlet: {e}")),
        };
        let units: Vec<Rendered> = units
            .into_iter()
            .filter(|u| services.contains(&u.service))
            .collect();
        if units.is_empty() {
            return Answer::NotFound;
        }
        if let Err(e) = fs::create_dir_all(&self.units) {
            return Answer::NoAnswer(format!("{}: {e}", self.units.display()));
        }
        for u in &units {
            if !is_unit(&u.name) {
                return Answer::NoAnswer(format!("{:?} is not a unit name", u.name));
            }
            if let Err(e) = super::state::write_atomic(&self.file(&u.name), u.text.as_bytes()) {
                return Answer::NoAnswer(e);
            }
        }
        if let Answer::NoAnswer(e) = self.reload() {
            return Answer::NoAnswer(e);
        }
        for u in &units {
            match self.show(&u.name) {
                Answer::Yes(s) if s.load == "not-found" => {
                    return Answer::NoAnswer(format!(
                        "podman's generator made no unit of {}: `/usr/libexec/podman/quadlet -dryrun -user` says why",
                        self.file(&u.name).display()
                    ))
                }
                Answer::Yes(_) => {}
                Answer::NotFound => return Answer::NotFound,
                Answer::NoAnswer(e) => return Answer::NoAnswer(e),
            }
            let service = format!("{}.service", u.name);
            if let Answer::NoAnswer(e) = self.systemctl(&["restart", &service]) {
                return Answer::NoAnswer(e);
            }
        }
        Answer::Yes(())
    }

    fn inspect(&mut self, id: &str) -> Answer<Unit> {
        if !is_unit(id) {
            return Answer::NoAnswer(format!("{id:?} is not a unit name"));
        }
        // The service is the agent's label on the container, or else the unit's.
        let written = fs::read_to_string(self.file(id)).unwrap_or_default();
        let service = label_in(&written, "org.omarchy-pool.agent.service").unwrap_or_default();
        match self.unit(id, &service) {
            Answer::Yes(Some(u)) => Answer::Yes(u),
            Answer::Yes(None) | Answer::NotFound => Answer::NotFound,
            Answer::NoAnswer(e) => Answer::NoAnswer(e),
        }
    }

    fn exits_since(&mut self, id: &str, since: i64) -> Answer<Vec<Exit>> {
        if !is_unit(id) {
            return Answer::NoAnswer(format!("{id:?} is not a unit name"));
        }
        self.api.exits_since(id, since)
    }

    fn ready(&mut self, id: &str, http: &str) -> Answer<bool> {
        if !is_unit(id) {
            return Answer::NoAnswer(format!("{id:?} is not a unit name"));
        }
        self.api.ready(id, http)
    }

    fn remove_image(&mut self, image: &str) -> Answer<()> {
        self.api.remove_image(image)
    }

    fn project_containers(&mut self, project: &str) -> Answer<Vec<Foreign>> {
        self.api.project_containers(project)
    }

    fn project_networks(&mut self, project: &str) -> Answer<Vec<String>> {
        self.api.project_networks(project)
    }

    fn remove_network(&mut self, id: &str) -> Answer<()> {
        self.api.remove_network(id)
    }

    fn logs(&mut self, id: &str, lines: u32) -> Answer<String> {
        if !is_unit(id) {
            return Answer::NoAnswer(format!("{id:?} is not a unit name"));
        }
        self.api.logs(id, lines)
    }

    fn engine(&mut self) -> Answer<EngineId> {
        self.api.engine()
    }

    fn host_tasks(&mut self, host: &str) -> Answer<usize> {
        self.api.host_tasks(host)
    }

    fn tasks_running(&mut self) -> Answer<bool> {
        self.api.tasks_running()
    }
}

#[cfg(test)]
#[path = "quadlet_tests.rs"]
mod tests;
