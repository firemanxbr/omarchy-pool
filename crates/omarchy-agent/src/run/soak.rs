//! The owner's soak (#326; design v2 D16, §12 `soak_minutes`, §16.1, §16.3): a new release
//! waits `soak_minutes` on this host before its round, so a bad one can be caught on
//! another host first.
//!
//! - **What waits.** A release the pool names above the one that runs waits from when the
//!   pool first named it to this agent — its own clock: the pool's word on when it deployed
//!   would let a compromised pool skip the soak. A newer release named meanwhile waits its
//!   own soak from then. The bundle is fetched, verified and its `min_release` and
//!   `revoked` merged while it waits (design v2 §5.2): a soaking host still learns of a
//!   revocation.
//! - **What does not.** A rollback statement skips it and applies at once (§5.3); a round
//!   to the release that runs (an input that changed, drift, a `reconcile-now` when nothing
//!   is new) has nothing to wait for, and nor has the first release a host applies: nothing
//!   runs that the soak would protect. `reconcile-now`, an Update and SIGUSR1 never skip
//!   it: they start a round, which the soak holds like any other.
//! - **Self-updates too** (v1 §11.3, D8): a release that ships a higher agent waits with
//!   that agent, unless its manifest sets `agent.urgent` — only a security release does —:
//!   then the agent updates itself at once, and the release itself still waits.
//! - **Never behind for longer than the longest soak.** The soak never keeps this host more
//!   than [`MAX_BEHIND_S`] behind the release it ran when it fell behind: when releases land
//!   faster than the soak, the release named then is taken at that bound. The pool's claim
//!   grace for a soaking host ends at most two hours after its deploy, the round's 15
//!   minutes included (worker/src/update.ts), so a longer wait would idle the host it meant
//!   to protect — which is also why `soak_minutes` is at most [`MAX_SOAK_MINUTES`]. Either
//!   bound leaves the round inside the pool's two hours: a soak ends at most 100 minutes
//!   after the poll that first named its release, which comes minutes after its deploy;
//!   and a release the pool names once the host is behind was deployed after the host saw
//!   the one before it, so no earlier than when the host fell behind.
//! - **The pool's grace follows it.** The report says until when (`release.soaking_until`)
//!   for the release the pool names, until the host runs it; the pool keeps that host's
//!   registration out of the 426 gate until then, and the round's margin after it, at most
//!   two hours after the deploy. A release held in quarantine reports no soak: the host
//!   reverted it, it is not waiting for it.

use serde::{Deserialize, Serialize};

use crate::version::{Release, Version};

use super::agent::Agent;
use super::config::MAX_SOAK_MINUTES;
use super::orders::iso;
use super::rollout::{self, Outcome};
use super::state::Step;

/// The longest a soak keeps a host behind the release it ran when it fell behind: the
/// longest soak an owner may set.
pub(crate) const MAX_BEHIND_S: i64 = MAX_SOAK_MINUTES as i64 * 60;

/// The soak of the release the pool names, in `state.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Soak {
    /// The release the pool names, above the one that runs.
    pub release: Release,
    /// When the pool first named it (unix seconds, this agent's clock).
    pub seen: i64,
    /// The release that ran when the host fell behind, and when that was.
    pub from: Release,
    pub behind_since: i64,
    /// When the soak ends: `seen` and the owner's minutes, at most [`MAX_BEHIND_S`] after
    /// `behind_since`.
    pub until: i64,
}

impl Agent {
    /// The soak's clock as the pool names `target`, at every poll that names one: it starts
    /// when the pool first names a release above the one that runs, and again for each
    /// newer one; it goes once the host runs that release (or a newer one), or when the
    /// envelope sets no soak.
    pub(super) fn note_soak(&mut self, target: Release, now: i64) {
        let minutes = self.cfg.policy.soak_minutes;
        let Some(applied) = self.state.applied.filter(|a| minutes > 0 && target > *a) else {
            self.state.soak = None;
            return;
        };
        let s = self.state.soak.get_or_insert(Soak {
            release: target,
            seen: now,
            from: applied,
            behind_since: now,
            until: now,
        });
        if s.release != target {
            s.release = target;
            s.seen = now;
        }
        // A release was applied since the host fell behind (one named before this one): it
        // is behind this one since it was named.
        if s.from != applied {
            s.from = applied;
            s.behind_since = s.seen;
        }
        s.until = (s.seen + i64::from(minutes) * 60).min(s.behind_since + MAX_BEHIND_S);
    }

    /// Until when the owner's soak holds `target` now; `None` when it does not.
    pub(super) fn soaking(&self, target: Release, now: i64) -> Option<i64> {
        if self.cfg.policy.soak_minutes == 0 {
            return None;
        }
        self.state
            .soak
            .as_ref()
            .filter(|s| s.release == target && now < s.until)
            .map(|s| s.until)
    }

    /// Says that `target` waits for the soak, with the higher agent it ships that waits with
    /// it: as the last round's outcome (`held`), once — not again at every poll while the
    /// words are the same.
    pub(super) fn soak_held(
        &mut self,
        target: Release,
        until: i64,
        agent: Option<Version>,
        now: i64,
    ) {
        let with = agent.map_or_else(String::new, |v| {
            format!(", and the agent {v} it ships with it (its manifest does not set agent.urgent)")
        });
        let detail = format!(
            "{target} waits for the owner's soak until {} (soak_minutes = {}){with}; a rollback statement skips it, reconcile-now and an Update do not",
            iso(until),
            self.cfg.policy.soak_minutes
        );
        if self.state.round.outcome == Outcome::Held.name() && self.state.round.detail == detail {
            return;
        }
        // A round in flight keeps its report: the journal says it once.
        if self.state.rollout.step != Step::Idle && !self.said.insert(format!("soak:{detail}")) {
            return;
        }
        self.say(now, Outcome::Held, &detail);
    }

    /// The report's `release.soaking_until`: when the soak of the release the pool names
    /// ends, until the host runs it — past its end too, while its round runs, so the pool's
    /// grace covers the round. None when nothing waits, or the release is in quarantine.
    pub(super) fn soak_view(&self, now: i64) -> Option<String> {
        if self.cfg.policy.soak_minutes == 0 {
            return None;
        }
        let target = self.state.target?;
        let s = self.state.soak.as_ref().filter(|s| s.release == target)?;
        if self.state.applied.is_some_and(|a| a >= target)
            || rollout::quarantined(&self.state, target, now).is_some()
        {
            return None;
        }
        Some(iso(s.until))
    }
}

#[cfg(test)]
#[path = "soak_tests.rs"]
mod tests;
