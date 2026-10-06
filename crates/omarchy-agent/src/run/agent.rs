//! One tick of the run loop (design v2 §16.1): ask the pool for the host state when a poll
//! is due (#344: the release target, the open Updates and the host orders; #325: the
//! settings), check the target against the trust rules and the brake, start or preempt a
//! round, and take one step of it; the next queued host order the brake lets through;
//! `run/capacity.json` kept as the settings say; one step of a `retire-legacy` in flight
//! and of the owner's runtime switch; GitHub's latest release read when it is time (#326's
//! freeze detection, [`super::freeze`]); the host report when it is due. A new release
//! waits for the owner's soak (#326, [`super::soak`]) unless a rollback statement brings
//! it. Network answers never stop the agent (§16.4): no answer, a 5xx or a malformed body
//! changes nothing and backs off to 10 minutes; a 401/403 changes nothing and polls hourly;
//! both recover by themselves at the next answer.

use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use crate::dispatcher_env::{self, addresses, Envelope, Refresh, Rendered, Sources};
use crate::manifest::{Manifest, Outer};
use crate::statement::Statement;
use crate::verify::{self, BundleOutcome, Rejection, StatementOutcome, VerifiedBundle};
use crate::version::{self, Release, Version};

use super::brake::{Ask, ROUND_RESTARTS};
use super::compose::Compose;
use super::config::{Config, Paths};
use super::driver::{Answer, Driver};
use super::journal::{env_secrets, Journal};
use super::orders::Taken;
use super::pool::{HostState, Net, Order, Pool};
use super::report::Reported;
use super::rollout::{self, Ctx, Outcome};
use super::selfupdate::Pending;
use super::state::{self, Files, Phase, State, Step};
use super::target::Target;
use super::tools;
use super::trust::{self, Refusal};

/// The poll interval when the pool names none (its `FOLLOW_POLL_S`), and the bounds.
const POLL_S: i64 = 120;
const MAX_BACKOFF_S: i64 = 600;
pub(super) const UNAUTHORIZED_S: i64 = 3600;
/// The safety timer: the running set is checked against `last-good/` at least this often.
const DRIFT_S: i64 = 900;
/// How often the host's own addresses are read again for `etc/dispatcher.env` (#371).
pub(crate) const ADDRESSES_S: i64 = 60;
/// How often the pool's edge is asked which public address the host leaves from (#371).
pub(crate) const PUBLIC_S: i64 = 3600;
/// After an ask the edge did not answer, the next comes after [`ADDRESSES_S`], doubled up
/// to this: a reboot that gave the home connection a new address often starts the loop
/// before the network is up, and the new address must not wait the hour to be refused.
pub(crate) const PUBLIC_RETRY_S: i64 = 300;

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
    /// The last agent version said to be skipped, so it is said once.
    pub(super) announced: Option<Version>,
    /// The watchdog's clock of the loop's last progress, moved on before each pinned
    /// tool's download too: one tick may hold two of them.
    pub progress: Option<Arc<AtomicI64>>,
    /// This agent's own version (a test plays another).
    pub version: Version,
    /// The binary that runs (`current_exe`): a self-update starts only from the one
    /// install.sh installed, so the way back is there.
    pub exe: Option<PathBuf>,
    /// Set when the agent should exit after this tick (a self-update swapped `current`).
    pub exit: Option<u8>,
    /// This agent is a self-update's candidate: its health gate is still shut.
    pub gate: Option<Pending>,
    pub(super) gate_next: i64,
    /// The agent version whose update failed before the swap, and when.
    pub(super) retry: Option<(Version, i64)>,
    /// The applied release whose agent was checked and needs no update (once per start).
    pub(super) upward_checked: Option<Release>,
    /// Order ids refused as seen already, said once per process (#344).
    pub(super) repeated: BTreeSet<String>,
    /// The legacy set as last looked at, for the report, and when.
    pub(super) legacy_seen: Option<(i64, serde_json::Value)>,
    /// The host report last sent (#344).
    pub(super) reported: Reported,
    /// Said once per process: the pool predates the host state's release (#344), so its
    /// `follow` names the target.
    older_pool_said: bool,
    /// The host orders of the last host state not taken yet: the brake paces them (#325).
    pub(super) queue: VecDeque<Order>,
    /// What was said once per process (#325: a narrowing that could not be written, the
    /// pool's settings held by the brake).
    pub(super) said: BTreeSet<String>,
    /// Tests: the fake engine behind another socket (the runtime switch, #325).
    #[cfg(test)]
    #[allow(clippy::type_complexity)]
    pub drivers_on: Option<Box<dyn FnMut(&std::path::Path) -> Option<Box<dyn Driver>>>>,
    /// `etc/dispatcher.env` rendered again from the host and agent.toml (#371); `None`
    /// leaves the file alone (the tests that play other parts).
    pub host_env: Option<HostEnv>,
}

/// The run loop's half of `etc/dispatcher.env` (#371): at its start, then every
/// [`ADDRESSES_S`], the host's own addresses and agent.toml are read again and the file
/// rendered with them, its token kept; at its start, then every [`PUBLIC_S`], the pool's
/// edge is asked which public address the host leaves from (`egress.json`, which install
/// wrote first), and within minutes after an ask it did not answer ([`PUBLIC_RETRY_S`]). A
/// file that changed starts a round (an input of the set), which recreates the dispatcher.
pub(crate) struct HostEnv {
    pub sources: Sources,
    next_at: i64,
    public_at: i64,
    /// The wait after the next ask the edge does not answer.
    public_retry: i64,
    /// The last failure said, so a failure that lasts is said once.
    failing: Option<String>,
}

impl HostEnv {
    pub fn new(sources: Sources) -> Self {
        Self {
            sources,
            next_at: 0,
            public_at: 0,
            public_retry: ADDRESSES_S,
            failing: None,
        }
    }
}

enum Fetched {
    Bundle(Box<VerifiedBundle>),
    /// Signed for this host, but only an agent above this one reads it: its outer layer.
    NewerAgent(Box<Outer>, String),
    Stop,
}

/// What `etc/dispatcher.env` gets beside the token now (#371): the host's own addresses
/// from `sources`, and agent.toml as it is now, as `omarchy-agent token` and
/// `dispatcher-env --write` read it, so the loop never puts back what they wrote; one that
/// does not read now (an edit half done) leaves what the loop started with. The run loop's
/// refresh and its `rotate-token` (#325) both render it so.
pub(super) fn rendered(cfg: &Config, paths: &Paths, sources: &Sources) -> Rendered {
    let envelope = match Envelope::of_data_dir(&paths.data) {
        Some(Ok(e)) if dispatcher_env::dispatcher_path(&e.secrets_dir) => e,
        _ => Envelope::of_config(cfg),
    };
    Rendered::now(sources, &paths.data, Some(envelope))
}

/// The cached names of release `r`'s bundle and its signature.
pub(crate) fn bundle_names(r: Release) -> (String, String) {
    let name = format!("omarchy-host-{r}.tar.gz");
    let sig = format!("{name}.sigstore.json");
    (name, sig)
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
            progress: None,
            version: version::agent(),
            exe: None,
            exit: None,
            gate: None,
            gate_next: 0,
            retry: None,
            upward_checked: None,
            repeated: BTreeSet::new(),
            legacy_seen: None,
            reported: Reported::default(),
            older_pool_said: false,
            queue: VecDeque::new(),
            said: BTreeSet::new(),
            #[cfg(test)]
            drivers_on: None,
            host_env: None,
        }
    }

    /// At start: a step bounded by the wall clock is timed again from now. While the
    /// agent was down (a reboot) the engine brought the dispatcher back, and it is still
    /// re-adopting its leases: a ready wait or a guard that ran on meanwhile would revert
    /// a good release. The guard begins again at the ready wait, so its evidence (exits,
    /// `RestartCount`) counts from when the agent is back to watch.
    pub fn resume(&mut self, now: i64) {
        // A runtime switch in flight goes on with the engine it was on (#325).
        self.resume_switch();
        let step = &mut self.state.rollout.step;
        match step {
            Step::Replace {
                phase: Phase::Create { since } | Phase::Ready { since },
                ..
            } => *since = now,
            Step::Guard(_) => {
                *step = Step::Replace {
                    files: Files::Staging,
                    phase: Phase::Ready { since: now },
                };
            }
            _ => {}
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
        let progress = self.progress.clone();
        let t = tools::ensure(&self.paths.tools(), m, platform, &mut |url| {
            if let Some(p) = &progress {
                p.store(super::now(), Ordering::Relaxed);
            }
            match pool.download(url) {
                Net::Ok(b) => Ok(b),
                Net::NoAnswer(e) => Err(format!("{url}: {e}")),
                Net::Unauthorized(s) => Err(format!("{url}: HTTP {s}")),
            }
        })?;
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
        // A new agent touches nothing until its health gate passed; once a self-update
        // swapped `current`, the state is saved and the agent exits before anything
        // else (#316).
        if self.gate.is_some() {
            self.gate_step(now);
        } else if self.exit.is_none() {
            self.dispatcher_env(now);
            if round_now || now >= self.state.poll.next_at {
                self.poll(now, round_now);
            } else if !self.queue.is_empty() {
                // The orders the brake paced: the next one, two seconds after the last.
                let taken = self.take_orders(now, self.busy());
                if !taken.rounds.is_empty() {
                    self.after_orders(taken, self.state.target, None, now);
                }
            }
            self.narrow(now);
            // Never while the owner's runtime switch moves the dispatcher (#325): it stops
            // the old one on purpose.
            if self.state.rollout.step == Step::Idle
                && self.exit.is_none()
                && self.state.switch.is_none()
            {
                self.drift(now);
            }
            if self.exit.is_none() {
                // A step that cannot write (a set directory, a full disk) is retried every
                // tick; a retire-legacy in flight goes on meanwhile, and the report still
                // says what the host knows, its answers above all.
                self.identify_runtime();
                let stepped = self.step(now);
                self.switch_step(now);
                self.retire_step(now);
                self.freeze(now);
                self.report(now);
                stepped?;
            }
        }
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

    /// Release `r`'s bundle from the cache, verified again.
    fn cached_outcome(&self, r: Release) -> Option<BundleOutcome> {
        let (name, sig) = bundle_names(r);
        let dir = self.paths.bundles();
        let (a, s) = (
            fs::read(dir.join(&name)).ok()?,
            fs::read(dir.join(&sig)).ok()?,
        );
        let outcome = self.verifier.bundle(&a, &s).ok()?;
        let release = match &outcome {
            BundleOutcome::Current(b) => b.manifest().outer().release(),
            BundleOutcome::NeedsNewerAgent { outer, .. } => outer.release(),
        };
        (Release(release) == r).then_some(outcome)
    }

    pub(super) fn cached(&self, r: Release) -> Option<Box<VerifiedBundle>> {
        match self.cached_outcome(r)? {
            BundleOutcome::Current(b) => Some(b),
            BundleOutcome::NeedsNewerAgent { .. } => None,
        }
    }

    /// Says what a poll found when no round is in flight; a round's own report is kept.
    pub(super) fn say(&mut self, now: i64, outcome: Outcome, detail: &str) {
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
        let answer = match self.pool.state() {
            Net::Ok(s) if s.older_pool => self.target_by_follow(s, now),
            other => other,
        };
        let p = &mut self.state.poll;
        p.last_at = now;
        let refused = p.last == "unauthorized";
        match answer {
            Net::Ok(f) => {
                p.last = "ok".into();
                p.backoff_s = 0;
                let every = f.poll_s.unwrap_or(POLL_S).clamp(60, MAX_BACKOFF_S);
                p.next_at = now + jitter(every, now);
                // The pool takes the host's calls again: the report waiting for its hourly
                // retry goes now.
                if refused {
                    self.reported.next_at = self.reported.next_at.min(now);
                }
                self.on_state(f, now, round_now);
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

    /// A host state with no `release` member, a pool from before #344: only a rollback below
    /// the release that brought agent 0.3.0 deploys one again (rollback.yml deploys the
    /// Worker of the tag it goes back to). Its target and the open Update of the host's
    /// registration are then its `follow`'s, as agents before 0.3.0 read them, so the host
    /// follows the rollback (its statement) down; a pool from #344 on is never asked.
    fn target_by_follow(&mut self, mut s: HostState, now: i64) -> Net<HostState> {
        let f = match self.pool.follow(&self.cfg.worker_id) {
            Net::Ok(f) => f,
            Net::NoAnswer(e) => {
                return Net::NoAnswer(format!(
                    "its host state names no release (a pool from before #344) and its follow did not answer: {e}"
                ))
            }
            Net::Unauthorized(c) => return Net::Unauthorized(c),
        };
        if !self.older_pool_said {
            self.older_pool_said = true;
            self.journal.write(
                now,
                "poll",
                serde_json::json!({"detail": format!(
                    "the pool's host state names no release: a pool from before #344 (a rollback below it); its follow names the target ({})",
                    f.latest.map_or_else(|| "none".to_owned(), |r| r.to_string())
                )}),
            );
        }
        s.target = f.latest;
        if s.updates.is_empty() {
            s.updates.extend(f.update);
        }
        s.poll_s = s.poll_s.or(f.poll_s);
        Net::Ok(s)
    }

    /// Whether a round cannot start now: a commit or a revert is finishing (a revert
    /// quarantines again), or the owner's runtime switch is in flight (#325).
    fn busy(&self) -> bool {
        (self.state.rollout.step != Step::Idle && !rollout::preemptible(&self.state.rollout.step))
            || self.state.switch.is_some()
    }

    /// The host state (#344): its Update orders, its settings (#325), its host orders, then
    /// its target.
    fn on_state(&mut self, s: HostState, now: i64, round_now: bool) {
        let mut force: Option<String> =
            round_now.then(|| "a round was asked for (SIGUSR1)".to_owned());
        // An Update order waits while commit or a revert finishes (a revert quarantines
        // again), or the owner's runtime switch: the next poll sees it unconsumed.
        let busy = self.busy();
        // The last Update an agent before 0.3.0 took (`update_seen`) counts as seen.
        if let Some(id) = s
            .updates
            .iter()
            .find(|id| {
                !busy
                    && !self.state.orders.seen(id)
                    && self.state.update_seen.as_deref() != Some(id.as_str())
            })
            .cloned()
        {
            // An Update lifts every quarantine, and the round it gives the release the guard
            // reverted recreates the dispatcher, and again if it reverts: without the room
            // for both on the brake (#325) the Update waits, unconsumed and the quarantine
            // kept, for a poll that has it — so a pool that keeps sending Updates for a
            // release this host reverts gets no more restarts than the brake's.
            let room = if self.state.quarantine.is_empty() {
                Ok(())
            } else {
                self.state
                    .brake
                    .check_room(now, &[Ask::Restart], ROUND_RESTARTS)
            };
            match room {
                Ok(()) => {
                    self.lift_quarantine(&id, now);
                    force = Some(format!("Update order {id}"));
                    self.state.orders.remember(&id);
                    self.state.update_seen = Some(id);
                }
                Err(why) => {
                    if self.said.insert(format!("update:{id}:{why}")) {
                        self.journal.write(
                            now,
                            "update",
                            serde_json::json!({"id": id, "detail": format!("waits, the quarantine kept: {why}")}),
                        );
                    }
                }
            }
        }
        self.restore_settings(s.settings, now);
        self.queue_orders(s.orders);
        let taken = self.take_orders(now, busy);
        self.after_orders(taken, s.target, force, now);
    }

    /// The round the orders taken ask for (`reconcile-now`, `retry-release`), or the one
    /// `force` says why, toward `target`; then their answers, which say what the round is.
    fn after_orders(
        &mut self,
        taken: Taken,
        target: Option<Release>,
        force: Option<String>,
        now: i64,
    ) {
        let mut force = force;
        if let (None, Some((id, kind, _))) = (&force, taken.rounds.first()) {
            force = Some(format!("host order {id} ({kind})"));
        }
        let named = target.is_some();
        self.follow_target(target, force, now);
        for (id, kind, said) in taken.rounds {
            let detail = if self.state.rollout.step != Step::Idle {
                format!(
                    "a round now: {} ({})",
                    self.state.rollout.why,
                    self.state.rollout.step.name()
                )
            } else if !named {
                "the pool names no release for this host: no round".to_owned()
            } else if self.state.round.detail.is_empty() {
                format!(
                    "no round started; the last round says {}",
                    self.state.round.outcome
                )
            } else {
                format!(
                    "no round started; the last round says {}: {}",
                    self.state.round.outcome, self.state.round.detail
                )
            };
            self.answer(&id, kind, "done", &format!("{said}{detail}"), now);
        }
    }

    /// The release the pool names: a round to it, preempting one in flight when it may,
    /// or a round to the release that runs when `force` says why.
    fn follow_target(&mut self, target: Option<Release>, force: Option<String>, now: i64) {
        let Some(target) = target else {
            return;
        };
        self.state.target = Some(target);
        // The owner's soak (#326) counts from the first poll that names a new release.
        self.note_soak(target, now);
        // The owner's runtime switch moves the dispatcher: the pool's target waits for it
        // to end (the next poll names it again).
        if self.state.switch.is_some() {
            return;
        }
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
        // A higher agent the release that runs ships, whose update failed before the
        // swap, is tried again while the pool names that release (#316).
        if in_flight.is_none()
            && self.state.applied == Some(target)
            && self.agent_again(target, now)
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

    /// A new target: its bundle verified, the trust rules, the agent (#316), the tools,
    /// then a round.
    fn go_to(&mut self, target: Release, now: i64, why: &str) {
        let b = match self.fetch(target, now) {
            Fetched::Bundle(b) => b,
            Fetched::NewerAgent(outer, why) => {
                return self.needs_newer_agent(target, &outer, &why, now)
            }
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
                Some(Ok(st)) => {
                    // A statement with `agent_to` moves the agent down first, through the
                    // same steps; the statement is accepted only once the swap is done
                    // (the agent below then applies the release), or with no move.
                    if let Some(down) = st.agent_to().filter(|v| *v < self.version) {
                        let ships = b.manifest().outer().agent();
                        let moved = if ships.version() == down {
                            self.move_agent(target, ships, now)
                        } else {
                            Err(format!(
                                "agent_to {down}, but {target} ships agent {}",
                                ships.version()
                            ))
                        };
                        if let Err(e) = moved {
                            let detail = format!(
                                "the rollback statement to {target} moves the agent down to {down}: {e}; the statement waits"
                            );
                            return self.say(now, Outcome::Held, &detail);
                        }
                    }
                    self.accept(target, &st, now);
                    if self.exit.is_some() {
                        return;
                    }
                    true
                }
                Some(Err(r)) => return self.refuse(now, &r),
                None => return,
            },
            Err(r) => return self.refuse(now, &r),
        };
        // The owner's soak (#326): a new release waits, its verified bundle's revocations
        // learnt meanwhile; a rollback statement skips it.
        let soak = if rollback {
            None
        } else {
            self.soaking(target, now)
        };
        // Only upward (D8): a higher agent first, before the round touches anything. One
        // that cannot be had now leaves this agent to apply the release (its min_agent
        // admits it) and is tried again later. It waits for the soak with its release,
        // unless the manifest sets agent.urgent (a security release).
        let ships = b.manifest().outer().agent().clone();
        if soak.is_none() || ships.urgent() {
            if let Ok(true) = self.upgrade(target, &ships, now) {
                return;
            }
        }
        if let Some(until) = soak {
            let waits =
                (ships.version() > self.version && !ships.urgent()).then(|| ships.version());
            return self.soak_held(target, until, waits, now);
        }
        if let Err(e) = self.ensure_tools(b.manifest(), now) {
            let detail = format!("the pinned tools: {e}");
            return self.say(now, Outcome::EngineUnreachable, &detail);
        }
        match Target::from_bundle(&b, &self.cfg.set_name) {
            Ok(t) => {
                // The brake (#325): another release than the one that runs at most every ten
                // minutes, and within the dispatcher's restarts; a rollback under a signed
                // statement is exempt (the pool cannot forge one), and so is the first
                // release a host applies (nothing ran before it). A round to the release the
                // last change went to (a pull that failed, a quarantine lifted) is that change
                // tried again: no new release change, but it recreates the dispatcher like
                // any, so it needs room for its restarts too — which its replace and its
                // revert's count as they happen (`Rollout::braked`).
                let braked = !rollback && self.state.applied.is_some_and(|a| a != target);
                if braked {
                    let again =
                        self.state.brake.last_release.as_deref() == Some(&target.to_string());
                    let asks: &[Ask] = if again {
                        &[Ask::Restart]
                    } else {
                        &[Ask::Release, Ask::Restart]
                    };
                    if let Err(why) = self.state.brake.check_room(now, asks, ROUND_RESTARTS) {
                        let detail = format!("{target} waits: {why}");
                        return self.say(now, Outcome::Held, &detail);
                    }
                    if !again {
                        self.state.brake.record(now, &[Ask::Release]);
                        self.state.brake.last_release = Some(target.to_string());
                    }
                }
                self.start(now, target, rollback, why);
                self.state.rollout.braked = braked;
                self.pending = Some(t);
            }
            Err(e) => self.say(now, Outcome::Refused, &format!("{target}: {e}")),
        }
    }

    /// A bundle only a higher agent reads: the agent updates itself from its (signed)
    /// outer layer, or says why it cannot.
    fn needs_newer_agent(&mut self, target: Release, outer: &Outer, why: &str, now: i64) {
        if let Err(r) = trust::admit(&self.state, target) {
            return self.refuse(now, &r);
        }
        // The agent it needs waits for the owner's soak with its release (#326), unless the
        // manifest sets agent.urgent.
        if let Some(until) = self
            .soaking(target, now)
            .filter(|_| !outer.agent().urgent())
        {
            let waits = (outer.agent().version() > self.version).then(|| outer.agent().version());
            return self.soak_held(target, until, waits, now);
        }
        let detail = match self.upgrade(target, outer.agent(), now) {
            Ok(true) => return,
            Ok(false) => {
                let v = outer.agent().version();
                if self.state.agent_skip.is_some_and(|s| v <= s) {
                    format!("{target}: {why}; agent {v} was rolled back here and is skipped until a higher one")
                } else {
                    format!("{target}: {why}; it ships agent {v}, not above this one")
                }
            }
            Err(e) => format!(
                "{target}: {why}; the update to agent {}: {e}",
                outer.agent().version()
            ),
        };
        self.say(now, Outcome::NeedsNewerAgent, &detail);
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
        match self.cached_outcome(target) {
            Some(BundleOutcome::Current(b)) => return Fetched::Bundle(b),
            Some(BundleOutcome::NeedsNewerAgent { outer, why, .. }) => {
                return Fetched::NewerAgent(Box::new(outer), why)
            }
            None => {}
        }
        let (name, sig) = bundle_names(target);
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
        let outcome = self.verifier.bundle(&archive, &signature);
        let release = match &outcome {
            Ok(BundleOutcome::Current(b)) => Release(b.manifest().outer().release()),
            Ok(BundleOutcome::NeedsNewerAgent { outer, .. }) => Release(outer.release()),
            Err(r) => {
                self.refuse(
                    now,
                    &Refusal::Verify {
                        reason: r.reason(),
                        detail: r.to_string(),
                    },
                );
                return Fetched::Stop;
            }
        };
        if release != target {
            self.refuse(
                now,
                &Refusal::Verify {
                    reason: "content",
                    detail: format!("asked for {target}, the bundle is {release}"),
                },
            );
            return Fetched::Stop;
        }
        // Kept for the next poll, and for the new agent's self-test and health gate.
        let dir = self.paths.bundles();
        let stored = fs::create_dir_all(&dir)
            .map_err(|e| e.to_string())
            .and_then(|()| state::write_atomic(&dir.join(&name), &archive))
            .and_then(|()| state::write_atomic(&dir.join(&sig), &signature));
        if let Err(e) = stored {
            self.journal
                .write(now, "cache", serde_json::json!({"detail": e}));
        }
        match outcome {
            Ok(BundleOutcome::Current(b)) => Fetched::Bundle(b),
            Ok(BundleOutcome::NeedsNewerAgent { outer, why, .. }) => {
                Fetched::NewerAgent(Box::new(outer), why)
            }
            Err(_) => Fetched::Stop,
        }
    }

    /// A target below the floor: only under a rollback statement rollback.yml signed on
    /// main that covers this host. `None`: no decision now (the pool did not answer).
    fn statement(
        &mut self,
        target: Release,
        b: &VerifiedBundle,
        now: i64,
    ) -> Option<Result<Statement, Refusal>> {
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
            trust::admit_rollback(&self.state, target, st, vs.signer().signed_at(), created)
                .map(|()| st.clone()),
        )
    }

    /// Records an admitted rollback statement: the floor goes to its `to`.
    fn accept(&mut self, target: Release, st: &Statement, now: i64) {
        self.journal.write(
            now,
            "rollback-accepted",
            serde_json::json!({"seq": st.seq(), "to": target.to_string(), "retracts_through": format!("v{}", st.retracts_through()), "run": st.run(), "agent_to": st.agent_to().map(|v| v.to_string())}),
        );
        trust::accept_rollback(&mut self.state, st);
    }

    /// Starts (or preempts) a round, with the env files' values read again so the journal
    /// scrubs a token written since (the owner's Confirm, a rotation).
    fn start(&mut self, now: i64, target: Release, rollback: bool, why: &str) {
        self.journal.set_secrets(env_secrets(&self.cfg.set_dir));
        rollout::start(&mut self.state, &self.journal, now, target, rollback, why);
    }

    /// `etc/dispatcher.env` rendered again when it is time (#371): before the drift check,
    /// so a file that changed starts its round in the same tick.
    fn dispatcher_env(&mut self, now: i64) {
        let Some(h) = self.host_env.as_mut() else {
            return;
        };
        if now < h.next_at {
            return;
        }
        h.next_at = now + ADDRESSES_S;
        if now >= h.public_at {
            // The address the pool's edge saw, asked again in the hour; no answer keeps the
            // one last seen and asks again within minutes.
            if let Net::Ok(ip) = self.pool.public_address() {
                h.public_at = now + PUBLIC_S;
                h.public_retry = ADDRESSES_S;
                if addresses::seen(&self.paths.data) != Some(ip) {
                    let at = crate::capacity::utc(u64::try_from(now).unwrap_or(0));
                    if let Err(e) = addresses::keep_seen(&self.paths.data, ip, &at) {
                        self.journal.write(
                            now,
                            "dispatcher-env",
                            serde_json::json!({"detail": format!("the public address {ip} was not kept: {e}")}),
                        );
                    }
                }
            } else {
                h.public_at = now + h.public_retry;
                h.public_retry = (h.public_retry * 2).min(PUBLIC_RETRY_S);
            }
        }
        let r = rendered(&self.cfg, &self.paths, &h.sources);
        let path = dispatcher_env::path_in(&self.cfg.set_dir);
        match dispatcher_env::refresh(&path, &r) {
            Ok(done) => {
                h.failing = None;
                if done == Refresh::Written {
                    let addresses: Vec<String> =
                        r.addresses.iter().map(ToString::to_string).collect();
                    self.journal.write(
                        now,
                        "dispatcher-env",
                        serde_json::json!({"addresses": addresses, "detail": "etc/dispatcher.env rendered again (the host's addresses or agent.toml changed), its token kept: the next round recreates the dispatcher"}),
                    );
                }
            }
            Err(e) if h.failing.as_ref() != Some(&e) => {
                self.journal.write(
                    now,
                    "dispatcher-env",
                    serde_json::json!({"detail": format!("etc/dispatcher.env was not rendered again: {e}; tried again every minute")}),
                );
                h.failing = Some(e);
            }
            Err(_) => {}
        }
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

    /// The compose project of `last-good/` and its services, when there is one.
    pub(super) fn last_good_project(&self) -> Option<(super::driver::Project, Vec<String>)> {
        let good = self.paths.last_good(&self.cfg.set_name);
        let set = fs::read_to_string(good.join("set.toml"))
            .map_err(|e| e.to_string())
            .and_then(|t| crate::lint::parse_set_toml(&t))
            .ok()?;
        let services = fs::read_to_string(good.join("compose.yml"))
            .ok()
            .and_then(|t| crate::lint::service_names(&t))?;
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
        Some((p, services))
    }

    /// Whether a service of `last-good/` is missing, stopped or differently configured.
    fn drifted(&mut self) -> bool {
        let Some((p, services)) = self.last_good_project() else {
            return false;
        };
        let Some(d) = self.driver.as_deref_mut() else {
            return false;
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
