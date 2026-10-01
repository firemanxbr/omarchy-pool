//! The host agent's trust core (design v2 §4.3, §4.4, §5, §11.3).
//!
//! Two things CI and every maintainer host must do identically:
//!
//! - [`verify`]: check a signed host bundle or rollback statement against the pinned
//!   `release.yml` / `rollback.yml` identity, then parse it: the manifest's outer layer
//!   leniently, `inner` strictly, into types nothing unverified can build.
//! - [`lint`]: check the host set template (and the owner's override) against its
//!   invariants, on variable references, before any interpolation.
//!
//! The run loop, drivers, install, capacity detection and self-update come in P1 and build
//! on the types defined here.

pub mod lint;
pub mod manifest;
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

    /// A set template, and an override after the first NUL byte.
    pub fn set(data: &[u8]) {
        let Ok(text) = std::str::from_utf8(data) else {
            return;
        };
        match text.split_once('\0') {
            Some((template, over)) => crate::lint::fuzz(template, Some(over)),
            None => crate::lint::fuzz(text, None),
        }
    }
}

/// This agent's own version (design v2 D17); a manifest whose `min_agent` is above it, or
/// whose schema is newer than this agent knows, means "update myself first".
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
