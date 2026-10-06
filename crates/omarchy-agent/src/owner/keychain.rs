//! The macOS Keychain for the agent's own secrets on a Mac host (#328, design v2 §14):
//! the seal key's private half lives in the person's login keychain, not in a file, read
//! and written through `/usr/bin/security` — the system's own tool, so the agent links no
//! framework and needs no `unsafe` code. A secret never reaches an argument list (which any
//! user's `ps` shows): it is written through `security -i`, which reads its command from
//! stdin, and read back from `find-generic-password -w`'s stdout. Every item is made by
//! `security` itself and so is readable by it alone without a prompt, whichever agent
//! binary asks after a self-update.
//!
//! A `LaunchAgent` runs in the person's login session, where the login keychain is
//! unlocked. A keychain that is locked or absent (an SSH session with nobody logged in)
//! answers an error: the agent then keeps everything running and takes no sealed key
//! until it can read it.
//!
//! [`Security`] is the seam the tests fake; [`Cli`] runs the real tool.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Where the agent's items live in the keychain (their "service"); the account names the
/// item.
pub const SERVICE: &str = "org.omarchy-pool.agent";
/// `security`'s exit status when the item is not there.
const NOT_FOUND: i32 = 44;
/// No call to `security` takes longer.
const TIMEOUT: Duration = Duration::from_secs(20);

/// A keychain the agent keeps one-line secrets in: base64url text, never a quote or a
/// space, so a command line of `security -i` reads them as one word.
pub trait Security {
    /// The secret of `account`, `None` when there is no such item.
    fn find(&mut self, account: &str) -> Result<Option<String>, String>;
    /// Adds the item, or replaces its secret (`-U`).
    fn put(&mut self, account: &str, secret: &str) -> Result<(), String>;
}

/// `/usr/bin/security`, on the login keychain or (tests on a Mac) one of their own.
#[derive(Debug, Clone, Default)]
pub struct Cli {
    pub keychain: Option<PathBuf>,
}

fn word_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 512
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':' | b'/'))
}

impl Cli {
    fn security() -> Command {
        let mut c = Command::new("/usr/bin/security");
        c.env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    fn keychain_arg(&self) -> Result<Option<String>, String> {
        self.keychain
            .as_ref()
            .map(|p| {
                let s = p.display().to_string();
                if word_ok(&s) {
                    Ok(s)
                } else {
                    Err(format!("{s}: a keychain path the agent does not name"))
                }
            })
            .transpose()
    }
}

impl Security for Cli {
    fn find(&mut self, account: &str) -> Result<Option<String>, String> {
        if !word_ok(account) {
            return Err(format!("{account:?} is no account the agent keeps"));
        }
        let mut c = Self::security();
        c.args(["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
        if let Some(k) = self.keychain_arg()? {
            c.arg(k);
        }
        let out = run(c, None)?;
        match out.status {
            Some(0) => Ok(Some(out.stdout.trim_end_matches('\n').to_owned())),
            Some(NOT_FOUND) => Ok(None),
            s => Err(format!(
                "security find-generic-password: {} (exit {})",
                out.stderr.trim(),
                s.map_or_else(|| "?".to_owned(), |s| s.to_string())
            )),
        }
    }

    fn put(&mut self, account: &str, secret: &str) -> Result<(), String> {
        if !word_ok(account) || !word_ok(secret) {
            return Err("the keychain takes the agent's own one-word items only".into());
        }
        let mut line = format!("add-generic-password -U -s {SERVICE} -a {account} -w {secret}");
        if let Some(k) = self.keychain_arg()? {
            line.push(' ');
            line.push_str(&k);
        }
        line.push('\n');
        let mut c = Self::security();
        c.arg("-i");
        let out = run(c, Some(line))?;
        // `security -i` answers 0 whatever its command did: what it said is the answer.
        if out.status != Some(0) || !out.stderr.trim().is_empty() {
            return Err(format!(
                "security add-generic-password: {}",
                out.stderr.trim().chars().take(300).collect::<String>()
            ));
        }
        match self.find(account)? {
            Some(s) if s == secret => Ok(()),
            _ => Err("security add-generic-password: the item does not read back".into()),
        }
    }
}

struct Out {
    status: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs `security`, feeding `stdin`, within [`TIMEOUT`].
fn run(mut c: Command, stdin: Option<String>) -> Result<Out, String> {
    if stdin.is_some() {
        c.stdin(Stdio::piped());
    }
    let mut child = c.spawn().map_err(|e| format!("/usr/bin/security: {e}"))?;
    if let (Some(text), Some(mut w)) = (stdin, child.stdin.take()) {
        w.write_all(text.as_bytes())
            .map_err(|e| format!("/usr/bin/security: {e}"))?;
    }
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < TIMEOUT => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "/usr/bin/security did not answer within {} s",
                    TIMEOUT.as_secs()
                ));
            }
            Err(e) => return Err(format!("/usr/bin/security: {e}")),
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("/usr/bin/security: {e}"))?;
    Ok(Out {
        status: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// A keychain in memory: what the tests play a Mac's with, on any OS.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct Fake {
    pub items: std::collections::BTreeMap<String, String>,
    /// Every call fails with this (a locked keychain).
    pub locked: Option<String>,
}

#[cfg(test)]
impl Security for Fake {
    fn find(&mut self, account: &str) -> Result<Option<String>, String> {
        if let Some(e) = &self.locked {
            return Err(e.clone());
        }
        Ok(self.items.get(account).cloned())
    }
    fn put(&mut self, account: &str, secret: &str) -> Result<(), String> {
        if let Some(e) = &self.locked {
            return Err(e.clone());
        }
        self.items.insert(account.to_owned(), secret.to_owned());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_agents_own_words_reach_security() {
        assert!(word_ok("seal-key-0123456789abcdef"));
        assert!(word_ok("yN7_x-ABC"));
        for bad in [
            "",
            "two words",
            "a\"quote",
            "line\nbreak",
            "semi;colon",
            "$(x)",
        ] {
            assert!(!word_ok(bad), "{bad:?}");
        }
        let mut c = Cli {
            keychain: Some(PathBuf::from("/tmp/a keychain")),
        };
        assert!(c
            .put("seal-key-1", "abc")
            .unwrap_err()
            .contains("does not name"));
        assert!(c.find("seal key").unwrap_err().contains("no account"));
    }

    /// The real tool on a Mac (the macOS runner's `cargo test`): a keychain of the test's
    /// own, an item written through stdin and read back, replaced, and one that is not
    /// there.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_real_keychain_keeps_a_secret_written_through_stdin() {
        let dir = crate::run::state::tempdir();
        let path = dir.join("agent-test.keychain-db");
        let shell = |args: &[&str]| {
            let s = Command::new("/usr/bin/security")
                .args(args)
                .status()
                .unwrap();
            assert!(s.success(), "security {args:?}");
        };
        let p = path.display().to_string();
        shell(&["create-keychain", "-p", "test", &p]);
        shell(&["unlock-keychain", "-p", "test", &p]);
        let mut c = Cli {
            keychain: Some(path.clone()),
        };
        assert_eq!(c.find("seal-key-test").unwrap(), None);
        c.put("seal-key-test", "AAAAbbbb-_cccc").unwrap();
        assert_eq!(
            c.find("seal-key-test").unwrap().as_deref(),
            Some("AAAAbbbb-_cccc")
        );
        c.put("seal-key-test", "ddd").unwrap();
        assert_eq!(c.find("seal-key-test").unwrap().as_deref(), Some("ddd"));
        let _ = Command::new("/usr/bin/security")
            .args(["delete-keychain", &p])
            .status();
    }
}
