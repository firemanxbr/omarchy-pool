//! Preflight's checks (#317, design v2 §13.3, §19.1), each on what was read, so each is
//! tested on its own: the hosting requirement, credentials within the agent user's
//! reach, the task subnets, emulation, linger and the user manager, and a `GITHUB_TOKEN`'s
//! scopes. [`Report`] gathers what they find into the one screen preflight prints.

use std::fmt::Write as _;
use std::path::Path;

use crate::capacity::Isolation;

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
/// rootful daemon without remapping, installed beside its legacy set, is the recorded
/// exception until P6.
pub(crate) fn hosting(
    isolation: Isolation,
    rootful: bool,
    dedicated: bool,
    legacy: bool,
    r: &mut Report,
) {
    if rootful && !dedicated {
        r.blockers.push(
            "hosting: a rootful daemon makes the agent's user root-equivalent; it runs only on a dedicated machine or VM (--dedicated), never on a maintainer's daily login".into(),
        );
    } else if isolation == Isolation::Root && !legacy {
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

/// The other architecture, reported only in P1 (its lane turns on in P2, #338).
pub(crate) fn emulation(native: &str, page_kb: Option<u32>, binfmt_dir: &Path, r: &mut Report) {
    let foreign = if native == "aarch64" {
        "x86_64"
    } else {
        "aarch64"
    };
    let handler = binfmt_dir.join(format!("qemu-{foreign}"));
    let state = match std::fs::read_to_string(&handler) {
        Ok(t) if t.lines().next() == Some("enabled") => {
            let fix = t
                .lines()
                .find_map(|l| l.strip_prefix("flags: "))
                .is_some_and(|f| f.contains('F'));
            if fix {
                "binfmt handler on (F flag)"
            } else {
                "binfmt handler on, without the F flag containers need"
            }
        }
        Ok(_) => "binfmt handler disabled",
        Err(_) => "no binfmt handler (prep-root.sh installs it)",
    };
    let pages = match page_kb {
        Some(16) => ", 16K pages",
        _ => "",
    };
    r.notes.push(format!(
        "emulation {foreign}: {state}{pages}; reported only, the lane comes in P2"
    ));
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
