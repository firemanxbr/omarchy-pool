//! Self-update (design v2 §16.3, v1 §11.3, D8; #316): the agent replaces itself, upward
//! only, A/B, with a health gate that counts every start and rolls back a hang.
//!
//! - **Only upward.** A verified bundle whose `agent.version` is strictly higher than this
//!   agent's (and than any version rolled back here) updates it, before the round touches
//!   anything; a bundle with a lower or equal agent changes nothing about the agent. Only
//!   a rollback statement's `agent_to` moves it down, through the same steps.
//! - **Download and self-test.** The binary the manifest lists for this platform, checked
//!   against its SHA-256, `chmod 0755` as `versions/<new>/omarchy-agent`, then
//!   `omarchy-agent self-test` must answer `ok` within 30 s.
//! - **Swap.** `pending` (`from`, `to`, `tries`, `deadline`) is written and synced, then
//!   `previous` and `current` are pointed (each an atomic rename of a new link), and the
//!   agent exits 0 for the service manager to start `current`.
//! - **Count every start.** [`count_start`] runs first in `run`, before agent.toml or
//!   state.json are read, on a one-line file: a build that panics while loading its
//!   configuration has counted its start. Its third start, or one past the deadline,
//!   points `current` back and exits.
//! - **Health gate.** The new agent touches no container until one verify + observe +
//!   report cycle passed: a cached bundle verifies, the engine answers, the pool answers
//!   or is explicitly unreachable. Then `pending` goes and the 3 newest versions stay.
//! - The agent it rolled back to records the version as skipped until a higher one and
//!   reports `agent-rollback`.
//!
//! Seams: soak and `agent.urgent` (P4); the unit file and launchd plist are written by
//! `install` (#317) — `omarchy-agent.service` beside this file is the unit it writes.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::manifest::AgentRelease;
use crate::verify::BundleOutcome;
use crate::version::{Release, Version};

use super::agent::{bundle_names, Agent, Verifier};
use super::config::{Config, Paths};
use super::driver::Answer;
use super::pool::Net;
use super::rollout::{self, Outcome};
use super::state::{self, write_atomic};
use super::target::Target;
use super::tools;

/// How long a new agent has to pass its health gate.
pub(crate) const DEADLINE_S: i64 = 600;
/// Starts a new agent may make without passing the gate; the next one rolls back.
pub(crate) const MAX_TRIES: u32 = 2;
/// The self-test answers within this.
const SELF_TEST: Duration = Duration::from_secs(30);
/// A self-update that failed before the swap (a download, a hash, a self-test) is tried
/// again after this.
pub(crate) const RETRY_S: i64 = 3600;
/// The gate's checks run at most this often while they fail.
const GATE_EVERY_S: i64 = 30;
/// Agent versions kept under `versions/`.
const KEEP: usize = 3;

/// The self-update in flight, one line in `pending`:
/// `from=0.2.0 to=0.3.0 tries=1 deadline=1800000600`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Pending {
    pub from: Version,
    pub to: Version,
    pub tries: u32,
    pub deadline: i64,
}

impl Pending {
    pub fn parse(text: &str) -> Option<Self> {
        let mut from = None;
        let mut to = None;
        let mut tries = None;
        let mut deadline = None;
        for part in text.split_whitespace() {
            let (k, v) = part.split_once('=')?;
            match k {
                "from" => from = Version::parse(v),
                "to" => to = Version::parse(v),
                "tries" => tries = v.parse().ok(),
                "deadline" => deadline = v.parse().ok(),
                _ => {}
            }
        }
        Some(Pending {
            from: from?,
            to: to?,
            tries: tries?,
            deadline: deadline?,
        })
    }

    pub fn render(&self) -> String {
        format!(
            "from={} to={} tries={} deadline={}\n",
            self.from, self.to, self.tries, self.deadline
        )
    }

    /// Why the gate was given up, for the report.
    fn why(&self) -> String {
        if self.tries > MAX_TRIES {
            format!("{} starts without passing its health gate", self.tries)
        } else {
            format!(
                "its health gate did not pass within {} minutes",
                DEADLINE_S / 60
            )
        }
    }
}

pub(crate) fn read_pending(data: &Path) -> Option<Pending> {
    Pending::parse(&fs::read_to_string(data.join("pending")).ok()?)
}

/// Points `link` (`current`, `previous`) at `versions/<v>`: a new link renamed over it.
fn point(data: &Path, link: &str, v: Version) -> Result<(), String> {
    let tmp = data.join(format!(".{link}.tmp"));
    let _ = fs::remove_file(&tmp);
    std::os::unix::fs::symlink(format!("versions/{v}"), &tmp)
        .and_then(|()| fs::rename(&tmp, data.join(link)))
        .map_err(|e| format!("{}: {e}", data.join(link).display()))
}

/// What the first lines of `run` decided.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Start {
    Run,
    /// `current` points at the previous agent again: exit for the service manager to
    /// start it.
    RolledBack(String),
}

/// The first lines of `run` (design v2 §16.3 step 4), before any configuration is read:
/// a start of the agent under test is counted in `pending`, and its third start, or one
/// past the deadline, points `current` back at the agent it replaced.
pub(crate) fn count_start(data: &Path, me: Version, now: i64) -> Start {
    let Some(mut p) = read_pending(data) else {
        return Start::Run;
    };
    if p.to != me {
        return Start::Run;
    }
    p.tries += 1;
    let counted = write_atomic(&data.join("pending"), p.render().as_bytes());
    if p.tries <= MAX_TRIES && now <= p.deadline {
        if let Err(e) = counted {
            eprintln!("omarchy-agent: this start could not be counted: {e}");
        }
        return Start::Run;
    }
    let why = format!("agent {}: {}", p.to, p.why());
    match point(data, "current", p.from) {
        Ok(()) => Start::RolledBack(format!("{why}; current points at {} again", p.from)),
        Err(e) => {
            eprintln!("omarchy-agent: {why}, but current cannot be pointed back: {e}");
            Start::Run
        }
    }
}

/// Whether this agent is the one a self-update in flight is testing.
pub(crate) fn candidate(data: &Path, me: Version) -> Option<Pending> {
    read_pending(data).filter(|p| p.to == me)
}

/// The candidate gives up on itself: `current` back at the agent it replaced.
pub(crate) fn flip_back(data: &Path, p: &Pending) -> Result<(), String> {
    point(data, "current", p.from)
}

/// `omarchy-agent self-test --release vX.Y.Z` (step 2): what a new agent must manage
/// before the old one hands over — agent.toml and state.json read, the release's bundle
/// as fetched verified, and its host set rendered and linted in memory (the plan's engine
/// half is the health gate's).
pub(crate) fn self_test(
    paths: &Paths,
    release: Release,
    verifier: &dyn Verifier,
) -> Result<(), String> {
    let uid = fs::metadata(&paths.data)
        .map_err(|e| format!("{}: {e}", paths.data.display()))?
        .uid();
    let cfg = Config::load(&paths.agent_toml(), uid)?;
    state::load(&paths.state())?;
    let (name, sig) = bundle_names(release);
    let read = |n: &str| {
        let p = paths.bundles().join(n);
        fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))
    };
    let b = match verifier.bundle(&read(&name)?, &read(&sig)?) {
        Ok(BundleOutcome::Current(b)) if Release(b.manifest().outer().release()) == release => b,
        Ok(BundleOutcome::Current(_)) => return Err(format!("{name} is not {release}")),
        Ok(BundleOutcome::NeedsNewerAgent { why, .. }) => return Err(format!("{name}: {why}")),
        Err(r) => return Err(format!("{name}: refused ({}): {r}", r.reason())),
    };
    let t = Target::from_bundle(&b, &cfg.set_name)?;
    rollout::dry_run(&cfg, &t)
}

/// `sd_notify` without libsystemd: one datagram to `$NOTIFY_SOCKET` (Linux; the unit is
/// `Type=notify` with `WatchdogSec`). Elsewhere, and with no socket, nothing.
pub(crate) fn notify(msg: &str) {
    #[cfg(target_os = "linux")]
    if let Some(socket) = std::env::var_os("NOTIFY_SOCKET") {
        notify_to(&socket, msg);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = msg;
}

#[cfg(target_os = "linux")]
fn notify_to(socket: &std::ffi::OsStr, msg: &str) {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::net::{SocketAddr, UnixDatagram};
    let Ok(s) = UnixDatagram::unbound() else {
        return;
    };
    let addr = match socket.as_bytes().strip_prefix(b"@") {
        Some(name) => SocketAddr::from_abstract_name(name),
        None => SocketAddr::from_pathname(socket),
    };
    if let Ok(addr) = addr {
        let _ = s.send_to_addr(msg.as_bytes(), &addr);
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

fn version_of_link(link: &Path) -> Option<Version> {
    Version::parse(fs::read_link(link).ok()?.file_name()?.to_str()?)
}

impl Agent {
    /// At start, after the state is loaded: a `pending` this agent is the candidate of
    /// opens its health gate; one this agent was swapped back to after counted starts is
    /// a rollback, recorded and reported; anything else is stale and goes.
    pub fn settle(&mut self, now: i64) -> Result<(), String> {
        let path = self.paths.pending();
        let Ok(text) = fs::read_to_string(&path) else {
            return Ok(());
        };
        let me = self.version;
        match Pending::parse(&text) {
            Some(p) if p.to == me => {
                self.journal.write(
                    now,
                    "agent-gate",
                    serde_json::json!({"from": p.from.to_string(), "to": me.to_string(), "start": p.tries}),
                );
                self.gate = Some(p);
                return Ok(());
            }
            Some(p) if p.from == me && p.tries > 0 => {
                let skip = self.state.agent_skip.map_or(p.to, |s| s.max(p.to));
                self.state.agent_skip = Some(skip);
                let detail = format!(
                    "agent {} was rolled back to {me} after {}; {} is skipped until a higher agent",
                    p.to,
                    p.why(),
                    p.to
                );
                rollout::report(
                    &mut self.state,
                    &self.journal,
                    now,
                    Outcome::AgentRollback,
                    None,
                    &detail,
                );
                state::save(&self.paths.state(), &self.state)?;
            }
            Some(p) if p.from == me => self.journal.write(
                now,
                "agent-update",
                serde_json::json!({"detail": format!("the update to {} did not complete; {me} stays", p.to)}),
            ),
            _ => self.journal.write(
                now,
                "agent-update",
                serde_json::json!({"detail": format!("a pending update this agent ({me}) is not part of: removed ({})", text.trim())}),
            ),
        }
        fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// One tick of the health gate (step 5); nothing else runs until it passes.
    pub(crate) fn gate_step(&mut self, now: i64) {
        let Some(p) = self.gate.clone() else {
            return;
        };
        if now > p.deadline {
            return self.give_up(&p, now, &p.why());
        }
        if now < self.gate_next {
            return;
        }
        self.gate_next = now + GATE_EVERY_S;
        match self.health(now) {
            Ok(()) => {
                if let Err(e) = fs::remove_file(self.paths.pending()) {
                    // Retried at the next tick: the gate stays shut until it is gone.
                    self.journal.write(
                        now,
                        "agent-gate",
                        serde_json::json!({"detail": format!("pending: {e}")}),
                    );
                    return;
                }
                self.gate = None;
                self.journal.write(
                    now,
                    "agent-updated",
                    serde_json::json!({"from": p.from.to_string(), "to": p.to.to_string(), "starts": p.tries}),
                );
                self.prune_versions(now);
            }
            Err(why) => self.journal.write(
                now,
                "agent-gate",
                serde_json::json!({"detail": why, "deadline": p.deadline}),
            ),
        }
    }

    /// The candidate's own rollback while it runs: the deadline passed in the gate.
    fn give_up(&mut self, p: &Pending, now: i64, why: &str) {
        let detail = match flip_back(&self.paths.data, p) {
            Ok(()) => format!("{why}; current points at {} again", p.from),
            Err(e) => format!("{why}; current cannot be pointed back: {e}"),
        };
        self.journal
            .write(now, "agent-rollback", serde_json::json!({"detail": detail}));
        self.gate = None;
        self.exit = Some(0);
    }

    /// verify + observe + report: a cached bundle (the target's, else the applied one's)
    /// verifies with this agent, the engine answers for `last-good/`, and the pool answers
    /// or is explicitly unreachable (every answer is one: calls time out).
    fn health(&mut self, now: i64) -> Result<(), String> {
        let cached = [self.state.target, self.state.applied]
            .into_iter()
            .flatten()
            .find(|r| self.paths.bundles().join(bundle_names(*r).0).exists());
        if let Some(r) = cached {
            if self.cached(r).is_none() {
                return Err(format!("the bundle of {r} does not verify with this agent"));
            }
        }
        if let Some((p, services)) = self.last_good_project() {
            let d = self
                .driver
                .as_deref_mut()
                .ok_or("the pinned tools are not installed")?;
            if let Answer::NoAnswer(e) = d.observe(&p, &services) {
                return Err(format!("the engine does not answer: {e}"));
            }
        }
        let last = match self.pool.follow(&self.cfg.worker_id) {
            Net::Ok(_) => "ok",
            Net::NoAnswer(_) => "no-answer",
            Net::Unauthorized(_) => "unauthorized",
        };
        self.state.poll.last = last.into();
        self.state.poll.last_at = now;
        Ok(())
    }

    /// Keeps `versions/` to the running agent, `previous` and the newest others, 3 in all.
    fn prune_versions(&self, now: i64) {
        let mut keep = vec![self.version];
        keep.extend(version_of_link(&self.paths.previous()));
        let Ok(dir) = fs::read_dir(self.paths.versions()) else {
            return;
        };
        let mut all: Vec<Version> = dir
            .flatten()
            .filter_map(|e| Version::parse(e.file_name().to_str()?))
            .collect();
        all.sort_unstable_by(|a, b| b.cmp(a));
        for v in all {
            if keep.contains(&v) {
                continue;
            }
            if keep.len() < KEEP {
                keep.push(v);
            } else {
                let dir = self.paths.versions().join(v.to_string());
                if let Err(e) = fs::remove_dir_all(&dir) {
                    self.journal.write(
                        now,
                        "agent-update",
                        serde_json::json!({"detail": format!("{}: {e}", dir.display())}),
                    );
                }
            }
        }
    }

    /// The upward rule (D8): a bundle shipping a higher agent than this one, and than any
    /// version rolled back here, updates it. `Ok(true)`: the swap is done and the agent
    /// exits after this tick; `Ok(false)`: no update now (skipped, or retried later).
    pub(crate) fn upgrade(
        &mut self,
        release: Release,
        ships: &AgentRelease,
        now: i64,
    ) -> Result<bool, String> {
        let want = ships.version();
        if want <= self.version {
            return Ok(false);
        }
        if let Some(skip) = self.state.agent_skip.filter(|s| want <= *s) {
            if self.announced != Some(want) {
                self.announced = Some(want);
                self.journal.write(
                    now,
                    "agent-skipped",
                    serde_json::json!({"version": want.to_string(), "detail": format!("agent {skip} was rolled back here; skipped until a higher one")}),
                );
            }
            return Ok(false);
        }
        self.move_agent(release, ships, now).map(|()| true)
    }

    /// The agent moved to what `ships` names, from `release`'s assets (steps 2 and 3).
    /// A failure is tried again after [`RETRY_S`], or at once after a restart.
    pub(crate) fn move_agent(
        &mut self,
        release: Release,
        ships: &AgentRelease,
        now: i64,
    ) -> Result<(), String> {
        let want = ships.version();
        if let Some((v, at)) = self.retry {
            if v == want && now < at + RETRY_S {
                return Err(format!(
                    "the update to agent {want} failed; tried again in {} s",
                    at + RETRY_S - now
                ));
            }
        }
        let result = self.download_test_swap(release, ships, now);
        match &result {
            Ok(()) => {
                self.journal.write(
                    now,
                    "agent-update",
                    serde_json::json!({"from": self.version.to_string(), "to": want.to_string(), "release": release.to_string()}),
                );
                self.exit = Some(0);
            }
            Err(e) => {
                self.retry = Some((want, now));
                self.journal.write(
                    now,
                    "agent-update",
                    serde_json::json!({"to": want.to_string(), "release": release.to_string(), "detail": format!("not updated: {e}")}),
                );
            }
        }
        result
    }

    fn download_test_swap(
        &mut self,
        release: Release,
        ships: &AgentRelease,
        now: i64,
    ) -> Result<(), String> {
        let want = ships.version();
        let platform = tools::platform().ok_or("this platform has no agent build")?;
        let asset = ships
            .asset(platform)
            .ok_or_else(|| format!("{release} ships no agent for {platform}"))?;
        // The way back must be there before anything moves: this agent installed as
        // install.sh installs it, and running from there.
        let mine = self.paths.binary(self.version);
        let running = self.exe.clone().unwrap_or_default();
        if !same_file(&running, &mine)
            || !same_file(&self.paths.current().join("omarchy-agent"), &mine)
        {
            return Err(format!(
                "self-update needs this agent to run as {} through {}, as install.sh installs it; it runs as {}",
                mine.display(),
                self.paths.current().display(),
                running.display()
            ));
        }
        let bin = self.paths.binary(want);
        let sha = hex::encode(asset.sha256().as_bytes());
        if tools::file_sha256(&bin).ok().as_deref() != Some(sha.as_str()) {
            if let Some(p) = &self.progress {
                p.store(super::now(), std::sync::atomic::Ordering::Relaxed);
            }
            let data = match self.pool.release_asset(release, asset.name()) {
                Net::Ok(d) => d,
                Net::NoAnswer(e) => return Err(format!("{}: {e}", asset.name())),
                Net::Unauthorized(s) => return Err(format!("{}: HTTP {s}", asset.name())),
            };
            let got = tools::sha256_hex(&data);
            if got != sha {
                return Err(format!(
                    "{}: SHA-256 {got}, not the {sha} that {release} lists; nothing was installed",
                    asset.name()
                ));
            }
            let dir = self.paths.versions().join(want.to_string());
            fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            write_atomic(&bin, &data)?;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("{}: {e}", bin.display()))?;
        }
        let mut c = Command::new(&bin);
        c.arg("self-test")
            .arg("--data")
            .arg(&self.paths.data)
            .args(["--release", &release.to_string()]);
        let o = super::exec::run(c, SELF_TEST).map_err(|e| format!("self-test: {e}"))?;
        if !o.ok() || o.stdout.trim() != "ok" {
            let said = format!("{}{}", o.stdout.trim(), o.stderr.trim());
            return Err(format!(
                "self-test of {want} failed (exit {:?}): {}",
                o.code,
                self.journal.scrub(&said)
            ));
        }
        let p = Pending {
            from: self.version,
            to: want,
            tries: 0,
            deadline: now + DEADLINE_S,
        };
        let data = self.paths.data.clone();
        write_atomic(&self.paths.pending(), p.render().as_bytes())?;
        let swapped =
            point(&data, "previous", self.version).and_then(|()| point(&data, "current", want));
        if let Err(e) = swapped {
            let _ = point(&data, "current", self.version);
            let _ = fs::remove_file(self.paths.pending());
            return Err(e);
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "selfupdate_tests.rs"]
mod tests;
