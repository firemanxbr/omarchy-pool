//! The run loop against a real engine (#315's integration test): the pinned docker CLI
//! and compose plugin downloaded from `factory/bundle/manifest.toml`, a stand-in
//! dispatcher (busybox: it saves its leases on SIGTERM, re-adopts them, answers `/ready`
//! and exits 75 on demand) and a long-running task container that must survive every
//! rollout. The pool and GitHub are in-process fakes; signatures vouch (the real check is
//! `verify`'s own tests).
//!
//! `tests/agent-run-loop.sh` runs it (CI: rootful docker, and rootless podman's API
//! socket); it needs `OMARCHY_AGENT_ENGINE_SOCKET` and `OMARCHY_STANDIN_IMAGE`.
//!
//! The host orders of #344 against a stand-in legacy compose project — `reconcile-now`,
//! then `retire-legacy`, which stops and removes that project and nothing else and writes
//! the marker into its directory — are `tests/agent-host-orders.sh`'s, on the same host;
//! so are #325's settings, narrowed into the file the dispatcher mounts while the task runs
//! on, and `diagnostics` reading the stand-in's own log, scrubbed. The owner's runtime
//! switch from one real engine to another is `tests/agent-runtime-switch.sh`'s.

use std::cell::RefCell;
use std::fmt::Write as _;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::run::agent::{Agent, Drivers};
use crate::run::compose::Compose;
use crate::run::config::{Config, Paths, Runtime};
use crate::run::driver::Driver;
use crate::run::fake::{
    relay_statement, FakePool, PoolState, Remote, TestVerifier, HOST_COMPOSE, HOST_SET,
};
use crate::run::pool::{Arg, HostState, Https, Net, Order, OrderKind, Pool};
use crate::run::state::{State, Step};
use crate::run::tools::{self, Tools};
use crate::verify::tests_support;
use crate::version::Release;

const TOKEN: &str = "omw_engine_test_token_0123456789";

/// The stand-in dispatcher: `$$` is compose's literal `$`.
const STANDIN: &str = r#"set -eu
root="$${OMARCHY_WORK_ROOT}"
me="$$(hostname)"
# A careless dispatcher: its token in its log, for #325's diagnostics to scrub.
echo "stand-in: up as $$me with worker token $${OMARCHY_WORKER_TOKEN:-none}"
if [ "$${1:-ok}" = broken ]; then echo "stand-in: a broken release" >&2; exit 1; fi
n=0
for f in "$$root"/leases/*; do [ -e "$$f" ] && n=$$((n + 1)); done
echo "$$n" > "$$root/readopted.$$me"
mkdir -p /tmp/www
echo ok > /tmp/www/ready
httpd -p 127.0.0.1:8791 -h /tmp/www
if [ "$${1:-ok}" = crash ]; then sleep 4; echo "stand-in: crashed" >&2; exit 3; fi
trap 'echo saved > "$$root/saved.$$me"; exit 0' TERM
while :; do
  if [ -e "$$root/exit75" ]; then rm -f "$$root/exit75"; exit 75; fi
  sleep 1 & wait $$!
done
"#;

fn env(name: &str) -> String {
    std::env::var(name)
        .unwrap_or_else(|_| panic!("{name} is not set (tests/agent-run-loop.sh sets it)"))
}

/// The tools the release pins for this platform, downloaded and checked like a host does.
fn pinned_tools(dir: &Path) -> Tools {
    let policy: toml::Table =
        toml::from_str(include_str!("../../../../factory/bundle/manifest.toml")).unwrap();
    let platform = tools::platform().expect("a platform with pinned tools");
    let named = policy["tools"][platform].as_table().unwrap();
    let list: Vec<(String, String, String)> = ["docker", "docker-compose"]
        .iter()
        .map(|n| {
            let t = &named[*n];
            (
                (*n).to_owned(),
                t["url"].as_str().unwrap().to_owned(),
                t["sha256"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let refs: Vec<(&str, &str, &str)> = list
        .iter()
        .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
        .collect();
    let m = tests_support::manifest_with_tools(platform, &refs);
    let mut net = Https::new("https://pkgs.omarchy-pool.org");
    tools::ensure(dir, &m, platform, &mut |url| match net.download(url) {
        Net::Ok(b) => Ok(b),
        Net::NoAnswer(e) => Err(e),
        Net::Unauthorized(s) => Err(format!("HTTP {s}")),
    })
    .unwrap()
}

struct Host {
    agent: Agent,
    remote: Remote,
    tools: Tools,
    socket: PathBuf,
    dir: PathBuf,
    project: String,
    image: String,
    task: String,
}

impl Host {
    fn docker(&self, args: &[&str]) -> String {
        let out = Command::new(&self.tools.docker)
            .env_clear()
            .env("DOCKER_HOST", format!("unix://{}", self.socket.display()))
            .env("DOCKER_CONFIG", self.dir.join("data/docker-config"))
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "docker {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    fn work(&self) -> PathBuf {
        self.dir.join("work")
    }

    /// Publishes `r` on the fake GitHub: the host template rendered with the stand-in
    /// image as the manifest's worker image, the stand-in's script and `mode`.
    fn publish(&self, r: &str, mode: &str) {
        let (repo, index) = self.image.split_once('@').unwrap();
        let mut m = tests_support::manifest_json(r, "v1.0.0", &[]);
        m["created"] = "2027-01-14T08:00:00Z".into();
        m["inner"]["pools"] = serde_json::json!(["https://pkgs.omarchy-pool.org"]);
        m["inner"]["images"]["worker"]["repo"] = repo.into();
        m["inner"]["images"]["worker"]["index"] = index.into();
        let b = m["inner"]["images"]["build"].clone();
        let script = STANDIN.lines().fold(String::new(), |mut out, l| {
            out.push_str("        ");
            out.push_str(l);
            out.push('\n');
            out
        });
        let compose = format!(
            "{}    entrypoint:\n      - sh\n      - -c\n      - |\n{script}      - standin\n    command: [{mode}]\n",
            HOST_COMPOSE
                .replace("ghcr.io/firemanxbr/omarchy-worker@RELEASE@", &self.image)
                .replace("@RELEASE_IMAGE@", &self.image)
                .replace("@BUILD_AARCH64@", b["aarch64"].as_str().unwrap())
                .replace("@BUILD_X86_64@", b["x86_64"].as_str().unwrap())
        );
        let set = HOST_SET
            .replace("guard_s = 90", "guard_s = 20")
            .replace("wait_s = 120", "wait_s = 40");
        let archive = tests_support::bundle_archive(
            m,
            &[
                ("compose.yml", compose.as_bytes()),
                ("set.toml", set.as_bytes()),
            ],
        );
        let mut s = self.remote.borrow_mut();
        s.assets
            .insert(format!("{r}/omarchy-host-{r}.tar.gz"), archive);
        s.assets.insert(
            format!("{r}/omarchy-host-{r}.tar.gz.sigstore.json"),
            b"signed".to_vec(),
        );
    }

    /// The pool names `latest`. The host-side brake (#325) would hold a second release
    /// change within ten minutes: these stories roll releases out back to back on purpose,
    /// so its window starts again here (its own tests are `run::brake`'s and
    /// `run::settings_tests`').
    fn target(&mut self, latest: &str) {
        self.agent.state.brake = crate::run::brake::Brake::default();
        self.remote.borrow_mut().state = Some(Net::Ok(HostState {
            target: Release::parse(latest),
            poll_s: Some(60),
            ..HostState::default()
        }));
    }

    fn tick(&mut self, round_now: bool) {
        let now = crate::run::now();
        self.agent.tick(now, round_now).unwrap();
    }

    /// Ticks once a second until `done`, or fails after `limit`.
    fn until(&mut self, what: &str, limit: Duration, mut done: impl FnMut(&mut Host) -> bool) {
        let start = Instant::now();
        while !done(self) {
            assert!(
                start.elapsed() < limit,
                "{what}: not within {limit:?}; state {:?}, round {:?}",
                self.agent.state.rollout,
                self.agent.state.round
            );
            std::thread::sleep(Duration::from_secs(1));
            self.tick(false);
        }
    }

    fn round(&mut self, what: &str) {
        self.tick(true);
        self.until(what, Duration::from_secs(300), |h| {
            h.agent.state.rollout.step == Step::Idle
        });
    }

    fn dispatcher(&self) -> (String, String) {
        let id = self.docker(&[
            "ps",
            "-q",
            "--no-trunc",
            "--filter",
            &format!("label=com.docker.compose.project={}", self.project),
        ]);
        assert_eq!(id.lines().count(), 1, "one dispatcher: {id:?}");
        let release = self.docker(&[
            "inspect",
            "-f",
            "{{index .Config.Labels \"org.omarchy-pool.agent.release\"}}",
            &id,
        ]);
        (id, release)
    }

    fn task_state(&self) -> String {
        self.docker(&[
            "inspect",
            "-f",
            "{{.State.Running}} {{.State.StartedAt}} {{.RestartCount}}",
            &self.task,
        ])
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let ids = Command::new(&self.tools.docker)
            .env_clear()
            .env("DOCKER_HOST", format!("unix://{}", self.socket.display()))
            .args([
                "ps",
                "-aq",
                "--filter",
                &format!("label=com.docker.compose.project={}", self.project),
            ])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        let mut rm = Command::new(&self.tools.docker);
        rm.env_clear()
            .env("DOCKER_HOST", format!("unix://{}", self.socket.display()))
            .args(["rm", "-f", &self.task])
            .args(ids.split_whitespace());
        let _ = rm.output();
        // And the network compose made for the set.
        sweep(&self.tools, &self.socket, &self.project);
    }
}

fn host() -> Host {
    let socket = PathBuf::from(env("OMARCHY_AGENT_ENGINE_SOCKET"));
    let image = env("OMARCHY_STANDIN_IMAGE");
    let dir = crate::run::state::tempdir();
    let set = dir.join("set");
    for d in [
        set.join("etc"),
        set.join("run"),
        dir.join("work/leases"),
        dir.join("secrets"),
        dir.join("data/docker-config"),
    ] {
        fs::create_dir_all(&d).unwrap();
    }
    // Rootful engines write as root into the work root; let the test clean up after it.
    fs::set_permissions(dir.join("work"), fs::Permissions::from_mode(0o777)).unwrap();
    fs::write(
        set.join("etc/dispatcher.env"),
        format!("OMARCHY_WORKER_TOKEN={TOKEN}\n"),
    )
    .unwrap();
    fs::write(set.join("run/capacity.json"), r#"{"schema":2,"units":3}"#).unwrap();
    let project = format!("omarchy-it-{}", std::process::id());
    let toml = format!(
        r#"pool = "https://pkgs.omarchy-pool.org"
host_id = "h_engine_test"
worker_id = "w_engine_test"
[set]
dir = "{}"
work_root = "{}"
secrets_dir = "{}"
project = "{project}"
socket_cli = "{}"
[envelope]
allow_socket = true
rootful_ack = true
dedicated = true
"#,
        set.display(),
        dir.join("work").display(),
        dir.join("secrets").display(),
        socket.display()
    );
    let cfg = Config::parse(&toml).unwrap();
    // On disk as install writes it: the owner's runtime switch rewrites it at its end (#325).
    fs::write(dir.join("data/agent.toml"), &toml).unwrap();
    fs::set_permissions(
        dir.join("data/agent.toml"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let tools = pinned_tools(
        &std::env::var("OMARCHY_AGENT_TOOLS")
            .map_or_else(|_| dir.join("data/tools"), PathBuf::from),
    );
    let remote: Remote = Rc::new(RefCell::new(PoolState::default()));
    let signed = Rc::new(RefCell::new(crate::run::now()));
    let paths = Paths {
        data: dir.join("data"),
    };
    let mut agent = Agent::new(
        cfg,
        paths,
        State::default(),
        Box::new(FakePool(Rc::clone(&remote))),
        Box::new(TestVerifier(signed, Rc::default())),
        Drivers::Fixed,
    );
    agent.driver = Some(Box::new(Compose::new(
        tools.clone(),
        &socket,
        &dir.join("data/docker-config"),
    )));
    let mut h = Host {
        agent,
        remote,
        tools,
        socket,
        dir,
        project,
        image,
        task: String::new(),
    };
    // A task the dispatcher started, holding a lease: not part of the compose project.
    h.docker(&["pull", "--quiet", &h.image]);
    h.task = h.docker(&[
        "run",
        "-d",
        "--label",
        "org.omarchy-pool.task=it",
        &h.image,
        "sleep",
        "3600",
    ]);
    fs::write(h.work().join("leases/task-1"), "lease").unwrap();
    h
}

#[test]
#[ignore = "needs a real engine: tests/agent-run-loop.sh"]
fn real_engine_rollouts_keep_the_task_running() {
    // The agent must never run a docker or compose but the pinned ones: decoys first in
    // PATH would leave a mark.
    let decoys = crate::run::state::tempdir();
    for name in ["docker", "docker-compose", "podman"] {
        let p = decoys.join(name);
        fs::write(
            &p,
            format!("#!/bin/sh\ntouch {}/ran-{name}\nexit 1\n", decoys.display()),
        )
        .unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::env::set_var(
        "PATH",
        format!(
            "{}:{}",
            decoys.display(),
            std::env::var("PATH").unwrap_or_default()
        ),
    );

    let mut h = host();
    let task0 = h.task_state();
    releases_with_ordered_restarts(&mut h);
    assert_eq!(h.task_state(), task0, "the task container kept running");
    a_broken_release_is_reverted(&mut h);
    assert_eq!(h.task_state(), task0);
    a_statement_preempts_and_goes_down(&mut h);
    assert_eq!(
        h.task_state(),
        task0,
        "the task container survived every rollout"
    );
    nothing_but_the_pinned_tools_and_no_secret_on_disk(&h, &decoys);
}

/// The first release reaches the host with no human action; a second one survives two
/// ordered restarts (exit 75) during its guard, and its dispatcher re-adopts the task.
fn releases_with_ordered_restarts(h: &mut Host) {
    h.publish("v1.0.0", "ok");
    h.target("v1.0.0");
    h.round("v1.0.0");
    assert_eq!(
        h.agent.state.round.outcome, "ok",
        "{:?}",
        h.agent.state.round
    );
    let (d1, rel) = h.dispatcher();
    assert_eq!(rel, "v1.0.0");

    h.publish("v1.1.0", "ok");
    h.target("v1.1.0");
    h.tick(true);
    h.until("the v1.1.0 guard", Duration::from_secs(300), |h| {
        matches!(h.agent.state.rollout.step, Step::Guard(_))
    });
    for n in 1..=2 {
        fs::write(h.work().join("exit75"), "").unwrap();
        h.until("the ordered restart", Duration::from_secs(60), |h| {
            let id = h.dispatcher().0;
            !h.work().join("exit75").exists()
                && h.docker(&["inspect", "-f", "{{.RestartCount}}", &id]) == n.to_string()
        });
        assert!(
            matches!(h.agent.state.rollout.step, Step::Guard(_)),
            "{:?}",
            h.agent.state.rollout
        );
    }
    h.until("v1.1.0", Duration::from_secs(300), |h| {
        h.agent.state.rollout.step == Step::Idle
    });
    assert_eq!(
        h.agent.state.round.outcome, "ok",
        "{:?}",
        h.agent.state.round
    );
    assert_eq!(h.agent.state.applied, Release::parse("v1.1.0"));
    let (d2, rel) = h.dispatcher();
    assert_eq!(rel, "v1.1.0");
    assert_ne!(d1, d2);
    // The old dispatcher saved its leases on its way out; the new one re-adopted the task.
    assert!(h.work().join(format!("saved.{}", &d1[..12])).exists());
    let readopted = fs::read_to_string(h.work().join(format!("readopted.{}", &d2[..12]))).unwrap();
    assert_eq!(readopted.trim(), "1");
}

/// Broken releases: one that never answers `/ready`, one that answers and then crashes
/// (the guard sees its exit 3): each reverted, quarantined, reported with its release.
fn a_broken_release_is_reverted(h: &mut Host) {
    for (r, mode, failed) in [
        ("v1.2.0", "broken", "replace: "),
        ("v1.2.1", "crash", "guard: "),
    ] {
        h.publish(r, mode);
        h.target(r);
        h.round(r);
        let round = &h.agent.state.round;
        assert_eq!(round.outcome, "rolled-back", "{round:?}");
        assert_eq!(round.from, Release::parse(r));
        assert!(round.detail.starts_with(failed), "{round:?}");
        assert!(h
            .agent
            .state
            .quarantine
            .contains_key(&Release::parse(r).unwrap()));
        assert_eq!(h.dispatcher().1, "v1.1.0");
    }
}

/// A rollback statement mid-round preempts it and moves the host down.
fn a_statement_preempts_and_goes_down(h: &mut Host) {
    h.publish("v1.3.0", "ok");
    h.target("v1.3.0");
    h.tick(true);
    h.until("the v1.3.0 guard", Duration::from_secs(300), |h| {
        matches!(h.agent.state.rollout.step, Step::Guard(_))
    });
    relay_statement(&h.remote, 1, "v1.0.0", "v1.3.0", b"signed");
    h.target("v1.0.0");
    h.round("the rollback to v1.0.0");
    assert_eq!(
        h.agent.state.round.outcome, "ok",
        "{:?}",
        h.agent.state.round
    );
    assert_eq!(
        (h.agent.state.applied, h.agent.state.floor),
        (Release::parse("v1.0.0"), Release::parse("v1.0.0"))
    );
    assert_eq!(h.dispatcher().1, "v1.0.0");
}

/// Only the pinned binaries ran, and no file holds the token or interpolated output.
fn nothing_but_the_pinned_tools_and_no_secret_on_disk(h: &Host, decoys: &Path) {
    let ran: Vec<_> = fs::read_dir(decoys)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("ran-"))
        .collect();
    assert!(
        ran.is_empty(),
        "a binary outside the pinned ones ran: {ran:?}"
    );
    let work = h.work().display().to_string();
    let mut stack = vec![h.dir.join("data"), h.dir.join("set")];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.starts_with(h.dir.join("data/tools")) {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if !p.ends_with("etc/dispatcher.env") {
                let text = String::from_utf8_lossy(&fs::read(&p).unwrap()).into_owned();
                assert!(!text.contains(TOKEN), "{} holds the token", p.display());
                assert!(
                    !text.contains(&format!("{work}:{work}")),
                    "{} holds interpolated output",
                    p.display()
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// #344: the host orders against a stand-in legacy compose project.

/// A compose project made by the pinned compose, as the legacy set's updater makes its own:
/// services that end on SIGTERM, in `dir`, with compose's own network.
fn compose_up(h: &Host, project: &str, dir: &Path, services: &[&str]) {
    let mut yml = String::from("services:\n");
    for s in services {
        // stop_grace_period as the Studio's workers have it: the order's own grace applies.
        let _ = write!(
            yml,
            "  {s}:\n    image: {}\n    command: [\"sh\", \"-c\", \"trap 'exit 0' TERM; while :; do sleep 1 & wait $$!; done\"]\n    stop_grace_period: 3h\n",
            h.image
        );
    }
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("compose.yml"), yml).unwrap();
    let out = Command::new(&h.tools.compose)
        .env_clear()
        .env("DOCKER_HOST", format!("unix://{}", h.socket.display()))
        .env("DOCKER_CONFIG", h.dir.join("data/docker-config"))
        .current_dir(dir)
        .args([
            "--project-name",
            project,
            "up",
            "--detach",
            "--pull",
            "never",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "compose up {project}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Every container and network labelled with `project`, removed (the test's cleanup).
fn sweep(tools: &Tools, socket: &Path, project: &str) {
    let docker = |args: &[&str]| {
        Command::new(&tools.docker)
            .env_clear()
            .env("DOCKER_HOST", format!("unix://{}", socket.display()))
            .args(args)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let label = format!("label=com.docker.compose.project={project}");
    let ids = docker(&["ps", "-aq", "--filter", &label]);
    let mut rm = vec!["rm", "-f"];
    rm.extend(ids.split_whitespace());
    if rm.len() > 2 {
        docker(&rm);
    }
    for n in docker(&["network", "ls", "-q", "--filter", &label]).split_whitespace() {
        docker(&["network", "rm", n]);
    }
}

struct Projects(Tools, PathBuf, Vec<String>);

impl Drop for Projects {
    fn drop(&mut self) {
        for p in &self.2 {
            sweep(&self.0, &self.1, p);
        }
    }
}

impl Host {
    fn orders(&self, orders: &[(OrderKind, &str)]) {
        let now = crate::run::now();
        let mut r = self.remote.borrow_mut();
        let mut s = match r.state.take() {
            Some(Net::Ok(s)) => s,
            _ => HostState::default(),
        };
        s.orders = orders
            .iter()
            .map(|(kind, id)| Order {
                id: (*id).into(),
                kind: kind.clone(),
                not_after: Some(now + 3600),
            })
            .collect();
        r.state = Some(Net::Ok(s));
    }

    fn answer(&self, id: &str) -> Option<(String, String)> {
        self.agent
            .state
            .orders
            .answers
            .iter()
            .find(|a| a.id == id)
            .map(|a| (a.outcome.clone(), a.detail.clone()))
    }

    /// `docker ps -a` of a project: (id, status), sorted.
    fn of_project(&self, project: &str) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .docker(&[
                "ps",
                "-a",
                "--no-trunc",
                "--format",
                "{{.ID}} {{.State}}",
                "--filter",
                &format!("label=com.docker.compose.project={project}"),
            ])
            .lines()
            .filter_map(|l| l.split_once(' '))
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
            .collect();
        v.sort();
        v
    }
}

#[test]
#[ignore = "needs a real engine: tests/agent-host-orders.sh"]
#[allow(clippy::too_many_lines)] // one host, one story: a round on order, then the retirement
fn real_engine_host_orders_reconcile_and_retire_the_legacy_set() {
    let mut h = host();
    let legacy_project = format!("omarchy-legacy-it-{}", std::process::id());
    let other_project = format!("omarchy-other-it-{}", std::process::id());
    let _cleanup = Projects(
        h.tools.clone(),
        h.socket.clone(),
        vec![legacy_project.clone(), other_project.clone()],
    );
    h.publish("v1.0.0", "ok");
    h.target("v1.0.0");
    h.round("v1.0.0");
    assert_eq!(
        h.agent.state.round.outcome, "ok",
        "{:?}",
        h.agent.state.round
    );
    let (dispatcher, _) = h.dispatcher();
    let task0 = h.task_state();

    // The legacy set (the Studio's, in small) and a project nobody recorded, side by side.
    let legacy_dir = h.dir.join("srv-omarchy-pool");
    compose_up(
        &h,
        &legacy_project,
        &legacy_dir,
        &["pool", "review", "updater"],
    );
    let other_dir = h.dir.join("other");
    compose_up(&h, &other_project, &other_dir, &["worker"]);
    let other = h.of_project(&other_project);
    assert_eq!(h.of_project(&legacy_project).len(), 3);
    // Recorded as install records it, against the same engine (its directory included).
    let d = crate::install::engine::Docker {
        cli: h.tools.docker.clone(),
        socket: h.socket.clone(),
    };
    let seen = crate::install::legacy::look(&d, &legacy_project).unwrap();
    assert_eq!(seen.containers.len(), 3);
    assert_eq!(seen.dir().as_deref(), Some(legacy_dir.as_path()));
    crate::install::legacy::record(
        &h.agent.paths.data,
        &crate::install::legacy::Legacy {
            project: legacy_project.clone(),
            recorded_at: "2027-01-01T08:00:00Z".into(),
            containers: seen.containers.clone(),
            networks: seen.networks.clone(),
            rootful_exception: true,
            dir: seen.dir(),
            retired_at: None,
            retired_by: None,
        },
    )
    .unwrap();

    // reconcile-now: a round now, answered; the legacy set untouched.
    h.orders(&[(OrderKind::ReconcileNow, "ho_it_reconcile")]);
    h.agent.state.poll.next_at = 0;
    h.tick(false);
    assert_eq!(
        h.answer("ho_it_reconcile").map(|a| a.0).as_deref(),
        Some("done")
    );
    h.until("the reconcile round", Duration::from_secs(300), |h| {
        h.agent.state.rollout.step == Step::Idle
    });
    assert_eq!(
        h.agent.state.round.outcome, "no-change",
        "{:?}",
        h.agent.state.round
    );
    assert_eq!(
        h.dispatcher().0,
        dispatcher,
        "nothing changed, nothing replaced"
    );
    assert!(h
        .of_project(&legacy_project)
        .iter()
        .all(|(_, s)| s == "running"));

    // retire-legacy: the marker, then stopped, then removed — exactly that project.
    h.orders(&[(OrderKind::RetireLegacy, "ho_it_retire")]);
    h.agent.state.poll.next_at = 0;
    h.tick(false);
    assert!(
        legacy_dir.join(".omarchy-agent").exists(),
        "the marker first"
    );
    h.until("the retirement", Duration::from_secs(300), |h| {
        h.answer("ho_it_retire").is_some()
    });
    let (outcome, detail) = h.answer("ho_it_retire").unwrap();
    assert_eq!(outcome, "done", "{detail}");
    assert!(
        detail.starts_with(&format!(
            "stopped and removed 3 container(s) and 1 network(s) of compose project {legacy_project}"
        )),
        "{detail}"
    );
    assert!(h.of_project(&legacy_project).is_empty());
    assert!(h
        .docker(&[
            "network",
            "ls",
            "-q",
            "--filter",
            &format!("label=com.docker.compose.project={legacy_project}")
        ])
        .is_empty());
    // Everything else as it was: the other project, the task, the bundle's dispatcher.
    assert_eq!(h.of_project(&other_project), other);
    assert_eq!(h.task_state(), task0);
    assert_eq!(h.dispatcher().0, dispatcher);
    // The record and the marker say so; the legacy directory's files are all there.
    let l = crate::install::legacy::recorded(&h.agent.paths.data)
        .unwrap()
        .unwrap();
    assert_eq!(l.retired_by.as_deref(), Some("ho_it_retire"));
    assert!(legacy_dir.join("compose.yml").exists());
    let marker = fs::read_to_string(legacy_dir.join(".omarchy-agent")).unwrap();
    assert!(
        marker.starts_with(&format!(
            "agent={}\nhost=h_engine_test\nsince=",
            h.agent.version
        )),
        "{marker}"
    );
}

// ---------------------------------------------------------------------------------------
// #325: the host's settings and diagnostics, and the owner's runtime switch.

/// `run/capacity.json` as detection writes it: three units, one of them reserved for pool
/// jobs, this machine's native lane and the other architecture's emulated one.
fn detected_capacity() -> serde_json::Value {
    let native = std::env::consts::ARCH;
    let other = if native == "x86_64" {
        "aarch64"
    } else {
        "x86_64"
    };
    serde_json::json!({
        "schema": 2, "at": "2027-01-15T08:00:00Z", "cpus": 4, "mem_gb": 16,
        "disk_free_gb": {"work": 100, "engine": 100}, "units": 3, "job_reserved": 1,
        "agent_slots": 1,
        "lanes": [{"arch": native, "mode": "native"}, {"arch": other, "mode": "emulated", "via": "qemu"}]
    })
}

/// The docker CLI against `socket`, its output when it succeeded (a container being
/// replaced may not answer `exec`).
fn try_docker(tools: &Tools, socket: &Path, config: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new(&tools.docker)
        .env_clear()
        .env("DOCKER_HOST", format!("unix://{}", socket.display()))
        .env("DOCKER_CONFIG", config)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

impl Host {
    /// The one running dispatcher of the set on `socket`, if there is exactly one.
    fn dispatcher_on(&self, socket: &Path) -> Option<String> {
        let ids = try_docker(
            &self.tools,
            socket,
            &self.dir.join("data/docker-config"),
            &[
                "ps",
                "-q",
                "--no-trunc",
                "--filter",
                &format!("label=com.docker.compose.project={}", self.project),
            ],
        )?;
        (ids.lines().count() == 1).then_some(ids)
    }

    /// The capacity file the running dispatcher reads: its own bind mount, from inside it.
    fn mounted_capacity(&self) -> Option<serde_json::Value> {
        let id = self.dispatcher_on(&self.socket)?;
        let text = try_docker(
            &self.tools,
            &self.socket,
            &self.dir.join("data/docker-config"),
            &["exec", &id, "cat", "/run/omarchy/capacity.json"],
        )?;
        serde_json::from_str(&text).ok()
    }

    fn capacity_on_disk(&self) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.agent.cfg.set_dir.join("run/capacity.json")).unwrap())
            .unwrap()
    }

    /// Whether the set that runs was rendered from the inputs on disk now: no change of
    /// `run/capacity.json` (or `etc/`) waits for a round.
    fn inputs_applied(&self) -> bool {
        let inputs = crate::run::rollout::inputs_hash(&self.agent.cfg.set_dir);
        fs::read_to_string(
            self.agent
                .paths
                .last_good(&self.agent.cfg.set_name)
                .join("agent.yml"),
        )
        .is_ok_and(|o| o.contains(&inputs))
    }

    /// Gives `orders` at the next poll and ticks until each is answered, no round runs, the
    /// set was rendered from the file on disk and the dispatcher mounts it — the rounds a
    /// narrowing starts are over.
    fn give(&mut self, orders: &[(OrderKind, &str)]) {
        self.orders(orders);
        self.agent.state.poll.next_at = 0;
        self.tick(false);
        let ids: Vec<String> = orders.iter().map(|(_, id)| (*id).to_owned()).collect();
        self.until(
            "the orders' answers and their rounds",
            Duration::from_secs(300),
            |h| {
                ids.iter().all(|id| h.answer(id).is_some())
                    && h.agent.state.rollout.step == Step::Idle
                    && h.inputs_applied()
                    && h.mounted_capacity() == Some(h.capacity_on_disk())
            },
        );
    }
}

#[test]
#[ignore = "needs a real engine: tests/agent-host-orders.sh"]
#[allow(clippy::too_many_lines)] // one host, one story: narrowed, refused above, then read
fn real_engine_settings_narrow_the_mounted_capacity_and_diagnostics_are_scrubbed() {
    let mut h = host();
    let detected = detected_capacity();
    let file = h.agent.cfg.set_dir.join("run/capacity.json");
    fs::write(&file, detected.to_string()).unwrap();
    h.publish("v1.0.0", "ok");
    h.target("v1.0.0");
    h.round("v1.0.0");
    assert_eq!(
        h.agent.state.round.outcome, "ok",
        "{:?}",
        h.agent.state.round
    );
    let (d0, _) = h.dispatcher();
    let task0 = h.task_state();
    assert_eq!(h.mounted_capacity(), Some(detected.clone()));

    // Narrowed from the site: two units and no emulated lane, two seconds apart (the
    // brake's pace). The dispatcher is recreated with the narrowed file; the task runs on.
    let native = std::env::consts::ARCH;
    h.give(&[
        (OrderKind::SetUnits(Arg::Set(2)), "ho_it_units"),
        (OrderKind::SetEmulate(Arg::Set(Vec::new())), "ho_it_lanes"),
    ]);
    for id in ["ho_it_units", "ho_it_lanes"] {
        let (outcome, detail) = h.answer(id).unwrap();
        assert_eq!(outcome, "done", "{id}: {detail}");
    }
    assert!(h
        .answer("ho_it_units")
        .unwrap()
        .1
        .starts_with("units 3 → 2 (its envelope gives 3)"));
    let mounted = h.mounted_capacity().unwrap();
    assert_eq!(mounted["units"], 2, "{mounted}");
    assert_eq!(mounted["job_reserved"], 1);
    assert_eq!(
        mounted["lanes"],
        serde_json::json!([{"arch": native, "mode": "native"}])
    );
    assert_eq!(mounted["detected"]["units"], 3);
    assert_ne!(h.dispatcher().0, d0, "recreated with the narrowed file");
    assert_eq!(
        h.task_state(),
        task0,
        "a running task is never stopped for it"
    );
    assert_eq!(h.agent.state.brake.narrowings.len(), 2);

    // Above the envelope (it detected 3): refused on the host, nothing changed.
    let (d1, _) = h.dispatcher();
    let before = h.capacity_on_disk();
    h.give(&[(OrderKind::SetUnits(Arg::Set(5)), "ho_it_above")]);
    let (outcome, detail) = h.answer("ho_it_above").unwrap();
    assert_eq!(
        (outcome.as_str(), detail.as_str()),
        (
            "refused",
            "5 units is above this host's envelope: it detected 3, and only its owner widens that, at the host"
        )
    );
    assert_eq!(h.capacity_on_disk(), before);
    assert_eq!(h.dispatcher().0, d1);

    // Diagnostics: refused while the envelope does not allow them; then the stand-in's own
    // log lines, its token scrubbed, posted for the host's page.
    h.give(&[(OrderKind::Diagnostics, "ho_it_diag_no")]);
    let (outcome, detail) = h.answer("ho_it_diag_no").unwrap();
    assert_eq!(outcome, "refused");
    assert!(
        detail.starts_with("its envelope does not allow diagnostics"),
        "{detail}"
    );
    assert!(h.remote.borrow().diagnostics.is_empty());
    h.agent.cfg.policy.diagnostics = true;
    h.give(&[(OrderKind::Diagnostics, "ho_it_diag")]);
    let (outcome, detail) = h.answer("ho_it_diag").unwrap();
    assert_eq!(outcome, "done", "{detail}");
    let posted = h.remote.borrow().diagnostics[0].clone();
    assert_eq!(posted["order"], "ho_it_diag");
    let lines: Vec<String> = posted["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_owned())
        .collect();
    assert!(
        lines
            .iter()
            .any(|l| l.ends_with("with worker token [redacted]")),
        "{lines:?}"
    );
    assert!(!posted.to_string().contains(TOKEN));
    assert_eq!(h.task_state(), task0);
}

#[test]
#[ignore = "needs two real engines: tests/agent-runtime-switch.sh"]
#[allow(clippy::too_many_lines)] // one host, one story: refused while a task runs, then moved
fn real_engine_runtime_switch_moves_the_dispatcher_to_the_other_engine() {
    let to = PathBuf::from(env("OMARCHY_AGENT_SWITCH_SOCKET"));
    let mut h = host();
    let config = h.dir.join("data/docker-config");
    let _cleanup = Projects(h.tools.clone(), to.clone(), vec![h.project.clone()]);
    // The driver on another socket: the same pinned tools.
    let (tools, cfgdir) = (h.tools.clone(), config.clone());
    h.agent.drivers_on = Some(Box::new(move |socket: &Path| {
        Some(Box::new(Compose::new(tools.clone(), socket, &cfgdir)) as Box<dyn Driver>)
    }));
    h.publish("v1.0.0", "ok");
    h.target("v1.0.0");
    h.round("v1.0.0");
    assert_eq!(
        h.agent.state.round.outcome, "ok",
        "{:?}",
        h.agent.state.round
    );
    let (d0, _) = h.dispatcher();
    let from = h.socket.clone();
    // Which engine it runs on, as that engine said (the host's agent.toml names none).
    let from_driver = h
        .agent
        .cfg
        .runtime
        .map(Runtime::driver)
        .expect("the engine said which it is");
    let to_driver = match try_docker(
        &h.tools,
        &to,
        &config,
        &["version", "--format", "{{json .Server}}"],
    ) {
        Some(v) if v.contains("Podman Engine") => "compose/podman",
        Some(_) => "compose/docker",
        None => panic!("nothing answers on {}", to.display()),
    };

    // A task container of this host on the engine it runs on: tasks do not move between
    // engines, so the switch is refused and nothing changes.
    let task = h.docker(&[
        "run",
        "-d",
        "--label",
        "org.omarchy-pool.agent.host=h_engine_test",
        &h.image,
        "sleep",
        "3600",
    ]);
    crate::run::switch::request(&h.agent.paths.data, to_driver, Some(&to)).unwrap();
    h.tick(false);
    let end = h.agent.state.switch_last.clone().unwrap();
    assert_eq!(end.outcome, "refused", "{}", end.detail);
    assert!(
        end.detail.starts_with(&format!(
            "1 task container(s) run on {from_driver}: task containers, named volumes and caches do not move between engines"
        )),
        "{}",
        end.detail
    );
    assert_eq!(h.dispatcher().0, d0);
    h.docker(&["rm", "-f", &task]);

    // Drained: the dispatcher stops on the old engine and comes up on the new one through
    // a whole round — pull, replace, the guard — and agent.toml names it from then on.
    crate::run::switch::request(&h.agent.paths.data, to_driver, Some(&to)).unwrap();
    h.tick(false);
    assert!(
        h.agent.state.switch.is_some(),
        "{:?}",
        h.agent.state.switch_last
    );
    h.until("the switch", Duration::from_secs(600), |h| {
        h.agent.state.switch.is_none() && h.agent.state.rollout.step == Step::Idle
    });
    let end = h.agent.state.switch_last.clone().unwrap();
    assert_eq!(
        (end.to.as_str(), end.outcome.as_str()),
        (to_driver, "done"),
        "{}",
        end.detail
    );
    assert!(
        h.dispatcher_on(&to).is_some(),
        "the dispatcher runs on {}",
        to.display()
    );
    assert!(
        try_docker(
            &h.tools,
            &from,
            &config,
            &[
                "ps",
                "-aq",
                "--filter",
                &format!("label=com.docker.compose.project={}", h.project)
            ]
        )
        .unwrap()
        .is_empty(),
        "nothing of the set is left on {}",
        from.display()
    );
    assert!(fs::read_to_string(h.agent.paths.journal())
        .unwrap()
        .contains("\"from\":\"replace\",\"target\":\"v1.0.0\",\"to\":\"guard\""));
    let cfg = Config::parse(&fs::read_to_string(h.agent.paths.agent_toml()).unwrap()).unwrap();
    assert_eq!(
        (
            cfg.runtime.map(Runtime::driver),
            cfg.socket_cli.clone(),
            cfg.socket_mount.clone()
        ),
        (Some(to_driver.to_owned()), to.clone(), to.clone())
    );
    // The task container of the old engine was never part of it.
    assert!(h.task_state().starts_with("true "));
}
