//! `factory/sizing/tasks.toml` (design v2 §7.4, §9.4), as the dispatcher
//! reads it from the release's own checkout: the signed per-package network
//! exception (#336). A package listed with `network = "direct"` gets a normal
//! bridge network of its own instead of an internal one and an egress
//! sidecar; nothing else is read here yet (sizes and disk budgets are P2's,
//! the pool's to apply).
//!
//! The file ships in the signed release, and CODEOWNERS makes every
//! maintainer an owner of `factory/sizing/`: an entry is a maintainer's
//! decision another maintainer approved in a pull request. A file that does
//! not read, a key outside schema 1, or an exception without its `reason`
//! fails the task: a release cannot widen a package's network by accident.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    schema: u32,
    #[serde(default)]
    package: BTreeMap<String, Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // size and disk_gb are read by the pool from P2; schema 1 holds them
struct Entry {
    size: Option<u32>,
    disk_gb: Option<u64>,
    network: Option<String>,
    reason: Option<String>,
}

/// Whether `package` has its signed exception in the release at `release_dir`.
/// No file (a release from before it) is no exception.
pub fn direct(release_dir: &Path, package: &str) -> Result<bool, String> {
    let path = release_dir.join("factory/sizing/tasks.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let file: File = toml::from_str(&text)
        .map_err(|e| format!("factory/sizing/tasks.toml does not read: {e}"))?;
    if file.schema != 1 {
        return Err(format!(
            "factory/sizing/tasks.toml is schema {}, this dispatcher reads 1",
            file.schema
        ));
    }
    let Some(entry) = file.package.get(package) else {
        return Ok(false);
    };
    match entry.network.as_deref() {
        None => Ok(false),
        Some("direct")
            if entry
                .reason
                .as_deref()
                .is_some_and(|r| !r.trim().is_empty()) =>
        {
            Ok(true)
        }
        Some("direct") => Err(format!(
            "factory/sizing/tasks.toml: {package}'s network exception has no reason"
        )),
        Some(other) => Err(format!(
            "factory/sizing/tasks.toml: {package}'s network is {other:?}; only \"direct\" exists"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(toml: &str) -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("factory/sizing")).unwrap();
        std::fs::write(t.path().join("factory/sizing/tasks.toml"), toml).unwrap();
        t
    }

    #[test]
    fn the_repositorys_own_file_reads_and_grants_nothing() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert_eq!(direct(&root, "chromium"), Ok(false));
        assert_eq!(direct(&root, "felix"), Ok(false));
    }

    #[test]
    fn an_exception_with_its_reason_gives_a_bridge_and_nothing_else_does() {
        let t = release(
            "schema = 1\n[package.\"wine\"]\nsize = 2\nnetwork = \"direct\"\nreason = \"its tests open raw sockets\"\n[package.\"chromium\"]\nsize = 4\ndisk_gb = 120\n",
        );
        assert_eq!(direct(t.path(), "wine"), Ok(true));
        assert_eq!(direct(t.path(), "chromium"), Ok(false));
        assert_eq!(direct(t.path(), "felix"), Ok(false));
        let none = tempfile::tempdir().unwrap();
        assert_eq!(
            direct(none.path(), "wine"),
            Ok(false),
            "a release before the file"
        );
    }

    #[test]
    fn a_file_outside_schema_1_fails_the_task() {
        for bad in [
            "schema = 1\n[package.\"wine\"]\nnetwork = \"direct\"\n",
            "schema = 1\n[package.\"wine\"]\nnetwork = \"host\"\nreason = \"x\"\n",
            "schema = 1\n[package.\"wine\"]\nnetwrk = \"direct\"\nreason = \"x\"\n",
            "schema = 2\n",
            "not toml",
        ] {
            assert!(direct(release(bad).path(), "wine").is_err(), "{bad}");
        }
    }
}
