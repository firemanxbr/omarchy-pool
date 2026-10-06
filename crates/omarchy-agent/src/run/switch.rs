//! The owner's runtime switch (#325, design v2 §15, v1 §10.4): `omarchy-agent runtime switch
//! <driver>` at the host moves the bundle to another driver this binary carries —
//! `compose/docker` or `compose/podman`, the compose driver against that engine's socket —
//! with the same guard and revert as any round. The pool cannot select a driver: nothing it
//! sends names one, and the request is a file in the agent's own data directory, which the
//! command writes and the loop takes.
//!
//! The steps, one per tick, persisted in `state.json` (`switch`) so a restart resumes:
//!
//! 1. `stop`: the dispatcher on the old engine gets its stop signal (it saves its leases and
//!    exits within its grace), then is removed. Before that the switch is refused, with
//!    nothing changed, unless the envelope's `drivers` allow the new one, its socket answers
//!    as that engine, a release runs, and no task container runs on the old engine: named
//!    volumes, caches and task containers do not move between engines, so the host is
//!    drained first (Drain on its registration's page) and its tasks finish there.
//! 2. `up`: a round of the release that runs, on the new engine — render, lint (with the new
//!    engine's kind: a rootful one needs `rootful_ack` and `dedicated`), plan, pull,
//!    replace, guard. Its commit ends the switch: agent.toml's `[set]` names the new socket,
//!    engine and runtime from then on.
//! 3. `back`, when that round fails — the guard or the ready wait (intercepted before the
//!    round's own revert, so the release is never quarantined for an engine's fault), a
//!    refusal, a pull that failed, agent.toml that cannot be written to name the new engine,
//!    or no end within [`LIMIT_S`] — or when a task container runs on the old engine once its
//!    dispatcher stopped (claimed after the request was checked): the new engine's dispatcher
//!    is stopped and removed, the old engine named again, and a round brings the dispatcher
//!    back there (`return`); the round's outcome says the switch was rolled back and why.
//!    agent.toml was never changed.
//!
//! On a Mac (#320) the switch is refused: the bundle runs in the VM's engine, which the
//! agent keeps ([`super::vm`]), and the drivers here are a Linux host's.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::agent::Agent;
use super::config::{Config, Runtime};
use super::driver::{Answer, Driver};
use super::rollout::{self, Outcome};
use super::state::{self, Step};
use crate::lint::Engine;

/// The request the command leaves in the data directory.
pub(crate) const REQUEST: &str = "runtime-switch.json";
/// A switch that has not ended within this goes back.
pub(crate) const LIMIT_S: i64 = 20 * 60;
/// The old dispatcher's grace, then its removal by force.
const GRACE_S: i64 = super::rollout::GRACE_S + 30;

/// Where the bundle runs: the engine, the socket the CLI talks to and the one the
/// dispatcher mounts, and whether the engine is rootful.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    pub runtime: String,
    pub socket_cli: PathBuf,
    pub socket_mount: PathBuf,
    /// `rootful` or `rootless`, as agent.toml's `set.engine` says it.
    pub engine: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SwitchStep {
    Stop,
    Up,
    Back,
    Return,
}

/// A runtime switch in flight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Switch {
    pub from: Place,
    pub to: Place,
    pub step: SwitchStep,
    /// When the switch began, and when its step did.
    pub started: i64,
    pub since: i64,
    /// Why it went back, once it does.
    pub why: Option<String>,
}

/// How the last switch ended: `done`, `refused` or `rolled-back`, with its words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwitchEnd {
    pub to: String,
    pub outcome: String,
    pub detail: String,
    pub at: i64,
}

/// What the command asks: a driver and its socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Request {
    pub driver: String,
    pub socket: PathBuf,
    pub asked_at: i64,
}

fn plain_absolute(p: &Path) -> bool {
    p.is_absolute()
        && p.components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}

/// The engine's own socket, in v1 §10.5's order for that engine: rootless first.
pub(crate) fn default_socket(r: Runtime, xdg_runtime_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    match r {
        Runtime::Podman => {
            if let Some(x) = xdg_runtime_dir {
                out.push(x.join("podman/podman.sock"));
            }
            out.push(PathBuf::from("/run/podman/podman.sock"));
        }
        Runtime::Docker => {
            if let Some(x) = xdg_runtime_dir {
                out.push(x.join("docker.sock"));
            }
            out.push(PathBuf::from("/var/run/docker.sock"));
        }
    }
    out
}

/// Where `cfg` says the bundle runs; `None` while the engine behind its socket has not
/// said which it is (agent.toml without `set.runtime`).
fn place_of(cfg: &Config) -> Option<Place> {
    Some(Place {
        runtime: cfg.runtime?.word().to_owned(),
        socket_cli: cfg.socket_cli.clone(),
        socket_mount: cfg.socket_mount.clone(),
        engine: match cfg.engine {
            Engine::Rootful => "rootful",
            Engine::Rootless => "rootless",
        }
        .to_owned(),
    })
}

/// Whether two socket paths name one socket: equal, or the same once their links are
/// followed (`/var/run` is a link to `/run` on most hosts).
fn same_socket(a: &Path, b: &Path) -> bool {
    a == b || matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// `cfg` pointed at `p`, in memory.
pub(crate) fn point(cfg: &mut Config, p: &Place) {
    cfg.runtime = Runtime::parse(&p.runtime);
    cfg.socket_cli.clone_from(&p.socket_cli);
    cfg.socket_mount.clone_from(&p.socket_mount);
    cfg.engine = if p.engine == "rootless" {
        Engine::Rootless
    } else {
        Engine::Rootful
    };
}

/// agent.toml with `[set]` naming `p`, the file's mode kept. Only those keys' lines change:
/// agent.toml is the owner's policy document (design v2 §12), so their comments — an
/// `[envelope]` note on why `max_units` is what it is — and its layout stay as they were.
/// A layout the line edit cannot name `p` in (a dotted `set.runtime` key, `set` as an
/// inline table) is written again from its table instead, its leading comment kept.
pub(crate) fn write_agent_toml(path: &Path, p: &Place) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mode = fs::metadata(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .permissions()
        .mode()
        & 0o777;
    let v = |s: &str| toml::Value::String(s.to_owned()).to_string();
    let keys = [
        ("driver", v("compose")),
        ("runtime", v(&p.runtime)),
        ("socket_cli", v(&p.socket_cli.display().to_string())),
        ("socket_mount", v(&p.socket_mount.display().to_string())),
        ("engine", v(&p.engine)),
    ];
    let names = |t: &str| {
        Config::parse(t).is_ok_and(|c| {
            place_of(&c).as_ref() == Some(p)
                && toml::from_str::<toml::Table>(t).is_ok_and(|t| {
                    t.get("set")
                        .and_then(|s| s.get("driver"))
                        .and_then(toml::Value::as_str)
                        == Some("compose")
                })
        })
    };
    let keys: Vec<(&str, Option<String>)> =
        keys.iter().map(|(k, v)| (*k, Some(v.clone()))).collect();
    let mut new = super::config::table_lines(&text, "set", &keys);
    if !names(&new) {
        new = reserialized(&text, p)?;
    }
    // Checked as the loop will read it before it replaces the one that works.
    Config::parse(&new)?;
    state::write_atomic(path, new.as_bytes())?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// agent.toml written again from its table, `[set]` naming `p`, its leading comment kept.
fn reserialized(text: &str, p: &Place) -> Result<String, String> {
    let mut t: toml::Table = toml::from_str(text).map_err(|e| format!("agent.toml: {e}"))?;
    let set = t
        .entry("set")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or("agent.toml: [set] is not a table")?;
    let s = |p: &Path| toml::Value::String(p.display().to_string());
    set.insert("driver".into(), toml::Value::String("compose".into()));
    set.insert("runtime".into(), toml::Value::String(p.runtime.clone()));
    set.insert("socket_cli".into(), s(&p.socket_cli));
    set.insert("socket_mount".into(), s(&p.socket_mount));
    set.insert("engine".into(), toml::Value::String(p.engine.clone()));
    let body = toml::to_string(&t).map_err(|e| format!("agent.toml: {e}"))?;
    let head = text
        .lines()
        .take_while(|l| l.starts_with('#'))
        .fold(String::new(), |mut h, l| {
            h.push_str(l);
            h.push('\n');
            h
        });
    Ok(format!("{head}{body}"))
}

impl Agent {
    /// The driver on another socket: the pinned tools against it (tests: the fake engine
    /// that socket names).
    fn driver_on(&mut self, socket: &Path) -> Result<Box<dyn Driver>, String> {
        #[cfg(test)]
        if let Some(make) = self.drivers_on.as_mut() {
            return make(socket).ok_or_else(|| format!("no engine at {}", socket.display()));
        }
        let pins = self
            .state
            .tools
            .clone()
            .ok_or("the pinned engine tools are not installed yet")?;
        let t = super::tools::open(&self.paths.tools(), &pins)?;
        Ok(Box::new(super::compose::Compose::new(
            t,
            socket,
            &self.paths.docker_config(),
        )))
    }

    /// At start: a switch in flight is resumed on the engine it was on.
    pub(super) fn resume_switch(&mut self) {
        if let Some(sw) = &self.state.switch {
            let at = match sw.step {
                SwitchStep::Stop | SwitchStep::Return => sw.from.clone(),
                SwitchStep::Up | SwitchStep::Back => sw.to.clone(),
            };
            point(&mut self.cfg, &at);
        }
    }

    /// One step of the switch in flight, or the start of one asked for. Never while a
    /// round of the pool's runs.
    pub(super) fn switch_step(&mut self, now: i64) {
        match self.state.switch.as_ref().map(|s| s.step) {
            None => self.switch_begin(now),
            Some(SwitchStep::Stop) => self.switch_stop(now),
            Some(SwitchStep::Up) => self.switch_up(now),
            Some(SwitchStep::Back) => self.switch_back(now),
            Some(SwitchStep::Return) => self.switch_return(now),
        }
    }

    fn switch_end(&mut self, to: &str, outcome: &str, detail: &str, now: i64) {
        let detail = self.journal.scrub(detail);
        self.journal.write(
            now,
            "runtime-switch",
            serde_json::json!({"to": to, "outcome": outcome, "detail": detail}),
        );
        self.state.switch = None;
        self.state.switch_last = Some(SwitchEnd {
            to: to.to_owned(),
            outcome: outcome.to_owned(),
            detail,
            at: now,
        });
    }

    fn switch_begin(&mut self, now: i64) {
        let path = self.paths.data.join(REQUEST);
        let Ok(text) = fs::read(&path) else { return };
        // Only between rounds: the request waits for the one in flight.
        if self.state.rollout.step != Step::Idle {
            return;
        }
        let _ = fs::remove_file(&path);
        let req: Request = match serde_json::from_slice(&text) {
            Ok(r) => r,
            Err(e) => {
                return self.switch_end("?", "refused", &format!("{REQUEST}: {e}"), now);
            }
        };
        let (from, to, version) = match self.switch_ready(&req) {
            Ok(ready) => ready,
            Err(why) => {
                return self.switch_end(
                    &req.driver,
                    "refused",
                    &format!("{why}; nothing changed"),
                    now,
                )
            }
        };
        self.journal.write(
            now,
            "runtime-switch",
            serde_json::json!({"to": format!("compose/{}", to.runtime), "socket": req.socket, "engine": to.engine, "version": version, "from": format!("compose/{}", from.runtime), "step": "stopping the dispatcher on the old engine"}),
        );
        self.state.switch = Some(Switch {
            from,
            to,
            step: SwitchStep::Stop,
            started: now,
            since: now,
            why: None,
        });
    }

    /// agent.toml names no `set.runtime` (install writes none: it finds a socket, and
    /// podman's speaks docker's API): the engine behind the socket says which it is, once
    /// it answers, so the report and a switch name the engine the bundle runs on (#325).
    /// Asked again each tick until it answers; in memory only, agent.toml is the owner's.
    pub(super) fn identify_runtime(&mut self) {
        if self.cfg.runtime.is_some() {
            return;
        }
        if let Some(Answer::Yes(id)) = self.driver.as_deref_mut().map(Driver::engine) {
            self.cfg.runtime = Some(id.runtime);
        }
    }

    /// Where the bundle runs and where a request moves it, and the new engine's version —
    /// or why it is refused: [`Agent::switch_check`]'s reasons, a socket that does not
    /// answer as the engine named, or a task container still running on the engine the
    /// bundle runs on.
    fn switch_ready(&mut self, req: &Request) -> Result<(Place, Place, String), String> {
        self.switch_check(req)?;
        let r = Runtime::parse(&req.driver)
            .ok_or_else(|| format!("{:?} is not a driver this agent carries", req.driver))?;
        let mut new = self.driver_on(&req.socket)?;
        let id = match new.engine() {
            Answer::Yes(id) => id,
            Answer::NotFound => {
                return Err(format!(
                    "the engine on {} does not answer",
                    req.socket.display()
                ))
            }
            Answer::NoAnswer(e) => {
                return Err(format!(
                    "the engine on {} does not answer ({e})",
                    req.socket.display()
                ))
            }
        };
        if id.runtime != r {
            return Err(format!(
                "{} answers as {} {}, not {}",
                req.socket.display(),
                id.runtime.word(),
                id.version,
                r.word()
            ));
        }
        let host = self.cfg.host_id.clone();
        let tasks = match self.driver.as_deref_mut().map(|d| d.host_tasks(&host)) {
            Some(Answer::Yes(n)) => n,
            Some(Answer::NoAnswer(e)) => return Err(format!("the engine it runs on now does not answer ({e}): its dispatcher and task containers cannot be stopped or counted")),
            Some(Answer::NotFound) => 0,
            None => return Err("the pinned engine tools are not installed yet".into()),
        };
        // The old engine answered: which it is is known by now (`identify_runtime`).
        let from = place_of(&self.cfg)
            .ok_or("the engine it runs on now has not said which it is (docker or podman)")?;
        if tasks > 0 {
            return Err(format!(
                "{tasks} task container(s) run on compose/{}: task containers, named volumes and caches do not move between engines — drain the host first (Drain on its registration's page), let its tasks finish, then switch",
                from.runtime
            ));
        }
        let to = Place {
            runtime: r.word().to_owned(),
            socket_cli: req.socket.clone(),
            socket_mount: req.socket.clone(),
            engine: if id.rootless { "rootless" } else { "rootful" }.to_owned(),
        };
        Ok((from, to, id.version))
    }

    /// What refuses a request before any engine is asked.
    fn switch_check(&self, req: &Request) -> Result<(), String> {
        // A Mac's bundle runs in a VM's engine (#320): the agent keeps the omarchy Colima
        // VM — its three mounts, its task firewall, its clock — around the docker engine
        // inside it, and Docker Desktop's or OrbStack's is the person's. The drivers this
        // binary carries move between a Linux host's engines only. agent.toml's `[vm]`
        // says a Mac whatever its runtime ([`Config::mac`], #329), and a Mac's build
        // refuses even with it gone.
        if self.cfg.mac || self.mac {
            return Err("this host's bundle runs in a Mac's VM (#320), whose engine the agent keeps: the runtime switch moves between a Linux host's engines only".into());
        }
        let r = Runtime::parse(&req.driver).ok_or_else(|| {
            format!(
                "{:?} is not a driver this agent carries (compose/docker, compose/podman)",
                req.driver
            )
        })?;
        if !self.cfg.policy.allows_driver(r) {
            return Err(format!(
                "the envelope's drivers ({}) do not name {}: only its owner widens that, in agent.toml",
                self.cfg.policy.drivers.join(", "),
                r.driver()
            ));
        }
        if !plain_absolute(&req.socket) {
            return Err(format!(
                "{} is not a plain absolute path",
                req.socket.display()
            ));
        }
        // The socket alone decides: one socket is one engine, whichever driver is named
        // (the engine's own answer refuses a mismatch on another socket).
        if same_socket(&req.socket, &self.cfg.socket_cli) {
            let at = req.socket.display();
            return Err(match self.cfg.runtime {
                Some(on) => format!("the bundle runs on {} at {at} already", on.driver()),
                None => format!("the bundle runs at {at} already"),
            });
        }
        if self.state.applied.is_none()
            || !self
                .paths
                .last_good(&self.cfg.set_name)
                .join("compose.yml")
                .exists()
        {
            return Err("no release runs here yet: install first, then switch".into());
        }
        Ok(())
    }

    /// Stops and removes the bundle's dispatcher on the engine `self.driver` talks to.
    /// `Ok(true)`: none is left.
    fn stop_bundle(&mut self, since: i64, now: i64) -> Result<bool, String> {
        let Some((p, services)) = self.last_good_project() else {
            return Ok(true);
        };
        let d = self
            .driver
            .as_deref_mut()
            .ok_or("the pinned engine tools are not installed yet")?;
        let units = match d.observe(&p, &services) {
            Answer::Yes(u) => u,
            Answer::NotFound => Vec::new(),
            Answer::NoAnswer(e) => return Err(e),
        };
        let late = now >= since + GRACE_S;
        let mut left = false;
        for u in &units {
            if !u.stopped() {
                if let Answer::NoAnswer(e) = d.begin_drain(u, rollout::GRACE_S.unsigned_abs()) {
                    return Err(e);
                }
            }
            match d.drained(u) {
                Answer::Yes(true) | Answer::NotFound => {
                    if let Answer::NoAnswer(e) = d.remove(u, false) {
                        return Err(e);
                    }
                }
                Answer::Yes(false) if late => {
                    if let Answer::NoAnswer(e) = d.remove(u, true) {
                        return Err(e);
                    }
                }
                Answer::Yes(false) => left = true,
                Answer::NoAnswer(e) => return Err(e),
            }
        }
        Ok(!left)
    }

    /// Moves to `p`'s engine and starts a round of the release that runs there.
    fn round_on(&mut self, p: &Place, why: &str, now: i64) -> Result<(), String> {
        let d = self.driver_on(&p.socket_cli)?;
        point(&mut self.cfg, p);
        self.driver = Some(d);
        let applied = self.state.applied.ok_or("no release runs")?;
        rollout::start(&mut self.state, &self.journal, now, applied, false, why);
        Ok(())
    }

    fn switch_stop(&mut self, now: i64) {
        let Some(sw) = self.state.switch.clone() else {
            return;
        };
        match self.stop_bundle(sw.since, now) {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) if now - sw.since < GRACE_S => {
                let _ = e;
                return;
            }
            Err(e) => {
                return self.switch_end(
                    &sw.to.runtime,
                    "refused",
                    &format!("the old engine did not stop the dispatcher ({e}): the switch is abandoned, the bundle stays on {}", sw.from.runtime),
                    now,
                );
            }
        }
        // The request found no task running, but the dispatcher claimed until its stop: a
        // task it started meanwhile runs on the old engine, where only a dispatcher there
        // re-adopts it. The bundle goes back to it.
        let host = self.cfg.host_id.clone();
        match self.driver.as_deref_mut().map(|d| d.host_tasks(&host)) {
            Some(Answer::Yes(0) | Answer::NotFound) => {}
            Some(Answer::Yes(n)) => {
                let why = format!(
                    "{n} task container(s) were claimed on compose/{} before its dispatcher stopped, and only a dispatcher there re-adopts them: drain the host first (Drain on its registration's page), let its tasks finish, then switch",
                    sw.from.runtime
                );
                return self.go_back(&sw, &why, now);
            }
            Some(Answer::NoAnswer(_)) | None if now - sw.since < GRACE_S => return,
            Some(Answer::NoAnswer(e)) => {
                let why = format!("the old engine did not say whether a task runs on it ({e})");
                return self.go_back(&sw, &why, now);
            }
            None => {
                let why = "the pinned engine tools are not installed".to_owned();
                return self.go_back(&sw, &why, now);
            }
        }
        let why = format!(
            "runtime switch to compose/{} (the owner's, at the host)",
            sw.to.runtime
        );
        match self.round_on(&sw.to, &why, now) {
            Ok(()) => self.switch_to(SwitchStep::Up, None, now),
            Err(e) => self.go_back(&sw, &format!("the new engine: {e}"), now),
        }
    }

    fn switch_to(&mut self, step: SwitchStep, why: Option<String>, now: i64) {
        if let Some(sw) = self.state.switch.as_mut() {
            sw.step = step;
            sw.since = now;
            if why.is_some() {
                sw.why = why;
            }
        }
    }

    fn go_back(&mut self, sw: &Switch, why: &str, now: i64) {
        let why = self.journal.scrub(why);
        self.journal.write(
            now,
            "runtime-switch",
            serde_json::json!({"to": format!("compose/{}", sw.to.runtime), "step": "going back", "detail": why}),
        );
        self.switch_to(SwitchStep::Back, Some(why), now);
    }

    fn switch_up(&mut self, now: i64) {
        let Some(sw) = self.state.switch.clone() else {
            return;
        };
        // The guard (or the ready wait) failed on the new engine: the switch goes back
        // before the round's own revert, so the release is not quarantined for it.
        if let Step::Revert { why } = &self.state.rollout.step {
            let why = why.clone();
            self.state.rollout = state::Rollout {
                since: now,
                ..Default::default()
            };
            self.pending = None;
            return self.go_back(&sw, &why, now);
        }
        if self.state.rollout.step != Step::Idle {
            if now - sw.started > LIMIT_S {
                self.state.rollout = state::Rollout {
                    since: now,
                    ..Default::default()
                };
                self.pending = None;
                let why = format!("not up on the new engine within {} min", LIMIT_S / 60);
                self.go_back(&sw, &why, now);
            }
            return;
        }
        let r = &self.state.round;
        if r.outcome == Outcome::Ok.name() || r.outcome == Outcome::NoChange.name() {
            // Up and guarded: agent.toml names the new engine from now on. One that cannot
            // be written would bring the dispatcher up on the old engine again at the next
            // start of the agent, beside this one — two dispatchers on one registration —
            // so the switch goes back instead.
            if let Err(e) = write_agent_toml(&self.paths.agent_toml(), &sw.to) {
                let why = format!("agent.toml could not be written to name it ({e})");
                return self.go_back(&sw, &why, now);
            }
            let detail = format!(
                "the bundle runs on compose/{} at {}; agent.toml says so",
                sw.to.runtime,
                sw.to.socket_cli.display()
            );
            let to = format!("compose/{}", sw.to.runtime);
            return self.switch_end(&to, "done", &detail, now);
        }
        let why = format!("{}: {}", r.outcome, r.detail);
        self.go_back(&sw, &why, now);
    }

    fn switch_back(&mut self, now: i64) {
        let Some(sw) = self.state.switch.clone() else {
            return;
        };
        match self.stop_bundle(sw.since, now) {
            Ok(true) => {}
            Ok(false) => return,
            // A new engine that does not answer has its dispatcher stopped by nobody: once
            // the grace is over the way back goes on, and says so.
            Err(_) if now - sw.since < GRACE_S => return,
            Err(e) => self.journal.write(
                now,
                "runtime-switch",
                serde_json::json!({"step": "going back", "detail": format!("the new engine did not answer ({e}): its dispatcher, if it runs, was not stopped")}),
            ),
        }
        let why = format!(
            "back on compose/{}: the switch to compose/{} failed",
            sw.from.runtime, sw.to.runtime
        );
        match self.round_on(&sw.from, &why, now) {
            Ok(()) => self.switch_to(SwitchStep::Return, None, now),
            Err(e) => {
                point(&mut self.cfg, &sw.from);
                let detail = format!(
                    "{}; the way back could not start: {e}",
                    sw.why.clone().unwrap_or_default()
                );
                self.switch_end(
                    &format!("compose/{}", sw.to.runtime),
                    "rolled-back",
                    &detail,
                    now,
                );
            }
        }
    }

    fn switch_return(&mut self, now: i64) {
        let Some(sw) = self.state.switch.clone() else {
            return;
        };
        if self.state.rollout.step != Step::Idle {
            return;
        }
        let back = format!("{}: {}", self.state.round.outcome, self.state.round.detail);
        let detail = format!(
            "the switch to compose/{} was rolled back ({}); the way back: {back}",
            sw.to.runtime,
            sw.why.clone().unwrap_or_default()
        );
        rollout::report(
            &mut self.state,
            &self.journal,
            now,
            Outcome::RolledBack,
            None,
            &detail,
        );
        self.switch_end(
            &format!("compose/{}", sw.to.runtime),
            "rolled-back",
            &detail,
            now,
        );
    }
}

/// `omarchy-agent runtime switch <driver> [--socket <path>]`: the request for the running
/// agent, which takes it between rounds; SIGUSR1 wakes it.
pub fn request(data: &Path, driver: &str, socket: Option<&Path>) -> Result<String, String> {
    let r = Runtime::parse(driver).ok_or_else(|| {
        format!("{driver:?} is not a driver this agent carries: compose/docker or compose/podman")
    })?;
    let xdg = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    let socket = if let Some(s) = socket {
        s.to_owned()
    } else {
        let list = default_socket(r, xdg.as_deref());
        list.iter()
            .find(|p| crate::install::engine::connect(p) == crate::install::engine::Socket::Answers)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "no {} socket answers ({}): start it, or give --socket",
                    r.word(),
                    list.iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?
    };
    if !plain_absolute(&socket) {
        return Err(format!("{} is not a plain absolute path", socket.display()));
    }
    match crate::install::engine::connect(&socket) {
        crate::install::engine::Socket::Answers => {}
        crate::install::engine::Socket::Denied => {
            return Err(crate::install::engine::denied_message(&socket))
        }
        crate::install::engine::Socket::Absent => {
            return Err(format!("nothing answers on {}", socket.display()))
        }
    }
    let req = Request {
        driver: r.driver(),
        socket: socket.clone(),
        asked_at: super::now(),
    };
    let bytes = serde_json::to_vec_pretty(&req).map_err(|e| e.to_string())?;
    state::write_atomic(&data.join(REQUEST), &bytes)?;
    Ok(format!(
        "asked the agent to move the bundle to {} at {}: it stops the dispatcher on the engine it runs on now, brings it up there and guards it, and goes back if it fails; `omarchy-agent status` and `omarchy-agent logs` follow it",
        r.driver(),
        socket.display()
    ))
}

#[cfg(test)]
#[path = "switch_tests.rs"]
mod tests;
