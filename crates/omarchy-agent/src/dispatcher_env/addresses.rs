//! The host's own addresses (#371, design v2 §9.4): what a task's egress sidecar refuses
//! besides the private ranges, written into `etc/dispatcher.env` as
//! `OMARCHY_HOST_ADDRESSES`. The private ranges cover a LAN address already; these matter
//! where the host has a public one, on an interface (a VPS) or behind a router that
//! forwards a port to it (a home), since a task that connects to it reaches the host.
//!
//! - Every address on the host's interfaces, IPv4 and IPv6, but loopback's and those of
//!   container bridges (docker's, podman's, libvirt's: a task network comes and goes with
//!   its task, and its range is refused by the egress anyway). They are read from the
//!   kernel's own lists — `/proc/net/fib_trie` (IPv4, matched to its interface through
//!   `/proc/net/route`) and `/proc/net/if_inet6` — so the agent runs no `ip` and needs no
//!   ioctl (no unsafe code).
//! - An IPv6 address is written as its /64 (a wider on-link prefix narrowed to it, a
//!   narrower one kept): temporary addresses (RFC 8981) change every day inside it, and
//!   each new value would recreate the dispatcher; the /64 is the host's own link, which
//!   no task reaches anyway.
//! - The public address the install's egress probe saw tasks leave from ([`SEEN_FILE`]
//!   in the data directory, written by install).

use std::collections::BTreeSet;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::install::net::{is_bridge, parse_routes, Cidr, Route};

/// Where the install's egress probe keeps the public address it saw, in the data directory.
pub const SEEN_FILE: &str = "egress.json";

/// An IPv6 address is refused with its /64 at least.
const V6_PREFIX: u8 = 64;

/// Where the kernel's lists are: `/proc/net` on a host, a fixture directory in the tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sources {
    pub proc_net: PathBuf,
}

impl Sources {
    pub fn system() -> Self {
        Self {
            proc_net: PathBuf::from("/proc/net"),
        }
    }

    fn read(&self, name: &str) -> String {
        // No file (macOS, or a kernel without IPv6): nothing from it.
        std::fs::read_to_string(self.proc_net.join(name)).unwrap_or_default()
    }
}

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

/// The addresses of the host's interfaces, as the egress refuses them.
pub(crate) fn of_interfaces(fib_trie: &str, routes: &str, if_inet6: &str) -> Vec<Range> {
    let routes = parse_routes(routes);
    let v4 = parse_fib_trie(fib_trie)
        .into_iter()
        .filter(|a| !a.is_loopback() && !a.is_unspecified())
        .filter(|a| !iface_of(*a, &routes).is_some_and(is_bridge))
        .map(|a| Range::host(IpAddr::V4(a)));
    let v6 = parse_if_inet6(if_inet6)
        .into_iter()
        .filter(|v| v.iface != "lo" && !v.addr.is_loopback() && !is_bridge(&v.iface))
        .map(|v| Range::new(IpAddr::V6(v.addr), v.prefix.max(V6_PREFIX)));
    v4.chain(v6).collect()
}

/// What install's egress probe saw ([`SEEN_FILE`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    /// The address the pool saw the probe task come from.
    pub public: IpAddr,
    /// When (RFC 3339).
    pub at: String,
}

/// The public address [`SEEN_FILE`] holds, if it holds one that reads.
pub fn seen(data: &Path) -> Option<IpAddr> {
    let b = std::fs::read(data.join(SEEN_FILE)).ok()?;
    serde_json::from_slice::<Seen>(&b)
        .ok()
        .map(|s| s.public)
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast())
}

/// The host's own addresses now: its interfaces' and the public one install saw, sorted,
/// each once and none inside another.
pub fn detect(sources: &Sources, data: &Path) -> Vec<Range> {
    let mut all: BTreeSet<Range> = of_interfaces(
        &sources.read("fib_trie"),
        &sources.read("route"),
        &sources.read("if_inet6"),
    )
    .into_iter()
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
