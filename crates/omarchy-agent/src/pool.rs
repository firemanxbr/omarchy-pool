//! The agent's HTTPS to the pool (design v2 §11.1 M1, #321): one origin, fixed at
//! install; blocking calls with a 60 s ceiling; rustls on aws-lc-rs with the webpki
//! roots. Plain HTTP only to a loopback address (a pool on the same machine: the E2E).
//!
//! The run loop (#315) builds on this: an answer is a status and a JSON value, never an
//! error that stops the agent (§16.4); what to do with a 401 or a 5xx is the caller's.

use std::sync::Arc;
use std::time::Duration;

use crate::host::HostKey;

/// The pool every host talks to unless told otherwise: the first of the signed `pools`
/// (factory/bundle/manifest.toml). Install checks a `--pool` against the verified list
/// (#317).
pub const DEFAULT_POOL: &str = "https://pkgs.omarchy-pool.org";
/// The ceiling of one call.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(60);

pub struct Pool {
    origin: String,
    agent: ureq::Agent,
}

/// An answer: its status and its body as JSON (`null` when it was not JSON).
#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    pub json: serde_json::Value,
}

impl Answer {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    /// The pool's own words for a refusal (`error`, and `code` when it gives one).
    pub fn why(&self) -> String {
        let e = shown(self.json["error"].as_str().unwrap_or("no reason given"));
        match self.json["code"].as_str() {
            Some(c) => format!("{e} ({}, HTTP {})", shown(c), self.status),
            None => format!("{e} (HTTP {})", self.status),
        }
    }
}

/// A string the pool sent, as the terminal may print it: no control character, so no
/// escape sequence of the pool's can move the cursor or rewrite a line the owner reads
/// (the fingerprint above all).
pub fn shown(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}

/// Whether `origin` is one this agent may talk to: https, or http to a loopback address.
pub fn check_origin(origin: &str) -> Result<String, String> {
    let o = origin.trim_end_matches('/');
    let rest = if let Some(r) = o.strip_prefix("https://") {
        r
    } else if let Some(r) = o.strip_prefix("http://") {
        let host = r.rsplit_once(':').map_or(r, |(h, _)| h);
        if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
            return Err(format!(
                "{origin}: the pool is reached over https (plain http only on this machine)"
            ));
        }
        r
    } else {
        return Err(format!("{origin}: the pool is an https:// origin"));
    };
    if rest.is_empty() || rest.contains('/') || rest.contains('@') || rest.contains('?') {
        return Err(format!("{origin}: an origin only — scheme, host, port"));
    }
    Ok(o.to_owned())
}

/// rustls on aws-lc-rs with the webpki roots: every HTTPS call the agent makes (the pool
/// here, and the run loop's to the pool and GitHub, #315). ureq is built without a
/// provider of its own, so none other (`ring`) is ever in the tree.
pub(crate) fn tls() -> ureq::tls::TlsConfig {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::Rustls)
        .unversioned_rustls_crypto_provider(provider)
        .build()
}

impl Pool {
    pub fn new(origin: &str) -> Result<Self, String> {
        let origin = check_origin(origin)?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(tls())
            .timeout_global(Some(CALL_TIMEOUT))
            .http_status_as_error(false)
            // One origin: a 3xx is an answer the caller sees, never a second origin a
            // signed request (its Omarchy-Host header) would follow.
            .max_redirects(0)
            .https_only(!origin.starts_with("http://"))
            .user_agent(format!("omarchy-agent/{}", crate::AGENT_VERSION))
            .build()
            .into();
        Ok(Self { origin, agent })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// An unsigned JSON POST (the enrollment, whose token and proof are in the body).
    pub fn post(&self, path: &str, body: &serde_json::Value) -> Result<Answer, String> {
        let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        let res = self
            .agent
            .post(format!("{}{path}", self.origin))
            .header("content-type", "application/json")
            .send(&bytes[..]);
        answer(res)
    }

    /// A call signed with the host key (`Omarchy-Host`, design v2 D7).
    pub fn signed(
        &self,
        key: &HostKey,
        host: &str,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<Answer, String> {
        let bytes = match body {
            Some(b) => serde_json::to_vec(b).map_err(|e| e.to_string())?,
            None => Vec::new(),
        };
        let header = key.header(host, method, path, &bytes)?;
        let url = format!("{}{path}", self.origin);
        let res = match method {
            "GET" => self
                .agent
                .get(&url)
                .header(crate::host::HEADER, &header)
                .call(),
            "POST" => self
                .agent
                .post(&url)
                .header(crate::host::HEADER, &header)
                .header("content-type", "application/json")
                .send(&bytes[..]),
            _ => return Err(format!("{method}: not a method the agent uses")),
        };
        answer(res)
    }
}

fn answer(res: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Answer, String> {
    let mut res = res.map_err(|e| format!("the pool did not answer: {e}"))?;
    let status = res.status().as_u16();
    let text = res
        .body_mut()
        .with_config()
        .limit(1 << 20)
        .read_to_string()
        .unwrap_or_default();
    Ok(Answer {
        status,
        json: serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_loopback_http_origins() {
        assert_eq!(
            check_origin("https://pkgs.omarchy-pool.org/").unwrap(),
            "https://pkgs.omarchy-pool.org"
        );
        assert!(check_origin("http://127.0.0.1:8787").is_ok());
        assert!(check_origin("http://localhost:8787").is_ok());
        for bad in [
            "http://pkgs.omarchy-pool.org",
            "http://10.0.0.2:8787",
            "ftp://x",
            "https://x/api",
            "https://user@x",
            "https://",
        ] {
            assert!(check_origin(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_pool_s_words_reach_the_terminal_without_escape_sequences() {
        let a = Answer {
            status: 409,
            json: serde_json::json!({"error": "taken \u{1b}[2K\rhost key fingerprint: SHA256:x — no", "code": "c\u{9b}1A"}),
        };
        assert_eq!(
            a.why(),
            "taken [2Khost key fingerprint: SHA256:x — no (c1A, HTTP 409)"
        );
    }
}
