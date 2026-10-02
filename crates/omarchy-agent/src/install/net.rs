//! IPv4 ranges for preflight (#317, design v2 §13.3): the task subnets against the host's
//! routes and other projects' networks, and where the host's default gateway and LAN
//! address are (the egress probe's targets). Task networks are IPv4 only.

use std::net::{Ipv4Addr, UdpSocket};

/// An IPv4 network, `a.b.c.d/len`, its host bits cleared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Cidr {
    pub addr: u32,
    pub len: u8,
}

impl Cidr {
    pub fn parse(s: &str) -> Option<Self> {
        let (a, l) = s.trim().split_once('/')?;
        let addr: Ipv4Addr = a.parse().ok()?;
        let len: u8 = l.parse().ok().filter(|l| *l <= 32)?;
        Some(Self::new(u32::from(addr), len))
    }

    pub fn new(addr: u32, len: u8) -> Self {
        Cidr {
            addr: addr & Self::mask(len),
            len,
        }
    }

    fn mask(len: u8) -> u32 {
        if len == 0 {
            0
        } else {
            u32::MAX << (32 - u32::from(len))
        }
    }

    pub fn overlaps(self, other: Cidr) -> bool {
        let m = Self::mask(self.len.min(other.len));
        self.addr & m == other.addr & m
    }

    /// The last /28 of the range: where the egress probe's own network goes, away from the
    /// first task networks a running dispatcher hands out.
    pub fn last_28(self) -> Option<Cidr> {
        (self.len <= 28).then(|| Cidr::new(self.addr | !Self::mask(self.len), 28))
    }
}

impl std::fmt::Display for Cidr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", Ipv4Addr::from(self.addr), self.len)
    }
}

/// The task subnets as agent.toml writes them: CIDRs separated by commas.
pub(crate) fn parse_list(s: &str) -> Result<Vec<Cidr>, String> {
    s.split(',')
        .map(|p| Cidr::parse(p).ok_or_else(|| format!("{p:?} is not an IPv4 CIDR")))
        .collect()
}

/// One line of `/proc/net/route`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Route {
    pub iface: String,
    pub dest: Cidr,
    pub gateway: Option<Ipv4Addr>,
}

/// An address as `/proc/net/route` prints it: the kernel's bytes in hex, read on a
/// little-endian machine (`x86_64` and `aarch64`, the only ones the agent ships for).
fn route_hex(s: &str) -> Option<u32> {
    u32::from_str_radix(s, 16).ok().map(u32::swap_bytes)
}

/// `/proc/net/route`'s routes.
pub(crate) fn parse_routes(text: &str) -> Vec<Route> {
    text.lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let dest = route_hex(f.get(1)?)?;
            let gw = route_hex(f.get(2)?)?;
            let mask = route_hex(f.get(7)?)?;
            Some(Route {
                iface: (*f.first()?).to_owned(),
                dest: Cidr::new(dest, u8::try_from(mask.count_ones()).ok()?),
                gateway: (gw != 0).then(|| Ipv4Addr::from(gw)),
            })
        })
        .collect()
}

/// The interfaces of container bridges: their networks are checked one by one (with the
/// agent's own left out), not as host routes.
pub(crate) fn is_bridge(iface: &str) -> bool {
    ["br-", "docker", "podman", "cni", "veth", "virbr"]
        .iter()
        .any(|p| iface.starts_with(p))
}

/// The default route's gateway.
pub(crate) fn default_gateway(routes: &[Route]) -> Option<Ipv4Addr> {
    routes
        .iter()
        .find(|r| r.dest.len == 0)
        .and_then(|r| r.gateway)
}

/// The address the host sends from towards the internet: a UDP socket "connected" to a
/// public address sends nothing, and its local address is the LAN address.
pub(crate) fn lan_address() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(a) if !a.is_unspecified() && !a.is_loopback() => Some(a),
        _ => None,
    }
}
