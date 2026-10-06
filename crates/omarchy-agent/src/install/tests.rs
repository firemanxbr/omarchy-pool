//! Install, preflight and uninstall (#317): each check on its own, then preflight and the
//! steps after it on a host played by a stub docker CLI, a fake pool on loopback and a
//! fake terminal and systemd. `engine_tests` below runs the egress probe and the legacy
//! set against a real engine (`tests/agent-install.sh`).

#![allow(clippy::many_single_char_names, clippy::struct_excessive_bools)]

use std::cell::RefCell;
use std::fmt::Write as _;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use super::*;
use crate::run::fake::{TestVerifier, HOST_SET, T0};
use crate::run::state::tempdir;
use crate::verify::tests_support;

/// The person's machine, played: answers given up front, every call recorded. A Mac's
/// (#320): launchctl, sysctl, route and a Colima that saves `colima.yaml` under
/// `colima_home` as it starts the profile.
pub(crate) struct Fake {
    pub calls: Vec<String>,
    pub confirm: bool,
    pub keys: String,
    pub scopes: Result<Option<String>, String>,
    pub linger: bool,
    pub enable_linger: bool,
    pub systemd: bool,
    /// The person's GUI login: launchctl's `gui/<uid>` answers.
    pub gui: bool,
    pub loaded: bool,
    pub bootstrap_fails: bool,
    pub colima: bool,
    pub vm_running: bool,
    pub colima_home: Option<PathBuf>,
    /// `sysctl -n hw.ncpu hw.memsize`.
    pub mac: String,
    /// Made when the task firewall runs in the VM: the docker stub's egress probe answers
    /// as a walled VM then, and as Colima's NAT without it otherwise.
    pub walled: Option<PathBuf>,
    pub firewall_fails: bool,
    /// Where the only docker client on this played Mac is (the release's pinned CLI):
    /// Colima starts a profile only with it on its PATH. `None`: not checked.
    pub docker_at: Option<PathBuf>,
    /// The environment of each `colima` call, in order.
    pub colima_env: Vec<Vec<(&'static str, String)>>,
}

impl Default for Fake {
    fn default() -> Self {
        Fake {
            calls: Vec::new(),
            confirm: true,
            keys: String::new(),
            scopes: Ok(Some(String::new())),
            linger: false,
            enable_linger: true,
            systemd: true,
            gui: true,
            loaded: false,
            bootstrap_fails: false,
            colima: true,
            vm_running: false,
            colima_home: None,
            mac: "16\n68719476736\n".into(),
            walled: None,
            firewall_fails: false,
            docker_at: None,
            colima_env: Vec::new(),
        }
    }
}

/// `colima.yaml` as Colima saves it after `colima start <args>`.
fn colima_saves(args: &[&str]) -> String {
    let value = |flag: &str| {
        args.iter()
            .position(|a| *a == flag)
            .and_then(|i| args.get(i + 1))
            .copied()
            .unwrap_or("")
    };
    let rosetta = args.contains(&"--vz-rosetta=true");
    let mut y = format!(
        "cpu: {}\nmemory: {}\ndisk: {}\narch: {}\nvmType: {}\nrosetta: {rosetta}\nforwardAgent: false\nmounts:\n",
        value("--cpu"),
        value("--memory"),
        value("--disk"),
        value("--arch"),
        value("--vm-type")
    );
    for (i, a) in args.iter().enumerate() {
        if *a == "--mount" {
            let m = args[i + 1];
            let (path, w) = m.strip_suffix(":w").map_or((m, false), |p| (p, true));
            let _ = writeln!(y, "  - location: {path}\n    writable: {w}");
        }
    }
    y
}

impl Sys for Fake {
    fn run_env(
        &mut self,
        prog: &str,
        args: &[&str],
        env: &[(&'static str, String)],
    ) -> Result<String, String> {
        let firewall = args.iter().any(|a| a.contains("OMARCHY-TASKS"));
        let line = if firewall {
            format!("{prog} ssh --profile omarchy -- sudo -n sh -c <firewall>")
        } else {
            format!("{prog} {}", args.join(" "))
        };
        self.calls.push(line.clone());
        if prog == "colima" {
            self.colima_env.push(env.to_vec());
        }
        let no = || Err(format!("{line}: no"));
        // Colima looks for a docker client on its PATH before it starts a profile.
        let docker_on_path = self.docker_at.as_ref().is_none_or(|at| {
            env.iter()
                .find(|(k, _)| *k == "PATH")
                .is_some_and(|(_, v)| v.split(':').any(|d| Path::new(d) == at))
        });
        match (prog, args.first().copied()) {
            ("loginctl", Some("show-user")) => {
                Ok(if self.linger { "yes\n" } else { "no\n" }.into())
            }
            ("loginctl", Some("enable-linger")) if self.enable_linger => Ok(String::new()),
            ("systemctl", _) if self.systemd => Ok(String::new()),
            ("launchctl", Some("print")) => {
                let agent = args.get(1).is_some_and(|d| d.ends_with(launchd::LABEL));
                if self.gui && (!agent || self.loaded) {
                    Ok("state = running\n".into())
                } else {
                    Err("Could not find domain for port identifier".into())
                }
            }
            ("launchctl", Some("bootstrap")) if self.gui && !self.bootstrap_fails => {
                self.loaded = true;
                Ok(String::new())
            }
            ("launchctl", Some("bootstrap")) => {
                Err("Bootstrap failed: 125: Domain does not support specified action".into())
            }
            ("launchctl", Some("bootout")) if self.loaded => {
                self.loaded = false;
                Ok(String::new())
            }
            ("sysctl", _) => Ok(self.mac.clone()),
            ("route", _) => {
                Ok("   route to: default\ndestination: default\n    gateway: 192.168.1.1\n".into())
            }
            ("colima", _) if !self.colima => Err(format!("{prog}: not found")),
            ("colima", Some("version")) => Ok("colima version 0.8.1\n".into()),
            ("colima", Some("status")) => {
                if self.vm_running {
                    Ok(String::new())
                } else {
                    no()
                }
            }
            ("colima", Some("stop")) => {
                self.vm_running = false;
                Ok(String::new())
            }
            ("colima", Some("start")) if !docker_on_path => Err(
                "dependency check failed for docker: docker not found, run 'brew install docker' to install".into(),
            ),
            ("colima", Some("start")) => {
                if let Some(w) = &self.walled {
                    let _ = fs::remove_file(w);
                }
                if let Some(home) = &self.colima_home {
                    fs::create_dir_all(home.join(crate::vm::PROFILE)).unwrap();
                    fs::write(crate::vm::config_path(home), colima_saves(args)).unwrap();
                }
                self.vm_running = true;
                Ok(String::new())
            }
            ("colima", Some("ssh")) if firewall => {
                if self.firewall_fails {
                    return Err("sudo: a password is required".into());
                }
                if let Some(w) = &self.walled {
                    fs::write(w, "").unwrap();
                }
                Ok(String::new())
            }
            ("colima", Some("ssh")) => {
                Ok("MemTotal: 32000000 kB\nMemAvailable: 30000000 kB\n".into())
            }
            _ => Err(format!("{line}: not allowed here")),
        }
    }
    fn confirm(&mut self, text: &str) -> Result<bool, String> {
        self.calls
            .push(format!("confirm {}", text.lines().last().unwrap_or("")));
        Ok(self.confirm)
    }
    fn ask_keys(&mut self, _: &str) -> Result<String, String> {
        self.calls.push("ask_keys".into());
        Ok(self.keys.clone())
    }
    fn github_scopes(&mut self, _: &str) -> Result<Option<String>, String> {
        self.calls.push("github_scopes".into());
        self.scopes.clone()
    }
    fn download(&mut self, url: &str) -> Result<Vec<u8>, String> {
        Err(format!("{url}: no network in this test"))
    }
}

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

// --- each check -------------------------------------------------------------------

#[test]
fn a_daily_login_and_a_rootful_daemon_without_remapping_are_refused_with_the_reason() {
    let blocked = |i, rootful, dedicated, legacy| {
        let mut r = Report::default();
        checks::hosting(i, rootful, dedicated, legacy, &mut r);
        (r.blockers.join("\n"), r.warnings.join("\n"))
    };
    let (b, _) = blocked(Isolation::User, false, false, false);
    assert!(b.contains("daily login"), "{b}");
    let (b, _) = blocked(Isolation::Root, true, false, false);
    assert!(b.contains("never on a maintainer's daily login"), "{b}");
    // A fresh rootful VM sees both of its blockers on the one screen.
    assert!(b.contains("needs userns-remap"), "{b}");
    // Remapped, but still a root daemon behind the socket: a dedicated machine only.
    let (b, _) = blocked(Isolation::Subuid, true, false, false);
    assert!(b.contains("root-equivalent"), "{b}");
    let (b, _) = blocked(Isolation::Root, true, true, false);
    assert!(b.contains("needs userns-remap"), "{b}");
    // The Studio: rootful without remapping beside its legacy set, a recorded exception.
    let (b, w) = blocked(Isolation::Root, true, true, true);
    assert!(
        b.is_empty() && w.contains("exception until P6"),
        "{b} / {w}"
    );
    for (i, rootful, dedicated) in [
        (Isolation::User, false, true),
        (Isolation::Subuid, true, true),
        (Isolation::Subuid, false, false),
    ] {
        assert_eq!(
            blocked(i, rootful, dedicated, false).0,
            "",
            "{i:?} {rootful} {dedicated}"
        );
    }
}

use crate::capacity::Isolation;

#[test]
fn credentials_in_reach_are_a_warning_on_a_dedicated_host_and_a_blocker_for_a_shared_one() {
    let home = tempdir();
    assert!(checks::credentials(&home).is_empty());
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(
        home.join(".ssh/id_ed25519"),
        "-----BEGIN OPENSSH PRIVATE KEY-----\n",
    )
    .unwrap();
    fs::write(home.join(".ssh/id_ed25519.pub"), "ssh-ed25519 AAAA").unwrap();
    fs::write(home.join(".ssh/known_hosts"), "github.com ssh-ed25519 AAAA").unwrap();
    fs::create_dir_all(home.join(".config/gh")).unwrap();
    fs::write(home.join(".config/gh/hosts.yml"), "github.com:\n").unwrap();
    fs::write(home.join(".gitconfig"), "[credential]\n\thelper = store\n").unwrap();
    fs::create_dir_all(home.join(".mozilla/firefox")).unwrap();
    let found = checks::credentials(&home);
    assert_eq!(found.len(), 4, "{found:?}");
    assert!(found[0].contains("id_ed25519") && !found[0].contains(".pub"));
    let mut r = Report::default();
    checks::credentials_verdict(&found, true, &mut r);
    assert_eq!((r.blockers.len(), r.warnings.len()), (0, 4));
    let mut r = Report::default();
    checks::credentials_verdict(&found, false, &mut r);
    assert_eq!((r.blockers.len(), r.warnings.len()), (4, 0));
}

#[test]
fn the_task_subnets_must_not_collide_with_routes_or_other_projects_networks() {
    let routes = net::parse_routes(
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n\
         eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\n\
         eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\n\
         br-1a2b\t0000E70A\t00000000\t0001\t0\t0\t0\t0000FFFF\n\
         wg0\t0000E80A\t00000000\t0001\t0\t0\t0\t0000FFFF\n",
    );
    assert_eq!(
        net::default_gateway(&routes),
        Some("192.168.1.1".parse().unwrap())
    );
    assert_eq!(routes[1].dest.to_string(), "192.168.1.0/24");
    let task = net::parse_list("10.231.0.0/16").unwrap();
    let mut r = Report::default();
    checks::subnets(&task, &routes, &[], &mut r);
    // The bridge's 10.231/16 is a container network, checked by name with ours left out.
    assert!(r.ok(), "{:?}", r.blockers);
    let task = net::parse_list("10.232.0.0/16,10.240.0.0/16").unwrap();
    let nets = vec![(
        "other_default".to_owned(),
        vec![Cidr::parse("10.240.3.0/24").unwrap()],
    )];
    checks::subnets(&task, &routes, &nets, &mut r);
    assert_eq!(r.blockers.len(), 2, "{:?}", r.blockers);
    assert!(r.blockers[0].contains("route to 10.232.0.0/16 on wg0"));
    assert!(r.blockers[1].contains("other_default"));
    assert_eq!(
        Cidr::parse("10.231.0.0/16")
            .unwrap()
            .last_28()
            .unwrap()
            .to_string(),
        "10.231.255.240/28"
    );
    assert!(net::parse_list("10.0.0.0/33").is_err());
}

#[test]
fn linger_and_the_user_manager_are_reported() {
    let d = tempdir();
    let mut r = Report::default();
    checks::user_manager("omarchy", &d, None, &mut r);
    assert!(r.blockers[0].contains("XDG_RUNTIME_DIR"));
    assert!(r.notes[0].contains("sudo loginctl enable-linger omarchy"));
    let mut r = Report::default();
    fs::write(d.join("omarchy"), "").unwrap();
    checks::user_manager("omarchy", &d, Some(&d), &mut r);
    assert!(r.blockers[0].contains("D-Bus"), "{:?}", r.blockers);
    fs::write(d.join("bus"), "").unwrap();
    let mut r = Report::default();
    checks::user_manager("omarchy", &d, Some(&d), &mut r);
    assert!(r.ok() && r.notes[0].contains("linger: on"), "{r:?}");
}

#[test]
fn a_github_token_with_any_scope_or_none_github_names_is_refused() {
    assert!(checks::github_token(Ok(Some(String::new()))).is_ok());
    assert!(checks::github_token(Ok(Some(" ".into()))).is_ok());
    for s in [
        "repo",
        "public_repo",
        "workflow, read:org",
        "write:packages",
    ] {
        let e = checks::github_token(Ok(Some(s.into()))).unwrap_err();
        assert!(e.contains("carries the scopes"), "{e}");
    }
    assert!(checks::github_token(Ok(None))
        .unwrap_err()
        .contains("fine-grained"));
    assert!(checks::github_token(Err("GitHub refused the token (401)".into())).is_err());
}

/// The probe's /28 for the default task subnets, and what its answers say when nothing of
/// `t`'s is reached.
const PROBE_NET: &str = "10.231.255.240/28";

fn all_blocked(t: &egress::Targets) -> String {
    t.forbidden.iter().fold(String::new(), |mut s, x| {
        let _ = writeln!(s, "egress {} blocked", x.name());
        s
    })
}

fn advice(rootful: bool, podman: bool) -> egress::Advice {
    egress::Advice {
        rootful,
        podman,
        firewall: "sudo factory/host/prep-root.sh --user omarchy --work-root /srv/w --task-subnets 10.231.0.0/16".into(),
        vm: None,
    }
}

#[test]
fn the_egress_probe_passes_only_when_public_addresses_alone_are_reachable() {
    let net = Cidr::parse(PROBE_NET).unwrap();
    let t = egress::Targets::of_host(
        Some("192.168.1.1".parse().unwrap()),
        Some("192.168.1.20".parse().unwrap()),
        net,
    );
    let a = advice(true, false);
    let ok = format!("{}egress public open\n", all_blocked(&t));
    assert!(egress::verdict(&ok, &t, &a).is_empty());
    for (out, why) in [
        (
            ok.replace("metadata blocked", "metadata open"),
            "169.254.169.254",
        ),
        (
            ok.replace("router blocked", "router refused"),
            "default gateway",
        ),
        (ok.replace("lan blocked", "lan open"), "LAN address"),
        (
            ok.replace("public open", "public blocked"),
            "cannot reach the public",
        ),
        (ok.replace("egress lan blocked\n", ""), "no answer"),
    ] {
        let b = egress::verdict(&out, &t, &a);
        assert_eq!(b.len(), 1, "{out}: {b:?}");
        assert!(b[0].contains(why), "{b:?}");
    }
    // Without a router or LAN address, the metadata address, the bridge's own gateway and
    // the public address remain.
    let t = egress::Targets::of_host(None, None, net);
    assert_eq!(t.forbidden.len(), 1 + egress::GATEWAY_PORTS.len());
    let ok = format!("{}egress public open\n", all_blocked(&t));
    assert!(egress::verdict(&ok, &t, &a).is_empty());
}

#[test]
fn a_task_that_reaches_its_networks_gateway_on_any_port_fails_the_probe_with_what_to_change() {
    let net = Cidr::parse(PROBE_NET).unwrap();
    let bridge = egress::Targets::of_host(None, None, net);
    // The /28's .1, on 22, 53 and the pool's ports; the probe task sits at its last address.
    let gw: Vec<String> = bridge
        .forbidden
        .iter()
        .filter(|x| x.what == egress::What::Gateway)
        .map(|x| format!("{}:{}", x.host, x.port))
        .collect();
    assert_eq!(
        gw,
        [
            "10.231.255.241:22",
            "10.231.255.241:53",
            "10.231.255.241:3128",
            "10.231.255.241:8790",
            "10.231.255.241:8791"
        ]
    );
    assert_eq!(net.last_host().to_string(), "10.231.255.254");
    // Refused counts, as an answer from the gateway; every port that answered, one blocker.
    let ok = format!("{}egress public open\n", all_blocked(&bridge));
    let out = ok
        .replace("gateway-22 blocked", "gateway-22 refused")
        .replace("gateway-8791 blocked", "gateway-8791 open");
    let b = egress::verdict(&out, &bridge, &advice(true, false));
    assert_eq!(b.len(), 1, "{b:?}");
    assert!(
        b[0].contains("a task on a signed exception's bridge network reaches its gateway 10.231.255.241 (port 22: refused, port 8791: open)"),
        "{b:?}"
    );
    // Rootful: the host itself, and the command that closes it.
    assert!(
        b[0].contains("OMARCHY-TASKS-HOST")
            && b[0].contains("run sudo factory/host/prep-root.sh --user omarchy"),
        "{b:?}"
    );
    // Rootless: the engine's own namespace, which no prep-root.sh closes.
    let b = egress::verdict(&out, &bridge, &advice(false, false));
    assert!(
        b[0].contains("rootless engine's own namespace") && !b[0].contains("prep-root"),
        "{b:?}"
    );

    // A task's own network: its gateway only, and no public address to reach (its egress
    // sidecar is its way out).
    let task = egress::Targets::of_task(net, engine::TaskNetwork::Libpod);
    assert!(task.public.is_none() && task.seen.is_none());
    assert!(task
        .forbidden
        .iter()
        .all(|x| x.what == egress::What::Gateway && x.host == "10.231.255.241"));
    let ok = all_blocked(&task);
    assert!(egress::verdict(&ok, &task, &advice(false, true)).is_empty());
    let out = ok.replace("gateway-53 blocked", "gateway-53 open");
    let b = egress::verdict(&out, &task, &advice(false, true));
    assert!(
        b.len() == 1
            && b[0].contains(
                "a task on its own network reaches its gateway 10.231.255.241 (port 53: open)"
            )
            && b[0].contains("made through libpod's API with DNS off"),
        "{b:?}"
    );
    // Rootful podman: the host's own address, closed by prep-root.sh.
    let b = egress::verdict(&out, &task, &advice(true, true));
    assert!(b[0].contains("prep-root.sh --user omarchy"), "{b:?}");
    // No answer at all is no pass.
    let b = egress::verdict("", &task, &advice(true, false));
    assert_eq!(b.len(), egress::GATEWAY_PORTS.len(), "{b:?}");
    assert!(b.iter().all(|x| x.contains("no answer")), "{b:?}");
}

#[test]
fn pasta_s_guest_mapped_address_is_tried_on_a_bridge_and_refused_when_it_answers() {
    let net = Cidr::parse(PROBE_NET).unwrap();
    let guest = Some(egress::PASTA_GUEST);
    // Tried only where asked: rootless podman behind pasta.
    assert_eq!(
        egress::Targets::of_host(None, None, net).guest(None),
        egress::Targets::of_host(None, None, net)
    );
    let t = egress::Targets::of_host(None, None, net).guest(guest);
    let g: Vec<String> = t
        .forbidden
        .iter()
        .filter(|x| x.what == egress::What::Guest)
        .map(|x| format!("{} {}:{}", x.name(), x.host, x.port))
        .collect();
    assert_eq!(
        g,
        [
            "guest-22 169.254.1.2:22",
            "guest-53 169.254.1.2:53",
            "guest-3128 169.254.1.2:3128",
            "guest-8790 169.254.1.2:8790",
            "guest-8791 169.254.1.2:8791"
        ]
    );
    let ok = format!("{}egress public open\n", all_blocked(&t));
    assert!(egress::verdict(&ok, &t, &advice(false, true)).is_empty());
    // Every port that answered, one blocker, with containers.conf's setting.
    let out = ok
        .replace("guest-53 blocked", "guest-53 refused")
        .replace("guest-22 blocked", "guest-22 open");
    let b = egress::verdict(&out, &t, &advice(false, true));
    assert_eq!(b.len(), 1, "{b:?}");
    assert!(
        b[0].contains("reaches pasta's guest-mapped address 169.254.1.2 (port 22: open, port 53: refused), which pasta forwards to this host's own address")
            && b[0].contains(r#""--map-guest-addr", "none""#)
            && b[0].contains("pasta_options under [network]"),
        "{b:?}"
    );
    // No answer is no pass.
    let b = egress::verdict(
        &ok.replace("egress guest-3128 blocked\n", ""),
        &t,
        &advice(false, true),
    );
    assert!(
        b.len() == 1
            && b[0].contains("no answer for pasta's guest-mapped address 169.254.1.2:3128"),
        "{b:?}"
    );

    // pasta's command line: the address it maps, if any; one the probe did not try is refused.
    let parse = |argv: &[&str]| {
        loopback::Stack::parse(9, format!("{}\0", argv.join("\0")).as_bytes()).unwrap()
    };
    let default = parse(PASTA);
    assert_eq!(default.guest_addr(), Some("169.254.1.2"));
    let setting = egress::GUEST_SETTING;
    assert_eq!(
        loopback::guest_verdict(std::slice::from_ref(&default), guest, setting),
        None
    );
    let b = loopback::guest_verdict(std::slice::from_ref(&default), None, setting).unwrap();
    assert!(
        b.contains("(pasta (pid 9) at 169.254.1.2), which the probe did not try")
            && b.contains(setting),
        "{b}"
    );
    let mut owners = PASTA.to_vec();
    owners.extend(["--map-guest-addr=10.0.2.9"]);
    let owners = parse(&owners);
    assert_eq!(owners.guest_addr(), Some("10.0.2.9"));
    assert!(loopback::guest_verdict(&[owners], guest, setting).is_some());
    let mut none = PASTA.to_vec();
    let at = none.len() - 1;
    none[at] = "none";
    assert_eq!(parse(&none).guest_addr(), None);
    let older: Vec<&str> = PASTA[..PASTA.len() - 2].to_vec();
    assert_eq!(parse(&older).guest_addr(), None);
    // Only pasta has one.
    let slirp = parse(&[SLIRP4NETNS, &["--map-guest-addr", "10.0.2.9"]].concat());
    assert_eq!(slirp.guest_addr(), None);
}

#[test]
fn on_a_mac_a_bridges_gateway_is_the_vm_and_the_macs_lan_address_is_past_its_nat() {
    // A Mac's engine is rootful in its VM (#320): a bridge's gateway is the VM itself,
    // which the omarchy VM's own task firewall closes, and nothing of prep-root.sh's is
    // there; the Mac's LAN address is reached through the VM's NAT, as its router is.
    let net = Cidr::parse(PROBE_NET).unwrap();
    let t = egress::Targets::of_host(None, Some("192.168.1.20".parse().unwrap()), net);
    let ok = format!("{}egress public open\n", all_blocked(&t));
    let out = ok
        .replace("gateway-22 blocked", "gateway-22 open")
        .replace("lan blocked", "lan refused");
    let mac = |vm| egress::Advice {
        firewall: String::new(),
        vm: Some(vm),
        ..advice(true, false)
    };
    let b = egress::verdict(&out, &t, &mac(VmKind::Dedicated));
    assert_eq!(b.len(), 2, "{b:?}");
    assert!(
        b[0].contains("a task reaches the host's LAN address 192.168.1.20 (port 22: refused); only public addresses may be reachable"),
        "{b:?}"
    );
    assert!(
        b[1].contains(
            "reaches its gateway 10.231.255.241 (port 22: open); that is the omarchy VM itself"
        ) && b[1].contains("colima ssh --profile omarchy"),
        "{b:?}"
    );
    assert!(
        b.iter().all(|x| !x.contains("prep-root.sh --user")),
        "{b:?}"
    );
    let b = egress::verdict(&out, &t, &mac(VmKind::Shared));
    assert!(
        b[1].contains("that is Docker Desktop's or OrbStack's VM itself")
            && b[1].contains("factory/host/prep-mac.sh"),
        "{b:?}"
    );
}

/// prep-root.sh's firewall script for the default task subnets, as it writes it (step 9).
const FIREWALL: &str = "#!/bin/sh\nset -e\niptables -N OMARCHY-TASKS-HOST 2>/dev/null || true\niptables -F OMARCHY-TASKS-HOST\niptables -A OMARCHY-TASKS-HOST -s 10.231.0.0/16 -j DROP\niptables -C INPUT -j OMARCHY-TASKS-HOST 2>/dev/null || iptables -I INPUT -j OMARCHY-TASKS-HOST\n";

/// prep-root.sh's firewall as it leaves it (step 9): `script`, and its unit there and enabled.
fn installed(script: &str) -> egress::Firewall<'_> {
    egress::Firewall {
        script: Some(script),
        unit: true,
        enabled: true,
    }
}

/// prep-root.sh's firewall on a test host as step 9 leaves it: its script, its unit, and the
/// unit's link in `multi-user.target.wants` (`systemctl enable`'s).
fn prepare(root: &Path) {
    fs::write(root.join("omarchy-task-firewall"), FIREWALL).unwrap();
    let wants = root.join("systemd/multi-user.target.wants");
    fs::create_dir_all(&wants).unwrap();
    fs::write(
        root.join("systemd/omarchy-task-firewall.service"),
        "[Install]\nWantedBy=multi-user.target\n",
    )
    .unwrap();
    std::os::unix::fs::symlink(
        "../omarchy-task-firewall.service",
        wants.join("omarchy-task-firewall.service"),
    )
    .unwrap();
}

/// No firewall of prep-root.sh's at all.
const NONE: egress::Firewall<'static> = egress::Firewall {
    script: None,
    unit: false,
    enabled: false,
};

#[test]
fn a_rootful_host_is_told_the_command_that_puts_prep_roots_input_drop_in_place() {
    let task = net::parse_list(TASK_SUBNETS).unwrap();
    let w = Path::new("/srv/omarchy-pool/host");
    let prep = "sudo factory/host/prep-root.sh --user omarchy --work-root /srv/omarchy-pool/host --task-subnets 10.231.0.0/16";
    assert_eq!(
        egress::firewall_command(NONE, None, &task, "omarchy", w, TASK_SUBNETS),
        prep
    );
    assert_eq!(
        egress::unprepared(NONE, &task).as_deref(),
        Some("/usr/local/libexec/omarchy-task-firewall, its unit's script, is not there")
    );
    // prep-root.sh's script, which drops these subnets, and its unit, enabled: installed. A
    // rule flushed since it ran is put back by its unit.
    assert_eq!(egress::unprepared(installed(FIREWALL), &task), None);
    assert_eq!(
        egress::firewall_command(installed(FIREWALL), None, &task, "omarchy", w, TASK_SUBNETS),
        "sudo systemctl restart omarchy-task-firewall.service"
    );
    // One that drops other subnets, or not all of these, or never jumps from INPUT: not
    // installed, and prep-root.sh again, with these, whatever the unit.
    let two = net::parse_list("10.231.0.0/16,10.232.0.0/16").unwrap();
    assert_eq!(
        egress::unprepared(installed(FIREWALL), &two).as_deref(),
        Some("/usr/local/libexec/omarchy-task-firewall, its unit's script, does not drop 10.232.0.0/16")
    );
    assert!(egress::firewall_command(
        installed(FIREWALL),
        None,
        &two,
        "omarchy",
        w,
        "10.231.0.0/16,10.232.0.0/16"
    )
    .ends_with("--task-subnets 10.231.0.0/16,10.232.0.0/16"));
    let no_jump = FIREWALL.replace("iptables -C INPUT", "# iptables -C INPUT");
    assert_eq!(
        egress::unprepared(installed(&no_jump), &task).as_deref(),
        Some("/usr/local/libexec/omarchy-task-firewall, its unit's script, does not jump from INPUT to OMARCHY-TASKS-HOST")
    );
    assert_eq!(
        egress::firewall_command(
            installed("#!/bin/sh\n"),
            None,
            &task,
            "omarchy",
            w,
            TASK_SUBNETS
        ),
        prep
    );
    // The address pool daemon.json names is carried, or prep-root.sh would set its own default;
    // one prep-root.sh would not keep as it is is said.
    let pool = r#"{"default-address-pools":[{"base":"10.200.0.0/16","size":24}],"userns-remap":"default"}"#;
    assert_eq!(
        egress::firewall_command(NONE, Some(pool), &task, "omarchy", w, TASK_SUBNETS),
        format!("{prep} --address-pool 10.200.0.0/16")
    );
    let pools = r#"{"default-address-pools":[{"base":"10.200.0.0/16","size":26},{"base":"10.201.0.0/16","size":24}]}"#;
    let c = egress::firewall_command(NONE, Some(pools), &task, "omarchy", w, TASK_SUBNETS);
    assert!(
        c.starts_with(&format!("{prep} --address-pool 10.200.0.0/16 ("))
            && c.contains("check it first"),
        "{c}"
    );
    for none in ["{}", "not json", r#"{"default-address-pools":[]}"#] {
        assert_eq!(
            egress::firewall_command(NONE, Some(none), &task, "omarchy", w, TASK_SUBNETS),
            prep
        );
    }
    // Every word is one shell word.
    assert_eq!(
        egress::firewall_command(
            NONE,
            None,
            &task,
            "o'mar chy",
            Path::new("/srv/my host"),
            TASK_SUBNETS
        ),
        r"sudo factory/host/prep-root.sh --user 'o'\''mar chy' --work-root '/srv/my host' --task-subnets 10.231.0.0/16"
    );
    // The lines are the ones prep-root.sh writes, for each task subnet.
    let prep_root = include_str!("../../../../factory/host/prep-root.sh");
    assert!(prep_root.contains(r#"rules+=("iptables -A OMARCHY-TASKS-HOST -s $s -j DROP")"#));
    assert!(prep_root.contains(
        r#""iptables -C INPUT -j OMARCHY-TASKS-HOST 2>/dev/null || iptables -I INPUT -j OMARCHY-TASKS-HOST")"#
    ));
    assert!(prep_root.contains("put /usr/local/libexec/omarchy-task-firewall 0755"));
    assert!(prep_root.contains("put /etc/systemd/system/omarchy-task-firewall.service 0644"));
    assert!(prep_root.contains("'WantedBy=multi-user.target'"));
    assert!(prep_root.contains(r#"address_pool="172.16.0.0/12""#));
}

#[test]
fn a_firewall_unit_that_does_not_run_at_boot_is_not_prepared() {
    let task = net::parse_list(TASK_SUBNETS).unwrap();
    let w = Path::new("/srv/omarchy-pool/host");
    let prep = "sudo factory/host/prep-root.sh --user omarchy --work-root /srv/omarchy-pool/host --task-subnets 10.231.0.0/16";
    // The unit disabled (or never enabled): the rule may be in effect now, but nothing puts it
    // back at boot, and nothing probes again after install. Enabled, then restarted.
    let disabled = egress::Firewall {
        enabled: false,
        ..installed(FIREWALL)
    };
    assert_eq!(
        egress::unprepared(disabled, &task).as_deref(),
        Some("omarchy-task-firewall.service, the unit that runs /usr/local/libexec/omarchy-task-firewall at boot, is not enabled (/etc/systemd/system/multi-user.target.wants has no link to it), so a reboot takes the drop away")
    );
    assert_eq!(
        egress::firewall_command(disabled, None, &task, "omarchy", w, TASK_SUBNETS),
        "sudo systemctl enable omarchy-task-firewall.service && sudo systemctl restart omarchy-task-firewall.service"
    );
    // The unit removed, the script left: systemctl has nothing to restart, and prep-root.sh
    // writes the unit again and enables it. A link left behind changes nothing.
    for enabled in [false, true] {
        let gone = egress::Firewall {
            unit: false,
            enabled,
            ..installed(FIREWALL)
        };
        assert_eq!(
            egress::unprepared(gone, &task).as_deref(),
            Some("/etc/systemd/system/omarchy-task-firewall.service, the unit that runs /usr/local/libexec/omarchy-task-firewall at boot, is not there")
        );
        assert_eq!(
            egress::firewall_command(gone, None, &task, "omarchy", w, TASK_SUBNETS),
            prep
        );
    }
}

/// A process in a stand-in `/proc`: its command line, NUL-separated.
fn process(proc: &Path, pid: u32, argv: &[&str]) {
    let dir = proc.join(pid.to_string());
    fs::create_dir_all(&dir).unwrap();
    let mut cmdline = argv.join("\0");
    cmdline.push('\0');
    fs::write(dir.join("cmdline"), cmdline).unwrap();
}

/// What dockerd-rootless.sh runs by default, and what rootless podman 4 runs for its bridge
/// networks.
const ROOTLESSKIT: &[&str] = &[
    "rootlesskit",
    "--state-dir=/run/user/1000/dockerd-rootless",
    "--net=slirp4netns",
    "--mtu=65520",
    "--slirp4netns-sandbox=auto",
    "--slirp4netns-seccomp=auto",
    "--disable-host-loopback",
    "--port-driver=builtin",
    "--copy-up=/etc",
    "--copy-up=/run",
    "--propagation=rslave",
    "/usr/bin/dockerd-rootless.sh",
];
const SLIRP4NETNS: &[&str] = &[
    "/usr/bin/slirp4netns",
    "--disable-host-loopback",
    "--mtu=65520",
    "--enable-sandbox",
    "--enable-seccomp",
    "-c",
    "-r",
    "3",
    "--netns-type=path",
    "/run/user/1000/netns/rootless-netns-0",
    "tap0",
];
const PASTA: &[&str] = &[
    "/usr/bin/pasta",
    "--config-net",
    "--pid",
    "/run/user/1000/containers/networks/rootless-netns/rootless-netns-conn.pid",
    "--dns-forward",
    "169.254.1.1",
    "-t",
    "none",
    "-u",
    "none",
    "--no-map-gw",
    "--quiet",
    "--netns",
    "/run/user/1000/containers/networks/rootless-netns/rootless-netns",
    "--map-guest-addr",
    "169.254.1.2",
];

#[test]
fn a_rootless_engines_stack_says_whether_it_maps_the_hosts_loopback() {
    use loopback::{Kind, Stack};
    let parse = |argv: &[&str]| Stack::parse(7, format!("{}\0", argv.join("\0")).as_bytes());
    let without = |argv: &[&str], flag: &str| -> Vec<String> {
        argv.iter()
            .filter(|a| **a != flag)
            .map(|a| (*a).to_owned())
            .collect()
    };
    let with = |argv: Vec<String>| parse(&argv.iter().map(String::as_str).collect::<Vec<_>>());
    // Each engine's defaults keep it out.
    for (argv, kind) in [
        (ROOTLESSKIT, Kind::RootlessKit),
        (SLIRP4NETNS, Kind::Slirp4netns),
        (PASTA, Kind::Pasta),
    ] {
        let s = parse(argv).unwrap();
        assert_eq!((s.kind, s.pid, s.args.len()), (kind, 7, argv.len() - 1));
        assert_eq!(s.host_loopback(), None, "{argv:?}");
    }
    // pasta's AVX2 build, by its name too.
    let mut avx2 = PASTA.to_vec();
    avx2[0] = "/usr/bin/pasta.avx2";
    assert_eq!(parse(&avx2).unwrap().kind, Kind::Pasta);
    for other in [
        &["/usr/bin/dockerd"][..],
        &["passt"],
        &["sh", "-c", "rootlesskit"],
        &[],
    ] {
        assert_eq!(parse(other), None, "{other:?}");
    }
    // RootlessKit without --disable-host-loopback, or with it false: where its driver puts it.
    let on = without(ROOTLESSKIT, "--disable-host-loopback");
    assert_eq!(
        with(on.clone()).unwrap().host_loopback().as_deref(),
        Some("10.0.2.2")
    );
    let mut vpnkit = on.clone();
    vpnkit[2] = "--net=vpnkit".into();
    assert_eq!(
        with(vpnkit).unwrap().host_loopback().as_deref(),
        Some("192.168.65.2")
    );
    let mut gvisor = on.clone();
    gvisor.splice(2..3, ["--net".to_owned(), "gvisor-tap-vsock".to_owned()]);
    assert_eq!(
        with(gvisor).unwrap().host_loopback().as_deref(),
        Some("10.0.2.1")
    );
    let mut off_then_on: Vec<String> = ROOTLESSKIT.iter().map(|a| (*a).to_owned()).collect();
    off_then_on.insert(7, "--disable-host-loopback=false".into());
    assert!(with(off_then_on).unwrap().host_loopback().is_some());
    // slirp4netns without it (allow_host_loopback=true): 10.0.2.2.
    let s = with(without(SLIRP4NETNS, "--disable-host-loopback")).unwrap();
    assert_eq!(s.host_loopback().as_deref(), Some("10.0.2.2"));
    // pasta without --no-map-gw (podman's --map-gw) maps its gateway; --map-host-loopback
    // maps the address it names, whatever comes with it; `none` maps nothing.
    let s = with(without(PASTA, "--no-map-gw")).unwrap();
    assert_eq!(
        s.host_loopback().as_deref(),
        Some("its namespace's gateway")
    );
    let mut named: Vec<String> = PASTA.iter().map(|a| (*a).to_owned()).collect();
    named.splice(
        1..1,
        ["--map-host-loopback".to_owned(), "10.0.2.3".to_owned()],
    );
    assert_eq!(
        with(named).unwrap().host_loopback().as_deref(),
        Some("10.0.2.3")
    );
    let mut none = without(PASTA, "--no-map-gw");
    none.push("--map-host-loopback=none".into());
    assert_eq!(with(none).unwrap().host_loopback(), None);
}

#[test]
fn a_rootless_engines_stack_is_read_while_the_probe_runs_and_refused_with_its_setting() {
    let without = |argv: &[&str], flag: &str| -> Vec<String> {
        argv.iter()
            .filter(|a| **a != flag)
            .map(|a| (*a).to_owned())
            .collect()
    };
    // This user's processes only, and only the stacks among them.
    let proc = tempdir();
    process(&proc, 40, ROOTLESSKIT);
    process(
        &proc,
        41,
        &[
            "/usr/bin/dockerd",
            "--config-file=/home/u/.config/docker/daemon.json",
        ],
    );
    process(&proc, 42, SLIRP4NETNS);
    fs::create_dir_all(proc.join("self")).unwrap();
    let me = rustix::process::getuid().as_raw();
    let seen = loopback::scan(&proc, me);
    assert_eq!(seen.iter().map(|s| s.pid).collect::<Vec<_>>(), [40, 42]);
    assert!(loopback::scan(&proc, me + 1).is_empty());
    assert!(loopback::scan(&proc.join("nowhere"), me).is_empty());

    // A stack that runs only while the probe does (rootless podman's) is seen all the same.
    let (out, seen) = loopback::watching(&proc, me, || {
        process(
            &proc,
            43,
            &without(PASTA, "--no-map-gw")
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
        );
        std::thread::sleep(Duration::from_millis(350));
        fs::remove_dir_all(proc.join("43")).unwrap();
        "probed"
    });
    assert_eq!(out, "probed");
    assert_eq!(seen.iter().map(|s| s.pid).collect::<Vec<_>>(), [40, 42, 43]);
    assert!(!loopback::scan(&proc, me).iter().any(|s| s.pid == 43));
    // A probe that panics (a real-engine test's unwrap) fails: the watcher stops with it.
    let panicked = std::panic::catch_unwind(|| {
        loopback::watching(&proc, me, || panic!("the probe task failed"))
    });
    assert!(panicked.is_err());

    // The verdict, with the engine's setting.
    let docker = advice(false, false).loopback();
    let podman = advice(false, true).loopback();
    let note = loopback::verdict(&seen[..2], &docker).unwrap();
    assert!(
        note.contains(
            "maps nothing to the host's loopback (RootlessKit (pid 40), slirp4netns (pid 42))"
        ),
        "{note}"
    );
    let b = loopback::verdict(&seen, &podman).unwrap_err();
    assert!(
        b.contains("maps this host's loopback into the networks tasks run on (pasta (pid 43) at its namespace's gateway)")
            && b.contains(&podman),
        "{b}"
    );
    let b = loopback::verdict(&[], &docker).unwrap_err();
    assert!(
        b.contains("no network stack of this user's rootless engine"),
        "{b}"
    );
    // The setting to change, by engine.
    assert!(
        docker.contains("DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false")
            && docker.contains("systemctl --user restart docker.service"),
        "{docker}"
    );
    assert!(
        podman.contains("--map-gw")
            && podman.contains("--map-host-loopback")
            && podman.contains("pasta_options")
            && podman.contains("allow_host_loopback=true")
            && podman.contains("network_cmd_options"),
        "{podman}"
    );
}

#[test]
fn a_tasks_network_is_made_as_the_dispatcher_makes_it_on_this_engine() {
    use engine::Server;
    let docker = r#"{"Version":"29.6.2","ApiVersion":"1.51","Components":[{"Name":"Engine","Version":"29.6.2"}]}"#;
    assert_eq!(engine::parse_server(docker), Ok(Server::Docker(29)));
    let podman = r#"{"Platform":{"Name":"linux/amd64/ubuntu-24.04"},"Version":"4.9.3","ApiVersion":"1.41","Components":[{"Name":"Podman Engine","Version":"4.9.3"}]}"#;
    assert_eq!(engine::parse_server(podman), Ok(Server::Podman));
    for bad in ["", "null", r#"{"Version":"x"}"#] {
        assert!(engine::parse_server(bad).is_err(), "{bad}");
    }
    assert_eq!(
        engine::task_network(Server::Docker(28)).unwrap(),
        engine::TaskNetwork::Cli(vec![
            "--internal",
            "-o",
            "com.docker.network.bridge.gateway_mode_ipv4=isolated"
        ])
    );
    // podman's docker API drops docker's option and turns DNS on: through libpod's own (#372).
    assert_eq!(
        engine::task_network(Server::Podman).unwrap(),
        engine::TaskNetwork::Libpod
    );
    let e = engine::task_network(Server::Docker(27)).unwrap_err();
    assert!(
        e.contains("Docker 28") && e.contains("dispatcher refuses"),
        "{e}"
    );
    // The dispatcher's own spec asks for the same option, and reads podman the same way; on
    // podman it asks libpod for the same network (internal, DNS off), as the probe does.
    let spec = include_str!("../../../pkg-repo/src/dispatch/spec.rs");
    assert!(spec.contains("\"com.docker.network.bridge.gateway_mode_ipv4=isolated\""));
    let dispatch = include_str!("../../../pkg-repo/src/dispatch/engine.rs");
    assert!(dispatch.contains("c.name.contains(\"Podman\")") && dispatch.contains("m >= 28"));
    let theirs = include_str!("../../../pkg-repo/src/dispatch/libpod.rs");
    assert!(
        theirs.contains("\"/v{}/libpod/networks/create\"")
            && theirs.contains("\"driver\": \"bridge\"")
            && theirs.contains("\"internal\": internal")
            && theirs.contains("\"dns_enabled\": dns")
    );
    let body: serde_json::Value = serde_json::from_str(&libpod::network_body(
        "n",
        Cidr::parse("10.231.255.240/28").unwrap(),
        &[("org.omarchy-pool.probe", "egress")],
    ))
    .unwrap();
    assert_eq!(
        body,
        serde_json::json!({"name": "n", "driver": "bridge", "internal": true, "dns_enabled": false,
            "subnets": [{"subnet": "10.231.255.240/28"}], "labels": {"org.omarchy-pool.probe": "egress"}})
    );
}

#[test]
fn a_socket_that_refuses_this_user_needs_a_person_and_the_first_that_answers_wins() {
    let d = tempdir();
    let (a, b, c) = (d.join("a.sock"), d.join("b.sock"), d.join("c.sock"));
    let answers = |p: &Path| {
        if p == b {
            engine::Socket::Answers
        } else if p == a {
            engine::Socket::Denied
        } else {
            engine::Socket::Absent
        }
    };
    let list = vec![a.clone(), b.clone(), c.clone()];
    assert_eq!(engine::discover(None, &list, answers).unwrap(), b);
    let e = engine::discover(None, &[a.clone(), c.clone()], answers).unwrap_err();
    assert!(
        e.contains("needs a person") && e.contains("log out and back in, or reboot"),
        "{e}"
    );
    assert!(engine::discover(Some(&c), &list, answers)
        .unwrap_err()
        .contains("no container engine"));
    // A real socket this user may not open: EACCES.
    let s = d.join("denied.sock");
    let _l = std::os::unix::net::UnixListener::bind(&s).unwrap();
    assert_eq!(engine::connect(&s), engine::Socket::Answers);
    fs::set_permissions(&s, fs::Permissions::from_mode(0o000)).unwrap();
    if files::euid() != 0 {
        assert_eq!(engine::connect(&s), engine::Socket::Denied);
    }
    assert_eq!(
        engine::connect(&d.join("none.sock")),
        engine::Socket::Absent
    );
    assert_eq!(
        engine::candidates(Some(Path::new("/run/user/1000")))[0],
        Path::new("/run/user/1000/podman/podman.sock")
    );
}

#[test]
fn a_symlink_planted_in_the_set_directory_is_refused_and_nothing_is_written_through_it() {
    let d = tempdir();
    fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
    let set = d.join("set");
    files::make_dir(&set).unwrap();
    assert_eq!(mode(&set), 0o700);
    let elsewhere = d.join("elsewhere");
    fs::write(&elsewhere, "keep").unwrap();
    std::os::unix::fs::symlink(&elsewhere, set.join("agent.toml")).unwrap();
    let e = files::write(&set, "agent.toml", b"pool = 1", 0o600).unwrap_err();
    assert!(e.contains("symbolic link"), "{e}");
    assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "keep");
    // A linked directory is refused too.
    std::os::unix::fs::symlink(&set, d.join("linked")).unwrap();
    assert!(files::write(&d.join("linked"), "x", b"x", 0o600)
        .unwrap_err()
        .contains("symbolic link"));
    assert!(files::check_owner_file(&set.join("agent.toml"))
        .unwrap_err()
        .contains("symbolic link"));
    // A plain write: the mode asked for, replaced in place.
    files::write(&set, "dispatcher.env", b"A=1\n", 0o600).unwrap();
    files::write(&set, "dispatcher.env", b"A=2\n", 0o600).unwrap();
    assert_eq!(
        fs::read_to_string(set.join("dispatcher.env")).unwrap(),
        "A=2\n"
    );
    assert_eq!(mode(&set.join("dispatcher.env")), 0o600);
    // Others may write the file, or the directory: refused.
    fs::set_permissions(
        set.join("dispatcher.env"),
        fs::Permissions::from_mode(0o620),
    )
    .unwrap();
    assert!(files::write(&set, "dispatcher.env", b"A=3\n", 0o600)
        .unwrap_err()
        .contains("writable"));
    assert!(files::check_owner_file(&set.join("dispatcher.env"))
        .unwrap_err()
        .contains("writable"));
    fs::set_permissions(&set, fs::Permissions::from_mode(0o770)).unwrap();
    assert!(files::write(&set, "other", b"x", 0o600)
        .unwrap_err()
        .contains("writable"));
    assert!(files::write(&d, "../x", b"x", 0o600).is_err());
}

#[test]
fn the_unit_is_the_agents_and_starts_it_from_this_data_directory() {
    let u = unit::render(Path::new("/home/omarchy/.local/share/omarchy-agent")).unwrap();
    for line in [
        "Type=notify",
        "Restart=always",
        "TimeoutStartSec=120",
        "WatchdogSec=300",
        "RestartPreventExitStatus=78",
        "UMask=0077",
        "NoNewPrivileges=yes",
        "WantedBy=default.target",
        "ExecStart=/home/omarchy/.local/share/omarchy-agent/current/omarchy-agent run --data-dir /home/omarchy/.local/share/omarchy-agent",
    ] {
        assert!(u.lines().any(|l| l == line), "{line}\n{u}");
    }
    assert_eq!(u.lines().filter(|l| l.starts_with("ExecStart=")).count(), 1);
    assert!(unit::render(Path::new("/home/a b")).is_err());
    assert!(unit::render(Path::new("/home/%h")).is_err());
}

#[test]
fn linger_is_enabled_without_sudo_where_polkit_allows_or_a_person_gets_the_line() {
    let mut s = Fake {
        linger: true,
        ..Fake::default()
    };
    unit::linger(&mut s, "omarchy").unwrap();
    assert_eq!(
        s.calls,
        ["loginctl show-user omarchy --property=Linger --value"]
    );
    let mut s = Fake::default();
    unit::linger(&mut s, "omarchy").unwrap();
    assert_eq!(s.calls[1], "loginctl enable-linger omarchy");
    let mut s = Fake {
        enable_linger: false,
        ..Fake::default()
    };
    let e = unit::linger(&mut s, "omarchy").unwrap_err();
    assert!(
        e.contains("needs a person") && e.contains("`sudo loginctl enable-linger omarchy`"),
        "{e}"
    );
    let mut s = Fake {
        systemd: false,
        ..Fake::default()
    };
    assert!(unit::start(&mut s).unwrap_err().contains("needs a person"));
}

#[test]
fn agent_keys_are_parsed_strictly_and_kept_outside_the_work_root() {
    let k = secrets::parse("# keys\nANTHROPIC_API_KEY=sk-1\nexport GITHUB_TOKEN=\"ghp_x\"\n\n")
        .unwrap();
    assert_eq!(
        k,
        [
            ("ANTHROPIC_API_KEY".into(), "sk-1".into()),
            ("GITHUB_TOKEN".into(), "ghp_x".into())
        ]
    );
    assert!(secrets::parse("lower=1").is_err());
    assert!(secrets::parse("A=1\nA=2").is_err());
    assert!(secrets::parse("no equals").is_err());
    assert_eq!(
        secrets::render(&k)
            .lines()
            .filter(|l| !l.starts_with('#'))
            .count(),
        2
    );
    let (w, s) = (
        Path::new("/srv/pool/host"),
        Path::new("/home/o/.local/share/omarchy-agent/sets/host"),
    );
    assert!(secrets::outside(Path::new("/srv/pool/host-secrets"), w, s).is_ok());
    assert!(secrets::outside(Path::new("/srv/pool/host/secrets"), w, s).is_err());
    assert!(secrets::outside(Path::new("/srv/pool"), w, s).is_err());
    assert!(secrets::outside(
        Path::new("/home/o/.local/share/omarchy-agent/sets/host/etc"),
        w,
        s
    )
    .is_err());
}

#[test]
fn the_pool_must_be_one_the_release_signs() {
    let signed = vec!["https://pkgs.omarchy-pool.org".to_owned()];
    assert_eq!(choose_pool(None, None, &signed).unwrap(), signed[0]);
    assert_eq!(
        choose_pool(Some("https://pkgs.omarchy-pool.org/"), None, &signed).unwrap(),
        signed[0]
    );
    assert!(choose_pool(Some("https://evil.example"), None, &signed)
        .unwrap_err()
        .contains("not one this release signs"));
    assert!(choose_pool(None, Some("https://old.example"), &signed).is_err());
}

#[test]
fn the_legacy_project_is_checked_and_never_removed() {
    let seen = legacy::Seen {
        containers: vec!["c1".into()],
        networks: vec!["n1".into()],
        paths: vec![PathBuf::from("/srv/omarchy-pool/work")],
        subnets: vec![Cidr::parse("10.231.0.0/24").unwrap()],
        dirs: vec![PathBuf::from("/srv/omarchy-pool")],
    };
    let task = net::parse_list("10.231.0.0/16").unwrap();
    let b = legacy::check(
        "omarchy-pool",
        &seen,
        Path::new("/srv/omarchy-pool/host"),
        &task,
    );
    assert_eq!(b.len(), 1, "{b:?}");
    assert!(b[0].contains("task subnets"));
    let b = legacy::check("omarchy-pool", &seen, Path::new("/srv/omarchy-pool"), &[]);
    assert!(b[0].contains("work root"), "{b:?}");
    let b = legacy::check("gone", &legacy::Seen::default(), Path::new("/srv/x"), &[]);
    assert!(b[0].contains("no container"), "{b:?}");
    let found = vec![
        ("a".to_owned(), "omarchy-host".to_owned()),
        ("b".to_owned(), "omarchy-pool".to_owned()),
        ("c".to_owned(), String::new()),
    ];
    assert_eq!(legacy::removable(&found, Some("omarchy-pool")), ["a", "c"]);
    assert!(legacy::valid_project("omarchy-pool") && !legacy::valid_project("Bad/Name"));
}

#[test]
fn the_envelope_keeps_the_owners_keys_and_takes_the_ids_after_the_confirm() {
    let v = values(Path::new("/d"));
    let first = envelope::render(None, &v, None).unwrap();
    assert!(!first.contains("host_id"));
    assert!(crate::run::config::Config::parse(&first)
        .unwrap_err()
        .contains("host_id is missing"));
    let with = envelope::render(None, &v, Some(("h_0123456789", "m1-rack-0a9z"))).unwrap();
    let c = crate::run::config::Config::parse(&with).unwrap();
    assert_eq!(
        (c.host_id.as_str(), c.worker_id.as_str()),
        ("h_0123456789", "m1-rack-0a9z")
    );
    assert_eq!(c.task_subnets.as_deref(), Some(TASK_SUBNETS));
    assert!(c.envelope.allow_socket && c.envelope.dedicated && !c.envelope.rootful_ack);
    // The emulated lane's switch, shown to the owner who confirms (#338): the foreign
    // architecture detection found.
    assert_eq!(
        crate::capacity::AgentToml::parse(&with)
            .unwrap()
            .caps
            .emulate,
        Some(vec!["x86_64".to_owned()])
    );
    // The owner narrowed it by hand; a re-run keeps that and refreshes the ids.
    let edited = with
        .replace("emulate = [\"x86_64\"]\n", "emulate = []\n")
        .replace("[envelope]\n", "[envelope]\nmax_units = 3\n");
    assert_ne!(edited, with);
    let again =
        envelope::render(Some(&edited), &v, Some(("h_0123456789", "m1-rack-1b2c"))).unwrap();
    let t: toml::Table = toml::from_str(&again).unwrap();
    assert_eq!(t["envelope"]["max_units"].as_integer(), Some(3));
    assert_eq!(
        t["envelope"]["emulate"].as_array().map(Vec::len),
        Some(0),
        "an owner's emulate = [] stays"
    );
    assert_eq!(t["worker_id"].as_str(), Some("m1-rack-1b2c"));
    assert_eq!(
        crate::capacity::AgentToml::parse(&again)
            .unwrap()
            .caps
            .max_units,
        Some(3)
    );
}

#[test]
fn the_run_loop_lints_the_set_for_the_engine_install_found() {
    use crate::lint::{lint_compose, Engine};
    use crate::run::config::Config;
    let compose = crate::run::fake::HOST_COMPOSE;
    let ids = Some(("h_0123456789", "m1-rack-0a9z"));
    // Rootless podman on a shared machine's dedicated user: no ack, not dedicated.
    let rootless = envelope::Values {
        dedicated: false,
        ..values(Path::new("/d"))
    };
    let c = Config::parse(&envelope::render(None, &rootless, ids).unwrap()).unwrap();
    assert_eq!(c.engine, Engine::Rootless);
    lint_compose(compose, None, &c.envelope, c.engine).unwrap();
    // A rootful daemon: the envelope carries the ack and `dedicated` the owner gave.
    let rootful = envelope::Values {
        rootful: true,
        ..values(Path::new("/d"))
    };
    let c = Config::parse(&envelope::render(None, &rootful, ids).unwrap()).unwrap();
    assert_eq!(c.engine, Engine::Rootful);
    lint_compose(compose, None, &c.envelope, c.engine).unwrap();
    // Without set.engine (written by hand), the strict case; an unknown kind is refused.
    let text = envelope::render(None, &rootless, ids).unwrap();
    let by_hand = text.replace("engine = \"rootless\"\n", "");
    let c = Config::parse(&by_hand).unwrap();
    assert_eq!(c.engine, Engine::Rootful);
    assert!(lint_compose(compose, None, &c.envelope, c.engine).is_err());
    assert!(Config::parse(&text.replace("\"rootless\"", "\"vm\"")).is_err());
}

#[test]
fn the_registration_comes_from_the_token_file_enrollment_wrote() {
    let d = tempdir();
    let env = d.join("dispatcher.env");
    assert_eq!(enroll::worker_of(&env), None);
    fs::write(
        &env,
        format!(
            "# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN=omw_{}\n",
            "0f".repeat(24)
        ),
    )
    .unwrap();
    assert_eq!(enroll::worker_of(&env).as_deref(), Some("m1-rack-0a9z"));
    fs::write(&env, "# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN=\n").unwrap();
    assert_eq!(enroll::worker_of(&env), None);
}

// --- preflight and the steps after it, on a played host ---------------------------

fn values(root: &Path) -> envelope::Values {
    envelope::Values {
        pool: "https://pkgs.omarchy-pool.org".into(),
        set_dir: root.join("data/sets/host"),
        work_root: root.join("work"),
        secrets_dir: root.join("secrets"),
        socket: root.join("engine.sock"),
        socket_mount: root.join("engine.sock"),
        task_subnets: TASK_SUBNETS.into(),
        rootful: false,
        userns_remap: false,
        dedicated: true,
        max_units: None,
        max_cpus: None,
        max_mem_gb: None,
        emulate: Some(vec!["x86_64".into()]),
        vm: None,
    }
}

/// A host for preflight: its places under `root`, a release signed for the test verifier
/// whose agent is `root/agent`, a socket that answers (libpod's API, [`serve_libpod`]), and a
/// docker CLI stand-in.
struct Host {
    root: PathBuf,
    options: Options,
    docker: PathBuf,
}

/// libpod's API on `root/engine.sock`, as podman answers it, for as long as the test runs:
/// `/_ping` with its version (as Docker's, without one, when `root/libpod-off` is there),
/// `/libpod/info` from `root/libpod-info`, and networks made (or refused with
/// `root/libpod-refuses`), every request kept in `root/libpod.log`. A connection that only says
/// the socket answers gets nothing.
fn serve_libpod(root: &Path) {
    use std::io::{Read, Write};
    let l = std::os::unix::net::UnixListener::bind(root.join("engine.sock")).unwrap();
    let root = root.to_owned();
    std::thread::spawn(move || {
        for mut c in l.incoming().flatten() {
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            let request = loop {
                let n = c.read(&mut buf).unwrap_or(0);
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw).into_owned();
                let Some(end) = text.find("\r\n\r\n") else {
                    if n == 0 {
                        break None;
                    }
                    continue;
                };
                let len = text[..end]
                    .lines()
                    .find_map(|l| l.strip_prefix("Content-Length: "))
                    .map_or(0, |n| n.parse::<usize>().unwrap_or(0));
                if raw.len() >= end + 4 + len || n == 0 {
                    break Some(text);
                }
            };
            let Some(request) = request else { continue };
            let first = request.lines().next().unwrap_or_default().to_owned();
            let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
            let mut log = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(root.join("libpod.log"))
                .unwrap();
            let _ = writeln!(log, "{first} {body}");
            let answer = if first.starts_with("GET /_ping ") {
                if root.join("libpod-off").exists() {
                    "HTTP/1.0 200 OK\r\nApi-Version: 1.51\r\n\r\nOK".to_owned()
                } else {
                    "HTTP/1.0 200 OK\r\nLibpod-Api-Version: 4.9.3\r\n\r\nOK".to_owned()
                }
            } else if first.starts_with("GET /v4.9.3/libpod/info ") {
                let info = fs::read_to_string(root.join("libpod-info"))
                    .unwrap_or_else(|_| r#"{"host":{"security":{"rootless":true}}}"#.into());
                format!("HTTP/1.0 200 OK\r\n\r\n{info}")
            } else if first.starts_with("POST /v4.9.3/libpod/networks/create ") {
                match fs::read_to_string(root.join("libpod-refuses")) {
                    Ok(why) => {
                        format!("HTTP/1.0 500 Internal Server Error\r\n\r\n{{\"message\":{why:?}}}")
                    }
                    Err(_) => "HTTP/1.0 200 OK\r\n\r\n{}".to_owned(),
                }
            } else {
                "HTTP/1.0 404 Not Found\r\n\r\nNot Found".to_owned()
            };
            let _ = c.write_all(answer.as_bytes());
        }
    });
}

const INFO: &str = r#"{"NCPU":12,"MemTotal":33443418112,"DockerRootDir":"/nonexistent/storage","Architecture":"aarch64","SecurityOptions":["name=rootless"],"CgroupVersion":"2","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true}"#;
const PROBE: &str = "cpu.max=50000 100000\nmemory.max=67108864\npids.max=32\npagesize=4096\noverlay 482344960 1 230686720 1% /";
const EGRESS_OK: &str = "egress metadata blocked\negress router blocked\negress lan blocked\n\
    egress vm-host blocked\negress gateway-22 blocked\negress gateway-53 blocked\n\
    egress gateway-3128 blocked\negress gateway-8790 blocked\negress gateway-8791 blocked\n\
    egress public open";
/// What the probe task on a task's own network answers when its gateway is not there.
const TASK_EGRESS_OK: &str = "egress gateway-22 blocked\negress gateway-53 blocked\n\
    egress gateway-3128 blocked\negress gateway-8790 blocked\negress gateway-8791 blocked";
/// `version` of a Docker that keeps a task network's gateway off the host.
const DOCKER_28: &str =
    r#"{"Version":"28.5.1","Components":[{"Name":"Engine","Version":"28.5.1"}]}"#;
/// `version` of podman behind its docker API.
const PODMAN: &str =
    r#"{"Version":"4.9.3","Components":[{"Name":"Podman Engine","Version":"4.9.3"}]}"#;
/// What a probe task reaches through Colima's NAT in a VM without the task firewall, and
/// the VM itself (its sshd) at its bridge's gateway.
const EGRESS_NAT: &str = "egress metadata blocked\negress router open\negress lan refused\n\
    egress vm-host refused\negress gateway-22 open\negress gateway-53 refused\n\
    egress gateway-3128 refused\negress gateway-8790 refused\negress gateway-8791 refused\n\
    egress public open";

fn host(info: &str, egress: &str) -> Host {
    host_min(info, egress, 1)
}

#[allow(clippy::too_many_lines)] // one host, every place of it: the release, the engine, the firewall
fn host_min(info: &str, egress: &str, min_cpus: u32) -> Host {
    let root = tempdir();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    for d in ["home", "config", "run", "linger", "binfmt"] {
        fs::create_dir_all(root.join(d)).unwrap();
    }
    fs::write(root.join("run/bus"), "").unwrap();
    fs::write(
        root.join("routes"),
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n",
    )
    .unwrap();
    // Where install.sh puts the agent: `<data>/versions/<v>/`, `current` pointing at it.
    let agent = root.join("data/versions/v1.0.0/omarchy-agent");
    fs::create_dir_all(agent.parent().unwrap()).unwrap();
    fs::write(&agent, b"the agent this release ships").unwrap();
    std::os::unix::fs::symlink("versions/v1.0.0", root.join("data/current")).unwrap();
    let mut m = tests_support::manifest_json("v1.20.0", "v1.0.0", &[]);
    m["created"] = "2027-01-14T08:00:00Z".into();
    m["agent"]["version"] = crate::AGENT_VERSION.into();
    for p in ["x86_64-linux", "aarch64-linux", "aarch64-darwin"] {
        m["agent"][p]["sha256"] = tools::sha256_hex(b"the agent this release ships").into();
    }
    // A test machine's own disk and cgroup decide nothing here.
    m["inner"]["capacity"]["min"] =
        serde_json::json!({"cpus": min_cpus, "mem_gb": 1, "work_disk_gb": 1, "engine_disk_gb": 1});
    let archive = tests_support::bundle_archive(
        m,
        &[
            (
                "compose.yml",
                crate::run::fake::rendered_compose("").as_bytes(),
            ),
            ("set.toml", HOST_SET.as_bytes()),
        ],
    );
    fs::write(root.join("bundle.tar.gz"), archive).unwrap();
    fs::write(root.join("bundle.sigstore.json"), "signed").unwrap();
    for (name, body) in [
        ("info", info),
        ("probe", PROBE),
        ("egress", egress),
        ("task-egress", TASK_EGRESS_OK),
        ("version", DOCKER_28),
    ] {
        fs::write(root.join(name), body).unwrap();
    }
    // INFO is rootless Docker's: its RootlessKit, as dockerd-rootless.sh runs it.
    process(&root.join("proc"), 4242, ROOTLESSKIT);
    let docker = root.join("docker");
    fs::write(
        &docker,
        format!(
            "#!/bin/sh\necho \"$*\" >> {r}/docker.log\ncase \" $* \" in\n  *\" info \"*) cat {r}/info ;;\n  *\" version \"*) cat {r}/version ;;\n  *\" network ls -q --filter label=org.omarchy-pool.probe=egress \"*) cat {r}/stale 2>/dev/null || true ;;\n  *\" network create \"*|*\" network rm \"*|*\" ps \"*) ;;\n  *\" network ls \"*|*\" network inspect \"*) ;;\n  *omarchy-egress-probe-*-task*) cat {r}/task-egress ;;\n  *omarchy-egress-probe-*) cat {r}/egress ;;\n  *\" --entrypoint pacman \"*) cat {r}/pacman 2>/dev/null || exit 125 ;;\n  *\" --entrypoint /usr/bin/true \"*) test -e {r}/pacman || exit 125 ;;\n  *\" run \"*) cat {r}/probe ;;\n  *) exit 2 ;;\nesac\n",
            r = root.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o755)).unwrap();
    serve_libpod(&root);
    let options = Options {
        places: Places {
            data: root.join("data"),
            home: root.join("home"),
            config_home: root.join("config"),
            xdg_runtime_dir: Some(root.join("run")),
            user: "omarchy".into(),
            os: "linux",
            linger_dir: root.join("linger"),
            routes: root.join("routes"),
            binfmt: root.join("binfmt"),
            uid: 501,
            colima_home: root.join("home/.colima"),
            colima_home_env: None,
            launch_agents: root.join("home/Library/LaunchAgents"),
            logs: root.join("home/Library/Logs/omarchy-agent"),
            ssh: false,
            rosetta: root.join("rosetta"),
            mac_root: root.join("shared"),
            proc_net: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/addresses/home"),
            ifconfig: None,
            task_firewall: root.join("omarchy-task-firewall"),
            systemd_system: root.join("systemd"),
            docker_daemon: root.join("daemon.json"),
            proc: root.join("proc"),
        },
        source: Some(Source::Files(
            root.join("bundle.tar.gz"),
            root.join("bundle.sigstore.json"),
        )),
        pool: None,
        work_root: Some(root.join("work")),
        secrets_dir: Some(root.join("secrets")),
        set_dir: None,
        socket: Some(root.join("engine.sock")),
        rosetta: None,
        task_subnets: None,
        dedicated: true,
        legacy: None,
        agent_env_from: None,
        max_units: None,
        max_cpus: None,
        max_mem_gb: None,
        yes: true,
        token: Some(format!("ome_{}", "0a".repeat(24))),
        wait: Duration::ZERO,
        poll: Duration::from_millis(10),
        exe: Some(agent),
    };
    Host {
        root,
        options,
        docker,
    }
}

fn verifier() -> TestVerifier {
    TestVerifier(Rc::new(RefCell::new(T0)))
}

fn measure_on(h: &Host, sys: &mut Fake) -> (Report, Option<Ready>) {
    measure(&h.options, sys, &verifier(), Some(&h.docker))
        .map_err(|e| e.to_string())
        .unwrap()
}

/// Every path under `dir`, so a test can show nothing was added.
fn tree(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            out.push(e.path());
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                out.extend(tree(&e.path()));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn preflight_lists_every_missing_prerequisite_on_one_screen_and_changes_nothing() {
    let mut h = host("", EGRESS_OK);
    // A fresh VM: no engine yet, no user manager, a key in ~/.ssh, a shared machine.
    h.options.socket = Some(h.root.join("no-engine.sock"));
    h.options.places.xdg_runtime_dir = None;
    h.options.dedicated = false;
    fs::create_dir_all(h.root.join("home/.ssh")).unwrap();
    fs::write(
        h.root.join("home/.ssh/id_rsa"),
        "-----BEGIN RSA PRIVATE KEY-----",
    )
    .unwrap();
    h.options.legacy = Some("BAD".into());
    let before = tree(&h.root);
    let mut sys = Fake::default();
    let (r, ready) = measure_on(&h, &mut sys);
    assert!(ready.is_none());
    let screen = r.screen();
    for want in [
        "no container engine answers",
        "XDG_RUNTIME_DIR",
        "an SSH private key",
        "--legacy \"BAD\"",
        "egress: not probed",
        "nothing was changed",
    ] {
        assert!(screen.contains(want), "{want}:\n{screen}");
    }
    assert_eq!(r.blockers.len(), 4, "{screen}");
    // One screen, and nothing written: install stops at it.
    let mut out = Vec::new();
    let e = install_with(&h.options, &mut sys, &verifier(), Some(&h.docker), &mut out).unwrap_err();
    assert!(matches!(e, Failure::Refused(_)), "{e}");
    assert_eq!(tree(&h.root), before);
    assert!(
        sys.calls.iter().all(|c| !c.starts_with("systemctl")),
        "{:?}",
        sys.calls
    );

    // An engine that answers, on a host below the release's minimum: refused with the
    // numbers; and the owner's caps leaving no unit.
    let h = host_min(&INFO.replace(r#""NCPU":12"#, r#""NCPU":2"#), EGRESS_OK, 4);
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(ready.is_none());
    assert!(
        r.screen()
            .contains("below the minimum to join: CPUs: 2 (the minimum is 4)"),
        "{}",
        r.screen()
    );
    let h = host(INFO, EGRESS_OK);
    let mut o = h.options.clone();
    o.max_cpus = Some(1);
    let (r, _) = measure(&o, &mut Fake::default(), &verifier(), Some(&h.docker))
        .map_err(|e| e.to_string())
        .unwrap();
    assert!(r.screen().contains("no unit is left"), "{}", r.screen());
}

#[test]
fn preflight_reports_the_emulated_lane_and_never_stops_on_a_held_one() {
    // An aarch64 host without binfmt: the x86_64 lane is held for a person, the install goes on.
    let h = host(INFO, EGRESS_OK);
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(r.ok(), "{}", r.screen());
    let ready = ready.expect("ready");
    assert!(
        r.notes.iter().any(|n| n.starts_with("emulation x86_64: held — needs a person: prep-root.sh installs qemu-user-static-binfmt")),
        "{:?}",
        r.notes
    );
    let lanes: Vec<_> = ready
        .capacity
        .lanes()
        .iter()
        .map(|l| (l.arch.clone(), l.mode))
        .collect();
    assert_eq!(lanes, [("aarch64".to_owned(), "native")]);
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(
        !log.contains("--platform"),
        "no smoke run without binfmt: {log}"
    );

    // With qemu's handler (the F flag) and an engine that runs the release's x86_64 image: on.
    let h = host(INFO, EGRESS_OK);
    fs::write(
        h.root.join("binfmt/qemu-x86_64"),
        "enabled\ninterpreter /usr/bin/qemu-x86_64-static\nflags: POCF\n",
    )
    .unwrap();
    fs::write(h.root.join("pacman"), "Pacman v7.0.0 - libalpm v15.0.0\n").unwrap();
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(r.ok(), "{}", r.screen());
    assert!(
        r.notes
            .iter()
            .any(|n| n == "emulation x86_64: on, through qemu"),
        "{:?}",
        r.notes
    );
    let lanes: Vec<_> = ready
        .unwrap()
        .capacity
        .lanes()
        .iter()
        .map(|l| (l.arch.clone(), l.mode))
        .collect();
    assert_eq!(
        lanes,
        [
            ("aarch64".to_owned(), "native"),
            ("x86_64".to_owned(), "emulated")
        ]
    );
    // The release's x86_64 build image, by digest: the engine's foreign architecture picks it,
    // whatever this test binary's own architecture is.
    let x86_image = tests_support::manifest("v1.20.0", "v1.0.0", &[])
        .build_image("x86_64")
        .unwrap()
        .to_string();
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(
        log.contains(&format!(
            "run --rm --network none --platform linux/amd64 --entrypoint /usr/bin/true {x86_image}"
        )),
        "{log}"
    );
    assert!(
        log.contains(&format!(
            "--platform linux/amd64 --entrypoint pacman {x86_image} --version"
        )),
        "{log}"
    );

    // The owner's envelope from an earlier install keeps it off: nothing is run for it.
    let h = host(INFO, EGRESS_OK);
    fs::write(
        h.root.join("binfmt/qemu-x86_64"),
        "enabled\ninterpreter /usr/bin/qemu-x86_64-static\nflags: POCF\n",
    )
    .unwrap();
    fs::write(h.root.join("pacman"), "Pacman v7.0.0\n").unwrap();
    fs::create_dir_all(h.root.join("data")).unwrap();
    fs::write(h.root.join("data/agent.toml"), "[envelope]\nemulate = []\n").unwrap();
    fs::set_permissions(
        h.root.join("data/agent.toml"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(
        r.notes
            .iter()
            .any(|n| n == "emulation x86_64: held — off: the envelope's emulate does not list it"),
        "{}",
        r.screen()
    );
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(!log.contains("--platform"), "{log}");
}

#[test]
fn preflight_fails_the_install_when_a_task_reaches_the_lan_and_checks_the_release_and_this_binary()
{
    let h = host(INFO, &EGRESS_OK.replace("lan blocked", "lan refused"));
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(ready.is_none());
    assert!(
        r.screen().contains("a task reaches the host's LAN address"),
        "{}",
        r.screen()
    );
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(log.contains("network create --subnet 10.231.255.240/28 --label org.omarchy-pool.probe=egress omarchy-egress-probe-"), "{log}");
    // Then a network made as the dispatcher makes a task's on this Docker (#367).
    assert!(log.contains("network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated --subnet 10.231.255.240/28 --label org.omarchy-pool.probe=egress omarchy-egress-probe-"), "{log}");
    // Each probe task at the /28's last address, never .1 (the gateway it tries).
    assert_eq!(
        log.matches("--ip 10.231.255.254 --label org.omarchy-pool.probe=egress")
            .count(),
        2,
        "{log}"
    );
    // Swept before and after each: every labelled probe container and network.
    let sweep = "network ls -q --filter label=org.omarchy-pool.probe=egress";
    assert_eq!(log.matches(sweep).count(), 4, "{log}");
    assert!(
        log.contains("ps -aq --no-trunc --filter label=org.omarchy-pool.probe=egress"),
        "{log}"
    );

    let mut h = host(INFO, EGRESS_OK);
    fs::write(h.root.join("agent"), "another binary").unwrap();
    h.options.exe = Some(h.root.join("agent"));
    h.options.pool = Some("https://evil.example".into());
    let (r, _) = measure_on(&h, &mut Fake::default());
    let s = r.screen();
    assert!(s.contains("is not the agent release v1.20.0 ships"), "{s}");
    assert!(s.contains("not one this release signs"), "{s}");
    fs::write(h.root.join("bundle.sigstore.json"), "forged").unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(
        r.screen().contains("the release bundle is refused"),
        "{}",
        r.screen()
    );

    // A write-scoped GITHUB_TOKEN in the file to copy is a blocker before anything is written.
    let mut h = host(INFO, EGRESS_OK);
    fs::write(h.root.join("agent.env"), "GITHUB_TOKEN=ghp_x\n").unwrap();
    h.options.agent_env_from = Some(h.root.join("agent.env"));
    let mut sys = Fake {
        scopes: Ok(Some("repo, workflow".into())),
        ..Fake::default()
    };
    let (r, _) = measure_on(&h, &mut sys);
    assert!(
        r.screen()
            .contains("GITHUB_TOKEN carries the scopes repo, workflow"),
        "{}",
        r.screen()
    );
}

#[test]
fn an_earlier_probes_network_is_removed_before_the_probe_needs_its_subnet() {
    let h = host(INFO, EGRESS_OK);
    // Left by an install interrupted mid-probe (another pid): it holds the probe's /28.
    fs::write(h.root.join("stale"), "omarchy-egress-probe-1\n").unwrap();
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(r.ok() && ready.is_some(), "{}", r.screen());
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    let rm = log.find("network rm omarchy-egress-probe-1").expect(&log);
    assert!(rm < log.find("network create --subnet").unwrap(), "{log}");
}

/// `docker info` of a rootful daemon with userns-remap: a new host's rootful engine.
fn rootful_info() -> String {
    INFO.replace(
        r#""SecurityOptions":["name=rootless"]"#,
        r#""SecurityOptions":["name=userns"]"#,
    )
}

#[test]
fn a_rootful_host_whose_tasks_reach_it_through_their_bridge_is_refused_with_the_command_to_run() {
    // prep-root.sh never ran: no firewall script, and the host itself answers a bridge's
    // task on its gateway and on its LAN address, both through INPUT.
    let h = host(
        &rootful_info(),
        &EGRESS_OK
            .replace("gateway-22 blocked", "gateway-22 refused")
            .replace("lan blocked", "lan refused"),
    );
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(ready.is_none());
    let s = r.screen();
    let cmd = format!(
        "run sudo factory/host/prep-root.sh --user omarchy --work-root {} --task-subnets 10.231.0.0/16",
        h.root.join("work").display()
    );
    assert!(
        s.contains("prep-root.sh's INPUT drop for the task subnets (OMARCHY-TASKS-HOST) is not installed: /usr/local/libexec/omarchy-task-firewall, its unit's script, is not there"),
        "{s}"
    );
    assert!(
        s.contains("a task on a signed exception's bridge network reaches its gateway 10.231.255.241 (port 22: refused); on a rootful engine that is this host itself"),
        "{s}"
    );
    assert!(
        s.contains("a task reaches the host's LAN address")
            && s.contains("(port 22: refused); on a rootful engine that is this host itself"),
        "{s}"
    );
    assert!(
        !s.contains("DOCKER-USER rules, or the egress sidecar"),
        "{s}"
    );
    assert_eq!(r.blockers.len(), 3, "{s}");
    assert!(r.blockers.iter().all(|b| b.ends_with(&cmd)), "{s}");
    // A rootful engine's network stack is the host's own: nothing is read in /proc.
    assert!(!s.contains("network stack"), "{s}");

    // The script there but for other subnets: still not installed.
    fs::write(
        h.root.join("omarchy-task-firewall"),
        FIREWALL.replace("10.231.0.0/16", "10.232.0.0/16"),
    )
    .unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(
        r.screen()
            .contains("its unit's script, does not drop 10.231.0.0/16"),
        "{}",
        r.screen()
    );

    // The unit's script drops the task subnets, its unit is enabled, and the probe still
    // reaches the host: the rule was flushed since, and the unit puts it back.
    prepare(&h.root);
    let (r, _) = measure_on(&h, &mut Fake::default());
    let s = r.screen();
    assert!(!s.contains("is not installed"), "{s}");
    assert_eq!(r.blockers.len(), 2, "{s}");
    assert!(
        r.blockers
            .iter()
            .all(|b| b.ends_with("run sudo systemctl restart omarchy-task-firewall.service")),
        "{s}"
    );

    // A host whose own firewall closes the ports probed, without prep-root.sh's drop: refused
    // all the same, since its other services stay open to a task.
    let h = host(&rootful_info(), EGRESS_OK);
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert_eq!(r.blockers.len(), 1, "{}", r.screen());
    assert!(r.blockers[0].contains("is not installed"), "{}", r.screen());
    // With prep-root.sh's daemon.json: its address pool goes with the command.
    fs::write(
        h.root.join("daemon.json"),
        r#"{"default-address-pools":[{"base":"10.200.0.0/16","size":24}]}"#,
    )
    .unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(
        r.blockers[0].ends_with("--task-subnets 10.231.0.0/16 --address-pool 10.200.0.0/16"),
        "{}",
        r.screen()
    );
}

#[test]
fn a_rootful_host_whose_firewall_unit_does_not_run_at_boot_is_refused_with_the_command_to_run() {
    // The script drops the task subnets, but the host answers: restarting the unit alone,
    // when it is not enabled, would last until the next reboot.
    let h = host(
        &rootful_info(),
        &EGRESS_OK
            .replace("gateway-22 blocked", "gateway-22 refused")
            .replace("lan blocked", "lan refused"),
    );
    prepare(&h.root);
    let wanted = h
        .root
        .join("systemd/multi-user.target.wants/omarchy-task-firewall.service");
    fs::remove_file(&wanted).unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    let s = r.screen();
    assert!(s.contains("is not installed: omarchy-task-firewall.service, the unit that runs /usr/local/libexec/omarchy-task-firewall at boot, is not enabled"), "{s}");
    assert_eq!(r.blockers.len(), 3, "{s}");
    assert!(
        r.blockers.iter().all(|b| b.ends_with(
            "run sudo systemctl enable omarchy-task-firewall.service && sudo systemctl restart omarchy-task-firewall.service"
        )),
        "{s}"
    );
    // The unit removed, the script left: there is nothing to restart, and prep-root.sh writes
    // it again.
    fs::remove_file(h.root.join("systemd/omarchy-task-firewall.service")).unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    let s = r.screen();
    assert!(s.contains("is not installed: /etc/systemd/system/omarchy-task-firewall.service, the unit that runs /usr/local/libexec/omarchy-task-firewall at boot, is not there"), "{s}");
    assert_eq!(r.blockers.len(), 3, "{s}");
    let cmd = format!(
        "run sudo factory/host/prep-root.sh --user omarchy --work-root {} --task-subnets 10.231.0.0/16",
        h.root.join("work").display()
    );
    assert!(r.blockers.iter().all(|b| b.ends_with(&cmd)), "{s}");

    // The drop in effect now, and nothing reaches the host, but its unit is not enabled: the
    // next reboot takes it away, and nothing probes again after install. Refused.
    let d = host(&rootful_info(), EGRESS_OK);
    prepare(&d.root);
    fs::remove_file(
        d.root
            .join("systemd/multi-user.target.wants/omarchy-task-firewall.service"),
    )
    .unwrap();
    let (r, ready) = measure_on(&d, &mut Fake::default());
    assert!(ready.is_none());
    assert_eq!(r.blockers.len(), 1, "{}", r.screen());
    assert!(
        r.blockers[0].contains("is not enabled")
            && r.blockers[0].ends_with("run sudo systemctl enable omarchy-task-firewall.service && sudo systemctl restart omarchy-task-firewall.service"),
        "{}",
        r.screen()
    );
}

#[test]
fn a_rootful_host_with_prep_roots_input_drop_passes_and_its_task_networks_are_probed_too() {
    // Installed, and nothing answers there: both probes pass.
    let h = host(&rootful_info(), EGRESS_OK);
    prepare(&h.root);
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(r.ok() && ready.is_some(), "{}", r.screen());
    for note in [
        "egress: a task reaches public addresses only, not its network's gateway",
        "egress: a task's own network has no gateway the task reaches",
    ] {
        assert!(r.notes.iter().any(|n| n == note), "{note}: {:?}", r.notes);
    }

    // podman behind its docker API, rootful: a task's own network is made through libpod's
    // API, internal with DNS off, as the dispatcher makes it (#372), and has no gateway; the
    // probe runs on it through the CLI. libpod is not asked which stack it runs: a rootful
    // engine runs none.
    let h = host(&rootful_info(), EGRESS_OK);
    prepare(&h.root);
    fs::write(h.root.join("version"), PODMAN).unwrap();
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(r.ok() && ready.is_some(), "{}", r.screen());
    let libpod = fs::read_to_string(h.root.join("libpod.log")).unwrap();
    assert!(
        libpod.contains("POST /v4.9.3/libpod/networks/create HTTP/1.0 {")
            && libpod.contains(r#""dns_enabled":false"#)
            && libpod.contains(r#""internal":true"#)
            && libpod.contains(r#""subnets":[{"subnet":"10.231.255.240/28"}]"#)
            && libpod.contains(r#""labels":{"org.omarchy-pool.probe":"egress"}"#)
            && !libpod.contains("/libpod/info"),
        "{libpod}"
    );
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(
        !log.contains("network create --internal") && log.contains("-task --ip 10.231.255.254"),
        "{log}"
    );
    // An engine that put an address there all the same: the host itself, behind the same drop.
    let h = host(&rootful_info(), EGRESS_OK);
    prepare(&h.root);
    fs::write(h.root.join("version"), PODMAN).unwrap();
    fs::write(
        h.root.join("task-egress"),
        TASK_EGRESS_OK.replace("gateway-53 blocked", "gateway-53 open"),
    )
    .unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    let s = r.screen();
    assert!(
        s.contains("a task on its own network reaches its gateway 10.231.255.241 (port 53: open)")
            && s.contains("run sudo systemctl restart omarchy-task-firewall.service"),
        "{s}"
    );
    // libpod refuses the network, or the socket is not libpod's although the CLI said podman:
    // not probed, and said.
    for (file, why) in [
        (
            "libpod-refuses",
            "libpod's networks/create answered 500: subnet in use",
        ),
        (
            "libpod-off",
            "answers without Libpod-Api-Version: not podman's API",
        ),
    ] {
        let h = host(&rootful_info(), EGRESS_OK);
        prepare(&h.root);
        fs::write(h.root.join("version"), PODMAN).unwrap();
        fs::write(h.root.join(file), "subnet in use").unwrap();
        let (r, ready) = measure_on(&h, &mut Fake::default());
        let s = r.screen();
        assert!(ready.is_none() && r.blockers.len() == 1, "{s}");
        assert!(
            s.contains("egress: the egress probe's network 10.231.255.240/28: ") && s.contains(why),
            "{s}"
        );
    }

    // A Docker older than 28 cannot keep the gateway off: refused, as the dispatcher refuses it.
    let h = host(&rootful_info(), EGRESS_OK);
    prepare(&h.root);
    fs::write(
        h.root.join("version"),
        r#"{"Version":"27.5.1","Components":[{"Name":"Engine","Version":"27.5.1"}]}"#,
    )
    .unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(
        r.screen()
            .contains("docker 27 cannot keep a task network's gateway off the host"),
        "{}",
        r.screen()
    );
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(!log.contains("network create --internal"), "{log}");
}

#[test]
fn a_rootless_host_whose_stack_maps_its_loopback_or_whose_tasks_reach_their_gateway_is_refused() {
    // Rootless Docker as dockerd-rootless.sh runs it: RootlessKit keeps the host's loopback
    // out, and nothing of prep-root.sh's is asked for.
    let h = host(INFO, EGRESS_OK);
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(r.ok(), "{}", r.screen());
    assert!(
        r.notes
            .iter()
            .any(|n| n.contains("maps nothing to the host's loopback (RootlessKit (pid 4242))")),
        "{:?}",
        r.notes
    );

    // With DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false: refused, with the setting.
    let h = host(INFO, EGRESS_OK);
    let on: Vec<&str> = ROOTLESSKIT
        .iter()
        .copied()
        .filter(|a| *a != "--disable-host-loopback")
        .collect();
    process(&h.root.join("proc"), 4242, &on);
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(ready.is_none());
    let s = r.screen();
    assert!(
        s.contains("maps this host's loopback into the networks tasks run on (RootlessKit (pid 4242) at 10.0.2.2)")
            && s.contains("DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false"),
        "{s}"
    );
    assert_eq!(r.blockers.len(), 1, "{s}");

    // No stack of this user seen while the probes ran: nothing says it is off.
    let h = host(INFO, EGRESS_OK);
    fs::remove_dir_all(h.root.join("proc")).unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(
        r.blockers.len() == 1
            && r.blockers[0].contains("no network stack of this user's rootless engine"),
        "{}",
        r.screen()
    );

    // Rootless podman 4 (slirp4netns; libpod's /info names no network command): its task
    // network, made through libpod with DNS off, should have no gateway, and one that answers
    // is the engine's doing; its slirp4netns with allow_host_loopback=true maps the host's
    // loopback, and the setting is containers.conf's. pasta's guest address is not tried.
    let h = host(INFO, EGRESS_OK);
    fs::remove_dir_all(h.root.join("proc")).unwrap();
    process(
        &h.root.join("proc"),
        77,
        &SLIRP4NETNS
            .iter()
            .copied()
            .filter(|a| *a != "--disable-host-loopback")
            .collect::<Vec<_>>(),
    );
    fs::write(h.root.join("version"), PODMAN).unwrap();
    fs::write(
        h.root.join("task-egress"),
        TASK_EGRESS_OK.replace("gateway-22 blocked", "gateway-22 refused"),
    )
    .unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    let s = r.screen();
    assert!(
        s.contains("a task on its own network reaches its gateway 10.231.255.241 (port 22: refused); the engine put an address on a task's network although it was made through libpod's API with DNS off"),
        "{s}"
    );
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(!log.contains("guest-"), "{log}");
    assert!(fs::read_to_string(h.root.join("libpod.log"))
        .unwrap()
        .contains("GET /v4.9.3/libpod/info HTTP/1.0"),);
    assert!(
        s.contains("(slirp4netns (pid 77) at 10.0.2.2)") && s.contains("allow_host_loopback=true"),
        "{s}"
    );
    assert_eq!(r.blockers.len(), 2, "{s}");
    assert!(!s.contains("prep-root.sh --user"), "{s}");
}

/// What libpod's /info says of rootless podman 5 behind pasta.
const PASTA_INFO: &str = r#"{"host":{"rootlessNetworkCmd":"pasta","security":{"rootless":true},"pasta":{"executable":"/usr/bin/pasta"}}}"#;

/// `out` with pasta's guest-mapped address blocked on every port, as a probe that tried it says.
fn with_guest(out: &str) -> String {
    let mut out = out.to_owned();
    for p in egress::GATEWAY_PORTS {
        let _ = write!(out, "\negress guest-{p} blocked");
    }
    out
}

#[test]
fn rootless_podman_behind_pasta_is_refused_when_its_guest_address_reaches_the_host() {
    let pasta_host = || {
        let h = host(INFO, &with_guest(EGRESS_OK));
        fs::remove_dir_all(h.root.join("proc")).unwrap();
        process(&h.root.join("proc"), 88, PASTA);
        fs::write(h.root.join("version"), PODMAN).unwrap();
        fs::write(h.root.join("libpod-info"), PASTA_INFO).unwrap();
        h
    };
    // podman's defaults (5.3 on): pasta maps 169.254.1.2, which the bridge's probe task tries on
    // 22, 53 and the pool's ports; nothing answers there, so it passes, and says so. A task's own
    // network does not try it: internal, it has no route there, and `nc -z` reads an address
    // that fails at once as a refusal.
    let h = pasta_host();
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(r.ok() && ready.is_some(), "{}", r.screen());
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert_eq!(log.matches("guest-22 169.254.1.2 22").count(), 1, "{log}");
    assert!(log.contains("guest-8791 169.254.1.2 8791"), "{log}");
    let task_probe = log
        .split("--network omarchy-egress-probe-")
        .find(|r| r.split_once(' ').is_some_and(|(n, _)| n.ends_with("-task")))
        .unwrap_or_else(|| panic!("no task network's probe: {log}"));
    assert!(
        task_probe.contains("gateway-22 ") && !task_probe.contains("guest-"),
        "{task_probe}"
    );
    for note in [
        "egress: a task reaches public addresses only, not its network's gateway, nor pasta's guest-mapped address 169.254.1.2",
        "egress: a task's own network has no gateway the task reaches",
        "egress: the rootless engine's network stack maps nothing to the host's loopback (pasta (pid 88))",
    ] {
        assert!(r.notes.iter().any(|n| n == note), "{note}: {:?}", r.notes);
    }

    // The host's sshd answers there: refused, with containers.conf's setting.
    let h = pasta_host();
    fs::write(
        h.root.join("egress"),
        with_guest(EGRESS_OK)
            .replace("guest-22 blocked", "guest-22 open")
            .replace("guest-8790 blocked", "guest-8790 refused"),
    )
    .unwrap();
    let (r, ready) = measure_on(&h, &mut Fake::default());
    let s = r.screen();
    assert!(ready.is_none() && r.blockers.len() == 1, "{s}");
    assert!(
        s.contains("egress: a task on a signed exception's bridge network reaches pasta's guest-mapped address 169.254.1.2 (port 22: open, port 8790: refused), which pasta forwards to this host's own address")
            && s.contains(r#"pasta_options = ["--map-guest-addr", "none"]"#)
            && s.contains("containers.conf")
            && !s.contains("prep-root.sh --user"),
        "{s}"
    );

    // An address of the owner's own (pasta_options' --map-guest-addr): not tried, so refused
    // from pasta's command line; and with `none`, nothing is mapped and it passes.
    for (addr, refused) in [("10.0.2.9", true), ("none", false)] {
        let h = pasta_host();
        let mut argv: Vec<&str> = PASTA.to_vec();
        let at = argv.len() - 1;
        argv[at] = addr;
        process(&h.root.join("proc"), 88, &argv);
        let (r, _) = measure_on(&h, &mut Fake::default());
        let s = r.screen();
        if refused {
            assert!(
                r.blockers.len() == 1
                    && s.contains("pasta maps a guest address to this host's own address (pasta (pid 88) at 10.0.2.9), which the probe did not try")
                    && s.contains("--map-guest-addr"),
                "{s}"
            );
        } else {
            assert!(r.ok(), "{s}");
        }
    }

    // podman's slirp4netns, or a podman that names no network command (4.x): not tried.
    for info in [
        r#"{"host":{"rootlessNetworkCmd":"slirp4netns","security":{"rootless":true}}}"#,
        r#"{"host":{"security":{"rootless":true}}}"#,
    ] {
        let h = host(INFO, EGRESS_OK);
        fs::remove_dir_all(h.root.join("proc")).unwrap();
        process(&h.root.join("proc"), 77, SLIRP4NETNS);
        fs::write(h.root.join("version"), PODMAN).unwrap();
        fs::write(h.root.join("libpod-info"), info).unwrap();
        let (r, _) = measure_on(&h, &mut Fake::default());
        assert!(r.ok(), "{info}: {}", r.screen());
        let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
        assert!(!log.contains("guest-"), "{log}");
    }

    // libpod's /info does not answer: nothing says which stack it runs.
    let h = pasta_host();
    fs::write(h.root.join("libpod-info"), "not json").unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(
        r.blockers
            .iter()
            .any(|b| b.contains("which network stack rootless podman runs (libpod's /info): libpod's info does not read")),
        "{}",
        r.screen()
    );
}

#[test]
fn libpod_answers_are_read_whole_and_its_info_says_which_stack() {
    let a = libpod::parse(
        b"HTTP/1.0 200 OK\r\nLibpod-Api-Version: 5.6.1\r\nContent-Length: 2\r\n\r\nOKjunk",
    )
    .unwrap();
    assert_eq!(
        (a.status, a.header("libpod-api-version"), &a.body[..]),
        (200, Some("5.6.1"), &b"OK"[..])
    );
    for bad in [
        &b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n"[..],
        b"SSH-2.0-OpenSSH\r\n\r\n",
        b"HTTP/1.0 200 OK\r\nContent-Length: 9\r\n\r\nshort",
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n",
    ] {
        assert!(
            libpod::parse(bad).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
    let i = libpod::parse_info(PASTA_INFO).unwrap();
    assert!(i.pasta() && i.rootless);
    // Rootful podman names its default all the same: no pasta runs for it.
    let rootful = libpod::parse_info(
        r#"{"host":{"rootlessNetworkCmd":"pasta","security":{"rootless":false}}}"#,
    )
    .unwrap();
    assert!(!rootful.pasta());
    let old = libpod::parse_info(
        r#"{"host":{"security":{"rootless":true},"pasta":{"executable":"/usr/bin/pasta"}}}"#,
    )
    .unwrap();
    assert_eq!(
        old,
        libpod::Info {
            rootless: true,
            network_cmd: None
        }
    );
    for bad in ["", "null", "{}", "[1]"] {
        assert!(libpod::parse_info(bad).is_err(), "{bad}");
    }
    // A socket that never answers runs out of its call; one that is not there says so.
    let d = tempdir();
    let _quiet = std::os::unix::net::UnixListener::bind(d.join("quiet.sock")).unwrap();
    let t = std::time::Instant::now();
    let e = libpod::request(
        &d.join("quiet.sock"),
        "GET",
        "/_ping",
        None,
        t + Duration::from_millis(300),
    )
    .unwrap_err();
    assert!(t.elapsed() < Duration::from_secs(5), "{e}");
    assert!(libpod::Libpod::on(&d.join("none.sock")).is_err());
}

#[test]
fn preflight_refuses_what_apply_would_fail_on_and_runs_nothing_from_a_foreign_data_dir() {
    // A data directory other than install.sh's: the unit's binary is not there.
    let mut h = host(INFO, EGRESS_OK);
    h.options.places.data = h.root.join("elsewhere");
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(
        r.screen().contains("the unit would start") && r.screen().contains("run install.sh"),
        "{}",
        r.screen()
    );

    // A work root under a directory this user cannot write: prep-root.sh's.
    let mut h = host(INFO, EGRESS_OK);
    fs::create_dir_all(h.root.join("srv")).unwrap();
    fs::set_permissions(h.root.join("srv"), fs::Permissions::from_mode(0o555)).unwrap();
    h.options.work_root = Some(h.root.join("srv/omarchy-pool/host"));
    let (r, _) = measure_on(&h, &mut Fake::default());
    fs::set_permissions(h.root.join("srv"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        r.screen()
            .contains("is not writable by this user: run factory/host/prep-root.sh"),
        "{}",
        r.screen()
    );

    // A data directory others may write: its tools are not run, the engine not asked.
    let h = host(INFO, EGRESS_OK);
    fs::set_permissions(&h.options.places.data, fs::Permissions::from_mode(0o775)).unwrap();
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(ready.is_none());
    assert!(
        r.screen().contains("group- or world-writable"),
        "{}",
        r.screen()
    );
    assert!(!h.root.join("docker.log").exists());

    // The agent.env a re-run keeps is probed too: a token's scopes widen on GitHub.
    let h = host(INFO, EGRESS_OK);
    fs::create_dir_all(h.root.join("secrets")).unwrap();
    fs::set_permissions(h.root.join("secrets"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(h.root.join("secrets/agent.env"), "GITHUB_TOKEN=ghp_x\n").unwrap();
    fs::set_permissions(
        h.root.join("secrets/agent.env"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let mut sys = Fake {
        scopes: Ok(Some("repo".into())),
        ..Fake::default()
    };
    let (r, _) = measure_on(&h, &mut sys);
    assert!(
        r.screen()
            .contains("agent.env: GITHUB_TOKEN carries the scopes repo"),
        "{}",
        r.screen()
    );
}

/// A pool on loopback: the host's state and its token, by path.
fn pool(state: String, token: String) -> String {
    use std::io::{BufRead, BufReader, Read, Write};
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", l.local_addr().unwrap());
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut first = String::new();
            let _ = r.read_line(&mut first);
            let mut len = 0;
            loop {
                let mut line = String::new();
                if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let _ = r.take(len).read_to_end(&mut Vec::new());
            let body = if first.contains("/hosts/self/token") {
                &token
            } else {
                &state
            };
            let _ = (&c).write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
        }
    });
    origin
}

/// Preflight passed on `h`; the host enrolled before (its key and host.json) with a pool
/// that answers `state`, so the steps after preflight run up to the owner's Confirm.
fn ready_to_enroll(h: &Host, state: &str) -> Ready {
    let state_dir = h.options.places.data.join("state");
    let _ = fs::remove_file(state_dir.join("host.json"));
    let (r, ready) = measure_on(h, &mut mac_sys(h));
    assert!(r.ok(), "{}", r.screen());
    let mut ready = ready.unwrap();
    let token = format!(
        r#"{{"worker":"m1-rack-0a9z","token":"omw_{}","rotate_after":"2027-02-14"}}"#,
        "0f".repeat(24)
    );
    ready.pool = pool(state.to_owned(), token);
    crate::host::private_dir(&state_dir).unwrap();
    HostKey::load_or_create(&state_dir.join(KEY_FILE)).unwrap();
    Identity {
        pool: ready.pool.clone(),
        host: "h_0123456789".into(),
    }
    .write(&state_dir)
    .unwrap();
    ready
}

#[test]
fn install_makes_the_set_directory_it_was_given_and_never_the_default_one() {
    for on_a_mac in [false, true] {
        let mut h = if on_a_mac {
            mac_host(1)
        } else {
            host(INFO, EGRESS_OK)
        };
        let chosen = h.root.join("shared/elsewhere");
        let default = h.options.places.set_dir();
        let _ = fs::remove_dir(&default);
        h.options.set_dir = Some(chosen.clone());
        let ready = ready_to_enroll(&h, r#"{"status":"active","token":null}"#);
        assert_eq!(ready.values.set_dir, chosen);
        let mut sys = mac_sys(&h);
        apply(&h.options, &ready, &mut sys, &mut Vec::new())
            .map_err(|e| e.to_string())
            .unwrap();
        assert_eq!(mode(&chosen), 0o700, "mac: {on_a_mac}");
        assert!(chosen.join("run/capacity.json").exists());
        assert!(!default.exists(), "mac: {on_a_mac}: {}", default.display());
    }
}

#[test]
fn nothing_can_claim_before_the_owner_confirms_and_the_ids_land_in_agent_toml_after() {
    let h = host(INFO, EGRESS_OK);
    let p = &h.options.places;
    let ready = ready_to_enroll(&h, r#"{"status":"pending-owner","owner":"m1"}"#);
    let mut sys = Fake::default();
    let mut out = Vec::new();
    let e = apply(&h.options, &ready, &mut sys, &mut out).unwrap_err();
    assert!(matches!(e, Failure::TimedOut(_)), "{e}");
    let said = String::from_utf8_lossy(&out).into_owned();
    assert!(said.contains("waiting for m1 to confirm"), "{said}");
    // No agent.toml, so no run loop; no token, no unit, nothing started.
    assert!(!p.data.join("agent.toml").exists());
    assert!(!p.set_dir().join("etc/dispatcher.env").exists());
    assert!(!p.unit_dir().join(unit::NAME).exists());
    assert!(sys.calls.is_empty(), "{:?}", sys.calls);
    // What enrollment sends was written: the capacity report.
    assert!(p.set_dir().join("run/capacity.json").exists());

    let ready = ready_to_enroll(&h, r#"{"status":"active","token":null}"#);
    let mut sys = Fake {
        keys: "ANTHROPIC_API_KEY=sk-test\n".into(),
        ..Fake::default()
    };
    let mut o = h.options.clone();
    o.yes = false;
    let mut out = Vec::new();
    let done = apply(&o, &ready, &mut sys, &mut out)
        .map_err(|e| e.to_string())
        .unwrap();
    let said = String::from_utf8_lossy(&out).into_owned();
    assert!(done.needs_person.is_empty(), "{:?}", done.needs_person);
    let cfg = crate::run::config::Config::load(&p.data.join("agent.toml"), files::euid()).unwrap();
    assert_eq!(
        (cfg.host_id.as_str(), cfg.worker_id.as_str()),
        ("h_0123456789", "m1-rack-0a9z")
    );
    assert_eq!(cfg.pool, "https://omarchy-pool.example.org"); // the release's signed pool
    assert_eq!(cfg.socket_cli, h.root.join("engine.sock"));
    assert_eq!(mode(&p.data.join("agent.toml")), 0o600);
    let unit_text = fs::read_to_string(p.unit_dir().join(unit::NAME)).unwrap();
    assert!(unit_text.contains(&format!("run --data-dir {}", p.data.display())));
    assert_eq!(
        sys.calls
            .iter()
            .filter(|c| !c.starts_with("confirm"))
            .cloned()
            .collect::<Vec<_>>(),
        [
            "ask_keys",
            "loginctl show-user omarchy --property=Linger --value",
            "loginctl enable-linger omarchy",
            "systemctl --user daemon-reload",
            "systemctl --user enable omarchy-agent.service",
            "systemctl --user restart omarchy-agent.service",
        ]
    );
    // The envelope was confirmed before anything was written.
    assert!(
        sys.calls[0].starts_with("confirm") && sys.calls[0].contains("Write it and enroll"),
        "{:?}",
        sys.calls
    );
    // The agent keys: in the secrets directory, outside the work root, 0600.
    let keys = h.root.join("secrets/agent.env");
    assert!(fs::read_to_string(&keys)
        .unwrap()
        .contains("ANTHROPIC_API_KEY=sk-test"));
    assert_eq!(mode(&keys), 0o600);
    assert!(!keys.starts_with(&cfg.work_root));
    assert!(
        said.contains("host h_0123456789 on")
            && said.contains("isolation user")
            && said.contains("host key SHA256:"),
        "{said}"
    );

    // Re-running repairs and keeps: the identity, the keys, the owner's edits.
    let edited = fs::read_to_string(p.data.join("agent.toml"))
        .unwrap()
        .replace("[envelope]\n", "[envelope]\nmax_units = 2\n");
    fs::write(p.data.join("agent.toml"), edited).unwrap();
    let ready = ready_to_enroll(&h, r#"{"status":"active","token":"held"}"#);
    let mut sys = Fake::default();
    apply(&h.options, &ready, &mut sys, &mut Vec::new())
        .map_err(|e| e.to_string())
        .unwrap();
    assert!(!sys.calls.contains(&"ask_keys".to_owned()));
    let t: toml::Table =
        toml::from_str(&fs::read_to_string(p.data.join("agent.toml")).unwrap()).unwrap();
    assert_eq!(t["envelope"]["max_units"].as_integer(), Some(2));
    assert_eq!(t["host_id"].as_str(), Some("h_0123456789"));
}

#[test]
fn the_dispatcher_env_names_the_host_s_addresses_the_secrets_dir_and_the_budget_beside_the_token() {
    // The probe task saw the pool see it come from 198.51.100.20 (#371).
    let h = host(INFO, &format!("{EGRESS_OK}\negress seen 198.51.100.20"));
    let p = &h.options.places;
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(
        r.screen()
            .contains("egress: tasks leave from 198.51.100.20, which every task's egress refuses"),
        "{}",
        r.screen()
    );
    // Asked of the release's signed pool, at its edge.
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(
        log.contains(
            "public github.com 443 seen https://omarchy-pool.example.org/cdn-cgi/trace 443"
        ),
        "{log}"
    );
    let ready = ready_to_enroll(&h, r#"{"status":"active","token":null}"#);
    assert_eq!(ready.public, Some("198.51.100.20".parse().unwrap()));
    let mut out = Vec::new();
    apply(&h.options, &ready, &mut Fake::default(), &mut out)
        .map_err(|e| e.to_string())
        .unwrap();
    let env = p.set_dir().join("etc/dispatcher.env");
    let text = fs::read_to_string(&env).unwrap();
    let secrets = h.root.join("secrets");
    for want in [
        format!("\nOMARCHY_WORKER_TOKEN=omw_{}\n", "0f".repeat(24)),
        "\nOMARCHY_HOST_ADDRESSES=10.8.0.2,192.168.1.20,198.51.100.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64\n".into(),
        format!("\nOMARCHY_SECRETS_DIR={}\n", secrets.display()),
    ] {
        assert!(text.contains(&want), "{want:?} in:\n{text}");
    }
    // No agent_budget in the envelope: the dispatcher's defaults.
    assert!(!text.contains("OMARCHY_AGENT_"), "{text}");
    assert_eq!(mode(&env), 0o600);
    let said = String::from_utf8_lossy(&out).into_owned();
    assert!(
        said.contains("dispatcher.env (0600): the worker token, OMARCHY_HOST_ADDRESSES=10.8.0.2,"),
        "{said}"
    );
    let seen: crate::dispatcher_env::addresses::Seen =
        serde_json::from_slice(&fs::read(p.data.join("egress.json")).unwrap()).unwrap();
    assert_eq!(seen.public.to_string(), "198.51.100.20");

    // The owner sets a budget; re-running install keeps the token and writes it.
    let edited = fs::read_to_string(p.data.join("agent.toml"))
        .unwrap()
        .replace(
            "[envelope]\n",
            "[envelope]\nagent_budget = { calls_per_task = 50, minutes_per_task = 30 }\n",
        );
    fs::write(p.data.join("agent.toml"), edited).unwrap();
    let ready = ready_to_enroll(&h, r#"{"status":"active","token":"held"}"#);
    apply(&h.options, &ready, &mut Fake::default(), &mut Vec::new())
        .map_err(|e| e.to_string())
        .unwrap();
    let again = fs::read_to_string(&env).unwrap();
    assert_eq!(
        again,
        text.replace(
            &format!("OMARCHY_SECRETS_DIR={}\n", secrets.display()),
            &format!(
                "OMARCHY_SECRETS_DIR={}\nOMARCHY_AGENT_CALLS_PER_TASK=50\nOMARCHY_AGENT_MINUTES_PER_TASK=30\n",
                secrets.display()
            )
        )
    );

    // A budget agent.toml would be refused with is a preflight blocker of the re-run, not a
    // failure after the Confirm and the token.
    let typo = fs::read_to_string(p.data.join("agent.toml"))
        .unwrap()
        .replace("calls_per_task = 50", "calls_per_tusk = 50");
    fs::write(p.data.join("agent.toml"), typo).unwrap();
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(ready.is_none());
    assert!(
        r.screen()
            .contains("envelope.agent_budget.calls_per_tusk is none of calls_per_task"),
        "{}",
        r.screen()
    );

    // A secrets directory the dispatcher would refuse is a preflight blocker.
    let mut h = host(INFO, EGRESS_OK);
    h.options.secrets_dir = Some(h.root.join("my secrets"));
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(ready.is_none());
    assert!(
        r.screen()
            .contains("has a character the dispatcher refuses"),
        "{}",
        r.screen()
    );
}

#[test]
fn a_declined_envelope_writes_nothing_and_a_write_scoped_token_is_refused() {
    let h = host(INFO, EGRESS_OK);
    let p = &h.options.places;
    let ready = ready_to_enroll(&h, r#"{"status":"active","token":null}"#);
    let mut o = h.options.clone();
    o.yes = false;
    let mut sys = Fake {
        confirm: false,
        ..Fake::default()
    };
    let e = apply(&o, &ready, &mut sys, &mut Vec::new()).unwrap_err();
    assert!(e.to_string().contains("not confirmed"), "{e}");
    assert!(!p.set_dir().exists() && !h.root.join("work").exists());

    // The keys typed include a GITHUB_TOKEN with a write scope: refused, not written.
    let mut sys = Fake {
        keys: "ANTHROPIC_API_KEY=sk\nGITHUB_TOKEN=ghp_w\n".into(),
        scopes: Ok(Some("public_repo".into())),
        ..Fake::default()
    };
    let e = apply(&o, &ready, &mut sys, &mut Vec::new()).unwrap_err();
    assert!(
        e.to_string()
            .contains("GITHUB_TOKEN carries the scopes public_repo"),
        "{e}"
    );
    assert!(!h.root.join("secrets/agent.env").exists());
    assert!(!p.unit_dir().join(unit::NAME).exists());

    // Copied from a file, after showing its keys; linger that needs sudo is a person's.
    fs::write(
        h.root.join("old.env"),
        "GEMINI_API_KEY=g\nGITHUB_TOKEN=ghp_r\n",
    )
    .unwrap();
    o.agent_env_from = Some(h.root.join("old.env"));
    let mut sys = Fake {
        enable_linger: false,
        ..Fake::default()
    };
    let done = apply(&o, &ready, &mut sys, &mut Vec::new())
        .map_err(|e| e.to_string())
        .unwrap();
    assert!(
        sys.calls
            .iter()
            .any(|c| c.contains("holds GEMINI_API_KEY, GITHUB_TOKEN")),
        "{:?}",
        sys.calls
    );
    assert_eq!(
        fs::read_to_string(h.root.join("secrets/agent.env"))
            .unwrap()
            .lines()
            .filter(|l| !l.starts_with('#'))
            .count(),
        2
    );
    assert_eq!(done.needs_person.len(), 1);
    assert!(done.needs_person[0].contains("sudo loginctl enable-linger omarchy"));
}

#[test]
fn a_legacy_project_is_recorded_in_legacy_json_and_changed_in_nothing() {
    let h = host(INFO, EGRESS_OK);
    let mut ready = ready_to_enroll(&h, r#"{"status":"active","token":null}"#);
    ready.legacy = Some(legacy::Seen {
        containers: vec!["c0ffee".into(), "beef".into()],
        networks: vec!["omarchy-pool_default".into()],
        dirs: vec![PathBuf::from("/srv/omarchy-pool")],
        ..legacy::Seen::default()
    });
    let mut o = h.options.clone();
    o.legacy = Some("omarchy-pool".into());
    fs::write(h.root.join("docker.log"), "").unwrap();
    apply(&o, &ready, &mut Fake::default(), &mut Vec::new())
        .map_err(|e| e.to_string())
        .unwrap();
    let l: legacy::Legacy =
        serde_json::from_slice(&fs::read(o.places.data.join("legacy.json")).unwrap()).unwrap();
    assert_eq!(l.project, "omarchy-pool");
    assert_eq!(l.containers, ["c0ffee", "beef"]);
    assert!(!l.rootful_exception);
    // Its directory, where retire-legacy (#344) writes the marker; not retired.
    assert_eq!(l.dir.as_deref(), Some(Path::new("/srv/omarchy-pool")));
    assert_eq!((l.retired_at, l.retired_by), (None, None));
    // Two directories, or none, record none: retire-legacy reads it again then.
    for dirs in [vec![], vec!["/a".into(), "/b".into()], vec!["rel".into()]] {
        let s = legacy::Seen {
            dirs,
            ..legacy::Seen::default()
        };
        assert_eq!(s.dir(), None);
    }
    // After preflight, the engine was asked nothing at all.
    assert_eq!(fs::read_to_string(h.root.join("docker.log")).unwrap(), "");
}

#[test]
fn uninstall_removes_the_unit_and_the_bundle_and_keeps_the_identity() {
    let h = host(INFO, EGRESS_OK);
    let ready = ready_to_enroll(&h, r#"{"status":"active","token":null}"#);
    apply(&h.options, &ready, &mut Fake::default(), &mut Vec::new())
        .map_err(|e| e.to_string())
        .unwrap();
    let p = &h.options.places;
    fs::create_dir_all(p.data.join("bundles")).unwrap();
    // The run loop applied a release and was mid-round.
    let v = Release::parse("v1.20.0").unwrap();
    let mut state = crate::run::state::State {
        applied: Some(v),
        floor: Some(v),
        statement_seq: Some(3),
        ..crate::run::state::State::default()
    };
    state.rollout.step = crate::run::state::Step::Pull;
    state.rollout.target = Some(v);
    crate::run::state::save(&p.data.join("state.json"), &state).unwrap();
    // A legacy set retire-legacy retired (#344): said as such, its record kept.
    legacy::record(
        &p.data,
        &legacy::Legacy {
            project: "omarchy-pool".into(),
            recorded_at: "2027-01-14T08:00:00Z".into(),
            containers: Vec::new(),
            networks: Vec::new(),
            rootful_exception: false,
            dir: Some(PathBuf::from("/srv/omarchy-pool")),
            retired_at: Some("2027-02-01T08:00:00Z".into()),
            retired_by: Some(format!("ho_{}", "a".repeat(32))),
        },
    )
    .unwrap();
    let mut sys = Fake::default();
    let mut out = Vec::new();
    let left = uninstall(p, &mut sys, &mut out).unwrap();
    let said = String::from_utf8(out).unwrap();
    assert!(
        said.contains("the legacy project omarchy-pool was retired already (2027-02-01T08:00:00Z); its marker stays in /srv/omarchy-pool"),
        "{said}"
    );
    assert!(!said.contains("was not touched"), "{said}");
    assert!(p.data.join(legacy::FILE).exists());
    assert!(!p.unit_dir().join(unit::NAME).exists());
    assert!(!p.data.join("bundles").exists() && !p.set_dir().exists());
    assert!(p.data.join("state/host.json").exists() && p.data.join("agent.toml").exists());
    // No applied release and no round left, so installing again starts a round; the
    // trust floor stays.
    let after = crate::run::state::load(&p.data.join("state.json"))
        .unwrap()
        .unwrap();
    assert_eq!(after.applied, None);
    assert_eq!(after.rollout, crate::run::state::Rollout::default());
    assert_eq!((after.floor, after.statement_seq), (Some(v), Some(3)));
    assert_eq!(
        sys.calls[1],
        "systemctl --user disable --now omarchy-agent.service"
    );
    // No pinned CLI recorded in state.json: the containers are a person's, named.
    assert!(left[0].contains("org.omarchy-pool.agent.host"), "{left:?}");
}

#[test]
fn uninstall_without_the_user_manager_removes_nothing_and_says_where_to_run_it() {
    let h = host(INFO, EGRESS_OK);
    let ready = ready_to_enroll(&h, r#"{"status":"active","token":null}"#);
    apply(&h.options, &ready, &mut Fake::default(), &mut Vec::new())
        .map_err(|e| e.to_string())
        .unwrap();
    let p = &h.options.places;
    fs::create_dir_all(p.data.join("bundles")).unwrap();
    // `sudo -iu omarchy`: no user bus, the agent still running under linger.
    let mut sys = Fake {
        systemd: false,
        ..Fake::default()
    };
    let e = uninstall(p, &mut sys, &mut Vec::new()).unwrap_err();
    assert!(
        e.contains("needs a person") && e.contains("login session"),
        "{e}"
    );
    assert!(p.unit_dir().join(unit::NAME).exists());
    assert!(p.data.join("bundles").exists() && p.set_dir().exists());
}

#[test]
fn preflight_names_a_missing_enrollment_token_and_a_unit_directory_others_may_write() {
    let mut h = host(INFO, EGRESS_OK);
    h.options.token = None;
    let unit_dir = h.options.places.unit_dir();
    fs::create_dir_all(&unit_dir).unwrap();
    fs::set_permissions(&unit_dir, fs::Permissions::from_mode(0o775)).unwrap();
    let (r, ready) = measure_on(&h, &mut Fake::default());
    assert!(ready.is_none());
    let screen = r.screen();
    assert!(screen.contains("OMARCHY_ENROLL is not set"), "{screen}");
    assert!(
        screen.contains("systemd/user: group- or world-writable"),
        "{screen}"
    );
    assert_eq!(r.blockers.len(), 2, "{screen}");
}

#[test]
fn a_rerun_without_legacy_uses_the_recorded_project_and_its_exception() {
    // The Studio: rootful, no userns-remap, legacy.json recorded by the first install.
    let rootful = INFO.replace(
        r#""SecurityOptions":["name=rootless"]"#,
        r#""SecurityOptions":[]"#,
    );
    let h = host(&rootful, EGRESS_OK);
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(r.screen().contains("needs userns-remap"), "{}", r.screen());
    let record = legacy::Legacy {
        project: "omarchy-pool".into(),
        recorded_at: "2027-01-14T08:00:00Z".into(),
        containers: vec!["c0ffee".into()],
        networks: Vec::new(),
        rootful_exception: true,
        dir: None,
        retired_at: None,
        retired_by: None,
    };
    files::write(
        &h.options.places.data,
        legacy::FILE,
        &serde_json::to_vec(&record).unwrap(),
        0o600,
    )
    .unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    let screen = r.screen();
    assert!(!screen.contains("needs userns-remap"), "{screen}");
    assert!(screen.contains("exception until P6"), "{screen}");
    // The recorded project is looked at again (this stub engine has none of it).
    assert!(screen.contains("omarchy-pool"), "{screen}");
}

#[test]
fn a_rerun_after_retire_legacy_keeps_the_rootful_exception_and_looks_at_nothing_of_the_set() {
    // The Studio after step 6 (#344): the legacy set stopped and removed by retire-legacy,
    // the daemon still rootful without remapping until P6.
    let rootful = INFO.replace(
        r#""SecurityOptions":["name=rootless"]"#,
        r#""SecurityOptions":[]"#,
    );
    let h = host(&rootful, EGRESS_OK);
    // prep-root.sh's INPUT drop, which a rootful host needs (#367).
    prepare(&h.root);
    let record = legacy::Legacy {
        project: "omarchy-pool".into(),
        recorded_at: "2027-01-14T08:00:00Z".into(),
        containers: vec!["c0ffee".into()],
        networks: Vec::new(),
        rootful_exception: true,
        dir: Some(PathBuf::from("/srv/omarchy-pool")),
        retired_at: Some("2027-02-01T08:00:00Z".into()),
        retired_by: Some(format!("ho_{}", "a".repeat(32))),
    };
    files::write(
        &h.options.places.data,
        legacy::FILE,
        &serde_json::to_vec(&record).unwrap(),
        0o600,
    )
    .unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    let screen = r.screen();
    assert!(r.blockers.is_empty(), "{screen}");
    assert!(!screen.contains("needs userns-remap"), "{screen}");
    assert!(screen.contains("exception until P6"), "{screen}");
    assert!(
        screen.contains("legacy: omarchy-pool was retired at 2027-02-01T08:00:00Z (ho_"),
        "{screen}"
    );
    // Nothing of the retired set is looked for (the engine has none of it any more).
    assert!(
        !screen.contains("no container of the compose project"),
        "{screen}"
    );
    assert!(
        !screen.contains("recorded only and left running"),
        "{screen}"
    );

    // A retired record without the exception (a host that never had one) gets none.
    let record = legacy::Legacy {
        rootful_exception: false,
        ..record
    };
    files::write(
        &h.options.places.data,
        legacy::FILE,
        &serde_json::to_vec(&record).unwrap(),
        0o600,
    )
    .unwrap();
    let (r, _) = measure_on(&h, &mut Fake::default());
    assert!(r.screen().contains("needs userns-remap"), "{}", r.screen());
}

// --- a Mac (#320), played on Linux ------------------------------------------------

/// The engine inside the omarchy VM: rootful docker, 8 CPUs and 32 GB (half the Mac).
const INFO_VM: &str = r#"{"NCPU":8,"MemTotal":33443418112,"DockerRootDir":"/var/lib/docker","Architecture":"aarch64","SecurityOptions":["name=seccomp,profile=builtin","name=cgroupns"],"CgroupVersion":"2","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true}"#;

/// A Mac: `os` macos, prep-mac.sh's three directories under `<root>/shared`, Colima's
/// home under `<root>/home/.colima`, and a docker stub for the engine in the VM that
/// refuses a bind of the home directory (`home-visible` lets it), runs an amd64 smoke
/// run (`no-rosetta` fails it), and answers the rest as the Linux stub does.
fn mac_host(min_cpus: u32) -> Host {
    let mut h = host_min(INFO_VM, EGRESS_OK, min_cpus);
    let r = h.root.clone();
    for d in ["work", "secrets", "set"] {
        fs::create_dir_all(r.join("shared").join(d)).unwrap();
        fs::set_permissions(r.join("shared").join(d), fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(r.join("home-path"), r.join("home").display().to_string()).unwrap();
    fs::write(r.join("egress-nat"), EGRESS_NAT).unwrap();
    h.options.places.os = "macos";
    h.options.places.xdg_runtime_dir = None;
    // No /proc on a Mac: its interfaces' addresses are `ifconfig -a`'s (#371).
    h.options.places.proc_net = r.join("no-proc");
    let ifconfig = r.join("ifconfig");
    fs::write(
        &ifconfig,
        format!(
            "#!/bin/sh\ncat '{}'\n",
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/addresses/mac/ifconfig")
                .display()
        ),
    )
    .unwrap();
    fs::set_permissions(&ifconfig, fs::Permissions::from_mode(0o755)).unwrap();
    h.options.places.ifconfig = Some(ifconfig);
    h.options.work_root = None;
    h.options.secrets_dir = None;
    h.options.socket = None;
    h.options.dedicated = false;
    fs::write(
        &h.docker,
        format!(
            "#!/bin/sh\necho \"$*\" >> {r}/docker.log\ncase \" $* \" in\n  *\" info \"*) cat {r}/info ;;\n  *\" version \"*) cat {r}/version ;;\n  *\"source=$(cat {r}/home-path),\"*) [ -e {r}/home-visible ] && exit 0; echo 'bind source path does not exist' >&2; exit 125 ;;\n  *\"source=$(cat {r}/home-path)/\"*) case \" $* \" in *\"source=$(cat {r}/part-visible 2>/dev/null),\"*) exit 0 ;; esac; echo 'path is not shared' >&2; exit 125 ;;\n  *\"--platform linux/amd64\"*) [ -e {r}/no-rosetta ] && exit 1; echo 'Pacman v7.0.0 - libalpm v15.0.0' ;;\n  *\" network ls -q --filter label=org.omarchy-pool.probe=egress \"*) ;;\n  *\" ps -q --filter label=com.omarchy.task \"*) cat {r}/tasks 2>/dev/null || true ;;\n  *\" network create \"*|*\" network rm \"*|*\" ps \"*) ;;\n  *\" network ls \"*|*\" network inspect \"*) ;;\n  *omarchy-egress-probe-*-task*) cat {r}/task-egress ;;\n  *omarchy-egress-probe-*) if [ -e {r}/walled ]; then cat {r}/egress; else cat {r}/egress-nat; fi ;;\n  *\" run \"*) cat {r}/probe ;;\n  *) exit 2 ;;\nesac\n",
            r = r.display()
        ),
    )
    .unwrap();
    h
}

/// The Mac's programs, with Colima saving its profile where this host's places say.
fn mac_sys(h: &Host) -> Fake {
    Fake {
        colima_home: Some(h.options.places.colima_home.clone()),
        walled: Some(h.root.join("walled")),
        docker_at: h.docker.parent().map(Path::to_path_buf),
        ..Fake::default()
    }
}

fn starts(sys: &Fake) -> Vec<&String> {
    sys.calls
        .iter()
        .filter(|c| c.starts_with("colima start"))
        .collect()
}

#[test]
fn on_a_mac_preflight_sizes_the_omarchy_vm_at_half_the_mac_and_mounts_only_its_three_directories() {
    let h = mac_host(4);
    let shared = h.root.join("shared");
    let mut sys = mac_sys(&h);
    let (r, ready) = measure_on(&h, &mut sys);
    assert!(r.ok(), "{}", r.screen());
    let ready = ready.unwrap();
    // A 16-core, 64 GB Mac: 8 CPUs and 32 GB, the three directories at their own paths,
    // no SSH agent, no Docker context switched; Rosetta is not installed here.
    assert_eq!(
        starts(&sys),
        [&format!(
            "colima start --profile omarchy --vm-type vz --arch aarch64 --runtime docker --mount-type virtiofs --ssh-agent=false --ssh-config=false --activate=false --cpu 8 --memory 32 --disk 100 --mount {s}/work:w --mount {s}/secrets --mount {s}/set --vz-rosetta=false",
            s = shared.display()
        )]
    );
    let screen = r.screen();
    for want in [
        "isolation: vm (the dedicated omarchy VM",
        "capacity: 8 CPUs, 31 GB",
        "7 units",
        "Rosetta 2 is not installed",
        "nothing of your home directory",
        "egress: a task reaches public addresses only",
    ] {
        assert!(screen.contains(want), "{want}:\n{screen}");
    }
    // What the agent reads of the VM: its own MemAvailable, through M7.
    assert_eq!(ready.capacity.mem_available_gb(), Some(28));
    assert_eq!(ready.capacity.isolation(), Isolation::Vm);
    let v = &ready.values;
    assert_eq!(v.socket, h.root.join("home/.colima/omarchy/docker.sock"));
    assert_eq!(v.socket_mount, Path::new("/var/run/docker.sock"));
    assert_eq!(
        (
            v.work_root.clone(),
            v.secrets_dir.clone(),
            v.set_dir.clone()
        ),
        (
            shared.join("work"),
            shared.join("secrets"),
            shared.join("set")
        )
    );
    assert!(v.dedicated && v.rootful);
    assert_eq!((v.max_cpus, v.max_mem_gb), (Some(8), Some(32)));
    assert_eq!(v.vm.as_ref().map(|x| x.runtime), Some("colima"));
    // The gateway the egress probe keeps a task from: the Mac's (route -n get default).
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(log.contains("192.168.1.1"), "{log}");
    // The envelope reads back as the run loop and the lint read it: the VM and its mounts.
    let text = envelope::render(None, v, Some(("h_0123456789", "m1-mac-0a9z"))).unwrap();
    let cfg = crate::run::config::Config::parse(&text).unwrap();
    assert_eq!(
        cfg.vm.as_ref().map(|x| (x.cpus, x.mem_gb, x.rosetta)),
        Some((8, 32, false))
    );
    assert_eq!(cfg.envelope.vm_mounts.as_ref().map(Vec::len), Some(3));
    crate::lint::lint_compose(
        crate::run::fake::HOST_COMPOSE,
        None,
        &cfg.envelope,
        cfg.engine,
    )
    .unwrap();

    // Run again with the VM up as it should be: nothing is restarted.
    let mut again = Fake {
        vm_running: true,
        ..mac_sys(&h)
    };
    let (r, _) = measure_on(&h, &mut again);
    assert!(r.ok() && starts(&again).is_empty(), "{:?}", again.calls);
    assert!(r.screen().contains("the omarchy VM runs as it should"));
}

#[test]
fn a_mac_that_cannot_give_the_vm_the_minimum_or_keeps_a_directory_under_home_starts_no_vm() {
    // Half of a 6-core, 16 GB Mac is 3 CPUs: below the release's 4.
    let h = mac_host(4);
    let mut sys = Fake {
        mac: "6\n17179869184\n".into(),
        ..mac_sys(&h)
    };
    let (r, ready) = measure_on(&h, &mut sys);
    assert!(ready.is_none());
    assert!(
        r.screen().contains("the VM would get 3 CPUs and 8 GB"),
        "{}",
        r.screen()
    );
    assert!(
        r.screen()
            .contains("--max-cpus and --max-mem-gb give it more, up to 5 CPUs"),
        "{}",
        r.screen()
    );
    assert!(starts(&sys).is_empty());
    // The owner gives it 4: it joins.
    let mut o = h.options.clone();
    o.max_cpus = Some(4);
    let mut sys = Fake {
        mac: "6\n17179869184\n".into(),
        ..mac_sys(&h)
    };
    let (r, _) = measure(&o, &mut sys, &verifier(), Some(&h.docker))
        .map_err(|e| e.to_string())
        .unwrap();
    assert!(r.ok(), "{}", r.screen());
    assert!(
        starts(&sys)[0].contains("--cpu 4 --memory 8"),
        "{:?}",
        sys.calls
    );

    // A work root under the home directory, a secrets directory that does not exist yet
    // (install would make it): nothing is made or started while anything blocks.
    let mut h = mac_host(1);
    fs::create_dir_all(h.root.join("home/omarchy-work")).unwrap();
    h.options.work_root = Some(h.root.join("home/omarchy-work"));
    h.options.secrets_dir = Some(h.root.join("shared/missing"));
    let mut sys = mac_sys(&h);
    let (r, _) = measure_on(&h, &mut sys);
    let screen = r.screen();
    assert!(screen.contains("is under your home directory"), "{screen}");
    assert!(
        screen.contains(&format!(
            "install makes {} (0700)",
            h.root.join("shared/missing").display()
        )),
        "{screen}"
    );
    assert!(!h.root.join("shared/missing").exists());
    assert!(starts(&sys).is_empty(), "{:?}", sys.calls);
}

#[test]
fn with_only_colima_installed_install_makes_the_three_directories_and_preflight_says_it_would() {
    // Colima installed by hand, no prep-mac.sh: the default directories are missing.
    let h = mac_host(1);
    let shared = h.root.join("shared");
    for d in ["work", "secrets", "set"] {
        fs::remove_dir(shared.join(d)).unwrap();
    }
    // Preflight makes nothing, starts no VM, and says what install will do.
    let mut sys = mac_sys(&h);
    let (r, _) = measure_as(
        &h.options,
        &mut sys,
        &verifier(),
        Some(&h.docker),
        Mode::Preflight,
    )
    .map_err(|e| e.to_string())
    .unwrap();
    assert!(r.ok(), "{}", r.screen());
    assert!(
        r.screen().contains("install makes")
            && r.screen().contains("its directories are made first"),
        "{}",
        r.screen()
    );
    assert!(starts(&sys).is_empty() && !shared.join("work").exists());
    // Install makes them, 0700, then starts the VM that mounts them.
    let mut sys = mac_sys(&h);
    let (r, _) = measure_on(&h, &mut sys);
    assert!(r.ok(), "{}", r.screen());
    for d in ["work", "secrets", "set"] {
        assert_eq!(mode(&shared.join(d)), 0o700, "{d}");
    }
    assert_eq!(starts(&sys).len(), 1);
    // One whose parent this user cannot write is prep-mac.sh's (or another path's); root
    // may write anywhere, so the check has nothing to refuse there.
    if files::euid() != 0 {
        let h = mac_host(1);
        fs::create_dir_all(h.root.join("locked")).unwrap();
        fs::set_permissions(h.root.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();
        let mut o = h.options.clone();
        o.work_root = Some(h.root.join("locked/work"));
        let (r, _) = measure(&o, &mut mac_sys(&h), &verifier(), Some(&h.docker))
            .map_err(|e| e.to_string())
            .unwrap();
        fs::set_permissions(h.root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            r.screen()
                .contains("is not writable by this user: run factory/host/prep-mac.sh"),
            "{}",
            r.screen()
        );
    }
}

#[test]
fn a_mac_root_that_is_a_link_or_another_accounts_is_refused_and_nothing_is_made_or_started() {
    // The pasted command, no prep-mac.sh: another account made `omarchy-pool` in
    // /Users/Shared (`<root>` plays it) as a link, before the person installed.
    let h = mac_host(1);
    let shared = h.root.join("shared");
    fs::rename(&shared, h.root.join("theirs")).unwrap();
    for d in ["work", "secrets", "set"] {
        fs::remove_dir(h.root.join("theirs").join(d)).unwrap();
    }
    std::os::unix::fs::symlink(h.root.join("theirs"), &shared).unwrap();
    let said = format!(
        "{} is a symbolic link: refused (the VM would mount what it points at)",
        shared.display()
    );
    for mode in [Mode::Preflight, Mode::Install] {
        let mut sys = mac_sys(&h);
        let (r, ready) = measure_as(&h.options, &mut sys, &verifier(), Some(&h.docker), mode)
            .map_err(|e| e.to_string())
            .unwrap();
        assert!(ready.is_none() && !r.ok(), "{mode:?}: {}", r.screen());
        assert!(r.screen().contains(&said), "{mode:?}: {}", r.screen());
        assert!(starts(&sys).is_empty(), "{mode:?}: {:?}", sys.calls);
        assert!(tree(&h.root.join("theirs")).is_empty(), "{mode:?}");
    }
    // Another account's own directory: root can play it here (`chown`); refused the same.
    if files::euid() == 0 {
        let h = mac_host(1);
        let shared = h.root.join("shared");
        std::os::unix::fs::chown(&shared, Some(4242), None).unwrap();
        let mut sys = mac_sys(&h);
        let (r, _) = measure_on(&h, &mut sys);
        assert!(
            r.screen().contains(&format!(
                "{} belongs to uid 4242, not this user's 0: use another --root",
                shared.display()
            )),
            "{}",
            r.screen()
        );
        assert!(starts(&sys).is_empty(), "{:?}", sys.calls);
    }
}

#[test]
fn colima_gets_the_pinned_docker_cli_on_its_path_and_its_own_docker_config() {
    let h = mac_host(1);
    let mut sys = mac_sys(&h);
    let (r, _) = measure_on(&h, &mut sys);
    assert!(r.ok(), "{}", r.screen());
    let start = sys
        .calls
        .iter()
        .position(|c| c.starts_with("colima start"))
        .unwrap();
    let env = &sys.colima_env[sys.calls[..start]
        .iter()
        .filter(|c| c.starts_with("colima"))
        .count()];
    let path = &env.iter().find(|(k, _)| *k == "PATH").unwrap().1;
    assert!(
        path.starts_with(&format!("{}:", h.root.display())) && path.contains("/opt/homebrew/bin"),
        "{path}"
    );
    assert!(
        env.contains(&(
            "DOCKER_CONFIG",
            h.options
                .places
                .data
                .join("docker-config")
                .display()
                .to_string()
        )),
        "{env:?}"
    );
    // Without it on the PATH, Colima refuses to start the profile, as on a Mac that has
    // only Colima and Lima from Homebrew.
    let mut sys = mac_sys(&h);
    let mut ask_env = Vec::new();
    let r = {
        let mut r = Report::default();
        let a = mac::Ask {
            given: None,
            mounts: &crate::vm::mounts(
                &h.root.join("shared/work"),
                &h.root.join("shared/secrets"),
                &h.root.join("shared/set"),
            ),
            caps: (None, None),
            rosetta: false,
            min: Some((1, 1)),
            docker_cli: None,
            subnets: &net::parse_list(TASK_SUBNETS).unwrap(),
            mode: Mode::Install,
        };
        let f = mac::engine(&h.options, &mut sys, &a, &mut r);
        ask_env.extend(f.colima_env);
        r
    };
    assert!(
        r.screen().contains("dependency check failed for docker"),
        "{}",
        r.screen()
    );
    assert!(
        ask_env.contains(&("PATH", crate::vm::PATH.to_owned())),
        "{ask_env:?}"
    );
}

#[test]
fn the_task_firewall_goes_into_the_vm_before_the_egress_probe_and_without_it_a_task_reaches_the_lan(
) {
    let h = mac_host(1);
    let mut sys = mac_sys(&h);
    let (r, _) = measure_on(&h, &mut sys);
    assert!(r.ok(), "{}", r.screen());
    assert!(
        r.screen().contains("task firewall is in place"),
        "{}",
        r.screen()
    );
    let wall = sys
        .calls
        .iter()
        .position(|c| c.ends_with("sudo -n sh -c <firewall>"))
        .unwrap();
    let start = sys
        .calls
        .iter()
        .position(|c| c.starts_with("colima start"))
        .unwrap();
    assert!(start < wall, "{:?}", sys.calls);
    // The probe also keeps a task from the Mac as the VM reaches it.
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(
        log.contains(&format!("vm-host {} 22", crate::vm::VM_HOST)),
        "{log}"
    );
    // A VM where the firewall does not apply: Colima's NAT carries a task to the Mac's
    // router and LAN, and the probe says so.
    let _ = fs::remove_file(h.root.join("walled"));
    let mut sys = Fake {
        firewall_fails: true,
        ..mac_sys(&h)
    };
    let (r, ready) = measure_on(&h, &mut sys);
    assert!(ready.is_none());
    let screen = r.screen();
    for want in [
        "the omarchy VM's task firewall did not apply (sudo: a password is required)",
        "egress: a task reaches the default gateway 192.168.1.1 (port 53: open)",
        "egress: a task reaches the Mac as its VM reaches it 192.168.5.2 (port 22: refused)",
        // The bridge's gateway is the VM itself, which only the firewall's INPUT drop closes
        // (#367); nothing of prep-root.sh's is asked of a Mac.
        "reaches its gateway 10.231.255.241 (port 22: open,",
        "that is the omarchy VM itself",
    ] {
        assert!(screen.contains(want), "{want}:\n{screen}");
    }
    assert!(
        !screen.contains("prep-root.sh --user") && !screen.contains("TASKS-HOST) is not installed"),
        "{screen}"
    );
    // The script is prep-root.sh's step 9 for the task subnets.
    let script = crate::vm::firewall(&net::parse_list(TASK_SUBNETS).unwrap());
    assert!(script.contains("iptables -A OMARCHY-TASKS -s 10.231.0.0/16 -d 192.168.0.0/16 -j DROP"));
}

#[test]
fn preflight_never_restarts_a_running_vm_and_install_waits_for_its_tasks() {
    let h = mac_host(1);
    // A running VM of another size than install gives it.
    let cfg = crate::vm::config_path(&h.options.places.colima_home);
    fs::create_dir_all(cfg.parent().unwrap()).unwrap();
    let s = h.root.join("shared");
    fs::write(
        &cfg,
        format!(
            "cpu: 4\nmemory: 8\ndisk: 100\narch: aarch64\nvmType: vz\nrosetta: false\nmounts:\n  - location: {s}/work\n    writable: true\n  - location: {s}/secrets\n    writable: false\n  - location: {s}/set\n    writable: false\n",
            s = s.display()
        ),
    )
    .unwrap();
    let running = || Fake {
        vm_running: true,
        ..mac_sys(&h)
    };
    let mut sys = running();
    let (r, _) = measure_as(
        &h.options,
        &mut sys,
        &verifier(),
        Some(&h.docker),
        Mode::Preflight,
    )
    .map_err(|e| e.to_string())
    .unwrap();
    assert!(r.ok(), "{}", r.screen());
    assert!(
        r.screen().contains("4 CPUs, not 8") && r.screen().contains("install restarts it"),
        "{}",
        r.screen()
    );
    assert!(
        sys.calls
            .iter()
            .all(|c| !c.starts_with("colima stop") && !c.starts_with("colima start")),
        "{:?}",
        sys.calls
    );
    assert!(!h.options.places.data.join(crate::vm::ACTIONS_FILE).exists());
    // Install with a task running in it: refused, the VM left as it runs.
    fs::write(h.root.join("tasks"), "0a1b2c\n").unwrap();
    let mut sys = running();
    let (r, _) = measure_on(&h, &mut sys);
    assert!(
        r.screen()
            .contains("which would end the tasks running in it"),
        "{}",
        r.screen()
    );
    assert!(sys.calls.iter().all(|c| !c.starts_with("colima stop")));
    // None running: the action is counted before the stop, then the start.
    fs::remove_file(h.root.join("tasks")).unwrap();
    let mut sys = running();
    let (r, _) = measure_on(&h, &mut sys);
    assert!(r.ok(), "{}", r.screen());
    let acts: Vec<&String> = sys
        .calls
        .iter()
        .filter(|c| c.starts_with("colima stop") || c.starts_with("colima start"))
        .collect();
    assert!(acts[0].starts_with("colima stop") && acts[1].contains("--cpu 8 --memory 32"));
    let recorded = crate::vm::read_actions(
        &fs::read_to_string(h.options.places.data.join(crate::vm::ACTIONS_FILE)).unwrap(),
    );
    assert_eq!(recorded.len(), 1);
}

#[test]
fn the_owners_choice_of_the_rosetta_lane_carries_over_a_repair() {
    let h = mac_host(1);
    fs::write(h.root.join("rosetta"), "").unwrap();
    let existing = |rosetta: bool| {
        format!(
            "[set]\ndir = \"{s}/set\"\n[vm]\nruntime = \"colima\"\nrosetta = {rosetta}\n",
            s = h.root.join("shared").display()
        )
    };
    fs::create_dir_all(&h.options.places.data).unwrap();
    for (written, flag, want) in [
        (false, None, "--vz-rosetta=false"),
        (true, None, "--vz-rosetta=true"),
        (false, Some(true), "--vz-rosetta=true"),
        (true, Some(false), "--vz-rosetta=false"),
    ] {
        fs::write(h.options.places.data.join("agent.toml"), existing(written)).unwrap();
        let mut o = h.options.clone();
        o.rosetta = flag;
        let mut sys = mac_sys(&h);
        let (r, _) = measure(&o, &mut sys, &verifier(), Some(&h.docker))
            .map_err(|e| e.to_string())
            .unwrap();
        assert!(
            starts(&sys).first().is_some_and(|s| s.ends_with(want)),
            "{written} {flag:?}: {:?}\n{}",
            sys.calls,
            r.screen()
        );
        let _ = fs::remove_file(crate::vm::config_path(&h.options.places.colima_home));
    }
}

#[test]
fn over_ssh_without_a_gui_login_the_installer_says_to_run_it_from_terminal() {
    let mut h = mac_host(1);
    h.options.places.ssh = true;
    let mut sys = Fake {
        gui: false,
        ..mac_sys(&h)
    };
    let before = tree(&h.root.join("shared"));
    let mut out = Vec::new();
    let e = install_with(&h.options, &mut sys, &verifier(), Some(&h.docker), &mut out).unwrap_err();
    assert!(matches!(e, Failure::Refused(_)), "{e}");
    let screen = String::from_utf8_lossy(&out).into_owned();
    assert!(
        screen.contains("no GUI login")
            && screen.contains("this is an SSH session")
            && screen.contains("run the installer from Terminal there"),
        "{screen}"
    );
    // Nothing was started or written: no VM, no plist.
    assert!(starts(&sys).is_empty(), "{:?}", sys.calls);
    assert_eq!(tree(&h.root.join("shared")), before);
    assert!(!h.options.places.launch_agents.exists());
}

#[test]
fn a_saved_profile_that_lets_the_persons_files_in_is_restarted_and_another_vm_type_is_refused() {
    let h = mac_host(1);
    let cfg = crate::vm::config_path(&h.options.places.colima_home);
    fs::create_dir_all(cfg.parent().unwrap()).unwrap();
    fs::write(
        &cfg,
        format!(
            "cpu: 8\nmemory: 32\ndisk: 100\narch: aarch64\nvmType: vz\nforwardAgent: true\nmounts:\n  - location: {}\n    writable: true\n",
            h.root.join("home").display()
        ),
    )
    .unwrap();
    let mut sys = Fake {
        vm_running: true,
        ..mac_sys(&h)
    };
    let (r, _) = measure_on(&h, &mut sys);
    assert!(r.ok(), "{}", r.screen());
    let stop = sys
        .calls
        .iter()
        .position(|c| c == "colima stop --profile omarchy")
        .unwrap();
    let start = sys
        .calls
        .iter()
        .position(|c| c.starts_with("colima start"))
        .unwrap();
    assert!(stop < start);
    let saved = crate::vm::parse_config(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert!(crate::vm::exposures(&saved, &h.root.join("home")).is_empty());

    fs::write(
        &cfg,
        "cpu: 8\nmemory: 32\narch: aarch64\nvmType: qemu\nmounts: []\n",
    )
    .unwrap();
    let mut sys = mac_sys(&h);
    let (r, _) = measure_on(&h, &mut sys);
    assert!(
        r.screen().contains("colima delete -p omarchy"),
        "{}",
        r.screen()
    );
    assert!(starts(&sys).is_empty());
}

#[test]
fn the_home_directory_visible_in_the_vm_is_refused_and_rosetta_gives_an_x86_64_lane() {
    let h = mac_host(1);
    fs::write(h.root.join("home-visible"), "").unwrap();
    let (r, _) = measure_on(&h, &mut mac_sys(&h));
    assert!(
        r.screen()
            .contains("is visible inside the engine's VM: remove the home mount"),
        "{}",
        r.screen()
    );

    // Rosetta 2 installed: the VM runs with --vz-rosetta and the amd64 smoke run turns the
    // lane on, `via: rosetta`.
    let h = mac_host(1);
    fs::write(h.root.join("rosetta"), "").unwrap();
    let mut sys = mac_sys(&h);
    let (r, ready) = measure_on(&h, &mut sys);
    assert!(r.ok(), "{}", r.screen());
    assert!(starts(&sys)[0].ends_with("--vz-rosetta=true"));
    let ready = ready.unwrap();
    let lanes = serde_json::to_value(ready.capacity.file("t").lanes).unwrap();
    assert_eq!(
        lanes,
        serde_json::json!([{"arch": "aarch64", "mode": "native"}, {"arch": "x86_64", "mode": "emulated", "via": "rosetta", "page16k": false}])
    );
    assert!(
        r.screen().contains("the x86_64 lane through rosetta"),
        "{}",
        r.screen()
    );
    // The emulated lane's own smoke run (#338), by digest; no binfmt table is read on a Mac.
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    let x86_image = tests_support::manifest("v1.20.0", "v1.0.0", &[])
        .build_image("x86_64")
        .unwrap()
        .to_string();
    assert!(
        log.contains(&format!(
            "--platform linux/amd64 --entrypoint /usr/bin/true {x86_image}"
        )) && log.contains(&format!(
            "--platform linux/amd64 --entrypoint pacman {x86_image} --version"
        )),
        "{log}"
    );
    assert!(
        r.screen().contains("emulation x86_64: on, through rosetta"),
        "{}",
        r.screen()
    );
    assert!(!r.screen().contains("held"), "{}", r.screen());
    // A smoke run that fails leaves the lane off, with a warning; nothing else blocks.
    let h = mac_host(1);
    fs::write(h.root.join("rosetta"), "").unwrap();
    fs::write(h.root.join("no-rosetta"), "").unwrap();
    let (r, ready) = measure_on(&h, &mut mac_sys(&h));
    assert!(
        r.ok() && r.screen().contains("no x86_64 lane through Rosetta"),
        "{}",
        r.screen()
    );
    assert!(ready.unwrap().capacity.emulated().is_empty());
}

#[test]
fn docker_desktop_is_used_if_present_shows_vm_shared_and_qualifies_only_with_dedicated() {
    let mut h = mac_host(1);
    // A home under /tmp: a socket path fits macOS's 104 bytes there (its TMPDIR is long).
    let home = PathBuf::from(format!("/tmp/oa-dd-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    h.options.places.home.clone_from(&home);
    fs::write(h.root.join("home-path"), home.display().to_string()).unwrap();
    let dd = home.join(".docker/run");
    fs::create_dir_all(&dd).unwrap();
    let _l = std::os::unix::net::UnixListener::bind(dd.join("docker.sock")).unwrap();
    let mut sys = Fake {
        colima: false,
        ..mac_sys(&h)
    };
    let (r, _) = measure_on(&h, &mut sys);
    let screen = r.screen();
    assert!(
        screen.contains("used because it is here, never installed"),
        "{screen}"
    );
    assert!(
        screen.contains("qualifies only with the home mount removed and --dedicated"),
        "{screen}"
    );
    assert!(sys.calls.iter().all(|c| !c.starts_with("colima start")));
    // The agent puts no firewall in a VM it does not own: its NAT carries a task to the
    // LAN, and the egress probe says so as on any host.
    assert!(
        screen.contains("egress: a task reaches the default gateway 192.168.1.1 (port 53: open)")
            && screen.contains("that is Docker Desktop's or OrbStack's VM itself"),
        "{screen}"
    );
    assert!(!sys.calls.iter().any(|c| c.ends_with("<firewall>")));
    // A shared VM whose network drops what a task must not reach (the egress sidecar's
    // job, once it lands) qualifies with --dedicated.
    fs::write(h.root.join("walled"), "").unwrap();
    h.options.dedicated = true;
    let (r, ready) = measure_on(
        &h,
        &mut Fake {
            colima: false,
            ..mac_sys(&h)
        },
    );
    assert!(r.ok(), "{}", r.screen());
    let ready = ready.unwrap();
    assert_eq!(ready.capacity.isolation(), Isolation::VmShared);
    let v = &ready.values;
    assert_eq!(v.socket, dd.join("docker.sock"));
    assert_eq!(v.socket_mount, Path::new("/var/run/docker.sock"));
    assert_eq!(v.vm.as_ref().map(|x| x.runtime), Some("docker-desktop"));
    // Its size is Docker Desktop's: not written into the envelope.
    assert_eq!((v.max_cpus, v.max_mem_gb), (None, None));
    let text = envelope::render(None, v, None).unwrap();
    assert!(
        text.contains("[vm]\nruntime = \"docker-desktop\"\n"),
        "{text}"
    );
    // A subdirectory of the home directory shared with the VM (~/.ssh here), though the
    // home directory itself is not: refused.
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(
        h.root.join("part-visible"),
        home.join(".ssh").display().to_string(),
    )
    .unwrap();
    let (r, _) = measure_on(
        &h,
        &mut Fake {
            colima: false,
            ..mac_sys(&h)
        },
    );
    assert!(
        r.screen().contains(&format!(
            "part of your home directory is visible inside the engine's VM ({})",
            home.join(".ssh").display()
        )),
        "{}",
        r.screen()
    );
    // A socket given that does not answer: what to do on a Mac, not on Linux.
    let mut o = h.options.clone();
    o.socket = Some(home.join(".orbstack/run/docker.sock"));
    let (r, _) = measure(
        &o,
        &mut Fake {
            colima: false,
            ..mac_sys(&h)
        },
        &verifier(),
        Some(&h.docker),
    )
    .map_err(|e| e.to_string())
    .unwrap();
    let screen = r.screen();
    // The same first words as on Linux, which tests/cli.rs looks for on either runner.
    assert!(
        screen.contains(&format!(
            "no container engine answers on {}: start Docker Desktop or OrbStack, or leave out --socket",
            home.join(".orbstack/run/docker.sock").display()
        )),
        "{screen}"
    );
    assert!(
        !screen.contains("prep-root.sh") && !screen.contains("podman"),
        "{screen}"
    );
    let _ = fs::remove_dir_all(&home);
}

/// `etc/dispatcher.env` in the Mac's set directory, which the VM mounts: the token, the
/// Mac's own addresses (`ifconfig`'s and the public one the probe task in the VM saw) and
/// the secrets directory (#371).
fn holds_the_macs_dispatcher_env(h: &Host) {
    let set = h.root.join("shared/set");
    let p = &h.options.places;
    let env = fs::read_to_string(set.join("etc/dispatcher.env")).unwrap();
    for want in [
        format!("\nOMARCHY_WORKER_TOKEN=omw_{}\n", "0f".repeat(24)),
        "\nOMARCHY_HOST_ADDRESSES=100.101.102.103,192.168.1.23,203.0.113.7,2001:db8:1:2::/64,fd7a:115c:a1e0::/64,fe80::/64\n".into(),
        format!("\nOMARCHY_SECRETS_DIR={}\n", h.root.join("shared/secrets").display()),
    ] {
        assert!(env.contains(&want), "{want:?} in:\n{env}");
    }
    assert!(
        !p.data.join("sets").exists(),
        "nothing in the data directory's default set"
    );
}

#[test]
fn on_a_mac_install_writes_the_launchagent_and_bootstraps_it_in_the_gui_domain() {
    let h = mac_host(1);
    let p = &h.options.places;
    // The probe task in the VM saw the pool see it come from the Mac's public address.
    let egress = h.root.join("egress");
    let seen = format!(
        "{}\negress seen 203.0.113.7",
        fs::read_to_string(&egress).unwrap()
    );
    fs::write(&egress, seen).unwrap();
    let ready = ready_to_enroll(&h, r#"{"status":"active","token":null}"#);
    let mut sys = mac_sys(&h);
    let mut out = Vec::new();
    let done = apply(&h.options, &ready, &mut sys, &mut out)
        .map_err(|e| e.to_string())
        .unwrap();
    let said = String::from_utf8_lossy(&out).into_owned();
    assert!(done.needs_person.is_empty(), "{:?}", done.needs_person);
    let plist = p.launch_agents.join(launchd::PLIST);
    let text = fs::read_to_string(&plist).unwrap();
    assert!(text.contains(&format!(
        "<string>{}/current/omarchy-agent</string>",
        p.data.display()
    )));
    assert_eq!(
        sys.calls
            .iter()
            .filter(|c| c.starts_with("launchctl"))
            .cloned()
            .collect::<Vec<_>>(),
        [
            "launchctl print gui/501".to_owned(),
            format!("launchctl print gui/501/{}", launchd::LABEL),
            format!("launchctl bootstrap gui/501 {}", plist.display()),
        ]
    );
    assert!(sys
        .calls
        .iter()
        .all(|c| !c.starts_with("systemctl") && !c.starts_with("loginctl")));
    assert!(p.logs.is_dir());
    assert!(
        said.contains("loaded (gui/501)") && said.contains("isolation vm"),
        "{said}"
    );
    // The token and the capacity report in the set directory the VM mounts, outside ~;
    // beside the token, the Mac's own addresses (ifconfig's and the public one the probe
    // saw) and the secrets directory the VM mounts, for every task's egress (#371).
    let set = h.root.join("shared/set");
    assert!(set.join("etc/dispatcher.env").exists() && set.join("run/capacity.json").exists());
    holds_the_macs_dispatcher_env(&h);
    let cap: serde_json::Value =
        serde_json::from_slice(&fs::read(set.join("run/capacity.json")).unwrap()).unwrap();
    assert_eq!(
        (cap["isolation"].as_str(), cap["units"].as_u64()),
        (Some("vm"), Some(7))
    );
    let cfg = crate::run::config::Config::load(&p.data.join("agent.toml"), files::euid()).unwrap();
    assert_eq!(cfg.set_dir, set);
    assert!(cfg.vm.is_some());

    // A bootstrap that fails although there is a GUI login: the line to run in Terminal.
    let ready = ready_to_enroll(&h, r#"{"status":"active","token":"held"}"#);
    let mut sys = Fake {
        bootstrap_fails: true,
        ..mac_sys(&h)
    };
    let done = apply(&h.options, &ready, &mut sys, &mut Vec::new())
        .map_err(|e| e.to_string())
        .unwrap();
    assert!(
        done.needs_person[0].contains(&format!(
            "in Terminal at the Mac: launchctl bootstrap gui/501 {}",
            plist.display()
        )),
        "{:?}",
        done.needs_person
    );

    // Uninstall: the agent booted out, the plist gone, the VM started for the containers
    // and stopped after, the set directory emptied but kept for the VM's mount.
    let mut sys = Fake {
        loaded: true,
        ..mac_sys(&h)
    };
    let mut out = Vec::new();
    uninstall(p, &mut sys, &mut out).unwrap();
    assert!(!plist.exists());
    assert!(sys
        .calls
        .contains(&format!("launchctl bootout gui/501/{}", launchd::LABEL)));
    assert!(
        sys.calls
            .contains(&"colima stop --profile omarchy".to_owned()),
        "{:?}",
        sys.calls
    );
    assert!(set.is_dir() && fs::read_dir(&set).unwrap().next().is_none());
    // Over SSH with no GUI login, uninstall stops before removing anything.
    let mut sys = Fake {
        gui: false,
        ..mac_sys(&h)
    };
    let e = uninstall(p, &mut sys, &mut Vec::new()).unwrap_err();
    assert!(e.contains("run uninstall from Terminal"), "{e}");
}

#[test]
fn the_launchagent_plist_has_every_key_the_design_names() {
    let text = launchd::render(
        Path::new("/Users/m/.local/share/omarchy-agent"),
        Path::new("/Users/m"),
        Path::new("/Users/m/Library/Logs/omarchy-agent"),
        &[("COLIMA_HOME", "/Users/m/colima & co".into())],
    )
    .unwrap();
    for want in [
        "<key>Label</key>\n  <string>org.omarchy-pool.agent</string>",
        "<string>/Users/m/.local/share/omarchy-agent/current/omarchy-agent</string>\n    <string>run</string>\n    <string>--data-dir</string>\n    <string>/Users/m/.local/share/omarchy-agent</string>",
        "<key>RunAtLoad</key>\n  <true/>",
        "<key>KeepAlive</key>\n  <true/>",
        "<key>ThrottleInterval</key>\n  <integer>10</integer>",
        "<key>ProcessType</key>\n  <string>Background</string>",
        "<key>Umask</key>\n  <integer>63</integer>",
        "<key>PATH</key>\n    <string>/opt/homebrew/bin:",
        "<key>HOME</key>\n    <string>/Users/m</string>",
        "<key>COLIMA_HOME</key>\n    <string>/Users/m/colima &amp; co</string>",
        "<key>StandardErrorPath</key>\n  <string>/Users/m/Library/Logs/omarchy-agent/agent.log</string>",
    ] {
        assert!(text.contains(want), "{want}:\n{text}");
    }
    assert_eq!(0o077, 63);
    assert!(launchd::render(Path::new("/a\nb"), Path::new("/h"), Path::new("/l"), &[]).is_err());
    // A macOS runner checks it with the system's own parser.
    #[cfg(target_os = "macos")]
    {
        let dir = tempdir();
        let f = dir.join("agent.plist");
        fs::write(&f, &text).unwrap();
        let o = std::process::Command::new("plutil")
            .arg("-lint")
            .arg(&f)
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
    }
}

/// The egress probe and a legacy project on a real engine (`tests/agent-install.sh`; it
/// sets `OMARCHY_AGENT_ENGINE_SOCKET` and `OMARCHY_STANDIN_IMAGE`).
mod engine_tests {
    use super::*;

    fn env(name: &str) -> String {
        std::env::var(name)
            .unwrap_or_else(|_| panic!("{name} is not set (tests/agent-install.sh sets it)"))
    }

    fn docker() -> Docker {
        let socket = PathBuf::from(env("OMARCHY_AGENT_ENGINE_SOCKET"));
        // A platform the release pins no tools for (a Mac running a podman machine) names
        // a docker CLI of its own.
        if let Ok(cli) = std::env::var("OMARCHY_AGENT_DOCKER_CLI") {
            return Docker {
                cli: cli.into(),
                socket,
            };
        }
        let dir = std::env::temp_dir().join("omarchy-agent-install-tools");
        let policy: toml::Table =
            toml::from_str(include_str!("../../../../factory/bundle/manifest.toml")).unwrap();
        let platform = tools::platform().unwrap();
        let named = policy["tools"][platform].as_table().unwrap();
        let list: Vec<(String, String, String)> = ["docker", "docker-compose"]
            .iter()
            .map(|n| {
                (
                    n.to_string(),
                    named[*n]["url"].as_str().unwrap().into(),
                    named[*n]["sha256"].as_str().unwrap().into(),
                )
            })
            .collect();
        let refs: Vec<(&str, &str, &str)> = list
            .iter()
            .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
            .collect();
        let m = tests_support::manifest_with_tools(platform, &refs);
        let mut sys = Machine::default();
        let t = tools::ensure(&dir, &m, platform, &mut |u| sys.download(u)).unwrap();
        Docker {
            cli: t.docker,
            socket,
        }
    }

    /// Removes the containers matching its filters and its networks when dropped.
    struct Cleanup(Docker, Vec<String>, Vec<String>);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            for f in &self.1 {
                if let Ok(ids) = self.0.run(&["ps", "-aq", "--filter", f]) {
                    for i in ids.split_whitespace() {
                        let _ = self.0.run(&["rm", "-f", i]);
                    }
                }
            }
            for n in &self.2 {
                let _ = self.0.run(&["network", "rm", n]);
            }
        }
    }

    #[test]
    #[ignore = "needs a real engine: tests/agent-install.sh"]
    #[allow(clippy::too_many_lines)] // one engine, one story: the legacy set, then egress
    fn real_engine_egress_probe_and_legacy_project() {
        let d = docker();
        let image = env("OMARCHY_STANDIN_IMAGE");
        let id = std::process::id();
        let legacy_project = format!("omarchy-legacy-test-{id}");
        let ours = format!("omarchy-host-test-{id}");
        let host_id = format!("h_test{id}");
        let lp = format!("com.docker.compose.project={legacy_project}");
        let net = format!("{legacy_project}_default");
        let target_net = format!("{ours}-target");
        let stale_net = format!("omarchy-egress-probe-stale-{id}");
        // Everything this test made goes, however it ends (labels and names are its own).
        let filters = vec![
            format!("label={lp}"),
            format!("label=org.omarchy-pool.agent.host={host_id}"),
        ];
        drop(Cleanup(
            d.clone(),
            filters.clone(),
            vec![net.clone(), target_net.clone(), stale_net.clone()],
        ));
        let _cleanup = Cleanup(
            d.clone(),
            filters,
            vec![net.clone(), target_net.clone(), stale_net.clone()],
        );

        // The legacy set: two containers on its own network, one bind mount.
        let work = tempdir();
        d.run(&[
            "network",
            "create",
            "--subnet",
            "10.199.7.0/24",
            "--label",
            &lp,
            &net,
        ])
        .unwrap();
        for n in ["a", "b"] {
            d.run(&[
                "run",
                "-d",
                "--name",
                &format!("{legacy_project}-{n}"),
                "--label",
                &lp,
                "--network",
                &net,
                "-v",
                &format!("{}:/w", work.display()),
                &image,
                "sleep",
                "3600",
            ])
            .unwrap();
        }
        // A task of the new host, and one that claims both (it stays: legacy wins).
        let hl = format!("org.omarchy-pool.agent.host={host_id}");
        d.run(&[
            "run",
            "-d",
            "--label",
            &hl,
            "--label",
            &format!("com.docker.compose.project={ours}"),
            &image,
            "sleep",
            "3600",
        ])
        .unwrap();
        d.run(&[
            "run", "-d", "--label", &hl, "--label", &lp, &image, "sleep", "3600",
        ])
        .unwrap();
        let ids = |d: &Docker| {
            let mut v: Vec<String> = d
                .run(&["ps", "-q", "--no-trunc", "--filter", &format!("label={lp}")])
                .unwrap()
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            v.sort();
            v
        };
        let before = ids(&d);
        assert_eq!(before.len(), 3);

        let seen = legacy::look(&d, &legacy_project).unwrap();
        assert_eq!(seen.containers.len(), 3);
        assert!(
            seen.subnets
                .contains(&Cidr::parse("10.199.7.0/24").unwrap()),
            "{seen:?}"
        );
        assert!(legacy::check(
            &legacy_project,
            &seen,
            Path::new("/srv/elsewhere"),
            &net::parse_list(TASK_SUBNETS).unwrap()
        )
        .is_empty());
        assert!(!legacy::check(&legacy_project, &seen, &work, &[]).is_empty());
        assert!(!legacy::check(
            &legacy_project,
            &seen,
            Path::new("/srv/x"),
            &net::parse_list("10.199.0.0/16").unwrap()
        )
        .is_empty());

        // Uninstall's removal: the new host's task goes; the legacy project stays as it was.
        let n = remove_containers(&d, &ours, Some(&host_id), Some(&legacy_project)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(
            ids(&d),
            before,
            "the legacy project's containers are the same, running"
        );
        assert!(d.run(&["network", "inspect", &net]).is_ok());

        // Egress: a target on the probe's own reach answers (refused or open) and fails it;
        // an address nothing answers is blocked; an address that answers counts as public.
        d.run(&[
            "network",
            "create",
            "--subnet",
            "10.198.7.0/24",
            &target_net,
        ])
        .unwrap();
        let tgt = d
            .run(&[
                "run",
                "-d",
                "--label",
                &hl,
                "--network",
                &target_net,
                "--ip",
                "10.198.7.10",
                &image,
                "sh",
                "-c",
                // A stand-in for the pool's /cdn-cgi/trace too: the address it saw (#371).
                "mkdir -p /w/cdn-cgi && printf 'fl=1\nip=203.0.113.9\nts=1\n' > /w/cdn-cgi/trace && httpd -f -p 8080 -h /w",
            ])
            .unwrap();
        let probe_on = |t: &egress::Targets| {
            // The probe gets its own network; joined to the target's by sharing it here.
            let mut args = vec![
                "run".to_owned(),
                "--rm".into(),
                "--network".into(),
                target_net.clone(),
                "--entrypoint".into(),
                "sh".into(),
                image.clone(),
                "-c".into(),
                egress::SCRIPT.into(),
                "sh".into(),
            ];
            args.extend(t.args());
            let out = d
                .run(&args.iter().map(String::as_str).collect::<Vec<_>>())
                .unwrap();
            (
                egress::verdict(&out, t, &advice(true, false)),
                egress::seen(&out),
            )
        };
        let only = |what, host: &str, port, seen: Option<&str>| egress::Targets {
            network: egress::Network::Bridge,
            forbidden: vec![egress::Target::new(what, host, port)],
            public: Some(("10.198.7.10".into(), 8080)),
            seen: seen.map(str::to_owned),
        };
        let (b, _) = probe_on(&only(egress::What::Lan, "10.198.7.10", 8080, None));
        assert!(b.len() == 1 && b[0].contains("LAN address"), "{b:?}");
        // A closed port on it answers too: refused, not blocked.
        let (b, _) = probe_on(&only(egress::What::Lan, "10.198.7.10", 8081, None));
        assert!(b.len() == 1 && b[0].contains("port 8081: refused"), "{b:?}");
        let (b, seen) = probe_on(&only(
            egress::What::Metadata,
            "192.0.2.1",
            80,
            Some("http://10.198.7.10:8080/cdn-cgi/trace"),
        ));
        assert!(b.is_empty(), "{b:?}");
        // The address the stand-in pool says it saw, through busybox's wget (the build
        // image has curl).
        assert_eq!(seen, Some("203.0.113.9".parse().unwrap()));
        // And the probe itself, on its own network: it is created and removed again, and
        // a network an interrupted probe left on its /28 is no reason to refuse.
        d.run(&[
            "network",
            "create",
            "--subnet",
            "10.197.7.240/28",
            "--label",
            "org.omarchy-pool.probe=egress",
            &stale_net,
        ])
        .unwrap();
        let t = egress::Targets {
            public: Some(("192.0.2.2".into(), 80)),
            ..only(egress::What::Metadata, "192.0.2.1", 80, None)
        };
        let out = egress::probe(&d, &image, Cidr::parse("10.197.7.240/28").unwrap(), &t).unwrap();
        assert!(out.contains("egress metadata blocked"), "{out}");
        assert!(d
            .run(&[
                "network",
                "ls",
                "-q",
                "--filter",
                "label=org.omarchy-pool.probe=egress"
            ])
            .unwrap()
            .trim()
            .is_empty());
        let _ = d.run(&["rm", "-f", tgt.trim()]);
    }

    /// A task's network's gateway and the host's loopback (#367, #372), on this engine: a
    /// signed exception's bridge reaches its gateway — the host itself on a rootful engine
    /// without an INPUT drop for the task subnets, the engine's namespace on a rootless one —
    /// and behind the drop (`OMARCHY_TEST_INPUT_DROP`, the /28 tests/agent-install.sh gave it,
    /// on a rootful engine only) it does not; a task's own network, made as the dispatcher
    /// makes it (on podman through libpod's API: internal, DNS off, no gateway), has no
    /// gateway a task reaches, on Docker and podman alike; a rootless engine's network stack,
    /// read while both probe tasks run, maps nothing to the host's loopback (the engines'
    /// defaults); and on rootless podman behind pasta, a service of the host's on every
    /// address answers through pasta's guest-mapped address exactly when pasta's command line
    /// maps it, which preflight refuses with containers.conf's setting.
    #[test]
    #[ignore = "needs a real engine: tests/agent-install.sh"]
    #[allow(clippy::too_many_lines)] // one engine, one story: each network a task may run on
    fn real_engine_a_tasks_gateway_and_the_hosts_loopback() {
        let d = docker();
        let image = env("OMARCHY_STANDIN_IMAGE");
        let server = d.server().unwrap();
        let rootless = d
            .run(&["info", "--format", "{{json .SecurityOptions}}"])
            .unwrap()
            .contains("name=rootless");
        let a = advice(!rootless, server == engine::Server::Podman);
        let gateway_only = |subnet: Cidr| egress::Targets {
            forbidden: egress::Targets::of_host(None, None, subnet)
                .forbidden
                .into_iter()
                .filter(|x| x.what == egress::What::Gateway)
                .collect(),
            public: None,
            ..egress::Targets::of_host(None, None, subnet)
        };
        let me = rustix::process::getuid().as_raw();
        let mut stacks = Vec::new();
        let open = Cidr::parse("10.197.8.240/28").unwrap();
        let bridge = gateway_only(open);
        let (out, seen) = loopback::watching(Path::new("/proc"), me, || {
            egress::probe(&d, &image, open, &bridge).unwrap()
        });
        stacks.extend(seen);
        let b = egress::verdict(&out, &bridge, &a);
        println!("{server:?}, rootless {rootless}: a signed exception's bridge:\n{out}");
        assert!(
            b.len() == 1 && b[0].contains("reaches its gateway 10.197.8.241"),
            "{out}\n{b:?}"
        );
        assert!(
            b[0].contains(if rootless {
                "rootless engine's own namespace"
            } else {
                "OMARCHY-TASKS-HOST"
            }),
            "{b:?}"
        );

        let task = egress::Targets::of_task(open, engine::task_network(server).unwrap());
        let (out, seen) = loopback::watching(Path::new("/proc"), me, || {
            egress::probe(&d, &image, open, &task).unwrap()
        });
        stacks.extend(seen);
        let b = egress::verdict(&out, &task, &a);
        println!("a task's own network:\n{out}");
        assert!(
            b.is_empty(),
            "{server:?}, rootless {rootless}: {out}\n{b:?}"
        );
        if server == engine::Server::Podman {
            // As libpod keeps it: internal, DNS off, no gateway in its subnet.
            let l = libpod::Libpod::on(&d.socket).unwrap();
            let net = format!("omarchy-libpod-test-{}", std::process::id());
            let _gone = Cleanup(d.clone(), Vec::new(), vec![net.clone()]);
            l.create_network(&net, open, &[("org.omarchy-pool.probe", "egress")])
                .unwrap();
            let path = format!("/v{}/libpod/networks/{net}/json", l.version);
            let got = libpod::request(
                &d.socket,
                "GET",
                &path,
                None,
                std::time::Instant::now() + Duration::from_secs(60),
            )
            .unwrap();
            let n: serde_json::Value = serde_json::from_slice(&got.body).unwrap();
            println!("podman {}: {n}", l.version);
            assert!(
                n["internal"] == true
                    && n["dns_enabled"] == false
                    && n["subnets"][0]["gateway"].is_null(),
                "{n}"
            );
        }

        // pasta's guest-mapped address (#372): a service of the host on every address, and a
        // probe task on a bridge tries it there, while pasta runs.
        let pasta = (server == engine::Server::Podman && rootless)
            .then(|| {
                libpod::Libpod::on(&d.socket)
                    .and_then(|l| l.info())
                    .unwrap()
            })
            .is_some_and(|i| i.pasta());
        if pasta {
            let host_service = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
            let port = host_service.local_addr().unwrap().port();
            let guest = egress::Targets {
                network: egress::Network::Bridge,
                forbidden: vec![egress::Target::new(
                    egress::What::Guest,
                    egress::PASTA_GUEST,
                    port,
                )],
                public: None,
                seen: None,
            };
            let (out, seen) = loopback::watching(Path::new("/proc"), me, || {
                egress::probe(&d, &image, open, &guest).unwrap()
            });
            let mapped = seen
                .iter()
                .filter_map(loopback::Stack::guest_addr)
                .collect::<Vec<_>>();
            let b = egress::verdict(&out, &guest, &a);
            println!("pasta's guest-mapped address ({mapped:?} on its command line):\n{out}");
            if mapped.contains(&"169.254.1.2") {
                assert!(
                    b.len() == 1
                        && b[0].contains("reaches pasta's guest-mapped address 169.254.1.2")
                        && b[0].contains(r#""--map-guest-addr", "none""#),
                    "{out}\n{b:?}"
                );
            } else {
                assert!(b.is_empty(), "{out}\n{b:?}");
            }
            stacks.extend(seen);
        } else {
            println!(
                "note: not rootless podman behind pasta: its guest-mapped address is not tried"
            );
        }

        // A rootless engine's network stack, as preflight reads it: seen while the probe tasks
        // ran (rootless podman's runs only then), and keeping the host's loopback out.
        if rootless {
            println!("its network stack: {stacks:?}");
            let note = loopback::verdict(&stacks, &a.loopback());
            assert!(note.is_ok(), "{note:?}");
        }

        // Behind an INPUT drop for the task subnets (what prep-root.sh's OMARCHY-TASKS-HOST
        // holds), nothing of the host answers: a rootful engine's only, since a rootless one's
        // bridges live in its own namespace, which the host's INPUT never sees.
        if let Some(dropped) = std::env::var("OMARCHY_TEST_INPUT_DROP")
            .ok()
            .and_then(|s| Cidr::parse(&s))
            .filter(|_| !rootless)
        {
            for t in [
                gateway_only(dropped),
                egress::Targets::of_task(dropped, engine::task_network(server).unwrap()),
            ] {
                let out = egress::probe(&d, &image, dropped, &t).unwrap();
                println!("behind the drop:\n{out}");
                assert!(egress::verdict(&out, &t, &a).is_empty(), "{out}");
            }
        } else {
            println!("note: no INPUT drop for a test subnet here (rootless, or no sudo): not tried behind one");
        }
    }
}
