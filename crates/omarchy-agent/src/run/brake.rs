//! The host-side brake (#325, design v2 §17.1): how fast the pool may make this host
//! change, enforced here, so it holds even against a compromised Worker whose own caps
//! would not:
//!
//! - at least [`ORDER_GAP_S`] between host orders: the agent paces them, taking the next
//!   one a tick later, so a person's two quick orders are both carried out;
//! - at most [`ORDERS_PER_HOUR`] host orders taken an hour;
//! - at most [`RESTARTS_PER_HOUR`] restarts of the dispatcher an hour that the pool
//!   caused — an order that recreates it (`set-units`, `set-emulate`, `rotate-token`,
//!   `retry-release`) or a round to another release;
//! - at most one release change every [`RELEASE_GAP_S`]: a round to a release other than
//!   the one that runs and the one the last change went to (a round tried again, after a
//!   pull that failed or a quarantine, is no new change); the first release a host applies
//!   and a rollback under a signed statement are exempt, from this and from the restarts
//!   (nothing ran before the first; the pool cannot forge a statement);
//! - at most [`NARROWINGS_PER_HOUR`] changes of the capacity settings an hour.
//!
//! Beyond that the order is answered `refused` with `brake: …`, and a release change is
//! held (`held`, the next poll asks again). What the agent does on its own — a changed
//! input, drift, a person's `round` at the host — is never braked. The counters live in
//! `state.json`, so a restart loop resets nothing.

use serde::{Deserialize, Serialize};

pub(crate) const ORDER_GAP_S: i64 = 2;
pub(crate) const ORDERS_PER_HOUR: usize = 20;
pub(crate) const RESTARTS_PER_HOUR: usize = 6;
pub(crate) const RELEASE_GAP_S: i64 = 600;
pub(crate) const NARROWINGS_PER_HOUR: usize = 4;
const HOUR_S: i64 = 3600;

/// What an order or a round asks of the host, as the brake counts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    /// A host order taken.
    Order,
    /// The dispatcher recreated.
    Restart,
    /// A round to a release other than the one that runs.
    Release,
    /// The capacity settings changed.
    Narrowing,
}

/// The times (unix seconds) of what the pool made the host do, by kind, within their
/// windows (older ones are dropped), and of the last order considered.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Brake {
    pub orders: Vec<i64>,
    pub restarts: Vec<i64>,
    pub releases: Vec<i64>,
    pub narrowings: Vec<i64>,
    /// The last host order taken or refused by the brake: the next waits [`ORDER_GAP_S`].
    pub last_order: Option<i64>,
    /// The release the last counted release change went to: a round to it again (a pull
    /// that failed, a quarantine's retry) changes nothing more.
    pub last_release: Option<String>,
}

fn window(a: Ask) -> i64 {
    match a {
        Ask::Release => RELEASE_GAP_S,
        Ask::Order | Ask::Restart | Ask::Narrowing => HOUR_S,
    }
}

impl Brake {
    fn times(&self, a: Ask) -> &Vec<i64> {
        match a {
            Ask::Order => &self.orders,
            Ask::Restart => &self.restarts,
            Ask::Release => &self.releases,
            Ask::Narrowing => &self.narrowings,
        }
    }

    fn times_mut(&mut self, a: Ask) -> &mut Vec<i64> {
        match a {
            Ask::Order => &mut self.orders,
            Ask::Restart => &mut self.restarts,
            Ask::Release => &mut self.releases,
            Ask::Narrowing => &mut self.narrowings,
        }
    }

    /// How many of `a` fall within its window before `now`. A time ahead of `now` counts
    /// (the clock was set back: the brake holds rather than forgets), unless it is more than
    /// a window ahead, which no clock the agent ran on wrote.
    pub fn count(&self, a: Ask, now: i64) -> usize {
        let w = window(a);
        self.times(a)
            .iter()
            .filter(|t| now - **t < w && **t - now < w)
            .count()
    }

    /// Whether the next host order may be taken now ([`ORDER_GAP_S`] after the last).
    pub fn paced(&self, now: i64) -> bool {
        self.last_order
            .is_none_or(|t| now - t >= ORDER_GAP_S || t - now > HOUR_S)
    }

    /// `Err` with the refusal's words when one of `asks` is spent now.
    pub fn check(&self, now: i64, asks: &[Ask]) -> Result<(), String> {
        for a in asks {
            let (n, limit, what) = match a {
                Ask::Order => (
                    self.count(*a, now),
                    ORDERS_PER_HOUR,
                    format!("at most {ORDERS_PER_HOUR} host orders an hour"),
                ),
                Ask::Restart => (
                    self.count(*a, now),
                    RESTARTS_PER_HOUR,
                    format!("at most {RESTARTS_PER_HOUR} restarts of the dispatcher an hour"),
                ),
                Ask::Release => (
                    self.count(*a, now),
                    1,
                    format!(
                        "at most one release change every {} minutes (a rollback is exempt)",
                        RELEASE_GAP_S / 60
                    ),
                ),
                Ask::Narrowing => (
                    self.count(*a, now),
                    NARROWINGS_PER_HOUR,
                    format!("at most {NARROWINGS_PER_HOUR} capacity narrowings an hour"),
                ),
            };
            if n >= limit {
                let next = self.free_at(*a, now, limit);
                return Err(format!(
                    "brake: {what}; {n} in the last {} min, the next from {}",
                    window(*a) / 60,
                    super::orders::iso(next)
                ));
            }
        }
        Ok(())
    }

    /// When `a` has room again: the `limit`-th newest time in its window leaves it.
    fn free_at(&self, a: Ask, now: i64, limit: usize) -> i64 {
        let w = window(a);
        let mut t: Vec<i64> = self
            .times(a)
            .iter()
            .copied()
            .filter(|t| now - *t < w && *t - now < w)
            .collect();
        t.sort_unstable();
        t.iter()
            .rev()
            .nth(limit.saturating_sub(1))
            .map_or(now, |t| t + w)
    }

    /// Counts `asks` at `now`, dropping what left its window.
    pub fn record(&mut self, now: i64, asks: &[Ask]) {
        for a in asks {
            let w = window(*a);
            let v = self.times_mut(*a);
            v.retain(|t| now - *t < w && *t - now < w);
            v.push(now);
        }
    }

    /// An order considered now (taken, or refused by the brake): the next one waits.
    pub fn considered(&mut self, now: i64) {
        self.last_order = Some(now);
    }

    /// What the report says of it: how much of each limit the last window spent.
    pub fn view(&self, now: i64) -> serde_json::Value {
        serde_json::json!({
            "orders_hour": self.count(Ask::Order, now),
            "restarts_hour": self.count(Ask::Restart, now),
            "narrowings_hour": self.count(Ask::Narrowing, now),
            "release_change_at": self
                .releases
                .iter()
                .copied()
                .filter(|t| now - *t < RELEASE_GAP_S)
                .max()
                .map(super::orders::iso),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_800_000_000;

    #[test]
    fn the_seventh_restart_in_an_hour_is_refused_and_the_window_slides() {
        let mut b = Brake::default();
        for i in 0..6 {
            assert!(b.check(T + i * 60, &[Ask::Restart]).is_ok(), "restart {i}");
            b.record(T + i * 60, &[Ask::Restart]);
        }
        let e = b.check(T + 400, &[Ask::Restart]).unwrap_err();
        assert!(
            e.starts_with("brake: at most 6 restarts of the dispatcher an hour; 6 in the last 60 min, the next from 2027-01-15T09:00:00Z"),
            "{e}"
        );
        // An hour after the first, one leaves the window.
        assert!(b.check(T + 3599, &[Ask::Restart]).is_err());
        assert!(b.check(T + 3600, &[Ask::Restart]).is_ok());
    }

    #[test]
    fn one_release_change_in_ten_minutes_and_four_narrowings_and_twenty_orders_an_hour() {
        let mut b = Brake::default();
        b.record(T, &[Ask::Release]);
        assert!(b.check(T + 599, &[Ask::Release]).unwrap_err().contains(
            "at most one release change every 10 minutes (a rollback is exempt); 1 in the last 10 min, the next from 2027-01-15T08:10:00Z"
        ));
        assert!(b.check(T + 600, &[Ask::Release]).is_ok());

        for i in 0..4 {
            assert!(b.check(T + i, &[Ask::Narrowing]).is_ok());
            b.record(T + i, &[Ask::Narrowing]);
        }
        assert!(b
            .check(T + 10, &[Ask::Order, Ask::Narrowing])
            .unwrap_err()
            .starts_with("brake: at most 4 capacity narrowings an hour"));

        let mut b = Brake::default();
        for i in 0..20 {
            b.record(T + i * 2, &[Ask::Order]);
        }
        assert!(b
            .check(T + 100, &[Ask::Order])
            .unwrap_err()
            .starts_with("brake: at most 20 host orders an hour"));
        assert!(b.check(T + 3600, &[Ask::Order]).is_ok());
    }

    #[test]
    fn orders_are_paced_two_seconds_apart() {
        let mut b = Brake::default();
        assert!(b.paced(T));
        b.considered(T);
        assert!(!b.paced(T + 1));
        assert!(b.paced(T + 2));
    }

    #[test]
    fn a_clock_set_back_keeps_the_brake_and_one_far_ahead_does_not_hold_it_forever() {
        let mut b = Brake::default();
        for i in 0..6 {
            b.record(T + i, &[Ask::Restart]);
        }
        // Set back by ten minutes: the restarts still count.
        assert!(b.check(T - 600, &[Ask::Restart]).is_err());
        // Set back by a day: the times are no agent's clock any more.
        assert!(b.check(T - 86_400, &[Ask::Restart]).is_ok());
        b.considered(T);
        assert!(b.paced(T - 86_400));
    }

    #[test]
    fn the_counters_survive_a_restart_through_state_json() {
        let mut b = Brake::default();
        for i in 0..6 {
            b.record(T + i, &[Ask::Restart, Ask::Order]);
        }
        b.considered(T + 5);
        let text = serde_json::to_string(&b).unwrap();
        let back: Brake = serde_json::from_str(&text).unwrap();
        assert_eq!(back, b);
        assert!(back.check(T + 10, &[Ask::Restart]).is_err());
        // An older agent's state with no brake reads as none.
        assert_eq!(
            serde_json::from_str::<Brake>("{}").unwrap(),
            Brake::default()
        );
    }
}
