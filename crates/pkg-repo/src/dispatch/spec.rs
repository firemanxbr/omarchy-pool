//! The task container spec (design v2 §9.3, §9.4, §9.5; #335, #336): the
//! one function that turns a lease into the engine calls that make its
//! network, its sidecars and its container, and the closed grammar every
//! value is checked against before it reaches them.
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
//! **Its network** (#336, D38, D49) is its own: an `--internal` network
//! `omarchy-task-<id>-<gen>` on a /28 of `OMARCHY_TASK_SUBNETS`, which no
//! other task, the host, its LAN, the dispatcher or the pool is on, with no
//! address of the host as its gateway ([`Gateway`]). Its one
//! way out is its **egress sidecar** (`<network>-egress`, the worker image's
//! `egress` role: `pkg-repo egress`), which listens on its own address of
//! that network and is also attached to the shared `omarchy-egress` bridge,
//! where it listens on nothing; the task's `HTTP(S)_PROXY` name it. A
//! package with a signed exception in `factory/sizing` gets a normal bridge
//! network of its own instead, and no egress sidecar, on a host whose
//! envelope grants it (`OMARCHY_DIRECT_NETWORK`, #373; elsewhere the lease
//! goes back before this spec is made).
//!
//! **A model kind's agent** (D48) is its own too: an **agent sidecar**
//! (`<network>-agent`, the worker image's `agent` role, the broker without
//! a worker token) on the task's network only, reaching the model and GitHub
//! through the same egress sidecar, with `OMARCHY_SECRETS_DIR/agent.env`
//! mounted read-only and its per-task caps (calls, tokens, wall time) in its
//! environment. Its usage is written to `<task dir>/agent`, which the task
//! container does not mount. Both sidecars are labelled with the lease and
//! removed with it; their CPUs and memory (0.1 CPU / 64 MB, 0.25 CPU /
//! 256 MB) come out of the task container's share.
//!
//! **Its lane** (#338, design v2 §7.4, §7.5): `--platform linux/<arch>` is
//! the lane's architecture, and a container on an emulated lane — and only
//! there — carries `WORKER_LABELS={"emulated":true}`, which makes the build
//! script probe the toolchains a recipe installs and fail at once with
//! `needs_native` when one cannot start (a 16K-page host's qemu, D33).
//!
//! **A pool job's helper** (#340, design v2 §9.2, §10.3; D34) is made here
//! too: the scripts a pool job runs (`tests/health-check.sh`, the ABI gate's
//! references) start their check containers through the `omarchy-task-run`
//! shim ([`super::shim`]), which reads the one shape they use and asks
//! [`helper_plan`] for the rest — the job's own internal network and egress
//! sidecar, the job's share less the sidecar's, the task container's
//! capabilities and flags, one of the job's scratch directories at `/repo`
//! and nothing else: no token, no socket, no other mount.
//!
//! Seams left for later issues, by name: P2's task caches child issue
//! mounts the read-only shared pacman cache and the per-package build
//! caches.

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

/// The shared, non-internal bridge every egress sidecar is attached to (and listens on nothing of).
pub const EGRESS_NETWORK: &str = "omarchy-egress";
/// What a sidecar is, on its label: `egress`, `agent`, or `probe` (the probe sidecar's one-shot agent).
pub const ROLE_LABEL: &str = "org.omarchy-pool.task.role";
/// Where the egress sidecar listens on its task's network, and the agent sidecar answers.
pub const EGRESS_PORT: u16 = 3128;
pub const AGENT_PORT: u16 = 8790;
/// What a model kind's task container sends as its "key": the agent sidecar holds the real one.
pub const AGENT_KEY_PLACEHOLDER: &str = "via-agent-sidecar";
/// Where the agent sidecar finds the keys file and writes its usage.
pub const AGENT_ENV_IN: &str = "/run/omarchy/agent.env";
pub const USAGE_DIR_IN: &str = "/run/omarchy/usage";
/// The sidecars' shares, in thousandths of a CPU and in MB, out of their task's units (design v2 §7.3).
pub const EGRESS_MILLICPUS: u32 = 100;
pub const EGRESS_MEM_MB: u32 = 64;
pub const AGENT_MILLICPUS: u32 = 250;
pub const AGENT_MEM_MB: u32 = 256;

/// The variables a task container may be given, and nothing else (§9.3).
/// Both spellings of the proxy variables: curl, pacman and git read only
/// the lowercase `http_proxy`, others the uppercase ones. `WORKER_LABELS`
/// is `{"emulated":true}` on an emulated lane, and absent elsewhere.
pub const ENV_ALLOWLIST: [&str; 14] = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "MAKEFLAGS",
    "NINJAFLAGS",
    "CARGO_BUILD_JOBS",
    "FACTORY_PROVIDER",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "GITHUB_API",
    "WORKER_LABELS",
];

/// What a container on an emulated lane is told, as the build script reads it
/// (`emulated_worker`) and as `pkg-repo work`'s emulated workers have always said it.
pub const EMULATED_LABELS: &str = r#"{"emulated":true}"#;

/// A pool job's helper container (#340): `omarchy-task-<id>-<gen>-helper`, on its job's network.
pub const HELPER_SUFFIX: &str = "-helper";
/// The one variable a helper is given besides its proxy: the base image's keyring its check
/// populates (`tests/health-check.sh`, `tests/trial.sh`), one of the two base images'.
pub const HELPER_ENV: &str = "KEYRING";
pub const HELPER_KEYRINGS: [&str; 2] = ["archlinux", "archlinuxarm"];

/// A script a pool job's helper runs from its scratch directory: `[a-z0-9][a-z0-9-]{0,31}.sh`.
pub fn script_ok(s: &str) -> bool {
    s.strip_suffix(".sh").is_some_and(|n| {
        let b = n.as_bytes();
        !b.is_empty()
            && b.len() <= 32
            && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
            && b.iter()
                .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    })
}

/// A scratch directory a pool job's script made (`mktemp -d`: `tmp.XXXXXXXXXX`): letters, digits, `.`, `_`, `-`.
pub fn scratch_name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('.')
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

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
/// environment and its sidecars, never its mounts.
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

/// `OMARCHY_TASK_SUBNETS`: the IPv4 range task networks are cut from, one /28 each (design v2 §9.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Subnets {
    base: u32,
    prefix: u8,
}

/// The /28 of one task network: `.1` the engine's gateway, `.2` the egress sidecar, `.3` the agent sidecar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot(u32);

impl Subnets {
    /// One IPv4 range, `a.b.c.d/p` with `p` in 8..=28 and its host bits zero.
    pub fn parse(s: &str) -> Result<Self, String> {
        let (a, p) = s
            .trim()
            .split_once('/')
            .ok_or_else(|| format!("task subnets {s:?}: not a.b.c.d/prefix"))?;
        let addr: std::net::Ipv4Addr = a
            .parse()
            .map_err(|_| format!("task subnets {s:?}: not an IPv4 range"))?;
        let prefix: u8 = p
            .parse()
            .ok()
            .filter(|p| (8..=28).contains(p))
            .ok_or_else(|| format!("task subnets {s:?}: the prefix must be 8..28"))?;
        let base = u32::from(addr);
        if base & !(u32::MAX << (32 - u32::from(prefix))) != 0 {
            return Err(format!("task subnets {s:?}: host bits are set"));
        }
        Ok(Self { base, prefix })
    }

    /// How many task networks the range holds.
    pub fn slots(&self) -> u32 {
        1 << (28 - u32::from(self.prefix))
    }

    pub fn slot(&self, i: u32) -> Option<Slot> {
        (i < self.slots()).then(|| Slot(self.base + 16 * i))
    }

    pub fn cidr(&self) -> String {
        format!("{}/{}", std::net::Ipv4Addr::from(self.base), self.prefix)
    }
}

impl Slot {
    pub fn cidr(self) -> String {
        format!("{}/28", std::net::Ipv4Addr::from(self.0))
    }
    pub fn egress_ip(self) -> String {
        std::net::Ipv4Addr::from(self.0 + 2).to_string()
    }
    pub fn agent_ip(self) -> String {
        std::net::Ipv4Addr::from(self.0 + 3).to_string()
    }
}

/// How the engine keeps a task network's gateway address off the host (design v2 §10.2 inv. 8):
/// an internal network's `.1` is otherwise the host's own address on its bridge, and packets to
/// it go through INPUT, which neither `--internal` nor `DOCKER-USER` filters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gateway {
    /// Docker 28 or newer: `com.docker.network.bridge.gateway_mode_ipv4=isolated`, no address on the bridge.
    Isolated,
    /// podman: `--disable-dns`, an internal network without DNS, which has no gateway and leaves
    /// netavark's bridge without an address. Its own CLI takes the flag; behind docker's CLI, whose
    /// podman API forces DNS on and drops docker's option, the engine makes that call through
    /// libpod's own API (`/libpod/networks/create`, `dns_enabled: false`; #372).
    NoDns,
}

/// A model kind's agent sidecar: where its keys are, and its per-task caps (D45).
#[derive(Debug, Clone, Copy)]
pub struct Agent<'a> {
    /// `OMARCHY_SECRETS_DIR/agent.env` on the host: mounted read-only into the sidecar, never read by the dispatcher.
    pub env_file: &'a Path,
    pub calls: u32,
    pub tokens: u64,
    pub wall_s: u64,
}

/// One lease's network, sidecars and container, as the dispatcher asks for them. Every field is checked by [`plan`].
#[derive(Debug, Clone)]
pub struct Spec<'a> {
    pub task: u64,
    pub gen: &'a str,
    pub host: &'a str,
    pub release: &'a str,
    /// The lane's architecture: the container's `--platform`.
    pub arch: &'a str,
    /// The lane is emulated on this host (#338): the container is told so.
    pub emulated: bool,
    pub name: &'a str,
    pub kind: Kind,
    /// The CPUs and the memory of its units (the signed constants); the sidecars' come out of them.
    pub cpus: u32,
    pub mem_gb: u32,
    pub image: &'a str,
    /// `<work root>/tasks/<id>-<gen>`.
    pub task_dir: &'a Path,
    /// `<work root>/releases/<release>`: the release's checkout.
    pub release_dir: &'a Path,
    /// The worker image by digest: the sidecars run it.
    pub worker_image: &'a str,
    pub subnets: Subnets,
    /// The lease's /28 of `subnets`.
    pub slot: u32,
    /// The package's signed network exception (`factory/sizing`): a bridge network, no egress sidecar.
    pub direct: bool,
    /// How this engine keeps the internal network's gateway off the host.
    pub gateway: Gateway,
    /// Addresses the egress refuses besides the built-in ranges and `subnets`: the host's own.
    pub deny: &'a [String],
    /// The agent sidecar of a model kind; `None` on a host with no agent key.
    pub agent: Option<Agent<'a>>,
}

/// The container's name: `omarchy-task-<id>-<gen>`, its network's too.
pub fn container_name(task: u64, gen: &str) -> String {
    format!("{NAME_PREFIX}{task}-{gen}")
}

/// The lease a container, a sidecar or a network of ours belongs to, by its name — task 0 is a probe's.
pub fn owner_of_name(name: &str) -> Option<(u64, String)> {
    let name = name.trim_start_matches('/');
    let base = name
        .strip_suffix("-egress")
        .or_else(|| name.strip_suffix("-agent"))
        .or_else(|| name.strip_suffix(HELPER_SUFFIX))
        .unwrap_or(name);
    let rest = base.strip_prefix(NAME_PREFIX)?;
    let (id, gen) = rest.split_once('-')?;
    let id: u64 = id.parse().ok()?;
    gen_ok(gen).then(|| (id, gen.to_owned()))
}

/// The task directory of a lease under the work root.
pub fn task_dir(work_root: &Path, task: u64, gen: &str) -> PathBuf {
    work_root.join("tasks").join(format!("{task}-{gen}"))
}

/// What the sidecars of one network share: whose they are, the image, the slot, what the egress refuses.
struct Side<'a> {
    task: u64,
    gen: &'a str,
    host: &'a str,
    image: &'a str,
    subnets: Subnets,
    slot: Slot,
    direct: bool,
    gateway: Gateway,
    deny: &'a [String],
}

impl Side<'_> {
    fn net(&self) -> String {
        container_name(self.task, self.gen)
    }

    fn labels(&self, role: Option<&str>) -> Vec<String> {
        let mut l = vec![
            format!("{TASK_LABEL}={}", self.task),
            format!("{GEN_LABEL}={}", self.gen),
            format!("{HOST_LABEL}={}", self.host),
        ];
        if let Some(r) = role {
            l.push(format!("{ROLE_LABEL}={r}"));
        }
        l.into_iter()
            .flat_map(|x| ["--label".to_owned(), x])
            .collect()
    }

    /// The proxy variables, both spellings, and what goes around the proxy.
    fn proxy_env(&self, no_proxy: &str) -> Vec<(&'static str, String)> {
        if self.direct {
            return Vec::new();
        }
        let url = format!("http://{}:{EGRESS_PORT}", self.slot.egress_ip());
        vec![
            ("HTTP_PROXY", url.clone()),
            ("http_proxy", url.clone()),
            ("HTTPS_PROXY", url.clone()),
            ("https_proxy", url),
            ("NO_PROXY", no_proxy.to_owned()),
            ("no_proxy", no_proxy.to_owned()),
        ]
    }

    /// `network create`: internal with no gateway address on the host, unless the package has its signed exception.
    fn network(&self) -> Vec<String> {
        let mut a: Vec<String> = vec!["network".into(), "create".into()];
        if !self.direct {
            a.push("--internal".into());
            match self.gateway {
                Gateway::Isolated => a.extend([
                    "-o".into(),
                    "com.docker.network.bridge.gateway_mode_ipv4=isolated".into(),
                ]),
                Gateway::NoDns => a.push("--disable-dns".into()),
            }
        }
        a.extend(["--subnet".into(), self.slot.cidr()]);
        a.extend(self.labels(None));
        a.push(self.net());
        a
    }

    /// The egress sidecar: created on the shared bridge, attached to the task's network at its fixed
    /// address, started. The bridge comes first: podman (netavark) gives a container whose first network
    /// is internal no way out through a second one. Install's egress probe starts its own the same way
    /// (#373): both are held to `tests/fixtures/egress-sidecar.txt`.
    fn egress(&self) -> Vec<Vec<String>> {
        let name = format!("{}-egress", self.net());
        let ip = self.slot.egress_ip();
        let mut a: Vec<String> = vec!["create".into(), "--name".into(), name.clone()];
        a.extend(self.labels(Some("egress")));
        a.extend(
            [
                "--network",
                EGRESS_NETWORK,
                "--cpus",
                &millis(EGRESS_MILLICPUS),
                "--memory",
                &format!("{EGRESS_MEM_MB}m"),
                "--memory-swap",
                &format!("{EGRESS_MEM_MB}m"),
                "--pids-limit",
                "256",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--read-only",
                "--log-driver",
                "none",
                "-e",
                "OMARCHY_WORKER_ROLE=egress",
                self.image,
                "--listen",
                &format!("{ip}:{EGRESS_PORT}"),
                "--deny",
                &self.subnets.cidr(),
            ]
            .map(str::to_owned),
        );
        for d in self.deny {
            a.push("--deny".into());
            a.push(d.clone());
        }
        vec![
            a,
            vec![
                "network".into(),
                "connect".into(),
                "--ip".into(),
                ip,
                self.net(),
                name.clone(),
            ],
            vec!["start".into(), name],
        ]
    }

    /// The agent sidecar (`create`, then `start`) on the task's network only; or, for the probe,
    /// the one-shot `run --rm … --probe` whose last line of output is the agent's answer.
    fn agent(&self, agent: &Agent<'_>, usage_dir: Option<&Path>) -> Vec<Vec<String>> {
        let name = format!("{}-agent", self.net());
        let probe = usage_dir.is_none();
        let mut a: Vec<String> = if probe {
            vec!["run".into(), "--rm".into(), "--name".into(), name.clone()]
        } else {
            vec!["create".into(), "--name".into(), name.clone()]
        };
        a.extend(self.labels(Some(if probe { "probe" } else { "agent" })));
        a.extend(
            [
                "--network",
                &self.net(),
                "--ip",
                &self.slot.agent_ip(),
                "--cpus",
                &millis(AGENT_MILLICPUS),
                "--memory",
                &format!("{AGENT_MEM_MB}m"),
                "--memory-swap",
                &format!("{AGENT_MEM_MB}m"),
                "--pids-limit",
                "512",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
            ]
            .map(str::to_owned),
        );
        if !probe {
            a.extend(["--log-driver".into(), "none".into()]);
        }
        let mut env = vec![
            ("OMARCHY_WORKER_ROLE", "agent".to_owned()),
            ("OMARCHY_AGENT_ENV", AGENT_ENV_IN.to_owned()),
        ];
        if !probe {
            env.extend([
                ("BROKER_AGENT_CALLS", agent.calls.to_string()),
                ("BROKER_AGENT_TOKENS", agent.tokens.to_string()),
                ("BROKER_AGENT_WALL_SECONDS", agent.wall_s.to_string()),
                ("BROKER_USAGE_FILE", format!("{USAGE_DIR_IN}/usage.json")),
            ]);
        }
        env.extend(self.proxy_env("localhost,127.0.0.1"));
        for (k, v) in env {
            a.push("-e".into());
            a.push(format!("{k}={v}"));
        }
        // --mount, not -v: a keys file that is not there fails the sidecar, where -v would make a directory of it.
        a.push("--mount".into());
        a.push(keys_mount(agent.env_file));
        if let Some(u) = usage_dir {
            a.push("-v".into());
            a.push(format!("{}:{USAGE_DIR_IN}", u.display()));
        }
        a.push(self.image.to_owned());
        if probe {
            a.push("--probe".into());
            return vec![a];
        }
        vec![a, vec!["start".into(), name]]
    }
}

/// The agent sidecar's keys file, read-only.
fn keys_mount(env_file: &Path) -> String {
    format!(
        "type=bind,source={},target={AGENT_ENV_IN},readonly",
        env_file.display()
    )
}

/// Thousandths of a CPU as `--cpus` reads them.
fn millis(m: u32) -> String {
    format!("{}.{:03}", m / 1000, m % 1000)
}

/// The checks every sidecar's values pass before they reach argv.
fn side_ok(image: &str, deny: &[String], agent: Option<&Agent<'_>>) -> Result<(), String> {
    if !digest_ok(image) {
        return Err(format!(
            "worker image {image:?} is not an image by digest (repository@sha256:…): the sidecars run it"
        ));
    }
    for d in deny {
        d.parse::<crate::egress::Cidr>()
            .map_err(|e| format!("a host address to refuse: {e}"))?;
        if d.starts_with('-') {
            return Err(format!("a host address to refuse: {d:?}"));
        }
    }
    if let Some(a) = agent {
        if !path_ok(a.env_file) || a.env_file.file_name().is_none_or(|n| n != "agent.env") {
            return Err(format!(
                "the agent's keys file {} is not a plain absolute path to agent.env",
                a.env_file.display()
            ));
        }
        if a.calls == 0 || a.tokens == 0 || a.wall_s == 0 {
            return Err("an agent sidecar with a cap of 0".into());
        }
    }
    Ok(())
}

/// The engine calls that make one lease's network, its sidecars and its
/// container, in order (design v2 §9.3, §10.3): `network create`, the egress
/// sidecar (`create`, `network connect omarchy-egress`, `start`), the agent
/// sidecar of a model kind (`create`, `start`), then the task container
/// (`run -d`). Every value that reaches them is checked against the closed
/// grammar first; a value outside it fails the task before the engine runs.
pub fn plan(s: &Spec<'_>) -> Result<Vec<Vec<String>>, String> {
    let task = task_container(s)?;
    side_ok(s.worker_image, s.deny, s.agent.as_ref())?;
    let side = side_of(s)?;
    let mut calls = vec![side.network()];
    if !s.direct {
        calls.extend(side.egress());
    }
    if s.kind.model() {
        let agent = s
            .agent
            .as_ref()
            .ok_or("a model task on a host with no agent key (OMARCHY_SECRETS_DIR/agent.env)")?;
        calls.extend(side.agent(agent, Some(&s.task_dir.join("agent"))));
    }
    calls.push(task);
    Ok(calls)
}

fn side_of<'a>(s: &Spec<'a>) -> Result<Side<'a>, String> {
    let slot = s
        .subnets
        .slot(s.slot)
        .ok_or_else(|| format!("slot {} is outside {}", s.slot, s.subnets.cidr()))?;
    Ok(Side {
        task: s.task,
        gen: s.gen,
        host: s.host,
        image: s.worker_image,
        subnets: s.subnets,
        slot,
        direct: s.direct,
        gateway: s.gateway,
        deny: s.deny,
    })
}

/// The probe sidecar (design v2 §9.5): who the agent of this host is, asked
/// on a network of its own (task 0, a fresh generation) through its own
/// egress sidecar, by a one-shot agent container. Returns the calls that
/// set the network and the egress up, and the probe's own `run --rm`.
pub struct Probe<'a> {
    pub gen: &'a str,
    pub host: &'a str,
    pub worker_image: &'a str,
    pub subnets: Subnets,
    pub slot: u32,
    pub gateway: Gateway,
    pub deny: &'a [String],
    pub env_file: &'a Path,
}

pub fn probe_plan(p: &Probe<'_>) -> Result<(Vec<Vec<String>>, Vec<String>), String> {
    if !gen_ok(p.gen) || !host_ok(p.host) {
        return Err("a probe's generation or host is outside the grammar".into());
    }
    let agent = Agent {
        env_file: p.env_file,
        calls: 1,
        tokens: 1,
        wall_s: 1,
    };
    side_ok(p.worker_image, p.deny, Some(&agent))?;
    let side = Side {
        task: 0,
        gen: p.gen,
        host: p.host,
        image: p.worker_image,
        subnets: p.subnets,
        slot: p
            .subnets
            .slot(p.slot)
            .ok_or_else(|| format!("slot {} is outside {}", p.slot, p.subnets.cidr()))?,
        direct: false,
        gateway: p.gateway,
        deny: p.deny,
    };
    let mut setup = vec![side.network()];
    setup.extend(side.egress());
    let mut run = side.agent(&agent, None);
    Ok((setup, run.remove(0)))
}

/// A pool job's helper container (#340, design v2 §9.2, §10.3; D34): what the
/// `omarchy-task-run` shim read of a script's `run` — the architecture, the
/// image, the scratch directory it mounts at `/repo` and the script it runs
/// there — on the job's own lease, /28 and share. Every field is checked by
/// [`helper_plan`].
#[derive(Debug, Clone)]
pub struct Helper<'a> {
    pub task: u64,
    pub gen: &'a str,
    pub host: &'a str,
    /// The ring's architecture its check runs (`--platform`): a lane of this host, native or emulated.
    pub arch: &'a str,
    pub image: &'a str,
    /// One of the job's own scratch directories, mounted at `/repo`: directly under `scratch`.
    pub dir: &'a Path,
    /// The job's scratch root (`<task dir>/tmp`, its scripts' `TMPDIR`).
    pub scratch: &'a Path,
    pub read_only: bool,
    /// `<name>.sh` in `dir`, which `bash` runs.
    pub script: &'a str,
    /// The base image's keyring its check populates (`KEYRING`).
    pub keyring: Option<&'a str>,
    /// The CPUs and the memory of the job's units; the egress sidecar's come out of them.
    pub cpus: u32,
    pub mem_gb: u32,
    pub worker_image: &'a str,
    pub subnets: Subnets,
    pub slot: u32,
    pub gateway: Gateway,
    pub deny: &'a [String],
}

/// The engine calls that make a pool job's helper (#340): the job's internal
/// network and its egress sidecar (`network create`, `create`, `network
/// connect omarchy-egress`, `start`), then the helper's own `run` — attached,
/// so its output and exit code reach the script that asked for it, and never
/// `--rm`: the shim removes it with the rest of the lease's (an engine
/// `--rm` would race the removal), and the dispatcher removes what a killed
/// shim left when the job ends. Every value is checked against the closed
/// grammar first; a value outside it runs nothing.
#[allow(clippy::too_many_lines)] // every check of a value, then every flag, mount and variable, in the spec's order
pub fn helper_plan(h: &Helper<'_>) -> Result<(Vec<Vec<String>>, Vec<String>), String> {
    if h.task == 0 || !gen_ok(h.gen) || !host_ok(h.host) {
        return Err("a helper's task, generation or host is outside the grammar".into());
    }
    let platform =
        platform_of(h.arch).ok_or_else(|| format!("arch {:?} is not a lane's", h.arch))?;
    if !digest_ok(h.image) {
        return Err(format!(
            "image {:?} is not an image by digest (repository@sha256:…)",
            h.image
        ));
    }
    if !script_ok(h.script) {
        return Err(format!("script {:?} is not <name>.sh", h.script));
    }
    if h.keyring.is_some_and(|k| !HELPER_KEYRINGS.contains(&k)) {
        return Err(format!(
            "keyring {:?} is not a base image's ({})",
            h.keyring,
            HELPER_KEYRINGS.join(", ")
        ));
    }
    if !path_ok(h.dir) || !path_ok(h.scratch) {
        return Err(format!(
            "host path {} is outside the grammar",
            h.dir.display()
        ));
    }
    if h.dir.parent() != Some(h.scratch)
        || !h
            .dir
            .file_name()
            .is_some_and(|n| scratch_name_ok(&n.to_string_lossy()))
    {
        return Err(format!(
            "{} is not one of this job's scratch directories ({}/<name>)",
            h.dir.display(),
            h.scratch.display()
        ));
    }
    if h.cpus == 0 || h.mem_gb == 0 || h.cpus > 4096 || h.mem_gb > 65_536 {
        return Err(format!(
            "share {} CPUs, {} GB is outside 1..4096 CPUs and 1..65536 GB",
            h.cpus, h.mem_gb
        ));
    }
    side_ok(h.worker_image, h.deny, None)?;
    let side = Side {
        task: h.task,
        gen: h.gen,
        host: h.host,
        image: h.worker_image,
        subnets: h.subnets,
        slot: h
            .subnets
            .slot(h.slot)
            .ok_or_else(|| format!("slot {} is outside {}", h.slot, h.subnets.cidr()))?,
        direct: false,
        gateway: h.gateway,
        deny: h.deny,
    };
    let mut setup = vec![side.network()];
    setup.extend(side.egress());
    let net = side.net();
    let mem = format!("{}m", h.mem_gb * 1024 - EGRESS_MEM_MB);
    let mut a: Vec<String> = vec![
        "run".into(),
        "--name".into(),
        format!("{net}{HELPER_SUFFIX}"),
    ];
    a.extend(side.labels(Some("helper")));
    a.extend(
        [
            "--platform",
            platform,
            "--network",
            &net,
            "--cpus",
            &millis(h.cpus * 1000 - EGRESS_MILLICPUS),
            "--memory",
            &mem,
            "--memory-swap",
            &mem,
            "--pids-limit",
            &PIDS_LIMIT.to_string(),
            "--cap-drop",
            "ALL",
            // Its output goes to the script that asked for it, attached: nothing on the engine's disk.
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
    a.push("-v".into());
    a.push(format!(
        "{}:/repo{}",
        h.dir.display(),
        if h.read_only { ":ro" } else { "" }
    ));
    let mut env: Vec<(&str, String)> = Vec::new();
    if let Some(k) = h.keyring {
        env.push((HELPER_ENV, k.to_owned()));
    }
    env.extend(side.proxy_env("localhost,127.0.0.1"));
    for (k, v) in env {
        a.push("-e".into());
        a.push(format!("{k}={v}"));
    }
    a.push(h.image.to_owned());
    a.push("bash".into());
    a.push(format!("/repo/{}", h.script));
    Ok((setup, a))
}

/// The task container's `docker` arguments, after `docker` (`run -d …`):
/// the one place a task container is made (§9.3, §10.3), on its own
/// network. Every value that reaches the arguments is checked against the
/// closed grammar first; a value outside it fails the task before `docker`
/// runs.
#[allow(clippy::too_many_lines)] // every check of a value, then every flag, mount and variable, in the spec's order
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
    let side = side_of(s)?;
    // The sidecars' shares come out of the task's own (design v2 §7.3).
    let (mut millicpus, mut mem_mb) = (s.cpus * 1000, s.mem_gb * 1024);
    if !s.direct {
        millicpus -= EGRESS_MILLICPUS;
        mem_mb -= EGRESS_MEM_MB;
    }
    if s.kind.model() {
        millicpus -= AGENT_MILLICPUS;
        mem_mb -= AGENT_MEM_MB;
    }
    let name = container_name(s.task, s.gen);
    let mem = format!("{mem_mb}m");
    let mut a: Vec<String> = vec!["run".into(), "-d".into(), "--name".into(), name.clone()];
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
            "--network",
            &name,
            "--cpus",
            &millis(millicpus),
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
    for (k, v) in env_of(s, &side) {
        a.push("-e".into());
        a.push(format!("{k}={v}"));
    }
    a.push(s.image.to_owned());
    a.extend(ENTRYPOINT.map(str::to_owned));
    Ok(a)
}

/// The task's environment: its job counts (the task's CPUs, D32), its egress
/// sidecar as its proxy and, for the model kinds, where its agent sidecar
/// answers (§9.3). Nothing of the dispatcher's own environment, ever.
fn env_of(s: &Spec<'_>, side: &Side<'_>) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("MAKEFLAGS", format!("-j{}", s.cpus)),
        ("NINJAFLAGS", format!("-j{}", s.cpus)),
        ("CARGO_BUILD_JOBS", s.cpus.to_string()),
    ];
    let agent = format!("http://{}:{AGENT_PORT}", side.slot.agent_ip());
    let no_proxy = if s.kind.model() {
        format!("localhost,127.0.0.1,{}", side.slot.agent_ip())
    } else {
        "localhost,127.0.0.1".to_owned()
    };
    env.extend(side.proxy_env(&no_proxy));
    if s.emulated {
        env.push(("WORKER_LABELS", EMULATED_LABELS.to_owned()));
    }
    if s.kind.model() {
        env.push(("FACTORY_PROVIDER", "anthropic".to_owned()));
        env.push(("ANTHROPIC_BASE_URL", agent.clone()));
        env.push(("ANTHROPIC_API_KEY", AGENT_KEY_PLACEHOLDER.to_owned()));
        env.push(("GITHUB_API", format!("{agent}/github")));
    }
    env
}

#[cfg(test)]
mod tests {
    //! The spec's CI test (design v2 §10.3): every kind's plan is rendered —
    //! its network, its sidecars, its container — and read back against the
    //! spec. Any variable, mount, network, capability or flag outside it
    //! fails, so does any value outside the grammar, and so does a container
    //! attached to a task network that holds the socket, a pool token or a job
    //! token (invariants 1, 3, 5, 6, 8). `check_plan` is the reader; its own
    //! tests show it refuses each of those, so a change to `plan` that adds
    //! one fails here.

    use super::*;

    const DIGEST: &str = "docker.io/library/archlinux@sha256:51dd3d24f7fba779e7c471caeee7804c50e8c134ad948e19685a1c83a42facc3";
    const WORKER: &str = "ghcr.io/firemanxbr/omarchy-worker@sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const GEN: &str = "g_0123456789abcdef";

    fn subnets() -> Subnets {
        Subnets::parse("10.231.0.0/16").unwrap()
    }

    /// The slot whose /28 is `cidr`, if it is one of this range's.
    fn slot_of(range: Subnets, cidr: &str) -> Option<u32> {
        (0..range.slots()).find(|&i| range.slot(i).is_some_and(|s| s.cidr() == cidr))
    }

    /// The lease a task container's name says it runs (never task 0, never a sidecar's).
    fn lease_of_name(name: &str) -> Option<(u64, String)> {
        let rest = name.trim_start_matches('/').strip_prefix(NAME_PREFIX)?;
        let (id, gen) = rest.split_once('-')?;
        let id: u64 = id.parse().ok().filter(|&i| i > 0)?;
        gen_ok(gen).then(|| (id, gen.to_owned()))
    }

    fn env_file() -> &'static Path {
        Path::new("/srv/omarchy/secrets/agent.env")
    }

    fn spec<'a>(kind: Kind, dir: &'a Path, rel: &'a Path) -> Spec<'a> {
        Spec {
            task: 812,
            gen: GEN,
            host: "h_studio-1",
            release: "v1.2.3",
            arch: "aarch64",
            emulated: false,
            name: "felix",
            kind,
            cpus: 4,
            mem_gb: 8,
            image: DIGEST,
            task_dir: dir,
            release_dir: rel,
            worker_image: WORKER,
            subnets: subnets(),
            slot: 3,
            direct: false,
            gateway: Gateway::Isolated,
            deny: &[],
            agent: Some(Agent {
                env_file: env_file(),
                calls: 200,
                tokens: 2_000_000,
                wall_s: 7200,
            }),
        }
    }

    const FLAGS_WITH_VALUE: [&str; 16] = [
        "--name",
        "--mount",
        "--label",
        "--platform",
        "--network",
        "--ip",
        "--cpus",
        "--memory",
        "--memory-swap",
        "--pids-limit",
        "--cap-drop",
        "--cap-add",
        "--security-opt",
        "--log-driver",
        "-v",
        "-e",
    ];

    /// A container's arguments, read.
    #[derive(Default, Debug)]
    struct Read<'a> {
        verb: &'a str,
        name: &'a str,
        network: Option<&'a str>,
        ip: Option<&'a str>,
        flags: Vec<(&'a str, &'a str)>,
        bare: Vec<&'a str>,
        env: Vec<&'a str>,
        mounts: Vec<&'a str>,
        labels: Vec<&'a str>,
        caps: Vec<&'a str>,
        rest: Vec<&'a str>,
    }

    fn read(a: &[String]) -> Result<Read<'_>, String> {
        let mut it = a.iter().map(String::as_str);
        let mut r = Read {
            verb: it.next().ok_or("empty")?,
            ..Read::default()
        };
        while let Some(f) = it.next() {
            if !f.starts_with('-') {
                r.rest.push(f);
                r.rest.extend(it.by_ref());
                break;
            }
            if matches!(f, "-d" | "--rm" | "--read-only") {
                r.bare.push(f);
                continue;
            }
            if !FLAGS_WITH_VALUE.contains(&f) {
                return Err(format!("flag outside the spec: {f}"));
            }
            let v = it.next().ok_or_else(|| format!("{f} without a value"))?;
            match f {
                "--name" => r.name = v,
                "--network" => r.network = Some(v),
                "--ip" => r.ip = Some(v),
                "-e" => r.env.push(v),
                "-v" => r.mounts.push(v),
                "--label" => r.labels.push(v),
                "--cap-add" => r.caps.push(v),
                _ => r.flags.push((f, v)),
            }
        }
        Ok(r)
    }

    fn flag<'a>(r: &Read<'a>, f: &str) -> Option<&'a str> {
        r.flags.iter().find(|(k, _)| *k == f).map(|(_, v)| *v)
    }

    /// What every container attached to a task network must be: its network that one only, the
    /// capabilities dropped, no new privileges, no socket, no token, no key but the agent's file.
    fn common(r: &Read<'_>, net: &str) -> Result<(), String> {
        if r.network != Some(net) {
            return Err(format!("{}: network {:?}, not {net}", r.name, r.network));
        }
        if flag(r, "--cap-drop") != Some("ALL")
            || flag(r, "--security-opt") != Some("no-new-privileges")
        {
            return Err(format!(
                "{}: --cap-drop ALL and no-new-privileges are required",
                r.name
            ));
        }
        for (k, _) in &r.flags {
            if r.flags.iter().filter(|(x, _)| x == k).count() != 1 {
                return Err(format!("{}: {k} twice", r.name));
            }
        }
        if let Some(p) = flag(r, "--platform") {
            if p != "linux/amd64" && p != "linux/arm64" {
                return Err(format!("platform {p}"));
            }
        }
        if let Some(l) = flag(r, "--log-driver") {
            if l != "none" {
                return Err(format!("{}: log driver {l}", r.name));
            }
        }
        if flag(r, "--mount").is_some() && !r.name.ends_with("-agent") {
            return Err(format!("{}: --mount outside the agent sidecar", r.name));
        }
        for m in &r.mounts {
            let from = m.split(':').next().unwrap_or("");
            if from.contains("docker.sock")
                || from.contains("podman.sock")
                || from.starts_with("/var/run")
                || from.starts_with("/run")
            {
                return Err(format!("{}: the socket: {m}", r.name));
            }
        }
        for e in &r.env {
            let (k, v) = e.split_once('=').ok_or("env without =")?;
            let lower = k.to_ascii_lowercase();
            // The placeholder a model kind sends as its key, and the sidecar's token cap (a number), are not credentials.
            let placeholder = k == "ANTHROPIC_API_KEY" && v == AGENT_KEY_PLACEHOLDER
                || k == "BROKER_AGENT_TOKENS" && v.parse::<u64>().is_ok()
                || k == HELPER_ENV && HELPER_KEYRINGS.contains(&v);
            if !placeholder
                && (lower.contains("token")
                    || lower.contains("key")
                    || lower.contains("secret")
                    || lower.contains("password")
                    || v.starts_with("omw_")
                    || v.starts_with("omj.")
                    || v.starts_with("om") && v.contains('_'))
            {
                return Err(format!("{}: a credential: {k}", r.name));
            }
        }
        Ok(())
    }

    fn proxy_ok(k: &str, v: &str, slot: Slot) -> bool {
        match k {
            "HTTP_PROXY" | "http_proxy" | "HTTPS_PROXY" | "https_proxy" => {
                v == format!("http://{}:{EGRESS_PORT}", slot.egress_ip())
            }
            "NO_PROXY" | "no_proxy" => v
                .split(',')
                .all(|h| h == "localhost" || h == "127.0.0.1" || h == slot.agent_ip()),
            _ => false,
        }
    }

    /// The task container: the spec's flags, mounts, environment and command.
    fn check_task(r: &Read<'_>, work: &Path, slot: Slot) -> Result<(), String> {
        if r.verb != "run" || r.bare != ["-d"] {
            return Err(format!(
                "the task container is `run -d`: {} {:?}",
                r.verb, r.bare
            ));
        }
        if r.ip.is_some() {
            return Err("the task container's address is the engine's".into());
        }
        if flag(r, "--log-driver") != Some("none") {
            return Err("--log-driver none is required: the task's log is /task/log".into());
        }
        if flag(r, "--pids-limit") != Some("8192") {
            return Err("pids limit".into());
        }
        for c in &r.caps {
            if !CAPS.contains(c) {
                return Err(format!("capability outside the spec: {c}"));
            }
        }
        let (id, gen) = lease_of_name(r.name).ok_or_else(|| format!("name {}", r.name))?;
        for want in [format!("{TASK_LABEL}={id}"), format!("{GEN_LABEL}={gen}")] {
            if !r.labels.contains(&want.as_str()) {
                return Err(format!("label {want} missing"));
            }
        }
        for l in &r.labels {
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
        for m in &r.mounts {
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
            dests.push(to);
        }
        dests.sort_unstable();
        dests.dedup();
        if dests.len() != r.mounts.len() || r.mounts.len() != 6 {
            return Err(format!("mounts: {:?}", r.mounts));
        }
        let agent = format!("http://{}:{AGENT_PORT}", slot.agent_ip());
        for e in &r.env {
            let (k, v) = e.split_once('=').ok_or("env without =")?;
            if !ENV_ALLOWLIST.contains(&k) {
                return Err(format!("variable outside the allowlist: {k}"));
            }
            let ok = match k {
                "ANTHROPIC_BASE_URL" => v == agent,
                "GITHUB_API" => v == format!("{agent}/github"),
                "ANTHROPIC_API_KEY" => v == AGENT_KEY_PLACEHOLDER,
                "WORKER_LABELS" => v == EMULATED_LABELS,
                k if k.to_ascii_lowercase().contains("proxy") => proxy_ok(k, v, slot),
                _ => true,
            };
            if !ok {
                return Err(format!("{k}={v}"));
            }
        }
        let image = r.rest.first().ok_or("no image")?;
        if !digest_ok(image) {
            return Err(format!("image not by digest: {image}"));
        }
        if r.rest[1..] != ENTRYPOINT {
            return Err(format!("command outside the spec: {:?}", &r.rest[1..]));
        }
        Ok(())
    }

    /// A pool job's helper (#340): attached, never `--rm` (the shim removes it), the task container's
    /// capabilities and limits, one of its job's scratch directories at `/repo` and nothing else, its
    /// keyring and its proxy only, a script of that directory run by bash.
    fn check_helper(r: &Read<'_>, work: &Path, slot: Slot) -> Result<(), String> {
        check_side_labels(r, "helper")?;
        if r.verb != "run" || !r.bare.is_empty() {
            return Err(format!(
                "{}: a helper is an attached `run`: {} {:?}",
                r.name, r.verb, r.bare
            ));
        }
        if r.ip.is_some() {
            return Err(format!("{}: its address is the engine's", r.name));
        }
        if flag(r, "--log-driver") != Some("none") || flag(r, "--pids-limit") != Some("8192") {
            return Err(format!("{}: its log driver and pids limit", r.name));
        }
        if flag(r, "--cpus").is_none()
            || flag(r, "--memory").is_none()
            || flag(r, "--memory-swap") != flag(r, "--memory")
        {
            return Err(format!("{}: its share", r.name));
        }
        for c in &r.caps {
            if !CAPS.contains(c) {
                return Err(format!("{}: capability outside the spec: {c}", r.name));
            }
        }
        let (id, gen) = owner_of_name(r.name).ok_or("name")?;
        let scratch = task_dir(work, id, &gen).join("tmp");
        let [m] = r.mounts.as_slice() else {
            return Err(format!("{}: mounts {:?}", r.name, r.mounts));
        };
        let from = m
            .strip_suffix(":/repo:ro")
            .or_else(|| m.strip_suffix(":/repo"))
            .map(Path::new)
            .ok_or_else(|| format!("{}: mount outside the spec: {m}", r.name))?;
        if from.parent() != Some(scratch.as_path())
            || !from
                .file_name()
                .is_some_and(|n| scratch_name_ok(&n.to_string_lossy()))
        {
            return Err(format!(
                "{}: {m} is not one of its job's scratch directories",
                r.name
            ));
        }
        for e in &r.env {
            let (k, v) = e.split_once('=').ok_or("env without =")?;
            let ok = match k {
                HELPER_ENV => HELPER_KEYRINGS.contains(&v),
                k => proxy_ok(k, v, slot),
            };
            if !ok {
                return Err(format!("{}: variable outside the spec: {k}={v}", r.name));
            }
        }
        let (image, cmd) = r.rest.split_first().ok_or("no image")?;
        if !digest_ok(image) {
            return Err(format!("{}: image not by digest: {image}", r.name));
        }
        match cmd {
            [bash, script]
                if *bash == "bash" && script.strip_prefix("/repo/").is_some_and(script_ok) => {}
            _ => return Err(format!("{}: command outside the spec: {cmd:?}", r.name)),
        }
        Ok(())
    }

    fn check_side_labels(r: &Read<'_>, role: &str) -> Result<(), String> {
        let (id, gen) = owner_of_name(r.name).ok_or_else(|| format!("name {}", r.name))?;
        let want = [
            format!("{TASK_LABEL}={id}"),
            format!("{GEN_LABEL}={gen}"),
            format!("{ROLE_LABEL}={role}"),
        ];
        for w in &want {
            if !r.labels.contains(&w.as_str()) {
                return Err(format!("{}: label {w} missing", r.name));
            }
        }
        for l in &r.labels {
            if !want.contains(&(*l).to_owned())
                && !l
                    .strip_prefix(&format!("{HOST_LABEL}="))
                    .is_some_and(host_ok)
            {
                return Err(format!("{}: label outside the spec: {l}", r.name));
            }
        }
        Ok(())
    }

    /// The egress sidecar: nothing mounted, no capability, a read-only root, its role and its listen address only.
    fn check_egress(r: &Read<'_>, slot: Slot, range: &str) -> Result<(), String> {
        check_side_labels(r, "egress")?;
        if r.verb != "create" || r.bare != ["--read-only"] {
            return Err(format!("{}: {} {:?}", r.name, r.verb, r.bare));
        }
        if r.ip.is_some() {
            return Err(format!(
                "{}: an address on the shared bridge: {:?}",
                r.name, r.ip
            ));
        }
        if !r.mounts.is_empty() || !r.caps.is_empty() || r.env != ["OMARCHY_WORKER_ROLE=egress"] {
            return Err(format!(
                "{}: mounts {:?}, caps {:?}, env {:?}",
                r.name, r.mounts, r.caps, r.env
            ));
        }
        if flag(r, "--cpus") != Some("0.100") || flag(r, "--memory") != Some("64m") {
            return Err(format!("{}: its share", r.name));
        }
        let (image, args) = r.rest.split_first().ok_or("no image")?;
        if !digest_ok(image) {
            return Err(format!("{}: image {image}", r.name));
        }
        let listen = format!("{}:{EGRESS_PORT}", slot.egress_ip());
        if args.len() < 4 || args[..4] != ["--listen", listen.as_str(), "--deny", range] {
            return Err(format!("{}: {args:?}", r.name));
        }
        for pair in args[2..].chunks(2) {
            if pair.len() != 2
                || pair[0] != "--deny"
                || pair[1].parse::<crate::egress::Cidr>().is_err()
            {
                return Err(format!("{}: {pair:?}", r.name));
            }
        }
        Ok(())
    }

    /// The agent sidecar (or the probe's one-shot agent): the keys file read-only, its usage
    /// directory, its caps and its proxy; never a worker token, never the socket.
    fn check_agent(r: &Read<'_>, slot: Slot, work: &Path) -> Result<(), String> {
        let probe = r.verb == "run";
        check_side_labels(r, if probe { "probe" } else { "agent" })?;
        if probe && r.bare != ["--rm"] || !probe && (r.verb != "create" || !r.bare.is_empty()) {
            return Err(format!("{}: {} {:?}", r.name, r.verb, r.bare));
        }
        if r.ip != Some(&slot.agent_ip()) || !r.caps.is_empty() {
            return Err(format!("{}: address {:?}, caps {:?}", r.name, r.ip, r.caps));
        }
        let (id, gen) = owner_of_name(r.name).ok_or("name")?;
        let usage = format!(
            "{}:{USAGE_DIR_IN}",
            task_dir(work, id, &gen).join("agent").display()
        );
        let keys: Vec<&str> = r
            .flags
            .iter()
            .filter(|(k, _)| *k == "--mount")
            .map(|(_, v)| *v)
            .collect();
        let keys_ok = |m: &str| {
            m.strip_prefix("type=bind,source=")
                .and_then(|m| m.strip_suffix(&format!(",target={AGENT_ENV_IN},readonly")))
                .is_some_and(|f| {
                    let f = Path::new(f);
                    path_ok(f) && f.file_name().is_some_and(|n| n == "agent.env")
                })
        };
        if keys.len() != 1 || !keys_ok(keys[0]) {
            return Err(format!("{}: the keys file: {keys:?}", r.name));
        }
        if r.mounts
            != if probe {
                Vec::new()
            } else {
                vec![usage.as_str()]
            }
        {
            return Err(format!("{}: mounts {:?}", r.name, r.mounts));
        }
        for e in &r.env {
            let (k, v) = e.split_once('=').ok_or("env without =")?;
            let ok = match k {
                "OMARCHY_WORKER_ROLE" => v == "agent",
                "OMARCHY_AGENT_ENV" => v == AGENT_ENV_IN,
                "BROKER_USAGE_FILE" => !probe && v == format!("{USAGE_DIR_IN}/usage.json"),
                "BROKER_AGENT_CALLS" | "BROKER_AGENT_TOKENS" | "BROKER_AGENT_WALL_SECONDS" => {
                    !probe && v.parse::<u64>().is_ok_and(|n| n > 0)
                }
                k => proxy_ok(k, v, slot),
            };
            if !ok {
                return Err(format!("{}: variable outside the spec: {k}={v}", r.name));
            }
        }
        let (image, args) = r.rest.split_first().ok_or("no image")?;
        if !digest_ok(image) || args != if probe { &["--probe"][..] } else { &[][..] } {
            return Err(format!("{}: {:?}", r.name, r.rest));
        }
        Ok(())
    }

    /// Reads a whole plan back: its network, every container attached to it, every connect and start.
    #[allow(clippy::too_many_lines)] // one reading of every call a plan may hold
    fn check_plan(calls: &[Vec<String>], work: &Path, direct: bool) -> Result<(), String> {
        let range = subnets();
        let mut net: Option<(String, Slot)> = None;
        let mut made: Vec<String> = Vec::new();
        let (mut tasks, mut egress, mut agents, mut helpers) = (0, 0, 0, 0);
        for c in calls {
            let words: Vec<&str> = c.iter().map(String::as_str).collect();
            match words.as_slice() {
                ["network", "create", rest @ ..] => {
                    if net.is_some() {
                        return Err("a second network".into());
                    }
                    let (mut internal, mut isolated, mut subnet, mut name) =
                        (false, false, None, None);
                    let mut it = rest.iter();
                    while let Some(w) = it.next() {
                        match *w {
                            "--internal" => internal = true,
                            "-o" => match it.next() {
                                Some(&"com.docker.network.bridge.gateway_mode_ipv4=isolated") => {
                                    isolated = true;
                                }
                                o => return Err(format!("network option outside the spec: {o:?}")),
                            },
                            "--subnet" => subnet = it.next().copied(),
                            "--label" => {
                                let l = it.next().ok_or("--label without a value")?;
                                let k = l.split_once('=').map(|(k, _)| k);
                                if !matches!(k, Some(TASK_LABEL | GEN_LABEL | HOST_LABEL)) {
                                    return Err(format!("network label {l}"));
                                }
                            }
                            w if !w.starts_with('-') && name.is_none() => name = Some(w),
                            w => return Err(format!("network flag outside the spec: {w}")),
                        }
                    }
                    if internal == direct {
                        return Err(format!("the network is internal: {internal}, the package's exception: {direct}"));
                    }
                    // Docker's plan (the CI engine): an internal network's gateway is no address of the host.
                    if isolated != internal {
                        return Err(format!(
                            "the network is internal: {internal}, its gateway isolated: {isolated}"
                        ));
                    }
                    let name = name.ok_or("a network without a name")?;
                    owner_of_name(name)
                        .filter(|_| !name.ends_with("-egress") && !name.ends_with("-agent"))
                        .ok_or_else(|| format!("network name {name}"))?;
                    let slot = subnet
                        .and_then(|s| slot_of(range, s))
                        .and_then(|i| range.slot(i))
                        .ok_or_else(|| {
                            format!("subnet {subnet:?} is not a /28 of {}", range.cidr())
                        })?;
                    net = Some((name.to_owned(), slot));
                }
                ["network", "connect", "--ip", ip, n, who] => {
                    let (name, slot) = net.as_ref().ok_or("a connect before the network")?;
                    if n != name
                        || *ip != slot.egress_ip()
                        || !who.ends_with("-egress")
                        || !made.contains(&(*who).to_owned())
                    {
                        return Err(format!("network connect --ip {ip} {n} {who}"));
                    }
                }
                ["start", who] => {
                    if !made.contains(&(*who).to_owned()) {
                        return Err(format!("start of {who}, which the plan did not create"));
                    }
                }
                ["create" | "run", ..] => {
                    let (name, slot) = net.as_ref().ok_or("a container before its network")?;
                    let r = read(c)?;
                    // The egress is created on the shared bridge and attached to the task's network after.
                    common(
                        &r,
                        if r.name.ends_with("-egress") {
                            EGRESS_NETWORK
                        } else {
                            name
                        },
                    )?;
                    if owner_of_name(r.name) != owner_of_name(name) {
                        return Err(format!("{} is not of {name}'s lease", r.name));
                    }
                    if r.name.ends_with("-egress") {
                        egress += 1;
                        check_egress(&r, *slot, &range.cidr())?;
                    } else if r.name.ends_with("-agent") {
                        agents += 1;
                        check_agent(&r, *slot, work)?;
                    } else if r.name.ends_with(HELPER_SUFFIX) {
                        helpers += 1;
                        check_helper(&r, work, *slot)?;
                    } else {
                        tasks += 1;
                        check_task(&r, work, *slot)?;
                    }
                    made.push(r.name.to_owned());
                }
                other => return Err(format!("a call outside the spec: {other:?}")),
            }
        }
        // A pool job's helper is its lease's one container: never beside a task container or an agent.
        if tasks > 1
            || egress > 1
            || agents > 1
            || helpers > 1
            || (helpers == 1 && tasks + agents > 0)
            || (egress == 1) == direct
        {
            return Err(format!(
                "{tasks} task(s), {helpers} helper(s), {egress} egress, {agents} agent(s), direct {direct}"
            ));
        }
        Ok(())
    }

    fn dirs() -> (PathBuf, PathBuf, PathBuf) {
        let work = PathBuf::from("/srv/omarchy/work");
        (
            task_dir(&work, 812, GEN),
            work.join("releases/v1.2.3"),
            work,
        )
    }

    fn task_of(plan: &[Vec<String>]) -> Vec<String> {
        plan.iter().find(|c| c[0] == "run").cloned().unwrap()
    }

    #[test]
    fn every_kind_renders_inside_the_spec() {
        let (tdir, rel, work) = dirs();
        for kind in [Kind::Build, Kind::ModelBuild, Kind::Audit, Kind::Trial] {
            let p = plan(&spec(kind, &tdir, &rel)).unwrap();
            check_plan(&p, &work, false).unwrap_or_else(|e| panic!("{kind:?}: {e}\n{p:#?}"));
            let a = task_of(&p);
            let has = |s: &str| a.iter().any(|x| x == s);
            assert!(!has("--rm"), "never --rm");
            assert!(!has("--privileged") && !has("--device"));
            assert!(a.iter().any(|x| x.starts_with("MAKEFLAGS=-j4")));
            assert_eq!(
                a.iter().any(|x| x.starts_with("ANTHROPIC_BASE_URL=")),
                kind.model(),
                "{kind:?}: only the model kinds talk to an agent"
            );
            assert_eq!(
                p.iter().any(|c| c.iter().any(|x| x.ends_with("-agent"))),
                kind.model(),
                "{kind:?}: an agent sidecar for the model kinds only"
            );
            // The order: the network, its egress, its agent, then the task.
            assert_eq!(p[0][..2], ["network", "create"]);
            assert_eq!(p.last().unwrap()[0], "run");
        }
    }

    #[test]
    fn only_a_container_on_an_emulated_lane_is_told_so_and_its_platform_is_the_lanes() {
        let (tdir, rel, work) = dirs();
        let after = |a: &[String], f: &str| {
            a.iter()
                .position(|x| x == f)
                .map(|i| a[i + 1].clone())
                .unwrap()
        };
        for kind in [Kind::Build, Kind::ModelBuild, Kind::Trial, Kind::Audit] {
            // The native lane: no WORKER_LABELS at all.
            let p = plan(&spec(kind, &tdir, &rel)).unwrap();
            let a = task_of(&p);
            assert!(
                !a.iter().any(|x| x.starts_with("WORKER_LABELS=")),
                "{kind:?}: a native lane's container is not told anything of emulation"
            );
            assert_eq!(after(&a, "--platform"), "linux/arm64");
            // An x86_64 lane emulated on this aarch64 host (#338).
            let mut s = spec(kind, &tdir, &rel);
            s.arch = "x86_64";
            s.emulated = true;
            let p = plan(&s).unwrap();
            check_plan(&p, &work, false).unwrap_or_else(|e| panic!("{kind:?}: {e}\n{p:#?}"));
            let a = task_of(&p);
            assert_eq!(after(&a, "--platform"), "linux/amd64");
            assert_eq!(
                a.iter()
                    .filter(|x| x.starts_with("WORKER_LABELS="))
                    .collect::<Vec<_>>(),
                [r#"WORKER_LABELS={"emulated":true}"#]
            );
            // Its sidecars run the worker image natively, and are told nothing.
            for c in p.iter().filter(|c| c[0] == "create") {
                assert!(
                    !c.iter().any(|x| x.starts_with("WORKER_LABELS=")),
                    "{kind:?}: {c:?}"
                );
            }
        }
        // Any other value of it is outside the spec.
        let mut bad = task_of(&plan(&spec(Kind::Build, &tdir, &rel)).unwrap());
        let image = bad.iter().position(|x| x == DIGEST).unwrap();
        bad.splice(
            image..image,
            [
                "-e".to_owned(),
                r#"WORKER_LABELS={"emulated":false,"x":1}"#.to_owned(),
            ],
        );
        let mut p = plan(&spec(Kind::Build, &tdir, &rel)).unwrap();
        *p.last_mut().unwrap() = bad;
        assert!(check_plan(&p, &work, false).is_err());
    }

    #[test]
    fn the_share_the_network_and_the_labels_are_the_leases() {
        let (tdir, rel, _) = dirs();
        let after = |a: &[String], f: &str| {
            a.iter()
                .position(|x| x == f)
                .map(|i| a[i + 1].clone())
                .unwrap()
        };
        let p = plan(&spec(Kind::Build, &tdir, &rel)).unwrap();
        assert_eq!(
            p[0],
            [
                "network",
                "create",
                "--internal",
                "-o",
                "com.docker.network.bridge.gateway_mode_ipv4=isolated",
                "--subnet",
                "10.231.0.48/28",
                "--label",
                "com.omarchy.task=812",
                "--label",
                "org.omarchy-pool.task.gen=g_0123456789abcdef",
                "--label",
                "org.omarchy-pool.agent.host=h_studio-1",
                "omarchy-task-812-g_0123456789abcdef"
            ]
        );
        assert_eq!(
            p[2],
            [
                "network",
                "connect",
                "--ip",
                "10.231.0.50",
                "omarchy-task-812-g_0123456789abcdef",
                "omarchy-task-812-g_0123456789abcdef-egress"
            ]
        );
        let a = task_of(&p);
        assert_eq!(after(&a, "--name"), "omarchy-task-812-g_0123456789abcdef");
        assert_eq!(
            after(&a, "--network"),
            "omarchy-task-812-g_0123456789abcdef"
        );
        // A build's 4 CPUs and 8 GB, less its egress sidecar's 0.1 CPU and 64 MB.
        assert_eq!(after(&a, "--cpus"), "3.900");
        assert_eq!(after(&a, "--memory"), "8128m");
        assert_eq!(after(&a, "--memory-swap"), "8128m");
        assert_eq!(after(&a, "--platform"), "linux/arm64");
        assert!(a.iter().any(|x| x == "https_proxy=http://10.231.0.50:3128"));
        assert!(a.iter().any(|x| x == "HTTP_PROXY=http://10.231.0.50:3128"));
        for l in [
            "com.omarchy.task=812",
            "org.omarchy-pool.task.gen=g_0123456789abcdef",
            "org.omarchy-pool.agent.host=h_studio-1",
            "org.omarchy-pool.task.release=v1.2.3",
        ] {
            assert!(a.iter().any(|x| x == l), "{l}");
        }
        // A model kind: the agent's 0.25 CPU and 256 MB too, its address the agent sidecar's.
        let m = task_of(&plan(&spec(Kind::Audit, &tdir, &rel)).unwrap());
        assert_eq!(after(&m, "--cpus"), "3.650");
        assert_eq!(after(&m, "--memory"), "7872m");
        assert!(m
            .iter()
            .any(|x| x == "ANTHROPIC_BASE_URL=http://10.231.0.51:8790"));
        assert!(m
            .iter()
            .any(|x| x == "no_proxy=localhost,127.0.0.1,10.231.0.51"));
        // One unit with both sidecars still leaves the task most of a CPU.
        let mut one = spec(Kind::Audit, &tdir, &rel);
        one.cpus = 1;
        one.mem_gb = 2;
        let o = task_of(&plan(&one).unwrap());
        assert_eq!(after(&o, "--cpus"), "0.650");
        assert_eq!(after(&o, "--memory"), "1728m");
    }

    /// The calls of the fixture the dispatcher and install's egress probe both start an egress
    /// sidecar by (#373), its placeholders filled with `values`.
    fn egress_fixture(values: &[(&str, &str)]) -> Vec<Vec<String>> {
        include_str!("../../tests/fixtures/egress-sidecar.txt")
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(|l| {
                let l = values
                    .iter()
                    .fold(l.to_owned(), |l, (k, v)| l.replace(k, v));
                l.split(' ').map(str::to_owned).collect()
            })
            .collect()
    }

    #[test]
    fn the_egress_sidecar_is_started_as_the_fixture_install_s_probe_shares_says() {
        // Install's egress probe starts its own sidecar from the same fixture (omarchy-agent's
        // install tests): a change to the limits, flags or role here fails until it follows.
        let (tdir, rel, _) = dirs();
        let own = ["203.0.113.10".to_owned()];
        let mut s = spec(Kind::Build, &tdir, &rel);
        s.deny = &own;
        let p = plan(&s).unwrap();
        let want = egress_fixture(&[
            ("{name}", "omarchy-task-812-g_0123456789abcdef-egress"),
            (
                "{labels}",
                "--label com.omarchy.task=812 --label org.omarchy-pool.task.gen=g_0123456789abcdef --label org.omarchy-pool.agent.host=h_studio-1 --label org.omarchy-pool.task.role=egress",
            ),
            ("{out}", EGRESS_NETWORK),
            ("{image}", WORKER),
            ("{ip}", "10.231.0.50"),
            ("{net}", "omarchy-task-812-g_0123456789abcdef"),
            ("{deny}", "--deny 10.231.0.0/16 --deny 203.0.113.10"),
        ]);
        assert_eq!(p[1..4], want[..]);
    }

    #[test]
    fn a_signed_exception_gets_a_bridge_network_and_no_egress() {
        let (tdir, rel, work) = dirs();
        for kind in [Kind::Build, Kind::ModelBuild] {
            let mut s = spec(kind, &tdir, &rel);
            s.direct = true;
            let p = plan(&s).unwrap();
            check_plan(&p, &work, true).unwrap_or_else(|e| panic!("{e}\n{p:#?}"));
            assert!(!p[0].iter().any(|x| x == "--internal"));
            assert!(!p.iter().any(|c| c
                .iter()
                .any(|x| x.contains("proxy=") || x.contains("PROXY="))));
            assert!(
                check_plan(&p, &work, false).is_err(),
                "a bridge network without its exception is refused"
            );
            let a = task_of(&p);
            let cpus = a[a.iter().position(|x| x == "--cpus").unwrap() + 1].clone();
            assert_eq!(cpus, if kind.model() { "3.750" } else { "4.000" });
        }
        let internal = plan(&spec(Kind::Build, &tdir, &rel)).unwrap();
        assert!(check_plan(&internal, &work, true).is_err());
    }

    #[test]
    fn two_leases_share_no_network_and_no_sidecar() {
        let work = PathBuf::from("/srv/omarchy/work");
        let r = work.join("releases/v1.2.3");
        let (t1, t2) = (
            task_dir(&work, 812, GEN),
            task_dir(&work, 813, "g_fedcba9876543210"),
        );
        let mut a = spec(Kind::ModelBuild, &t1, &r);
        a.slot = 0;
        let mut b = spec(Kind::Audit, &t2, &r);
        b.task = 813;
        b.gen = "g_fedcba9876543210";
        b.slot = 1;
        let (pa, pb) = (plan(&a).unwrap(), plan(&b).unwrap());
        check_plan(&pa, &work, false).unwrap();
        check_plan(&pb, &work, false).unwrap();
        let names = |p: &[Vec<String>]| -> Vec<String> {
            p.iter()
                .flat_map(|c| c.iter())
                .filter(|x| x.starts_with(NAME_PREFIX))
                .cloned()
                .collect()
        };
        for n in names(&pa) {
            assert!(!names(&pb).contains(&n), "{n} is in both leases' plans");
        }
        // The audit's agent is on the audit's network only: the recipe of the other lease reaches neither.
        let agent_b = pb
            .iter()
            .find(|c| c[0] == "create" && c[2].ends_with("-agent"))
            .unwrap();
        assert_eq!(
            agent_b[agent_b.iter().position(|x| x == "--network").unwrap() + 1],
            "omarchy-task-813-g_fedcba9876543210"
        );
        let subnet = |p: &[Vec<String>]| {
            p[0][p[0].iter().position(|x| x == "--subnet").unwrap() + 1].clone()
        };
        assert_ne!(subnet(&pa), subnet(&pb));
    }

    #[test]
    fn a_model_task_without_an_agent_key_fails_before_docker() {
        let (tdir, rel, _) = dirs();
        let mut s = spec(Kind::Audit, &tdir, &rel);
        s.agent = None;
        assert!(plan(&s).unwrap_err().contains("no agent key"));
        let mut b = spec(Kind::Build, &tdir, &rel);
        b.agent = None;
        assert!(plan(&b).is_ok(), "a build needs no agent");
    }

    #[test]
    fn a_value_outside_the_grammar_fails_before_docker() {
        type Change = Box<dyn for<'b> Fn(&mut Spec<'b>)>;
        let (tdir, rel, _) = dirs();
        let other = PathBuf::from("/srv/omarchy/work/tasks/813-g_0123456789abcdef");
        let colon = PathBuf::from("/srv/omarchy/work:/etc/tasks/812-g_0123456789abcdef");
        let relative = PathBuf::from("work/releases/v1.2.3");
        for (what, td, rd) in [
            ("another task's directory", &other, &rel),
            ("a colon in a path", &colon, &rel),
            ("a relative checkout", &tdir, &relative),
        ] {
            let mut s = spec(Kind::Build, td, rd);
            s.task_dir = td;
            assert!(plan(&s).is_err(), "{what} must fail the task");
        }
        let bad_keys = PathBuf::from("/srv/omarchy/secrets/keys.txt");
        let colon_keys = PathBuf::from("/srv/omarchy:/x/agent.env");
        let deny_flag = ["--privileged".to_owned()];
        let deny_word = ["example.org".to_owned()];
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
            (
                "worker image tag",
                Box::new(|s| s.worker_image = "ghcr.io/firemanxbr/omarchy-worker:latest"),
            ),
            ("worker image empty", Box::new(|s| s.worker_image = "")),
            ("slot outside the range", Box::new(|s| s.slot = 4096)),
        ];
        for (what, change) in cases {
            let mut s = spec(Kind::Build, &tdir, &rel);
            change(&mut s);
            assert!(plan(&s).is_err(), "{what} must fail the task");
        }
        for deny in [&deny_flag[..], &deny_word[..]] {
            let mut s = spec(Kind::Build, &tdir, &rel);
            s.deny = deny;
            assert!(plan(&s).is_err(), "{deny:?} must fail the task");
        }
        for keys in [&bad_keys, &colon_keys] {
            let mut s = spec(Kind::Audit, &tdir, &rel);
            s.agent = Some(Agent {
                env_file: keys,
                calls: 1,
                tokens: 1,
                wall_s: 1,
            });
            assert!(plan(&s).is_err(), "{} must fail the task", keys.display());
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
        assert!(gen_ok(GEN) && !gen_ok("g_0123456789ABCDEF") && !gen_ok("0123456789abcdef"));
        assert!(digest_ok(DIGEST) && digest_ok(&format!("sha256:{}", "a".repeat(64))));
        assert!(digest_ok(WORKER));
        assert!(
            !digest_ok("archlinux:latest")
                && !digest_ok("x@sha512:00")
                && !digest_ok(&format!("@sha256:{}", "a".repeat(64)))
        );
        assert_eq!(
            lease_of_name("omarchy-task-812-g_0123456789abcdef"),
            Some((812, GEN.into()))
        );
        assert_eq!(
            lease_of_name("/omarchy-task-812-g_0123456789abcdef"),
            Some((812, GEN.into()))
        );
        assert_eq!(lease_of_name("omarchy-build-812"), None);
        assert_eq!(
            lease_of_name("omarchy-task-812-g_0123456789abcdef-egress"),
            None
        );
        assert_eq!(
            owner_of_name("omarchy-task-812-g_0123456789abcdef-egress"),
            Some((812, GEN.into()))
        );
        assert_eq!(
            owner_of_name("/omarchy-task-812-g_0123456789abcdef-agent"),
            Some((812, GEN.into()))
        );
        assert_eq!(
            owner_of_name("omarchy-task-0-g_0123456789abcdef-egress"),
            Some((0, GEN.into()))
        );
        assert_eq!(owner_of_name("omarchy-task-812-g_0123456789abcdef-x"), None);
        let n = subnets();
        assert_eq!(n.slots(), 4096);
        assert_eq!(n.slot(0).unwrap().cidr(), "10.231.0.0/28");
        assert_eq!(n.slot(17).unwrap().cidr(), "10.231.1.16/28");
        assert_eq!(n.slot(17).unwrap().egress_ip(), "10.231.1.18");
        assert_eq!(n.slot(17).unwrap().agent_ip(), "10.231.1.19");
        assert_eq!(slot_of(n, "10.231.1.16/28"), Some(17));
        assert_eq!(n.slot(4096), None);
        for bad in [
            "10.231.0.1/16",
            "10.231.0.0/29",
            "10.231.0.0/7",
            "fd00::/48",
            "10.231.0.0",
        ] {
            assert!(Subnets::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_probe_runs_one_shot_on_a_network_of_its_own() {
        let p = Probe {
            gen: GEN,
            host: "h_studio-1",
            worker_image: WORKER,
            subnets: subnets(),
            slot: 9,
            gateway: Gateway::Isolated,
            deny: &[],
            env_file: env_file(),
        };
        let (setup, run) = probe_plan(&p).unwrap();
        let mut all = setup.clone();
        all.push(run.clone());
        check_plan(&all, Path::new("/srv/omarchy/work"), false)
            .unwrap_or_else(|e| panic!("{e}\n{all:#?}"));
        assert_eq!(run[..3], ["run", "--rm", "--name"]);
        assert_eq!(run.last().unwrap(), "--probe");
        assert!(setup[0]
            .iter()
            .any(|x| x == "omarchy-task-0-g_0123456789abcdef"));
    }

    /// The internal network's gateway, per engine: docker's isolated mode, podman's without DNS (its
    /// own CLI's flag, which the engine says to libpod's API behind docker's CLI); a signed
    /// exception's bridge keeps its gateway, its way out.
    #[test]
    fn the_gateway_is_no_address_of_the_host_where_the_engine_can_say_so() {
        let (tdir, rel, _) = dirs();
        for (gateway, flags) in [
            (
                Gateway::Isolated,
                &["-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated"][..],
            ),
            (Gateway::NoDns, &["--disable-dns"][..]),
        ] {
            let mut s = spec(Kind::Build, &tdir, &rel);
            s.gateway = gateway;
            let p = plan(&s).unwrap();
            let sub = p[0].iter().position(|x| x == "--subnet").unwrap();
            assert_eq!(p[0][2], "--internal");
            assert_eq!(p[0][3..sub], *flags, "{gateway:?}");
            s.direct = true;
            let p = plan(&s).unwrap();
            assert_eq!(
                p[0][2], "--subnet",
                "{gateway:?}: a bridge keeps its gateway"
            );
        }
    }

    /// The reader itself: each thing the spec forbids, added to a good plan, is refused.
    #[test]
    #[allow(clippy::too_many_lines)] // one case per thing the spec forbids
    fn the_check_refuses_what_the_spec_forbids() {
        let (tdir, rel, work) = dirs();
        let good = plan(&spec(Kind::ModelBuild, &tdir, &rel)).unwrap();
        check_plan(&good, &work, false).unwrap();
        let at = |p: &[Vec<String>], suffix: &str| {
            p.iter()
                .position(|c| {
                    matches!(c[0].as_str(), "create" | "run")
                        && c.iter()
                            .any(|x| x.ends_with(suffix) && x.starts_with(NAME_PREFIX))
                })
                .unwrap()
        };
        // Inserts flags just before a container's image.
        let with = |which: &str, extra: &[&str]| {
            let mut p = good.clone();
            let i = if which.is_empty() {
                p.len() - 1
            } else {
                at(&p, which)
            };
            let c = &mut p[i];
            let image_at = c.iter().position(|x| x == DIGEST || x == WORKER).unwrap();
            for (k, x) in extra.iter().enumerate() {
                c.insert(image_at + k, (*x).to_owned());
            }
            p
        };
        let tdir_s = tdir.display().to_string();
        let mut forbidden: Vec<Vec<Vec<String>>> = vec![
            with("", &["-v", "/var/run/docker.sock:/var/run/docker.sock"]),
            with("", &["-v", "/srv/omarchy/work:/work"]),
            with("", &["-v", "/srv/omarchy/work/state:/state:ro"]),
            with("", &["-v", &format!("{}:/task/other", tdir_s.replace("812-", "813-"))]),
            with("", &["-v", &format!("{tdir_s}/agent:/task/usage")]),
            with("", &["-e", "OMARCHY_WORKER_TOKEN=omw_x"]),
            with("", &["-e", "ANTHROPIC_API_KEY=sk-ant"]),
            with("", &["-e", "GITHUB_TOKEN=ghp_x"]),
            with("", &["-e", "PATH=/tmp"]),
            with("", &["-e", "HTTPS_PROXY=http://10.0.0.1:3128"]),
            with("", &["--cap-add", "SYS_ADMIN"]),
            with("", &["--cap-add", "NET_RAW"]),
            with("", &["--privileged"]),
            with("", &["--network", "host"]),
            with("", &["--device", "/dev/kvm"]),
            with("", &["--rm"]),
            with("", &["--security-opt", "seccomp=unconfined"]),
            with("", &["--user", "0"]),
            with("", &["--label", "x=y"]),
            with("", &["--log-driver", "json-file"]),
            with("", &["--ip", "10.231.0.52"]),
            with("-egress", &["-v", "/var/run/docker.sock:/var/run/docker.sock"]),
            with("-egress", &["-e", "OMARCHY_WORKER_TOKEN=omw_x"]),
            with("-egress", &["-v", "/srv/omarchy/secrets/agent.env:/run/omarchy/agent.env:ro"]),
            with("-egress", &["--mount", "type=bind,source=/srv/omarchy/secrets/agent.env,target=/run/omarchy/agent.env,readonly"]),
            with("", &["--mount", "type=bind,source=/srv/omarchy/secrets/agent.env,target=/x,readonly"]),
            with("-agent", &["--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock"]),
            with("-agent", &["-v", "/srv/omarchy/secrets/agent.env:/run/omarchy/agent.env:ro"]),
            with("-egress", &["--cap-add", "NET_ADMIN"]),
            with("-agent", &["-v", "/var/run/docker.sock:/var/run/docker.sock"]),
            with("-agent", &["-e", "OMARCHY_WORKER_TOKEN=omw_x"]),
            with("-agent", &["-e", "FACTORY_TOKEN=omw_x"]),
            with("-agent", &["-v", "/srv/omarchy/work/state:/state"]),
            with("-agent", &["--privileged"]),
        ];
        // A task container on another network, or attached to the shared bridge.
        let mut other_net = good.clone();
        let last = other_net.len() - 1;
        let n = other_net[last]
            .iter()
            .position(|x| x == "--network")
            .unwrap();
        other_net[last][n + 1] = "bridge".into();
        forbidden.push(other_net);
        let mut joins = good.clone();
        joins.push(vec![
            "network".into(),
            "connect".into(),
            "--ip".into(),
            "10.231.0.50".into(),
            EGRESS_NETWORK.into(),
            "omarchy-task-812-g_0123456789abcdef".into(),
        ]);
        forbidden.push(joins);
        let mut joins_task_net = good.clone();
        joins_task_net.push(vec![
            "network".into(),
            "connect".into(),
            "--ip".into(),
            "10.231.0.50".into(),
            "omarchy-task-812-g_0123456789abcdef".into(),
            "omarchy-dispatcher".into(),
        ]);
        forbidden.push(joins_task_net);
        // A network that is not internal, outside the range, or a second agent.
        let mut open = good.clone();
        open[0].retain(|x| x != "--internal");
        forbidden.push(open);
        let mut wide = good.clone();
        let sub = wide[0].iter().position(|x| x == "--subnet").unwrap() + 1;
        wide[0][sub] = "10.0.0.0/8".into();
        forbidden.push(wide);
        // An internal network whose gateway is the host's address, or with another option.
        let mut host_gw = good.clone();
        let o = host_gw[0].iter().position(|x| x == "-o").unwrap();
        host_gw[0].drain(o..o + 2);
        forbidden.push(host_gw);
        let mut other_opt = good.clone();
        other_opt[0][o + 1] = "com.docker.network.bridge.gateway_mode_ipv4=nat".into();
        forbidden.push(other_opt);
        let mut second = good.clone();
        let agent = second[at(&second, "-agent")].clone();
        second.insert(1, agent);
        forbidden.push(second);
        for p in forbidden {
            assert!(
                check_plan(&p, &work, false).is_err(),
                "must be refused: {p:#?}"
            );
        }
        let mut no_drop = good.clone();
        let last = no_drop.len() - 1;
        let i = no_drop[last]
            .iter()
            .position(|x| x == "--cap-drop")
            .unwrap();
        no_drop[last].drain(i..i + 2);
        assert!(check_plan(&no_drop, &work, false).is_err());
        let mut tag = good.clone();
        let last = tag.len() - 1;
        let i = tag[last].iter().position(|x| x == DIGEST).unwrap();
        tag[last][i] = "archlinux:base-devel".into();
        assert!(check_plan(&tag, &work, false).is_err());
        let mut agent_url = good.clone();
        let last = agent_url.len() - 1;
        let j = agent_url[last]
            .iter()
            .position(|x| x.starts_with("ANTHROPIC_BASE_URL="))
            .unwrap();
        agent_url[last][j] = "ANTHROPIC_BASE_URL=https://api.anthropic.com".into();
        assert!(check_plan(&agent_url, &work, false).is_err());
    }

    // ---------- a pool job's helpers (#340) ----------

    /// The ring's image the scripts pin (tests/images.env), by digest.
    const ARCH_BASE: &str = "docker.io/library/archlinux:base@sha256:b944cc65c5f28665dfd5fdbf5ed2997c88f5bb4a0aefac7ee8a7ef01893e5ed9";

    fn helper<'a>(dir: &'a Path, scratch: &'a Path, script: &'a str, ro: bool) -> Helper<'a> {
        Helper {
            task: 812,
            gen: GEN,
            host: "h_studio-1",
            arch: "x86_64",
            image: ARCH_BASE,
            dir,
            scratch,
            read_only: ro,
            script,
            keyring: ro.then_some("archlinux"),
            cpus: 1,
            mem_gb: 2,
            worker_image: WORKER,
            subnets: subnets(),
            slot: 7,
            gateway: Gateway::Isolated,
            deny: &[],
        }
    }

    fn helper_calls(h: &Helper<'_>) -> Vec<Vec<String>> {
        let (mut setup, run) = helper_plan(h).unwrap();
        setup.push(run);
        setup
    }

    #[test]
    fn every_helper_the_scripts_start_renders_inside_the_spec() {
        let (tdir, _, work) = dirs();
        let scratch = tdir.join("tmp");
        let dir = scratch.join("tmp.Ab3dE5gH9k");
        // The health check's (and a trial's), read-only; the ABI gate's references, writable; the
        // enqueue's PKGBUILD reader (reconcile.rs: it sources recipes, package code), read-only, no keyring.
        for (script, ro, keyring) in [
            ("check.sh", true, Some("archlinux")),
            ("export.sh", false, None),
            ("build.sh", false, None),
            ("meta.sh", true, None),
        ] {
            let p = helper_calls(&Helper {
                keyring,
                ..helper(&dir, &scratch, script, ro)
            });
            check_plan(&p, &work, false).unwrap_or_else(|e| panic!("{script}: {e}\n{p:#?}"));
            let run = p.last().unwrap();
            let has = |s: &str| run.iter().any(|x| x == s);
            assert!(
                !has("--rm") && !has("-d") && !has("--privileged"),
                "{run:?}"
            );
            assert_eq!(value(run, "--platform"), Some("linux/amd64"));
            assert_eq!(
                value(run, "--network"),
                Some("omarchy-task-812-g_0123456789abcdef"),
                "the job's own internal network"
            );
            assert_eq!(
                (value(run, "--cpus"), value(run, "--memory")),
                (Some("0.900"), Some("1984m")),
                "the job's unit, less its egress sidecar's"
            );
            assert_eq!(
                run[run.len() - 2..],
                ["bash".to_owned(), format!("/repo/{script}")]
            );
            // No token, no socket, no host path but its own scratch directory.
            let all = run.join(" ");
            assert!(!all.contains("omj.") && !all.contains("omw_") && !all.contains(".sock"));
            assert_eq!(
                run.iter().filter(|x| *x == "-v").count(),
                1,
                "one mount: {run:?}"
            );
        }
    }

    fn value<'a>(a: &'a [String], f: &str) -> Option<&'a str> {
        a.iter()
            .position(|x| x == f)
            .and_then(|i| a.get(i + 1))
            .map(String::as_str)
    }

    #[test]
    fn a_helpers_network_and_egress_sidecar_are_a_tasks_and_never_a_bridge() {
        // A pool job's helper runs package code: on the same slot it gets the very internal network
        // and egress sidecar a task gets, held to the fixture install's egress probe shares (#373).
        // A signed exception's bridge is a package's build, never a helper's, whatever the owner's
        // envelope grants (`direct_network`): `Helper` has no such field, and its plan is internal.
        let (tdir, rel, work) = dirs();
        let scratch = tdir.join("tmp");
        let dir = scratch.join("tmp.Ab3dE5gH9k");
        let own = ["203.0.113.10".to_owned()];
        let mut s = spec(Kind::Build, &tdir, &rel);
        s.deny = &own;
        let task = plan(&s).unwrap();
        let helper = helper_calls(&Helper {
            slot: s.slot,
            deny: &own,
            ..helper(&dir, &scratch, "check.sh", true)
        });
        check_plan(&helper, &work, false).unwrap_or_else(|e| panic!("{e}\n{helper:#?}"));
        assert_eq!(helper[..4], task[..4], "the network and the egress sidecar");
        let want = egress_fixture(&[
            ("{name}", "omarchy-task-812-g_0123456789abcdef-egress"),
            (
                "{labels}",
                "--label com.omarchy.task=812 --label org.omarchy-pool.task.gen=g_0123456789abcdef --label org.omarchy-pool.agent.host=h_studio-1 --label org.omarchy-pool.task.role=egress",
            ),
            ("{out}", EGRESS_NETWORK),
            ("{image}", WORKER),
            ("{ip}", "10.231.0.50"),
            ("{net}", "omarchy-task-812-g_0123456789abcdef"),
            ("{deny}", "--deny 10.231.0.0/16 --deny 203.0.113.10"),
        ]);
        assert_eq!(helper[1..4], want[..]);
        assert!(check_plan(&helper, &work, true).is_err(), "never a bridge");
    }

    #[test]
    #[allow(clippy::too_many_lines)] // one case per line, as rustfmt lays them out
    fn a_helper_value_outside_the_grammar_runs_nothing() {
        let (tdir, _, _) = dirs();
        let scratch = tdir.join("tmp");
        let dir = scratch.join("tmp.Ab3dE5gH9k");
        let base = helper(&dir, &scratch, "check.sh", true);
        assert!(helper_plan(&base).is_ok());
        let other = tdir.join("in");
        let deep = scratch.join("a/b");
        let root = PathBuf::from("/");
        let quoted = scratch.join("tmp.a:b");
        let task_dir_itself = tdir.clone();
        for (what, h) in [
            (
                "a tag",
                Helper {
                    image: "docker.io/library/archlinux:base",
                    ..base.clone()
                },
            ),
            (
                "another arch",
                Helper {
                    arch: "riscv64",
                    ..base.clone()
                },
            ),
            (
                "a script with a path",
                Helper {
                    script: "../x.sh",
                    ..base.clone()
                },
            ),
            (
                "a script that is not .sh",
                Helper {
                    script: "check",
                    ..base.clone()
                },
            ),
            (
                "a keyring with a space",
                Helper {
                    keyring: Some("arch linux"),
                    ..base.clone()
                },
            ),
            (
                "another keyring",
                Helper {
                    keyring: Some("omarchy"),
                    ..base.clone()
                },
            ),
            (
                "the task dir's own in/",
                Helper {
                    dir: &other,
                    ..base.clone()
                },
            ),
            (
                "a directory deeper down",
                Helper {
                    dir: &deep,
                    ..base.clone()
                },
            ),
            (
                "the root",
                Helper {
                    dir: &root,
                    ..base.clone()
                },
            ),
            (
                "a colon",
                Helper {
                    dir: &quoted,
                    ..base.clone()
                },
            ),
            (
                "the task dir, where the token is",
                Helper {
                    dir: &task_dir_itself,
                    ..base.clone()
                },
            ),
            (
                "task 0",
                Helper {
                    task: 0,
                    ..base.clone()
                },
            ),
            (
                "a generation",
                Helper {
                    gen: "g_1",
                    ..base.clone()
                },
            ),
            (
                "a slot outside the range",
                Helper {
                    slot: 1 << 20,
                    ..base.clone()
                },
            ),
            (
                "a worker image by tag",
                Helper {
                    worker_image: "ghcr.io/x/y:latest",
                    ..base.clone()
                },
            ),
            (
                "no share",
                Helper {
                    cpus: 0,
                    ..base.clone()
                },
            ),
        ] {
            assert!(helper_plan(&h).is_err(), "{what} must be refused");
        }
    }

    #[test]
    fn the_check_refuses_a_helper_outside_the_spec() {
        let (tdir, _, work) = dirs();
        let scratch = tdir.join("tmp");
        let dir = scratch.join("tmp.Ab3dE5gH9k");
        let good = helper_calls(&helper(&dir, &scratch, "check.sh", true));
        check_plan(&good, &work, false).unwrap();
        let with = |extra: &[&str]| {
            let mut p = good.clone();
            let last = p.len() - 1;
            let at = p[last].iter().position(|x| x == ARCH_BASE).unwrap();
            for (k, x) in extra.iter().enumerate() {
                p[last].insert(at + k, (*x).to_owned());
            }
            p
        };
        let tdir_s = tdir.display().to_string();
        let mut forbidden = vec![
            with(&["-v", "/var/run/docker.sock:/var/run/docker.sock"]),
            with(&["-v", &format!("{tdir_s}:/job")]),
            with(&["-e", "OMARCHY_TOKEN=omj.x"]),
            with(&["-e", "OMARCHY_API=https://pkgs.omarchy-pool.org"]),
            with(&["-e", "KEYRING=a b"]),
            with(&["-e", "KEYRING=omw_0123"]),
            with(&["--cap-add", "SYS_ADMIN"]),
            with(&["--privileged"]),
            with(&["--rm"]),
            with(&["-d"]),
            with(&["--network", "bridge"]),
            with(&["--label", "x=y"]),
        ];
        // Its mount anywhere but its job's scratch: the task dir (the token file), another lease's.
        for m in [
            format!("{tdir_s}:/repo:ro"),
            format!("{}/tmp/tmp.x:/repo", tdir_s.replace("812-", "813-")),
            "/srv/omarchy/work/jobs:/repo".to_owned(),
        ] {
            let mut p = good.clone();
            let last = p.len() - 1;
            let i = p[last].iter().position(|x| x == "-v").unwrap();
            p[last][i + 1] = m;
            forbidden.push(p);
        }
        // Another command, a tag.
        let mut cmd = good.clone();
        let last = cmd.len() - 1;
        *cmd[last].last_mut().unwrap() = "-c".into();
        forbidden.push(cmd);
        let mut tag = good.clone();
        let i = tag[last].iter().position(|x| x == ARCH_BASE).unwrap();
        tag[last][i] = "docker.io/library/archlinux:base".into();
        forbidden.push(tag);
        // Beside a task container: a lease runs one or the other.
        let (rel, task_dir) = (work.join("releases/v1.2.3"), tdir.clone());
        let mut beside = plan(&spec(Kind::Build, &task_dir, &rel)).unwrap();
        beside.push(good[good.len() - 1].clone());
        forbidden.push(beside);
        for p in forbidden {
            assert!(
                check_plan(&p, &work, false).is_err(),
                "must be refused: {p:#?}"
            );
        }
    }

    #[test]
    fn a_helper_is_its_jobs_lease_by_its_name() {
        assert_eq!(
            owner_of_name("omarchy-task-812-g_0123456789abcdef-helper"),
            Some((812, GEN.to_owned()))
        );
    }
}
