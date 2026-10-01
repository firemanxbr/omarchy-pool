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
//!
//! - [`capacity`]: detect the host's CPUs, memory, disks and limits and turn them, with the
//!   owner's caps and the release's verified constants, into units (P1, #333).
//!
//! And the host's identity (#321): [`host`] (its Ed25519 key and the signed request),
//! [`pool`] (HTTPS to the pool) and [`enroll`] (the one-time token, the owner's Confirm,
//! the host worker token).
//!
//! The run loop, drivers, install and self-update come in P1 and build on the types defined
//! here.

pub mod capacity;
pub mod enroll;
pub mod host;
pub mod lint;
pub mod manifest;
pub mod pool;
pub mod statement;
pub mod verify;

mod archive;
mod version;

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
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
