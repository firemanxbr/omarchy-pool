//! Owner files, written safely (#317, design v2 §13.2): every write goes through `openat`
//! with `O_NOFOLLOW` in a directory the agent owns, and a file already there that is a
//! symbolic link, another user's, or writable by others is refused, never replaced.
//!
//! A directory the agent owns is one opened without following a link at its last
//! component, owned by the agent's effective uid and writable by it alone. The new
//! content goes to a fresh file beside the target (`O_CREAT | O_EXCL | O_NOFOLLOW`) and is
//! renamed over it inside that same directory descriptor, so nothing is written through a
//! link planted in the meantime either.

use std::fs::File;
use std::io::Write as _;
use std::os::fd::OwnedFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;

use rustix::fs::{openat, renameat, unlinkat, AtFlags, Mode, OFlags};
use rustix::io::Errno;

/// The agent's effective uid: the owner every owner file must have.
pub(crate) fn euid() -> u32 {
    rustix::process::geteuid().as_raw()
}

fn said(path: &Path, e: Errno) -> String {
    if e == Errno::LOOP || e == Errno::NOTDIR {
        format!(
            "{}: a symbolic link (or not a directory); refused, not followed",
            path.display()
        )
    } else {
        format!("{}: {e}", path.display())
    }
}

/// Whether the owner or modes of `meta` make it a file the agent may not trust.
pub(crate) fn foreign(path: &Path, meta: &std::fs::Metadata) -> Option<String> {
    let uid = euid();
    if meta.uid() != uid {
        return Some(format!(
            "{}: owned by uid {}, not this agent's {uid}",
            path.display(),
            meta.uid()
        ));
    }
    if meta.mode() & 0o022 != 0 {
        return Some(format!(
            "{}: group- or world-writable (mode {:o})",
            path.display(),
            meta.mode() & 0o7777
        ));
    }
    None
}

/// Opens `dir`, a directory the agent owns.
pub(crate) fn owned_dir(dir: &Path) -> Result<OwnedFd, String> {
    let fd = rustix::fs::open(
        dir,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| said(dir, e))?;
    let f = File::from(fd);
    let meta = f
        .metadata()
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    if let Some(why) = foreign(dir, &meta) {
        return Err(why);
    }
    Ok(f.into())
}

/// Makes `dir` and its missing parents (mode 0700), then opens it as a directory the
/// agent owns. Parents that exist are left as they are.
pub(crate) fn make_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    owned_dir(dir).map(drop)
}

fn plain_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(format!("{name:?} is not a file name"));
    }
    Ok(())
}

/// Writes `bytes` to `dir/name` with `mode`, as described above.
pub(crate) fn write(dir: &Path, name: &str, bytes: &[u8], mode: u32) -> Result<(), String> {
    plain_name(name)?;
    let dfd = owned_dir(dir)?;
    let path = dir.join(name);
    match openat(
        &dfd,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => {
            let meta = File::from(fd)
                .metadata()
                .map_err(|e| format!("{}: {e}", path.display()))?;
            if !meta.is_file() {
                return Err(format!("{}: not a regular file", path.display()));
            }
            if let Some(why) = foreign(&path, &meta) {
                return Err(why);
            }
        }
        Err(e) if e == Errno::NOENT => {}
        Err(e) => return Err(said(&path, e)),
    }
    let tmp = format!(".{name}.{}.tmp", std::process::id());
    match unlinkat(&dfd, tmp.as_str(), AtFlags::empty()) {
        Ok(()) => {}
        Err(e) if e == Errno::NOENT => {}
        Err(e) => return Err(said(&dir.join(&tmp), e)),
    }
    let fd = openat(
        &dfd,
        tmp.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map_err(|e| said(&dir.join(&tmp), e))?;
    let written = (|| {
        let mut f = File::from(fd);
        f.set_permissions(std::fs::Permissions::from_mode(mode))?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = unlinkat(&dfd, tmp.as_str(), AtFlags::empty());
        return Err(format!("{}: {e}", path.display()));
    }
    renameat(&dfd, tmp.as_str(), &dfd, name).map_err(|e| {
        let _ = unlinkat(&dfd, tmp.as_str(), AtFlags::empty());
        said(&path, e)
    })
}

/// Removes `dir/name` when it is there (a link is removed, never followed).
pub(crate) fn remove(dir: &Path, name: &str) -> Result<(), String> {
    plain_name(name)?;
    let dfd = match owned_dir(dir) {
        Ok(d) => d,
        Err(_) if !dir.exists() => return Ok(()),
        Err(e) => return Err(e),
    };
    match unlinkat(&dfd, name, AtFlags::empty()) {
        Ok(()) => Ok(()),
        Err(e) if e == Errno::NOENT => Ok(()),
        Err(e) => Err(said(&dir.join(name), e)),
    }
}

/// An owner file that exists: owned by the agent and writable by it alone (preflight's
/// check of `agent.toml`, `compose.override.yml` and `.env`). A link is refused.
pub(crate) fn check_owner_file(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(format!(
            "{}: a symbolic link; owner files are never followed",
            path.display()
        )),
        Ok(m) => foreign(path, &m).map_or(Ok(()), Err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}
