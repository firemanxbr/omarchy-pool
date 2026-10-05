//! Whether a rootless engine maps the host's loopback into its networks (#367; design v2
//! §10.2 inv. 8). A rootless engine's networks live in a namespace of its own that reaches
//! the outside through a user-mode network stack — `RootlessKit` (with slirp4netns, vpnkit,
//! gvisor-tap-vsock or pasta) for rootless Docker, slirp4netns or pasta for rootless podman —
//! and each of them can forward an address of that namespace to the host's `127.0.0.1`,
//! where services that trust local callers listen. Every one has it off by default, and
//! whether it is on is on the stack's command line, which the engine's own user reads in
//! `/proc/<pid>/cmdline`: preflight reads it there while its probe tasks run (rootless podman
//! starts its stack with the first container on a bridge network, and stops it with the
//! last), rather than listening for a connection the mapping would let through — the agent
//! listens on nothing (design v2 §11.2). The agent runs as the rootless engine's user (design
//! v2 §19.3), so a rootless host whose stack is not seen is refused: nothing then says the
//! mapping is off.

use std::os::unix::fs::MetadataExt as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Which user-mode network stack a process is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    RootlessKit,
    Slirp4netns,
    Pasta,
}

/// One process of a user-mode network stack, as its command line says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stack {
    pub pid: u32,
    pub kind: Kind,
    /// Its arguments, without the program.
    pub args: Vec<String>,
}

/// Every value of `--name=value` or `--name value` in `args`, in order.
fn values<'a>(args: &'a [String], name: &str) -> Vec<&'a str> {
    args.iter()
        .enumerate()
        .filter_map(|(i, a)| {
            if a == name {
                args.get(i + 1).map(String::as_str)
            } else {
                a.strip_prefix(name)?.strip_prefix('=')
            }
        })
        .collect()
}

impl Stack {
    /// The stack a command line (`/proc/<pid>/cmdline`: NUL-separated) is, if it is one, by
    /// its program's name.
    pub fn parse(pid: u32, cmdline: &[u8]) -> Option<Self> {
        let mut argv = cmdline
            .split(|b| *b == 0)
            .map(|a| String::from_utf8_lossy(a).into_owned());
        let program = argv.next()?;
        let name = program.rsplit('/').next().unwrap_or_default();
        let kind = match name {
            "rootlesskit" => Kind::RootlessKit,
            "slirp4netns" => Kind::Slirp4netns,
            // pasta.avx2: the build pasta runs itself as where the CPU has AVX2.
            n if n == "pasta" || n.starts_with("pasta.") => Kind::Pasta,
            _ => return None,
        };
        let mut args: Vec<String> = argv.collect();
        if args.last().is_some_and(String::is_empty) {
            args.pop();
        }
        Some(Stack { pid, kind, args })
    }

    /// Where it maps the host's loopback, `None` when it does not. A setting it reads two
    /// ways is read the way that maps it.
    pub fn host_loopback(&self) -> Option<String> {
        let has = |f: &str| self.args.iter().any(|a| a == f);
        match self.kind {
            // `--disable-host-loopback`, a boolean flag: absent, or `=false`, maps it.
            Kind::RootlessKit => {
                let off = (has("--disable-host-loopback") || has("--disable-host-loopback=true"))
                    && !has("--disable-host-loopback=false");
                (!off).then(|| {
                    // Where RootlessKit's docs put it for each driver (docs/network.md).
                    match values(&self.args, "--net")
                        .last()
                        .copied()
                        .unwrap_or("host")
                    {
                        "slirp4netns" => "10.0.2.2".into(),
                        "vpnkit" => "192.168.65.2".into(),
                        "gvisor-tap-vsock" => "10.0.2.1".into(),
                        "pasta" => "its namespace's gateway".into(),
                        other => format!("--net={other}"),
                    }
                })
            }
            Kind::Slirp4netns => (!has("--disable-host-loopback")).then(|| "10.0.2.2".into()),
            // pasta maps its namespace's gateway unless `--no-map-gw` (or `--map-host-loopback
            // none`), and an address `--map-host-loopback` names whatever comes with it.
            Kind::Pasta => {
                let named = values(&self.args, "--map-host-loopback");
                match named.iter().find(|a| **a != "none") {
                    Some(a) => Some((*a).to_owned()),
                    None if has("--no-map-gw") || !named.is_empty() => None,
                    None => Some("its namespace's gateway".into()),
                }
            }
        }
    }

    fn describe(&self) -> String {
        let name = match self.kind {
            Kind::RootlessKit => "RootlessKit",
            Kind::Slirp4netns => "slirp4netns",
            Kind::Pasta => "pasta",
        };
        format!("{name} (pid {})", self.pid)
    }
}

/// The stacks among `uid`'s processes in `proc` now. A process that exits while it is read
/// is not there.
pub(crate) fn scan(proc: &Path, uid: u32) -> Vec<Stack> {
    let Ok(dir) = std::fs::read_dir(proc) else {
        return Vec::new();
    };
    let mut out: Vec<Stack> = dir
        .flatten()
        .filter_map(|e| {
            let pid = e.file_name().to_str()?.parse::<u32>().ok()?;
            if e.metadata().ok()?.uid() != uid {
                return None;
            }
            Stack::parse(pid, &std::fs::read(e.path().join("cmdline")).ok()?)
        })
        .collect();
    out.sort_by_key(|s| s.pid);
    out
}

/// Runs `f`, watching `uid`'s processes in `proc` every 100 ms until it returns, and once
/// after: what it returned, and every stack seen meanwhile.
pub(crate) fn watching<T>(proc: &Path, uid: u32, f: impl FnOnce() -> T) -> (T, Vec<Stack>) {
    let done = AtomicBool::new(false);
    std::thread::scope(|s| {
        let watcher = s.spawn(|| {
            let mut seen: Vec<Stack> = Vec::new();
            loop {
                let last = done.load(Ordering::Acquire);
                for st in scan(proc, uid) {
                    if !seen.contains(&st) {
                        seen.push(st);
                    }
                }
                if last {
                    break seen;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let out = f();
        done.store(true, Ordering::Release);
        (out, watcher.join().unwrap_or_default())
    })
}

/// What the stacks seen while the probe tasks ran say, on a rootless engine: a note when
/// every one keeps the host's loopback out, or the blocker, with `setting`, what turns the
/// mapping off on this engine; a blocker too when none was seen.
pub(crate) fn verdict(seen: &[Stack], setting: &str) -> Result<String, String> {
    if seen.is_empty() {
        return Err("egress: no network stack of this user's rootless engine (RootlessKit, slirp4netns or pasta) was seen while the probe tasks ran, so nothing says it keeps the host's loopback out of task networks: the agent runs as the rootless engine's own user (design v2 §19.3), whose processes it reads".into());
    }
    let mapped: Vec<String> = seen
        .iter()
        .filter_map(|s| {
            s.host_loopback()
                .map(|a| format!("{} at {a}", s.describe()))
        })
        .collect();
    if mapped.is_empty() {
        let names: Vec<String> = seen.iter().map(Stack::describe).collect();
        Ok(format!(
            "egress: the rootless engine's network stack maps nothing to the host's loopback ({})",
            names.join(", ")
        ))
    } else {
        Err(format!(
            "egress: the rootless engine's network stack maps this host's loopback into the networks tasks run on ({}), so a task reaches the services that trust local callers; {setting}",
            mapped.join(", ")
        ))
    }
}
