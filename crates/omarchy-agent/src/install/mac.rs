//! Install and preflight on a Mac (#320; design v2 §13.2, §13.3, §19.2, §19.3): the GUI
//! login a `LaunchAgent` needs, the `omarchy` Colima profile sized from the Mac and the
//! envelope and started with only its three mounts, or Docker Desktop's or `OrbStack`'s VM
//! when one is here (never installed: their licence terms), and what the VM may see.
//!
//! Everything goes through [`Sys`] (`launchctl`, `sysctl`, `colima`, `route`) and the
//! pinned docker CLI, so the tests play a Mac on Linux. Colima gets the pinned CLI first on
//! its `PATH` ([`vm::colima_env`]): it wants a `docker` client on the Mac before it starts
//! a profile, and Homebrew installs only Colima and Lima.
//!
//! Preflight starts a stopped profile, to measure it, and changes nothing else; install
//! also makes the three directories when they are missing and restarts a profile that
//! differs — only while no task runs in it, unless it lets the person's files in. Either
//! puts the task firewall in the VM ([`vm::firewall`]) before the egress probe runs.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use crate::capacity::VmKind;
use crate::vm::{self, Drift, Mount, Want};

use super::engine::{self, Docker};
use super::net::Cidr;
use super::{files, launchd, Mode, Options, Report, Sys};

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
    /// What every `colima` call gets ([`vm::colima_env`]).
    pub colima_env: Vec<(&'static str, String)>,
    /// Preflight did not start the VM because install makes its directories first: the
    /// engine is measured then.
    pub deferred: bool,
}

/// What preflight asks of the Mac's engine.
pub(crate) struct Ask<'a> {
    /// The socket given (`--socket`, agent.toml's `socket_cli`).
    pub given: Option<&'a Path>,
    pub mounts: &'a [Mount],
    /// The envelope's `max_cpus` and `max_mem_gb`.
    pub caps: (Option<u32>, Option<u32>),
    pub rosetta: bool,
    /// The release's signed minimum (CPUs, GB), when it verified.
    pub min: Option<(u32, u32)>,
    /// The release's pinned docker CLI, which Colima needs on the Mac.
    pub docker_cli: Option<&'a Path>,
    /// The task subnets, which the VM's task firewall fences in.
    pub subnets: &'a [Cidr],
    pub mode: Mode,
}

/// `colima <args>` with `env` ([`vm::colima_env`]).
fn colima(
    sys: &mut dyn Sys,
    env: &[(&'static str, String)],
    args: &[&str],
) -> Result<String, String> {
    sys.run_env("colima", args, env)
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

/// Whether a task container runs in the profile (`com.omarchy.task`, which every task
/// container and sidecar carries); `None` when the engine does not say.
fn tasks_running(cli: Option<&Path>, socket: &Path) -> Option<bool> {
    let d = Docker {
        cli: cli?.to_owned(),
        socket: socket.to_owned(),
    };
    let filter = format!("label={}", crate::run::driver::TASK_LABEL);
    d.run(&["ps", "-q", "--filter", &filter])
        .ok()
        .map(|out| !out.trim().is_empty())
}

/// The profile running as `want` says: started, or (install) stopped and started again
/// with the agent's flags when what it saved differs; a profile of another VM type or
/// architecture is the person's to delete. Preflight only starts a stopped profile, and
/// says what install would restart. `true` when the engine in it may be measured.
#[allow(clippy::too_many_lines)] // each case of the saved profile, in order
pub(crate) fn ensure_profile(
    o: &Options,
    sys: &mut dyn Sys,
    ask: &Ask<'_>,
    env: &[(&'static str, String)],
    want: &Want,
    r: &mut Report,
) -> bool {
    let p = &o.places;
    let cfg_path = vm::config_path(&p.colima_home);
    let saved = std::fs::read_to_string(&cfg_path)
        .ok()
        .map(|t| vm::parse_config(&t));
    let running = colima(sys, env, &["status", "--profile", vm::PROFILE]).is_ok();
    let drift = match &saved {
        Some(Ok(c)) => vm::drift(c, want, &p.home),
        Some(Err(e)) => Drift::Restart(vec![e.clone()]),
        None => Drift::Restart(vec!["not created yet".into()]),
    };
    let exposed = matches!(&saved, Some(Ok(c)) if !vm::exposures(c, &p.home).is_empty());
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
        // Preflight leaves a running profile as it is: install restarts it.
        Drift::Restart(why) if running && ask.mode == Mode::Preflight => {
            let why = why.join(", ");
            if exposed {
                r.blockers.push(format!(
                    "the {} VM runs as it should not ({why}): install restarts it with its three mounts only",
                    vm::PROFILE
                ));
            } else {
                r.notes.push(format!(
                    "the {} VM differs from what install gives it ({why}): install restarts it, once no task runs in it",
                    vm::PROFILE
                ));
            }
        }
        Drift::Same | Drift::Restart(_) => {
            // Running here means it differs (the same and running is above).
            if let (Drift::Restart(why), true) = (&drift, running) {
                let why = why.join(", ");
                // A restart ends the tasks in it; one that lets the person's files in does
                // not wait for them (the run loop's rule, `run::vm`).
                if !exposed
                    && tasks_running(ask.docker_cli, &vm::socket_cli(&p.colima_home)) != Some(false)
                {
                    r.blockers.push(format!(
                        "the {} VM is to be restarted ({why}), which would end the tasks running in it: run install again once none runs",
                        vm::PROFILE
                    ));
                    return false;
                }
                eprintln!(
                    "omarchy-agent: restarting the {} VM ({why}); its containers start again",
                    vm::PROFILE
                );
            }
            // Counted before the stop, so the running agent's keeper, held to the same
            // rate limit, does not start it meanwhile with its own flags.
            count_action(&p.data, crate::run::now());
            if running {
                if let Err(e) = colima(sys, env, &["stop", "--profile", vm::PROFILE]) {
                    r.blockers
                        .push(format!("colima stop --profile {}: {e}", vm::PROFILE));
                    return false;
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
            let args = vm::start_args(want);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            if let Err(e) = colima(sys, env, &args) {
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
    // The task firewall, kept for the VM's every boot and applied now, before the egress
    // probe judges it.
    wall(sys, env, ask.subnets, r);
    // What it saved, read back: nothing of the person's may be in it.
    match std::fs::read_to_string(&cfg_path).map(|t| vm::parse_config(&t)) {
        Ok(Ok(c)) => {
            let exposed = vm::exposures(&c, &p.home);
            if ask.mode == Mode::Install || !running {
                for e in &exposed {
                    r.blockers.push(format!("the {} VM: {e}", vm::PROFILE));
                }
            }
            exposed.is_empty() || ask.mode == Mode::Preflight
        }
        // Started with every setting given; what decides then is the probe from a
        // container that the VM sees nothing of the home directory (`sees`).
        Ok(Err(e)) => {
            r.warnings.push(format!(
                "{e}: not read back; the VM's mounts are probed instead"
            ));
            true
        }
        Err(e) => {
            r.warnings.push(format!(
                "{}: {e}; the VM's mounts are probed instead",
                cfg_path.display()
            ));
            true
        }
    }
}

/// The task firewall inside the `omarchy` VM ([`vm::firewall`]): the egress probe that
/// follows checks it holds.
fn wall(sys: &mut dyn Sys, env: &[(&'static str, String)], subnets: &[Cidr], r: &mut Report) {
    let script = vm::firewall(subnets);
    let mut args = vec!["ssh", "--profile", vm::PROFILE, "--"];
    args.extend(vm::as_root(&script));
    match colima(sys, env, &args) {
        Ok(_) => r.notes.push(format!(
            "the {} VM's task firewall is in place, and applied at its every boot: the task subnets reach no private, CGNAT, link-local or VM address",
            vm::PROFILE
        )),
        Err(e) => r.blockers.push(format!(
            "the {} VM's task firewall did not apply ({e}): the agent runs it as root in the VM through Colima's passwordless sudo",
            vm::PROFILE
        )),
    }
}

/// Preflight's Mac half before the engine is measured: the GUI login, the three mounts
/// and their directories below `/Users/Shared` ([`vm::check_owned`]; install makes a
/// missing one, 0700, as prep-mac.sh does), the engine (the `omarchy`
/// profile, sized, started and walled, or a shared VM already here), the gateway.
#[allow(clippy::too_many_lines)] // one check after another, in the screen's order
pub(crate) fn engine(o: &Options, sys: &mut dyn Sys, ask: &Ask<'_>, r: &mut Report) -> Found {
    let p = &o.places;
    let env = vm::colima_env(ask.docker_cli, &p.docker_config());
    let mut found = Found {
        gateway: sys
            .run("route", &["-n", "get", "default"])
            .ok()
            .and_then(|out| parse_gateway(&out)),
        colima_env: env.clone(),
        ..Found::default()
    };
    if let Err(e) = launchd::gui(sys, p.uid, p.ssh) {
        r.blockers.push(e);
    }
    r.blockers
        .extend(vm::check_paths(&p.home, ask.mounts, &NAMES));
    // Below /Users/Shared, which every account may write, each directory there is this
    // user's and no link (prep-mac.sh's check, for the pasted command that runs without it).
    let shared = vm::shared_dir(&p.mac_root);
    r.blockers
        .extend(vm::check_owned(shared, ask.mounts, files::euid()));
    // A missing one is install's to make where this user may (`/Users/Shared` is sticky
    // and writable by everyone): the pasted command needs only Colima installed.
    let mut missing = Vec::new();
    for (m, what) in ask.mounts.iter().zip(NAMES) {
        if m.path.is_dir() {
            continue;
        }
        let parent = super::existing_ancestor(&m.path);
        if rustix::fs::access(&parent, rustix::fs::Access::WRITE_OK).is_ok() {
            missing.push(m.path.clone());
        } else {
            r.blockers.push(format!(
                "the {what} {} does not exist and {} is not writable by this user: run factory/host/prep-mac.sh, which makes {}/{{work,secrets,set}}, or name another with --work-root, --secrets-dir or --set-dir",
                m.path.display(),
                parent.display(),
                vm::MAC_ROOT
            ));
        }
    }
    let colima_socket = vm::socket_cli(&p.colima_home);
    let colima_here = ask.given.map_or_else(
        || colima(sys, &env, &["version"]).is_ok(),
        |g| g == colima_socket,
    );
    if !colima_here {
        // Docker Desktop or OrbStack, when one answers here (or is the one given).
        let list = ask
            .given
            .map_or_else(|| shared_sockets(&p.home), |g| vec![g.to_owned()]);
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
            // The socket given (--socket, agent.toml's): what to do on a Mac.
            Err(e) if ask.given.is_some() => r.blockers.push(if e.starts_with("needs a person") {
                e
            } else {
                format!(
                    "no container engine answers on {}: start Docker Desktop or OrbStack, or leave out --socket (and agent.toml's set.socket_cli) to use the agent's own omarchy Colima VM (factory/host/prep-mac.sh installs Colima)",
                    list.iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }),
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
    let size = match (mac, ask.min) {
        (Ok(mac), Some(min)) => match vm::size(mac, ask.caps.0, ask.caps.1, min) {
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
    let rosetta = ask.rosetta && p.rosetta.exists();
    if !p.rosetta.exists() {
        r.notes.push(
            "Rosetta 2 is not installed: no x86_64 lane (softwareupdate --install-rosetta --agree-to-license, then install again with --rosetta)".into(),
        );
    }
    let Some(size) = size else {
        return found;
    };
    let want = Want {
        size,
        disk_gb: vm::DISK_GB,
        mounts: ask.mounts.to_vec(),
        rosetta,
    };
    found.want = Some(want.clone());
    let shown: Vec<String> = missing.iter().map(|m| m.display().to_string()).collect();
    // Nothing is started or made while anything else blocks: the screen lists it all first.
    if !r.ok() || (ask.mode == Mode::Preflight && !missing.is_empty()) {
        if !missing.is_empty() {
            r.notes.push(format!(
                "install makes {} (0700) before it starts the {} VM, which mounts it",
                shown.join(", "),
                vm::PROFILE
            ));
        }
        found.deferred = r.ok();
        r.notes.push(format!(
            "the {} VM was not started: {}",
            vm::PROFILE,
            if r.ok() {
                "its directories are made first; install measures the engine in it then"
            } else {
                "what blocks comes first"
            }
        ));
        return found;
    }
    if !missing.is_empty() {
        for m in &missing {
            if let Err(e) = files::make_dir(m) {
                r.blockers.push(format!(
                    "{e}: run factory/host/prep-mac.sh, which makes {}/{{work,secrets,set}}",
                    vm::MAC_ROOT
                ));
                return found;
            }
        }
        // What another account made in between (the parents `make_dir` found there).
        let late = vm::check_owned(shared, ask.mounts, files::euid());
        if !late.is_empty() {
            r.blockers.extend(late);
            return found;
        }
        r.notes.push(format!("made {} (0700)", shown.join(", ")));
    }
    if ensure_profile(o, sys, ask, &env, &want, r) {
        found.socket = Some(colima_socket);
    }
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

/// What else of the home directory a shared VM must not see (#320): the places that hold
/// credentials, and the folders a file share is usually made for. Docker Desktop shares a
/// subdirectory of `~` without the home directory itself, so probing `~` alone says
/// nothing of them.
pub(crate) fn home_parts(home: &Path) -> Vec<PathBuf> {
    [
        ".ssh",
        ".aws",
        ".gnupg",
        ".kube",
        ".docker",
        ".config",
        ".git-credentials",
        "Library",
        "Documents",
        "Desktop",
        "Downloads",
        "Developer",
        "Projects",
        "projects",
        "src",
        "code",
        "dev",
        "git",
        "repos",
        "work",
    ]
    .iter()
    .map(|n| home.join(n))
    .filter(|p| p.exists())
    .collect()
}

/// After the engine answered: the VM sees the three directories at their own paths, and
/// not the home directory nor any of `extra` ([`home_parts`], for a shared VM) (design v2
/// §19.2: a container escape lands in the VM, not in the maintainer's account; a shared VM
/// qualifies only with the home mount removed).
pub(crate) fn sees(
    d: &Docker,
    image: &str,
    home: &Path,
    mounts: &[Mount],
    extra: &[PathBuf],
    r: &mut Report,
) {
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
    let unsafe_path = |p: &Path| p.to_string_lossy().contains([',', '"']);
    if unsafe_path(home) {
        r.warnings.push(format!(
            "{}: not probed (a ',' or '\"' in the path)",
            home.display()
        ));
        return;
    }
    if visible(d, image, home).is_ok() {
        r.blockers.push(format!(
            "your home directory {} is visible inside the engine's VM: remove the home mount (Docker Desktop: Settings, Resources, File sharing; the omarchy Colima VM never has one)",
            home.display()
        ));
        return;
    }
    let seen: Vec<String> = extra
        .iter()
        .filter(|p| !unsafe_path(p) && visible(d, image, p).is_ok())
        .map(|p| p.display().to_string())
        .collect();
    if seen.is_empty() {
        r.notes
            .push("the VM sees the work root, the secrets and the set directories, and nothing of your home directory".into());
    } else {
        r.blockers.push(format!(
            "part of your home directory is visible inside the engine's VM ({}): share nothing under {} with it (Docker Desktop: Settings, Resources, File sharing)",
            seen.join(", "),
            home.display()
        ));
    }
}

/// `MemAvailable` from inside the `omarchy` VM (M7), where this process has no
/// `/proc/meminfo` of its own.
pub(crate) fn meminfo(sys: &mut dyn Sys, env: &[(&'static str, String)]) -> Option<String> {
    colima(
        sys,
        env,
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
