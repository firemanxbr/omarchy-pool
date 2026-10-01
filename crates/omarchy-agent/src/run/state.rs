//! `state.json` (design v2 §16.1, §16.2): what the agent knows across restarts — the trust
//! floor, the merged `min_release` and `revoked`, the last accepted rollback statement, the
//! rollout in flight, quarantines, the last round and the poll schedule.
//!
//! Written before each step acts, atomically (a temporary file, fsync, rename), so a
//! restart anywhere resumes where it was. Read leniently: unknown fields are ignored, so a
//! later agent's fields survive an older reader. A file that is there but unreadable is a
//! local error (exit 78), never "start from nothing", since that would forget the floor.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::version::Release;

/// The layout this agent writes; readers accept any (lenient).
pub const STATE_SCHEMA: u32 = 1;
/// state.json is small; anything larger is not one the agent wrote.
const MAX_STATE: u64 = 1 << 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub state_schema: u32,
    /// The agent version that last wrote the file.
    pub agent: String,
    /// The highest release this host applied successfully (design v2 §5.2), or the `to`
    /// of the last accepted rollback statement.
    pub floor: Option<Release>,
    /// The highest `min_release` of every verified manifest seen; never lowered.
    pub min_release: Option<Release>,
    /// The union of `revoked` of every verified manifest seen; never shrinks.
    pub revoked: BTreeSet<Release>,
    /// `seq` of the last accepted rollback statement.
    pub statement_seq: Option<u64>,
    /// The release whose set the host runs (`last-good/`).
    pub applied: Option<Release>,
    /// What the pool named last.
    pub target: Option<Release>,
    pub quarantine: BTreeMap<Release, Quarantine>,
    /// The last Update order (seen in `follow`) a round was started for.
    pub update_seen: Option<String>,
    /// The pinned tools in use: SHA-256 of the docker and compose downloads.
    pub tools: Option<ToolPins>,
    /// Images the agent pulled, by the release that named them (for pruning).
    pub pulled: BTreeMap<Release, Vec<String>>,
    pub rollout: Rollout,
    pub round: Round,
    pub poll: Poll,
}

impl Default for State {
    fn default() -> Self {
        State {
            state_schema: STATE_SCHEMA,
            agent: crate::AGENT_VERSION.to_owned(),
            floor: None,
            min_release: None,
            revoked: BTreeSet::new(),
            statement_seq: None,
            applied: None,
            target: None,
            quarantine: BTreeMap::new(),
            update_seen: None,
            tools: None,
            pulled: BTreeMap::new(),
            rollout: Rollout::default(),
            round: Round::default(),
            poll: Poll::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolPins {
    pub docker: String,
    pub compose: String,
}

/// A reverted release: not retried before `until`; `until: None` waits for a newer
/// release. An Update order lifts every quarantine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quarantine {
    pub until: Option<i64>,
    /// How many rounds of this release were reverted.
    pub reverts: u32,
}

/// The rollout in flight (design v2 §16.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Rollout {
    pub step: Step,
    /// When `step` began (unix seconds).
    pub since: i64,
    /// The release this round applies.
    pub target: Option<Release>,
    /// What ran when the round began.
    pub from: Option<Release>,
    /// The round goes down under an accepted rollback statement.
    pub rollback: bool,
    /// Why a round started (a new target, an Update order, a changed input, drift).
    pub why: String,
    /// The services the plan replaces.
    pub services: Vec<String>,
    /// Set while `last-good/` is applied after a failed guard: why it failed.
    pub reverting: Option<String>,
}

impl Default for Rollout {
    fn default() -> Self {
        Rollout {
            step: Step::Idle,
            since: 0,
            target: None,
            from: None,
            rollback: false,
            why: String::new(),
            services: Vec::new(),
            reverting: None,
        }
    }
}

/// Which files a replace creates from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Files {
    Staging,
    LastGood,
}

/// One phase of a replace: stop the old container, remove it, create the new one, wait
/// for its `/ready`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum Phase {
    Stop,
    Drain { since: i64 },
    Create { since: i64 },
    Ready { since: i64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Step {
    Idle,
    Render,
    Lint,
    Plan,
    Pull,
    Replace {
        files: Files,
        #[serde(flatten)]
        phase: Phase,
    },
    Guard(Guard),
    Commit,
    /// The guard (or the ready wait) failed: apply `last-good/` (a replace from it),
    /// then quarantine the release.
    Revert {
        why: String,
    },
}

impl Step {
    pub fn name(&self) -> &'static str {
        match self {
            Step::Idle => "idle",
            Step::Render => "render",
            Step::Lint => "lint",
            Step::Plan => "plan",
            Step::Pull => "pull",
            Step::Replace { .. } => "replace",
            Step::Guard(_) => "guard",
            Step::Commit => "commit",
            Step::Revert { .. } => "revert",
        }
    }
}

/// The guard's samples so far (design v2 §16.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Guard {
    pub started: i64,
    /// The container guarded, and its `RestartCount` when the guard began.
    pub container: String,
    pub restarts0: u64,
    /// Consecutive samples that found it restarting.
    pub streak: u32,
    pub last_sample: i64,
}

/// The last round's outcome, as reported (design v2 §17.2 `round`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Round {
    pub at: i64,
    pub outcome: String,
    /// For `rolled-back`: the release rolled back from.
    pub from: Option<Release>,
    pub step: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Poll {
    /// When the pool is asked next (unix seconds).
    pub next_at: i64,
    /// The current back-off after no answer, in seconds (0: none).
    pub backoff_s: i64,
    /// What the pool said last: `ok`, `no-answer`, `unauthorized`.
    pub last: String,
    pub last_at: i64,
}

/// Reads `state.json`: `Ok(None)` when there is none yet.
pub fn load(path: &Path) -> Result<Option<State>, String> {
    let bytes = match fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
        Ok(m) if m.len() > MAX_STATE => {
            return Err(format!("{}: larger than {MAX_STATE} bytes", path.display()))
        }
        Ok(_) => fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?,
    };
    parse(&bytes)
        .map(Some)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// The lenient parser `load` uses (and the fuzz target).
pub fn parse(bytes: &[u8]) -> Result<State, String> {
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}

/// Writes `state.json` atomically: a sibling temporary file, fsync, rename.
pub fn save(path: &Path, state: &State) -> Result<(), String> {
    let mut s = state.clone();
    s.state_schema = STATE_SCHEMA;
    crate::AGENT_VERSION.clone_into(&mut s.agent);
    let bytes = serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?;
    write_atomic(path, &bytes)
}

/// Replaces `path` with `bytes` so a reader sees the old or the new file, never half.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("{}: not a file path", path.display()))?;
    let tmp = path.with_file_name(format!(".{}.tmp", name.to_string_lossy()));
    let err = |e: std::io::Error| format!("{}: {e}", path.display());
    // A fresh file, never one a link at the temporary name points to (O_EXCL does not
    // follow it); the rename replaces a link at `path` rather than writing through it.
    match fs::remove_file(&tmp) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(err(e)),
        _ => {}
    }
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(err)?;
    f.write_all(bytes).map_err(err)?;
    f.sync_all().map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

#[cfg(test)]
pub(crate) use tests::tempdir;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::version::Version;

    #[test]
    fn round_trips_and_reads_leniently() {
        let dir = tempdir();
        let path = dir.join("state.json");
        assert_eq!(load(&path).unwrap(), None);
        let mut s = State {
            floor: Release::parse("v1.2.3"),
            ..State::default()
        };
        s.revoked.insert(Release(Version(1, 1, 0)));
        s.quarantine.insert(
            Release(Version(1, 3, 0)),
            Quarantine {
                until: Some(10),
                reverts: 1,
            },
        );
        s.rollout.step = Step::Replace {
            files: Files::Staging,
            phase: Phase::Drain { since: 5 },
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path).unwrap(), Some(s.clone()));
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"floor\": \"v1.2.3\""), "{text}");
        assert!(text.contains("\"phase\": \"drain\""), "{text}");

        // A later agent's fields are ignored; missing ones take their defaults.
        let later = r#"{"state_schema": 9, "floor": "v2.0.0", "new_thing": {"x": 1}}"#;
        let s = parse(later.as_bytes()).unwrap();
        assert_eq!(s.floor, Release::parse("v2.0.0"));
        assert_eq!(s.rollout.step, Step::Idle);
        // But a floor that is not a release is not "no floor".
        assert!(parse(br#"{"floor": "latest"}"#).is_err());
        fs::write(&path, b"{not json").unwrap();
        assert!(load(&path).is_err());
    }

    #[test]
    fn an_atomic_write_never_writes_through_a_link() {
        let dir = tempdir();
        let outside = dir.join("outside");
        fs::write(&outside, b"untouched").unwrap();
        // A link at the temporary name, and one at the destination.
        std::os::unix::fs::symlink(&outside, dir.join(".compose.yml.tmp")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("compose.yml")).unwrap();
        write_atomic(&dir.join("compose.yml"), b"new").unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"untouched");
        let meta = fs::symlink_metadata(dir.join("compose.yml")).unwrap();
        assert!(meta.file_type().is_file());
        assert_eq!(fs::read(dir.join("compose.yml")).unwrap(), b"new");
    }

    pub(crate) fn tempdir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "omarchy-agent-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
}
