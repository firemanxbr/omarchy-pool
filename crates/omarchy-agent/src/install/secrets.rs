//! The agent keys (#317, design v2 §13.2 step 7, §14): typed on `/dev/tty`, or copied
//! from an existing file (`--agent-env-from`) after showing which keys it holds, into
//! `OMARCHY_SECRETS_DIR/agent.env` (mode 0600), outside the work root. Without them the
//! host takes no model kinds. A `GITHUB_TOKEN` among them must be public read only.
//!
//! An empty directory where the file goes (#419) — what podman's docker API makes of a bind
//! mount's source that is not there, as it did of the keys file's on studio-vm4k while there
//! was none (`run::engine_tests` shows it on the engine) — is removed by every writer of the keys (install,
//! *Set agent keys*) and by the run loop, and said ([`clear`]); a directory with something in
//! it, a link or another user's file stays refused ([`check`]).

use std::path::Path;

use super::files;

/// The keys file's name in the secrets directory.
pub(crate) const FILE: &str = "agent.env";

/// Whether `path` (the keys file) is an empty directory (#419), which a writer of the keys
/// removes and replaces with the file; `false` for no file or the agent's own. A directory with
/// something in it, a symbolic link, another user's file or one others may write is refused.
pub(crate) fn check(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => {
            let mut entries =
                std::fs::read_dir(path).map_err(|e| format!("{}: {e}", path.display()))?;
            if entries.next().is_none() {
                Ok(true)
            } else {
                Err(format!(
                    "{}: a directory with something in it where the agent keys go: refused, left as it is (move it away, then give the keys again)",
                    path.display()
                ))
            }
        }
        _ => files::check_owner_file(path).map(|()| false),
    }
}

/// An empty directory at `dir/agent.env` removed (#419), and what to say of it; `None` when there
/// was none. A directory with something in it is refused, never emptied.
pub(crate) fn clear(dir: &Path) -> Result<Option<String>, String> {
    Ok(files::remove_empty_dir(dir, FILE)?.then(|| {
        format!(
            "{} was an empty directory, which an engine made of the agent sidecars' mount while there was no keys file (#419): removed",
            dir.join(FILE).display()
        )
    }))
}

/// `KEY=value` lines; comments and blank lines are left out. A key is a shell variable
/// name; a value holds no newline (it goes into a container's env file).
pub(crate) fn parse(text: &str) -> Result<Vec<(String, String)>, String> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let (k, v) = l
            .split_once('=')
            .ok_or_else(|| format!("line {}: not KEY=value", n + 1))?;
        let k = k.trim().strip_prefix("export ").unwrap_or(k.trim()).trim();
        let name_ok = k
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_uppercase() || b == b'_')
            && k.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
        if !name_ok {
            return Err(format!("line {}: {k:?} is not a KEY", n + 1));
        }
        let v = v.trim();
        let v = v
            .strip_prefix('"')
            .and_then(|x| x.strip_suffix('"'))
            .or_else(|| v.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
            .unwrap_or(v);
        if out.iter().any(|(o, _)| o == k) {
            return Err(format!("line {}: {k} given twice", n + 1));
        }
        out.push((k.to_owned(), v.to_owned()));
    }
    Ok(out)
}

/// The file as written: one `KEY=value` a line.
pub(crate) fn render(keys: &[(String, String)]) -> String {
    let mut s = String::from(
        "# The agent keys (omarchy-agent install, #317): the agent sidecars' only, read-only.\n",
    );
    for (k, v) in keys {
        s.push_str(k);
        s.push('=');
        s.push_str(v);
        s.push('\n');
    }
    s
}

/// Whether `secrets` is outside `work_root` and the set directory (both are mounted into
/// containers; the secrets directory never is).
pub(crate) fn outside(secrets: &Path, work_root: &Path, set_dir: &Path) -> Result<(), String> {
    for (what, d) in [("the work root", work_root), ("the set directory", set_dir)] {
        if secrets.starts_with(d) || d.starts_with(secrets) {
            return Err(format!(
                "the secrets directory {} must be outside {what} {}",
                secrets.display(),
                d.display()
            ));
        }
    }
    Ok(())
}
