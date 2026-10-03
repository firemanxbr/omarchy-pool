//! The run loop against a real engine (#315's integration test): the pinned docker CLI
//! and compose plugin downloaded from `factory/bundle/manifest.toml`, a stand-in
//! dispatcher (busybox: it saves its leases on SIGTERM, re-adopts them, answers `/ready`
//! and exits 75 on demand) and a long-running task container that must survive every
//! rollout. The pool and GitHub are in-process fakes; signatures vouch (the real check is
//! `verify`'s own tests).
//!
//! `tests/agent-run-loop.sh` runs it (CI: rootful docker, and rootless podman's API
//! socket); it needs `OMARCHY_AGENT_ENGINE_SOCKET` and `OMARCHY_STANDIN_IMAGE`.

use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::run::agent::{Agent, Drivers};
use crate::run::compose::Compose;
use crate::run::config::{Config, Paths};
use crate::run::fake::{
    relay_statement, FakePool, PoolState, Remote, TestVerifier, HOST_COMPOSE, HOST_SET,
};
use crate::run::pool::{Follow, Https, Net, Pool};
use crate::run::state::{State, Step};
use crate::run::tools::{self, Tools};
use crate::verify::tests_support;
use crate::version::Release;

const TOKEN: &str = "omw_engine_test_token_0123456789";

/// The stand-in dispatcher: `$$` is compose's literal `$`.
const STANDIN: &str = r#"set -eu
root="$${OMARCHY_WORK_ROOT}"
me="$$(hostname)"
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

    fn follow(&self, latest: &str) {
        self.remote.borrow_mut().follow = Some(Net::Ok(Follow {
            latest: Release::parse(latest),
            update: None,
            poll_s: Some(60),
            date: None,
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
    let cfg = Config::parse(&format!(
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
    ))
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
        Box::new(TestVerifier(signed)),
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
    h.follow("v1.0.0");
    h.round("v1.0.0");
    assert_eq!(
        h.agent.state.round.outcome, "ok",
        "{:?}",
        h.agent.state.round
    );
    let (d1, rel) = h.dispatcher();
    assert_eq!(rel, "v1.0.0");

    h.publish("v1.1.0", "ok");
    h.follow("v1.1.0");
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
        h.follow(r);
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
    h.follow("v1.3.0");
    h.tick(true);
    h.until("the v1.3.0 guard", Duration::from_secs(300), |h| {
        matches!(h.agent.state.rollout.step, Step::Guard(_))
    });
    relay_statement(&h.remote, 1, "v1.0.0", "v1.3.0", b"signed");
    h.follow("v1.0.0");
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
