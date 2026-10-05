//! What the agent asks over the network (design v2 §16.1, §16.4): the pool's `follow`
//! (the target until P3's host state, #344) and its rollback relay, and the release assets
//! on GitHub. Answers are read leniently and sorted three ways; none of them ever stops
//! the agent: no answer, a 5xx or a malformed body changes nothing; a 401/403 changes
//! nothing and slows the polls to hourly.

use std::io::Read;
use std::net::IpAddr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

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

/// What `GET /api/v1/factory/follow?ids=<worker>` says, as far as the agent reads it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Follow {
    /// The pool's release; `None` when it runs none (a build with no tag).
    pub latest: Option<Release>,
    /// The open Update order for this host's worker, if any.
    pub update: Option<String>,
    /// How often the pool asks to be polled, in seconds.
    pub poll_s: Option<i64>,
}

/// A signed rollback statement as the pool relays it: the exact signed bytes and the
/// Sigstore bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Relayed {
    pub statement: Vec<u8>,
    pub bundle: Vec<u8>,
}

pub(crate) trait Pool {
    fn follow(&mut self, worker_id: &str) -> Net<Follow>;
    /// `Ok(None)`: the pool has no statement for going back to `to` (404).
    fn rollback(&mut self, to: Release) -> Net<Option<Relayed>>;
    /// A file of release `r` on GitHub (the host bundle and its signature).
    fn release_asset(&mut self, r: Release, name: &str) -> Net<Vec<u8>>;
    /// A pinned tool (checked by SHA-256 by the caller).
    fn download(&mut self, url: &str) -> Net<Vec<u8>>;
    /// The public address the pool's edge sees this host come from over IPv4 (#371): the
    /// one its tasks leave from too, through the same NAT.
    fn public_address(&mut self) -> Net<IpAddr>;
}

const FOLLOW_MAX: u64 = 64 << 10;
/// `/cdn-cgi/trace` is a dozen short lines.
const TRACE_MAX: u64 = 4 << 10;
const STATEMENT_MAX: u64 = 1 << 20;
const BUNDLE_MAX: u64 = 64 << 20;
pub(crate) const RELEASES: &str = "https://github.com/firemanxbr/omarchy-pool/releases/download";

/// Reads a `follow` body leniently: unknown fields ignored, a `latest` that is not a
/// release read as none. `worker_id`'s entry gives the open Update, if any.
pub(crate) fn parse_follow(body: &[u8], worker_id: &str) -> Result<Follow, String> {
    #[derive(Deserialize)]
    struct Raw {
        latest: Option<String>,
        poll_s: Option<i64>,
        #[serde(default)]
        workers: Vec<Worker>,
    }
    #[derive(Deserialize)]
    struct Worker {
        id: String,
        update: Option<String>,
    }
    let raw: Raw = serde_json::from_slice(body).map_err(|e| format!("follow: {e}"))?;
    let latest = raw.latest.as_deref().and_then(|l| {
        let l = l.trim();
        Release::parse(l).or_else(|| Release::parse(&format!("v{l}")))
    });
    let update = raw
        .workers
        .into_iter()
        .find(|w| w.id == worker_id)
        .and_then(|w| w.update)
        .filter(|u| !u.is_empty() && u.len() <= 128);
    Ok(Follow {
        latest,
        update,
        poll_s: raw.poll_s,
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
    downloads: ureq::Agent,
    /// IPv4 only and never through a proxy: the way a task's egress leaves the host.
    direct_v4: ureq::Agent,
    /// The watchdog's clock, moved on as a body's bytes arrive: a long download is
    /// progress, a stalled one is not.
    progress: Option<Arc<AtomicI64>>,
}

impl Https {
    /// `origin` is agent.toml's `pool`, already checked to be an `https://` origin.
    pub fn new(origin: &str) -> Self {
        let config = |timeout: Duration| {
            ureq::Agent::config_builder()
                .tls_config(crate::pool::tls())
                .timeout_global(Some(timeout))
                .http_status_as_error(false)
                .https_only(true)
                .user_agent(format!("omarchy-agent/{}", crate::AGENT_VERSION))
        };
        Https {
            origin: origin.trim_end_matches('/').to_owned(),
            agent: config(Duration::from_secs(60)).build().into(),
            // The pinned tools are tens of MiB: a longer deadline, still a deadline.
            downloads: config(Duration::from_secs(600)).build().into(),
            direct_v4: config(Duration::from_secs(20))
                .ip_family(ureq::config::IpFamily::Ipv4Only)
                .proxy(None)
                .build()
                .into(),
            progress: None,
        }
    }

    pub fn with_progress(mut self, progress: Arc<AtomicI64>) -> Self {
        self.progress = Some(progress);
        self
    }

    fn get(&self, agent: &ureq::Agent, url: &str, max: u64) -> Net<(u16, Vec<u8>)> {
        let mut res = match agent.get(url).call() {
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

    fn get_ok(&self, agent: &ureq::Agent, url: &str, max: u64) -> Net<Vec<u8>> {
        match self.get(agent, url, max) {
            Net::Ok((s, body)) => match classify(s) {
                Net::Ok(()) => Net::Ok(body),
                Net::Unauthorized(s) => Net::Unauthorized(s),
                Net::NoAnswer(e) => Net::NoAnswer(e),
            },
            Net::NoAnswer(e) => Net::NoAnswer(e),
            Net::Unauthorized(s) => Net::Unauthorized(s),
        }
    }
}

impl Pool for Https {
    fn follow(&mut self, worker_id: &str) -> Net<Follow> {
        let url = format!("{}/api/v1/factory/follow?ids={worker_id}", self.origin);
        match self.get_ok(&self.agent, &url, FOLLOW_MAX) {
            Net::Ok(body) => match parse_follow(&body, worker_id) {
                Ok(f) => Net::Ok(f),
                Err(e) => Net::NoAnswer(e),
            },
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

    fn public_address(&mut self) -> Net<IpAddr> {
        let url = format!("{}/cdn-cgi/trace", self.origin);
        match self.get_ok(&self.direct_v4, &url, TRACE_MAX) {
            Net::Ok(body) => {
                crate::dispatcher_env::addresses::from_trace(&String::from_utf8_lossy(&body))
                    .map_or_else(|| Net::NoAnswer(format!("{url}: no ip= line")), Net::Ok)
            }
            Net::NoAnswer(e) => Net::NoAnswer(e),
            Net::Unauthorized(s) => Net::Unauthorized(s),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follow_is_read_leniently() {
        let body = br#"{"latest":"v1.20.0","deployed_at":"x","poll_s":120,"new":1,
            "workers":[{"id":"other","update":"o1"},{"id":"w_host","version":"v1.19.0","outdated":true,"update":"ord_7"}]}"#;
        let f = parse_follow(body, "w_host").unwrap();
        assert_eq!(f.latest, Release::parse("v1.20.0"));
        assert_eq!(f.update.as_deref(), Some("ord_7"));
        assert_eq!(f.poll_s, Some(120));
        // The pool's own version may lack the v; a build with no release is none.
        assert_eq!(
            parse_follow(br#"{"latest":"1.2.3"}"#, "w").unwrap().latest,
            Release::parse("v1.2.3")
        );
        assert_eq!(
            parse_follow(br#"{"latest":"dev-abc"}"#, "w")
                .unwrap()
                .latest,
            None
        );
        assert!(parse_follow(b"<html>", "w").is_err());
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
