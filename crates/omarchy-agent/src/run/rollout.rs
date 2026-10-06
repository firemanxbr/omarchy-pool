//! The rollout state machine (design v2 §16.2): `idle → render → lint → plan → pull →
//! replace → guard → commit | revert`, one small step per tick, the step persisted in
//! `state.json` before it acts so a restart anywhere resumes where it was.
//!
//! - render: `staging/<set>/` = the release's set files, `pins.json` and the agent's label
//!   overlay (`agent.yml`); the owner's override, `etc/` and `run/capacity.json` are
//!   referenced in place and hashed into the overlay.
//! - lint: the P0 invariants, on the template as written, before interpolation.
//! - plan: replace a service whose config hash differs or that does not run; hold it
//!   while one of its env files (or `run/capacity.json`) is missing.
//! - pull: a child, polled; a failure changes nothing and the next poll retries.
//! - replace: stop the old dispatcher (it saves its leases and exits within 60 s), create
//!   the new one, wait for `/ready` (answered once leases are re-adopted). Task
//!   containers are never part of a plan.
//! - guard: sample the dispatcher for `guard_s`: a restart streak, `RestartCount` +2, a
//!   non-zero exit other than 75 (#277's ordered restart), or `/ready` lost fail it.
//! - commit: staging becomes `last-good/`, the set directory is written, the floor rises,
//!   old pulled images go.
//! - revert: `last-good/` is applied the same way, the release is quarantined for an hour
//!   (retried once), and the round reports `rolled-back` with the release it left.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};

use crate::lint::{self, SetToml};
use crate::version::Release;

use super::brake::Ask;
use super::config::{Config, Paths};
use super::driver::{Answer, Driver, Exit, Project, PullState, Unit};
use super::journal::Journal;
use super::state::{write_atomic, Files, Guard, Phase, Quarantine, State, Step};
use super::target::{Pins, Target};

/// The dispatcher saves its leases and exits within this (`stop_grace_period`).
pub(crate) const GRACE_S: i64 = 60;
/// Beyond the grace, before a container that did not stop is removed by force.
const GRACE_MARGIN_S: i64 = 30;
/// The guard samples at most this often.
const SAMPLE_S: i64 = 5;
/// A reverted release waits this long before its one retry.
pub(crate) const QUARANTINE_S: i64 = 3600;

/// How a round ended (design v2 §17.2 `round.outcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Ok,
    NoChange,
    Held,
    RolledBack,
    Refused,
    PoolUnreachable,
    Unauthorized,
    EngineUnreachable,
    NeedsNewerAgent,
    PullFailed,
    /// A self-update that did not pass its health gate was rolled back (#316).
    AgentRollback,
}

impl Outcome {
    pub fn name(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::NoChange => "no-change",
            Outcome::Held => "held",
            Outcome::RolledBack => "rolled-back",
            Outcome::Refused => "refused",
            Outcome::PoolUnreachable => "pool-unreachable",
            Outcome::Unauthorized => "unauthorized",
            Outcome::EngineUnreachable => "engine-unreachable",
            Outcome::NeedsNewerAgent => "needs-newer-agent",
            Outcome::PullFailed => "pull-failed",
            Outcome::AgentRollback => "agent-rollback",
        }
    }
}

/// What a step needs besides the state.
pub(crate) struct Ctx<'a> {
    pub cfg: &'a Config,
    pub paths: &'a Paths,
    /// `None` until the pinned tools are installed.
    pub driver: Option<&'a mut dyn Driver>,
    pub journal: &'a Journal,
    pub now: i64,
}

/// Records a round's end and goes back to idle.
pub(crate) fn report(
    state: &mut State,
    j: &Journal,
    now: i64,
    outcome: Outcome,
    from: Option<Release>,
    detail: &str,
) {
    let step = state.rollout.step.name().to_owned();
    let detail = j.scrub(detail);
    j.write(
        now,
        "round",
        serde_json::json!({
            "outcome": outcome.name(),
            "target": state.rollout.target.map(|r| r.to_string()),
            "from": from.map(|r| r.to_string()),
            "step": step,
            "detail": detail,
        }),
    );
    state.round = super::state::Round {
        at: now,
        outcome: outcome.name().to_owned(),
        from,
        step,
        detail,
    };
}

fn finish(state: &mut State, ctx: &Ctx, outcome: Outcome, from: Option<Release>, detail: &str) {
    report(state, ctx.journal, ctx.now, outcome, from, detail);
    state.rollout = super::state::Rollout {
        since: ctx.now,
        ..Default::default()
    };
}

fn go(state: &mut State, ctx: &Ctx, step: Step) {
    ctx.journal.write(
        ctx.now,
        "step",
        serde_json::json!({
            "from": state.rollout.step.name(),
            "to": step.name(),
            "target": state.rollout.target.map(|r| r.to_string()),
        }),
    );
    state.rollout.step = step;
    state.rollout.since = ctx.now;
}

/// The revert step, its reason scrubbed: it is kept in `state.json` (and in
/// `rollout.reverting`), which the host report (#321) is built from.
fn revert_step(ctx: &Ctx, why: &str) -> Step {
    Step::Revert {
        why: ctx.journal.scrub(why),
    }
}

/// Steps a round may be preempted at: everything before `commit` (design v2 §16.2).
pub(crate) fn preemptible(step: &Step) -> bool {
    matches!(
        step,
        Step::Render
            | Step::Lint
            | Step::Plan
            | Step::Pull
            | Step::Replace {
                files: Files::Staging,
                ..
            }
            | Step::Guard(_)
    )
}

/// Starts a round for `target` (preempting one in flight, which the caller checked).
pub(crate) fn start(
    state: &mut State,
    j: &Journal,
    now: i64,
    target: Release,
    rollback: bool,
    why: &str,
) {
    if state.rollout.step != Step::Idle {
        j.write(
            now,
            "preempted",
            serde_json::json!({
                "target": state.rollout.target.map(|r| r.to_string()),
                "step": state.rollout.step.name(),
                "by": target.to_string(),
                "why": why,
            }),
        );
    }
    state.rollout = super::state::Rollout {
        step: Step::Render,
        since: now,
        target: Some(target),
        from: state.applied,
        rollback,
        why: why.to_owned(),
        services: Vec::new(),
        reverting: None,
        braked: false,
    };
    j.write(
        now,
        "round-start",
        serde_json::json!({"target": target.to_string(), "rollback": rollback, "why": why}),
    );
}

/// One step of the round in flight. `pending` is the verified target in memory, when the
/// round renders from a bundle. Errors are local (the disk): the loop retries the step
/// at its next tick, so every step is safe to run again.
pub(crate) fn step(
    state: &mut State,
    pending: Option<&Target>,
    ctx: &mut Ctx,
) -> Result<(), String> {
    match state.rollout.step.clone() {
        Step::Idle => Ok(()),
        Step::Render => render(state, pending, ctx),
        Step::Lint => {
            lint_step(state, ctx);
            Ok(())
        }
        Step::Plan => {
            plan(state, ctx);
            Ok(())
        }
        Step::Pull => {
            pull(state, ctx);
            Ok(())
        }
        Step::Replace { files, phase } => replace(state, ctx, files, &phase),
        Step::Guard(g) => {
            guard(state, ctx, g);
            Ok(())
        }
        Step::Commit => commit(state, ctx),
        Step::Revert { why } => {
            if ctx
                .paths
                .last_good(&ctx.cfg.set_name)
                .join("compose.yml")
                .exists()
            {
                state.rollout.reverting = Some(why);
                go(
                    state,
                    ctx,
                    Step::Replace {
                        files: Files::LastGood,
                        phase: Phase::Stop,
                    },
                );
                Ok(())
            } else {
                finish_revert(
                    state,
                    ctx,
                    &format!("{why}; no last-good to apply: left as is"),
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Files.

fn staging(ctx: &Ctx) -> PathBuf {
    ctx.paths.staging(&ctx.cfg.set_name)
}

fn last_good(ctx: &Ctx) -> PathBuf {
    ctx.paths.last_good(&ctx.cfg.set_name)
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Writes `files` (relative paths, checked by the manifest parser) under `dir`.
fn write_files(dir: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    for (rel, data) in files {
        if !crate::manifest::is_relative_path(rel) {
            return Err(format!("{rel:?} leaves the set directory"));
        }
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        write_atomic(&path, data)?;
    }
    Ok(())
}

/// Every regular file under `dir`, by relative path.
fn read_tree(dir: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for e in entries {
            let e = e.map_err(|e| e.to_string())?;
            let ty = e.file_type().map_err(|e| e.to_string())?;
            let path = e.path();
            if ty.is_dir() {
                walk(root, &path, out)?;
            } else if ty.is_file() {
                let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
                let data = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                out.insert(rel.to_string_lossy().into_owned(), data);
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out)?;
    Ok(out)
}

fn reset_dir(dir: &Path) -> Result<(), String> {
    match fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    }
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))
}

const PINS: &str = "pins.json";
const OVERLAY: &str = "agent.yml";

/// The inputs referenced in place (design v2 §16.2): the owner's override, every file
/// of `etc/` and `run/capacity.json`. Their hash goes into the overlay as a label, so a
/// change to any of them changes compose's config hash and replaces the dispatcher.
pub(crate) fn inputs_hash(set_dir: &Path) -> String {
    let mut h = Sha256::new();
    let mut add = |name: &str, path: &Path| {
        h.update(name.as_bytes());
        h.update([0]);
        match fs::read(path) {
            Ok(data) => {
                h.update((data.len() as u64).to_be_bytes());
                h.update(&data);
            }
            Err(_) => h.update(b"-"),
        }
    };
    add(
        "compose.override.yml",
        &set_dir.join("compose.override.yml"),
    );
    let mut etc: Vec<PathBuf> = fs::read_dir(set_dir.join("etc"))
        .map(|d| {
            d.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect()
        })
        .unwrap_or_default();
    etc.sort();
    for p in &etc {
        add(
            &format!(
                "etc/{}",
                p.file_name().unwrap_or_default().to_string_lossy()
            ),
            p,
        );
    }
    add("run/capacity.json", &set_dir.join("run/capacity.json"));
    format!("sha256:{}", hex::encode(h.finalize()))
}

/// The agent's label overlay (design v2 §4.3): its labels on every service, and
/// `userns_mode: host` on a remapped rootful daemon (the envelope's `userns_remap`).
fn overlay(cfg: &Config, services: &[String], release: Release, inputs: &str) -> String {
    let mut y = String::from(
        "# Written by omarchy-agent: its labels on every service of the set.\nservices:\n",
    );
    for s in services {
        let _ = write!(
            y,
            "  {s}:\n    labels:\n      org.omarchy-pool.agent.host: \"{}\"\n      org.omarchy-pool.agent.set: \"{}\"\n      org.omarchy-pool.agent.service: \"{s}\"\n      org.omarchy-pool.agent.release: \"{release}\"\n      org.omarchy-pool.agent.inputs: \"{inputs}\"\n",
            cfg.host_id, cfg.set_name
        );
        if cfg.envelope.userns_remap {
            y.push_str("    userns_mode: host\n");
        }
    }
    y
}

fn read_set(dir: &Path) -> Result<(SetToml, Vec<String>), String> {
    let set = lint::parse_set_toml(&read_text(&dir.join("set.toml"))?)?;
    let services = lint::service_names(&read_text(&dir.join("compose.yml"))?)
        .ok_or("compose.yml has no services")?;
    if let Some(bad) = services.iter().find(|s| !super::compose::is_service(s)) {
        return Err(format!("{bad:?} is not a service name"));
    }
    Ok((set, services))
}

/// The compose project for `files` (staging or last-good): its files, the set directory
/// as the project directory, agent.toml's variables.
fn project(ctx: &Ctx, files: Files) -> Result<(Project, SetToml, Vec<String>), String> {
    let dir = match files {
        Files::Staging => staging(ctx),
        Files::LastGood => last_good(ctx),
    };
    let (set, services) = read_set(&dir)?;
    let mut list = vec![dir.join("compose.yml"), dir.join(OVERLAY)];
    let over = ctx.cfg.set_dir.join("compose.override.yml");
    if over.exists() {
        list.push(over);
    }
    let name = ctx
        .cfg
        .project
        .clone()
        .unwrap_or_else(|| set.project_default.clone());
    Ok((
        Project {
            name,
            dir: ctx.cfg.set_dir.clone(),
            files: list,
            env: ctx.cfg.interpolation(),
        },
        set,
        services,
    ))
}

// ---------------------------------------------------------------------------------------
// Steps.

fn render(state: &mut State, pending: Option<&Target>, ctx: &mut Ctx) -> Result<(), String> {
    let Some(target) = state.rollout.target else {
        finish(state, ctx, Outcome::Refused, None, "a round with no target");
        return Ok(());
    };
    let dir = staging(ctx);
    let good = last_good(ctx);
    let mut files = match pending.filter(|t| t.release() == target) {
        Some(t) => {
            let mut f = t.files.clone();
            f.insert(
                PINS.into(),
                serde_json::to_vec_pretty(&t.pins).map_err(|e| e.to_string())?,
            );
            f
        }
        None if state.applied == Some(target) && pins_release(&good) == Some(target) => {
            read_tree(&good)?
        }
        None => {
            finish(
                state,
                ctx,
                Outcome::PoolUnreachable,
                None,
                &format!("the bundle of {target} is not at hand; the next poll fetches it"),
            );
            return Ok(());
        }
    };
    files.remove(OVERLAY);
    reset_dir(&dir)?;
    write_files(&dir, &files)?;
    let services = match read_set(&dir) {
        Ok((_, s)) => s,
        Err(e) => {
            finish(state, ctx, Outcome::Refused, None, &format!("lint: {e}"));
            return Ok(());
        }
    };
    let inputs = inputs_hash(&ctx.cfg.set_dir);
    write_atomic(
        &dir.join(OVERLAY),
        overlay(ctx.cfg, &services, target, &inputs).as_bytes(),
    )?;
    go(state, ctx, Step::Lint);
    Ok(())
}

fn lint_step(state: &mut State, ctx: &mut Ctx) {
    let dir = staging(ctx);
    let read = || -> Result<(Pins, String, String), String> {
        let pins: Pins = serde_json::from_slice(
            &fs::read(dir.join(PINS)).map_err(|e| format!("pins.json: {e}"))?,
        )
        .map_err(|e| format!("pins.json: {e}"))?;
        let compose = read_text(&dir.join("compose.yml"))?;
        let set = read_text(&dir.join("set.toml"))?;
        Ok((pins, compose, set))
    };
    let v = match read().and_then(|(pins, compose, set)| violations(ctx.cfg, &pins, &compose, &set))
    {
        Ok(v) => v,
        Err(e) => return finish(state, ctx, Outcome::Refused, None, &format!("lint: {e}")),
    };
    if v.is_empty() {
        go(state, ctx, Step::Plan);
    } else {
        finish(
            state,
            ctx,
            Outcome::Refused,
            None,
            &format!("lint: {}", v.join("; ")),
        );
    }
}

/// The lint of a rendered set with the owner's override: every violation, by name.
fn violations(cfg: &Config, pins: &Pins, compose: &str, set: &str) -> Result<Vec<String>, String> {
    let compose = pins.lint_view(compose);
    let over = cfg.set_dir.join("compose.override.yml");
    let over = over.exists().then(|| read_text(&over)).transpose()?;
    // The engine install detected (#317); strictly rootful when agent.toml does not say.
    let mut v = lint::lint_compose(&compose, over.as_deref(), &cfg.envelope, cfg.engine)
        .err()
        .unwrap_or_default();
    v.extend(lint::lint_set_toml(set, &compose).err().unwrap_or_default());
    // A Quadlet host (#330) runs what its driver renders: the owner's override with it.
    if cfg.driver == super::config::DriverKind::Quadlet {
        v.extend(
            lint::lint_quadlet(&compose, over.as_deref(), &cfg.interpolation())
                .err()
                .unwrap_or_default(),
        );
    }
    Ok(v.iter().map(ToString::to_string).collect())
}

/// A round's render and lint in memory, writing nothing (a new agent's self-test, #316).
pub(crate) fn dry_run(cfg: &Config, t: &Target) -> Result<(), String> {
    let text = |name: &str| {
        String::from_utf8(t.files.get(name).cloned().unwrap_or_default())
            .map_err(|_| format!("{name}: not UTF-8"))
    };
    let v = violations(cfg, &t.pins, &text("compose.yml")?, &text("set.toml")?)?;
    if v.is_empty() {
        Ok(())
    } else {
        Err(format!("lint: {}", v.join("; ")))
    }
}

/// What the dispatcher may not start without: its env files (the host worker token is
/// written once the owner confirmed the host, #321) and the capacity file (#333).
fn missing_inputs(cfg: &Config, set: &SetToml) -> Vec<String> {
    let mut wanted: Vec<&str> = set
        .needs
        .env_files
        .values()
        .flatten()
        .map(String::as_str)
        .collect();
    wanted.push("run/capacity.json");
    wanted
        .into_iter()
        .map(|f| f.strip_prefix("./").unwrap_or(f))
        .filter(|f| !cfg.set_dir.join(f).is_file())
        .map(str::to_owned)
        .collect()
}

fn held_reason(missing: &[String]) -> String {
    let mut why: Vec<String> = Vec::new();
    for m in missing {
        why.push(if m.starts_with("etc/") {
            format!("awaiting the owner's Confirm: {m} is missing")
        } else {
            format!("{m} is missing (capacity detection, #333)")
        });
    }
    format!("the dispatcher is held: {}", why.join("; "))
}

fn engine_wait(state: &mut State, ctx: &Ctx, what: &str, why: &str) {
    // Change nothing: this step runs again next tick. Said once per minute at most.
    if ctx.now - state.round.at >= 60 || state.round.outcome != Outcome::EngineUnreachable.name() {
        report(
            state,
            ctx.journal,
            ctx.now,
            Outcome::EngineUnreachable,
            None,
            &engine_detail(what, why),
        );
    }
}

/// What an engine that did not answer says. A socket that refuses this user (`EACCES`:
/// the docker group applies to new logins only) is a person's to fix, and says so; the
/// agent keeps running and asks again (#317).
pub(crate) fn engine_detail(what: &str, why: &str) -> String {
    if why.to_ascii_lowercase().contains("permission denied") {
        format!("needs a person: {what}: the engine's socket refuses this user (EACCES); log out and back in, or reboot, so the docker group applies ({why})")
    } else {
        format!("{what}: {why}")
    }
}

fn plan(state: &mut State, ctx: &mut Ctx) {
    let (p, set, services) = match project(ctx, Files::Staging) {
        Ok(v) => v,
        Err(e) => return finish(state, ctx, Outcome::Refused, None, &e),
    };
    let missing = missing_inputs(ctx.cfg, &set);
    if !missing.is_empty() {
        return finish(state, ctx, Outcome::Held, None, &held_reason(&missing));
    }
    let Some(d) = ctx.driver.as_deref_mut() else {
        return engine_wait(
            state,
            ctx,
            "plan",
            "no pinned docker and compose installed yet",
        );
    };
    let mut want = BTreeMap::new();
    for s in &services {
        match d.config_hash(&p, s) {
            Answer::Yes(h) => {
                want.insert(s.clone(), h);
            }
            Answer::NotFound | Answer::NoAnswer(_) => {
                return engine_wait(state, ctx, "plan", "compose gave no config hash")
            }
        }
    }
    let units = match d.observe(&p, &services) {
        Answer::Yes(u) => u,
        Answer::NotFound => Vec::new(),
        Answer::NoAnswer(e) => return engine_wait(state, ctx, "plan", &e),
    };
    let replace: Vec<String> = services
        .iter()
        .filter(|s| {
            !units
                .iter()
                .any(|u| &u.service == *s && u.running() && Some(&u.config_hash) == want.get(*s))
        })
        .cloned()
        .collect();
    state.rollout.services.clone_from(&replace);
    if replace.is_empty() {
        return go(state, ctx, Step::Commit);
    }
    // Started here, so a pull of a preempted round (still polled by the driver) is
    // replaced by this round's and never taken for it.
    match d.start_pull(&p, &replace) {
        Answer::Yes(()) => go(state, ctx, Step::Pull),
        Answer::NotFound | Answer::NoAnswer(_) => {
            finish(
                state,
                ctx,
                Outcome::PullFailed,
                None,
                "the pull did not start",
            );
        }
    }
}

fn pull(state: &mut State, ctx: &mut Ctx) {
    let (p, _, _) = match project(ctx, Files::Staging) {
        Ok(v) => v,
        Err(e) => return finish(state, ctx, Outcome::Refused, None, &e),
    };
    let services = state.rollout.services.clone();
    let Some(d) = ctx.driver.as_deref_mut() else {
        return engine_wait(
            state,
            ctx,
            "pull",
            "no pinned docker and compose installed yet",
        );
    };
    match d.poll_pull() {
        // None in flight (the agent restarted): start it again.
        Answer::NotFound => match d.start_pull(&p, &services) {
            Answer::Yes(()) => {}
            Answer::NotFound | Answer::NoAnswer(_) => {
                finish(
                    state,
                    ctx,
                    Outcome::PullFailed,
                    None,
                    "the pull did not start",
                );
            }
        },
        Answer::Yes(PullState::Running) => {}
        Answer::Yes(PullState::Done) => {
            if let (Some(t), Answer::Yes(images)) = (state.rollout.target, d.images(&p)) {
                state.pulled.insert(t, images);
            }
            go(
                state,
                ctx,
                Step::Replace {
                    files: Files::Staging,
                    phase: Phase::Stop,
                },
            );
        }
        Answer::Yes(PullState::Failed(e)) => {
            finish(state, ctx, Outcome::PullFailed, None, &format!("pull: {e}"));
        }
        Answer::NoAnswer(e) => engine_wait(state, ctx, "pull", &e),
    }
}

/// What a phase of a replace found.
enum Then {
    Go(Step),
    /// Not yet: the same phase next tick.
    Stay,
    /// The engine did not answer: change nothing, say so.
    Wait(String),
    Fail(String),
    /// `last-good/` runs and answers again: the revert is done.
    Reverted,
}

fn units(d: &mut dyn Driver, p: &Project, services: &[String]) -> Result<Vec<Unit>, Then> {
    match d.observe(p, services) {
        Answer::Yes(u) => Ok(u),
        Answer::NotFound => Ok(Vec::new()),
        Answer::NoAnswer(e) => Err(Then::Wait(e)),
    }
}

fn replace(state: &mut State, ctx: &mut Ctx, files: Files, phase: &Phase) -> Result<(), String> {
    let (p, set, services) = match project(ctx, files) {
        Ok(v) => v,
        Err(e) => return fail_replace(state, ctx, files, &e),
    };
    // A revert replaces every service: the round's plan was against staging.
    let services = match files {
        Files::Staging => state.rollout.services.clone(),
        Files::LastGood => services,
    };
    let now = ctx.now;
    let Some(d) = ctx.driver.as_deref_mut() else {
        engine_wait(
            state,
            ctx,
            "replace",
            "no pinned docker and compose installed yet",
        );
        return Ok(());
    };
    let next = |phase| Then::Go(Step::Replace { files, phase });
    let then = match *phase {
        Phase::Stop => {
            stop_old(d, &p, &services).map_or_else(|t| t, |()| next(Phase::Drain { since: now }))
        }
        Phase::Drain { since } => {
            match drain_old(d, &p, &services, now >= since + GRACE_S + GRACE_MARGIN_S) {
                Ok(true) => next(Phase::Create { since: now }),
                Ok(false) => Then::Stay,
                Err(t) => t,
            }
        }
        Phase::Create { since } => match d.create(&p, &services) {
            Answer::Yes(()) => next(Phase::Ready { since: now }),
            Answer::NotFound | Answer::NoAnswer(_) if now < since + ready_wait(&set) => Then::Stay,
            Answer::NotFound => Then::Fail("compose created nothing".into()),
            Answer::NoAnswer(e) => Then::Fail(format!("create: {e}")),
        },
        Phase::Ready { since } => match wait_ready(d, &p, &set, &services) {
            Ok(Some(u)) if files == Files::Staging => Then::Go(Step::Guard(Guard {
                started: now,
                container: u.id,
                restarts0: u.restarts,
                streak: 0,
                last_sample: now,
            })),
            Ok(Some(_)) => Then::Reverted,
            Ok(None) if now >= since + ready_wait(&set) => Then::Fail(format!(
                "{} did not answer /ready within {} s",
                services.join(", "),
                ready_wait(&set)
            )),
            Ok(None) => Then::Stay,
            Err(t) => t,
        },
    };
    match then {
        Then::Go(step) => {
            // The old dispatcher was sent its stop: one recreation of it, once per replace
            // (the step is saved past it). A round the pool's target started toward another
            // release counts it on the brake, and its revert's too (#325).
            if *phase == Phase::Stop && state.rollout.braked {
                state.brake.record(now, &[Ask::Restart]);
            }
            go(state, ctx, step);
        }
        Then::Stay => {}
        Then::Wait(e) => engine_wait(state, ctx, "replace", &e),
        Then::Fail(why) => fail_replace(state, ctx, files, &why)?,
        Then::Reverted => {
            let why = state.rollout.reverting.clone().unwrap_or_default();
            finish_revert(state, ctx, &why)?;
        }
    }
    Ok(())
}

/// Sends every running old container its stop signal (the dispatcher saves its leases
/// and exits; the engine kills it after the grace).
fn stop_old(d: &mut dyn Driver, p: &Project, services: &[String]) -> Result<(), Then> {
    for u in units(d, p, services)?.iter().filter(|u| !u.stopped()) {
        if let Answer::NoAnswer(e) = d.begin_drain(u, GRACE_S.unsigned_abs()) {
            return Err(Then::Wait(e));
        }
    }
    Ok(())
}

/// Removes the old containers once they stopped, or by force once `late`. `Ok(true)`:
/// none is left.
fn drain_old(
    d: &mut dyn Driver,
    p: &Project,
    services: &[String],
    late: bool,
) -> Result<bool, Then> {
    let units = units(d, p, services)?;
    let mut all_stopped = true;
    for u in &units {
        match d.drained(u) {
            Answer::Yes(true) => {}
            Answer::Yes(false) | Answer::NotFound => all_stopped = false,
            Answer::NoAnswer(e) => return Err(Then::Wait(e)),
        }
    }
    if !all_stopped && !late {
        return Ok(false);
    }
    for u in &units {
        if let Answer::NoAnswer(e) = d.remove(u, !all_stopped) {
            return Err(Then::Wait(e));
        }
    }
    Ok(true)
}

/// The first service's container once every service runs and answers its ready check.
fn wait_ready(
    d: &mut dyn Driver,
    p: &Project,
    set: &SetToml,
    services: &[String],
) -> Result<Option<Unit>, Then> {
    let units = units(d, p, services)?;
    let mut first: Option<Unit> = None;
    for s in services {
        let Some(u) = units.iter().find(|u| &u.service == s && u.running()) else {
            return Ok(None);
        };
        first.get_or_insert_with(|| u.clone());
        if let Some(r) = set.ready.get(s) {
            match d.ready(&u.id, &r.http) {
                Answer::Yes(true) => {}
                Answer::Yes(false) | Answer::NotFound => return Ok(None),
                Answer::NoAnswer(e) => return Err(Then::Wait(e)),
            }
        }
    }
    Ok(first)
}

fn ready_wait(set: &SetToml) -> i64 {
    i64::from(set.ready.values().map(|r| r.wait_s).max().unwrap_or(120))
}

fn fail_replace(state: &mut State, ctx: &mut Ctx, files: Files, why: &str) -> Result<(), String> {
    match files {
        Files::Staging => {
            go(state, ctx, revert_step(ctx, &format!("replace: {why}")));
            Ok(())
        }
        Files::LastGood => {
            let first = state.rollout.reverting.clone().unwrap_or_default();
            finish_revert(
                state,
                ctx,
                &format!("{first}; last-good did not come up either: {why}"),
            )
        }
    }
}

/// One guard sample of the dispatcher, from its state and its exits since the guard
/// began: `Ok(true)` it runs, `Ok(false)` the engine is restarting it (once), `Err` why
/// the guard fails. An ordered restart (#277) exits 75 and is restarted by the engine:
/// neither its exit nor its restart counts. `settling`: an ordered restart happened
/// within the ready wait, so a stopped sample is the gap before the engine restarts it
/// (podman reports `exited` there, docker `restarting`).
fn judge(g: &mut Guard, u: &Unit, exits: &[Exit], settling: bool) -> Result<bool, String> {
    if let Some(e) = exits.iter().find(|e| e.code != 0 && e.code != 75) {
        return Err(format!("the dispatcher exited with {}", e.code));
    }
    let ordered = exits.iter().filter(|e| e.code == 75).count() as u64;
    let unordered = u
        .restarts
        .saturating_sub(g.restarts0)
        .saturating_sub(ordered);
    if unordered >= 2 {
        return Err(format!(
            "the dispatcher restarted {unordered} times, none ordered"
        ));
    }
    if u.restarting() {
        g.streak += 1;
        return if g.streak >= 2 {
            Err("the dispatcher keeps restarting".into())
        } else {
            Ok(false)
        };
    }
    g.streak = 0;
    if u.running() {
        Ok(true)
    } else if settling {
        Ok(false)
    } else {
        Err(format!("the dispatcher is {} and not restarting", u.status))
    }
}

fn guard(state: &mut State, ctx: &mut Ctx, mut g: Guard) {
    let now = ctx.now;
    if now - g.last_sample < SAMPLE_S {
        return;
    }
    let revert = |state: &mut State, ctx: &Ctx, why: &str| {
        go(state, ctx, revert_step(ctx, &format!("guard: {why}")));
    };
    let (http, guard_s, wait_s) = match project(ctx, Files::Staging) {
        Ok((_, set, services)) => (
            services
                .first()
                .and_then(|s| set.ready.get(s))
                .map(|r| r.http.clone()),
            i64::from(set.guard_s),
            ready_wait(&set),
        ),
        Err(e) => return revert(state, ctx, &e),
    };
    let Some(d) = ctx.driver.as_deref_mut() else {
        return engine_wait(
            state,
            ctx,
            "guard",
            "no pinned docker and compose installed yet",
        );
    };
    let u = match d.inspect(&g.container) {
        Answer::Yes(u) => u,
        Answer::NotFound => return revert(state, ctx, "the dispatcher's container is gone"),
        Answer::NoAnswer(e) => return engine_wait(state, ctx, "guard", &e),
    };
    let exits = match d.exits_since(&g.container, g.started) {
        Answer::Yes(e) => e,
        Answer::NotFound => Vec::new(),
        Answer::NoAnswer(e) => return engine_wait(state, ctx, "guard", &e),
    };
    g.last_sample = now;
    let last75 = exits.iter().filter(|e| e.code == 75).map(|e| e.at).max();
    let settling = last75.is_some_and(|t| now - t <= wait_s);
    match judge(&mut g, &u, &exits, settling) {
        Err(why) => return revert(state, ctx, &why),
        Ok(false) => {
            state.rollout.step = Step::Guard(g);
            return;
        }
        Ok(true) => {}
    }
    if let Some(http) = http {
        match d.ready(&g.container, &http) {
            Answer::Yes(true) => {}
            // After an ordered restart the dispatcher answers again once it has
            // re-adopted its leases: it has the ready wait for that.
            Answer::Yes(false) | Answer::NotFound if settling => {
                state.rollout.step = Step::Guard(g);
                return;
            }
            Answer::Yes(false) | Answer::NotFound => {
                return revert(state, ctx, "the dispatcher lost /ready");
            }
            Answer::NoAnswer(e) => return engine_wait(state, ctx, "guard", &e),
        }
    }
    if now >= g.started + guard_s {
        go(state, ctx, Step::Commit);
    } else {
        state.rollout.step = Step::Guard(g);
    }
}

/// Copies `last-good/` (but `pins.json`) into the set directory, so `docker compose ps`
/// there shows what really runs.
fn write_set_dir(ctx: &Ctx) -> Result<(), String> {
    let mut files = read_tree(&last_good(ctx))?;
    files.remove(PINS);
    write_files(&ctx.cfg.set_dir, &files)
}

/// The release a rendered directory's `pins.json` names.
fn pins_release(dir: &Path) -> Option<Release> {
    let pins: Pins = serde_json::from_slice(&fs::read(dir.join(PINS)).ok()?).ok()?;
    Some(pins.release)
}

fn commit(state: &mut State, ctx: &mut Ctx) -> Result<(), String> {
    let Some(target) = state.rollout.target else {
        finish(state, ctx, Outcome::Refused, None, "a round with no target");
        return Ok(());
    };
    let (dir, good) = (staging(ctx), last_good(ctx));
    // Safe to run again: a commit that stopped after the rename (a restart, a failed
    // write of the set directory) finds staging gone and last-good already the target.
    if dir.join("compose.yml").exists() {
        reset_dir(&good)?;
        fs::rename(&dir, &good).map_err(|e| format!("{}: {e}", dir.display()))?;
    } else if pins_release(&good) != Some(target) {
        go(
            state,
            ctx,
            Step::Revert {
                why: "commit: staging is gone and last-good is not the target".into(),
            },
        );
        return Ok(());
    }
    write_set_dir(ctx)?;
    let from = state.rollout.from;
    state.floor = Some(state.floor.map_or(target, |f| f.max(target)));
    if state.rollout.rollback {
        // The statement set the floor to `to`; nothing above it stays the floor.
        state.floor = Some(target);
    }
    // What a co-signed statement vouched for holds only while the floor stands there (#330).
    if state.vouched != state.floor {
        state.vouched = None;
    }
    state.applied = Some(target);
    state.quarantine.remove(&target);
    prune(state, ctx, target, from);
    let changed = !state.rollout.services.is_empty() || from != Some(target);
    let detail = if changed {
        format!("{} runs {target}", ctx.cfg.set_name)
    } else {
        format!("{} already runs {target} as rendered", ctx.cfg.set_name)
    };
    let outcome = if changed {
        Outcome::Ok
    } else {
        Outcome::NoChange
    };
    // `from` is the rolled-back release's alone (design v2 §17.2); the journal's
    // round-start says what ran before.
    finish(state, ctx, outcome, None, &detail);
    Ok(())
}

/// Removes the images the agent pulled for releases older than the previous one (and
/// not the one now applied); the engine refuses any a container uses. Their cached
/// bundles go too.
fn prune(state: &mut State, ctx: &mut Ctx, target: Release, from: Option<Release>) {
    let Some(from) = from else { return };
    let old: Vec<Release> = state
        .pulled
        .keys()
        .copied()
        .filter(|r| *r < from && *r != target)
        .collect();
    for r in old {
        let images = state.pulled.remove(&r).unwrap_or_default();
        if let Some(d) = ctx.driver.as_deref_mut() {
            for i in &images {
                let _ = d.remove_image(i);
            }
        }
        for ext in ["tar.gz", "tar.gz.sigstore.json"] {
            let _ = fs::remove_file(ctx.paths.bundles().join(format!("omarchy-host-{r}.{ext}")));
        }
        // And its maintainers' co-signatures (#330), one file each.
        let cosigned = format!("omarchy-host-{r}.tar.gz.");
        for e in fs::read_dir(ctx.paths.bundles())
            .into_iter()
            .flatten()
            .flatten()
        {
            let n = e.file_name();
            let n = n.to_string_lossy();
            if n.starts_with(&cosigned) && n.ends_with(".sshsig") {
                let _ = fs::remove_file(e.path());
            }
        }
        ctx.journal.write(
            ctx.now,
            "pruned",
            serde_json::json!({"release": r.to_string(), "images": images}),
        );
    }
}

fn finish_revert(state: &mut State, ctx: &mut Ctx, why: &str) -> Result<(), String> {
    if last_good(ctx).join("compose.yml").exists() {
        write_set_dir(ctx)?;
    }
    let _ = fs::remove_dir_all(staging(ctx));
    let target = state.rollout.target;
    if let Some(t) = target {
        let q = state.quarantine.entry(t).or_insert(Quarantine {
            until: None,
            reverts: 0,
        });
        q.reverts += 1;
        // One retry after an hour; a second revert waits for a newer release.
        q.until = (q.reverts < 2).then_some(ctx.now + QUARANTINE_S);
    }
    let until = target
        .and_then(|t| state.quarantine.get(&t))
        .map_or_else(String::new, |q| match q.until {
            Some(u) => format!(" (quarantined until {u})"),
            None => " (quarantined until a newer release)".into(),
        });
    // Reported at `revert`; `why` names the step that failed.
    state.rollout.step = Step::Revert {
        why: why.to_owned(),
    };
    finish(
        state,
        ctx,
        Outcome::RolledBack,
        target,
        &format!("{why}{until}"),
    );
    Ok(())
}

/// Whether `target` waits in quarantine now.
pub(crate) fn quarantined(state: &State, target: Release, now: i64) -> Option<String> {
    let q = state.quarantine.get(&target)?;
    match q.until {
        Some(u) if now < u => Some(format!("{target} is quarantined until {u}")),
        Some(_) => None,
        None => Some(format!("{target} is quarantined until a newer release")),
    }
}

#[cfg(test)]
#[path = "rollout_tests.rs"]
mod tests;
