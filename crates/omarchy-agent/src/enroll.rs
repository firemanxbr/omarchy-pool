//! Enrollment, the agent's half (#321, design v2 §6.1 steps 1-5, §13.2 step 6): the
//! host key, `POST /api/v1/hosts/enroll` with the one-time token from the environment
//! (never argv), the fingerprint printed for the owner to compare, the wait for the
//! owner's Confirm, and the host worker token written for the dispatcher.
//!
//! What comes before it at install — the verified bundle, preflight, the runtime and
//! the capacity detection that writes `run/capacity.json` — is #317's and #333's; a
//! rotation is `omarchy-agent token` or the pool's `rotate-token` host order (#325), both
//! through [`write_worker_token`].
//! Re-running it keeps the identity: a machine that enrolled goes straight to the wait
//! or the token — and keeps the worker token it holds, since every fetch rotates it
//! (the one it replaces works ten more minutes only, so two fetches in a row would cut
//! off a running dispatcher). Rotation is `omarchy-agent token`, and the run loop's
//! (#315).
//!
//! The token goes into its own file, `run/host/dispatcher/token` (0400, #327), which the
//! host set mounts read-only into the dispatcher, and its registration into
//! `etc/dispatcher.env` with what the agent renders beside it ([`crate::dispatcher_env`],
//! #371): the host's own addresses, and once install wrote agent.toml, the secrets directory
//! and the agent budget. Both an enrollment and a rotation render them again; one that keeps
//! its token renders them too. Every write of a token goes through
//! [`write_worker_token`], the one place that knows where it lives.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::dispatcher_env::{self, Envelope, Refresh, Rendered, Sources};
use crate::host::{self, HostKey, Identity};
use crate::pool::{shown, Answer, Pool};

/// Where the agent keeps its files, under its data directory (install.sh's
/// `${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-agent`).
#[derive(Debug, Clone)]
pub struct Paths {
    /// The data directory: agent.toml, and the public address the host's tasks leave from.
    pub data: PathBuf,
    /// The host key and `host.json`.
    pub state: PathBuf,
    /// The host set: `etc/dispatcher.env`, `run/capacity.json`, `run/host/dispatcher/token`.
    pub set: PathBuf,
}

impl Paths {
    pub fn under(data: &Path) -> Self {
        Self {
            data: data.to_path_buf(),
            state: data.join("state"),
            set: data.join("sets").join("host"),
        }
    }
    /// As installed: the set directory agent.toml names (a Mac's is outside the data
    /// directory, #320), else the default one.
    pub fn installed(data: &Path) -> Self {
        let set = std::fs::read_to_string(data.join("agent.toml"))
            .ok()
            .and_then(|t| toml::from_str::<toml::Table>(&t).ok())
            .and_then(|t| t.get("set")?.get("dir")?.as_str().map(PathBuf::from))
            .filter(|d| crate::lint::is_plain_absolute(d));
        match set {
            Some(set) => Self {
                data: data.to_path_buf(),
                state: data.join("state"),
                set,
            },
            None => Self::under(data),
        }
    }
    pub fn capacity(&self) -> PathBuf {
        self.set.join("run").join("capacity.json")
    }
    pub fn dispatcher_env(&self) -> PathBuf {
        dispatcher_env::path_in(&self.set)
    }
    pub fn token(&self) -> PathBuf {
        dispatcher_env::token_path_in(&self.set)
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
    /// Where the host's own addresses are read (`/proc/net`).
    pub sources: Sources,
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
    t.strip_prefix("ome_")
        .is_some_and(|h| all_of(h, 48, 48, lower_hex))
}

/// Whether every byte of `s` is one `ok` takes, and it has `min..=max` of them.
fn all_of(s: &str, min: usize, max: usize, ok: impl Fn(u8) -> bool) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(ok)
}

fn lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// A host id as the pool mints it: `h_` and 10 base36 characters. It goes into
/// `host.json` and every signed request's header, so nothing else is taken.
pub fn valid_host(h: &str) -> bool {
    h.strip_prefix("h_")
        .is_some_and(|r| all_of(r, 10, 10, |b| b.is_ascii_digit() || b.is_ascii_lowercase()))
}

/// A host worker token as the pool mints it: `omw_` and 48 hex digits.
pub fn valid_worker_token(t: &str) -> bool {
    t.strip_prefix("omw_")
        .is_some_and(|h| all_of(h, 48, 48, lower_hex))
}

/// A registration's id (`<login>-<host name>-<4 base36>`): letters, digits and dashes.
pub fn valid_worker_id(w: &str) -> bool {
    all_of(w, 1, 120, |b| b.is_ascii_alphanumeric() || b == b'-')
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
    let key_path = o.paths.state.join(host::KEY_FILE);
    // No identity yet: this enrollment's own key. One kept from an enrollment whose
    // answer never arrived may be a host's already (the pool's key_taken).
    let key = if identity.is_some() {
        HostKey::load_or_create(&key_path)?
    } else {
        HostKey::create_fresh(&key_path)?
    };
    Ok((key, identity, pool))
}

/// The whole enrollment: enroll (once), wait for the owner's Confirm, write the token.
pub fn run(o: &Options, out: &mut impl Write) -> Result<(), Failure> {
    let (mut key, mut identity, pool) = open(o)?;
    // A new install on the machine of a retired host (#322): the pool refuses that key for
    // good, so the new token enrolls the machine as a new host, with a new key. The old
    // identity is kept beside, renamed; nothing else is asked of the owner.
    if let (Some(id), Some(_)) = (&identity, &o.token) {
        if retired(&key, &pool, id) {
            say(
                out,
                &format!(
                    "host {} was retired: this install enrolls the machine as a new host",
                    id.host
                ),
            );
            retire_identity(&o.paths.state, &id.host)?;
            key = HostKey::create_fresh(&o.paths.state.join(host::KEY_FILE))?;
            identity = None;
        }
    }
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
    let state = wait_for_confirm(o, &key, &pool, &id, out)?;
    let env = o.paths.dispatcher_env();
    // A token is kept only with its registration (the env file's `# worker:` line), which
    // install names in agent.toml: a token file without it — an env file lost, or a write
    // stopped half-way — finishes no install, so a new token is fetched.
    if !state["token"].is_null() && worker_of(&env).is_some() {
        say(
            out,
            &format!(
                "host {} keeps its worker token ({}); `omarchy-agent token` rotates it",
                id.host,
                o.paths.token().display()
            ),
        );
        let r = rendered(o, out);
        match dispatcher_env::refresh(&env, &r)? {
            Refresh::TokenMoved => {
                said_moved(out, o);
                said_rendered(out, &env, &r);
            }
            Refresh::Written => said_rendered(out, &env, &r),
            Refresh::Unchanged => {}
            // The env file went in the meantime: as above, a new token.
            Refresh::NoFile => return fetch_token(o, &key, &pool, &id, out),
        }
        return Ok(());
    }
    fetch_token(o, &key, &pool, &id, out)
}

/// What the dispatcher's env file gets beside the token: the host's addresses now and,
/// once install wrote agent.toml, its secrets directory and agent budget. An agent.toml
/// that does not read, or names a secrets directory the dispatcher would refuse, leaves
/// those lines as they are, and says why: the token never waits on it.
fn rendered(o: &Options, out: &mut impl Write) -> Rendered {
    let envelope = match Envelope::of_data_dir(&o.paths.data) {
        None => None,
        Some(Ok(e)) if dispatcher_env::dispatcher_path(&e.secrets_dir) => Some(e),
        Some(Ok(e)) => {
            say(out, &format!("the secrets directory {} is not a path the dispatcher takes (letters, digits and / . _ - +); it is not written beside the token", e.secrets_dir.display()));
            None
        }
        Some(Err(e)) => {
            say(out, &format!("{e}: the secrets directory and the agent budget beside the token are left as they were"));
            None
        }
    };
    Rendered::now(&o.sources, &o.paths.data, envelope)
}

fn said_moved(out: &mut impl Write, o: &Options) {
    say(
        out,
        &format!(
            "the host worker token moved from {} to {} (0400), which the dispatcher reads as a read-only file (#327)",
            o.paths.dispatcher_env().display(),
            o.paths.token().display()
        ),
    );
}

fn said_rendered(out: &mut impl Write, env: &Path, r: &Rendered) {
    let addresses = dispatcher_env::addresses::joined(&r.addresses);
    say(
        out,
        &format!(
            "{} (0600) names this host's own addresses for every task's egress to refuse: {}",
            env.display(),
            if addresses.is_empty() {
                "none found"
            } else {
                addresses.as_str()
            }
        ),
    );
}

/// Whether the pool says this host is retired: its signed state refused with `retired`.
/// Any other answer — a suspension, no answer at all — is not a retirement.
fn retired(key: &HostKey, pool: &Pool, id: &Identity) -> bool {
    matches!(
        pool.signed(key, &id.host, "GET", "/api/v1/hosts/self/state", None),
        Ok(Answer { status: 403, json }) if json["status"] == "retired"
    )
}

/// The retired host's identity, renamed beside: `host.json.retired-<host>`.
fn retire_identity(state: &Path, host_id: &str) -> Result<(), Failure> {
    if !valid_host(host_id) {
        return Err(Failure::Refused(format!("{host_id}: not a host id")));
    }
    let from = state.join(host::IDENTITY_FILE);
    let to = state.join(format!("{}.retired-{host_id}", host::IDENTITY_FILE));
    std::fs::rename(&from, &to).map_err(|e| Failure::Refused(format!("{}: {e}", from.display())))
}

/// The registration the host's worker token belongs to (the `# worker:` line of the
/// dispatcher's env file, which [`write_worker_token`] writes beside the token's file): what
/// install puts in agent.toml's `worker_id` (#317). `None` without a valid token.
pub fn worker_of(env: &Path) -> Option<String> {
    if !dispatcher_env::holds_token(env) {
        return None;
    }
    std::fs::read_to_string(env).ok()?.lines().find_map(|l| {
        l.strip_prefix("# worker: ")
            .map(str::trim)
            .filter(|w| valid_worker_id(w))
            .map(str::to_owned)
    })
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
        .filter(|h| valid_host(h))
        .ok_or("the pool's answer names no host id (h_ and 10 base36 characters)")?
        .to_owned();
    say(
        out,
        &format!(
            "enrolled as host {host} ({}) of {}, {} units; the pool says {}",
            shown(a.json["name"].as_str().unwrap_or("?")),
            shown(a.json["owner"].as_str().unwrap_or("?")),
            a.json["units"]
                .as_u64()
                .map_or("?".into(), |u| u.to_string()),
            shown(a.json["fingerprint"].as_str().unwrap_or("?")),
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
            &format!(
                "confirm it at {}, after comparing the fingerprint below",
                shown(url)
            ),
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
) -> Result<serde_json::Value, Failure> {
    let until = Instant::now() + o.wait;
    let mut said = false;
    loop {
        match pool.signed(key, &id.host, "GET", "/api/v1/hosts/self/state", None) {
            Ok(Answer { status: 200, json }) => match json["status"].as_str() {
                Some("active") => return Ok(json),
                Some("pending-owner") => {
                    if !said {
                        say(
                            out,
                            &format!(
                                "waiting for {} to confirm this host on the site",
                                shown(json["owner"].as_str().unwrap_or("its owner"))
                            ),
                        );
                        said = true;
                    }
                }
                Some(other) => {
                    return Err(Failure::Refused(format!("the host is {}", shown(other))))
                }
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
/// dispatcher (its file, 0400, #327). The one it replaces works ten more minutes, in which
/// the run loop recreates the dispatcher, and only it (#315).
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
    let env = o.paths.dispatcher_env();
    // The rest of the env file is rendered again (#371): a rotation keeps the host's
    // addresses, the secrets directory, the agent budget and the owner's own lines.
    let r = rendered(o, out);
    let worker = write_worker_token(&env, &a.json, &r)?;
    say(
        out,
        &format!(
            "host {} is registration {worker}; its token is in {} (0400), next rotation after {}",
            id.host,
            o.paths.token().display(),
            shown(a.json["rotate_after"].as_str().unwrap_or("?"))
        ),
    );
    said_rendered(out, &env, &r);
    Ok(())
}

/// Writes the host worker token of the pool's answer to `POST /hosts/self/token` for the
/// dispatcher, and nowhere else: its file, `run/host/dispatcher/token` (0400, in directories
/// only the agent enters, #327), which the host set mounts read-only — and `env` (the set's
/// `etc/dispatcher.env`, 0600) gets the registration it names, the rest rendered again by
/// `r` (#371), and the token too only while a release from before #327 is here (`r.plain`).
/// The registration is returned. Enrollment's first fetch and every rotation —
/// `omarchy-agent token`, and the run loop's `rotate-token` host order (#325) — write
/// through here alone; the changed files recreate the dispatcher, and only it, at the run
/// loop's next round.
pub fn write_worker_token(
    env: &Path,
    answer: &serde_json::Value,
    r: &Rendered,
) -> Result<String, String> {
    // Anything but the pool's own shapes is refused, and nothing is written: the
    // registration goes into the dispatcher's env_file, where a newline would add a variable
    // of the pool's choosing to a container that holds the engine's socket, and the token
    // goes there too for an older release.
    let worker = answer["worker"]
        .as_str()
        .filter(|w| valid_worker_id(w))
        .ok_or("the answer names no registration (letters, digits and dashes)")?;
    let token = answer["token"]
        .as_str()
        .filter(|t| valid_worker_token(t))
        .ok_or("the answer carries no worker token (omw_ and 48 hex digits)")?;
    host::private_dir(env.parent().ok_or("no etc directory")?)?;
    dispatcher_env::write_token(env, worker, token, r)?;
    Ok(worker.to_owned())
}

/// The machine's name as the pool takes it: a DNS label's characters, at most 63.
fn hostname() -> String {
    // A Mac has neither file and exports no HOSTNAME: uname's node name (#320).
    let raw = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| {
            Some(
                rustix::system::uname()
                    .nodename()
                    .to_string_lossy()
                    .into_owned(),
            )
        })
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

    /// The host's interfaces, from a fixture: a home LAN, docker's bridges, IPv6.
    fn fixture() -> Sources {
        Sources {
            proc_net: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/addresses/home"),
            ifconfig: None,
        }
    }

    #[test]
    fn the_installed_set_directory_is_the_one_agent_toml_names() {
        // A Mac's set directory is outside the data directory (#320): `token` and `enroll`
        // write dispatcher.env there, where the VM mounts it.
        let data = crate::run::state::tempdir();
        assert_eq!(Paths::installed(&data).set, data.join("sets/host"));
        std::fs::write(
            data.join("agent.toml"),
            "[set]\ndir = \"/Users/Shared/omarchy-pool/set\"\n",
        )
        .unwrap();
        let p = Paths::installed(&data);
        assert_eq!(
            p.dispatcher_env(),
            Path::new("/Users/Shared/omarchy-pool/set/etc/dispatcher.env")
        );
        assert_eq!(p.state, data.join("state"));
        // One that is not a plain absolute path is not followed.
        std::fs::write(data.join("agent.toml"), "[set]\ndir = \"../elsewhere\"\n").unwrap();
        assert_eq!(Paths::installed(&data).set, data.join("sets/host"));
    }

    #[test]
    fn a_token_is_ome_and_48_hex_digits() {
        assert!(valid_token(&format!("ome_{}", "a1".repeat(24))));
        assert!(!valid_token(&format!("ome_{}", "A1".repeat(24))));
        assert!(!valid_token(&format!("omw_{}", "a1".repeat(24))));
        assert!(!valid_token("ome_short"));
    }

    #[test]
    fn what_the_pool_answers_is_taken_in_its_own_shapes_only() {
        let omw = format!("omw_{}", "0f".repeat(24));
        assert!(valid_worker_token(&omw));
        assert!(!valid_worker_token(&format!("{omw}\nBASH_ENV=/tmp/x")));
        assert!(!valid_worker_token(&format!("omw_{}", "0F".repeat(24))));
        assert!(!valid_worker_token("omw_x"));
        assert!(valid_worker_id("m1-rack-0a9z"));
        assert!(!valid_worker_id("m1-rack\nBASH_ENV=x"));
        assert!(!valid_worker_id(""));
        assert!(valid_host("h_0123456789"));
        assert!(!valid_host("h_012345678"));
        assert!(!valid_host("h_01234567\n9"));
        assert!(!valid_host("../../x"));
    }

    /// A pool on loopback that gives every request the same answer.
    fn pool_answering(body: String) -> String {
        use std::io::{BufRead, BufReader, Read};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", l.local_addr().unwrap());
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let mut r = BufReader::new(c.try_clone().unwrap());
                let mut len = 0;
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let _ = r.take(len).read_to_end(&mut Vec::new());
                let _ = (&c).write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        origin
    }

    /// A pool on loopback that answers each request as `answer` says, from its method,
    /// its path, its `Omarchy-Host` header and its body.
    fn pool_scripted(
        answer: impl Fn(&str, &str, &str, &[u8]) -> (u16, String) + Send + 'static,
    ) -> String {
        use std::io::{BufRead, BufReader, Read};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", l.local_addr().unwrap());
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let mut r = BufReader::new(c.try_clone().unwrap());
                let mut first = String::new();
                let _ = r.read_line(&mut first);
                let mut parts = first.split_whitespace();
                let (method, path) = (
                    parts.next().unwrap_or("").to_owned(),
                    parts.next().unwrap_or("").to_owned(),
                );
                let (mut len, mut signer) = (0, String::new());
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    if let Some(v) = lower.strip_prefix("omarchy-host:") {
                        signer = v.trim().split(';').next().unwrap_or("").to_owned();
                    }
                }
                let mut body = vec![0; len];
                let _ = r.read_exact(&mut body);
                let (status, text) = answer(&method, &path, &signer, &body);
                let _ = (&c).write_all(
                    format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                        text.len()
                    )
                    .as_bytes(),
                );
            }
        });
        origin
    }

    #[test]
    fn a_new_install_on_a_retired_host_s_machine_enrolls_a_new_host_with_a_new_key() {
        use base64::Engine;
        use sha2::Digest;
        let d = std::env::temp_dir().join(format!("omarchy-agent-retired-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let omw = format!("omw_{}", "0f".repeat(24));
        let pool = pool_scripted(move |method, path, signer, body| match (method, path) {
            // The old host's key is refused for good, with its status; the new one waits, then is active.
            ("GET", "/api/v1/hosts/self/state") if signer == "h_0000000001" => (
                403,
                r#"{"error":"old is retired","code":"host_status","status":"retired"}"#.into(),
            ),
            ("GET", "/api/v1/hosts/self/state") => (
                200,
                r#"{"status":"active","owner":"m1","token":null}"#.into(),
            ),
            ("POST", "/api/v1/hosts/enroll") => {
                let b: serde_json::Value = serde_json::from_slice(body).unwrap();
                let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(b["pubkey"].as_str().unwrap())
                    .unwrap();
                let fp = format!(
                    "SHA256:{}",
                    base64::engine::general_purpose::STANDARD_NO_PAD
                        .encode(sha2::Sha256::digest(&raw))
                );
                (
                    201,
                    serde_json::json!({"host": "h_0000000002", "name": "old", "owner": "m1", "units": 3, "fingerprint": fp}).to_string(),
                )
            }
            ("POST", "/api/v1/hosts/self/token") => (
                200,
                serde_json::json!({"worker": "m1-old-0a9z", "token": omw, "rotate_after": "later"})
                    .to_string(),
            ),
            _ => (404, "{}".into()),
        });
        let o = Options {
            pool: None,
            paths: Paths::under(&d),
            token: Some(format!("ome_{}", "0".repeat(48))),
            wait: Duration::from_secs(5),
            poll: Duration::from_millis(10),
            sources: fixture(),
        };
        // The machine was host h_0000000001 on this pool, with its key and a capacity report.
        host::private_dir(&o.paths.state).unwrap();
        let old_key = HostKey::load_or_create(&o.paths.state.join(host::KEY_FILE))
            .unwrap()
            .public_b64u();
        Identity {
            pool: pool.clone(),
            host: "h_0000000001".into(),
        }
        .write(&o.paths.state)
        .unwrap();
        std::fs::create_dir_all(o.paths.capacity().parent().unwrap()).unwrap();
        std::fs::write(
            o.paths.capacity(),
            r#"{"page_kb":4,"isolation":"root","cpus":4,"mem_gb":8,"disk_free_gb":{"work":60,"engine":40},"lanes":[{"arch":"x86_64","mode":"native"}]}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        run(&o, &mut out).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out)));
        let said = String::from_utf8_lossy(&out);
        assert!(
            said.contains(
                "host h_0000000001 was retired: this install enrolls the machine as a new host"
            ),
            "{said}"
        );
        // A new host, a new key, the old identity kept beside, the new worker token written.
        assert_eq!(
            Identity::read(&o.paths.state).unwrap().unwrap().host,
            "h_0000000002"
        );
        assert!(o
            .paths
            .state
            .join("host.json.retired-h_0000000001")
            .exists());
        let (key, _, _) = open(&o).unwrap();
        assert_ne!(key.public_b64u(), old_key);
        assert!(dispatcher_env::holds_token(&o.paths.dispatcher_env()));
        assert!(valid_worker_token(&token_in_its_file_only(&o)));
        // Beside the registration, the host's own addresses (#371); no agent.toml yet, so no
        // secrets directory and no budget.
        let env = std::fs::read_to_string(o.paths.dispatcher_env()).unwrap();
        assert!(
            env.contains("\nOMARCHY_HOST_ADDRESSES=10.8.0.2,192.168.1.20,2001:db8:1:2::/64,"),
            "{env}"
        );
        assert!(!env.contains("OMARCHY_SECRETS_DIR"), "{env}");
        assert!(
            said.contains(
                "names this host's own addresses for every task's egress to refuse: 10.8.0.2,"
            ),
            "{said}"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The host's token: in its file (0400, #327), and none in the env file, which no release
    /// here reads it from.
    fn token_in_its_file_only(o: &Options) -> String {
        let (token, mode) = dispatcher_env::read_token(&o.paths.token())
            .unwrap()
            .unwrap();
        let env = std::fs::read_to_string(o.paths.dispatcher_env()).unwrap();
        assert!(mode == 0o400 && !env.contains("omw_"), "{mode:o} {env}");
        token
    }

    #[test]
    fn a_rotation_keeps_the_addresses_and_the_owner_s_lines_and_an_enrollment_renders_them_again() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let d = std::env::temp_dir().join(format!("omarchy-agent-rotate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let n = AtomicUsize::new(0);
        let pool = pool_scripted(move |method, path, _, _| match (method, path) {
            ("GET", "/api/v1/hosts/self/state") => (
                200,
                r#"{"status":"active","owner":"m1","token":"held"}"#.into(),
            ),
            ("POST", "/api/v1/hosts/self/token") => {
                let i = n.fetch_add(1, Ordering::Relaxed);
                (
                    200,
                    serde_json::json!({"worker": "m1-rack-0a9z", "token": format!("omw_{:048x}", i + 1), "rotate_after": "later"})
                        .to_string(),
                )
            }
            _ => (404, "{}".into()),
        });
        let o = Options {
            pool: None,
            paths: Paths::under(&d),
            token: None,
            wait: Duration::from_secs(5),
            poll: Duration::from_millis(10),
            sources: fixture(),
        };
        host::private_dir(&o.paths.state).unwrap();
        HostKey::load_or_create(&o.paths.state.join(host::KEY_FILE)).unwrap();
        Identity {
            pool,
            host: "h_0123456789".into(),
        }
        .write(&o.paths.state)
        .unwrap();
        // The envelope install wrote; the token of #321's agent, and an owner's own line.
        std::fs::write(
            d.join("agent.toml"),
            "[set]\nsecrets_dir = \"/srv/omarchy-pool/host-secrets\"\n[envelope]\nagent_budget = { calls_per_day = 900 }\n",
        )
        .unwrap();
        let env = o.paths.dispatcher_env();
        host::private_dir(env.parent().unwrap()).unwrap();
        let first = format!("omw_{}", "0f".repeat(24));
        std::fs::write(
            &env,
            format!("# The host worker token (omarchy-agent, #321): the dispatcher's only, rotated every 30 days.\n# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={first}\nTZ=UTC\n"),
        )
        .unwrap();

        let mut out = Vec::new();
        rotate(&o, &mut out).unwrap();
        let text = std::fs::read_to_string(&env).unwrap();
        let token = format!("omw_{:048x}", 1);
        for want in [
            "\n# worker: m1-rack-0a9z\nOMARCHY_HOST_ADDRESSES=10.8.0.2,192.168.1.20,2001:db8:1:2::/64,2001:db8:ffff::5,fe80::/64\n",
            "\nOMARCHY_SECRETS_DIR=/srv/omarchy-pool/host-secrets\nOMARCHY_AGENT_CALLS_PER_DAY=900\nTZ=UTC\n",
        ] {
            assert!(text.contains(want), "{want:?} in:\n{text}");
        }
        assert_eq!(token_in_its_file_only(&o), token);
        assert!(String::from_utf8_lossy(&out).contains("run/host/dispatcher/token (0400)"));
        assert_eq!(
            std::fs::metadata(&env).unwrap().permissions().mode() & 0o777,
            0o600
        );

        // The owner narrows the budget; enrolling again keeps the token and renders the rest.
        std::fs::write(
            d.join("agent.toml"),
            "[set]\nsecrets_dir = \"/srv/omarchy-pool/host-secrets\"\n[envelope]\nagent_budget = { calls_per_day = 800 }\n",
        )
        .unwrap();
        let mut out = Vec::new();
        run(&o, &mut out).unwrap();
        let again = std::fs::read_to_string(&env).unwrap();
        assert_eq!(
            again,
            text.replace("CALLS_PER_DAY=900", "CALLS_PER_DAY=800")
        );
        assert!(String::from_utf8_lossy(&out).contains("keeps its worker token"));

        // An agent.toml that does not read never holds the token back: the rest stays.
        std::fs::write(
            d.join("agent.toml"),
            "[envelope]\nagent_budget = { calls_per_dai = 1 }\n",
        )
        .unwrap();
        let mut out = Vec::new();
        rotate(&o, &mut out).unwrap();
        let third = std::fs::read_to_string(&env).unwrap();
        assert_eq!(token_in_its_file_only(&o), format!("omw_{:048x}", 2));
        assert!(
            third.contains("OMARCHY_AGENT_CALLS_PER_DAY=800\n"),
            "{third}"
        );
        assert!(
            String::from_utf8_lossy(&out).contains("left as they were"),
            "{}",
            String::from_utf8_lossy(&out)
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_enrollment_run_again_over_a_token_without_its_registration_fetches_one() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        // An earlier run stopped with the token file written and no etc/dispatcher.env (or the
        // file was lost since): a token with no registration finishes no install, so running
        // the enrollment again fetches one, and writes both.
        let d = std::env::temp_dir().join(format!("omarchy-agent-halfway-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let fetched = Arc::new(AtomicUsize::new(0));
        let pool = pool_scripted({
            let fetched = Arc::clone(&fetched);
            move |method, path, _, _| match (method, path) {
                ("GET", "/api/v1/hosts/self/state") => (
                    200,
                    r#"{"status":"active","owner":"m1","token":"held"}"#.into(),
                ),
                ("POST", "/api/v1/hosts/self/token") => {
                    fetched.fetch_add(1, Ordering::Relaxed);
                    (
                        200,
                        serde_json::json!({"worker": "m1-rack-0a9z", "token": format!("omw_{}", "c3".repeat(24)), "rotate_after": "later"})
                            .to_string(),
                    )
                }
                _ => (404, "{}".into()),
            }
        });
        let o = Options {
            pool: None,
            paths: Paths::under(&d),
            token: None,
            wait: Duration::from_secs(5),
            poll: Duration::from_millis(10),
            sources: fixture(),
        };
        host::private_dir(&o.paths.state).unwrap();
        HostKey::load_or_create(&o.paths.state.join(host::KEY_FILE)).unwrap();
        Identity {
            pool,
            host: "h_0123456789".into(),
        }
        .write(&o.paths.state)
        .unwrap();
        let env = o.paths.dispatcher_env();
        host::private_dir(env.parent().unwrap()).unwrap();
        crate::run::fake::write_token_file(&o.paths.set, &format!("omw_{}", "0f".repeat(24)));
        assert!(dispatcher_env::holds_token(&env) && worker_of(&env).is_none());
        let mut out = Vec::new();
        run(&o, &mut out).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out)));
        let said = String::from_utf8_lossy(&out);
        assert!(!said.contains("keeps its worker token"), "{said}");
        assert_eq!(fetched.load(Ordering::Relaxed), 1);
        assert_eq!(worker_of(&env).as_deref(), Some("m1-rack-0a9z"));
        assert_eq!(
            token_in_its_file_only(&o),
            format!("omw_{}", "c3".repeat(24))
        );
        // Run again, it keeps that one.
        let mut out = Vec::new();
        run(&o, &mut out).unwrap();
        assert!(String::from_utf8_lossy(&out).contains("keeps its worker token"));
        assert_eq!(fetched.load(Ordering::Relaxed), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_suspended_host_keeps_its_identity_and_changes_nothing() {
        let d =
            std::env::temp_dir().join(format!("omarchy-agent-suspended-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let pool = pool_scripted(|_, _, _, _| {
            (
                403,
                r#"{"error":"box is suspended","code":"host_status","status":"suspended"}"#.into(),
            )
        });
        let o = Options {
            pool: None,
            paths: Paths::under(&d),
            token: Some(format!("ome_{}", "0".repeat(48))),
            wait: Duration::from_secs(5),
            poll: Duration::from_millis(10),
            sources: fixture(),
        };
        host::private_dir(&o.paths.state).unwrap();
        let key = HostKey::load_or_create(&o.paths.state.join(host::KEY_FILE))
            .unwrap()
            .public_b64u();
        Identity {
            pool,
            host: "h_0000000001".into(),
        }
        .write(&o.paths.state)
        .unwrap();
        // Even with a token in the environment: a suspension is not a retirement.
        let e = run(&o, &mut Vec::new()).unwrap_err().to_string();
        assert!(e.contains("box is suspended"), "{e}");
        assert_eq!(
            Identity::read(&o.paths.state).unwrap().unwrap().host,
            "h_0000000001"
        );
        assert_eq!(open(&o).unwrap().0.public_b64u(), key);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_token_or_registration_with_a_newline_is_refused_and_nothing_is_written() {
        let omw = "0f".repeat(24);
        for (answer, why) in [
            (
                format!(r#"{{"worker":"m1-rack-0a9z","token":"omw_{omw}\nBASH_ENV=/tmp/x"}}"#),
                "no worker token",
            ),
            (
                format!(r#"{{"worker":"m1\nBASH_ENV=/tmp/x","token":"omw_{omw}"}}"#),
                "no registration",
            ),
        ] {
            let d = std::env::temp_dir().join(format!(
                "omarchy-agent-token-{}-{}",
                std::process::id(),
                why.len()
            ));
            let _ = std::fs::remove_dir_all(&d);
            let o = Options {
                pool: None,
                paths: Paths::under(&d),
                token: None,
                wait: Duration::from_secs(0),
                poll: Duration::from_millis(10),
                sources: fixture(),
            };
            host::private_dir(&o.paths.state).unwrap();
            let key = HostKey::create_fresh(&o.paths.state.join(host::KEY_FILE)).unwrap();
            let pool = Pool::new(&pool_answering(answer)).unwrap();
            let id = Identity {
                pool: pool.origin().to_owned(),
                host: "h_0123456789".into(),
            };
            let e = fetch_token(&o, &key, &pool, &id, &mut Vec::new())
                .unwrap_err()
                .to_string();
            assert!(e.contains(why), "{e}");
            assert!(!o.paths.dispatcher_env().exists());
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn a_machine_with_no_identity_enrolls_with_a_new_key() {
        let d = std::env::temp_dir().join(format!("omarchy-agent-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let o = Options {
            pool: Some("http://127.0.0.1:9".into()),
            paths: Paths::under(&d),
            token: None,
            wait: Duration::from_secs(0),
            poll: Duration::from_millis(10),
            sources: fixture(),
        };
        let first = open(&o).unwrap().0.public_b64u();
        assert_ne!(open(&o).unwrap().0.public_b64u(), first);
        Identity {
            pool: "http://127.0.0.1:9".into(),
            host: "h_0123456789".into(),
        }
        .write(&o.paths.state)
        .unwrap();
        let kept = open(&o).unwrap().0.public_b64u();
        assert_eq!(open(&o).unwrap().0.public_b64u(), kept);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_worker_token_in_its_file_or_the_env_file_is_kept_and_anything_else_is_not() {
        let d = std::env::temp_dir().join(format!("omarchy-agent-holds-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let paths = Paths::under(&d);
        let env = paths.dispatcher_env();
        host::private_dir(env.parent().unwrap()).unwrap();
        let holds = || dispatcher_env::holds_token(&env);
        assert!(!holds());
        std::fs::write(&env, "# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN=\n").unwrap();
        assert!(!holds());
        assert_eq!(worker_of(&env), None);
        // Where an agent from before #327 wrote it.
        let omw = format!("omw_{}", "0f".repeat(24));
        std::fs::write(
            &env,
            format!("# worker: m1-rack-0a9z\nOMARCHY_WORKER_TOKEN={omw}\n"),
        )
        .unwrap();
        assert!(holds());
        // In its own file, the env file naming the registration only.
        std::fs::write(&env, "# worker: m1-rack-0a9z\n").unwrap();
        assert!(!holds());
        std::fs::create_dir_all(paths.token().parent().unwrap()).unwrap();
        std::fs::write(paths.token(), "omw_short\n").unwrap();
        assert!(!holds(), "a token of another shape");
        std::fs::write(paths.token(), format!("{omw}\n")).unwrap();
        assert!(holds());
        assert_eq!(worker_of(&env).as_deref(), Some("m1-rack-0a9z"));
        let _ = std::fs::remove_dir_all(&d);
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
            sources: fixture(),
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
