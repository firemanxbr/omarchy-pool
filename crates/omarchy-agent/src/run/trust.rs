//! Which targets a host may move to (design v2 §5.2, §5.3; decisions D1 b, D25). Pure
//! decisions on verified content and the host's state: the floor, the merged `min_release`
//! and `revoked`, rollback statements, and the maintainers' co-signature (#330).

use std::fmt;

use crate::manifest::Manifest;
use crate::statement::Statement;
use crate::verify::cosignature::Cosigned;
use crate::version::Release;

use super::state::State;

/// How far back a rollback statement may go: `to` created at most this long before the
/// statement was signed (D25). Deeper needs the maintainers' co-signature over the
/// statement (#330), or a forward-fix release.
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
    /// `to` was created more than 14 days before the statement was signed, and fewer than
    /// `need` maintainers co-signed the statement (#330).
    StatementTooDeep {
        days: i64,
        cosigned: usize,
        need: usize,
    },
    /// The bundle lacks the maintainers' co-signature this agent pins (#330, D1 b).
    Cosignature(String),
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
            Refusal::Cosignature(_) => "cosignature",
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
            Refusal::StatementTooDeep {
                days,
                cosigned,
                need,
            } => write!(
                f,
                "rollback statement goes back {days} days, more than the 14 a statement may without {need} maintainer co-signature(s) over it ({cosigned} verif{})",
                if *cosigned == 1 { "ies" } else { "y" }
            ),
            Refusal::Cosignature(why) => f.write_str(why),
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
/// statement's signed (log) time — or deeper, when `cosigned` reaches `deep` (#330, D25:
/// the maintainers' co-signatures over the statement, and how many the agent pins for a
/// deep one). `to_created` is `to`'s signed manifest `created`.
pub fn admit_rollback(
    state: &State,
    target: Release,
    st: &Statement,
    signed_at: i64,
    to_created: &str,
    cosigned: usize,
    deep: usize,
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
    if depth > MAX_ROLLBACK_DEPTH_S && cosigned < deep {
        return Err(Refusal::StatementTooDeep {
            days: depth / 86_400,
            cosigned,
            need: deep,
        });
    }
    Ok(())
}

/// The maintainers' co-signature a bundle needs before this agent applies it or takes its
/// agent (#330, D1 b): `need` of the pinned maintainers over the bundle, or, for the target
/// of a rollback statement, over that statement (a co-signed statement vouches for its
/// target, whose release may be from before the threshold rose). The refusal says which
/// can still be co-signed: a published release takes no asset, a statement takes more
/// co-signatures through the pool.
pub fn cosigned(
    target: Release,
    need: usize,
    bundle: &Cosigned,
    statement: Option<&Cosigned>,
) -> Result<(), Refusal> {
    if statement.is_some_and(|s| s.count() >= need) {
        return Ok(());
    }
    let Err(why) = bundle.require(need, &format!("{target}'s bundle")) else {
        return Ok(());
    };
    Err(Refusal::Cosignature(match statement {
        None => why,
        Some(st) => format!(
            "{target}'s bundle needs {need} maintainer co-signature(s) (factory/MAINTAINERS.toml), or the rollback statement to it does (factory/bin/co-sign rollback {target}); bundle: {}; statement: {}",
            bundle.summary(),
            st.summary()
        ),
    }))
}

/// Whether `target` is the release a co-signed rollback statement vouched for when it was
/// accepted, and the floor still stands there: the round to it is that rollback, tried
/// again after a first attempt that did not finish (a pull, the tools, a quarantine). The
/// statement no longer reads as one (its `to` is the floor now), so its vouching is what
/// was kept (#330).
pub fn vouched(state: &State, target: Release) -> bool {
    state.vouched == Some(target) && state.floor == Some(target)
}

/// Records an accepted statement: the floor goes to `to`, and whether the statement's
/// co-signatures vouched for `to`'s bundle (see [`vouched`]).
pub fn accept_rollback(state: &mut State, st: &Statement, vouches: bool) {
    let to = Release(st.to());
    state.statement_seq = Some(st.seq());
    state.floor = Some(to);
    state.vouched = vouches.then_some(to);
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

    fn statement(seq: u64, to: &str, through: &str) -> Statement {
        let json = format!(
            r#"{{"schema":1,"seq":{seq},"to":"{to}","retracts_through":"{through}","issued":"2027-02-20T08:00:00Z","agent_to":null,"run":"https://github.com/firemanxbr/omarchy-pool/actions/runs/1"}}"#
        );
        match crate::statement::parse(json.as_bytes()).unwrap() {
            crate::statement::ParsedStatement::Current(st) => st,
            crate::statement::ParsedStatement::NeedsNewerAgent { why } => panic!("{why}"),
        }
    }

    #[test]
    fn a_statement_deeper_than_14_days_is_taken_only_with_the_maintainers_co_signature() {
        let s = State {
            floor: Some(r("v1.2.0")),
            ..State::default()
        };
        let st = statement(5, "v1.0.1", "v1.2.0");
        let created = "2027-01-01T00:00:00Z";
        let at = unix_time(created).unwrap();
        let admit = |s: &State, signed_at, cosigned, deep| {
            admit_rollback(s, r("v1.0.1"), &st, signed_at, created, cosigned, deep)
        };
        // 14 days to the second: no co-signature is asked.
        assert_eq!(admit(&s, at + MAX_ROLLBACK_DEPTH_S, 0, 1), Ok(()));
        // One second deeper: refused without one, and the refusal says what it lacks.
        let deep = at + MAX_ROLLBACK_DEPTH_S + 1;
        let e = admit(&s, deep, 0, 1).unwrap_err();
        assert_eq!(e.reason(), "statement-too-deep");
        assert!(
            e.to_string()
                .contains("more than the 14 a statement may without 1 maintainer co-signature(s) over it (0 verify)"),
            "{e}"
        );
        // Taken with one where one is pinned (1-of-N, or nothing asked of bundles), with two
        // only where two are (2-of-N).
        assert_eq!(admit(&s, deep + 90 * 86_400, 1, 1), Ok(()));
        let e = admit(&s, deep, 1, 2).unwrap_err();
        assert!(
            e.to_string()
                .contains("without 2 maintainer co-signature(s) over it (1 verifies)"),
            "{e}"
        );
        assert_eq!(admit(&s, deep, 2, 2), Ok(()));
        // The co-signature lifts the depth bound only: every other rule still holds.
        let low = State {
            min_release: Some(r("v1.1.0")),
            ..s.clone()
        };
        assert_eq!(
            admit(&low, deep, 2, 1).unwrap_err().reason(),
            "below-min-release"
        );
        let past = State {
            statement_seq: Some(5),
            ..s.clone()
        };
        assert_eq!(
            admit(&past, deep, 2, 1).unwrap_err().reason(),
            "statement-seq"
        );
        let below = State {
            floor: Some(r("v1.0.1")),
            ..s
        };
        assert_eq!(
            admit(&below, deep, 2, 1).unwrap_err().reason(),
            "statement-range"
        );
    }

    #[test]
    fn a_bundle_needs_its_co_signature_or_a_co_signed_statement_that_names_it() {
        use crate::verify::cosignature::tests_support::{policy, TestKey};
        use crate::verify::cosignature::{BUNDLE_NAMESPACE, ROLLBACK_NAMESPACE};
        use std::collections::BTreeMap;
        let alice = TestKey::ed25519("alice", 1);
        let bob = TestKey::ed25519("bob", 2);
        let p = policy(1, &[&alice, &bob]);
        let by = |ns: &str, msg: &[u8], who: &[&TestKey]| {
            let sigs: BTreeMap<String, Vec<u8>> = who
                .iter()
                .map(|k| (k.login.clone(), k.sign(ns, msg)))
                .collect();
            p.check(ns, msg, &sigs)
        };
        let none = by(BUNDLE_NAMESPACE, b"bundle", &[]);
        let one = by(BUNDLE_NAMESPACE, b"bundle", &[&alice]);
        let two = by(BUNDLE_NAMESPACE, b"bundle", &[&alice, &bob]);
        let target = r("v1.3.0");
        // Nothing asked.
        assert_eq!(cosigned(target, 0, &none, None), Ok(()));
        // 1-of-N, 2-of-N.
        let e = cosigned(target, 1, &none, None).unwrap_err();
        assert_eq!(e.reason(), "cosignature");
        assert!(
            e.to_string()
                .starts_with("v1.3.0's bundle needs 1 maintainer co-signature(s)"),
            "{e}"
        );
        assert_eq!(cosigned(target, 1, &one, None), Ok(()));
        assert!(cosigned(target, 2, &one, None).is_err());
        assert_eq!(cosigned(target, 2, &two, None), Ok(()));
        // A rollback's target from before the threshold rose: its statement's co-signatures,
        // as many as a bundle's, vouch for it; fewer do not.
        let st_one = by(ROLLBACK_NAMESPACE, b"statement", &[&bob]);
        assert_eq!(cosigned(target, 1, &none, Some(&st_one)), Ok(()));
        assert!(cosigned(target, 2, &none, Some(&st_one)).is_err());
        assert_eq!(
            cosigned(
                target,
                2,
                &one,
                Some(&by(ROLLBACK_NAMESPACE, b"statement", &[&alice, &bob]))
            ),
            Ok(())
        );
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
