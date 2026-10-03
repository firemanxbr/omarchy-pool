//! Host orders (#344; design v2 §11.1 M4, M5, §13.4, §17.1, §21.1 step 6): a closed set the
//! pool sends in the host state, each with an id and a `not_after`. P3 has two:
//!
//! - `reconcile-now`: a round now, as an Update order or SIGUSR1 starts one. It waits while
//!   a commit or a revert finishes (the next poll sees it again), lifts no quarantine (an
//!   Update does; P4's `retry-release` will), and never skips the owner's soak once P4
//!   gives the host one: it only starts a round, which the soak holds like any other.
//! - `retire-legacy`: stop and then remove the legacy compose project `legacy.json`
//!   records, and nothing else — never a project it does not record, never a container
//!   that carries the agent's host label (this host's bundle or one of its tasks), never a
//!   volume, an image or a file of it — and write the `.omarchy-agent` marker into its
//!   directory, so `rollout.sh`, `setup.sh`, the `omarchy-worker` CLI and the updater
//!   refuse there from then on (#313's switch guard). The marker is written first: a
//!   directory the agent cannot write refuses the order with nothing changed, and from the
//!   moment the containers stop, nothing of the legacy set can bring them back. Then it
//!   runs to its end across ticks and restarts (`state.json`), each engine call bounded:
//!   stop every container (a grace of [`GRACE_S`], the engine's `docker stop`), remove
//!   them, remove the project's networks, record the retirement in `legacy.json`, and
//!   answer. Past [`LIMIT_S`] it answers `failed` with what is left; the marker stays.
//!
//! An unknown kind, an order past its `not_after` (or with none) and an id in the ring of
//! the last 512 taken are refused: an id is taken once, whatever the pool says again, and
//! its first answer stands. Every answer goes on the journal and rides the next reports
//! (`orders`), which the pool closes the order with.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::install::legacy::{self, Legacy};

use super::agent::Agent;
use super::driver::{Answer, Foreign};
use super::pool::{Order, OrderKind};
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

/// What the orders of one host state ask of its poll.
#[derive(Debug, Default)]
pub(super) struct Taken {
    /// The `reconcile-now` orders taken: a round now, answered once the poll has acted.
    pub reconcile: Vec<String>,
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
    /// Takes the orders of one host state, in order: each id once (the ring), an unknown
    /// kind or an order past its `not_after` refused, the rest carried out. `busy`: a
    /// commit or a revert is finishing, so a round cannot start now.
    pub(super) fn take_orders(&mut self, orders: Vec<Order>, now: i64, busy: bool) -> Taken {
        let mut taken = Taken::default();
        for o in orders {
            if self.state.orders.seen(&o.id) {
                // The pool closes an order at the report after its answer; a compromised
                // one could send it again. It is never run twice; said once per process.
                if self.repeated.insert(o.id.clone()) {
                    self.journal.write(
                        now,
                        "order",
                        serde_json::json!({"id": o.id, "kind": o.kind.name(), "outcome": "refused", "detail": "seen already: an order id is taken once, and its first answer stands"}),
                    );
                }
                continue;
            }
            let refusal = match (&o.kind, o.not_after) {
                (OrderKind::Unknown(k), _) => Some(format!(
                    "unknown kind {k:?}: agent {} takes retire-legacy and reconcile-now",
                    self.version
                )),
                (_, None) => Some("it carries no not_after the agent can read".to_owned()),
                (_, Some(t)) if t <= now => Some(format!("expired at {}", iso(t))),
                _ => None,
            };
            if let Some(why) = refusal {
                self.answer(&o.id, o.kind.name(), "refused", &why, now);
                continue;
            }
            match o.kind {
                OrderKind::ReconcileNow if busy => {}
                OrderKind::ReconcileNow => {
                    self.state.orders.remember(&o.id);
                    taken.reconcile.push(o.id);
                }
                OrderKind::RetireLegacy => match self.begin_retire(&o.id, now) {
                    // Answered at its end.
                    Ok(()) => self.state.orders.remember(&o.id),
                    Err(why) => self.answer(&o.id, "retire-legacy", "refused", &why, now),
                },
                OrderKind::Unknown(_) => {}
            }
        }
        taken
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
                    "not finished within {} min at the {} step; the marker stays in {}, and the order can be given again",
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
                let recorded = legacy::recorded(&self.paths.data)
                    .and_then(|l| l.ok_or_else(|| "legacy.json is gone".to_owned()))
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
                "project": l.project, "state": "retiring", "since": iso(r.since), "dir": r.dir, "order": r.order,
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
mod tests;
