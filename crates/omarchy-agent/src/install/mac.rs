//! Install and preflight on a Mac (#320; design v2 §13.2, §13.3, §19.2, §19.3): the GUI
//! login a `LaunchAgent` needs, the `omarchy` Colima profile sized from the Mac and the
//! envelope and started with only its three mounts, or Docker Desktop's or `OrbStack`'s VM
//! when one is here (never installed: their licence terms), and what the VM may see.
//!
//! Everything goes through [`Sys`] (`launchctl`, `sysctl`, `colima`, `route`) and the
//! pinned docker CLI, so the tests play a Mac on Linux.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use crate::capacity::VmKind;
use crate::vm::{self, Drift, Mount, Want};

use super::engine::{self, Docker};
use super::{files, launchd, Options, Report, Sys};

/// The three directories the VM mounts, as preflight names them.
pub(crate) const NAMES: [&str; 3] = ["work root", "secrets directory", "set directory"];

/// What preflight found on a Mac, for the engine's measurement and the envelope.
#[derive(Debug, Clone, Default)]
pub(crate) struct Found {
    /// The engine's socket on the Mac (`socket_cli`).
    pub socket: Option<PathBuf>,
    pub kind: Option<VmKind>,
    /// The `omarchy` profile as the agent started it.
    pub want: Option<Want>,
    /// The default gateway, for the egress probe (`route -n get default`).
    pub gateway: Option<Ipv4Addr>,
}

/// Docker Desktop's and `OrbStack`'s sockets, used if present (never installed).
pub(crate) fn shared_sockets(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".docker/run/docker.sock"),
        home.join(".orbstack/run/docker.sock"),
    ]
}

/// The runtime a socket on a Mac belongs to, as `[vm] runtime` records it.
pub(crate) fn runtime_of(socket: &Path, colima_home: &Path) -> &'static str {
    if socket == vm::socket_cli(colima_home) {
        "colima"
    } else if socket.components().any(|c| c.as_os_str() == ".orbstack") {
        "orbstack"
    } else {
        "docker-desktop"
    }
}

/// `route -n get default`'s `gateway:` line.
pub(crate) fn parse_gateway(out: &str) -> Option<Ipv4Addr> {
    out.lines()
        .find_map(|l| l.trim().strip_prefix("gateway:"))
        .and_then(|g| g.trim().parse().ok())
}

/// The recorded M7 actions, with `now` added (install starts the profile because a
/// person asked: it is counted, never held back).
fn count_action(data: &Path, now: i64) {
    let before = std::fs::read_to_string(data.join(vm::ACTIONS_FILE))
        .map(|t| vm::read_actions(&t))
        .unwrap_or_default();
    let body = vm::render_actions(&vm::record(&before, now));
    if let Err(e) = files::write(data, vm::ACTIONS_FILE, body.as_bytes(), 0o600) {
        eprintln!("omarchy-agent: {e}");
    }
}

/// The profile running as `want` says: started, or stopped and started again with the
/// agent's flags when what it saved differs; a profile of another VM type or
/// architecture is the person's to delete.
pub(crate) fn ensure_profile(o: &Options, sys: &mut dyn Sys, want: &Want, r: &mut Report) -> bool {
    let p = &o.places;
    let cfg_path = vm::config_path(&p.colima_home);
    let saved = std::fs::read_to_string(&cfg_path)
        .ok()
        .map(|t| vm::parse_config(&t));
    let running = sys
        .run("colima", &["status", "--profile", vm::PROFILE])
        .is_ok();
    let drift = match &saved {
        Some(Ok(c)) => vm::drift(c, want, &p.home),
        Some(Err(e)) => Drift::Restart(vec![e.clone()]),
        None => Drift::Restart(vec!["not created yet".into()]),
    };
    match drift {
        Drift::Recreate(e) => {
            r.blockers.push(e);
            return false;
        }
        Drift::Same if running => {
            r.notes.push(format!(
                "the {} VM runs as it should: {} CPUs, {} GB",
                vm::PROFILE,
                want.size.cpus,
                want.size.mem_gb
            ));
        }
        Drift::Same | Drift::Restart(_) => {
            if let Drift::Restart(why) = &drift {
                if running {
                    eprintln!(
                        "omarchy-agent: restarting the {} VM ({}); its containers start again",
                        vm::PROFILE,
                        why.join(", ")
                    );
                    if let Err(e) = sys.run("colima", &["stop", "--profile", vm::PROFILE]) {
                        r.blockers
                            .push(format!("colima stop --profile {}: {e}", vm::PROFILE));
                        return false;
                    }
                }
            }
            eprintln!(
                "omarchy-agent: starting the {} VM: {} CPUs, {} GB, a {} GB disk{} (a first start downloads its image)",
                vm::PROFILE,
                want.size.cpus,
                want.size.mem_gb,
                want.disk_gb,
                if want.rosetta { ", Rosetta on" } else { "" }
            );
            count_action(&p.data, crate::run::now());
            let args = vm::start_args(want);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            if let Err(e) = sys.run("colima", &args) {
                r.blockers
                    .push(format!("colima start --profile {}: {e}", vm::PROFILE));
                return false;
            }
            r.notes.push(format!(
                "the {} VM started: {} CPUs, {} GB, mounts {}",
                vm::PROFILE,
                want.size.cpus,
                want.size.mem_gb,
                want.mounts
                    .iter()
                    .map(|m| format!(
                        "{} ({})",
                        m.path.display(),
                        if m.writable { "rw" } else { "ro" }
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    // What it saved, read back: nothing of the person's may be in it.
    match std::fs::read_to_string(&cfg_path).map(|t| vm::parse_config(&t)) {
        Ok(Ok(c)) => {
            let exposed = vm::exposures(&c, &p.home);
            for e in &exposed {
                r.blockers.push(format!("the {} VM: {e}", vm::PROFILE));
            }
            exposed.is_empty()
        }
        Ok(Err(e)) => {
            r.blockers.push(e);
            false
        }
        Err(e) => {
            r.blockers.push(format!("{}: {e}", cfg_path.display()));
            false
        }
    }
}

/// Preflight's Mac half before the engine is measured: the GUI login, the three mounts,
/// the engine (the `omarchy` profile, sized and started, or a shared VM already here),
/// the gateway. `min` is the release's signed minimum (CPUs, GB), when it verified.
#[allow(clippy::too_many_arguments)] // preflight's state, passed through once
pub(crate) fn engine(
    o: &Options,
    sys: &mut dyn Sys,
    given: Option<&Path>,
    mounts: &[Mount],
    caps: (Option<u32>, Option<u32>),
    rosetta: bool,
    min: Option<(u32, u32)>,
    r: &mut Report,
) -> Found {
    let p = &o.places;
    let mut found = Found {
        gateway: sys
            .run("route", &["-n", "get", "default"])
            .ok()
            .and_then(|out| parse_gateway(&out)),
        ..Found::default()
    };
    if let Err(e) = launchd::gui(sys, p.uid, p.ssh) {
        r.blockers.push(e);
    }
    r.blockers.extend(vm::check_paths(&p.home, mounts, &NAMES));
    for (m, what) in mounts.iter().zip(NAMES) {
        if !m.path.is_dir() {
            r.blockers.push(format!(
                "the {what} {} does not exist: run factory/host/prep-mac.sh, which makes {}/{{work,secrets,set}}",
                m.path.display(),
                vm::MAC_ROOT
            ));
        }
    }
    let colima_socket = vm::socket_cli(&p.colima_home);
    let colima = given.map_or_else(
        || sys.run("colima", &["version"]).is_ok(),
        |g| g == colima_socket,
    );
    if !colima {
        // Docker Desktop or OrbStack, when one answers here (or is the one given).
        let list = given.map_or_else(|| shared_sockets(&p.home), |g| vec![g.to_owned()]);
        match engine::discover(None, &list, engine::connect) {
            Ok(s) => {
                r.notes.push(format!(
                    "the engine: {} ({}), used because it is here, never installed (its licence terms: the runbook's Installing a Mac); the omarchy Colima VM is the default (factory/host/prep-mac.sh)",
                    s.display(),
                    runtime_of(&s, &p.colima_home)
                ));
                found.socket = Some(s);
                found.kind = Some(VmKind::Shared);
            }
            // The socket given (--socket, agent.toml's) is named; none found here is
            // prep-mac.sh's to fix.
            Err(e) if given.is_some() => r.blockers.push(e),
            Err(_) => r.blockers.push(
                "no engine: install Colima and Lima with factory/host/prep-mac.sh (Homebrew, no sudo); the agent runs them in its own omarchy VM".into(),
            ),
        }
        return found;
    }
    found.kind = Some(VmKind::Dedicated);
    let mac = sys
        .run("sysctl", &["-n", "hw.ncpu", "hw.memsize"])
        .and_then(|out| vm::parse_sysctl(&out));
    let size = match (mac, min) {
        (Ok(mac), Some(min)) => match vm::size(mac, caps.0, caps.1, min) {
            Ok(s) => Some(s),
            Err(e) => {
                r.blockers.push(e);
                None
            }
        },
        (Err(e), _) => {
            r.blockers.push(format!("this Mac's CPUs and memory: {e}"));
            None
        }
        (Ok(_), None) => None,
    };
    let rosetta = rosetta && p.rosetta.exists();
    if !p.rosetta.exists() {
        r.notes.push(
            "Rosetta 2 is not installed: no x86_64 lane (softwareupdate --install-rosetta --agree-to-license, then install again)".into(),
        );
    }
    let Some(size) = size else {
        return found;
    };
    let want = Want {
        size,
        disk_gb: vm::DISK_GB,
        mounts: mounts.to_vec(),
        rosetta,
    };
    // Nothing is started while anything else blocks: the screen lists it all first.
    if r.ok() && ensure_profile(o, sys, &want, r) {
        found.socket = Some(colima_socket);
    } else if r.ok() {
        // ensure_profile said why.
    } else {
        r.notes
            .push(format!("the {} VM was not started", vm::PROFILE));
    }
    found.want = Some(want);
    found
}

/// Whether `path` is visible inside the engine's VM at the same path: a container
/// started with it bind-mounted (`--mount`, which never makes a missing source) runs.
fn visible(d: &Docker, image: &str, path: &Path) -> Result<(), String> {
    let mount = format!(
        "type=bind,source={},target=/omarchy-probe,readonly",
        path.display()
    );
    d.run(&[
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        &mount,
        "--entrypoint",
        "true",
        image,
    ])
    .map(drop)
}

/// After the engine answered: the VM sees the three directories at their own paths, and
/// not the home directory (design v2 §19.2: a container escape lands in the VM, not in
/// the maintainer's account; a shared VM qualifies only with the home mount removed).
pub(crate) fn sees(d: &Docker, image: &str, home: &Path, mounts: &[Mount], r: &mut Report) {
    let mut probed = false;
    for (m, what) in mounts.iter().zip(NAMES) {
        match visible(d, image, &m.path) {
            Ok(()) => probed = true,
            Err(e) => r.blockers.push(format!(
                "the {what} {} is not visible inside the engine's VM at the same path ({e})",
                m.path.display()
            )),
        }
    }
    // A run that works on a mount and fails on the home directory: it is not mounted.
    if !probed {
        return;
    }
    if home.to_string_lossy().contains([',', '"']) {
        r.warnings.push(format!(
            "{}: not probed (a ',' or '\"' in the path)",
            home.display()
        ));
    } else if visible(d, image, home).is_ok() {
        r.blockers.push(format!(
            "your home directory {} is visible inside the engine's VM: remove the home mount (Docker Desktop: Settings, Resources, File sharing; the omarchy Colima VM never has one)",
            home.display()
        ));
    } else {
        r.notes
            .push("the VM sees the work root, the secrets and the set directories, and nothing of your home directory".into());
    }
}

/// `MemAvailable` from inside the `omarchy` VM (M7), where this process has no
/// `/proc/meminfo` of its own.
pub(crate) fn meminfo(sys: &mut dyn Sys) -> Option<String> {
    sys.run(
        "colima",
        &[
            "ssh",
            "--profile",
            vm::PROFILE,
            "--",
            "cat",
            "/proc/meminfo",
        ],
    )
    .ok()
}
