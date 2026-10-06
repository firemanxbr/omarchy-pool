//! Freeze detection (#326; design v2 §5.5, §18.1, §18.3): a compromised pool could hold its
//! hosts on an old release. Once every [`EVERY_S`] the agent reads the tag of GitHub's
//! latest release — and nothing else: no asset, no notes, unauthenticated — and when GitHub
//! has shown a release newer than the one the pool names for more than [`AHEAD_S`], it
//! reports `pool-behind-github` (`release.pool_behind_github`) for the host page and
//! Status. It never acts on GitHub's word alone: no round, no fetch of that release,
//! nothing changes on the host. GitHub's tag is no signed word, only a second opinion on
//! the pool's.
//!
//! Not counted: a GitHub release in the merged `revoked` set, and one a rollback statement
//! retracts — rollback.yml signed it, the pool relays it for the release it names, and its
//! `retracts_through` reaches GitHub's latest: a rollback leaves GitHub's latest release as
//! it was and has the pool name the older one on purpose. The statement is verified as any
//! (the pinned identity), when GitHub is read. The day counts from when this agent first
//! found the pool naming a release older than GitHub's latest — a tag carries no time —, so
//! a host that just started, or a pool that just rolled back, waits a whole day before it
//! says so; a GitHub that does not answer is asked again within the hour and changes
//! nothing.

use serde::{Deserialize, Serialize};

use crate::verify::StatementOutcome;
use crate::version::Release;

use super::agent::Agent;
use super::orders::iso;
use super::pool::Net;

/// GitHub's latest release is read this often.
pub(crate) const EVERY_S: i64 = 6 * 3600;
/// After a read that got no answer.
pub(crate) const RETRY_S: i64 = 3600;
/// How long GitHub shows a newer release than the pool names before the agent says so.
pub(crate) const AHEAD_S: i64 = 24 * 3600;

/// What the agent knows of GitHub's latest release, in `state.json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GitHub {
    /// When GitHub is read next (unix seconds).
    pub next_at: i64,
    /// The tag of GitHub's latest release as last read, and when.
    pub latest: Option<Release>,
    pub read_at: i64,
    /// A rollback statement relayed for the release the pool names, verified: its `to` and
    /// its `retracts_through`.
    pub retracted: Option<(Release, Release)>,
    /// Since when the pool names a release older than GitHub's latest, as this agent saw
    /// both.
    pub ahead_since: Option<i64>,
    /// Whether `pool-behind-github` is said now (the journal says each change once).
    pub behind: bool,
}

/// `pool-behind-github`: GitHub's latest release, the one the pool names, and since when.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Behind {
    pub github: Release,
    pub pool: Release,
    pub since: i64,
}

impl Agent {
    /// Every tick: GitHub read when it is time, then whether the pool is behind it — all
    /// local but the read.
    pub(super) fn freeze(&mut self, now: i64) {
        if now >= self.state.github.next_at {
            self.read_github(now);
        }
        let ahead = self.github_ahead().is_some();
        let g = &mut self.state.github;
        match (ahead, g.ahead_since) {
            (true, None) => g.ahead_since = Some(now),
            (false, Some(_)) => g.ahead_since = None,
            _ => {}
        }
        let behind = self.pool_behind(now);
        if behind.is_some() != self.state.github.behind {
            self.state.github.behind = behind.is_some();
            let detail = match behind {
                Some(b) => format!(
                    "pool-behind-github: GitHub's latest release has been {} since {} (more than {} h) while the pool names {}; nothing changes here — the agent follows only the pool and what is signed",
                    b.github,
                    iso(b.since),
                    AHEAD_S / 3600,
                    b.pool
                ),
                None => "the pool names GitHub's latest release again (or a rollback statement explains why it does not)".to_owned(),
            };
            self.journal
                .write(now, "freeze", serde_json::json!({"detail": detail}));
        }
    }

    /// GitHub's latest release and the release the pool names, when GitHub's is the newer
    /// and neither `revoked` nor a verified rollback statement explains it.
    fn github_ahead(&self) -> Option<(Release, Release)> {
        let g = &self.state.github;
        let (latest, pool) = (g.latest?, self.state.target?);
        let retracted = g
            .retracted
            .is_some_and(|(to, through)| to == pool && latest <= through);
        (latest > pool && !self.state.revoked.contains(&latest) && !retracted)
            .then_some((latest, pool))
    }

    /// `pool-behind-github` now: GitHub ahead of the pool for more than [`AHEAD_S`].
    pub(crate) fn pool_behind(&self, now: i64) -> Option<Behind> {
        let (github, pool) = self.github_ahead()?;
        let since = self.state.github.ahead_since?;
        (now - since > AHEAD_S).then_some(Behind {
            github,
            pool,
            since,
        })
    }

    /// The report's `release.pool_behind_github`.
    pub(super) fn freeze_view(&self, now: i64) -> serde_json::Value {
        self.pool_behind(now)
            .map_or(serde_json::Value::Null, |b| {
                serde_json::json!({"github": b.github.to_string(), "pool": b.pool.to_string(), "since": iso(b.since)})
            })
    }

    /// GitHub's latest release, read; then, when it is ahead of the pool, whether a
    /// rollback statement explains it.
    fn read_github(&mut self, now: i64) {
        match self.pool.github_latest() {
            Net::Ok(r) => {
                let g = &mut self.state.github;
                g.latest = Some(r);
                g.read_at = now;
                g.next_at = now + EVERY_S;
                if let Some((_, pool)) = self.github_ahead() {
                    self.retraction(pool);
                }
            }
            Net::NoAnswer(_) | Net::Unauthorized(_) => {
                self.state.github.next_at = now + RETRY_S;
            }
        }
    }

    /// The rollback statement the pool relays for the release it names, verified as any:
    /// its `retracts_through` explains a newer GitHub release up to it.
    fn retraction(&mut self, pool: Release) {
        let Net::Ok(Some(relayed)) = self.pool.rollback(pool) else {
            return;
        };
        if let Ok(StatementOutcome::Current(vs)) =
            self.verifier.statement(&relayed.statement, &relayed.bundle)
        {
            let st = vs.statement();
            if Release(st.to()) == pool {
                self.state.github.retracted = Some((pool, Release(st.retracts_through())));
            }
        }
    }
}

#[cfg(test)]
#[path = "freeze_tests.rs"]
mod tests;
