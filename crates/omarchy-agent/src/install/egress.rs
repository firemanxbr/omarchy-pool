//! The egress probe (#317, #367; design v2 §9.4, §13.3): probe tasks must fail to reach the
//! cloud metadata address, the default gateway, the host's LAN address, their own network's
//! gateway and the host's loopback, and must reach a public address. Anything they reach that
//! they must not — a connection made, or one refused, which is an answer from the target too —
//! fails the install; so does a public address they cannot reach, or a target they gave no
//! answer for.
//!
//! Two probe tasks run, one after the other, each on its own network carved from the task
//! subnets (their last /28) and at its last address, away from `.1`:
//!
//! 1. On a plain bridge, the network a task with a signed exception gets, which is what
//!    prep-root.sh's DOCKER-USER rules guard on a rootful host: the metadata address, the
//!    default gateway, the LAN address and a public one; and the bridge's own gateway on 22,
//!    53 and the pool's ports ([`GATEWAY_PORTS`]). On a rootful engine that gateway is the host
//!    itself: DOCKER-USER sits in FORWARD, which traffic to the host never crosses
//!    (CVE-2024-29018), so only prep-root.sh's INPUT drop for the task subnets
//!    (`OMARCHY-TASKS-HOST`) keeps a task off it. The agent is never root and cannot read the
//!    rules: the probe's answer is the check, and a rootful host it reaches is refused with the
//!    command that puts the drop in place ([`firewall_command`]). This task also tries the
//!    addresses a rootless engine maps to the host's loopback (slirp4netns's and `RootlessKit`'s
//!    10.0.2.2, and the default gateway, which pasta maps with `--map-gw`) on the port of a
//!    listener that only the host's loopback has ([`Canary`]): a connection that arrives there
//!    refuses the install with the setting that turns the mapping off ([`Advice::loopback`]).
//! 2. On a network made like a task's own ([`super::engine::task_network`]): its gateway on
//!    the same ports. Docker 28 or newer puts none there (its isolated gateway mode); behind
//!    podman's docker API there is one, the host's own on a rootful engine (prep-root.sh's
//!    INPUT drop closes it there) and rootless podman's namespace otherwise.
//!
//! Until the probe runs behind an egress sidecar (#373) a rootless host is expected to fail:
//! the bridge's traffic leaves through the user-mode network stack, so the LAN target answers
//! from inside it, and the bridge's gateway is the engine's own namespace, which answers too;
//! rootless podman's task networks keep their gateway behind its docker API (#372). The
//! probe's answers decide, not the engine's kind: there is no separate check for a rootless
//! engine, and a host whose LAN address is not found, with a gateway that drops TCP 53, is
//! judged on what remains.
//!
//! The first probe task also asks the pool which address it comes from (#371): the pool's
//! origin answers `/cdn-cgi/trace` at Cloudflare's edge, whose `ip=` line is the public
//! address the host's tasks leave from. Install keeps it (`egress.json`) and the agent writes
//! it with the host's own addresses for every task's egress to refuse
//! ([`crate::dispatcher_env`]): behind a router that forwards a port, a task connecting to
//! it would reach the host. The run loop asks the edge again every hour (within minutes
//! after no answer), from the host (the same NAT), for when the provider changes it. Not seen (no curl in the image, no
//! answer) is a note, never a blocker: the interfaces' addresses are refused all the same,
//! and the run loop's first answer adds it.

use std::net::{IpAddr, Ipv4Addr, TcpListener};
use std::path::Path;

use super::checks::Report;
use super::engine::{self, Docker, Server};
use super::net::Cidr;

/// The ports a probe task tries on its network's gateway (#367): sshd, a resolver, and the
/// ports the pool's own services listen on — the egress sidecar's proxy, the agent sidecar's
/// (and the broker's), the dispatcher's `/ready`. Nothing of the host may answer there.
pub(crate) const GATEWAY_PORTS: [u16; 5] = [22, 53, 3128, 8790, 8791];

/// Where slirp4netns and `RootlessKit` put the host's loopback for a rootless engine's
/// containers, unless it is off (`allow_host_loopback=false`, `--disable-host-loopback`: both
/// their defaults).
pub(crate) const SLIRP_HOST_LOOPBACK: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 2);

/// What a probe target is, which says what reaching it means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum What {
    /// 169.254.169.254.
    Metadata,
    /// The host's default gateway: its router.
    Router,
    /// The host's LAN address.
    Lan,
    /// The probe network's own gateway, its `.1` (#367).
    Gateway,
    /// An address an engine may map to the host's loopback, on the [`Canary`]'s port (#367).
    Loopback,
}

/// One address and port a probe task tries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub what: What,
    pub host: String,
    pub port: u16,
}

impl Target {
    pub fn new(what: What, host: impl std::fmt::Display, port: u16) -> Self {
        Target {
            what,
            host: host.to_string(),
            port,
        }
    }

    /// Its name in the probe's answers: one word, one per target.
    pub fn name(&self) -> String {
        match self.what {
            What::Metadata => "metadata".into(),
            What::Router => "router".into(),
            What::Lan => "lan".into(),
            What::Gateway => format!("gateway-{}", self.port),
            What::Loopback => format!("loopback-{}", self.host),
        }
    }

    fn describe(&self) -> &'static str {
        match self.what {
            What::Metadata => "the cloud metadata address",
            What::Router => "the default gateway",
            What::Lan => "the host's LAN address",
            What::Gateway => "its network's gateway",
            What::Loopback => "an address mapped to the host's loopback",
        }
    }
}

/// The network a probe task runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Network {
    /// A plain bridge: the network a package with a signed exception gets.
    Bridge,
    /// A task's own, made with these `network create` options ([`engine::task_network`]).
    Task(Vec<&'static str>),
}

impl Network {
    fn describe(&self) -> &'static str {
        match self {
            Network::Bridge => "a task on a signed exception's bridge network",
            Network::Task(_) => "a task on its own network",
        }
    }
}

/// What a probe task tries, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Targets {
    pub network: Network,
    pub forbidden: Vec<Target>,
    /// The public address it must reach: none on a task's own network, whose one way out is
    /// its egress sidecar (seam: #373 probes through it).
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
            public: Some(("github.com".to_owned(), 443)),
            seen: None,
        }
    }

    /// On a task's own network in `subnet`, made with `create`: its gateway.
    pub fn of_task(subnet: Cidr, create: Vec<&'static str>) -> Self {
        Targets {
            network: Network::Task(create),
            forbidden: gateway(subnet).collect(),
            public: None,
            seen: None,
        }
    }

    /// Also the addresses an engine may map to the host's loopback, on the [`Canary`]'s
    /// `port`: slirp4netns's and `RootlessKit`'s, and the default gateway (pasta's `--map-gw`).
    pub fn and_loopback(mut self, router: Option<Ipv4Addr>, port: u16) -> Self {
        self.forbidden
            .push(Target::new(What::Loopback, SLIRP_HOST_LOOPBACK, port));
        if let Some(g) = router.filter(|g| *g != SLIRP_HOST_LOOPBACK) {
            self.forbidden.push(Target::new(What::Loopback, g, port));
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

    pub(crate) fn args(&self) -> Vec<String> {
        let mut out = Vec::new();
        for t in &self.forbidden {
            out.extend([t.name(), t.host.clone(), t.port.to_string()]);
        }
        if let Some((host, port)) = &self.public {
            out.extend(["public".to_owned(), host.clone(), port.to_string()]);
        }
        if let Some(url) = &self.seen {
            out.extend(["seen".to_owned(), url.clone(), "443".to_owned()]);
        }
        out
    }
}

/// The probe task's script: bash's `/dev/tcp` where there is bash (the Arch build image),
/// else `nc -z`. Each target prints `egress <name> open|refused|blocked`, all of them at
/// once, so a probe takes one timeout however many targets it has. busybox's and OpenBSD's
/// `nc -z` print nothing for a refused connection and return at once, while a target that
/// does not answer takes the whole `-w 4`, and an address nobody holds on the network's own
/// link (no ARP answer) about 3 s: a quiet failure in under 2 s is a refusal. The `seen`
/// target (a URL) prints `egress seen <address>`, or `none` with neither curl nor wget, or no
/// answer.
pub(crate) const SCRIPT: &str = r#"reach() {
  if command -v bash >/dev/null 2>&1; then out=$(timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$2" "$3" 2>&1); rc=$?
  else s=$(date +%s); out=$(nc -z -w 4 "$2" "$3" 2>&1 </dev/null); rc=$?
    if [ "$rc" != 0 ] && [ -z "$out" ] && [ $(( $(date +%s) - s )) -lt 2 ]; then out=refused; fi; fi
  if [ "$rc" = 0 ]; then r=open; else case "$out" in *efused*) r=refused ;; *) r=blocked ;; esac; fi
  echo "egress $1 $r"
}
seen() {
  if command -v curl >/dev/null 2>&1; then a=$(curl -fsS --max-time 10 "$1" 2>/dev/null)
  elif command -v wget >/dev/null 2>&1; then a=$(wget -q -T 10 -O - "$1" 2>/dev/null); else a=""; fi
  ip=$(printf '%s\n' "$a" | sed -n 's/^ip=//p' | head -n 1)
  echo "egress seen ${ip:-none}"
}
while [ $# -ge 3 ]; do if [ "$1" = seen ]; then seen "$2" & else reach "$1" "$2" "$3" & fi; shift 3; done
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

/// Runs a probe task on its own network in `subnet`, made as `t.network` says, at the
/// subnet's last address, and removes both: a network it could not remove is reported, not
/// left behind silently.
pub(crate) fn probe(
    docker: &Docker,
    image: &str,
    subnet: Cidr,
    t: &Targets,
) -> Result<String, String> {
    let mut net = format!("omarchy-egress-probe-{}", std::process::id());
    let mut create = vec!["network".to_owned(), "create".to_owned()];
    if let Network::Task(options) = &t.network {
        net.push_str("-task");
        create.extend(options.iter().map(|o| (*o).to_owned()));
    }
    create.extend([
        "--subnet".to_owned(),
        subnet.to_string(),
        "--label".to_owned(),
        LABEL.to_owned(),
        net.clone(),
    ]);
    sweep(docker).map_err(|e| format!("an earlier egress probe's leftovers: {e}"))?;
    docker
        .run(&create.iter().map(String::as_str).collect::<Vec<_>>())
        .map_err(|e| format!("the egress probe's network {subnet}: {e}"))?;
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
        "--entrypoint",
        "sh",
        image,
        "-c",
        SCRIPT,
        "sh",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    args.extend(t.args());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = docker
        .run(&refs)
        .map_err(|e| format!("the egress probe task: {e}"));
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
/// The loopback targets are the [`Canary`]'s to judge: an `open` there may be the router's
/// own port. A gateway that answers on several ports is one blocker.
pub(crate) fn verdict(out: &str, t: &Targets, advice: &Advice) -> Vec<String> {
    let mut blockers = Vec::new();
    let mut gateway = Vec::new();
    for x in t.forbidden.iter().filter(|x| x.what != What::Loopback) {
        match answer(out, &x.name()) {
            Some("blocked") => {}
            None => blockers.push(format!(
                "egress: the probe task gave no answer for {} {}:{}",
                x.describe(),
                x.host,
                x.port
            )),
            Some(r) if x.what == What::Gateway => gateway.push(format!("port {}: {r}", x.port)),
            Some(r) => blockers.push(format!(
                "egress: a task reaches {} {} (port {}: {r}); only public addresses may be reachable (prep-root.sh's DOCKER-USER rules, or the egress sidecar)",
                x.describe(),
                x.host,
                x.port
            )),
        }
    }
    if let Some(g) = t
        .forbidden
        .iter()
        .find(|x| x.what == What::Gateway)
        .filter(|_| !gateway.is_empty())
    {
        blockers.push(format!(
            "egress: {} reaches its gateway {} ({}); {}",
            t.network.describe(),
            g.host,
            gateway.join(", "),
            advice.gateway(&t.network)
        ));
    }
    if let Some((host, port)) = &t.public {
        match answer(out, "public") {
            Some("open") => {}
            Some(r) => blockers.push(format!(
                "egress: a task cannot reach the public address {host}:{port} ({r}); tasks need public egress"
            )),
            None => blockers.push(format!("egress: the probe task gave no answer for {host}:{port}")),
        }
    }
    blockers
}

/// The loopback targets the probe reached, for the canary's blocker: ` through 10.0.2.2`.
fn through(out: &str, t: &Targets) -> String {
    let open: Vec<&str> = t
        .forbidden
        .iter()
        .filter(|x| x.what == What::Loopback && answer(out, &x.name()) == Some("open"))
        .map(|x| x.host.as_str())
        .collect();
    if open.is_empty() {
        String::new()
    } else {
        format!(" through {}", open.join(" and "))
    }
}

/// A listener on the host's loopback for the probe's loopback targets (#367). It listens
/// nowhere else, so a connection to it can only come through an engine that maps an address
/// to the host's loopback — slirp4netns with `allow_host_loopback=true`, `RootlessKit` without
/// `--disable-host-loopback`, pasta with `--map-gw` — and it needs no accept to answer: the
/// kernel completes the handshake and keeps the connection in its queue, reset or not.
pub(crate) struct Canary(TcpListener);

impl Canary {
    pub fn open() -> Result<Self, String> {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|l| l.set_nonblocking(true).map(|()| l))
            .map_err(|e| format!("a listener on the host's loopback for the probe: {e}"))?;
        Ok(Canary(l))
    }

    pub fn port(&self) -> u16 {
        self.0.local_addr().map_or(0, |a| a.port())
    }

    /// Whether anything connected to it.
    pub fn reached(&self) -> bool {
        self.0.accept().is_ok()
    }
}

/// What a blocker tells the person to change, for this host's engine (#367).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Advice {
    /// A root daemon behind the socket: a bridge's gateway is the host itself.
    pub rootful: bool,
    /// podman behind its docker API (pasta or slirp4netns when rootless), not Docker.
    pub podman: bool,
    /// The command that puts prep-root.sh's INPUT drop in place ([`firewall_command`]).
    pub firewall: String,
}

impl Advice {
    fn gateway(&self, on: &Network) -> String {
        if self.rootful {
            return format!(
                "on a rootful engine that is this host itself, which only prep-root.sh's INPUT drop for the task subnets (OMARCHY-TASKS-HOST) keeps from a task, and it is not in effect: run {}",
                self.firewall
            );
        }
        match (on, self.podman) {
            (Network::Task(_), true) => "that is rootless podman's own namespace: its docker-compatible API gives every network it makes a gateway with DNS on, and no setting removes it until the dispatcher makes task networks through libpod's API (#372; the runbook's Rootless engines)".into(),
            (Network::Task(_), false) => "the engine put an address on a task's network although the dispatcher asks for none (Docker's isolated gateway mode)".into(),
            (Network::Bridge, _) => "that is the rootless engine's own namespace, which a bridge network reaches: every rootless host fails here until the probe runs the way a task runs, behind its egress sidecar (#373; the runbook's Rootless engines)".into(),
        }
    }

    /// The setting that keeps the engine from mapping the host's loopback into its networks.
    pub fn loopback(&self) -> String {
        if self.rootful {
            "a rootful engine maps nothing there: look for what does (a DNAT to 127.0.0.1 with route_localnet on)".into()
        } else if self.podman {
            "rootless podman maps it: in containers.conf (~/.config/containers/containers.conf, or /etc/containers/containers.conf) remove --map-gw and any --map-host-loopback from pasta_options under [network] (pasta), and allow_host_loopback=true from network_cmd_options under [engine] (slirp4netns), then stop every container of this user so its network starts again without it".into()
        } else {
            "rootless Docker's RootlessKit maps it: run it with --disable-host-loopback, dockerd-rootless.sh's default, by removing DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false from docker.service's environment (systemctl --user edit docker.service), then systemctl --user restart docker.service".into()
        }
    }
}

/// The command that puts prep-root.sh's INPUT drop for the task subnets in place (#367). Its
/// unit's script is world-readable: when it already drops every task subnet the rule was
/// flushed since it ran (a firewall reload), and restarting the unit puts it back; otherwise
/// prep-root.sh, with this install's user, work root and task subnets.
pub(crate) fn firewall_command(
    script: Option<&str>,
    task: &[Cidr],
    user: &str,
    work_root: &Path,
    task_subnets: &str,
) -> String {
    let drops = |c: &Cidr| {
        let rule = format!("iptables -A OMARCHY-TASKS-HOST -s {c} -j DROP");
        script.is_some_and(|s| s.lines().any(|l| l.trim() == rule))
    };
    if !task.is_empty() && task.iter().all(drops) {
        "sudo systemctl restart omarchy-task-firewall.service".into()
    } else {
        format!(
            "sudo factory/host/prep-root.sh --user {user} --work-root {} --task-subnets {task_subnets}",
            work_root.display()
        )
    }
}

/// What preflight's egress checks know of the host.
pub(crate) struct Host<'a> {
    pub router: Option<Ipv4Addr>,
    pub lan: Option<Ipv4Addr>,
    /// The pool, asked which address tasks leave from (#371).
    pub pool: Option<&'a str>,
    /// Which engine answers, for a task network's options.
    pub server: Result<Server, String>,
    pub advice: Advice,
}

/// Preflight's egress (#317, #367): both probe tasks, their blockers and notes into `r`; the
/// public address tasks leave from, when the pool said it.
pub(crate) fn check(
    docker: &Docker,
    image: &str,
    subnet: Cidr,
    h: &Host<'_>,
    r: &mut Report,
) -> Option<IpAddr> {
    let mut public = None;
    let canary = Canary::open();
    let mut t = Targets::of_host(h.router, h.lan, subnet).asking(h.pool);
    match &canary {
        Ok(c) => t = t.and_loopback(h.router, c.port()),
        Err(e) => r.blockers.push(format!("egress: {e}")),
    }
    match probe(docker, image, subnet, &t) {
        Ok(out) => {
            let mut b = verdict(&out, &t, &h.advice);
            if canary.as_ref().is_ok_and(Canary::reached) {
                b.push(format!(
                    "egress: a task reaches this host's loopback{}; {}",
                    through(&out, &t),
                    h.advice.loopback()
                ));
            }
            if b.is_empty() {
                r.notes.push(
                    "egress: a task reaches public addresses only, not its network's gateway or the host's loopback".into(),
                );
            }
            r.blockers.extend(b);
            public = seen(&out);
            r.notes.push(match (public, &t.seen) {
                (Some(ip), _) => format!("egress: tasks leave from {ip}, which every task's egress refuses with the host's own addresses"),
                (None, Some(url)) => format!("egress: the address tasks leave from was not seen ({url} gave none); every task's egress refuses the interfaces' addresses"),
                (None, None) => "egress: the address tasks leave from was not asked (the pool is not HTTPS)".into(),
            });
        }
        Err(e) => r.blockers.push(format!("egress: {e}")),
    }
    match h.server.clone().and_then(engine::task_network) {
        Ok(create) => {
            let t = Targets::of_task(subnet, create);
            match probe(docker, image, subnet, &t) {
                Ok(out) => {
                    let b = verdict(&out, &t, &h.advice);
                    if b.is_empty() {
                        r.notes.push(
                            "egress: a task's own network has no gateway the task reaches".into(),
                        );
                    }
                    r.blockers.extend(b);
                }
                Err(e) => r.blockers.push(format!("egress: {e}")),
            }
        }
        Err(e) => r.blockers.push(format!("egress: {e}")),
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
