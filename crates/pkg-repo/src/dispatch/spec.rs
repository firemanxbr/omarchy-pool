//! The task container spec (design v2 §9.3, #335): the one function that
//! turns a lease into the `docker run` arguments of its container, and the
//! closed grammar every value is checked against before it reaches them.
//!
//! A task container is born with nothing: no socket, no token of any kind,
//! no agent key, not the work root, not another task's directory, not the
//! dispatcher's state, never `--privileged`, a device or host networking. It
//! mounts its own staged inputs read-only, its outputs, its log, its build
//! directory on the work root, the release's checkout read-only and a
//! pacman cache of its own; its environment is an allowlist; it is never
//! started with `--rm`, so its exit code and `OOMKilled` outlive a
//! dispatcher restart (§9.8).
//!
//! Seams left for later issues, by name: the task networks child issue adds
//! `--network omarchy-task-<id>-<gen>` (an internal network) and the egress
//! sidecar's `HTTP(S)_PROXY`/`NO_PROXY`; until then a task container is on
//! the engine's default bridge, which reaches the internet like any
//! anonymous client and holds nothing to add to it. The agent sidecars child
//! issue starts the `agent` sidecar the model kinds' environment points at,
//! and subtracts the sidecars' CPUs and memory from the task's share. P2's
//! task caches child issue mounts the read-only shared pacman cache and the
//! per-package build caches; emulated lanes (#338) add the emulated lane's
//! `WORKER_LABELS`.

use std::path::{Path, PathBuf};

use crate::stop::TASK_LABEL;

/// The lease generation label (D46): a container of an older lease of the same task is never taken for this one.
pub const GEN_LABEL: &str = "org.omarchy-pool.task.gen";
/// The host whose dispatcher started it: re-adoption lists only its own host's containers.
pub const HOST_LABEL: &str = "org.omarchy-pool.agent.host";
/// The release the lease was claimed on: its checkout is the one mounted at `/pool`.
pub const RELEASE_LABEL: &str = "org.omarchy-pool.task.release";

/// Every container a task runs is named `omarchy-task-<id>-<gen>`.
pub const NAME_PREFIX: &str = "omarchy-task-";

/// The capabilities a task container keeps after `--cap-drop ALL` (the P1
/// spike, #335): pacman installing the makedepends as root and makepkg
/// building as the `builder` user through `runuser`. Without `CHOWN`,
/// `DAC_OVERRIDE` or `FOWNER` root cannot prepare `/build` for the builder
/// (`install -o builder`, `useradd -m`); without `SETUID` or `SETGID`
/// `runuser` cannot become the builder. `KILL` lets the script's root stop
/// the builder's process group (`stop_build`), and `FSETID` keeps the set-id
/// bits of what pacman installs; the toy spike did not need those two and
/// the design expects them, so they stay until a real build proves
/// otherwise. Never `MKNOD`, `NET_RAW`, `NET_ADMIN`, `SYS_PTRACE`,
/// `AUDIT_WRITE`, `SETFCAP` or `NET_BIND_SERVICE`.
pub const CAPS: [&str; 7] = [
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "FSETID",
    "SETUID",
    "SETGID",
    "KILL",
];

/// The pid limit of every task container.
pub const PIDS_LIMIT: u32 = 8192;

/// Where the release's checkout carries the build script: the one entrypoint
/// of every kind (it reads the kind from `/task/in/meta.sh`).
pub const ENTRYPOINT: [&str; 3] = [
    "bash",
    "/pool/factory/worker/omarchy-build-worker.sh",
    "--task",
];

/// The agent sidecar's address on the task's network, for the model kinds.
pub const AGENT_URL: &str = "http://agent:8790";

/// The variables a task container may be given, and nothing else (§9.3).
/// The proxy variables come with the egress sidecar (the task networks
/// child issue); nothing sets them before it.
pub const ENV_ALLOWLIST: [&str; 9] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "MAKEFLAGS",
    "NINJAFLAGS",
    "CARGO_BUILD_JOBS",
    "FACTORY_PROVIDER",
    "ANTHROPIC_BASE_URL",
    "GITHUB_API",
];

/// A name that reaches `docker` argv — a package, a release, a host: `[a-z0-9][a-z0-9._+-]{0,63}`.
pub fn name_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|&c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'+' | b'-')
        })
}

/// A host's id as the pool names its registration: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
pub fn host_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|&c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// A lease generation, as the pool draws it: `g_` and 16 hex digits (#334).
pub fn gen_ok(s: &str) -> bool {
    s.len() == 18
        && s.starts_with("g_")
        && s[2..]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The two lanes' architectures, and their engine platform.
pub fn platform_of(arch: &str) -> Option<&'static str> {
    match arch {
        "x86_64" => Some("linux/amd64"),
        "aarch64" => Some("linux/arm64"),
        _ => None,
    }
}

/// An image by digest: `<repository>@sha256:<64 hex>`, or a local image's
/// content id `sha256:<64 hex>` (what a test builds). A tag is refused.
pub fn digest_ok(s: &str) -> bool {
    let (repo, digest) = match s.rsplit_once('@') {
        Some((r, d)) => (Some(r), d),
        None => (None, s),
    };
    let hex_ok = digest.strip_prefix("sha256:").is_some_and(|h| {
        h.len() == 64
            && h.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    });
    let repo_ok = repo.is_none_or(|r| {
        !r.is_empty()
            && r.len() <= 255
            && r.as_bytes()[0].is_ascii_alphanumeric()
            && r.bytes().all(|c| {
                c.is_ascii_lowercase()
                    || c.is_ascii_digit()
                    || matches!(c, b'.' | b'_' | b'-' | b'/' | b':')
            })
    });
    hex_ok && repo_ok
}

/// A host path a task container mounts: absolute, and nothing a `-v`
/// argument could read as a separator or an option (`:`, `,`, spaces).
pub fn path_ok(p: &Path) -> bool {
    let s = p.to_string_lossy();
    p.is_absolute()
        && !s.contains("/../")
        && !s.ends_with("/..")
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'.' | b'_' | b'-' | b'+'))
}

/// What a task container runs (design v2 §9.2): the kind decides its
/// environment, never its mounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A build that needs no model: a contributor's recipe, a bump, the project's recipe on main.
    Build,
    /// A build with a model: a draft (and its corrections) or the project's review rebuild.
    ModelBuild,
    /// The second opinion: reads the staged evidence as data, with a model.
    Audit,
    /// The trial's helper: installs from the public lab URL, no model.
    Trial,
}

impl Kind {
    pub fn model(self) -> bool {
        matches!(self, Kind::ModelBuild | Kind::Audit)
    }
}

/// One task container, as the dispatcher asks for it. Every field is checked by [`task_container`].
#[derive(Debug, Clone)]
pub struct Spec<'a> {
    pub task: u64,
    pub gen: &'a str,
    pub host: &'a str,
    pub release: &'a str,
    pub arch: &'a str,
    pub name: &'a str,
    pub kind: Kind,
    /// The CPUs and the memory of its units (the signed constants), the sidecars' not yet subtracted (the agent sidecars child issue).
    pub cpus: u32,
    pub mem_gb: u32,
    pub image: &'a str,
    /// `<work root>/tasks/<id>-<gen>`.
    pub task_dir: &'a Path,
    /// `<work root>/releases/<release>`: the release's checkout.
    pub release_dir: &'a Path,
}

/// The container's name: `omarchy-task-<id>-<gen>`.
pub fn container_name(task: u64, gen: &str) -> String {
    format!("{NAME_PREFIX}{task}-{gen}")
}

/// The lease a container's name says it runs, when it is one of ours.
pub fn lease_of_name(name: &str) -> Option<(u64, String)> {
    let rest = name.trim_start_matches('/').strip_prefix(NAME_PREFIX)?;
    let (id, gen) = rest.split_once('-')?;
    let id: u64 = id.parse().ok().filter(|&i| i > 0)?;
    gen_ok(gen).then(|| (id, gen.to_owned()))
}

/// The task directory of a lease under the work root.
pub fn task_dir(work_root: &Path, task: u64, gen: &str) -> PathBuf {
    work_root.join("tasks").join(format!("{task}-{gen}"))
}

/// The task container's `docker` arguments, after `docker` (`run -d …`):
/// the one place a task container is made (§9.3, §10.3). Every value that
/// reaches the arguments is checked against the closed grammar first; a
/// value outside it fails the task before `docker` runs.
pub fn task_container(s: &Spec<'_>) -> Result<Vec<String>, String> {
    if s.task == 0 {
        return Err("task id 0".to_owned());
    }
    if !gen_ok(s.gen) {
        return Err(format!("lease generation {:?} is not g_ and 16 hex", s.gen));
    }
    if !host_ok(s.host) {
        return Err(format!("host {:?} is outside the grammar", s.host));
    }
    if !name_ok(s.release) {
        return Err(format!("release {:?} is outside the grammar", s.release));
    }
    if !name_ok(s.name) {
        return Err(format!("package name {:?} is outside the grammar", s.name));
    }
    let platform =
        platform_of(s.arch).ok_or_else(|| format!("arch {:?} is not a lane's", s.arch))?;
    if !digest_ok(s.image) {
        return Err(format!(
            "build image {:?} is not an image by digest (repository@sha256:…)",
            s.image
        ));
    }
    if s.cpus == 0 || s.mem_gb == 0 || s.cpus > 4096 || s.mem_gb > 65_536 {
        return Err(format!(
            "share {} CPUs, {} GB is outside 1..4096 CPUs and 1..65536 GB",
            s.cpus, s.mem_gb
        ));
    }
    for p in [s.task_dir, s.release_dir] {
        if !path_ok(p) {
            return Err(format!("host path {} is outside the grammar", p.display()));
        }
    }
    let dir_name = s.task_dir.file_name().map(|n| n.to_string_lossy());
    if dir_name.as_deref() != Some(&format!("{}-{}", s.task, s.gen)) {
        return Err(format!(
            "task directory {} is not this lease's ({}-{})",
            s.task_dir.display(),
            s.task,
            s.gen
        ));
    }
    let name = container_name(s.task, s.gen);
    let mem = format!("{}g", s.mem_gb);
    let mut a: Vec<String> = vec!["run".into(), "-d".into(), "--name".into(), name];
    for (k, v) in [
        (TASK_LABEL, s.task.to_string()),
        (GEN_LABEL, s.gen.to_owned()),
        (HOST_LABEL, s.host.to_owned()),
        (RELEASE_LABEL, s.release.to_owned()),
    ] {
        a.push("--label".into());
        a.push(format!("{k}={v}"));
    }
    a.extend(
        [
            "--platform",
            platform,
            "--cpus",
            &s.cpus.to_string(),
            "--memory",
            &mem,
            "--memory-swap",
            &mem,
            "--pids-limit",
            &PIDS_LIMIT.to_string(),
            "--cap-drop",
            "ALL",
            // Its log is /task/log, capped by the script: nothing it writes to its stdout reaches the engine's disk.
            "--log-driver",
            "none",
        ]
        .map(str::to_owned),
    );
    for c in CAPS {
        a.push("--cap-add".into());
        a.push(c.into());
    }
    a.push("--security-opt".into());
    a.push("no-new-privileges".into());
    let d = |sub: &str| s.task_dir.join(sub).display().to_string();
    for mount in [
        format!("{}:/task/in:ro", d("in")),
        format!("{}:/task/out", d("out")),
        format!("{}:/task/log", d("log")),
        format!("{}:/build", d("build")),
        format!("{}:/pool:ro", s.release_dir.display()),
        format!("{}:/var/cache/pacman/pkg", d("pkgcache")),
    ] {
        a.push("-v".into());
        a.push(mount);
    }
    for (k, v) in env_of(s) {
        a.push("-e".into());
        a.push(format!("{k}={v}"));
    }
    a.push(s.image.to_owned());
    a.extend(ENTRYPOINT.map(str::to_owned));
    Ok(a)
}

/// The task's environment: its job counts (the task's CPUs, D32) and, for
/// the model kinds, where the agent sidecar answers (§9.3). Nothing of the
/// dispatcher's own environment, ever.
fn env_of(s: &Spec<'_>) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("MAKEFLAGS", format!("-j{}", s.cpus)),
        ("NINJAFLAGS", format!("-j{}", s.cpus)),
        ("CARGO_BUILD_JOBS", s.cpus.to_string()),
    ];
    if s.kind.model() {
        env.push(("FACTORY_PROVIDER", "anthropic".to_owned()));
        env.push(("ANTHROPIC_BASE_URL", AGENT_URL.to_owned()));
        env.push(("GITHUB_API", format!("{AGENT_URL}/github")));
    }
    env
}

#[cfg(test)]
mod tests {
    //! The spec's CI test (design v2 §10.3): every kind's arguments are
    //! rendered and read back against the spec — any variable, mount,
    //! network, capability or flag outside it fails, so does any value
    //! outside the grammar, and so does a container that holds the socket or
    //! a token. `check` is the reader; its own tests show it refuses each of
    //! those, so a change to `task_container` that adds one fails here.

    use super::*;

    const DIGEST: &str = "docker.io/library/archlinux@sha256:51dd3d24f7fba779e7c471caeee7804c50e8c134ad948e19685a1c83a42facc3";

    fn spec<'a>(kind: Kind, dir: &'a Path, rel: &'a Path) -> Spec<'a> {
        Spec {
            task: 812,
            gen: "g_0123456789abcdef",
            host: "h_studio-1",
            release: "v1.2.3",
            arch: "aarch64",
            name: "felix",
            kind,
            cpus: 4,
            mem_gb: 8,
            image: DIGEST,
            task_dir: dir,
            release_dir: rel,
        }
    }

    const FLAGS_WITH_VALUE: [&str; 12] = [
        "--name",
        "--label",
        "--platform",
        "--cpus",
        "--memory",
        "--memory-swap",
        "--pids-limit",
        "--cap-drop",
        "--cap-add",
        "--security-opt",
        "--log-driver",
        "-v",
    ];

    /// Reads `run -d …` back and checks it against the spec; `Err` names the first thing outside it.
    #[allow(clippy::too_many_lines)] // one reading of every flag the spec allows
    fn check(a: &[String], work: &Path) -> Result<(), String> {
        let mut it = a.iter().map(String::as_str).peekable();
        if it.next() != Some("run") || it.next() != Some("-d") {
            return Err("not `run -d`".into());
        }
        let (mut caps_dropped, mut nnp, mut name, mut logs_off) = (false, false, None, false);
        let mut caps = Vec::new();
        let mut mounts = Vec::new();
        let mut labels = Vec::new();
        let mut env = Vec::new();
        let mut rest = Vec::new();
        while let Some(f) = it.next() {
            if !f.starts_with('-') {
                rest.push(f);
                rest.extend(it.by_ref());
                break;
            }
            if f == "-e" {
                env.push(it.next().ok_or("-e without a value")?);
                continue;
            }
            if !FLAGS_WITH_VALUE.contains(&f) {
                return Err(format!("flag outside the spec: {f}"));
            }
            let v = it.next().ok_or_else(|| format!("{f} without a value"))?;
            match f {
                "--name" => name = Some(v),
                "--label" => labels.push(v),
                "--cap-drop" if v == "ALL" => caps_dropped = true,
                "--cap-drop" => return Err(format!("--cap-drop {v}")),
                "--cap-add" => caps.push(v),
                "--security-opt" if v == "no-new-privileges" => nnp = true,
                "--security-opt" => return Err(format!("security option outside the spec: {v}")),
                "-v" => mounts.push(v),
                "--platform" if v == "linux/amd64" || v == "linux/arm64" => {}
                "--platform" => return Err(format!("platform {v}")),
                "--pids-limit" if v == "8192" => {}
                "--pids-limit" => return Err(format!("pids limit {v}")),
                "--log-driver" if v == "none" => logs_off = true,
                "--log-driver" => return Err(format!("log driver {v}")),
                _ => {}
            }
        }
        if !caps_dropped || !nnp {
            return Err("--cap-drop ALL and no-new-privileges are required".into());
        }
        if !logs_off {
            return Err("--log-driver none is required: the task's log is /task/log".into());
        }
        for c in &caps {
            if !CAPS.contains(c) {
                return Err(format!("capability outside the spec: {c}"));
            }
        }
        let name = name.ok_or("no --name")?;
        let (id, gen) = lease_of_name(name).ok_or_else(|| format!("name {name}"))?;
        for want in [format!("{TASK_LABEL}={id}"), format!("{GEN_LABEL}={gen}")] {
            if !labels.contains(&want.as_str()) {
                return Err(format!("label {want} missing"));
            }
        }
        for l in &labels {
            let (k, v) = l.split_once('=').ok_or("label without =")?;
            match k {
                TASK_LABEL | GEN_LABEL => {}
                HOST_LABEL if host_ok(v) => {}
                RELEASE_LABEL if name_ok(v) => {}
                _ => return Err(format!("label outside the spec: {l}")),
            }
        }
        let tdir = task_dir(work, id, &gen);
        let mut dests = Vec::new();
        for m in &mounts {
            let parts: Vec<&str> = m.split(':').collect();
            let (from, to, ro) = match parts.as_slice() {
                [f, t] => (*f, *t, false),
                [f, t, "ro"] => (*f, *t, true),
                _ => return Err(format!("mount {m}")),
            };
            let from = Path::new(from);
            let ok = match to {
                "/task/in" => ro && from == tdir.join("in"),
                "/task/out" => !ro && from == tdir.join("out"),
                "/task/log" => !ro && from == tdir.join("log"),
                "/build" => !ro && from == tdir.join("build"),
                "/var/cache/pacman/pkg" => !ro && from == tdir.join("pkgcache"),
                "/pool" => {
                    ro && from.starts_with(work.join("releases")) && from != work.join("releases")
                }
                _ => false,
            };
            if !ok {
                return Err(format!("mount outside the spec: {m}"));
            }
            if from.to_string_lossy().contains("docker.sock")
                || from.starts_with("/var/run")
                || from.starts_with("/run")
            {
                return Err(format!("the socket: {m}"));
            }
            dests.push(to);
        }
        dests.sort_unstable();
        dests.dedup();
        if dests.len() != mounts.len() || mounts.len() != 6 {
            return Err(format!("mounts: {mounts:?}"));
        }
        for e in &env {
            let (k, v) = e.split_once('=').ok_or("env without =")?;
            if !ENV_ALLOWLIST.contains(&k) {
                return Err(format!("variable outside the allowlist: {k}"));
            }
            let lower = k.to_ascii_lowercase();
            if lower.contains("token")
                || lower.contains("key")
                || lower.contains("secret")
                || v.starts_with("om") && v.contains('_')
            {
                return Err(format!("a credential: {k}"));
            }
            match k {
                "ANTHROPIC_BASE_URL" if v != AGENT_URL => return Err(format!("{k}={v}")),
                "GITHUB_API" if v != format!("{AGENT_URL}/github") => {
                    return Err(format!("{k}={v}"))
                }
                _ => {}
            }
        }
        let image = rest.first().ok_or("no image")?;
        if !digest_ok(image) {
            return Err(format!("image not by digest: {image}"));
        }
        if rest[1..] != ENTRYPOINT {
            return Err(format!("command outside the spec: {:?}", &rest[1..]));
        }
        Ok(())
    }

    fn dirs() -> (PathBuf, PathBuf, PathBuf) {
        let work = PathBuf::from("/srv/omarchy/work");
        (
            task_dir(&work, 812, "g_0123456789abcdef"),
            work.join("releases/v1.2.3"),
            work,
        )
    }

    #[test]
    fn every_kind_renders_inside_the_spec() {
        let (t, r, work) = dirs();
        for kind in [Kind::Build, Kind::ModelBuild, Kind::Audit, Kind::Trial] {
            let a = task_container(&spec(kind, &t, &r)).unwrap();
            check(&a, &work).unwrap_or_else(|e| panic!("{kind:?}: {e}\n{a:?}"));
            let has = |s: &str| a.iter().any(|x| x == s);
            assert!(!has("--rm"), "never --rm");
            assert!(!has("--privileged") && !has("--network") && !has("--device"));
            assert!(a.iter().any(|x| x.starts_with("MAKEFLAGS=-j4")));
            assert_eq!(
                a.iter().any(|x| x.starts_with("ANTHROPIC_BASE_URL=")),
                kind.model(),
                "{kind:?}: only the model kinds talk to an agent"
            );
        }
    }

    #[test]
    fn the_share_and_the_labels_are_the_leases() {
        let (t, r, _) = dirs();
        let a = task_container(&spec(Kind::Build, &t, &r)).unwrap();
        let after = |f: &str| {
            a.iter()
                .position(|x| x == f)
                .map(|i| a[i + 1].clone())
                .unwrap()
        };
        assert_eq!(after("--name"), "omarchy-task-812-g_0123456789abcdef");
        assert_eq!(after("--cpus"), "4");
        assert_eq!(after("--memory"), "8g");
        assert_eq!(after("--memory-swap"), "8g");
        assert_eq!(after("--platform"), "linux/arm64");
        for l in [
            "com.omarchy.task=812",
            "org.omarchy-pool.task.gen=g_0123456789abcdef",
            "org.omarchy-pool.agent.host=h_studio-1",
            "org.omarchy-pool.task.release=v1.2.3",
        ] {
            assert!(a.iter().any(|x| x == l), "{l}");
        }
    }

    #[test]
    fn a_value_outside_the_grammar_fails_before_docker() {
        type Change = Box<dyn for<'b> Fn(&mut Spec<'b>)>;
        let (t, r, _) = dirs();
        let other = PathBuf::from("/srv/omarchy/work/tasks/813-g_0123456789abcdef");
        let colon = PathBuf::from("/srv/omarchy/work:/etc/tasks/812-g_0123456789abcdef");
        let relative = PathBuf::from("work/releases/v1.2.3");
        for (what, td, rd) in [
            ("another task's directory", &other, &r),
            ("a colon in a path", &colon, &r),
            ("a relative checkout", &t, &relative),
        ] {
            let mut s = spec(Kind::Build, td, rd);
            s.task_dir = td;
            assert!(task_container(&s).is_err(), "{what} must fail the task");
        }
        let cases: Vec<(&str, Change)> = vec![
            ("arch", Box::new(|s| s.arch = "riscv64")),
            (
                "arch injection",
                Box::new(|s| s.arch = "aarch64 --privileged"),
            ),
            ("gen", Box::new(|s| s.gen = "g_0123")),
            (
                "gen injection",
                Box::new(|s| s.gen = "g_0123456789abcdef --privileged"),
            ),
            ("task 0", Box::new(|s| s.task = 0)),
            ("name", Box::new(|s| s.name = "Felix")),
            ("name injection", Box::new(|s| s.name = "felix;rm -rf /")),
            (
                "name too long",
                Box::new(|s| {
                    s.name = "a234567890123456789012345678901234567890123456789012345678901234x";
                }),
            ),
            ("release", Box::new(|s| s.release = "../v1")),
            ("host", Box::new(|s| s.host = "studio=1")),
            (
                "image tag",
                Box::new(|s| s.image = "docker.io/library/archlinux:base-devel"),
            ),
            (
                "image short digest",
                Box::new(|s| s.image = "archlinux@sha256:abc"),
            ),
            ("image option", Box::new(|s| s.image = "--privileged")),
            ("cpus 0", Box::new(|s| s.cpus = 0)),
        ];
        for (what, change) in cases {
            let mut s = spec(Kind::Build, &t, &r);
            change(&mut s);
            assert!(task_container(&s).is_err(), "{what} must fail the task");
        }
    }

    #[test]
    fn the_grammars() {
        assert!(
            name_ok("felix")
                && name_ok("lib32-gcc-libs")
                && name_ok("v0.0.180")
                && name_ok("0.0.0-dev")
                && name_ok("gtk+3")
        );
        assert!(
            !name_ok("")
                && !name_ok("-x")
                && !name_ok(".x")
                && !name_ok("X")
                && !name_ok("a b")
                && !name_ok("a/b")
        );
        assert!(
            gen_ok("g_0123456789abcdef")
                && !gen_ok("g_0123456789ABCDEF")
                && !gen_ok("0123456789abcdef")
        );
        assert!(digest_ok(DIGEST) && digest_ok(&format!("sha256:{}", "a".repeat(64))));
        assert!(digest_ok("ghcr.io/firemanxbr/omarchy-worker@sha256:0000000000000000000000000000000000000000000000000000000000000000"));
        assert!(
            !digest_ok("archlinux:latest")
                && !digest_ok("x@sha512:00")
                && !digest_ok(&format!("@sha256:{}", "a".repeat(64)))
        );
        assert_eq!(
            lease_of_name("omarchy-task-812-g_0123456789abcdef"),
            Some((812, "g_0123456789abcdef".into()))
        );
        assert_eq!(
            lease_of_name("/omarchy-task-812-g_0123456789abcdef"),
            Some((812, "g_0123456789abcdef".into()))
        );
        assert_eq!(lease_of_name("omarchy-build-812"), None);
        assert_eq!(
            lease_of_name("omarchy-task-812-g_0123456789abcdef-egress"),
            None
        );
    }

    /// The reader itself: each thing the spec forbids, added to a good rendering, is refused.
    #[test]
    fn the_check_refuses_what_the_spec_forbids() {
        let (t, r, work) = dirs();
        let good = task_container(&spec(Kind::ModelBuild, &t, &r)).unwrap();
        let image_at = good.iter().position(|x| x == DIGEST).unwrap();
        let with = |extra: &[&str]| {
            let mut a = good.clone();
            for (i, x) in extra.iter().enumerate() {
                a.insert(image_at + i, (*x).to_owned());
            }
            a
        };
        let tdir = t.display().to_string();
        let forbidden: Vec<Vec<String>> = vec![
            with(&["-v", "/var/run/docker.sock:/var/run/docker.sock"]),
            with(&["-v", "/srv/omarchy/work:/work"]),
            with(&["-v", "/srv/omarchy/work/state:/state:ro"]),
            with(&[
                "-v",
                &format!("{}:/task/other", tdir.replace("812-", "813-")),
            ]),
            with(&["-e", "OMARCHY_WORKER_TOKEN=omw_x"]),
            with(&["-e", "ANTHROPIC_API_KEY=sk-ant"]),
            with(&["-e", "GITHUB_TOKEN=ghp_x"]),
            with(&["-e", "PATH=/tmp"]),
            with(&["--cap-add", "SYS_ADMIN"]),
            with(&["--cap-add", "NET_RAW"]),
            with(&["--privileged"]),
            with(&["--network", "host"]),
            with(&["--device", "/dev/kvm"]),
            with(&["--rm"]),
            with(&["--security-opt", "seccomp=unconfined"]),
            with(&["--user", "0"]),
            with(&["--label", "x=y"]),
            with(&["--log-driver", "json-file"]),
        ];
        for a in forbidden {
            assert!(check(&a, &work).is_err(), "must be refused: {a:?}");
        }
        let mut no_drop = good.clone();
        let i = no_drop.iter().position(|x| x == "--cap-drop").unwrap();
        no_drop.drain(i..i + 2);
        assert!(check(&no_drop, &work).is_err());
        let mut logged = good.clone();
        let i = logged.iter().position(|x| x == "--log-driver").unwrap();
        logged.drain(i..i + 2);
        assert!(
            check(&logged, &work).is_err(),
            "the engine's log of a task is off"
        );
        let mut tag = good.clone();
        tag[image_at] = "archlinux:base-devel".into();
        assert!(check(&tag, &work).is_err());
        let mut cmd = good.clone();
        cmd.push("--rm".into());
        assert!(check(&cmd, &work).is_err());
        let mut agent = good;
        let j = agent
            .iter()
            .position(|x| x.starts_with("ANTHROPIC_BASE_URL="))
            .unwrap();
        agent[j] = "ANTHROPIC_BASE_URL=https://api.anthropic.com".into();
        assert!(check(&agent, &work).is_err());
    }
}
