//! `state.json` (design v2 §16.1, §16.2): what the agent knows across restarts — the trust
//! floor, the merged `min_release` and `revoked`, the last accepted rollback statement, the
//! rollout in flight, quarantines, the last round, the poll schedule, and the host orders
//! (#344): the ids taken, their answers and a `retire-legacy` in flight.
//!
//! Written before each step acts, atomically (a temporary file, fsync, rename), so a
//! restart anywhere resumes where it was. Read leniently (#316): unknown fields are
//! ignored, and a field this agent cannot read (a step or a quarantine a later agent
//! wrote) starts from its default, so the agent a self-update rolls back to, or a signed
//! `agent_to` moves down to, reads the state the newer one wrote. The trust fields are
//! the exception: a file that is there but whose floor, `min_release`, `revoked`,
//! `statement_seq` or `applied` cannot be read is a local error (exit 78), never "start
//! from nothing", since that would forget the floor.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::version::{Release, Version};

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
    /// The last Update order (seen in the host state) a round was started for.
    pub update_seen: Option<String>,
    /// The pinned tools in use: SHA-256 of the docker and compose downloads.
    pub tools: Option<ToolPins>,
    /// Images the agent pulled, by the release that named them (for pruning).
    pub pulled: BTreeMap<Release, Vec<String>>,
    pub rollout: Rollout,
    pub round: Round,
    pub poll: Poll,
    /// An agent version a self-update rolled back from: skipped until a higher one
    /// (design v2 §16.3).
    pub agent_skip: Option<Version>,
    /// The host orders (#344, design v2 §17.1).
    pub orders: Orders,
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
            agent_skip: None,
            orders: Orders::default(),
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

/// How many order ids the agent remembers (design v2 §17.1): an id among them is never
/// taken again, whatever the pool says.
pub const SEEN_RING: usize = 512;
/// How many answers the state keeps, and every report carries until they leave.
pub const ANSWERS_KEPT: usize = 8;

/// The host orders the agent took (#344): the ring of ids, the answers, a retire in flight.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Orders {
    /// The last [`SEEN_RING`] ids taken, host orders' and Updates' alike, oldest first.
    pub seen: VecDeque<String>,
    /// The last [`ANSWERS_KEPT`] answers, oldest first.
    pub answers: Vec<OrderAnswer>,
    /// The `retire-legacy` in flight: it runs to its end across ticks and restarts.
    pub retire: Option<Retire>,
}

impl Orders {
    pub fn seen(&self, id: &str) -> bool {
        self.seen.iter().any(|s| s == id)
    }

    /// Remembers `id`; the oldest leaves past [`SEEN_RING`].
    pub fn remember(&mut self, id: &str) {
        if !self.seen(id) {
            self.seen.push_back(id.to_owned());
        }
        while self.seen.len() > SEEN_RING {
            self.seen.pop_front();
        }
    }

    /// Keeps an answer; the oldest leaves past [`ANSWERS_KEPT`].
    pub fn answer(&mut self, a: OrderAnswer) {
        self.answers.retain(|x| x.id != a.id);
        self.answers.push(a);
        let extra = self.answers.len().saturating_sub(ANSWERS_KEPT);
        self.answers.drain(..extra);
    }
}

/// What the agent answered an order: `done`, `refused` or `failed`, with its words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderAnswer {
    pub id: String,
    pub kind: String,
    pub outcome: String,
    pub detail: String,
    pub at: i64,
}

/// A `retire-legacy` in flight: the recorded project, the directory its marker went into,
/// and how far it got. The marker is written before anything is stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Retire {
    pub order: String,
    pub project: String,
    pub dir: PathBuf,
    /// When it was taken: it fails past its time limit.
    pub since: i64,
    pub step: RetireStep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetireStep {
    /// Stopping the project's containers.
    Stop,
    /// Removing its containers, then its networks.
    Remove,
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
    let (state, dropped) = read(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    if !dropped.is_empty() {
        eprintln!(
            "{}: {} written by another agent version cannot be read here and start from their defaults",
            path.display(),
            dropped.join(", ")
        );
    }
    Ok(Some(state))
}

/// The fields a reader may leave at their default when it cannot read them: none of
/// them holds a trust decision. A dropped `rollout` is a round that starts again.
const LENIENT: &[&str] = &[
    "agent",
    "target",
    "quarantine",
    "update_seen",
    "tools",
    "pulled",
    "rollout",
    "round",
    "poll",
    "agent_skip",
    "orders",
];

/// The lenient parser `load` uses (and the fuzz target).
pub fn parse(bytes: &[u8]) -> Result<State, String> {
    read(bytes).map(|(s, _)| s)
}

/// The state, and the fields left at their default because this agent cannot read them.
fn read(bytes: &[u8]) -> Result<(State, Vec<String>), String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    // An object only: serde would read `[]` as a state with no floor.
    if !value.is_object() {
        return Err("not a JSON object".into());
    }
    let first = match serde_json::from_value::<State>(value.clone()) {
        Ok(s) => return Ok((s, Vec::new())),
        Err(e) => e.to_string(),
    };
    let serde_json::Value::Object(mut fields) = value else {
        return Err(first);
    };
    let mut dropped = Vec::new();
    fields.retain(|k, v| {
        let keep = !LENIENT.contains(&k.as_str())
            || serde_json::from_value::<State>(serde_json::json!({ k.as_str(): v })).is_ok();
        if !keep {
            dropped.push(k.clone());
        }
        keep
    });
    serde_json::from_value(serde_json::Value::Object(fields))
        .map(|s| (s, dropped))
        .map_err(|_| first)
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
    fn the_previous_agent_reads_a_state_json_a_newer_one_wrote() {
        // A newer agent's file: a later schema, new fields, a step and a quarantine this
        // agent has no word for. The trust fields are read; the rest starts from its
        // default (a round that starts again), and nothing is refused.
        let newer = br#"{
            "state_schema": 2, "agent": "0.9.0",
            "floor": "v1.4.0", "min_release": "v1.2.0", "revoked": ["v1.3.1"],
            "statement_seq": 3, "applied": "v1.4.0", "target": "v1.5.0",
            "quarantine": {"v1.5.0": {"until": null, "reverts": 1, "why": {"new": true}}},
            "rollout": {"step": {"state": "gate", "since": 5}, "target": "v1.5.0"},
            "round": {"outcome": "ok", "at": 7, "detail": "x", "trace": [1]},
            "poll": {"next_at": "soon"},
            "agent_skip": "0.8.0",
            "settings": {"profiles": ["build"]}
        }"#;
        let s = parse(newer).unwrap();
        assert_eq!(
            (s.floor, s.min_release, s.applied, s.statement_seq),
            (
                Release::parse("v1.4.0"),
                Release::parse("v1.2.0"),
                Release::parse("v1.4.0"),
                Some(3)
            )
        );
        assert!(s.revoked.contains(&Release(Version(1, 3, 1))));
        assert_eq!(s.rollout.step, Step::Idle);
        assert_eq!(s.round.outcome, "ok");
        assert_eq!(s.poll, Poll::default());
        assert_eq!(s.agent_skip, Version::parse("0.8.0"));
        assert_eq!(s.target, Release::parse("v1.5.0"));
        // The quarantine's extra field is ignored, not dropped.
        assert_eq!(s.quarantine.len(), 1);

        // But a trust field this agent cannot read is never "no floor".
        for bad in [
            r#"{"floor": {"v": 2}}"#,
            r#"{"revoked": "all"}"#,
            r#"{"applied": 1}"#,
            r#"{"statement_seq": "3"}"#,
            r#"{"min_release": "latest"}"#,
        ] {
            assert!(parse(bad.as_bytes()).is_err(), "{bad}");
        }
        assert!(parse(b"[]").is_err());

        // And the file this agent writes is one the previous agent (#315, schema 1, no
        // agent_skip) reads: the same names, one field more, which it ignores.
        let dir = tempdir();
        let path = dir.join("state.json");
        let mine = State {
            agent_skip: Version::parse("0.3.0"),
            ..State::default()
        };
        save(&path, &mine).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(v["state_schema"], STATE_SCHEMA);
        assert_eq!(STATE_SCHEMA, 1);
        let previous = [
            "state_schema",
            "agent",
            "floor",
            "min_release",
            "revoked",
            "statement_seq",
            "applied",
            "target",
            "quarantine",
            "update_seen",
            "tools",
            "pulled",
            "rollout",
            "round",
            "poll",
        ];
        let added: Vec<&String> = v
            .as_object()
            .unwrap()
            .keys()
            .filter(|k| !previous.contains(&k.as_str()))
            .collect();
        assert_eq!(added, ["agent_skip", "orders"]);
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
