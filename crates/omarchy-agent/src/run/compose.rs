//! The compose driver (design v2 §15, v1 §10.1): the pinned docker CLI and compose plugin
//! ([`Tools`]) against the runtime's Docker-compatible socket — docker rootful or rootless,
//! podman's API socket. Fixed argv, an empty environment (`env -i`) plus exactly the
//! variables the set interpolates, and validated identifiers.
//!
//! The planner reads compose's hashes and image lists only; `compose config` output with
//! the variables filled in is never asked for, so it is never written anywhere. The driver
//! never learns about tasks: everything it lists is filtered to the set's compose project.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Deserialize;

use super::driver::{Answer, Driver, Exit, Project, PullState, Unit};
use super::exec::{self, Background, Progress};
use super::tools::Tools;

/// No engine call blocks longer than this (design v2 §16.1).
pub(crate) const CALL: Duration = Duration::from_secs(60);
/// A pull is a child, polled, killed after this.
pub(crate) const PULL_LIMIT: Duration = Duration::from_secs(1800);

pub(crate) struct Compose {
    tools: Tools,
    /// `DOCKER_HOST` for both binaries.
    socket: PathBuf,
    /// An empty docker config directory: no credential helper, no context, no plugin.
    config_dir: PathBuf,
    pull: Option<Background>,
    stops: Vec<(String, Background)>,
}

impl Compose {
    pub fn new(tools: Tools, socket: &Path, config_dir: &Path) -> Self {
        Compose {
            tools,
            socket: socket.to_owned(),
            config_dir: config_dir.to_owned(),
            pull: None,
            stops: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn tools(&self) -> &Tools {
        &self.tools
    }

    /// A command for one of the pinned binaries, with nothing inherited.
    fn base(&self, program: &Path) -> Command {
        let mut c = Command::new(program);
        c.env_clear()
            .env("DOCKER_HOST", format!("unix://{}", self.socket.display()))
            .env("DOCKER_CONFIG", &self.config_dir)
            .env("HOME", &self.config_dir)
            .current_dir(&self.config_dir);
        c
    }

    fn docker(&self) -> Command {
        self.base(&self.tools.docker)
    }

    /// `docker-compose --project-name .. --env-file /dev/null --project-directory .. -f ..`
    /// with the set's interpolation variables.
    fn compose(&self, p: &Project) -> Result<Command, String> {
        if !is_project(&p.name) {
            return Err(format!("{:?} is not a compose project name", p.name));
        }
        let mut c = self.base(&self.tools.compose);
        c.envs(p.env.iter().map(|(k, v)| (k, v)));
        c.args([
            "--ansi",
            "never",
            "--project-name",
            &p.name,
            // Interpolation comes from agent.toml alone, never the set's own `.env`.
            "--env-file",
            "/dev/null",
            "--project-directory",
        ])
        .arg(&p.dir);
        for f in &p.files {
            c.arg("--file").arg(f);
        }
        Ok(c)
    }

    fn call(cmd: Result<Command, String>) -> Answer<exec::Output> {
        let cmd = match cmd {
            Ok(c) => c,
            Err(e) => return Answer::NoAnswer(e),
        };
        match exec::run(cmd, CALL) {
            Ok(o) if o.ok() => Answer::Yes(o),
            Ok(o) if not_found(&o.stderr) => Answer::NotFound,
            Ok(o) => Answer::NoAnswer(failed(&o)),
            Err(e) => Answer::NoAnswer(e),
        }
    }

    fn inspect_many(&self, ids: &[&str]) -> Answer<Vec<Unit>> {
        if let Some(bad) = ids.iter().find(|i| !is_container_id(i)) {
            return Answer::NoAnswer(format!("{bad:?} is not a container id"));
        }
        if ids.is_empty() {
            return Answer::Yes(Vec::new());
        }
        let mut c = self.docker();
        c.args(["inspect", "--type", "container", "--format", INSPECT])
            .args(ids);
        match Self::call(Ok(c)) {
            Answer::Yes(o) => o
                .stdout
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(parse_unit)
                .collect::<Result<Vec<_>, _>>()
                .map_or_else(Answer::NoAnswer, Answer::Yes),
            Answer::NotFound => Answer::NotFound,
            Answer::NoAnswer(e) => Answer::NoAnswer(e),
        }
    }
}

/// What `inspect` reads of a container: never `.Config.Env`.
const INSPECT: &str = concat!(
    r#"{"id":{{json .Id}},"status":{{json .State.Status}},"exit_code":{{json .State.ExitCode}},"#,
    r#""restarts":{{json .RestartCount}},"#,
    r#""service":{{json (index .Config.Labels "com.docker.compose.service")}},"#,
    r#""config_hash":{{json (index .Config.Labels "com.docker.compose.config-hash")}},"#,
    r#""release":{{json (index .Config.Labels "org.omarchy-pool.agent.release")}}}"#
);

#[derive(Deserialize)]
struct Inspected {
    id: String,
    status: String,
    exit_code: i64,
    restarts: u64,
    service: Option<String>,
    config_hash: Option<String>,
    release: Option<String>,
}

fn parse_unit(line: &str) -> Result<Unit, String> {
    let i: Inspected = serde_json::from_str(line).map_err(|e| format!("inspect: {e}"))?;
    Ok(Unit {
        id: i.id,
        service: i.service.unwrap_or_default(),
        status: i.status,
        restarts: i.restarts,
        exit_code: i.exit_code,
        config_hash: i.config_hash.unwrap_or_default(),
        release: i.release.unwrap_or_default(),
    })
}

fn not_found(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("no such container") || s.contains("no such object") || s.contains("no such image")
}

/// The last line `s` has that is not blank.
fn last_line(s: &str) -> Option<&str> {
    s.lines().rev().map(str::trim).find(|l| !l.is_empty())
}

/// Why a pinned binary failed, never empty: its name, its exit, and its last word, from
/// stderr or else stdout (docker puts an exec that could not start, `OCI runtime exec
/// failed: …`, on the exec's stdout).
fn failed(o: &exec::Output) -> String {
    let code = o
        .code
        .map_or_else(|| "ended by a signal".into(), |c| format!("exit {c}"));
    match last_line(&o.stderr).or_else(|| last_line(&o.stdout)) {
        Some(last) => format!("{}: {code}: {last}", o.program),
        None => format!("{}: {code}, nothing on stderr or stdout", o.program),
    }
}

fn is_container_id(s: &str) -> bool {
    (12..=64).contains(&s.len()) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A compose service name as the set may write one.
pub(crate) fn is_service(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !s.starts_with(['-', '.'])
}

fn is_project(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
}

/// An image reference as compose lists one: a repository, an optional tag, a digest.
fn is_image(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 512
        && !s.starts_with('-')
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'/' | b':' | b'@')
        })
}

fn services_ok(services: &[String]) -> Result<(), String> {
    match services.iter().find(|s| !is_service(s)) {
        Some(s) => Err(format!("{s:?} is not a service name")),
        None => Ok(()),
    }
}

/// `127.0.0.1:<port>/<path>` (set.toml's lint holds it to that).
fn is_ready_http(s: &str) -> bool {
    s.strip_prefix("127.0.0.1:").is_some_and(|r| {
        r.split_once('/').is_some_and(|(port, path)| {
            port.parse::<u16>().is_ok_and(|p| p != 0)
                && path
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._~/".contains(&b))
        })
    })
}

impl Driver for Compose {
    fn observe(&mut self, p: &Project, services: &[String]) -> Answer<Vec<Unit>> {
        if !is_project(&p.name) {
            return Answer::NoAnswer(format!("{:?} is not a compose project name", p.name));
        }
        let mut c = self.docker();
        c.args([
            "ps",
            "--all",
            "--no-trunc",
            "--format",
            "{{.ID}}",
            "--filter",
        ])
        .arg(format!("label=com.docker.compose.project={}", p.name));
        let ids = match Self::call(Ok(c)) {
            Answer::Yes(o) => o.stdout,
            Answer::NotFound => String::new(),
            Answer::NoAnswer(e) => return Answer::NoAnswer(e),
        };
        let ids: Vec<&str> = ids.split_whitespace().collect();
        match self.inspect_many(&ids) {
            Answer::Yes(units) => Answer::Yes(
                units
                    .into_iter()
                    .filter(|u| services.contains(&u.service))
                    .collect(),
            ),
            // One went away between the list and the look: ask again next tick.
            Answer::NotFound => Answer::NoAnswer("a container went away while listed".into()),
            Answer::NoAnswer(e) => Answer::NoAnswer(e),
        }
    }

    fn config_hash(&mut self, p: &Project, service: &str) -> Answer<String> {
        if !is_service(service) {
            return Answer::NoAnswer(format!("{service:?} is not a service name"));
        }
        let cmd = self.compose(p).map(|mut c| {
            c.args(["config", "--hash", service]);
            c
        });
        match Self::call(cmd) {
            Answer::Yes(o) => o
                .stdout
                .lines()
                .find_map(|l| {
                    let (s, h) = l.trim().split_once(' ')?;
                    (s == service && !h.is_empty()).then(|| h.trim().to_owned())
                })
                .map_or_else(
                    || Answer::NoAnswer(format!("compose gave no hash for {service}")),
                    Answer::Yes,
                ),
            other => other.map_none(),
        }
    }

    fn images(&mut self, p: &Project) -> Answer<Vec<String>> {
        let cmd = self.compose(p).map(|mut c| {
            c.args(["config", "--images"]);
            c
        });
        match Self::call(cmd) {
            Answer::Yes(o) => Answer::Yes(
                o.stdout
                    .lines()
                    .map(str::trim)
                    .filter(|l| is_image(l))
                    .map(str::to_owned)
                    .collect(),
            ),
            other => other.map_none(),
        }
    }

    fn start_pull(&mut self, p: &Project, services: &[String]) -> Answer<()> {
        if let Err(e) = services_ok(services) {
            return Answer::NoAnswer(e);
        }
        let mut c = match self.compose(p) {
            Ok(c) => c,
            Err(e) => return Answer::NoAnswer(e),
        };
        c.args(["pull", "--quiet"]).args(services);
        match Background::start(c, PULL_LIMIT) {
            Ok(b) => {
                self.pull = Some(b);
                Answer::Yes(())
            }
            Err(e) => Answer::NoAnswer(e),
        }
    }

    fn poll_pull(&mut self) -> Answer<PullState> {
        let Some(job) = self.pull.as_mut() else {
            return Answer::NotFound;
        };
        let state = match job.poll() {
            Progress::Running => return Answer::Yes(PullState::Running),
            Progress::Done(o) if o.ok() => PullState::Done,
            Progress::Done(o) => PullState::Failed(failed(&o)),
            Progress::TimedOut => {
                PullState::Failed(format!("no end within {} s", PULL_LIMIT.as_secs()))
            }
        };
        self.pull = None;
        Answer::Yes(state)
    }

    fn begin_drain(&mut self, u: &Unit, grace_s: u64) -> Answer<()> {
        if !is_container_id(&u.id) {
            return Answer::NoAnswer(format!("{:?} is not a container id", u.id));
        }
        self.stops
            .retain_mut(|(_, b)| b.poll() == Progress::Running);
        if self.stops.iter().any(|(id, _)| *id == u.id) {
            return Answer::Yes(());
        }
        // `docker stop` marks the container stopped by hand, so its restart policy does
        // not bring it back, sends its stop signal, and kills it after the grace. Started
        // and polled: the engine carries the wait.
        let mut c = self.docker();
        c.args(["stop", "--time", &grace_s.to_string(), &u.id]);
        match Background::start(c, Duration::from_secs(grace_s) + CALL) {
            Ok(b) => {
                self.stops.push((u.id.clone(), b));
                Answer::Yes(())
            }
            Err(e) => Answer::NoAnswer(e),
        }
    }

    fn drained(&mut self, u: &Unit) -> Answer<bool> {
        match self.inspect(&u.id) {
            Answer::Yes(now) => Answer::Yes(now.stopped()),
            Answer::NotFound => Answer::Yes(true),
            Answer::NoAnswer(e) => Answer::NoAnswer(e),
        }
    }

    fn remove(&mut self, u: &Unit, force: bool) -> Answer<()> {
        if !is_container_id(&u.id) {
            return Answer::NoAnswer(format!("{:?} is not a container id", u.id));
        }
        let mut c = self.docker();
        c.arg("rm");
        if force {
            c.arg("--force");
        }
        c.arg(&u.id);
        match Self::call(Ok(c)) {
            Answer::Yes(_) | Answer::NotFound => Answer::Yes(()),
            Answer::NoAnswer(e) => Answer::NoAnswer(e),
        }
    }

    fn create(&mut self, p: &Project, services: &[String]) -> Answer<()> {
        if let Err(e) = services_ok(services) {
            return Answer::NoAnswer(e);
        }
        let cmd = self.compose(p).map(|mut c| {
            c.args([
                "up",
                "--detach",
                "--no-deps",
                "--no-build",
                "--pull",
                "never",
            ])
            .args(services);
            c
        });
        Self::call(cmd).map_none()
    }

    fn inspect(&mut self, id: &str) -> Answer<Unit> {
        match self.inspect_many(&[id]) {
            Answer::Yes(mut u) if u.len() == 1 => Answer::Yes(u.remove(0)),
            Answer::Yes(_) | Answer::NotFound => Answer::NotFound,
            Answer::NoAnswer(e) => Answer::NoAnswer(e),
        }
    }

    fn exits_since(&mut self, id: &str, since: i64) -> Answer<Vec<Exit>> {
        if !is_container_id(id) {
            return Answer::NoAnswer(format!("{id:?} is not a container id"));
        }
        // Bounded by --until, so the engine sends what it has and closes. One second past
        // now: the engine drops events after `until` to the nanosecond, and a `die` from
        // earlier in this second must count (the guard reads its restart from inspect
        // just before), so the call waits out at most the rest of the second.
        let until = super::now() + 1;
        let mut c = self.docker();
        c.args(["events", "--since", &since.to_string(), "--until"])
            .arg(until.to_string())
            .args([
                "--filter",
                &format!("container={id}"),
                "--filter",
                "event=die",
            ])
            .args(["--format", "{{json .}}"]);
        match Self::call(Ok(c)) {
            Answer::Yes(o) => Answer::Yes(o.stdout.lines().filter_map(parse_die).collect()),
            other => other.map_none(),
        }
    }

    fn ready(&mut self, id: &str, http: &str) -> Answer<bool> {
        if !is_container_id(id) || !is_ready_http(http) {
            return Answer::NoAnswer(format!("refusing to ask {id:?} for {http:?}"));
        }
        let url = format!("http://{http}");
        // curl is in the worker image; a minimal image (a stand-in) may have only
        // busybox wget.
        for probe in [
            vec!["curl", "-fsS", "-m", "2", "-o", "/dev/null", url.as_str()],
            vec!["wget", "-q", "-T", "2", "-O", "/dev/null", url.as_str()],
        ] {
            let mut c = self.docker();
            c.args(["exec", id]).args(&probe);
            match exec::run(c, CALL) {
                Ok(o) if o.ok() => return Answer::Yes(true),
                Ok(o) if probe_missing(&o) => {}
                Ok(o) if not_found(&o.stderr) => return Answer::NotFound,
                Ok(o) if probe_said_no(&o) => return Answer::Yes(false),
                // The engine failed, not the probe (the daemon did not answer, an exec
                // did not start): change nothing.
                Ok(o) => return Answer::NoAnswer(failed(&o)),
                Err(e) => return Answer::NoAnswer(e),
            }
        }
        Answer::Yes(false)
    }

    fn remove_image(&mut self, image: &str) -> Answer<()> {
        if !is_image(image) {
            return Answer::NoAnswer(format!("{image:?} is not an image reference"));
        }
        let mut c = self.docker();
        c.args(["image", "rm", image]);
        Self::call(Ok(c)).map_none()
    }
}

/// Whether the probe is not in the image: 126/127 and "not found". Podman says so on
/// stderr; docker puts an exec that could not start on the exec's stdout
/// (`OCI runtime exec failed: … exec: "curl": executable file not found in $PATH`).
fn probe_missing(o: &exec::Output) -> bool {
    matches!(o.code, Some(126 | 127))
        && (o.stderr.contains("not found") || o.stdout.contains("not found"))
}

/// Whether a failed probe is curl's or wget's own "no" (it ran; the URL did not answer):
/// their messages start with their name, and GNU wget's `-q` says nothing. Anything else
/// on stderr is docker's or podman's, and the probes write nothing to stdout (`-o`/`-O
/// /dev/null`), so anything there is the engine's.
fn probe_said_no(o: &exec::Output) -> bool {
    !matches!(o.code, Some(125..=127) | None)
        && o.stdout.trim().is_empty()
        && last_line(&o.stderr).is_none_or(|l| l.starts_with("curl:") || l.starts_with("wget:"))
}

/// A `die` event's time and exit code (podman's compatible API names it
/// `containerExitCode`).
fn parse_die(line: &str) -> Option<Exit> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let attrs = v.pointer("/Actor/Attributes")?;
    let code = attrs
        .get("exitCode")
        .or_else(|| attrs.get("containerExitCode"))
        .and_then(|c| {
            c.as_str()
                .and_then(|s| s.parse().ok())
                .or_else(|| c.as_i64())
        })?;
    let at = v.get("time").and_then(serde_json::Value::as_i64)?;
    Some(Exit { at, code })
}

impl<T> Answer<T> {
    /// Keeps `NotFound` and `NoAnswer`, dropping a `Yes` value's type.
    pub(crate) fn map_none<U: Default>(self) -> Answer<U> {
        match self {
            Answer::Yes(_) => Answer::Yes(U::default()),
            Answer::NotFound => Answer::NotFound,
            Answer::NoAnswer(e) => Answer::NoAnswer(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::state::{tempdir, ToolPins};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    /// A driver whose "pinned" binaries are scripts that log their argv and environment.
    fn recording() -> (Compose, PathBuf) {
        let dir = tempdir();
        let log = dir.join("calls");
        let script = format!(
            "#!/bin/sh\n{{ echo \"$0 $*\"; env | sort | tr '\\n' ' '; echo; }} >> {}\nexit 0\n",
            log.display()
        );
        for name in ["docker", "docker-compose"] {
            let p = dir.join(name);
            fs::write(&p, &script).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let tools = Tools {
            docker: dir.join("docker"),
            compose: dir.join("docker-compose"),
            pins: ToolPins {
                docker: "0".repeat(64),
                compose: "1".repeat(64),
            },
        };
        let cfg = dir.join("docker-config");
        fs::create_dir_all(&cfg).unwrap();
        (
            Compose::new(tools, Path::new("/run/user/1000/docker.sock"), &cfg),
            log,
        )
    }

    #[test]
    fn runs_only_the_pinned_binaries_with_fixed_argv_and_an_empty_environment() {
        std::env::set_var("OMARCHY_LEAK_CHECK", "inherited");
        let (mut d, log) = recording();
        let p = Project {
            name: "omarchy-host".into(),
            dir: PathBuf::from("/srv/set"),
            files: vec![PathBuf::from("/data/staging/host/compose.yml")],
            env: vec![("OMARCHY_WORK_ROOT".into(), "/srv/work".into())],
        };
        assert_eq!(d.create(&p, &["dispatcher".into()]), Answer::Yes(()));
        let calls = fs::read_to_string(&log).unwrap();
        let mut lines = calls.lines();
        let argv = lines.next().unwrap();
        assert!(
            argv.starts_with(&d.tools().compose.display().to_string()),
            "{argv}"
        );
        assert!(argv.ends_with(
            "--ansi never --project-name omarchy-host --env-file /dev/null --project-directory /srv/set \
             --file /data/staging/host/compose.yml up --detach --no-deps --no-build --pull never dispatcher"
        ), "{argv}");
        let env = lines.next().unwrap();
        assert!(
            env.contains("DOCKER_HOST=unix:///run/user/1000/docker.sock"),
            "{env}"
        );
        assert!(env.contains("OMARCHY_WORK_ROOT=/srv/work"), "{env}");
        assert!(!env.contains("OMARCHY_LEAK_CHECK"), "{env}");
        assert!(!env.contains("PATH="), "{env}");

        // Identifiers that are not what they claim are never put on a command line.
        let bad = Unit {
            id: "--privileged".into(),
            service: "dispatcher".into(),
            status: "running".into(),
            restarts: 0,
            exit_code: 0,
            config_hash: String::new(),
            release: String::new(),
        };
        assert!(matches!(d.remove(&bad, true), Answer::NoAnswer(_)));
        assert!(matches!(
            d.ready(&"a".repeat(64), "evil.example:80/x"),
            Answer::NoAnswer(_)
        ));
        assert!(matches!(
            d.create(&p, &["-d; rm -rf /".into()]),
            Answer::NoAnswer(_)
        ));
        let bad_project = Project {
            name: "Bad Name".into(),
            ..p
        };
        assert!(matches!(d.images(&bad_project), Answer::NoAnswer(_)));
        assert_eq!(fs::read_to_string(&log).unwrap().lines().count(), 2);
    }

    /// A driver whose pinned docker is `body` (a shell script).
    fn docker_doing(body: &str) -> Compose {
        let (d, _) = recording();
        let p = d.tools().docker.clone();
        fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        d
    }

    #[test]
    fn exits_are_asked_up_to_a_second_past_now() {
        // The engine drops events after --until to the nanosecond: a `die` from earlier
        // in this second must be in the answer.
        let (mut d, log) = recording();
        let before = crate::run::now();
        assert_eq!(d.exits_since(&"a".repeat(64), 100), Answer::Yes(Vec::new()));
        let argv = fs::read_to_string(&log).unwrap();
        let until: i64 = argv
            .split_whitespace()
            .skip_while(|a| *a != "--until")
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        assert!(until > before, "{argv}");
    }

    #[test]
    fn a_ready_probe_that_the_engine_failed_is_no_answer() {
        let id = "a".repeat(64);
        let http = "127.0.0.1:8791/ready";
        let ready = |body: &str| docker_doing(body).ready(&id, http);
        // The probe ran and the dispatcher said no: curl's and wget's own words, or
        // GNU wget's silence.
        assert_eq!(
            ready("echo 'curl: (7) Failed to connect to 127.0.0.1 port 8791' >&2; exit 7"),
            Answer::Yes(false)
        );
        assert_eq!(ready("exit 8"), Answer::Yes(false));
        // curl missing from the image: wget answers.
        assert_eq!(
            ready(
                r#"case "$*" in *" curl "*) echo 'exec: "curl": executable file not found in $PATH' >&2; exit 126;; *) echo 'wget: server returned error: HTTP/1.1 503' >&2; exit 1;; esac"#
            ),
            Answer::Yes(false)
        );
        // curl missing from the image as docker says it: exit 127 and the reason on the
        // exec's stdout, nothing on stderr (#315's docker leg). wget answers.
        let docker_missing = |wget: &str| {
            format!(
                r#"case "$*" in *" curl "*) echo 'OCI runtime exec failed: exec failed: unable to start container process: exec: "curl": executable file not found in $PATH'; exit 127;; *) {wget};; esac"#
            )
        };
        assert_eq!(ready(&docker_missing("exit 0")), Answer::Yes(true));
        assert_eq!(
            ready(&docker_missing(
                "echo 'wget: server returned error: HTTP/1.0 503 Service Unavailable' >&2; exit 1"
            )),
            Answer::Yes(false)
        );
        // Neither probe in the image: not ready, never an engine failure.
        assert_eq!(
            ready(
                r#"echo "OCI runtime exec failed: exec failed: unable to start container process: exec: \"$3\": executable file not found in \$PATH"; exit 127"#
            ),
            Answer::Yes(false)
        );
        // The engine did not answer, or the exec did not start: change nothing.
        for body in [
            "echo 'Cannot connect to the Docker daemon at unix:///run/user/1000/docker.sock. Is the docker daemon running?' >&2; exit 1",
            "echo 'Error response from daemon: container is restarting' >&2; exit 1",
            "echo 'OCI runtime exec failed: exec failed: cannot allocate memory' >&2; exit 126",
            "echo 'OCI runtime exec failed: exec failed: cannot allocate memory'; exit 126",
            "echo 'OCI runtime exec failed: exec failed: unable to start container process'; exit 1",
        ] {
            assert!(matches!(ready(body), Answer::NoAnswer(_)), "{body}");
        }
        assert_eq!(
            ready("echo 'Error: No such container: aaa' >&2; exit 1"),
            Answer::NotFound
        );
    }

    #[test]
    fn a_failure_always_says_which_binary_and_why() {
        let o = |code, stdout: &str, stderr: &str| exec::Output {
            program: "docker".into(),
            code,
            stdout: stdout.into(),
            stderr: stderr.into(),
        };
        assert_eq!(
            failed(&o(Some(1), "", "warn\nError: no such network\n\n")),
            "docker: exit 1: Error: no such network"
        );
        // docker's exec that could not start says so on stdout.
        assert_eq!(
            failed(&o(
                Some(127),
                "OCI runtime exec failed: exec: \"curl\": executable file not found in $PATH\n",
                ""
            )),
            "docker: exit 127: OCI runtime exec failed: exec: \"curl\": executable file not found in $PATH"
        );
        assert_eq!(
            failed(&o(Some(127), "", " \n")),
            "docker: exit 127, nothing on stderr or stdout"
        );
        assert_eq!(
            failed(&o(None, "", "")),
            "docker: ended by a signal, nothing on stderr or stdout"
        );

        // A pinned binary that cannot be started is named, with the reason.
        let (mut d, _) = recording();
        let gone = d.tools().docker.clone();
        fs::remove_file(&gone).unwrap();
        let Answer::NoAnswer(e) = d.remove_image("busybox:1.37.0") else {
            panic!("a missing binary answered");
        };
        assert!(
            e.starts_with(&format!("could not start {}: ", gone.display())),
            "{e}"
        );
        // Through the real runner too: what the child said and its name.
        let (mut d, _) = recording();
        fs::write(&d.tools().docker, "#!/bin/sh\nexit 127\n").unwrap();
        assert_eq!(
            d.remove_image("busybox:1.37.0"),
            Answer::NoAnswer("docker: exit 127, nothing on stderr or stdout".into())
        );
    }

    #[test]
    fn reads_inspect_lines_and_die_events() {
        let u = parse_unit(
            r#"{"id":"abc","status":"running","exit_code":0,"restarts":2,"service":"dispatcher","config_hash":"h1","release":null}"#,
        )
        .unwrap();
        assert_eq!(
            (u.restarts, u.config_hash.as_str(), u.release.as_str()),
            (2, "h1", "")
        );
        assert_eq!(
            parse_die(
                r#"{"status":"die","id":"x","Actor":{"ID":"x","Attributes":{"exitCode":"75"}},"time":1700000000}"#
            ),
            Some(Exit {
                at: 1_700_000_000,
                code: 75
            })
        );
        assert_eq!(
            parse_die(
                r#"{"status":"die","id":"x","Actor":{"ID":"x","Attributes":{"containerExitCode":"75"}},"time":1700000001}"#
            ),
            Some(Exit {
                at: 1_700_000_001,
                code: 75
            })
        );
        assert_eq!(parse_die("not json"), None);
    }
}
