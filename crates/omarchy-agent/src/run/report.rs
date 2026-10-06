//! The host report (design v2 §17.2; #344's part of it): `POST /api/v1/hosts/self/report`,
//! signed with the host key, on every change and at least every [`EVERY_S`]. It carries
//! what the agent knows of itself — its version, the release applied, targeted and its
//! floor, the rollout and the last round, the legacy set (`legacy`), and the answers to
//! the last host orders (`orders`), which the pool closes the orders with. Capacity,
//! runtime, bundle and task fields stay with the issues that read them.
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
        body
    }

    /// Posts the report when something changed or one is due.
    pub(super) fn report(&mut self, now: i64) {
        if now < self.reported.at + SPACING_S {
            return;
        }
        let body = self.report_body(now).to_string();
        let changed = self.reported.body.as_deref() != Some(body.as_str());
        if !changed && now < self.reported.next_at {
            return;
        }
        if changed && now < self.reported.next_at && self.reported.body.is_none() {
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
