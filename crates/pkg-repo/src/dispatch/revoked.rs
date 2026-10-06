//! Revoked releases (#342, design v2 §5.2, §9.1, §16.2; D55): a release the
//! signed manifest names in `revoked` produces nothing more. Its task
//! containers are killed and reported; the pool refuses what their leases
//! send and requeues them. Every other task finishes on the release it
//! started with: a newer release never interrupts a build, a revoked one is
//! the one exception, and it is the dispatcher's, not the rollout's.
//!
//! The dispatcher's set is merged as the agent's is (§5.2: the union seen,
//! never shrinking): the `revoked` list of the manifest built into this
//! binary (factory/bundle/manifest.toml, the one release.yml signs into the
//! host bundle of this release), with every list a dispatcher of this host
//! kept before it in `<work root>/state/revoked.json` — so a dispatcher of an
//! older release, after a rollback, still kills what a newer one revoked.
//! Only signed lists go into the file. The pool's word arrives per lease, at
//! its heartbeat (409 `stop`, state `revoked`), and is acted on, never kept:
//! a pool cannot widen what this host refuses for good.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Deserialize;

use super::capacity::MANIFEST;
use super::spec;
use crate::work::say;

#[derive(Deserialize)]
struct Policy {
    #[serde(default)]
    revoked: Vec<String>,
}

/// The `revoked` list of a manifest in factory/bundle/manifest.toml's form: release names
/// only (`[a-z0-9][a-z0-9._+-]*`, as a lease's release must be), anything else refused whole.
pub fn of_manifest(text: &str) -> Result<BTreeSet<String>, String> {
    let p: Policy = toml::from_str(text).map_err(|e| format!("the manifest does not read: {e}"))?;
    p.revoked
        .into_iter()
        .map(|r| {
            if spec::name_ok(&r) {
                Ok(r)
            } else {
                Err(format!("revoked: {r:?} is not a release"))
            }
        })
        .collect()
}

/// The releases the manifest built into this binary revokes.
///
/// # Panics
/// When that manifest does not read: a broken build, which the tests catch.
pub fn signed() -> BTreeSet<String> {
    of_manifest(MANIFEST).expect("factory/bundle/manifest.toml's revoked list reads")
}

/// Where a host's dispatchers keep the lists they were signed with.
fn file(work_root: &Path) -> std::path::PathBuf {
    work_root.join("state").join("revoked.json")
}

/// This host's merged set: `signed` with every list a dispatcher of this host kept, written
/// back when it grew. The file is written as the leases are (0600, synced, renamed over the old
/// one), so a power loss leaves the old set or the new one, never a cut one. A file that does
/// not read is said, kept aside as `revoked.json.bad` and replaced by what this binary knows: it
/// only ever held signed lists, and the next one adds this release's. A file that is there but
/// cannot be read now (permissions, I/O, no descriptor left) is said and left alone: this run
/// goes on with `signed`, and the next one reads the set whole again.
pub fn merged(work_root: &Path, signed: &BTreeSet<String>) -> BTreeSet<String> {
    let path = file(work_root);
    let kept: BTreeSet<String> = match std::fs::read(&path) {
        Ok(b) => match serde_json::from_slice::<Vec<String>>(&b) {
            Ok(v) => v.into_iter().filter(|r| spec::name_ok(r)).collect(),
            Err(e) => {
                let bad = path.with_extension("json.bad");
                say(format!(
                    "{}: does not read ({e}); kept as {}, and the revoked releases of this release stand",
                    path.display(),
                    bad.display()
                ));
                if let Err(e) = std::fs::rename(&path, &bad) {
                    say(format!("{}: not kept aside: {e}", path.display()));
                }
                BTreeSet::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
        Err(e) => {
            say(format!(
                "{}: not read ({e}); it is left as it is, and this run knows only the revoked releases of this release",
                path.display()
            ));
            return signed.clone();
        }
    };
    let all: BTreeSet<String> = kept.union(signed).cloned().collect();
    if all != kept {
        if let Err(e) = write(&path, &all) {
            say(format!("{}: not written: {e}", path.display()));
        }
    }
    all
}

/// Writes the set whole: 0600, synced, renamed over the old file (as `lease::Store::save`).
fn write(path: &Path, all: &BTreeSet<String>) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(
        &serde_json::to_vec(&all.iter().collect::<Vec<_>>()).map_err(std::io::Error::other)?,
    )?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_signed_list_reads_and_a_manifest_names_releases_only() {
        // Today's manifest revokes nothing; the parser is what matters.
        let _ = signed();
        let stub = "min_release = \"v1.0.0\"\nrevoked = [\"v1.2.3\", \"v1.2.5\"]\n[capacity]\nmax_size = 4\n";
        assert_eq!(
            of_manifest(stub).unwrap(),
            BTreeSet::from(["v1.2.3".to_owned(), "v1.2.5".to_owned()])
        );
        assert!(of_manifest("min_release = \"v1.0.0\"\n")
            .unwrap()
            .is_empty());
        assert!(of_manifest("revoked = [\"../v1\"]").is_err());
        assert!(of_manifest("revoked = \"v1.2.3\"").is_err());
    }

    #[test]
    fn the_merged_set_never_shrinks_and_keeps_signed_lists_only() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("state")).unwrap();
        let newer = BTreeSet::from(["v1.2.3".to_owned()]);
        assert_eq!(merged(t.path(), &newer), newer);
        // A dispatcher of an older release, whose manifest did not revoke it yet, after a rollback.
        let older = BTreeSet::new();
        assert_eq!(merged(t.path(), &older), newer, "still revoked");
        let later = BTreeSet::from(["v1.2.4".to_owned()]);
        assert_eq!(
            merged(t.path(), &later),
            BTreeSet::from(["v1.2.3".to_owned(), "v1.2.4".to_owned()])
        );
        // A file that does not read: kept aside, this release's list stands, and is written again.
        std::fs::write(t.path().join("state/revoked.json"), "not json").unwrap();
        assert_eq!(merged(t.path(), &later), later);
        assert_eq!(
            std::fs::read_to_string(t.path().join("state/revoked.json.bad")).unwrap(),
            "not json"
        );
        assert_eq!(merged(t.path(), &BTreeSet::new()), later);
        // A name outside the grammar in the file is not a release.
        std::fs::write(
            t.path().join("state/revoked.json"),
            r#"["v1.2.4", "../etc"]"#,
        )
        .unwrap();
        assert_eq!(merged(t.path(), &BTreeSet::new()), later);
    }

    #[test]
    fn the_kept_set_is_written_private_and_a_file_that_cannot_be_read_is_left_alone() {
        use std::os::unix::fs::PermissionsExt as _;
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("state")).unwrap();
        let newer = BTreeSet::from(["v1.2.3".to_owned()]);
        assert_eq!(merged(t.path(), &newer), newer);
        let file = t.path().join("state/revoked.json");
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!t.path().join("state/revoked.json.tmp").exists());
        // Not a missing file but one that is there and cannot be read now (here a directory, as
        // root reads every file): this run knows its own list, and nothing is written over it.
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let later = BTreeSet::from(["v1.2.4".to_owned()]);
        assert_eq!(merged(t.path(), &later), later);
        assert!(file.is_dir(), "left as it was");
        assert!(
            !t.path().join("state/revoked.json.tmp").exists(),
            "no write tried"
        );
    }
}
