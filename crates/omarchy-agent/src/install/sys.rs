//! The machine install runs on (#317): `/dev/tty` for the person (install.sh's stdin is
//! the script itself), HTTPS to GitHub, and `systemctl` / `loginctl`.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use super::Sys;

/// The real one.
pub struct Machine {
    agent: ureq::Agent,
}

impl Default for Machine {
    fn default() -> Self {
        Machine {
            agent: ureq::Agent::config_builder()
                .tls_config(crate::pool::tls())
                .timeout_global(Some(Duration::from_secs(600)))
                .http_status_as_error(false)
                .https_only(true)
                .user_agent(format!("omarchy-agent/{}", crate::AGENT_VERSION))
                .build()
                .into(),
        }
    }
}

fn tty() -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|e| format!("no terminal to ask on (/dev/tty: {e})"))
}

fn read_line(r: &mut impl BufRead) -> Result<String, String> {
    let mut line = String::new();
    r.read_line(&mut line)
        .map_err(|e| format!("/dev/tty: {e}"))?;
    Ok(line.trim_end_matches(['\r', '\n']).to_owned())
}

/// The largest body read from GitHub (a host bundle is a few MiB; a pinned tool tens).
const MAX_BODY: u64 = 256 << 20;

impl Sys for Machine {
    fn run(&mut self, prog: &str, args: &[&str]) -> Result<String, String> {
        let o = Command::new(prog)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("{prog}: {e}"))?;
        if o.status.success() {
            Ok(String::from_utf8_lossy(&o.stdout).into_owned())
        } else {
            Err(format!(
                "{prog} {}: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr).trim()
            ))
        }
    }

    fn confirm(&mut self, text: &str) -> Result<bool, String> {
        let mut t = tty()?;
        write!(t, "{text} [y/N] ").map_err(|e| format!("/dev/tty: {e}"))?;
        let answer = read_line(&mut BufReader::new(t))?;
        Ok(matches!(answer.trim(), "y" | "Y" | "yes" | "Yes"))
    }

    fn ask_keys(&mut self, text: &str) -> Result<String, String> {
        use rustix::termios::{tcgetattr, tcsetattr, LocalModes, OptionalActions};
        let mut t = tty()?;
        writeln!(t, "{text}").map_err(|e| format!("/dev/tty: {e}"))?;
        let before = tcgetattr(&t).map_err(|e| format!("/dev/tty: {e}"))?;
        let mut quiet = before.clone();
        quiet.local_modes.remove(LocalModes::ECHO);
        tcsetattr(&t, OptionalActions::Now, &quiet).map_err(|e| format!("/dev/tty: {e}"))?;
        let mut out = String::new();
        let mut r = BufReader::new(t.try_clone().map_err(|e| format!("/dev/tty: {e}"))?);
        let read = (|| loop {
            let line = read_line(&mut r)?;
            if line.trim().is_empty() {
                return Ok::<_, String>(());
            }
            out.push_str(&line);
            out.push('\n');
            let _ = writeln!(t, "  (a line taken)");
        })();
        let _ = tcsetattr(&t, OptionalActions::Now, &before);
        read.map(|()| out)
    }

    fn github_scopes(&mut self, token: &str) -> Result<Option<String>, String> {
        let res = self
            .agent
            .get("https://api.github.com/user")
            .header("Authorization", &format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| format!("GitHub did not answer: {e}"))?;
        match res.status().as_u16() {
            200 => Ok(res
                .headers()
                .get("x-oauth-scopes")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)),
            401 => Err("GitHub refused the token (401)".into()),
            s => Err(format!("GitHub answered HTTP {s}")),
        }
    }

    fn download(&mut self, url: &str) -> Result<Vec<u8>, String> {
        let mut res = self
            .agent
            .get(url)
            .call()
            .map_err(|e| format!("{url}: {e}"))?;
        let status = res.status().as_u16();
        if status != 200 {
            return Err(format!("{url}: HTTP {status}"));
        }
        let mut body = Vec::new();
        res.body_mut()
            .with_config()
            .limit(MAX_BODY)
            .reader()
            .read_to_end(&mut body)
            .map_err(|e| format!("{url}: {e}"))?;
        Ok(body)
    }
}
