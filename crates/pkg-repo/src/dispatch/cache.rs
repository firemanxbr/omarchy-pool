//! The task caches (#341, design v2 §9.3, §10.2 invariant 9, §12; D52): what makes the
//! builds a host runs at once fast, without the caches becoming a path between them.
//! Today's set mounts the whole `community/<arch>` build-cache tree into every community
//! builder, keeps "one directory per package" by the script inside the untrusted
//! container, and shares one writable pacman cache per architecture between every build,
//! where two builds race on one `.part` file and one recipe can plant a package another
//! build installs. Here the host keeps the boundaries itself:
//!
//! - **Build caches per package and trust side.** A build's task container mounts
//!   `<work>/cache/build/<trust>/<arch>/<package>` at `/build/cache` (cargo, Go, ccache)
//!   and nothing else of the cache tree: the spec cuts the path from the lease's own
//!   trust, lane and package name ([`build_dir`]), so a community recipe never reaches a
//!   project cache or another package's. An audit and a trial compile nothing and mount
//!   none.
//! - **The pacman cache, shared read-only.** Every task container mounts
//!   `<work>/cache/pacman/<arch>` read-only at `/var/cache/pacman/shared`, its pacman's
//!   first `CacheDir` (the build script's `pacman_ready`), and its own writable
//!   `<task dir>/pkgcache` at `/var/cache/pacman/pkg`, the second: pacman downloads into
//!   the first writable one, so concurrent builds never share a file they write.
//! - **Verified merge-back.** When a lease ends, what it downloaded goes aside
//!   (`cache/incoming/<arch>/<id>-<gen>`, [`collect`]) and, in a thread of its own
//!   ([`upkeep`]), into the shared cache only when each file's SHA-256 is the one the
//!   pool's signed sync database lists for that file name — every database of the ring a
//!   build resolves its dependencies from, read with pkg-repo's own database code
//!   ([`crate::syncdb`]) once its `.sig` verified with the pool's key
//!   ([`crate::sign::verify_with_keyring`]). A file no database lists, one whose bytes
//!   are not the listed ones, and one two databases list with different bytes (a task
//!   that resolves it from the other repository would find bytes it refuses, in a cache
//!   it cannot delete from) are discarded.
//! - **Caps and pruning**, from the envelope's `cache_caps` (`OMARCHY_CACHE_PACMAN_GB`,
//!   `OMARCHY_CACHE_BUILD_GB` in `etc/dispatcher.env`, written by the agent): the pacman
//!   cache keeps the two newest versions of each package and, above its cap, drops the
//!   oldest merged first, older versions before newest ones; the build caches go least
//!   recently used first, a package's whole directory at a time, never one a lease of
//!   this host mounts.
//!
//! Only the dispatcher walks into `cache/` (0700): a task mounts its parts of it, which
//! needs no walk from inside. The databases fetched, the files being merged and the use
//! stamps of the build caches are never mounted into a task.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{File, Permissions};
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use sha2::{Digest as _, Sha256};

use super::pool::Pool;
use super::spec::{self, Trust};

/// Where a task container finds the host's shared pacman cache (read-only), its own (where its pacman downloads), and its package's build cache.
pub const PACMAN_SHARED_IN: &str = "/var/cache/pacman/shared";
pub const PACMAN_OWN_IN: &str = "/var/cache/pacman/pkg";
pub const BUILD_CACHE_IN: &str = "/build/cache";

/// The ring a build resolves its dependencies from (the build script's `add_pool_repos`): its databases decide what is merged.
pub const RING: &str = "edge";
/// Every source the pool renders a database of (`worker/src/meta.ts`: `REPO_ORDER`, and
/// chaotic-aur's): a database the pool serves none of for an architecture answers 404. Each
/// one counts, the ones a task's pacman does not read too: a file name two of them list with
/// different bytes is merged from none.
pub const SOURCES: [&str; 9] = [
    "asahi",
    "asahi-alarm",
    "packages",
    "factory",
    "core",
    "extra",
    "multilib",
    "alarm",
    "chaotic",
];
/// How long the databases fetched for an architecture are read before they are fetched again.
pub const DB_FRESH: Duration = Duration::from_secs(60 * 60);
/// Between two passes of the upkeep when no lease ended (a build cache grows while its build runs).
pub const EVERY: u64 = 15 * 60;
/// How many versions of each package the shared pacman cache keeps.
pub const KEEP_VERSIONS: usize = 2;
/// The caps when the envelope sets none: a host at the signed minimum (60 GB on the work
/// root) keeps room for two builds' budgets and the floor.
pub const DEFAULT_PACMAN_GB: u64 = 10;
pub const DEFAULT_BUILD_GB: u64 = 20;
const GB: u64 = 1 << 30;

/// The pool's public key, built in: what signs its databases (`docs/omarchy-staging.pub.asc`,
/// the key a build's pacman trusts them by).
pub const POOL_KEY: &str = include_str!("../../../../docs/omarchy-staging.pub.asc");

/// The envelope's `cache_caps`, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub pacman: u64,
    pub build: u64,
}

impl Caps {
    pub fn gb(pacman_gb: u64, build_gb: u64) -> Self {
        Self {
            pacman: pacman_gb.saturating_mul(GB),
            build: build_gb.saturating_mul(GB),
        }
    }
}

impl Default for Caps {
    fn default() -> Self {
        Self::gb(DEFAULT_PACMAN_GB, DEFAULT_BUILD_GB)
    }
}

/// The shared pacman cache of one architecture.
pub fn pacman_dir(work_root: &Path, arch: &str) -> PathBuf {
    work_root.join("cache").join("pacman").join(arch)
}

/// One package's build cache on one side: the only part of the build caches its build mounts.
pub fn build_dir(work_root: &Path, trust: Trust, arch: &str, name: &str) -> PathBuf {
    work_root
        .join("cache")
        .join("build")
        .join(trust.as_str())
        .join(arch)
        .join(name)
}

/// When a lease last mounted a build cache: the dispatcher's word, out of every task's reach.
fn used_stamp(work_root: &Path, trust: Trust, arch: &str, name: &str) -> PathBuf {
    work_root
        .join("cache")
        .join("used")
        .join(trust.as_str())
        .join(arch)
        .join(name)
}

fn incoming_dir(work_root: &Path) -> PathBuf {
    work_root.join("cache").join("incoming")
}

fn db_dir(work_root: &Path, arch: &str) -> PathBuf {
    work_root.join("cache").join("syncdb").join(arch)
}

fn tmp_dir(work_root: &Path) -> PathBuf {
    work_root.join("cache").join("tmp")
}

/// A build cache is made ready for a lease and pruned under this one lock: a directory a
/// lease is about to mount is never the one the upkeep removes.
static BUILD_LOCK: Mutex<()> = Mutex::new(());

fn touch(path: &Path) -> std::io::Result<()> {
    File::options()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?
        .set_modified(SystemTime::now())
}

fn cache_root(work_root: &Path) -> std::io::Result<PathBuf> {
    let root = work_root.join("cache");
    std::fs::create_dir_all(&root)?;
    std::fs::set_permissions(&root, Permissions::from_mode(0o700))?;
    Ok(root)
}

/// A lease's caches, made before its container starts: the shared pacman cache of its lane
/// (readable by every task's root, whatever its user namespace maps it to) and, for a build,
/// its package's build cache, stamped as used now — what the build caches' pruning orders by.
pub fn ready(
    work_root: &Path,
    trust: Trust,
    arch: &str,
    name: &str,
    builds: bool,
) -> std::io::Result<()> {
    if spec::platform_of(arch).is_none() || !spec::name_ok(name) {
        return Err(std::io::Error::other(format!(
            "{name:?} for {arch:?} is outside the grammar"
        )));
    }
    cache_root(work_root)?;
    let pacman = pacman_dir(work_root, arch);
    std::fs::create_dir_all(&pacman)?;
    std::fs::set_permissions(&pacman, Permissions::from_mode(0o755))?;
    if builds {
        let _held = BUILD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        std::fs::create_dir_all(build_dir(work_root, trust, arch, name))?;
        let stamp = used_stamp(work_root, trust, arch, name);
        if let Some(p) = stamp.parent() {
            std::fs::create_dir_all(p)?;
        }
        touch(&stamp)?;
    }
    Ok(())
}

/// What a lease downloaded (`<task dir>/pkgcache`) goes aside for the merge-back before its
/// task directory is removed: `true` when it left anything. Its container is gone by then,
/// so nothing writes there any more.
pub fn collect(task_dir: &Path, work_root: &Path, arch: &str, task: u64, gen: &str) -> bool {
    if spec::platform_of(arch).is_none() || !spec::gen_ok(gen) {
        return false;
    }
    let from = task_dir.join("pkgcache");
    if !std::fs::read_dir(&from).is_ok_and(|mut d| d.next().is_some()) {
        return false;
    }
    let to = incoming_dir(work_root)
        .join(arch)
        .join(format!("{task}-{gen}"));
    let _ = std::fs::remove_dir_all(&to);
    cache_root(work_root).is_ok()
        && to
            .parent()
            .is_some_and(|p| std::fs::create_dir_all(p).is_ok())
        && std::fs::rename(&from, &to).is_ok()
}

// ---------- the signed databases ----------

/// What the pool's signed databases of one architecture list: each file name, with the
/// SHA-256 and the size of the bytes each database that lists it names.
#[derive(Debug, Default)]
pub struct Index {
    files: HashMap<String, BTreeSet<(String, u64)>>,
}

/// What the databases say of one file name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Listed {
    /// One SHA-256 (and size) for it.
    Once(String, u64),
    /// None lists it.
    Unknown,
    /// Two databases list it with different bytes.
    Ambiguous,
}

impl Index {
    /// One database's packages (gzip- or zstd-compressed, as the pool renders them).
    pub fn add(&mut self, db: &[u8]) -> std::io::Result<usize> {
        let pkgs = crate::syncdb::parse_sync_db(db)?;
        for p in &pkgs {
            self.files
                .entry(p.filename.clone())
                .or_default()
                .insert((p.sha256.to_ascii_lowercase(), p.size_download));
        }
        Ok(pkgs.len())
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn listed(&self, file: &str) -> Listed {
        match self.files.get(file) {
            None => Listed::Unknown,
            Some(s) if s.len() == 1 => s.first().map_or(Listed::Unknown, |(sha, size)| {
                Listed::Once(sha.clone(), *size)
            }),
            Some(_) => Listed::Ambiguous,
        }
    }
}

/// The key the databases are verified with: the one given (the engine tests' own pool), or
/// the one built into this binary, written where only the dispatcher reads.
pub fn key_file(work_root: &Path, given: Option<&Path>) -> std::io::Result<PathBuf> {
    if let Some(k) = given {
        return Ok(k.to_path_buf());
    }
    let path = cache_root(work_root)?.join("pool-key.asc");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(POOL_KEY) {
        let tmp = path.with_extension("asc.new");
        std::fs::write(&tmp, POOL_KEY)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(path)
}

fn db_name(source: &str) -> String {
    format!("omarchy-{source}-{RING}.db")
}

/// The databases of one architecture fetched again from the pool, when the ones here are
/// older than [`DB_FRESH`]: each into place only once its signature verified, one the pool
/// serves no longer (404) removed, one that did not come kept as it was. Returns what went
/// wrong, for the log.
pub fn refresh(
    pool: &dyn Pool,
    pool_url: &str,
    work_root: &Path,
    arch: &str,
    key: &Path,
) -> Vec<String> {
    let dir = db_dir(work_root, arch);
    let stamp = dir.join(".fetched");
    let fresh = std::fs::metadata(&stamp)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < DB_FRESH);
    if fresh {
        return Vec::new();
    }
    let mut notes = Vec::new();
    let new = dir.join(".new");
    if let Err(e) = std::fs::create_dir_all(&new) {
        return vec![format!("{}: {e}", new.display())];
    }
    let mut answered = true;
    for source in SOURCES {
        let name = db_name(source);
        let url = format!("{}/{source}/{arch}/{name}", pool_url.trim_end_matches('/'));
        let (db, sig) = (new.join(&name), new.join(format!("{name}.sig")));
        let got = pool.public_file(&url, &db).and_then(|there| {
            if there {
                pool.public_file(&format!("{url}.sig"), &sig)
            } else {
                Ok(false)
            }
        });
        match got {
            Ok(true) => match crate::sign::verify_with_keyring(&db, &sig, key) {
                Ok(()) => {
                    let placed = std::fs::rename(&db, dir.join(&name))
                        .and_then(|()| std::fs::rename(&sig, dir.join(format!("{name}.sig"))));
                    if let Err(e) = placed {
                        notes.push(format!("{name} ({arch}): {e}"));
                    }
                }
                Err(e) => notes.push(format!(
                    "{name} ({arch}): its signature does not verify with the pool's key ({}); the copy here is kept",
                    crate::orders::clean_line(&e.to_string())
                )),
            },
            Ok(false) => {
                let _ = std::fs::remove_file(dir.join(&name));
                let _ = std::fs::remove_file(dir.join(format!("{name}.sig")));
            }
            Err(e) => {
                answered = false;
                notes.push(format!(
                    "{name} ({arch}): {}; the copy here is kept",
                    crate::orders::clean_line(&e.to_string())
                ));
            }
        }
    }
    let _ = std::fs::remove_dir_all(&new);
    if answered {
        let _ = touch(&stamp);
    }
    notes
}

/// The index of one architecture from the databases here, each read only once its `.sig`
/// verifies with `key`; a database that does not verify is left out, and said.
pub fn load(work_root: &Path, arch: &str, key: &Path) -> (Index, Vec<String>) {
    let dir = db_dir(work_root, arch);
    let mut index = Index::default();
    let mut notes = Vec::new();
    for source in SOURCES {
        let name = db_name(source);
        let (db, sig) = (dir.join(&name), dir.join(format!("{name}.sig")));
        if !db.is_file() {
            continue;
        }
        if let Err(e) = crate::sign::verify_with_keyring(&db, &sig, key) {
            notes.push(format!(
                "{name} ({arch}) is not read: its signature does not verify with the pool's key ({})",
                crate::orders::clean_line(&e.to_string())
            ));
            continue;
        }
        if let Err(e) = std::fs::read(&db).and_then(|b| index.add(&b)) {
            notes.push(format!("{name} ({arch}) does not read: {e}"));
        }
    }
    (index, notes)
}

// ---------- the merge-back ----------

/// What one merge-back did with a lease's downloads.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Merged {
    /// Copied into the shared cache: the bytes the databases list.
    pub merged: usize,
    pub bytes: u64,
    /// Listed and already there.
    pub present: usize,
    /// Listed with other bytes (or another size): discarded.
    pub mismatched: usize,
    /// Listed by no database (a `.part`, a recipe's own file): discarded.
    pub unknown: usize,
    /// Listed by two databases with different bytes: discarded.
    pub ambiguous: usize,
    /// Not a regular file, or a name no package has: discarded.
    pub refused: usize,
}

impl Merged {
    fn add(&mut self, o: &Merged) {
        self.merged += o.merged;
        self.bytes += o.bytes;
        self.present += o.present;
        self.mismatched += o.mismatched;
        self.unknown += o.unknown;
        self.ambiguous += o.ambiguous;
        self.refused += o.refused;
    }

    fn discarded(&self) -> usize {
        self.mismatched + self.unknown + self.ambiguous + self.refused
    }
}

/// A package file's name as a database names it: plain, no path, no dot first.
fn file_name_ok(f: &str) -> bool {
    !f.is_empty()
        && f.len() <= 255
        && !f.starts_with('.')
        && f.contains(".pkg.tar")
        && f.bytes().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, b'@' | b'.' | b'_' | b'+' | b'-' | b':' | b'~')
        })
}

/// `src` copied to `tmp` (0644, made new) while its SHA-256 is computed, without following
/// a link, stopping past `size` bytes: whether the copy is exactly the listed bytes.
fn copy_verified(src: &Path, tmp: &Path, sha: &str, size: u64) -> std::io::Result<bool> {
    use rustix::fs::{Mode, OFlags};
    let fd = rustix::fs::open(
        src,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let mut from = File::from(fd);
    if !from.metadata()?.is_file() {
        return Ok(false);
    }
    let mut to = File::options()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(tmp)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > size {
            return Ok(false);
        }
        hasher.update(&buf[..n]);
        to.write_all(&buf[..n])?;
    }
    to.flush()?;
    Ok(total == size && hex::encode(hasher.finalize()) == sha)
}

/// One lease's downloads (`incoming`) merged into the shared cache `shared` by `index`:
/// each file listed once, with its size and SHA-256, is copied in (through `tmp`, on the
/// same file system, renamed into place: a task never sees half of one); every other is
/// discarded. `incoming` itself is left to the caller.
pub fn merge(incoming: &Path, shared: &Path, tmp: &Path, index: &Index) -> Merged {
    let mut m = Merged::default();
    let Ok(entries) = std::fs::read_dir(incoming) else {
        return m;
    };
    let _ = std::fs::create_dir_all(tmp);
    for e in entries.flatten() {
        let Ok(name) = e.file_name().into_string() else {
            m.refused += 1;
            continue;
        };
        // `DirEntry::metadata` does not follow a link: a link, a directory (pacman's own
        // download directories) or a device is nothing to merge.
        if !e.metadata().is_ok_and(|md| md.file_type().is_file()) || !file_name_ok(&name) {
            m.refused += 1;
            continue;
        }
        let (sha, size) = match index.listed(&name) {
            Listed::Once(sha, size) => (sha, size),
            Listed::Unknown => {
                m.unknown += 1;
                continue;
            }
            Listed::Ambiguous => {
                m.ambiguous += 1;
                continue;
            }
        };
        let dest = shared.join(&name);
        if dest.symlink_metadata().is_ok() {
            m.present += 1;
            continue;
        }
        // One file at a time, under a name of its own: a package's name may already be 255 bytes long.
        let part = tmp.join("merging.part");
        let _ = std::fs::remove_file(&part);
        let ok = copy_verified(&e.path(), &part, &sha, size).unwrap_or(false)
            && std::fs::set_permissions(&part, Permissions::from_mode(0o644)).is_ok()
            && std::fs::rename(&part, &dest).is_ok();
        if ok {
            m.merged += 1;
            m.bytes += size;
        } else {
            let _ = std::fs::remove_file(&part);
            m.mismatched += 1;
        }
    }
    m
}

// ---------- pruning ----------

/// What one pruning removed, and what is left.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Pruned {
    /// Files of the pacman cache, or packages' build caches.
    pub removed: usize,
    pub freed: u64,
    pub left: u64,
}

/// `<name>-<pkgver>-<pkgrel>-<arch>.pkg.tar.<ext>`: the package (name and architecture) and its version.
pub fn package_of(file: &str) -> Option<(String, String)> {
    let (stem, _) = file.split_once(".pkg.tar")?;
    let mut it = stem.rsplitn(4, '-');
    let (arch, rel, ver, name) = (it.next()?, it.next()?, it.next()?, it.next()?);
    (![arch, rel, ver, name].iter().any(|s| s.is_empty()))
        .then(|| (format!("{name} {arch}"), format!("{ver}-{rel}")))
}

/// The shared pacman caches `dirs` (one per architecture) pruned: the two newest versions of
/// each package kept, then, while they hold more than `cap` bytes, the oldest merged
/// removed first, a package's older version before any newest one.
pub fn prune_pacman(dirs: &[PathBuf], cap: u64) -> Pruned {
    struct File {
        path: PathBuf,
        len: u64,
        at: SystemTime,
        newest: bool,
    }
    let mut out = Pruned::default();
    let mut kept: Vec<File> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut by_package: BTreeMap<String, Vec<(String, File)>> = BTreeMap::new();
        for e in entries.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if !md.file_type().is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let f = File {
                path: e.path(),
                len: md.len(),
                at: md.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                newest: false,
            };
            // A file whose name says no version is a package of its own.
            let (pkg, ver) = package_of(&name).unwrap_or_else(|| (name.clone(), String::new()));
            by_package.entry(pkg).or_default().push((ver, f));
        }
        for (_, mut versions) in by_package {
            versions.sort_by(|(a, _), (b, _)| pkg_manifest::vercmp(b, a));
            for (i, (_, mut f)) in versions.into_iter().enumerate() {
                if i < KEEP_VERSIONS {
                    f.newest = i == 0;
                    kept.push(f);
                } else if std::fs::remove_file(&f.path).is_ok() {
                    out.removed += 1;
                    out.freed += f.len;
                }
            }
        }
    }
    let mut total: u64 = kept.iter().map(|f| f.len).sum();
    kept.sort_by_key(|f| (f.newest, f.at));
    for f in &kept {
        if total <= cap {
            break;
        }
        if std::fs::remove_file(&f.path).is_ok() {
            out.removed += 1;
            out.freed += f.len;
            total -= f.len;
        }
    }
    out.left = total;
    out
}

/// What a directory holds on the disk: its files' allocated blocks, links not followed (a
/// sparse file counts what it takes, not what it claims).
fn usage(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(e.path());
            }
            total += md.blocks() * 512;
        }
    }
    total
}

/// The build caches pruned to `cap` bytes, least recently used first (by the stamp a lease's
/// start leaves, else the directory's own time), a package's whole cache at a time; never
/// one in `in_use` (a lease of this host mounts it) or used since `since` (a lease that
/// started meanwhile).
pub fn prune_build(
    work_root: &Path,
    cap: u64,
    in_use: &BTreeSet<PathBuf>,
    since: SystemTime,
) -> Pruned {
    struct Pkg {
        dir: PathBuf,
        stamp: PathBuf,
        size: u64,
        at: SystemTime,
    }
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let mut pkgs = Vec::new();
    for trust in [Trust::Community, Trust::Project] {
        for arch in ["aarch64", "x86_64"] {
            let side = work_root
                .join("cache")
                .join("build")
                .join(trust.as_str())
                .join(arch);
            let Ok(entries) = std::fs::read_dir(&side) else {
                continue;
            };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !spec::name_ok(&name) || !e.metadata().is_ok_and(|m| m.is_dir()) {
                    continue;
                }
                let dir = e.path();
                let stamp = used_stamp(work_root, trust, arch, &name);
                let at = mtime(&stamp)
                    .or_else(|| mtime(&dir))
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                pkgs.push(Pkg {
                    size: usage(&dir),
                    dir,
                    stamp,
                    at,
                });
            }
        }
    }
    let mut total: u64 = pkgs.iter().map(|p| p.size).sum();
    let mut out = Pruned::default();
    pkgs.sort_by_key(|p| p.at);
    for p in &pkgs {
        if total <= cap {
            break;
        }
        if in_use.contains(&p.dir) {
            continue;
        }
        let _held = BUILD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        if mtime(&p.stamp).is_some_and(|t| t >= since) {
            continue;
        }
        if std::fs::remove_dir_all(&p.dir).is_ok() {
            let _ = std::fs::remove_file(&p.stamp);
            out.removed += 1;
            out.freed += p.size;
            total -= p.size;
        }
    }
    out.left = total;
    out
}

// ---------- the upkeep ----------

/// One pass of the caches' upkeep, in a thread of the dispatcher's own.
pub struct Upkeep {
    pub pool: Arc<dyn Pool>,
    /// The pool's package repositories (`OMARCHY_POOL`): where its databases are.
    pub pool_url: String,
    pub work_root: PathBuf,
    /// The key the databases are verified with; `None`: the one built in.
    pub key: Option<PathBuf>,
    pub caps: Caps,
    /// The build caches the leases of this host mount now.
    pub in_use: BTreeSet<PathBuf>,
}

/// What a pass did, for the log.
#[derive(Debug, Default)]
pub struct Report {
    /// The leases whose downloads were merged back or discarded.
    pub leases: usize,
    pub merged: Merged,
    pub pacman: Pruned,
    pub build: Pruned,
    pub notes: Vec<String>,
}

impl Report {
    /// One line when the pass did anything, or has something to say.
    pub fn said(&self) -> Option<String> {
        let mut parts = Vec::new();
        let m = &self.merged;
        if self.leases > 0 {
            parts.push(format!(
                "the downloads of {} lease(s): {} merged into the shared pacman cache ({} MB), {} there already, {} discarded ({} not the bytes the pool's signed databases list, {} listed by none, {} listed twice with different bytes, {} no package file)",
                self.leases,
                m.merged,
                m.bytes >> 20,
                m.present,
                m.discarded(),
                m.mismatched,
                m.unknown,
                m.ambiguous,
                m.refused
            ));
        }
        if self.pacman.removed > 0 {
            parts.push(format!(
                "{} file(s) of the pacman cache pruned ({} MB; {} MB left)",
                self.pacman.removed,
                self.pacman.freed >> 20,
                self.pacman.left >> 20
            ));
        }
        if self.build.removed > 0 {
            parts.push(format!(
                "{} package(s)' build caches pruned, least recently used first ({} MB; {} MB left)",
                self.build.removed,
                self.build.freed >> 20,
                self.build.left >> 20
            ));
        }
        parts.extend(self.notes.iter().cloned());
        (!parts.is_empty()).then(|| format!("caches: {}", parts.join("; ")))
    }
}

/// One pass: every lease's downloads set aside since the last one merged back by the
/// signed databases of its architecture (fetched again when stale) or discarded, then both
/// caches pruned to their caps.
pub fn upkeep(u: &Upkeep) -> Report {
    let since = SystemTime::now();
    let mut r = Report::default();
    let tmp = tmp_dir(&u.work_root);
    let _ = std::fs::remove_dir_all(&tmp);
    let incoming = incoming_dir(&u.work_root);
    for arch in ["aarch64", "x86_64"] {
        let Ok(entries) = std::fs::read_dir(incoming.join(arch)) else {
            continue;
        };
        let leases: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        if leases.is_empty() {
            continue;
        }
        let index = match key_file(&u.work_root, u.key.as_deref()) {
            Ok(key) => {
                r.notes
                    .extend(refresh(&*u.pool, &u.pool_url, &u.work_root, arch, &key));
                let (index, notes) = load(&u.work_root, arch, &key);
                r.notes.extend(notes);
                index
            }
            Err(e) => {
                r.notes.push(format!("the pool's key: {e}"));
                Index::default()
            }
        };
        if index.is_empty() {
            r.notes.push(format!(
                "no signed database of {arch} could be read: every download of these leases is discarded"
            ));
        }
        let shared = pacman_dir(&u.work_root, arch);
        let _ = std::fs::create_dir_all(&shared);
        for lease in leases {
            let m = merge(&lease, &shared, &tmp, &index);
            r.merged.add(&m);
            r.leases += 1;
            let _ = std::fs::remove_dir_all(&lease);
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    r.pacman = prune_pacman(
        &["aarch64", "x86_64"].map(|a| pacman_dir(&u.work_root, a)),
        u.caps.pacman,
    );
    r.build = prune_build(&u.work_root, u.caps.build, &u.in_use, since);
    r
}

#[cfg(test)]
pub(crate) mod tests {
    //! The caches' own tests (#341): the merge-back against the fixture databases
    //! (`tests/fixtures/pool-dbs/`, signed by a key of their own, `write_the_fixtures`),
    //! with matching, mismatching, unknown and ambiguous files; a database that does not
    //! verify left unread; the pacman cache pruned to two versions and its cap; the build
    //! caches least recently used first and never one in use.

    use super::*;

    /// The bytes of a fixture package: what the fixture databases list, and what a stub task writes.
    pub(crate) fn fixture_bytes(name: &str, which: &str, arch: &str) -> Vec<u8> {
        format!("omarchy-pool fixture package {name} ({which}) for {arch}\n").into_bytes()
    }

    pub(crate) fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pool-dbs")
    }

    fn file(name: &str, arch: &str) -> String {
        format!("{name}-1.0-1-{arch}.pkg.tar.zst")
    }

    /// The fixture databases as the pool would serve them, into `<work>/cache/syncdb/<arch>`.
    fn place_fixtures(work: &Path, arch: &str) {
        let dir = db_dir(work, arch);
        std::fs::create_dir_all(&dir).unwrap();
        for source in ["core", "packages"] {
            for f in [db_name(source), format!("{}.sig", db_name(source))] {
                std::fs::copy(fixture_dir().join(&f), dir.join(&f)).unwrap();
            }
        }
    }

    #[test]
    fn the_fixture_databases_verify_and_list_what_the_stub_tasks_write() {
        let t = tempfile::tempdir().unwrap();
        for arch in ["aarch64", "x86_64"] {
            place_fixtures(t.path(), arch);
            let (index, notes) = load(t.path(), arch, &fixture_dir().join("pool.pub.asc"));
            assert!(notes.is_empty(), "{notes:?}");
            let sha = |b: &[u8]| hex::encode(Sha256::digest(b));
            let lib = fixture_bytes("libfixture", "libfixture", arch);
            assert_eq!(
                index.listed(&file("libfixture", arch)),
                Listed::Once(sha(&lib), lib.len() as u64)
            );
            assert_eq!(index.listed(&file("twin", arch)), Listed::Ambiguous);
            assert_eq!(index.listed(&file("stranger", arch)), Listed::Unknown);
        }
    }

    #[test]
    fn a_database_whose_signature_does_not_verify_is_not_read() {
        let t = tempfile::tempdir().unwrap();
        place_fixtures(t.path(), "x86_64");
        let db = db_dir(t.path(), "x86_64").join(db_name("core"));
        // Another database under the signature of the real one: a planted listing.
        let mut other = Index::default();
        let planted = crate::build_database(&[], crate::Flavor::Db).unwrap();
        other.add(&planted).unwrap();
        std::fs::write(&db, planted).unwrap();
        let (index, notes) = load(t.path(), "x86_64", &fixture_dir().join("pool.pub.asc"));
        assert_eq!(index.listed(&file("libfixture", "x86_64")), Listed::Unknown);
        assert!(
            notes
                .iter()
                .any(|n| n.contains("omarchy-core-edge.db (x86_64) is not read")),
            "{notes:?}"
        );
        // The packages database still reads: twin is listed once now, by it.
        assert!(matches!(
            index.listed(&file("twin", "x86_64")),
            Listed::Once(..)
        ));
        // A key that is not the pool's verifies nothing.
        let t2 = tempfile::tempdir().unwrap();
        place_fixtures(t2.path(), "x86_64");
        let other_key = t2.path().join("other.asc");
        std::fs::write(&other_key, POOL_KEY).unwrap();
        let (index, notes) = load(t2.path(), "x86_64", &other_key);
        assert!(index.is_empty() && notes.len() == 2, "{notes:?}");
    }

    #[test]
    fn the_merge_back_takes_only_the_bytes_the_signed_databases_list() {
        let t = tempfile::tempdir().unwrap();
        let work = t.path();
        let arch = "aarch64";
        place_fixtures(work, arch);
        let (index, _) = load(work, arch, &fixture_dir().join("pool.pub.asc"));
        let incoming = work.join("incoming");
        std::fs::create_dir_all(incoming.join("download-x1")).unwrap();
        let put = |name: &str, bytes: &[u8]| std::fs::write(incoming.join(name), bytes).unwrap();
        // Matching: the shared dependency, as the pool lists it.
        put(
            &file("libfixture", arch),
            &fixture_bytes("libfixture", "libfixture", arch),
        );
        // Mismatching: listed, other bytes of the same size, and other bytes of another size.
        let evil = fixture_bytes("evil", "evil", arch);
        let mut same_size = evil.clone();
        same_size[0] ^= 1;
        put(&file("evil", arch), &same_size);
        put(&format!("evil-1.0-1-{arch}.pkg.tar.zst.sig"), b"x");
        // Unknown: a recipe's own file, and pacman's half-downloaded one.
        put(&file("stranger", arch), b"planted");
        put(
            &format!("{}.part", file("libfixture", arch)),
            &fixture_bytes("libfixture", "libfixture", arch),
        );
        // Ambiguous: the bytes core lists, which packages lists otherwise.
        put(&file("twin", arch), &fixture_bytes("twin", "core", arch));
        // A link to a file the dispatcher can read is no download.
        std::os::unix::fs::symlink(
            fixture_dir().join("pool.pub.asc"),
            incoming.join(file("linked", arch)),
        )
        .unwrap();
        let shared = work.join("shared");
        std::fs::create_dir_all(&shared).unwrap();
        let m = merge(&incoming, &shared, &work.join("tmp"), &index);
        assert_eq!(
            m,
            Merged {
                merged: 1,
                bytes: fixture_bytes("libfixture", "libfixture", arch).len() as u64,
                present: 0,
                mismatched: 1,
                unknown: 3,
                ambiguous: 1,
                refused: 2,
            }
        );
        let names: Vec<String> = std::fs::read_dir(&shared)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [file("libfixture", arch)]);
        let merged = shared.join(file("libfixture", arch));
        assert_eq!(
            std::fs::read(&merged).unwrap(),
            fixture_bytes("libfixture", "libfixture", arch)
        );
        assert_eq!(
            std::fs::metadata(&merged).unwrap().permissions().mode() & 0o7777,
            0o644
        );
        // The same file from a second lease is there already; nothing half-made is left behind.
        let m = merge(&incoming, &shared, &work.join("tmp"), &index);
        assert_eq!((m.merged, m.present), (0, 1));
        assert_eq!(std::fs::read_dir(work.join("tmp")).unwrap().count(), 0);
        // With no database read, everything is discarded.
        let shared2 = work.join("shared2");
        std::fs::create_dir_all(&shared2).unwrap();
        let m = merge(&incoming, &shared2, &work.join("tmp"), &Index::default());
        assert_eq!((m.merged, m.unknown), (0, 6));
        assert_eq!(std::fs::read_dir(&shared2).unwrap().count(), 0);
    }

    fn write_at(path: &Path, len: usize, secs_ago: u64) {
        std::fs::write(path, vec![7u8; len]).unwrap();
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(secs_ago))
            .unwrap();
    }

    #[test]
    fn the_pacman_cache_keeps_two_versions_of_each_package_then_its_cap() {
        let t = tempfile::tempdir().unwrap();
        let (a, x) = (t.path().join("aarch64"), t.path().join("x86_64"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&x).unwrap();
        // zlib: four versions, epochs and pkgrels among them; vercmp orders them, not the names.
        for (v, ago) in [
            ("1:1.3.1-1", 400),
            ("1:1.3.2-3", 100),
            ("1:1.3.2-10", 50),
            ("1.3.3-1", 10),
        ] {
            write_at(&a.join(format!("zlib-{v}-aarch64.pkg.tar.zst")), 1000, ago);
        }
        write_at(&a.join("felix-2.0-1-any.pkg.tar.zst"), 1000, 300);
        write_at(&x.join("zlib-1:1.3.2-3-x86_64.pkg.tar.zst"), 1000, 200);
        let p = prune_pacman(&[a.clone(), x.clone()], u64::MAX);
        assert_eq!((p.removed, p.freed, p.left), (2, 2000, 4000));
        let mut left: Vec<String> = std::fs::read_dir(&a)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "felix-2.0-1-any.pkg.tar.zst",
                "zlib-1:1.3.2-10-aarch64.pkg.tar.zst",
                "zlib-1:1.3.2-3-aarch64.pkg.tar.zst"
            ]
        );
        // Above the cap: the older version goes before any newest one, then the oldest merged.
        let p = prune_pacman(&[a.clone(), x.clone()], 2500);
        assert_eq!((p.removed, p.left), (2, 2000));
        assert!(!a.join("zlib-1:1.3.2-3-aarch64.pkg.tar.zst").exists());
        assert!(!a.join("felix-2.0-1-any.pkg.tar.zst").exists());
        assert!(a.join("zlib-1:1.3.2-10-aarch64.pkg.tar.zst").exists());
        assert!(x.join("zlib-1:1.3.2-3-x86_64.pkg.tar.zst").exists());
        assert_eq!(prune_pacman(&[a, x], 0).left, 0);
        assert_eq!(
            package_of("zlib-1:1.3.2-3-x86_64.pkg.tar.zst"),
            Some(("zlib x86_64".into(), "1:1.3.2-3".into()))
        );
        assert_eq!(
            package_of("lib32-gcc-libs-14.1-1-x86_64.pkg.tar.xz"),
            Some(("lib32-gcc-libs x86_64".into(), "14.1-1".into()))
        );
        assert_eq!(package_of("notes.txt"), None);
    }

    #[test]
    fn the_build_caches_go_least_recently_used_first_never_one_in_use() {
        let t = tempfile::tempdir().unwrap();
        let work = t.path();
        let make = |trust: Trust, arch: &str, name: &str, blocks: usize, used_ago: u64| {
            let dir = build_dir(work, trust, arch, name);
            std::fs::create_dir_all(dir.join("cargo/registry")).unwrap();
            std::fs::write(dir.join("cargo/registry/crate"), vec![1u8; blocks * 4096]).unwrap();
            let stamp = used_stamp(work, trust, arch, name);
            std::fs::create_dir_all(stamp.parent().unwrap()).unwrap();
            write_at(&stamp, 0, used_ago);
            dir
        };
        let old = make(Trust::Community, "aarch64", "old", 4, 900);
        let busy = make(Trust::Community, "aarch64", "busy", 4, 800);
        let mid = make(Trust::Project, "x86_64", "mid", 4, 500);
        let new = make(Trust::Community, "x86_64", "new", 4, 10);
        let each = usage(&old);
        assert!(each >= 4 * 4096, "{each}");
        // Under the cap: nothing goes.
        let none = prune_build(work, u64::MAX, &BTreeSet::new(), SystemTime::now());
        assert_eq!((none.removed, none.left), (0, 4 * each));
        // Room for two: the oldest goes, the one a lease mounts stays, the next oldest goes.
        let in_use: BTreeSet<PathBuf> = [busy.clone()].into();
        let p = prune_build(work, 2 * each, &in_use, SystemTime::now());
        assert_eq!((p.removed, p.freed, p.left), (2, 2 * each, 2 * each));
        assert!(!old.exists() && !mid.exists() && busy.exists() && new.exists());
        assert!(!used_stamp(work, Trust::Community, "aarch64", "old").exists());
        // One used since the pass began (a lease that started meanwhile) stays too.
        ready(work, Trust::Community, "x86_64", "new", true).unwrap();
        let p = prune_build(work, 0, &in_use, SystemTime::now() - Duration::from_secs(5));
        assert_eq!(p.removed, 0);
        assert!(busy.exists() && new.exists());
    }

    #[test]
    fn ready_and_collect_keep_to_the_grammar_and_the_cache_tree() {
        let t = tempfile::tempdir().unwrap();
        let work = t.path();
        ready(work, Trust::Community, "aarch64", "felix", true).unwrap();
        assert!(build_dir(work, Trust::Community, "aarch64", "felix").is_dir());
        assert!(pacman_dir(work, "aarch64").is_dir());
        assert_eq!(
            std::fs::metadata(work.join("cache"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        // An audit's: the pacman cache only.
        ready(work, Trust::Project, "x86_64", "felix", false).unwrap();
        assert!(!build_dir(work, Trust::Project, "x86_64", "felix").exists());
        for (arch, name) in [("riscv64", "felix"), ("aarch64", "../x"), ("aarch64", "")] {
            assert!(ready(work, Trust::Community, arch, name, true).is_err());
        }
        // A lease's downloads go aside; an empty pkgcache is nothing to merge.
        let gen = "g_00000000000000a1";
        let tdir = spec::task_dir(work, 7, gen);
        std::fs::create_dir_all(tdir.join("pkgcache")).unwrap();
        assert!(!collect(&tdir, work, "aarch64", 7, gen));
        std::fs::write(tdir.join("pkgcache/x.pkg.tar.zst"), b"x").unwrap();
        assert!(!collect(&tdir, work, "riscv64", 7, gen));
        assert!(collect(&tdir, work, "aarch64", 7, gen));
        assert!(incoming_dir(work)
            .join("aarch64")
            .join(format!("7-{gen}"))
            .join("x.pkg.tar.zst")
            .is_file());
        assert!(!tdir.join("pkgcache").exists());
    }

    /// Makes `tests/fixtures/pool-dbs/` again: two databases rendered with pkg-repo's own
    /// code — `core` (the shared dependency `libfixture`, `evil`, `twin`) and `packages`
    /// (`twin` with other bytes) — for both architectures, each signed by a key made for
    /// them and thrown away, whose public half is `pool.pub.asc`. Needs gpg.
    #[test]
    #[ignore = "writes the fixtures; run by hand when they change"]
    fn write_the_fixtures() {
        use pkg_manifest::{PackageManifest, PkgInfoFields, MANIFEST_SCHEMA_VERSION};
        let out = fixture_dir();
        std::fs::create_dir_all(&out).unwrap();
        let pkg = |name: &str, which: &str, arch: &str| {
            let bytes = fixture_bytes(name, which, arch);
            PackageManifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                name: name.into(),
                version: "1.0-1".into(),
                arch: arch.into(),
                description: Some("omarchy-pool's cache fixture".into()),
                url: None,
                licenses: vec!["MIT".into()],
                size_installed: bytes.len() as u64,
                size_download: bytes.len() as u64,
                sha256: hex::encode(Sha256::digest(&bytes)),
                filename: file(name, arch),
                pkginfo: PkgInfoFields {
                    base: name.into(),
                    builddate: 1_700_000_000,
                    packager: "omarchy-pool fixture".into(),
                    ..PkgInfoFields::default()
                },
                provides: vec![],
                requires: vec![],
                optional: vec![],
                conflicts: vec![],
                replaces: vec![],
                files: vec![],
                backup: vec![],
                components: vec![],
            }
        };
        let arches = ["aarch64", "x86_64"];
        let core: Vec<PackageManifest> = arches
            .iter()
            .flat_map(|a| {
                [
                    pkg("evil", "evil", a),
                    pkg("libfixture", "libfixture", a),
                    pkg("twin", "core", a),
                ]
            })
            .collect();
        let packages: Vec<PackageManifest> =
            arches.iter().map(|a| pkg("twin", "packages", a)).collect();
        let home = tempfile::tempdir().unwrap();
        let gpg = |args: &[&str]| {
            let o = std::process::Command::new("gpg")
                .env("GNUPGHOME", home.path())
                .args([
                    "--batch",
                    "--yes",
                    "--pinentry-mode",
                    "loopback",
                    "--passphrase",
                    "",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            o.stdout
        };
        gpg(&[
            "--quick-gen-key",
            "omarchy-pool cache fixture (a test key, not the pool's) <fixture@omarchy-pool.invalid>",
            "ed25519",
            "sign",
            "never",
        ]);
        std::fs::write(out.join("pool.pub.asc"), gpg(&["--armor", "--export"])).unwrap();
        for (source, pkgs) in [("core", core), ("packages", packages)] {
            let db = out.join(db_name(source));
            std::fs::write(
                &db,
                crate::build_database(&pkgs, crate::Flavor::Db).unwrap(),
            )
            .unwrap();
            let sig = out.join(format!("{}.sig", db_name(source)));
            gpg(&[
                "--detach-sign",
                "--no-armor",
                "--output",
                &sig.display().to_string(),
                &db.display().to_string(),
            ]);
        }
    }
}
