//! What the agent asks over the network (design v2 §16.1, §16.4, §17.1): the pool's host
//! state (`GET /api/v1/hosts/self/state`, signed with the host key, #344) — the release
//! target, the open Update orders of the host's registration and the host orders — and
//! its rollback relay, the host report (`POST /api/v1/hosts/self/report`, signed), and
//! the release assets on GitHub. Answers are read leniently and sorted three ways; none
//! of them ever stops the agent: no answer, a 5xx or a malformed body changes nothing; a
//! 401/403 changes nothing and slows the polls to hourly.
//!
//! From this agent on the target is the host state's, never `follow.latest`: the pool's
//! public `GET /factory/follow` is read by the legacy sets' updaters and the agents before
//! this one only.

use std::io::Read;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::host::HostKey;
use crate::version::Release;

/// A network answer, sorted the way the loop acts on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Net<T> {
    Ok(T),
    /// No answer, a 5xx, a malformed body, or any status the agent does not act on.
    NoAnswer(String),
    /// 401 or 403: keep everything running, poll hourly.
    Unauthorized(u16),
}

/// What `GET /api/v1/hosts/self/state` says, as far as this agent reads it (P3's minimal
/// host state, design v2 §17.1; settings and the other orders are P4's).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct HostState {
    /// The release the pool names for this host; `None` when it runs none (a build with
    /// no tag) or says none.
    pub target: Option<Release>,
    /// The open Update orders of the host's registration ("reconcile now", which lifts a
    /// quarantine).
    pub updates: Vec<String>,
    /// The host orders, in the pool's order.
    pub orders: Vec<Order>,
    /// How often the pool asks to be polled, in seconds.
    pub poll_s: Option<i64>,
}

/// A host order as the pool sends it: a closed set of kinds, each with an id and a
/// `not_after` (design v2 §17.1). What this agent does not know is `Unknown`, and refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Order {
    pub id: String,
    pub kind: OrderKind,
    /// Unix seconds; `None` when the pool sent none this agent can read (refused).
    pub not_after: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OrderKind {
    /// Stop and then remove the legacy compose project `legacy.json` records, and write the
    /// `.omarchy-agent` marker into its directory (design v2 §11.1 M4, M5; §13.4, §21.1).
    RetireLegacy,
    /// A round now; it never skips the owner's soak (P4).
    ReconcileNow,
    /// Any other word, kept to say what was refused.
    Unknown(String),
}

impl OrderKind {
    pub fn parse(s: &str) -> Self {
        match s {
            "retire-legacy" => OrderKind::RetireLegacy,
            "reconcile-now" => OrderKind::ReconcileNow,
            other => {
                OrderKind::Unknown(other.chars().filter(|c| !c.is_control()).take(64).collect())
            }
        }
    }

    pub fn name(&self) -> &str {
        match self {
            OrderKind::RetireLegacy => "retire-legacy",
            OrderKind::ReconcileNow => "reconcile-now",
            OrderKind::Unknown(k) => k,
        }
    }
}

/// A signed rollback statement as the pool relays it: the exact signed bytes and the
/// Sigstore bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Relayed {
    pub statement: Vec<u8>,
    pub bundle: Vec<u8>,
}

pub(crate) trait Pool {
    /// The host state, signed with the host key.
    fn state(&mut self) -> Net<HostState>;
    /// Posts the host report (signed); the pool keeps it and closes the orders it answers.
    fn report(&mut self, body: &[u8]) -> Net<()>;
    /// `Ok(None)`: the pool has no statement for going back to `to` (404).
    fn rollback(&mut self, to: Release) -> Net<Option<Relayed>>;
    /// A file of release `r` on GitHub (the host bundle and its signature).
    fn release_asset(&mut self, r: Release, name: &str) -> Net<Vec<u8>>;
    /// A pinned tool (checked by SHA-256 by the caller).
    fn download(&mut self, url: &str) -> Net<Vec<u8>>;
}

const STATE_MAX: u64 = 64 << 10;
const STATE_PATH: &str = "/api/v1/hosts/self/state";
const REPORT_PATH: &str = "/api/v1/hosts/self/report";
const STATEMENT_MAX: u64 = 1 << 20;
const BUNDLE_MAX: u64 = 64 << 20;
pub(crate) const RELEASES: &str = "https://github.com/firemanxbr/omarchy-pool/releases/download";
/// At most this many host orders and Update ids are read from one answer.
const MAX_ORDERS: usize = 32;

/// An id the pool hands out (an order's, an Update's): letters, digits, `.`, `_`, `-`,
/// 1 to 128 of them. It is journaled and reported back, so nothing else is taken.
pub(crate) fn is_order_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Reads a host state leniently: unknown fields ignored, a target that is not a release
/// read as none, an Update id or an order whose id is not one dropped, an order whose
/// `not_after` is not a time kept with none (and refused), an unknown kind kept as
/// `Unknown` (and refused).
pub(crate) fn parse_state(body: &[u8]) -> Result<HostState, String> {
    #[derive(Deserialize)]
    struct Raw {
        release: Option<serde_json::Value>,
        poll_s: Option<serde_json::Value>,
        updates: Option<serde_json::Value>,
        orders: Option<serde_json::Value>,
    }
    let raw: Raw = serde_json::from_slice(body).map_err(|e| format!("host state: {e}"))?;
    let target = raw
        .release
        .as_ref()
        .and_then(|r| r.get("target"))
        .and_then(serde_json::Value::as_str)
        .and_then(|t| {
            let t = t.trim();
            Release::parse(t).or_else(|| Release::parse(&format!("v{t}")))
        });
    let list = |v: Option<serde_json::Value>| match v {
        Some(serde_json::Value::Array(a)) => a.into_iter().take(MAX_ORDERS).collect(),
        _ => Vec::new(),
    };
    let updates = list(raw.updates)
        .into_iter()
        .filter_map(|u| u.as_str().filter(|u| is_order_id(u)).map(str::to_owned))
        .collect();
    let orders = list(raw.orders)
        .into_iter()
        .filter_map(|o| {
            let id = o.get("id")?.as_str().filter(|i| is_order_id(i))?.to_owned();
            let kind = OrderKind::parse(
                o.get("kind")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            );
            let not_after = match o.get("not_after") {
                Some(serde_json::Value::String(t)) => super::trust::unix_time(t),
                Some(serde_json::Value::Number(n)) => n.as_i64(),
                _ => None,
            };
            Some(Order {
                id,
                kind,
                not_after,
            })
        })
        .collect();
    Ok(HostState {
        target,
        updates,
        orders,
        poll_s: raw.poll_s.as_ref().and_then(serde_json::Value::as_i64),
    })
}

/// Reads the relay's body: `{to, statement, bundle}`, the statement as the signed text.
pub(crate) fn parse_relayed(body: &[u8], to: Release) -> Result<Relayed, String> {
    #[derive(Deserialize)]
    struct Raw {
        to: String,
        statement: String,
        bundle: String,
    }
    let raw: Raw = serde_json::from_slice(body).map_err(|e| format!("rollback relay: {e}"))?;
    if Release::parse(&raw.to) != Some(to) {
        return Err(format!("rollback relay: asked for {to}, got {:?}", raw.to));
    }
    Ok(Relayed {
        statement: raw.statement.into_bytes(),
        bundle: raw.bundle.into_bytes(),
    })
}

/// Sorts a status the way the loop acts on it.
pub(crate) fn classify(status: u16) -> Net<()> {
    match status {
        200..=299 => Net::Ok(()),
        401 | 403 => Net::Unauthorized(status),
        s => Net::NoAnswer(format!("HTTP {s}")),
    }
}

/// The pool and GitHub over HTTPS (`ureq` on rustls with aws-lc-rs, the same TLS as
/// [`crate::pool`]): every call times out.
pub(crate) struct Https {
    origin: String,
    agent: ureq::Agent,
    /// The host's own calls: one origin, never a redirect a signed request would follow
    /// to a second one (as [`crate::pool::Pool`]'s).
    signed: ureq::Agent,
    downloads: ureq::Agent,
    /// The host key and the host's id, which sign the host state's and the report's
    /// requests; `None` (no key on this machine yet) answers them "no answer".
    host: Option<(HostKey, String)>,
    /// The watchdog's clock, moved on as a body's bytes arrive: a long download is
    /// progress, a stalled one is not.
    progress: Option<Arc<AtomicI64>>,
}

impl Https {
    /// `origin` is agent.toml's `pool`, already checked to be an `https://` origin.
    pub fn new(origin: &str) -> Self {
        let agent = |timeout: Duration, redirects: u32| -> ureq::Agent {
            ureq::Agent::config_builder()
                .tls_config(crate::pool::tls())
                .timeout_global(Some(timeout))
                .http_status_as_error(false)
                .https_only(true)
                .max_redirects(redirects)
                .user_agent(format!("omarchy-agent/{}", crate::AGENT_VERSION))
                .build()
                .into()
        };
        Https {
            origin: origin.trim_end_matches('/').to_owned(),
            // GitHub's release downloads redirect to its object store.
            agent: agent(Duration::from_secs(60), 10),
            signed: agent(Duration::from_secs(60), 0),
            // The pinned tools are tens of MiB: a longer deadline, still a deadline.
            downloads: agent(Duration::from_secs(600), 10),
            host: None,
            progress: None,
        }
    }

    pub fn with_progress(mut self, progress: Arc<AtomicI64>) -> Self {
        self.progress = Some(progress);
        self
    }

    /// The host key and the host's id (agent.toml's `host_id`) the host's calls are signed
    /// with.
    pub fn with_host(mut self, key: HostKey, host: &str) -> Self {
        self.host = Some((key, host.to_owned()));
        self
    }

    fn read(
        &self,
        res: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
        max: u64,
    ) -> Net<(u16, Vec<u8>)> {
        let mut res = match res {
            Ok(r) => r,
            Err(e) => return Net::NoAnswer(e.to_string()),
        };
        let status = res.status().as_u16();
        if let Net::Unauthorized(s) = classify(status) {
            return Net::Unauthorized(s);
        }
        let mut reader = res.body_mut().with_config().limit(max).reader();
        let mut body = Vec::new();
        let mut chunk = vec![0u8; 64 << 10];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => return Net::Ok((status, body)),
                Ok(n) => body.extend_from_slice(&chunk[..n]),
                Err(e) => return Net::NoAnswer(format!("HTTP {status}: {e}")),
            }
            if let Some(p) = &self.progress {
                p.store(super::now(), Ordering::Relaxed);
            }
        }
    }

    fn get(&self, agent: &ureq::Agent, url: &str, max: u64) -> Net<(u16, Vec<u8>)> {
        self.read(agent.get(url).call(), max)
    }

    fn get_ok(&self, agent: &ureq::Agent, url: &str, max: u64) -> Net<Vec<u8>> {
        ok_body(self.get(agent, url, max))
    }

    /// A call signed with the host key (`Omarchy-Host`, design v2 D7): a GET, or a POST
    /// of `body` as JSON.
    fn signed_call(&self, method: &str, path: &str, body: Option<&[u8]>) -> Net<Vec<u8>> {
        let Some((key, host)) = &self.host else {
            return Net::NoAnswer("no host key on this machine to sign with".into());
        };
        let header = key.header(host, method, path, body.unwrap_or_default());
        let url = format!("{}{path}", self.origin);
        let res = match body {
            None => self.signed.get(&url).header("omarchy-host", &header).call(),
            Some(b) => self
                .signed
                .post(&url)
                .header("omarchy-host", &header)
                .header("content-type", "application/json")
                .send(b),
        };
        ok_body(self.read(res, STATE_MAX))
    }
}

/// The body of a 2xx answer; any other status sorted as [`classify`] does.
fn ok_body(answer: Net<(u16, Vec<u8>)>) -> Net<Vec<u8>> {
    match answer {
        Net::Ok((s, body)) => match classify(s) {
            Net::Ok(()) => Net::Ok(body),
            Net::Unauthorized(s) => Net::Unauthorized(s),
            Net::NoAnswer(e) => Net::NoAnswer(e),
        },
        Net::NoAnswer(e) => Net::NoAnswer(e),
        Net::Unauthorized(s) => Net::Unauthorized(s),
    }
}

impl Pool for Https {
    fn state(&mut self) -> Net<HostState> {
        match self.signed_call("GET", STATE_PATH, None) {
            Net::Ok(body) => match parse_state(&body) {
                Ok(s) => Net::Ok(s),
                Err(e) => Net::NoAnswer(e),
            },
            Net::NoAnswer(e) => Net::NoAnswer(e),
            Net::Unauthorized(s) => Net::Unauthorized(s),
        }
    }

    fn report(&mut self, body: &[u8]) -> Net<()> {
        match self.signed_call("POST", REPORT_PATH, Some(body)) {
            Net::Ok(_) => Net::Ok(()),
            Net::NoAnswer(e) => Net::NoAnswer(e),
            Net::Unauthorized(s) => Net::Unauthorized(s),
        }
    }

    fn rollback(&mut self, to: Release) -> Net<Option<Relayed>> {
        let url = format!("{}/api/v1/factory/rollback/{to}", self.origin);
        match self.get(&self.agent, &url, STATEMENT_MAX) {
            Net::Ok((404, _)) => Net::Ok(None),
            Net::Ok((s, body)) => match classify(s) {
                Net::Ok(()) => match parse_relayed(&body, to) {
                    Ok(r) => Net::Ok(Some(r)),
                    Err(e) => Net::NoAnswer(e),
                },
                Net::Unauthorized(s) => Net::Unauthorized(s),
                Net::NoAnswer(e) => Net::NoAnswer(e),
            },
            Net::NoAnswer(e) => Net::NoAnswer(e),
            Net::Unauthorized(s) => Net::Unauthorized(s),
        }
    }

    fn release_asset(&mut self, r: Release, name: &str) -> Net<Vec<u8>> {
        self.get_ok(&self.agent, &format!("{RELEASES}/{r}/{name}"), BUNDLE_MAX)
    }

    fn download(&mut self, url: &str) -> Net<Vec<u8>> {
        self.get_ok(&self.downloads, url, super::tools::MAX_TOOL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_state_is_read_leniently() {
        let body = br#"{"host":"h_0123456789","status":"active","new":{"x":1},
            "release":{"target":"v1.20.0","deployed_at":"x"},"poll_s":120,
            "updates":["wo_1",7,"bad id",""],
            "orders":[
              {"id":"ho_a","kind":"retire-legacy","not_after":"2027-01-15T09:00:00.000Z","by":"m1"},
              {"id":"ho_b","kind":"reconcile-now","not_after":1800003600},
              {"id":"ho_c","kind":"rotate-token","not_after":"2027-01-15T09:00:00Z"},
              {"id":"ho_d","kind":"reconcile-now","not_after":"soon"},
              {"id":"ho_e","not_after":"2027-01-15T09:00:00Z"},
              {"id":"bad id","kind":"reconcile-now","not_after":1},
              {"kind":"reconcile-now","not_after":1},
              "ho_f"
            ]}"#;
        let s = parse_state(body).unwrap();
        assert_eq!(s.target, Release::parse("v1.20.0"));
        assert_eq!(s.poll_s, Some(120));
        assert_eq!(s.updates, ["wo_1"]);
        let got: Vec<(&str, &str, Option<i64>)> = s
            .orders
            .iter()
            .map(|o| (o.id.as_str(), o.kind.name(), o.not_after))
            .collect();
        assert_eq!(
            got,
            [
                ("ho_a", "retire-legacy", Some(1_800_003_600)),
                ("ho_b", "reconcile-now", Some(1_800_003_600)),
                ("ho_c", "rotate-token", Some(1_800_003_600)),
                ("ho_d", "reconcile-now", None),
                ("ho_e", "", Some(1_800_003_600)),
            ]
        );
        assert!(matches!(s.orders[2].kind, OrderKind::Unknown(_)));
        // The pool's own version may lack the v; a build with no release is none, and so is
        // a pool from before #344, whose state names no release.
        assert_eq!(
            parse_state(br#"{"release":{"target":"1.2.3"}}"#)
                .unwrap()
                .target,
            Release::parse("v1.2.3")
        );
        for none in [
            &br#"{"release":{"target":"dev-abc"}}"#[..],
            br#"{"release":null,"orders":{"x":1},"updates":"wo_1"}"#,
            br#"{"host":"h_0123456789","status":"active","token":null}"#,
        ] {
            let s = parse_state(none).unwrap();
            assert_eq!(s, HostState::default());
        }
        assert!(parse_state(b"<html>").is_err());
        assert!(parse_state(b"[]").is_err());
        // A kind's word is kept without control characters, at most 64 of them.
        let k = OrderKind::parse(&format!("x\u{1b}[2K{}", "y".repeat(100)));
        assert_eq!(k.name().len(), 64);
        assert!(!k.name().contains('\u{1b}'));
    }

    #[test]
    fn statuses_sort_into_three_answers() {
        assert_eq!(classify(200), Net::Ok(()));
        assert_eq!(classify(401), Net::Unauthorized(401));
        assert_eq!(classify(403), Net::Unauthorized(403));
        for s in [500, 502, 503, 404, 426, 429, 302] {
            assert!(matches!(classify(s), Net::NoAnswer(_)), "{s}");
        }
    }

    #[test]
    fn the_relay_must_answer_for_the_release_asked() {
        let to = Release::parse("v1.13.4").unwrap();
        let ok = br#"{"to":"v1.13.4","statement":"{\"schema\":1}","bundle":"{}"}"#;
        assert_eq!(parse_relayed(ok, to).unwrap().statement, br#"{"schema":1}"#);
        let other = br#"{"to":"v1.12.0","statement":"{}","bundle":"{}"}"#;
        assert!(parse_relayed(other, to).is_err());
    }
}
