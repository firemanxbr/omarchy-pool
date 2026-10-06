//! A Mac that sleeps (#329), against a played power layer: every Mac agent keeps one,
//! whatever its runtime, and no Linux agent; the assertion held while a task runs and let go
//! when none does (an engine that does not answer changes nothing for a lease's length, then
//! lets it go; a holder that ended is taken again, a hold that fails is said once); a lease
//! the dispatcher holds is a lease file it rewrote within a lease's length; a sleep heard is `asleep`
//! until the wake the watcher says, a gap in the ticks or two minutes of ticks that went on;
//! a watcher that does not start or ends is said once and started again ten minutes later.
//! On a Mac (the `agent` job's macOS runner) the real layer: `caffeinate` holds
//! `PreventUserIdleSystemSleep` as `pmset` lists it and lets it go, and the watcher starts.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use super::*;
use crate::run::state::tempdir;

/// The Mac's power, played: the assertion, the watcher and what it says next.
#[derive(Default)]
pub(crate) struct Played {
    pub held: bool,
    pub holds: u32,
    pub releases: u32,
    pub hold_fails: bool,
    pub listen_fails: bool,
    pub listens: u32,
    /// What the watcher says at the next [`Power::heard`].
    pub next: Vec<Heard>,
    pub let_sleeps: u32,
    /// Run at each [`Power::let_sleep`]: what the agent had done by then.
    pub at_let_sleep: Option<Box<dyn FnMut()>>,
}

pub(crate) struct FakePower(pub Rc<RefCell<Played>>);

impl Power for FakePower {
    fn hold(&mut self) -> Result<(), String> {
        let mut p = self.0.borrow_mut();
        if p.hold_fails {
            return Err("could not start /usr/bin/caffeinate: No such file or directory".into());
        }
        p.holds += 1;
        p.held = true;
        Ok(())
    }
    fn held(&mut self) -> bool {
        self.0.borrow().held
    }
    fn release(&mut self) {
        let mut p = self.0.borrow_mut();
        p.releases += 1;
        p.held = false;
    }
    fn listen(&mut self) -> Result<(), String> {
        let mut p = self.0.borrow_mut();
        p.listens += 1;
        if p.listen_fails {
            return Err("could not start /usr/bin/osascript: No such file or directory".into());
        }
        p.next.push(Heard::Ready);
        Ok(())
    }
    fn heard(&mut self) -> Vec<Heard> {
        std::mem::take(&mut self.0.borrow_mut().next)
    }
    fn let_sleep(&mut self) {
        let f = {
            let mut p = self.0.borrow_mut();
            p.let_sleeps += 1;
            p.at_let_sleep.take()
        };
        if let Some(mut f) = f {
            f();
            self.0.borrow_mut().at_let_sleep = Some(f);
        }
    }
}

struct Host {
    played: Rc<RefCell<Played>>,
    sleep: Sleep,
    journal: Journal,
    dir: PathBuf,
    now: i64,
    tasks: Option<bool>,
}

impl Host {
    fn new(played: Played) -> Self {
        let dir = tempdir();
        let played = Rc::new(RefCell::new(played));
        Host {
            sleep: Sleep::new(Box::new(FakePower(Rc::clone(&played)))),
            played,
            journal: Journal::new(&dir.join("journal.ndjson")),
            dir,
            now: 1_800_000_000,
            tasks: Some(false),
        }
    }

    /// One tick `dt` seconds after the last: what was heard, then the assertion kept.
    fn tick(&mut self, dt: i64) -> Hears {
        self.now += dt;
        let h = self.sleep.hear(self.now, &self.journal);
        if h.slept {
            self.sleep.let_sleep();
        }
        let tasks = self.tasks;
        self.sleep.keep(self.now, &mut || tasks, &self.journal);
        h
    }

    fn says(&self, h: Heard) {
        self.played.borrow_mut().next.push(h);
    }

    fn held(&self) -> bool {
        self.played.borrow().held
    }

    fn journal(&self) -> String {
        std::fs::read_to_string(self.dir.join("journal.ndjson")).unwrap_or_default()
    }
}

#[test]
fn a_running_task_holds_off_idle_sleep_and_its_end_lets_it_go() {
    let mut h = Host::new(Played::default());
    h.tick(3);
    assert!(!h.held(), "no task, no assertion");
    h.tasks = Some(true);
    // Looked at every ten seconds, not every tick.
    h.tick(3);
    h.tick(3);
    assert!(!h.held());
    h.tick(5);
    assert!(h.held());
    for _ in 0..20 {
        h.tick(3);
    }
    assert_eq!(h.played.borrow().holds, 1, "held once while the task runs");
    h.tasks = Some(false);
    h.tick(10);
    assert!(!h.held());
    assert_eq!(h.played.borrow().releases, 1);
    h.tick(10);
    assert_eq!(h.played.borrow().releases, 1, "let go once");
    let j = h.journal();
    assert!(
        j.contains(
            "a task runs: the Mac does not idle-sleep until none runs (PreventUserIdleSystemSleep)"
        ),
        "{j}"
    );
    assert!(
        j.contains("no task runs: the Mac may idle-sleep again"),
        "{j}"
    );
}

#[test]
fn an_engine_that_does_not_answer_changes_nothing_for_a_leases_length() {
    let mut h = Host::new(Played::default());
    h.tasks = Some(true);
    h.tick(3);
    assert!(h.held());
    // The engine does not answer: a task may run in it, so the Mac stays held.
    h.tasks = None;
    h.tick(10);
    h.tick(10);
    assert!(h.held());
    h.tasks = Some(false);
    h.tick(10);
    assert!(!h.held());
    // ... and an engine that does not answer takes no assertion either.
    h.tasks = None;
    h.tick(10);
    assert!(!h.held());
    assert_eq!(h.played.borrow().holds, 1);
    // A task seen, then an engine that stops answering for good (the VM gone): held for a
    // lease's length, no longer — the pool requeues what nobody can confirm.
    h.tasks = Some(true);
    h.tick(10);
    assert!(h.held());
    h.tasks = None;
    let mut waited = 0;
    while waited < UNANSWERED_S {
        h.tick(10);
        waited += 10;
        assert!(h.held(), "{waited} s");
    }
    h.tick(10);
    assert!(!h.held());
    assert_eq!(h.played.borrow().releases, 2);
    for _ in 0..10 {
        h.tick(10);
    }
    let said =
        "the engine has not said whether a task runs for 30 minutes: the Mac may idle-sleep again";
    assert_eq!(h.journal().matches(said).count(), 1, "{}", h.journal());
    assert_eq!(h.played.borrow().releases, 2, "let go once");
    // It answers again with a task running: held off again.
    h.tasks = Some(true);
    h.tick(10);
    assert!(h.held());
    assert_eq!(h.played.borrow().holds, 3);
    // An engine that answers now and then holds the assertion on.
    for _ in 0..3 {
        h.tasks = None;
        for _ in 0..(UNANSWERED_S / 10 - 1) {
            h.tick(10);
        }
        h.tasks = Some(true);
        h.tick(10);
        assert!(h.held());
    }
    assert_eq!(h.played.borrow().holds, 3);
}

/// Every Mac agent keeps a keeper, whatever runtime its engine is in — Colima, which it
/// manages, or Docker Desktop and `OrbStack`, which it only uses; a Linux agent none.
#[test]
fn every_mac_keeps_its_sleep_whatever_its_runtime_and_linux_none() {
    let mac = include_str!("../../../tests/fixtures/lint/envelope/mac.toml");
    for runtime in ["colima", "docker-desktop", "orbstack"] {
        let text = mac.replace("runtime = \"colima\"", &format!("runtime = {runtime:?}"));
        let cfg = Config::parse(&format!("worker_id = \"w_1\"\n{text}")).unwrap();
        let k = keeper(&cfg, false).unwrap_or_else(|| panic!("{runtime}: no keeper"));
        assert!(!k.asleep());
    }
    let dir = tempdir();
    let linux = crate::run::config::tests::example(
        &dir.join("set"),
        &dir.join("work"),
        &dir.join("secrets"),
    );
    let cfg = Config::parse(&linux).unwrap();
    assert!(keeper(&cfg, false).is_none());
    // A Mac's build (`Agent::mac`, played on any OS) keeps it even with `[vm]` gone, as the
    // runtime switch refuses it (#325).
    assert!(keeper(&cfg, true).is_some());
}

/// A lease file at `<work root>/state/leases/<name>`, last written at `at`.
fn lease_file(work: &std::path::Path, name: &str, at: i64) {
    let dir = work.join("state/leases");
    std::fs::create_dir_all(&dir).unwrap();
    let f = std::fs::File::create(dir.join(name)).unwrap();
    f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(at.unsigned_abs()))
        .unwrap();
}

/// A lease the dispatcher holds is a lease file it rewrote (at a heartbeat the pool accepted,
/// every five minutes) within a lease's length; a stale one, a temporary file or no directory
/// holds nothing.
#[test]
fn a_held_lease_is_a_lease_file_rewritten_within_a_leases_length() {
    let work = tempdir();
    let now = 1_800_000_000;
    assert!(!leases_held(&work, now), "no directory");
    lease_file(&work, "7-g_0123456789abcdef.json.tmp", now);
    assert!(!leases_held(&work, now), "a temporary file is no lease");
    lease_file(&work, "7-g_0123456789abcdef.json", now - UNANSWERED_S - 1);
    assert!(!leases_held(&work, now), "past a lease's length");
    lease_file(&work, "8-g_1111111111111111.json", now - UNANSWERED_S + 60);
    assert!(leases_held(&work, now));
    // Its heartbeats stopped (a dispatcher gone): it holds nothing once a lease went by.
    assert!(!leases_held(&work, now + 61));
}

#[test]
fn an_assertion_whose_holder_ended_is_taken_again_while_a_task_runs() {
    let mut h = Host::new(Played::default());
    h.tasks = Some(true);
    h.tick(3);
    // caffeinate killed by someone: the next look takes the assertion again.
    h.played.borrow_mut().held = false;
    h.tick(10);
    assert!(h.held());
    assert_eq!(h.played.borrow().holds, 2);
    assert!(h
        .journal()
        .contains("had ended while a task runs: taken again"));
}

#[test]
fn a_hold_that_fails_is_said_once_and_tried_again() {
    let mut h = Host::new(Played {
        hold_fails: true,
        ..Played::default()
    });
    h.tasks = Some(true);
    for _ in 0..5 {
        h.tick(10);
    }
    let j = h.journal();
    assert_eq!(
        j.matches(
            "the Mac's idle sleep could not be held off (could not start /usr/bin/caffeinate"
        )
        .count(),
        1,
        "{j}"
    );
    h.played.borrow_mut().hold_fails = false;
    h.tick(10);
    assert!(h.held());
}

#[test]
fn a_sleep_heard_is_asleep_until_the_wake_the_watcher_says() {
    let mut h = Host::new(Played::default());
    assert_eq!(h.tick(3), Hears::default());
    assert!(h.journal().contains("the Mac's sleep and wake are heard"));
    assert!(!h.sleep.asleep());
    h.says(Heard::Sleep);
    assert_eq!(
        h.tick(3),
        Hears {
            slept: true,
            woke: false
        }
    );
    assert!(h.sleep.asleep());
    assert_eq!(h.played.borrow().let_sleeps, 1);
    // A short sleep: no gap in the ticks; the watcher's wake ends it.
    h.tick(3);
    assert!(h.sleep.asleep());
    h.says(Heard::Wake);
    assert_eq!(
        h.tick(30),
        Hears {
            slept: false,
            woke: true
        }
    );
    assert!(!h.sleep.asleep());
    let j = h.journal();
    assert!(
        j.contains("the Mac goes to sleep: the host reports asleep"),
        "{j}"
    );
    assert!(
        j.contains("the Mac woke: the host reports itself awake"),
        "{j}"
    );
    // A wake with no sleep reported before it is nothing to say.
    h.says(Heard::Wake);
    assert_eq!(h.tick(3), Hears::default());
}

#[test]
fn a_gap_in_the_ticks_is_a_wake_the_watcher_did_not_say() {
    let mut h = Host::new(Played::default());
    h.tick(3);
    h.says(Heard::Sleep);
    h.tick(3);
    assert!(h.sleep.asleep());
    let woke = h.tick(crate::vm::WAKE_GAP_S + 1);
    assert!(woke.woke && !woke.slept);
    assert!(!h.sleep.asleep());
    // Its wake, said late, is no second one.
    h.says(Heard::Wake);
    assert_eq!(h.tick(3), Hears::default());
    // A new sleep heard on the first tick after a gap is that new sleep.
    h.says(Heard::Sleep);
    h.tick(3);
    h.says(Heard::Wake);
    h.tick(3);
    h.says(Heard::Sleep);
    let again = h.tick(crate::vm::WAKE_GAP_S + 1);
    assert!(again.slept && !again.woke);
    assert!(h.sleep.asleep());
}

#[test]
fn a_sleep_that_did_not_happen_ends_after_two_minutes_of_ticks() {
    let mut h = Host::new(Played::default());
    h.tick(3);
    h.says(Heard::Sleep);
    h.tick(3);
    for _ in 0..40 {
        assert!(h.sleep.asleep());
        assert!(!h.tick(3).woke);
    }
    assert!(h.tick(3).woke);
    assert!(!h.sleep.asleep());
    assert!(h
        .journal()
        .contains("no sleep followed the one heard 120 s ago"));
}

#[test]
fn a_watcher_that_does_not_start_or_ends_is_said_once_and_started_again_ten_minutes_later() {
    let mut h = Host::new(Played {
        listen_fails: true,
        ..Played::default()
    });
    h.tick(3);
    assert_eq!(h.played.borrow().listens, 1);
    for _ in 0..19 {
        h.tick(30);
    }
    assert_eq!(h.played.borrow().listens, 1, "not every tick");
    h.tick(30);
    assert_eq!(h.played.borrow().listens, 2);
    let j = h.journal();
    assert_eq!(
        j.matches("the Mac's sleep is not heard (could not start /usr/bin/osascript")
            .count(),
        1,
        "{j}"
    );
    assert!(
        j.contains("a task it catches is requeued when its lease expires"),
        "{j}"
    );
    // It starts, then ends: said, and started again ten minutes later.
    h.played.borrow_mut().listen_fails = false;
    h.tick(600);
    assert_eq!(h.played.borrow().listens, 3);
    h.says(Heard::Gone("execution error: Error: boom (-2700)".into()));
    h.tick(3);
    assert!(h.journal().contains("the watcher of the Mac's sleep ended (execution error: Error: boom (-2700)); started again in 10 minutes"));
    h.tick(3);
    assert_eq!(h.played.borrow().listens, 3);
    h.tick(600);
    assert_eq!(h.played.borrow().listens, 4);
    // The assertion never needed it.
    h.tasks = Some(true);
    h.tick(10);
    assert!(h.held());
}

/// The watcher's script names the two notifications `AppKit` posts around a sleep, waits for
/// the agent's line after `sleep`, and ends with its parent.
#[test]
fn the_watcher_observes_appkits_sleep_and_wake_and_waits_for_the_agent() {
    for want in [
        "'NSWorkspaceWillSleepNotification'",
        "'NSWorkspaceDidWakeNotification'",
        "say('sleep');\n        if (input.availableData.length == 0) { $.exit(0); }",
        "say('wake')",
        "say('ready');\napp.run;",
        "if ($.getppid() != agent) { $.exit(0); }",
    ] {
        assert!(WATCHER.contains(want), "{want}");
    }
}

/// A stand-in for one of macOS's tools: a shell script in `dir`, written from a child so no
/// write descriptor of it lives in this test process ([`crate::run::exec::write_stub`]).
fn stand_in(dir: &std::path::Path, name: &str, script: &str) -> PathBuf {
    let p = dir.join(name);
    crate::run::exec::write_stub(&p, script);
    p
}

/// Whether process `pid` runs (`kill -0`).
fn alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

/// Until `f` holds, or `secs` seconds.
fn within(secs: u64, f: &mut dyn FnMut() -> bool) -> bool {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while std::time::Instant::now() < end {
        if f() {
            return true;
        }
        thread::sleep(std::time::Duration::from_millis(50));
    }
    false
}

/// The real layer's plumbing with stand-ins for `caffeinate` and `osascript`: the assertion
/// is one child, `-i -w <the agent's pid>`, kept while it runs, taken again once it ended and
/// gone with its `Mac`; the watcher's lines are heard in order, the agent's `ok` reaches it
/// after `sleep`, and its end is heard with its last word on stderr.
#[test]
fn the_real_layer_runs_its_two_children_and_hears_the_watcher() {
    let dir = tempdir();
    let d = dir.display();
    let caffeinate = stand_in(
        &dir,
        "caffeinate",
        &format!("#!/bin/sh\necho \"$*\" > '{d}/caffeinate.args'\nexec sleep 600\n"),
    );
    let osascript = stand_in(
        &dir,
        "osascript",
        &format!("#!/bin/sh\n[ \"$1 $2 $3\" = '-l JavaScript -e' ] || exit 2\necho ready\necho sleep\nread ack\necho \"$ack\" > '{d}/ack'\necho wake\necho 'execution error: Error: gone (-2700)' >&2\nexit 1\n"),
    );
    let mut m = Mac::with(&caffeinate, &osascript);
    m.hold().unwrap();
    assert!(m.held());
    let pid = m.caffeinate.as_ref().unwrap().id();
    assert!(within(10, &mut || std::fs::read_to_string(
        dir.join("caffeinate.args")
    )
    .is_ok_and(|a| a.trim() == format!("-i -w {}", std::process::id()))));
    m.hold().unwrap();
    assert_eq!(
        m.caffeinate.as_ref().unwrap().id(),
        pid,
        "kept, not taken twice"
    );
    m.release();
    assert!(!m.held());
    // A holder that ended is seen, and the next hold takes another.
    m.hold().unwrap();
    let pid = m.caffeinate.as_ref().unwrap().id();
    Command::new("kill").arg(pid.to_string()).status().unwrap();
    assert!(within(10, &mut || !m.held()));
    m.hold().unwrap();
    assert_ne!(m.caffeinate.as_ref().unwrap().id(), pid);

    m.listen().unwrap();
    let mut heard = Vec::new();
    assert!(within(10, &mut || {
        heard.extend(m.heard());
        heard.len() >= 2
    }));
    assert_eq!(heard, [Heard::Ready, Heard::Sleep]);
    m.let_sleep();
    assert!(within(10, &mut || {
        heard.extend(m.heard());
        heard.len() >= 4
    }));
    assert_eq!(
        heard[2..],
        [
            Heard::Wake,
            Heard::Gone("execution error: Error: gone (-2700)".into())
        ]
    );
    assert_eq!(std::fs::read_to_string(dir.join("ack")).unwrap(), "ok\n");
    assert!(m.watcher.is_none(), "reaped");
    // Gone with its Mac: no assertion outlives the agent's exit.
    let pid = m.caffeinate.as_ref().unwrap().id();
    drop(m);
    assert!(!alive(pid));
}

/// A watcher that cannot be started says why.
#[test]
fn a_watcher_that_cannot_start_says_why() {
    let dir = tempdir();
    let mut m = Mac::with(&dir.join("caffeinate"), &dir.join("osascript"));
    let e = m.listen().unwrap_err();
    assert!(
        e.starts_with(&format!("could not start {}/osascript: ", dir.display())),
        "{e}"
    );
    assert!(m.hold().unwrap_err().contains("caffeinate"));
    assert!(!m.held());
}

/// The real layer, on the macOS runner: `caffeinate -i -w <pid>` holds exactly
/// `PreventUserIdleSystemSleep` while it runs, as `pmset -g assertions` lists it, and none
/// once released.
#[cfg(target_os = "macos")]
#[test]
fn on_a_mac_caffeinate_holds_prevent_user_idle_system_sleep_until_released() {
    let assertions = || {
        let o = Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&o.stdout).into_owned()
    };
    let mut m = Mac::default();
    m.hold().unwrap();
    assert!(m.held());
    let mine = format!("pid {}(caffeinate)", m.caffeinate.as_ref().unwrap().id());
    assert!(
        within(10, &mut || assertions().lines().any(
            |l| l.contains(&mine) && l.contains("PreventUserIdleSystemSleep")
        )),
        "{}",
        assertions()
    );
    m.release();
    assert!(!m.held());
    assert!(
        within(10, &mut || !assertions().contains(&mine)),
        "{}",
        assertions()
    );
}

/// The watcher starts on the macOS runner (`AppKit`'s observers in place, `ready` said), and
/// ends with the agent's [`Mac`].
#[cfg(target_os = "macos")]
#[test]
fn on_a_mac_the_watcher_starts_and_says_it_is_ready() {
    let mut m = Mac::default();
    m.listen().unwrap();
    let mut heard = Vec::new();
    within(60, &mut || {
        heard.extend(m.heard());
        heard
            .iter()
            .any(|h| matches!(h, Heard::Ready | Heard::Gone(_)))
    });
    assert_eq!(heard, [Heard::Ready]);
    let pid = m.watcher.as_ref().unwrap().child.id();
    drop(m);
    assert!(!alive(pid), "the watcher ended with its Mac");
}
