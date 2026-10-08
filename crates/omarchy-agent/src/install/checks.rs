//! Preflight's checks (#317, design v2 §13.3, §19.1), each on what was read, so each is
//! tested on its own: the hosting requirement, credentials within the agent user's
//! reach, the task subnets, emulation, linger and the user manager, and a `GITHUB_TOKEN`'s
//! scopes. [`Report`] gathers what they find into the one screen preflight prints.

use std::fmt::Write as _;
use std::path::Path;

use crate::capacity::{Capacity, Isolation};

use super::net::{self, Cidr, Route};

/// Everything preflight found: blockers stop the install; warnings and notes are shown.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub notes: Vec<String>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.blockers.is_empty()
    }

    /// The one screen: every blocker, then the warnings and what was found.
    pub fn screen(&self) -> String {
        let mut s = String::new();
        if self.blockers.is_empty() {
            s.push_str("preflight: nothing blocks the install\n");
        } else {
            let _ = writeln!(
                s,
                "preflight: {} thing(s) to fix before the install; nothing was changed:",
                self.blockers.len()
            );
            for b in &self.blockers {
                let _ = writeln!(s, "  x {b}");
            }
        }
        for w in &self.warnings {
            let _ = writeln!(s, "  ! {w}");
        }
        for n in &self.notes {
            let _ = writeln!(s, "  - {n}");
        }
        s
    }
}

/// The hosting requirement (decision D42, design v2 §19.1, §19.3): a dedicated machine
/// or VM at any level (a rootful daemon of a new host with `userns-remap`), or a
/// dedicated user on a shared machine at the `subuid` level. A maintainer's daily login —
/// `user`, or any rootful daemon, without `--dedicated` — is refused. The Studio's
/// rootful daemon without remapping, installed beside its legacy set (`--legacy`, or the
/// `legacy.json` an earlier install recorded), is the recorded exception until P6. Any
/// existing compose project named with `--legacy` grants it: it is meant for the Studio's
/// recorded set only, the warning and `rootful_exception` in `legacy.json` record it, and
/// P6 removes it.
///
/// On macOS (#320) the escape lands in a VM, not in the person's account: the `omarchy`
/// Colima VM is dedicated (`vm`, whatever runs inside it); Docker Desktop's or `OrbStack`'s
/// VM (`vm-shared`) qualifies only with the home mount removed — the caller probes that —
/// and `--dedicated`, the person's word that nothing else runs in it.
pub(crate) fn hosting(
    isolation: Isolation,
    rootful: bool,
    dedicated: bool,
    legacy: bool,
    r: &mut Report,
) {
    match isolation {
        Isolation::Vm => {
            r.notes.push(
                "isolation: vm (the dedicated omarchy VM; the Mac's files are not mounted into it)"
                    .into(),
            );
            return;
        }
        Isolation::VmShared => {
            if !dedicated {
                r.blockers.push(
                    "hosting: Docker Desktop's or OrbStack's VM is shared with your own containers: it qualifies only with the home mount removed and --dedicated, your word that nothing else runs in it (the omarchy Colima profile needs neither: factory/host/prep-mac.sh)".into(),
                );
            }
            r.notes.push("isolation: vm-shared (Docker Desktop's or OrbStack's VM, used because it is here; never installed)".into());
            return;
        }
        Isolation::Root | Isolation::User | Isolation::Subuid => {}
    }
    // Each requirement on its own, so a fresh rootful VM sees both of its blockers at once.
    if rootful && !dedicated {
        r.blockers.push(
            "hosting: a rootful daemon makes the agent's user root-equivalent; it runs only on a dedicated machine or VM (--dedicated), never on a maintainer's daily login".into(),
        );
    }
    if isolation == Isolation::Root && !legacy {
        r.blockers.push(
            "hosting: a rootful daemon on a new host needs userns-remap, so a task-container escape lands in an unprivileged subuid (factory/host/prep-root.sh sets it on a new daemon)".into(),
        );
    } else if isolation == Isolation::Root {
        r.warnings.push(
            "hosting: a rootful daemon without userns-remap, beside the legacy set: recorded as an exception until P6".into(),
        );
    } else if isolation == Isolation::User && !dedicated {
        r.blockers.push(
            "hosting: a rootless runtime at the user level runs only on a dedicated machine or VM (--dedicated); this looks like a maintainer's daily login, which is refused: on a shared machine use a dedicated Unix user with rootless podman at the subuid level".into(),
        );
    }
    r.notes.push(format!(
        "isolation: {} ({})",
        level(isolation),
        if dedicated {
            "a dedicated machine or VM"
        } else {
            "a dedicated user on a shared machine"
        }
    ));
}

/// The isolation level as the host page shows it (design v2 §19.3).
pub(crate) fn level(i: Isolation) -> &'static str {
    match i {
        Isolation::Root => "root",
        Isolation::User => "user",
        Isolation::Subuid => "subuid",
        Isolation::Vm => "vm",
        Isolation::VmShared => "vm-shared",
    }
}

/// Credentials within reach of the agent's user (design v2 §13.3): SSH private keys, a
/// `gh` login, stored git credentials, browser profiles.
pub(crate) fn credentials(home: &Path) -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(dir) = std::fs::read_dir(home.join(".ssh")) {
        let mut keys: Vec<String> = dir
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter(|e| {
                !e.path()
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case("pub"))
                    && std::fs::read(e.path())
                        .is_ok_and(|b| b.windows(11).any(|w| w == b"PRIVATE KEY"))
            })
            .map(|e| e.path().display().to_string())
            .collect();
        keys.sort();
        found.extend(keys.into_iter().map(|k| format!("an SSH private key: {k}")));
    }
    let gh = home.join(".config/gh/hosts.yml");
    if gh.exists() {
        found.push(format!("a gh login: {}", gh.display()));
    }
    let stored = home.join(".git-credentials");
    if stored.exists() {
        found.push(format!("stored git credentials: {}", stored.display()));
    }
    for cfg in [home.join(".gitconfig"), home.join(".config/git/config")] {
        if std::fs::read_to_string(&cfg).is_ok_and(|t| {
            t.lines().any(|l| {
                let l = l.trim();
                l.starts_with("helper") && l.contains('=')
            })
        }) {
            found.push(format!("a git credential helper: {}", cfg.display()));
        }
    }
    for b in [
        ".mozilla/firefox",
        ".config/google-chrome",
        ".config/chromium",
        ".config/BraveSoftware",
        ".config/microsoft-edge",
        ".config/vivaldi",
        "snap/firefox",
        ".var/app/org.mozilla.firefox",
        "Library/Application Support/Google/Chrome",
        "Library/Application Support/Firefox",
    ] {
        let p = home.join(b);
        if p.is_dir() {
            found.push(format!("a browser profile: {}", p.display()));
        }
    }
    found
}

/// Found credentials: a warning on a dedicated host ("move them off this user"), a blocker
/// for a dedicated user on a shared machine, which must not hold any.
pub(crate) fn credentials_verdict(found: &[String], dedicated: bool, r: &mut Report) {
    for f in found {
        if dedicated {
            r.warnings.push(format!(
                "credentials within the agent's reach, move them off this user: {f}"
            ));
        } else {
            r.blockers.push(format!(
                "credentials: a dedicated agent user on a shared machine holds none, and this one has {f}"
            ));
        }
    }
}

/// The task subnets against the host's routes (container bridges aside) and other
/// projects' networks on the same engine.
pub(crate) fn subnets(
    task: &[Cidr],
    routes: &[Route],
    networks: &[(String, Vec<Cidr>)],
    r: &mut Report,
) {
    for t in task {
        for route in routes
            .iter()
            .filter(|x| x.dest.len > 0 && !net::is_bridge(&x.iface))
        {
            if t.overlaps(route.dest) {
                r.blockers.push(format!(
                    "task subnets: {t} collides with the host's route to {} on {} (give --task-subnets)",
                    route.dest, route.iface
                ));
            }
        }
        for (name, cidrs) in networks {
            if let Some(c) = cidrs.iter().find(|c| t.overlaps(**c)) {
                r.blockers.push(format!(
                    "task subnets: {t} collides with the network {name} ({c}) on this engine (give --task-subnets)"
                ));
            }
        }
    }
}

/// The emulated lanes detection found (#338, design v2 §7.5), reported only: a lane held
/// for binfmt, the envelope or a smoke run that failed never stops an install, and the
/// native lane never depends on it.
pub(crate) fn emulation(c: &Capacity, r: &mut Report) {
    for l in c.lanes().iter().filter(|l| l.mode == "emulated") {
        let pages = match l.page16k {
            Some(true) => ", on pages larger than the guest's: a toolchain that cannot start here sends its build back for a native host or a lane on 4K pages (D33)",
            Some(false) => ", on 4K pages: it also takes the builds a lane on 16K pages sent back (#413)",
            None => "",
        };
        r.notes.push(format!(
            "emulation {}: on, through {}{pages}",
            l.arch,
            l.via.unwrap_or("?")
        ));
    }
    for h in c.held_lanes() {
        r.notes
            .push(format!("emulation {}: held — {}", h.arch, h.reason));
    }
}

/// The sandboxed runtime community tasks run in (#330, design v2 §10.4; D43): said, never
/// a blocker — a host without one runs them on the engine's own runtime, as before.
pub(crate) fn sandbox(c: &Capacity, r: &mut Report) {
    match c.sandbox() {
        Some(s) => r.notes.push(format!(
            "sandbox: {} ({}) — community tasks on the {} lane run in it, so a container escape lands in its kernel, not on the host's",
            s.kind.words(),
            s.runtime,
            c.lanes()[0].arch
        )),
        None => r.notes.push(
            "sandbox: none — community tasks run on the engine's own runtime; gVisor (runsc) or Kata Containers registered with the engine would hold a container escape (the runbook's *A sandboxed runtime for community tasks*)"
                .into(),
        ),
    }
    if let Some(h) = c.sandbox_held() {
        r.warnings.push(format!("sandbox: {h}"));
    }
}

/// Linger and the user manager (design v2 §13.3): linger is enabled at install when polkit
/// lets this user; without `XDG_RUNTIME_DIR` and its D-Bus socket there is no
/// `systemctl --user` to run the agent.
pub(crate) fn user_manager(
    user: &str,
    linger_dir: &Path,
    xdg_runtime_dir: Option<&Path>,
    r: &mut Report,
) {
    if linger_dir.join(user).exists() {
        r.notes.push(format!("linger: on for {user}"));
    } else {
        r.notes.push(format!(
            "linger: off for {user}; install runs `loginctl enable-linger` (polkit decides) or prints `sudo loginctl enable-linger {user}`"
        ));
    }
    match xdg_runtime_dir {
        Some(d) if d.is_dir() => {
            if !d.join("bus").exists() {
                r.blockers.push(format!(
                    "user manager: no D-Bus socket at {}/bus, so no systemctl --user (log in through a session, or enable linger and log in again)",
                    d.display()
                ));
            }
        }
        _ => r.blockers.push(
            "user manager: XDG_RUNTIME_DIR is not set or not there, so no systemctl --user (log in through a session, or enable linger and log in again)".into(),
        ),
    }
}

/// A `GITHUB_TOKEN` for the agent sidecars (design v2 §13.3, §20 item 7): public read
/// only. GitHub names a classic token's scopes in `X-OAuth-Scopes`; a token with none
/// reads public repositories and writes nothing. Any scope is refused, and so is a token
/// whose scopes GitHub does not name (fine-grained and app tokens): this agent cannot
/// tell what they may write.
pub(crate) fn github_token(scopes: Result<Option<String>, String>) -> Result<(), String> {
    match scopes {
        Err(e) => Err(format!("GITHUB_TOKEN: {e}")),
        Ok(None) => Err(
            "GITHUB_TOKEN: GitHub names no scopes for it (a fine-grained or app token), so whether it may write cannot be told: give a classic token with no scope, which reads public repositories only".into(),
        ),
        Ok(Some(s)) => {
            let scopes: Vec<&str> = s.split(',').map(str::trim).filter(|x| !x.is_empty()).collect();
            if scopes.is_empty() {
                Ok(())
            } else {
                Err(format!(
                    "GITHUB_TOKEN carries the scopes {}: the agent sidecars take a token with no scope (public read only); a write scope or private read is refused",
                    scopes.join(", ")
                ))
            }
        }
    }
}

/// Where the enrollment will make the host key (#330, design v2 §14), said before anything
/// is made, since a host keeps the key it enrolled with: in the TPM where this user may open
/// one; else a file — a note on a machine with no TPM (or a Mac), a warning where one is
/// there but out of the agent's reach (tpm2-tools, the tss group, or a running user manager
/// that started without it and so would run the agent's service without it), which the
/// owner may fix first. `OMARCHY_HOST_KEY=tpm` makes a TPM out of reach a blocker.
pub(crate) fn host_key(choice: &crate::host::KeyChoice, linux: bool, r: &mut Report) {
    use crate::host::Want;
    let tpm = if linux {
        choice.tools.reachable(&choice.tcti)
    } else {
        Err(crate::host::MAC_FILE_KEY.to_owned())
    };
    match (choice.want, tpm) {
        (Want::File, _) => r
            .notes
            .push("host key: a file, as OMARCHY_HOST_KEY=file asks".into()),
        (_, Ok(())) => r.notes.push(format!(
            "host key: made in the TPM ({}) at the enrollment, ECDSA P-256, and it never leaves it",
            choice.tcti
        )),
        (Want::Tpm, Err(why)) => r
            .blockers
            .push(format!("host key: OMARCHY_HOST_KEY=tpm, but {why}")),
        (Want::Auto, Err(why)) if !linux || why.starts_with("no TPM") => {
            r.notes.push(format!("host key: a file ({why})"));
        }
        (Want::Auto, Err(why)) => r.warnings.push(format!(
            "host key: a file, not in the TPM: {why}; a host keeps the key it enrolled with (OMARCHY_HOST_KEY=file says a file is meant)"
        )),
    }
}
