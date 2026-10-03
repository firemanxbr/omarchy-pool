//! `pkg-repo egress` (#336, design v2 §9.4, D49): the egress sidecar of one
//! task. A small forward proxy, started per task from the worker image on the
//! task's internal network (where it listens, on its own address there) and
//! on the shared `omarchy-egress` bridge (where it listens on nothing). It
//! holds nothing: no token, no key, no mount.
//!
//! It allows `CONNECT` and plain `GET`/`HEAD` to public destinations, and
//! refuses every other method. A destination is judged by the addresses its
//! name resolves to, never by the name: RFC 1918, CGNAT, link-local (cloud
//! metadata), loopback, multicast, the reserved and documentation ranges,
//! every IPv6 address outside global unicast, and whatever `--deny` adds (the
//! task subnets, the host's own addresses) are refused. A name is resolved
//! once; the proxy connects to the very addresses it checked, so a name that
//! answers a public address to the check and a private one to the connection
//! (DNS rebinding) has no second answer to give. A name with any refused
//! address is refused whole.
//!
//! The host's own addresses reach `--deny` from the dispatcher's
//! `OMARCHY_HOST_ADDRESSES`, which the agent writes into
//! `etc/dispatcher.env` (#371): every address of the host's interfaces (an
//! IPv6 one as its /64) and the public address its install's egress probe saw
//! tasks leave from, rendered again by the run loop when they change. This
//! list is what keeps a task off them: prep-root.sh's INPUT drop matches the
//! task subnets, and this proxy's traffic comes from the `omarchy-egress`
//! bridge. `DOCKER-USER` rules are prep-root.sh's (the P0 sets issue).

use std::fmt::Write as _;
use std::io::{self, Read as _, Write as _};
use std::net::{
    IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs,
};
use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The longest request head the proxy reads.
const HEAD_MAX: usize = 16 << 10;
/// How long a client may take to send its request head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a connection to a destination may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// A tunnel or a response with no byte either way for this long is closed.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// Connections served at once; one more is answered 503. A tunnel is two threads: within the
/// sidecar's pid limit (256) with room to spare.
const MAX_CONNECTIONS: usize = 96;
/// A connection's threads copy bytes and hold little: small stacks, within the sidecar's 64 MB.
const STACK: usize = 256 << 10;

fn thread(f: impl FnOnce() + Send + 'static) -> io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new().stack_size(STACK).spawn(f)
}

/// An address range: `10.0.0.0/8`, `fe80::/10`, or one address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    net: IpAddr,
    prefix: u8,
}

impl FromStr for Cidr {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let (addr, prefix) = s.split_once('/').unwrap_or((s, ""));
        let net: IpAddr = addr
            .parse()
            .map_err(|_| format!("{s:?} is not an address or a range"))?;
        let max = if net.is_ipv4() { 32 } else { 128 };
        let prefix = if prefix.is_empty() {
            max
        } else {
            prefix
                .parse::<u8>()
                .ok()
                .filter(|p| *p <= max)
                .ok_or_else(|| format!("{s:?}: the prefix is not 0..{max}"))?
        };
        Ok(Self { net, prefix })
    }
}

impl Cidr {
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.net, ip) {
            (IpAddr::V4(n), IpAddr::V4(a)) => {
                let mask = u32::MAX
                    .checked_shl(32 - u32::from(self.prefix))
                    .unwrap_or(0);
                u32::from(n) & mask == u32::from(a) & mask
            }
            (IpAddr::V6(n), IpAddr::V6(a)) => {
                let mask = u128::MAX
                    .checked_shl(128 - u32::from(self.prefix))
                    .unwrap_or(0);
                u128::from(n) & mask == u128::from(a) & mask
            }
            _ => false,
        }
    }
}

/// The IPv4 ranges no task reaches, whatever the host (design v2 §9.4).
const REFUSED_V4: [(&str, &str); 14] = [
    ("0.0.0.0/8", "this network"),
    ("10.0.0.0/8", "a private address (RFC 1918)"),
    ("100.64.0.0/10", "a carrier-grade NAT address"),
    ("127.0.0.0/8", "loopback"),
    ("169.254.0.0/16", "link-local (cloud metadata)"),
    ("172.16.0.0/12", "a private address (RFC 1918)"),
    ("192.0.0.0/24", "an IETF protocol address"),
    ("192.0.2.0/24", "a documentation address"),
    ("192.168.0.0/16", "a private address (RFC 1918)"),
    ("198.18.0.0/15", "a benchmarking address"),
    ("198.51.100.0/24", "a documentation address"),
    ("203.0.113.0/24", "a documentation address"),
    ("224.0.0.0/4", "multicast"),
    ("240.0.0.0/4", "reserved (or broadcast)"),
];

fn refused_v4(ip: Ipv4Addr) -> Option<&'static str> {
    REFUSED_V4.iter().find_map(|(range, why)| {
        Cidr::from_str(range)
            .expect("a built-in range")
            .contains(IpAddr::V4(ip))
            .then_some(*why)
    })
}

fn refused_v6(ip: Ipv6Addr) -> Option<&'static str> {
    let in_ = |range: &str| {
        Cidr::from_str(range)
            .expect("a built-in range")
            .contains(IpAddr::V6(ip))
    };
    let embedded = |from: usize| {
        let o = ip.octets();
        Ipv4Addr::new(o[from], o[from + 1], o[from + 2], o[from + 3])
    };
    if let Some(v4) = ip.to_ipv4_mapped() {
        return refused_v4(v4);
    }
    if in_("64:ff9b::/96") {
        return refused_v4(embedded(12));
    }
    if in_("2002::/16") {
        return refused_v4(embedded(2));
    }
    if ip.is_loopback() {
        return Some("loopback");
    }
    if ip.is_multicast() {
        return Some("multicast");
    }
    if in_("fe80::/10") {
        return Some("link-local");
    }
    if in_("fc00::/7") {
        return Some("a unique local address");
    }
    if in_("2001:db8::/32") {
        return Some("a documentation address");
    }
    if in_("2001::/32") {
        return Some("a Teredo address");
    }
    if !in_("2000::/3") {
        return Some("not a global unicast address");
    }
    None
}

/// Why `ip` is refused, or `None` when it is a public address outside `deny`.
pub fn refused(ip: IpAddr, deny: &[Cidr]) -> Option<String> {
    let builtin = match ip {
        IpAddr::V4(v4) => refused_v4(v4),
        IpAddr::V6(v6) => refused_v6(v6),
    };
    if let Some(why) = builtin {
        return Some(why.to_owned());
    }
    deny.iter()
        .any(|c| c.contains(ip))
        .then(|| "an address of this host or of its task networks".to_owned())
}

type Resolver = fn(&str, u16) -> io::Result<Vec<SocketAddr>>;
type Judge = fn(IpAddr, &[Cidr]) -> Option<String>;

fn system_resolver(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    Ok((host, port).to_socket_addrs()?.collect())
}

/// What the proxy allows: the extra ranges it refuses, how it resolves a name and judges an address.
pub struct Policy {
    pub deny: Vec<Cidr>,
    pub resolve: Resolver,
    pub judge: Judge,
}

impl Policy {
    pub fn new(deny: Vec<Cidr>) -> Self {
        Self {
            deny,
            resolve: system_resolver,
            judge: refused,
        }
    }

    /// The addresses to connect to for `host:port`, every one of them judged; `Err` is the status and the words of the refusal.
    pub fn destination(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, (u16, String)> {
        let host = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host);
        if host.is_empty()
            || host.len() > 253
            || !host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b':' | b'_'))
        {
            return Err((400, format!("{host:?} is not a host name")));
        }
        if port == 0 {
            return Err((400, "port 0".into()));
        }
        // An address needs no resolver; a name is resolved once, here.
        let addrs = match host.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => (self.resolve)(host, port)
                .map_err(|e| (502, format!("{host} does not resolve: {e}")))?,
        };
        if addrs.is_empty() {
            return Err((502, format!("{host} does not resolve")));
        }
        for a in &addrs {
            if let Some(why) = (self.judge)(a.ip(), &self.deny) {
                return Err((403, format!("{host} resolves to {}: {why}", a.ip())));
            }
        }
        Ok(addrs)
    }
}

/// `host:port` or `[v6]:port`.
fn authority(s: &str, default_port: Option<u16>) -> Option<(String, u16)> {
    if s.contains('@') || s.is_empty() {
        return None;
    }
    let (host, port) = if let Some(rest) = s.strip_prefix('[') {
        let (h, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse().ok()?,
            None if after.is_empty() => default_port?,
            None => return None,
        };
        (format!("[{h}]"), port)
    } else {
        match s.rsplit_once(':') {
            Some((h, p)) if !h.contains(':') => (h.to_owned(), p.parse().ok()?),
            Some(_) => return None,
            None => (s.to_owned(), default_port?),
        }
    };
    Some((host, port))
}

fn reply(c: &mut TcpStream, status: u16, words: &str) {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let body = format!("omarchy egress: {words}\n");
    let _ = write!(
        c,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn connect(addrs: &[SocketAddr]) -> io::Result<TcpStream> {
    let mut last = io::Error::other("no address");
    for a in addrs {
        match TcpStream::connect_timeout(a, CONNECT_TIMEOUT) {
            Ok(s) => return Ok(s),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Bytes both ways until either side closes or goes quiet for [`IDLE`].
fn splice(client: &TcpStream, upstream: &TcpStream) {
    let (Ok(mut c_in), Ok(mut u_out), Ok(mut u_in), Ok(mut c_out)) = (
        client.try_clone(),
        upstream.try_clone(),
        upstream.try_clone(),
        client.try_clone(),
    ) else {
        return;
    };
    let _ = client.set_read_timeout(Some(IDLE));
    let _ = upstream.set_read_timeout(Some(IDLE));
    let Ok(up) = thread(move || {
        let _ = io::copy(&mut c_in, &mut u_out);
        let _ = u_out.shutdown(Shutdown::Write);
    }) else {
        return;
    };
    let _ = io::copy(&mut u_in, &mut c_out);
    let _ = c_out.shutdown(Shutdown::Write);
    let _ = up.join();
}

/// The destination's connection, every address judged first; `None` once the client has its refusal.
fn open(c: &mut TcpStream, policy: &Policy, host: &str, port: u16) -> Option<TcpStream> {
    let addrs = match policy.destination(host, port) {
        Ok(a) => a,
        Err((status, why)) => {
            reply(c, status, &format!("refused: {why}"));
            return None;
        }
    };
    match connect(&addrs) {
        Ok(u) => Some(u),
        Err(e) => {
            reply(c, 502, &format!("{host}:{port} does not answer: {e}"));
            None
        }
    }
}

/// A plain `GET`/`HEAD` as the origin reads it: its path, the client's headers without the proxy's, and one request per connection.
fn origin_request(method: &str, path: &str, auth: &str, headers: &[(&str, &str)]) -> String {
    let mut req = format!("{method} {path} HTTP/1.1\r\n");
    let mut host_said = false;
    for (k, v) in headers {
        let lower = k.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "proxy-connection" | "proxy-authorization" | "connection" | "keep-alive"
        ) {
            continue;
        }
        host_said |= lower == "host";
        let _ = write!(req, "{k}: {v}\r\n");
    }
    if !host_said {
        let _ = write!(req, "Host: {auth}\r\n");
    }
    req.push_str("Connection: close\r\n\r\n");
    req
}

/// One client connection: its request head, then a tunnel, a forwarded `GET`/`HEAD`, or a refusal.
pub fn handle(mut c: TcpStream, policy: &Policy) {
    let _ = c.set_read_timeout(Some(HEAD_TIMEOUT));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() >= HEAD_MAX {
            return reply(&mut c, 400, "the request head is too long");
        }
        match c.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let early = buf[end..].to_vec();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let headers: Vec<(&str, &str)> = lines
        .filter(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim(), v.trim()))
        .collect();
    match method {
        "CONNECT" => {
            let Some((host, port)) = authority(target, None) else {
                return reply(&mut c, 400, &format!("CONNECT {target:?}: not host:port"));
            };
            let Some(mut up) = open(&mut c, policy, &host, port) else {
                return;
            };
            if c.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .is_err()
                || (!early.is_empty() && up.write_all(&early).is_err())
            {
                return;
            }
            splice(&c, &up);
        }
        "GET" | "HEAD" => {
            let Some(rest) = target.strip_prefix("http://") else {
                return reply(&mut c, 400, "a GET or HEAD through the proxy names an http:// URL; https goes through CONNECT");
            };
            let (auth, path) = rest
                .find('/')
                .map_or((rest, "/"), |i| (&rest[..i], &rest[i..]));
            let Some((host, port)) = authority(auth, Some(80)) else {
                return reply(&mut c, 400, &format!("{auth:?}: not a host"));
            };
            let has_body = headers.iter().any(|(k, v)| {
                k.eq_ignore_ascii_case("transfer-encoding")
                    || (k.eq_ignore_ascii_case("content-length") && *v != "0")
            });
            if has_body || !early.is_empty() {
                return reply(&mut c, 400, "a GET or HEAD with a body");
            }
            let Some(mut up) = open(&mut c, policy, &host, port) else {
                return;
            };
            if up
                .write_all(origin_request(method, path, auth, &headers).as_bytes())
                .is_err()
            {
                return;
            }
            let _ = up.set_read_timeout(Some(IDLE));
            let _ = io::copy(&mut up, &mut c);
        }
        _ => reply(
            &mut c,
            405,
            "the egress proxy allows CONNECT, GET and HEAD only",
        ),
    }
}

/// Serves until the process ends: one thread per connection, at most [`MAX_CONNECTIONS`] at once.
pub fn serve(listener: &TcpListener, policy: &Arc<Policy>) {
    let active = Arc::new(AtomicUsize::new(0));
    for conn in listener.incoming() {
        let Ok(mut c) = conn else { continue };
        if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            active.fetch_sub(1, Ordering::SeqCst);
            reply(&mut c, 503, "too many connections at once");
            continue;
        }
        let (policy, held) = (Arc::clone(policy), Arc::clone(&active));
        // A thread that cannot start drops its connection; the proxy serves on.
        if thread(move || {
            handle(c, &policy);
            held.fetch_sub(1, Ordering::SeqCst);
        })
        .is_err()
        {
            active.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// `pkg-repo egress --listen <address>:<port> [--deny <range>]…`.
pub fn run(listen: &str, deny: &[String]) -> anyhow::Result<()> {
    let deny = deny
        .iter()
        .map(|d| Cidr::from_str(d).map_err(anyhow::Error::msg))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let listener =
        TcpListener::bind(listen).map_err(|e| anyhow::anyhow!("listening on {listen}: {e}"))?;
    eprintln!(
        "egress: listening on {listen}; public destinations only ({} more range(s) refused)",
        deny.len()
    );
    serve(&listener, &Arc::new(Policy::new(deny)));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn every_refused_range_is_refused_and_public_addresses_pass() {
        for a in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.8",
            "192.0.2.1",
            "192.168.1.221",
            "198.18.0.1",
            "198.51.100.7",
            "203.0.113.9",
            "224.0.0.251",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "2001:db8::1",
            "2001::1",
            "::ffff:169.254.169.254",
            "::ffff:10.0.0.1",
            "64:ff9b::a9fe:a9fe",
            "2002:c0a8:0101::1",
            "::127.0.0.1",
            "100::1",
        ] {
            assert!(refused(ip(a), &[]).is_some(), "{a} must be refused");
        }
        for a in [
            "1.1.1.1",
            "140.82.112.3",
            "151.101.1.69",
            "100.63.255.255",
            "100.128.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.169.0.1",
            "2606:4700:4700::1111",
            "2a04:4e42::81",
            "::ffff:1.1.1.1",
            "64:ff9b::101:101",
            "2002:0101:0101::1",
        ] {
            assert_eq!(refused(ip(a), &[]), None, "{a} is public");
        }
        assert_eq!(
            refused(ip("169.254.169.254"), &[]).unwrap(),
            "link-local (cloud metadata)"
        );
    }

    #[test]
    fn the_task_subnets_and_the_hosts_addresses_are_refused_too() {
        let deny: Vec<Cidr> = ["203.0.114.0/24", "198.51.99.7", "2a01:4f8::/32"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        assert!(refused(ip("203.0.114.40"), &deny).is_some());
        assert!(refused(ip("198.51.99.7"), &deny).is_some());
        assert!(refused(ip("198.51.99.8"), &deny).is_none());
        assert!(refused(ip("2a01:4f8:1:2::3"), &deny).is_some());
        assert!(refused(ip("10.231.0.18"), &["10.231.0.0/16".parse().unwrap()]).is_some());
        assert!("10.0.0.0/33".parse::<Cidr>().is_err());
        assert!("not-an-address".parse::<Cidr>().is_err());
        assert!("0.0.0.0/0".parse::<Cidr>().unwrap().contains(ip("8.8.8.8")));
    }

    #[test]
    fn the_agents_host_addresses_are_a_deny_list_as_written() {
        // `OMARCHY_HOST_ADDRESSES` as the agent renders it (#371): plain addresses, an IPv6
        // address as its /64 (a temporary address in it is the host's too), link-local.
        let deny: Vec<Cidr> = "203.0.114.10,2a01:4f8:1:2::/64,fe80::/64"
            .split(',')
            .map(|s| s.parse().unwrap())
            .collect();
        let host = Some("an address of this host or of its task networks".to_owned());
        assert_eq!(refused(ip("203.0.114.10"), &deny), host);
        assert_eq!(refused(ip("2a01:4f8:1:2:9c1e:44ff:fe00:7"), &deny), host);
        assert_eq!(refused(ip("2a01:4f8:1:3::1"), &deny), None);
        assert_eq!(refused(ip("203.0.114.11"), &deny), None);
    }

    fn rebinding(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        let a = |s: &str| SocketAddr::new(s.parse().unwrap(), port);
        Ok(match host {
            "public.example" => vec![a("93.184.215.14")],
            // A public name whose DNS answers a private address, or one private among public ones.
            "rebind.example" => vec![a("10.0.0.5")],
            "mixed.example" => vec![a("93.184.215.14"), a("169.254.169.254")],
            "metadata.example" => vec![a("169.254.169.254")],
            "v6.example" => vec![a("::ffff:192.168.1.1")],
            _ => return Err(io::Error::other("NXDOMAIN")),
        })
    }

    #[test]
    fn a_public_name_that_resolves_to_a_private_address_is_refused_by_its_address() {
        let p = Policy {
            deny: Vec::new(),
            resolve: rebinding,
            judge: refused,
        };
        assert_eq!(
            p.destination("public.example", 443).unwrap(),
            vec![SocketAddr::new(ip("93.184.215.14"), 443)]
        );
        for h in [
            "rebind.example",
            "mixed.example",
            "metadata.example",
            "v6.example",
        ] {
            let (status, why) = p.destination(h, 443).unwrap_err();
            assert_eq!(status, 403, "{h}: {why}");
            assert!(why.contains("resolves to"), "{why}");
        }
        assert_eq!(p.destination("169.254.169.254", 80).unwrap_err().0, 403);
        assert_eq!(p.destination("[::1]", 80).unwrap_err().0, 403);
        assert_eq!(p.destination("nowhere.example", 80).unwrap_err().0, 502);
        assert_eq!(p.destination("a b", 80).unwrap_err().0, 400);
        assert_eq!(p.destination("", 80).unwrap_err().0, 400);
    }

    #[test]
    fn authorities() {
        assert_eq!(
            authority("example.org:443", None),
            Some(("example.org".into(), 443))
        );
        assert_eq!(
            authority("[2001:db8::1]:443", None),
            Some(("[2001:db8::1]".into(), 443))
        );
        assert_eq!(
            authority("example.org", Some(80)),
            Some(("example.org".into(), 80))
        );
        assert_eq!(authority("example.org", None), None);
        assert_eq!(authority("user@example.org:443", None), None);
        assert_eq!(authority("example.org:99999", None), None);
        assert_eq!(authority("2001:db8::1:443", None), None);
    }

    /// A proxy on loopback whose judge lets loopback through, so a local destination stands in for a public one.
    fn proxy(judge: Judge) -> SocketAddr {
        fn local(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
            match host {
                "public.test" => Ok(vec![SocketAddr::new("127.0.0.1".parse().unwrap(), port)]),
                h => system_resolver(h, port),
            }
        }
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let at = l.local_addr().unwrap();
        let p = Arc::new(Policy {
            deny: Vec::new(),
            resolve: local,
            judge,
        });
        std::thread::spawn(move || serve(&l, &p));
        at
    }

    fn origin() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let mut c = c.unwrap();
                let mut buf = [0u8; 4096];
                let n = c.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                let first = req.lines().next().unwrap_or("").to_owned();
                let leaked = req.to_ascii_lowercase().contains("proxy-authorization");
                let body = format!("{first}|leaked={leaked}");
                let _ = write!(
                    c,
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    fn ask(proxy: SocketAddr, req: &str) -> String {
        let mut c = TcpStream::connect(proxy).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        c.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = c.read_to_string(&mut out);
        out
    }

    #[test]
    fn get_and_connect_reach_an_allowed_destination_and_other_methods_do_not() {
        let allow_all: Judge = |_, _| None;
        let p = proxy(allow_all);
        let port = origin();
        let got = ask(
            p,
            &format!("GET http://public.test:{port}/core/os.db HTTP/1.1\r\nHost: public.test:{port}\r\nProxy-Authorization: Basic eA==\r\n\r\n"),
        );
        assert!(got.starts_with("HTTP/1.1 200"), "{got}");
        assert!(
            got.ends_with("GET /core/os.db HTTP/1.1|leaked=false"),
            "{got}"
        );
        // A tunnel: the proxy answers 200, then the bytes are the origin's.
        let mut c = TcpStream::connect(p).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        write!(
            c,
            "CONNECT public.test:{port} HTTP/1.1\r\nHost: public.test:{port}\r\n\r\n"
        )
        .unwrap();
        let mut head = [0u8; 39];
        c.read_exact(&mut head).unwrap();
        assert_eq!(&head[..], b"HTTP/1.1 200 Connection established\r\n\r\n");
        c.write_all(b"HEAD /x HTTP/1.1\r\n\r\n").unwrap();
        let mut rest = String::new();
        let _ = c.read_to_string(&mut rest);
        assert!(rest.ends_with("HEAD /x HTTP/1.1|leaked=false"), "{rest}");
        for req in [
            format!("POST http://public.test:{port}/ HTTP/1.1\r\n\r\n"),
            format!("PUT http://public.test:{port}/ HTTP/1.1\r\n\r\n"),
            format!("GET http://public.test:{port}/ HTTP/1.1\r\ncontent-length: 3\r\n\r\nabc"),
            "GET https://public.test/ HTTP/1.1\r\n\r\n".to_owned(),
            "GET /local HTTP/1.1\r\n\r\n".to_owned(),
        ] {
            let got = ask(p, &req);
            assert!(got.starts_with("HTTP/1.1 4"), "{req:?} → {got}");
        }
    }

    #[test]
    fn the_real_judge_refuses_loopback_through_get_and_connect() {
        let p = proxy(refused);
        let port = origin();
        for req in [
            format!("GET http://127.0.0.1:{port}/ HTTP/1.1\r\n\r\n"),
            format!("CONNECT public.test:{port} HTTP/1.1\r\n\r\n"),
            "CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n".to_owned(),
            "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\n\r\n".to_owned(),
        ] {
            let got = ask(p, &req);
            assert!(got.starts_with("HTTP/1.1 403"), "{req:?} → {got}");
            assert!(got.contains("refused:"), "{got}");
        }
    }
}
