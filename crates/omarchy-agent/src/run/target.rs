//! A release to roll out: the host set's files out of a verified bundle, and the pins the
//! lint needs to read the rendered template the way it was written.
//!
//! [`Target::from_bundle`] is the only way to make one outside tests, so a rollout only
//! ever renders files whose hashes the signed manifest listed.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::verify::VerifiedBundle;
use crate::version::Release;

/// What the lint and the overlay need besides the set files, kept as `pins.json` in
/// `staging/` and `last-good/` so a step resumed after a restart has them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Pins {
    pub release: Release,
    /// The manifest's `created`.
    pub created: String,
    /// `<repo>@<index digest>`: the worker image the template was rendered with.
    pub worker: String,
    pub build_aarch64: String,
    pub build_x86_64: String,
}

impl Pins {
    /// The template as the lint reads it: the manifest's own images put back as the
    /// placeholders release.yml rendered (design v2 §4.3: the lint runs before
    /// rendering), so any other image, a literal digest included, is still refused.
    pub fn lint_view(&self, compose: &str) -> String {
        let mut out = compose.to_owned();
        for (value, placeholder) in [
            (&self.worker, "ghcr.io/firemanxbr/omarchy-worker@RELEASE@"),
            (&self.build_aarch64, "@BUILD_AARCH64@"),
            (&self.build_x86_64, "@BUILD_X86_64@"),
        ] {
            if !value.is_empty() {
                out = out.replace(value.as_str(), placeholder);
            }
        }
        out
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub pins: Pins,
    /// The set's files, by path inside the set (`compose.yml`, `set.toml`, ...).
    pub files: BTreeMap<String, Vec<u8>>,
}

impl Target {
    pub fn from_bundle(b: &VerifiedBundle, set: &str) -> Result<Self, String> {
        let m = b.manifest();
        let listed = m
            .set_files(set)
            .ok_or_else(|| format!("the bundle has no {set} set"))?;
        let mut files = BTreeMap::new();
        for path in listed.keys() {
            let data = b
                .file(&format!("sets/{set}/{path}"))
                .ok_or_else(|| format!("sets/{set}/{path} is listed but missing"))?;
            files.insert(path.clone(), data.to_vec());
        }
        for needed in ["compose.yml", "set.toml"] {
            if !files.contains_key(needed) {
                return Err(format!("the {set} set has no {needed}"));
            }
        }
        let w = m.worker_image().index();
        let build = |arch| {
            m.build_image(arch)
                .map(ToString::to_string)
                .unwrap_or_default()
        };
        Ok(Target {
            pins: Pins {
                release: Release(m.outer().release()),
                created: m.outer().created().to_owned(),
                worker: w.to_string(),
                build_aarch64: build("aarch64"),
                build_x86_64: build("x86_64"),
            },
            files,
        })
    }

    pub fn release(&self) -> Release {
        self.pins.release
    }
}
