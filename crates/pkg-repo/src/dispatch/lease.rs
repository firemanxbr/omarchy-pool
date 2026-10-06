//! One file per lease (design v2 §9.8, D37): `work/state/leases/<id>-<gen>.json`,
//! 0600, in a 0700 directory no task container ever mounts. It holds what a
//! new dispatcher needs to carry the lease on — the task, its generation,
//! its job token, its units, its release, the last heartbeat the pool
//! accepted, where the lease stands — and is rewritten whole (a temporary
//! file renamed over it) at every change, so a crash leaves the old or the
//! new one, never half of either.

use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::work::Task;

/// Where a lease stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Its inputs are being staged (and, for a trial, the lab published); no container yet.
    Preparing,
    /// Its container was started.
    Running,
    /// Its container exited: its outputs are being checked, uploaded and reported.
    Finishing,
}

/// Why the dispatcher ends a lease itself, written before it kills anything:
/// a dispatcher that dies between the kill and the report finishes the job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "why", content = "detail")]
pub enum Ending {
    /// The pool took it back (409 `stop`, 404): killed, reported failed as stopped.
    Stopped(String),
    /// Its lease expired here (no heartbeat accepted for the lease and the grace): killed, nothing reported.
    Expired,
    /// A host event (the disk watcher, a container the engine lost): killed, reported `lost`.
    Lost(String),
    /// Its release is revoked (#342): killed, reported `revoked` (and `lost`, which a pool from
    /// before #342 reads as a host event); the pool takes nothing of it and requeues it. A
    /// dispatcher from before #342 cannot read a lease file that says so: it removes the
    /// container, which was being killed anyway, and the pool requeues the lease.
    Revoked(String),
}

/// The lane a lease runs on (#338, design v2 §7.4, §7.5): the architecture of its
/// container (`--platform linux/<arch>`), and whether this host runs it emulated — then,
/// and only then, the container is told so (`WORKER_LABELS={"emulated":true}`), and its
/// build probes the toolchains a recipe installs. A build or a trial runs the task's
/// architecture on the lane the pool leased; an audit, which reads its build as data, the
/// host's own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lane {
    pub arch: String,
    pub emulated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lease {
    pub task: Task,
    pub gen: String,
    /// The job token of this lease; the heartbeat renews it.
    pub token: String,
    pub units: u32,
    /// A build's disk budget in GB (0 for the other kinds).
    pub disk_gb: u64,
    /// The release the lease was claimed on: its checkout is the one the container mounts.
    pub release: String,
    /// A contributor's staging workspace was full at claim time.
    #[serde(default)]
    pub staging_full: bool,
    /// Seconds since the epoch.
    pub claimed_at: u64,
    pub last_beat: u64,
    #[serde(default)]
    pub started_at: Option<u64>,
    pub phase: Phase,
    #[serde(default)]
    pub ending: Option<Ending>,
    /// What a kind's preparation leaves for its finish (a trial's packages and rendered databases).
    #[serde(default)]
    pub notes: serde_json::Value,
    /// Its network's /28 of the task subnets, once it was given one (#336).
    #[serde(default)]
    pub net_slot: Option<u32>,
    /// The calls its agent sidecar may make, set aside from the day's budget while it runs (#336, D45).
    #[serde(default)]
    pub agent_calls: Option<u32>,
    /// Its lane (#338); a lease file from before lanes runs the task's architecture, natively.
    #[serde(default)]
    pub lane: Option<Lane>,
}

impl Lease {
    pub fn key(&self) -> (u64, String) {
        (self.task.id, self.gen.clone())
    }

    /// The architecture its container runs.
    pub fn arch(&self) -> &str {
        self.lane.as_ref().map_or(&self.task.arch, |l| &l.arch)
    }

    /// Whether it runs on an emulated lane.
    pub fn emulated(&self) -> bool {
        self.lane.as_ref().is_some_and(|l| l.emulated)
    }
}

/// The directory of lease files.
pub struct Store {
    dir: PathBuf,
}

/// What reading the directory found: the leases, and the files it could not read.
pub struct Found {
    pub leases: Vec<Lease>,
    pub unreadable: Vec<PathBuf>,
}

impl Store {
    pub fn open(work_root: &Path) -> std::io::Result<Self> {
        let dir = work_root.join("state").join("leases");
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(
            work_root.join("state"),
            std::fs::Permissions::from_mode(0o700),
        )?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self { dir })
    }

    fn path(&self, id: u64, gen: &str) -> PathBuf {
        self.dir.join(format!("{id}-{gen}.json"))
    }

    /// Writes the lease whole: 0600, renamed over the old file.
    pub fn save(&self, l: &Lease) -> std::io::Result<()> {
        let path = self.path(l.task.id, &l.gen);
        let tmp = path.with_extension("json.tmp");
        let _ = std::fs::remove_file(&tmp);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(l).map_err(std::io::Error::other)?)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, &path)
    }

    pub fn remove(&self, id: u64, gen: &str) {
        let _ = std::fs::remove_file(self.path(id, gen));
    }

    /// Every lease file: the ones that read, and the ones that do not (a
    /// dispatcher that cannot read a lease cannot report it; its container
    /// goes, and the pool requeues the lease when the claims stop listing it).
    pub fn load(&self) -> std::io::Result<Found> {
        let mut found = Found {
            leases: Vec::new(),
            unreadable: Vec::new(),
        };
        let mut paths: Vec<PathBuf> = std::fs::read_dir(&self.dir)?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .collect();
        paths.sort();
        for p in paths {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let ext = p.extension().and_then(|e| e.to_str());
            if ext == Some("tmp") && name.contains(".json") {
                let _ = std::fs::remove_file(&p);
                continue;
            }
            if ext != Some("json") {
                continue;
            }
            let read = std::fs::read(&p)
                .ok()
                .and_then(|b| serde_json::from_slice::<Lease>(&b).ok())
                .filter(|l| p == self.path(l.task.id, &l.gen));
            match read {
                Some(l) => found.leases.push(l),
                None => found.unreadable.push(p),
            }
        }
        Ok(found)
    }

    /// The lease a file's name says it was, for a file that does not read.
    pub fn named(path: &Path) -> Option<(u64, String)> {
        let stem = path.file_name()?.to_string_lossy();
        let stem = stem.strip_suffix(".json")?;
        let (id, gen) = stem.split_once('-')?;
        let id = id.parse().ok()?;
        super::spec::gen_ok(gen).then(|| (id, gen.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn lease(id: u64, gen: &str) -> Lease {
        Lease {
            task: serde_json::from_value(serde_json::json!({"id": id, "kind": "build", "name": "felix", "arch": "aarch64", "trust": "community", "pkgbuild_ref": "https://x@v1:PKGBUILD"})).unwrap(),
            gen: gen.into(),
            token: "omj.secret".into(),
            units: 2,
            disk_gb: 20,
            release: "v1.2.3".into(),
            staging_full: false,
            claimed_at: 10,
            last_beat: 10,
            started_at: None,
            phase: Phase::Preparing,
            ending: None,
            notes: serde_json::Value::Null,
            net_slot: None,
            agent_calls: None,
            lane: None,
        }
    }

    #[test]
    fn a_lease_keeps_its_lane_and_one_from_before_lanes_runs_its_task_natively() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let mut emulated = lease(7, "g_0123456789abcdef");
        emulated.task.arch = "x86_64".into();
        emulated.lane = Some(Lane {
            arch: "x86_64".into(),
            emulated: true,
        });
        store.save(&emulated).unwrap();
        let back = &store.load().unwrap().leases[0];
        assert_eq!((back.arch(), back.emulated()), ("x86_64", true));
        // A P1 dispatcher's lease file has no lane: its task's architecture, natively.
        let file = dir.path().join("state/leases/7-g_0123456789abcdef.json");
        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        json.as_object_mut().unwrap().remove("lane");
        std::fs::write(&file, json.to_string()).unwrap();
        let back = &store.load().unwrap().leases[0];
        assert_eq!((back.arch(), back.emulated()), ("x86_64", false));
    }

    #[test]
    fn a_lease_file_is_private_whole_and_read_back() {
        let t = tempfile::tempdir().unwrap();
        let s = Store::open(t.path()).unwrap();
        let mut l = lease(7, "g_0123456789abcdef");
        s.save(&l).unwrap();
        l.phase = Phase::Running;
        l.ending = Some(Ending::Stopped("cancelled".into()));
        s.save(&l).unwrap();
        let p = t.path().join("state/leases/7-g_0123456789abcdef.json");
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(t.path().join("state/leases"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        std::fs::write(
            t.path().join("state/leases/8-g_1111111111111111.json"),
            b"{not json",
        )
        .unwrap();
        std::fs::write(
            t.path().join("state/leases/9-g_2222222222222222.json.tmp"),
            b"half",
        )
        .unwrap();
        let found = s.load().unwrap();
        assert_eq!(found.leases.len(), 1);
        assert_eq!(found.leases[0].phase, Phase::Running);
        assert_eq!(
            found.leases[0].ending,
            Some(Ending::Stopped("cancelled".into()))
        );
        assert_eq!(found.unreadable.len(), 1);
        assert_eq!(
            Store::named(&found.unreadable[0]),
            Some((8, "g_1111111111111111".into()))
        );
        assert!(!t
            .path()
            .join("state/leases/9-g_2222222222222222.json.tmp")
            .exists());
        s.remove(7, "g_0123456789abcdef");
        assert!(s.load().unwrap().leases.is_empty());
    }

    #[test]
    fn a_file_under_another_leases_name_is_not_read_as_it() {
        let t = tempfile::tempdir().unwrap();
        let s = Store::open(t.path()).unwrap();
        let l = lease(7, "g_0123456789abcdef");
        std::fs::write(
            t.path().join("state/leases/9-g_0123456789abcdef.json"),
            serde_json::to_vec(&l).unwrap(),
        )
        .unwrap();
        let found = s.load().unwrap();
        assert!(found.leases.is_empty());
        assert_eq!(found.unreadable.len(), 1);
    }
}
