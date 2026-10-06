//! The Mac's VM (#320), on Linux: its size from the Mac and the envelope, its mounts and
//! the paths they may hold, the `colima start` argv, the saved profile read back, the clock
//! after a wake and M7's rate limit.

use std::path::{Path, PathBuf};

use super::*;
use crate::run::state::tempdir;

const MIN: (u32, u32) = (4, 8);

fn mac(cpus: u32, mem_gb: u32) -> Mac {
    Mac { cpus, mem_gb }
}

#[test]
fn sysctl_gives_the_macs_cpus_and_memory() {
    assert_eq!(parse_sysctl("16\n68719476736\n").unwrap(), mac(16, 64));
    for bad in ["", "16", "0\n1", "x\n1", "16\n0"] {
        assert!(parse_sysctl(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn the_vm_gets_half_the_mac_by_default_and_never_below_the_minimum() {
    // The issue's example: a 16-core, 64 GB Mac gives 8 CPUs and 32 GB.
    assert_eq!(
        size(mac(16, 64), None, None, MIN).unwrap(),
        Size {
            cpus: 8,
            mem_gb: 32
        }
    );
    // An 8-core, 16 GB Mac gives exactly the minimum.
    assert_eq!(
        size(mac(8, 16), None, None, MIN).unwrap(),
        Size { cpus: 4, mem_gb: 8 }
    );
    // The envelope's caps decide, within what the Mac keeps for itself.
    assert_eq!(
        size(mac(16, 64), Some(12), Some(48), MIN).unwrap(),
        Size {
            cpus: 12,
            mem_gb: 48
        }
    );
    assert_eq!(
        size(mac(16, 64), Some(64), Some(64), MIN).unwrap(),
        Size {
            cpus: 15,
            mem_gb: 62
        }
    );
    // Half of a 6-core, 16 GB Mac is below the minimum: refused, with a way in.
    let e = size(mac(6, 16), None, None, MIN).unwrap_err();
    assert!(e.contains("below the minimum to join"), "{e}");
    assert!(e.contains("3 CPUs and 8 GB"), "{e}");
    assert!(e.contains("up to 5 CPUs and 14 GB"), "{e}");
    assert_eq!(
        size(mac(6, 16), Some(4), None, MIN).unwrap(),
        Size { cpus: 4, mem_gb: 8 }
    );
    // A Mac that cannot give the minimum at all does not join, whatever the caps say.
    let e = size(mac(4, 8), Some(4), Some(8), MIN).unwrap_err();
    assert!(e.contains("does not join") && !e.contains("up to"), "{e}");
    // A cap below the minimum: the owner's choice, and the host does not join.
    assert!(size(mac(16, 64), Some(2), None, MIN).is_err());
}

fn m(path: &str, writable: bool) -> Mount {
    Mount {
        path: PathBuf::from(path),
        writable,
    }
}

#[test]
fn the_mounts_hold_nothing_of_the_home_directory_and_never_overlap() {
    let ms = mounts(
        Path::new("/Users/Shared/omarchy-pool/work"),
        Path::new("/Users/Shared/omarchy-pool/secrets"),
        Path::new("/Users/Shared/omarchy-pool/set"),
    );
    assert_eq!(
        ms,
        vec![
            m("/Users/Shared/omarchy-pool/work", true),
            m("/Users/Shared/omarchy-pool/secrets", false),
            m("/Users/Shared/omarchy-pool/set", false),
        ]
    );
    let names = ["work root", "secrets directory", "set directory"];
    let home = Path::new("/Users/maintainer");
    assert!(check_paths(home, &ms, &names).is_empty());

    // Under the home directory, in any case; holding it; overlapping; Colima's syntax.
    for (paths, want) in [
        (
            ["/Users/maintainer/work", "/s", "/t"],
            "work root /Users/maintainer/work is under your home",
        ),
        (["/users/MAINTAINER/w", "/s", "/t"], "under your home"),
        (["/Users", "/s", "/t"], "holds your home directory"),
        (["/", "/s", "/t"], "holds your home directory"),
        (["/w", "/w/secrets", "/t"], "overlap"),
        (["/w", "/s", "/s"], "overlap"),
        (["/w:x", "/s", "/t"], "':' or ','"),
        (["/w,x", "/s", "/t"], "':' or ','"),
        (["w", "/s", "/t"], "not a plain absolute path"),
        (["/w/../x", "/s", "/t"], "not a plain absolute path"),
    ] {
        let ms = mounts(
            Path::new(paths[0]),
            Path::new(paths[1]),
            Path::new(paths[2]),
        );
        let found = check_paths(home, &ms, &names).join("\n");
        assert!(found.contains(want), "{paths:?}: {found}");
    }

    // A directory outside the home directory that links into it is the home directory.
    let root = tempdir();
    let home = root.join("home/me");
    std::fs::create_dir_all(home.join("projects")).unwrap();
    std::os::unix::fs::symlink(home.join("projects"), root.join("work")).unwrap();
    let ms = mounts(&root.join("work"), &root.join("s"), &root.join("t"));
    let found = check_paths(&home, &ms, &names).join("\n");
    assert!(found.contains("under your home"), "{found}");
}

#[test]
fn every_directory_of_a_mount_below_users_shared_is_this_users_and_no_link() {
    use std::os::unix::fs::MetadataExt as _;
    // `<tmp>` plays /Users/Shared: prep-mac.sh's root and its three directories in it.
    let shared = tempdir();
    let root = shared.join("omarchy-pool");
    for d in ["work", "secrets", "set"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    let ms = mounts(&root.join("work"), &root.join("secrets"), &root.join("set"));
    let uid = std::fs::metadata(&root).unwrap().uid();
    assert_eq!(shared_dir(Path::new(MAC_ROOT)), Path::new("/Users/Shared"));
    assert!(check_owned(&shared, &ms, uid).is_empty());
    // Not there yet: install makes them, this user's.
    let fresh = mounts(
        &shared.join("new/work"),
        &shared.join("new/s"),
        &shared.join("new/t"),
    );
    assert!(check_owned(&shared, &fresh, uid).is_empty());
    // Another account's root, said once for the three mounts it holds.
    let found = check_owned(&shared, &ms, uid + 1);
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(
        found[0].starts_with(&format!(
            "{} belongs to uid {uid}, not this user's {}: use another --root",
            root.display(),
            uid + 1
        )),
        "{found:?}"
    );
    // The work root put back as a link (to anywhere): refused, never followed.
    std::fs::rename(root.join("work"), root.join("was-work")).unwrap();
    std::os::unix::fs::symlink(root.join("was-work"), root.join("work")).unwrap();
    let found = check_owned(&shared, &ms, uid).join("\n");
    assert_eq!(
        found,
        format!(
            "{} is a symbolic link: refused (the VM would mount what it points at)",
            root.join("work").display()
        )
    );
    // So is the root itself, once for all three; and a mount elsewhere is not looked at.
    std::fs::rename(&root, shared.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(shared.join("elsewhere"), &root).unwrap();
    assert_eq!(check_owned(&shared, &ms, uid).len(), 1);
    assert!(check_owned(&shared.join("other"), &ms, uid + 1).is_empty());
}

fn want() -> Want {
    Want {
        size: Size {
            cpus: 8,
            mem_gb: 32,
        },
        disk_gb: DISK_GB,
        mounts: mounts(
            Path::new("/Users/Shared/omarchy-pool/work"),
            Path::new("/Users/Shared/omarchy-pool/secrets"),
            Path::new("/Users/Shared/omarchy-pool/set"),
        ),
        rosetta: true,
    }
}

#[test]
fn colima_starts_the_profile_with_every_setting_given() {
    let a = start_args(&want()).join(" ");
    assert_eq!(
        a,
        "start --profile omarchy --vm-type vz --arch aarch64 --runtime docker --mount-type virtiofs \
         --ssh-agent=false --ssh-config=false --activate=false --cpu 8 --memory 32 --disk 100 \
         --mount /Users/Shared/omarchy-pool/work:w --mount /Users/Shared/omarchy-pool/secrets \
         --mount /Users/Shared/omarchy-pool/set --vz-rosetta=true"
    );
    let mut w = want();
    w.rosetta = false;
    assert!(start_args(&w).join(" ").ends_with("--vz-rosetta=false"));
}

/// `colima.yaml` as Colima writes it for the profile the agent wants.
const SAVED: &str = "\
# Number of CPUs to be allocated to the virtual machine.
cpu: 8
disk: 100
memory: 32
arch: aarch64
runtime: docker
hostname: colima-omarchy
autoActivate: false
network:
  address: false
  dns: []
forwardAgent: false
vmType: vz
rosetta: true
mountType: virtiofs
mountInotify: true
mounts:
  - location: /Users/Shared/omarchy-pool/work
    writable: true
  - location: /Users/Shared/omarchy-pool/secrets
    writable: false
  - location: /Users/Shared/omarchy-pool/set
    writable: false
env: {}
";

#[test]
fn the_saved_profile_is_read_back_and_compared_with_what_the_agent_wants() {
    let home = Path::new("/Users/maintainer");
    let c = parse_config(SAVED).unwrap();
    assert_eq!((c.cpus, c.mem_gb, c.disk_gb), (8, 32.0, 100));
    assert!(c.rosetta && !c.forward_agent && c.mounts.len() == 3);
    assert!(exposures(&c, home).is_empty());
    assert_eq!(drift(&c, &want(), home), Drift::Same);

    // A size, Rosetta or a mount changed: a restart with the agent's flags.
    let mut w = want();
    w.size = Size {
        cpus: 6,
        mem_gb: 24,
    };
    w.rosetta = false;
    let Drift::Restart(why) = drift(&c, &w, home) else {
        panic!()
    };
    assert_eq!(why, ["8 CPUs, not 6", "32 GB, not 24", "Rosetta on"]);
    let other = SAVED.replace(
        "secrets\n    writable: false",
        "secrets\n    writable: true",
    );
    assert!(
        matches!(drift(&parse_config(&other).unwrap(), &want(), home), Drift::Restart(w) if w == ["other mounts"])
    );

    // What lets the person's files or keys into the VM: the home mount, Colima's default
    // when nothing is mounted, a mount point elsewhere, a forwarded SSH agent.
    for (from, to, said) in [
        (
            "  - location: /Users/Shared/omarchy-pool/set\n",
            "  - location: '~'\n",
            "mounts ~",
        ),
        (
            "  - location: /Users/Shared/omarchy-pool/set\n",
            "  - location: /Users/maintainer/src\n",
            "in or around your home",
        ),
        (
            "  - location: /Users/Shared/omarchy-pool/set\n",
            "  - location: /Users\n",
            "in or around your home",
        ),
        (
            "    writable: true\n",
            "    mountPoint: /mnt/work\n    writable: true\n",
            "elsewhere than its own path",
        ),
        ("forwardAgent: false", "forwardAgent: true", "SSH agent"),
    ] {
        let c = parse_config(&SAVED.replacen(from, to, 1)).unwrap();
        let e = exposures(&c, home).join("\n");
        assert!(e.contains(said), "{said}: {e}");
        assert!(matches!(drift(&c, &want(), home), Drift::Restart(_)));
    }
    let bare = SAVED.split("mounts:").next().unwrap();
    let e = exposures(&parse_config(bare).unwrap(), home).join("\n");
    assert!(e.contains("Colima mounts your home directory"), "{e}");

    // Another VM type or architecture: only the person can delete the profile.
    for (from, to) in [
        ("vmType: vz", "vmType: qemu"),
        ("arch: aarch64", "arch: x86_64"),
    ] {
        let c = parse_config(&SAVED.replace(from, to)).unwrap();
        assert!(
            matches!(drift(&c, &want(), home), Drift::Recreate(e) if e.contains("colima delete -p omarchy"))
        );
    }
    // A shrunken disk is never asked for: Colima only grows one.
    let c = parse_config(&SAVED.replace("disk: 100", "disk: 200")).unwrap();
    assert_eq!(drift(&c, &want(), home), Drift::Same);
    assert!(parse_config("mounts: x\n").is_err());
    assert!(parse_config("mounts:\n  - writable: true\n").is_err());
}

#[test]
fn the_vm_is_held_within_five_seconds_of_the_pool_and_a_wrong_mac_is_said_and_held_to() {
    let now = 1_800_000_000;
    let fine = Clock {
        resync: None,
        mac_off: None,
    };
    let resync = |to, skew| Some(Resync { to, skew });
    // The pool and the Mac agree; the VM slept behind.
    assert_eq!(clock(now, now, Some((now, now))), fine);
    assert_eq!(clock(now - 4, now, Some((now + 1, now))), fine);
    assert_eq!(
        clock(now - 1800, now, Some((now, now))).resync,
        resync(now, -1800)
    );
    // Without a Date the Mac's clock stands for the pool's.
    assert_eq!(clock(now + 6, now, None).resync, resync(now, 6));
    // The VM 5 s behind the Mac and the Mac 5 s behind the pool: 10 s off the pool, set
    // to the pool's time (the Mac's own offset is within its allowance).
    assert_eq!(
        clock(now - 5, now, Some((now + 5, now))),
        Clock {
            resync: resync(now + 5, -10),
            mac_off: None
        }
    );
    // The Mac itself is off the pool's clock: said, never set; the VM on the Mac's time
    // is left there, as the pool's answer moves it no further from the Mac's own.
    assert_eq!(
        clock(now, now, Some((now + 30, now))),
        Clock {
            resync: None,
            mac_off: Some(30)
        }
    );
    // The Mac off, and the VM drifted on top of that during a sleep: the drift goes (the
    // VM is set to the Mac's time) and the Mac is said as well.
    let c = clock(now - 600, now, Some((now - 40, now)));
    assert_eq!(c.resync, resync(now, -600));
    assert_eq!(c.mac_off, Some(-40));
    // A pool whose Date is years off moves the VM nowhere.
    let c = clock(now, now, Some((now - 3 * 365 * 86_400, now)));
    assert!(c.vm_fine() && c.mac_off.is_some(), "{c:?}");
    // One second of the Date header's resolution is allowed for the Mac.
    assert_eq!(clock(now + 6, now, Some((now + 6, now))), fine);
    assert_eq!(clock(now, now, Some((now + 6, now))).mac_off, None);
}

#[test]
fn an_http_date_reads_as_unix_seconds() {
    assert_eq!(
        parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
        Some(784_111_777)
    );
    assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
    assert_eq!(
        parse_http_date("Sat, 03 Oct 2026 11:28:00 GMT"),
        Some(1_791_026_880)
    );
    assert_eq!(
        parse_http_date("Tue, 29 Feb 2028 23:59:59 GMT"),
        Some(1_835_481_599)
    );
    for bad in [
        "",
        "Sunday, 06-Nov-94 08:49:37 GMT",
        "Sun Nov  6 08:49:37 1994",
        "Sun, 06 Nov 1994 08:49:37 UTC",
        "Sun, 06 Foo 1994 08:49:37 GMT",
        "Sun, 06 Nov 1994 25:49:37 GMT",
        "Sun, 06 Nov 1994 08:49 GMT",
    ] {
        assert_eq!(parse_http_date(bad), None, "{bad:?}");
    }
}

#[test]
fn the_vm_is_started_stopped_or_sized_at_most_once_per_cooldown_and_six_times_a_day() {
    let t = 1_800_000_000;
    assert_eq!(allowed(&[], t), Ok(()));
    assert_eq!(allowed(&[t - 60], t), Err(COOLDOWN_S - 60));
    assert_eq!(allowed(&[t - COOLDOWN_S], t), Ok(()));
    let mut a = Vec::new();
    let mut at = t;
    for _ in 0..PER_DAY {
        assert_eq!(allowed(&a, at), Ok(()));
        a = record(&a, at);
        at += COOLDOWN_S;
    }
    // The seventh in a day waits until the first is a day old.
    assert_eq!(allowed(&a, at), Err(t + 86_400 - at));
    assert_eq!(allowed(&a, t + 86_400), Ok(()));
    // What is older than a day is dropped from the record, which reads back as written.
    assert_eq!(record(&a, t + 86_400 + 1).len(), PER_DAY);
    assert_eq!(read_actions(&render_actions(&a)), a);
    assert!(read_actions("not json").is_empty());
}

#[test]
fn colima_lives_under_colima_home_or_the_home_directory() {
    let home = Path::new("/Users/m");
    assert_eq!(
        socket_cli(&colima_home(home, None)),
        Path::new("/Users/m/.colima/omarchy/docker.sock")
    );
    assert_eq!(
        config_path(&colima_home(home, Some(std::ffi::OsStr::new("/opt/c")))),
        Path::new("/opt/c/omarchy/colima.yaml")
    );
    assert_eq!(
        colima_home(home, Some(std::ffi::OsStr::new(""))),
        home.join(".colima")
    );
}

#[test]
fn colima_runs_with_the_pinned_docker_cli_first_and_the_agents_own_docker_config() {
    let env = colima_env(
        Some(Path::new(
            "/Users/m/.local/share/omarchy-agent/tools/0a/docker",
        )),
        Path::new("/Users/m/.local/share/omarchy-agent/docker-config"),
    );
    assert_eq!(
        env,
        [
            (
                "PATH",
                format!("/Users/m/.local/share/omarchy-agent/tools/0a:{PATH}")
            ),
            (
                "DOCKER_CONFIG",
                "/Users/m/.local/share/omarchy-agent/docker-config".to_owned()
            ),
        ]
    );
    // Before the tools are known: launchd's PATH, Colima's own check says what is missing.
    assert_eq!(
        colima_env(None, Path::new("/d"))[0],
        ("PATH", PATH.to_owned())
    );
}

#[test]
fn the_task_firewall_is_prep_roots_step_nine_with_dns_to_the_vms_resolvers() {
    let subnets = crate::install::net::parse_list("10.231.0.0/16,10.232.0.0/16").unwrap();
    let s = firewall_rules(&subnets);
    assert!(s.starts_with("set -e\n"));
    for t in ["10.231.0.0/16", "10.232.0.0/16"] {
        assert!(s.contains(&format!(
            "iptables -A OMARCHY-TASKS -s {t} -d {t} -j RETURN"
        )));
        for d in FORBIDDEN {
            assert!(
                s.contains(&format!("iptables -A OMARCHY-TASKS -s {t} -d {d} -j DROP")),
                "{t} {d}\n{s}"
            );
        }
        assert!(s.contains(&format!("iptables -A OMARCHY-TASKS-HOST -s {t} -j DROP")));
        // DNS to the VM's resolvers comes before the drops.
        let dns = s
            .find(&format!(
                "iptables -A OMARCHY-TASKS -s {t} -d \"$d\" -p \"$p\" --dport 53 -j RETURN"
            ))
            .unwrap();
        let drop = s
            .find(&format!(
                "iptables -A OMARCHY-TASKS -s {t} -d 10.0.0.0/8 -j DROP"
            ))
            .unwrap();
        assert!(dns < drop);
    }
    // Rebuilt whole each time, hooked in once: running it again changes nothing.
    assert!(s.contains("iptables -F OMARCHY-TASKS\n"));
    assert!(s.contains(
        "iptables -C DOCKER-USER -j OMARCHY-TASKS 2>/dev/null || iptables -I DOCKER-USER -j OMARCHY-TASKS"
    ));
    assert!(s.contains(
        "iptables -C INPUT -j OMARCHY-TASKS-HOST 2>/dev/null || iptables -I INPUT -j OMARCHY-TASKS-HOST"
    ));
    // The VM's own address range is among the forbidden: the Mac as the VM reaches it.
    let vm_host = crate::install::net::Cidr::parse(&format!("{VM_HOST}/32")).unwrap();
    assert!(crate::install::net::Cidr::parse("192.168.0.0/16")
        .unwrap()
        .overlaps(vm_host));
    assert_eq!(as_root(&s)[..4], ["sudo", "-n", "sh", "-c"]);
}

#[test]
fn the_task_firewall_is_kept_in_the_vm_and_applied_at_its_every_boot_after_docker() {
    use std::os::unix::fs::PermissionsExt as _;
    // The script as the VM runs it, its absolute paths moved under a scratch root, with
    // iptables and systemctl played.
    let root = tempdir();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let r = root.display();
    for (tool, body) in [
        ("iptables", format!("echo \"$*\" >> '{r}/iptables.log'")),
        (
            "systemctl",
            format!(
                "echo \"$*\" >> '{r}/systemctl.log'\ncase \"$1\" in is-enabled) [ -e '{r}/enabled' ] ;; enable) touch '{r}/enabled' ;; esac"
            ),
        ),
    ] {
        // Started by the script's shell: written where no fork of this process can hold it.
        crate::run::exec::write_stub(&bin.join(tool), &format!("#!/bin/sh\n{body}\n"));
    }
    let subnets = crate::install::net::parse_list("10.231.0.0/16").unwrap();
    let script = firewall(&subnets)
        .replace("/usr/local/libexec", &format!("{r}/usr/local/libexec"))
        .replace("/etc/systemd/system", &format!("{r}/etc/systemd/system"))
        .replace("/run/systemd/system", &format!("{r}/run/systemd/system"));
    let run = || {
        let o = std::process::Command::new("sh")
            .args(["-c", &script])
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    bin.display(),
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    };
    let read = |rel: &str| std::fs::read_to_string(root.join(rel)).unwrap_or_default();
    let rules = root.join(FIREWALL_RULES.trim_start_matches('/'));
    let unit = root.join(FIREWALL_UNIT.trim_start_matches('/'));

    // Without systemd: the rules are kept and applied, no unit.
    run();
    assert_eq!(
        std::fs::metadata(&rules).unwrap().permissions().mode() & 0o777,
        0o755
    );
    let kept = std::fs::read_to_string(&rules).unwrap();
    assert!(kept.starts_with("#!/bin/sh\n"), "{kept}");
    assert!(kept.ends_with(&firewall_rules(&subnets)), "{kept}");
    assert!(read("iptables.log").contains("-A OMARCHY-TASKS-HOST -s 10.231.0.0/16 -j DROP"));
    assert!(!unit.exists() && read("systemctl.log").is_empty());

    // Under systemd: the unit, after docker, enabled for every boot.
    std::fs::create_dir_all(root.join("run/systemd/system")).unwrap();
    std::fs::create_dir_all(unit.parent().unwrap()).unwrap();
    run();
    let u = std::fs::read_to_string(&unit).unwrap();
    for want in [
        "After=docker.service",
        "Wants=docker.service",
        "Type=oneshot",
        &format!("ExecStart={}", rules.display()),
        "WantedBy=multi-user.target",
    ] {
        assert!(u.contains(want), "{want}:\n{u}");
    }
    let calls = read("systemctl.log");
    assert!(
        calls.contains("daemon-reload")
            && calls.contains("enable --quiet omarchy-task-firewall.service"),
        "{calls}"
    );
    // Again (after the next start, hourly): the rules again, systemd left alone.
    std::fs::write(root.join("systemctl.log"), "").unwrap();
    std::fs::write(root.join("iptables.log"), "").unwrap();
    run();
    assert_eq!(
        read("systemctl.log").trim(),
        "is-enabled --quiet omarchy-task-firewall.service"
    );
    assert!(read("iptables.log").contains("-F OMARCHY-TASKS-HOST"));
    assert!(!Path::new(&format!("{}.new", unit.display())).exists());
}
