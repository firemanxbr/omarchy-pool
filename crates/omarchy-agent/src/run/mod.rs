//! `omarchy-agent run` and its companions `status`, `round` and `logs` (design v2 §15,
//! §16.1, §16.2, §16.4, §18.4; #315): the run loop that rolls the host bundle's one
//! service, the dispatcher, out to this host — verify, lint, plan, pull, replace, guard,
//! commit or revert — on the pinned compose driver.
//!
//! Seams left for later issues, each named where it sits:
//! - install, preflight and runtime discovery (#317): agent.toml, the first tools and the
//!   engine kind arrive from there; until then the lint holds every host to the rootful
//!   (strict) case;
//! - enrollment and the host report (#321): `agent.toml`'s `worker_id`, and
//!   `POST /hosts/self/report` built from `state.json`'s `round` and `rollout`;
//! - capacity detection (#333): `run/capacity.json`, hashed as an input of the set;
//! - self-update (#316): a bundle with a newer agent is noted, and rolled out by this
//!   agent meanwhile (its `min_agent` admits it);
//! - the host state (#344) replaces `follow.latest` as the target.

pub mod config;
pub mod state;

pub(crate) mod compose;
pub(crate) mod driver;
pub(crate) mod exec;
pub(crate) mod journal;
pub(crate) mod pool;
pub(crate) mod rollout;
pub(crate) mod target;
pub(crate) mod tools;
pub(crate) mod trust;

mod agent;
mod cli;

pub use cli::{logs, round, run, status};

/// Unix seconds now.
pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
pub(crate) mod fake;
