//! The `omarchy` VM, kept by the run loop on a Mac (#320; design v2 §19.2, M7): started
//! when it is not running (after a login, which is when launchd starts the agent; after a
//! crash), restarted with the agent's flags when what it saved differs from agent.toml —
//! at once when it would let anything of the person's in, otherwise only while no task
//! runs, since a restart ends them — and its clock held to the pool's after a wake. Every
//! start, stop or restart is held to M7's rate limit ([`crate::vm::allowed`]), recorded
//! in `vm.json`. A start is a child the loop polls, so no tick blocks on it.
//!
//! After a wake (a tick that comes [`crate::vm::WAKE_GAP_S`] after the last) the loop asks
//! the pool at once, and the VM's clock is compared with the pool's `Date` through the
//! Mac's own: beyond five seconds it is set from the Mac's clock inside the VM, and the
//! profile is restarted (within the rate limit) when that does not hold. A Mac whose own
//! clock is off is said, never corrected from the network. Running tasks keep their job
//! tokens valid that way; a task a restart ended is the pool's to requeue when its lease
//! expires.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::vm::{self, Clock, Drift, Want};

use super::exec::{self, Background, Progress};
use super::journal::Journal;

/// How often the profile is looked at.
const LOOK_S: i64 = 30;
/// How often the clock is checked without a wake.
const CLOCK_EVERY_S: i64 = 3600;
/// A pool `Date` older than this is not used for the check.
const DATE_FRESH_S: i64 = 120;
/// One `colima` call that is not a start.
const CALL: Duration = Duration::from_secs(120);
/// A start, polled.
const START_LIMIT: Duration = Duration::from_secs(900);

/// Colima, as the keeper drives it.
pub(crate) trait Colima {
    /// Whether the profile runs (`colima status --profile omarchy`).
    fn running(&mut self) -> Result<bool, String>;
    /// The profile's saved `colima.yaml`, when there is one.
    fn saved(&mut self) -> Option<Result<vm::Config, String>>;
    /// `colima start ...` in the background; [`Colima::poll`] follows it.
    fn start(&mut self, args: &[String]) -> Result<(), String>;
    /// `None` while the start runs, then how it ended.
    fn poll(&mut self) -> Option<Result<(), String>>;
    fn stop(&mut self) -> Result<(), String>;
    /// A command inside the VM (`colima ssh --profile omarchy -- ...`): its stdout.
    fn ssh(&mut self, args: &[&str]) -> Result<String, String>;
}

/// The real one: `colima` from launchd's `PATH`, which the plist sets.
pub(crate) struct Cli {
    pub colima_home: PathBuf,
    pub start: Option<Background>,
}

impl Cli {
    fn run(args: &[&str]) -> Result<String, String> {
        let mut c = Command::new("colima");
        c.args(args);
        let o = exec::run(c, CALL)?;
        if o.ok() {
            Ok(o.stdout)
        } else {
            Err(format!(
                "colima {}: exit {:?}: {}",
                args.first().unwrap_or(&""),
                o.code,
                o.stderr.trim()
            ))
        }
    }
}

impl Colima for Cli {
    fn running(&mut self) -> Result<bool, String> {
        let mut c = Command::new("colima");
        c.args(["status", "--profile", vm::PROFILE]);
        exec::run(c, CALL).map(|o| o.ok())
    }

    fn saved(&mut self) -> Option<Result<vm::Config, String>> {
        let path = vm::config_path(&self.colima_home);
        std::fs::read_to_string(&path)
            .ok()
            .map(|t| vm::parse_config(&t))
    }

    fn start(&mut self, args: &[String]) -> Result<(), String> {
        let mut c = Command::new("colima");
        c.args(args);
        self.start = Some(Background::start(c, START_LIMIT)?);
        Ok(())
    }

    fn poll(&mut self) -> Option<Result<(), String>> {
        let b = self.start.as_mut()?;
        let done = match b.poll() {
            Progress::Running => return None,
            Progress::Done(o) if o.ok() => Ok(()),
            Progress::Done(o) => Err(format!(
                "colima start: exit {:?}: {}",
                o.code,
                o.stderr.trim().lines().last().unwrap_or("")
            )),
            Progress::TimedOut => Err(format!(
                "colima start: no end within {} s",
                START_LIMIT.as_secs()
            )),
        };
        self.start = None;
        Some(done)
    }

    fn stop(&mut self) -> Result<(), String> {
        Self::run(&["stop", "--profile", vm::PROFILE]).map(drop)
    }

    fn ssh(&mut self, args: &[&str]) -> Result<String, String> {
        let mut all = vec!["ssh", "--profile", vm::PROFILE, "--"];
        all.extend_from_slice(args);
        Self::run(&all)
    }
}

/// What the keeper asks of the rest of the loop this tick.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Asks {
    /// The Mac woke: poll the pool now, for a fresh `Date`.
    pub poll_now: bool,
}

pub(crate) struct Keeper {
    colima: Box<dyn Colima>,
    want: Want,
    home: PathBuf,
    /// The data directory, where `vm.json` records M7's actions.
    data: PathBuf,
    last_tick: Option<i64>,
    next_look: i64,
    starting: bool,
    clock_due: bool,
    next_clock: i64,
    /// What was last said, so each state is journalled once.
    said: Option<String>,
}

impl Keeper {
    pub fn new(colima: Box<dyn Colima>, want: Want, home: &Path, data: &Path) -> Self {
        Keeper {
            colima,
            want,
            home: home.to_owned(),
            data: data.to_owned(),
            last_tick: None,
            next_look: 0,
            starting: false,
            // At start the clock is checked once, like after a wake.
            clock_due: true,
            next_clock: 0,
            said: None,
        }
    }

    fn say(&mut self, journal: &Journal, now: i64, event: &str, detail: &str) {
        self.say_once(journal, now, event, detail, detail);
    }

    /// Says `detail` unless the last thing said had the same `key` (a wait whose seconds
    /// count down is one state).
    fn say_once(&mut self, journal: &Journal, now: i64, event: &str, key: &str, detail: &str) {
        if self.said.as_deref() != Some(key) {
            journal.write(now, event, serde_json::json!({"detail": detail}));
            self.said = Some(key.to_owned());
        }
    }

    fn actions(&self) -> Vec<i64> {
        std::fs::read_to_string(self.data.join(vm::ACTIONS_FILE))
            .map(|t| vm::read_actions(&t))
            .unwrap_or_default()
    }

    /// One start, stop or restart, if the rate limit allows it now; recorded.
    fn act(&mut self, now: i64) -> Result<(), i64> {
        let before = self.actions();
        vm::allowed(&before, now)?;
        let _ = super::state::write_atomic(
            &self.data.join(vm::ACTIONS_FILE),
            vm::render_actions(&vm::record(&before, now)).as_bytes(),
        );
        Ok(())
    }

    /// Before the poll: a wake is seen, and asks for the pool at once.
    pub fn before_poll(&mut self, now: i64, journal: &Journal) -> Asks {
        let woke = self
            .last_tick
            .is_some_and(|last| now - last > vm::WAKE_GAP_S);
        self.last_tick = Some(now);
        if woke {
            journal.write(
                now,
                "vm",
                serde_json::json!({"detail": "the Mac woke: the pool is asked now and the VM's clock checked"}),
            );
            self.clock_due = true;
            self.next_look = now;
        }
        Asks { poll_now: woke }
    }

    /// After the poll: the profile kept running and sized, and its clock checked when due.
    /// `pool_date` is the last `follow`'s `Date` and when it came (Mac seconds);
    /// `tasks_running` asks the engine, when a restart would end them.
    ///
    /// While a self-update's health gate is shut (`gate`), only a stopped VM is started:
    /// the new agent's gate needs the engine, and touches nothing else.
    pub fn step(
        &mut self,
        now: i64,
        pool_date: Option<(i64, i64)>,
        tasks_running: &mut dyn FnMut() -> Option<bool>,
        gate: bool,
        journal: &Journal,
    ) {
        if self.starting {
            match self.colima.poll() {
                None => return,
                Some(Ok(())) => {
                    self.starting = false;
                    self.next_look = now;
                    self.say(
                        journal,
                        now,
                        "vm",
                        &format!("the {} VM started", vm::PROFILE),
                    );
                }
                Some(Err(e)) => {
                    self.starting = false;
                    self.next_look = now + LOOK_S;
                    self.say(
                        journal,
                        now,
                        "vm",
                        &format!("the {} VM did not start: {e}", vm::PROFILE),
                    );
                    return;
                }
            }
        }
        if now < self.next_look {
            return;
        }
        self.next_look = now + LOOK_S;
        let running = match self.colima.running() {
            Ok(r) => r,
            Err(e) => {
                return self.say(journal, now, "vm", &format!("colima did not answer: {e}"));
            }
        };
        if !running {
            return self.start(now, journal, "it was not running");
        }
        if gate {
            return;
        }
        // What the profile saved, read back. One that cannot be read is said and left as
        // it runs: install checked it, and a restart would not make it readable.
        let saved = match self.colima.saved() {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                return self.say(
                    journal,
                    now,
                    "vm",
                    &format!("the {} VM's colima.yaml: {e}; left as it runs", vm::PROFILE),
                );
            }
            None => {
                return self.say(
                    journal,
                    now,
                    "vm",
                    &format!(
                        "the {} VM runs with no colima.yaml to read; left as it runs",
                        vm::PROFILE
                    ),
                );
            }
        };
        match vm::drift(&saved, &self.want, &self.home) {
            Drift::Same => {}
            Drift::Recreate(e) => {
                return self.say(journal, now, "vm", &format!("needs a person: {e}"));
            }
            Drift::Restart(why) => {
                let exposed = !vm::exposures(&saved, &self.home).is_empty();
                // A size, a mount or Rosetta waits for the tasks to end; an exposure of the
                // person's files or keys does not.
                if !exposed && tasks_running() != Some(false) {
                    return self.say(
                        journal,
                        now,
                        "vm",
                        &format!(
                            "the {} VM is to be restarted ({}): it waits until no task runs",
                            vm::PROFILE,
                            why.join(", ")
                        ),
                    );
                }
                return self.restart(now, journal, &why.join(", "));
            }
        }
        if self.clock_due || now >= self.next_clock {
            self.clock(now, pool_date, journal);
        }
    }

    fn start(&mut self, now: i64, journal: &Journal, why: &str) {
        if let Err(wait) = self.act(now) {
            return self.say_once(
                journal,
                now,
                "vm",
                "rate-limit start",
                &format!(
                    "the {} VM is to be started ({why}): the rate limit lets it in {wait} s",
                    vm::PROFILE
                ),
            );
        }
        match self.colima.start(&vm::start_args(&self.want)) {
            Ok(()) => {
                self.starting = true;
                self.say(
                    journal,
                    now,
                    "vm",
                    &format!("starting the {} VM ({why})", vm::PROFILE),
                );
            }
            Err(e) => self.say(journal, now, "vm", &format!("colima start: {e}")),
        }
    }

    fn restart(&mut self, now: i64, journal: &Journal, why: &str) {
        if let Err(wait) = vm::allowed(&self.actions(), now) {
            return self.say_once(
                journal,
                now,
                "vm",
                "rate-limit restart",
                &format!(
                    "the {} VM is to be restarted ({why}): the rate limit lets it in {wait} s",
                    vm::PROFILE
                ),
            );
        }
        if let Err(e) = self.colima.stop() {
            return self.say(journal, now, "vm", &format!("colima stop: {e}"));
        }
        // The stop and the start are one action of the rate limit.
        self.start(now, journal, why);
    }

    fn vm_now(&mut self) -> Result<i64, String> {
        self.colima
            .ssh(&["date", "+%s"])?
            .trim()
            .parse()
            .map_err(|_| "the VM's date is not a number".to_owned())
    }

    fn clock(&mut self, now: i64, pool_date: Option<(i64, i64)>, journal: &Journal) {
        // The Mac's clock, the one the pool's date was received by.
        let Some((date, at)) = pool_date.filter(|(_, at)| super::now() - at <= DATE_FRESH_S) else {
            // A wake waits for the poll it asked for; the hourly check, for the next one.
            return;
        };
        let check = |k: &mut Self| -> Result<Clock, String> {
            let vm_now = k.vm_now()?;
            Ok(vm::clock(vm_now, super::now(), Some((date, at))))
        };
        let verdict = match check(self) {
            Ok(v) => v,
            Err(e) => return self.say(journal, now, "vm-clock", &format!("the VM's clock: {e}")),
        };
        self.clock_due = false;
        self.next_clock = now + CLOCK_EVERY_S;
        match verdict {
            Clock::Fine => {}
            Clock::MacOff { by } => self.say(
                journal,
                now,
                "vm-clock",
                &format!("needs a person: this Mac's clock is {by} s off the pool's; the agent does not set it"),
            ),
            Clock::Resync { to, skew } => {
                let set = self
                    .colima
                    .ssh(&["sudo", "date", "-u", "-s", &format!("@{to}")]);
                let after = check(self);
                journal.write(
                    now,
                    "vm-clock",
                    serde_json::json!({"detail": format!("the VM's clock was {skew} s off; set from the Mac's"), "set": set.as_ref().err(), "after": format!("{after:?}")}),
                );
                if !matches!(after, Ok(Clock::Fine)) {
                    self.restart(now, journal, "its clock stayed off the pool's");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
