//! Enrollment, the agent's half (#321, design v2 §6.1 steps 1-5, §13.2 step 6): the
//! host key, `POST /api/v1/hosts/enroll` with the one-time token from the environment
//! (never argv), the fingerprint printed for the owner to compare, the wait for the
//! owner's Confirm, and the host worker token written for the dispatcher.
//!
//! What comes before it at install — the verified bundle, preflight, the runtime and
//! the capacity detection that writes `run/capacity.json` — is #317's and #333's; the
//! rotation every 30 days is called from the run loop (#315) through [`fetch_token`].
//! Re-running it keeps the identity: a machine that enrolled goes straight to the wait
//! or the token.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::host::{self, HostKey, Identity};
use crate::pool::{Answer, Pool};

/// Where the agent keeps its files, under its data directory (install.sh's
/// `${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-agent`).
#[derive(Debug, Clone)]
pub struct Paths {
    /// The host key and `host.json`.
    pub state: PathBuf,
    /// The host set: `etc/dispatcher.env`, `run/capacity.json`.
    pub set: PathBuf,
}

impl Paths {
    pub fn under(data: &Path) -> Self {
        Self {
            state: data.join("state"),
            set: data.join("sets").join("host"),
        }
    }
    pub fn capacity(&self) -> PathBuf {
        self.set.join("run").join("capacity.json")
    }
    pub fn dispatcher_env(&self) -> PathBuf {
        self.set.join("etc").join("dispatcher.env")
    }
}

pub struct Options {
    /// The pool's origin; `None` keeps the one this machine enrolled with, or the default.
    pub pool: Option<String>,
    pub paths: Paths,
    /// The `ome_` token, from `OMARCHY_ENROLL`; needed only for a machine not enrolled yet.
    pub token: Option<String>,
    /// How long to wait for the owner's Confirm, and how often to ask.
    pub wait: Duration,
    pub poll: Duration,
}

#[derive(Debug)]
pub enum Failure {
    /// The pool, or this machine, said no: the reason, as it was given.
    Refused(String),
    /// Nothing was decided before the wait ran out; re-running continues where it stopped.
    TimedOut(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Refused(s) | Failure::TimedOut(s) => f.write_str(s),
        }
    }
}

impl From<String> for Failure {
    fn from(s: String) -> Self {
        Failure::Refused(s)
    }
}

impl From<&str> for Failure {
    fn from(s: &str) -> Self {
        Failure::Refused(s.to_owned())
    }
}

/// A token as the site prints it: `ome_` and 48 hex digits.
pub fn valid_token(t: &str) -> bool {
    t.strip_prefix("ome_").is_some_and(|h| {
        h.len() == 48
            && h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// What the agent opens with: its key, which pool and which host — the identity this
/// machine has, if it has one.
fn open(o: &Options) -> Result<(HostKey, Option<Identity>, Pool), Failure> {
    host::private_dir(&o.paths.state)?;
    let identity = Identity::read(&o.paths.state)?;
    let origin = match (&identity, &o.pool) {
        (Some(id), Some(p)) if crate::pool::check_origin(p)? != id.pool => {
            return Err(Failure::Refused(format!(
                "this machine is {} on {}; enrolling it with {p} needs a new install",
                id.host, id.pool
            )))
        }
        (Some(id), _) => id.pool.clone(),
        (None, Some(p)) => p.clone(),
        (None, None) => crate::pool::DEFAULT_POOL.to_owned(),
    };
    let pool = Pool::new(&origin)?;
    let key = HostKey::load_or_create(&o.paths.state.join(host::KEY_FILE))?;
    Ok((key, identity, pool))
}

/// The whole enrollment: enroll (once), wait for the owner's Confirm, write the token.
pub fn run(o: &Options, out: &mut impl Write) -> Result<(), Failure> {
    let (key, identity, pool) = open(o)?;
    let id = if let Some(id) = identity {
        say(
            out,
            &format!("this machine is host {} on {}", id.host, id.pool),
        );
        id
    } else {
        let id = enroll(o, &key, &pool, out)?;
        id.write(&o.paths.state)?;
        id
    };
    say(out, &format!("host key fingerprint: {}", key.fingerprint()));
    wait_for_confirm(o, &key, &pool, &id, out)?;
    fetch_token(o, &key, &pool, &id, out)
}

/// The host worker token, fetched again (a rotation): only for a machine that enrolled.
pub fn rotate(o: &Options, out: &mut impl Write) -> Result<(), Failure> {
    let (key, identity, pool) = open(o)?;
    let id = identity.ok_or_else(|| {
        Failure::Refused("this machine has not enrolled: run the command the site printed".into())
    })?;
    fetch_token(o, &key, &pool, &id, out)
}

fn say(out: &mut impl Write, line: &str) {
    let _ = writeln!(out, "omarchy-agent: {line}");
}

fn enroll(
    o: &Options,
    key: &HostKey,
    pool: &Pool,
    out: &mut impl Write,
) -> Result<Identity, Failure> {
    let token = o.token.as_deref().ok_or_else(|| {
        Failure::Refused(
            "this machine has not enrolled yet, and OMARCHY_ENROLL is not set: add the host on your page and paste the command it prints"
                .into(),
        )
    })?;
    if !valid_token(token) {
        return Err(Failure::Refused(
            "OMARCHY_ENROLL is not a token the site prints (ome_ and 48 hex digits)".into(),
        ));
    }
    let cap_path = o.paths.capacity();
    let capacity: serde_json::Value = match std::fs::read(&cap_path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("{}: {e}", cap_path.display()))?,
        Err(e) => {
            return Err(Failure::Refused(format!(
                "{}: {e} — the capacity report comes from the capacity detection at install (#333)",
                cap_path.display()
            )))
        }
    };
    let page_kb = capacity["page_kb"]
        .as_u64()
        .ok_or_else(|| format!("{}: no page_kb", cap_path.display()))?;
    let isolation = capacity["isolation"]
        .as_str()
        .ok_or_else(|| format!("{}: no isolation", cap_path.display()))?;
    let pubkey = key.public_b64u();
    let body = serde_json::json!({
        "token": token,
        "pubkey": pubkey,
        "sig": key.sign(&host::enroll_message(token, &pubkey)),
        "hostname": hostname(),
        "os": if cfg!(target_os = "macos") { "macos" } else { "linux" },
        "arch": std::env::consts::ARCH,
        "page_kb": page_kb,
        "isolation": isolation,
        "dedicated": capacity["dedicated"].as_bool(),
        "runtime": capacity.get("runtime").cloned().unwrap_or(serde_json::Value::Null),
        "agent_version": crate::AGENT_VERSION,
        "capacity": capacity,
    });
    let a = pool.post("/api/v1/hosts/enroll", &body)?;
    if !a.ok() {
        return Err(Failure::Refused(format!(
            "the pool refused the enrollment: {}",
            a.why()
        )));
    }
    let host = a.json["host"]
        .as_str()
        .ok_or("the pool's answer names no host")?
        .to_owned();
    say(
        out,
        &format!(
            "enrolled as host {host} ({}) of {}, {} units; the pool says {}",
            a.json["name"].as_str().unwrap_or("?"),
            a.json["owner"].as_str().unwrap_or("?"),
            a.json["units"],
            a.json["fingerprint"].as_str().unwrap_or("?"),
        ),
    );
    if a.json["fingerprint"].as_str() != Some(key.fingerprint().as_str()) {
        return Err(Failure::Refused(format!(
            "the pool holds another key for {host} than this machine's {}: do not confirm it",
            key.fingerprint()
        )));
    }
    if let Some(url) = a.json["confirm"].as_str() {
        say(
            out,
            &format!("confirm it at {url}, after comparing the fingerprint below"),
        );
    }
    Ok(Identity {
        pool: pool.origin().to_owned(),
        host,
    })
}

fn wait_for_confirm(
    o: &Options,
    key: &HostKey,
    pool: &Pool,
    id: &Identity,
    out: &mut impl Write,
) -> Result<(), Failure> {
    let until = Instant::now() + o.wait;
    let mut said = false;
    loop {
        match pool.signed(key, &id.host, "GET", "/api/v1/hosts/self/state", None) {
            Ok(Answer { status: 200, json }) => match json["status"].as_str() {
                Some("active") => return Ok(()),
                Some("pending-owner") => {
                    if !said {
                        say(
                            out,
                            &format!(
                                "waiting for {} to confirm this host on the site",
                                json["owner"].as_str().unwrap_or("its owner")
                            ),
                        );
                        said = true;
                    }
                }
                Some(other) => return Err(Failure::Refused(format!("the host is {other}"))),
                None => {}
            },
            // The clock is the machine's to fix; nothing a retry changes.
            Ok(a) if a.json["code"] == "clock" => return Err(Failure::Refused(a.why())),
            Ok(a) if a.status == 401 || a.status == 403 => return Err(Failure::Refused(a.why())),
            // A 5xx, or no answer: the pool comes back; the wait goes on.
            Ok(_) | Err(_) => {}
        }
        if Instant::now() >= until {
            return Err(Failure::TimedOut(format!(
                "nobody confirmed host {} within {} min: confirm it on the site, then run `omarchy-agent enroll` again (the identity is kept)",
                id.host,
                o.wait.as_secs() / 60
            )));
        }
        std::thread::sleep(o.poll);
    }
}

/// `POST /api/v1/hosts/self/token`, signed: a new host worker token, written for the
/// dispatcher (`etc/dispatcher.env`, 0600). The one it replaces works ten more minutes,
/// in which the run loop recreates the dispatcher (#315).
pub fn fetch_token(
    o: &Options,
    key: &HostKey,
    pool: &Pool,
    id: &Identity,
    out: &mut impl Write,
) -> Result<(), Failure> {
    let a = pool.signed(key, &id.host, "POST", "/api/v1/hosts/self/token", None)?;
    if !a.ok() {
        return Err(Failure::Refused(format!(
            "the pool did not give the host worker token: {}",
            a.why()
        )));
    }
    let worker = a.json["worker"]
        .as_str()
        .ok_or("the answer names no worker")?;
    let token = a.json["token"]
        .as_str()
        .filter(|t| t.starts_with("omw_"))
        .ok_or("the answer carries no worker token")?;
    let env = o.paths.dispatcher_env();
    host::private_dir(env.parent().ok_or("no etc directory")?)?;
    host::replace(
        &env,
        format!(
            "# The host worker token (omarchy-agent, #321): the dispatcher's only, rotated every 30 days.\n# worker: {worker}\nOMARCHY_WORKER_TOKEN={token}\n"
        )
        .as_bytes(),
    )?;
    say(
        out,
        &format!(
            "host {} is registration {worker}; its token is in {} (0600), next rotation after {}",
            id.host,
            env.display(),
            a.json["rotate_after"].as_str().unwrap_or("?")
        ),
    );
    Ok(())
}

/// The machine's name as the pool takes it: a DNS label's characters, at most 63.
fn hostname() -> String {
    let raw = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_default();
    let name: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '.')
        .take(63)
        .collect();
    let name = name.trim_start_matches(['-', '.']).to_owned();
    if name.is_empty() {
        "host".to_owned()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_ome_and_48_hex_digits() {
        assert!(valid_token(&format!("ome_{}", "a1".repeat(24))));
        assert!(!valid_token(&format!("ome_{}", "A1".repeat(24))));
        assert!(!valid_token(&format!("omw_{}", "a1".repeat(24))));
        assert!(!valid_token("ome_short"));
    }

    #[test]
    fn the_hostname_is_a_dns_label_s_characters() {
        let h = hostname();
        assert!(!h.is_empty() && h.len() <= 63);
        assert!(h
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'));
    }

    #[test]
    fn no_token_and_no_identity_is_refused_before_anything_is_sent() {
        let d = std::env::temp_dir().join(format!("omarchy-agent-enroll-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let o = Options {
            pool: Some("http://127.0.0.1:9".into()),
            paths: Paths::under(&d),
            token: None,
            wait: Duration::from_secs(0),
            poll: Duration::from_millis(10),
        };
        let mut out = Vec::new();
        let e = run(&o, &mut out).unwrap_err().to_string();
        assert!(e.contains("OMARCHY_ENROLL is not set"), "{e}");
        let o = Options {
            token: Some("nope".into()),
            ..o
        };
        assert!(run(&o, &mut out)
            .unwrap_err()
            .to_string()
            .contains("not a token"));
        let o = Options {
            token: Some(format!("ome_{}", "0".repeat(48))),
            ..o
        };
        assert!(run(&o, &mut out)
            .unwrap_err()
            .to_string()
            .contains("capacity detection"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
