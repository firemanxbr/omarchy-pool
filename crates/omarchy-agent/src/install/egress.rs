//! The egress probe (#317, #367; design v2 §9.4, §13.3): probe tasks must fail to reach the
//! cloud metadata address, the default gateway, the host's LAN address and their own
//! network's gateway, and must reach a public address. Anything they reach that they must
//! not — a connection made, or one refused, which is an answer from the target too — fails
//! the install; so does a public address they cannot reach, or a target they gave no answer
//! for.
//!
//! Two probe tasks run, one after the other, each on its own network carved from the task
//! subnets (their last /28) and at its last address, away from `.1`:
//!
//! 1. On a plain bridge, the network a task with a signed exception gets, which is what
//!    prep-root.sh's DOCKER-USER rules guard on a rootful host: the metadata address, the
//!    default gateway, the LAN address and a public one; and the bridge's own gateway on 22,
//!    53 and the pool's ports ([`GATEWAY_PORTS`]). On a rootful engine that gateway, like the
//!    LAN address, is the host itself: DOCKER-USER sits in FORWARD, which traffic to the host
//!    never crosses (CVE-2024-29018), so only prep-root.sh's INPUT drop for the task subnets
//!    (`OMARCHY-TASKS-HOST`) keeps a task off it.
//! 2. On a network made like a task's own ([`super::engine::task_network`]): its gateway on
//!    the same ports. Docker 28 or newer puts none there (its isolated gateway mode); behind
//!    podman's docker API there is one, the host's own on a rootful engine (prep-root.sh's
//!    INPUT drop closes it there) and rootless podman's namespace otherwise.
//!
//! On a Mac (#320) the probe runs in the `omarchy` VM, whose task firewall the agent puts
//! there itself (`crate::vm::firewall`, before the probe), and the first probe task has one
//! more target: the Mac as the VM reaches it (Lima's `host.lima.internal`). Colima's NAT
//! would carry a task's connection to the Mac's router and LAN otherwise. A bridge's gateway
//! there is the VM itself, which that firewall's INPUT drop closes as prep-root.sh's does on
//! a Linux host ([`Advice::vm`]); preflight reads neither prep-root.sh's files nor a network
//! stack's command line on a Mac. The agent puts nothing in Docker Desktop's or `OrbStack`'s
//! VM: such a host is judged on the probe's answers like any other.
//!
//! On a rootful engine on Linux preflight also reads prep-root.sh's firewall script and its
//! boot unit, which are world-readable: a script that does not drop every task subnet, or
//! none, or a unit that is not there or not enabled (a reboot would take the drop away),
//! refuses the install with the command that installs it ([`unprepared`],
//! [`firewall_command`]), whatever the probe says, since a host's own firewall may close the
//! ports probed and leave the others open. The agent is never root and cannot read the rules
//! in effect: the probe is what shows they hold (a rule flushed since the unit ran is refused
//! with the command that puts it back).
//!
//! On a rootless engine there is no such rule, and what could reach the host is the user-mode
//! network stack's host loopback: while both probe tasks run, preflight reads the stack's
//! command line and refuses one that maps the host's loopback, with the setting that turns
//! it off ([`super::loopback`], [`Advice::loopback`]). Until the probe runs behind an egress
//! sidecar (#373) a rootless host is expected to fail all the same: the bridge's traffic
//! leaves through the user-mode network stack, so the LAN target answers from inside it, and
//! the bridge's gateway is the engine's own namespace, which answers too; rootless podman's
//! task networks keep their gateway behind its docker API (#372). The probe's answers decide,
//! not the engine's kind, and a host whose LAN address is not found, with a gateway that
//! drops TCP 53, is judged on what remains.
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

use std::borrow::Cow;
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;

use crate::capacity::VmKind;

use super::checks::Report;
use super::engine::{self, Docker, Server};
use super::loopback;
use super::net::Cidr;

/// The ports a probe task tries on its network's gateway (#367): sshd, a resolver, and the
/// ports the pool's own services listen on — the egress sidecar's proxy, the agent sidecar's
/// (and the broker's), the dispatcher's `/ready`. Nothing of the host may answer there.
pub(crate) const GATEWAY_PORTS: [u16; 5] = [22, 53, 3128, 8790, 8791];

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
    /// The Mac as the `omarchy` VM reaches it ([`crate::vm::VM_HOST`], #320).
    VmHost,
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
            What::VmHost => "vm-host".into(),
        }
    }

    fn describe(&self) -> &'static str {
        match self.what {
            What::Metadata => "the cloud metadata address",
            What::Router => "the default gateway",
            What::Lan => "the host's LAN address",
            What::Gateway => "its network's gateway",
            What::VmHost => "the Mac as its VM reaches it",
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
/// A gateway that answers on several ports is one blocker.
pub(crate) fn verdict(out: &str, t: &Targets, advice: &Advice) -> Vec<String> {
    let mut blockers = Vec::new();
    let mut gateway = Vec::new();
    for x in &t.forbidden {
        match answer(out, &x.name()) {
            Some("blocked") => {}
            None => blockers.push(format!(
                "egress: the probe task gave no answer for {} {}:{}",
                x.describe(),
                x.host,
                x.port
            )),
            Some(r) if x.what == What::Gateway => gateway.push(format!("port {}: {r}", x.port)),
            // The host's own address is reached through INPUT, which DOCKER-USER never sees;
            // a Mac's is past its VM's NAT, as the router is.
            Some(r) if x.what == What::Lan && advice.rootful && advice.vm.is_none() => blockers.push(format!(
                "egress: a task reaches {} {} (port {}: {r}); {}",
                x.describe(),
                x.host,
                x.port,
                advice.host_itself()
            )),
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
            (Network::Task(_), true) => "that is rootless podman's own namespace: its docker-compatible API gives every network it makes a gateway with DNS on, and no setting removes it until the dispatcher makes task networks through libpod's API (#372; the runbook's Rootless engines)".into(),
            (Network::Task(_), false) => "the engine put an address on a task's network although the dispatcher asks for none (Docker's isolated gateway mode)".into(),
            (Network::Bridge, _) => "that is the rootless engine's own namespace, which a bridge network reaches: every rootless host fails here until the probe runs the way a task runs, behind its egress sidecar (#373; the runbook's Rootless engines)".into(),
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
/// not what is in effect now: the probe shows that.
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
/// reload), and enabled first when it is not, or the next reboot takes the rule away again.
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
    pub advice: Advice,
    /// Why prep-root.sh's INPUT drop is not installed, when it is not ([`unprepared`]):
    /// judged on a rootful engine only, and never on a Mac.
    pub unprepared: Option<String>,
    /// Where processes are read (`/proc`), and whose: a rootless engine's network stack runs
    /// as the agent's own user ([`loopback`]).
    pub proc: &'a Path,
    pub uid: u32,
}

/// Preflight's egress (#317, #367): prep-root.sh's INPUT drop on a rootful engine, both probe
/// tasks, and a rootless engine's network stack while they run; their blockers and notes
/// into `r`; the public address tasks leave from, when the pool said it.
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
    // runs only while a container on a bridge network does); never a Mac's, whose engine
    // runs in its VM, where the agent sees no process.
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
    let mut t = Targets::of_host(h.router, h.lan, subnet).asking(h.pool);
    if h.advice.vm == Some(VmKind::Dedicated) {
        // The Mac as the omarchy VM reaches it, past Colima's NAT (#320).
        t.forbidden
            .push(Target::new(What::VmHost, crate::vm::VM_HOST, 22));
    }
    match run(&t) {
        Ok(out) => {
            let b = verdict(&out, &t, &h.advice);
            if b.is_empty() {
                r.notes.push(
                    "egress: a task reaches public addresses only, not its network's gateway"
                        .into(),
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
            match run(&t) {
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
    if watch && probed {
        match loopback::verdict(&stacks, &h.advice.loopback()) {
            Ok(note) => r.notes.push(note),
            Err(b) => r.blockers.push(b),
        }
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
