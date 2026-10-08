//! `etc/dispatcher.env` (#321, #371; design v2 §4.2, §9.4, §9.5, §12): the dispatcher's
//! `env_file` in the host set, the agent's alone to write, mode 0600; and beside it the host
//! worker token's own file (#327, design v2 §14, D15).
//!
//! The token is `run/host/dispatcher/token` in the set directory ([`TOKEN_FILE`]), mode 0400
//! in directories only the agent may enter, written by the enrollment and by every rotation
//! ([`crate::enroll::write_worker_token`]) and by nothing else. The host set mounts it
//! read-only into the dispatcher and names it in `OMARCHY_WORKER_TOKEN_FILE`, so the token is
//! in no container's environment, which anyone who can talk to the engine's socket reads
//! with `docker inspect`. The env file keeps:
//!
//! - the `# worker:` line: the registration the token belongs to (agent.toml's `worker_id`);
//! - `OMARCHY_WORKER_TOKEN` only while a release from before #327 is applied or staged here
//!   ([`older_release_here`]): its template reads the token from this file alone, so the
//!   agent keeps it here too until that release is gone (a rollback to one puts it back,
//!   and a rollback statement's `agent_to` puts it back before the agent moves down, the
//!   agent below being one that may write no such line); once none is left the next
//!   refresh takes it out, and that change recreates the dispatcher, as any change of an
//!   input does;
//! - `OMARCHY_HOST_ADDRESSES`: the host's own addresses ([`addresses`]), which every task's
//!   egress sidecar refuses besides the private ranges;
//! - `OMARCHY_SECRETS_DIR`: the directory install chose (agent.toml's `set.secrets_dir`),
//!   whose `agent.env` the dispatcher names in an agent sidecar's read-only mount; the
//!   dispatcher never mounts it nor opens it (the template's `environment` gives it the
//!   same path from agent.toml);
//! - `OMARCHY_AGENT_CALLS_PER_TASK`, `…_TOKENS_PER_TASK`, `…_MINUTES_PER_TASK` and
//!   `…_CALLS_PER_DAY`: the envelope's `agent_budget`, each only when agent.toml sets it,
//!   so an envelope without one leaves the dispatcher's defaults;
//! - `OMARCHY_DIRECT_NETWORK=1`, only when the envelope grants a signed exception's bridge
//!   network (`direct_network`, #373), which install's egress probe then checked: without
//!   it the dispatcher hands a package with `network = "direct"` in `factory/sizing` back;
//! - `OMARCHY_CACHE_PACMAN_GB` and `OMARCHY_CACHE_BUILD_GB`: the envelope's `cache_caps`
//!   (#341, design v2 §12, D52), each only when agent.toml sets it, so the dispatcher's
//!   defaults hold otherwise — the task caches it prunes to them;
//! - `OMARCHY_AGENT_USER=<uid>:<gid>` ([`KeysUser`], #399): who the agent sidecars and the
//!   probe run as — the owner of `OMARCHY_SECRETS_DIR/agent.env` as the engine shows it to a
//!   container. The file stays 0600 and the sidecars keep every capability dropped, so only
//!   its owner reads it: the agent's own uid on a rootful engine (and in a Mac's VM, whose
//!   shared directory shows the Mac's uid), root on a rootless one (whose root is the agent's
//!   user). A remapped daemon shows the owner to no container user — its remapped uids are
//!   none of the host's, and its sidecars stay remapped as its task containers do (design v2
//!   §19.1) — so there `OMARCHY_AGENT_HELD=userns-remap` instead: the dispatcher runs no probe
//!   and no agent sidecar, and the host's page says why it takes no model kinds (how a
//!   remapped host reads the keys is the maintainer's to decide). Rendered from the file's
//!   owner (its directory's before there is one) and agent.toml's `set.engine` and
//!   `envelope.userns_remap`, so an agent of a release with this fix writes it within a minute
//!   and the dispatcher is recreated with it, with no person at the host.
//!
//! It is written on install, on enrollment, on every rotation, and by the run loop when the
//! host's addresses or agent.toml changed (it reads both every minute, agent.toml only when
//! it is the agent's own as design v2 §12 says, and asks the pool's edge for the public
//! address every hour, within minutes after no answer), and when a round stages a release
//! ([`refresh_token`]). A rotation keeps the rest, a change of address never touches the
//! token, and every line the agent does not own — an owner's own variable, a comment — is
//! kept as it was. Every writer holds `etc/` locked (an advisory `flock` on the directory)
//! from its read to its last rename, so a refresh never puts back a token a rotation in
//! another process just replaced. Both files are made only with a token: before the owner's
//! Confirm there is none, and the run loop holds the dispatcher while one it needs is
//! missing. Both are inputs of the set, so a file that changed — a rotation above all —
//! recreates the dispatcher at the next round, and only the dispatcher: its tasks run on and
//! it re-adopts them (design v2§9.8).
//!
//! An `OMARCHY_WORKER_TOKEN` line found here is the newest token there is — one the agent of
//! an older release wrote, before the upgrade or after a self-update it rolled back — so the
//! token file takes it (the move of an existing host, which loses no token), and the line
//! stays only while an older release needs it. The agent's own writes keep that true when
//! one stops half-way (a crash, a kill, a full disk): a new token goes into an env line before
//! its file whenever a line, or another registration's `# worker:` line, could be left
//! behind ([`token_steps`]).

pub mod addresses;

#[cfg(test)]
mod tests;

use std::io::Read as _;
use std::os::fd::OwnedFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

pub use addresses::{Range, Sources};

use crate::install::net::{self, Cidr};
use crate::lint::Engine;

/// The host worker token's variable: an older release's dispatcher reads it here (#327).
pub const TOKEN: &str = "OMARCHY_WORKER_TOKEN";
/// The host worker token's file in the set directory (#327): the dispatcher's own secret
/// file, which the host set mounts read-only (`lint::token_file_of("dispatcher")`).
pub const TOKEN_FILE: &str = "run/host/dispatcher/token";
/// The host's own addresses, comma-separated: what the egress sidecars refuse besides the private ranges.
pub const ADDRESSES: &str = "OMARCHY_HOST_ADDRESSES";
/// The secrets directory: a path only.
pub const SECRETS_DIR: &str = "OMARCHY_SECRETS_DIR";
/// `1` when the envelope grants a signed exception's bridge network (#373); absent otherwise.
pub const DIRECT_NETWORK: &str = "OMARCHY_DIRECT_NETWORK";
/// Who the agent sidecars run as (#399): `<uid>:<gid>`, agent.env's owner as the engine shows it.
pub const AGENT_USER: &str = "OMARCHY_AGENT_USER";
/// Why the host takes no model kinds though it has keys (#399): a code, [`HELD_REMAP`].
pub const AGENT_HELD: &str = "OMARCHY_AGENT_HELD";
/// A remapped daemon: no container user is agent.env's owner, and the sidecars stay remapped.
pub const HELD_REMAP: &str = "userns-remap";
/// The group a sidecar that is not root takes for a keys file of root's group: none of the host's
/// privileged ones (`nogroup`), which a 0600 file does not need.
const NOGROUP: u32 = 65_534;
/// `[envelope].agent_budget`'s keys, and the variables the dispatcher reads them from (D45).
pub const BUDGET: [(&str, &str); 4] = [
    ("calls_per_task", "OMARCHY_AGENT_CALLS_PER_TASK"),
    ("tokens_per_task", "OMARCHY_AGENT_TOKENS_PER_TASK"),
    ("minutes_per_task", "OMARCHY_AGENT_MINUTES_PER_TASK"),
    ("calls_per_day", "OMARCHY_AGENT_CALLS_PER_DAY"),
];

/// `[envelope].cache_caps`' keys, and the variables the dispatcher reads them from (#341, D52).
pub const CACHE_CAPS: [(&str, &str); 2] = [
    ("pacman_gb", "OMARCHY_CACHE_PACMAN_GB"),
    ("build_gb", "OMARCHY_CACHE_BUILD_GB"),
];
/// No cache cap is larger: a value past it is a typo, not a disk.
const MAX_CACHE_GB: u64 = 1 << 20;

/// The registration the token belongs to: what install puts in agent.toml's `worker_id`.
pub const WORKER: &str = "# worker: ";
const HEADER: &str = "# The dispatcher's environment (omarchy-agent, #321, #371, #327, #341, #399): the registration of its host worker token, the host's own addresses, and from agent.toml alone the secrets directory, the agent budget, the grant of a signed exception's bridge, the cache caps and who the agent sidecars run as, or why none runs (a line of yours for one of those is replaced); the token itself is run/host/dispatcher/token, a read-only file (here too only while an older release needs it). The agent renders its own lines and keeps every other one.";
/// Every heading the agent wrote: this one, #371's and #327's (which said less), and the
/// first one #321's wrote, before there was more than the token.
const OLD_HEADERS: [&str; 2] = [
    "# The dispatcher's environment (omarchy-agent",
    "# The host worker token (omarchy-agent",
];
/// No env file of the agent's is longer.
const MAX_LEN: u64 = 64 << 10;

/// A key the agent renders whose value is no secret: the journal need not scrub it.
pub(crate) fn not_secret(key: &str) -> bool {
    key == ADDRESSES || owned_by_envelope(key)
}

fn owned_by_envelope(key: &str) -> bool {
    key == SECRETS_DIR
        || key == DIRECT_NETWORK
        || key == AGENT_USER
        || key == AGENT_HELD
        || BUDGET.iter().any(|(_, k)| *k == key)
        || CACHE_CAPS.iter().any(|(_, k)| *k == key)
}

/// The envelope's agent budget (design v2 §12, D45); `None` leaves the dispatcher's default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Budget {
    pub calls_per_task: Option<u32>,
    pub tokens_per_task: Option<u64>,
    pub minutes_per_task: Option<u64>,
    pub calls_per_day: Option<u32>,
}

impl Budget {
    /// `[envelope].agent_budget`: a table of the four keys, each a whole number from 1 (an
    /// agent sidecar's caps have no "unlimited"; an owner who wants no model work gives no
    /// agent keys); no table leaves every default. A key it does not know is refused: a
    /// typo would leave a default the owner did not mean.
    pub fn from_envelope(budget: Option<&toml::Value>) -> Result<Self, String> {
        let Some(v) = budget else {
            return Ok(Self::default());
        };
        let t = v
            .as_table()
            .ok_or("agent.toml: envelope.agent_budget is not a table")?;
        if let Some(k) = t.keys().find(|k| !BUDGET.iter().any(|(n, _)| n == k)) {
            return Err(format!(
                "agent.toml: envelope.agent_budget.{k} is none of {}",
                BUDGET.map(|(n, _)| n).join(", ")
            ));
        }
        let get = |k: &str, max: u64| -> Result<Option<u64>, String> {
            t.get(k)
                .map(|v| {
                    v.as_integer()
                        .and_then(|i| u64::try_from(i).ok())
                        .filter(|n| (1..=max).contains(n))
                        .ok_or_else(|| {
                            format!("agent.toml: envelope.agent_budget.{k} must be a whole number from 1 to {max}")
                        })
                })
                .transpose()
        };
        let calls =
            |k: &str| get(k, u64::from(u32::MAX)).map(|n| n.and_then(|n| u32::try_from(n).ok()));
        Ok(Self {
            calls_per_task: calls("calls_per_task")?,
            tokens_per_task: get("tokens_per_task", u64::MAX)?,
            // The dispatcher counts a sidecar's wall time in seconds.
            minutes_per_task: get("minutes_per_task", u64::MAX / 60)?,
            calls_per_day: calls("calls_per_day")?,
        })
    }

    fn lines(&self) -> Vec<String> {
        let values = [
            self.calls_per_task.map(u64::from),
            self.tokens_per_task,
            self.minutes_per_task,
            self.calls_per_day.map(u64::from),
        ];
        BUDGET
            .iter()
            .zip(values)
            .filter_map(|((_, var), v)| v.map(|v| format!("{var}={v}")))
            .collect()
    }
}

/// The envelope's caps of the dispatcher's task caches in GB (#341, design v2 §12, D52);
/// `None` leaves the dispatcher's default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheCaps {
    pub pacman_gb: Option<u64>,
    pub build_gb: Option<u64>,
}

impl CacheCaps {
    /// `[envelope].cache_caps`: a table of `pacman_gb` and `build_gb`, each a whole number of
    /// GB from 1; no table leaves both defaults. A key it does not know is refused: a typo
    /// would leave a default the owner did not mean.
    pub fn from_envelope(caps: Option<&toml::Value>) -> Result<Self, String> {
        let Some(v) = caps else {
            return Ok(Self::default());
        };
        let t = v
            .as_table()
            .ok_or("agent.toml: envelope.cache_caps is not a table")?;
        if let Some(k) = t.keys().find(|k| !CACHE_CAPS.iter().any(|(n, _)| n == k)) {
            return Err(format!(
                "agent.toml: envelope.cache_caps.{k} is none of {}",
                CACHE_CAPS.map(|(n, _)| n).join(", ")
            ));
        }
        let get = |k: &str| -> Result<Option<u64>, String> {
            t.get(k)
                .map(|v| {
                    v.as_integer()
                        .and_then(|i| u64::try_from(i).ok())
                        .filter(|n| (1..=MAX_CACHE_GB).contains(n))
                        .ok_or_else(|| {
                            format!("agent.toml: envelope.cache_caps.{k} must be a whole number of GB from 1 to {MAX_CACHE_GB}")
                        })
                })
                .transpose()
        };
        Ok(Self {
            pacman_gb: get("pacman_gb")?,
            build_gb: get("build_gb")?,
        })
    }

    fn lines(&self) -> Vec<String> {
        CACHE_CAPS
            .iter()
            .zip([self.pacman_gb, self.build_gb])
            .filter_map(|((_, var), v)| v.map(|v| format!("{var}={v}")))
            .collect()
    }
}

/// What agent.toml gives the file: the secrets directory, the agent budget, the grant of a
/// signed exception's bridge and the task caches' caps, and the task subnets, whose container
/// bridges' addresses are not the host's own to refuse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub secrets_dir: PathBuf,
    pub budget: Budget,
    /// `[envelope].direct_network` (#373): absent is no grant.
    pub direct_network: bool,
    /// `[envelope].cache_caps` (#341).
    pub cache_caps: CacheCaps,
    pub(crate) task_subnets: Vec<Cidr>,
    /// The engine behind the socket (`set.engine`) and whether its daemon remaps users
    /// (`[envelope].userns_remap`): how it shows agent.env's owner to a container (#399).
    pub engine: Engine,
    pub userns_remap: bool,
}

/// Who the agent sidecars and the probe run as (#399): `OMARCHY_SECRETS_DIR/agent.env`'s
/// owner as the engine shows it to a container. The file is 0600, and root with every
/// capability dropped — as the sidecars run — opens no file another uid owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeysUser {
    /// `OMARCHY_AGENT_USER=<uid>:<gid>`: the sidecars run as the owner, in the engine's own user
    /// namespace.
    Owner { uid: u32, gid: u32 },
    /// `OMARCHY_AGENT_HELD=<code>`: no container user may be the owner here, so the dispatcher
    /// runs no probe and no agent sidecar, and the host's page says why.
    Held(&'static str),
}

impl KeysUser {
    /// The owner `(uid, gid)` of the keys file on this machine, as `engine` shows it to a
    /// container; `euid` is the agent's own. `None` where no container user is that owner on an
    /// engine that would show it one — a rootless engine and a file another user owns — so the
    /// dispatcher starts the sidecars as before, and the probe says whose the file is.
    pub fn of(owner: (u32, u32), engine: Engine, userns_remap: bool, euid: u32) -> Option<Self> {
        let (uid, gid) = owner;
        match engine {
            // Its root is its user, the agent's: the file the agent wrote is root's in there.
            Engine::Rootless => (uid == euid).then_some(Self::Owner { uid: 0, gid: 0 }),
            // Its remapped uids are none of the host's, so none is the owner; leaving the
            // remapping (`--userns host`) would land a sidecar escape on the agent's own user
            // rather than a subuid, which design v2 §19.1 does not allow: held, for a maintainer.
            Engine::Rootful if userns_remap => Some(Self::Held(HELD_REMAP)),
            // Uids as the host has them; a Mac's VM shows the Mac's in its shared directories.
            // A sidecar that is not root takes no root group: the host's, on a rootful engine.
            Engine::Rootful => Some(Self::Owner {
                uid,
                gid: if uid != 0 && gid == 0 { NOGROUP } else { gid },
            }),
        }
    }

    /// Of the host now: agent.env's owner, or its directory's before there is one (the agent
    /// writes the file as itself, there).
    fn of_host(e: &Envelope) -> Option<Self> {
        let meta = std::fs::metadata(e.secrets_dir.join("agent.env"))
            .or_else(|_| std::fs::metadata(&e.secrets_dir))
            .ok()?;
        Self::of(
            (meta.uid(), meta.gid()),
            e.engine,
            e.userns_remap,
            crate::install::files::euid(),
        )
    }

    fn line(self) -> String {
        match self {
            Self::Owner { uid, gid } => format!("{AGENT_USER}={uid}:{gid}"),
            Self::Held(code) => format!("{AGENT_HELD}={code}"),
        }
    }
}

/// `set.engine` (`rootless`, or `rootful` and absent as the strict case), a Quadlet host's
/// rootless when it names none; and `[envelope].userns_remap`, a boolean, absent as false.
fn engine_of(t: &toml::Table) -> Result<(Engine, bool), String> {
    let set = t.get("set");
    let word = |k: &str| set.and_then(|s| s.get(k)).and_then(toml::Value::as_str);
    let engine = match (word("engine"), word("driver")) {
        (Some("rootless"), _) | (None, Some("quadlet")) => Engine::Rootless,
        _ => Engine::Rootful,
    };
    let remap = match t.get("envelope").and_then(|e| e.get("userns_remap")) {
        None => false,
        Some(v) => v
            .as_bool()
            .ok_or("agent.toml: envelope.userns_remap is neither true nor false")?,
    };
    Ok((engine, remap))
}

/// `[envelope].direct_network`: true or false, absent as false; anything else is refused, as
/// a value the owner did not mean.
fn direct_network(envelope: Option<&toml::Value>) -> Result<bool, String> {
    match envelope.and_then(|e| e.get("direct_network")) {
        None => Ok(false),
        Some(v) => v
            .as_bool()
            .ok_or_else(|| "agent.toml: envelope.direct_network is neither true nor false".into()),
    }
}

/// The task subnets agent.toml names (install's default when it names none); a value that
/// does not read leaves only the private ranges for a bridge's addresses (the dispatcher
/// refuses to start on it anyway).
fn task_subnets(value: Option<&str>) -> Vec<Cidr> {
    net::parse_list(value.unwrap_or(crate::install::TASK_SUBNETS)).unwrap_or_default()
}

impl Envelope {
    /// From agent.toml's text: `set.secrets_dir`, `envelope.agent_budget`,
    /// `envelope.direct_network`, `envelope.cache_caps` and `envelope.task_subnets`, nothing
    /// else (the enrollment reads it where the run loop's stricter configuration does not
    /// apply).
    pub fn from_agent_toml(text: &str) -> Result<Self, String> {
        let t: toml::Table = toml::from_str(text).map_err(|e| format!("agent.toml: {e}"))?;
        let secrets_dir = t
            .get("set")
            .and_then(|s| s.get("secrets_dir"))
            .and_then(toml::Value::as_str)
            .map(PathBuf::from)
            .ok_or("agent.toml: set.secrets_dir is missing")?;
        let envelope = t.get("envelope");
        let budget = Budget::from_envelope(envelope.and_then(|e| e.get("agent_budget")))?;
        let (engine, userns_remap) = engine_of(&t)?;
        Ok(Self {
            secrets_dir,
            budget,
            direct_network: direct_network(envelope)?,
            cache_caps: CacheCaps::from_envelope(envelope.and_then(|e| e.get("cache_caps")))?,
            task_subnets: task_subnets(
                envelope
                    .and_then(|e| e.get("task_subnets"))
                    .and_then(toml::Value::as_str),
            ),
            engine,
            userns_remap,
        })
    }

    /// The run loop's configuration's, as it read agent.toml.
    pub(crate) fn of_config(cfg: &crate::run::config::Config) -> Self {
        Self {
            secrets_dir: cfg.secrets_dir.clone(),
            budget: cfg.agent_budget,
            direct_network: cfg.direct_network,
            cache_caps: cfg.cache_caps,
            task_subnets: task_subnets(cfg.task_subnets.as_deref()),
            engine: cfg.engine,
            userns_remap: cfg.envelope.userns_remap,
        }
    }

    /// `<data>/agent.toml`'s, when there is one: `None` before install wrote it. It is
    /// trusted as the run loop's configuration is (design v2 §12): a symbolic link, a file
    /// another user owns or one others may write is refused, not read.
    pub fn of_data_dir(data: &Path) -> Option<Result<Self, String>> {
        match read(&data.join("agent.toml")) {
            Ok(Some((text, _))) => Some(Self::from_agent_toml(&text)),
            Ok(None) => None,
            Err(e) => Some(Err(e)),
        }
    }
}

/// A path the dispatcher takes for `OMARCHY_SECRETS_DIR` (its `spec::path_ok`): absolute,
/// plain, of letters, digits and `/ . _ - +` — nothing an env file could read otherwise.
pub fn dispatcher_path(p: &Path) -> bool {
    p.is_absolute()
        && p.components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && p.to_str().is_some_and(|s| {
            s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'.' | b'_' | b'-' | b'+'))
        })
}

/// What the agent renders into the file besides the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub addresses: Vec<Range>,
    /// `None` before agent.toml exists (the enrollment of a first install): the file's own
    /// lines for the secrets directory and the budget stay as they are.
    pub envelope: Option<Envelope>,
    /// The token here too, as `OMARCHY_WORKER_TOKEN`: a release from before #327 is applied
    /// or staged ([`older_release_here`]).
    pub plain: bool,
    /// Who the agent sidecars run as, or why none runs (#399), with the envelope's lines:
    /// `None` leaves the dispatcher's default, the worker image's user.
    pub keys_user: Option<KeysUser>,
}

impl Rendered {
    /// The host's addresses now (its interfaces', the public one last seen), with `envelope`,
    /// whether a release here still reads the token from the file, and agent.env's owner as
    /// the engine shows it.
    pub fn now(sources: &Sources, data: &Path, envelope: Option<Envelope>) -> Self {
        let task = envelope
            .as_ref()
            .map_or_else(|| task_subnets(None), |e| e.task_subnets.clone());
        Self {
            addresses: addresses::detect(sources, data, &task),
            keys_user: envelope.as_ref().and_then(KeysUser::of_host),
            envelope,
            plain: older_release_here(data),
        }
    }

    /// Its lines, `KEY=value` as the dispatcher reads them; none of them is a secret.
    pub fn lines(&self) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        // No address at all (no interface list on this system): the key is left out, an
        // empty value being no list the dispatcher reads.
        if !self.addresses.is_empty() {
            out.push(format!(
                "{ADDRESSES}={}",
                addresses::joined(&self.addresses)
            ));
        }
        if let Some(e) = &self.envelope {
            if !dispatcher_path(&e.secrets_dir) {
                return Err(format!(
                    "the secrets directory {} is not a path of letters, digits and / . _ - + : the dispatcher names its agent.env in a sidecar's mount and refuses any other",
                    e.secrets_dir.display()
                ));
            }
            out.push(format!("{SECRETS_DIR}={}", e.secrets_dir.display()));
            out.extend(e.budget.lines());
            if e.direct_network {
                out.push(format!("{DIRECT_NETWORK}=1"));
            }
            out.extend(e.cache_caps.lines());
            out.extend(self.keys_user.map(KeysUser::line));
        }
        Ok(out)
    }
}

/// Whether a release on this host — the one applied (`last-good/`) or one a round staged —
/// has a template that reads the host worker token from `etc/dispatcher.env` rather than from
/// its file (#327): one from before it, whose dispatcher an older agent may also start
/// again. A template that cannot be read counts as one of those: the token stays.
pub fn older_release_here(data: &Path) -> bool {
    let paths = crate::run::config::Paths {
        data: data.to_path_buf(),
    };
    [paths.last_good("host"), paths.staging("host")].iter().any(
        |dir| match std::fs::read_to_string(dir.join("compose.yml")) {
            Ok(t) => !crate::lint::reads_token_file(&t),
            Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        },
    )
}

/// `existing` (the file's text; empty for none) rendered again: the `# worker:` line a new
/// `worker`'s or the file's own, the token as `OMARCHY_WORKER_TOKEN` only when `plain` gives
/// it (an older release's dispatcher reads it there), and the agent's other lines from `r` —
/// or, with no `r`, as the file has them (a round that only puts the token in or takes it
/// out); then every line it does not own, in their order and as they were.
pub fn render(
    existing: &str,
    worker: Option<&str>,
    plain: Option<&str>,
    r: Option<&Rendered>,
) -> Result<String, String> {
    let mut worker_line = None;
    let (mut kept, mut others) = (Vec::new(), Vec::new());
    let keep_envelope = r.is_none_or(|r| r.envelope.is_none());
    for line in existing.lines() {
        let t = line.trim_start();
        if t == HEADER || OLD_HEADERS.iter().any(|h| t.starts_with(h)) {
            // The agent's own heading, written anew.
            continue;
        }
        if t.starts_with(WORKER) {
            worker_line = worker_line.or(Some(line));
            continue;
        }
        let key = (!t.starts_with('#'))
            .then(|| line.split_once('=').map(|(k, _)| k.trim()))
            .flatten();
        match key {
            // Written from `plain` alone: its file holds it (#327).
            Some(TOKEN) => {}
            // Rendered from the host, unless there is nothing to render it from.
            Some(ADDRESSES) => {
                if r.is_none() {
                    kept.push(line);
                }
            }
            Some(k) if owned_by_envelope(k) => {
                if keep_envelope {
                    kept.push(line);
                }
            }
            _ => others.push(line),
        }
    }
    let mut out = vec![HEADER.to_owned()];
    match worker {
        Some(w) => out.push(format!("{WORKER}{w}")),
        None => out.extend(worker_line.map(str::to_owned)),
    }
    if let Some(t) = plain {
        out.push(format!("{TOKEN}={t}"));
    }
    if let Some(r) = r {
        out.extend(r.lines()?);
    }
    out.extend(kept.into_iter().chain(others).map(str::to_owned));
    Ok(out.join("\n") + "\n")
}

/// The token file of the set whose `etc/dispatcher.env` is `env`.
pub fn token_path(env: &Path) -> Result<PathBuf, String> {
    env.parent()
        .filter(|etc| etc.file_name() == Some("etc".as_ref()))
        .and_then(Path::parent)
        .map(token_path_in)
        .ok_or_else(|| format!("{}: not a set's etc/dispatcher.env", env.display()))
}

/// The token file in a set directory.
pub fn token_path_in(set_dir: &Path) -> PathBuf {
    set_dir.join(TOKEN_FILE)
}

/// A token as a file and an env line can carry it: one word of printable ASCII, no quote
/// and no `#` (the pool mints `omw_` and 48 hex digits; tests and older files hold others).
fn plain_token(t: &str) -> bool {
    (1..=512).contains(&t.len())
        && t.bytes()
            .all(|b| b.is_ascii_graphic() && !matches!(b, b'"' | b'\'' | b'#' | b'\\'))
}

/// The `OMARCHY_WORKER_TOKEN` line's value, when the file has one with a value; one that is
/// not a token stops the writer, which never drops a token it cannot move.
fn token_line(text: &str, path: &Path) -> Result<Option<String>, String> {
    let Some(v) = text.lines().find_map(|l| {
        l.split_once('=')
            .filter(|(k, _)| !k.trim_start().starts_with('#') && k.trim() == TOKEN)
            .map(|(_, v)| v.trim())
    }) else {
        return Ok(None);
    };
    if v.is_empty() {
        return Ok(None);
    }
    if !plain_token(v) {
        return Err(format!(
            "{}: its {TOKEN} is not a token the agent can move to {TOKEN_FILE}: fix the line or remove it",
            path.display()
        ));
    }
    Ok(Some(v.to_owned()))
}

/// The token file's token and mode; `None` when there is none. Read as the env file is: a
/// link, another user's file or one others may write is refused.
pub fn read_token(path: &Path) -> Result<Option<(String, u32)>, String> {
    let Some((text, mode)) = read(path)? else {
        return Ok(None);
    };
    let t = text.trim();
    if !plain_token(t) {
        return Err(format!(
            "{}: holds no host worker token (one token on one line)",
            path.display()
        ));
    }
    Ok(Some((t.to_owned(), mode)))
}

/// The token file written: `run/host/dispatcher/` made 0700 where it is missing, the file
/// 0400, replacing one that is the agent's own (never a link or another user's file).
fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("the token file: no directory")?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("the token file: no name")?;
    crate::install::files::make_dir(dir)?;
    crate::install::files::write(dir, name, format!("{token}\n").as_bytes(), 0o400)
}

/// A file's text and mode (this one's, agent.toml's), read without following a symbolic
/// link; `None` when there is no file. One that is not the agent's own (a link, a
/// directory, another user's or one others may write) is refused.
pub fn read(path: &Path) -> Result<Option<(String, u32)>, String> {
    use rustix::fs::{Mode, OFlags};
    let fd = match rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(rustix::io::Errno::LOOP) => {
            return Err(format!(
                "{}: a symbolic link; refused, not followed",
                path.display()
            ))
        }
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let f = std::fs::File::from(fd);
    let meta = f
        .metadata()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{}: not a regular file", path.display()));
    }
    if let Some(why) = crate::install::files::foreign(path, &meta) {
        return Err(why);
    }
    let mut text = String::new();
    f.take(MAX_LEN + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if text.len() as u64 > MAX_LEN {
        return Err(format!(
            "{}: longer than {} KiB",
            path.display(),
            MAX_LEN >> 10
        ));
    }
    Ok(Some((text, meta.mode() & 0o7777)))
}

/// `etc/` locked for one writer, until the returned descriptor is dropped: an advisory
/// `flock` on the directory itself, so no lock file appears among the set's inputs. `None`
/// when there is no `etc/` (nor a file in it).
fn lock(path: &Path) -> Result<Option<OwnedFd>, String> {
    use rustix::fs::{FlockOperation, Mode, OFlags};
    let dir = path.parent().ok_or("dispatcher.env: no directory")?;
    let fd = match rustix::fs::open(
        dir,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    loop {
        match rustix::fs::flock(&fd, FlockOperation::LockExclusive) {
            Ok(()) => return Ok(Some(fd)),
            Err(rustix::io::Errno::INTR) => {}
            Err(e) => return Err(format!("{}: locking it: {e}", dir.display())),
        }
    }
}

/// Both files written by a refresh, which keeps the token it found: the env file first when
/// it carries the token too, else the token file first. Wherever the writer stops between
/// them, an env line left behind holds the token the file holds or gets, never an older one.
fn put(env: &Path, text: &str, file: Option<(&Path, &str)>, plain: bool) -> Result<(), String> {
    if plain {
        crate::host::replace(env, text.as_bytes())?;
    }
    if let Some((path, token)) = file {
        write_token_file(path, token)?;
    }
    if !plain {
        crate::host::replace(env, text.as_bytes())?;
    }
    Ok(())
}

/// One write of a new token's: the env file with this text, or the token file.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Step {
    Env(String),
    File,
}

/// The registration the env file's `# worker:` line names.
fn worker_line(text: &str) -> Option<&str> {
    text.lines()
        .find_map(|l| l.trim_start().strip_prefix(WORKER))
        .map(str::trim)
}

/// The writes of a new token, in an order that, wherever the writer stops between two of
/// them (a crash, a kill, a full disk), leaves the new token on the host beside its own
/// registration, and never an older token in an env line, which a refresh takes for the
/// newest ([`sync`]) and would put back into the file:
/// - with an older release here (`r.plain`), the env file (its line the new token), then the
///   token file;
/// - when the env file already names this registration and holds no token line (a rotation
///   on a host past its move), the token file, then the env file;
/// - else (no env file yet at a first enrollment, another registration's, or an older
///   token's line: the minute before the refresh that takes it out, a suspended host), the
///   env file with this registration and the new token as its line, then the token file,
///   then the env file without the line.
fn token_steps(
    existing: Option<&str>,
    path: &Path,
    worker: &str,
    token: &str,
    r: &Rendered,
) -> Result<Vec<Step>, String> {
    let text = existing.unwrap_or_default();
    let last = render(text, Some(worker), r.plain.then_some(token), Some(r))?;
    if r.plain {
        return Ok(vec![Step::Env(last), Step::File]);
    }
    let settled = existing
        .is_some_and(|t| worker_line(t) == Some(worker) && matches!(token_line(t, path), Ok(None)));
    if settled {
        return Ok(vec![Step::File, Step::Env(last)]);
    }
    let first = render(text, Some(worker), Some(token), Some(r))?;
    Ok(vec![Step::Env(first), Step::File, Step::Env(last)])
}

fn apply(env: &Path, file: &Path, token: &str, step: &Step) -> Result<(), String> {
    match step {
        Step::Env(text) => crate::host::replace(env, text.as_bytes()),
        Step::File => write_token_file(file, token),
    }
}

/// A new host worker token (enrollment and every rotation): its file (0400), and the env
/// file with its registration and the rest rendered by `r` — the token there too only while
/// an older release needs it (`r.plain`), in the order [`token_steps`] gives. An env file
/// that is not the agent's own is replaced, never read.
pub fn write_token(path: &Path, worker: &str, token: &str, r: &Rendered) -> Result<(), String> {
    let file = token_path(path)?;
    if !plain_token(token) {
        return Err("a host worker token is one word of printable characters".into());
    }
    let _held = lock(path)?;
    let existing = read(path).ok().flatten().map(|(t, _)| t);
    for step in token_steps(existing.as_deref(), path, worker, token, r)? {
        apply(path, &file, token, &step)?;
    }
    Ok(())
}

/// What [`refresh`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refresh {
    /// The files already said this, with modes 0600 and 0400.
    Unchanged,
    Written,
    /// The token was in the env file and its file did not hold it (an upgrade from before
    /// #327, or an older agent's rotation): the file has it now.
    TokenMoved,
    /// No env file: no token yet (the owner has not confirmed the host), and none is made.
    NoFile,
}

/// The env file rendered again by `r`, its token and the owner's lines kept; written only
/// when that changes it (or its mode is not 0600), and the token file with it.
pub fn refresh(path: &Path, r: &Rendered) -> Result<Refresh, String> {
    sync(path, Some(r), r.plain)
}

/// The token put into the env file or taken out of it as `plain` says, every other line as
/// it is: a round that staged a release does this before it hashes the set's inputs, so a
/// rollback to a release from before #327 starts its dispatcher with the token where it
/// reads it; and so does the run loop before a rollback statement's `agent_to` moves the
/// agent down to run such a rollback.
pub fn refresh_token(path: &Path, plain: bool) -> Result<Refresh, String> {
    sync(path, None, plain)
}

fn sync(path: &Path, r: Option<&Rendered>, plain: bool) -> Result<Refresh, String> {
    let file = token_path(path)?;
    let Some(_held) = lock(path)? else {
        return Ok(Refresh::NoFile);
    };
    let Some((text, mode)) = read(path)? else {
        return Ok(Refresh::NoFile);
    };
    let held = read_token(&file)?;
    // An env line is the newest token there is (an older agent wrote it): the file takes it.
    let line = token_line(&text, path)?;
    let moved = line
        .as_ref()
        .is_some_and(|t| held.as_ref().is_none_or(|(h, _)| h != t));
    let token = line.or_else(|| held.as_ref().map(|(t, _)| t.clone()));
    let new = render(&text, None, token.as_deref().filter(|_| plain), r)?;
    let file_ok = !moved && held.as_ref().is_none_or(|(_, m)| *m == 0o400);
    if new == text && mode == 0o600 && file_ok {
        return Ok(Refresh::Unchanged);
    }
    let rewrite = token
        .as_deref()
        .filter(|_| !file_ok)
        .map(|t| (file.as_path(), t));
    put(path, &new, rewrite, plain)?;
    Ok(if moved {
        Refresh::TokenMoved
    } else {
        Refresh::Written
    })
}

/// Whether the host holds a host worker token of the pool's shape: in its file, or in the
/// env file where an agent from before #327 wrote it.
pub fn holds_token(env: &Path) -> bool {
    let valid = |t: &str| crate::enroll::valid_worker_token(t);
    token_path(env)
        .ok()
        .and_then(|f| read_token(&f).ok().flatten())
        .is_some_and(|(t, _)| valid(&t))
        || read(env)
            .ok()
            .flatten()
            .and_then(|(text, _)| token_line(&text, env).ok().flatten())
            .is_some_and(|t| valid(&t))
}

/// `omarchy-agent dispatcher-env [--write]`: the lines the agent renders now from
/// agent.toml (read as the run loop reads it) and the host; with `write`, the file
/// rendered again, as the run loop does.
pub fn command(
    data: &Path,
    sources: &Sources,
    write: bool,
) -> Result<(Vec<String>, Option<Refresh>), String> {
    let cfg =
        crate::run::config::Config::load(&data.join("agent.toml"), crate::install::files::euid())?;
    let r = Rendered::now(sources, data, Some(Envelope::of_config(&cfg)));
    let lines = r.lines()?;
    let written = if write {
        Some(refresh(&path_in(&cfg.set_dir), &r)?)
    } else {
        None
    };
    Ok((lines, written))
}

/// The file in a set directory.
pub fn path_in(set_dir: &Path) -> PathBuf {
    set_dir.join("etc").join("dispatcher.env")
}
