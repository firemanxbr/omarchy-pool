//! libpod's own API (podman), for the one call docker's CLI cannot make on podman (#372;
//! design v2 §9.4, §10.2 inv. 8): a task network that is internal with DNS off.
//!
//! The dispatcher runs docker's CLI from the worker image on whatever socket the host set
//! mounts. On podman that socket's docker-compatible API turns DNS on for every bridge network
//! it makes and drops docker's isolated-gateway option, so a task network made through it keeps
//! a gateway at its `.1`: aardvark-dns answers there on 53, and the host (rootful) or the
//! engine's namespace (rootless) on every other port. Made through `/libpod/networks/create`
//! with `internal: true` and `dns_enabled: false`, as podman's own CLI makes it with
//! `--internal --disable-dns`, the network has no gateway and netavark puts no address on its
//! bridge: a task on it reaches its egress sidecar, the agent sidecar, and nothing else.
//!
//! Which engine answers is asked of the socket itself: libpod names its version in
//! `Libpod-Api-Version` on every answer, `/_ping`'s included, which Docker never sends. One
//! request per connection, in HTTP/1.0, so the answer is never chunked and ends with the
//! connection (reqwest speaks no unix socket, and this is all the dispatcher asks of libpod).
//!
//! podman's docker API shows such a network with `"Gateway": "<nil>"` (podman 4), which the
//! worker image's docker CLI (27.5.1) lists and removes as text; docker's CLI from 29 on reads
//! the gateway as an address and fails on it, so a newer CLI in the image needs a podman that
//! omits it.

use std::fmt::Write as _;
use std::io::{Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

/// The most of an answer read: libpod's are a few hundred bytes.
const MAX_ANSWER: u64 = 1 << 20;

/// libpod's API on one unix socket, at the version it named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Libpod {
    pub socket: PathBuf,
    /// `Libpod-Api-Version`: libpod's endpoints answer under `/v<version>/libpod/` only.
    pub version: String,
    /// How long one request may take.
    pub call: Duration,
}

impl Libpod {
    /// libpod's API on `socket`, when podman answers there: `/_ping` with its version.
    pub fn on(socket: &Path, call: Duration) -> Result<Self, String> {
        let a = request(socket, "GET", "/_ping", None, Instant::now() + call)?;
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
            call,
        })
    }

    /// `network create <args>` as the spec writes it ([`network_body`]), made through
    /// `/libpod/networks/create`.
    pub fn create_network(&self, args: &[String]) -> Result<(), String> {
        let body = network_body(args)?.to_string();
        let path = format!("/v{}/libpod/networks/create", self.version);
        let a = request(
            &self.socket,
            "POST",
            &path,
            Some(body.as_bytes()),
            Instant::now() + self.call,
        )?;
        if (200..300).contains(&a.status) {
            return Ok(());
        }
        Err(format!(
            "libpod's networks/create answered {}: {}",
            a.status,
            a.message()
        ))
    }
}

/// libpod's version as a path segment: a digit, then digits, letters, dots and dashes.
fn version_ok(v: &str) -> bool {
    v.len() <= 64
        && v.starts_with(|c: char| c.is_ascii_digit())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// Whether the spec's call is one docker's CLI cannot make on podman: a `network create` with
/// podman's `--disable-dns` ([`super::spec::Gateway::NoDns`]).
pub fn wants(args: &[String]) -> bool {
    args.len() > 2
        && args[0] == "network"
        && args[1] == "create"
        && args.iter().any(|a| a == "--disable-dns")
}

/// The request body of `/libpod/networks/create` for `network create <args>`, read in the
/// spec's own grammar (`--internal`, `--disable-dns`, `--subnet <cidr>`, `--label k=v`, the
/// name last): a bridge, internal as asked, DNS on only without `--disable-dns`. Anything else
/// (docker's `-o` among them) is refused, never dropped.
pub fn network_body(args: &[String]) -> Result<Value, String> {
    let rest = match args {
        [n, c, rest @ ..] if n == "network" && c == "create" => rest,
        _ => return Err(format!("not a network create: {args:?}")),
    };
    let (mut internal, mut dns, mut subnet, mut name) = (false, true, None, None);
    let mut labels = Map::new();
    let mut it = rest.iter();
    while let Some(w) = it.next() {
        match w.as_str() {
            "--internal" => internal = true,
            "--disable-dns" => dns = false,
            "--subnet" => {
                let s = it.next().ok_or("--subnet without a value")?;
                if subnet.replace(s.clone()).is_some() {
                    return Err("a second --subnet".into());
                }
            }
            "--label" => {
                let l = it.next().ok_or("--label without a value")?;
                let (k, v) = l
                    .split_once('=')
                    .ok_or_else(|| format!("a label without a value: {l}"))?;
                labels.insert(k.to_owned(), Value::String(v.to_owned()));
            }
            n if !n.starts_with('-') && name.is_none() => name = Some(n.to_owned()),
            w => return Err(format!("libpod is not asked for {w:?}")),
        }
    }
    let name = name.ok_or("a network without a name")?;
    let mut body = json!({
        "name": name,
        "driver": "bridge",
        "internal": internal,
        "dns_enabled": dns,
        "labels": labels,
    });
    if let Some(s) = subnet {
        body["subnets"] = json!([{ "subnet": s }]);
    }
    Ok(body)
}

/// The unix socket docker's CLI talks to, from its endpoint (`docker context inspect`'s
/// `.Endpoints.docker.Host`, which follows `DOCKER_HOST`): libpod is asked on that one.
pub fn socket_of(endpoint: &str) -> Result<PathBuf, String> {
    let e = endpoint.trim();
    e.strip_prefix("unix://")
        .filter(|p| p.starts_with('/'))
        .map(PathBuf::from)
        .ok_or_else(|| {
            format!("docker's CLI talks to {e:?}, not a unix socket libpod's API can be asked on")
        })
}

/// One answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
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
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("message")?.as_str().map(str::to_owned))
            .unwrap_or_else(|| text.trim().chars().take(300).collect())
    }
}

/// An HTTP/1.0 answer, read whole: its status, its headers, its body (cut at `Content-Length`
/// when it names one). A chunked one is refused: no server chunks for HTTP/1.0.
pub fn parse(raw: &[u8]) -> Result<Answer, String> {
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
pub fn request(
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn a_task_network_is_asked_of_libpod_internal_with_dns_off() {
        let args = words("network create --internal --disable-dns --subnet 10.231.0.48/28 --label org.omarchy-pool.task.id=7 --label org.omarchy-pool.agent.host=h_studio-1 omarchy-task-7-g_0123456789abcdef");
        assert!(wants(&args));
        assert_eq!(
            network_body(&args).unwrap(),
            json!({
                "name": "omarchy-task-7-g_0123456789abcdef",
                "driver": "bridge",
                "internal": true,
                "dns_enabled": false,
                "subnets": [{"subnet": "10.231.0.48/28"}],
                "labels": {"org.omarchy-pool.task.id": "7", "org.omarchy-pool.agent.host": "h_studio-1"},
            })
        );
        // Docker's calls and a signed exception's bridge stay on the CLI.
        for other in [
            "network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated --subnet 10.231.0.48/28 n",
            "network create --subnet 10.231.0.48/28 n",
            "network rm n",
            "create --disable-dns",
        ] {
            assert!(!wants(&words(other)), "{other}");
        }
        // Nothing outside the spec's grammar is passed on, or dropped.
        for bad in [
            "network create --internal -o x=y --disable-dns n",
            "network create --disable-dns --subnet a --subnet b n",
            "network create --disable-dns --label nokv n",
            "network create --disable-dns a b",
            "network create --disable-dns",
            "network ls --disable-dns",
        ] {
            assert!(network_body(&words(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn libpod_is_asked_on_the_socket_docker_s_cli_talks_to() {
        assert_eq!(
            socket_of("unix:///var/run/docker.sock\n").unwrap(),
            PathBuf::from("/var/run/docker.sock")
        );
        for bad in [
            "tcp://10.0.0.1:2375",
            "ssh://h",
            "unix://relative",
            "",
            "npipe:////./pipe/docker_engine",
        ] {
            assert!(socket_of(bad).is_err(), "{bad}");
        }
        assert!(version_ok("4.9.3") && version_ok("5.6.1") && version_ok("5.0.0-rc1"));
        for bad in ["", "v5", "5/../x", "5 1", &"9".repeat(65)] {
            assert!(!version_ok(bad), "{bad}");
        }
    }

    #[test]
    fn an_answer_reads_whole_or_not_at_all() {
        let a = parse(
            b"HTTP/1.0 200 OK\r\nLibpod-Api-Version: 5.6.1\r\nContent-Length: 2\r\n\r\nOKjunk",
        )
        .unwrap();
        assert_eq!(
            (a.status, a.header("libpod-api-version"), &a.body[..]),
            (200, Some("5.6.1"), &b"OK"[..])
        );
        let e = parse(b"HTTP/1.1 409 Conflict\r\n\r\n{\"cause\":\"network already exists\",\"message\":\"network name x already used: network already exists\",\"response\":409}").unwrap();
        assert_eq!(
            e.message(),
            "network name x already used: network already exists"
        );
        for bad in [
            &b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n"[..],
            b"SSH-2.0-OpenSSH\r\n\r\n",
            b"HTTP/1.0 200 OK\r\nContent-Length: 9\r\n\r\nshort",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n",
        ] {
            assert!(parse(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }

    /// A stand-in engine on a unix socket: each connection's request kept, `answer` sent back.
    fn engine(
        dir: &Path,
        answers: Vec<&'static str>,
    ) -> (PathBuf, std::thread::JoinHandle<Vec<String>>) {
        let socket = dir.join("engine.sock");
        let l = UnixListener::bind(&socket).unwrap();
        let h = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for answer in answers {
                let (mut c, _) = l.accept().unwrap();
                let mut raw = Vec::new();
                let mut buf = [0u8; 4096];
                // The request: its headers, then the body its Content-Length names.
                loop {
                    let n = c.read(&mut buf).unwrap();
                    raw.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end]
                            .lines()
                            .find_map(|l| l.strip_prefix("Content-Length: "))
                            .map_or(0, |n| n.parse::<usize>().unwrap());
                        if raw.len() >= end + 4 + len || n == 0 {
                            break;
                        }
                    }
                }
                seen.push(String::from_utf8_lossy(&raw).into_owned());
                c.write_all(answer.as_bytes()).unwrap();
            }
            seen
        });
        (socket, h)
    }

    #[test]
    fn a_network_is_made_through_libpod_at_the_version_it_named() {
        let dir = tempfile::tempdir().unwrap();
        let (socket, h) = engine(
            dir.path(),
            vec![
                "HTTP/1.0 200 OK\r\nApi-Version: 1.41\r\nLibpod-Api-Version: 4.9.3\r\nContent-Length: 2\r\n\r\nOK",
                "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"name\":\"n\",\"internal\":true,\"dns_enabled\":false}",
                "HTTP/1.0 409 Conflict\r\n\r\n{\"cause\":\"network already exists\",\"message\":\"network name n already used: network already exists\",\"response\":409}",
            ],
        );
        let l = Libpod::on(&socket, Duration::from_secs(10)).unwrap();
        assert_eq!(l.version, "4.9.3");
        let args = words("network create --internal --disable-dns --subnet 10.231.0.48/28 n");
        l.create_network(&args).unwrap();
        let e = l.create_network(&args).unwrap_err();
        assert!(e.contains("409") && e.contains("already used"), "{e}");
        let seen = h.join().unwrap();
        assert!(
            seen[0].starts_with("GET /_ping HTTP/1.0\r\n"),
            "{}",
            seen[0]
        );
        assert!(
            seen[1].starts_with("POST /v4.9.3/libpod/networks/create HTTP/1.0\r\n"),
            "{}",
            seen[1]
        );
        let body: Value = serde_json::from_str(seen[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            (body["internal"].as_bool(), body["dns_enabled"].as_bool()),
            (Some(true), Some(false))
        );
    }

    #[test]
    fn docker_or_a_silent_socket_is_not_libpod() {
        let dir = tempfile::tempdir().unwrap();
        // Docker answers /_ping without libpod's header.
        let (socket, h) = engine(
            dir.path(),
            vec!["HTTP/1.0 200 OK\r\nApi-Version: 1.51\r\nContent-Length: 2\r\n\r\nOK"],
        );
        let e = Libpod::on(&socket, Duration::from_secs(10)).unwrap_err();
        assert!(e.contains("not podman's API"), "{e}");
        h.join().unwrap();
        // One that never answers runs out of its call, not for ever.
        let quiet = dir.path().join("quiet.sock");
        let _l = UnixListener::bind(&quiet).unwrap();
        let t = Instant::now();
        let e = Libpod::on(&quiet, Duration::from_millis(300)).unwrap_err();
        assert!(t.elapsed() < Duration::from_secs(5), "{e}");
        assert!(Libpod::on(&dir.path().join("none.sock"), Duration::from_secs(1)).is_err());
    }
}
