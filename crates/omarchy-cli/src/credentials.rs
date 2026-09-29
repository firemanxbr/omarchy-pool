//! `~/.config/omarchy-cli/credentials.toml`: an agent's grant, as
//! `omarchy-cli login` wrote it — the `oma_` token the pool handed over once,
//! the login it acts as, the agent's name, the scopes, the expiry, and the
//! API origin that granted it. Mode 0600: a file anyone else can read is
//! refused, not used. Never `/etc/omarchy-cli/config.toml`, which is the
//! machine's; and the token goes to its own origin only — an `--api` that
//! points elsewhere gets no token.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// The three scopes a grant may hold, and the tools each lists (the Worker's
/// `SCOPE_TOOLS` in worker/src/agents.ts says the same).
pub const SCOPE_TOOLS: [(&str, &[&str]); 3] = [
    ("contribute", &["request_package", "request_status"]),
    (
        "review",
        &[
            "review_claim",
            "review_release",
            "review_context",
            "submit_review",
        ],
    ),
    ("block", &["block"]),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    /// The API origin that granted the token (`scheme://host[:port]`): the only one it is sent to.
    pub origin: String,
    /// `oma_…`: shown once by the pool, which keeps its SHA-256.
    pub token: String,
    /// The grant's id (`g_…`): the person's page lists it with Revoke.
    pub grant: String,
    pub login: String,
    /// The agent's name, as the person gave it at login.
    pub agent: String,
    pub scopes: Vec<String>,
    /// RFC 3339, UTC.
    pub expires_at: String,
}

impl Credentials {
    pub fn has(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }

    /// Whether the tool is one the grant's scopes list.
    pub fn allows(&self, tool: &str) -> bool {
        SCOPE_TOOLS
            .iter()
            .any(|(scope, tools)| self.has(scope) && tools.contains(&tool))
    }

    /// Whether this credential may be sent to `api`: the same origin that granted it.
    pub fn for_api(&self, api: &str) -> bool {
        origin_of(api).is_some_and(|o| o == self.origin)
    }

    /// Whether the grant has expired at `now` (seconds since the epoch); an expiry that does not parse is expired.
    pub fn expired(&self, now: i64) -> bool {
        unix_of(&self.expires_at).is_none_or(|at| at <= now)
    }
}

/// `scheme://host[:port]` of a URL, lowercased; None for something that is not an http(s) URL.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    if host.is_empty() || host.contains('@') {
        return None;
    }
    let default = if scheme == "https" { ":443" } else { ":80" };
    Some(format!(
        "{scheme}://{}",
        host.strip_suffix(default).unwrap_or(&host)
    ))
}

/// Seconds since the epoch of an RFC 3339 UTC time (`2026-10-06T12:00:00.000Z`); None for anything else.
pub fn unix_of(time: &str) -> Option<i64> {
    let bytes = time.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || !time.ends_with('Z')
    {
        return None;
    }
    let num = |r: std::ops::Range<usize>| time.get(r)?.parse::<i64>().ok();
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Days from the civil date (H. Hinnant's algorithm), the inverse of cli.rs now().
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let yoe = shifted - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

/// Now, in seconds since the epoch.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// `$XDG_CONFIG_HOME/omarchy-cli/credentials.toml`, else `~/.config/omarchy-cli/credentials.toml`.
pub fn default_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|v| !v.is_empty())
                .map(|h| PathBuf::from(h).join(".config"))
        })?;
    Some(base.join("omarchy-cli").join("credentials.toml"))
}

/// The credentials, or None when there are none; an error for a file others may read, or one that does not parse.
pub fn load(path: &Path) -> Result<Option<Credentials>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)?.permissions().mode();
        if mode & 0o077 != 0 {
            bail!(
                "{} is readable by others (mode {:o}): refused — chmod 600 it, or run omarchy-cli logout and log in again",
                path.display(),
                mode & 0o777
            );
        }
    }
    let c: Credentials =
        toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    if !c.token.starts_with("oma_") {
        bail!("{}: not an agent's token", path.display());
    }
    Ok(Some(c))
}

/// The credentials as the file holds them, whatever its mode — what `logout` and
/// `login` read to end or keep a grant the file holds (a file others can read
/// is still this machine's grant to end); None when there is no file, or one
/// that does not parse (there is no grant in it to end).
pub fn read_any(path: &Path) -> Result<Option<Credentials>> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(toml::from_str(&t).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// An agent's name as the pool keeps it: one line, its runs of white space one space.
pub fn agent_name(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The grant a new login at `origin` for `agent` would leave live with no
/// holder: the machine keeps one credential, and the pool replaces a grant
/// only when the new one has the same agent name at the same origin. None
/// when the file holds no grant, an expired one, or the one this login
/// replaces.
pub fn orphaned_by(
    held: Option<Credentials>,
    origin: &str,
    agent: &str,
    now: i64,
) -> Option<Credentials> {
    held.filter(|c| !(c.expired(now) || (c.origin == origin && c.agent == agent_name(agent))))
}

/// Writes the credentials, mode 0600 from the first byte (the directory 0700 when it is made).
pub fn save(path: &Path, c: &Credentials) -> Result<()> {
    if let Some(dir) = path.parent() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            if !dir.exists() {
                std::fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(dir)
                    .with_context(|| format!("creating {}", dir.display()))?;
            }
        }
        #[cfg(not(unix))]
        std::fs::create_dir_all(dir)?;
    }
    let text = format!(
        "# omarchy-cli: an agent's grant (omarchy-cli login). It acts as {} through omarchy-cli's tools; keep it to yourself.\n# omarchy-cli logout revokes it on the pool and deletes this file; so does Revoke on your page.\n{}",
        c.login,
        toml::to_string(c)?
    );
    // A new file, created 0600 — never a moment readable by others — then renamed over the old one.
    let tmp = path.with_extension("toml.tmp");
    let _ = std::fs::remove_file(&tmp);
    {
        use std::io::Write;
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o
            .open(&tmp)
            .with_context(|| format!("writing {}", tmp.display()))?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Deletes the file; false when there was none.
pub fn remove(path: &Path) -> Result<bool> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e).with_context(|| format!("deleting {}", path.display())),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn sample(origin: &str, scopes: &[&str]) -> Credentials {
        Credentials {
            origin: origin.to_owned(),
            token: format!("oma_{}", "a".repeat(48)),
            grant: format!("g_{}", "b".repeat(32)),
            login: "bob".into(),
            agent: "Claude Code".into(),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            expires_at: "2999-01-01T00:00:00.000Z".into(),
        }
    }

    pub(crate) fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omarchy-cli-test-{}-{name}-{}",
            std::process::id(),
            now_unix()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn is_written_0600_in_a_0700_directory_and_read_back() {
        let dir = scratch("write");
        let path = dir.join("omarchy-cli").join("credentials.toml");
        let c = sample("https://pkgs.omarchy-pool.org", &["contribute", "review"]);
        save(&path, &c).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        assert_eq!(load(&path).unwrap(), Some(c.clone()));
        // Written again (a new login): still 0600, the new grant.
        let mut again = c;
        again.grant = format!("g_{}", "c".repeat(32));
        save(&path, &again).unwrap();
        assert_eq!(load(&path).unwrap().unwrap().grant, again.grant);
        assert!(remove(&path).unwrap());
        assert!(!remove(&path).unwrap());
        assert_eq!(load(&path).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_others_can_read_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("open");
        let path = dir.join("credentials.toml");
        save(
            &path,
            &sample("https://pkgs.omarchy-pool.org", &["contribute"]),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let e = load(&path).unwrap_err().to_string();
        assert!(e.contains("readable by others"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_bound_to_the_origin_that_granted_it() {
        let c = sample("https://pkgs.omarchy-pool.org", &["contribute"]);
        assert!(c.for_api("https://pkgs.omarchy-pool.org"));
        assert!(c.for_api("https://PKGS.omarchy-pool.org:443/"));
        assert!(!c.for_api("https://pkgs.omarchy-pool.org.evil.example"));
        assert!(!c.for_api("http://pkgs.omarchy-pool.org"));
        assert!(!c.for_api("https://omarchy-pool.org"));
        assert!(!c.for_api("https://user@pkgs.omarchy-pool.org"));
        assert_eq!(
            origin_of("http://127.0.0.1:8880/api"),
            Some("http://127.0.0.1:8880".into())
        );
    }

    #[test]
    fn a_new_login_orphans_a_live_grant_of_another_name_or_origin_and_replaces_its_own() {
        let now = now_unix();
        let held = sample("https://pkgs.omarchy-pool.org", &["contribute"]);
        // The same name at the same origin: the pool replaces it at the swap.
        assert_eq!(
            orphaned_by(
                Some(held.clone()),
                "https://pkgs.omarchy-pool.org",
                " Claude   Code ",
                now
            ),
            None
        );
        // Another name, or another origin: it would stay live, with nobody holding its token.
        assert_eq!(
            orphaned_by(
                Some(held.clone()),
                "https://pkgs.omarchy-pool.org",
                "Codex",
                now
            ),
            Some(held.clone())
        );
        assert_eq!(
            orphaned_by(
                Some(held.clone()),
                "http://127.0.0.1:8880",
                "Claude Code",
                now
            ),
            Some(held.clone())
        );
        // An expired grant, or none: nothing to orphan.
        let mut old = held;
        old.expires_at = "2001-01-01T00:00:00.000Z".into();
        assert_eq!(
            orphaned_by(Some(old), "https://pkgs.omarchy-pool.org", "Codex", now),
            None
        );
        assert_eq!(
            orphaned_by(None, "https://pkgs.omarchy-pool.org", "Codex", now),
            None
        );
        // read_any reads a file whatever its mode, and a file that does not parse holds no grant.
        let dir = scratch("read-any");
        let path = dir.join("credentials.toml");
        assert_eq!(read_any(&path).unwrap(), None);
        save(&path, &sample("https://x", &["contribute"])).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        assert_eq!(read_any(&path).unwrap().unwrap().origin, "https://x");
        std::fs::write(&path, "not toml [").unwrap();
        assert_eq!(read_any(&path).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn knows_its_expiry_and_its_tools() {
        let mut c = sample("https://x", &["contribute", "block"]);
        assert_eq!(unix_of("1970-01-02T00:00:00.000Z"), Some(86_400));
        assert_eq!(unix_of("2026-10-06T12:30:15Z"), Some(1_791_289_815));
        assert_eq!(unix_of("not a time"), None);
        assert!(!c.expired(now_unix()));
        c.expires_at = "2001-01-01T00:00:00.000Z".into();
        assert!(c.expired(now_unix()));
        assert!(c.allows("request_package") && c.allows("block"));
        assert!(!c.allows("submit_review") && !c.allows("status"));
    }
}
