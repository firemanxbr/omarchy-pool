//! Reading the host (design v2 §7.1). Every probe either answers or fails the whole
//! detection with a reason: the run loop then changes nothing (an unanswered probe is
//! never read as "less capacity").
//!
//! Seam for the driver trait (#315, design v2 M6): the docker CLI here inherits the
//! agent's environment, so without `set.socket_cli` a `DOCKER_HOST` or `DOCKER_CONTEXT`
//! decides which engine is measured. The driver runs it under `env_clear()` with a short
//! allowlist and always passes `--host`; until then, give `socket_cli`.

use std::io::Read as _;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{DiskFree, Isolation, Lane, Limits, VmKind};

const GB: u64 = 1 << 30;
/// One engine call (design v2 §10: no call blocks longer than this).
const ENGINE_TIMEOUT: Duration = Duration::from_secs(60);
/// The probe container may pull its image first (install only).
const PROBE_TIMEOUT: Duration = Duration::from_secs(600);

/// The limits the probe container is started with, and what its cgroup must then show.
const PROBE_CPU_MAX: &str = "50000 100000";
const PROBE_MEMORY_MAX: &str = "67108864";
const PROBE_PIDS_MAX: &str = "32";

/// What the engine says about itself (`docker info`): the containers' view, right for a
/// rootful or rootless docker, podman's API socket and a VM alike.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[allow(clippy::struct_excessive_bools)] // docker info's own switches, one for one
pub struct Engine {
    pub cpus: u32,
    pub mem_bytes: u64,
    pub root_dir: String,
    pub arch: String,
    pub rootless: bool,
    pub userns: bool,
    pub cgroup_v2: bool,
    pub cpus_hard: bool,
    pub memory_hard: bool,
    pub pids: bool,
}

/// The agent's own cgroup limits (a VPS slice, a systemd slice with `CPUQuota` or
/// `MemoryMax`): the tightest along its cgroup's ancestors; `None` when unlimited.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct CgroupLimits {
    pub cpus: Option<u32>,
    pub mem_bytes: Option<u64>,
}

/// Everything detection read. Only [`detect`] builds it (and the tests), so a
/// [`super::Capacity`] always stands on probes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    pub(super) engine: Engine,
    pub(super) cgroup: CgroupLimits,
    pub(super) mem_available: Option<u64>,
    pub(super) page_size: u64,
    pub(super) disk_free: (u64, u64),
    pub(super) limits: Limits,
    /// The VM the engine runs in on macOS (#320); `None` on Linux.
    pub(super) vm: Option<VmKind>,
    /// Emulated lanes a smoke run turned on (a Mac's Rosetta lane, #320).
    pub(super) emulated: Vec<Lane>,
}

impl Facts {
    /// CPUs and memory (GB) before the owner's caps: the engine's view and the agent's
    /// cgroup limits, the smaller of each. The engine's `MemTotal` is the RAM the kernel
    /// manages, a little under the machine's nominal size, so it is rounded to the nearest
    /// GB (an "8 GB" VM reports about 7.7); a cgroup limit is exact, so it is rounded down.
    ///
    /// So an "8 GB" host meets the 8 GB minimum only while its `MemTotal` is at least
    /// 7.5 GiB; one that reserves more (a large crashkernel) reads as 7 and is below it.
    /// Should real hosts miss that line, the knob is the signed `min.mem_gb` and
    /// `reserve.mem_gb` in a release, not a tolerance here.
    pub fn totals(&self) -> (u32, u32) {
        let cpus = self
            .cgroup
            .cpus
            .map_or(self.engine.cpus, |c| c.min(self.engine.cpus));
        let engine_gb = gb((self.engine.mem_bytes + GB / 2) / GB);
        let mem_gb = self
            .cgroup
            .mem_bytes
            .map_or(engine_gb, |m| gb(m / GB).min(engine_gb));
        (cpus, mem_gb)
    }

    /// Free disk, whole GB rounded down: on the work root and on the engine's data root.
    pub fn disk_free_gb(&self) -> DiskFree {
        DiskFree {
            work: self.disk_free.0 / GB,
            engine: self.disk_free.1 / GB,
        }
    }

    pub fn mem_available_gb(&self) -> Option<u32> {
        self.mem_available.map(|b| gb(b / GB))
    }

    pub fn page_kb(&self) -> u32 {
        u32::try_from(self.page_size / 1024).unwrap_or(u32::MAX)
    }

    pub fn arch(&self) -> &str {
        &self.engine.arch
    }

    /// The level the host page shows (design v2 §19.3): the VM on macOS, else the engine's.
    pub fn isolation(&self) -> Isolation {
        match self.vm {
            Some(VmKind::Dedicated) => Isolation::Vm,
            Some(VmKind::Shared) => Isolation::VmShared,
            None => self.inner_isolation(),
        }
    }

    /// The engine's own level: inside the VM on macOS (`vm`, inside `root`).
    pub fn inner_isolation(&self) -> Isolation {
        if self.engine.userns {
            Isolation::Subuid
        } else if self.engine.rootless {
            Isolation::User
        } else {
            Isolation::Root
        }
    }

    /// The facts of an engine install found in a VM on macOS (#320): its level is the VM's,
    /// and this process's own cgroup and `MemAvailable` say nothing of the VM's (it has its
    /// own kernel): the engine's view and the VM's `/proc/meminfo` ([`Facts::with_meminfo`])
    /// stand.
    #[must_use]
    pub fn in_vm(mut self, kind: VmKind) -> Self {
        self.vm = Some(kind);
        self.cgroup = CgroupLimits::default();
        self.mem_available = None;
        self
    }

    /// An emulated lane `via` something, once its smoke run passed ([`rosetta_lane`]).
    #[must_use]
    pub fn with_lane(mut self, arch: &str, via: &'static str) -> Self {
        if arch != self.arch() && !self.emulated.iter().any(|l| l.arch == arch) {
            self.emulated.push(Lane {
                arch: arch.to_owned(),
                mode: "emulated",
                via: Some(via),
            });
        }
        self
    }

    pub fn vm(&self) -> Option<VmKind> {
        self.vm
    }

    /// `MemAvailable` from the VM's own `/proc/meminfo` on macOS (M7: the agent reads it
    /// inside the `omarchy` profile), where this process has none to read.
    #[must_use]
    pub fn with_meminfo(mut self, meminfo: &str) -> Self {
        if let Some(m) = mem_available(meminfo) {
            self.mem_available = Some(m);
        }
        self
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// A rootless runtime: no root daemon behind the socket (install's `rootful_ack`, #317).
    pub fn rootless(&self) -> bool {
        self.engine.rootless
    }

    /// The facts as `omarchy-agent capacity` prints them without a release.
    pub fn report(&self) -> serde_json::Value {
        let (cpus, mem_gb) = self.totals();
        serde_json::json!({
            "cpus": cpus,
            "mem_gb": mem_gb,
            "mem_available_gb": self.mem_available_gb(),
            "page_kb": self.page_kb(),
            "disk_free_gb": self.disk_free_gb(),
            "arch": self.arch(),
            "isolation": self.isolation(),
            "limits": self.limits,
            "cgroup_v2": self.limits.cgroup_v2,
            "engine": {
                "cpus": self.engine.cpus,
                "mem_gb": gb((self.engine.mem_bytes + GB / 2) / GB),
                "root_dir": self.engine.root_dir,
            },
            "cgroup": {
                "cpus": self.cgroup.cpus,
                "mem_gb": self.cgroup.mem_bytes.map(|m| gb(m / GB)),
            },
        })
    }
}

fn gb(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// How to reach the engine and the host.
#[derive(Debug, Clone)]
pub struct Probe<'a> {
    /// The docker CLI (the pinned one once install places it, #317).
    pub docker: &'a str,
    /// `unix://<path>` of the engine's socket, when not the CLI's default.
    pub host: Option<&'a str>,
    pub work_root: &'a Path,
    /// An image to start the probe container from (the release's build image by digest):
    /// it checks that `--cpus`, `--memory` and `--pids-limit` land in the task's cgroup,
    /// and measures the engine's data root when this process cannot see it (rootless in a
    /// VM). `None` trusts `docker info`'s own answer for the limits, which podman's API
    /// gets wrong for `--cpus`: install and the run loop pass the release's build image.
    pub image: Option<&'a str>,
}

impl Probe<'_> {
    fn docker(&self) -> Command {
        let mut c = Command::new(self.docker);
        if let Some(h) = self.host {
            c.args(["--host", h]);
        }
        c
    }
}

/// Reads everything §7.1 lists, or says what did not answer.
pub fn detect(p: &Probe<'_>) -> Result<Facts, String> {
    let engine = engine(p)?;
    let cgroup = std::fs::read_to_string("/proc/self/cgroup")
        .map(|s| cgroup_limits(Path::new("/sys/fs/cgroup"), &s))
        .unwrap_or_default();
    let mem_available = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| mem_available(&s));
    let work = free_bytes(p.work_root)
        .map_err(|e| format!("free disk on the work root {}: {e}", p.work_root.display()))?;

    let mut limits = Limits {
        cpus_hard: engine.cpus_hard,
        memory_hard: engine.memory_hard,
        pids: engine.pids,
        cgroup_v2: engine.cgroup_v2,
    };
    // The probe container runs on the engine's kernel and its root lives on the engine's
    // data root: what it measures wins over this process's view, which is another
    // machine's when the engine is in a VM (Colima's 4K pages under macOS's 16K, a
    // leftover /var/lib/docker here).
    let mut engine_free = None;
    let mut page_size = None;
    if let Some(image) = p.image {
        // A limited run that fails may have failed for a reason of its own (a pull, the
        // registry, the deadline). The unlimited run then answers, so the image is here
        // and the engine is up: a limited run that still fails is the runtime refusing the
        // limits (rootless podman without delegation). Refused both ways: no answer.
        let out = if let Ok(out) = probe_container(p, image, true) {
            Ok(out)
        } else {
            let unlimited = probe_container(p, image, false)?;
            probe_container(p, image, true).map_err(|_| unlimited)
        };
        let out = match out {
            Ok(out) => {
                // What the task's cgroup shows is the answer; `docker info` only where the
                // file is not there to read (cgroup v1). Podman's API, for one, reports
                // `CpuCfsQuota: false` while `--cpus` lands.
                let seen = probe_limits(&out);
                limits.cpus_hard = seen.0.unwrap_or(limits.cpus_hard);
                limits.memory_hard = seen.1.unwrap_or(limits.memory_hard);
                limits.pids = seen.2.unwrap_or(limits.pids);
                out
            }
            Err(out) => {
                limits.cpus_hard = false;
                limits.memory_hard = false;
                limits.pids = false;
                out
            }
        };
        engine_free = df_free(&out);
        page_size = probe_page_size(&out);
    }
    let root = Path::new(&engine.root_dir);
    let engine_free = engine_free
        .or_else(|| {
            (root.is_absolute() && root.is_dir())
                .then(|| free_bytes(root).ok())
                .flatten()
        })
        .ok_or_else(|| {
            format!(
                "free disk on the engine's data root {:?}: not visible from here, and no probe \
             container measured it",
                engine.root_dir
            )
        })?;
    Ok(Facts {
        engine,
        cgroup,
        mem_available,
        page_size: page_size.unwrap_or(rustix::param::page_size() as u64),
        disk_free: (work, engine_free),
        limits,
        vm: None,
        emulated: Vec::new(),
    })
}

/// The smoke run of an `x86_64` lane through Rosetta (design v2 §7.5 step 2, §19.2; #320):
/// the release's `x86_64` build image, by digest, starts `/usr/bin/true` and answers
/// `pacman --version` on `linux/amd64`. In a Colima VM started with `--vz-rosetta` the
/// engine runs it through Rosetta, on the VM's 4K pages.
pub fn rosetta_lane(p: &Probe<'_>, image_x86_64: &str) -> Result<(), String> {
    let mut c = p.docker();
    c.args([
        "run",
        "--rm",
        "--network",
        "none",
        "--platform",
        "linux/amd64",
        "--entrypoint",
        "sh",
        image_x86_64,
        "-c",
        "/usr/bin/true && pacman --version >/dev/null",
    ]);
    run(c, PROBE_TIMEOUT)
        .map(drop)
        .map_err(|e| format!("the x86_64 smoke run: {e}"))
}

/// `docker info` (the driver's `capacity()` once the driver trait exists, #315).
pub fn engine(p: &Probe<'_>) -> Result<Engine, String> {
    let mut c = p.docker();
    c.args(["info", "--format", "{{json .}}"]);
    let out = run(c, ENGINE_TIMEOUT).map_err(|e| format!("docker info: {e}"))?;
    parse_info(&out)
}

#[derive(Deserialize)]
struct InfoRaw {
    #[serde(rename = "NCPU", default)]
    ncpu: u32,
    #[serde(rename = "MemTotal", default)]
    mem_total: u64,
    #[serde(rename = "DockerRootDir", default)]
    root_dir: String,
    #[serde(rename = "Architecture", default)]
    arch: String,
    #[serde(rename = "SecurityOptions", default)]
    security_options: Option<Vec<String>>,
    #[serde(rename = "CgroupVersion", default)]
    cgroup_version: String,
    #[serde(rename = "MemoryLimit", default)]
    memory_limit: bool,
    #[serde(rename = "CpuCfsQuota", default)]
    cpu_cfs_quota: bool,
    #[serde(rename = "PidsLimit", default)]
    pids_limit: bool,
}

pub(super) fn parse_info(json: &str) -> Result<Engine, String> {
    let raw: InfoRaw =
        serde_json::from_str(json.trim()).map_err(|e| format!("docker info: {e}"))?;
    if raw.ncpu == 0 || raw.mem_total == 0 {
        return Err("docker info: no NCPU or MemTotal (is the engine answering?)".into());
    }
    let arch = match raw.arch.as_str() {
        "aarch64" | "arm64" => "aarch64",
        "x86_64" | "amd64" => "x86_64",
        other => {
            return Err(format!(
                "docker info: architecture {other:?} is not one the pool builds"
            ))
        }
    };
    let opts = raw.security_options.unwrap_or_default();
    let has = |name: &str| {
        opts.iter()
            .any(|o| o.split(',').any(|kv| kv == format!("name={name}")))
    };
    Ok(Engine {
        cpus: raw.ncpu,
        mem_bytes: raw.mem_total,
        root_dir: raw.root_dir,
        arch: arch.to_owned(),
        rootless: has("rootless"),
        userns: has("userns"),
        cgroup_v2: raw.cgroup_version == "2",
        cpus_hard: raw.cpu_cfs_quota,
        memory_hard: raw.memory_limit,
        pids: raw.pids_limit,
    })
}

/// The tightest `cpu.max` and `memory.max` from the agent's cgroup up to the root, as
/// `/proc/self/cgroup` names it (cgroup v2: `0::/path`). Anything else reads as no limit.
pub(super) fn cgroup_limits(root: &Path, proc_self_cgroup: &str) -> CgroupLimits {
    let Some(rel) = proc_self_cgroup
        .lines()
        .find_map(|l| l.strip_prefix("0::"))
        .map(str::trim)
    else {
        return CgroupLimits::default();
    };
    let rel = PathBuf::from(rel.trim_start_matches('/'));
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return CgroupLimits::default();
    }
    let mut out = CgroupLimits::default();
    let mut dir = root.join(rel);
    loop {
        if let Some(c) = std::fs::read_to_string(dir.join("cpu.max"))
            .ok()
            .and_then(|s| cpu_max(&s))
        {
            out.cpus = Some(out.cpus.map_or(c, |o| o.min(c)));
        }
        if let Some(m) = std::fs::read_to_string(dir.join("memory.max"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
        {
            out.mem_bytes = Some(out.mem_bytes.map_or(m, |o| o.min(m)));
        }
        if dir == root || !dir.pop() || !dir.starts_with(root) {
            break;
        }
    }
    out
}

/// `cpu.max`: `max <period>` is unlimited; `<quota> <period>` is quota/period CPUs,
/// rounded down.
fn cpu_max(s: &str) -> Option<u32> {
    let mut it = s.split_whitespace();
    let quota: u64 = it.next()?.parse().ok()?;
    let period: u64 = it.next()?.parse().ok()?;
    (period > 0).then(|| gb(quota / period))
}

pub(crate) fn mem_available(meminfo: &str) -> Option<u64> {
    let line = meminfo.lines().find(|l| l.starts_with("MemAvailable:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

fn free_bytes(path: &Path) -> Result<u64, String> {
    let s = rustix::fs::statvfs(path).map_err(|e| e.to_string())?;
    Ok(s.f_bavail.saturating_mul(s.f_frsize))
}

/// The probe container: its cgroup's three limits, the engine kernel's page size, then
/// `df` of its root (which lives on the engine's data root).
fn probe_container(p: &Probe<'_>, image: &str, limited: bool) -> Result<String, String> {
    let mut c = p.docker();
    c.args(["run", "--rm", "--network", "none"]);
    if limited {
        c.args(["--cpus", "0.5", "--memory", "64m", "--pids-limit", "32"]);
    }
    c.args(["--entrypoint", "sh", image, "-c"]).arg(
        "for f in cpu.max memory.max pids.max; do printf '%s=' $f; \
         cat /sys/fs/cgroup/$f 2>/dev/null || echo; done; \
         printf 'pagesize='; getconf PAGESIZE 2>/dev/null || echo; df -Pk / | tail -n 1",
    );
    run(c, PROBE_TIMEOUT).map_err(|e| format!("probe container: {e}"))
}

/// What the probe container's cgroup showed for each limit: `None` when the file is not
/// there to read (cgroup v1), so only `docker info`'s answer counts.
pub(super) fn probe_limits(out: &str) -> (Option<bool>, Option<bool>, Option<bool>) {
    let get = |name: &str, want: &str| probe_value(out, name).map(|v| v == want);
    (
        get("cpu.max=", PROBE_CPU_MAX),
        get("memory.max=", PROBE_MEMORY_MAX),
        get("pids.max=", PROBE_PIDS_MAX),
    )
}

/// The engine kernel's page size, as the probe container's `getconf` printed it; `None`
/// when the image has no `getconf`.
pub(super) fn probe_page_size(out: &str) -> Option<u64> {
    probe_value(out, "pagesize=")?
        .parse()
        .ok()
        .filter(|&n: &u64| n > 0)
}

fn probe_value<'a>(out: &'a str, name: &str) -> Option<&'a str> {
    let v = out.lines().find_map(|l| l.strip_prefix(name))?.trim();
    (!v.is_empty()).then_some(v)
}

/// The last line of `df -Pk /`: the fourth column is the space available, in KB.
pub(super) fn df_free(out: &str) -> Option<u64> {
    let line = out.lines().rev().find(|l| !l.trim().is_empty())?;
    let kb: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(kb * 1024)
}

/// Runs a command with a deadline, killing it when the deadline passes; its stdout.
/// Install's engine calls (#317) go through it too.
pub(crate) fn run(mut c: Command, timeout: Duration) -> Result<String, String> {
    let mut child = c
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let out = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = stdout.read_to_end(&mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = stderr.read_to_end(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("no answer in {} s", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    if !status.success() {
        let e = String::from_utf8_lossy(&err);
        let e = e.trim();
        return Err(format!(
            "{status}{}",
            if e.is_empty() {
                String::new()
            } else {
                format!(": {}", e.chars().take(300).collect::<String>())
            }
        ));
    }
    String::from_utf8(out).map_err(|_| "output is not UTF-8".to_owned())
}

#[cfg(test)]
impl Facts {
    /// Facts as a probe of the given host would read them.
    pub(super) fn for_test(
        engine: Engine,
        cgroup: CgroupLimits,
        disk_free_gb: (u64, u64),
        limits: Limits,
    ) -> Self {
        Facts {
            engine,
            cgroup,
            mem_available: None,
            page_size: 4096,
            disk_free: (disk_free_gb.0 * GB, disk_free_gb.1 * GB),
            limits,
            vm: None,
            emulated: Vec::new(),
        }
    }
}
