//! Host orders (#344; design v2 §11.1 M4, M5, §13.4, §17.1, §21.1 step 6): a closed set the
//! pool sends in the host state, each with an id and a `not_after`. P3 has two:
//!
//! - `reconcile-now`: a round now, as an Update order or SIGUSR1 starts one. It waits while
//!   a commit or a revert finishes (the next poll sees it again), lifts no quarantine (an
//!   Update does, and P4's `retry-release`), and never skips the owner's soak (#326,
//!   [`super::soak`]): it only starts a round, which the soak holds like any other.
//! - `retire-legacy`: stop and then remove the legacy compose project `legacy.json`
//!   records, and nothing else — never a project it does not record, never a container
//!   that carries the agent's host label (this host's bundle or one of its tasks), never a
//!   volume, an image or a file of it — and write the `.omarchy-agent` marker into its
//!   directory, so `rollout.sh`, `setup.sh`, the `omarchy-worker` CLI and the updater
//!   refuse there from then on (#313's switch guard). The marker is written first, before
//!   anything stops (the issue and design v2 §13.4 name it with the removal; a decision for
//!   the maintainer to confirm): a directory the agent cannot write refuses the order with
//!   nothing changed, and from the moment the containers stop, nothing of the legacy set
//!   (its own updater above all) can `compose up` them again. Then it runs to its end
//!   across ticks and restarts (`state.json`), each engine call bounded: stop every
//!   container (a grace of [`GRACE_S`], the engine's `docker stop`), remove them, remove
//!   the project's networks, record the retirement in `legacy.json` (only if it still
//!   names that project), and answer. Past [`LIMIT_S`] it answers `failed` with what is
//!   left; the marker stays, so the set's own tools refuse there although it was not
//!   retired, and the order is given again.
//!
//! P4 (#325) adds the rest of the closed set, each inside the envelope the owner wrote at
//! the host (design v2 §12, §17.1):
//!
//! - `set-units <n>` and `set-emulate <archs>`: the host's settings ([`super::settings`]),
//!   narrowed inside the envelope and applied to `run/capacity.json`; a value above the
//!   envelope — more units than it allows, a lane its `emulate` excludes — is refused, with
//!   nothing changed. `null` gives the envelope's own back.
//! - `rotate-token`: a new host worker token from the pool (`POST /hosts/self/token`),
//!   written for the dispatcher where enrollment writes it, the rest of
//!   `etc/dispatcher.env` rendered as the loop's own refresh renders it (#371); the changed
//!   `etc/` recreates the dispatcher with it within the ten minutes the old one still works.
//! - `retry-release`: lifts every quarantine and starts a round, as an Update does — only
//!   with room on the brake for that round's restarts (its own and a revert's).
//! - `diagnostics`: the dispatcher's last [`DIAGNOSTIC_LINES`] log lines, scrubbed of every
//!   secret the agent knows (the set's and the secrets directory's env values, and anything
//!   shaped like a token), posted to the pool for the host's page — only when the envelope
//!   says `diagnostics = true` (M10); refused otherwise.
//!
//! Every order goes through the host-side brake ([`super::brake`]): at least two seconds
//! apart (the agent paces them, a tick at a time), at most twenty an hour, and the limits
//! on dispatcher restarts, release changes and capacity narrowings; beyond them it is
//! answered `refused: brake`.
//!
//! An unknown kind, an order past its `not_after` (or with none), one whose argument this
//! agent cannot read, and an id in the ring of the last 512 taken are refused: an id is
//! taken once, whatever the pool says again, and its first answer stands (a repeated id is
//! said once on the journal, as no answer; the `retire-legacy` in flight, which the pool
//! lists until it is answered, not at all). Every answer goes on the journal and rides the
//! next reports (`orders`), which the pool closes the order with.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::dispatcher_env::{self, Sources};
use crate::install::legacy::{self, Legacy};
use crate::version::Release;

use super::agent::Agent;
use super::brake::{Ask, ROUND_RESTARTS};
use super::config::ARCHES;
use super::driver::{Answer, Foreign};
use super::journal::{env_secrets, env_values};
use super::pool::{Arg, Net, Order, OrderKind};
use super::settings::{self, Base, Settings};
use super::state::{OrderAnswer, Retire, RetireStep};

/// The marker #313's switch guard reads, in the legacy directory.
pub(crate) const MARKER: &str = ".omarchy-agent";
/// How long a legacy container gets between its stop signal and the kill: its set was
/// drained for the 14 days before (design v2 §21.1 steps 4-6), so it holds no task.
pub(crate) const GRACE_S: u64 = 120;
/// A `retire-legacy` not done within this answers `failed`.
pub(crate) const LIMIT_S: i64 = 30 * 60;
/// An answer's words are cut to this many characters.
const DETAIL_MAX: usize = 500;
/// The `diagnostics` order reads this many of the dispatcher's last log lines (M10)...
pub(crate) const DIAGNOSTIC_LINES: u32 = 500;
/// ...each cut to this many characters, and all of them, as the JSON body carries them
/// (quotes and backslashes escaped), to this many bytes: the pool takes 64 KiB with the
/// order and the time around them.
const DIAGNOSTIC_LINE_MAX: usize = 300;
const DIAGNOSTICS_MAX: usize = 56 << 10;
/// What a token looks like after one of these, in a log line (the pool's — its job tokens
/// `omj.<payload>.<sig>` among them, which the dispatcher holds for its leases — and its
/// agent tokens, GitHub's, Anthropic's and `OpenAI`'s keys): replaced whatever the env files
/// say. The pool's own check (worker/src/leak.ts) drops a line that still looks like one.
const TOKEN_PREFIXES: [&str; 11] = [
    "omw_",
    "ome_",
    "omc_",
    "oms_",
    "oma_",
    "omj.",
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
    "sk-",
];
/// A compose project's file, one of which the legacy directory must hold.
const COMPOSE_FILES: [&str; 4] = [
    "compose.yml",
    "compose.yaml",
    "docker-compose.yml",
    "docker-compose.yaml",
];

/// `t` (unix seconds) as the journal and the reports say a time.
pub(crate) fn iso(t: i64) -> String {
    crate::capacity::utc(u64::try_from(t).unwrap_or(0))
}

fn cut(s: &str) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).collect();
    if s.chars().count() <= DETAIL_MAX {
        return s;
    }
    let mut out: String = s.chars().take(DETAIL_MAX - 1).collect();
    out.push('…');
    out
}

/// What a settings order replaces: `None` gives the envelope's own back.
enum Narrow {
    Units(Option<u32>),
    Emulate(Option<Vec<String>>),
}

/// What the orders taken ask of the loop.
#[derive(Debug, Default)]
pub(super) struct Taken {
    /// The orders that ask for a round now — `reconcile-now`, `retry-release` — each
    /// answered once the loop has acted: its id, its kind, and what it did before.
    pub rounds: Vec<(String, &'static str, String)>,
}

/// `text` with anything shaped like a token — one of [`TOKEN_PREFIXES`] and at least 16
/// letters, digits, `_` or `-` (and the dots between a job token's parts) — replaced.
pub(crate) fn scrub_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    'scan: while !rest.is_empty() {
        for p in TOKEN_PREFIXES {
            if let Some(tail) = rest.strip_prefix(p) {
                let dots = p == "omj.";
                let mut n = tail
                    .bytes()
                    .take_while(|b| {
                        b.is_ascii_alphanumeric()
                            || matches!(b, b'_' | b'-')
                            || (dots && *b == b'.')
                    })
                    .count();
                // A sentence's full stop after it is no part of it.
                while dots && n > 0 && tail.as_bytes()[n - 1] == b'.' {
                    n -= 1;
                }
                let word_start = out
                    .chars()
                    .last()
                    .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_');
                if n >= 16 && word_start {
                    out.push_str("[redacted]");
                    rest = &tail[n..];
                    continue 'scan;
                }
            }
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// The legacy directory a `retire-legacy` writes its marker into: the one `legacy.json`
/// records, or else the one directory every container of the project names — absolute,
/// plain, a directory and not a link, holding a compose file.
pub(crate) fn legacy_dir(l: &Legacy, units: &[Foreign]) -> Result<PathBuf, String> {
    let named: BTreeSet<PathBuf> = units
        .iter()
        .filter(|u| u.agent_host.is_empty() && !u.working_dir.is_empty())
        .map(|u| PathBuf::from(&u.working_dir))
        .collect();
    let dir = match (&l.dir, named.len()) {
        (Some(d), 0) => d.clone(),
        (Some(d), _) if named.contains(d) && named.len() == 1 => d.clone(),
        (Some(d), _) => {
            return Err(format!(
                "legacy.json records the directory {}, but its containers name {}",
                d.display(),
                shown(&named)
            ))
        }
        (None, 1) => named.into_iter().next().unwrap_or_default(),
        (None, 0) => {
            return Err(format!(
                "no directory is known for {}: legacy.json records none and no container of it names one",
                l.project
            ))
        }
        (None, _) => {
            return Err(format!(
                "the containers of {} name more than one directory ({})",
                l.project,
                shown(&named)
            ))
        }
    };
    let plain = dir.is_absolute()
        && dir
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)));
    if !plain || dir == Path::new("/") {
        return Err(format!("{} is not a plain absolute path", dir.display()));
    }
    match fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return Err(format!(
                "{}: not a directory (a link is not followed)",
                dir.display()
            ))
        }
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    }
    if !COMPOSE_FILES.iter().any(|f| dir.join(f).is_file()) {
        return Err(format!(
            "{} holds no compose file: it is not the legacy set's directory",
            dir.display()
        ));
    }
    Ok(dir)
}

fn shown(dirs: &BTreeSet<PathBuf>) -> String {
    dirs.iter()
        .map(|d| d.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The marker's lines: the agent, the host and when (what #313's guards print the path of).
pub(crate) fn marker(agent: &str, host: &str, now: i64) -> String {
    format!("agent={agent}\nhost={host}\nsince={}\n", iso(now))
}

impl Agent {
    /// Queues the orders of one host state: the brake paces them, so they are taken from
    /// the queue a tick at a time ([`Agent::take_orders`]).
    pub(super) fn queue_orders(&mut self, orders: Vec<Order>) {
        self.queue = orders.into();
    }

    /// Takes the queued orders, in order: each id once (the ring), an unknown kind, an
    /// order past its `not_after` or one with an argument it cannot read refused at once,
    /// the rest as the brake allows — one at a time, [`super::brake::ORDER_GAP_S`] apart;
    /// what waits stays queued for a later tick. `busy`: a commit, a revert or the owner's
    /// runtime switch is in flight, so a round cannot start now (the next poll sees the
    /// order again).
    pub(super) fn take_orders(&mut self, now: i64, busy: bool) -> Taken {
        let mut taken = Taken::default();
        while let Some(o) = self.queue.front().cloned() {
            // The retire-legacy in flight: the pool keeps it open until the report that
            // answers it, so a poll while its containers stop lists it again. It is being
            // carried out and has no answer yet: nothing to say.
            if self
                .state
                .orders
                .retire
                .as_ref()
                .is_some_and(|r| r.order == o.id)
            {
                self.queue.pop_front();
                continue;
            }
            if self.state.orders.seen(&o.id) {
                // The pool closes an order at the report after its answer; a compromised
                // one could send it again. It is never run twice; said once per process,
                // and with no outcome: that is not an answer, the first one stands.
                if self.repeated.insert(o.id.clone()) {
                    self.journal.write(
                        now,
                        "order",
                        serde_json::json!({"id": o.id, "kind": o.kind.name(), "detail": "seen already: an order id is taken once, and its first answer stands"}),
                    );
                }
                self.queue.pop_front();
                continue;
            }
            let refusal = match (&o.kind, o.not_after) {
                (OrderKind::Unknown(k), _) => Some(format!(
                    "unknown kind {k:?}: agent {} takes retire-legacy, reconcile-now, set-units, set-emulate, rotate-token, retry-release and diagnostics",
                    self.version
                )),
                (_, None) => Some("it carries no not_after the agent can read".to_owned()),
                (_, Some(t)) if t <= now => Some(format!("expired at {}", iso(t))),
                (OrderKind::SetUnits(Arg::Malformed), _) => {
                    Some("its units are not a whole number this agent can read".to_owned())
                }
                (OrderKind::SetEmulate(Arg::Malformed), _) => Some(
                    "its emulate is not a list of architectures this agent can read".to_owned(),
                ),
                _ => None,
            };
            if let Some(why) = refusal {
                self.queue.pop_front();
                self.answer(&o.id, o.kind.name(), "refused", &why, now);
                continue;
            }
            if busy && matches!(o.kind, OrderKind::ReconcileNow | OrderKind::RetryRelease) {
                self.queue.pop_front();
                continue;
            }
            if !self.state.brake.paced(now) {
                break;
            }
            self.queue.pop_front();
            self.state.brake.considered(now);
            let mut asks = vec![Ask::Order];
            asks.extend(match o.kind {
                OrderKind::SetUnits(_) | OrderKind::SetEmulate(_) => {
                    &[Ask::Narrowing, Ask::Restart][..]
                }
                // retry-release's round meets the brake again where every round does, and
                // its replace and its revert's count there as they happen.
                OrderKind::RotateToken | OrderKind::RetryRelease => &[Ask::Restart][..],
                _ => &[][..],
            });
            // One that would lift a quarantine gives that release a round, which needs room
            // for its revert too: refused without it, the quarantine kept.
            let restarts = if o.kind == OrderKind::RetryRelease && !self.state.quarantine.is_empty()
            {
                ROUND_RESTARTS
            } else {
                1
            };
            if let Err(why) = self.state.brake.check_room(now, &asks, restarts) {
                self.answer(&o.id, o.kind.name(), "refused", &why, now);
                continue;
            }
            self.state.brake.record(now, &[Ask::Order]);
            self.take(o, now, &mut taken);
        }
        taken
    }

    /// Carries out one order the brake let through.
    fn take(&mut self, o: Order, now: i64, taken: &mut Taken) {
        let kind = o.kind.name().to_owned();
        let done = match o.kind {
            OrderKind::ReconcileNow => {
                self.state.orders.remember(&o.id);
                taken.rounds.push((o.id, "reconcile-now", String::new()));
                return;
            }
            OrderKind::RetireLegacy => match self.begin_retire(&o.id, now) {
                // Answered at its end.
                Ok(()) => {
                    self.state.orders.remember(&o.id);
                    return;
                }
                Err(why) => Err(why),
            },
            OrderKind::RetryRelease => {
                self.state.orders.remember(&o.id);
                // The round to the release the guard reverted counts its recreations of the
                // dispatcher as they happen (`Rollout::braked`); the release change itself
                // was counted when it was first tried, and the round to it again is no new one.
                let lifted = self.lift_quarantine(&o.id, now);
                let said = if lifted.is_empty() {
                    "no release was quarantined here; ".to_owned()
                } else {
                    format!("lifted the quarantine of {}; ", lifted.join(", "))
                };
                taken.rounds.push((o.id, "retry-release", said));
                return;
            }
            OrderKind::SetUnits(Arg::Set(n)) => self.narrow_to(&Narrow::Units(Some(n)), now),
            OrderKind::SetUnits(_) => self.narrow_to(&Narrow::Units(None), now),
            OrderKind::SetEmulate(Arg::Set(a)) => self.narrow_to(&Narrow::Emulate(Some(a)), now),
            OrderKind::SetEmulate(_) => self.narrow_to(&Narrow::Emulate(None), now),
            OrderKind::RotateToken => self.rotate_token(now),
            OrderKind::Diagnostics => self.diagnostics(&o.id, now),
            OrderKind::Unknown(_) => return,
        };
        match done {
            Ok(detail) => self.answer(&o.id, &kind, "done", &detail, now),
            Err(why) => self.answer(&o.id, &kind, "refused", &why, now),
        }
    }

    /// Lifts every quarantine (an Update's or a `retry-release`'s, `by`): the releases it
    /// held.
    pub(super) fn lift_quarantine(&mut self, by: &str, now: i64) -> Vec<String> {
        let lifted: Vec<String> = self
            .state
            .quarantine
            .keys()
            .map(Release::to_string)
            .collect();
        if !lifted.is_empty() {
            self.journal.write(
                now,
                "quarantine-lifted",
                serde_json::json!({"by": by, "releases": lifted}),
            );
        }
        self.state.quarantine.clear();
        lifted
    }

    /// A settings order: `units` or `emulate` replaced (`None`: the envelope's own), checked
    /// against the envelope, then applied to `run/capacity.json`.
    fn narrow_to(&mut self, n: &Narrow, now: i64) -> Result<String, String> {
        let p = self.cfg.policy.clone();
        let base = Base::read(&self.cfg.set_dir)?;
        let old = self.state.settings.clone().unwrap_or_default();
        let mut new = old.clone();
        match n {
            Narrow::Units(u) => {
                settings::check_units(*u, base.as_ref(), &p)?;
                new.units = *u;
            }
            Narrow::Emulate(e) => {
                let native = base
                    .as_ref()
                    .map_or_else(|| std::env::consts::ARCH.to_owned(), Base::native);
                new.emulate = settings::check_emulate(e.as_deref(), &native, &p)?;
            }
        }
        let before = base.as_ref().map(|b| b.narrowed(&old, &p).1);
        let Some((changed, after)) = settings::apply(&self.cfg.set_dir, &new, &p)? else {
            return Err("run/capacity.json is missing (capacity detection, #333): there is nothing to narrow".into());
        };
        self.state.settings = Some(new);
        if changed {
            self.state
                .brake
                .record(now, &[Ask::Narrowing, Ask::Restart]);
        }
        let shown = |u: Option<u32>| u.map_or_else(|| "?".to_owned(), |u| u.to_string());
        let lanes = |e: &[String]| {
            if e.is_empty() {
                "none".to_owned()
            } else {
                e.join(", ")
            }
        };
        let said = match n {
            Narrow::Units(_) => format!(
                "units {} → {} (its envelope gives {})",
                shown(before.as_ref().and_then(|b| b.units)),
                shown(after.units),
                shown(after.ceiling)
            ),
            Narrow::Emulate(_) => format!(
                "emulated lanes {} → {}",
                before
                    .as_ref()
                    .map_or_else(|| "?".to_owned(), |b| lanes(&b.emulated)),
                lanes(&after.emulated)
            ),
        };
        let tail = if changed {
            "; the dispatcher is recreated with it and claims by it from its next claim, and running tasks above it finish"
        } else {
            "; nothing changed on the host"
        };
        Ok(format!("{said}{tail}"))
    }

    /// `rotate-token`: a new host worker token, written where enrollment writes it; the
    /// changed `etc/` recreates the dispatcher with it at the next tick.
    fn rotate_token(&mut self, now: i64) -> Result<String, String> {
        let a = match self.pool.token() {
            Net::Ok(a) => a,
            Net::NoAnswer(e) => {
                return Err(format!(
                    "the pool gave no token ({e}); the one the dispatcher holds stays"
                ))
            }
            Net::Unauthorized(s) => {
                return Err(format!(
                    "the pool answered {s}; the one the dispatcher holds stays"
                ))
            }
        };
        let named = a["worker"].as_str().unwrap_or("?").to_owned();
        if named != self.cfg.worker_id {
            return Err(format!(
                "the pool's answer names registration {}, not this host's {}: nothing was written (the old token keeps working for ten minutes only: rotate again)",
                cut(&named),
                self.cfg.worker_id
            ));
        }
        // Where enrollment writes it, the rest of the file rendered as the loop's own
        // refresh renders it (#371): the host's addresses, the secrets directory, the agent
        // budget and the owner's lines stay. The seam #327's token file moves.
        let sources = self
            .host_env
            .as_ref()
            .map_or_else(Sources::system, |h| h.sources.clone());
        let r = super::agent::rendered(&self.cfg, &self.paths, &sources);
        let env = dispatcher_env::path_in(&self.cfg.set_dir);
        crate::enroll::write_worker_token(&env, &a, &r).map_err(|e| {
            format!("{e} (the old token keeps working for ten minutes only: rotate again)")
        })?;
        self.journal.set_secrets(env_secrets(&self.cfg.set_dir));
        self.state.brake.record(now, &[Ask::Restart]);
        Ok(format!(
            "a new host worker token is in etc/dispatcher.env (next rotation after {}); the dispatcher is recreated with it at once, and the one it replaces works ten more minutes",
            cut(a["rotate_after"].as_str().unwrap_or("?"))
        ))
    }

    /// `diagnostics` (M10): only if the envelope allows it, the dispatcher's last log
    /// lines, scrubbed, posted for the host's page.
    fn diagnostics(&mut self, order: &str, now: i64) -> Result<String, String> {
        if !self.cfg.policy.diagnostics {
            return Err("its envelope does not allow diagnostics (diagnostics = false in agent.toml): only its owner allows them, at the host".into());
        }
        let (p, services) = self
            .last_good_project()
            .ok_or("no release runs here: there is no dispatcher to read")?;
        let d = self
            .driver
            .as_deref_mut()
            .ok_or("the pinned engine tools are not installed yet")?;
        let units = match d.observe(&p, &services) {
            Answer::Yes(u) => u,
            Answer::NotFound => Vec::new(),
            Answer::NoAnswer(e) => return Err(format!("the engine did not answer ({e})")),
        };
        let unit = services
            .first()
            .and_then(|s| units.iter().find(|u| &u.service == s))
            .ok_or("the dispatcher has no container to read")?;
        let text = match d.logs(&unit.id, DIAGNOSTIC_LINES) {
            Answer::Yes(t) => t,
            Answer::NotFound => return Err("the dispatcher's container went away".into()),
            Answer::NoAnswer(e) => return Err(format!("the engine did not answer ({e})")),
        };
        let mut secrets = env_secrets(&self.cfg.set_dir);
        secrets.extend(env_values(&self.cfg.secrets_dir));
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        let mut lines: Vec<String> = text
            .lines()
            .map(|l| {
                let mut l: String = l.chars().filter(|c| !c.is_control()).collect();
                for s in &secrets {
                    l = l.replace(s.as_str(), "[redacted]");
                }
                let l = scrub_tokens(&l);
                if l.chars().count() > DIAGNOSTIC_LINE_MAX {
                    let mut c: String = l.chars().take(DIAGNOSTIC_LINE_MAX - 1).collect();
                    c.push('…');
                    c
                } else {
                    l
                }
            })
            .collect();
        // The newest lines, within the size the pool takes: each as the body carries it,
        // escaped and quoted, with its comma.
        let mut size = 0;
        let keep = lines
            .iter()
            .rev()
            .take_while(|l| {
                size += serde_json::to_string(l).map_or(l.len() * 6, |j| j.len()) + 1;
                size <= DIAGNOSTICS_MAX
            })
            .count();
        lines.drain(..lines.len() - keep);
        let body = serde_json::json!({"order": order, "at": iso(now), "lines": lines});
        let n = lines.len();
        match self.pool.diagnostics(body.to_string().as_bytes()) {
            Net::Ok(()) => Ok(format!(
                "{n} line(s) of the dispatcher's log, scrubbed of the host's secrets, are on the host's page"
            )),
            Net::NoAnswer(e) => Err(format!("the pool did not take the {n} line(s): {e}")),
            Net::Unauthorized(s) => Err(format!("the pool answered {s} to the {n} line(s)")),
        }
    }

    /// The settings the pool keeps for this host, taken when the agent has none of its own
    /// (a `state.json` lost), through the brake. It is a record, not an order: kept as the
    /// pool says it — but for what names no setting (no units, the native lane, no
    /// architecture) — and never refused; the envelope narrows it as it narrows every
    /// setting, at every tick, and what of it is above the envelope is journaled here and
    /// reported (`settings.above`) for the host page, as a pool that should not have sent
    /// it.
    pub(super) fn restore_settings(&mut self, pool: Option<Settings>, now: i64) {
        let Some(s) = pool.filter(|_| self.state.settings.is_none()) else {
            return;
        };
        let p = self.cfg.policy.clone();
        let base = Base::read(&self.cfg.set_dir).ok().flatten();
        let native = base
            .as_ref()
            .map_or_else(|| std::env::consts::ARCH.to_owned(), Base::native);
        let want = Settings {
            units: s.units.map(|u| u.max(1)),
            emulate: s.emulate.map(|e| {
                let mut e: Vec<String> = e
                    .into_iter()
                    .filter(|a| a != &native && ARCHES.contains(&a.as_str()))
                    .collect();
                e.sort();
                e.dedup();
                e
            }),
        };
        if let Err(why) = self.state.brake.check(now, &[Ask::Narrowing, Ask::Restart]) {
            if self.said.insert(format!("restore:{why}")) {
                self.journal.write(
                    now,
                    "settings",
                    serde_json::json!({"detail": format!("the pool's record of this host's settings waits: {why}")}),
                );
            }
            return;
        }
        match settings::apply(&self.cfg.set_dir, &want, &p) {
            Ok(applied) => {
                if applied.as_ref().is_some_and(|(changed, _)| *changed) {
                    self.state
                        .brake
                        .record(now, &[Ask::Narrowing, Ask::Restart]);
                }
                let above = applied.map(|(_, e)| e.above).unwrap_or_default();
                let detail = if above.is_empty() {
                    "taken from the pool's record (this host had none of its own)".to_owned()
                } else {
                    format!(
                        "taken from the pool's record (this host had none of its own); above the envelope, which leaves it out: {}",
                        above.join("; ")
                    )
                };
                self.journal.write(
                    now,
                    "settings",
                    serde_json::json!({"detail": detail, "units": want.units, "emulate": want.emulate, "above": above}),
                );
                self.state.settings = Some(want);
            }
            Err(e) => {
                if self.said.insert(format!("restore:{e}")) {
                    self.journal
                        .write(now, "settings", serde_json::json!({"detail": e}));
                }
            }
        }
    }

    /// Keeps `run/capacity.json` as the settings and the envelope say, every tick: after a
    /// detection rewrote it, or once the owner narrowed the envelope.
    pub(super) fn narrow(&mut self, now: i64) {
        let s = self.state.settings.clone().unwrap_or_default();
        if let Err(e) = settings::apply(&self.cfg.set_dir, &s, &self.cfg.policy) {
            if self.said.insert(format!("narrow:{e}")) {
                self.journal.write(
                    now,
                    "settings",
                    serde_json::json!({"detail": format!("run/capacity.json was not narrowed: {e}")}),
                );
            }
        }
    }

    /// Answers order `id`: remembered, journaled, kept for the reports.
    pub(super) fn answer(&mut self, id: &str, kind: &str, outcome: &str, detail: &str, now: i64) {
        let detail = cut(&self.journal.scrub(detail));
        self.state.orders.remember(id);
        self.journal.write(
            now,
            "order",
            serde_json::json!({"id": id, "kind": kind, "outcome": outcome, "detail": detail}),
        );
        self.state.orders.answer(OrderAnswer {
            id: id.to_owned(),
            kind: kind.to_owned(),
            outcome: outcome.to_owned(),
            detail,
            at: now,
        });
    }

    /// The compose projects that are this host's own, which no order ever retires.
    fn own_projects(&self) -> Vec<String> {
        let mut own = vec![crate::install::envelope::PROJECT.to_owned()];
        own.extend(self.cfg.project.clone());
        own.extend(self.last_good_project().map(|(p, _)| p.name));
        own
    }

    /// Takes a `retire-legacy`: the record read, the project's directory found and the
    /// marker written — or why not, with nothing changed.
    fn begin_retire(&mut self, order: &str, now: i64) -> Result<(), String> {
        if let Some(r) = &self.state.orders.retire {
            return Err(format!(
                "a retire-legacy is in flight already (order {}, {})",
                r.order, r.project
            ));
        }
        let l = legacy::recorded(&self.paths.data)?.ok_or(
            "no legacy project is recorded on this host (legacy.json, install --legacy): there is nothing to retire",
        )?;
        if let Some(at) = &l.retired_at {
            return Err(format!("{} was retired already, at {at}", l.project));
        }
        if !legacy::valid_project(&l.project) {
            return Err(format!(
                "legacy.json names {:?}, which is not a compose project name",
                l.project
            ));
        }
        if self.own_projects().contains(&l.project) {
            return Err(format!(
                "legacy.json names {}, this host's own bundle: never retired",
                l.project
            ));
        }
        let d = self
            .driver
            .as_deref_mut()
            .ok_or("the pinned engine tools are not installed yet; nothing changed")?;
        let units = match d.project_containers(&l.project) {
            Answer::Yes(u) => u,
            Answer::NotFound => Vec::new(),
            Answer::NoAnswer(e) => {
                return Err(format!("the engine did not answer ({e}); nothing changed"))
            }
        };
        let dir = legacy_dir(&l, &units).map_err(|e| format!("{e}; nothing changed"))?;
        let body = marker(&self.version.to_string(), &self.cfg.host_id, now);
        crate::install::files::write(&dir, MARKER, body.as_bytes(), 0o644).map_err(|e| {
            format!("the marker could not be written ({e}): the directory must be the agent user's own and writable by it alone; nothing changed")
        })?;
        let n = units.iter().filter(|u| u.agent_host.is_empty()).count();
        self.journal.write(
            now,
            "retire-legacy",
            serde_json::json!({"order": order, "project": l.project, "dir": dir, "containers": n, "step": "marker written; stopping"}),
        );
        self.state.orders.retire = Some(Retire {
            order: order.to_owned(),
            project: l.project,
            dir,
            since: now,
            step: RetireStep::Stop,
        });
        Ok(())
    }

    /// One step of the `retire-legacy` in flight, if any: every call bounded; an engine
    /// that does not answer leaves the step for the next tick.
    pub(super) fn retire_step(&mut self, now: i64) {
        let Some(r) = self.state.orders.retire.clone() else {
            return;
        };
        if now - r.since > LIMIT_S {
            return self.end_retire(
                &r,
                "failed",
                &format!(
                    "not finished within {} min at the {} step; the marker stays in {}, so rollout.sh, setup.sh, omarchy-worker and the updater refuse there although the set was not retired: give the order again",
                    LIMIT_S / 60,
                    if r.step == RetireStep::Stop { "stop" } else { "remove" },
                    r.dir.display()
                ),
                now,
            );
        }
        let Some(d) = self.driver.as_deref_mut() else {
            return;
        };
        // Never a container that carries the agent's host label, whatever project it names.
        let units: Vec<Foreign> = match d.project_containers(&r.project) {
            Answer::Yes(u) => u.into_iter().filter(|u| u.agent_host.is_empty()).collect(),
            Answer::NotFound => Vec::new(),
            Answer::NoAnswer(_) => return,
        };
        match r.step {
            RetireStep::Stop => {
                let mut stopped = true;
                for u in units.iter().filter(|u| !u.stopped()) {
                    stopped = false;
                    if let Answer::NoAnswer(_) = d.begin_drain(&u.unit(), GRACE_S) {
                        return;
                    }
                }
                if stopped {
                    self.journal.write(
                        now,
                        "retire-legacy",
                        serde_json::json!({"order": r.order, "project": r.project, "step": "stopped; removing", "containers": units.len()}),
                    );
                    if let Some(x) = self.state.orders.retire.as_mut() {
                        x.step = RetireStep::Remove;
                    }
                }
            }
            RetireStep::Remove => {
                for u in &units {
                    if let Answer::NoAnswer(_) = d.remove(&u.unit(), true) {
                        return;
                    }
                }
                let networks = match d.project_networks(&r.project) {
                    Answer::Yes(n) => n,
                    Answer::NotFound => Vec::new(),
                    Answer::NoAnswer(_) => return,
                };
                let mut left = Vec::new();
                for n in &networks {
                    if let Answer::NoAnswer(e) = d.remove_network(n) {
                        let e: String = e.chars().take(120).collect();
                        left.push(format!("{} ({e})", &n[..n.len().min(12)]));
                    }
                }
                let mut detail = format!(
                    "stopped and removed {} container(s) and {} network(s) of compose project {}",
                    units.len(),
                    networks.len() - left.len(),
                    r.project,
                );
                if !left.is_empty() {
                    let _ = write!(detail, "; networks left: {}", left.join("; "));
                }
                let _ = write!(
                    detail,
                    "; the marker is in {}: rollout.sh, setup.sh, omarchy-worker and the updater refuse there",
                    r.dir.join(MARKER).display()
                );
                // Only the record of the project this order retired: an install --legacy
                // meanwhile may have recorded another, which stays retirable.
                let recorded = legacy::recorded(&self.paths.data)
                    .and_then(|l| l.ok_or_else(|| "legacy.json is gone".to_owned()))
                    .and_then(|l| {
                        if l.project == r.project {
                            Ok(l)
                        } else {
                            Err(format!("it names {} now, not {}", l.project, r.project))
                        }
                    })
                    .and_then(|mut l| {
                        l.retired_at = Some(iso(now));
                        l.retired_by = Some(r.order.clone());
                        if l.dir.is_none() {
                            l.dir = Some(r.dir.clone());
                        }
                        legacy::record(&self.paths.data, &l)
                    });
                if let Err(e) = recorded {
                    let _ = write!(detail, "; legacy.json was not updated: {e}");
                }
                self.end_retire(&r, "done", &detail, now);
            }
        }
    }

    fn end_retire(&mut self, r: &Retire, outcome: &str, detail: &str, now: i64) {
        self.state.orders.retire = None;
        self.legacy_seen = None;
        self.answer(&r.order, "retire-legacy", outcome, detail, now);
    }

    /// The legacy set as the report says it (design v2 §17.2 `legacy`): the record, and
    /// the engine's view of it read again at most every 5 minutes. `None`: none recorded.
    pub(super) fn legacy_view(&mut self, now: i64) -> Option<serde_json::Value> {
        let l = legacy::recorded(&self.paths.data).ok().flatten()?;
        if let Some(at) = &l.retired_at {
            return Some(serde_json::json!({
                "project": l.project, "state": "retired", "since": at, "dir": l.dir, "order": l.retired_by,
            }));
        }
        if let Some(r) = &self.state.orders.retire {
            return Some(serde_json::json!({
                "project": r.project, "state": "retiring", "since": iso(r.since), "dir": r.dir, "order": r.order,
                "step": if r.step == RetireStep::Stop { "stop" } else { "remove" },
            }));
        }
        let fresh = self
            .legacy_seen
            .as_ref()
            .is_some_and(|(at, _)| now - at < super::report::EVERY_S);
        if !fresh {
            let seen =
                self.driver
                    .as_deref_mut()
                    .and_then(|d| match d.project_containers(&l.project) {
                        Answer::Yes(u) => Some(u),
                        Answer::NotFound => Some(Vec::new()),
                        Answer::NoAnswer(_) => None,
                    });
            let view = match seen {
                Some(units) => {
                    let units: Vec<Foreign> = units
                        .into_iter()
                        .filter(|u| u.agent_host.is_empty())
                        .collect();
                    let running = units.iter().filter(|u| u.running()).count();
                    let state = if running > 0 {
                        "running"
                    } else if units.is_empty() {
                        "gone"
                    } else {
                        "stopped"
                    };
                    // What a retire-legacy would be refused for, before anyone asks:
                    // no directory, or one the agent may not write its marker into.
                    let dir = legacy_dir(&l, &units).and_then(|d| {
                        crate::install::files::owned_dir(&d)
                            .map(|_| d)
                            .map_err(|e| format!("the marker cannot be written: {e}"))
                    });
                    serde_json::json!({
                        "project": l.project, "state": state, "since": l.recorded_at,
                        "containers": units.len(), "running": running,
                        "dir": dir.as_ref().ok().or(l.dir.as_ref()),
                        "blocked": dir.err(),
                    })
                }
                None => serde_json::json!({
                    "project": l.project, "state": "unknown", "since": l.recorded_at, "dir": l.dir,
                }),
            };
            self.legacy_seen = Some((now, view));
        }
        self.legacy_seen.as_ref().map(|(_, v)| v.clone())
    }
}

#[cfg(test)]
#[path = "orders_tests.rs"]
pub(crate) mod tests;
