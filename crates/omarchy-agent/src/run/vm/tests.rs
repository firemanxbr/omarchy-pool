//! The `omarchy` VM kept by the run loop (#320), against a played Colima: started when
//! stopped (once the pinned docker CLI is known), held to the rate limit, restarted when
//! it differs (a size only while no task runs and never below the signed minimum, an
//! exposure at once), never started or restarted with a mount that became a link, walled
//! by the task firewall after every start, and its clock held to the pool's after a wake
//! whatever else waits; the count after a start, which pulls nothing.

use std::cell::RefCell;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use super::*;
use crate::run::state::tempdir;

/// A Colima, played: what runs, what it saved, and how the VM's clock is off.
#[derive(Default)]
#[allow(clippy::struct_excessive_bools)] // the played Colima's switches, one for one
pub(crate) struct World {
    pub running: bool,
    pub saved: Option<String>,
    pub calls: Vec<String>,
    /// Polls a start takes before it ends.
    pub start_polls: u32,
    pub left: u32,
    pub start_fails: bool,
    /// The VM's clock against the Mac's, in seconds.
    pub skew: i64,
    /// Whether `date -s` inside the VM holds.
    pub set_holds: bool,
    /// What a start saves.
    pub want: Option<Want>,
    /// `sysctl -n hw.ncpu hw.memsize`; empty: sysctl fails.
    pub mac: String,
    /// The docker CLI Colima was given.
    pub docker: Option<PathBuf>,
    /// Whether the agent ran the task firewall in the running VM (a played start loses it:
    /// the worst case, a VM with no unit that applies it at boot).
    pub walled: bool,
    pub firewall_fails: bool,
}

pub(crate) struct Fake(pub Rc<RefCell<World>>);

/// `colima.yaml` as Colima saves it for `w`.
pub(crate) fn saved_for(w: &Want) -> String {
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
    fn use_docker(&mut self, cli: &Path) {
        self.0.borrow_mut().docker = Some(cli.to_owned());
    }
    fn mac(&mut self) -> Result<vm::Mac, String> {
        vm::parse_sysctl(&self.0.borrow().mac)
    }
    fn running(&mut self) -> Result<bool, String> {
        Ok(self.0.borrow().running)
    }
    fn saved(&mut self) -> Option<Result<vm::Config, String>> {
        self.0.borrow().saved.as_deref().map(vm::parse_config)
    }
    fn start(&mut self, args: &[String]) -> Result<(), String> {
        let mut w = self.0.borrow_mut();
        w.calls.push(args.join(" "));
        // Colima looks for a docker client before it starts a profile.
        if w.docker.is_none() {
            return Err("dependency check failed for docker: docker not found".into());
        }
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
        w.walled = false;
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
        let shown = if args.len() == 5 && args[2] == "sh" {
            "sudo -n sh -c <firewall>".to_owned()
        } else {
            args.join(" ")
        };
        w.calls.push(format!("ssh {shown}"));
        match args {
            ["date", "+%s"] => Ok(format!("{}\n", super::super::now() + w.skew)),
            ["sudo", "-n", "date", "-u", "-s", to] => {
                if w.set_holds {
                    let to: i64 = to.trim_start_matches('@').parse().unwrap();
                    w.skew = to - super::super::now();
                }
                Ok(String::new())
            }
            ["sudo", "-n", "sh", "-c", script] if script.contains("OMARCHY-TASKS") => {
                if w.firewall_fails {
                    return Err("sudo: a password is required".into());
                }
                w.walled = true;
                Ok(String::new())
            }
            ["cat", "/proc/meminfo"] => Ok("MemAvailable: 30000000 kB\n".into()),
            _ => Err("not here".into()),
        }
    }
}

pub(crate) fn want() -> Want {
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
    /// A keeper with the pinned docker CLI known, on a 16-core, 64 GB Mac.
    fn new(world: World) -> Self {
        let mut h = Self::without_docker(world);
        h.keeper.use_docker(Path::new("/data/tools/0a/docker"));
        h
    }

    fn without_docker(world: World) -> Self {
        let dir = tempdir();
        let world = Rc::new(RefCell::new(World {
            want: Some(want()),
            mac: if world.mac.is_empty() {
                "16\n68719476736\n".into()
            } else {
                world.mac
            },
            ..world
        }));
        let subnets = crate::install::net::parse_list("10.231.0.0/16").unwrap();
        let keeper = Keeper::new(
            Box::new(Fake(Rc::clone(&world))),
            want(),
            vm::firewall(&subnets),
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
        self.tick_started(dt, gate).0
    }

    /// [`Host::tick`], and whether a start ended in it.
    fn tick_started(&mut self, dt: i64, gate: bool) -> (Asks, bool) {
        self.now += dt;
        let asks = self.keeper.before_poll(self.now, &self.journal);
        let real = super::super::now();
        let tasks = self.tasks;
        let started = self.keeper.step(
            self.now,
            Some((real, real)),
            &mut || tasks,
            gate,
            &self.journal,
        );
        (asks, started)
    }

    /// Colima's calls but the firewall's.
    fn calls(&self) -> Vec<String> {
        self.world
            .borrow()
            .calls
            .iter()
            .filter(|c| !c.ends_with("<firewall>"))
            .cloned()
            .collect()
    }

    /// Colima's starts and stops, in order.
    fn acts(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter(|c| !c.starts_with("ssh"))
            .collect()
    }

    fn walls(&self) -> usize {
        self.world
            .borrow()
            .calls
            .iter()
            .filter(|c| c.ends_with("<firewall>"))
            .count()
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
fn a_stopped_vm_is_started_with_the_agents_flags_within_the_rate_limit_and_walled() {
    let mut h = Host::new(World {
        start_polls: 2,
        ..World::default()
    });
    assert!(!h.tick_started(0, false).1);
    assert_eq!(h.acts(), [vm::start_args(&want()).join(" ")]);
    assert!(h
        .journal()
        .contains("starting the omarchy VM (it was not running)"));
    // The start is a child the loop polls: no tick waits on it.
    h.tick(3, false);
    h.tick(3, false);
    assert!(!h.world.borrow().running);
    // The tick its start ends in says so (the loop counts the capacity again), and the
    // task firewall is run in the new VM at once.
    assert!(h.tick_started(3, false).1);
    assert!(h.world.borrow().running && h.journal().contains("the omarchy VM started"));
    assert!(h.world.borrow().walled && h.walls() == 1, "{:?}", h.calls());
    assert!(h.journal().contains("task firewall is in place"));
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
    for _ in 0..3 {
        h.tick(3, false);
    }
    assert_eq!(h.walls(), 2, "walled again after the second start");
}

#[test]
fn a_running_vm_is_walled_at_the_first_look_again_hourly_and_after_a_wake() {
    let mut h = Host::new(World {
        running: true,
        saved: Some(saved_for(&want())),
        ..World::default()
    });
    h.tick(0, false);
    assert_eq!(h.walls(), 1);
    h.tick(40, false);
    h.tick(40, false);
    assert_eq!(h.walls(), 1, "not at every look");
    h.tick(3600, false);
    assert_eq!(h.walls(), 2, "hourly, and after a wake");
    // One that does not apply is said and tried at the next look; a self-update's gate
    // walls the VM too.
    h.world.borrow_mut().firewall_fails = true;
    h.tick(3600, true);
    assert!(
        h.journal()
            .contains("needs a person: the omarchy VM's task firewall did not apply"),
        "{}",
        h.journal()
    );
    h.world.borrow_mut().firewall_fails = false;
    h.tick(40, true);
    assert!(h.world.borrow().walled);
    // The script is prep-root.sh's step 9 for agent.toml's subnets.
    let script = vm::firewall(&crate::install::net::parse_list("10.231.0.0/16").unwrap());
    for want in [
        "iptables -A OMARCHY-TASKS -s 10.231.0.0/16 -d 192.168.0.0/16 -j DROP",
        "iptables -A OMARCHY-TASKS-HOST -s 10.231.0.0/16 -j DROP",
        "iptables -I DOCKER-USER -j OMARCHY-TASKS",
    ] {
        assert!(script.contains(want), "{want}:\n{script}");
    }
}

#[test]
fn a_start_waits_for_the_pinned_docker_cli_colima_needs() {
    let mut h = Host::without_docker(World::default());
    h.tick(0, false);
    assert!(h.acts().is_empty(), "{:?}", h.calls());
    assert!(
        h.journal()
            .contains("it waits for the release's pinned docker CLI"),
        "{}",
        h.journal()
    );
    // No action of the rate limit was spent on it.
    assert!(!h.dir.join(vm::ACTIONS_FILE).exists());
    h.keeper.use_docker(Path::new("/data/tools/0a/docker"));
    h.tick(40, false);
    assert_eq!(h.starts(), 1);
    assert_eq!(
        h.world.borrow().docker.as_deref(),
        Some(Path::new("/data/tools/0a/docker"))
    );
    h.tick(3, false);
    assert!(h.world.borrow().running);
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
    assert!(h.acts().is_empty());
    assert!(
        h.journal().contains("waits until no task runs"),
        "{}",
        h.journal()
    );
    // An engine that does not answer is a task that may run.
    h.tasks = None;
    h.tick(40, false);
    assert!(h.acts().is_empty());
    h.tasks = Some(false);
    h.tick(40, false);
    assert_eq!(h.acts()[0], "stop");
    assert_eq!(h.acts()[1], vm::start_args(&want()).join(" "));
    // The action was recorded before the stop: one for the stop and the start.
    assert_eq!(
        vm::read_actions(&std::fs::read_to_string(h.dir.join(vm::ACTIONS_FILE)).unwrap()).len(),
        1
    );
    h.tick(3, false);
    assert!(h.journal().contains("the omarchy VM started"));
    // Started as agent.toml says: nothing more to do.
    h.tick(40, false);
    assert_eq!(h.starts(), 1);
}

#[test]
fn a_size_below_the_signed_minimum_is_neither_started_nor_resized_and_one_above_the_mac_is_held_to_it(
) {
    // agent.toml edited to 2 CPUs on a running VM of 8: refused, the VM left as it is.
    let mut tiny = want();
    tiny.size = vm::Size { cpus: 2, mem_gb: 4 };
    let world = Rc::new(RefCell::new(World {
        running: true,
        saved: Some(saved_for(&want())),
        want: Some(tiny.clone()),
        mac: "16\n68719476736\n".into(),
        ..World::default()
    }));
    let dir = tempdir();
    let journal = Journal::new(&dir.join("journal.ndjson"));
    let mut k = Keeper::new(
        Box::new(Fake(Rc::clone(&world))),
        tiny,
        String::new(),
        Path::new("/Users/maintainer"),
        &dir,
    );
    k.use_docker(Path::new("/data/tools/0a/docker"));
    k.minimum((4, 8));
    k.step(T, None, &mut || Some(false), false, &journal);
    let said = std::fs::read_to_string(dir.join("journal.ndjson")).unwrap();
    assert!(
        said.contains("needs a person: agent.toml's [envelope] max_cpus and max_mem_gb: below the minimum to join"),
        "{said}"
    );
    assert!(!world.borrow().calls.iter().any(|c| c == "stop"));
    // Stopped, it is not started at that size either.
    world.borrow_mut().running = false;
    k.step(T + 40, None, &mut || Some(false), false, &journal);
    assert!(!world.borrow().calls.iter().any(|c| c.starts_with("start")));

    // 32 CPUs and 128 GB on a 16-core, 64 GB Mac: the Mac keeps its share.
    let mut huge = want();
    huge.size = vm::Size {
        cpus: 32,
        mem_gb: 128,
    };
    let world = Rc::new(RefCell::new(World {
        mac: "16\n68719476736\n".into(),
        ..World::default()
    }));
    let mut k = Keeper::new(
        Box::new(Fake(Rc::clone(&world))),
        huge,
        String::new(),
        Path::new("/Users/maintainer"),
        &tempdir(),
    );
    k.use_docker(Path::new("/data/tools/0a/docker"));
    k.minimum((4, 8));
    k.step(T, None, &mut || Some(false), false, &journal);
    let start = world.borrow().calls[0].clone();
    assert!(start.contains("--cpu 15 --memory 62"), "{start}");
}

const T: i64 = 1_800_000_000;

#[test]
fn a_mount_that_became_a_link_is_neither_started_nor_restarted_with() {
    // `<tmp>` plays /Users/Shared, with prep-mac.sh's three directories and a home beside.
    let dir = tempdir();
    let root = dir.join("omarchy-pool");
    let home = dir.join("home/me");
    for d in ["work", "secrets", "set"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    std::fs::create_dir_all(home.join("projects")).unwrap();
    let mut w = want();
    w.mounts = vm::mounts(&root.join("work"), &root.join("secrets"), &root.join("set"));
    let world = Rc::new(RefCell::new(World {
        want: Some(w.clone()),
        mac: "16\n68719476736\n".into(),
        ..World::default()
    }));
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let journal = Journal::new(&data.join("journal.ndjson"));
    let said = || std::fs::read_to_string(data.join("journal.ndjson")).unwrap_or_default();
    let mut k = Keeper::new(
        Box::new(Fake(Rc::clone(&world))),
        w.clone(),
        String::new(),
        &home,
        &data,
    );
    k.shared.clone_from(&dir);
    k.use_docker(Path::new("/data/tools/0a/docker"));
    // Another account that owns the root renamed the work root and left a link into the
    // person's home in its place: the stopped VM is not started with it.
    std::fs::rename(root.join("work"), root.join("old-work")).unwrap();
    std::os::unix::fs::symlink(home.join("projects"), root.join("work")).unwrap();
    k.step(T, None, &mut || Some(false), false, &journal);
    assert!(
        world.borrow().calls.is_empty(),
        "{:?}",
        world.borrow().calls
    );
    assert!(
        said().contains(&format!(
            "needs a person: the work root {} is under your home directory",
            root.join("work").display()
        )) && said().contains(&format!(
            "{} is a symbolic link: refused (the VM would mount what it points at)",
            root.join("work").display()
        )) && said().contains("the omarchy VM is neither started nor restarted with these mounts"),
        "{}",
        said()
    );
    // Put right: started. Then the running VM differs (a resize) while the link is back:
    // it is not stopped for a restart it would make with that link.
    std::fs::remove_file(root.join("work")).unwrap();
    std::fs::rename(root.join("old-work"), root.join("work")).unwrap();
    k.step(T + 40, None, &mut || Some(false), false, &journal);
    k.step(T + 43, None, &mut || Some(false), false, &journal);
    assert_eq!(world.borrow().calls[0], vm::start_args(&w).join(" "));
    assert!(world.borrow().running);
    let mut smaller = w.clone();
    smaller.size = vm::Size { cpus: 4, mem_gb: 8 };
    world.borrow_mut().saved = Some(saved_for(&smaller));
    std::fs::rename(root.join("set"), root.join("old-set")).unwrap();
    std::os::unix::fs::symlink(root.join("old-set"), root.join("set")).unwrap();
    k.step(
        T + 43 + vm::COOLDOWN_S,
        None,
        &mut || Some(false),
        false,
        &journal,
    );
    let calls = world.borrow().calls.clone();
    assert!(
        !calls.iter().any(|c| c == "stop")
            && calls.iter().filter(|c| c.starts_with("start")).count() == 1,
        "{calls:?}"
    );
    assert!(
        said().contains(&format!(
            "{} is a symbolic link: refused",
            root.join("set").display()
        )),
        "{}",
        said()
    );
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
    assert_eq!(h.acts()[0], "stop", "{}", h.journal());
    // During a self-update's gate the VM is only started, never restarted.
    let mut h = Host::new(World {
        running: true,
        saved: Some(saved_for(&want()).replace("rosetta: true", "rosetta: false")),
        ..World::default()
    });
    h.tick(0, true);
    assert!(h.acts().is_empty());
    h.world.borrow_mut().running = false;
    h.tick(40, true);
    assert_eq!(h.acts(), [vm::start_args(&want()).join(" ")]);
}

#[test]
fn after_a_wake_the_vms_clock_is_set_to_the_pools_and_the_profile_restarted_if_that_fails() {
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
    assert!(
        calls[2].starts_with("ssh sudo -n date -u -s @"),
        "{calls:?}"
    );
    assert_eq!(calls.len(), 4, "{calls:?}");
    assert!(
        h.journal().contains("the VM's clock was -2400 s off"),
        "{}",
        h.journal()
    );
    assert!(h.world.borrow().skew.abs() <= 1);
    // A clock that does not hold: the profile is restarted, within the rate limit.
    h.world.borrow_mut().skew = 60;
    h.world.borrow_mut().set_holds = false;
    h.tick(3600, false);
    assert!(h.acts().contains(&"stop".to_owned()), "{:?}", h.calls());
    assert!(h.acts().last().unwrap().starts_with("start"));
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
fn the_clock_is_checked_while_a_resize_waits_for_tasks_and_beside_an_unreadable_colima_yaml() {
    let mut smaller = want();
    smaller.size = vm::Size { cpus: 4, mem_gb: 8 };
    for saved in [saved_for(&smaller), "mounts: x\n".to_owned()] {
        let mut h = Host::new(World {
            running: true,
            saved: Some(saved),
            set_holds: true,
            ..World::default()
        });
        h.tasks = Some(true);
        h.tick(0, false);
        h.world.borrow_mut().skew = -900;
        h.tick(1800, false);
        assert!(
            h.calls().iter().any(|c| c.starts_with("ssh sudo -n date")),
            "{:?}\n{}",
            h.calls(),
            h.journal()
        );
        assert!(h.world.borrow().skew.abs() <= 1);
        assert!(h.acts().is_empty(), "{:?}", h.acts());
    }
}

#[test]
fn a_saved_profile_that_cannot_be_read_is_said_and_never_restarted() {
    let mut h = Host::new(World {
        running: true,
        saved: Some("mounts: x\n".into()),
        ..World::default()
    });
    h.tick(0, false);
    h.tick(40, false);
    assert!(h.acts().is_empty(), "{:?}", h.calls());
    assert_eq!(
        h.journal().matches("left as it runs").count(),
        1,
        "{}",
        h.journal()
    );
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

/// A docker CLI for the engine in the VM: `info`, the build images in its store (all but
/// the one `missing` names), the probe container, and the `x86_64` smoke run through
/// Rosetta.
fn engine_in_the_vm(dir: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let d = dir.display();
    std::fs::write(
        dir.join("info.json"),
        r#"{"NCPU":8,"MemTotal":33443418112,"DockerRootDir":"/var/lib/docker","Architecture":"aarch64","SecurityOptions":["name=seccomp,profile=builtin","name=cgroupns"],"CgroupVersion":"2","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true}"#,
    )
    .unwrap();
    let docker = dir.join("docker");
    std::fs::write(
        &docker,
        format!(
            r#"#!/bin/sh
echo "$*" >> '{d}/docker.log'
case " $* " in
*" image inspect "*)
  m=$(cat '{d}/missing' 2>/dev/null)
  case "$*" in *"${{m:-//none//}}"*) echo "Error response from daemon: No such image: $m" >&2; exit 1 ;; esac
  echo sha256:0a ;;
*" info "*) cat '{d}/info.json' ;;
*" --platform linux/amd64 "*) exit 0 ;;
*" run "*) printf 'cpu.max=50000 100000\nmemory.max=67108864\npids.max=32\npagesize=4096\noverlay 1 1 104857600 1%% /\n' ;;
*) exit 2 ;;
esac
"#
        ),
    )
    .unwrap();
    std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
    docker
}

#[test]
fn a_count_after_a_start_writes_the_vms_capacity_and_the_lane_the_envelope_allows() {
    let dir = tempdir();
    let docker = engine_in_the_vm(&dir);
    let set = dir.join("set");
    std::fs::create_dir_all(&set).unwrap();
    let manifest = crate::verify::tests_support::manifest("v1.20.0", "v1.0.0", &[]);
    let toml = |emulate: &str| {
        format!("[envelope]\nmax_cpus = 8\nmax_mem_gb = 32\n{emulate}[vm]\nruntime = \"colima\"\nrosetta = true\n")
    };
    let count_with = |agent_toml: &str| {
        super::count(&Counting {
            docker: &docker,
            socket: Path::new("/Users/maintainer/.colima/omarchy/docker.sock"),
            work_root: &dir,
            set_dir: &set,
            manifest: &manifest,
            agent_toml,
            meminfo: Some("MemTotal: 32000000 kB\nMemAvailable: 30000000 kB\n"),
        })
    };
    let said = count_with(&toml("")).unwrap();
    assert!(
        said.contains("8 CPUs") && said.contains("x86_64 via rosetta"),
        "{said}"
    );
    assert!(said.ends_with("run/capacity.json changed"), "{said}");
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(set.join("run/capacity.json")).unwrap()).unwrap();
    assert_eq!(file["isolation"], "vm");
    assert_eq!(file["cpus"], 8);
    assert_eq!(file["lanes"][1]["via"], "rosetta");
    // Counted again with nothing changed: the file stays, so the dispatcher is not reloaded.
    assert!(count_with(&toml("")).unwrap().ends_with("unchanged"));
    // The owner left the x86_64 lane out: the count does not bring it back.
    let said = count_with(&toml("emulate = []\n")).unwrap();
    assert!(
        said.contains("the envelope's emulate leaves it out"),
        "{said}"
    );
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(set.join("run/capacity.json")).unwrap()).unwrap();
    assert_eq!(file["lanes"].as_array().map(Vec::len), Some(1));
    // The engine through the pinned CLI on the Mac's socket.
    let log = std::fs::read_to_string(dir.join("docker.log")).unwrap();
    assert!(log.contains("--platform linux/amd64"), "{log}");
    // A release's new x86_64 image, which only an x86_64 task on the lane pulls: the lane
    // stays as the file had it, its smoke run not repeated, and the native count still
    // reaches the file.
    // Here the file has no lane (the owner's emulate above): none is added.
    let x86 = manifest.build_image("x86_64").unwrap().to_string();
    let native = manifest.build_image("aarch64").unwrap().to_string();
    assert_ne!(x86, native);
    std::fs::write(dir.join("missing"), &x86).unwrap();
    let said = count_with(&toml("")).unwrap();
    assert!(
        said.contains(&format!("no x86_64 lane through Rosetta: the release's x86_64 build image {x86} is not in the VM's image store"))
            && said.ends_with("run/capacity.json unchanged"),
        "{said}"
    );
    std::fs::remove_file(dir.join("missing")).unwrap();
    assert!(count_with(&toml("")).unwrap().ends_with("changed"));
    std::fs::write(dir.join("missing"), &x86).unwrap();
    std::fs::write(dir.join("docker.log"), "").unwrap();
    // A resize: the VM's new size reaches the file, the lane kept as it was.
    std::fs::write(
        dir.join("info.json"),
        std::fs::read_to_string(dir.join("info.json"))
            .unwrap()
            .replace(r#""NCPU":8"#, r#""NCPU":6"#),
    )
    .unwrap();
    let said = count_with(&toml("")).unwrap();
    assert!(
        said.contains("6 CPUs")
            && said.contains("x86_64 via rosetta")
            && said.contains(&format!(
                "the x86_64 lane through Rosetta is kept as run/capacity.json had it, its smoke run not repeated: the release's x86_64 build image {x86} is not in the VM's image store, and the loop pulls none"
            ))
            && said.ends_with("run/capacity.json changed"),
        "{said}"
    );
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(set.join("run/capacity.json")).unwrap()).unwrap();
    assert_eq!(
        (file["cpus"].as_u64(), &file["lanes"][1]["via"]),
        (Some(6), &serde_json::json!("rosetta"))
    );
    let log = std::fs::read_to_string(dir.join("docker.log")).unwrap();
    assert!(!log.contains("--platform linux/amd64"), "{log}");
    // The native build image the VM's store lacks (a VM made again): the loop pulls
    // nothing, runs nothing, and leaves the file as it was until a task's pull brings it.
    let before = std::fs::read(set.join("run/capacity.json")).unwrap();
    std::fs::write(dir.join("missing"), &native).unwrap();
    std::fs::write(dir.join("docker.log"), "").unwrap();
    let e = count_with(&toml("")).unwrap_err();
    assert!(
        e.contains(&format!(
            "the release's build image {native} is not in the VM's image store, and the loop pulls none"
        )),
        "{e}"
    );
    let log = std::fs::read_to_string(dir.join("docker.log")).unwrap();
    assert!(log.lines().all(|l| l.contains("image inspect")), "{log}");
    assert_eq!(
        std::fs::read(set.join("run/capacity.json")).unwrap(),
        before
    );
}
