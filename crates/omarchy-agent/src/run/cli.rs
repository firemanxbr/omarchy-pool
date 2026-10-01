//! The commands: `run` (the loop), `status` (works with the pool down), `round`
//! (SIGUSR1 to the running agent), `logs` (the journal's tail) and `self-test` (what a
//! self-update asks of a new agent before it hands over, #316).

use std::fmt::Write as _;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use super::agent::{Agent, Drivers, Sigstore};
use super::config::{data_dir, Config, Paths};
use super::pool::Https;
use super::selfupdate::{self, notify, Start};
use super::state::{self, State};
use crate::version::{self, Release};

/// Local configuration errors only (design v2 §16.4): systemd's
/// `RestartPreventExitStatus=78` leaves the agent stopped until a person fixes it.
pub const CONFIG_ERROR: u8 = 78;
/// The loop ticks this often; nothing in a tick blocks longer than one timed-out call.
const TICK: Duration = Duration::from_secs(3);
/// The watchdog aborts a loop that made no progress for this long. A download moves the
/// progress on as its bytes arrive.
const WATCHDOG_S: i64 = 15 * 60;
/// How often the watchdog thread looks; it pings systemd's watchdog (`WatchdogSec=300`)
/// only when the loop made progress since its last look.
const WATCHDOG_LOOK: Duration = Duration::from_secs(10);

fn paths(data: Option<&str>) -> Result<Paths, String> {
    Ok(Paths {
        data: data_dir(data)?,
    })
}

/// A deliberately broken build for `tests/agent-self-update.sh`, chosen when the binary
/// is built (`OMARCHY_AGENT_TEST_FAULT`); a build without it has none. Each acts in `run`
/// only, so it gets past the self-test like a fault that shows only under the service
/// manager does.
fn fault(at: &str) {
    if option_env!("OMARCHY_AGENT_TEST_FAULT") == Some(at) {
        assert!(at != "panic-at-config", "a test build that panics at {at}");
        loop {
            thread::sleep(Duration::from_secs(3600));
        }
    }
}

/// `omarchy-agent run [--data <dir>]`: the loop, until stopped (or until a self-update
/// swapped `current`: exit 0 and the service manager starts the new agent).
pub fn run(data: Option<&str>) -> u8 {
    let me = version::agent();
    // A self-update's start is counted before agent.toml or state.json are read (#316).
    if let Ok(dir) = data_dir(data) {
        if let Start::RolledBack(why) = selfupdate::count_start(&dir, me, super::now()) {
            eprintln!("omarchy-agent run: {why}");
            return 0;
        }
    }
    let progress = Arc::new(AtomicI64::new(super::now()));
    watchdog(Arc::clone(&progress));
    match setup(data, &progress) {
        Ok((mut agent, usr1)) => {
            fault("hang-before-ready");
            notify("READY=1");
            fault("hang-after-ready");
            loop_forever(&mut agent, &usr1, &progress)
        }
        Err(e) => {
            eprintln!("omarchy-agent run: {e}");
            // A configuration the new agent refuses is a failed start of the new agent,
            // not a person's to fix: back to the one that read it.
            let dir = data_dir(data).unwrap_or_default();
            if let Some(p) = selfupdate::candidate(&dir, me) {
                if selfupdate::flip_back(&dir, &p).is_ok() {
                    eprintln!(
                        "omarchy-agent run: agent {me} refused its configuration; current points at {} again",
                        p.from
                    );
                    return 0;
                }
            }
            CONFIG_ERROR
        }
    }
}

/// The progress watchdog (both OSes): aborts a loop that made no progress for
/// [`WATCHDOG_S`], so the service manager starts the agent again (a counted start
/// during a self-update), and pings systemd's watchdog while the loop moves.
fn watchdog(progress: Arc<AtomicI64>) {
    thread::spawn(move || {
        let mut pinged = progress.load(Ordering::Relaxed);
        loop {
            thread::sleep(WATCHDOG_LOOK);
            let seen = progress.load(Ordering::Relaxed);
            let idle = super::now() - seen;
            if idle > WATCHDOG_S {
                eprintln!("omarchy-agent: the loop made no progress for {idle} s; aborting so the service manager restarts it");
                std::process::abort();
            }
            if seen != pinged {
                notify("WATCHDOG=1");
                pinged = seen;
            }
        }
    });
}

fn setup(
    data: Option<&str>,
    progress: &Arc<AtomicI64>,
) -> Result<(Agent, Arc<AtomicBool>), String> {
    let paths = paths(data)?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&paths.data)
        .map_err(|e| format!("{}: {e}", paths.data.display()))?;
    for d in [paths.bundles(), paths.tools(), paths.docker_config()] {
        fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
    }
    if let Some(pid) = running_agent(&paths) {
        return Err(format!(
            "another agent runs on {} as pid {pid}",
            paths.data.display()
        ));
    }
    // The pid file is the agent's own: its owner is the uid agent.toml must have.
    state::write_atomic(&paths.pid(), std::process::id().to_string().as_bytes())?;
    let uid = fs::metadata(paths.pid())
        .map_err(|e| format!("{}: {e}", paths.pid().display()))?
        .uid();
    // What the data directory holds is trusted without another check (state.json,
    // last-good/, the tools' hashes): nobody else may write there.
    let meta = fs::metadata(&paths.data).map_err(|e| format!("{}: {e}", paths.data.display()))?;
    if meta.uid() != uid || meta.mode() & 0o022 != 0 {
        return Err(format!(
            "{} must be owned by uid {uid} and writable by it alone (mode {:o})",
            paths.data.display(),
            meta.mode() & 0o7777
        ));
    }
    fault("panic-at-config");
    let cfg = Config::load(&paths.agent_toml(), uid)?;
    let state = state::load(&paths.state())?.unwrap_or_default();
    let usr1 = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGUSR1, Arc::clone(&usr1))
        .map_err(|e| format!("SIGUSR1: {e}"))?;
    let pool = Box::new(Https::new(&cfg.pool).with_progress(Arc::clone(progress)));
    let mut agent = Agent::new(cfg, paths, state, pool, Box::new(Sigstore), Drivers::Pinned);
    agent.progress = Some(Arc::clone(progress));
    agent.exe = std::env::current_exe().ok();
    agent.open_tools();
    agent.resume(super::now());
    agent.journal.write(
        super::now(),
        "start",
        serde_json::json!({"agent": crate::AGENT_VERSION, "applied": agent.state.applied.map(|r| r.to_string()), "step": agent.state.rollout.step.name()}),
    );
    agent.settle(super::now())?;
    Ok((agent, usr1))
}

fn loop_forever(agent: &mut Agent, usr1: &AtomicBool, progress: &AtomicI64) -> u8 {
    let mut failing: Option<String> = None;
    loop {
        let now = super::now();
        // A local write that failed (a full disk) is not a configuration error: the
        // state stays unsaved in memory and the step runs again at the next tick.
        match agent.tick(now, usr1.swap(false, Ordering::Relaxed)) {
            Ok(()) => failing = None,
            Err(e) if failing.as_ref() != Some(&e) => {
                eprintln!("omarchy-agent run: {e}; retrying every tick");
                failing = Some(e);
            }
            Err(_) => {}
        }
        progress.store(super::now(), Ordering::Relaxed);
        // A self-update swapped `current` (and the state is saved): the service manager
        // starts the new agent; containers keep running across the restart.
        if let (Some(code), None) = (agent.exit, &failing) {
            let _ = fs::remove_file(agent.paths.pid());
            return code;
        }
        let mut slept = Duration::ZERO;
        while slept < TICK && !usr1.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(250));
            slept += Duration::from_millis(250);
        }
    }
}

/// `omarchy-agent self-test --release vX.Y.Z [--data <dir>]`: prints `ok`, or why not.
pub fn self_test(data: Option<&str>, release: &str) -> u8 {
    let result = Release::parse(release)
        .ok_or_else(|| format!("{release:?} is not vX.Y.Z"))
        .and_then(|r| selfupdate::self_test(&paths(data)?, r, &Sigstore));
    match result {
        Ok(()) => {
            println!("ok");
            0
        }
        Err(e) => {
            eprintln!("omarchy-agent self-test: {e}");
            1
        }
    }
}

/// `omarchy-agent status`: state.json and run/capacity.json only, so it answers with the
/// pool and the engine down.
pub fn status(data: Option<&str>) -> u8 {
    let paths = match paths(data) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("omarchy-agent status: {e}");
            return CONFIG_ERROR;
        }
    };
    let s = match state::load(&paths.state()) {
        Ok(Some(s)) => s,
        Ok(None) => {
            println!(
                "omarchy-agent {}: no state yet ({} has not run)",
                crate::AGENT_VERSION,
                paths.state().display()
            );
            print_pending(&paths);
            return 0;
        }
        Err(e) => {
            eprintln!("omarchy-agent status: {e}");
            return CONFIG_ERROR;
        }
    };
    print!("{}", summary(&s, crate::run::now()));
    print_pending(&paths);
    let capacity = fs::read_to_string(paths.agent_toml())
        .ok()
        .and_then(|t| Config::parse(&t).ok())
        .map(|c| c.set_dir.join("run/capacity.json"));
    match capacity.map(|p| (fs::read_to_string(&p), p)) {
        Some((Ok(text), _)) => println!(
            "capacity:  {}",
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        ),
        Some((Err(_), p)) => println!("capacity:  {} is missing", p.display()),
        None => println!("capacity:  agent.toml does not name the set directory"),
    }
    0
}

/// A self-update in flight (#316), from `pending`.
fn print_pending(paths: &Paths) {
    if let Some(p) = selfupdate::read_pending(&paths.data) {
        println!(
            "update:    agent {} to {}: start {} of {}, its health gate open for {} s more",
            p.from,
            p.to,
            p.tries,
            selfupdate::MAX_TRIES + 1,
            (p.deadline - crate::run::now()).max(0)
        );
    }
}

fn opt<T: ToString>(v: Option<T>) -> String {
    v.map_or_else(|| "none".into(), |v| v.to_string())
}

pub(crate) fn summary(s: &State, now: i64) -> String {
    let mut out = String::new();
    let mut line = |k: &str, v: String| {
        let _ = writeln!(out, "{k:<10} {v}");
    };
    line(
        "agent:",
        format!(
            "{} (state written by {}){}",
            crate::AGENT_VERSION,
            s.agent,
            s.agent_skip.map_or_else(String::new, |v| format!(
                "; {v} was rolled back here and is skipped until a higher one"
            ))
        ),
    );
    line(
        "release:",
        format!(
            "applied {}, target {}, floor {}, min_release {}",
            opt(s.applied),
            opt(s.target),
            opt(s.floor),
            opt(s.min_release)
        ),
    );
    if !s.revoked.is_empty() {
        line(
            "revoked:",
            s.revoked
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    let r = &s.rollout;
    line(
        "rollout:",
        format!(
            "{} since {} s{}",
            r.step.name(),
            (now - r.since).max(0),
            r.target.map_or_else(String::new, |t| format!(
                ", to {t}{}",
                if r.rollback { " (rollback)" } else { "" }
            ))
        ),
    );
    if !s.round.outcome.is_empty() {
        line(
            "round:",
            format!(
                "{} {} s ago at {}{}: {}",
                s.round.outcome,
                (now - s.round.at).max(0),
                s.round.step,
                s.round
                    .from
                    .map_or_else(String::new, |f| format!(", from {f}")),
                s.round.detail
            ),
        );
    }
    for (rel, q) in &s.quarantine {
        line(
            "quarantine:",
            match q.until {
                Some(u) if u > now => format!("{rel} for {} s more", u - now),
                Some(_) => format!("{rel}: retried at the next poll"),
                None => format!("{rel} until a newer release"),
            },
        );
    }
    line(
        "pool:",
        format!(
            "{} {} s ago; next poll in {} s",
            if s.poll.last.is_empty() {
                "not asked yet"
            } else {
                s.poll.last.as_str()
            },
            (now - s.poll.last_at).max(0),
            (s.poll.next_at - now).max(0)
        ),
    );
    out
}

/// The pid of another `omarchy-agent` process that agent.pid names, if one runs: a
/// stale pid file never names a process that is not the agent.
fn running_agent(paths: &Paths) -> Option<String> {
    let pid = fs::read_to_string(paths.pid()).ok()?;
    let pid = pid.trim();
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if pid == std::process::id().to_string() {
        return None;
    }
    let comm = fs::read_to_string(format!("/proc/{pid}/comm")).or_else(|_| {
        let o = std::process::Command::new("ps")
            .args(["-o", "comm=", "-p", pid])
            .output()?;
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&o.stdout).into_owned())
    });
    let comm = comm.ok()?;
    (comm.trim().rsplit('/').next() == Some("omarchy-agent")).then(|| pid.to_owned())
}

/// `omarchy-agent round`: asks the running agent for a round now (SIGUSR1).
pub fn round(data: Option<&str>) -> u8 {
    let result = paths(data).and_then(|p| {
        let pid = running_agent(&p).ok_or_else(|| {
            format!(
                "{} names no running agent (is the agent running?)",
                p.pid().display()
            )
        })?;
        let ok = std::process::Command::new("/bin/kill")
            .args(["-USR1", &pid])
            .status()
            .map_err(|e| format!("kill: {e}"))?
            .success();
        if ok {
            Ok(pid)
        } else {
            Err(format!("no agent runs as pid {pid}"))
        }
    });
    match result {
        Ok(pid) => {
            println!("asked the agent (pid {pid}) for a round now");
            0
        }
        Err(e) => {
            eprintln!("omarchy-agent round: {e}");
            1
        }
    }
}

/// `omarchy-agent logs [-n N]`: the journal's last lines (the rotated file first).
pub fn logs(data: Option<&str>, lines: usize) -> u8 {
    let paths = match paths(data) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("omarchy-agent logs: {e}");
            return CONFIG_ERROR;
        }
    };
    print!("{}", tail(&paths.journal(), lines));
    0
}

pub(crate) fn tail(journal: &Path, lines: usize) -> String {
    let mut all: Vec<String> = Vec::new();
    for p in [journal.with_extension("ndjson.1"), journal.to_owned()] {
        if let Ok(text) = fs::read_to_string(&p) {
            all.extend(text.lines().map(str::to_owned));
        }
    }
    let start = all.len().saturating_sub(lines);
    let mut out = String::new();
    for l in &all[start..] {
        out.push_str(l);
        out.push('\n');
    }
    out
}
