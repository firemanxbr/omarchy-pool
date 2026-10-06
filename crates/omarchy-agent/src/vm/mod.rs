//! A Mac as a maintainer host (#320; design v2 §19.2, §19.3, §21.3; decision D11; the
//! agent's M7): a native macOS agent whose Arch Linux containers run in a Linux VM, the
//! dedicated `omarchy` Colima profile. No Linux container runs on Darwin itself.
//!
//! Everything here is platform-neutral — the profile's size from the Mac and the envelope,
//! its mounts and the paths they may hold, the `colima start` argv, the profile's saved
//! configuration read back, the clock after a wake, the rate limit of M7 — so the tests run
//! on Linux; the agent drives `colima`, `sysctl` and `launchctl` only through their CLIs
//! (no unsafe code, no Apple SDK).
//!
//! - **Size** ([`size`]): CPUs and memory from the envelope (`max_cpus`, `max_mem_gb`),
//!   by default half of the Mac's; never the whole Mac ([`MAC_KEEPS`]), and never below
//!   the release's signed minimum: a Mac that cannot give the VM 4 CPUs and 8 GB does not
//!   join. A 16-core, 64 GB Mac gives 8 CPUs and 32 GB: 7 units, 3 builds and the job unit.
//! - **Mounts** ([`mounts`], [`check_paths`], [`check_owned`]): no home directory. The
//!   work root (writable), the secrets directory and the set directory (both read-only),
//!   each at its identical path, none under `~` and none holding it, and every directory of
//!   theirs below `/Users/Shared` the person's own and no link — checked again before every
//!   start of the profile. The set directory is mounted because the host set binds
//!   `./run/capacity.json` into the dispatcher; read-only, so nothing in the VM can plant a
//!   link the agent would then write through.
//! - **Two sockets**: [`socket_cli`] (`~/.colima/omarchy/docker.sock`) for the agent's
//!   pinned CLI, [`SOCKET_MOUNT`] (`/var/run/docker.sock`, inside the VM) for the
//!   dispatcher's bind mount.
//! - **The profile** ([`start_args`], [`parse_config`], [`drift`]): `--vm-type vz --arch
//!   aarch64`, virtiofs, no SSH agent, the Docker context left alone; `--vz-rosetta` for an
//!   `x86_64` lane through Rosetta (4K pages in the VM). What `colima.yaml` says the profile
//!   has decides whether it must be restarted with the agent's flags, or deleted by a
//!   person (another VM type or architecture).
//! - **The task firewall** ([`firewall`]): prep-root.sh's step 9 inside the VM, where the
//!   agent is root (Colima's passwordless sudo) — the task subnets reach no private, CGNAT,
//!   link-local or VM address — kept in the VM with a unit that applies it after
//!   `docker.service` at every boot, and run again after every start of the profile.
//!   Colima's NAT carries a task's connection to the Mac's LAN otherwise.
//! - **Colima's environment** ([`colima_env`], [`colima`]): launchd's `PATH` with the pinned
//!   docker CLI first (Colima wants a `docker` client before it starts a profile) and the
//!   agent's own `DOCKER_CONFIG`, every call with a deadline.
//! - **The clock after a wake** ([`clock`]): the VM's clock against the pool's `Date`,
//!   through the Mac's own: beyond [`CLOCK_SKEW_S`] the VM is set to the pool's time, and
//!   restarted (within the rate limit) when that does not hold; a Mac whose own clock is
//!   off is said, never set, and the VM is held to the Mac's then.
//! - **The rate limit** ([`allowed`]): the agent starts, stops and sizes the profile at
//!   most once per [`COOLDOWN_S`] and [`PER_DAY`] times a day.

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::install::net::Cidr;
use crate::lint::yaml::{self, Node};

/// The Colima profile the agent owns (decision D11).
pub const PROFILE: &str = "omarchy";
/// The profile's architecture (`--arch aarch64`, D11): its engine's native lane.
pub const ARCH: &str = "aarch64";
/// The socket the dispatcher bind-mounts: the engine's own, inside the VM.
pub const SOCKET_MOUNT: &str = "/var/run/docker.sock";
/// launchd's `PATH` lacks Homebrew's prefix, where Colima and Lima are (`prep-mac.sh`).
pub const PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/// Where `prep-mac.sh` makes the work root, the secrets and the set directories: outside
/// every home directory, and writable by any user without sudo (`/Users/Shared` is
/// sticky), each made 0700.
pub const MAC_ROOT: &str = "/Users/Shared/omarchy-pool";
/// The VM's disk (Colima's default); the engine's data root lives on it.
pub const DISK_GB: u32 = 100;
/// What the Mac always keeps for itself: the VM never takes the whole Mac.
pub const MAC_KEEPS: (u32, u32) = (1, 2);
/// The largest skew between the VM's clock and the pool's that the agent lets stand.
pub const CLOCK_SKEW_S: i64 = 5;
/// A tick that comes this long after the last one: the Mac slept.
pub const WAKE_GAP_S: i64 = 60;
/// M7's rate limit: one start, stop, restart or resize per this many seconds...
pub const COOLDOWN_S: i64 = 600;
/// ...and at most this many a day.
pub const PER_DAY: usize = 6;
/// Where Rosetta 2 lives once installed (`softwareupdate --install-rosetta`).
pub const ROSETTA_RUNTIME: &str = "/Library/Apple/usr/libexec/oah/libRosettaRuntime";
/// The Mac as the omarchy VM reaches it (Lima's `host.lima.internal`): a target the egress
/// probe must find blocked, as it does the Mac's LAN address.
pub const VM_HOST: &str = "192.168.5.2";
/// What a task subnet never reaches (design v2 §9.4): RFC 1918, CGNAT (Tailscale's range)
/// and link-local (cloud metadata) — prep-root.sh's step 9, the same list.
pub const FORBIDDEN: [&str; 5] = [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "169.254.0.0/16",
];

/// `$COLIMA_HOME`, or `~/.colima`.
pub fn colima_home(home: &Path, env: Option<&std::ffi::OsStr>) -> PathBuf {
    env.filter(|v| !v.is_empty())
        .map_or_else(|| home.join(".colima"), PathBuf::from)
}

/// The engine's socket on the Mac, for the agent's pinned CLI.
pub fn socket_cli(colima_home: &Path) -> PathBuf {
    colima_home.join(PROFILE).join("docker.sock")
}

/// The profile's saved configuration, which Colima writes at every start.
pub fn config_path(colima_home: &Path) -> PathBuf {
    colima_home.join(PROFILE).join("colima.yaml")
}

// ---------------------------------------------------------------------------------------
// The Mac and the VM's size.

/// What the Mac has: `sysctl -n hw.ncpu hw.memsize`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mac {
    pub cpus: u32,
    pub mem_gb: u32,
}

/// `sysctl -n hw.ncpu hw.memsize`: two lines, the CPUs and the memory in bytes.
pub fn parse_sysctl(out: &str) -> Result<Mac, String> {
    let mut it = out.split_whitespace();
    let cpus: u32 = it
        .next()
        .and_then(|v| v.parse().ok())
        .filter(|&c| c > 0)
        .ok_or_else(|| format!("sysctl hw.ncpu: {out:?}"))?;
    let bytes: u64 = it
        .next()
        .and_then(|v| v.parse().ok())
        .filter(|&b| b > 0)
        .ok_or_else(|| format!("sysctl hw.memsize: {out:?}"))?;
    Ok(Mac {
        cpus,
        mem_gb: u32::try_from(bytes >> 30).unwrap_or(u32::MAX),
    })
}

/// The VM's CPUs and memory (GB).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub cpus: u32,
    pub mem_gb: u32,
}

/// The VM's size: the envelope's caps, else half of the Mac; at most the Mac less what
/// it keeps ([`MAC_KEEPS`]); refused below the signed minimum (`min`: CPUs, GB), with the
/// numbers and what would let it join.
pub fn size(
    mac: Mac,
    max_cpus: Option<u32>,
    max_mem_gb: Option<u32>,
    min: (u32, u32),
) -> Result<Size, String> {
    let most = (
        mac.cpus.saturating_sub(MAC_KEEPS.0),
        mac.mem_gb.saturating_sub(MAC_KEEPS.1),
    );
    let s = Size {
        cpus: max_cpus.unwrap_or(mac.cpus / 2).min(most.0),
        mem_gb: max_mem_gb.unwrap_or(mac.mem_gb / 2).min(most.1),
    };
    if s.cpus >= min.0 && s.mem_gb >= min.1 {
        return Ok(s);
    }
    let how = if max_cpus.is_some() || max_mem_gb.is_some() {
        "the envelope's max_cpus and max_mem_gb"
    } else {
        "half of the Mac's"
    };
    let raise = if most.0 >= min.0 && most.1 >= min.1 {
        format!(
            "; --max-cpus and --max-mem-gb give it more, up to {} CPUs and {} GB on this Mac",
            most.0, most.1
        )
    } else {
        String::new()
    };
    Err(format!(
        "below the minimum to join: the VM would get {} CPUs and {} GB ({how}: this Mac has {} and {}), and the release's minimum is {} CPUs and {} GB; a Mac that cannot give the VM the minimum does not join{raise}",
        s.cpus, s.mem_gb, mac.cpus, mac.mem_gb, min.0, min.1
    ))
}

// ---------------------------------------------------------------------------------------
// Mounts and the paths they may hold.

/// One directory the profile mounts, at its identical path inside the VM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mount {
    pub path: PathBuf,
    pub writable: bool,
}

/// The profile's mounts: the work root (writable), the secrets directory and the set
/// directory (read-only). Nothing else, the home directory least of all.
pub fn mounts(work_root: &Path, secrets_dir: &Path, set_dir: &Path) -> Vec<Mount> {
    vec![
        Mount {
            path: work_root.to_owned(),
            writable: true,
        },
        Mount {
            path: secrets_dir.to_owned(),
            writable: false,
        },
        Mount {
            path: set_dir.to_owned(),
            writable: false,
        },
    ]
}

/// `a` is `b` or under it, comparing components without case: the Mac's file system is
/// case-insensitive by default, so `/users/me` is `/Users/me`.
fn within(a: &Path, b: &Path) -> bool {
    let (a, b): (Vec<Component>, Vec<Component>) =
        (a.components().collect(), b.components().collect());
    b.len() <= a.len()
        && a.iter().zip(&b).all(|(x, y)| {
            x.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&y.as_os_str().to_string_lossy())
        })
}

/// A path as the VM would reach it: the link resolved when it exists (a directory under
/// `/Users/Shared` linked into the home directory is the home directory).
fn resolved(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_owned())
}

/// Preflight's check of the profile's mounts (design v2 §13.3: "the work root is not under
/// `~` on macOS"): each plain absolute and free of `:` and `,` (Colima's mount syntax),
/// none the home directory, under it or holding it, and no two overlapping (Lima refuses
/// overlapping mounts).
pub fn check_paths(home: &Path, mounts: &[Mount], names: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let home_r = resolved(home);
    for (i, m) in mounts.iter().enumerate() {
        let what = names.get(i).copied().unwrap_or("mount");
        let p = &m.path;
        let shown = p.display();
        if !crate::lint::is_plain_absolute(p) {
            out.push(format!("the {what} {shown} is not a plain absolute path"));
            continue;
        }
        if p.to_string_lossy().contains([':', ',']) {
            out.push(format!(
                "the {what} {shown} holds ':' or ',', which Colima's --mount cannot carry"
            ));
            continue;
        }
        let r = resolved(p);
        if within(p, home) || within(&r, &home_r) {
            out.push(format!(
                "the {what} {shown} is under your home directory {}: the omarchy VM mounts no part of it (factory/host/prep-mac.sh makes {MAC_ROOT})",
                home.display()
            ));
        } else if within(home, p) || within(&home_r, &r) {
            out.push(format!(
                "the {what} {shown} holds your home directory {}: the omarchy VM mounts no part of it",
                home.display()
            ));
        }
        for (j, other) in mounts.iter().enumerate().skip(i + 1) {
            let r2 = resolved(&other.path);
            if within(&r, &r2) || within(&r2, &r) {
                out.push(format!(
                    "the {what} {shown} and the {} {} overlap: the VM mounts each on its own",
                    names.get(j).copied().unwrap_or("mount"),
                    other.path.display()
                ));
            }
        }
    }
    out
}

/// The directory the default mounts are made in, sticky and writable by every account:
/// `/Users/Shared` for [`MAC_ROOT`].
pub fn shared_dir(mac_root: &Path) -> &Path {
    mac_root.parent().unwrap_or(Path::new("/"))
}

/// The directories below `shared` ([`shared_dir`]) that hold a mount, as prep-mac.sh checks
/// them: each one there (the mount and its parents below `shared`) this user's (`uid`),
/// none a symbolic link. Another account may make `omarchy-pool` in `/Users/Shared` before
/// the person does; owning it, it could later rename the work root and leave a link into
/// the person's home in its place, which the next start of the VM would mount. Checked by
/// preflight, install, and the run loop before every start of the profile.
pub fn check_owned(shared: &Path, mounts: &[Mount], uid: u32) -> Vec<String> {
    use std::os::unix::fs::MetadataExt as _;
    let mut out = Vec::new();
    // Each directory once (the three mounts share their root), with whether it was refused.
    let mut seen: Vec<(PathBuf, bool)> = Vec::new();
    let depth = shared.components().count();
    for m in mounts {
        let mut below: Vec<&Path> = m
            .path
            .ancestors()
            .filter(|a| a.components().count() > depth && within(a, shared))
            .collect();
        // From the top down: below a link, every path is its target's.
        below.reverse();
        for d in below {
            if let Some((_, refused)) = seen.iter().find(|(s, _)| s == d) {
                if *refused {
                    break;
                }
                continue;
            }
            // One not there yet is install's to make, 0700, this user's.
            let why = match std::fs::symlink_metadata(d) {
                Ok(meta) if meta.file_type().is_symlink() => Some(format!(
                    "{} is a symbolic link: refused (the VM would mount what it points at)",
                    d.display()
                )),
                Ok(meta) if meta.uid() != uid => Some(format!(
                    "{} belongs to uid {}, not this user's {uid}: use another --root with factory/host/prep-mac.sh (and --work-root, --secrets-dir and --set-dir)",
                    d.display(),
                    meta.uid()
                )),
                Ok(_) | Err(_) => None,
            };
            seen.push((d.to_owned(), why.is_some()));
            if let Some(why) = why {
                out.push(why);
                break;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------------------
// The profile.

/// What the agent gives the profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Want {
    pub size: Size,
    pub disk_gb: u32,
    pub mounts: Vec<Mount>,
    pub rosetta: bool,
}

/// `colima start` with everything the profile must have, so a saved setting of the
/// person's (an SSH agent forwarded, the Docker context switched, another mount) does not
/// carry over: `--vm-type vz --arch aarch64`, virtiofs, the mounts at identical paths,
/// `--vz-rosetta` set either way.
pub fn start_args(w: &Want) -> Vec<String> {
    let mut a: Vec<String> = [
        "start",
        "--profile",
        PROFILE,
        "--vm-type",
        "vz",
        "--arch",
        ARCH,
        "--runtime",
        "docker",
        "--mount-type",
        "virtiofs",
        // The person's SSH agent stays out of the VM; their ~/.ssh/config and their
        // Docker context are left as they are.
        "--ssh-agent=false",
        "--ssh-config=false",
        "--activate=false",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    for (flag, v) in [
        ("--cpu", w.size.cpus),
        ("--memory", w.size.mem_gb),
        ("--disk", w.disk_gb),
    ] {
        a.push(flag.to_owned());
        a.push(v.to_string());
    }
    for m in &w.mounts {
        a.push("--mount".to_owned());
        a.push(format!(
            "{}{}",
            m.path.display(),
            if m.writable { ":w" } else { "" }
        ));
    }
    a.push(format!("--vz-rosetta={}", w.rosetta));
    a
}

/// One mount as `colima.yaml` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedMount {
    pub location: String,
    pub mount_point: Option<String>,
    pub writable: bool,
}

/// The profile's `colima.yaml`, as far as the agent reads it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Config {
    pub vm_type: String,
    pub arch: String,
    pub cpus: u32,
    pub mem_gb: f64,
    pub disk_gb: u32,
    pub rosetta: bool,
    pub forward_agent: bool,
    pub mounts: Vec<SavedMount>,
}

/// `colima.yaml`, read with the lint's hardened reader. A key Colima leaves out is its
/// default (`omitempty`): no mounts at all means Colima mounts the home directory.
pub fn parse_config(text: &str) -> Result<Config, String> {
    let doc = yaml::parse(text).map_err(|e| format!("colima.yaml: {e}"))?;
    let s = |k: &str| doc.get(k).and_then(Node::as_str).unwrap_or("").to_owned();
    let b = |k: &str| matches!(doc.get(k).and_then(Node::as_str), Some("true"));
    let n = |k: &str| s(k).parse::<f64>().unwrap_or(0.0);
    let mut mounts = Vec::new();
    match doc.get("mounts") {
        None | Some(Node::Null) => {}
        Some(Node::Seq(items)) => {
            for m in items {
                let location = m
                    .get("location")
                    .and_then(Node::as_str)
                    .ok_or("colima.yaml: a mount without a location")?;
                mounts.push(SavedMount {
                    location: location.to_owned(),
                    mount_point: m
                        .get("mountPoint")
                        .and_then(Node::as_str)
                        .filter(|p| !p.is_empty())
                        .map(str::to_owned),
                    writable: matches!(m.get("writable").and_then(Node::as_str), Some("true")),
                });
            }
        }
        Some(_) => return Err("colima.yaml: mounts is not a list".into()),
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // whole CPUs and GB
    Ok(Config {
        vm_type: s("vmType"),
        arch: s("arch"),
        cpus: n("cpu") as u32,
        mem_gb: n("memory"),
        disk_gb: n("disk") as u32,
        rosetta: b("rosetta"),
        forward_agent: b("forwardAgent"),
        mounts,
    })
}

/// Why a saved profile would let anything of the person's into the VM: the home
/// directory (no mounts at all is Colima's default `~`), a mount elsewhere than its own
/// path, a forwarded SSH agent. A start with [`start_args`] puts each right.
pub fn exposures(c: &Config, home: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if c.mounts.is_empty() {
        out.push(
            "the profile mounts nothing of its own, so Colima mounts your home directory"
                .to_owned(),
        );
    }
    for m in &c.mounts {
        let loc = m.location.as_str();
        if loc == "~"
            || loc.starts_with("~/")
            || within(Path::new(loc), home)
            || within(home, Path::new(loc))
        {
            out.push(format!(
                "the profile mounts {loc}, in or around your home directory"
            ));
        }
        if m.mount_point.as_deref().is_some_and(|p| p != loc) {
            out.push(format!(
                "the profile mounts {loc} elsewhere than its own path"
            ));
        }
    }
    if c.forward_agent {
        out.push("the profile forwards your SSH agent into the VM".to_owned());
    }
    out
}

/// What the saved profile is, against what the agent wants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Drift {
    Same,
    /// A start with the agent's flags puts it right (a stop first when it runs): why.
    Restart(Vec<String>),
    /// Only `colima delete -p omarchy` does: another VM type or architecture.
    Recreate(String),
}

/// The saved profile against [`Want`]: a type or architecture Colima cannot change in
/// place is the person's to delete; a size, a mount, Rosetta or an exposure is a restart.
pub fn drift(have: &Config, want: &Want, home: &Path) -> Drift {
    if (!have.vm_type.is_empty() && have.vm_type != "vz")
        || (!have.arch.is_empty() && have.arch != ARCH)
    {
        return Drift::Recreate(format!(
            "the omarchy profile is {} {}, not vz aarch64: `colima delete -p {PROFILE}` and install again",
            have.vm_type, have.arch
        ));
    }
    let mut why = exposures(have, home);
    if have.cpus != want.size.cpus {
        why.push(format!("{} CPUs, not {}", have.cpus, want.size.cpus));
    }
    if (have.mem_gb - f64::from(want.size.mem_gb)).abs() > 0.01 {
        why.push(format!("{} GB, not {}", have.mem_gb, want.size.mem_gb));
    }
    // Colima grows a disk and never shrinks one.
    if have.disk_gb < want.disk_gb {
        why.push(format!("a {} GB disk, not {}", have.disk_gb, want.disk_gb));
    }
    let saved: Vec<(&str, bool)> = have
        .mounts
        .iter()
        .map(|m| (m.location.as_str(), m.writable))
        .collect();
    let wanted: Vec<(String, bool)> = want
        .mounts
        .iter()
        .map(|m| (m.path.display().to_string(), m.writable))
        .collect();
    if saved.len() != wanted.len()
        || !wanted
            .iter()
            .all(|(p, w)| saved.iter().any(|(s, sw)| s == p && sw == w))
    {
        why.push("other mounts".to_owned());
    }
    if have.rosetta != want.rosetta {
        why.push(format!(
            "Rosetta {}",
            if want.rosetta { "off" } else { "on" }
        ));
    }
    if why.is_empty() {
        Drift::Same
    } else {
        Drift::Restart(why)
    }
}

// ---------------------------------------------------------------------------------------
// Colima's environment, and the task firewall inside the VM.

/// The environment every `colima` call gets: launchd's `PATH` ([`PATH`]) with the pinned
/// docker CLI's directory first — Colima looks for a `docker` client on the Mac before it
/// starts a profile, and runs `docker context create` there — and the agent's own
/// `DOCKER_CONFIG`, so that context lands in the agent's data directory and never in the
/// person's `~/.docker`. Homebrew installs Colima and Lima only (`prep-mac.sh`); the docker
/// CLI is the release's.
pub fn colima_env(docker_cli: Option<&Path>, docker_config: &Path) -> Vec<(&'static str, String)> {
    let path = match docker_cli.and_then(Path::parent) {
        Some(d) => format!("{}:{PATH}", d.display()),
        None => PATH.to_owned(),
    };
    vec![
        ("PATH", path),
        ("DOCKER_CONFIG", docker_config.display().to_string()),
    ]
}

/// `colima <args>` with `env` ([`colima_env`]) and a deadline (design v2 §10: no call
/// blocks longer than it): its stdout, or why not.
pub fn colima(
    args: &[&str],
    env: &[(&'static str, String)],
    limit: Duration,
) -> Result<String, String> {
    let mut c = Command::new("colima");
    c.args(args).envs(env.iter().map(|(k, v)| (*k, v)));
    let o = crate::run::exec::run(c, limit)?;
    if o.ok() {
        Ok(o.stdout)
    } else {
        Err(format!(
            "colima {}: exit {:?}: {}",
            args.first().unwrap_or(&""),
            o.code,
            o.stderr.trim()
        ))
    }
}

/// Where the omarchy VM keeps the task firewall's rules, and the unit that applies them at
/// every boot of the VM: prep-root.sh's names on a Linux host.
pub(crate) const FIREWALL_RULES: &str = "/usr/local/libexec/omarchy-task-firewall";
pub(crate) const FIREWALL_UNIT: &str = "/etc/systemd/system/omarchy-task-firewall.service";

/// The task firewall of the omarchy VM (#320; design v2 §9.4): prep-root.sh's step 9 as
/// one idempotent script, run as root inside the VM (`colima ssh -- sudo -n sh -c`). It
/// writes the rules ([`firewall_rules`]) and, under systemd, the unit that applies them
/// after `docker.service` at every boot of the VM — as `omarchy-task-firewall.service`
/// does on a Linux host — so a boot (a login, a resize, a clock restart) leaves no window
/// in which the dispatcher, which dockerd starts with itself, runs a task unwalled until
/// the agent looks. The VM's disk keeps both across `colima stop` and `start`. Then it
/// applies them now. The agent runs it after every start of the profile, hourly and after
/// a wake, which repairs the rules and carries a change of the task subnets; the unit is
/// reloaded only when it changed. Colima's NAT carries a task's connection to the Mac's
/// router, the Mac's own LAN address and [`VM_HOST`]: nothing else in the VM stops it.
pub(crate) fn firewall(subnets: &[Cidr]) -> String {
    let unit = [
        "# omarchy-agent (omarchy-pool): the task subnets' drop rules, after docker, at every boot of the VM.",
        "[Unit]",
        "Description=omarchy-pool: task subnets reach no private, link-local or VM address",
        "After=docker.service systemd-resolved.service",
        "Wants=docker.service",
        "",
        "[Service]",
        "Type=oneshot",
        "RemainAfterExit=yes",
        &format!("ExecStart={FIREWALL_RULES}"),
        "",
        "[Install]",
        "WantedBy=multi-user.target",
    ]
    .join("\n");
    format!(
        r"set -e
umask 022
mkdir -p /usr/local/libexec
cat > {FIREWALL_RULES}.new <<'OMARCHY_RULES'
#!/bin/sh
# omarchy-agent (omarchy-pool): task subnets reach no private, CGNAT, link-local or VM address (design v2 §9.4).
# Rebuilt whole on every run; the chains are this file's own.
{rules}OMARCHY_RULES
chmod 0755 {FIREWALL_RULES}.new
mv -f {FIREWALL_RULES}.new {FIREWALL_RULES}
if [ -d /run/systemd/system ]; then
  cat > {FIREWALL_UNIT}.new <<'OMARCHY_UNIT'
{unit}
OMARCHY_UNIT
  if cmp -s {FIREWALL_UNIT}.new {FIREWALL_UNIT}; then
    rm -f {FIREWALL_UNIT}.new
  else
    mv -f {FIREWALL_UNIT}.new {FIREWALL_UNIT}
    systemctl daemon-reload
  fi
  systemctl is-enabled --quiet omarchy-task-firewall.service || systemctl enable --quiet omarchy-task-firewall.service
fi
{FIREWALL_RULES}
",
        rules = firewall_rules(subnets),
    )
}

/// The rules [`firewall`] keeps in the VM: prep-root.sh's step 9 for the task subnets.
///
/// The chains are the script's own and rebuilt whole: the task subnets reach each other
/// (a task's network holds its sidecars) and no private, CGNAT or link-local address
/// ([`FORBIDDEN`]) through `DOCKER-USER`, and nothing of the VM itself through `INPUT`.
/// One exception prep-root.sh does not need: DNS (port 53) to the VM's own resolvers
/// (Lima's `192.168.5.3`), which Docker's embedded DNS server forwards to from the task's
/// own namespace — a name is still checked by the egress sidecar against the address it
/// resolves to. IPv4 only, as there.
pub(crate) fn firewall_rules(subnets: &[Cidr]) -> String {
    let mut s = vec![
        "set -e".to_owned(),
        // The VM's resolvers: systemd-resolved's upstream, else resolv.conf's; never a
        // loopback stub.
        r#"ns=$(cat /run/systemd/resolve/resolv.conf /etc/resolv.conf 2>/dev/null | awk '$1 == "nameserver" && $2 ~ /^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$/ && $2 !~ /^127[.]/ { print $2 }' | sort -u)"#.to_owned(),
        "iptables -N OMARCHY-TASKS 2>/dev/null || true".to_owned(),
        "iptables -N OMARCHY-TASKS-HOST 2>/dev/null || true".to_owned(),
        "iptables -F OMARCHY-TASKS".to_owned(),
        "iptables -F OMARCHY-TASKS-HOST".to_owned(),
    ];
    for t in subnets {
        s.push(format!("iptables -A OMARCHY-TASKS -s {t} -d {t} -j RETURN"));
        s.push(format!(
            r#"for d in $ns; do for p in udp tcp; do iptables -A OMARCHY-TASKS -s {t} -d "$d" -p "$p" --dport 53 -j RETURN; done; done"#
        ));
        for d in FORBIDDEN {
            s.push(format!("iptables -A OMARCHY-TASKS -s {t} -d {d} -j DROP"));
        }
        s.push(format!("iptables -A OMARCHY-TASKS-HOST -s {t} -j DROP"));
    }
    s.extend(
        [
            "iptables -N DOCKER-USER 2>/dev/null || true",
            "iptables -C DOCKER-USER -j OMARCHY-TASKS 2>/dev/null || iptables -I DOCKER-USER -j OMARCHY-TASKS",
            "iptables -C INPUT -j OMARCHY-TASKS-HOST 2>/dev/null || iptables -I INPUT -j OMARCHY-TASKS-HOST",
        ]
        .map(str::to_owned),
    );
    let mut out = s.join("\n");
    out.push('\n');
    out
}

/// The command inside the VM (after `colima ssh --profile omarchy --`) that runs
/// [`firewall`]'s script as root; `-n`: sudo never waits for a password.
pub(crate) fn as_root(script: &str) -> [&str; 5] {
    ["sudo", "-n", "sh", "-c", script]
}

// ---------------------------------------------------------------------------------------
// The clock after a wake.

/// What the clock check decided: the VM's clock to set, and the Mac's own offset when it
/// is off the pool's. Both can hold at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clock {
    /// Set the VM's clock to `to` (`date -u -s @<to>` inside the VM): it is `skew` seconds
    /// off it (the pool's time, or the Mac's while the Mac's is off the pool's).
    pub resync: Option<Resync>,
    /// The Mac's own clock is this far from the pool's: said, never set by the agent.
    pub mac_off: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resync {
    pub to: i64,
    pub skew: i64,
}

impl Clock {
    /// The VM is within [`CLOCK_SKEW_S`] of the time it is held to.
    pub fn vm_fine(&self) -> bool {
        self.resync.is_none()
    }
}

/// The VM's clock against the pool's `Date` (design v2 §19.2, v1 §14.2: beyond 5 s it is
/// resynced), through the Mac's: the pool's date as received (`date`, at the Mac's
/// `received`) gives the Mac's offset from the pool, and the pool's time now is the Mac's
/// (`mac_now`, read with `vm_now`) plus that offset.
///
/// While the Mac agrees with the pool (within [`CLOCK_SKEW_S`], one second more for the
/// `Date` header's resolution), a VM more than [`CLOCK_SKEW_S`] from the pool's time is set
/// to it. A Mac whose own clock is further off is said ([`Clock::mac_off`], never set by the
/// agent), and the VM is then held to the Mac's clock: a sleep's drift goes, and the pool's
/// answer never moves the VM's clock further than that from the Mac's own (a pool that lies
/// about the time cannot take the VM's TLS checks back to a year whose certificates have
/// expired). Without a `Date` the Mac's clock stands for the pool's.
pub fn clock(vm_now: i64, mac_now: i64, pool: Option<(i64, i64)>) -> Clock {
    let mac_off = pool.map_or(0, |(date, received)| date - received);
    let agrees = mac_off.abs() <= CLOCK_SKEW_S + 1;
    let to = if agrees { mac_now + mac_off } else { mac_now };
    let skew = vm_now - to;
    Clock {
        resync: (skew.abs() > CLOCK_SKEW_S).then_some(Resync { to, skew }),
        mac_off: (!agrees).then_some(mac_off),
    }
}

/// An HTTP `Date` (RFC 9110's IMF-fixdate, `Sun, 06 Nov 1994 08:49:37 GMT`) as Unix
/// seconds; `None` for anything else.
pub fn parse_http_date(s: &str) -> Option<i64> {
    let mut it = s.split_whitespace();
    let _weekday = it.next()?.strip_suffix(',')?;
    let day: u32 = it.next()?.parse().ok()?;
    let month = match it.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = it.next()?.parse().ok()?;
    let mut hms = it.next()?.split(':').map(|x| x.parse::<i64>().ok());
    let (h, m, sec) = (hms.next()??, hms.next()??, hms.next()??);
    if it.next()? != "GMT" || it.next().is_some() || hms.next().is_some() {
        return None;
    }
    if !(1..=31).contains(&day)
        || !(0..24).contains(&h)
        || !(0..60).contains(&m)
        || !(0..61).contains(&sec)
    {
        return None;
    }
    // Days from civil (H. Hinnant), the inverse of capacity::utc.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + m * 60 + sec)
}

// ---------------------------------------------------------------------------------------
// M7's rate limit.

/// Whether a start, stop, restart or resize may happen at `now`, given the earlier ones
/// (Unix seconds): `Err(seconds to wait)` when not.
pub fn allowed(actions: &[i64], now: i64) -> Result<(), i64> {
    let last = actions.iter().copied().max();
    if let Some(l) = last.filter(|l| now - l < COOLDOWN_S) {
        return Err(l + COOLDOWN_S - now);
    }
    let mut day: Vec<i64> = actions
        .iter()
        .copied()
        .filter(|a| now - a < 86_400)
        .collect();
    if day.len() >= PER_DAY {
        day.sort_unstable();
        return Err(day[day.len() - PER_DAY] + 86_400 - now);
    }
    Ok(())
}

/// Where the agent records M7's actions, in its data directory.
pub const ACTIONS_FILE: &str = "vm.json";

/// The recorded actions: `{"actions": [<unix seconds>...]}`; nothing readable is none.
pub fn read_actions(text: &str) -> Vec<i64> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| {
            v.get("actions")?
                .as_array()
                .map(|a| a.iter().filter_map(serde_json::Value::as_i64).collect())
        })
        .unwrap_or_default()
}

pub fn render_actions(actions: &[i64]) -> String {
    format!("{}\n", serde_json::json!({ "actions": actions }))
}

/// The actions of the last day, with `now` added: what [`allowed`] reads next time.
pub fn record(actions: &[i64], now: i64) -> Vec<i64> {
    let mut out: Vec<i64> = actions
        .iter()
        .copied()
        .filter(|a| now - a < 86_400)
        .collect();
    out.push(now);
    out
}

#[cfg(test)]
mod tests;
