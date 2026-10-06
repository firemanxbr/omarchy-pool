//! The host's own addresses (#371, design v2 §9.4): what a task's egress sidecar refuses
//! besides the private ranges, written into `etc/dispatcher.env` as
//! `OMARCHY_HOST_ADDRESSES`. The private ranges cover a LAN address already; these matter
//! where the host has a public one, on an interface (a VPS) or behind a router that
//! forwards a port to it (a home), since a task that connects to it reaches the host.
//!
//! - Every address on the host's interfaces, IPv4 and IPv6, but loopback's and a container
//!   bridge's (docker's, podman's, libvirt's) that the egress refuses anyway: a private,
//!   CGNAT, link-local or unique local one, or one in the task subnets. A task network
//!   comes and goes with its task, and the dispatcher is not recreated for it; a bridge
//!   given a global range (docker's `fixed-cidr-v6` from the host's delegated prefix) is
//!   the host's like any other interface. They are read from the kernel's own lists —
//!   `/proc/net/fib_trie` (IPv4, matched to its interface through `/proc/net/route`) and
//!   `/proc/net/if_inet6` — so the agent runs no `ip` and needs no ioctl (no unsafe code).
//!   A Mac (#320) has no `/proc`: there they come from `/sbin/ifconfig`'s listing, read
//!   with the same rules (a vmnet bridge, `bridge100` and the like, is the VMs' NAT, as
//!   docker's is the containers'). They are the Mac's own: the `omarchy` VM's tasks leave
//!   through the Mac, and an address of the Mac is what they must not reach.
//! - An IPv6 address is written as its /64 (a wider on-link prefix narrowed to it, a
//!   narrower one kept): temporary addresses (RFC 8981) change every day inside it, and
//!   each new value would recreate the dispatcher; the /64 is the host's own link, which
//!   no task reaches anyway.
//! - The public address the host's tasks leave from ([`SEEN_FILE`] in the data directory):
//!   what install's egress probe saw, then what the pool's edge says the run loop's own
//!   request came from, asked every hour over IPv4 and not through a proxy ([`from_trace`]),
//!   and within minutes after an ask it did not answer: the host and its tasks leave
//!   through the same NAT, whose public address a home connection's provider may change at
//!   any time. An IPv4 one is kept as IPv4, never in its v4-mapped form.

use std::collections::BTreeSet;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::install::net::{is_bridge, parse_routes, Cidr, Route};

/// Where the public address the host's tasks leave from is kept, in the data directory:
/// written by install's egress probe, then by the run loop when the pool's edge says another.
pub const SEEN_FILE: &str = "egress.json";

/// An IPv6 address is refused with its /64 at least.
const V6_PREFIX: u8 = 64;

/// Where the kernel's lists are: `/proc/net` on a host, a fixture directory in the tests;
/// and on a Mac, which has none, the `ifconfig` that lists its interfaces (#320).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sources {
    pub proc_net: PathBuf,
    /// `/sbin/ifconfig` on macOS; `None` elsewhere.
    pub ifconfig: Option<PathBuf>,
}

impl Sources {
    pub fn system() -> Self {
        Self {
            proc_net: PathBuf::from("/proc/net"),
            ifconfig: cfg!(target_os = "macos").then(|| PathBuf::from(IFCONFIG)),
        }
    }

    fn read(&self, name: &str) -> String {
        // No file (macOS, or a kernel without IPv6): nothing from it.
        std::fs::read_to_string(self.proc_net.join(name)).unwrap_or_default()
    }

    /// `ifconfig -a`'s listing, when there is an `ifconfig` to ask; nothing when it fails.
    fn listing(&self) -> String {
        self.ifconfig
            .as_ref()
            .and_then(|p| {
                let mut c = std::process::Command::new(p);
                c.arg("-a");
                crate::run::exec::retry_busy(|| c.output()).ok()
            })
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    }
}

/// macOS's `ifconfig`, which lists the Mac's interfaces and their addresses.
pub const IFCONFIG: &str = "/sbin/ifconfig";

/// One address, or a range of them: `a.b.c.d`, `2001:db8:1:2::/64`. Ordered IPv4 first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Range {
    net: IpAddr,
    prefix: u8,
}

impl Range {
    /// `ip` with its host bits past `prefix` cleared.
    pub fn new(ip: IpAddr, prefix: u8) -> Self {
        match ip {
            IpAddr::V4(a) => {
                let p = prefix.min(32);
                let mask = u32::MAX.checked_shl(32 - u32::from(p)).unwrap_or(0);
                Self {
                    net: IpAddr::V4(Ipv4Addr::from(u32::from(a) & mask)),
                    prefix: p,
                }
            }
            IpAddr::V6(a) => {
                let p = prefix.min(128);
                let mask = u128::MAX.checked_shl(128 - u32::from(p)).unwrap_or(0);
                Self {
                    net: IpAddr::V6(Ipv6Addr::from(u128::from(a) & mask)),
                    prefix: p,
                }
            }
        }
    }

    /// One address alone.
    pub fn host(ip: IpAddr) -> Self {
        Self::new(ip, if ip.is_ipv4() { 32 } else { 128 })
    }

    fn full(&self) -> u8 {
        if self.net.is_ipv4() {
            32
        } else {
            128
        }
    }

    /// The one address it is, when it is one (a /32, a /128).
    pub(crate) fn address(&self) -> Option<IpAddr> {
        (self.prefix == self.full()).then_some(self.net)
    }

    /// Whether `ip` lies inside it, an IPv4 address in its v4-mapped form too.
    pub(crate) fn contains(&self, ip: IpAddr) -> bool {
        self.covers(&Range::host(ip.to_canonical()))
    }

    /// Whether `other` lies inside this range (itself included).
    fn covers(&self, other: &Range) -> bool {
        self.net.is_ipv4() == other.net.is_ipv4()
            && self.prefix <= other.prefix
            && Range::new(other.net, self.prefix).net == self.net
    }
}

impl fmt::Display for Range {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.prefix == self.full() {
            write!(f, "{}", self.net)
        } else {
            write!(f, "{}/{}", self.net, self.prefix)
        }
    }
}

/// The local IPv4 addresses `/proc/net/fib_trie` lists: a leaf (`|-- a.b.c.d`) with a
/// `/32 host LOCAL` entry under it. Both tables list them; each is kept once.
pub(crate) fn parse_fib_trie(text: &str) -> Vec<Ipv4Addr> {
    let mut out = BTreeSet::new();
    let mut leaf: Option<Ipv4Addr> = None;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(a) = t.strip_prefix("|--") {
            leaf = a.trim().parse().ok();
        } else if let Some(entry) = t.strip_prefix('/') {
            let f: Vec<&str> = entry.split_whitespace().collect();
            if f.len() >= 3 && f[..3] == ["32", "host", "LOCAL"] {
                out.extend(leaf);
            }
        } else {
            // A node (`+-- …`), or a table's name: no leaf until the next one.
            leaf = None;
        }
    }
    out.into_iter().collect()
}

/// One line of `/proc/net/if_inet6`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V6 {
    pub addr: Ipv6Addr,
    pub prefix: u8,
    pub iface: String,
}

/// `/proc/net/if_inet6`: the address in 32 hex digits, the interface's index, the prefix
/// length, the scope and the flags (in hex), the interface's name.
pub(crate) fn parse_if_inet6(text: &str) -> Vec<V6> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let (hex, plen, iface) = (f.first()?, f.get(2)?, f.get(5)?);
            if hex.len() != 32 {
                return None;
            }
            Some(V6 {
                addr: Ipv6Addr::from(u128::from_str_radix(hex, 16).ok()?),
                prefix: u8::from_str_radix(plen, 16).ok().filter(|p| *p <= 128)?,
                iface: (*iface).to_owned(),
            })
        })
        .collect()
}

/// A bridge's IPv4 address the egress refuses anyway: private (RFC 1918), carrier-grade
/// NAT, link-local, or in the task subnets.
fn refused_anyway_v4(a: Ipv4Addr, task: &[Cidr]) -> bool {
    let one = Cidr::new(u32::from(a), 32);
    a.is_private()
        || a.is_link_local()
        || Cidr::new(u32::from(Ipv4Addr::new(100, 64, 0, 0)), 10).overlaps(one)
        || task.iter().any(|t| t.overlaps(one))
}

/// A bridge's IPv6 address the egress refuses anyway: link-local or unique local.
fn refused_anyway_v6(a: Ipv6Addr) -> bool {
    a.is_unicast_link_local() || a.is_unique_local()
}

/// The interface an IPv4 address of the host is on: the most specific route that holds it
/// (the default route says nothing). `None` for an address no route holds (a /32 with an
/// on-link gateway, an address on `lo`).
fn iface_of(a: Ipv4Addr, routes: &[Route]) -> Option<&str> {
    let one = Cidr::new(u32::from(a), 32);
    routes
        .iter()
        .filter(|r| r.dest.len > 0 && r.dest.overlaps(one))
        .max_by_key(|r| r.dest.len)
        .map(|r| r.iface.as_str())
}

/// The addresses of the host's interfaces, as the egress refuses them; `task` is the task
/// subnets.
pub(crate) fn of_interfaces(
    fib_trie: &str,
    routes: &str,
    if_inet6: &str,
    task: &[Cidr],
) -> Vec<Range> {
    let routes = parse_routes(routes);
    let v4 = parse_fib_trie(fib_trie)
        .into_iter()
        .filter(|a| !a.is_loopback() && !a.is_unspecified())
        .filter(|a| !(iface_of(*a, &routes).is_some_and(is_bridge) && refused_anyway_v4(*a, task)))
        .map(|a| Range::host(IpAddr::V4(a)));
    let v6 = parse_if_inet6(if_inet6)
        .into_iter()
        // An address on `lo` but `::1` (an anycast /128, a routed service address) is the
        // host's own, as an IPv4 one there is.
        .filter(|v| !v.addr.is_loopback())
        .filter(|v| !(is_bridge(&v.iface) && refused_anyway_v6(v.addr)))
        .map(|v| Range::new(IpAddr::V6(v.addr), v.prefix.max(V6_PREFIX)));
    v4.chain(v6).collect()
}

/// A Mac's bridges: docker's names, and the vmnet bridges macOS gives its VMs' NAT
/// (`bridge100` for the `omarchy` VM's).
fn is_mac_bridge(iface: &str) -> bool {
    is_bridge(iface) || iface.starts_with("bridge")
}

/// The addresses macOS's `ifconfig -a` lists: an interface's name starts a line
/// (`en0: flags=…`), its `inet a.b.c.d …` (a point-to-point one's `inet a --> b …`) and
/// `inet6 addr[%scope] prefixlen N …` lines follow, indented.
pub(crate) fn parse_ifconfig(text: &str) -> (Vec<(Ipv4Addr, String)>, Vec<V6>) {
    let (mut v4, mut v6) = (Vec::new(), Vec::new());
    let mut iface = String::new();
    for line in text.lines() {
        if !line.starts_with([' ', '\t']) {
            iface = line
                .split_once(':')
                .map(|(n, _)| n.trim().to_owned())
                .unwrap_or_default();
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        match f.as_slice() {
            ["inet", a, ..] => v4.extend(a.parse().ok().map(|a| (a, iface.clone()))),
            ["inet6", a, rest @ ..] => {
                let prefix = rest
                    .iter()
                    .position(|w| *w == "prefixlen")
                    .and_then(|i| rest.get(i + 1)?.parse().ok())
                    .filter(|p| *p <= 128);
                let addr = a.split_once('%').map_or(*a, |(a, _)| a).parse().ok();
                if let (Some(addr), Some(prefix)) = (addr, prefix) {
                    v6.push(V6 {
                        addr,
                        prefix,
                        iface: iface.clone(),
                    });
                }
            }
            _ => {}
        }
    }
    (v4, v6)
}

/// The addresses of a Mac's interfaces as `ifconfig -a` lists them, by the same rules as
/// [`of_interfaces`]; `task` is the task subnets.
pub(crate) fn of_ifconfig(listing: &str, task: &[Cidr]) -> Vec<Range> {
    let (v4, v6) = parse_ifconfig(listing);
    let v4 = v4
        .into_iter()
        .filter(|(a, _)| !a.is_loopback() && !a.is_unspecified())
        .filter(|(a, i)| !(is_mac_bridge(i) && refused_anyway_v4(*a, task)))
        .map(|(a, _)| Range::host(IpAddr::V4(a)));
    let v6 = v6
        .into_iter()
        .filter(|v| !v.addr.is_loopback())
        .filter(|v| !(is_mac_bridge(&v.iface) && refused_anyway_v6(v.addr)))
        .map(|v| Range::new(IpAddr::V6(v.addr), v.prefix.max(V6_PREFIX)));
    v4.chain(v6).collect()
}

/// The public address the host's tasks leave from ([`SEEN_FILE`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    /// The address the pool saw the probe task (install) or the run loop come from.
    pub public: IpAddr,
    /// When (RFC 3339).
    pub at: String,
}

/// One address the pool could have seen a host come from: never loopback, unspecified or
/// multicast; an IPv4 one written as IPv4 (`::ffff:a.b.c.d` as `a.b.c.d`), the way the
/// egress judges a destination and reads its deny list.
pub(crate) fn public(ip: IpAddr) -> Option<IpAddr> {
    Some(ip.to_canonical())
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast())
}

/// The public address [`SEEN_FILE`] holds, if it holds one that reads.
pub fn seen(data: &Path) -> Option<IpAddr> {
    let b = std::fs::read(data.join(SEEN_FILE)).ok()?;
    serde_json::from_slice::<Seen>(&b)
        .ok()
        .and_then(|s| public(s.public))
}

/// [`SEEN_FILE`] written (0600) with `ip`, seen at `at` (RFC 3339).
pub fn keep_seen(data: &Path, ip: IpAddr, at: &str) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&Seen {
        public: ip.to_canonical(),
        at: at.to_owned(),
    })
    .map_err(|e| e.to_string())?;
    crate::install::files::write(data, SEEN_FILE, &body, 0o600)
}

/// The address Cloudflare's edge saw a request come from: the `ip=` line of
/// `/cdn-cgi/trace`, one address and nothing else.
pub fn from_trace(body: &str) -> Option<IpAddr> {
    body.lines()
        .find_map(|l| l.strip_prefix("ip="))
        .and_then(|a| a.trim().parse().ok())
        .and_then(public)
}

/// The host's own addresses now: its interfaces' (a container bridge's in `task` or
/// another range the egress refuses left out; a Mac's from `ifconfig`) and the public one
/// last seen, sorted, each once and none inside another.
pub(crate) fn detect(sources: &Sources, data: &Path, task: &[Cidr]) -> Vec<Range> {
    let mut all: BTreeSet<Range> = of_interfaces(
        &sources.read("fib_trie"),
        &sources.read("route"),
        &sources.read("if_inet6"),
        task,
    )
    .into_iter()
    .chain(of_ifconfig(&sources.listing(), task))
    .collect();
    all.extend(seen(data).map(Range::host));
    let all: Vec<Range> = all.into_iter().collect();
    all.iter()
        .filter(|r| !all.iter().any(|o| o != *r && o.covers(r)))
        .copied()
        .collect()
}

/// The value of `OMARCHY_HOST_ADDRESSES`: the ranges, comma-separated.
pub fn joined(ranges: &[Range]) -> String {
    ranges
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}
