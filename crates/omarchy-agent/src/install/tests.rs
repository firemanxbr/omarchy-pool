//! Install, preflight and uninstall (#317): each check on its own, then preflight and the
//! steps after it on a host played by a stub docker CLI, a fake pool on loopback and a
//! fake terminal and systemd. `engine_tests` below runs the egress probe and the legacy
//! set against a real engine (`tests/agent-install.sh`).

#![allow(clippy::many_single_char_names, clippy::struct_excessive_bools)]

use std::cell::RefCell;
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
fn emulation_linger_and_the_user_manager_are_reported() {
    let d = tempdir();
    fs::write(
        d.join("qemu-x86_64"),
        "enabled\ninterpreter /usr/bin/qemu-x86_64\nflags: POCF\n",
    )
    .unwrap();
    let mut r = Report::default();
    checks::emulation("aarch64", Some(16), &d, &mut r);
    checks::emulation("x86_64", Some(4), &d, &mut r);
    assert!(
        r.notes[0].contains("x86_64: binfmt handler on (F flag), 16K pages"),
        "{:?}",
        r.notes
    );
    assert!(
        r.notes[1].contains("aarch64: no binfmt handler"),
        "{:?}",
        r.notes
    );
    assert!(r.ok());

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

#[test]
fn the_egress_probe_passes_only_when_public_addresses_alone_are_reachable() {
    let t = egress::Targets::of_host(
        Some("192.168.1.1".parse().unwrap()),
        Some("192.168.1.20".parse().unwrap()),
    );
    let ok =
        "egress metadata blocked\negress gateway blocked\negress lan blocked\negress public open\n";
    assert!(egress::verdict(ok, &t).is_empty());
    for (out, why) in [
        (
            ok.replace("metadata blocked", "metadata open"),
            "169.254.169.254",
        ),
        (
            ok.replace("gateway blocked", "gateway refused"),
            "default gateway",
        ),
        (ok.replace("lan blocked", "lan open"), "LAN address"),
        (
            ok.replace("public open", "public blocked"),
            "cannot reach the public",
        ),
        (ok.replace("egress lan blocked\n", ""), "no answer"),
    ] {
        let b = egress::verdict(&out, &t);
        assert_eq!(b.len(), 1, "{out}: {b:?}");
        assert!(b[0].contains(why), "{b:?}");
    }
    // Without a gateway or LAN address, the metadata address and the public one remain.
    let t = egress::Targets::of_host(None, None);
    assert!(egress::verdict("egress metadata blocked\negress public open\n", &t).is_empty());
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
    crate::capacity::AgentToml::parse(&with).unwrap();
    // The owner narrowed it by hand; a re-run keeps that and refreshes the ids.
    let edited = with.replace("[envelope]\n", "[envelope]\nmax_units = 3\nemulate = []\n");
    let again =
        envelope::render(Some(&edited), &v, Some(("h_0123456789", "m1-rack-1b2c"))).unwrap();
    let t: toml::Table = toml::from_str(&again).unwrap();
    assert_eq!(t["envelope"]["max_units"].as_integer(), Some(3));
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
        vm: None,
    }
}

/// A host for preflight: its places under `root`, a release signed for the test verifier
/// whose agent is `root/agent`, a socket that answers, and a docker CLI stand-in.
struct Host {
    root: PathBuf,
    options: Options,
    docker: PathBuf,
    _socket: std::os::unix::net::UnixListener,
}

const INFO: &str = r#"{"NCPU":12,"MemTotal":33443418112,"DockerRootDir":"/nonexistent/storage","Architecture":"aarch64","SecurityOptions":["name=rootless"],"CgroupVersion":"2","MemoryLimit":true,"CpuCfsQuota":true,"PidsLimit":true}"#;
const PROBE: &str = "cpu.max=50000 100000\nmemory.max=67108864\npids.max=32\npagesize=4096\noverlay 482344960 1 230686720 1% /";
const EGRESS_OK: &str =
    "egress metadata blocked\negress gateway blocked\negress lan blocked\negress vm-host blocked\negress public open";
/// What a probe task reaches through Colima's NAT in a VM without the task firewall.
const EGRESS_NAT: &str =
    "egress metadata blocked\negress gateway open\negress lan refused\negress vm-host refused\negress public open";

fn host(info: &str, egress: &str) -> Host {
    host_min(info, egress, 1)
}

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
    for (name, body) in [("info", info), ("probe", PROBE), ("egress", egress)] {
        fs::write(root.join(name), body).unwrap();
    }
    let docker = root.join("docker");
    fs::write(
        &docker,
        format!(
            "#!/bin/sh\necho \"$*\" >> {r}/docker.log\ncase \" $* \" in\n  *\" info \"*) cat {r}/info ;;\n  *\" network ls -q --filter label=org.omarchy-pool.probe=egress \"*) cat {r}/stale 2>/dev/null || true ;;\n  *\" network create \"*|*\" network rm \"*|*\" ps \"*) ;;\n  *\" network ls \"*|*\" network inspect \"*) ;;\n  *omarchy-egress-probe-*) cat {r}/egress ;;\n  *\" run \"*) cat {r}/probe ;;\n  *) exit 2 ;;\nesac\n",
            r = root.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o755)).unwrap();
    let socket = std::os::unix::net::UnixListener::bind(root.join("engine.sock")).unwrap();
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
        _socket: socket,
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
    // Swept before and after: every labelled probe container and network.
    let sweep = "network ls -q --filter label=org.omarchy-pool.probe=egress";
    assert_eq!(log.matches(sweep).count(), 2, "{log}");
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
    let mut sys = Fake::default();
    let mut out = Vec::new();
    let left = uninstall(p, &mut sys, &mut out).unwrap();
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
    h.options.work_root = None;
    h.options.secrets_dir = None;
    h.options.socket = None;
    h.options.dedicated = false;
    fs::write(
        &h.docker,
        format!(
            "#!/bin/sh\necho \"$*\" >> {r}/docker.log\ncase \" $* \" in\n  *\" info \"*) cat {r}/info ;;\n  *\"source=$(cat {r}/home-path),\"*) [ -e {r}/home-visible ] && exit 0; echo 'bind source path does not exist' >&2; exit 125 ;;\n  *\"source=$(cat {r}/home-path)/\"*) case \" $* \" in *\"source=$(cat {r}/part-visible 2>/dev/null),\"*) exit 0 ;; esac; echo 'path is not shared' >&2; exit 125 ;;\n  *\"--platform linux/amd64\"*) [ -e {r}/no-rosetta ] && exit 1; exit 0 ;;\n  *\" network ls -q --filter label=org.omarchy-pool.probe=egress \"*) ;;\n  *\" ps -q --filter label=com.omarchy.task \"*) cat {r}/tasks 2>/dev/null || true ;;\n  *\" network create \"*|*\" network rm \"*|*\" ps \"*) ;;\n  *\" network ls \"*|*\" network inspect \"*) ;;\n  *omarchy-egress-probe-*) if [ -e {r}/walled ]; then cat {r}/egress; else cat {r}/egress-nat; fi ;;\n  *\" run \"*) cat {r}/probe ;;\n  *) exit 2 ;;\nesac\n",
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
    ] {
        assert!(screen.contains(want), "{want}:\n{screen}");
    }
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
        serde_json::json!([{"arch": "aarch64", "mode": "native"}, {"arch": "x86_64", "mode": "emulated", "via": "rosetta"}])
    );
    assert!(
        r.screen().contains("the x86_64 lane through rosetta"),
        "{}",
        r.screen()
    );
    let log = fs::read_to_string(h.root.join("docker.log")).unwrap();
    assert!(log.contains("--platform linux/amd64"), "{log}");
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
        screen.contains("egress: a task reaches the default gateway 192.168.1.1 (port 53: open)"),
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

#[test]
fn on_a_mac_install_writes_the_launchagent_and_bootstraps_it_in_the_gui_domain() {
    let h = mac_host(1);
    let p = &h.options.places;
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
    // The token and the capacity report in the set directory the VM mounts, outside ~.
    let set = h.root.join("shared/set");
    assert!(set.join("etc/dispatcher.env").exists() && set.join("run/capacity.json").exists());
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
                "mkdir -p /w && httpd -f -p 8080 -h /w",
            ])
            .unwrap();
        let probe_on = |t: &egress::Targets| {
            // The probe gets its own network; joined to the target's by sharing it here.
            let out = d
                .run(&[
                    "run",
                    "--rm",
                    "--network",
                    &target_net,
                    "--entrypoint",
                    "sh",
                    &image,
                    "-c",
                    egress::SCRIPT,
                    "sh",
                    t.forbidden[0].0,
                    &t.forbidden[0].1,
                    &t.forbidden[0].2.to_string(),
                    "public",
                    &t.public.0,
                    &t.public.1.to_string(),
                ])
                .unwrap();
            egress::verdict(&out, t)
        };
        let reach_lan = egress::Targets {
            forbidden: vec![("lan", "10.198.7.10".into(), 8080)],
            public: ("10.198.7.10".into(), 8080),
        };
        let b = probe_on(&reach_lan);
        assert!(b.len() == 1 && b[0].contains("LAN address"), "{b:?}");
        // A closed port on it answers too: refused, not blocked.
        let closed = egress::Targets {
            forbidden: vec![("lan", "10.198.7.10".into(), 8081)],
            public: ("10.198.7.10".into(), 8080),
        };
        let b = probe_on(&closed);
        assert!(b.len() == 1 && b[0].contains("port 8081: refused"), "{b:?}");
        let only_public = egress::Targets {
            forbidden: vec![("metadata", "192.0.2.1".into(), 80)],
            public: ("10.198.7.10".into(), 8080),
        };
        let b = probe_on(&only_public);
        assert!(b.is_empty(), "{b:?}");
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
            forbidden: vec![("metadata", "192.0.2.1".into(), 80)],
            public: ("192.0.2.2".into(), 80),
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
}
