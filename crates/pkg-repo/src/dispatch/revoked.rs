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
/// back when it grew. A file that does not read is said and replaced by what this binary
/// knows: it only ever held signed lists, and the next one adds this release's.
pub fn merged(work_root: &Path, signed: &BTreeSet<String>) -> BTreeSet<String> {
    let path = file(work_root);
    let kept: BTreeSet<String> = match std::fs::read(&path) {
        Ok(b) => match serde_json::from_slice::<Vec<String>>(&b) {
            Ok(v) => v.into_iter().filter(|r| spec::name_ok(r)).collect(),
            Err(e) => {
                say(format!(
                    "{}: does not read ({e}); the revoked releases of this release stand",
                    path.display()
                ));
                BTreeSet::new()
            }
        },
        Err(_) => BTreeSet::new(),
    };
    let all: BTreeSet<String> = kept.union(signed).cloned().collect();
    if all != kept {
        let tmp = path.with_extension("json.tmp");
        let body = serde_json::to_vec(&all.iter().collect::<Vec<_>>()).unwrap_or_default();
        if let Err(e) = std::fs::write(&tmp, body).and_then(|()| std::fs::rename(&tmp, &path)) {
            say(format!("{}: not written: {e}", path.display()));
        }
    }
    all
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
        // A file that does not read: this release's list stands, and is written again.
        std::fs::write(t.path().join("state/revoked.json"), "not json").unwrap();
        assert_eq!(merged(t.path(), &later), later);
        assert_eq!(merged(t.path(), &BTreeSet::new()), later);
        // A name outside the grammar in the file is not a release.
        std::fs::write(
            t.path().join("state/revoked.json"),
            r#"["v1.2.4", "../etc"]"#,
        )
        .unwrap();
        assert_eq!(merged(t.path(), &BTreeSet::new()), later);
    }
}
