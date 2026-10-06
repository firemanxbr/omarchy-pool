//! The commands: `run` (the loop), `status` (works with the pool down), `round`
//! (SIGUSR1 to the running agent), `logs` (the journal's tail), `self-test` (what a
//! self-update asks of a new agent before it hands over, #316), `runtime switch` (the
//! owner's move of the bundle to another driver, #325) and `envelope pin-passkey` (the
//! owner's passkey pinned at the host, #328).

use std::fmt::Write as _;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use super::agent::{Agent, Drivers, HostEnv, Sigstore};
use super::config::{data_dir, Config, Paths};
use super::pool::Https;
use super::selfupdate::{self, notify, Start};
use super::state::{self, State};
use crate::dispatcher_env::Sources;
use crate::version::{self, Release};

/// Local configuration errors only (design v2 §16.4): systemd's
/// `RestartPreventExitStatus=78` leaves the agent stopped until a person fixes it.
pub const CONFIG_ERROR: u8 = 78;
/// The loop ticks this often; nothing in a tick blocks longer than one timed-out call.
const TICK: Duration = Duration::from_secs(3);
/// The watchdog aborts a loop that made no progress for this long. A download moves the
/// progress on as its bytes arrive.
const WATCHDOG_S: i64 = 15 * 60;
/// A self-update's candidate is ended this long after its health gate's deadline, when
/// its loop did not give up by itself (it hangs): the start that follows rolls it back.
const GATE_GRACE_S: i64 = 30;
/// How often the watchdog thread looks; it pings systemd's watchdog (`WatchdogSec=300`)
/// only when the loop made progress since its last look.
const WATCHDOG_LOOK: Duration = Duration::from_secs(10);
/// Two of the watchdog's looks this much further apart than [`WATCHDOG_LOOK`] on the wall
/// clock: the machine slept (a Mac's lid, #320), and the loop with it.
const WATCHDOG_WAKE_S: i64 = 60;
/// Under launchd, a configuration the agent refuses is read again this often, and the
/// agent exits after this long at most (`KeepAlive` starts it again at once otherwise).
const CONFIG_LOOK: Duration = Duration::from_secs(5);
const CONFIG_WAIT: Duration = Duration::from_secs(600);

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

/// `omarchy-agent run [--data-dir <dir>]`: the loop, until stopped (or until a self-update
/// swapped `current`: exit 0 and the service manager starts the new agent).
pub fn run(data: Option<&str>) -> u8 {
    let me = version::agent();
    // A self-update's start is counted before agent.toml or state.json are read (#316);
    // a second `run` beside the running agent is no start of it: neither counted nor
    // flipped back.
    if let Ok(p) = paths(data) {
        if let Some(pid) = running_agent(&p) {
            eprintln!(
                "omarchy-agent run: another agent runs on {} as pid {pid}",
                p.data.display()
            );
            return CONFIG_ERROR;
        }
        if let Start::RolledBack(why) = selfupdate::count_start(&p.data, me, super::now()) {
            eprintln!("omarchy-agent run: {why}");
            return 0;
        }
    }
    let progress = Arc::new(AtomicI64::new(super::now()));
    watchdog(Arc::clone(&progress), data_dir(data).ok(), me);
    match setup(data, &progress) {
        Ok((mut agent, usr1)) => {
            fault("hang-before-ready");
            notify("READY=1");
            fault("hang-after-ready");
            // After READY=1: the pinned tools may be downloaded again, longer than
            // TimeoutStartSec allows.
            agent.open_tools();
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
            // systemd stops on 78 (`RestartPreventExitStatus`); launchd's `KeepAlive` has
            // no such thing and would start the agent every 10 s, each start saying the
            // same: the agent waits for agent.toml to change instead (#320).
            if under_launchd(std::env::var("XPC_SERVICE_NAME").ok().as_deref()) {
                let toml = Paths { data: dir }.agent_toml();
                eprintln!(
                    "omarchy-agent run: waiting for {} to change (at most {} minutes) before launchd starts the agent again",
                    toml.display(),
                    CONFIG_WAIT.as_secs() / 60
                );
                wait_for_change(&toml, CONFIG_LOOK, CONFIG_WAIT);
            }
            CONFIG_ERROR
        }
    }
}

/// Whether launchd started this process as the agent's `LaunchAgent` (it names the job in
/// `XPC_SERVICE_NAME`); a person running `omarchy-agent run` by hand is not.
pub(crate) fn under_launchd(xpc_service_name: Option<&str>) -> bool {
    xpc_service_name == Some(crate::install::launchd::LABEL)
}

/// Waits until `path` changes (its size, its modification time, or it appears or goes),
/// looking every `look`, and at most `limit`.
pub(crate) fn wait_for_change(path: &Path, look: Duration, limit: Duration) -> bool {
    let stamp = || {
        fs::metadata(path)
            .ok()
            .map(|m| (m.len(), m.modified().ok()))
    };
    let before = stamp();
    let mut waited = Duration::ZERO;
    while waited < limit {
        thread::sleep(look);
        waited += look;
        if stamp() != before {
            return true;
        }
    }
    false
}

/// The progress watchdog (both OSes): aborts a loop that made no progress for
/// [`WATCHDOG_S`], so the service manager starts the agent again (a counted start
/// during a self-update), and pings systemd's watchdog while the loop moves. launchd
/// restarts only on exit and has no watchdog of its own (#320): a self-update's candidate
/// whose loop hangs past its health gate's deadline is aborted too, and the next start
/// points `current` back. A Mac that slept stopped the loop and this thread alike: the
/// look after a wake starts the count again ([`watchdog_look`]) rather than end a loop
/// whose first tick after the wake is a slow one (the pool, the VM's clock).
fn watchdog(progress: Arc<AtomicI64>, data: Option<std::path::PathBuf>, me: version::Version) {
    thread::spawn(move || {
        let mut pinged = progress.load(Ordering::Relaxed);
        let mut last_look = super::now();
        loop {
            thread::sleep(WATCHDOG_LOOK);
            let now = super::now();
            let seen = progress.load(Ordering::Relaxed);
            let gate = data
                .as_deref()
                .and_then(|d| selfupdate::candidate(d, me))
                .map(|p| p.deadline);
            match watchdog_look(now, last_look, seen, gate) {
                Look::Woke => {
                    progress.fetch_max(now, Ordering::Relaxed);
                }
                Look::Abort(why) => {
                    eprintln!("omarchy-agent: {why}; aborting so the service manager restarts it");
                    std::process::abort();
                }
                Look::Fine => {}
            }
            last_look = now;
            if seen != pinged {
                notify("WATCHDOG=1");
                pinged = seen;
            }
        }
    });
}

/// What the watchdog does at one look.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Look {
    Fine,
    /// The wall clock jumped since the last look ([`WATCHDOG_WAKE_S`]): the machine slept.
    /// The loop's idleness counts from now; nothing is judged at this look.
    Woke,
    Abort(String),
}

/// One look of the watchdog at `now`, the last one at `last_look`.
pub(crate) fn watchdog_look(
    now: i64,
    last_look: i64,
    progress: i64,
    gate_deadline: Option<i64>,
) -> Look {
    #[allow(clippy::cast_possible_wrap)] // ten seconds
    let every = WATCHDOG_LOOK.as_secs() as i64;
    if now - last_look > every + WATCHDOG_WAKE_S {
        return Look::Woke;
    }
    watchdog_verdict(now, progress, gate_deadline).map_or(Look::Fine, Look::Abort)
}

/// Why the watchdog ends the loop now, if it does: no progress for [`WATCHDOG_S`], or a
/// self-update's health gate whose deadline passed [`GATE_GRACE_S`] ago with the gate
/// still shut (a running loop gives up by itself at the deadline; one that hangs does not).
pub(crate) fn watchdog_verdict(
    now: i64,
    progress: i64,
    gate_deadline: Option<i64>,
) -> Option<String> {
    let idle = now - progress;
    if idle > WATCHDOG_S {
        return Some(format!("the loop made no progress for {idle} s"));
    }
    gate_deadline.filter(|d| now > d + GATE_GRACE_S).map(|d| {
        format!(
            "this agent's health gate is still shut {} s past its deadline",
            now - d
        )
    })
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
    // The host state and the report are signed with the key the enrollment made (#344).
    // Without it they answer "no answer" (the agent keeps running and says why); a missing
    // key is no reason to stop.
    let mut https = Https::new(&cfg.pool).with_progress(Arc::clone(progress));
    let key_error = match crate::host::HostKey::load_in(&paths.host_key_dir()) {
        Ok(k) => {
            https = https.with_host(k, &cfg.host_id);
            None
        }
        Err(e) => Some(e),
    };
    let pool = Box::new(https);
    let vm = cfg
        .vm
        .as_ref()
        .map(|v| keeper(&cfg, v, &paths))
        .transpose()?;
    let mut agent = Agent::new(cfg, paths, state, pool, Box::new(Sigstore), Drivers::Pinned);
    agent.vm = vm;
    // A Mac's sleep (#329) is the agent's to hold off and report, whatever runtime its
    // engine is in.
    agent.power = super::power::keeper(&agent.cfg, agent.mac);
    if let Some(e) = key_error {
        agent.journal.write(
            super::now(),
            "host-key",
            serde_json::json!({"detail": format!("{e}: the host state and the report cannot be signed; the agent keeps the set running")}),
        );
    }
    agent.progress = Some(Arc::clone(progress));
    agent.exe = std::env::current_exe().ok();
    agent.host_env = Some(HostEnv::new(Sources::system()));
    // The seal key (#328): made at the first start that has none, its fingerprint on the
    // journal, kept in the login keychain on a Mac. One that cannot be loaded now is no
    // reason to stop: the loop tries again, and takes no sealed key meanwhile.
    agent.keychain = super::owner::keychain();
    let _ = agent.seal_key(super::now());
    agent.resume(super::now());
    agent.journal.write(
        super::now(),
        "start",
        serde_json::json!({"agent": crate::AGENT_VERSION, "applied": agent.state.applied.map(|r| r.to_string()), "step": agent.state.rollout.step.name()}),
    );
    agent.settle(super::now())?;
    Ok((agent, usr1))
}

/// A Mac's VM keeper (#320): the `omarchy` profile as agent.toml describes it, walled by
/// the task firewall for agent.toml's task subnets. Colima gets the pinned docker CLI once
/// the loop has its tools ([`Agent::open_tools`]), and the agent's own `DOCKER_CONFIG`.
fn keeper(cfg: &Config, v: &super::config::Vm, paths: &Paths) -> Result<super::vm::Keeper, String> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let colima_home = crate::vm::colima_home(&home, std::env::var_os("COLIMA_HOME").as_deref());
    let want = crate::vm::Want {
        size: crate::vm::Size {
            cpus: v.cpus,
            mem_gb: v.mem_gb,
        },
        disk_gb: v.disk_gb,
        mounts: crate::vm::mounts(&cfg.work_root, &cfg.secrets_dir, &cfg.set_dir),
        rosetta: v.rosetta,
    };
    let subnets = crate::install::net::parse_list(
        cfg.task_subnets
            .as_deref()
            .unwrap_or(crate::install::TASK_SUBNETS),
    )
    .map_err(|e| format!("agent.toml: envelope.task_subnets: {e}"))?;
    Ok(super::vm::Keeper::new(
        Box::new(super::vm::Cli {
            colima_home,
            docker_config: paths.docker_config(),
            docker: None,
            start: None,
        }),
        want,
        crate::vm::firewall(&subnets),
        &home,
        &paths.data,
    ))
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

/// `omarchy-agent envelope pin-passkey [<pin> | -]` and `envelope unpin-passkey` (#328), at
/// the host, as the agent's user: the owner's passkey pinned from the pin the site printed
/// (read from stdin when it is not given), or no passkey pinned any more. The running agent
/// reads the pin at the next signed order; nothing needs restarting.
pub fn envelope(data: Option<&str>, cmd: &str, pin: Option<&str>) -> u8 {
    let paths = match paths(data) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("omarchy-agent envelope: {e}");
            return 2;
        }
    };
    let state = paths.data.join("state");
    let said = match cmd {
        "pin-passkey" => {
            let uid = rustix::process::geteuid().as_raw();
            match Config::load(&paths.agent_toml(), uid) {
                Err(e) => Err(format!(
                    "{e}: a passkey is pinned on a host that is installed and confirmed"
                )),
                Ok(cfg) => {
                    let text = match pin {
                        Some(t) if t != "-" => Ok(t.to_owned()),
                        _ => {
                            use std::io::Read as _;
                            let mut t = String::new();
                            std::io::stdin()
                                .take(64 << 10)
                                .read_to_string(&mut t)
                                .map(|_| t)
                                .map_err(|e| format!("stdin: {e}"))
                        }
                    };
                    text.and_then(|t| {
                        crate::owner::pin(&state, &cfg.host_id, &cfg.pool, &t, super::now())
                    })
                }
            }
        }
        _ => crate::owner::unpin(&state),
    };
    match said {
        Ok(s) => {
            println!("{s}");
            0
        }
        Err(e) => {
            eprintln!("omarchy-agent envelope {cmd}: {e}");
            1
        }
    }
}

/// `omarchy-agent self-test --release vX.Y.Z [--data-dir <dir>]`: prints `ok`, or why not.
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
            print!("{}", host_key_line(&paths.host_key_dir()));
            return 0;
        }
        Err(e) => {
            eprintln!("omarchy-agent status: {e}");
            return CONFIG_ERROR;
        }
    };
    print!("{}", summary(&s, crate::run::now()));
    print_pending(&paths);
    let cfg = fs::read_to_string(paths.agent_toml())
        .ok()
        .and_then(|t| Config::parse(&t).ok());
    let capacity = cfg.as_ref().map(|c| c.set_dir.join("run/capacity.json"));
    match capacity.map(|p| (fs::read_to_string(&p), p)) {
        Some((Ok(text), _)) => println!(
            "capacity:  {}",
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        ),
        Some((Err(_), p)) => println!("capacity:  {} is missing", p.display()),
        None => println!("capacity:  agent.toml does not name the set directory"),
    }
    if let Some(c) = &cfg {
        println!("driver:    {}", driver_line(c));
    }
    print!("{}", host_key_line(&paths.host_key_dir()));
    print!("{}", owner_lines(&paths.data.join("state")));
    0
}

/// `status`'s line for the host key: its fingerprint, the one the host's page shows, and
/// where it lives — in the TPM, or a file (#330). The TPM is not asked: its files say.
fn host_key_line(state: &Path) -> String {
    match crate::host::HostKey::load_in(state) {
        Ok(k) => format!("{:<10} {} {}\n", "host key:", k.fingerprint(), k.describe()),
        Err(_) if !state.join(crate::host::IDENTITY_FILE).exists() => {
            format!(
                "{:<10} none yet: this machine has not enrolled\n",
                "host key:"
            )
        }
        Err(e) => format!("{:<10} {e}\n", "host key:"),
    }
}

/// The driver agent.toml names and where it runs the set (#330: the Quadlet driver's units).
fn driver_line(c: &Config) -> String {
    let on = c.socket_cli.display();
    match (c.driver, c.driver_name()) {
        (super::config::DriverKind::Quadlet, _) => format!(
            "quadlet on {on}, its units in {}",
            c.quadlet_dir()
                .map_or_else(|e| e, |d| d.display().to_string())
        ),
        (_, Some(name)) => format!("{name} on {on}"),
        (_, None) => format!("compose on {on} (the engine says which at the agent's start)"),
    }
}

/// `status`'s lines for #328: the passkey pinned at this host and the last signed version
/// it took, and the seal key's fingerprint, which its owner compares on the site once.
fn owner_lines(state: &Path) -> String {
    let mut out = String::new();
    match crate::owner::Record::load(state) {
        Ok(r) => match &r.passkey {
            Some(p) => {
                let _ = writeln!(
                    out,
                    "{:<10} {}'s passkey pinned ({}, credential {}…) for {} on {} since {}; last signed version {}",
                    "owner:",
                    p.by,
                    crate::owner::webauthn::alg_name(p.alg),
                    p.credential.chars().take(12).collect::<String>(),
                    p.rp_id,
                    p.origin,
                    p.pinned_at,
                    r.version
                );
            }
            None => {
                let _ = writeln!(
                    out,
                    "{:<10} no passkey pinned: the site widens nothing and sets no agent key here (`omarchy-agent envelope pin-passkey`)",
                    "owner:"
                );
            }
        },
        Err(e) => {
            let _ = writeln!(out, "{:<10} {e}", "owner:");
        }
    }
    if let Some(k) = crate::owner::seal::read_public(state) {
        let raw = crate::owner::webauthn::unb64(&k, "", 64).unwrap_or_default();
        let _ = writeln!(
            out,
            "{:<10} {} (the host's page shows the same before its owner confirms it)",
            "seal key:",
            crate::owner::seal::fingerprint_of(&raw)
        );
    }
    out
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
    out.push_str(&orders_lines(s, now));
    out.push_str(&p4_lines(s, now));
    out.push_str(&soak_lines(s, now));
    out
}

/// `status`'s lines for #326: the owner's soak of the release the pool names, and what
/// GitHub showed last (freeze detection).
fn soak_lines(s: &State, now: i64) -> String {
    let mut out = String::new();
    let mut line = |k: &str, v: String| {
        let _ = writeln!(out, "{k:<10} {v}");
    };
    if let Some(k) = s
        .soak
        .as_ref()
        .filter(|k| s.target == Some(k.release) && s.applied.is_some_and(|a| a < k.release))
    {
        line(
            "soak:",
            if k.until > now {
                format!(
                    "{} waits {} s more (named {} s ago; a rollback statement skips it)",
                    k.release,
                    k.until - now,
                    (now - k.seen).max(0)
                )
            } else {
                format!("{} soaked: its round goes", k.release)
            },
        );
    }
    let g = &s.github;
    if let Some(latest) = g.latest {
        let behind = if g.behind {
            format!(
                "; pool-behind-github: the pool names {} since {} s",
                opt(s.target),
                g.ahead_since.map_or(0, |a| (now - a).max(0))
            )
        } else {
            String::new()
        };
        line(
            "github:",
            format!(
                "latest release {latest}, read {} s ago; next in {} s{behind}",
                (now - g.read_at).max(0),
                (g.next_at - now).max(0)
            ),
        );
    }
    out
}

/// `status`'s lines for P4 (#325): the settings the pool narrowed, the brake, and the
/// owner's runtime switch.
fn p4_lines(s: &State, now: i64) -> String {
    use super::brake::Ask;
    let mut out = String::new();
    let mut line = |k: &str, v: String| {
        let _ = writeln!(out, "{k:<10} {v}");
    };
    if let Some(set) = &s.settings {
        line(
            "settings:",
            format!(
                "units {}, emulated lanes {} (the pool's narrowing, inside the envelope)",
                set.units
                    .map_or_else(|| "as the envelope".to_owned(), |u| u.to_string()),
                set.emulate.as_ref().map_or_else(
                    || "as the envelope".to_owned(),
                    |e| if e.is_empty() {
                        "none".to_owned()
                    } else {
                        e.join(", ")
                    }
                )
            ),
        );
    }
    let brake = &s.brake;
    let (orders, restarts, narrowings, releases) = (
        brake.count(Ask::Order, now),
        brake.count(Ask::Restart, now),
        brake.count(Ask::Narrowing, now),
        brake.count(Ask::Release, now),
    );
    if orders + restarts + narrowings + releases > 0 {
        line(
            "brake:",
            format!(
                "{orders}/{} host orders, {restarts}/{} dispatcher restarts, {narrowings}/{} narrowings in the last hour; {releases}/1 release change in the last 10 min",
                super::brake::ORDERS_PER_HOUR,
                super::brake::RESTARTS_PER_HOUR,
                super::brake::NARROWINGS_PER_HOUR
            ),
        );
    }
    if let Some(sw) = &s.switch {
        line(
            "switching:",
            format!(
                "to {} at {} from {}, at its {} step for {} s{}",
                sw.to.name(),
                sw.to.socket_cli.display(),
                sw.from.name(),
                match sw.step {
                    super::switch::SwitchStep::Stop => "stop",
                    super::switch::SwitchStep::Up => "up",
                    super::switch::SwitchStep::Back => "back",
                    super::switch::SwitchStep::Return => "return",
                },
                (now - sw.since).max(0),
                sw.why
                    .as_ref()
                    .map_or_else(String::new, |w| format!(": {w}"))
            ),
        );
    }
    if let Some(e) = &s.switch_last {
        line(
            "switch:",
            format!(
                "to {} {} {} s ago: {}",
                e.to,
                e.outcome,
                (now - e.at).max(0),
                e.detail
            ),
        );
    }
    out
}

/// `omarchy-agent runtime switch <driver> [--socket <path>] [--data-dir <dir>]` (#325): the
/// request for the running agent, which it takes between rounds; SIGUSR1 wakes it.
pub fn runtime_switch(data: Option<&str>, driver: &str, socket: Option<&str>) -> u8 {
    let result = paths(data).and_then(|p| {
        let said = super::switch::request(&p.data, driver, socket.map(Path::new))?;
        if let Some(pid) = running_agent(&p) {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-USR1", &pid])
                .status();
            Ok(said)
        } else {
            Ok(format!(
                "{said}\nno agent runs on {} now: it takes the request when it starts",
                p.data.display()
            ))
        }
    });
    match result {
        Ok(said) => {
            println!("omarchy-agent: {said}");
            0
        }
        Err(e) => {
            eprintln!("omarchy-agent runtime switch: {e}");
            1
        }
    }
}

/// `status`'s lines for the host orders (#344): a `retire-legacy` in flight, and the
/// last answers.
fn orders_lines(s: &State, now: i64) -> String {
    let mut out = String::new();
    let mut line = |k: &str, v: String| {
        let _ = writeln!(out, "{k:<10} {v}");
    };
    if let Some(r) = &s.orders.retire {
        line(
            "retiring:",
            format!(
                "legacy project {} ({}) for {} s, at its {} step (order {})",
                r.project,
                r.dir.display(),
                (now - r.since).max(0),
                if r.step == super::state::RetireStep::Stop {
                    "stop"
                } else {
                    "remove"
                },
                r.order
            ),
        );
    }
    for a in &s.orders.answers {
        line(
            "order:",
            format!(
                "{} {} {} {} s ago: {}",
                a.id,
                a.kind,
                a.outcome,
                (now - a.at).max(0),
                a.detail
            ),
        );
    }
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
