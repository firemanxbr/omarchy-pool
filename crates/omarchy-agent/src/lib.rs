//! The host agent's trust core (design v2 §4.3, §4.4, §5, §11.3).
//!
//! Two things CI and every maintainer host must do identically:
//!
//! - [`verify`]: check a signed host bundle or rollback statement against the pinned
//!   `release.yml` / `rollback.yml` identity, then parse it: the manifest's outer layer
//!   leniently, `inner` strictly, into types nothing unverified can build.
//! - [`lint`]: check the host set template (and the owner's override) against its
//!   invariants, on variable references, before any interpolation.
//! - [`capacity`]: detect the host's CPUs, memory, disks and limits and turn them, with the
//!   owner's caps and the release's verified constants, into units (P1, #333).
//! - [`run`]: the run loop (P1, #315): the host bundle rolled out by a state machine with
//!   a guard, revert, quarantine and preemption, on the pinned compose driver.
//!
//! And the host's identity (#321): [`host`] (its Ed25519 key and the signed request),
//! [`pool`] (HTTPS to the pool) and [`enroll`] (the one-time token, the owner's Confirm,
//! the host worker token).
//!
//! Self-update (#316) is part of [`run`]; [`install`] (#317) puts a Linux host together:
//! preflight, the envelope, enrollment, the agent keys, the unit and linger.
//! [`dispatcher_env`] (#371, #327) writes the dispatcher's worker token to its own file,
//! which the host set mounts read-only, and renders `etc/dispatcher.env` beside it: the
//! token's registration, the host's own addresses, the secrets directory and the agent
//! budget.

pub mod capacity;
pub mod dispatcher_env;
pub mod enroll;
pub mod host;
pub mod install;
pub mod lint;
pub mod manifest;
pub mod pool;
pub mod run;
pub mod statement;
pub mod verify;
pub mod version;

mod archive;

/// Entry points for the fuzz targets (`fuzz/`): each runs a parser on arbitrary bytes and
/// drops the result.
#[cfg(feature = "fuzzing")]
#[doc(hidden)]
pub mod fuzz {
    pub fn manifest(data: &[u8]) {
        let _ = crate::manifest::parse(data);
    }

    pub fn statement(data: &[u8]) {
        let _ = crate::statement::parse(data);
    }

    /// `state.json` as the run loop reads it, and the pool's `follow` answer.
    pub fn state(data: &[u8]) {
        let _ = crate::run::state::parse(data);
        let _ = crate::run::pool::parse_follow(data, "w_fuzz");
    }

    /// The bundle archive, then its manifest, as `verify --bundle` reads them once signed.
    pub fn bundle(data: &[u8]) {
        if let Ok(files) = crate::archive::read(data) {
            if let Some(m) = files.get("manifest.json") {
                let _ = crate::manifest::parse(m);
            }
        }
    }

    /// A set template, and an override after the first NUL byte; the same second part read
    /// as the template's `set.toml`.
    pub fn set(data: &[u8]) {
        let Ok(text) = std::str::from_utf8(data) else {
            return;
        };
        match text.split_once('\0') {
            Some((template, over)) => {
                crate::lint::fuzz(template, Some(over));
                let _ = crate::lint::lint_set_toml(over, template);
            }
            None => crate::lint::fuzz(text, None),
        }
    }
}

/// This agent's own version (design v2 D17); a manifest whose `min_agent` is above it, or
/// whose schema is newer than this agent knows, means "update myself first".
/// `tests/agent-self-update.sh` builds test agents with other versions
/// (`OMARCHY_AGENT_TEST_VERSION`, at build time); every other build is the crate's.
pub const AGENT_VERSION: &str = match option_env!("OMARCHY_AGENT_TEST_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};
