//! The egress probe (#317, #367, #372, #373; design v2 §9.4, §13.3): probe tasks must fail to
//! reach the cloud metadata address, the default gateway, the host's LAN address, the host's
//! own addresses, their own network's gateway and, on rootless podman behind pasta, pasta's
//! guest-mapped address, and must reach a public address. Anything they reach that they must
//! not — a connection made, or one refused, which is an answer from the target too — fails the
//! install; so does a public address they cannot reach, or a target they gave no answer for.
//!
//! The probe runs the way a task runs (#373): on a network made like a task's own
//! ([`super::engine::task_network`]: internal, and on Docker in its isolated gateway mode, on
//! podman through libpod's own API with DNS off, as the dispatcher makes it, #372), carved from
//! the task subnets (their last /28), with its **egress sidecar**: the release's worker image in
//! its `egress` role, started as the dispatcher starts one (pkg-repo's `dispatch::spec`, mirrored
//! by [`sidecar`]) — on a bridge of its own first, the probe's stand-in for the shared
//! `omarchy-egress`, then attached to the task network at its `.2` — refusing what the
//! dispatcher's would: the task subnets and the host's own addresses, `OMARCHY_HOST_ADDRESSES`
//! as the agent renders it now ([`crate::dispatcher_env::addresses`], #371). The probe task, at
//! the network's last address, away from `.1`, tries every target twice: straight from its
//! network, where nothing may answer (the network is internal, with no route off its subnet
//! and no gateway at its `.1`), and through its sidecar (`CONNECT`), which must refuse it (403)
//! or find nothing there; and a public mirror (GitHub) through the sidecar, which must answer.
//! A rootless engine's bridges leave through its user-mode network stack, where the LAN and the
//! router answer; a task's never do, since its one way out is a sidecar that refuses them, and
//! so a rootless host passes a probe that tests the path its tasks take.
//!
//! The probe task also asks the pool, through its sidecar, which address it comes from (#371):
//! the pool's origin answers `/cdn-cgi/trace` at Cloudflare's edge, whose `ip=` line is the
//! public address the host's tasks leave from. Install keeps it (`egress.json`) and the agent
//! writes it with the host's own addresses for every task's egress to refuse
//! ([`crate::dispatcher_env`]): behind a router that forwards a port, a task connecting to it
//! would reach the host. An address the sidecar was not given yet (a first install, or a new
//! one) is probed once more, by a sidecar given it, as the dispatcher's will be. The run loop
//! asks the edge again every hour (within minutes after no answer), from the host (the same
//! NAT), for when the provider changes it. Not seen (no curl in the image, no answer) is a
//! note, never a blocker: the interfaces' addresses are refused all the same, and the run
//! loop's first answer adds it.
//!
//! A **signed exception's bridge** — the plain bridge network a package with `network =
//! "direct"` in `factory/sizing` gets, raw sockets and all — is probed too, and only, where the
//! owner's envelope grants it (`direct_network`, `--direct-network`): a host that does not grant
//! it hands such a package's tasks back (the dispatcher's `OMARCHY_DIRECT_NETWORK`). On that
//! bridge the probe task tries the metadata address, the default gateway, the LAN address and a
//! public one directly, and the bridge's own gateway on 22, 53 and the pool's ports
//! ([`GATEWAY_PORTS`]), which is what prep-root.sh's DOCKER-USER rules guard on a rootful host.
//! On a rootful engine that gateway, like the LAN address, is the host itself: DOCKER-USER sits
//! in FORWARD, which traffic to the host never crosses (CVE-2024-29018), so only prep-root.sh's
//! INPUT drop for the task subnets (`OMARCHY-TASKS-HOST`) keeps a task off it. A rootless
//! engine's bridge reaches the LAN through its user-mode stack, and its gateway is the engine's
//! own namespace: a rootless host cannot grant the exception, and the probe says so.
//!
//! On rootless podman behind pasta (libpod's `/info` says which stack it runs), the probe tasks
//! also try pasta's guest-mapped address ([`PASTA_GUEST`], podman's `--map-guest-addr` from 5.3
//! on), which pasta forwards to the host's own address, where its services listen: anything
//! there fails the install, with the containers.conf setting that turns the mapping off
//! ([`GUEST_SETTING`]). From a task's own network it is unreachable, and its sidecar refuses
//! link-local addresses; from a bridge it has a route. An address pasta's command line maps that
//! the probe did not try (one an owner set) is refused the same way
//! ([`loopback::guest_verdict`]).
//!
//! On a Mac (#320) the probe runs in the `omarchy` VM, whose task firewall the agent puts
//! there itself (`crate::vm::firewall`, before the probe), and the probe tasks have one more
//! target: the Mac as the VM reaches it (Lima's `host.lima.internal`). Colima's NAT
//! would carry a bridge's connection to the Mac's router and LAN otherwise. A bridge's gateway
//! there is the VM itself, which that firewall's INPUT drop closes as prep-root.sh's does on
//! a Linux host ([`Advice::vm`]); preflight reads neither prep-root.sh's files nor a network
//! stack's command line on a Mac. The agent puts nothing in Docker Desktop's or `OrbStack`'s
//! VM: such a host is judged on the probe's answers like any other.
//!
//! On a rootful engine on Linux preflight also reads prep-root.sh's firewall script and its
//! boot unit, which are world-readable: a script that does not drop every task subnet, or
//! none, or a unit that is not there or not enabled (a reboot would take the drop away),
//! refuses the install with the command that installs it ([`unprepared`],
//! [`firewall_command`]), whatever the probe says: it is the second layer under every task
//! network (design v2 §9.4), and a host's own firewall may close the ports probed and leave the
//! others open. The agent is never root and cannot read the rules in effect: where the envelope
//! grants a signed exception's bridge, whose gateway and the LAN address are the host itself,
//! that bridge's probe is what shows they hold (a rule flushed since the unit ran is refused with
//! the command that puts it back). Without the grant no probe target crosses INPUT — a task's
//! own network has no address of the host's (Docker's isolated gateway mode, libpod's network
//! with DNS off) and no route off its subnet, and its sidecar refuses the LAN — so preflight
//! reads the script and the unit only, and the drop is the second layer under task networks
//! that reach nothing of the host's.
//!
//! On a rootless engine there is no such rule, and what could reach the host is the user-mode
//! network stack's host loopback: while the probe tasks run (the sidecar's bridge starts
//! rootless podman's stack), preflight reads the stack's command line and refuses one that maps
//! the host's loopback, with the setting that turns it off ([`super::loopback`],
//! [`Advice::loopback`]). The probe's answers decide, not the engine's kind, and a host whose
//! LAN address is not found is judged on what remains.

use std::borrow::Cow;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;

use crate::capacity::VmKind;
use crate::dispatcher_env::addresses::Range;

use super::checks::Report;
use super::engine::{self, Docker, Server, TaskNetwork};
use super::libpod::Libpod;
use super::loopback;
use super::net::Cidr;

/// The ports a probe task tries on its network's gateway (#367): sshd, a resolver, and the
/// ports the pool's own services listen on — the egress sidecar's proxy, the agent sidecar's
/// (and the broker's), the dispatcher's `/ready`. Nothing of the host may answer there.
pub(crate) const GATEWAY_PORTS: [u16; 5] = [22, 53, EGRESS_PORT, 8790, 8791];

/// Where a task's egress sidecar listens on its network (pkg-repo's `dispatch::spec::EGRESS_PORT`).
pub(crate) const EGRESS_PORT: u16 = 3128;

/// pasta's guest-mapped address as rootless podman runs it from 5.3 on (`--map-guest-addr`,
/// what `host.containers.internal` names): pasta forwards it to the host's own address (#372).
pub(crate) const PASTA_GUEST: Ipv4Addr = Ipv4Addr::new(169, 254, 1, 2);

/// The public mirror a probe task must reach: GitHub, which every task needs anyway.
const PUBLIC: (&str, u16) = ("github.com", 443);

/// What a probe target is, which says what reaching it means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum What {
    /// 169.254.169.254.
    Metadata,
    /// The host's default gateway: its router.
    Router,
    /// The host's LAN address.
    Lan,
    /// One of the host's own addresses (#373): an interface's, or the public one its tasks
    /// leave from, which `OMARCHY_HOST_ADDRESSES` names for every egress sidecar to refuse.
    Own,
    /// The probe network's own gateway, its `.1` (#367).
    Gateway,
    /// pasta's guest-mapped address, which reaches the host's own address (#372).
    Guest,
    /// The Mac as the `omarchy` VM reaches it ([`crate::vm::VM_HOST`], #320).
    VmHost,
}

/// How a probe task tries a target (#373): straight from its network, or through its egress
/// sidecar (`CONNECT`), as a task's every connection goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Via {
    Direct,
    Egress,
}

/// One address and port a probe task tries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub what: What,
    pub host: String,
    pub port: u16,
    pub via: Via,
}

impl Target {
    /// Tried straight from the probe task's network.
    pub fn new(what: What, host: impl std::fmt::Display, port: u16) -> Self {
        Target {
            what,
            host: host.to_string(),
            port,
            via: Via::Direct,
        }
    }

    /// The same, through the egress sidecar.
    pub fn through_egress(&self) -> Self {
        Target {
            via: Via::Egress,
            ..self.clone()
        }
    }

    /// Its name in the probe's answers: one word, one per target; `@egress` after it when
    /// it is tried through the sidecar.
    pub fn name(&self) -> String {
        let name = match self.what {
            What::Metadata => "metadata".into(),
            What::Router => "router".into(),
            What::Lan => "lan".into(),
            What::Own => format!("own-{}", self.host),
            What::Gateway => format!("gateway-{}", self.port),
            What::Guest => format!("guest-{}", self.port),
            What::VmHost => "vm-host".into(),
        };
        match self.via {
            Via::Direct => name,
            Via::Egress => format!("{name}@egress"),
        }
    }

    fn describe(&self) -> &'static str {
        match self.what {
            What::Metadata => "the cloud metadata address",
            What::Router => "the default gateway",
            What::Lan => "the host's LAN address",
            What::Own => "this host's own address",
            What::Gateway => "its network's gateway",
            What::Guest => "pasta's guest-mapped address",
            What::VmHost => "the Mac as its VM reaches it",
        }
    }
}

/// A task's egress sidecar as the dispatcher starts it (#373): the release's worker image in its
/// `egress` role, and what it refuses besides the built-in ranges — the task subnets, then the
/// host's own addresses (the dispatcher's `--deny`s).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Sidecar {
    pub image: String,
    pub deny: Vec<String>,
}

/// The network a probe task runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Network {
    /// A plain bridge: the network a package with a signed exception gets.
    Bridge,
    /// A task's own, made as the dispatcher makes it ([`engine::task_network`]), with its
    /// egress sidecar (#373).
    Task(TaskNetwork, Sidecar),
}

impl Network {
    fn describe(&self) -> &'static str {
        match self {
            Network::Bridge => "a task on a signed exception's bridge network",
            Network::Task(..) => "a task on its own network",
        }
    }
}

/// What a probe task tries, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Targets {
    pub network: Network,
    pub forbidden: Vec<Target>,
    /// The public address it must reach: directly on a bridge, through its egress sidecar on a
    /// task's own network (whose one way out the sidecar is).
    pub public: Option<(String, u16)>,
    /// Where it asks which address it comes from (`ip=` in the answer), if anywhere.
    pub seen: Option<String>,
}

/// The gateway of a network in `subnet` on every port of [`GATEWAY_PORTS`].
fn gateway(subnet: Cidr) -> impl Iterator<Item = Target> {
    let gw = subnet.first_host();
    GATEWAY_PORTS
        .into_iter()
        .map(move |p| Target::new(What::Gateway, gw, p))
}

/// Where a probe network's egress sidecar listens: its `.2`, as a task network's (pkg-repo's
/// `Slot::egress_ip`).
pub(crate) fn sidecar_ip(subnet: Cidr) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(subnet.first_host()).wrapping_add(1))
}

/// The addresses of the host's own a probe task tries (#373): the single IPv4 ones of `own`
/// (`OMARCHY_HOST_ADDRESSES`), but the LAN address, tried as such. A probe network is IPv4
/// only, and the sidecar refuses an IPv6 range whole.
pub(crate) fn own_targets(own: &[Range], lan: Option<Ipv4Addr>) -> Vec<Target> {
    own.iter()
        .filter_map(Range::address)
        .filter(|a| a.is_ipv4() && Some(*a) != lan.map(IpAddr::V4))
        .map(|a| Target::new(What::Own, a, 22))
        .collect()
}

/// What the sidecars refuse besides the built-in ranges, in the dispatcher's order: the task
/// subnets, then the host's own addresses.
pub(crate) fn deny(task: &[Cidr], own: &[Range]) -> Vec<String> {
    task.iter()
        .map(ToString::to_string)
        .chain(own.iter().map(ToString::to_string))
        .collect()
}

impl Targets {
    /// On a signed exception's bridge in `subnet`: the metadata address, the host's default
    /// gateway and LAN address when it has them, the bridge's own gateway, and GitHub (which
    /// every task needs anyway).
    pub fn of_host(router: Option<Ipv4Addr>, lan: Option<Ipv4Addr>, subnet: Cidr) -> Self {
        let mut forbidden = vec![Target::new(What::Metadata, "169.254.169.254", 80)];
        if let Some(g) = router {
            forbidden.push(Target::new(What::Router, g, 53));
        }
        if let Some(l) = lan {
            forbidden.push(Target::new(What::Lan, l, 22));
        }
        forbidden.extend(gateway(subnet));
        Targets {
            network: Network::Bridge,
            forbidden,
            public: Some((PUBLIC.0.to_owned(), PUBLIC.1)),
            seen: None,
        }
    }

    /// These targets from a task's own network, made as `create` says, with its egress
    /// `sidecar` (#373), and `own` (the host's own addresses, [`own_targets`]) too: each tried
    /// straight from it and through the sidecar; the public address through the sidecar.
    pub fn behind(self, create: TaskNetwork, sidecar: Sidecar, own: Vec<Target>) -> Self {
        let mut forbidden = self.forbidden;
        forbidden.extend(own);
        let through: Vec<Target> = forbidden.iter().map(Target::through_egress).collect();
        forbidden.extend(through);
        Targets {
            network: Network::Task(create, sidecar),
            forbidden,
            ..self
        }
    }

    /// pasta's guest-mapped address too, on every port of [`GATEWAY_PORTS`], when the engine is
    /// rootless podman behind pasta (#372).
    pub fn guest(mut self, guest: Option<Ipv4Addr>) -> Self {
        if let Some(g) = guest {
            self.forbidden.extend(
                GATEWAY_PORTS
                    .into_iter()
                    .map(|p| Target::new(What::Guest, g, p)),
            );
        }
        self
    }

    /// The pool's own origin answers the question at Cloudflare's edge; a pool that is not
    /// HTTPS (a test's, on loopback) is not asked.
    pub fn asking(mut self, pool: Option<&str>) -> Self {
        self.seen = pool
            .filter(|p| p.starts_with("https://"))
            .map(|p| format!("{}/cdn-cgi/trace", p.trim_end_matches('/')));
        self
    }

    /// The public address's name in the probe's answers.
    fn public_name(&self) -> &'static str {
        match self.network {
            Network::Bridge => "public",
            Network::Task(..) => "public@egress",
        }
    }

    pub(crate) fn args(&self) -> Vec<String> {
        let mut out = Vec::new();
        for t in &self.forbidden {
            out.extend([t.name(), t.host.clone(), t.port.to_string()]);
        }
        if let Some((host, port)) = &self.public {
            out.extend([
                self.public_name().to_owned(),
                host.clone(),
                port.to_string(),
            ]);
        }
        if let Some(url) = &self.seen {
            out.extend(["seen".to_owned(), url.clone(), "443".to_owned()]);
        }
        out
    }
}

/// The probe task's script: bash's `/dev/tcp` where there is bash (the Arch build image),
/// else `nc`. Each target prints `egress <name> <answer>`, all of them at once, so a probe takes
/// one timeout however many targets it has.
///
/// Straight from its network, `open`, `refused` or `blocked`. busybox's and OpenBSD's `nc -z`
/// print nothing for a refused connection and return at once, while a target that does not
/// answer takes the whole `-w 4`, and an address nobody holds on the network's own link (no ARP
/// answer) about 3 s: a quiet failure in under 2 s is a refusal — unless the network has no
/// route there (`ip route get` fails, as on a task's internal network), which is `blocked`.
///
/// Through the egress sidecar (a target whose name ends in `@egress`, after the `proxy <address>
/// <port>` it is told first), a `CONNECT` and the sidecar's answer: `open` (200), `denied` (403,
/// the sidecar's refusal), `refused` (502 with the target's refusal: pkg-repo's egress words it
/// `<host>:<port> does not answer: Connection refused`), `blocked` (any other 502 — one it could
/// not connect to, or a name it could not resolve, which it words `refused: <host> does not
/// resolve` like its own refusals, though nothing answered — or nothing within 6 s) or `error`;
/// and `egress proxy none` when the sidecar never answered.
/// Its status line is read alone (and a 502's words after it): a tunnel that opened stays open,
/// and a reader killed waiting on it would lose what it had not written out.
///
/// The `seen` target (a URL) prints `egress seen <address>`, or `none` with neither curl nor
/// wget, or no answer; on a task's network through its sidecar, which `https_proxy` names.
pub(crate) const SCRIPT: &str = r#"tcp() { timeout "$1" bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$2" "$3" 2>&1; }
reach() {
  if command -v bash >/dev/null 2>&1; then out=$(tcp 5 "$2" "$3"); rc=$?
  elif command -v ip >/dev/null 2>&1 && ! ip route get "$2" >/dev/null 2>&1; then out=unreachable; rc=1
  else s=$(date +%s); out=$(nc -z -w 4 "$2" "$3" 2>&1 </dev/null); rc=$?
    if [ "$rc" != 0 ] && [ -z "$out" ] && [ $(( $(date +%s) - s )) -lt 2 ]; then out=refused; fi; fi
  if [ "$rc" = 0 ]; then r=open; else case "$out" in *efused*) r=refused ;; *) r=blocked ;; esac; fi
  echo "egress $1 $r"
}
via() {
  case "$2" in *:*) a="[$2]:$3" ;; *) a="$2:$3" ;; esac
  if command -v bash >/dev/null 2>&1; then
    out=$(timeout 8 bash -c 'exec 3<>"/dev/tcp/$0/$1" || exit 1; printf "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n" "$2" "$2" >&3
      IFS= read -r -t 6 l <&3 || exit 0; printf "%s\n" "$l"; case "$l" in *" 502 "*) timeout 2 cat <&3 ;; esac' "$P" "$PP" "$a" 2>/dev/null)
  else
    out=$(printf 'CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n' "$a" "$a" | timeout 6 nc "$P" "$PP" 2>/dev/null | head -c 512)
  fi
  case "$out" in
    "HTTP/1."?" 200"*) r=open ;;
    "HTTP/1."?" 403"*) r=denied ;;
    "HTTP/1."?" 502"*"does not answer"*efused*) r=refused ;;
    "HTTP/1."?" 502"*|"") r=blocked ;;
    *) r=error ;;
  esac
  echo "egress $1 $r"
}
up() {
  if command -v bash >/dev/null 2>&1; then tcp 2 "$P" "$PP" >/dev/null; else nc -z -w 2 "$P" "$PP" </dev/null >/dev/null 2>&1; fi
}
seen() {
  if command -v curl >/dev/null 2>&1; then a=$(curl -fsS --max-time 10 "$1" 2>/dev/null)
  elif command -v wget >/dev/null 2>&1; then a=$(wget -q -T 10 -O - "$1" 2>/dev/null); else a=""; fi
  ip=$(printf '%s\n' "$a" | sed -n 's/^ip=//p' | head -n 1)
  echo "egress seen ${ip:-none}"
}
if [ "$1" = proxy ]; then
  P=$2 PP=$3; shift 3; i=0
  until up; do i=$((i + 1)); if [ "$i" -ge 20 ]; then echo "egress proxy none"; break; fi; sleep 0.5; done
fi
while [ $# -ge 3 ]; do
  case "$1" in seen) seen "$2" & ;; *@egress) via "$1" "$2" "$3" & ;; *) reach "$1" "$2" "$3" & ;; esac
  shift 3
done
wait
"#;

const LABEL: &str = "org.omarchy-pool.probe=egress";

/// Removes every probe container and network, this run's or one an earlier run left
/// behind (interrupted, or its engine did not answer): a leftover network would hold the
/// probe's /28 and refuse every later install. Uninstall calls it too.
pub(crate) fn sweep(docker: &Docker) -> Result<(), String> {
    let filter = format!("label={LABEL}");
    let ids = docker.run(&["ps", "-aq", "--no-trunc", "--filter", &filter])?;
    let ids: Vec<&str> = ids.split_whitespace().collect();
    if !ids.is_empty() {
        let mut args = vec!["rm", "-f"];
        args.extend(&ids);
        docker.run(&args)?;
    }
    for n in docker
        .run(&["network", "ls", "-q", "--filter", &filter])?
        .split_whitespace()
    {
        docker.run(&["network", "rm", n])?;
    }
    Ok(())
}

/// The engine calls that start a probe network's egress sidecar, `name`, as the dispatcher
/// starts a task's (pkg-repo's `dispatch::spec`, `Side::egress`): created on `out` (the bridge it
/// leaves through), with the dispatcher's limits, flags, role and `--deny`s, attached to the task
/// network `net` at `ip`, started. The bridge comes first: podman (netavark) gives a container
/// whose first network is internal no way out through a second one. Both are held to one
/// fixture, `crates/pkg-repo/tests/fixtures/egress-sidecar.txt`, which both crates' tests read:
/// a change on either side fails until the other follows.
pub(crate) fn sidecar(
    name: &str,
    out: &str,
    net: &str,
    ip: Ipv4Addr,
    s: &Sidecar,
) -> Vec<Vec<String>> {
    let mut create: Vec<String> = [
        "create",
        "--name",
        name,
        "--label",
        LABEL,
        "--network",
        out,
        "--cpus",
        "0.100",
        "--memory",
        "64m",
        "--memory-swap",
        "64m",
        "--pids-limit",
        "256",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--log-driver",
        "none",
        "-e",
        "OMARCHY_WORKER_ROLE=egress",
        &s.image,
        "--listen",
        &format!("{ip}:{EGRESS_PORT}"),
    ]
    .map(str::to_owned)
    .into();
    for d in &s.deny {
        create.extend(["--deny".to_owned(), d.clone()]);
    }
    let ip = ip.to_string();
    vec![
        create,
        ["network", "connect", "--ip", &ip, net, name]
            .map(str::to_owned)
            .into(),
        ["start", name].map(str::to_owned).into(),
    ]
}

/// Makes a probe task's network, as `t.network` says, in `subnet`: a plain bridge; or a task's
/// own with its egress sidecar's bridge and its sidecar (#373).
fn make(docker: &Docker, base: &str, net: &str, subnet: Cidr, t: &Targets) -> Result<(), String> {
    let mut create = vec!["network", "create"];
    let Network::Task(how, side) = &t.network else {
        let cidr = subnet.to_string();
        create.extend(["--subnet", &cidr, "--label", LABEL, net]);
        return docker
            .run(&create)
            .map(|_| ())
            .map_err(|e| format!("the egress probe's network {subnet}: {e}"));
    };
    // The probe's stand-in for the shared `omarchy-egress` bridge, made as the dispatcher makes
    // that one: the engine picks its range.
    let out = format!("{base}-out");
    docker
        .run(&["network", "create", "--label", LABEL, &out])
        .map_err(|e| format!("the egress probe's sidecar bridge: {e}"))?;
    match how {
        // podman: through libpod's own API, as the dispatcher makes a task's network (#372).
        TaskNetwork::Libpod => {
            let (k, v) = LABEL.split_once('=').unwrap_or((LABEL, ""));
            Libpod::on(&docker.socket).and_then(|l| l.create_network(net, subnet, &[(k, v)]))
        }
        TaskNetwork::Cli(options) => {
            create.extend(options.iter().copied());
            let cidr = subnet.to_string();
            create.extend(["--subnet", &cidr, "--label", LABEL, net]);
            docker.run(&create).map(|_| ())
        }
    }
    .map_err(|e| format!("the egress probe's network {subnet}: {e}"))?;
    for call in sidecar(
        &format!("{base}-egress"),
        &out,
        net,
        sidecar_ip(subnet),
        side,
    ) {
        let refs: Vec<&str> = call.iter().map(String::as_str).collect();
        docker
            .run(&refs)
            .map_err(|e| format!("the egress probe's sidecar ({}): {e}", side.image))?;
    }
    Ok(())
}

/// Runs a probe task on its own network in `subnet`, made as `t.network` says, at the
/// subnet's last address, and removes it all: a network it could not remove is reported, not
/// left behind silently. On a task's own network the task is told where its sidecar listens,
/// and `https_proxy` names it, as a task's environment does.
pub(crate) fn probe(
    docker: &Docker,
    image: &str,
    subnet: Cidr,
    t: &Targets,
) -> Result<String, String> {
    let base = format!("omarchy-egress-probe-{}", std::process::id());
    let net = match t.network {
        Network::Bridge => base.clone(),
        Network::Task(..) => format!("{base}-task"),
    };
    sweep(docker).map_err(|e| format!("an earlier egress probe's leftovers: {e}"))?;
    let out = make(docker, &base, &net, subnet, t).and_then(|()| {
        let ip = subnet.last_host().to_string();
        let mut args: Vec<String> = [
            "run",
            "--rm",
            "--network",
            &net,
            "--ip",
            &ip,
            "--label",
            LABEL,
        ]
        .map(str::to_owned)
        .into();
        let mut script = Vec::new();
        if let Network::Task(..) = t.network {
            let proxy = sidecar_ip(subnet);
            let url = format!("http://{proxy}:{EGRESS_PORT}");
            for k in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
                args.extend(["-e".to_owned(), format!("{k}={url}")]);
            }
            script.extend([
                "proxy".to_owned(),
                proxy.to_string(),
                EGRESS_PORT.to_string(),
            ]);
        }
        args.extend(["--entrypoint", "sh", image, "-c", SCRIPT, "sh"].map(str::to_owned));
        args.extend(script);
        args.extend(t.args());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        docker
            .run(&refs)
            .map_err(|e| format!("the egress probe task: {e}"))
    });
    let removed = sweep(docker).map_err(|e| {
        format!(
            "the egress probe's network {net} was not removed ({e}); the next preflight removes it"
        )
    });
    let out = out?;
    removed.map(|()| out)
}

/// What the probe said for the target called `name`.
fn answer<'a>(out: &'a str, name: &str) -> Option<&'a str> {
    out.lines()
        .find_map(|l| {
            l.strip_prefix("egress ")?
                .strip_prefix(name)?
                .strip_prefix(' ')
        })
        .map(str::trim)
}

/// What the probe's output says: the blockers, none when only the public address answered.
/// A gateway, or pasta's guest-mapped address, that answers on several ports is one blocker
/// each way it was tried.
#[allow(clippy::too_many_lines)] // every target's answer each way, then the grouped ports, then the public address
pub(crate) fn verdict(out: &str, t: &Targets, advice: &Advice) -> Vec<String> {
    let mut blockers = Vec::new();
    let task = matches!(t.network, Network::Task(..));
    if task && answer(out, "proxy") == Some("none") {
        blockers.push(format!(
            "egress: the probe's egress sidecar (the release's worker image in its egress role) never answered on its task network: {SIDECAR_DOWN}"
        ));
    }
    // A gateway's or pasta's guest-mapped address's answers, each way: one blocker however many ports.
    let mut ports: Vec<(What, Via, Vec<String>)> = Vec::new();
    for x in &t.forbidden {
        let r = answer(out, &x.name());
        let fine = match x.via {
            Via::Direct => r == Some("blocked"),
            // The sidecar's refusal, or nothing there it could reach.
            Via::Egress => matches!(r, Some("blocked" | "denied")),
        };
        if fine {
            continue;
        }
        let Some(r) = r.filter(|r| *r != "error") else {
            blockers.push(format!(
                "egress: the probe task gave no answer for {} {}:{}{}",
                x.describe(),
                x.host,
                x.port,
                if x.via == Via::Egress {
                    " through its egress sidecar"
                } else {
                    ""
                }
            ));
            continue;
        };
        if matches!(x.what, What::Gateway | What::Guest) {
            let at = format!("port {}: {r}", x.port);
            match ports
                .iter_mut()
                .find(|(w, v, _)| *w == x.what && *v == x.via)
            {
                Some((_, _, list)) => list.push(at),
                None => ports.push((x.what, x.via, vec![at])),
            }
            continue;
        }
        blockers.push(match (x.via, &t.network) {
            (Via::Egress, _) => format!(
                "egress: a task's egress sidecar lets it reach {} {} (port {}: {r}); {}",
                x.describe(),
                x.host,
                x.port,
                EGRESS_LETS
            ),
            (Via::Direct, Network::Task(..)) => format!(
                "egress: a task on its own network reaches {} {} (port {}: {r}) without its egress sidecar; {}",
                x.describe(),
                x.host,
                x.port,
                advice.internal()
            ),
            // The host's own address is reached through INPUT, which DOCKER-USER never sees;
            // a Mac's is past its VM's NAT, as the router is.
            (Via::Direct, Network::Bridge) if x.what == What::Lan && advice.rootful && advice.vm.is_none() => format!(
                "egress: a task on a signed exception's bridge network reaches {} {} (port {}: {r}); {}",
                x.describe(),
                x.host,
                x.port,
                advice.host_itself()
            ),
            (Via::Direct, Network::Bridge) => format!(
                "egress: a task on a signed exception's bridge network reaches {} {} (port {}: {r}); {}",
                x.describe(),
                x.host,
                x.port,
                advice.bridge()
            ),
        });
    }
    for (what, via, list) in ports {
        let at = match what {
            What::Guest => "pasta's guest-mapped address",
            _ => "its gateway",
        };
        let host = t
            .forbidden
            .iter()
            .find(|x| x.what == what)
            .map(|x| x.host.as_str())
            .unwrap_or_default();
        blockers.push(match (what, via) {
            (_, Via::Egress) => format!(
                "egress: a task's egress sidecar lets it reach {at} {host} ({}); {EGRESS_LETS}",
                list.join(", ")
            ),
            (What::Guest, Via::Direct) => format!(
                "egress: {} reaches {at} {host} ({}), which pasta forwards to this host's own address, where its services listen; {GUEST_SETTING}",
                t.network.describe(),
                list.join(", ")
            ),
            (_, Via::Direct) => format!(
                "egress: {} reaches {at} {host} ({}); {}",
                t.network.describe(),
                list.join(", "),
                advice.gateway(&t.network)
            ),
        });
    }
    if let Some((host, port)) = &t.public {
        let through = if task {
            " through its egress sidecar"
        } else {
            ""
        };
        match answer(out, t.public_name()) {
            Some("open") => {}
            Some(r) => blockers.push(format!(
                "egress: a task cannot reach the public address {host}:{port}{through} ({r}); tasks need public egress"
            )),
            None => blockers.push(format!(
                "egress: the probe task gave no answer for {host}:{port}{through}"
            )),
        }
    }
    blockers
}

/// What a sidecar that never answered on its network means, and where to look.
const SIDECAR_DOWN: &str = "every task's sidecar would be the same, and no task would reach anything; the engine's own log of the container, or `docker run --rm -e OMARCHY_WORKER_ROLE=egress <the worker image> --listen 127.0.0.1:3128` by hand, says why";

/// What a target a task's egress sidecar let it reach means.
const EGRESS_LETS: &str = "every task's sidecar refuses private, link-local and loopback addresses, the task subnets and this host's own addresses (OMARCHY_HOST_ADDRESSES), so a sidecar that does not refuse it is not the release's, or this target is none of those: report it";

/// The setting that keeps rootless podman's pasta from mapping its guest address to the host's
/// own (#372): podman passes `--map-guest-addr` only when `pasta_options` does not.
pub(crate) const GUEST_SETTING: &str = "rootless podman's setting: in containers.conf (~/.config/containers/containers.conf, /etc/containers/containers.conf, or a file in their containers.conf.d) add \"--map-guest-addr\", \"none\" to pasta_options under [network] (pasta_options = [\"--map-guest-addr\", \"none\"]), then stop every container of this user so its network namespace starts again without the mapping";

/// What takes a signed exception's bridge off a host that cannot keep it to public addresses
/// (#373): the envelope's grant, which the dispatcher's `OMARCHY_DIRECT_NETWORK` follows. A
/// re-run without either switch keeps a grant agent.toml records, so the advice names the one
/// that takes it back.
pub(crate) const DIRECT_OFF: &str = "install again with --no-direct-network, which records direct_network = false under [envelope] in agent.toml (a re-run without it keeps the grant agent.toml holds), and this host hands a package with that exception back to the pool";

/// What a blocker tells the person to change, for this host's engine (#367).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Advice {
    /// A root daemon behind the socket: a bridge's gateway is the host itself.
    pub rootful: bool,
    /// podman behind its docker API (pasta or slirp4netns when rootless), not Docker.
    pub podman: bool,
    /// The command that puts prep-root.sh's INPUT drop in place ([`firewall_command`]);
    /// none on a Mac, where nothing of prep-root.sh's is.
    pub firewall: String,
    /// The Mac's VM the engine runs in (#320): there a bridge's gateway is the VM itself,
    /// walled by the agent's own task firewall in the `omarchy` one ([`crate::vm::firewall`])
    /// and by nothing of the agent's in Docker Desktop's or `OrbStack`'s.
    pub vm: Option<VmKind>,
}

impl Advice {
    /// On a rootful engine, for an address that is the host itself (the VM, on a Mac).
    fn host_itself(&self) -> String {
        match self.vm {
            None => format!(
                "on a rootful engine that is this host itself, which only prep-root.sh's INPUT drop for the task subnets (OMARCHY-TASKS-HOST) keeps from a task, and it is not in effect: run {}",
                self.firewall
            ),
            Some(VmKind::Dedicated) => format!(
                "that is the {p} VM itself, which only the INPUT drop of the task firewall the agent keeps there (OMARCHY-TASKS-HOST) keeps from a task, and it is not in effect although preflight applies it before the probe: `colima ssh --profile {p} -- sudo iptables -S INPUT` shows what holds, and install again applies it",
                p = crate::vm::PROFILE
            ),
            Some(VmKind::Shared) => format!(
                "that is Docker Desktop's or OrbStack's VM itself, in which the agent puts no firewall: use the {} Colima VM instead (factory/host/prep-mac.sh), whose task firewall the agent keeps",
                crate::vm::PROFILE
            ),
        }
    }

    fn gateway(&self, on: &Network) -> String {
        if self.rootful {
            return self.host_itself();
        }
        match (on, self.podman) {
            (Network::Task(..), true) => "the engine put an address on a task's network although it was made through libpod's API with DNS off, as the dispatcher makes it, which leaves netavark's bridge without one (#372; the runbook's Rootless engines)".into(),
            (Network::Task(..), false) => "the engine put an address on a task's network although the dispatcher asks for none (Docker's isolated gateway mode)".into(),
            (Network::Bridge, _) => format!("that is the rootless engine's own namespace, which a bridge network reaches: a rootless engine cannot keep a signed exception's bridge off it, so this host cannot grant one (the runbook's Rootless engines); {DIRECT_OFF}"),
        }
    }

    /// For an address a signed exception's bridge reaches that is not the host itself: what keeps
    /// such a bridge off it, or what takes the exception off this host (#373).
    fn bridge(&self) -> String {
        match (self.rootful, self.vm) {
            (true, None) => format!("a signed exception's bridge reaches only public addresses where prep-root.sh's DOCKER-USER rules are in (run {}), or this host does not grant the exception: {DIRECT_OFF}", self.firewall),
            (_, Some(VmKind::Dedicated)) => format!("a signed exception's bridge reaches only public addresses where the task firewall the agent keeps in the {} VM holds (install again applies it), or this host does not grant the exception: {DIRECT_OFF}", crate::vm::PROFILE),
            _ => format!("nothing keeps a signed exception's bridge on this engine to public addresses (a rootless engine's bridge leaves through its user-mode network stack; Docker Desktop's and OrbStack's VMs have no firewall of the agent's), so this host cannot grant the exception: {DIRECT_OFF}"),
        }
    }

    /// For an address a task's own network reaches without its sidecar (#373).
    fn internal(&self) -> String {
        if self.podman {
            "the network is not internal although it was made through libpod's API as the dispatcher makes it (internal, DNS off), so a task would reach it too: the engine is not one the dispatcher can run tasks on (#372; the runbook's Rootless engines)".into()
        } else {
            "the network is not internal although it was made as the dispatcher makes it (--internal, Docker's isolated gateway mode), so a task would reach it too: the engine is not one the dispatcher can run tasks on".into()
        }
    }

    /// The setting that keeps a rootless engine's network stack from mapping the host's
    /// loopback into its networks ([`loopback`]).
    pub fn loopback(&self) -> String {
        if self.podman {
            "rootless podman's setting: in containers.conf (~/.config/containers/containers.conf, /etc/containers/containers.conf, or a file in their containers.conf.d) remove --map-gw and any --map-host-loopback from pasta_options under [network] (pasta), and allow_host_loopback=true from network_cmd_options under [engine] (slirp4netns), then stop every container of this user so its network namespace starts again without it".into()
        } else {
            "rootless Docker's setting: RootlessKit runs with --disable-host-loopback, dockerd-rootless.sh's default, once DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false is removed from docker.service's environment (systemctl --user edit docker.service), and any --disable-host-loopback=false from DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS; then systemctl --user restart docker.service".into()
        }
    }
}

/// prep-root.sh's firewall script, which its unit runs (#367).
const FIREWALL_SCRIPT: &str = "/usr/local/libexec/omarchy-task-firewall";
/// prep-root.sh's boot unit for that script, in `/etc/systemd/system`, after docker (#367).
pub(crate) const UNIT: &str = "omarchy-task-firewall.service";

/// prep-root.sh's firewall as preflight reads it without root, every file of it
/// world-readable (#367): its unit's script, and whether the unit that runs that script at
/// boot is there and enabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Firewall<'a> {
    /// `/usr/local/libexec/omarchy-task-firewall`, when it is there.
    pub script: Option<&'a str>,
    /// `/etc/systemd/system/omarchy-task-firewall.service` is there.
    pub unit: bool,
    /// The unit's link in `/etc/systemd/system/multi-user.target.wants`, which
    /// `systemctl enable` makes from prep-root.sh's `WantedBy=multi-user.target`: without it
    /// the unit never runs at boot, and a reboot takes the drop away while nothing after
    /// install probes again.
    pub enabled: bool,
}

impl<'a> Firewall<'a> {
    /// The unit and its link in `systemd` (`/etc/systemd/system`), with the script read.
    pub fn read(script: Option<&'a str>, systemd: &Path) -> Self {
        Firewall {
            script,
            unit: systemd.join(UNIT).is_file(),
            enabled: systemd.join("multi-user.target.wants").join(UNIT).exists(),
        }
    }
}

/// Why prep-root.sh's firewall script does not drop the task subnets, if it does not: it is
/// not there, does not jump from INPUT to `OMARCHY-TASKS-HOST`, or does not drop a task
/// subnet there.
fn unscripted(script: Option<&str>, task: &[Cidr]) -> Option<String> {
    let Some(script) = script else {
        return Some("is not there".into());
    };
    let has = |rule: &str| script.lines().any(|l| l.trim() == rule);
    if !has("iptables -C INPUT -j OMARCHY-TASKS-HOST 2>/dev/null || iptables -I INPUT -j OMARCHY-TASKS-HOST") {
        return Some("does not jump from INPUT to OMARCHY-TASKS-HOST".into());
    }
    let missing: Vec<String> = task
        .iter()
        .filter(|c| !has(&format!("iptables -A OMARCHY-TASKS-HOST -s {c} -j DROP")))
        .map(ToString::to_string)
        .collect();
    (!missing.is_empty()).then(|| format!("does not drop {}", missing.join(", ")))
}

/// Why prep-root.sh's INPUT drop for the task subnets is not installed, if it is not (#367):
/// its unit's script does not drop every task subnet ([`unscripted`]), or the unit that runs
/// it at boot is not there, or is not enabled. It says what puts the drop in place at boot,
/// not what is in effect now: a granted bridge's probe shows that (#373).
pub(crate) fn unprepared(fw: Firewall<'_>, task: &[Cidr]) -> Option<String> {
    if task.is_empty() {
        return Some(format!(
            "there is no task subnet to read {FIREWALL_SCRIPT} for"
        ));
    }
    if let Some(why) = unscripted(fw.script, task) {
        return Some(format!("{FIREWALL_SCRIPT}, its unit's script, {why}"));
    }
    if !fw.unit {
        return Some(format!(
            "/etc/systemd/system/{UNIT}, the unit that runs {FIREWALL_SCRIPT} at boot, is not there"
        ));
    }
    (!fw.enabled).then(|| format!(
        "{UNIT}, the unit that runs {FIREWALL_SCRIPT} at boot, is not enabled (/etc/systemd/system/multi-user.target.wants has no link to it), so a reboot takes the drop away"
    ))
}

/// `s` as one shell word: as it is when it needs no quoting, else in single quotes.
fn sh(s: &str) -> Cow<'_, str> {
    if !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@%+=:,./_-".contains(&b))
    {
        Cow::Borrowed(s)
    } else {
        Cow::Owned(format!("'{}'", s.replace('\'', r"'\''")))
    }
}

/// The command that puts prep-root.sh's INPUT drop for the task subnets in place (#367).
/// When its unit's script drops every task subnet ([`unscripted`]) and the unit is there,
/// the unit puts the rule back: restarted, when the rule was flushed since it ran (a firewall
/// reload, which a granted bridge's probe shows, #373), and enabled first when it is not, or the
/// next reboot takes the rule away again.
/// Otherwise prep-root.sh, which writes both and enables the unit, with this install's user,
/// work root and task subnets, and the base of docker's default address pools
/// `/etc/docker/daemon.json` (`daemon_json`, world-readable) names, since prep-root.sh sets
/// it to its own default otherwise.
pub(crate) fn firewall_command(
    fw: Firewall<'_>,
    daemon_json: Option<&str>,
    task: &[Cidr],
    user: &str,
    work_root: &Path,
    task_subnets: &str,
) -> String {
    if !task.is_empty() && unscripted(fw.script, task).is_none() && fw.unit {
        return if fw.enabled {
            format!("sudo systemctl restart {UNIT}")
        } else {
            format!("sudo systemctl enable {UNIT} && sudo systemctl restart {UNIT}")
        };
    }
    let mut cmd = format!(
        "sudo factory/host/prep-root.sh --user {} --work-root {} --task-subnets {}",
        sh(user),
        sh(&work_root.to_string_lossy()),
        sh(task_subnets)
    );
    let pools: Vec<(String, Option<u64>)> = daemon_json
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v.get("default-address-pools")?.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|p| {
            let base = p.get("base")?.as_str()?.to_owned();
            Some((base, p.get("size").and_then(serde_json::Value::as_u64)))
        })
        .collect();
    if let Some((base, _)) = pools.first() {
        cmd.push_str(" --address-pool ");
        cmd.push_str(&sh(base));
        if pools.len() > 1 || pools.iter().any(|(_, size)| *size != Some(24)) {
            cmd.push_str(" (it leaves /etc/docker/daemon.json one default address pool, that one cut in /24s: check it first)");
        }
    }
    cmd
}

/// What preflight's egress checks know of the host.
pub(crate) struct Host<'a> {
    pub router: Option<Ipv4Addr>,
    pub lan: Option<Ipv4Addr>,
    /// The pool, asked which address tasks leave from (#371).
    pub pool: Option<&'a str>,
    /// Which engine answers, for a task network's options.
    pub server: Result<Server, String>,
    /// The release's worker image, which every task's egress sidecar runs (#373).
    pub worker: &'a str,
    /// The task subnets, which every egress sidecar refuses.
    pub task: &'a [Cidr],
    /// The host's own addresses as the agent renders them for the dispatcher now
    /// (`OMARCHY_HOST_ADDRESSES`, #371): every egress sidecar refuses them, and the probe task
    /// tries the IPv4 ones ([`own_targets`]).
    pub own: Vec<Range>,
    /// The envelope grants a signed exception's bridge (`direct_network`): its probe runs too.
    pub direct: bool,
    /// pasta's guest-mapped address, tried on rootless podman behind pasta ([`PASTA_GUEST`]).
    pub guest: Option<Ipv4Addr>,
    pub advice: Advice,
    /// Why prep-root.sh's INPUT drop is not installed, when it is not ([`unprepared`]):
    /// judged on a rootful engine only, and never on a Mac.
    pub unprepared: Option<String>,
    /// Where processes are read (`/proc`), and whose: a rootless engine's network stack runs
    /// as the agent's own user ([`loopback`]).
    pub proc: &'a Path,
    pub uid: u32,
}

/// Preflight's egress (#317, #367, #372, #373): prep-root.sh's INPUT drop on a rootful engine;
/// the probe task on a network made like a task's, behind its egress sidecar, and again for a
/// public address its sidecar was not given yet; a signed exception's bridge where the envelope
/// grants one; a rootless engine's network stack while they run; their blockers and notes into
/// `r`; the public address tasks leave from, when the pool said it.
#[allow(clippy::too_many_lines, clippy::many_single_char_names)] // one probe after another, each with its verdict and notes
pub(crate) fn check(
    docker: &Docker,
    image: &str,
    subnet: Cidr,
    h: &Host<'_>,
    r: &mut Report,
) -> Option<IpAddr> {
    if let Some(why) = h.unprepared.as_deref().filter(|_| h.advice.rootful) {
        r.blockers.push(format!(
            "egress: prep-root.sh's INPUT drop for the task subnets (OMARCHY-TASKS-HOST) is not installed: {why}; on a rootful engine a network's gateway and the host's LAN address are this host itself, which DOCKER-USER (in FORWARD) never sees, and that drop is what keeps a task off every service of it, not only the ports the probe tries: run {}",
            h.advice.firewall
        ));
    }
    // A rootless engine's network stack, seen while the probe tasks run (rootless podman's
    // runs only while a container on a bridge network does: the sidecar's, a signed
    // exception's); never a Mac's, whose engine runs in its VM, where the agent sees no process.
    let watch = !h.advice.rootful && h.advice.vm.is_none();
    let mut stacks: Vec<loopback::Stack> = Vec::new();
    let mut probed = false;
    let mut run = |t: &Targets| {
        let out = if watch {
            let (out, seen) = loopback::watching(h.proc, h.uid, || probe(docker, image, subnet, t));
            for s in seen {
                if !stacks.contains(&s) {
                    stacks.push(s);
                }
            }
            out
        } else {
            probe(docker, image, subnet, t)
        };
        probed |= out.is_ok();
        out
    };
    let mut public = None;
    // What a probe tried besides the rest, when it passed.
    let guest = h
        .guest
        .map(|g| format!(", nor pasta's guest-mapped address {g}"))
        .unwrap_or_default();
    let mut around = Targets::of_host(h.router, h.lan, subnet).guest(h.guest);
    if h.advice.vm == Some(VmKind::Dedicated) {
        // The Mac as the omarchy VM reaches it, past Colima's NAT (#320).
        around
            .forbidden
            .push(Target::new(What::VmHost, crate::vm::VM_HOST, 22));
    }

    // The way a task runs (#373): its own network, its egress sidecar with the dispatcher's
    // deny list.
    match h.server.clone().and_then(engine::task_network) {
        Ok(create) => {
            let side = Sidecar {
                image: h.worker.to_owned(),
                deny: deny(h.task, &h.own),
            };
            let own = own_targets(&h.own, h.lan);
            let tried = own.len();
            let t = around
                .clone()
                .behind(create.clone(), side.clone(), own)
                .asking(h.pool);
            match run(&t) {
                Ok(out) => {
                    let b = verdict(&out, &t, &h.advice);
                    if b.is_empty() {
                        r.notes.push(format!(
                            "egress: a task on its own network reaches public addresses through its egress sidecar only, not the metadata address, the default gateway, the LAN, this host's own addresses ({tried} tried) or its network's gateway{guest}"
                        ));
                    }
                    r.blockers.extend(b);
                    public = seen(&out);
                    r.notes.push(match (public, &t.seen) {
                        (Some(ip), _) => format!("egress: tasks leave from {ip}, which every task's egress refuses with the host's own addresses"),
                        (None, Some(url)) => format!("egress: the address tasks leave from was not seen ({url} gave none); every task's egress refuses the interfaces' addresses"),
                        (None, None) => "egress: the address tasks leave from was not asked (the pool is not HTTPS)".into(),
                    });
                    // An address the sidecar was not given (a first install, or a new one): the
                    // dispatcher's sidecars refuse it from install on; one given it is probed now.
                    if let Some(ip) = public.filter(|ip| !h.own.iter().any(|o| o.contains(*ip))) {
                        let mut deny = side.deny;
                        deny.push(Range::host(ip).to_string());
                        let one = Target::new(What::Own, ip, 22);
                        let t = Targets {
                            network: Network::Task(create, Sidecar { deny, ..side }),
                            forbidden: vec![one.through_egress(), one],
                            public: None,
                            seen: None,
                        };
                        match run(&t) {
                            Ok(out) => {
                                let b = verdict(&out, &t, &h.advice);
                                if b.is_empty() {
                                    r.notes.push(format!("egress: a task does not reach {ip} with its sidecar given it, as every task's is from install on"));
                                }
                                r.blockers.extend(b);
                            }
                            Err(e) => r.blockers.push(format!("egress: {e}")),
                        }
                    }
                }
                Err(e) => r.blockers.push(format!("egress: {e}")),
            }
        }
        Err(e) => r.blockers.push(format!("egress: {e}")),
    }

    // A signed exception's bridge, where the envelope grants one (#373).
    if h.direct {
        match run(&around) {
            Ok(out) => {
                let b = verdict(&out, &around, &h.advice);
                if b.is_empty() {
                    r.notes.push(format!(
                        "egress: a task on a signed exception's bridge network reaches public addresses only, not its network's gateway{guest}"
                    ));
                }
                r.blockers.extend(b);
            }
            Err(e) => r.blockers.push(format!("egress: {e}")),
        }
    } else {
        r.notes.push("egress: no signed exception's bridge probed: the envelope does not grant one (direct_network), so this host hands a package with that exception back to the pool".into());
    }
    if watch && probed {
        match loopback::verdict(&stacks, &h.advice.loopback()) {
            Ok(note) => r.notes.push(note),
            Err(b) => r.blockers.push(b),
        }
        r.blockers
            .extend(loopback::guest_verdict(&stacks, h.guest, GUEST_SETTING));
    }
    public
}

/// The address the probe task said the pool saw it come from: one address, never a
/// loopback, unspecified or multicast one, an IPv4 one as IPv4
/// ([`crate::dispatcher_env::addresses::public`]).
pub(crate) fn seen(out: &str) -> Option<IpAddr> {
    out.lines()
        .find_map(|l| l.strip_prefix("egress seen "))
        .and_then(|a| a.trim().parse::<IpAddr>().ok())
        .and_then(crate::dispatcher_env::addresses::public)
}
