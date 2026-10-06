//! A Mac host that sleeps (#329; design v2 §19.2, P5): a sleeping host has zero free
//! units. Every Mac agent has this keeper ([`keeper`]), whatever runtime its engine is in —
//! the `omarchy` Colima VM it manages, or Docker Desktop's or `OrbStack`'s, which it only
//! uses. While a task runs the agent holds a `PreventUserIdleSystemSleep` assertion, so the
//! Mac does not idle into sleep under it, and lets it go once none runs. A task runs from its
//! claim to its report: while a container labelled `com.omarchy.task` runs
//! ([`super::driver::TASK_LABEL`]), and while the dispatcher holds its lease with no container
//! running yet or any more — staging its inputs, uploading its outputs ([`leases_held`]).
//! When the Mac goes to sleep anyway — idle with no task, the lid, the Apple menu — the
//! agent hears it first, reports `asleep: true` and only then lets it sleep: the pool hands
//! the host's dispatcher nothing more. After the wake it reports `asleep: false`, asks the
//! pool for its target at once and, where it keeps the VM, checks the VM's clock
//! ([`super::vm`]); the dispatcher claims again with nobody's action.
//! A task the sleep caught is the pool's to requeue when its lease expires, as on any host
//! that goes away.
//!
//! The agent's own code holds no `unsafe` and links no Apple SDK, so both halves are
//! documented macOS tools the agent runs as children, behind [`Power`] (played in the tests):
//! - the assertion is a `caffeinate -i -w <agent pid>`, which holds exactly
//!   `PreventUserIdleSystemSleep` while it runs and ends with the agent whatever ends it;
//! - the sleep is heard through `AppKit`'s `NSWorkspaceWillSleepNotification` and
//!   `NSWorkspaceDidWakeNotification`, observed by a JavaScript for Automation script
//!   ([`WATCHER`], `osascript -l JavaScript`). `AppKit` posts the first on
//!   `kIOMessageSystemWillSleep` — after `kIOMessageCanSystemSleep` for an idle sleep, and
//!   alone for a forced one, which the idle message never announces — and macOS lets an
//!   observer hold the sleep up to 30 s: the script says `sleep` and waits for the agent's
//!   line, which comes once its report was sent. A crate that registers with `IOKit` itself
//!   would put another author's FFI into the agent that holds the host key; a parse of the
//!   unified log would read words Apple does not document. A watcher that does not start or
//!   ends is said and started again ten minutes later: the assertion does not need it, and a
//!   sleep it misses costs what it costs today, the leases.
//!
//! An engine that stops answering keeps the assertion for a lease's length at most
//! ([`UNANSWERED_S`]): past it a task the agent cannot confirm is the pool's to requeue, and a
//! laptop is not kept awake on its battery for one.
//!
//! What the agent reports as `asleep` mends itself: a gap in the loop's ticks
//! ([`crate::vm::WAKE_GAP_S`]) is a wake the watcher did not say, and two minutes of ticks
//! with no gap after a sleep was heard is a sleep that did not happen. It is never saved: a
//! new agent runs, so the Mac is awake.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;

use super::config::Config;
use super::exec::retry_busy;
use super::journal::Journal;

/// macOS's own tool for an assertion: `-i` is `PreventUserIdleSystemSleep`.
const CAFFEINATE: &str = "/usr/bin/caffeinate";
const OSASCRIPT: &str = "/usr/bin/osascript";
/// How often the engine is asked whether a task runs.
const LOOK_S: i64 = 10;
/// A watcher that did not start, or ended, is started again this much later.
const LISTEN_AGAIN_S: i64 = 600;
/// A sleep heard this long ago with the loop ticking on and no wake: none happened.
const AWAKE_S: i64 = 120;
/// A lease's length (the pool's `LEASE_MINUTES`): an assertion held while the engine has not
/// answered for this long is let go, and a lease file the dispatcher has not rewritten for
/// this long ([`leases_held`]) holds nothing — either way the pool has requeued the task.
pub(crate) const UNANSWERED_S: i64 = 30 * 60;

/// The sleep watcher (`osascript -l JavaScript -e`): one line on stdout per event —
/// `ready` once its observers are in place, `sleep` before the Mac sleeps, `wake` after it
/// woke. After `sleep` it waits for one line on stdin, the agent's `ok`, and the Mac waits
/// with it (`AppKit` lets an observer hold a sleep up to 30 s, then sleeps whatever it does);
/// the end of stdin is the agent gone, and so is a parent that changed (checked every five
/// seconds): the watcher never outlives the agent that started it. `AppKit`'s notifications
/// need an application's run loop, so it runs one, never shown (activation policy 2,
/// `NSApplicationActivationPolicyProhibited`).
pub(crate) const WATCHER: &str = r"ObjC.import('AppKit');
ObjC.import('stdlib');
ObjC.import('unistd');
var agent = $.getppid();
var out = $.NSFileHandle.fileHandleWithStandardOutput;
var input = $.NSFileHandle.fileHandleWithStandardInput;
function say(word) {
  out.writeData($(word + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
ObjC.registerSubclass({
  name: 'OmarchyAgentSleepWatch',
  methods: {
    'willSleep:': {
      types: ['void', ['id']],
      implementation: function (n) {
        say('sleep');
        if (input.availableData.length == 0) { $.exit(0); }
      }
    },
    'didWake:': {
      types: ['void', ['id']],
      implementation: function (n) { say('wake'); }
    },
    'look:': {
      types: ['void', ['id']],
      implementation: function (t) { if ($.getppid() != agent) { $.exit(0); } }
    }
  }
});
var watch = $.OmarchyAgentSleepWatch.alloc.init;
var center = $.NSWorkspace.sharedWorkspace.notificationCenter;
center.addObserverSelectorNameObject(watch, 'willSleep:', $('NSWorkspaceWillSleepNotification'), $());
center.addObserverSelectorNameObject(watch, 'didWake:', $('NSWorkspaceDidWakeNotification'), $());
$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(5, watch, 'look:', $(), true);
var app = $.NSApplication.sharedApplication;
app.setActivationPolicy(2);
say('ready');
app.run;
";

/// What the sleep watcher said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Heard {
    /// Its observers are in place.
    Ready,
    /// The Mac goes to sleep, and waits for [`Power::let_sleep`].
    Sleep,
    Wake,
    /// The watcher ended, with its last word on stderr.
    Gone(String),
}

/// The Mac's power, as the keeper drives it.
pub(crate) trait Power {
    /// Holds `PreventUserIdleSystemSleep`, or keeps the assertion held.
    fn hold(&mut self) -> Result<(), String>;
    /// Whether the assertion stands: its holder still runs.
    fn held(&mut self) -> bool;
    fn release(&mut self);
    /// Starts the sleep watcher.
    fn listen(&mut self) -> Result<(), String>;
    /// What the watcher said since the last call, in order.
    fn heard(&mut self) -> Vec<Heard>;
    /// The sleep the watcher holds goes on.
    fn let_sleep(&mut self);
}

/// The real one: `caffeinate` and the watcher, children of the agent.
pub(crate) struct Mac {
    /// `caffeinate` and `osascript` (stand-ins in the tests).
    caffeinate_bin: PathBuf,
    osascript_bin: PathBuf,
    caffeinate: Option<Child>,
    watcher: Option<Watcher>,
}

impl Default for Mac {
    fn default() -> Self {
        Mac::with(Path::new(CAFFEINATE), Path::new(OSASCRIPT))
    }
}

struct Watcher {
    child: Child,
    stdin: Option<ChildStdin>,
    heard: mpsc::Receiver<Heard>,
}

impl Mac {
    pub fn with(caffeinate: &Path, osascript: &Path) -> Self {
        Mac {
            caffeinate_bin: caffeinate.to_owned(),
            osascript_bin: osascript.to_owned(),
            caffeinate: None,
            watcher: None,
        }
    }

    /// The watcher ended: reaped, so a new one may start.
    fn reap(&mut self) {
        if let Some(mut w) = self.watcher.take() {
            let _ = w.child.kill();
            let _ = w.child.wait();
        }
    }
}

impl Power for Mac {
    fn hold(&mut self) -> Result<(), String> {
        if self.held() {
            return Ok(());
        }
        // `-w`: the assertion ends with the agent, even one the watchdog aborted.
        let pid = std::process::id().to_string();
        let mut cmd = Command::new(&self.caffeinate_bin);
        cmd.args(["-i", "-w", &pid])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = retry_busy(|| cmd.spawn())
            .map_err(|e| format!("could not start {}: {e}", self.caffeinate_bin.display()))?;
        self.caffeinate = Some(child);
        Ok(())
    }

    fn held(&mut self) -> bool {
        let running = self
            .caffeinate
            .as_mut()
            .is_some_and(|c| matches!(c.try_wait(), Ok(None)));
        if !running {
            // Ended (and reaped by try_wait), or never started.
            self.caffeinate = None;
        }
        running
    }

    fn release(&mut self) {
        if let Some(mut c) = self.caffeinate.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    fn listen(&mut self) -> Result<(), String> {
        self.reap();
        let mut cmd = Command::new(&self.osascript_bin);
        cmd.args(["-l", "JavaScript", "-e", WATCHER])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = retry_busy(|| cmd.spawn())
            .map_err(|e| format!("could not start {}: {e}", self.osascript_bin.display()))?;
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            // The last line on stderr says why it ended (osascript's own error, its exit).
            let last = thread::spawn(move || {
                let mut s = String::new();
                if let Some(mut e) = stderr {
                    let _ = e.read_to_string(&mut s);
                }
                s.lines()
                    .rev()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .map(str::to_owned)
            });
            if let Some(out) = stdout {
                for line in BufReader::new(out).lines() {
                    let Ok(line) = line else { break };
                    let h = match line.trim() {
                        "ready" => Heard::Ready,
                        "sleep" => Heard::Sleep,
                        "wake" => Heard::Wake,
                        _ => continue,
                    };
                    if tx.send(h).is_err() {
                        return;
                    }
                }
            }
            let why = last
                .join()
                .ok()
                .flatten()
                .unwrap_or_else(|| "it ended".into());
            let _ = tx.send(Heard::Gone(why));
        });
        self.watcher = Some(Watcher {
            stdin: child.stdin.take(),
            child,
            heard: rx,
        });
        Ok(())
    }

    fn heard(&mut self) -> Vec<Heard> {
        let Some(w) = self.watcher.as_ref() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        loop {
            match w.heard.try_recv() {
                Ok(h) => out.push(h),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    if !matches!(out.last(), Some(Heard::Gone(_))) {
                        out.push(Heard::Gone("it ended".into()));
                    }
                    break;
                }
            }
        }
        if matches!(out.last(), Some(Heard::Gone(_))) {
            self.reap();
        }
        out
    }

    fn let_sleep(&mut self) {
        if let Some(stdin) = self.watcher.as_mut().and_then(|w| w.stdin.as_mut()) {
            // A watcher gone meanwhile hears nothing, and its end is heard at the next tick.
            let _ = stdin.write_all(b"ok\n").and_then(|()| stdin.flush());
        }
    }
}

impl Drop for Mac {
    /// An agent that exits (a self-update's swap) leaves no assertion and no watcher.
    fn drop(&mut self) {
        self.release();
        self.reap();
    }
}

/// The keeper of a Mac agent's sleep, `None` on Linux: agent.toml has `[vm]`, whatever
/// runtime its engine is in ([`Config::mac`]). The VM's clock is checked after a wake only
/// where the agent keeps the VM (Colima); the rest is the same on every Mac.
pub(crate) fn keeper(cfg: &Config) -> Option<Sleep> {
    cfg.mac.then(|| Sleep::new(Box::<Mac>::default()))
}

/// Whether the dispatcher holds a lease: a lease file in `<work root>/state/leases/` (one
/// per lease, from its claim to its report, design v2 §9.8; the work root is the same path
/// on the Mac and in the VM) rewritten within a lease's length of `now`. The dispatcher
/// rewrites it at every heartbeat the pool accepts (every five minutes), so one older than
/// [`UNANSWERED_S`] is a lease the pool has requeued, or a dispatcher gone, and holds nothing.
/// Only the names and times are read, never what the files hold (a job token). A directory
/// that cannot be read holds nothing either: the engine's answer still counts.
pub(crate) fn leases_held(work_root: &Path, now: i64) -> bool {
    let Ok(dir) = std::fs::read_dir(work_root.join("state").join("leases")) else {
        return false;
    };
    dir.filter_map(Result::ok).any(|e| {
        let name = e.file_name();
        Path::new(&name).extension().is_some_and(|x| x == "json")
            && e.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|d| i64::try_from(d.as_secs()).ok())
                .is_some_and(|at| (now - at).abs() <= UNANSWERED_S)
    })
}

/// What the keeper heard this tick.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Hears {
    /// The Mac goes to sleep: the report says so now, then [`Sleep::let_sleep`].
    pub slept: bool,
    /// The Mac woke from a sleep the agent reported: the report says so, the pool is asked
    /// for the target now and the VM's clock is checked.
    pub woke: bool,
}

/// The keeper, one per Mac agent.
pub(crate) struct Sleep {
    power: Box<dyn Power>,
    /// When the sleep was heard (the Mac's clock), until the wake.
    asleep: Option<i64>,
    /// A task ran at the last look: the assertion is meant to stand.
    holding: bool,
    /// When the engine last said whether a task runs.
    answered: i64,
    listening: bool,
    listen_at: i64,
    next_look: i64,
    last_tick: Option<i64>,
    /// What was last said of the watcher or the assertion, so each failure is said once.
    said: Option<String>,
}

impl Sleep {
    pub fn new(power: Box<dyn Power>) -> Self {
        Sleep {
            power,
            asleep: None,
            holding: false,
            answered: 0,
            listening: false,
            listen_at: 0,
            next_look: 0,
            last_tick: None,
            said: None,
        }
    }

    /// What the host report says (`asleep`).
    pub fn asleep(&self) -> bool {
        self.asleep.is_some()
    }

    fn say_once(&mut self, journal: &Journal, now: i64, detail: String) {
        if self.said.as_ref() != Some(&detail) {
            journal.write(now, "sleep", serde_json::json!({ "detail": detail }));
            self.said = Some(detail);
        }
    }

    /// At the start of every tick: the watcher started when it is due, what it said read,
    /// and the agent's own evidence of a wake (a gap in the ticks, or ticks that went on).
    pub fn hear(&mut self, now: i64, journal: &Journal) -> Hears {
        let gap = self
            .last_tick
            .is_some_and(|last| now - last > crate::vm::WAKE_GAP_S);
        self.last_tick = Some(now);
        let mut h = Hears::default();
        if !self.listening && now >= self.listen_at {
            match self.power.listen() {
                Ok(()) => self.listening = true,
                Err(e) => {
                    self.listen_at = now + LISTEN_AGAIN_S;
                    self.say_once(journal, now, format!(
                        "the Mac's sleep is not heard ({e}): it is not reported before it happens, and a task it catches is requeued when its lease expires; tried again every {} minutes",
                        LISTEN_AGAIN_S / 60
                    ));
                }
            }
        }
        for heard in self.power.heard() {
            match heard {
                Heard::Ready => self.say_once(
                    journal,
                    now,
                    "the Mac's sleep and wake are heard: before it sleeps the host reports asleep, and the pool hands it nothing until it wakes".into(),
                ),
                Heard::Sleep => {
                    h.slept = true;
                    if self.asleep.is_none() {
                        journal.write(
                            now,
                            "sleep",
                            serde_json::json!({"detail": "the Mac goes to sleep: the host reports asleep, so the pool hands it nothing, then lets it sleep"}),
                        );
                    }
                    self.asleep = Some(now);
                }
                Heard::Wake => h.woke |= self.asleep.take().is_some(),
                Heard::Gone(why) => {
                    self.listening = false;
                    self.listen_at = now + LISTEN_AGAIN_S;
                    self.say_once(journal, now, format!(
                        "the watcher of the Mac's sleep ended ({why}); started again in {} minutes",
                        LISTEN_AGAIN_S / 60
                    ));
                }
            }
        }
        // A wake the watcher did not say: the loop stopped with the Mac.
        if gap && !h.slept {
            h.woke |= self.asleep.take().is_some();
        }
        if self.asleep.is_some_and(|at| now - at > AWAKE_S) {
            self.asleep = None;
            h.woke = true;
            journal.write(
                now,
                "sleep",
                serde_json::json!({"detail": format!("no sleep followed the one heard {AWAKE_S} s ago: the host reports itself awake again")}),
            );
        }
        if h.woke {
            journal.write(
                now,
                "sleep",
                serde_json::json!({"detail": "the Mac woke: the host reports itself awake and the pool is asked for its target now; the dispatcher claims again"}),
            );
        }
        h
    }

    /// The sleep the watcher holds goes on: once per sleep heard, after the report.
    pub fn let_sleep(&mut self) {
        self.power.let_sleep();
    }

    /// The assertion held while a task runs and let go when none does, looked at every
    /// [`LOOK_S`]. An engine that does not answer changes nothing, a task may run in it — for
    /// [`UNANSWERED_S`] at most: past that the assertion is let go, and taken again once a
    /// task is seen running.
    pub fn keep(
        &mut self,
        now: i64,
        tasks_running: &mut dyn FnMut() -> Option<bool>,
        journal: &Journal,
    ) {
        if now < self.next_look {
            return;
        }
        self.next_look = now + LOOK_S;
        let answer = tasks_running();
        if answer.is_some() {
            self.answered = now;
        }
        match answer {
            Some(true) if !self.holding || !self.power.held() => match self.power.hold() {
                Ok(()) => {
                    let detail = if self.holding {
                        "the assertion that holds off the Mac's idle sleep had ended while a task runs: taken again"
                    } else {
                        "a task runs: the Mac does not idle-sleep until none runs (PreventUserIdleSystemSleep)"
                    };
                    journal.write(now, "sleep", serde_json::json!({ "detail": detail }));
                    self.holding = true;
                    self.said = None;
                }
                Err(e) => self.say_once(journal, now, format!(
                    "a task runs, and the Mac's idle sleep could not be held off ({e}): an idle sleep would end it, and the pool would requeue it when its lease expires; tried again every {LOOK_S} s"
                )),
            },
            Some(false) if self.holding => {
                self.power.release();
                self.holding = false;
                journal.write(
                    now,
                    "sleep",
                    serde_json::json!({"detail": "no task runs: the Mac may idle-sleep again"}),
                );
            }
            None if self.holding && now - self.answered > UNANSWERED_S => {
                self.power.release();
                self.holding = false;
                journal.write(
                    now,
                    "sleep",
                    serde_json::json!({"detail": format!(
                        "the engine has not said whether a task runs for {} minutes: the Mac may idle-sleep again, and a task it cannot confirm is the pool's to requeue; held off again once a task is seen running",
                        UNANSWERED_S / 60
                    )}),
                );
            }
            _ => {}
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
