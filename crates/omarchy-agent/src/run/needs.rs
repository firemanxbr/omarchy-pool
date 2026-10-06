//! What only a person fixes that the agent sees of itself (#324, design v2 §18.1): linger
//! off for its user — the agent does not start at boot, and stops when that user logs out —
//! and credentials within its user's reach (install's own check, design v2 §13.3: SSH
//! private keys, a `gh` login, stored git credentials, browser profiles). Install says both
//! once, at the machine; the run loop looks again every [`EVERY_S`] and says them in the
//! report's `needs_person`, which the host page's "needs a person" box shows its owner and
//! the maintainers. Only the agent can see them: the pool reads nothing of the machine.
//!
//! Each is `{what, detail}`, `what` one of `linger` and `credentials`; a path is said, never
//! what a file holds.

use std::path::PathBuf;

/// The look is taken again this often (a home directory's walk, a file's existence).
pub(crate) const EVERY_S: i64 = 3600;
/// At most this many credentials are said (the pool keeps eight items).
const CREDENTIALS_MAX: usize = 6;

/// Where the agent looks, and its last look.
#[derive(Debug)]
pub(crate) struct SelfCheck {
    /// The agent user's home directory.
    pub home: PathBuf,
    pub user: String,
    /// `/var/lib/systemd/linger` on Linux; `None` on a Mac, where launchd starts the agent
    /// at its user's login.
    pub linger_dir: Option<PathBuf>,
    seen: Option<(i64, serde_json::Value)>,
}

impl SelfCheck {
    pub fn new(home: PathBuf, user: String, linger_dir: Option<PathBuf>) -> Self {
        Self {
            home,
            user,
            linger_dir,
            seen: None,
        }
    }

    /// The agent's own: `HOME` and `USER` (`LOGNAME`) as its service manager sets them;
    /// `None` without either, and the report says nothing then.
    pub fn system(mac: bool) -> Option<Self> {
        let home = std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)?;
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .ok()
            .filter(|u| !u.is_empty())?;
        let linger = (!mac).then(|| PathBuf::from("/var/lib/systemd/linger"));
        Some(Self::new(home, user, linger))
    }

    /// What it found, looked at again once [`EVERY_S`] passed since the last look.
    pub fn view(&mut self, now: i64) -> serde_json::Value {
        if let Some((at, v)) = &self.seen {
            if now - at < EVERY_S {
                return v.clone();
            }
        }
        let v = serde_json::Value::Array(self.look());
        self.seen = Some((now, v.clone()));
        v
    }

    fn look(&self) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        if let Some(dir) = &self.linger_dir {
            if !dir.join(&self.user).exists() {
                let u = &self.user;
                out.push(serde_json::json!({
                    "what": "linger",
                    "detail": format!("linger is off for {u}: the agent does not start at boot and stops when {u} logs out — run `sudo loginctl enable-linger {u}`"),
                }));
            }
        }
        for f in crate::install::checks::credentials(&self.home)
            .into_iter()
            .take(CREDENTIALS_MAX)
        {
            out.push(serde_json::json!({
                "what": "credentials",
                "detail": format!("credentials within the agent's reach, move them off this user: {f}"),
            }));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "omarchy-agent-test-needs-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn linger_off_and_credentials_are_said_and_looked_at_again_only_hourly() {
        let d = tmp("said");
        let (home, linger) = (d.join("home"), d.join("linger"));
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::create_dir_all(&linger).unwrap();
        fs::write(
            home.join(".ssh/id_ed25519"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();
        fs::write(home.join(".ssh/id_ed25519.pub"), "ssh-ed25519 AAAA\n").unwrap();
        let mut c = SelfCheck::new(home.clone(), "omarchy".into(), Some(linger.clone()));
        let v = c.view(1000);
        let items = v.as_array().unwrap();
        assert_eq!(items.len(), 2, "{v}");
        assert_eq!(items[0]["what"], "linger");
        assert!(items[0]["detail"]
            .as_str()
            .unwrap()
            .contains("sudo loginctl enable-linger omarchy"));
        assert_eq!(items[1]["what"], "credentials");
        let said = items[1]["detail"].as_str().unwrap();
        assert!(said.contains("an SSH private key: ") && said.ends_with("id_ed25519"));
        // A path, never what the file holds.
        assert!(!v.to_string().contains("BEGIN"));
        // Fixed at the machine: still said until the hour is up, then gone.
        fs::write(linger.join("omarchy"), "").unwrap();
        fs::remove_file(home.join(".ssh/id_ed25519")).unwrap();
        assert_eq!(c.view(1000 + EVERY_S - 1), v);
        assert_eq!(c.view(1000 + EVERY_S), serde_json::json!([]));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_mac_says_no_linger_and_credentials_are_capped() {
        let d = tmp("mac");
        let home = d.join("home");
        fs::create_dir_all(home.join(".ssh")).unwrap();
        for i in 0..10 {
            fs::write(
                home.join(format!(".ssh/key{i}")),
                "-----BEGIN RSA PRIVATE KEY-----\n",
            )
            .unwrap();
        }
        let mut c = SelfCheck::new(home, "omarchy".into(), None);
        let v = c.view(0);
        let items = v.as_array().unwrap();
        assert_eq!(items.len(), CREDENTIALS_MAX);
        assert!(items.iter().all(|i| i["what"] == "credentials"));
        let _ = fs::remove_dir_all(&d);
    }
}
