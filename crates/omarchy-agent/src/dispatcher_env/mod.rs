//! `etc/dispatcher.env` (#321, #371; design v2 §4.2, §9.4, §9.5, §12): the dispatcher's
//! `env_file` in the host set, the agent's alone to write, mode 0600. It holds:
//!
//! - `OMARCHY_WORKER_TOKEN` and its `# worker:` line: the host worker token, written by the
//!   enrollment and by every rotation ([`crate::enroll`]), and by nothing else;
//! - `OMARCHY_HOST_ADDRESSES`: the host's own addresses ([`addresses`]), which every task's
//!   egress sidecar refuses besides the private ranges;
//! - `OMARCHY_SECRETS_DIR`: the directory install chose (agent.toml's `set.secrets_dir`),
//!   whose `agent.env` the dispatcher names in an agent sidecar's read-only mount; the
//!   dispatcher never mounts it nor opens it (the template's `environment` gives it the
//!   same path from agent.toml);
//! - `OMARCHY_AGENT_CALLS_PER_TASK`, `…_TOKENS_PER_TASK`, `…_MINUTES_PER_TASK` and
//!   `…_CALLS_PER_DAY`: the envelope's `agent_budget`, each only when agent.toml sets it,
//!   so an envelope without one leaves the dispatcher's defaults.
//!
//! It is written on install, on enrollment, on every rotation, and by the run loop when the
//! host's addresses or agent.toml changed (it reads both every minute, and asks the pool's
//! edge for the public address every hour). A rotation keeps the rest, a change of address
//! never touches the token, and every line the agent does not own — an owner's own
//! variable, a comment — is kept as it was. Every writer holds `etc/` locked (an advisory
//! `flock` on the directory) from its read to its rename, so a refresh never puts back a
//! token a rotation in another process just replaced. The file is made only with a token:
//! before the owner's Confirm there is none, and the run loop holds the dispatcher while it
//! is missing. A file that changed is an input of the set, so the next round recreates the
//! dispatcher with it; its tasks run on.

pub mod addresses;

#[cfg(test)]
mod tests;

use std::io::Read as _;
use std::os::fd::OwnedFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

pub use addresses::{Range, Sources};

use crate::install::net::{self, Cidr};

/// The host worker token.
pub const TOKEN: &str = "OMARCHY_WORKER_TOKEN";
/// The host's own addresses, comma-separated: what the egress sidecars refuse besides the private ranges.
pub const ADDRESSES: &str = "OMARCHY_HOST_ADDRESSES";
/// The secrets directory: a path only.
pub const SECRETS_DIR: &str = "OMARCHY_SECRETS_DIR";
/// `[envelope].agent_budget`'s keys, and the variables the dispatcher reads them from (D45).
pub const BUDGET: [(&str, &str); 4] = [
    ("calls_per_task", "OMARCHY_AGENT_CALLS_PER_TASK"),
    ("tokens_per_task", "OMARCHY_AGENT_TOKENS_PER_TASK"),
    ("minutes_per_task", "OMARCHY_AGENT_MINUTES_PER_TASK"),
    ("calls_per_day", "OMARCHY_AGENT_CALLS_PER_DAY"),
];

/// The registration the token belongs to: what install puts in agent.toml's `worker_id`.
pub const WORKER: &str = "# worker: ";
const HEADER: &str = "# The dispatcher's environment (omarchy-agent, #321, #371): the host worker token (rotated every 30 days), the host's own addresses, the secrets directory and the agent budget; the agent renders its own lines and keeps every other one.";
/// The first line the agent of #321 wrote, before there was more than the token.
const OLD_HEADER: &str = "# The host worker token (omarchy-agent";
/// No env file of the agent's is longer.
const MAX_LEN: u64 = 64 << 10;

/// A key the agent renders whose value is no secret: the journal need not scrub it.
pub(crate) fn not_secret(key: &str) -> bool {
    key == ADDRESSES || key == SECRETS_DIR || BUDGET.iter().any(|(_, k)| *k == key)
}

fn owned_by_envelope(key: &str) -> bool {
    key == SECRETS_DIR || BUDGET.iter().any(|(_, k)| *k == key)
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

/// What agent.toml gives the file: the secrets directory and the agent budget, and the
/// task subnets, whose container bridges' addresses are not the host's own to refuse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub secrets_dir: PathBuf,
    pub budget: Budget,
    pub(crate) task_subnets: Vec<Cidr>,
}

/// The task subnets agent.toml names (install's default when it names none); a value that
/// does not read leaves only the private ranges for a bridge's addresses (the dispatcher
/// refuses to start on it anyway).
fn task_subnets(value: Option<&str>) -> Vec<Cidr> {
    net::parse_list(value.unwrap_or(crate::install::TASK_SUBNETS)).unwrap_or_default()
}

impl Envelope {
    /// From agent.toml's text: `set.secrets_dir`, `envelope.agent_budget` and
    /// `envelope.task_subnets`, nothing else (the enrollment reads it where the run loop's
    /// stricter configuration does not apply).
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
        Ok(Self {
            secrets_dir,
            budget,
            task_subnets: task_subnets(
                envelope
                    .and_then(|e| e.get("task_subnets"))
                    .and_then(toml::Value::as_str),
            ),
        })
    }

    /// The run loop's configuration's, as it read agent.toml.
    pub(crate) fn of_config(cfg: &crate::run::config::Config) -> Self {
        Self {
            secrets_dir: cfg.secrets_dir.clone(),
            budget: cfg.agent_budget,
            task_subnets: task_subnets(cfg.task_subnets.as_deref()),
        }
    }

    /// `<data>/agent.toml`'s, when there is one: `None` before install wrote it.
    pub fn of_data_dir(data: &Path) -> Option<Result<Self, String>> {
        let path = data.join("agent.toml");
        match std::fs::read_to_string(&path) {
            Ok(text) => Some(Self::from_agent_toml(&text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => Some(Err(format!("{}: {e}", path.display()))),
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
}

impl Rendered {
    /// The host's addresses now (its interfaces', the public one last seen), with `envelope`.
    pub fn now(sources: &Sources, data: &Path, envelope: Option<Envelope>) -> Self {
        let task = envelope
            .as_ref()
            .map_or_else(|| task_subnets(None), |e| e.task_subnets.clone());
        Self {
            addresses: addresses::detect(sources, data, &task),
            envelope,
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
        }
        Ok(out)
    }
}

/// `existing` (the file's text; empty for none) rendered again with `token` — a new
/// `(worker, token)`, or the file's own when `None` — and `r`: the agent's lines first, then
/// every line it does not own, in their order and as they were.
pub fn render(existing: &str, token: Option<(&str, &str)>, r: &Rendered) -> Result<String, String> {
    let (mut worker_line, mut token_line) = (None, None);
    let (mut kept, mut others) = (Vec::new(), Vec::new());
    for line in existing.lines() {
        let t = line.trim_start();
        if t == HEADER || t.starts_with(OLD_HEADER) {
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
            Some(TOKEN) => token_line = token_line.or(Some(line)),
            // Rendered from the host, always.
            Some(ADDRESSES) => {}
            Some(k) if owned_by_envelope(k) => {
                if r.envelope.is_none() {
                    kept.push(line);
                }
            }
            _ => others.push(line),
        }
    }
    let mut out = vec![HEADER.to_owned()];
    match token {
        Some((worker, token)) => {
            out.push(format!("{WORKER}{worker}"));
            out.push(format!("{TOKEN}={token}"));
        }
        None => out.extend(worker_line.into_iter().chain(token_line).map(str::to_owned)),
    }
    out.extend(r.lines()?);
    out.extend(kept.into_iter().chain(others).map(str::to_owned));
    Ok(out.join("\n") + "\n")
}

/// The file's text and mode, read without following a symbolic link; `None` when there is
/// no file. One that is not the agent's own (a link, a directory, another user's or one
/// others may write) is refused.
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

/// A new host worker token, with the rest rendered by `r` (enrollment and every rotation).
/// A file that is not the agent's own is replaced, never read.
pub fn write_token(path: &Path, worker: &str, token: &str, r: &Rendered) -> Result<(), String> {
    let _held = lock(path)?;
    let existing = read(path)
        .ok()
        .flatten()
        .map(|(t, _)| t)
        .unwrap_or_default();
    let text = render(&existing, Some((worker, token)), r)?;
    crate::host::replace(path, text.as_bytes())
}

/// What [`refresh`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refresh {
    /// The file already said this, with mode 0600.
    Unchanged,
    Written,
    /// No file: no token yet (the owner has not confirmed the host), and none is made.
    NoFile,
}

/// The file rendered again by `r`, its token and the owner's lines kept; written only when
/// that changes it (or its mode is not 0600).
pub fn refresh(path: &Path, r: &Rendered) -> Result<Refresh, String> {
    let Some(_held) = lock(path)? else {
        return Ok(Refresh::NoFile);
    };
    let Some((text, mode)) = read(path)? else {
        return Ok(Refresh::NoFile);
    };
    let new = render(&text, None, r)?;
    if new == text && mode == 0o600 {
        return Ok(Refresh::Unchanged);
    }
    crate::host::replace(path, new.as_bytes())?;
    Ok(Refresh::Written)
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
