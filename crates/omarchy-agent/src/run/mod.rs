//! `omarchy-agent run` and its companions `status`, `round` and `logs` (design v2 §15,
//! §16.1, §16.2, §16.4, §18.4; #315): the run loop that rolls the host bundle's one
//! service, the dispatcher, out to this host — verify, lint, plan, pull, replace, guard,
//! commit or revert — on the pinned compose driver.
//!
//! Seams left for later issues, each named where it sits:
//! - install, preflight and runtime discovery (#317, `crate::install`): agent.toml (with
//!   `host_id` and `worker_id` from enrollment, and `set.engine`, the engine kind the
//!   lint holds the set to) and the first tools arrive from there. Preflight checks who
//!   owns (and may write) agent.toml, `compose.override.yml`, `.env` and
//!   `etc/dispatcher.env`;
//! - enrollment and the host report (#321): `agent.toml`'s `worker_id`, and
//!   `POST /hosts/self/report` built from `state.json`'s `round` and `rollout`;
//! - capacity detection (#333): `run/capacity.json`, hashed as an input of the set, so a
//!   file `capacity::write_if_changed` rewrote (`omarchy-agent capacity --write`) starts
//!   a round; the loop does not run the detection itself yet;
//! - self-update (#316, [`selfupdate`]): a bundle with a higher agent updates the agent
//!   first, upward only, behind a health gate. A release's pinned docker and compose
//!   roll forward only: they are switched before its round and not reverted with it;
//! - the host state (#344, [`pool`]) is the target, signed with the host key: from this
//!   agent on `follow.latest` is read only from a pool from before #344, whose state
//!   names no release (a rollback below it). It carries the open Updates and the host
//!   orders ([`orders`]: `retire-legacy` and `reconcile-now`; P4 adds the rest and the
//!   settings), whose answers ride the host report ([`report`]).

pub mod config;
pub mod state;

pub(crate) mod compose;
pub(crate) mod driver;
pub(crate) mod exec;
pub(crate) mod journal;
pub(crate) mod orders;
pub(crate) mod pool;
pub(crate) mod report;
pub(crate) mod rollout;
pub(crate) mod selfupdate;
pub(crate) mod target;
pub(crate) mod tools;
pub(crate) mod trust;

mod agent;
mod cli;

pub use cli::{logs, round, run, self_test, status};

// What install (#317) shares with the loop: the verifier, the release assets' names and
// where they are, and the pinned tools.
pub(crate) use agent::{bundle_names, Sigstore, Verifier};
pub(crate) use pool::RELEASES;

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
