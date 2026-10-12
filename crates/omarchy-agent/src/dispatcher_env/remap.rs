//! The one remapped uid the agent sidecars and the probe run as on a rootful daemon with
//! userns-remap (#405, the maintainer's option (a) of 2026-10-08). Every task container and
//! sidecar there stays remapped (design v2 §19.1), so no container user is `agent.env`'s
//! owner; instead the sidecars run as [`SIDECAR_ID`] inside the daemon's user namespace, and
//! the agent's ACL on the keys file ([`crate::install::acl`]) lets that uid as the host sees
//! it read the file: the remap user's subordinate range, `dockremap`'s for `"userns-remap":
//! "default"`, which `factory/host/prep-root.sh` makes with a range of its own.
//!
//! The daemon maps container uid `n` to the `n`-th id of the remap user's `/etc/subuid` lines,
//! taken in the file's order, unsorted (`LoadIdentityMapping` in moby/sys `user/idtools_unix.go`:
//! the first line's ids from container uid 0, the next line's after them), and reads them when
//! it starts. It takes a line by the user's name or its uid; the agent reads those by name, as
//! prep-root.sh and docker itself write them. The agent reads the same lines,
//! every minute it renders `etc/dispatcher.env` and whenever it writes the keys; the
//! dispatcher maps the same uid through a container's own `uid_map` when it starts
//! (`pkg-repo`'s `dispatch::engine::Remap`) and gives the sidecar's usage directory to it. A
//! range the agent cannot read, or one that does not reach [`SIDECAR_ID`], holds the host's
//! model kinds (`OMARCHY_AGENT_HELD=userns-remap`); if the daemon maps otherwise than the file
//! says (edited since it started), the probe cannot read the keys and says so.

use std::path::{Path, PathBuf};

/// The uid and gid the agent sidecars and the probe run as inside a remapped daemon's user
/// namespace: no task container's — its root is 0, the builder the first regular uid, pacman's
/// `alpm` a system one, `nobody` 65534 — the highest below `nobody` and the overflow id 65535,
/// so within the 65536 ids docker and prep-root.sh give the remap user.
pub const SIDECAR_ID: u32 = 65_533;

/// The remap user of `"userns-remap": "default"`.
const DEFAULT_USER: &str = "dockremap";

/// Where a remapped daemon's ranges are read: its `daemon.json`, for which user it remaps
/// to, and `/etc/subuid`, for that user's ranges. Both are world-readable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Files {
    pub daemon_json: PathBuf,
    pub subuid: PathBuf,
}

impl Files {
    pub fn system() -> Self {
        Self {
            daemon_json: PathBuf::from("/etc/docker/daemon.json"),
            subuid: PathBuf::from("/etc/subuid"),
        }
    }

    /// `daemon.json` and `subuid` in `dir`: a test's.
    #[cfg(test)]
    pub fn at(dir: &Path) -> Self {
        Self {
            daemon_json: dir.join("daemon.json"),
            subuid: dir.join("subuid"),
        }
    }

    /// [`SIDECAR_ID`] as the host sees it: the uid agent.env's ACL names.
    pub fn sidecar_uid(&self) -> Result<u32, String> {
        let user = remap_user(read(&self.daemon_json)?.as_deref())
            .map_err(|e| format!("{}: {e}", self.daemon_json.display()))?;
        let subuid = read(&self.subuid)?.unwrap_or_default();
        host_id(&subuid, &user, SIDECAR_ID).map_err(|e| format!("{}: {e}", self.subuid.display()))
    }
}

/// A file's text; `None` when it is not there.
fn read(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// The user a daemon remaps to, from its `daemon.json`: `"default"` is `dockremap`, docker's
/// own, as prep-root.sh sets it; `"user"` or `"user:group"` that user. A daemon with no
/// `daemon.json`, or one that does not name it (`--userns-remap` on its command line), is taken
/// as remapping to `dockremap`.
pub fn remap_user(daemon_json: Option<&str>) -> Result<String, String> {
    let Some(text) = daemon_json.filter(|t| !t.trim().is_empty()) else {
        return Ok(DEFAULT_USER.into());
    };
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("does not read as JSON: {e}"))?;
    match v.get("userns-remap") {
        None => Ok(DEFAULT_USER.into()),
        Some(serde_json::Value::String(s)) => {
            let user = s.split(':').next().unwrap_or("").trim();
            match user {
                "" => Err(format!("userns-remap {s:?} names no user")),
                "default" => Ok(DEFAULT_USER.into()),
                u => Ok(u.to_owned()),
            }
        }
        Some(other) => Err(format!("userns-remap {other} is not a string")),
    }
}

/// Container id `inside` on the host, through `user`'s lines of `subuid` (`user:start:count`)
/// in the file's order, as the daemon maps them.
pub fn host_id(subuid: &str, user: &str, inside: u32) -> Result<u32, String> {
    let mut base = 0u64;
    let mut seen = false;
    for l in subuid.lines().map(str::trim) {
        let mut f = l.split(':');
        if f.next() != Some(user) {
            continue;
        }
        let (Some(start), Some(count), None) = (
            f.next().and_then(|s| s.parse::<u64>().ok()),
            f.next().and_then(|s| s.parse::<u64>().ok()),
            f.next(),
        ) else {
            return Err(format!("{l:?} is not {user}:<start>:<count>"));
        };
        seen = true;
        if u64::from(inside) < base + count {
            return u32::try_from(start + (u64::from(inside) - base))
                .map_err(|_| format!("{l:?} reaches past the ids there are"));
        }
        base += count;
    }
    Err(if seen {
        format!("{user}'s ranges hold {base} ids, and the agent sidecars' uid {inside} is not among them")
    } else {
        format!("no range for {user} (the daemon's userns-remap user; prep-root.sh gives dockremap one)")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #405: the agent sidecars' remapped uid on the host — the remap user daemon.json names,
    /// its /etc/subuid ranges in the file's order, as the daemon maps them — and why there is
    /// none.
    #[test]
    fn the_sidecars_uid_is_read_from_the_remap_user_s_range() {
        // daemon.json: "default" is dockremap; a user, or user:group, is that user; none named
        // (no file, no key: --userns-remap on dockerd's command line), dockremap.
        assert_eq!(remap_user(None).unwrap(), "dockremap");
        assert_eq!(remap_user(Some(" \n")).unwrap(), "dockremap");
        assert_eq!(
            remap_user(Some(
                r#"{"userns-remap":"default","default-address-pools":[]}"#
            ))
            .unwrap(),
            "dockremap"
        );
        assert_eq!(
            remap_user(Some(r#"{"cgroup-parent":"x"}"#)).unwrap(),
            "dockremap"
        );
        assert_eq!(
            remap_user(Some(r#"{"userns-remap":"remap:remapgroup"}"#)).unwrap(),
            "remap"
        );
        assert!(remap_user(Some(r#"{"userns-remap":":g"}"#)).is_err());
        assert!(remap_user(Some(r#"{"userns-remap":true}"#)).is_err());
        assert!(remap_user(Some("{")).is_err());

        // One range (prep-root.sh's, or the one docker makes itself): its start plus the uid.
        let subuid = "firemanxbr:100000:65536\nomarchy:165536:65536\ndockremap:231072:65536\n";
        assert_eq!(host_id(subuid, "dockremap", SIDECAR_ID).unwrap(), 296_605);
        assert_eq!(host_id(subuid, "dockremap", 0).unwrap(), 231_072);
        // Two ranges: the first line's ids first, in the file's order.
        let two = "dockremap:500000:1000\nx:1:1\ndockremap:300000:65536\n";
        assert_eq!(host_id(two, "dockremap", 999).unwrap(), 500_999);
        assert_eq!(
            host_id(two, "dockremap", SIDECAR_ID).unwrap(),
            300_000 + 65_533 - 1000
        );
        // A range too short for the sidecars' uid, none, or a line that does not read: none.
        let e = host_id("dockremap:231072:1000\n", "dockremap", SIDECAR_ID).unwrap_err();
        assert!(e.contains("hold 1000 ids") && e.contains("65533"), "{e}");
        let e = host_id(subuid, "remap", SIDECAR_ID).unwrap_err();
        assert!(e.contains("no range for remap"), "{e}");
        assert!(host_id("dockremap:x:65536\n", "dockremap", 0).is_err());
        assert!(host_id("dockremap:1:2:3\n", "dockremap", 0).is_err());
        assert!(host_id("dockremap:4294967295:65536\n", "dockremap", SIDECAR_ID).is_err());

        // On a machine: the files' paths in what is said.
        let d = std::env::temp_dir().join(format!("remap-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let files = Files::at(&d);
        let e = files.sidecar_uid().unwrap_err();
        assert!(
            e.contains("subuid") && e.contains("no range for dockremap"),
            "{e}"
        );
        std::fs::write(&files.subuid, subuid).unwrap();
        assert_eq!(files.sidecar_uid().unwrap(), 296_605);
        std::fs::write(&files.daemon_json, r#"{"userns-remap":"omarchy"}"#).unwrap();
        assert_eq!(files.sidecar_uid().unwrap(), 165_536 + 65_533);
        std::fs::write(&files.daemon_json, "not json").unwrap();
        assert!(files.sidecar_uid().unwrap_err().contains("daemon.json"));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
