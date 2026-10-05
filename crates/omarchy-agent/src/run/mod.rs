//! `omarchy-agent run` and its companions `status`, `round` and `logs` (design v2 §15,
//! §16.1, §16.2, §16.4, §18.4; #315): the run loop that rolls the host bundle's one
//! service, the dispatcher, out to this host — verify, lint, plan, pull, replace, guard,
//! commit or revert — on the pinned compose driver. At its start and every minute it also
//! renders the dispatcher's `etc/dispatcher.env` beside the token (#371,
//! [`crate::dispatcher_env`]): the host's addresses when they change (the public one asked
//! of the pool's edge every hour), agent.toml's secrets directory and budget as agent.toml
//! says them now; a file that changed starts a round like any input.
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
//!   orders ([`orders`]: `retire-legacy` and `reconcile-now`), whose answers ride the host
//!   report ([`report`]);
//! - P4's host state (#325): the settings the pool may narrow inside the envelope
//!   ([`settings`]: units and emulated lanes, applied to `run/capacity.json`), the other
//!   host orders (`set-units`, `set-emulate`, `rotate-token`, `retry-release`,
//!   `diagnostics`), all behind the host-side brake ([`brake`]), and the owner's runtime
//!   switch at the host ([`switch`]). Seams: soak and freeze detection, and the `*_FILE`
//!   secrets, are their own issues; `rotate-token` writes the token where enrollment does
//!   (`enroll::write_worker_token`), which #371 and #327 move.

pub mod brake;
pub mod config;
pub mod settings;
pub mod state;
pub mod switch;

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

pub use cli::{logs, round, run, runtime_switch, self_test, status};

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
#[cfg(test)]
mod settings_tests;
