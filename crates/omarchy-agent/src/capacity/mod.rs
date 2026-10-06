//! Capacity (design v2 §7.1-§7.3, §7.6; decisions D30, D32, D44; #333).
//!
//! [`probe`] reads the host into [`Facts`]: the engine's CPUs and memory (`docker info`
//! through the CLI the agent runs), the agent's own cgroup limits, `MemAvailable`, free
//! disk on the work root and on the engine's data root, page size, cgroup v2 and whether
//! `--cpus` / `--memory` / `--pids-limit` hold, and the isolation level.
//!
//! [`Capacity::new`] turns facts, the owner's [`Caps`] and the release's verified
//! constants into the host's units: the effective totals are the minimum of the engine's
//! view, the cgroup limits and the caps; `usable = total - reserve`;
//! `units = min(usable_cpus / unit.cpus, usable_mem / unit.mem_gb, max_units)`. A host
//! below the signed minimum keeps 0 units and says `below_minimum` (D44): it claims
//! nothing. Nothing else builds a [`Capacity`], so nothing else produces a unit count.
//!
//! [`preflight`] lists what stops an install; [`write_if_changed`] keeps
//! `run/capacity.json` (schema 2) in the set directory and says whether it changed, which
//! is what starts a rollout round (the run loop, #315).
//!
//! Seams left for later issues, by name: the run loop calls [`probe::detect`] at start,
//! hourly and after a runtime change and starts a round on [`Written::Changed`] (#315);
//! install runs [`preflight`] with the limit probe and prints its blockers (#317); the
//! dispatcher reads the file, claims nothing while `below_minimum` or while its leases
//! exceed `units`, and gives each task `--cpus` and the job counts of its share (#335,
//! #337); the driver trait (#315) wraps [`probe::engine`] as its `capacity()` and the
//! smoke run ([`emulation::Smoke`] on [`probe::Probe`]) as its `emulation()`, and runs the
//! engine CLI under a cleared environment. Also for #315: one `agent.toml` reader in
//! place of [`AgentToml`] and `lint::Envelope::from_agent_toml`, with one closed
//! `[envelope]` schema (until then [`AgentToml::parse`] refuses a key design v2 §12 does
//! not name); whether a change of free disk alone (in `DISK_STEP_GB` steps, at most
//! hourly) is worth a whole round; and the set directory's files opened with `openat` and
//! `O_NOFOLLOW` (until then [`write_if_changed`] refuses a linked `run/` or
//! `capacity.json`).
//!
//! [`emulation`] (#338, design v2 §7.5) adds the foreign architecture's lane to `lanes`
//! when the envelope allows it, binfmt is there and the smoke run passes — on 16K pages
//! too (D33) — and says why it is held otherwise (`held_lanes`); the native lane never
//! depends on it. On a Mac (#320) the binfmt table is the VM's, which the agent does not
//! read: [`probe::in_mac_vm`] puts the `x86_64` lane through Rosetta into the same lanes
//! after the same smoke run, and says why it is off in install's notes and the run loop's
//! journal rather than in `held_lanes`.

pub mod emulation;
pub mod probe;

use std::fmt;
use std::io::Write as _;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::manifest;

pub use probe::Facts;

/// `run/capacity.json`'s layout.
pub const FILE_SCHEMA: u32 = 2;

/// Free disk in the file is rounded down to this many GB, so the file (and with it a
/// rollout round) changes when the host's free space moves by this much, not with every
/// gigabyte a build writes. The minimum is checked on the exact values.
const DISK_STEP_GB: u64 = 10;

/// The isolation a task-container escape lands with (design v2 §19.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Isolation {
    /// A rootful daemon without user-namespace remapping.
    Root,
    /// A rootless runtime: an escape lands as the runtime's user.
    User,
    /// Task root mapped away from the daemon's user (`userns-remap`).
    Subuid,
    /// macOS: the dedicated `omarchy` Colima VM, which mounts only the work root, the
    /// secrets directory and the set directory (#320): an escape lands in the VM.
    Vm,
    /// macOS: Docker Desktop's or `OrbStack`'s VM, shared with the person's own containers
    /// and mounting the home directory by default; used if present, never installed.
    #[serde(rename = "vm-shared")]
    VmShared,
}

/// The VM a macOS engine runs in (#320, design v2 §19.2, §19.3), as install found it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmKind {
    /// The `omarchy` Colima profile the agent starts, stops and sizes (M7).
    Dedicated,
    /// Docker Desktop or `OrbStack`.
    Shared,
}

/// Whether the runtime enforces the hard limits every task gets (D32).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[allow(clippy::struct_excessive_bools)] // the three limits and cgroup v2, one for one
pub struct Limits {
    pub cpus_hard: bool,
    pub memory_hard: bool,
    pub pids: bool,
    #[serde(skip)]
    pub cgroup_v2: bool,
}

impl Limits {
    fn all(self) -> bool {
        self.cpus_hard && self.memory_hard && self.pids
    }
}

/// The owner's caps, from `agent.toml`'s `[envelope]` (design v2 §7.2, §12). They only
/// lower what detection found; nothing the pool sends changes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caps {
    pub max_units: Option<u32>,
    pub max_cpus: Option<u32>,
    pub max_mem_gb: Option<u32>,
    /// How many tasks that need a model may be leased at once (default 2).
    pub agent_slots: u32,
    pub dedicated: bool,
    /// The foreign architectures that may run emulated (`emulate`): `None` when the
    /// envelope does not say (every one detection turns on), `Some([])` keeps them off.
    pub emulate: Option<Vec<String>>,
}

impl Default for Caps {
    fn default() -> Self {
        Caps {
            max_units: None,
            max_cpus: None,
            max_mem_gb: None,
            agent_slots: 2,
            dedicated: false,
            emulate: None,
        }
    }
}

/// What the capacity code reads from `agent.toml`: the caps, and where the work root and
/// the engine's socket are. Other tables are left to their readers, but a key in
/// `[envelope]` that design v2 §12 does not name is refused: a misspelt cap that is
/// silently lost would leave the envelope wider than the owner wrote it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentToml {
    pub caps: Caps,
    pub work_root: Option<String>,
    pub socket_cli: Option<String>,
    /// A Mac's VM (#320, `[vm]`): its runtime (`colima`, `docker-desktop`, `orbstack`) and
    /// whether it runs `x86_64` through Rosetta. The envelope's `emulate` is `caps.emulate`.
    pub vm: Option<(String, bool)>,
}

impl AgentToml {
    pub fn parse(text: &str) -> Result<Self, String> {
        #[derive(Deserialize, Default)]
        struct File {
            #[serde(default)]
            set: SetPart,
            #[serde(default)]
            envelope: EnvelopePart,
            vm: Option<VmPart>,
        }
        #[derive(Deserialize)]
        struct VmPart {
            runtime: String,
            #[serde(default)]
            rosetta: bool,
        }
        #[derive(Deserialize, Default)]
        struct SetPart {
            work_root: Option<String>,
            socket_cli: Option<String>,
        }
        #[derive(Deserialize, Default)]
        struct EnvelopePart {
            max_units: Option<u32>,
            max_cpus: Option<u32>,
            max_mem_gb: Option<u32>,
            agent_slots: Option<u32>,
            #[serde(default)]
            dedicated: bool,
            emulate: Option<Vec<String>>,
        }
        let raw: toml::Table = toml::from_str(text).map_err(|e| format!("agent.toml: {e}"))?;
        if let Some(env) = raw.get("envelope").and_then(toml::Value::as_table) {
            if let Some(k) = env.keys().find(|k| !ENVELOPE_KEYS.contains(&k.as_str())) {
                return Err(format!("agent.toml: [envelope] has no key {k:?}"));
            }
        }
        let f: File = raw.try_into().map_err(|e| format!("agent.toml: {e}"))?;
        if let Some(w) = f.set.work_root.as_deref() {
            if !crate::lint::is_plain_absolute(Path::new(w)) {
                return Err(format!(
                    "agent.toml: set.work_root {w} is not a plain absolute path"
                ));
            }
        }
        let e = f.envelope;
        if let Some(bad) = e
            .emulate
            .iter()
            .flatten()
            .find(|a| !emulation::ARCHES.contains(&a.as_str()))
        {
            return Err(format!(
                "agent.toml: [envelope] emulate lists {bad:?}, not an architecture the pool builds \
                 ({})",
                emulation::ARCHES.join(", ")
            ));
        }
        Ok(AgentToml {
            caps: Caps {
                max_units: e.max_units,
                max_cpus: e.max_cpus,
                max_mem_gb: e.max_mem_gb,
                agent_slots: e.agent_slots.unwrap_or(2),
                dedicated: e.dedicated,
                emulate: e.emulate,
            },
            work_root: f.set.work_root,
            socket_cli: f.set.socket_cli,
            vm: f.vm.map(|v| (v.runtime, v.rosetta)),
        })
    }
}

/// Every key of `agent.toml`'s `[envelope]` (design v2 §12).
const ENVELOPE_KEYS: &[&str] = &[
    "max_units",
    "max_cpus",
    "max_mem_gb",
    "emulate",
    "agent_slots",
    "agent_budget",
    "cache_caps",
    "task_subnets",
    "allow_socket",
    "rootful_ack",
    "dedicated",
    "userns_remap",
    "drivers",
    "paths",
    "diagnostics",
    "soak_minutes",
];

/// One way the host is below the signed minimum, with the numbers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shortfall {
    pub what: &'static str,
    pub have: u64,
    pub need: u64,
}

impl fmt::Display for Shortfall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {} (the minimum is {})",
            self.what, self.have, self.need
        )
    }
}

/// A host's capacity in units, built only from probed [`Facts`] and the verified
/// constants of a signed release ([`manifest::Capacity`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Capacity {
    cpus: u32,
    mem_gb: u32,
    /// The totals detection found before the owner's `max_cpus` and `max_mem_gb` (#328): a
    /// signed widening of those counts the units again from them, never above them.
    hardware: (u32, u32),
    mem_available_gb: Option<u32>,
    page_kb: u32,
    disk_free_gb: DiskFree,
    units: u32,
    job_reserved: u32,
    agent_slots: u32,
    arch: String,
    emulated: Vec<emulation::Emulated>,
    held: Vec<emulation::Held>,
    isolation: Isolation,
    dedicated: bool,
    limits: Limits,
    shortfalls: Vec<Shortfall>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DiskFree {
    pub work: u64,
    pub engine: u64,
}

impl Capacity {
    /// The effective totals, the units they give, and the minimum check.
    pub fn new(facts: &Facts, caps: &Caps, constants: &manifest::Capacity) -> Self {
        let c = constants.constants();
        let (cpus, mem_gb) = facts.totals();
        let hardware = (cpus, mem_gb);
        let cpus = caps.max_cpus.map_or(cpus, |m| cpus.min(m));
        let mem_gb = caps.max_mem_gb.map_or(mem_gb, |m| mem_gb.min(m));
        let disk = facts.disk_free_gb();

        let mut shortfalls = Vec::new();
        for (what, have, need) in [
            ("CPUs", u64::from(cpus), c.min.cpus),
            ("memory (GB)", u64::from(mem_gb), c.min.mem_gb),
            (
                "free disk on the work root (GB)",
                disk.work,
                c.min.work_disk_gb,
            ),
            (
                "free disk on the engine's data root (GB)",
                disk.engine,
                c.min.engine_disk_gb,
            ),
        ] {
            if have < u64::from(need) {
                shortfalls.push(Shortfall {
                    what,
                    have,
                    need: u64::from(need),
                });
            }
        }

        let units = if shortfalls.is_empty() {
            units_of(cpus, mem_gb, caps.max_units, c)
        } else {
            0
        };
        // The emulated lanes detection turned on, within the owner's envelope: one it leaves
        // out is held, whatever the probe that found it was told (design v2 §7.5, §12).
        let (mut emulated, mut held) = facts
            .emulation()
            .map(|l| (l.on.clone(), l.held.clone()))
            .unwrap_or_default();
        emulated.retain(|l| {
            let ok = emulation::allowed(caps.emulate.as_deref(), &l.arch);
            if !ok {
                held.push(emulation::off_in_envelope(&l.arch));
            }
            ok
        });
        Capacity {
            cpus,
            mem_gb,
            hardware,
            mem_available_gb: facts.mem_available_gb(),
            page_kb: facts.page_kb(),
            disk_free_gb: disk,
            units,
            job_reserved: c.units.job_reserved.min(units),
            agent_slots: caps.agent_slots,
            arch: facts.arch().to_owned(),
            emulated,
            held,
            isolation: facts.isolation(),
            dedicated: caps.dedicated,
            limits: facts.limits(),
            shortfalls,
        }
    }

    pub fn cpus(&self) -> u32 {
        self.cpus
    }
    pub fn mem_gb(&self) -> u32 {
        self.mem_gb
    }
    pub fn units(&self) -> u32 {
        self.units
    }
    pub fn job_reserved(&self) -> u32 {
        self.job_reserved
    }
    pub fn disk_free_gb(&self) -> DiskFree {
        self.disk_free_gb
    }
    pub fn isolation(&self) -> Isolation {
        self.isolation
    }
    /// The emulated lanes, after the native one (#338; a Mac's Rosetta lane, #320).
    pub fn emulated(&self) -> &[emulation::Emulated] {
        &self.emulated
    }
    pub fn limits(&self) -> Limits {
        self.limits
    }
    /// The lanes this host runs: the native one first, then each emulated one.
    pub fn lanes(&self) -> Vec<Lane> {
        let mut out = vec![Lane {
            arch: self.arch.clone(),
            mode: "native",
            via: None,
            page16k: None,
        }];
        out.extend(self.emulated.iter().map(|e| Lane {
            arch: e.arch.clone(),
            mode: "emulated",
            via: Some(e.via),
            page16k: Some(e.page16k),
        }));
        out
    }
    /// The lanes detection holds off, and why.
    pub fn held_lanes(&self) -> &[emulation::Held] {
        &self.held
    }
    /// Below the signed minimum (D44): the host keeps its bundle, claims nothing.
    pub fn below_minimum(&self) -> bool {
        !self.shortfalls.is_empty()
    }
    pub fn shortfalls(&self) -> &[Shortfall] {
        &self.shortfalls
    }
    /// `MemAvailable` when the agent could read it; reported, never part of the totals
    /// (the dispatcher checks it before every claim, design v2 §7.6).
    pub fn mem_available_gb(&self) -> Option<u32> {
        self.mem_available_gb
    }

    /// `run/capacity.json` (schema 2), as the dispatcher reads it and the host report
    /// and every claim carry it.
    pub fn file(&self, at: &str) -> CapacityFile {
        CapacityFile {
            schema: FILE_SCHEMA,
            at: at.to_owned(),
            cpus: self.cpus,
            mem_gb: self.mem_gb,
            hardware: (self.hardware != (self.cpus, self.mem_gb)).then_some(Totals {
                cpus: self.hardware.0,
                mem_gb: self.hardware.1,
            }),
            page_kb: self.page_kb,
            disk_free_gb: DiskFree {
                work: self.disk_free_gb.work / DISK_STEP_GB * DISK_STEP_GB,
                engine: self.disk_free_gb.engine / DISK_STEP_GB * DISK_STEP_GB,
            },
            units: self.units,
            job_reserved: self.job_reserved,
            agent_slots: self.agent_slots,
            lanes: self.lanes(),
            held_lanes: self.held.clone(),
            isolation: self.isolation,
            dedicated: self.dedicated,
            limits: self.limits,
            below_minimum: self.below_minimum(),
        }
    }
}

/// One architecture the host runs: `native`, or `emulated` with how (`via`: `qemu`, or
/// `rosetta` — a Linux VM's binfmt handler, or a Mac's Colima VM started with
/// `--vz-rosetta`, #320) and whether the kernel's pages are larger than the guest's
/// (`page16k`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Lane {
    pub arch: String,
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page16k: Option<bool>,
}

/// `run/capacity.json`, schema 2 (design v2 §7.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CapacityFile {
    pub schema: u32,
    pub at: String,
    pub cpus: u32,
    pub mem_gb: u32,
    /// The detected totals, when the owner's caps lowered `cpus` or `mem_gb` (#328).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hardware: Option<Totals>,
    pub page_kb: u32,
    pub disk_free_gb: DiskFree,
    pub units: u32,
    pub job_reserved: u32,
    pub agent_slots: u32,
    pub lanes: Vec<Lane>,
    /// The foreign architectures this host does not run, and why (design v2 §17.2).
    pub held_lanes: Vec<emulation::Held>,
    pub isolation: Isolation,
    pub dedicated: bool,
    pub limits: Limits,
    pub below_minimum: bool,
}

/// A host's CPUs and memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Totals {
    pub cpus: u32,
    pub mem_gb: u32,
}

/// The units `cpus` and `mem_gb` give under the signed constants (design v2 §7.3): what is
/// left after the reserve, in whole units of CPU and memory, the smaller of the two, and
/// at most the owner's `max_units`. Detection counts them so, and so does a signed widening
/// of the envelope (#328, `run::settings::recount`), which therefore never gives more than
/// the constants and the detected hardware allow.
pub(crate) fn units_of(
    cpus: u32,
    mem_gb: u32,
    max_units: Option<u32>,
    c: &manifest::CapacityConstants,
) -> u32 {
    let usable_cpus = cpus.saturating_sub(c.reserve.cpus);
    let usable_mem = mem_gb.saturating_sub(c.reserve.mem_gb);
    // The constants are verified non-zero (manifest::Capacity::validate).
    let units = (usable_cpus / c.unit.cpus.max(1)).min(usable_mem / c.unit.mem_gb.max(1));
    max_units.map_or(units, |m| units.min(m))
}

/// What stops an install (design v2 §13.3, the capacity part): below the minimum, with
/// the numbers; limits the runtime cannot enforce; no unit left after the caps.
pub fn preflight(c: &Capacity) -> Vec<String> {
    let mut out: Vec<String> = c
        .shortfalls
        .iter()
        .map(|s| format!("below the minimum to join: {s}"))
        .collect();
    if c.isolation == Isolation::User && !c.limits.cgroup_v2 {
        out.push(
            "limits cannot be enforced: a rootless runtime needs cgroup v2 \
             (with systemd delegating cpu, memory and pids to the user)"
                .to_owned(),
        );
    } else if !c.limits.all() {
        let missing: Vec<&str> = [
            (c.limits.cpus_hard, "--cpus"),
            (c.limits.memory_hard, "--memory"),
            (c.limits.pids, "--pids-limit"),
        ]
        .iter()
        .filter(|(ok, _)| !ok)
        .map(|(_, f)| *f)
        .collect();
        let hint = if c.isolation == Isolation::User {
            " (a rootless runtime needs systemd to delegate cpu, memory and pids to the user)"
        } else {
            ""
        };
        out.push(format!(
            "limits cannot be enforced: this runtime ignores {}{hint}",
            missing.join(", ")
        ));
    }
    if !c.below_minimum() && c.units == 0 {
        out.push("no unit is left after the reserve and the owner's caps".to_owned());
    }
    out
}

/// What [`write_if_changed`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Written {
    /// The file is new or something in it changed: the run loop starts a rollout round.
    Changed,
    Unchanged,
}

/// Writes `<set dir>/run/capacity.json` only when something other than `at` changed,
/// atomically (a new file renamed over the old one). A file the run loop narrowed (#325)
/// is compared by its detected values; when detection changed, the new file goes in whole
/// and the loop narrows it again at its next tick. A `run/` or a `capacity.json` that is
/// a symbolic link is refused, never followed.
pub fn write_if_changed(set_dir: &Path, c: &Capacity, at: &str) -> std::io::Result<Written> {
    let run = set_dir.join("run");
    let path = run.join("capacity.json");
    for p in [&run, &path] {
        if std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(std::io::Error::other(format!(
                "{} is a symbolic link; not followed",
                p.display()
            )));
        }
    }
    let new = c.file(at);
    if let Ok(old) = std::fs::read(&path) {
        let mut same = serde_json::from_slice::<serde_json::Value>(&old).ok();
        if let Some(serde_json::Value::Object(m)) = same.as_mut() {
            m.insert("at".into(), serde_json::Value::String(at.to_owned()));
            // A file the run loop narrowed to the pool's settings (#325) is compared by what
            // it detected: the same detection leaves the narrowing in place.
            if let Some(serde_json::Value::Object(d)) = m.remove("detected") {
                m.extend(d);
            }
            m.remove("settings");
        }
        if same.as_ref() == Some(&serde_json::to_value(&new)?) {
            return Ok(Written::Unchanged);
        }
    }
    std::fs::create_dir_all(&run)?;
    let tmp = run.join(format!(".capacity.json.{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    serde_json::to_writer(&mut f, &new)?;
    f.write_all(b"\n")?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, &path)?;
    Ok(Written::Changed)
}

/// Now, as `run/capacity.json`'s `at`: RFC 3339, UTC, whole seconds.
pub fn now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    utc(secs)
}

/// Seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ` (civil from days, H. Hinnant).
pub(crate) fn utc(secs: u64) -> String {
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + u64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests;
