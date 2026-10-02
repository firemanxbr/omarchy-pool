//! The agent keys (#317, design v2 §13.2 step 7, §14): typed on `/dev/tty`, or copied
//! from an existing file (`--agent-env-from`) after showing which keys it holds, into
//! `OMARCHY_SECRETS_DIR/agent.env` (mode 0600), outside the work root. Without them the
//! host takes no model kinds. A `GITHUB_TOKEN` among them must be public read only.

use std::path::Path;

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
