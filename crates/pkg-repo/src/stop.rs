//! A task the pool took back, and a worker that wedges (#277, part 2).
//!
//! **The stop.** The pool answers a heartbeat for a task that is no longer
//! this worker's — stopped from its worker's page, cancelled, requeued, or
//! leased to another — with `409 {"stop": true, "state": …}` (a task that is
//! gone with `404`), on every heartbeat. A child holding the job token cannot
//! swallow it: it is a repeated fact, not a one-time order. On it the
//! heartbeat thread stops the task ([`TaskStop::stop`]):
//! - its flag first, which every [`Api`](crate::client::Api) of the task
//!   checks before each attempt: work in the worker's own process ends at its
//!   next call to the pool;
//! - then the process groups of the task's children — each spawned in a
//!   group of its own ([`status`], [`output`]) — `SIGTERM`, `SIGKILL` 10 s
//!   later;
//! - then the task's containers, which outlive a killed client: every
//!   container labelled `com.omarchy.task=<id>`, created ones included
//!   (`ps -aq`), removed with `rm -f`, at most 30 s in all.
//!
//! **The watchdog.** A process that makes no progress — no claim attempt
//! between tasks, no heartbeat the pool accepted in a task — for its wait
//! exits 75, when its restart policy starts it again, after the stop above
//! when it was in a task; otherwise it says so and waits on. The wait doubles
//! with each watchdog exit of the container (20, 40, 80 … min, at most 24 h;
//! never under 35 min in a task: the lease plus one heartbeat), counted in
//! the container's writable layer — so at most 6 in any 24 h —, and the next
//! process tells the pool why it is new (`previous_exit`).

use std::cell::RefCell;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::RepoError;

/// The label every container a task starts or creates carries: a stop removes them by it.
pub const TASK_LABEL: &str = "com.omarchy.task";
/// How long a stopped task's process groups have between `SIGTERM` and `SIGKILL`.
pub const KILL_GRACE: Duration = Duration::from_secs(10);
/// How long the removal of a stopped task's containers may take, in all.
pub const CONTAINERS_WITHIN: Duration = Duration::from_secs(30);

// ---------- what the heartbeat's answer says ----------

/// A heartbeat's answer, as the task reads it.
#[derive(Debug, PartialEq, Eq)]
pub enum Beat {
    /// The pool took it (200): the lease moved, with a fresh job token when it sent one. Progress, for the watchdog.
    Accepted(Option<String>),
    /// The task is no longer this worker's — `404`, or `409` with `"stop": true` — and what became of it.
    Stop(String),
    /// Nothing to act on: a network error, a `5xx`, or a `409` without `stop` (a pool from before #277 keeps today's behaviour).
    Nothing,
}

pub fn beat_of(r: &Result<Option<Value>, RepoError>) -> Beat {
    match r {
        Ok(Some(v)) => Beat::Accepted(v.get("token").and_then(Value::as_str).map(str::to_owned)),
        Ok(None) => Beat::Accepted(None),
        Err(RepoError::Api { status: 404, .. }) => Beat::Stop("gone".to_owned()),
        Err(RepoError::Api { status: 409, body }) => {
            let v: Value = serde_json::from_str(body).unwrap_or_default();
            if v.get("stop").and_then(Value::as_bool) == Some(true) {
                let state = v.get("state").and_then(Value::as_str).unwrap_or("stopping");
                // The pool's word, as this worker prints it: a closed set of short words, anything else "stopping".
                let state = if state.len() <= 16 && state.bytes().all(|b| b.is_ascii_lowercase()) {
                    state
                } else {
                    "stopping"
                };
                Beat::Stop(state.to_owned())
            } else {
                Beat::Nothing
            }
        }
        Err(_) => Beat::Nothing,
    }
}

// ---------- the task's stop ----------

/// What a stopped task's work returns: its processes stopped, nothing more of it sent.
#[derive(Debug)]
pub struct Stopped {
    pub task: u64,
    pub state: String,
}

impl std::fmt::Display for Stopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "task {} was stopped by the pool ({}); stopped its processes",
            self.task, self.state
        )
    }
}

impl std::error::Error for Stopped {}

/// The engine as a stop uses it: `<runtime> <args…>` with a deadline; None when the runtime is not there or did not answer in time.
pub type Engine<'a> = &'a dyn Fn(&str, &[&str], Instant) -> Option<Output>;

/// One task's stop: its flag, the pool's word, and the process groups of its children while they run.
pub struct TaskStop {
    task: u64,
    flag: Arc<AtomicBool>,
    state: Mutex<Option<String>>,
    groups: Mutex<Vec<u32>>,
}

impl TaskStop {
    pub fn new(task: u64) -> Arc<Self> {
        Arc::new(Self {
            task,
            flag: Arc::new(AtomicBool::new(false)),
            state: Mutex::new(None),
            groups: Mutex::new(Vec::new()),
        })
    }

    pub fn task(&self) -> u64 {
        self.task
    }

    /// The flag every `Api` of the task carries.
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }

    pub fn is_stopped(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// The error the task's work returns once stopped.
    pub fn stopped(&self) -> Stopped {
        Stopped {
            task: self.task,
            state: self
                .state
                .lock()
                .ok()
                .and_then(|s| s.clone())
                .unwrap_or_else(|| "stopping".to_owned()),
        }
    }

    /// Stops the task: the flag first — a call about to be made is not —,
    /// then its children's process groups (`SIGTERM`, `SIGKILL` after
    /// `grace`), then its containers on every runtime that answers (`ps -aq`
    /// by the task's label, `rm -f` each, within [`CONTAINERS_WITHIN`]).
    /// Returns the containers it removed.
    pub fn stop(&self, state: &str, engine: Engine, grace: Duration) -> Vec<String> {
        if let Ok(mut s) = self.state.lock() {
            s.get_or_insert_with(|| state.to_owned());
        }
        self.flag.store(true, Ordering::SeqCst);
        let groups: Vec<u32> = self.groups.lock().map(|g| g.clone()).unwrap_or_default();
        kill_groups(&groups, grace);
        remove_task_containers(self.task, engine, Instant::now() + CONTAINERS_WITHIN)
    }

    /// A child's process group, while it runs: a stop kills it. A stop that came first kills it at once.
    fn register(&self, group: u32) {
        if let Ok(mut g) = self.groups.lock() {
            g.push(group);
        }
        if self.is_stopped() {
            kill_groups(&[group], KILL_GRACE);
        }
    }

    fn unregister(&self, group: u32) {
        if let Ok(mut g) = self.groups.lock() {
            g.retain(|&x| x != group);
        }
    }
}

/// `SIGTERM` to each group, up to `grace` for them to end, then `SIGKILL` to what is left.
fn kill_groups(groups: &[u32], grace: Duration) {
    use rustix::process::{kill_process_group, test_kill_process_group, Pid, Signal};
    let pids: Vec<Pid> = groups
        .iter()
        .filter_map(|&g| i32::try_from(g).ok().and_then(Pid::from_raw))
        .collect();
    for &p in &pids {
        let _ = kill_process_group(p, Signal::TERM);
    }
    let until = Instant::now() + grace;
    while Instant::now() < until && pids.iter().any(|&p| test_kill_process_group(p).is_ok()) {
        std::thread::sleep(Duration::from_millis(100));
    }
    for &p in &pids {
        if test_kill_process_group(p).is_ok() {
            let _ = kill_process_group(p, Signal::KILL);
        }
    }
}

/// Every container labelled with the task, created or running, on every
/// runtime that answers, removed: a created container is not running, so
/// `kill` could not end it and `ps` without `-a` would not list it. Task ids
/// are the pool's, unique across the fleet, so the filter never reaches
/// another worker's container on a shared engine.
pub fn remove_task_containers(task: u64, engine: Engine, until: Instant) -> Vec<String> {
    let filter = format!("label={TASK_LABEL}={task}");
    let mut removed = Vec::new();
    for rt in ["docker", "podman"] {
        let Some(out) = engine(rt, &["ps", "-aq", "--filter", &filter], until) else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        for id in String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric()))
        {
            if engine(rt, &["rm", "-f", id], until).is_some_and(|o| o.status.success()) {
                removed.push(id.to_owned());
            }
        }
    }
    removed
}

/// The engine itself: `<runtime> <args…>`, killed at the deadline.
pub fn real_engine(runtime: &str, args: &[&str], until: Instant) -> Option<Output> {
    let mut child = Command::new(runtime)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

// ---------- the task this thread works on ----------

thread_local! {
    static CURRENT: RefCell<Option<Arc<TaskStop>>> = const { RefCell::new(None) };
}

/// Runs a task's work with its stop as this thread's: the children it
/// spawns ([`status`], [`output`]) are the task's, in groups a stop kills.
pub fn within<T>(stop: &Arc<TaskStop>, f: impl FnOnce() -> T) -> T {
    struct Leave;
    impl Drop for Leave {
        fn drop(&mut self) {
            CURRENT.with(|c| c.borrow_mut().take());
        }
    }
    CURRENT.with(|c| *c.borrow_mut() = Some(Arc::clone(stop)));
    let _leave = Leave;
    f()
}

/// The stop of the task this thread works on, if any.
pub fn current() -> Option<Arc<TaskStop>> {
    CURRENT.with(|c| c.borrow().clone())
}

/// After a child: the task's error when it was stopped meanwhile.
pub fn check() -> anyhow::Result<()> {
    match current() {
        Some(s) if s.is_stopped() => Err(s.stopped().into()),
        _ => Ok(()),
    }
}

/// Spawns a task's child in a process group of its own, registered while it
/// runs, so a stop kills the whole group — a script and whatever it runs.
fn spawned(cmd: &mut Command) -> std::io::Result<(std::process::Child, Option<Arc<TaskStop>>)> {
    let stop = current();
    if stop.as_ref().is_some_and(|s| s.is_stopped()) {
        return Err(std::io::Error::other("the task was stopped by the pool"));
    }
    cmd.process_group(0);
    let child = cmd.spawn()?;
    if let Some(s) = &stop {
        s.register(child.id());
    }
    Ok((child, stop))
}

/// A task's child, run to its end: its exit status.
pub fn status(cmd: &mut Command) -> std::io::Result<ExitStatus> {
    let (mut child, stop) = spawned(cmd)?;
    let id = child.id();
    let st = child.wait();
    if let Some(s) = stop {
        s.unregister(id);
    }
    st
}

/// A task's child, run to its end: what it printed.
pub fn output(cmd: &mut Command) -> std::io::Result<Output> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let (child, stop) = spawned(cmd)?;
    let id = child.id();
    let out = child.wait_with_output();
    if let Some(s) = stop {
        s.unregister(id);
    }
    out
}

// ---------- the watchdog ----------

/// The watchdog's first wait, and the least in a task — the 30-minute lease
/// plus one heartbeat: a heartbeat unanswered that long means the lease has
/// ended and the task is back in the queue, so the exit costs nothing.
pub const WATCHDOG_MIN: u64 = 20;
pub const WATCHDOG_TASK_MIN: u64 = 35;
pub const WATCHDOG_MAX_MIN: u64 = 1440;
/// The count goes back to 0 only after this long without a watchdog exit.
pub const WATCHDOG_RESET: Duration = Duration::from_secs(24 * 3600);

/// Where the process is when it makes no progress: in its claim (between tasks), in a task, or in an order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Claim,
    Task(u64),
    Order,
}

impl Phase {
    pub fn word(self) -> &'static str {
        match self {
            Self::Claim => "claim",
            Self::Task(_) => "task",
            Self::Order => "order",
        }
    }

    fn words(self) -> String {
        match self {
            Self::Claim => "stuck in its claim".to_owned(),
            Self::Task(id) => format!("stuck in task {id}"),
            Self::Order => "stuck in an order".to_owned(),
        }
    }
}

/// The wait, in minutes: 20 × 2^n, at most a day, never under 35 in a task.
pub fn wait_minutes(n: u32, phase: Phase) -> u64 {
    let doubled = WATCHDOG_MIN.saturating_mul(1u64 << n.min(16));
    let wait = doubled.min(WATCHDOG_MAX_MIN);
    if matches!(phase, Phase::Task(_)) {
        wait.max(WATCHDOG_TASK_MIN)
    } else {
        wait
    }
}

/// The container's count of watchdog exits in a row, with when the last one was (seconds since the epoch).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Count {
    pub n: u32,
    pub last: u64,
}

/// The count a process starts with: the file's, unless its last exit is more than a day old — and 0 when the file is missing or unreadable.
pub fn read_count(dir: &Path, now: u64) -> u32 {
    let Ok(text) = std::fs::read_to_string(dir.join("watchdog")) else {
        return 0;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return 0;
    };
    let n = v.get("n").and_then(Value::as_u64).unwrap_or(0);
    let last = v.get("last").and_then(Value::as_u64).unwrap_or(0);
    if now.saturating_sub(last) > WATCHDOG_RESET.as_secs() {
        return 0;
    }
    u32::try_from(n.min(64)).unwrap_or(0)
}

pub fn write_count(dir: &Path, c: Count) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(
        dir.join("watchdog"),
        serde_json::json!({ "n": c.n, "last": c.last }).to_string(),
    )
}

/// What a watchdog's look at the clock decides.
#[derive(Debug, PartialEq, Eq)]
pub enum Tick {
    Nothing,
    /// A day without a watchdog exit: the count goes back to 0.
    Reset,
    /// No progress for the wait, and nothing restarts this process: said, at each wait.
    Warn(String),
    /// No progress for the wait: exit so the restart policy starts it again — the count and the note say why.
    Exit {
        line: String,
        stuck_in: Phase,
        n: u32,
    },
}

/// The watchdog's state, on the process's own monotonic clock (a host that
/// sleeps does not fire it): the count it started with, where it is, and
/// its last progress.
#[derive(Debug)]
pub struct Watchdog {
    n: u32,
    restart: bool,
    phase: Phase,
    last_progress: Duration,
    warned: Option<Duration>,
    reset: bool,
    fired: bool,
}

impl Watchdog {
    pub fn new(n: u32, restart: bool) -> Self {
        Self {
            n,
            restart,
            phase: Phase::Claim,
            last_progress: Duration::ZERO,
            warned: None,
            reset: false,
            fired: false,
        }
    }

    pub fn n(&self) -> u32 {
        self.n
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// The loop reached its claim, or the pool accepted a heartbeat: the process moves.
    pub fn progress(&mut self, at: Duration) {
        self.last_progress = at;
    }

    /// Where the process is now; entering a phase is progress too (the claim that got the task, the answer that carried the orders).
    pub fn enter(&mut self, phase: Phase, at: Duration) {
        self.phase = phase;
        self.last_progress = at;
    }

    /// The wait now, in minutes.
    pub fn wait(&self) -> u64 {
        wait_minutes(self.n, self.phase)
    }

    pub fn tick(&mut self, at: Duration) -> Tick {
        if self.fired {
            return Tick::Nothing;
        }
        // A day of work without a watchdog exit — progress made after a day of life, not a day spent wedged — puts the count back to 0.
        if !self.reset && self.n > 0 && at >= WATCHDOG_RESET && self.last_progress >= WATCHDOG_RESET
        {
            self.reset = true;
            self.n = 0;
            return Tick::Reset;
        }
        let wait = self.wait();
        let still = at.saturating_sub(self.last_progress);
        if still < Duration::from_secs(wait * 60) {
            return Tick::Nothing;
        }
        let why = format!(
            "no claim and no accepted heartbeat for {wait} min ({})",
            self.phase.words()
        );
        if self.restart {
            self.fired = true;
            return Tick::Exit {
                line: format!("{why}: exiting so the restart policy starts me again"),
                stuck_in: self.phase,
                n: self.n + 1,
            };
        }
        if self
            .warned
            .is_some_and(|w| at.saturating_sub(w) < Duration::from_secs(wait * 60))
        {
            return Tick::Nothing;
        }
        self.warned = Some(at);
        Tick::Warn(format!(
            "{why}: nothing restarts this process (no restart it can count on), so it waits on; a person looks"
        ))
    }
}

/// The watchdog as the loop, the heartbeat and its own thread share it: its
/// state, the task in hand (a watchdog exit in a task stops it first), and
/// the process's own clock.
pub struct Watch {
    wd: Mutex<Watchdog>,
    task: Mutex<Option<Arc<TaskStop>>>,
    started: Instant,
}

impl Watch {
    pub fn new(wd: Watchdog) -> Arc<Self> {
        Arc::new(Self {
            wd: Mutex::new(wd),
            task: Mutex::new(None),
            started: Instant::now(),
        })
    }

    fn at(&self) -> Duration {
        self.started.elapsed()
    }

    /// The loop reached its claim, or the pool accepted a heartbeat.
    pub fn progress(&self) {
        let at = self.at();
        if let Ok(mut w) = self.wd.lock() {
            w.progress(at);
        }
    }

    /// Where the loop is now, with the task's stop while it runs one.
    pub fn enter(&self, phase: Phase, task: Option<Arc<TaskStop>>) {
        let at = self.at();
        if let Ok(mut w) = self.wd.lock() {
            w.enter(phase, at);
        }
        if let Ok(mut t) = self.task.lock() {
            *t = task;
        }
    }

    pub fn tick(&self) -> (Tick, Option<Arc<TaskStop>>) {
        let at = self.at();
        let tick = self.wd.lock().map_or(Tick::Nothing, |mut w| w.tick(at));
        let task = self.task.lock().ok().and_then(|t| t.clone());
        (tick, task)
    }
}

/// What the watchdog does with its tick: a day without an exit writes the
/// count back to 0; a warning is said; an exit stops the task in hand when
/// it was stuck in one (its process groups and its containers, at most
/// 40 s), counts itself in the container's layer, leaves the note the next
/// process tells the pool, and calls `exit` with 75 — whatever of that
/// could not be written, it says so and exits all the same.
pub struct Fire<'a> {
    pub dir: &'a Path,
    pub now: u64,
    pub at_iso: &'a str,
    pub engine: Engine<'a>,
    pub say: &'a dyn Fn(&str),
    pub exit: &'a dyn Fn(i32),
}

pub fn on_tick(tick: Tick, task: Option<&TaskStop>, f: &Fire) {
    match tick {
        Tick::Nothing => {}
        Tick::Reset => {
            if write_count(f.dir, Count { n: 0, last: f.now }).is_err() {
                (f.say)(
                    "watchdog: a day without an exit, but its count could not be written back to 0",
                );
            }
        }
        Tick::Warn(line) => (f.say)(&line),
        Tick::Exit { line, stuck_in, n } => {
            (f.say)(&line);
            if let (Phase::Task(_), Some(t)) = (stuck_in, task) {
                let removed = t.stop("watchdog", f.engine, KILL_GRACE);
                (f.say)(&format!(
                    "task {}: its processes stopped{}",
                    t.task(),
                    if removed.is_empty() {
                        String::new()
                    } else {
                        format!(", {} container(s) removed", removed.len())
                    }
                ));
            }
            if let Err(e) = write_count(f.dir, Count { n, last: f.now }) {
                (f.say)(&format!("watchdog: could not count this exit ({e}); the next wait is the first one again"));
            }
            if let Err(e) = leave_watchdog_note(f.dir, f.at_iso, stuck_in, n) {
                (f.say)(&format!(
                    "watchdog: could not leave the note for the next process ({e})"
                ));
            }
            (f.exit)(75);
        }
    }
}

/// The note a watchdog exit leaves for the next process: why, where it was stuck, and the container's count.
pub fn leave_watchdog_note(dir: &Path, at: &str, stuck_in: Phase, n: u32) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(
        dir.join("last-exit"),
        serde_json::json!({ "why": "watchdog", "at": at, "stuck_in": stuck_in.word(), "n": n })
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    fn api_err(status: u16, body: &str) -> Result<Option<Value>, RepoError> {
        Err(RepoError::Api {
            status,
            body: body.to_owned(),
        })
    }

    #[test]
    fn the_heartbeats_answer_stops_on_404_and_on_409_with_stop_only() {
        assert_eq!(
            beat_of(&Ok(Some(serde_json::json!({ "token": "omj.2" })))),
            Beat::Accepted(Some("omj.2".to_owned()))
        );
        assert_eq!(beat_of(&api_err(404, "{}")), Beat::Stop("gone".to_owned()));
        assert_eq!(
            beat_of(&api_err(
                409,
                r#"{"error":"x","stop":true,"state":"stopping"}"#
            )),
            Beat::Stop("stopping".to_owned())
        );
        assert_eq!(
            beat_of(&api_err(409, r#"{"stop":true,"state":"cancelled"}"#)),
            Beat::Stop("cancelled".to_owned())
        );
        // What the pool says is printed: only a short word of its own.
        assert_eq!(
            beat_of(&api_err(409, r#"{"stop":true,"state":"\u001b[31mrm -rf"}"#)),
            Beat::Stop("stopping".to_owned())
        );
        // A pool from before #277 (a 409 without stop), a 5xx, a network error: nothing stops.
        assert_eq!(
            beat_of(&api_err(409, r#"{"error":"the lease is not yours"}"#)),
            Beat::Nothing
        );
        assert_eq!(beat_of(&api_err(503, "")), Beat::Nothing);
        assert_eq!(
            beat_of(&Err(RepoError::Io(std::io::Error::other("down")))),
            Beat::Nothing
        );
    }

    /// The stop kills the task's process group — a `sleep 600` and the shell
    /// that started it —, never runs `kill` on a container, and removes every
    /// container with the task's label: running or only created.
    #[test]
    fn a_stop_kills_the_tasks_process_group_and_removes_its_containers() {
        let stop = TaskStop::new(812);
        let s = Arc::clone(&stop);
        let child = std::thread::spawn(move || {
            within(&s, || {
                let mut cmd = Command::new("sh");
                cmd.args(["-c", "sleep 600 & sleep 600; echo never"]);
                let started = Instant::now();
                let st = status(&mut cmd).unwrap();
                (st, started.elapsed(), check().is_err())
            })
        });
        std::thread::sleep(Duration::from_millis(300));
        let calls = Mutex::new(Vec::<String>::new());
        let engine = |rt: &str, args: &[&str], _until: Instant| -> Option<Output> {
            calls
                .lock()
                .unwrap()
                .push(format!("{rt} {}", args.join(" ")));
            let stdout = if args[0] == "ps" && rt == "docker" {
                b"0123abcd\ncafe4567\n".to_vec()
            } else {
                Vec::new()
            };
            Some(Output {
                status: ExitStatus::from_raw(0),
                stdout,
                stderr: Vec::new(),
            })
        };
        let removed = stop.stop("stopping", &engine, Duration::from_secs(2));
        let (st, took, stopped) = child.join().unwrap();
        assert!(!st.success(), "the group was killed: {st:?}");
        assert!(
            took < Duration::from_secs(10),
            "at once, not after the sleep: {took:?}"
        );
        assert!(stopped, "the work sees the stop");
        assert_eq!(removed, ["0123abcd", "cafe4567"]);
        let calls = calls.into_inner().unwrap();
        assert_eq!(
            calls,
            [
                "docker ps -aq --filter label=com.omarchy.task=812",
                "docker rm -f 0123abcd",
                "docker rm -f cafe4567",
                "podman ps -aq --filter label=com.omarchy.task=812",
            ]
        );
        assert!(!calls.iter().any(|c| c.contains(" kill")));
        assert_eq!(
            stop.stopped().to_string(),
            "task 812 was stopped by the pool (stopping); stopped its processes"
        );
        // A child the task would start after the stop is never started.
        within(&stop, || {
            assert!(status(&mut Command::new("true")).is_err());
        });
    }

    #[test]
    fn a_child_outside_a_task_is_nobodys_and_a_task_that_was_not_stopped_goes_on() {
        assert!(current().is_none());
        assert!(status(&mut Command::new("true")).unwrap().success());
        let stop = TaskStop::new(9);
        within(&stop, || {
            assert_eq!(
                output(Command::new("sh").args(["-c", "echo hi"]))
                    .unwrap()
                    .stdout,
                b"hi\n"
            );
            assert!(check().is_ok());
        });
        assert!(
            current().is_none(),
            "the task is this thread's only while its work runs"
        );
    }

    /// Wedged at once every time: exits at 20, 60, 140, 300, 620 and 1260
    /// minutes, then after 1280 and every 1440 — the count kept in the
    /// container's layer between processes. In a task, 35 first.
    #[test]
    fn a_process_that_wedges_every_time_is_restarted_ever_more_slowly() {
        let dir = tempfile::tempdir().unwrap();
        let exits = chain(dir.path(), &[0; 10], Phase::Claim);
        assert_eq!(&exits[..9], [20, 60, 140, 300, 620, 1260, 2540, 3980, 5420]);
        let dir = tempfile::tempdir().unwrap();
        let exits = chain(dir.path(), &[0; 6], Phase::Task(812));
        assert_eq!(exits, [35, 75, 155, 315, 635, 1275]);
    }

    /// Over random wedge times, never more than six watchdog exits in any
    /// 24 hours; a process that ran a day rewrites the count.
    #[test]
    fn never_more_than_six_watchdog_exits_in_any_day() {
        let mut seed = 0x2770_0277_u64;
        let mut rnd = move |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        for _ in 0..200 {
            let dir = tempfile::tempdir().unwrap();
            let wedges: Vec<u64> = (0..40)
                .map(|_| if rnd(4) == 0 { rnd(2000) } else { 0 })
                .collect();
            let exits = chain(dir.path(), &wedges, Phase::Claim);
            for (i, &t) in exits.iter().enumerate() {
                let in_day = exits[i..].iter().take_while(|&&u| u < t + 1440).count();
                assert!(
                    in_day <= 6,
                    "{in_day} exits from minute {t}: {exits:?} (wedges {wedges:?})"
                );
            }
        }
    }

    /// Processes one after the other, the next started at the minute the last
    /// one exited; each makes progress for `wedge` minutes, then none. The
    /// minutes of the exits, on the wall clock.
    fn chain(dir: &Path, wedges: &[u64], phase: Phase) -> Vec<u64> {
        let epoch0 = 1_800_000_000u64;
        let mut t = 0u64; // minutes since the first start
        let mut exits = Vec::new();
        for &wedge in wedges {
            let mut wd = Watchdog::new(read_count(dir, epoch0 + t * 60), true);
            wd.enter(phase, Duration::ZERO);
            let mut m = 0u64;
            loop {
                m += 1;
                let at = Duration::from_secs(m * 60);
                if m <= wedge {
                    wd.progress(at);
                }
                match wd.tick(at) {
                    Tick::Exit { n, stuck_in, .. } => {
                        assert_eq!(stuck_in, phase);
                        write_count(
                            dir,
                            Count {
                                n,
                                last: epoch0 + (t + m) * 60,
                            },
                        )
                        .unwrap();
                        break;
                    }
                    Tick::Reset => write_count(
                        dir,
                        Count {
                            n: 0,
                            last: epoch0 + (t + m) * 60,
                        },
                    )
                    .unwrap(),
                    Tick::Nothing | Tick::Warn(_) => {}
                }
                assert!(m < 10_000, "it never fired");
            }
            t += m;
            exits.push(t);
        }
        exits
    }

    #[test]
    fn the_count_resets_after_a_day_without_an_exit_and_is_zero_when_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_count(dir.path(), 1000), 0, "missing");
        std::fs::write(dir.path().join("watchdog"), "not json").unwrap();
        assert_eq!(read_count(dir.path(), 1000), 0, "unreadable");
        write_count(
            dir.path(),
            Count {
                n: 3,
                last: 1_000_000,
            },
        )
        .unwrap();
        assert_eq!(read_count(dir.path(), 1_000_000 + 3600), 3);
        assert_eq!(
            read_count(dir.path(), 1_000_000 + 25 * 3600),
            0,
            "a process that starts more than a day after the last exit ignores it"
        );
        // A process that runs a day rewrites it: its own wait is the first one again.
        let mut wd = Watchdog::new(3, true);
        wd.progress(Duration::from_secs(24 * 3600 - 60));
        assert_eq!(wd.tick(Duration::from_secs(24 * 3600 - 30)), Tick::Nothing);
        wd.progress(Duration::from_secs(24 * 3600));
        assert_eq!(wd.tick(Duration::from_secs(24 * 3600)), Tick::Reset);
        assert_eq!(wd.wait(), 20);
        // A day spent wedged is not a day of work: no reset, and the day-long wait fires.
        let mut wd = Watchdog::new(7, true);
        assert!(matches!(
            wd.tick(Duration::from_secs(24 * 3600)),
            Tick::Exit { n: 8, .. }
        ));
    }

    #[test]
    fn without_a_restart_it_counts_on_the_watchdog_only_says_so_at_each_wait() {
        let mut wd = Watchdog::new(0, false);
        let min = |m: u64| Duration::from_secs(m * 60);
        assert_eq!(wd.tick(min(19)), Tick::Nothing);
        assert!(
            matches!(wd.tick(min(20)), Tick::Warn(ref l) if l.contains("no claim and no accepted heartbeat for 20 min (stuck in its claim)"))
        );
        assert_eq!(wd.tick(min(30)), Tick::Nothing);
        assert!(matches!(wd.tick(min(40)), Tick::Warn(_)));
    }

    /// Progress is only what shows the process moving: a heartbeat the pool
    /// took. Heartbeats that fail — a 409 with or without stop, a 404, a 503,
    /// a network error — are not, so a task that ignores its stop trips it,
    /// 35 minutes after the last accepted one.
    #[test]
    fn only_an_accepted_heartbeat_is_progress_in_a_task() {
        let mut wd = Watchdog::new(0, true);
        wd.enter(Phase::Task(812), Duration::ZERO);
        let min = |m: u64| Duration::from_secs(m * 60);
        // Accepted every 5 minutes for 3 hours: never.
        for m in (5..=180).step_by(5) {
            if beat_of(&Ok(Some(serde_json::json!({})))) != Beat::Nothing {
                wd.progress(min(m));
            }
            assert_eq!(wd.tick(min(m)), Tick::Nothing);
        }
        // Then refused, and failing, every 5 minutes: exit 35 minutes after the last accepted one.
        let answers = [
            api_err(409, r#"{"stop":true,"state":"stopping"}"#),
            api_err(404, "{}"),
            api_err(503, ""),
            api_err(409, "{}"),
        ];
        let mut fired = None;
        for (i, m) in (185..=240).step_by(5).enumerate() {
            if let Beat::Accepted(_) = beat_of(&answers[i % answers.len()]) {
                wd.progress(min(m));
            }
            if let Tick::Exit { line, stuck_in, n } = wd.tick(min(m)) {
                assert_eq!((stuck_in, n), (Phase::Task(812), 1));
                assert!(line.contains("stuck in task 812"), "{line}");
                fired = Some(m);
                break;
            }
        }
        assert_eq!(fired, Some(215));
    }

    /// A watchdog exit in a task: the stop runs first — the registered group
    /// killed, the labelled containers removed through the engine —, then
    /// the count, the note, and 75; a state directory it cannot write does
    /// not keep it from exiting.
    #[test]
    fn a_watchdog_exit_in_a_task_stops_it_first_counts_itself_and_exits_75() {
        let dir = tempfile::tempdir().unwrap();
        let task = TaskStop::new(812);
        let t = Arc::clone(&task);
        let child = std::thread::spawn(move || {
            within(&t, || {
                status(Command::new("sleep").arg("600")).map(|s| s.success())
            })
        });
        std::thread::sleep(Duration::from_millis(300));
        let said = Mutex::new(Vec::<String>::new());
        let exited = Mutex::new(Vec::<i32>::new());
        let engine = |rt: &str, args: &[&str], _: Instant| -> Option<Output> {
            let out = if rt == "docker" && args[0] == "ps" {
                b"feed1234\n".to_vec()
            } else {
                Vec::new()
            };
            Some(Output {
                status: ExitStatus::from_raw(0),
                stdout: out,
                stderr: Vec::new(),
            })
        };
        let f = Fire {
            dir: dir.path(),
            now: 1_800_000_000,
            at_iso: "2026-09-30T12:00:00Z",
            engine: &engine,
            say: &|l| said.lock().unwrap().push(l.to_owned()),
            exit: &|c| exited.lock().unwrap().push(c),
        };
        on_tick(Tick::Exit { line: "no claim and no accepted heartbeat for 35 min (stuck in task 812): exiting so the restart policy starts me again".into(), stuck_in: Phase::Task(812), n: 1 }, Some(&task), &f);
        assert_eq!(
            child.join().unwrap().ok(),
            Some(false),
            "the task's child was killed"
        );
        assert_eq!(*exited.lock().unwrap(), [75]);
        assert_eq!(read_count(dir.path(), 1_800_000_000), 1);
        assert_eq!(
            crate::orders::read_exit_note(dir.path()).unwrap()["stuck_in"],
            "task"
        );
        assert!(said
            .lock()
            .unwrap()
            .iter()
            .any(|l| l == "task 812: its processes stopped, 1 container(s) removed"));
        // A state directory it cannot write: it says so, and exits all the same.
        let file = dir.path().join("a-file");
        std::fs::write(&file, b"").unwrap();
        let said = Mutex::new(Vec::<String>::new());
        let exited = Mutex::new(Vec::<i32>::new());
        let f = Fire {
            dir: &file,
            now: 1,
            at_iso: "x",
            engine: &engine,
            say: &|l| said.lock().unwrap().push(l.to_owned()),
            exit: &|c| exited.lock().unwrap().push(c),
        };
        on_tick(
            Tick::Exit {
                line: "stuck".into(),
                stuck_in: Phase::Claim,
                n: 1,
            },
            None,
            &f,
        );
        assert_eq!(*exited.lock().unwrap(), [75]);
        assert!(said
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.starts_with("watchdog: could not count this exit")));
    }

    #[test]
    fn a_watchdog_exit_leaves_its_note() {
        let dir = tempfile::tempdir().unwrap();
        leave_watchdog_note(dir.path(), "2026-09-30T12:00:00Z", Phase::Task(812), 2).unwrap();
        let v = crate::orders::read_exit_note(dir.path()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "why": "watchdog", "at": "2026-09-30T12:00:00Z", "stuck_in": "task", "n": 2 })
        );
    }
}
