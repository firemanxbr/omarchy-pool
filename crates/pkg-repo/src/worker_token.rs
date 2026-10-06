//! The worker token, from a file or from the environment (#327, design v2 §14, D15).
//!
//! `OMARCHY_WORKER_TOKEN_FILE` names a file that holds the token: on a maintainer host the
//! agent's `run/host/dispatcher/token` (mode 0400), which the host set mounts read-only into
//! the dispatcher. It wins over `OMARCHY_WORKER_TOKEN`, whose value anyone who can talk to
//! the engine's socket reads with `docker inspect`. The plain variable keeps working: a
//! dispatcher started from an older release's template, and every worker started the old
//! way, carry the token there.
//!
//! A file that is named but cannot be read, or holds no token, is an error and never falls
//! back to the plain variable: a mount that went missing must not pass unnoticed to a token
//! that may be stale.

use std::io::Read as _;
use std::path::Path;
use std::process::Command;

use anyhow::{bail, Context as _, Result};

/// No token file is longer; one that is holds something else.
const MAX_LEN: u64 = 4096;

/// Every variable that carries a token of this process's, or names the file that holds one.
const CARRIERS: [&str; 3] = [
    "OMARCHY_TOKEN",
    "OMARCHY_WORKER_TOKEN",
    "OMARCHY_WORKER_TOKEN_FILE",
];

/// `cmd` without any of this process's tokens in its environment: a helper that fetches
/// public files or stages a trial's inputs holds none. The file's name goes too (#327): a
/// `pkg-repo` call in the helper would read the host worker token through it.
pub fn withhold(cmd: &mut Command) -> &mut Command {
    for k in CARRIERS {
        cmd.env_remove(k);
    }
    cmd
}

/// The worker token: the file's when `file` names one (an empty path names none), else the
/// plain variable's.
pub fn resolve(file: Option<&Path>, plain: Option<&str>) -> Result<String> {
    if let Some(f) = file.filter(|f| !f.as_os_str().is_empty()) {
        return from_file(f);
    }
    match plain.filter(|t| !t.is_empty()) {
        Some(t) => Ok(t.to_owned()),
        None => bail!(
            "no worker token: OMARCHY_WORKER_TOKEN_FILE (a read-only file — the host set mounts the agent's run/host/dispatcher/token there) or OMARCHY_WORKER_TOKEN (--worker-token-file, --worker-token)"
        ),
    }
}

fn from_file(f: &Path) -> Result<String> {
    let mut text = String::new();
    std::fs::File::open(f)
        .and_then(|h| h.take(MAX_LEN + 1).read_to_string(&mut text))
        .with_context(|| {
            format!(
                "OMARCHY_WORKER_TOKEN_FILE {}: the worker token cannot be read",
                f.display()
            )
        })?;
    if text.len() as u64 > MAX_LEN {
        bail!(
            "OMARCHY_WORKER_TOKEN_FILE {}: longer than a worker token",
            f.display()
        );
    }
    // One line, as the agent writes it; a trailing newline (or CR) is not part of it.
    let token = text.trim();
    if token.is_empty() {
        bail!(
            "OMARCHY_WORKER_TOKEN_FILE {}: holds no worker token",
            f.display()
        );
    }
    if !token.bytes().all(|b| b.is_ascii_graphic()) {
        bail!(
            "OMARCHY_WORKER_TOKEN_FILE {}: not one token on one line",
            f.display()
        );
    }
    Ok(token.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "pkg-repo-token-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_helper_gets_neither_a_token_nor_the_token_file_s_name() {
        let mut cmd = Command::new("true");
        cmd.env("OMARCHY_WORKER_TOKEN_FILE", "/run/omarchy/worker-token")
            .env("OMARCHY_API", "https://pkgs.omarchy-pool.org");
        withhold(&mut cmd);
        let envs: Vec<_> = cmd.get_envs().collect();
        for k in CARRIERS {
            assert!(envs.contains(&(k.as_ref(), None)), "{k} in {envs:?}");
        }
        assert!(envs.contains(&(
            "OMARCHY_API".as_ref(),
            Some("https://pkgs.omarchy-pool.org".as_ref())
        )));
    }

    #[test]
    fn the_file_wins_over_the_plain_variable() {
        let d = dir();
        let f = d.join("token");
        std::fs::write(&f, "omw_from_the_file\n").unwrap();
        assert_eq!(
            resolve(Some(&f), Some("omw_from_the_environment")).unwrap(),
            "omw_from_the_file"
        );
        // A CRLF file, or none at the end: the same token.
        std::fs::write(&f, "omw_from_the_file\r\n").unwrap();
        assert_eq!(resolve(Some(&f), None).unwrap(), "omw_from_the_file");
        std::fs::write(&f, "omw_from_the_file").unwrap();
        assert_eq!(resolve(Some(&f), None).unwrap(), "omw_from_the_file");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn the_plain_variable_still_works_without_a_file() {
        // A dispatcher started from an older release's template: the token in its environment.
        assert_eq!(resolve(None, Some("omw_plain")).unwrap(), "omw_plain");
        // An empty OMARCHY_WORKER_TOKEN_FILE names no file.
        assert_eq!(
            resolve(Some(Path::new("")), Some("omw_plain")).unwrap(),
            "omw_plain"
        );
        let e = resolve(None, Some("")).unwrap_err().to_string();
        assert!(e.contains("no worker token"), "{e}");
        assert!(resolve(None, None).is_err());
    }

    #[test]
    fn a_named_file_that_does_not_give_a_token_never_falls_back() {
        let d = dir().join("fallback");
        std::fs::create_dir_all(&d).unwrap();
        let missing = d.join("missing");
        let e = format!(
            "{:#}",
            resolve(Some(&missing), Some("omw_plain")).unwrap_err()
        );
        assert!(e.contains("cannot be read"), "{e}");
        let empty = d.join("empty");
        std::fs::write(&empty, "\n").unwrap();
        let e = resolve(Some(&empty), Some("omw_plain"))
            .unwrap_err()
            .to_string();
        assert!(e.contains("holds no worker token"), "{e}");
        let two = d.join("two");
        std::fs::write(&two, "omw_a\nOMARCHY_API=http://elsewhere\n").unwrap();
        let e = resolve(Some(&two), None).unwrap_err().to_string();
        assert!(e.contains("not one token on one line"), "{e}");
        let big = d.join("big");
        std::fs::write(&big, "a".repeat(5000)).unwrap();
        assert!(resolve(Some(&big), None).is_err());
        // A directory where the file should be (a bind of a path that did not exist).
        let e = format!("{:#}", resolve(Some(&d), Some("omw_plain")).unwrap_err());
        assert!(e.contains("cannot be read"), "{e}");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
