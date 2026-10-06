//! libpod's own API (podman), for what the pinned docker CLI cannot ask of podman (#372;
//! design v2 §9.4, §13.3): a task's own network, internal with DNS off, made the way the
//! dispatcher makes it (pkg-repo's `dispatch::libpod`), and which user-mode network stack a
//! rootless podman runs its bridge networks behind.
//!
//! podman's docker-compatible API turns DNS on for every bridge network it makes and drops
//! docker's isolated-gateway option, so a network made through it keeps a gateway at its `.1`
//! (aardvark-dns on 53, the engine's namespace or the host on every other port). Made through
//! `/libpod/networks/create` with `internal: true` and `dns_enabled: false` it has no gateway,
//! and netavark puts no address on its bridge.
//!
//! Which engine answers is asked of the socket itself: libpod names its version in
//! `Libpod-Api-Version` on every answer, `/_ping`'s included, which Docker never sends. One
//! request per connection, in HTTP/1.0, so the answer is never chunked and ends with the
//! connection: a few lines of std over the engine's unix socket, not an HTTP stack or a Docker
//! API client among the agent's dependencies (`tests/agent-deps.sh`).
//!
//! podman's docker API shows such a network with `"Gateway": "<nil>"` (podman 4), which the
//! pinned docker CLI (27.5.1) lists, inspects and removes as text; docker's CLI from 29 on reads
//! the gateway as an address and fails on it, so a newer pin needs a podman that omits it.

use std::fmt::Write as _;
use std::io::{Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::net::Cidr;

/// One request to libpod (design v2 §10: no call blocks for ever); its answers are small and
/// a network is made in seconds.
const CALL: Duration = Duration::from_secs(120);
/// The most of an answer read: `/libpod/info` is a few kilobytes.
const MAX_ANSWER: u64 = 1 << 20;

/// libpod's API on one unix socket, at the version it named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Libpod {
    pub socket: PathBuf,
    /// `Libpod-Api-Version`: libpod's endpoints answer under `/v<version>/libpod/` only.
    pub version: String,
}

/// What `/libpod/info` says of the engine's networks.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Info {
    pub rootless: bool,
    /// `host.rootlessNetworkCmd` (podman 5 on): `pasta` or `slirp4netns`; podman 4 does not
    /// say, and never maps pasta's guest address (`--map-guest-addr` came with podman 5.3).
    pub network_cmd: Option<String>,
}

impl Info {
    /// Rootless podman behind pasta, which maps its guest address to the host (#372).
    pub fn pasta(&self) -> bool {
        self.rootless && self.network_cmd.as_deref() == Some("pasta")
    }
}

impl Libpod {
    /// libpod's API on `socket`, when podman answers there: `/_ping` with its version.
    pub fn on(socket: &Path) -> Result<Self, String> {
        let a = request(socket, "GET", "/_ping", None, Instant::now() + CALL)?;
        let version = a
            .header("libpod-api-version")
            .ok_or_else(|| {
                format!(
                    "{} answers without Libpod-Api-Version: not podman's API",
                    socket.display()
                )
            })?
            .to_owned();
        if !version_ok(&version) {
            return Err(format!(
                "{} names libpod's version {version:?}, which does not read",
                socket.display()
            ));
        }
        Ok(Libpod {
            socket: socket.to_owned(),
            version,
        })
    }

    fn call(&self, method: &str, what: &str, body: Option<&str>) -> Result<Answer, String> {
        let path = format!("/v{}/libpod/{what}", self.version);
        let a = request(
            &self.socket,
            method,
            &path,
            body.map(str::as_bytes),
            Instant::now() + CALL,
        )?;
        if (200..300).contains(&a.status) {
            Ok(a)
        } else {
            Err(format!(
                "libpod's {what} answered {}: {}",
                a.status,
                a.message()
            ))
        }
    }

    /// A task's own network as the dispatcher asks libpod for it: a bridge on `subnet`,
    /// internal, DNS off, so it has no gateway; labelled with `labels`.
    pub fn create_network(
        &self,
        name: &str,
        subnet: Cidr,
        labels: &[(&str, &str)],
    ) -> Result<(), String> {
        self.call(
            "POST",
            "networks/create",
            Some(&network_body(name, subnet, labels)),
        )
        .map(|_| ())
    }

    /// `/libpod/info`, read ([`parse_info`]).
    pub fn info(&self) -> Result<Info, String> {
        let a = self.call("GET", "info", None)?;
        parse_info(&String::from_utf8_lossy(&a.body))
    }
}

/// libpod's version as a path segment: a digit, then digits, letters, dots and dashes.
fn version_ok(v: &str) -> bool {
    v.len() <= 64
        && v.starts_with(|c: char| c.is_ascii_digit())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// The body of `/libpod/networks/create` for a task's own network.
pub(crate) fn network_body(name: &str, subnet: Cidr, labels: &[(&str, &str)]) -> String {
    let labels: serde_json::Map<String, serde_json::Value> = labels
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).into()))
        .collect();
    serde_json::json!({
        "name": name,
        "driver": "bridge",
        "internal": true,
        "dns_enabled": false,
        "subnets": [{ "subnet": subnet.to_string() }],
        "labels": labels,
    })
    .to_string()
}

/// `/libpod/info`'s answer: whether the engine is rootless (`host.security.rootless`) and its
/// rootless network command (`host.rootlessNetworkCmd`), when it names one.
pub(crate) fn parse_info(json: &str) -> Result<Info, String> {
    let v: serde_json::Value =
        serde_json::from_str(json.trim()).map_err(|_| "libpod's info does not read".to_owned())?;
    let host = v.get("host").ok_or("libpod's info has no host")?;
    Ok(Info {
        rootless: host
            .pointer("/security/rootless")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        network_cmd: host
            .get("rootlessNetworkCmd")
            .and_then(serde_json::Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_owned),
    })
}

/// One answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Answer {
    pub status: u16,
    /// Names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Answer {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// What an error answer says: libpod's `message`, else the body as it is.
    fn message(&self) -> String {
        let text = String::from_utf8_lossy(&self.body);
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("message")?.as_str().map(str::to_owned))
            .unwrap_or_else(|| text.trim().chars().take(300).collect())
    }
}

/// An HTTP/1.0 answer, read whole: its status, its headers, its body (cut at `Content-Length`
/// when it names one). A chunked one is refused: no server chunks for HTTP/1.0.
pub(crate) fn parse(raw: &[u8]) -> Result<Answer, String> {
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("an answer without the end of its headers")?;
    let head =
        std::str::from_utf8(&raw[..end]).map_err(|_| "an answer whose headers are not text")?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .strip_prefix("HTTP/1.")
        .and_then(|s| s.split(' ').nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| format!("an answer whose status does not read: {status_line:?}"))?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let mut a = Answer {
        status,
        headers,
        body: raw[end + 4..].to_vec(),
    };
    if a.header("transfer-encoding")
        .is_some_and(|t| t.eq_ignore_ascii_case("chunked"))
    {
        return Err("a chunked answer to an HTTP/1.0 request".into());
    }
    if let Some(n) = a
        .header("content-length")
        .and_then(|n| n.parse::<usize>().ok())
    {
        if a.body.len() < n {
            return Err(format!(
                "an answer cut short ({} of {n} bytes)",
                a.body.len()
            ));
        }
        a.body.truncate(n);
    }
    Ok(a)
}

/// One request on `socket`, its answer read until the server closes the connection, all of it
/// before `deadline`.
pub(crate) fn request(
    socket: &Path,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    deadline: Instant,
) -> Result<Answer, String> {
    let at = |e: std::io::Error| format!("{}: {e}", socket.display());
    let left = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| {
                format!(
                    "{} did not answer {method} {path} in time",
                    socket.display()
                )
            })
    };
    let mut s = UnixStream::connect(socket).map_err(at)?;
    s.set_write_timeout(Some(left()?)).map_err(at)?;
    let mut req = format!("{method} {path} HTTP/1.0\r\nHost: libpod\r\n");
    if let Some(b) = body {
        let _ = write!(
            req,
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        );
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).map_err(at)?;
    if let Some(b) = body {
        s.write_all(b).map_err(at)?;
    }
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        s.set_read_timeout(Some(left()?)).map_err(at)?;
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() as u64 > MAX_ANSWER {
                    return Err(format!(
                        "{} answered more than {MAX_ANSWER} bytes",
                        socket.display()
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(at(e)),
        }
    }
    parse(&raw)
}
