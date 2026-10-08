//! Emulated lanes (design v2 §7.5, §15 `emulation(arch, image)`; D33, S6; #338): for each
//! foreign architecture the pool builds (`x86_64` on an `aarch64` host, `aarch64` on an `x86_64`
//! one), whether this host runs it emulated — a lane like the native one, sharing its
//! units, detected rather than configured.
//!
//! In order, for the foreign architecture:
//! 1. the envelope's `emulate` (design v2 §12) lists it, or is absent: `emulate = []` keeps
//!    every emulated lane off, and nothing else is tried for one it leaves out — no image
//!    of an architecture the owner turned off is pulled;
//! 2. binfmt, checked always (it is also the only host need `lint-set` lets a set's
//!    `[needs]` name for an emulated lane, so detection does not read the set):
//!    `/proc/sys/fs/binfmt_misc/qemu-<arch>` enabled, with the `F` flag so a container's
//!    own root needs no interpreter of its own (or Rosetta's handler, `rosetta`, in a VM
//!    started with it). Missing, the lane is held — "needs a person: prep-root.sh installs
//!    qemu-user-static-binfmt" — and the native lane is unaffected;
//! 3. the smoke run through the engine ([`Smoke`]): the release's build image of that
//!    architecture, by digest, runs `/usr/bin/true`, then `pacman --version` — and on a
//!    kernel with 4K pages, `sudo -V` ([`LOADER`], #VM4K). Passing turns the lane on, with
//!    `via` (`qemu` or `rosetta`) and `page16k`.
//!
//! **On a kernel with pages larger than the guest's 4K the lane stays on** (16K on Asahi;
//! D33): some `x86_64` toolchains cannot start under qemu there, and the build container
//! probes the toolchains a recipe installs and fails at once with `needs_native`
//! (`omarchy-build-worker.sh`, `toolchains_start`, told it is emulated by
//! `WORKER_LABELS={"emulated":true}`, which the dispatcher sets on this lane only); the
//! pool sends that task back without spending its attempt. Most packages build emulated;
//! the few that cannot wait for a native host — or, since #VM4K (D33 amended), for an
//! emulated lane on 4K pages, where qemu maps what 16K pages cannot (the Studio's `x86_64`
//! VM: a 4K-page kernel under KVM on the same machine). That is why a 4K-page lane runs
//! the loader check too: it is handed exactly the builds whose libraries 16K pages could
//! not map, so a lane where `sudo` — a setuid binary that loads its plugins through the
//! dynamic loader, and fails on 16K pages with *failed to map segment from shared object*
//! — does not start is held, not reported 4K. On 16K pages it is not run: `sudo` fails
//! there by design (D33), and the lane is on anyway.
//!
//! A lane that is not on is reported held with its reason (`held_lanes`), so the host page
//! says what a person can do about it.

use std::path::Path;

use serde::Serialize;

/// The architectures the pool builds.
pub const ARCHES: [&str; 2] = ["aarch64", "x86_64"];

/// What a person does for a lane whose handler is missing (prep-root.sh's root step).
pub const NEEDS_PERSON: &str = "needs a person: prep-root.sh installs qemu-user-static-binfmt";

/// The other architecture the pool builds, for a native one.
pub fn foreign_of(native: &str) -> Option<&'static str> {
    match native {
        "aarch64" => Some("x86_64"),
        "x86_64" => Some("aarch64"),
        _ => None,
    }
}

/// The engine's platform of an architecture the pool builds.
pub fn platform_of(arch: &str) -> Option<&'static str> {
    match arch {
        "x86_64" => Some("linux/amd64"),
        "aarch64" => Some("linux/arm64"),
        _ => None,
    }
}

/// What the kernel's binfmt table says of a foreign architecture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binfmt {
    /// A handler is enabled with the `F` flag: containers can run that architecture.
    Ready {
        via: &'static str,
    },
    /// Enabled, but without `F`: the interpreter would have to be inside every container.
    NoFixFlag,
    Disabled,
    Missing,
}

/// One handler file (`enabled`, then `flags: …`): `None` when it is not there.
fn handler(dir: &Path, name: &str) -> Option<Binfmt> {
    let text = std::fs::read_to_string(dir.join(name)).ok()?;
    if text.lines().next().map(str::trim) != Some("enabled") {
        return Some(Binfmt::Disabled);
    }
    let fix = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("flags:"))
        .is_some_and(|f| f.contains('F'));
    Some(if fix {
        Binfmt::Ready {
            via: name_via(name),
        }
    } else {
        Binfmt::NoFixFlag
    })
}

fn name_via(handler: &str) -> &'static str {
    if handler == "rosetta" {
        "rosetta"
    } else {
        "qemu"
    }
}

/// The binfmt handler of `arch` under `dir` (`/proc/sys/fs/binfmt_misc`): qemu's, or for
/// `x86_64` Rosetta's (a Linux VM on Apple silicon started with it).
pub fn binfmt(dir: &Path, arch: &str) -> Binfmt {
    let qemu = handler(dir, &format!("qemu-{arch}"));
    if let Some(ready @ Binfmt::Ready { .. }) = qemu {
        return ready;
    }
    if arch == "x86_64" {
        if let Some(ready @ Binfmt::Ready { .. }) = handler(dir, "rosetta") {
            return ready;
        }
    }
    qemu.unwrap_or(Binfmt::Missing)
}

/// The smoke run of an emulated lane (design v2 §15's `emulation(arch, image)`): the
/// build image of `arch`, by digest, starts `/usr/bin/true`, then `pacman --version`,
/// under `--platform linux/<arch>`; on 4K pages, [`LOADER`] too (`loader`, #VM4K).
/// [`super::probe::Probe`] runs it with the engine's CLI; the tests fake it.
pub trait Smoke {
    fn emulation(&self, arch: &str, image: &str) -> Result<(), String>;
    /// [`LOADER`] in the same image, under the same platform.
    fn loader(&self, arch: &str, image: &str) -> Result<(), String>;
}

/// The smoke run's two containers, in order: their entrypoint, its arguments, and what it
/// must print (`pacman --version`: `Pacman v7.0.0 - libalpm v15.0.0`, whatever the
/// version). Each runs with `--network none`: a smoke run reaches nothing.
pub const STEPS: [(&str, &[&str], &str); 2] = [
    ("/usr/bin/true", &[], ""),
    ("pacman", &["--version"], "Pacman v"),
];

/// The loader check of a lane on 4K pages (#VM4K), one more container the same way:
/// `sudo -V` (`Sudo version 1.9.17p2`, whatever the version) — `sudo` and the plugins it
/// loads are what 16K pages cannot map (D33), so a 4K-page lane that is handed the builds
/// 16K pages sent back proves it maps them. The release's build images are Arch's
/// `base-devel`, which has `sudo` (`factory/bin/build-images`), run as root; an image
/// given by hand (`--emulate-image`) needs it too.
pub const LOADER: (&str, &[&str], &str) = ("sudo", &["-V"], "Sudo version");

/// An emulated lane this host runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Emulated {
    pub arch: String,
    pub via: &'static str,
    /// The kernel's pages are larger than the guest's 4K (16K on Asahi): the lane is on
    /// anyway, and a toolchain that cannot start there sends its task back (D33).
    pub page16k: bool,
}

/// A lane this host does not run, and why (the host page shows it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Held {
    pub arch: String,
    pub reason: String,
}

/// What detection found of the foreign architectures.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Lanes {
    pub on: Vec<Emulated>,
    pub held: Vec<Held>,
}

/// The envelope's word on `arch`: absent, every foreign architecture may run.
pub fn allowed(emulate: Option<&[String]>, arch: &str) -> bool {
    emulate.is_none_or(|e| e.iter().any(|a| a == arch))
}

/// Why the envelope holds a lane off.
pub fn off_in_envelope(arch: &str) -> Held {
    Held {
        arch: arch.to_owned(),
        reason: "off: the envelope's emulate does not list it".into(),
    }
}

/// What detection needs: where the binfmt table is, the build images the smoke run may
/// start, by architecture and by digest (the release's; none without one), and the
/// envelope's `emulate`. The foreign architecture is the engine's other one, so its image
/// is looked up here: the agent binary's own architecture may not be the engine's.
#[derive(Debug, Clone, Copy)]
pub struct Probe<'a> {
    pub binfmt: &'a Path,
    pub images: &'a [(&'static str, String)],
    pub emulate: Option<&'a [String]>,
}

/// The images the smoke run may start ([`Probe::images`]): one given by hand
/// (`--emulate-image`), as the foreign architecture's whichever the engine's is, or else a
/// release's build image of each architecture the pool builds.
pub fn images(
    given: Option<&str>,
    release: Option<&crate::manifest::Manifest>,
) -> Vec<(&'static str, String)> {
    ARCHES
        .iter()
        .filter_map(|a| {
            let image = match given {
                Some(i) => i.to_owned(),
                None => release?.build_image(a)?.to_string(),
            };
            Some((*a, image))
        })
        .collect()
}

/// The emulated lanes of a host whose native architecture is `native`, on a kernel with
/// pages of `page_kb`.
pub fn detect(native: &str, page_kb: u32, p: &Probe<'_>, smoke: &dyn Smoke) -> Lanes {
    let mut out = Lanes::default();
    let Some(arch) = foreign_of(native) else {
        return out;
    };
    let held = |reason: String| Held {
        arch: arch.to_owned(),
        reason,
    };
    if !allowed(p.emulate, arch) {
        out.held.push(off_in_envelope(arch));
        return out;
    }
    let via = match binfmt(p.binfmt, arch) {
        Binfmt::Ready { via } => via,
        Binfmt::NoFixFlag => {
            out.held.push(held(format!(
                "{NEEDS_PERSON} (qemu-{arch} is enabled without the F flag containers need)"
            )));
            return out;
        }
        Binfmt::Disabled => {
            out.held
                .push(held(format!("{NEEDS_PERSON} (qemu-{arch} is disabled)")));
            return out;
        }
        Binfmt::Missing => {
            out.held.push(held(format!(
                "{NEEDS_PERSON} (no qemu-{arch} handler in {})",
                p.binfmt.display()
            )));
            return out;
        }
    };
    let Some(image) = p
        .images
        .iter()
        .find_map(|(a, i)| (*a == arch).then_some(i.as_str()))
    else {
        out.held.push(held(format!(
            "not checked: no {arch} build image to run (a release names one)"
        )));
        return out;
    };
    let cut = |e: String| e.chars().take(200).collect::<String>();
    if let Err(e) = smoke.emulation(arch, image) {
        out.held
            .push(held(format!("the smoke run failed: {}", cut(e))));
        return out;
    }
    let page16k = page_kb >= 16;
    // On 4K pages the lane takes what 16K pages sent back (#VM4K): it proves the loader maps
    // what they could not, or it is held — never on, reported 4K, and failing those builds.
    if !page16k {
        if let Err(e) = smoke.loader(arch, image) {
            out.held.push(held(format!(
                "the smoke run failed: {} — the loader check of a lane on 4K pages (#VM4K)",
                cut(e)
            )));
            return out;
        }
    }
    out.on.push(Emulated {
        arch: arch.to_owned(),
        via,
        page16k,
    });
    out
}

/// An image the smoke run may name on the engine's argv: `<repository>@sha256:<64 hex>`,
/// the repository starting with a letter or a digit (never a flag), as the dispatcher's
/// task spec reads one.
pub fn image_ok(s: &str) -> bool {
    let Some((repo, digest)) = s.rsplit_once("@sha256:") else {
        return false;
    };
    repo.len() <= 255
        && repo
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && repo
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-/:".contains(&b))
        && digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
