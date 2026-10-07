//! The container engine as the dispatcher uses it: make a lease's network,
//! sidecars and container from the spec's calls, read a container's state
//! (its exit code and `OOMKilled` survive a dispatcher restart, since nothing
//! is started with `--rm`), list this host's task containers and networks,
//! remove one lease's. Through the engine's CLI (`docker`, or `podman` where
//! that is what answers), each call with a deadline, and behind docker's CLI on
//! podman a task network through libpod's own API ([`libpod`], #372). A trait,
//! so the loop's tests run on a fake engine.
//!
//! A sandboxed task's `--runtime <name>` (#330) is `run`'s option on docker's
//! CLI and a global one on podman's ([`argv_of`]). Behind docker's CLI podman's
//! API does not pass it on (podman 4.9 runs its default runtime): the agent's
//! smoke run sees that kernel and names no sandbox there, so the dispatcher is
//! never told to rely on it.

use std::time::{Duration, Instant};

use serde::Deserialize;

use super::libpod;
use super::spec::{self, EGRESS_NETWORK, GEN_LABEL, HOST_LABEL};
use crate::stop::{self, TASK_LABEL};

/// A container's state, as `inspect` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct State {
    /// `running`, `exited`, `created`, `paused`, `dead`, …
    pub status: String,
    pub exit_code: i32,
    /// The engine's out-of-memory kill: the task's memory limit, whatever its script reported.
    pub oom_killed: bool,
}

impl State {
    pub fn running(&self) -> bool {
        self.status == "running"
    }
    pub fn exited(&self) -> bool {
        self.status == "exited" || self.status == "stopped"
    }
}

pub trait Engine: Send + Sync {
    /// `<engine> <args…>`, one of the spec's calls (`network create`, `create`, `network connect`,
    /// `start`, `run -d`): `Ok` when the engine did it. A `network create` with podman's
    /// `--disable-dns` is made through libpod's API where docker's CLI talks to podman (#372).
    fn run(&self, args: &[String]) -> Result<(), String>;
    /// `<engine> <args…>` for its output: (stdout, stderr), whatever its exit code; `Err` when the engine did not answer.
    fn output(&self, args: &[String]) -> Result<(String, String), String>;
    /// The container's state; `Ok(None)` when the engine has no such container, `Err` when the
    /// engine did not answer (a busy daemon is not a lost container: the loop asks again).
    fn inspect(&self, name: &str) -> Result<Option<State>, String>;
    /// The names of every container (any state) labelled with this host and a task: task containers and their sidecars.
    fn list(&self, host: &str) -> Result<Vec<String>, String>;
    /// The names of every network labelled with this host: task networks.
    fn networks(&self, host: &str) -> Result<Vec<String>, String>;
    /// Kills and removes one lease's containers (by its task and generation labels) — its task
    /// container and its sidecars — then its network.
    fn remove_lease(&self, task: u64, gen: &str);
    /// Removes one network by its name: one re-adoption found with no lease file to say what it is.
    fn remove_network(&self, name: &str);
    /// Kills and removes one container by its name: one re-adoption found with no lease file to say what it is.
    fn remove_name(&self, name: &str);
}

/// The shared `omarchy-egress` bridge, made once (labelled with this host): every egress sidecar is attached to it.
pub fn ensure_bridge(engine: &dyn Engine, host: &str) -> Result<(), String> {
    let inspect = ["network", "inspect", EGRESS_NETWORK].map(str::to_owned);
    if engine.run(&inspect).is_ok() {
        return Ok(());
    }
    let create = [
        "network".to_owned(),
        "create".to_owned(),
        "--label".to_owned(),
        format!("{HOST_LABEL}={host}"),
        EGRESS_NETWORK.to_owned(),
    ];
    // Made meanwhile by another call of this dispatcher: there it is.
    engine
        .run(&create)
        .or_else(|e| engine.run(&inspect).map_err(|_| e))
}

/// The engine's CLI.
pub struct Cli {
    pub runtime: String,
    /// libpod's API on the socket docker's CLI talks to, when podman answers there: the task
    /// networks docker's CLI cannot make on it (#372). Set by [`Cli::gateway`].
    pub libpod: Option<libpod::Libpod>,
}

/// How long one engine call may take: a `run` pulls nothing (the image is pinned and
/// present, or it is pulled within this), the others answer in seconds.
const CALL: Duration = Duration::from_secs(300);

impl Cli {
    /// `docker` when it answers, `podman` otherwise (the worker image carries docker's CLI
    /// for whatever socket is mounted; a podman host's tests run podman's).
    pub fn find() -> Option<Self> {
        let answers = |r: &str| {
            std::process::Command::new(r)
                .arg("--version")
                .output()
                .is_ok_and(|o| o.status.success())
        };
        ["docker", "podman"]
            .into_iter()
            .find(|r| answers(r))
            .map(|r| Self {
                runtime: r.to_owned(),
                libpod: None,
            })
    }

    /// How this engine keeps a task network's gateway off the host ([`spec::Gateway`]): podman by a
    /// network without DNS — its own CLI's `--disable-dns`, or behind docker's CLI (whose API forces
    /// DNS on and drops docker's option) libpod's own API on the socket that CLI talks to, which
    /// must answer as podman ([`libpod::Libpod::on`]); docker by its isolated gateway mode, from
    /// Docker 28 (an older daemon is refused, in its own words: it would make the network with the
    /// host's address on it).
    pub fn gateway(&mut self) -> Result<spec::Gateway, String> {
        // By its name, or its path's (a pool job's shim runs the engine by its absolute path, #340).
        if std::path::Path::new(&self.runtime)
            .file_name()
            .is_some_and(|n| n == "podman")
        {
            return Ok(spec::Gateway::NoDns);
        }
        let out = self.call(&["version", "--format", "{{json .Server}}"])?;
        if !out.status.success() {
            return Err(format!(
                "{} version: {}",
                self.runtime,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let gateway = gateway_of(&String::from_utf8_lossy(&out.stdout))?;
        if gateway == spec::Gateway::NoDns {
            // The endpoint docker's CLI uses, DOCKER_HOST's or its context's: libpod is asked there.
            let out = self.call(&[
                "context",
                "inspect",
                "--format",
                "{{.Endpoints.docker.Host}}",
            ])?;
            if !out.status.success() {
                return Err(format!(
                    "{} context inspect: {}",
                    self.runtime,
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            let socket = libpod::socket_of(&String::from_utf8_lossy(&out.stdout))
                .map_err(|e| format!("podman behind docker's CLI: {e}"))?;
            self.libpod = Some(libpod::Libpod::on(&socket, CALL).map_err(|e| {
                format!("podman behind docker's CLI, whose task networks are made through libpod's API: {e}")
            })?);
        }
        Ok(gateway)
    }

    /// SIGKILL, then removed: podman's `rm -f` stops with SIGTERM and waits ten seconds first, and a
    /// sidecar's process, pid 1 without a handler, ignores SIGTERM.
    fn kill_rm(&self, name: &str) {
        let _ = self.call(&["kill", name]);
        let _ = self.call(&["rm", "-f", name]);
    }

    fn call(&self, args: &[&str]) -> Result<std::process::Output, String> {
        stop::real_engine(&self.runtime, args, Instant::now() + CALL).ok_or_else(|| {
            format!(
                "{} {} did not answer",
                self.runtime,
                args.first().unwrap_or(&"")
            )
        })
    }
}

#[derive(Deserialize)]
struct RawState {
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "ExitCode", default)]
    exit_code: i32,
    #[serde(rename = "OOMKilled", default)]
    oom_killed: bool,
}

/// `version --format '{{json .Server}}'` of docker's CLI, read: whose engine answers, and which
/// Docker. podman, which names itself among the components, makes its task networks without DNS.
pub fn gateway_of(json: &str) -> Result<spec::Gateway, String> {
    #[derive(Deserialize)]
    struct Component {
        #[serde(rename = "Name", default)]
        name: String,
    }
    #[derive(Deserialize)]
    struct Server {
        #[serde(rename = "Version", default)]
        version: String,
        #[serde(rename = "Components", default)]
        components: Vec<Component>,
    }
    let s: Server = serde_json::from_str(json.trim())
        .map_err(|_| format!("the engine's version does not read: {:?}", json.trim()))?;
    if s.components.iter().any(|c| c.name.contains("Podman")) {
        return Ok(spec::Gateway::NoDns);
    }
    let major = s
        .version
        .split('.')
        .next()
        .and_then(|m| m.parse::<u32>().ok());
    match major {
        Some(m) if m >= 28 => Ok(spec::Gateway::Isolated),
        _ => Err(format!(
            "docker {:?} cannot keep a task network's gateway off the host (com.docker.network.bridge.gateway_mode_ipv4=isolated needs Docker 28 or newer); upgrade the engine",
            s.version
        )),
    }
}

/// The spec's call as this CLI takes it: podman's takes `--runtime <name>` before the verb
/// (`podman --runtime runsc run -d …`), docker's after it, where the spec puts it (#330).
pub fn argv_of(cli: &str, args: &[String]) -> Vec<String> {
    let at = args.iter().position(|a| a == "--runtime").filter(|&i| {
        cli == "podman" && i + 1 < args.len() && matches!(args[0].as_str(), "run" | "create")
    });
    let Some(i) = at else {
        return args.to_vec();
    };
    let mut out = args[i..i + 2].to_vec();
    out.extend_from_slice(&args[..i]);
    out.extend_from_slice(&args[i + 2..]);
    out
}

/// Whether `inspect`'s error says the container does not exist — docker: "No such container: …"
/// (or "No such object"), podman: "no such container" — and not that the engine did not answer
/// ("dial unix …: connect: no such file or directory" is a socket that is not there).
fn missing(stderr: &str) -> bool {
    let e = stderr.to_ascii_lowercase();
    e.contains("no such container") || e.contains("no such object")
}

/// `inspect --format '{{json .State}}'`, read.
pub fn parse_state(json: &str) -> Option<State> {
    let raw: RawState = serde_json::from_str(json.trim()).ok()?;
    Some(State {
        status: raw.status.to_ascii_lowercase(),
        exit_code: raw.exit_code,
        oom_killed: raw.oom_killed,
    })
}

impl Engine for Cli {
    fn run(&self, args: &[String]) -> Result<(), String> {
        if let Some(l) = self.libpod.as_ref().filter(|_| libpod::wants(args)) {
            return l.create_network(args);
        }
        let args = argv_of(&self.runtime, args);
        let a: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = self.call(&a)?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{} run: {}",
                self.runtime,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    fn output(&self, args: &[String]) -> Result<(String, String), String> {
        let a: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = self.call(&a)?;
        Ok((
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ))
    }

    fn inspect(&self, name: &str) -> Result<Option<State>, String> {
        let out = self.call(&[
            "inspect",
            "--type",
            "container",
            "--format",
            "{{json .State}}",
            name,
        ])?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            if missing(&err) {
                return Ok(None);
            }
            return Err(format!("{} inspect: {}", self.runtime, err.trim()));
        }
        parse_state(&String::from_utf8_lossy(&out.stdout))
            .map(Some)
            .ok_or_else(|| format!("{} inspect: an answer that does not read", self.runtime))
    }

    fn list(&self, host: &str) -> Result<Vec<String>, String> {
        let host_filter = format!("label={HOST_LABEL}={host}");
        let task_filter = format!("label={TASK_LABEL}");
        let out = self.call(&[
            "ps",
            "-a",
            "--filter",
            &host_filter,
            "--filter",
            &task_filter,
            "--format",
            "{{.Names}}",
        ])?;
        if !out.status.success() {
            return Err(format!(
                "{} ps: {}",
                self.runtime,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect())
    }

    fn networks(&self, host: &str) -> Result<Vec<String>, String> {
        let host_filter = format!("label={HOST_LABEL}={host}");
        let out = self.call(&[
            "network",
            "ls",
            "--filter",
            &host_filter,
            "--format",
            "{{.Name}}",
        ])?;
        if !out.status.success() {
            return Err(format!(
                "{} network ls: {}",
                self.runtime,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect())
    }

    fn remove_name(&self, name: &str) {
        self.kill_rm(name);
    }

    fn remove_network(&self, name: &str) {
        let _ = self.call(&["network", "rm", name]);
    }

    fn remove_lease(&self, task: u64, gen: &str) {
        let t = format!("label={TASK_LABEL}={task}");
        let g = format!("label={GEN_LABEL}={gen}");
        let Ok(out) = self.call(&["ps", "-aq", "--filter", &t, "--filter", &g]) else {
            return;
        };
        for id in String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric()))
        {
            self.kill_rm(id);
        }
        // Its network once nothing is attached to it (`rm -f` returns once the container is gone).
        let _ = self.call(&["network", "rm", &spec::container_name(task, gen)]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_docker_and_podman_print() {
        let docker = r#"{"Status":"exited","Running":false,"Paused":false,"Restarting":false,"OOMKilled":true,"Dead":false,"Pid":0,"ExitCode":137,"Error":"","StartedAt":"2026-10-01T10:00:00Z","FinishedAt":"2026-10-01T10:05:00Z"}"#;
        assert_eq!(
            parse_state(docker),
            Some(State {
                status: "exited".into(),
                exit_code: 137,
                oom_killed: true
            })
        );
        let podman = r#"{"OciVersion":"1.2.0","Status":"running","Running":true,"Paused":false,"Restarting":false,"OOMKilled":false,"Dead":false,"Pid":42,"ExitCode":0}"#;
        let s = parse_state(podman).unwrap();
        assert!(s.running() && !s.oom_killed);
        assert_eq!(parse_state("no such container"), None);
    }

    #[test]
    fn the_gateway_mode_by_the_engine_that_answers() {
        let docker = r#"{"Platform":{"Name":"Docker Engine - Community"},"Components":[{"Name":"Engine","Version":"28.5.1"},{"Name":"containerd","Version":"v2.1.4"}],"Version":"28.5.1","ApiVersion":"1.51"}"#;
        assert_eq!(gateway_of(docker), Ok(spec::Gateway::Isolated));
        let old = r#"{"Components":[{"Name":"Engine","Version":"27.5.1"}],"Version":"27.5.1"}"#;
        assert!(gateway_of(old).unwrap_err().contains("Docker 28"));
        let podman = r#"{"Platform":{"Name":"linux/amd64/fedora-42"},"Components":[{"Name":"Podman Engine","Version":"5.6.1"},{"Name":"Conmon","Version":"2.1.13"}],"Version":"5.6.1","ApiVersion":"1.41"}"#;
        assert_eq!(gateway_of(podman), Ok(spec::Gateway::NoDns));
        assert!(gateway_of("null").is_err() && gateway_of("").is_err());
    }

    /// Removes a network when dropped, however the test ends.
    struct Gone<'a>(&'a Cli, &'a str);

    impl Drop for Gone<'_> {
        fn drop(&mut self) {
            self.0.remove_network(self.1);
        }
    }

    fn stdout(cli: &Cli, args: &[&str]) -> String {
        let out = cli.call(args).unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// The network as the engine keeps it: internal, and with no gateway — through libpod, DNS off
    /// and none in its subnet; on Docker, its isolated gateway mode.
    fn assert_no_gateway(cli: &Cli, gateway: spec::Gateway, net: &str, host: &str) {
        if let Some(l) = &cli.libpod {
            assert_eq!(gateway, spec::Gateway::NoDns);
            let path = format!("/v{}/libpod/networks/{net}/json", l.version);
            let a = libpod::request(&l.socket, "GET", &path, None, Instant::now() + CALL).unwrap();
            let n: serde_json::Value = serde_json::from_slice(&a.body).unwrap();
            println!(
                "podman {} behind docker's CLI, through libpod: {n}",
                l.version
            );
            assert_eq!(n["internal"], true, "{n}");
            assert_eq!(n["dns_enabled"], false, "{n}");
            assert!(n["subnets"][0]["gateway"].is_null(), "{n}");
            assert_eq!(n["labels"][HOST_LABEL], host, "{n}");
            return;
        }
        let out = stdout(cli, &["network", "inspect", "--format", "{{json .}}", net]);
        let n: serde_json::Value = serde_json::from_str(&out).unwrap();
        println!("{}: {n}", cli.runtime);
        let internal = n["Internal"].as_bool().or(n["internal"].as_bool());
        assert_eq!(internal, Some(true), "{n}");
        if gateway == spec::Gateway::Isolated {
            let mode = &n["Options"]["com.docker.network.bridge.gateway_mode_ipv4"];
            assert_eq!(mode, "isolated", "{n}");
        }
    }

    /// A task network as this dispatcher makes it, on a real engine (tests/agent-install.sh runs it
    /// beside the install's probe, with `DOCKER_HOST` on that engine's socket and
    /// `OMARCHY_STANDIN_IMAGE`): by docker's CLI, which on podman makes it through libpod's API
    /// (#372). It is internal with no gateway, and a task on it reaches nothing at its `.1` on 22, 53
    /// or the pool's ports: nothing answers there, nor refuses (busybox's `nc -z` prints nothing for
    /// a refusal and returns at once, while an address no neighbour holds takes about 3 s).
    #[test]
    #[ignore = "needs a real engine: tests/agent-install.sh"]
    fn real_engine_a_task_network_made_here_has_no_gateway() {
        let image = std::env::var("OMARCHY_STANDIN_IMAGE")
            .expect("OMARCHY_STANDIN_IMAGE (tests/agent-install.sh sets it)");
        let mut cli = Cli {
            runtime: std::env::var("OMARCHY_DISPATCH_CLI").unwrap_or_else(|_| "docker".into()),
            libpod: None,
        };
        let gateway = cli.gateway().unwrap();
        let pid = std::process::id();
        let (gen, host) = (format!("g_{pid:016x}"), format!("h_libpod-test-{pid}"));
        let (setup, _) = spec::probe_plan(&spec::Probe {
            gen: &gen,
            host: &host,
            worker_image: "docker.io/library/busybox@sha256:1111111111111111111111111111111111111111111111111111111111111111",
            subnets: spec::Subnets::parse("10.197.10.0/24").unwrap(),
            slot: 15,
            gateway,
            deny: &[],
            env_file: std::path::Path::new("/nonexistent/agent.env"),
            user: None,
        })
        .unwrap();
        let net = spec::container_name(0, &gen);
        cli.remove_network(&net);
        cli.run(&setup[0]).unwrap();
        let _gone = Gone(&cli, &net);
        assert_no_gateway(&cli, gateway, &net, &host);
        // All at once, as install's probe does: a port tried after the first found no neighbour
        // at .1 would fail at once, as a refusal does.
        let script = "for p in 22 53 3128 8790 8791; do (s=$(date +%s); if nc -z -w 3 10.197.10.241 $p; then echo \"$p open\"; elif [ $(( $(date +%s) - s )) -lt 2 ]; then echo \"$p refused\"; else echo \"$p blocked\"; fi) & done; wait";
        let label = format!("{HOST_LABEL}={host}");
        let out = stdout(
            &cli,
            &[
                "run",
                "--rm",
                "--label",
                &label,
                "--network",
                &net,
                "--ip",
                "10.197.10.254",
                &image,
                "sh",
                "-c",
                script,
            ],
        );
        println!("a task on it:\n{out}");
        assert_eq!(
            out.lines().filter(|l| l.ends_with(" blocked")).count(),
            5,
            "{out}"
        );
    }

    /// #399, on a real engine (tests/agent-install.sh runs it beside the test above, on rootful
    /// docker and rootless podman): the probe's one-shot agent, started as the dispatcher starts
    /// it — every capability dropped, no new privileges, the keys a read-only file mount — reads
    /// an owner-only (0600) keys file of a non-root user's as that owner as the engine shows it
    /// to a container, which is what the agent writes into `OMARCHY_AGENT_USER`: `--user 0:0` on a
    /// rootless engine (whose root is the runner, the file's owner), the file's own `uid:gid` on a
    /// rootful one (as root here, the file is made another uid's first). On a rootful engine the
    /// image's root, with no capability, cannot read it — the bug the Studio's canary found. The
    /// image is the stand-in's (busybox), which `cat`s the file where the worker image's
    /// `agent --probe` would read it.
    #[test]
    #[ignore = "needs a real engine: tests/agent-install.sh"]
    fn real_engine_the_probe_reads_owner_only_keys_as_their_owner() {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        let image = std::env::var("OMARCHY_STANDIN_IMAGE")
            .expect("OMARCHY_STANDIN_IMAGE (tests/agent-install.sh sets it)");
        let mut cli = Cli {
            runtime: std::env::var("OMARCHY_DISPATCH_CLI").unwrap_or_else(|_| "docker".into()),
            libpod: None,
        };
        let gateway = cli.gateway().unwrap();
        let security = stdout(&cli, &["info", "--format", "{{json .SecurityOptions}}"]);
        if security.contains("name=userns") {
            println!("a remapped daemon: its agent holds the host's model kinds (#399), nothing reads the keys");
            return;
        }
        let rootless = security.contains("name=rootless");
        // The keys as install writes them: 0600, a non-root user's.
        let dir = tempfile::tempdir().unwrap();
        let keys = dir.path().join("agent.env");
        std::fs::write(&keys, "ANTHROPIC_API_KEY=sk-ant-not-a-real-key\n").unwrap();
        std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o600)).unwrap();
        if !rootless && std::fs::metadata(&keys).unwrap().uid() == 0 {
            std::os::unix::fs::chown(&keys, Some(4242), Some(4242)).unwrap();
        }
        let m = std::fs::metadata(&keys).unwrap();
        assert_ne!(m.uid(), 0, "the keys file must be a non-root user's");
        let user = if rootless {
            spec::AgentUser { uid: 0, gid: 0 }
        } else {
            spec::AgentUser {
                uid: m.uid(),
                gid: m.gid(),
            }
        };
        // A generation of its own: the test above runs beside it, under the same pid.
        let pid = u64::from(std::process::id());
        let (gen, host) = (
            format!("g_{:016x}", pid | 1 << 60),
            format!("h_keys-test-{pid}"),
        );
        let probe = |user| {
            spec::probe_plan(&spec::Probe {
                gen: &gen,
                host: &host,
                worker_image: "docker.io/library/busybox@sha256:1111111111111111111111111111111111111111111111111111111111111111",
                subnets: spec::Subnets::parse("10.197.11.0/24").unwrap(),
                slot: 15,
                gateway,
                deny: &[],
                env_file: &keys,
                user,
            })
            .unwrap()
        };
        let (setup, run) = probe(Some(user));
        let net = spec::container_name(0, &gen);
        cli.remove_network(&net);
        cli.run(&setup[0]).unwrap();
        let _gone = Gone(&cli, &net);
        // The probe's own argv up to its image, then the stand-in reading the keys.
        let read = |run: &[String]| {
            let (args, tail) = run.split_at(run.len() - 2);
            assert_eq!(tail[1], "--probe");
            let mut a: Vec<&str> = args.iter().map(String::as_str).collect();
            a.extend([image.as_str(), "cat", spec::AGENT_ENV_IN]);
            cli.call(&a).unwrap()
        };
        for (k, v) in [
            ("--cap-drop", "ALL"),
            ("--security-opt", "no-new-privileges"),
        ] {
            assert!(run.windows(2).any(|w| w[0] == k && w[1] == v), "{run:?}");
        }
        assert!(
            !run.iter()
                .any(|x| x == "--cap-add" || x.starts_with("--userns")),
            "{run:?}"
        );
        let out = read(&run);
        let said = String::from_utf8_lossy(&out.stdout);
        println!(
            "{}: the probe as {}:{} read agent.env ({}:{}, 0600): {}",
            if rootless { "rootless" } else { "rootful" },
            user.uid,
            user.gid,
            m.uid(),
            m.gid(),
            out.status
        );
        assert!(
            out.status.success() && said.contains("ANTHROPIC_API_KEY="),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        // Before #399, on a rootful engine: the image's root, with no capability, cannot.
        if !rootless {
            let (_, before) = probe(None);
            let out = read(&before);
            assert!(
                !out.status.success() && out.stdout.is_empty(),
                "root with no capability read another user's 0600 keys: {}",
                String::from_utf8_lossy(&out.stdout)
            );
        }
    }

    #[test]
    fn podmans_cli_takes_the_sandboxs_runtime_before_the_verb() {
        let call: Vec<String> = [
            "run",
            "-d",
            "--name",
            "t",
            "--runtime",
            "runsc",
            "--platform",
            "linux/arm64",
            "img",
            "bash",
        ]
        .map(str::to_owned)
        .to_vec();
        assert_eq!(argv_of("docker", &call), call);
        assert_eq!(
            argv_of("podman", &call),
            [
                "--runtime",
                "runsc",
                "run",
                "-d",
                "--name",
                "t",
                "--platform",
                "linux/arm64",
                "img",
                "bash"
            ]
        );
        // Nothing else moves: a call without it, another verb, a flag without its value.
        let plain: Vec<String> = ["run", "-d", "img"].map(str::to_owned).to_vec();
        assert_eq!(argv_of("podman", &plain), plain);
        let net: Vec<String> = ["network", "create", "--runtime", "x"]
            .map(str::to_owned)
            .to_vec();
        assert_eq!(argv_of("podman", &net), net);
        let dangling: Vec<String> = ["run", "--runtime"].map(str::to_owned).to_vec();
        assert_eq!(argv_of("podman", &dangling), dangling);
    }

    #[test]
    fn a_missing_container_is_not_an_engine_that_does_not_answer() {
        assert!(missing(
            "Error: No such container: omarchy-task-7-g_0123456789abcdef"
        ));
        assert!(missing("Error response from daemon: No such object: x"));
        assert!(missing("Error: no such container \"x\""));
        assert!(!missing(
            "Error: dial unix /run/podman/podman.sock: connect: no such file or directory"
        ));
        assert!(!missing("failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory"));
    }
}
