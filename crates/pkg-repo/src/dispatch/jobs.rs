//! Pool jobs in the dispatcher (#340, design v2 §7.3, §7.4, §9.2; D34): the
//! jobs that move the rings — sync, render, promote, rollback, security, gc,
//! verify, relayout, enqueue, publish and health — are signed release code,
//! trusted like the dispatcher itself, and run as `pkg-repo work` runs them
//! (`work.rs` `execute`), with their job token: they post events, and their
//! scripts get it, as today. Each runs in a child process of the dispatcher
//! (`pkg-repo pool-job`, in a process group of its own), so a crash or a hang
//! of one never stops the loop or another lease's heartbeats:
//!
//! - **its memory**: the child sets a 2 GB data rlimit on itself before it
//!   runs anything (`setrlimit`, no `unsafe`); its scripts and their helpers'
//!   clients inherit it;
//! - **its time**: a per-kind timeout from its start; past it the dispatcher
//!   kills the job's whole process group and the helper containers labelled
//!   with its lease, and fails it (not final: the pool retries it within its
//!   attempts);
//! - **its end**: the child writes `result.json` in its directory (what the
//!   job returned, or its failure as `pkg-repo work` reports it); the
//!   dispatcher reports it with the lease's job token, after the child is
//!   gone. A child that ended without one (a signal: a crash, or its memory
//!   limit) fails the job with how it ended.
//!
//! **One at a time, on the reserved unit.** One unit of the host is kept for
//! pool jobs (the pool enforces it from its own leases, #337), and the
//! dispatcher runs one pool job at a time in it — the claim lists the pool's
//! kinds only while no job is held — so the jobs share one work directory
//! (`<work root>/jobs`: keyrings, the sync's scratch, the ABI gate's cached
//! Omarchy reference), as a legacy pool worker's did. Its scripts' scratch
//! directories are the lease's own (`<task dir>/tmp`, their `TMPDIR`).
//!
//! **Arch-neutral** (§7.4): every pool job runs in the dispatcher's own
//! native process, whatever its row's arch (today's `pool-x86_64` is the
//! native aarch64 image registered for `x86_64`). Only the helper containers
//! of `health`, `promote` and `security` run a ring's architecture: through
//! the `omarchy-task-run` shim ([`super::shim`]) on a lane of it, native or
//! emulated, and only those kinds get a /28 for them.
//!
//! **Across a restart** the child does not survive its dispatcher (it lives
//! in the dispatcher's container): a job that was running is failed `lost`
//! (its attempt given back, bounded), one that had written its result is
//! reported from it.

use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::work::{self, Task, WorkOptions};

/// The kinds a host runs as pool jobs (design v2§7.4, §9.2). `metrics` is the pool's own (its cron), never a task.
pub const POOL_KINDS: [&str; 11] = [
    "sync", "render", "promote", "rollback", "security", "gc", "verify", "relayout", "enqueue",
    "publish", "health",
];
/// The pool jobs whose scripts start helper containers of a ring's architecture (selection.ts
/// `helperArches`): the health check, a promotion's ABI gates and health checks, the fast-track's.
pub const HELPER_KINDS: [&str; 3] = ["health", "promote", "security"];
/// A job's data rlimit: its heap, and its scripts' (design v2 §9.2).
pub const MEM_LIMIT: u64 = 2 << 30;
/// The architectures a ring serves.
const RING_ARCHES: [&str; 2] = ["x86_64", "aarch64"];

/// The files of a job's directory.
pub const SPEC_FILE: &str = "job.json";
pub const TOKEN_FILE: &str = "token";
pub const RESULT_FILE: &str = "result.json";
pub const CONTEXT_FILE: &str = "helper.json";

pub fn is_job(kind: &str) -> bool {
    POOL_KINDS.contains(&kind)
}

pub fn has_helpers(kind: &str) -> bool {
    HELPER_KINDS.contains(&kind)
}

/// How long a job may run, from its start: generous against its longest real runs, and below the
/// three hours between two scheduled syncs or security runs, so a hung one never meets the next.
pub fn timeout(kind: &str) -> Duration {
    let min = match kind {
        "render" | "rollback" | "enqueue" => 30,
        "health" => 45,
        "sync" | "security" => 150,
        // Health of both arches, before and after, and two ABI gates — an Omarchy reference rebuilt
        // once a week, under emulation on an aarch64 host.
        "promote" => 180,
        "verify" | "relayout" => 240,
        // gc, publish
        _ => 60,
    };
    Duration::from_secs(min * 60)
}

/// The architectures a job's helper containers run (selection.ts `helperArches`): a health
/// check's ring arch, a promotion's (`params.arch`, or both), the fast-track's both; none for
/// every other kind.
pub fn helper_arches(task: &Task) -> Vec<String> {
    let named = task
        .params
        .get("arch")
        .and_then(Value::as_str)
        .filter(|a| RING_ARCHES.contains(a));
    let both = || RING_ARCHES.iter().map(|a| (*a).to_owned()).collect();
    match task.kind.as_str() {
        "health" => vec![named.unwrap_or(&task.arch).to_owned()],
        "promote" => named.map_or_else(both, |a| vec![a.to_owned()]),
        "security" => both(),
        _ => Vec::new(),
    }
}

/// What the child reads (`job.json`): the task, where the pool is, the host's arch, its directories.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spec {
    pub task: Task,
    pub api: String,
    pub pool: String,
    /// The dispatcher's native arch: the job's own process runs it.
    pub arch: String,
    /// `<work root>/jobs`, shared by the jobs (one at a time).
    pub work_dir: PathBuf,
    /// The release's checkout: the scripts.
    pub repo_dir: PathBuf,
    /// `<task dir>/tmp`: its scripts' scratch directories.
    pub scratch: PathBuf,
}

/// How a job's child ended, as its lease file keeps it for the report (`notes.job`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct End {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// Killed at its timeout (`limit_s`).
    pub timed_out: bool,
    pub limit_s: u64,
}

impl End {
    pub fn of(status: std::process::ExitStatus, limit: Duration) -> Self {
        use std::os::unix::process::ExitStatusExt as _;
        Self {
            code: status.code(),
            signal: status.signal(),
            timed_out: false,
            limit_s: limit.as_secs(),
        }
    }

    /// How it ended, in words: for the log and a report.
    pub fn words(&self) -> String {
        if self.timed_out {
            return format!(
                "ran past its timeout of {}: killed, with its helper containers",
                span(self.limit_s)
            );
        }
        match (self.code, self.signal) {
            (_, Some(s)) => format!(
                "its process ended on signal {s}{}",
                match s {
                    6 => " (SIGABRT: a crash, or an allocation past its 2 GB memory limit)",
                    9 => " (SIGKILL)",
                    11 => " (SIGSEGV: a crash)",
                    _ => "",
                }
            ),
            (Some(c), None) => format!("its process exited {c}"),
            (None, None) => "its process ended, how is not known".to_owned(),
        }
    }
}

/// A timeout as the log and a report say it: minutes, or seconds when it is not a whole number of them.
pub fn span(secs: u64) -> String {
    if secs % 60 == 0 {
        format!("{} min", secs / 60)
    } else {
        format!("{secs} s")
    }
}

/// How a job's child is started: the real one runs this binary again as `pkg-repo pool-job`; the
/// loop's tests run a shell.
pub trait Launch: Send + Sync {
    fn command(&self, dir: &Path) -> Command;
}

/// `pkg-repo pool-job --dir <task dir>`.
pub struct Exe(pub PathBuf);

impl Launch for Exe {
    fn command(&self, dir: &Path) -> Command {
        let mut c = Command::new(&self.0);
        c.arg("pool-job").arg("--dir").arg(dir);
        c
    }
}

/// A job's child process, in its own process group.
pub struct Child(std::process::Child);

impl Child {
    /// Starts a job's child: its own process group (the dispatcher kills it whole), nothing on its stdin.
    pub fn spawn(mut cmd: Command) -> std::io::Result<Self> {
        cmd.stdin(Stdio::null()).process_group(0);
        cmd.spawn().map(Self)
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.0.try_wait()
    }

    /// Kills its whole process group — the job, its scripts, their engine clients — and reaps it.
    pub fn kill(&mut self) -> Option<std::process::ExitStatus> {
        self.kill_group();
        let _ = self.0.kill();
        self.0.wait().ok()
    }

    /// What is left of its process group once it ended: a script it left behind.
    pub fn kill_group(&self) {
        use rustix::process::{kill_process_group, Pid, Signal};
        if let Some(p) = i32::try_from(self.0.id()).ok().and_then(Pid::from_raw) {
            let _ = kill_process_group(p, Signal::KILL);
        }
    }
}

/// Writes a file of the job's directory whole, 0600 (a temporary file renamed over it).
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

/// The job's result as its child wrote it: done with a summary and a result, or the failure it reports.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Done {
        summary: String,
        result: Value,
        duration_ms: u64,
    },
    Failed(Value),
}

pub fn read_result(dir: &Path) -> Option<Outcome> {
    let v: Value = serde_json::from_slice(&std::fs::read(dir.join(RESULT_FILE)).ok()?).ok()?;
    if v.get("ok").and_then(Value::as_bool)? {
        Some(Outcome::Done {
            summary: v
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("done")
                .to_owned(),
            result: v.get("result").cloned().unwrap_or(Value::Null),
            duration_ms: v.get("duration_ms").and_then(Value::as_u64).unwrap_or(0),
        })
    } else {
        Some(Outcome::Failed(
            v.get("fail")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({ "error": "failed", "final": false })),
        ))
    }
}

/// The wrapper the dispatcher writes for its jobs (`<work root>/state/bin`): `omarchy-task-run`,
/// and `docker` and `podman` beside it, each this binary's `task-run`.
pub fn install_shim(bin: &Path, exe: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let exe_s = exe.display().to_string();
    if !super::spec::path_ok(exe) {
        return Err(std::io::Error::other(format!(
            "{exe_s} is not a plain absolute path: the shim cannot name it"
        )));
    }
    std::fs::create_dir_all(bin)?;
    let body = format!(
        "#!/bin/sh\n# {} (#340): a pool job's only container engine — the one helper shape, through the task spec.\nexec '{exe_s}' task-run \"$@\"\n",
        super::shim::NAME
    );
    for name in [super::shim::NAME, "docker", "podman"] {
        let p = bin.join(name);
        write_private(&p, body.as_bytes())?;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The real engine's CLI by absolute path, looked up on `path` (the dispatcher's `PATH`) outside
/// the shim's directory.
pub fn engine_path(
    runtime: &str,
    shim_bin: &Path,
    path: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    if Path::new(runtime).is_absolute() {
        return Some(PathBuf::from(runtime));
    }
    std::env::split_paths(path?)
        .filter(|d| d != shim_bin && d.is_absolute())
        .map(|d| d.join(runtime))
        .find(|c| c.is_file())
}

// ---------- the child: `pkg-repo pool-job` ----------

/// How often the child reads the token its dispatcher renewed at a heartbeat.
const TOKEN_EVERY: Duration = Duration::from_secs(10);

/// `pkg-repo pool-job --dir <task dir>`: limits its own memory, runs the job as `pkg-repo work`
/// does — with the token the dispatcher keeps renewing in `<dir>/token` — and writes its result.
pub fn child_main(dir: &Path) -> anyhow::Result<()> {
    use anyhow::Context as _;
    use rustix::process::{setrlimit, Resource, Rlimit};
    setrlimit(
        Resource::Data,
        Rlimit {
            current: Some(MEM_LIMIT),
            maximum: Some(MEM_LIMIT),
        },
    )
    .context("its 2 GB memory limit")?;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        // Its dispatcher gone (outside a container, whose end takes every process with it): so is the job.
        let _ =
            rustix::process::set_parent_process_death_signal(Some(rustix::process::Signal::KILL));
    }
    let spec: Spec = serde_json::from_slice(
        &std::fs::read(dir.join(SPEC_FILE)).context("reading the job's job.json")?,
    )
    .context("job.json")?;
    let read_token = |d: &Path| {
        std::fs::read_to_string(d.join(TOKEN_FILE))
            .map(|t| t.trim().to_owned())
            .unwrap_or_default()
    };
    let token = Arc::new(Mutex::new(read_token(dir)));
    anyhow::ensure!(
        !token.lock().map_or(true, |t| t.is_empty()),
        "no job token in {}",
        dir.join(TOKEN_FILE).display()
    );
    {
        let (token, dir) = (Arc::clone(&token), dir.to_path_buf());
        std::thread::spawn(move || loop {
            std::thread::sleep(TOKEN_EVERY);
            let fresh = read_token(&dir);
            if !fresh.is_empty() {
                if let Ok(mut t) = token.lock() {
                    *t = fresh;
                }
            }
        });
    }
    std::fs::create_dir_all(&spec.work_dir)?;
    std::fs::create_dir_all(&spec.scratch)?;
    let opts = WorkOptions {
        api: spec.api.clone(),
        pool: spec.pool.clone(),
        worker_token: String::new(),
        arch: spec.arch.clone(),
        kinds: vec![spec.task.kind.clone()],
        shared: false,
        labels: json!({}),
        once: true,
        idle_exit: 0,
        work_dir: spec.work_dir.clone(),
        repo_dir: Some(spec.repo_dir.clone()),
        scratch: Some(spec.scratch.clone()),
    };
    let started = Instant::now();
    let outcome = work::execute(&opts, &spec.task, &token);
    let took = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let body = match outcome {
        Ok(o) => {
            json!({ "ok": true, "summary": o.summary, "result": o.result, "duration_ms": took })
        }
        Err(e) => {
            work::say(format!("task {}: failed — {e:#}", spec.task.id));
            json!({ "ok": false, "fail": work::fail_body(&e, took) })
        }
    };
    write_private(&dir.join(RESULT_FILE), &serde_json::to_vec(&body)?)
        .context("writing result.json")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::needless_pass_by_value)] // the call sites read better with json!(…) inline
    fn task(kind: &str, arch: &str, params: Value) -> Task {
        serde_json::from_value(json!({ "id": 5, "kind": kind, "name": kind, "arch": arch, "trust": "project", "params": params })).unwrap()
    }

    #[test]
    fn helpers_run_the_arches_a_job_checks_and_every_other_kind_none() {
        assert_eq!(
            helper_arches(&task(
                "health",
                "x86_64",
                json!({ "ring": "rc", "arch": "x86_64" })
            )),
            ["x86_64"]
        );
        assert_eq!(
            helper_arches(&task("health", "aarch64", json!({ "ring": "rc" }))),
            ["aarch64"]
        );
        assert_eq!(
            helper_arches(&task(
                "promote",
                "x86_64",
                json!({ "from": "rc", "to": "stable" })
            )),
            ["x86_64", "aarch64"]
        );
        assert_eq!(
            helper_arches(&task("promote", "x86_64", json!({ "arch": "aarch64" }))),
            ["aarch64"]
        );
        assert_eq!(
            helper_arches(&task("security", "x86_64", json!({}))),
            ["x86_64", "aarch64"]
        );
        for k in POOL_KINDS.iter().filter(|k| !has_helpers(k)) {
            assert!(
                helper_arches(&task(k, "x86_64", json!({}))).is_empty(),
                "{k}"
            );
        }
        // A pool job is none of the task kinds, and the pool's own metrics is not one.
        for k in ["build", "trial", "audit", "metrics"] {
            assert!(!is_job(k), "{k}");
        }
    }

    #[test]
    fn every_kind_has_a_timeout_and_the_scheduled_ones_end_before_their_next_run() {
        for k in POOL_KINDS {
            let t = timeout(k);
            assert!(
                t >= Duration::from_secs(30 * 60) && t <= Duration::from_secs(4 * 3600),
                "{k}"
            );
        }
        // sync and security are queued every three hours (worker/src/scheduler.ts RULES).
        assert!(timeout("sync") < Duration::from_secs(180 * 60));
        assert!(timeout("security") < Duration::from_secs(180 * 60));
    }

    #[test]
    fn a_result_reads_back_and_one_that_is_not_there_is_none() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(read_result(t.path()), None);
        write_private(
            &t.path().join(RESULT_FILE),
            br#"{"ok":true,"summary":"edge/x86_64 rendered: a","result":{"repos":["a"]},"duration_ms":40}"#,
        )
        .unwrap();
        assert_eq!(
            read_result(t.path()),
            Some(Outcome::Done {
                summary: "edge/x86_64 rendered: a".into(),
                result: json!({ "repos": ["a"] }),
                duration_ms: 40
            })
        );
        let mode = std::os::unix::fs::PermissionsExt::mode(
            &std::fs::metadata(t.path().join(RESULT_FILE))
                .unwrap()
                .permissions(),
        );
        assert_eq!(mode & 0o777, 0o600);
        write_private(
            &t.path().join(RESULT_FILE),
            br#"{"ok":false,"fail":{"error":"health check of rc/x86_64 failed","final":false}}"#,
        )
        .unwrap();
        assert_eq!(
            read_result(t.path()),
            Some(Outcome::Failed(
                json!({ "error": "health check of rc/x86_64 failed", "final": false })
            ))
        );
        std::fs::write(t.path().join(RESULT_FILE), "{").unwrap();
        assert_eq!(read_result(t.path()), None);
    }

    #[test]
    fn the_shim_is_this_binary_under_three_names_and_the_engine_is_never_it() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        let bin = root.join("state/bin");
        install_shim(&bin, Path::new("/usr/local/bin/pkg-repo")).unwrap();
        for n in ["omarchy-task-run", "docker", "podman"] {
            let body = std::fs::read_to_string(bin.join(n)).unwrap();
            assert!(
                body.contains("exec '/usr/local/bin/pkg-repo' task-run \"$@\""),
                "{body}"
            );
        }
        assert!(install_shim(&bin, Path::new("/opt/it's here/pkg-repo")).is_err());
        // A real engine beside the shim on PATH: the real one is found, never the shim.
        std::fs::create_dir_all(root.join("usr/bin")).unwrap();
        std::fs::write(root.join("usr/bin/docker"), "").unwrap();
        let path = std::env::join_paths([bin.clone(), root.join("usr/bin")]).unwrap();
        assert_eq!(
            engine_path("docker", &bin, Some(&path)),
            Some(root.join("usr/bin/docker"))
        );
        assert_eq!(engine_path("podman", &bin, Some(&path)), None);
        assert_eq!(
            engine_path("/usr/bin/podman", &bin, None),
            Some(PathBuf::from("/usr/bin/podman"))
        );
    }

    #[test]
    fn a_child_that_ends_says_how() {
        let ended = |sh: &str| {
            let mut c = Child::spawn({
                let mut c = Command::new("sh");
                c.arg("-c").arg(sh);
                c
            })
            .unwrap();
            loop {
                if let Some(s) = c.try_wait().unwrap() {
                    return End::of(s, Duration::from_secs(60));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        assert_eq!(ended("exit 3").code, Some(3));
        let crash = ended("kill -SEGV $$");
        assert_eq!(crash.signal, Some(11));
        assert!(crash.words().contains("SIGSEGV"), "{}", crash.words());
        assert!(ended("kill -ABRT $$").words().contains("2 GB memory limit"));
        // A hung child and what it started go together.
        let t = tempfile::tempdir().unwrap();
        let pid_file = t.path().join("pid");
        let mut hung = Child::spawn({
            let mut c = Command::new("sh");
            c.arg("-c").arg(format!(
                "sleep 600 & echo $! > {}; wait",
                pid_file.display()
            ));
            c
        })
        .unwrap();
        while !pid_file.exists()
            || std::fs::read_to_string(&pid_file)
                .unwrap()
                .trim()
                .is_empty()
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        let grandchild: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let s = hung.kill().unwrap();
        assert_eq!(std::os::unix::process::ExitStatusExt::signal(&s), Some(9));
        let gone = || {
            rustix::process::test_kill_process(rustix::process::Pid::from_raw(grandchild).unwrap())
                .is_err()
                || std::fs::read_to_string(format!("/proc/{grandchild}/stat"))
                    .is_ok_and(|s| s.split_whitespace().nth(2) == Some("Z"))
        };
        let until = Instant::now() + Duration::from_secs(5);
        while !gone() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gone(), "the job's scripts die with it");
    }
}
