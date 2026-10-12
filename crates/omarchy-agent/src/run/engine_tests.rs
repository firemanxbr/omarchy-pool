//! The run loop against a real engine (#315's integration test): the pinned docker CLI
//! and compose plugin downloaded from `factory/bundle/manifest.toml`, a stand-in
//! dispatcher (busybox: it saves its leases on SIGTERM, re-adopts them, answers `/ready`
//! and exits 75 on demand) and a long-running task container that must survive every
//! rollout. The pool and GitHub are in-process fakes; signatures vouch (the real check is
//! `verify`'s own tests).
//!
//! The host worker token (#327): the host starts as #371's agent left it, the token in
//! `etc/dispatcher.env`; the first round moves it to `run/host/dispatcher/token`, and
//! `docker inspect` then shows it in no container's environment — the dispatcher's, the
//! task's — while the stand-in reads it through its read-only mount; a rotation rewrites
//! the file and recreates the dispatcher alone, the task running on.
//!
//! `tests/agent-run-loop.sh` runs it (CI: rootful docker, and rootless podman's API
//! socket); it needs `OMARCHY_AGENT_ENGINE_SOCKET` and `OMARCHY_STANDIN_IMAGE`.
//!
//! The host orders of #344 against a stand-in legacy compose project — `reconcile-now`,
//! then `retire-legacy`, which stops and removes that project and nothing else and writes
//! the marker into its directory — are `tests/agent-host-orders.sh`'s, on the same host;
//! so are #325's settings, narrowed into the file the dispatcher mounts while the task runs
//! on, and `diagnostics` reading the stand-in's own log, scrubbed; and #328's widening the
//! owner's passkey signed, counted into the file the dispatcher mounts, with an agent key
//! sealed to the host that the dispatcher never sees; and #419's host with no agent keys,
//! whose keys file no probe mount ever makes a directory of, given them later by install
//! and by its owner. The owner's runtime switch from one
//! real engine to another is `tests/agent-runtime-switch.sh`'s. The same rollouts on the
//! Quadlet driver (#330) — the set as a unit of the user's own systemd, on rootless podman,
//! with no compose — and #327's token file and its rotation there are
//! `tests/agent-quadlet.sh`'s.

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
# A careless dispatcher: its token in its log, for #325's diagnostics to scrub — read from
# its file (#327), or the plain variable an older release's template gives.
tok="$${OMARCHY_WORKER_TOKEN:-none}"
if [ -n "$${OMARCHY_WORKER_TOKEN_FILE:-}" ]; then tok="$$(cat "$$OMARCHY_WORKER_TOKEN_FILE" || echo unreadable)"; fi
echo "stand-in: up as $$me with worker token $$tok"
if [ "$${1:-ok}" = broken ]; then echo "stand-in: a broken release" >&2; exit 1; fi
n=0
for f in "$$root"/leases/*; do [ -e "$$f" ] && n=$$((n + 1)); done
echo "$$n" > "$$root/readopted.$$me"
tf="$${OMARCHY_WORKER_TOKEN_FILE:-}"
if [ -n "$$tf" ]; then
  sha256sum < "$$tf" | cut -c1-16 > "$$root/token.$$me"
  if (echo x >> "$$tf") 2>/dev/null; then echo writable >> "$$root/token.$$me"; fi
fi
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
    /// The Quadlet driver's unit (#330), when the host runs on it.
    unit: Option<Unit>,
}

/// A Quadlet host's unit: its name and its file.
struct Unit {
    name: String,
    file: PathBuf,
}

/// `systemctl --user` as the test runs it, the system's own (the agent's own calls are its
/// driver's).
fn systemctl(args: &[&str]) -> String {
    let out = Command::new(crate::run::quadlet::systemctl_path())
        .arg("--user")
        .args(args)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
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
        if let Some(u) = &self.unit {
            let out = self.docker(&[
                "inspect",
                "-f",
                "{{.Id}} {{index .Config.Labels \"org.omarchy-pool.agent.release\"}}",
                &u.name,
            ]);
            let (id, release) = out.split_once(' ').unwrap();
            return (id.to_owned(), release.to_owned());
        }
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

    /// How many times the engine restarted the dispatcher: its container's count, or (a
    /// Quadlet unit's containers are new at each restart) its service's.
    fn restarts(&self) -> Option<u64> {
        let out = match &self.unit {
            Some(u) => systemctl(&[
                "show",
                "--property=NRestarts",
                "--value",
                &format!("{}.service", u.name),
            ]),
            None => try_docker(
                &self.tools,
                &self.socket,
                &self.dir.join("data/docker-config"),
                &["inspect", "-f", "{{.RestartCount}}", &self.dispatcher().0],
            )?,
        };
        out.trim().parse().ok()
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
        if let Some(u) = &self.unit {
            systemctl(&["stop", &format!("{}.service", u.name)]);
            let _ = fs::remove_file(&u.file);
            systemctl(&["daemon-reload"]);
            systemctl(&["reset-failed", &format!("{}.service", u.name)]);
        }
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
    host_on(false)
}

/// A host on the engine `OMARCHY_AGENT_ENGINE_SOCKET` names: through compose, or through
/// the Quadlet driver (#330) under this user's own systemd.
#[allow(clippy::too_many_lines)] // one host, set up as install sets one up
fn host_on(quadlet: bool) -> Host {
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
    // As #371's agent left the host: the token in the env file, no token file yet (#327).
    fs::write(
        set.join("etc/dispatcher.env"),
        format!("# worker: w-engine-test\nOMARCHY_WORKER_TOKEN={TOKEN}\n"),
    )
    .unwrap();
    fs::set_permissions(
        set.join("etc/dispatcher.env"),
        fs::Permissions::from_mode(0o600),
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
socket_cli = "{}"{}
[envelope]
allow_socket = true
rootful_ack = true
dedicated = true
"#,
        set.display(),
        dir.join("work").display(),
        dir.join("secrets").display(),
        socket.display(),
        if quadlet {
            "\ndriver = \"quadlet\"\nengine = \"rootless\""
        } else {
            ""
        }
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
    let compose = Compose::new(tools.clone(), &socket, &dir.join("data/docker-config"));
    let unit = quadlet.then(|| {
        // Where the user's generator reads them: `set.unit_dir` is left to its default.
        let units = agent.cfg.quadlet_dir().unwrap();
        let name = crate::quadlet::unit_name(&project, "dispatcher");
        Unit {
            file: units.join(format!("{name}.container")),
            name,
        }
    });
    agent.driver = Some(if quadlet {
        Box::new(crate::run::quadlet::Quadlet::new(
            Box::new(compose),
            Box::new(crate::run::quadlet::Systemctl::from_env()),
            &agent.cfg.quadlet_dir().unwrap(),
        ))
    } else {
        Box::new(compose)
    });
    let mut h = Host {
        agent,
        remote,
        tools,
        socket,
        dir,
        project,
        image,
        task: String::new(),
        unit,
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
    the_token_is_a_read_only_file_in_no_container_s_environment(&h, TOKEN);
    let rotated = a_rotation_recreates_the_dispatcher_alone(&mut h);
    assert_eq!(h.task_state(), task0, "the task container kept running");
    the_token_is_a_read_only_file_in_no_container_s_environment(&h, &rotated);
    a_broken_release_is_reverted(&mut h);
    assert_eq!(h.task_state(), task0);
    a_statement_preempts_and_goes_down(&mut h);
    assert_eq!(
        h.task_state(),
        task0,
        "the task container survived every rollout"
    );
    nothing_but_the_pinned_tools_and_no_secret_on_disk(&h, &decoys, &rotated);
}

/// The first 16 hex digits of the SHA-256 of a token file holding `token`, as the stand-in
/// writes what it read.
fn token_sha(token: &str) -> String {
    use sha2::{Digest as _, Sha256};
    hex::encode(Sha256::digest(format!("{token}\n")))[..16].to_owned()
}

/// #327's acceptance: `docker inspect` of the dispatcher and of the task shows no token in
/// their environment; the dispatcher reads `token` from its file through a read-only mount,
/// and could not write it; the env file holds it no more, the file 0400 does.
fn the_token_is_a_read_only_file_in_no_container_s_environment(h: &Host, token: &str) {
    let (d, _) = h.dispatcher();
    for id in [d.as_str(), h.task.as_str()] {
        let env = h.docker(&["inspect", "-f", "{{json .Config.Env}}", id]);
        assert!(
            !env.contains(token) && !env.contains("OMARCHY_WORKER_TOKEN="),
            "{id}'s environment: {env}"
        );
    }
    let env = h.docker(&["inspect", "-f", "{{json .Config.Env}}", &d]);
    assert!(
        env.contains("\"OMARCHY_WORKER_TOKEN_FILE=/run/omarchy/worker-token\""),
        "{env}"
    );
    let mounts: serde_json::Value =
        serde_json::from_str(&h.docker(&["inspect", "-f", "{{json .Mounts}}", &d])).unwrap();
    let file = crate::dispatcher_env::token_path_in(&h.dir.join("set"));
    let m = mounts
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["Destination"] == "/run/omarchy/worker-token")
        .unwrap_or_else(|| panic!("no token mount: {mounts}"));
    assert_eq!(
        (m["Source"].as_str(), m["RW"].as_bool()),
        (file.to_str(), Some(false)),
        "{m}"
    );
    let read = fs::read_to_string(h.work().join(format!("token.{}", &d[..12]))).unwrap();
    assert_eq!(
        read,
        format!("{}\n", token_sha(token)),
        "what the dispatcher read"
    );
    assert_eq!(
        crate::dispatcher_env::read_token(&file).unwrap(),
        Some((token.to_owned(), 0o400))
    );
    let text = fs::read_to_string(h.dir.join("set/etc/dispatcher.env")).unwrap();
    assert!(
        !text.contains(token) && text.contains("# worker: w-engine-test\n"),
        "{text}"
    );
}

/// A rotation (`omarchy-agent token`, or #325's order, through `write_worker_token`): the
/// file rewritten, and the next round recreates the dispatcher, and nothing else.
fn a_rotation_recreates_the_dispatcher_alone(h: &mut Host) -> String {
    let (before, release) = h.dispatcher();
    let new = format!("omw_{}", "7a".repeat(24));
    let r = crate::dispatcher_env::Rendered {
        addresses: Vec::new(),
        envelope: None,
        plain: false,
        keys_user: None,
    };
    crate::enroll::write_worker_token(
        &h.dir.join("set/etc/dispatcher.env"),
        &serde_json::json!({"worker": "w-engine-test", "token": new}),
        &r,
    )
    .unwrap();
    h.tick(false);
    assert_ne!(
        h.agent.state.rollout.step,
        Step::Idle,
        "the new token starts a round"
    );
    h.until("the rotation's round", Duration::from_secs(300), |h| {
        h.agent.state.rollout.step == Step::Idle
    });
    assert_eq!(
        h.agent.state.round.outcome, "ok",
        "{:?}",
        h.agent.state.round
    );
    let (after, same) = h.dispatcher();
    assert_ne!(before, after, "the dispatcher was recreated");
    assert_eq!(same, release, "on the same release");
    // The old dispatcher saved its leases; the new one re-adopted the task.
    assert!(h.work().join(format!("saved.{}", &before[..12])).exists());
    let readopted =
        fs::read_to_string(h.work().join(format!("readopted.{}", &after[..12]))).unwrap();
    assert_eq!(readopted.trim(), "1");
    new
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
    let r0 = h.restarts().expect("the dispatcher's restarts");
    for n in 1..=2 {
        fs::write(h.work().join("exit75"), "").unwrap();
        h.until("the ordered restart", Duration::from_secs(60), |h| {
            !h.work().join("exit75").exists() && h.restarts() == Some(r0 + n)
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
    // Once it answers again after its second restart.
    h.until("the v1.1.0 dispatcher", Duration::from_secs(60), |h| {
        try_docker(
            &h.tools,
            &h.socket,
            &h.dir.join("data/docker-config"),
            &[
                "exec",
                &h.dispatcher().0,
                "wget",
                "-q",
                "-O",
                "/dev/null",
                "http://127.0.0.1:8791/ready",
            ],
        )
        .is_some()
    });
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

/// Only the pinned binaries ran, and no file holds a token (but the token's own file) or
/// interpolated output.
fn nothing_but_the_pinned_tools_and_no_secret_on_disk(h: &Host, decoys: &Path, rotated: &str) {
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
            } else if !p.ends_with(crate::dispatcher_env::TOKEN_FILE) {
                let text = String::from_utf8_lossy(&fs::read(&p).unwrap()).into_owned();
                assert!(
                    !text.contains(TOKEN) && !text.contains(rotated),
                    "{} holds a token",
                    p.display()
                );
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

/// #328 on a real engine: the owner's passkey, pinned at the host, raises its unit cap
/// from the site — the dispatcher is recreated with the file counted again under it while
/// the task runs on, and the same document again is refused; then an agent key sealed to
/// the host's seal key lands in `OMARCHY_SECRETS_DIR/agent.env` and nowhere the dispatcher
/// reads: not its env, not its mounts. The owner is a virtual authenticator signing at the
/// wall clock's time (`owner::tests::Authenticator`).
#[test]
#[ignore = "needs a real engine: tests/agent-host-orders.sh"]
#[allow(clippy::too_many_lines)] // one host, one story: pinned, widened, replayed, keyed
fn real_engine_owner_widens_the_mounted_capacity_and_seals_keys_the_dispatcher_never_sees() {
    use crate::owner::tests::Authenticator;
    use crate::run::pool::Signed;
    const CANARY: &str = "sk-ant-engine-canary-7f3a9c";
    let mut h = host();
    // As install writes it under a cap of 2 units, and detection counted under that cap.
    let path = h.agent.paths.agent_toml();
    let toml = fs::read_to_string(&path)
        .unwrap()
        .replace("[envelope]\n", "[envelope]\nmax_units = 2\n");
    fs::write(&path, &toml).unwrap();
    h.agent.cfg = Config::parse(&toml).unwrap();
    let mut detected = detected_capacity();
    detected["cpus"] = 12.into();
    detected["mem_gb"] = 32.into();
    detected["units"] = 2.into();
    fs::write(
        h.agent.cfg.set_dir.join("run/capacity.json"),
        detected.to_string(),
    )
    .unwrap();
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
    assert_eq!(h.mounted_capacity().unwrap()["units"], 2);

    // The owner pins a passkey at the host, once (`omarchy-agent envelope pin-passkey`).
    let host_id = h.agent.cfg.host_id.clone();
    let owner = Authenticator::new();
    let now = crate::run::now();
    let state = h.agent.paths.data.join("state");
    let said = crate::owner::pin(
        &state,
        &host_id,
        &h.agent.cfg.pool,
        &owner.pin(&host_id, now),
        now,
    )
    .unwrap();
    assert!(said.contains("EdDSA"), "{said}");

    // Then raises the cap from the browser: 2 → 6 units, signed.
    let (doc, assertion) = owner.sign(
        "widen-envelope",
        &host_id,
        1,
        now,
        &serde_json::json!({"envelope": {"max_units": 6}}),
    );
    let widening = Signed { doc, assertion };
    h.give(&[(
        OrderKind::WidenEnvelope(Some(widening.clone())),
        "ho_it_widen",
    )]);
    let (outcome, detail) = h.answer("ho_it_widen").unwrap();
    assert_eq!(outcome, "done", "{detail}");
    assert!(detail.contains("max_units 2 → 6"), "{detail}");
    assert!(detail.contains("units 2 → 6"), "{detail}");
    assert!(fs::read_to_string(&path)
        .unwrap()
        .contains("max_units = 6\n"));
    let mounted = h.mounted_capacity().unwrap();
    assert_eq!(mounted["units"], 6, "{mounted}");
    assert_ne!(h.dispatcher().0, d0, "recreated with the widened file");
    assert_eq!(
        h.task_state(),
        task0,
        "a running task is never stopped for it"
    );

    // The same document again — the pool replaying it — is refused, nothing changed.
    let (d1, _) = h.dispatcher();
    let before = h.capacity_on_disk();
    h.give(&[(OrderKind::WidenEnvelope(Some(widening)), "ho_it_replay")]);
    let (outcome, detail) = h.answer("ho_it_replay").unwrap();
    assert_eq!(outcome, "refused");
    assert!(detail.contains("a replay"), "{detail}");
    assert_eq!(h.capacity_on_disk(), before);
    assert_eq!(h.dispatcher().0, d1);

    // An agent key sealed in the browser to the seal key the host reports.
    let public = h.agent.seal_key(now).unwrap().public_b64u();
    let raw = crate::owner::webauthn::unb64(&public, "the seal key", 64).unwrap();
    let sealed = crate::owner::seal::seal(&raw, &host_id, "ANTHROPIC_API_KEY", CANARY);
    let (doc, assertion) = owner.sign(
        "set-agent-keys",
        &host_id,
        2,
        now,
        &serde_json::json!({"seal_key": public, "keys": [sealed]}),
    );
    h.give(&[(
        OrderKind::SetAgentKeys(Some(Signed { doc, assertion })),
        "ho_it_keys",
    )]);
    let (outcome, detail) = h.answer("ho_it_keys").unwrap();
    assert_eq!(outcome, "done", "{detail}");
    assert!(!detail.contains(CANARY));
    let env = h.dir.join("secrets/agent.env");
    assert!(fs::read_to_string(&env)
        .unwrap()
        .contains(&format!("ANTHROPIC_API_KEY={CANARY}\n")));
    assert_eq!(
        fs::metadata(&env).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // The dispatcher never sees it: not in its env, not in what it mounts (it is told the
    // directory's path, OMARCHY_SECRETS_DIR, to mount into agent sidecars, and nothing
    // more), and the file is not there inside it.
    let (d2, _) = h.dispatcher();
    let env_of = h.docker(&["inspect", "-f", "{{json .Config.Env}}", &d2]);
    assert!(!env_of.contains(CANARY), "{env_of}");
    let secrets = h.dir.join("secrets");
    let mounts: serde_json::Value =
        serde_json::from_str(&h.docker(&["inspect", "-f", "{{json .Mounts}}", &d2])).unwrap();
    for m in mounts.as_array().unwrap() {
        let source = Path::new(m["Source"].as_str().unwrap());
        assert!(
            !source.starts_with(&secrets) && !secrets.starts_with(source),
            "the dispatcher mounts {}",
            source.display()
        );
    }
    let inside = h.docker(&["exec", &d2, "env"]);
    assert!(!inside.contains(CANARY));
    let read = try_docker(
        &h.tools,
        &h.socket,
        &h.dir.join("data/docker-config"),
        &["exec", &d2, "cat", &env.display().to_string()],
    );
    assert_eq!(read, None, "the dispatcher reads agent.env");
    assert_eq!(h.task_state(), task0);
}

// ---------------------------------------------------------------------------------------
// #419: a host with no agent keys, then given them by install and by its owner.

/// The probe's keys mount as the dispatcher writes it (`keys_mount`,
/// crates/pkg-repo/src/dispatch/spec.rs), run through the pinned docker CLI as `user` with
/// every capability dropped, as its probe and agent sidecars run (#399); here with no network,
/// and the stand-in's `cat` where the worker image's `agent --probe` reads the keys. Whether
/// the container ran, and what it and the engine said.
fn mount_keys(h: &Host, file: &Path, user: Option<&str>) -> (bool, String) {
    let mount = format!(
        "type=bind,source={},target=/run/omarchy/agent.env,readonly",
        file.display()
    );
    let mut args = vec!["run", "--rm", "--network", "none"];
    if let Some(u) = user {
        args.extend(["--user", u]);
    }
    args.extend([
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        &mount,
        &h.image,
        "cat",
        "/run/omarchy/agent.env",
    ]);
    let out = Command::new(&h.tools.docker)
        .env_clear()
        .env("DOCKER_HOST", format!("unix://{}", h.socket.display()))
        .env("DOCKER_CONFIG", h.dir.join("data/docker-config"))
        .args(&args)
        .output()
        .unwrap();
    (
        out.status.success(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ),
    )
}

/// Install's terminal and network, never asked here: `--agent-env-from` with `--yes`, and no
/// `GITHUB_TOKEN` among the keys.
struct NoTty;

impl crate::install::Sys for NoTty {
    fn run_env(
        &mut self,
        prog: &str,
        _: &[&str],
        _: &[(&'static str, String)],
    ) -> Result<String, String> {
        Err(format!("{prog}: not run here"))
    }
    fn confirm(&mut self, _: &str) -> Result<bool, String> {
        Err("no terminal here".into())
    }
    fn ask_keys(&mut self, _: &str) -> Result<String, String> {
        Err("no terminal here".into())
    }
    fn github_scopes(&mut self, _: &str) -> Result<Option<String>, String> {
        Err("no network here".into())
    }
    fn download(&mut self, url: &str) -> Result<Vec<u8>, String> {
        Err(format!("{url}: no network here"))
    }
    fn download_if_any(&mut self, url: &str) -> Result<Option<Vec<u8>>, String> {
        Err(format!("{url}: no network here"))
    }
}

impl Host {
    /// `name` in the running dispatcher's environment as `docker inspect` shows it — what
    /// `pkg-repo dispatch` reads its flags from (`OMARCHY_SECRETS_DIR`, `OMARCHY_AGENT_USER`,
    /// `OMARCHY_AGENT_HELD`) — when it is there and not empty.
    fn dispatcher_var(&self, name: &str) -> Option<String> {
        let env = self.docker(&[
            "inspect",
            "-f",
            "{{json .Config.Env}}",
            &self.dispatcher().0,
        ]);
        let env: Vec<String> = serde_json::from_str(&env).unwrap();
        let prefix = format!("{name}=");
        env.iter()
            .find_map(|kv| kv.strip_prefix(&prefix))
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    }

    /// What `pkg-repo dispatch` does with the agent keys, from its own environment: with
    /// `OMARCHY_AGENT_HELD` it starts no probe and no agent sidecar (`Net::env_file`,
    /// crates/pkg-repo/src/dispatch/mod.rs), `None`; otherwise its probe mounts
    /// `OMARCHY_SECRETS_DIR/agent.env` as `OMARCHY_AGENT_USER` ([`mount_keys`]).
    fn dispatcher_reads_keys(&self) -> Option<(bool, String)> {
        if self.dispatcher_var("OMARCHY_AGENT_HELD").is_some() {
            return None;
        }
        let dir = self
            .dispatcher_var("OMARCHY_SECRETS_DIR")
            .expect("the dispatcher's OMARCHY_SECRETS_DIR");
        let user = self.dispatcher_var("OMARCHY_AGENT_USER");
        Some(mount_keys(
            self,
            &Path::new(&dir).join("agent.env"),
            user.as_deref(),
        ))
    }

    /// Ticks until no round runs, the set runs from the inputs on disk, and the dispatcher's
    /// environment holds its model kinds for no keys (`held`) or names who reads them.
    fn keys_settled(&mut self, what: &str, held: bool) {
        self.until(what, Duration::from_secs(300), |h| {
            h.agent.state.rollout.step == Step::Idle
                && h.inputs_applied()
                && if held {
                    h.dispatcher_var("OMARCHY_AGENT_HELD").as_deref() == Some("no-keys")
                        && h.dispatcher_var("OMARCHY_AGENT_USER").is_none()
                } else {
                    h.dispatcher_var("OMARCHY_AGENT_USER").is_some()
                        && h.dispatcher_var("OMARCHY_AGENT_HELD").is_none()
                }
        });
    }

    /// The host running a while with no keys file, its set settled: what the dispatcher does
    /// with the keys — nothing — and nothing at agent.env, then the loop's minute, `minutes`
    /// times; the dispatcher's environment holds its model kinds throughout.
    fn a_while_without_keys(&mut self, minutes: u32) {
        let keys = self.agent.cfg.secrets_dir.join("agent.env");
        self.until("the set settled", Duration::from_secs(300), |h| {
            h.agent.state.rollout.step == Step::Idle && h.inputs_applied()
        });
        for _ in 0..minutes {
            let probed = self.dispatcher_reads_keys();
            let there = fs::symlink_metadata(&keys).map(|m| m.file_type());
            assert!(
                probed.is_none() && there.is_err(),
                "a host with no keys file: the dispatcher's probe {probed:?} (its OMARCHY_AGENT_USER {:?}), and {} is {there:?}",
                self.dispatcher_var("OMARCHY_AGENT_USER"),
                keys.display()
            );
            assert_eq!(
                self.dispatcher_var("OMARCHY_AGENT_HELD").as_deref(),
                Some("no-keys")
            );
            self.agent.host_env.as_mut().unwrap().next_at = 0;
            self.tick(false);
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}

/// #419 on a real engine, as found on the Studio's 4K VM host (rootless podman behind docker's
/// CLI): a host installed without agent keys runs a while, then is given them by install's own
/// step (`--agent-env-from`) and, taken away again, by *Set agent keys* sealed in its owner's
/// browser. Both work — the recreated dispatcher's probe reads them as their owner as this
/// engine shows it — and `agent.env` is never a directory: while there is no keys file the
/// dispatcher's environment holds its model kinds (`OMARCHY_AGENT_HELD=no-keys`), so nothing
/// mounts it. First, what this engine makes of the probe's mount of a keys file that is not
/// there: podman's docker API makes every missing bind source an empty 0755 directory, `--mount`
/// included (`pkg/api/handlers/compat/containers_create.go`, 4.9 to 6.0), and docker refuses the
/// container. Before #419 a host without keys named `OMARCHY_AGENT_USER` all the same, so its
/// dispatcher probed, and on podman made the directory that refused the keys given later.
#[test]
#[ignore = "needs a real engine: tests/agent-host-orders.sh"]
#[allow(clippy::too_many_lines)] // one host, one story: without keys, keyed by install, then by its owner
fn real_engine_a_host_without_keys_mounts_none_and_takes_them_from_install_and_its_owner() {
    use crate::dispatcher_env::{self, Envelope, Refresh, Rendered, Sources};
    use crate::owner::tests::Authenticator;
    use crate::run::pool::Signed;
    const BY_INSTALL: &str = "sk-ant-engine-install-5d21e0";
    const BY_OWNER: &str = "sk-ant-engine-owner-8b4f17";
    let mut h = host();
    // A Linux host's agent, also where the test runs on a Mac against a podman machine: its
    // seal key in its state directory, not a keychain.
    h.agent.mac = false;
    let secrets = h.agent.cfg.secrets_dir.clone();
    let keys = secrets.join("agent.env");
    fs::set_permissions(&secrets, fs::Permissions::from_mode(0o700)).unwrap();
    // The engine as install records it (`set.engine`): rootless podman's root is this user,
    // the keys' owner, so its sidecars read them as 0:0 (#399).
    let rootless = h
        .docker(&["info", "--format", "{{json .SecurityOptions}}"])
        .contains("name=rootless");
    let podman = h
        .docker(&["version", "--format", "{{json .Server.Components}}"])
        .contains("Podman Engine");
    if rootless {
        let path = h.agent.paths.agent_toml();
        let toml = fs::read_to_string(&path)
            .unwrap()
            .replace("\n[envelope]\n", "\nengine = \"rootless\"\n[envelope]\n");
        fs::write(&path, &toml).unwrap();
        h.agent.cfg = Config::parse(&toml).unwrap();
    }
    let engine = format!(
        "{} {}",
        if rootless { "rootless" } else { "rootful" },
        if podman { "podman" } else { "docker" }
    );

    // What this engine makes of the probe's mount of a keys file that is not there.
    let scratch = h.dir.join("scratch");
    fs::create_dir(&scratch).unwrap();
    let (ran, said) = mount_keys(&h, &scratch.join("agent.env"), None);
    let made = fs::symlink_metadata(scratch.join("agent.env")).ok();
    println!(
        "{engine}: the probe's mount of a keys file that is not there {}; the container {}: {}",
        match &made {
            Some(m) if m.is_dir() => format!(
                "made an empty directory of it ({:o})",
                m.permissions().mode() & 0o777
            ),
            Some(m) => format!("made a {:?} of it", m.file_type()),
            None => "made nothing".into(),
        },
        if ran { "ran" } else { "failed" },
        said.trim()
    );
    assert!(!ran, "a keys file that is not there was read: {said}");
    if podman {
        assert!(
            made.as_ref().is_some_and(fs::Metadata::is_dir)
                && fs::read_dir(scratch.join("agent.env"))
                    .unwrap()
                    .next()
                    .is_none(),
            "podman's docker API made no empty directory of a missing bind source: {made:?}"
        );
    } else {
        assert!(
            made.is_none(),
            "docker made {made:?} of a missing bind source"
        );
    }

    // Installed with --yes and no keys: the loop's minute renders the hold, which the
    // dispatcher's environment carries from the first round on.
    h.agent.host_env = Some(crate::run::agent::HostEnv::new(Sources::system()));
    h.publish("v1.0.0", "ok");
    h.target("v1.0.0");
    h.round("v1.0.0");
    assert_eq!(
        h.agent.state.round.outcome, "ok",
        "{:?}",
        h.agent.state.round
    );
    let task0 = h.task_state();
    // It runs a while: no probe, nothing at agent.env.
    h.a_while_without_keys(5);

    // install --agent-env-from: its own keys step, then etc/dispatcher.env rendered from them
    // as its apply does next (install/mod.rs).
    let given = h.dir.join("keys.env");
    fs::write(&given, format!("ANTHROPIC_API_KEY={BY_INSTALL}\n")).unwrap();
    let values = crate::install::envelope::Values {
        pool: h.agent.cfg.pool.clone(),
        driver: h.agent.cfg.driver,
        set_dir: h.agent.cfg.set_dir.clone(),
        work_root: h.agent.cfg.work_root.clone(),
        secrets_dir: secrets.clone(),
        socket: h.socket.clone(),
        socket_mount: h.socket.clone(),
        task_subnets: "10.231.0.0/16".into(),
        rootful: !rootless,
        userns_remap: false,
        dedicated: true,
        direct_network: false,
        max_units: None,
        max_cpus: None,
        max_mem_gb: None,
        emulate: None,
        vm: None,
    };
    let mut out = Vec::new();
    crate::install::agent_keys(
        Some(&given),
        true,
        &values,
        &Sources::system().remap,
        &mut NoTty,
        &mut out,
    )
    .map_err(|e| e.to_string())
    .unwrap();
    let out = String::from_utf8(out).unwrap();
    assert!(
        out.contains(&format!("wrote {} (0600", keys.display())) && !out.contains("directory"),
        "{out}"
    );
    let rendered = Rendered::now(
        &Sources::system(),
        &h.agent.paths.data,
        Some(Envelope::of_data_dir(&h.agent.paths.data).unwrap().unwrap()),
    );
    assert_eq!(
        dispatcher_env::refresh(&dispatcher_env::path_in(&h.agent.cfg.set_dir), &rendered),
        Ok(Refresh::Written)
    );
    // The loop recreates the dispatcher with the keys' owner, whose probe reads them.
    h.keys_settled("the dispatcher recreated with the keys' owner", false);
    let user = h.dispatcher_var("OMARCHY_AGENT_USER").unwrap();
    if rootless {
        assert_eq!(user, "0:0");
    }
    let (ran, read) = h.dispatcher_reads_keys().unwrap();
    assert!(
        ran && read.contains(&format!("ANTHROPIC_API_KEY={BY_INSTALL}")),
        "{engine}: the probe as {user} did not read the keys install wrote: {read}"
    );
    let m = fs::symlink_metadata(&keys).unwrap();
    assert!(m.is_file() && m.permissions().mode() & 0o777 == 0o600);
    println!("{engine}: install's keys read by the dispatcher's probe as {user}");

    // Taken away (the owner removes the file): held again within the minute, and a while.
    fs::remove_file(&keys).unwrap();
    h.agent.host_env.as_mut().unwrap().next_at = 0;
    h.tick(false);
    h.keys_settled("the dispatcher held again", true);
    h.a_while_without_keys(3);

    // Set agent keys: a key sealed to the host's seal key in its owner's browser, signed with
    // the passkey pinned at the host.
    let host_id = h.agent.cfg.host_id.clone();
    let owner = Authenticator::new();
    let now = crate::run::now();
    crate::owner::pin(
        &h.agent.paths.data.join("state"),
        &host_id,
        &h.agent.cfg.pool,
        &owner.pin(&host_id, now),
        now,
    )
    .unwrap();
    let public = h.agent.seal_key(now).unwrap().public_b64u();
    let raw = crate::owner::webauthn::unb64(&public, "the seal key", 64).unwrap();
    let sealed = crate::owner::seal::seal(&raw, &host_id, "ANTHROPIC_API_KEY", BY_OWNER);
    let (doc, assertion) = owner.sign(
        "set-agent-keys",
        &host_id,
        1,
        now,
        &serde_json::json!({"seal_key": public, "keys": [sealed]}),
    );
    h.give(&[(
        OrderKind::SetAgentKeys(Some(Signed { doc, assertion })),
        "ho_it_keys_419",
    )]);
    let (outcome, detail) = h.answer("ho_it_keys_419").unwrap();
    assert_eq!(outcome, "done", "{detail}");
    assert!(
        !detail.contains(BY_OWNER) && !detail.contains("directory"),
        "{detail}"
    );
    h.keys_settled("the dispatcher recreated with the owner's keys", false);
    let (ran, read) = h.dispatcher_reads_keys().unwrap();
    assert!(
        ran && read.contains(&format!("ANTHROPIC_API_KEY={BY_OWNER}")),
        "{engine}: the probe did not read the keys the owner set: {read}"
    );
    let m = fs::symlink_metadata(&keys).unwrap();
    assert!(m.is_file() && m.permissions().mode() & 0o777 == 0o600);

    // Never a directory: the loop removed none, nor found one it could not remove.
    let journal = fs::read_to_string(h.agent.paths.journal()).unwrap_or_default();
    assert!(
        !journal.contains("was an empty directory")
            && !journal.contains("a directory with something in it"),
        "{journal}"
    );
    assert!(!journal.contains(BY_INSTALL) && !journal.contains(BY_OWNER));
    assert_eq!(h.task_state(), task0, "the task ran on throughout");
    println!(
        "{engine}: the owner's keys read by the dispatcher's probe; agent.env never a directory"
    );
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
    h.agent.drivers_on = Some(Box::new(move |p: &crate::run::switch::Place| {
        Some(Box::new(Compose::new(tools.clone(), &p.socket_cli, &cfgdir)) as Box<dyn Driver>)
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

// ---------------------------------------------------------------------------------------
// #330: the Quadlet driver, on a real rootless podman under this user's own systemd.

#[test]
#[ignore = "needs rootless podman under a user manager: tests/agent-quadlet.sh"]
fn real_engine_quadlet_rollouts_keep_the_task_running() {
    // The agent runs no docker, compose, podman or systemctl but the pinned CLI and the
    // system's own systemctl: decoys first in PATH would leave a mark.
    let decoys = crate::run::state::tempdir();
    for name in ["docker", "docker-compose", "podman", "systemctl"] {
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
    let mut h = host_on(true);
    let task0 = h.task_state();
    releases_with_ordered_restarts(&mut h);
    assert_eq!(h.task_state(), task0, "the task container kept running");
    let unit = h.unit.as_ref().unwrap();
    let text = fs::read_to_string(&unit.file).unwrap();
    assert!(
        text.contains("WantedBy=default.target") && !text.contains("AutoUpdate"),
        "{text}"
    );
    assert!(!text.contains(TOKEN), "the unit holds the worker token");
    assert_eq!(
        systemctl(&["is-active", &format!("{}.service", unit.name)]),
        "active"
    );
    // #327 on Quadlet: the token moved to its file, which the unit mounts read-only and
    // podman's env file no longer carries; a rotation restarts the dispatcher's unit alone.
    the_token_is_a_read_only_file_in_no_container_s_environment(&h, TOKEN);
    let rotated = a_rotation_recreates_the_dispatcher_alone(&mut h);
    assert_eq!(h.task_state(), task0, "the task container kept running");
    the_token_is_a_read_only_file_in_no_container_s_environment(&h, &rotated);
    let text = fs::read_to_string(&h.unit.as_ref().unwrap().file).unwrap();
    assert!(
        !text.contains(TOKEN) && !text.contains(&rotated),
        "the unit holds a worker token"
    );
    a_broken_release_is_reverted(&mut h);
    assert_eq!(h.task_state(), task0);
    a_statement_preempts_and_goes_down(&mut h);
    assert_eq!(
        h.task_state(),
        task0,
        "the task container survived every rollout"
    );
    nothing_but_the_pinned_tools_and_no_secret_on_disk(&h, &decoys, &rotated);
    // The unit podman's generator made runs what last-good says, under this user's systemd.
    let unit = h.unit.as_ref().unwrap();
    assert!(fs::read_to_string(&unit.file)
        .unwrap()
        .contains("Label=\"org.omarchy-pool.agent.release=v1.0.0\""));
    assert_eq!(h.dispatcher().1, "v1.0.0");
}
