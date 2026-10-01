//! One tick of the run loop (design v2 §16.1): ask the pool when a poll is due, check the
//! target against the trust rules, start or preempt a round, and take one step of it.
//! Network answers never stop the agent (§16.4): no answer, a 5xx or a malformed body
//! changes nothing and backs off to 10 minutes; a 401/403 changes nothing and polls
//! hourly; both recover by themselves at the next answer.

use std::fs;

use crate::manifest::Manifest;
use crate::verify::{self, BundleOutcome, Rejection, StatementOutcome, VerifiedBundle};
use crate::version::{self, Release};

use super::compose::Compose;
use super::config::{Config, Paths};
use super::driver::{Answer, Driver};
use super::journal::{env_secrets, Journal};
use super::pool::{Follow, Net, Pool};
use super::rollout::{self, Ctx, Outcome};
use super::state::{self, State, Step};
use super::target::Target;
use super::tools;
use super::trust::{self, Refusal};

/// The poll interval when the pool names none (its `FOLLOW_POLL_S`), and the bounds.
const POLL_S: i64 = 120;
const MAX_BACKOFF_S: i64 = 600;
const UNAUTHORIZED_S: i64 = 3600;
/// The safety timer: the running set is checked against `last-good/` at least this often.
const DRIFT_S: i64 = 900;

/// The cryptographic check, pinned identities and parsing (`crate::verify`).
pub(crate) trait Verifier {
    fn bundle(&self, archive: &[u8], sig: &[u8]) -> Result<BundleOutcome, Rejection>;
    fn statement(&self, json: &[u8], sig: &[u8]) -> Result<StatementOutcome, Rejection>;
}

/// Sigstore, pinned to release.yml and rollback.yml on main.
pub(crate) struct Sigstore;

impl Verifier for Sigstore {
    fn bundle(&self, archive: &[u8], sig: &[u8]) -> Result<BundleOutcome, Rejection> {
        verify::bundle(archive, sig)
    }
    fn statement(&self, json: &[u8], sig: &[u8]) -> Result<StatementOutcome, Rejection> {
        verify::statement(json, sig)
    }
}

/// Where the driver comes from: the pinned tools of a verified manifest, or (tests) one
/// given once.
pub(crate) enum Drivers {
    Pinned,
    #[cfg(test)]
    Fixed,
}

pub(crate) struct Agent {
    pub cfg: Config,
    pub paths: Paths,
    pub state: State,
    pub journal: Journal,
    pub driver: Option<Box<dyn Driver>>,
    pub pool: Box<dyn Pool>,
    pub verifier: Box<dyn Verifier>,
    pub drivers: Drivers,
    /// The verified target of the round in flight.
    pub pending: Option<Target>,
    saved: Option<State>,
    last_drift: i64,
    /// The inputs hash a round was last started for, so a held round is not restarted
    /// every tick: the next change of an input starts the next one.
    last_inputs: Option<String>,
    announced: Option<version::Version>,
}

enum Fetched {
    Bundle(Box<VerifiedBundle>),
    Stop,
}

impl Agent {
    pub fn new(
        cfg: Config,
        paths: Paths,
        state: State,
        pool: Box<dyn Pool>,
        verifier: Box<dyn Verifier>,
        drivers: Drivers,
    ) -> Self {
        let mut journal = Journal::new(&paths.journal());
        journal.set_secrets(env_secrets(&cfg.set_dir));
        Agent {
            cfg,
            paths,
            state,
            journal,
            driver: None,
            pool,
            verifier,
            drivers,
            pending: None,
            saved: None,
            last_drift: 0,
            last_inputs: None,
            announced: None,
        }
    }

    /// At start: the tools recorded in the state, opened and checked again.
    pub fn open_tools(&mut self) {
        if !matches!(self.drivers, Drivers::Pinned) {
            return;
        }
        if let Some(pins) = self.state.tools.clone() {
            match tools::open(&self.paths.tools(), &pins) {
                Ok(t) => return self.use_tools(t),
                Err(e) => self.journal.write(
                    super::now(),
                    "tools",
                    serde_json::json!({"detail": format!("the recorded tools do not open: {e}")}),
                ),
            }
        }
        // Installed again from the bundle that runs (cached, verified again); otherwise
        // the next verified bundle installs them.
        if let Some(b) = self.state.applied.and_then(|r| self.cached(r)) {
            if let Err(e) = self.ensure_tools(b.manifest(), super::now()) {
                self.journal
                    .write(super::now(), "tools", serde_json::json!({"detail": e}));
            }
        }
    }

    fn use_tools(&mut self, t: tools::Tools) {
        self.state.tools = Some(t.pins.clone());
        self.driver = Some(Box::new(Compose::new(
            t,
            &self.cfg.socket_cli,
            &self.paths.docker_config(),
        )));
    }

    /// The pinned tools of a verified manifest: installed if missing, and the driver
    /// switched to them when they changed.
    fn ensure_tools(&mut self, m: &Manifest, now: i64) -> Result<(), String> {
        if !matches!(self.drivers, Drivers::Pinned) {
            return Ok(());
        }
        let platform = tools::platform().ok_or("this platform has no pinned tools")?;
        let want = m
            .tool(platform, "docker")
            .zip(m.tool(platform, "docker-compose"));
        let same = match (&self.state.tools, want) {
            (Some(have), Some((d, c))) => {
                have.docker == hex::encode(d.sha256().as_bytes())
                    && have.compose == hex::encode(c.sha256().as_bytes())
            }
            _ => false,
        };
        if same && self.driver.is_some() {
            return Ok(());
        }
        let pool = &mut self.pool;
        let t = tools::ensure(
            &self.paths.tools(),
            m,
            platform,
            &mut |url| match pool.download(url) {
                Net::Ok(b) => Ok(b),
                Net::NoAnswer(e) => Err(format!("{url}: {e}")),
                Net::Unauthorized(s) => Err(format!("{url}: HTTP {s}")),
            },
        )?;
        self.journal.write(
            now,
            "tools",
            serde_json::json!({"docker": t.pins.docker, "compose": t.pins.compose}),
        );
        self.use_tools(t);
        Ok(())
    }

    /// One tick. `Err` only for a local error (the disk): nothing is saved and the loop
    /// retries at its next tick.
    pub fn tick(&mut self, now: i64, round_now: bool) -> Result<(), String> {
        if round_now || now >= self.state.poll.next_at {
            self.poll(now, round_now);
        }
        if self.state.rollout.step == Step::Idle {
            self.drift(now);
        }
        self.step(now)?;
        if self.saved.as_ref() != Some(&self.state) {
            state::save(&self.paths.state(), &self.state)?;
            self.saved = Some(self.state.clone());
        }
        Ok(())
    }

    fn step(&mut self, now: i64) -> Result<(), String> {
        if self.state.rollout.step == Step::Render {
            self.reload_pending(now);
        }
        let mut ctx = Ctx {
            cfg: &self.cfg,
            paths: &self.paths,
            driver: self.driver.as_deref_mut().map(|d| d as &mut dyn Driver),
            journal: &self.journal,
            now,
        };
        rollout::step(&mut self.state, self.pending.as_ref(), &mut ctx)?;
        if self.state.rollout.step == Step::Idle {
            self.pending = None;
        }
        Ok(())
    }

    /// After a restart at `render`, the bundle comes back from the cache (verified again).
    fn reload_pending(&mut self, _now: i64) {
        let Some(t) = self.state.rollout.target else {
            return;
        };
        if self.pending.as_ref().is_some_and(|p| p.release() == t) || self.state.applied == Some(t)
        {
            return;
        }
        if let Some(b) = self.cached(t) {
            self.pending = Target::from_bundle(&b, &self.cfg.set_name).ok();
        }
    }

    fn bundle_names(r: Release) -> (String, String) {
        let name = format!("omarchy-host-{r}.tar.gz");
        let sig = format!("{name}.sigstore.json");
        (name, sig)
    }

    fn cached(&self, r: Release) -> Option<Box<VerifiedBundle>> {
        let (name, sig) = Self::bundle_names(r);
        let dir = self.paths.bundles();
        let (a, s) = (
            fs::read(dir.join(&name)).ok()?,
            fs::read(dir.join(&sig)).ok()?,
        );
        match self.verifier.bundle(&a, &s) {
            Ok(BundleOutcome::Current(b)) if Release(b.manifest().outer().release()) == r => {
                Some(b)
            }
            _ => None,
        }
    }

    /// Says what a poll found when no round is in flight; a round's own report is kept.
    fn say(&mut self, now: i64, outcome: Outcome, detail: &str) {
        if self.state.rollout.step == Step::Idle {
            rollout::report(&mut self.state, &self.journal, now, outcome, None, detail);
        } else {
            self.journal.write(
                now,
                "poll",
                serde_json::json!({"outcome": outcome.name(), "detail": detail}),
            );
        }
    }

    fn poll(&mut self, now: i64, round_now: bool) {
        let answer = self.pool.follow(&self.cfg.worker_id);
        let p = &mut self.state.poll;
        p.last_at = now;
        match answer {
            Net::Ok(f) => {
                p.last = "ok".into();
                p.backoff_s = 0;
                let every = f.poll_s.unwrap_or(POLL_S).clamp(60, MAX_BACKOFF_S);
                p.next_at = now + jitter(every, now);
                self.on_follow(f, now, round_now);
            }
            Net::NoAnswer(e) => {
                p.last = "no-answer".into();
                p.backoff_s = if p.backoff_s == 0 {
                    60
                } else {
                    (p.backoff_s * 2).min(MAX_BACKOFF_S)
                };
                p.next_at = now + p.backoff_s;
                let detail = format!(
                    "the pool did not answer ({e}); everything keeps running, next poll in {} s",
                    p.backoff_s
                );
                self.say(now, Outcome::PoolUnreachable, &detail);
            }
            Net::Unauthorized(s) => {
                p.last = "unauthorized".into();
                p.backoff_s = 0;
                p.next_at =
                    now + UNAUTHORIZED_S + jitter(UNAUTHORIZED_S / 10, now) - UNAUTHORIZED_S / 10;
                let detail =
                    format!("the pool answered {s}; everything keeps running, polling hourly");
                self.say(now, Outcome::Unauthorized, &detail);
            }
        }
    }

    fn on_follow(&mut self, f: Follow, now: i64, round_now: bool) {
        let mut force: Option<String> =
            round_now.then(|| "a round was asked for (SIGUSR1)".to_owned());
        // An Update order waits while commit or a revert finishes (a revert quarantines
        // again): the next poll sees it unconsumed.
        let busy = self.state.rollout.step != Step::Idle
            && !rollout::preemptible(&self.state.rollout.step);
        if let Some(id) = f
            .update
            .filter(|id| !busy && self.state.update_seen.as_ref() != Some(id))
        {
            if !self.state.quarantine.is_empty() {
                self.journal.write(
                    now,
                    "quarantine-lifted",
                    serde_json::json!({"by": id, "releases": self.state.quarantine.keys().map(ToString::to_string).collect::<Vec<_>>()}),
                );
            }
            self.state.quarantine.clear();
            force = Some(format!("Update order {id}"));
            self.state.update_seen = Some(id);
        }
        let Some(target) = f.latest else {
            return;
        };
        self.state.target = Some(target);
        let step = self.state.rollout.step.clone();
        let in_flight = (step != Step::Idle)
            .then_some(self.state.rollout.target)
            .flatten();
        // The round in flight goes there already; commit and revert finish first (the
        // next poll sees the target again).
        if in_flight == Some(target) || (in_flight.is_some() && !rollout::preemptible(&step)) {
            return;
        }
        // Only a newer release or a rollback statement preempts (a target below the
        // floor needs one): an older admitted release waits for the round to end.
        if in_flight.is_some_and(|cur| target < cur)
            && !matches!(
                trust::admit(&self.state, target),
                Err(Refusal::BelowFloor { .. })
            )
        {
            return;
        }
        if in_flight.is_none() && self.state.applied == Some(target) && force.is_none() {
            return;
        }
        let good = self
            .paths
            .last_good(&self.cfg.set_name)
            .join("pins.json")
            .exists();
        if self.state.applied == Some(target) && good {
            match trust::admit(&self.state, target) {
                Ok(()) => {
                    let why =
                        force.unwrap_or_else(|| format!("the pool names {target}, which runs"));
                    self.start(now, target, false, &why);
                }
                Err(r) => self.refuse(now, &r),
            }
            return;
        }
        if let Some(q) = rollout::quarantined(&self.state, target, now) {
            self.say(now, Outcome::Held, &q);
            return;
        }
        let why = force.unwrap_or_else(|| match self.state.applied {
            Some(a) => format!("the pool names {target} (runs {a})"),
            None => format!("the pool names {target}"),
        });
        self.go_to(target, now, &why);
    }

    /// A new target: its bundle verified, the trust rules, the tools, then a round.
    fn go_to(&mut self, target: Release, now: i64, why: &str) {
        let b = match self.fetch(target, now) {
            Fetched::Bundle(b) => b,
            Fetched::Stop => return,
        };
        trust::merge(&mut self.state, b.manifest());
        let ours = self.cfg.pool.trim_end_matches('/');
        if !b
            .manifest()
            .pools()
            .iter()
            .any(|p| p.trim_end_matches('/') == ours)
        {
            return self.refuse(now, &Refusal::PoolNotListed(self.cfg.pool.clone()));
        }
        let rollback = match trust::admit(&self.state, target) {
            Ok(()) => false,
            Err(Refusal::BelowFloor { .. }) => match self.statement(target, &b, now) {
                Some(Ok(())) => true,
                Some(Err(r)) => return self.refuse(now, &r),
                None => return,
            },
            Err(r) => return self.refuse(now, &r),
        };
        if let Err(e) = self.ensure_tools(b.manifest(), now) {
            let detail = format!("the pinned tools: {e}");
            return self.say(now, Outcome::EngineUnreachable, &detail);
        }
        let agent = b.manifest().outer().agent().version();
        if agent > version::agent() && self.announced != Some(agent) {
            self.announced = Some(agent);
            self.journal.write(
                now,
                "agent-available",
                serde_json::json!({"version": agent.to_string(), "detail": "self-update arrives with #316; this agent rolls the release out meanwhile"}),
            );
        }
        match Target::from_bundle(&b, &self.cfg.set_name) {
            Ok(t) => {
                self.start(now, target, rollback, why);
                self.pending = Some(t);
            }
            Err(e) => self.say(now, Outcome::Refused, &format!("{target}: {e}")),
        }
    }

    fn refuse(&mut self, now: i64, r: &Refusal) {
        self.say(
            now,
            Outcome::Refused,
            &format!("refused ({}): {r}", r.reason()),
        );
    }

    /// The target's bundle: from the cache, or GitHub, verified either way.
    fn fetch(&mut self, target: Release, now: i64) -> Fetched {
        if let Some(b) = self.cached(target) {
            return Fetched::Bundle(b);
        }
        let (name, sig) = Self::bundle_names(target);
        let get = |pool: &mut Box<dyn Pool>, n: &str| pool.release_asset(target, n);
        let (archive, signature) = match (get(&mut self.pool, &name), get(&mut self.pool, &sig)) {
            (Net::Ok(a), Net::Ok(s)) => (a, s),
            (Net::Unauthorized(s), _) | (_, Net::Unauthorized(s)) => {
                self.say(
                    now,
                    Outcome::PoolUnreachable,
                    &format!("{target}'s bundle: HTTP {s}"),
                );
                return Fetched::Stop;
            }
            (Net::NoAnswer(e), _) | (_, Net::NoAnswer(e)) => {
                self.say(
                    now,
                    Outcome::PoolUnreachable,
                    &format!("{target}'s bundle: {e}"),
                );
                return Fetched::Stop;
            }
        };
        match self.verifier.bundle(&archive, &signature) {
            Ok(BundleOutcome::Current(b)) => {
                let r = Release(b.manifest().outer().release());
                if r != target {
                    self.refuse(
                        now,
                        &Refusal::Verify {
                            reason: "content",
                            detail: format!("asked for {target}, the bundle is {r}"),
                        },
                    );
                    return Fetched::Stop;
                }
                let dir = self.paths.bundles();
                let stored = fs::create_dir_all(&dir)
                    .map_err(|e| e.to_string())
                    .and_then(|()| state::write_atomic(&dir.join(&name), &archive))
                    .and_then(|()| state::write_atomic(&dir.join(&sig), &signature));
                if let Err(e) = stored {
                    self.journal
                        .write(now, "cache", serde_json::json!({"detail": e}));
                }
                Fetched::Bundle(b)
            }
            Ok(BundleOutcome::NeedsNewerAgent { why, .. }) => {
                self.say(
                    now,
                    Outcome::NeedsNewerAgent,
                    &format!("{target}: {why} (self-update is #316)"),
                );
                Fetched::Stop
            }
            Err(r) => {
                self.refuse(
                    now,
                    &Refusal::Verify {
                        reason: r.reason(),
                        detail: r.to_string(),
                    },
                );
                Fetched::Stop
            }
        }
    }

    /// A target below the floor: only under a rollback statement rollback.yml signed on
    /// main that covers this host. `None`: no decision now (the pool did not answer).
    fn statement(
        &mut self,
        target: Release,
        b: &VerifiedBundle,
        now: i64,
    ) -> Option<Result<(), Refusal>> {
        let floor = self.state.floor.unwrap_or(target);
        let relayed = match self.pool.rollback(target) {
            Net::Ok(Some(r)) => r,
            Net::Ok(None) => {
                return Some(Err(Refusal::BelowFloor {
                    target,
                    floor,
                    why: "the pool relays no rollback statement for it".into(),
                }))
            }
            Net::NoAnswer(e) => {
                self.say(
                    now,
                    Outcome::PoolUnreachable,
                    &format!("the rollback statement for {target}: {e}"),
                );
                return None;
            }
            Net::Unauthorized(s) => {
                self.say(
                    now,
                    Outcome::Unauthorized,
                    &format!("the rollback statement for {target}: HTTP {s}"),
                );
                return None;
            }
        };
        let vs = match self.verifier.statement(&relayed.statement, &relayed.bundle) {
            Ok(StatementOutcome::Current(vs)) => vs,
            Ok(StatementOutcome::NeedsNewerAgent { why, .. }) => {
                self.say(
                    now,
                    Outcome::NeedsNewerAgent,
                    &format!("rollback statement: {why}"),
                );
                return None;
            }
            Err(r) => {
                return Some(Err(Refusal::Verify {
                    reason: r.reason(),
                    detail: format!("rollback statement: {r}"),
                }))
            }
        };
        let st = vs.statement();
        let created = b.manifest().outer().created();
        Some(
            trust::admit_rollback(&self.state, target, st, vs.signer().signed_at(), created).map(|()| {
                self.journal.write(
                    now,
                    "rollback-accepted",
                    serde_json::json!({"seq": st.seq(), "to": target.to_string(), "retracts_through": format!("v{}", st.retracts_through()), "run": st.run()}),
                );
                trust::accept_rollback(&mut self.state, st);
            }),
        )
    }

    /// Starts (or preempts) a round, with the env files' values read again so the journal
    /// scrubs a token written since (the owner's Confirm, a rotation).
    fn start(&mut self, now: i64, target: Release, rollback: bool, why: &str) {
        self.journal.set_secrets(env_secrets(&self.cfg.set_dir));
        rollout::start(&mut self.state, &self.journal, now, target, rollback, why);
    }

    /// When idle: a changed input (the override, `etc/`, `run/capacity.json`) starts a
    /// round at once; the running set is compared with `last-good/` every 15 minutes.
    fn drift(&mut self, now: i64) {
        let Some(applied) = self.state.applied else {
            return;
        };
        let good = self.paths.last_good(&self.cfg.set_name);
        let Ok(overlay) = fs::read_to_string(good.join("agent.yml")) else {
            return;
        };
        let inputs = rollout::inputs_hash(&self.cfg.set_dir);
        if !overlay.contains(&inputs) && self.last_inputs.as_ref() != Some(&inputs) {
            self.last_inputs = Some(inputs);
            let why = "an input changed (the override, etc/ or run/capacity.json)";
            return self.start(now, applied, false, why);
        }
        if now - self.last_drift < DRIFT_S {
            return;
        }
        self.last_drift = now;
        if self.drifted() {
            self.start(
                now,
                applied,
                false,
                "the dispatcher does not run as last-good says",
            );
        }
    }

    /// Whether a service of `last-good/` is missing, stopped or differently configured.
    fn drifted(&mut self) -> bool {
        let Some(d) = self.driver.as_deref_mut() else {
            return false;
        };
        let good = self.paths.last_good(&self.cfg.set_name);
        let Ok(set) = fs::read_to_string(good.join("set.toml"))
            .map_err(|e| e.to_string())
            .and_then(|t| crate::lint::parse_set_toml(&t))
        else {
            return false;
        };
        let Some(services) = fs::read_to_string(good.join("compose.yml"))
            .ok()
            .and_then(|t| crate::lint::service_names(&t))
        else {
            return false;
        };
        let mut files = vec![good.join("compose.yml"), good.join("agent.yml")];
        let over = self.cfg.set_dir.join("compose.override.yml");
        if over.exists() {
            files.push(over);
        }
        let p = super::driver::Project {
            name: self.cfg.project.clone().unwrap_or(set.project_default),
            dir: self.cfg.set_dir.clone(),
            files,
            env: self.cfg.interpolation(),
        };
        let Answer::Yes(units) = d.observe(&p, &services) else {
            return false;
        };
        services.iter().any(|s| match d.config_hash(&p, s) {
            Answer::Yes(h) => !units
                .iter()
                .any(|u| &u.service == s && (u.running() || u.restarting()) && u.config_hash == h),
            _ => false,
        })
    }
}

/// `base` seconds, ±20%, from the clock and the process id: hosts that started together
/// drift apart without a random number generator.
fn jitter(base: i64, now: i64) -> i64 {
    let seed = (now.unsigned_abs() ^ u64::from(std::process::id()))
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        >> 33;
    let span = (base / 5).max(1);
    base - span + i64::try_from(seed % (2 * span.unsigned_abs() + 1)).unwrap_or(0)
}

#[cfg(test)]
#[path = "agent_tests.rs"]
mod tests;
