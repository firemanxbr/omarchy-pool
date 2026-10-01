//! Agent spend on a maintainer's host (design v2 §9.5, D45; #336).
//!
//! - **Per task**, in the agent sidecar: at most `calls_per_task` model
//!   calls, `tokens_per_task` tokens and `minutes_per_task` of wall time
//!   (`factory/bin/broker`, its `BROKER_AGENT_*` caps); past one, the sidecar
//!   answers 429 to every call.
//! - **Per day** (UTC), here: the dispatcher keeps the day's calls in
//!   `state/agent-day.json` (never mounted into a container). A new sidecar
//!   may make at most what is left of the day once every running sidecar's
//!   own cap is set aside, so the day's total cannot be passed even by
//!   sidecars running at once; when nothing is left, no model task starts
//!   and the claim offers no agent slot until the next day. A sidecar's
//!   usage comes back in `<task dir>/agent/usage.json`, which the sidecar
//!   writes and the task container does not mount; a usage that does not
//!   read counts as the whole cap it was given.
//!
//! Seam (#317): the caps come from the envelope's `agent_budget`, which the
//! install writes into the dispatcher's environment.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// The caps, from the envelope (design v2 §12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub calls_per_task: u32,
    pub tokens_per_task: u64,
    pub minutes_per_task: u64,
    pub calls_per_day: u32,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            calls_per_task: 200,
            tokens_per_task: 2_000_000,
            minutes_per_task: 120,
            calls_per_day: 5000,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct Day {
    /// Days since the epoch, UTC.
    day: u64,
    calls: u32,
}

/// The day's ledger: `state/agent-day.json`.
pub struct Ledger {
    path: std::path::PathBuf,
}

impl Ledger {
    pub fn new(work_root: &Path) -> Self {
        Self {
            path: work_root.join("state").join("agent-day.json"),
        }
    }

    fn read(&self, now: u64) -> Day {
        let today = now / 86_400;
        std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Day>(&b).ok())
            .filter(|d| d.day == today)
            .unwrap_or(Day {
                day: today,
                calls: 0,
            })
    }

    /// The calls spent today by sidecars that ended.
    pub fn spent(&self, now: u64) -> u32 {
        self.read(now).calls
    }

    /// Adds an ended sidecar's calls to today's.
    pub fn add(&self, now: u64, calls: u32) {
        let mut d = self.read(now);
        d.calls = d.calls.saturating_add(calls);
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec(&d).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }
}

/// What a new sidecar may spend: the task's cap, within what the day has left once `reserved`
/// (the running sidecars' caps) is set aside. 0: no model task starts.
pub fn grant(caps: &Caps, spent_today: u32, reserved: u32) -> u32 {
    caps.calls_per_task.min(
        caps.calls_per_day
            .saturating_sub(spent_today)
            .saturating_sub(reserved),
    )
}

/// The calls an ended sidecar made, from the file it wrote; its whole cap when the file does not read.
pub fn used(task_dir: &Path, cap: u32) -> u32 {
    std::fs::read(task_dir.join("agent").join("usage.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("calls").and_then(serde_json::Value::as_u64))
        .map_or(cap, |c| u32::try_from(c).unwrap_or(u32::MAX).min(cap))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_day_is_never_passed_even_by_sidecars_at_once() {
        let caps = Caps {
            calls_per_task: 200,
            tokens_per_task: 1,
            minutes_per_task: 1,
            calls_per_day: 450,
        };
        assert_eq!(grant(&caps, 0, 0), 200);
        assert_eq!(grant(&caps, 0, 200), 200);
        assert_eq!(grant(&caps, 0, 400), 50, "two running sidecars leave 50");
        assert_eq!(grant(&caps, 300, 150), 0);
        assert_eq!(grant(&caps, 500, 0), 0);
    }

    #[test]
    fn the_ledger_keeps_today_and_forgets_yesterday() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("state")).unwrap();
        let l = Ledger::new(t.path());
        let day = 20_000 * 86_400;
        assert_eq!(l.spent(day), 0);
        l.add(day + 10, 30);
        l.add(day + 20, 12);
        assert_eq!(l.spent(day + 30), 42);
        assert_eq!(l.spent(day + 86_400), 0, "a new day");
    }

    #[test]
    fn a_usage_that_does_not_read_counts_as_the_whole_cap() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(used(t.path(), 200), 200);
        std::fs::create_dir_all(t.path().join("agent")).unwrap();
        std::fs::write(
            t.path().join("agent/usage.json"),
            r#"{"calls":17,"tokens":9000}"#,
        )
        .unwrap();
        assert_eq!(used(t.path(), 200), 17);
        std::fs::write(t.path().join("agent/usage.json"), r#"{"calls":9999}"#).unwrap();
        assert_eq!(
            used(t.path(), 200),
            200,
            "never more than the cap it was given"
        );
    }
}
