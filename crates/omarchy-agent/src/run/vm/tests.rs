//! The `omarchy` VM kept by the run loop (#320), against a played Colima: started when
//! stopped, held to the rate limit, restarted when it differs (a size only while no task
//! runs, an exposure at once), and its clock held to the pool's after a wake.

use std::cell::RefCell;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use super::*;
use crate::run::state::tempdir;

/// A Colima, played: what runs, what it saved, and how the VM's clock is off.
#[derive(Default)]
struct World {
    running: bool,
    saved: Option<String>,
    calls: Vec<String>,
    /// Polls a start takes before it ends.
    start_polls: u32,
    left: u32,
    start_fails: bool,
    /// The VM's clock against the Mac's, in seconds.
    skew: i64,
    /// Whether `date -s` inside the VM holds.
    set_holds: bool,
    /// What a start saves.
    want: Option<Want>,
}

struct Fake(Rc<RefCell<World>>);

/// `colima.yaml` as Colima saves it for `w`.
fn saved_for(w: &Want) -> String {
    let mut s = format!(
        "cpu: {}\nmemory: {}\ndisk: {}\narch: aarch64\nvmType: vz\nrosetta: {}\nforwardAgent: false\nmounts:\n",
        w.size.cpus, w.size.mem_gb, w.disk_gb, w.rosetta
    );
    for m in &w.mounts {
        let _ = writeln!(
            s,
            "  - location: {}\n    writable: {}",
            m.path.display(),
            m.writable
        );
    }
    s
}

impl Colima for Fake {
    fn running(&mut self) -> Result<bool, String> {
        Ok(self.0.borrow().running)
    }
    fn saved(&mut self) -> Option<Result<vm::Config, String>> {
        self.0.borrow().saved.as_deref().map(vm::parse_config)
    }
    fn start(&mut self, args: &[String]) -> Result<(), String> {
        let mut w = self.0.borrow_mut();
        w.calls.push(args.join(" "));
        w.left = w.start_polls;
        Ok(())
    }
    fn poll(&mut self) -> Option<Result<(), String>> {
        let mut w = self.0.borrow_mut();
        if w.left > 0 {
            w.left -= 1;
            return None;
        }
        if w.start_fails {
            return Some(Err("vz: boom".into()));
        }
        w.running = true;
        w.saved = w.want.as_ref().map(saved_for);
        Some(Ok(()))
    }
    fn stop(&mut self) -> Result<(), String> {
        let mut w = self.0.borrow_mut();
        w.calls.push("stop".into());
        w.running = false;
        Ok(())
    }
    fn ssh(&mut self, args: &[&str]) -> Result<String, String> {
        let mut w = self.0.borrow_mut();
        w.calls.push(format!("ssh {}", args.join(" ")));
        match args {
            ["date", "+%s"] => Ok(format!("{}\n", super::super::now() + w.skew)),
            ["sudo", "date", "-u", "-s", _] => {
                if w.set_holds {
                    w.skew = 0;
                }
                Ok(String::new())
            }
            _ => Err("not here".into()),
        }
    }
}

fn want() -> Want {
    Want {
        size: vm::Size {
            cpus: 8,
            mem_gb: 32,
        },
        disk_gb: vm::DISK_GB,
        mounts: vm::mounts(
            Path::new("/Users/Shared/omarchy-pool/work"),
            Path::new("/Users/Shared/omarchy-pool/secrets"),
            Path::new("/Users/Shared/omarchy-pool/set"),
        ),
        rosetta: true,
    }
}

struct Host {
    world: Rc<RefCell<World>>,
    keeper: Keeper,
    journal: Journal,
    dir: PathBuf,
    now: i64,
    tasks: Option<bool>,
}

impl Host {
    fn new(world: World) -> Self {
        let dir = tempdir();
        let world = Rc::new(RefCell::new(World {
            want: Some(want()),
            ..world
        }));
        let keeper = Keeper::new(
            Box::new(Fake(Rc::clone(&world))),
            want(),
            Path::new("/Users/maintainer"),
            &dir,
        );
        Host {
            world,
            keeper,
            journal: Journal::new(&dir.join("journal.ndjson")),
            dir,
            now: 1_800_000_000,
            tasks: Some(false),
        }
    }

    /// One tick `dt` seconds after the last, with the pool's `Date` as the Mac sees it.
    fn tick(&mut self, dt: i64, gate: bool) -> Asks {
        self.now += dt;
        let asks = self.keeper.before_poll(self.now, &self.journal);
        let real = super::super::now();
        let tasks = self.tasks;
        self.keeper.step(
            self.now,
            Some((real, real)),
            &mut || tasks,
            gate,
            &self.journal,
        );
        asks
    }

    fn calls(&self) -> Vec<String> {
        self.world.borrow().calls.clone()
    }

    fn starts(&self) -> usize {
        self.calls()
            .iter()
            .filter(|c| c.starts_with("start"))
            .count()
    }

    fn journal(&self) -> String {
        std::fs::read_to_string(self.dir.join("journal.ndjson")).unwrap_or_default()
    }
}

#[test]
fn a_stopped_vm_is_started_with_the_agents_flags_within_the_rate_limit() {
    let mut h = Host::new(World {
        start_polls: 2,
        ..World::default()
    });
    h.tick(0, false);
    assert_eq!(h.calls(), [vm::start_args(&want()).join(" ")]);
    assert!(h
        .journal()
        .contains("starting the omarchy VM (it was not running)"));
    // The start is a child the loop polls: no tick waits on it.
    h.tick(3, false);
    h.tick(3, false);
    assert!(!h.world.borrow().running);
    h.tick(3, false);
    assert!(h.world.borrow().running && h.journal().contains("the omarchy VM started"));
    assert_eq!(
        vm::read_actions(&std::fs::read_to_string(h.dir.join(vm::ACTIONS_FILE)).unwrap()).len(),
        1
    );
    // It stops again at once: the next start waits for the rate limit, and says so once.
    h.world.borrow_mut().running = false;
    h.tick(40, false);
    h.tick(40, false);
    assert_eq!(h.starts(), 1, "{:?}", h.calls());
    assert_eq!(h.journal().matches("the rate limit lets it in").count(), 1);
    h.tick(vm::COOLDOWN_S, false);
    assert_eq!(h.starts(), 2);
}

#[test]
fn a_vm_that_differs_from_agent_toml_is_restarted_only_while_no_task_runs() {
    let mut smaller = want();
    smaller.size = vm::Size { cpus: 4, mem_gb: 8 };
    let mut h = Host::new(World {
        running: true,
        saved: Some(saved_for(&smaller)),
        ..World::default()
    });
    h.tasks = Some(true);
    h.tick(0, false);
    assert!(h.calls().is_empty());
    assert!(
        h.journal().contains("waits until no task runs"),
        "{}",
        h.journal()
    );
    // An engine that does not answer is a task that may run.
    h.tasks = None;
    h.tick(40, false);
    assert!(h.calls().is_empty());
    h.tasks = Some(false);
    h.tick(40, false);
    assert_eq!(h.calls()[0], "stop");
    assert_eq!(h.calls()[1], vm::start_args(&want()).join(" "));
    h.tick(3, false);
    assert!(h.journal().contains("the omarchy VM started"));
    // Started as agent.toml says: nothing more to do.
    h.tick(40, false);
    assert_eq!(h.starts(), 1);
}

#[test]
fn a_vm_that_lets_the_persons_files_in_is_restarted_at_once() {
    let mut h = Host::new(World {
        running: true,
        saved: Some(saved_for(&want()).replace(
            "  - location: /Users/Shared/omarchy-pool/set\n",
            "  - location: /Users/maintainer\n",
        )),
        ..World::default()
    });
    h.tasks = Some(true);
    h.tick(0, false);
    assert_eq!(h.calls()[0], "stop", "{}", h.journal());
    // During a self-update's gate the VM is only started, never restarted.
    let mut h = Host::new(World {
        running: true,
        saved: Some(saved_for(&want()).replace("rosetta: true", "rosetta: false")),
        ..World::default()
    });
    h.tick(0, true);
    assert!(h.calls().is_empty());
    h.world.borrow_mut().running = false;
    h.tick(40, true);
    assert_eq!(h.calls(), [vm::start_args(&want()).join(" ")]);
}

#[test]
fn after_a_wake_the_vms_clock_is_set_from_the_macs_and_the_profile_restarted_if_that_fails() {
    let mut h = Host::new(World {
        running: true,
        saved: Some(saved_for(&want())),
        ..World::default()
    });
    // At start the clock is checked once: on time, nothing done.
    h.tick(0, false);
    assert_eq!(h.calls(), ["ssh date +%s"]);
    // The Mac slept 40 minutes; the VM's clock stayed behind.
    h.world.borrow_mut().skew = -2400;
    h.world.borrow_mut().set_holds = true;
    let asks = h.tick(2400, false);
    assert!(asks.poll_now, "a wake asks the pool now");
    let calls = h.calls();
    assert!(calls[2].starts_with("ssh sudo date -u -s @"), "{calls:?}");
    assert_eq!(calls.len(), 4, "{calls:?}");
    assert!(
        h.journal().contains("the VM's clock was -2400 s off"),
        "{}",
        h.journal()
    );
    assert_eq!(h.world.borrow().skew, 0);
    // A clock that does not hold: the profile is restarted, within the rate limit.
    h.world.borrow_mut().skew = 60;
    h.world.borrow_mut().set_holds = false;
    h.tick(3600, false);
    assert!(h.calls().contains(&"stop".to_owned()), "{:?}", h.calls());
    assert!(h.calls().last().unwrap().starts_with("start"));
    // Without a wake the clock is checked hourly, not every look.
    let mut h = Host::new(World {
        running: true,
        saved: Some(saved_for(&want())),
        ..World::default()
    });
    h.tick(0, false);
    h.tick(40, false);
    h.tick(40, false);
    assert_eq!(h.calls().len(), 1);
}

#[test]
fn a_tick_long_after_the_last_is_a_wake_and_asks_the_pool_now() {
    let mut h = Host::new(World {
        running: true,
        saved: Some(saved_for(&want())),
        ..World::default()
    });
    assert!(!h.tick(0, false).poll_now);
    assert!(!h.tick(3, false).poll_now);
    assert!(!h.tick(vm::WAKE_GAP_S, false).poll_now);
    assert!(h.tick(vm::WAKE_GAP_S + 1, false).poll_now);
    assert!(h.journal().contains("the Mac woke"));
}

#[test]
fn a_start_that_fails_is_said_and_tried_again_after_the_rate_limit() {
    let mut h = Host::new(World {
        start_fails: true,
        ..World::default()
    });
    h.tick(0, false);
    h.tick(3, false);
    assert!(
        h.journal().contains("did not start: vz: boom"),
        "{}",
        h.journal()
    );
    h.tick(40, false);
    assert_eq!(h.starts(), 1);
    h.tick(vm::COOLDOWN_S, false);
    assert_eq!(h.starts(), 2);
}
