//! What the dispatcher knows of its host's capacity: the release's signed
//! constants (factory/bundle/manifest.toml, compiled in, as the pool reads
//! the same file: worker/src/hosts.ts) and the agent's `run/capacity.json`
//! (schema 2, #333), read read-only before every claim.
//!
//! Seams: the agent's run loop (#315) refreshes the file; its free engine
//! disk is the agent's last probe, in 10 GB steps, so the disk watcher's
//! engine value is only as fresh as that: it kills on it once per probe (the
//! file's `at`), never twice on the same value (the work root it measures
//! itself, with statvfs, at every turn of the loop).

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

/// The signed release's manifest, as built into this binary.
const MANIFEST: &str = include_str!("../../../../factory/bundle/manifest.toml");

/// The constants the dispatcher needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Constants {
    /// One capacity unit.
    pub unit_cpus: u32,
    pub unit_mem_gb: u32,
    /// Free disk below this, on the work root or the engine's data root, stops claims and starts the disk watcher.
    pub floor_gb: u64,
    /// The units of the largest task the pool may hand: a build of the signed maximum size (#337). Memory is checked against it
    /// before a claim.
    pub largest_task_units: u32,
}

#[derive(Deserialize)]
struct Manifest {
    capacity: Cap,
}
#[derive(Deserialize)]
struct Cap {
    max_size: u32,
    unit: Unit,
    units: Units,
    disk: Disk,
}
#[derive(Deserialize)]
struct Units {
    build_per_size: u32,
}
#[derive(Deserialize)]
struct Unit {
    cpus: u32,
    mem_gb: u32,
}
#[derive(Deserialize)]
struct Disk {
    floor_gb: u64,
}

impl Constants {
    /// The constants of this release.
    ///
    /// # Panics
    /// When the manifest built into this binary does not read: a broken build, which the tests catch.
    pub fn signed() -> Self {
        let m: Manifest = toml::from_str(MANIFEST).expect("factory/bundle/manifest.toml reads");
        assert!(m.capacity.unit.cpus > 0 && m.capacity.unit.mem_gb > 0);
        Self {
            unit_cpus: m.capacity.unit.cpus,
            unit_mem_gb: m.capacity.unit.mem_gb,
            floor_gb: m.capacity.disk.floor_gb,
            largest_task_units: m.capacity.units.build_per_size * m.capacity.max_size.max(1),
        }
    }

    /// The units a claim may offer now (design v2 §7.6): what its units leave beside its leases and the
    /// job unit, and — when `MemAvailable` is below the largest task it could receive — only what the
    /// memory available still holds, so a host another workload is using claims what still fits, or
    /// nothing. `None` (no `/proc/meminfo`) leaves the units alone.
    pub fn offer(&self, room: u32, mem_available_gb: Option<u64>) -> u32 {
        let Some(mem) = mem_available_gb else {
            return room;
        };
        let largest = room.min(self.largest_task_units);
        if mem >= u64::from(largest) * u64::from(self.unit_mem_gb) {
            return room;
        }
        u32::try_from(mem / u64::from(self.unit_mem_gb.max(1)))
            .unwrap_or(u32::MAX)
            .min(room)
    }

    /// A lease's share: its units' CPUs and memory.
    pub fn share(&self, units: u32) -> (u32, u32) {
        let units = units.max(1);
        (units * self.unit_cpus, units * self.unit_mem_gb)
    }
}

/// `run/capacity.json` as far as the dispatcher reads it; the whole file goes with the claim.
#[derive(Debug, Clone)]
pub struct File {
    /// When the agent probed: a new value is a new probe.
    pub at: String,
    pub units: u32,
    pub job_reserved: u32,
    pub below_minimum: bool,
    /// The native lane's architecture.
    pub arch: String,
    pub engine_free_gb: u64,
    /// The claim's `capacity`, as the pool reads it (worker/src/hosts.ts parseCapacity).
    pub claim: Value,
}

/// Reads the agent's file; `None` when it is missing or not schema 2 (the dispatcher then claims nothing).
pub fn read(path: &Path) -> Option<File> {
    let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if v.get("schema").and_then(Value::as_u64) != Some(2) {
        return None;
    }
    let n = |k: &str| v.get(k).and_then(Value::as_u64);
    let units = u32::try_from(n("units")?).ok()?;
    let job_reserved = u32::try_from(n("job_reserved").unwrap_or(0)).ok()?;
    let lanes = v.get("lanes")?.as_array()?;
    let arch = lanes
        .iter()
        .find(|l| l.get("mode").and_then(Value::as_str) == Some("native"))?
        .get("arch")?
        .as_str()?
        .to_owned();
    let disk = v.get("disk_free_gb")?;
    let claim = serde_json::json!({
        "cpus": v.get("cpus")?, "mem_gb": v.get("mem_gb")?,
        "disk_free_gb": { "work": disk.get("work")?, "engine": disk.get("engine")? },
        "units": units, "job_reserved": job_reserved,
        "agent_slots": v.get("agent_slots").cloned().unwrap_or(Value::from(0)),
        "lanes": lanes,
    });
    Some(File {
        at: v
            .get("at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        units,
        job_reserved,
        below_minimum: v
            .get("below_minimum")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        arch,
        engine_free_gb: disk.get("engine")?.as_u64()?,
        claim,
    })
}

/// Free GB on the filesystem that holds `path` (statvfs), for the unprivileged user.
pub fn free_gb(path: &Path) -> Option<u64> {
    let s = rustix::fs::statvfs(path).ok()?;
    Some(s.f_bavail.saturating_mul(s.f_frsize) / (1 << 30))
}

/// `MemAvailable` in GB, where the kernel says it (Linux); `None` elsewhere.
pub fn mem_available_gb() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb: u64 = text
        .lines()
        .find_map(|l| l.strip_prefix("MemAvailable:"))?
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .ok()?;
    Some(kb / (1 << 20))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_signed_constants_are_the_manifests() {
        let c = Constants::signed();
        assert_eq!(
            c,
            Constants {
                unit_cpus: 1,
                unit_mem_gb: 2,
                floor_gb: 10,
                largest_task_units: 8
            }
        );
        assert_eq!(c.share(4), (4, 8));
        assert_eq!(c.share(0), (1, 2));
    }

    #[test]
    fn a_claim_offers_what_the_memory_available_still_holds() {
        let c = Constants::signed();
        // Memory for the largest task it could receive (a size-4 build, 8 units, 16 GB): every free unit.
        assert_eq!(c.offer(10, Some(16)), 10);
        assert_eq!(c.offer(10, Some(64)), 10);
        // Three free units: the largest it could receive is 3 units, 6 GB.
        assert_eq!(c.offer(3, Some(6)), 3);
        // Another workload holds the machine: only what fits, or nothing.
        assert_eq!(c.offer(10, Some(9)), 4);
        assert_eq!(c.offer(10, Some(1)), 0);
        assert_eq!(c.offer(0, Some(64)), 0);
        // No /proc/meminfo (a VM's view comes later): the units decide.
        assert_eq!(c.offer(10, None), 10);
    }

    #[test]
    fn the_agents_file_and_the_claim_it_gives() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("capacity.json");
        assert!(read(&p).is_none());
        std::fs::write(&p, r#"{"schema":2,"at":"2026-10-01T00:00:00Z","cpus":12,"mem_gb":32,"page_kb":16,"disk_free_gb":{"work":200,"engine":150},"units":11,"job_reserved":1,"agent_slots":1,"lanes":[{"arch":"aarch64","mode":"native"}],"isolation":"root","dedicated":true,"limits":{"cpus_hard":true,"memory_hard":true,"pids":true},"below_minimum":false}"#).unwrap();
        let f = read(&p).unwrap();
        assert_eq!(
            (
                f.units,
                f.job_reserved,
                f.below_minimum,
                f.arch.as_str(),
                f.engine_free_gb
            ),
            (11, 1, false, "aarch64", 150)
        );
        assert_eq!(f.claim["disk_free_gb"]["work"], 200);
        assert_eq!(f.claim["lanes"][0]["mode"], "native");
        std::fs::write(&p, r#"{"schema":1,"units":3}"#).unwrap();
        assert!(read(&p).is_none(), "another schema: nothing is guessed");
    }
}
