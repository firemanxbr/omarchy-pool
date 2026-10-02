//! Which targets a host may move to (design v2 §5.2, §5.3; decision D25). Pure decisions
//! on verified content and the host's state: the floor, the merged `min_release` and
//! `revoked`, and rollback statements.

use std::fmt;

use crate::manifest::Manifest;
use crate::statement::Statement;
use crate::version::Release;

use super::state::State;

/// How far back a rollback statement may go: `to` created at most this long before the
/// statement was signed (D25). Deeper needs a forward-fix release.
pub const MAX_ROLLBACK_DEPTH_S: i64 = 14 * 24 * 3600;

/// Why a target was refused; each has a stable name for the report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Below the floor and no statement covers it.
    BelowFloor {
        target: Release,
        floor: Release,
        why: String,
    },
    BelowMinRelease {
        target: Release,
        min_release: Release,
    },
    Revoked(Release),
    /// A statement whose `seq` is not above the last accepted one.
    StatementSeq {
        seq: u64,
        last: u64,
    },
    /// A statement that does not cover this host: `to < floor <= retracts_through` fails,
    /// or it is not about this target.
    StatementRange(String),
    /// `to` was created more than 14 days before the statement was signed.
    StatementTooDeep {
        days: i64,
    },
    /// The agent's pool origin is not in the bundle's signed `pools` list.
    PoolNotListed(String),
    /// The signature, the signer or the content failed `verify`.
    Verify {
        reason: &'static str,
        detail: String,
    },
}

impl Refusal {
    pub fn reason(&self) -> &'static str {
        match self {
            Refusal::BelowFloor { .. } => "below-floor",
            Refusal::BelowMinRelease { .. } => "below-min-release",
            Refusal::Revoked(_) => "revoked",
            Refusal::StatementSeq { .. } => "statement-seq",
            Refusal::StatementRange(_) => "statement-range",
            Refusal::StatementTooDeep { .. } => "statement-too-deep",
            Refusal::PoolNotListed(_) => "pool-not-listed",
            Refusal::Verify { reason, .. } => reason,
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::BelowFloor { target, floor, why } => {
                write!(f, "{target} is below the floor {floor}: {why}")
            }
            Refusal::BelowMinRelease {
                target,
                min_release,
            } => write!(f, "{target} is below min_release {min_release}"),
            Refusal::Revoked(r) => write!(f, "{r} is revoked"),
            Refusal::StatementSeq { seq, last } => write!(
                f,
                "rollback statement seq {seq} is not above the last accepted {last}"
            ),
            Refusal::StatementRange(why) => write!(f, "rollback statement: {why}"),
            Refusal::StatementTooDeep { days } => write!(
                f,
                "rollback statement goes back {days} days, more than the 14 a statement may"
            ),
            Refusal::PoolNotListed(p) => write!(f, "the pool {p} is not in the bundle's pools"),
            Refusal::Verify { reason, detail } => write!(f, "verify refused ({reason}): {detail}"),
        }
    }
}

/// Merges a verified manifest's `min_release` and `revoked` into the state; neither ever
/// goes down (design v2 §5.2), whatever the manifest's own release.
pub fn merge(state: &mut State, m: &Manifest) {
    let min = Release(m.min_release());
    if state.min_release.is_none_or(|have| min > have) {
        state.min_release = Some(min);
    }
    state
        .revoked
        .extend(m.revoked().iter().copied().map(Release));
}

/// The checks every target passes, with or without a statement.
fn floor_free_checks(state: &State, target: Release) -> Result<(), Refusal> {
    if let Some(min_release) = state.min_release.filter(|m| target < *m) {
        return Err(Refusal::BelowMinRelease {
            target,
            min_release,
        });
    }
    if state.revoked.contains(&target) {
        return Err(Refusal::Revoked(target));
    }
    Ok(())
}

/// A target at or above the floor (no statement needed). `None` floor: a fresh host.
pub fn admit(state: &State, target: Release) -> Result<(), Refusal> {
    floor_free_checks(state, target)?;
    match state.floor {
        Some(floor) if target < floor => Err(Refusal::BelowFloor {
            target,
            floor,
            why: "no rollback statement covers it".into(),
        }),
        _ => Ok(()),
    }
}

/// A target below the floor, under a verified rollback statement (design v2 §5.3):
/// `seq` above the last accepted, `to` the target, `to < floor <= retracts_through`,
/// `to` not below `min_release` nor revoked, and `to` created at most 14 days before the
/// statement's signed (log) time. `to_created` is `to`'s signed manifest `created`.
pub fn admit_rollback(
    state: &State,
    target: Release,
    st: &Statement,
    signed_at: i64,
    to_created: &str,
) -> Result<(), Refusal> {
    floor_free_checks(state, target)?;
    if let Some(last) = state.statement_seq.filter(|last| st.seq() <= *last) {
        return Err(Refusal::StatementSeq {
            seq: st.seq(),
            last,
        });
    }
    let to = Release(st.to());
    if to != target {
        return Err(Refusal::StatementRange(format!(
            "it goes to {to}, not to the target {target}"
        )));
    }
    let through = Release(st.retracts_through());
    match state.floor {
        Some(floor) if to < floor && floor <= through => {}
        floor => {
            return Err(Refusal::StatementRange(format!(
                "{to} < floor <= {through} does not hold for the floor {}",
                floor.map_or_else(|| "none".into(), |f| f.to_string())
            )))
        }
    }
    let created = unix_time(to_created).ok_or_else(|| {
        Refusal::StatementRange(format!("{to}'s created {to_created:?} is not a time"))
    })?;
    let depth = signed_at - created;
    if depth > MAX_ROLLBACK_DEPTH_S {
        return Err(Refusal::StatementTooDeep {
            days: depth / 86_400,
        });
    }
    Ok(())
}

/// Records an accepted statement: the floor goes to `to`.
pub fn accept_rollback(state: &mut State, st: &Statement) {
    state.statement_seq = Some(st.seq());
    state.floor = Some(Release(st.to()));
}

/// Seconds since the epoch of `YYYY-MM-DDTHH:MM:SS[.f]Z` (the manifest's `created`).
pub fn unix_time(s: &str) -> Option<i64> {
    if !crate::manifest::is_timestamp(s) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (year, month, day) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::version::Version;

    fn r(s: &str) -> Release {
        Release::parse(s).unwrap()
    }

    #[test]
    fn unix_time_reads_the_manifest_created() {
        assert_eq!(unix_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(unix_time("2026-09-30T18:26:06Z"), Some(1_790_792_766));
        assert_eq!(unix_time("2000-02-29T12:00:00.5Z"), Some(951_825_600));
        assert_eq!(unix_time("2026-13-01T00:00:00Z"), None);
        assert_eq!(unix_time("yesterday"), None);
    }

    #[test]
    fn the_floor_min_release_and_revoked_each_refuse_with_their_name() {
        let mut s = State {
            floor: Some(r("v1.20.0")),
            min_release: Some(r("v1.18.0")),
            ..State::default()
        };
        s.revoked.insert(r("v1.21.1"));
        assert_eq!(admit(&s, r("v1.20.0")), Ok(()));
        assert_eq!(admit(&s, r("v1.22.0")), Ok(()));
        assert_eq!(admit(&s, r("v1.19.0")).unwrap_err().reason(), "below-floor");
        assert_eq!(
            admit(&s, r("v1.17.0")).unwrap_err().reason(),
            "below-min-release"
        );
        assert_eq!(admit(&s, r("v1.21.1")).unwrap_err().reason(), "revoked");
        // A fresh host has no floor.
        assert_eq!(admit(&State::default(), r("v1.0.0")), Ok(()));
    }

    #[test]
    fn merging_never_lowers_min_release_nor_forgets_a_revocation() {
        let mut s = State {
            min_release: Some(r("v1.19.0")),
            ..State::default()
        };
        s.revoked.insert(Release(Version(1, 0, 1)));
        let m = crate::verify::tests_support::manifest("v1.20.0", "v1.18.0", &["v1.19.1"]);
        merge(&mut s, &m);
        assert_eq!(s.min_release, Some(r("v1.19.0")));
        assert_eq!(
            s.revoked
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            ["v1.0.1", "v1.19.1"]
        );
        let m = crate::verify::tests_support::manifest("v1.21.0", "v1.20.0", &[]);
        merge(&mut s, &m);
        assert_eq!(s.min_release, Some(r("v1.20.0")));
        assert_eq!(s.revoked.len(), 2);
    }
}
