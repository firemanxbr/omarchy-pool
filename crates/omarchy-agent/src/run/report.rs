//! The host report (design v2 §17.2; #344's part of it): `POST /api/v1/hosts/self/report`,
//! signed with the host key, on every change and at least every [`EVERY_S`]. It carries
//! what the agent knows of itself — its version, the release applied, targeted and its
//! floor, the rollout and the last round, the legacy set (`legacy`), and the answers to
//! the last host orders (`orders`), which the pool closes the orders with. P4 (#325) adds
//! `capacity` (`run/capacity.json` as the dispatcher reads it, narrowed), `settings` (what
//! the pool narrowed, the envelope it narrows inside and what applies: the host page's
//! controls), `brake` (how much of each limit the last window spent) and `runtime` (the
//! driver, and the owner's switch in flight or its last end). It also says whether the Mac
//! sleeps (`asleep`, #329; `false` on every other host), which the pool counts as zero free
//! units. Bundle and task fields stay with the issues that read them.
//!
//! A Mac about to sleep reports at once ([`Agent::report_now`]), whatever the spacing or a
//! retry's wait: the sleep waits for it.
//!
//! A report that does not get through changes nothing and is tried again a minute later —
//! an hour later when the pool refuses the host's calls (401/403: suspended, retired, a
//! clock off by more than two minutes), as the polls go hourly then (design v2 §16.4), and
//! at once when a poll gets through again; the pool keeps the last one it got. Every word
//! in it went through the journal's scrub (the env files' values), and the pool refuses
//! whole a report that looks like it carries a secret.

use super::agent::Agent;
use super::orders::iso;
use super::pool::Net;

/// A report at least this often, and the legacy set looked at again this often.
pub(crate) const EVERY_S: i64 = 300;
/// Never two reports closer than this (a round's steps follow each other in seconds).
const SPACING_S: i64 = 10;
/// After a report that did not get through.
const RETRY_S: i64 = 60;
/// A round's detail in the report is cut to this many characters (the report's 16 KiB).
const ROUND_DETAIL_MAX: usize = 1000;
/// The runtime switch's words, so `runtime` stays within the 2 KiB the pool keeps whole.
const RUNTIME_WORDS_MAX: usize = 400;

/// When the report was last sent, what it said, and when one is due again.
#[derive(Debug, Default)]
pub(crate) struct Reported {
    pub body: Option<String>,
    pub at: i64,
    pub next_at: i64,
}

impl Agent {
    /// The report as it would be posted now.
    pub(super) fn report_body(&mut self, now: i64) -> serde_json::Value {
        let s = &self.state;
        let r = |v: Option<crate::version::Release>| v.map(|r| r.to_string());
        let round = &s.round;
        let detail: String = round.detail.chars().take(ROUND_DETAIL_MAX).collect();
        let mut body = serde_json::json!({
            "agent": {"version": self.version.to_string(), "skip": s.agent_skip.map(|v| v.to_string())},
            "release": {"applied": r(s.applied), "target": r(s.target), "floor": r(s.floor), "min_release": r(s.min_release)},
            "rollout": {"state": s.rollout.step.name(), "since": iso(s.rollout.since), "target": r(s.rollout.target)},
            "round": if round.outcome.is_empty() { serde_json::Value::Null } else { serde_json::json!({
                "at": iso(round.at), "outcome": round.outcome, "from": r(round.from), "step": round.step, "detail": detail,
            }) },
            "quarantine": s.quarantine.iter().map(|(rel, q)| serde_json::json!({"release": rel.to_string(), "until": q.until.map(iso)})).collect::<Vec<_>>(),
            "orders": s.orders.answers.iter().map(|a| serde_json::json!({
                "id": a.id, "kind": a.kind, "outcome": a.outcome, "detail": a.detail, "at": iso(a.at),
            })).collect::<Vec<_>>(),
        });
        body["legacy"] = self.legacy_view(now).unwrap_or(serde_json::Value::Null);
        body["settings"] = super::settings::view(
            self.state.settings.as_ref(),
            &self.cfg.set_dir,
            &self.cfg.policy,
        );
        body["brake"] = self.state.brake.view(now);
        // Only a whole one: a pool refuses the report (and the answers it carries) whose
        // capacity it cannot read, `null` too before #325.
        if let Some(c) = self.capacity_view() {
            body["capacity"] = c;
        }
        // The pool keeps `runtime` whole only within 2 KiB: the words are cut to fit.
        let short = |t: &str| -> String { t.chars().take(RUNTIME_WORDS_MAX).collect() };
        body["runtime"] = serde_json::json!({
            // `null` until the engine said which it is (agent.toml without `set.runtime`).
            "driver": self.cfg.runtime.map(super::config::Runtime::driver),
            "switch": self.state.switch.as_ref().map(|w| serde_json::json!({
                "to": format!("compose/{}", w.to.runtime), "since": iso(w.started), "step": w.step,
                "why": w.why.as_deref().map(short),
            })),
            "switch_last": self.state.switch_last.as_ref().map(|e| serde_json::json!({
                "to": e.to, "outcome": e.outcome, "detail": short(&e.detail), "at": iso(e.at),
            })),
        });
        body["asleep"] = self
            .power
            .as_ref()
            .is_some_and(super::power::Sleep::asleep)
            .into();
        body
    }

    /// `run/capacity.json` as the dispatcher reads it, for the pool's units and the host
    /// page; only one whole as the pool takes one (its totals, its free disk, one to four
    /// lanes with exactly one native, of this machine's architecture) — the pool refuses a
    /// report whose capacity it cannot read, and the answers it carries with it.
    fn capacity_view(&self) -> Option<serde_json::Value> {
        use serde_json::Value;
        let Ok(Some(_)) = super::settings::Base::read(&self.cfg.set_dir) else {
            return None;
        };
        let mut c = std::fs::read(self.cfg.set_dir.join("run/capacity.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())?;
        let lanes = c["lanes"].as_array().cloned().unwrap_or_default();
        let natives: Vec<&Value> = lanes.iter().filter(|l| l["mode"] == "native").collect();
        let whole = c["cpus"].as_u64().is_some_and(|n| (1..=4096).contains(&n))
            && c["mem_gb"].is_number()
            && c["disk_free_gb"]["work"].is_number()
            && c["disk_free_gb"]["engine"].is_number()
            && (1..=4).contains(&lanes.len())
            && lanes.iter().all(|l| {
                super::config::ARCHES.contains(&l["arch"].as_str().unwrap_or(""))
                    && (l["mode"] == "native" || l["mode"] == "emulated")
            })
            && natives.len() == 1
            && natives[0]["arch"] == std::env::consts::ARCH;
        if !whole {
            return None;
        }
        // The narrowing's own record stays on the host.
        if let Some(o) = c.as_object_mut() {
            o.remove("detected");
            o.remove("settings");
        }
        Some(c)
    }

    /// Posts the report when something changed or one is due.
    pub(super) fn report(&mut self, now: i64) {
        self.post_report(now, false);
    }

    /// Posts the report now: the Mac goes to sleep, and waits for it (#329).
    pub(super) fn report_now(&mut self, now: i64) {
        self.post_report(now, true);
    }

    fn post_report(&mut self, now: i64, at_once: bool) {
        if !at_once && now < self.reported.at + SPACING_S {
            return;
        }
        let body = self.report_body(now).to_string();
        let changed = self.reported.body.as_deref() != Some(body.as_str());
        if !at_once && !changed && now < self.reported.next_at {
            return;
        }
        if !at_once && changed && now < self.reported.next_at && self.reported.body.is_none() {
            // A report that did not get through waits for its retry.
            return;
        }
        self.reported.at = now;
        match self.pool.report(body.as_bytes()) {
            Net::Ok(()) => {
                self.reported.body = Some(body);
                self.reported.next_at = now + EVERY_S;
            }
            Net::NoAnswer(e) => self.unreported(now, &e, RETRY_S),
            Net::Unauthorized(s) => {
                self.unreported(now, &format!("HTTP {s}"), super::agent::UNAUTHORIZED_S);
            }
        }
    }

    fn unreported(&mut self, now: i64, why: &str, retry_s: i64) {
        // Said once per spell: the next one that gets through ends it.
        if self.reported.body.is_some() || self.reported.next_at == 0 {
            self.journal
                .write(now, "report", serde_json::json!({"detail": format!("not sent: {why}; tried again in {retry_s} s")}));
        }
        self.reported.body = None;
        self.reported.next_at = now + retry_s;
    }
}
