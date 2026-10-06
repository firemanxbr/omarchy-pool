//! The `omarchy` VM, kept by the run loop on a Mac (#320; design v2 §19.2, M7): started
//! when it is not running (after a login, which is when launchd starts the agent; after a
//! crash), restarted with the agent's flags when what it saved differs from agent.toml —
//! at once when it would let anything of the person's in, otherwise only while no task
//! runs, since a restart ends them — its task firewall (which the VM applies at its every
//! boot) checked and repaired after every start, hourly and after a wake, and its clock
//! held to the pool's after a wake. Every start, stop or restart is held to M7's rate
//! limit ([`crate::vm::allowed`]), recorded in `vm.json`. A start is a child the loop
//! polls, so no tick blocks on it; once one ends the loop counts the host's capacity again
//! (`run/capacity.json`, with no pull), so a new size reaches the dispatcher.
//!
//! Before every start or restart the mounts are checked again as preflight checks them
//! ([`crate::vm::check_paths`], [`crate::vm::check_owned`]): a directory below
//! `/Users/Shared` that became a link or another account's is "needs a person", and the
//! profile is neither started nor stopped for it.
//!
//! The size agent.toml gives (`[envelope] max_cpus`, `max_mem_gb`) is held to what install
//! holds it to ([`crate::vm::size`]): never more than the Mac less what it keeps, and never
//! below the applied release's signed minimum — a size below it is "needs a person", and
//! nothing is started or resized for it. Colima needs a docker client on the Mac before
//! it starts a profile: the release's pinned one, so a start waits until the loop has it.
//!
//! After a wake (a tick that comes [`crate::vm::WAKE_GAP_S`] after the last) the loop asks
//! the pool at once, and the VM's clock is compared with the pool's `Date` through the
//! Mac's own ([`crate::vm::clock`]): beyond five seconds it is set to the pool's time inside
//! the VM, and the profile is restarted (within the rate limit) when that does not hold. A
//! Mac whose own clock is off is said, never corrected, and the VM is held to the Mac's
//! then. Running tasks keep their job tokens valid that way; a task a restart ended is the
//! pool's to requeue when its lease expires. The clock is checked whatever else the profile
//! waits for (a resize held back by a running task, a `colima.yaml` that cannot be read).
//!
//! A restart of the running profile stops the dispatcher in it, so the loop records each
//! as one of the dispatcher's restarts on the host-side brake (#325,
//! [`Keeper::take_restarts`]): the pool's orders and rounds get only the room left. The
//! brake never holds the keeper — M7's rate limit governs it, and an exposure must not
//! wait — just as it never holds what the agent does on its own.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::capacity::{self, probe, AgentToml, Capacity, VmKind, Written};
use crate::manifest::Manifest;
use crate::vm::{self, Drift, Want};

use super::exec::{self, Background, Progress};
use super::journal::Journal;

/// How often the profile is looked at.
const LOOK_S: i64 = 30;
/// How often the clock is checked, and the firewall put in place again, without a wake.
const CLOCK_EVERY_S: i64 = 3600;
/// A pool `Date` older than this is not used for the check.
const DATE_FRESH_S: i64 = 120;
/// One `colima` call that is not a start.
const CALL: Duration = Duration::from_secs(120);
/// A start, polled.
const START_LIMIT: Duration = Duration::from_secs(900);

/// Colima, and the Mac, as the keeper drives them.
pub(crate) trait Colima {
    /// The pinned docker CLI, which goes first on Colima's `PATH` ([`vm::colima_env`]).
    fn use_docker(&mut self, cli: &Path);
    /// The Mac's CPUs and memory (`sysctl -n hw.ncpu hw.memsize`).
    fn mac(&mut self) -> Result<vm::Mac, String>;
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

/// The real one: `colima` from launchd's `PATH`, which the plist sets, with the pinned
/// docker CLI ahead of it and the agent's own `DOCKER_CONFIG`.
pub(crate) struct Cli {
    pub colima_home: PathBuf,
    pub docker_config: PathBuf,
    pub docker: Option<PathBuf>,
    pub start: Option<Background>,
}

impl Cli {
    fn env(&self) -> Vec<(&'static str, String)> {
        vm::colima_env(self.docker.as_deref(), &self.docker_config)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new("colima");
        c.args(args).envs(self.env());
        c
    }
}

impl Colima for Cli {
    fn use_docker(&mut self, cli: &Path) {
        self.docker = Some(cli.to_owned());
    }

    fn mac(&mut self) -> Result<vm::Mac, String> {
        let mut c = Command::new("sysctl");
        c.args(["-n", "hw.ncpu", "hw.memsize"]);
        let o = exec::run(c, CALL)?;
        vm::parse_sysctl(&o.stdout)
    }

    fn running(&mut self) -> Result<bool, String> {
        exec::run(self.command(&["status", "--profile", vm::PROFILE]), CALL).map(|o| o.ok())
    }

    fn saved(&mut self) -> Option<Result<vm::Config, String>> {
        let path = vm::config_path(&self.colima_home);
        std::fs::read_to_string(&path)
            .ok()
            .map(|t| vm::parse_config(&t))
    }

    fn start(&mut self, args: &[String]) -> Result<(), String> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        self.start = Some(Background::start(self.command(&args), START_LIMIT)?);
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
        vm::colima(&["stop", "--profile", vm::PROFILE], &self.env(), CALL).map(drop)
    }

    fn ssh(&mut self, args: &[&str]) -> Result<String, String> {
        let mut all = vec!["ssh", "--profile", vm::PROFILE, "--"];
        all.extend_from_slice(args);
        vm::colima(&all, &self.env(), CALL)
    }
}

/// What the host's capacity is counted from once a start of the VM ended.
pub(crate) struct Counting<'a> {
    /// The pinned docker CLI, and the engine's socket on the Mac (`socket_cli`).
    pub docker: &'a Path,
    pub socket: &'a Path,
    pub work_root: &'a Path,
    pub set_dir: &'a Path,
    /// The applied release: its signed constants and build images.
    pub manifest: &'a Manifest,
    /// agent.toml's text: the caps, `[vm] rosetta` and the envelope's `emulate`.
    pub agent_toml: &'a str,
    /// The VM's own `/proc/meminfo` (M7).
    pub meminfo: Option<&'a str>,
}

/// The host's capacity counted again as `omarchy-agent capacity --write` counts it (the
/// engine through the pinned CLI, the VM's own `MemAvailable`, the Rosetta lane the
/// envelope allows: [`probe::in_mac_vm`]), and `run/capacity.json` rewritten when it
/// changed: a new size reaches the dispatcher and the pool, never the totals of the VM
/// before. What it found, for the journal.
pub(crate) fn count(c: &Counting<'_>) -> Result<String, String> {
    let toml = AgentToml::parse(c.agent_toml)?;
    let host = format!("unix://{}", c.socket.display());
    // The VM's own lane: the profile is aarch64 whatever runs the agent.
    let image = c.manifest.build_image(vm::ARCH).map(ToString::to_string);
    let docker = c.docker.to_string_lossy();
    let how = probe::Probe {
        docker: &docker,
        host: Some(&host),
        work_root: c.work_root,
        image: image.as_deref(),
        // The VM's lane is Rosetta's ([`probe::in_mac_vm`]), not the binfmt table's.
        emulation: None,
        // A sandboxed runtime in the VM's engine (#330): the VM's files are not this
        // machine's, so its smoke run alone decides.
        sandbox: Some(crate::capacity::sandbox::Probe {
            setting: &toml.caps.sandbox,
            local: false,
        }),
    };
    // The loop pulls nothing: a pull of a multi-GB build image would hold the tick far past
    // one engine call (and the watchdog's patience). A native build image the VM's store
    // lacks (a VM made again, a release no native task has pulled yet) leaves
    // `run/capacity.json` as it was until a task's pull brings it (the agent tries again).
    if let Some(img) = &image {
        probe::image_here(&how, img).map_err(|e| {
            format!(
                "the release's build image {img} is not in the VM's image store, and the loop pulls none ({e})"
            )
        })?;
    }
    let facts = probe::detect(&how)?;
    let x86 = c.manifest.build_image("x86_64").map(ToString::to_string);
    let vm = probe::MacVm {
        kind: VmKind::Dedicated,
        meminfo: c.meminfo,
        rosetta: toml.vm.as_ref().is_some_and(|v| v.1),
        emulate: toml.caps.emulate.as_deref(),
        x86_64_image: x86.as_deref(),
    };
    // Only an x86_64 task on the Rosetta lane pulls a release's x86_64 image (the loop pulls
    // none). When the VM lacks it, the lane stays as the last count found it (its smoke run
    // proved the VM's Rosetta, which a new image does not change), so the native CPUs,
    // memory and units still reach the file.
    let mut carried = None;
    let (facts, said) = probe::in_mac_vm(facts, &vm, &mut |img| {
        if probe::image_here(&how, img).is_ok() {
            return probe::rosetta_lane(&how, img);
        }
        let why = format!(
            "the release's x86_64 build image {img} is not in the VM's image store, and the loop pulls none"
        );
        if rosetta_counted(c.set_dir) {
            carried = Some(format!(
                "the x86_64 lane through Rosetta is kept as run/capacity.json had it, its smoke run not repeated: {why}"
            ));
            Ok(())
        } else {
            Err(why)
        }
    });
    let cap = Capacity::new(&facts, &toml.caps, c.manifest.capacity());
    let w = capacity::write_if_changed(c.set_dir, &cap, &capacity::now())
        .map_err(|e| format!("{}/run/capacity.json: {e}", c.set_dir.display()))?;
    let lane = match (said, carried) {
        (Some(probe::LaneSaid::Note(s) | probe::LaneSaid::Warning(s)), _) | (None, Some(s)) => {
            format!("; {s}")
        }
        (None, None) => String::new(),
    };
    Ok(format!(
        "the host's capacity counted again after the VM started: {} CPUs, {} GB, {} units, lanes {}{lane}; run/capacity.json {}",
        cap.cpus(),
        cap.mem_gb(),
        cap.units(),
        std::iter::once(facts.arch().to_owned())
            .chain(cap.emulated().iter().map(|l| format!("{} via {}", l.arch, l.via)))
            .collect::<Vec<_>>()
            .join(", "),
        match w {
            Written::Changed => "changed",
            Written::Unchanged => "unchanged",
        }
    ))
}

/// Whether `run/capacity.json` holds the `x86_64` lane through Rosetta: a count before
/// this one (install's, the loop's) passed its smoke run in this VM. Read through a
/// narrowing the pool's settings made (#325): a lane they turned off was still counted.
fn rosetta_counted(set_dir: &Path) -> bool {
    super::settings::Base::read(set_dir)
        .ok()
        .flatten()
        .is_some_and(|b| {
            b.lanes()
                .iter()
                .any(|l| l["arch"] == "x86_64" && l["via"] == "rosetta")
        })
}

/// What the keeper asks of the rest of the loop this tick.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Asks {
    /// The Mac woke: poll the pool now, for a fresh `Date`.
    pub poll_now: bool,
}

pub(crate) struct Keeper {
    colima: Box<dyn Colima>,
    /// The profile as agent.toml describes it; its size is held to [`Keeper::sized`].
    want: Want,
    /// The task firewall ([`vm::firewall`]) for agent.toml's task subnets.
    firewall: String,
    home: PathBuf,
    /// `/Users/Shared` ([`vm::shared_dir`]), below which every directory of a mount must be
    /// the person's own and no link ([`vm::check_owned`]).
    shared: PathBuf,
    /// The data directory, where `vm.json` records M7's actions.
    data: PathBuf,
    /// The applied release's signed minimum (CPUs, GB), once known.
    minimum: Option<(u32, u32)>,
    /// The Mac's size, read once.
    mac: Option<vm::Mac>,
    /// Whether the pinned docker CLI is known: Colima needs a docker client to start.
    docker: bool,
    last_tick: Option<i64>,
    next_look: i64,
    starting: bool,
    clock_due: bool,
    next_clock: i64,
    next_firewall: i64,
    /// What was last said, so each state is journalled once.
    said: Option<String>,
    /// Restarts of a running profile since the loop last asked: each recreated the
    /// dispatcher, which the brake counts (#325).
    restarted: u32,
}

impl Keeper {
    pub fn new(
        colima: Box<dyn Colima>,
        want: Want,
        firewall: String,
        home: &Path,
        data: &Path,
    ) -> Self {
        Keeper {
            colima,
            want,
            firewall,
            home: home.to_owned(),
            shared: vm::shared_dir(Path::new(vm::MAC_ROOT)).to_owned(),
            data: data.to_owned(),
            minimum: None,
            mac: None,
            docker: false,
            last_tick: None,
            next_look: 0,
            starting: false,
            // At start the clock is checked once, like after a wake, and the firewall put
            // in place (the VM may have booted while no agent ran).
            clock_due: true,
            next_clock: 0,
            next_firewall: 0,
            said: None,
            restarted: 0,
        }
    }

    /// How many times a running profile was stopped for a restart since the last ask: the
    /// dispatcher in it stopped with it, so the brake counts each as one of its restarts.
    /// A start of a stopped profile is not one (nothing ran to restart).
    pub fn take_restarts(&mut self) -> u32 {
        std::mem::take(&mut self.restarted)
    }

    /// The pinned docker CLI (the loop's tools, whenever they open or change).
    pub fn use_docker(&mut self, cli: &Path) {
        self.colima.use_docker(cli);
        self.docker = true;
    }

    /// A new size from agent.toml, as a signed widening of `max_cpus` or `max_mem_gb` wrote
    /// it (#328): held to the same bounds as at start, and the VM restarted with it as any
    /// size change is — at once only when no task runs, within the rate limit.
    pub fn resize(&mut self, size: vm::Size) {
        if self.want.size != size {
            self.want.size = size;
            self.next_look = 0;
        }
    }

    /// The applied release's signed minimum (CPUs, GB): a size below it is refused.
    pub fn minimum(&mut self, min: (u32, u32)) {
        self.minimum = Some(min);
    }

    /// The VM's own `/proc/meminfo` (M7: its `MemAvailable`, which the Mac has none of).
    pub fn meminfo(&mut self) -> Option<String> {
        self.colima.ssh(&["cat", "/proc/meminfo"]).ok()
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

    /// One start, stop or restart, if the rate limit allows it now; recorded before it is
    /// made, so an install running beside the loop is held to it too.
    fn act(&mut self, now: i64) -> Result<(), i64> {
        let before = self.actions();
        vm::allowed(&before, now)?;
        let _ = super::state::write_atomic(
            &self.data.join(vm::ACTIONS_FILE),
            vm::render_actions(&vm::record(&before, now)).as_bytes(),
        );
        Ok(())
    }

    /// The profile agent.toml describes, its size held to what install holds it to: at
    /// most the Mac less what it keeps, never below the release's signed minimum.
    fn sized(&mut self) -> Result<Want, String> {
        if self.mac.is_none() {
            self.mac = self.colima.mac().ok();
        }
        let have = self.want.size;
        let size = match (self.mac, self.minimum) {
            (Some(mac), min) => vm::size(
                mac,
                Some(have.cpus),
                Some(have.mem_gb),
                min.unwrap_or((0, 0)),
            )?,
            (None, Some(min)) if have.cpus < min.0 || have.mem_gb < min.1 => {
                return Err(format!(
                    "below the minimum to join: {} CPUs and {} GB, and the release's minimum is {} CPUs and {} GB",
                    have.cpus, have.mem_gb, min.0, min.1
                ))
            }
            (None, _) => have,
        };
        Ok(Want {
            size,
            ..self.want.clone()
        })
    }

    /// Before the poll: a wake is seen, and asks for the pool at once.
    pub fn before_poll(&mut self, now: i64, journal: &Journal) -> Asks {
        let woke = self
            .last_tick
            .is_some_and(|last| now - last > vm::WAKE_GAP_S);
        self.last_tick = Some(now);
        if woke {
            self.woke(now, journal);
        }
        Asks { poll_now: woke }
    }

    /// The Mac woke: a gap in the ticks, or a wake macOS announced after a sleep too short
    /// to leave one (#329). The VM is looked at, walled and its clock checked now; the
    /// caller asks the pool at once, for a fresh `Date`.
    pub fn woke(&mut self, now: i64, journal: &Journal) {
        journal.write(
            now,
            "vm",
            serde_json::json!({"detail": "the Mac woke: the pool is asked now and the VM's clock checked"}),
        );
        self.clock_due = true;
        self.next_look = now;
        self.next_firewall = now;
    }

    /// After the poll: the profile kept running, sized and walled, and its clock checked
    /// when due. `pool_date` is the host state's last `Date` and when it came (Mac seconds);
    /// `tasks_running` asks the engine, when a restart would end them. `true` when a start
    /// of the profile ended this step: the loop counts the host's capacity again.
    ///
    /// While a self-update's health gate is shut (`gate`), only a stopped VM is started
    /// (and walled): the new agent's gate needs the engine, and touches nothing else.
    pub fn step(
        &mut self,
        now: i64,
        pool_date: Option<(i64, i64)>,
        tasks_running: &mut dyn FnMut() -> Option<bool>,
        gate: bool,
        journal: &Journal,
    ) -> bool {
        let mut started = false;
        if self.starting {
            match self.colima.poll() {
                None => return false,
                Some(Ok(())) => {
                    self.starting = false;
                    started = true;
                    self.next_look = now;
                    // A boot of the VM lost the firewall; its clock came from the Mac's.
                    self.next_firewall = now;
                    self.clock_due = true;
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
                    return false;
                }
            }
        }
        if now < self.next_look {
            return started;
        }
        self.next_look = now + LOOK_S;
        let running = match self.colima.running() {
            Ok(r) => r,
            Err(e) => {
                self.say(journal, now, "vm", &format!("colima did not answer: {e}"));
                return started;
            }
        };
        let want = match self.sized() {
            Ok(w) => Some(w),
            Err(e) => {
                self.say(
                    journal,
                    now,
                    "vm",
                    &format!(
                        "needs a person: agent.toml's [envelope] max_cpus and max_mem_gb: {e}; the {} VM is neither started nor resized for it",
                        vm::PROFILE
                    ),
                );
                None
            }
        };
        if !running {
            if let Some(w) = want {
                self.start(now, journal, &w, "it was not running", false);
            }
            return started;
        }
        if now >= self.next_firewall {
            self.wall(now, journal);
        }
        if gate {
            return started;
        }
        if let Some(w) = want {
            if self.keep(now, &w, tasks_running, journal) {
                // Stopped for a restart: nothing more to look at in this VM.
                return started;
            }
        }
        if self.clock_due || now >= self.next_clock {
            self.clock(now, pool_date, journal);
        }
        started
    }

    /// The saved profile against `want`: restarted when it differs and may be (`true`
    /// once stopped), otherwise left as it runs, with why.
    fn keep(
        &mut self,
        now: i64,
        want: &Want,
        tasks_running: &mut dyn FnMut() -> Option<bool>,
        journal: &Journal,
    ) -> bool {
        // What the profile saved, read back. One that cannot be read is said and left as
        // it runs: install checked it, and a restart would not make it readable.
        let saved = match self.colima.saved() {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                self.say(
                    journal,
                    now,
                    "vm",
                    &format!("the {} VM's colima.yaml: {e}; left as it runs", vm::PROFILE),
                );
                return false;
            }
            None => {
                self.say(
                    journal,
                    now,
                    "vm",
                    &format!(
                        "the {} VM runs with no colima.yaml to read; left as it runs",
                        vm::PROFILE
                    ),
                );
                return false;
            }
        };
        match vm::drift(&saved, want, &self.home) {
            Drift::Same => false,
            Drift::Recreate(e) => {
                self.say(journal, now, "vm", &format!("needs a person: {e}"));
                false
            }
            Drift::Restart(why) => {
                let exposed = !vm::exposures(&saved, &self.home).is_empty();
                // A size, a mount or Rosetta waits for the tasks to end; an exposure of the
                // person's files or keys does not.
                if !exposed && tasks_running() != Some(false) {
                    self.say(
                        journal,
                        now,
                        "vm",
                        &format!(
                            "the {} VM is to be restarted ({}): it waits until no task runs",
                            vm::PROFILE,
                            why.join(", ")
                        ),
                    );
                    return false;
                }
                self.restart(now, journal, want, &why.join(", "))
            }
        }
    }

    /// The mounts checked again before a start or restart, as preflight checks them
    /// ([`vm::check_paths`], [`vm::check_owned`]): what install found may have changed since
    /// (another account's link put in place of a directory below `/Users/Shared`), and the
    /// VM would mount what a link points at. `true`, said, when one is refused: the profile
    /// is then neither started nor stopped for a restart.
    fn refused(&mut self, now: i64, journal: &Journal, want: &Want) -> bool {
        let mut no = vm::check_paths(&self.home, &want.mounts, &crate::install::mac::NAMES);
        no.extend(vm::check_owned(
            &self.shared,
            &want.mounts,
            crate::install::files::euid(),
        ));
        if no.is_empty() {
            return false;
        }
        self.say(
            journal,
            now,
            "vm",
            &format!(
                "needs a person: {}; the {} VM is neither started nor restarted with these mounts",
                no.join("; "),
                vm::PROFILE
            ),
        );
        true
    }

    /// Says what a start or restart waits for, when it cannot be made now.
    fn held(&mut self, now: i64, journal: &Journal, what: &str, why: &str) -> bool {
        if self.docker {
            return false;
        }
        self.say(
            journal,
            now,
            "vm",
            &format!(
                "the {} VM is to be {what} ({why}): it waits for the release's pinned docker CLI, which Colima needs on the Mac",
                vm::PROFILE
            ),
        );
        true
    }

    /// Starts the profile as `want` says, within the rate limit (`counted`: a restart
    /// recorded its action before the stop).
    fn start(&mut self, now: i64, journal: &Journal, want: &Want, why: &str, counted: bool) {
        if self.refused(now, journal, want) || self.held(now, journal, "started", why) {
            return;
        }
        if !counted {
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
        }
        match self.colima.start(&vm::start_args(want)) {
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

    /// A stop and a start, one action of the rate limit, recorded before the stop: `true`
    /// once the profile was stopped.
    fn restart(&mut self, now: i64, journal: &Journal, want: &Want, why: &str) -> bool {
        if self.refused(now, journal, want) || self.held(now, journal, "restarted", why) {
            return false;
        }
        if let Err(wait) = self.act(now) {
            self.say_once(
                journal,
                now,
                "vm",
                "rate-limit restart",
                &format!(
                    "the {} VM is to be restarted ({why}): the rate limit lets it in {wait} s",
                    vm::PROFILE
                ),
            );
            return false;
        }
        if let Err(e) = self.colima.stop() {
            self.say(journal, now, "vm", &format!("colima stop: {e}"));
            return false;
        }
        self.restarted += 1;
        self.start(now, journal, want, why, true);
        true
    }

    /// The task firewall put in place inside the VM ([`vm::firewall`]); tried again at the
    /// next look when it did not apply.
    fn wall(&mut self, now: i64, journal: &Journal) {
        let script = self.firewall.clone();
        match self.colima.ssh(&vm::as_root(&script)) {
            Ok(_) => {
                self.next_firewall = now + CLOCK_EVERY_S;
                self.say(
                    journal,
                    now,
                    "vm",
                    &format!(
                        "the {} VM's task firewall is in place, and applied at its every boot: the task subnets reach no private, CGNAT, link-local or VM address",
                        vm::PROFILE
                    ),
                );
            }
            Err(e) => self.say(
                journal,
                now,
                "vm",
                &format!(
                    "needs a person: the {} VM's task firewall did not apply ({e}); tried again at the next look",
                    vm::PROFILE
                ),
            ),
        }
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
        let check = |k: &mut Self| -> Result<vm::Clock, String> {
            let vm_now = k.vm_now()?;
            Ok(vm::clock(vm_now, super::now(), Some((date, at))))
        };
        let verdict = match check(self) {
            Ok(v) => v,
            Err(e) => return self.say(journal, now, "vm-clock", &format!("the VM's clock: {e}")),
        };
        self.clock_due = false;
        self.next_clock = now + CLOCK_EVERY_S;
        if let Some(by) = verdict.mac_off {
            self.say(
                journal,
                now,
                "vm-clock",
                &format!("needs a person: this Mac's clock is {by} s off the pool's; the agent does not set it, and holds the VM to the Mac's until it is right"),
            );
        }
        let Some(r) = verdict.resync else {
            return;
        };
        let set = self
            .colima
            .ssh(&["sudo", "-n", "date", "-u", "-s", &format!("@{}", r.to)]);
        let after = check(self);
        journal.write(
            now,
            "vm-clock",
            serde_json::json!({"detail": format!("the VM's clock was {} s off{}; set to it", r.skew, if verdict.mac_off.is_some() { " the Mac's" } else { " the pool's" }), "set": set.as_ref().err(), "after": format!("{after:?}")}),
        );
        if after.is_ok_and(|c| c.vm_fine()) {
            return;
        }
        match self.sized() {
            Ok(w) => {
                self.restart(now, journal, &w, "its clock stayed off the pool's");
            }
            Err(e) => self.say(journal, now, "vm", &format!("needs a person: {e}")),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
