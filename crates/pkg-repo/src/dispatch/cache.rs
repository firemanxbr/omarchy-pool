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
//!   `<work>/cache/pacman/<arch>` read-only at `/var/cache/pacman/shared` and its own
//!   writable `<task dir>/pkgcache` at `/var/cache/pacman/pkg`. A build's and an audit's
//!   pacman names the shared one its first `CacheDir` and its own the second (the build
//!   script's `pacman_ready`): pacman downloads into the first writable one, so
//!   concurrent builds never share a file they write. A trial's check names none and
//!   downloads everything itself, as in its own container: it installs the lab's
//!   sections above edge's, and the shared cache holds the bytes edge's databases list,
//!   which the lab's need not.
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
//! - **A package's signature beside it.** pacman downloads a package's `.sig` with it from a
//!   repository whose `SigLevel` checks packages (the image's own Arch and Arch Linux ARM
//!   sections, where most of a build's dependencies come from) and checks the package by the
//!   `.sig` beside the file it found: one in the read-only shared cache without its `.sig`
//!   is downloaded again and then refused (`missing required signature`), failing every
//!   task that installs it from there, and so is one beside a wrong `.sig`, which pacman
//!   cannot delete. So a package is merged with the signature the pool keeps beside it
//!   (`<source>/<arch>/<file>.sig`, fetched as the databases are, [`Signatures`]): its
//!   upstream's, or for the pool's own builds the pool key's, which `pkg-repo publish` makes
//!   and their sections (`PackageNever`) never read. It must be the very bytes its task
//!   downloaded when it downloaded one — never a task's own — or the package is not merged;
//!   one the pool keeps no signature of (an upstream that ships none, a build published
//!   while the pool had no signing key) goes alone, when its task downloaded none either.
//! - **Checked again.** What was merged is recorded (`cache/merged/<arch>/<file>`: its
//!   SHA-256 and size), and every pass checks the shared cache again against the
//!   databases of the day ([`recheck`]): a file whose name they now list with other bytes,
//!   or list twice at odds, or that is not whole (a crash) leaves it, and its signature
//!   after it — the snapshot it was merged by is not the one tasks resolve by.
//! - **Caps and pruning**, from the envelope's `cache_caps` (`OMARCHY_CACHE_PACMAN_GB`,
//!   `OMARCHY_CACHE_BUILD_GB` in `etc/dispatcher.env`, written by the agent): the pacman
//!   cache keeps the two newest versions of each package (a signature goes with its
//!   package, after it) and, above its cap, drops the oldest merged first, older versions
//!   before newest ones; the build caches go least recently used first, a package's whole
//!   directory at a time, never one a lease of this host mounts. Each pass prunes before it asks the pool anything, so a pool that
//!   does not answer never holds the caches over their caps.
//!
//! Only the dispatcher walks into `cache/` (0700): a task mounts its parts of it, which
//! needs no walk from inside. The databases fetched, the files being merged, their
//! records and the use stamps of the build caches are never mounted into a task.

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
/// The lanes a host's caches are kept for.
const ARCHES: [&str; 2] = ["aarch64", "x86_64"];

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

/// The records of what was merged into the shared pacman cache of one architecture: one
/// file per package file, its SHA-256 and size — what each pass checks the shared cache
/// against the databases of the day by, without hashing it again.
fn merged_dir(work_root: &Path, arch: &str) -> PathBuf {
    work_root.join("cache").join("merged").join(arch)
}

/// Build caches being deleted: moved here under [`BUILD_LOCK`], deleted after it.
fn trash_dir(work_root: &Path) -> PathBuf {
    work_root.join("cache").join("trash")
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
/// so nothing writes there any more. An error (`cache/` on another file system than the
/// tasks', say) is the caller's to say: those downloads are lost with the task directory.
pub fn collect(
    task_dir: &Path,
    work_root: &Path,
    arch: &str,
    task: u64,
    gen: &str,
) -> std::io::Result<bool> {
    if spec::platform_of(arch).is_none() || !spec::gen_ok(gen) {
        return Ok(false);
    }
    let from = task_dir.join("pkgcache");
    if !std::fs::read_dir(&from).is_ok_and(|mut d| d.next().is_some()) {
        return Ok(false);
    }
    let to = incoming_dir(work_root)
        .join(arch)
        .join(format!("{task}-{gen}"));
    let _ = std::fs::remove_dir_all(&to);
    cache_root(work_root)?;
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::rename(&from, &to)?;
    Ok(true)
}

// ---------- the signed databases ----------

/// What the pool's signed databases of one architecture list: each file name, with the
/// SHA-256 and the size of the bytes each database that lists it names, and the sources whose
/// databases list it — where the pool keeps its copy of the file's upstream signature
/// (`<source>/<arch>/<file>.sig`, `worker/src/r2.ts`).
#[derive(Debug, Default)]
pub struct Index {
    files: HashMap<String, BTreeSet<(String, u64)>>,
    sources: HashMap<String, BTreeSet<String>>,
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
    /// One source's database's packages (gzip- or zstd-compressed, as the pool renders them).
    pub fn add(&mut self, source: &str, db: &[u8]) -> std::io::Result<usize> {
        let pkgs = crate::syncdb::parse_sync_db(db)?;
        for p in &pkgs {
            self.files
                .entry(p.filename.clone())
                .or_default()
                .insert((p.sha256.to_ascii_lowercase(), p.size_download));
            self.sources
                .entry(p.filename.clone())
                .or_default()
                .insert(source.to_owned());
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

    /// The sources whose databases list `file`.
    pub fn sources(&self, file: &str) -> impl Iterator<Item = &str> {
        self.sources
            .get(file)
            .into_iter()
            .flat_map(|s| s.iter().map(String::as_str))
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
/// serves no longer (404) removed. At the first that does not come, the pool is not asked
/// for the rest: every copy here is kept and the next pass asks again (one timeout a pass
/// for a pool that hangs, not one per database). Returns what went wrong, for the log.
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
                    "{name} ({arch}): {}; the copies here are kept, and the pool asked again at the next pass",
                    crate::orders::clean_line(&e.to_string())
                ));
                break;
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
        if let Err(e) = std::fs::read(&db).and_then(|b| index.add(source, &b)) {
            notes.push(format!("{name} ({arch}) does not read: {e}"));
        }
    }
    (index, notes)
}

// ---------- the merge-back ----------

/// What one merge-back did with a lease's downloads, and what it took out of the shared cache.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Merged {
    /// Packages copied into the shared cache: the bytes the databases list.
    pub merged: usize,
    pub bytes: u64,
    /// Signatures put beside their package in the shared cache: the pool's copies.
    pub signed: usize,
    /// Packages, and signatures downloaded with them, already there as these bytes.
    pub present: usize,
    /// Listed with other bytes (or another size): discarded.
    pub mismatched: usize,
    /// Listed by no database (a `.part`, a recipe's own file): discarded.
    pub unknown: usize,
    /// Listed by two databases with different bytes: discarded.
    pub ambiguous: usize,
    /// Packages not merged for their signature, and the signatures downloaded with them: the
    /// one downloaded is not the pool's copy, or the pool keeps none, or several, or did not
    /// answer; and a signature downloaded beside no package merged.
    pub unvouched: usize,
    /// Not a regular file, or a name no package has: discarded.
    pub refused: usize,
    /// Listed, but the copy failed (the disk, not the bytes: a full work root, an I/O error): not merged.
    pub failed: usize,
    /// Packages taken out of the shared cache: there without the signature their task's
    /// pacman downloaded with them, which every task of that repository fails on, and none of
    /// the pool's to put beside them.
    pub withdrawn: usize,
}

impl Merged {
    fn add(&mut self, o: &Merged) {
        self.merged += o.merged;
        self.bytes += o.bytes;
        self.signed += o.signed;
        self.present += o.present;
        self.mismatched += o.mismatched;
        self.unknown += o.unknown;
        self.ambiguous += o.ambiguous;
        self.unvouched += o.unvouched;
        self.refused += o.refused;
        self.failed += o.failed;
        self.withdrawn += o.withdrawn;
    }

    fn discarded(&self) -> usize {
        self.mismatched + self.unknown + self.ambiguous + self.unvouched + self.refused
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

/// The record of a file merged: `<sha256> <size>`. One that does not read is none (a crash
/// while it was written): the file is then hashed again.
fn read_record(path: &Path) -> Option<(String, u64)> {
    let s = std::fs::read_to_string(path).ok()?;
    let (sha, size) = s.trim().split_once(' ')?;
    (sha.len() == 64 && sha.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))
        .then(|| size.parse().ok().map(|n| (sha.to_owned(), n)))
        .flatten()
}

fn write_record(
    work_root: &Path,
    arch: &str,
    name: &str,
    sha: &str,
    size: u64,
) -> std::io::Result<()> {
    let dir = merged_dir(work_root, arch);
    let tmp = tmp_dir(work_root).join("record.part");
    std::fs::create_dir_all(&dir)?;
    std::fs::create_dir_all(tmp_dir(work_root))?;
    std::fs::write(&tmp, format!("{sha} {size}\n"))?;
    std::fs::rename(&tmp, dir.join(name))
}

/// A file of the shared cache and its record removed: whether the file went.
fn remove_merged(work_root: &Path, arch: &str, name: &str) -> bool {
    let gone = std::fs::remove_file(pacman_dir(work_root, arch).join(name)).is_ok();
    if gone {
        let _ = std::fs::remove_file(merged_dir(work_root, arch).join(name));
    }
    gone
}

/// `src`'s bytes hashed without following a link, stopping past `size` bytes, and written
/// to `to` meanwhile when one is given: whether they are exactly the listed ones. An error
/// is the disk's, never the bytes'.
fn verify(src: &Path, mut to: Option<&mut File>, sha: &str, size: u64) -> std::io::Result<bool> {
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
        if let Some(to) = to.as_deref_mut() {
            to.write_all(&buf[..n])?;
        }
    }
    Ok(total == size && hex::encode(hasher.finalize()) == sha)
}

/// A new file in the dispatcher's own `cache/tmp` (0644): what is then renamed into the
/// shared cache, on the same file system.
fn part(path: &Path) -> std::io::Result<File> {
    let _ = std::fs::remove_file(path);
    File::options()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(path)
}

/// `part`, written whole, renamed into place as `dest`: on the disk before, the rename after
/// — a task never sees half a file, and a crash never leaves the name with half its bytes.
fn commit(to: &File, part: &Path, dest: &Path, shared: &Path) -> std::io::Result<()> {
    to.sync_all()?;
    std::fs::set_permissions(part, Permissions::from_mode(0o644))?;
    std::fs::rename(part, dest)?;
    File::open(shared)?.sync_all()
}

/// Whether the shared cache of `arch` holds `file` as the bytes `sha` and `size` (its record
/// says so, and it is whole).
fn holds(work_root: &Path, arch: &str, file: &str, sha: &str, size: u64) -> bool {
    pacman_dir(work_root, arch)
        .join(file)
        .symlink_metadata()
        .is_ok_and(|md| md.is_file() && md.len() == size)
        && read_record(&merged_dir(work_root, arch).join(file))
            .is_some_and(|(s, n)| s == sha && n == size)
}

// ---------- the packages' signatures ----------

/// No package signature is longer: pacman downloads none past 16 KiB either.
const MAX_SIG: u64 = 16 << 10;

/// The signature the pool keeps beside a package (its upstream's, or the pool key's for the
/// pool's own builds), by the source whose database lists the package and the package's file
/// name: `Ok(None)` when it keeps none there, `Err` when it does not answer.
pub type Vouch<'a> = dyn FnMut(&str, &str) -> Result<Option<Vec<u8>>, String> + 'a;

/// The signatures the pool keeps beside one architecture's packages, asked for while a pass
/// merges (`<pool>/<source>/<arch>/<file>.sig`, beside the package, as `worker/src/r2.ts`
/// lays them out). A pool that does not answer is asked no more this pass:
/// one timeout a pass, as for the databases.
pub struct Signatures<'a> {
    pub pool: &'a dyn Pool,
    pub pool_url: &'a str,
    pub arch: &'a str,
    /// Where each copy is downloaded to, the dispatcher's own (`cache/tmp`).
    pub tmp: PathBuf,
    /// What the pool said when it did not answer.
    pub unanswered: Option<String>,
}

impl Signatures<'_> {
    pub fn of(&mut self, source: &str, file: &str) -> Result<Option<Vec<u8>>, String> {
        if let Some(e) = &self.unanswered {
            return Err(e.clone());
        }
        let url = format!(
            "{}/{source}/{}/{file}.sig",
            self.pool_url.trim_end_matches('/'),
            self.arch
        );
        let dest = self.tmp.join("signature.part");
        let _ = std::fs::create_dir_all(&self.tmp);
        let got = match self.pool.public_file(&url, &dest) {
            Ok(true) => Ok(read_capped(&dest, MAX_SIG)
                .ok()
                .flatten()
                .filter(|s| !s.is_empty())),
            Ok(false) => Ok(None),
            Err(e) => {
                let said = crate::orders::clean_line(&e.to_string());
                self.unanswered = Some(said.clone());
                Err(said)
            }
        };
        let _ = std::fs::remove_file(&dest);
        got
    }
}

/// `src`'s bytes, without following a link, when it is a regular file of at most `cap` bytes.
fn read_capped(src: &Path, cap: u64) -> std::io::Result<Option<Vec<u8>>> {
    use rustix::fs::{Mode, OFlags};
    let fd = rustix::fs::open(
        src,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let from = File::from(fd);
    if !from.metadata()?.is_file() {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    from.take(cap + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= cap).then_some(bytes))
}

/// What goes beside a package merged into the shared cache.
#[derive(Debug, PartialEq, Eq)]
enum Beside {
    /// The signature the pool keeps beside it: its upstream's, or the pool key's (the pool's
    /// own builds, which `pkg-repo publish` signs).
    Signature(Vec<u8>),
    /// Nothing: the pool keeps no signature of it (an upstream that ships none, a build
    /// published while the pool had no signing key), and its task's pacman downloaded none.
    Nothing,
    /// The package is not merged: the signature its task's pacman downloaded is not the
    /// pool's copy, or the pool keeps none of it, or keeps several (two sources' upstreams
    /// signed these bytes, and which one a task's keyring takes is the task's repository's),
    /// or did not answer.
    Unvouched,
}

/// What goes beside `package` (listed once by `index`), whose task's pacman downloaded
/// `downloaded` beside it (`None`: none, or one that does not read).
///
/// pacman downloads a package's `.sig` with it from a repository whose `SigLevel` checks
/// packages (the image's own Arch and Arch Linux ARM sections, where most of a build's
/// dependencies come from) and checks the package by the `.sig` beside the file it found:
/// one in the read-only shared cache without its `.sig` is downloaded again, then refused
/// (`missing required signature`), failing every task that installs it from there — and a
/// wrong one, which pacman cannot delete, fails them too. So the signature is the pool's own
/// copy of the upstream one, or the package is not merged; and the pool's copy goes beside it
/// even when the task downloaded none, since a task's recipe can delete its own.
fn beside(
    index: &Index,
    package: &str,
    downloaded: Option<&[u8]>,
    vouch: &mut Vouch<'_>,
) -> Beside {
    let mut copies = BTreeSet::new();
    for source in index.sources(package) {
        match vouch(source, package) {
            Ok(Some(copy)) => {
                copies.insert(copy);
            }
            Ok(None) => {}
            Err(_) => return Beside::Unvouched,
        }
    }
    if copies.len() > 1 {
        return Beside::Unvouched;
    }
    match (downloaded, copies.pop_first()) {
        (Some(d), Some(copy)) if !d.is_empty() && d == copy.as_slice() => Beside::Signature(copy),
        (Some(_), _) => Beside::Unvouched,
        (None, Some(copy)) => Beside::Signature(copy),
        (None, None) => Beside::Nothing,
    }
}

/// One lease's downloads (`incoming`) merged into the shared cache of `arch` by `index`:
/// each package listed once, with its size and SHA-256, is copied in and recorded, with the
/// pool's copy of its upstream signature beside it ([`beside`]: the package is not merged
/// when that cannot be had); one already there is left as it is only when its record says
/// these bytes (else it is replaced: it was merged when the databases listed others, or is
/// not whole); every other file is discarded. `incoming` itself is left to the caller. With
/// the counts, the first copy that failed for the disk's sake, for the log.
pub fn merge(
    work_root: &Path,
    arch: &str,
    incoming: &Path,
    index: &Index,
    vouch: &mut Vouch<'_>,
) -> (Merged, Option<String>) {
    let mut m = Merged::default();
    let mut failure = None;
    let Ok(entries) = std::fs::read_dir(incoming) else {
        return (m, failure);
    };
    let _ = std::fs::create_dir_all(tmp_dir(work_root));
    let _ = std::fs::create_dir_all(pacman_dir(work_root, arch));
    let (mut packages, mut signatures) = (Vec::new(), HashMap::new());
    for e in entries.flatten() {
        let Ok(name) = e.file_name().into_string() else {
            m.refused += 1;
            continue;
        };
        // `DirEntry::metadata` does not follow a link: a link, a directory (pacman's own
        // download directories) or a device is nothing to merge.
        if !e.metadata().is_ok_and(|md| md.file_type().is_file()) {
            m.refused += 1;
        } else if let Some(package) = name.strip_suffix(".sig").filter(|p| file_name_ok(p)) {
            signatures.insert(package.to_owned(), e.path());
        } else if file_name_ok(&name) {
            packages.push((name, e.path()));
        } else {
            m.refused += 1;
        }
    }
    for (name, src) in packages {
        let downloaded = signatures.remove(&name);
        let Listed::Once(sha, size) = index.listed(&name) else {
            if index.listed(&name) == Listed::Unknown {
                m.unknown += 1;
            } else {
                m.ambiguous += 1;
            }
            m.unvouched += usize::from(downloaded.is_some());
            continue;
        };
        let downloaded =
            downloaded.map(|p| read_capped(&p, MAX_SIG).ok().flatten().unwrap_or_default());
        let file = Download {
            name: &name,
            src: &src,
            sha: &sha,
            size,
            downloaded,
        };
        if let Err(e) = merge_one(work_root, arch, index, &file, vouch, &mut m) {
            m.failed += 1;
            failure.get_or_insert_with(|| format!("{name}: {e}"));
        }
    }
    // A signature without its package: pacman downloads both, or neither.
    m.unvouched += signatures.len();
    (m, failure)
}

/// One package of a lease's downloads, listed once.
struct Download<'a> {
    name: &'a str,
    src: &'a Path,
    sha: &'a str,
    size: u64,
    /// The signature its task's pacman downloaded with it: empty when there is one that does
    /// not read (past 16 KiB, say), which is no signature of the pool's either.
    downloaded: Option<Vec<u8>>,
}

/// One package merged ([`merge`]). Into the shared cache in the order that leaves no task a
/// package without the signature it was merged with: an old package of other bytes out
/// first, then its signature; the new signature in (its record first: a crash leaves a record
/// of nothing, never a signature unrecorded), then the package. An error is the disk's, and
/// counted by the caller.
fn merge_one(
    work_root: &Path,
    arch: &str,
    index: &Index,
    d: &Download<'_>,
    vouch: &mut Vouch<'_>,
    m: &mut Merged,
) -> std::io::Result<()> {
    let shared = pacman_dir(work_root, arch);
    let sig_name = format!("{}.sig", d.name);
    let with_sig = usize::from(d.downloaded.is_some());
    let downloaded = d.downloaded.as_deref();
    if holds(work_root, arch, d.name, d.sha, d.size) {
        let Some(got) = downloaded else {
            // What it holds beside it stays as it is.
            m.present += 1;
            return Ok(());
        };
        let sig_there = read_record(&merged_dir(work_root, arch).join(&sig_name));
        if sig_there.is_some() && shared.join(&sig_name).is_file() {
            // A signature there already: the pool's, whatever this one is.
            m.present += 1 + with_sig;
            return Ok(());
        }
        // There without a signature, while its task's pacman downloaded one with it: every
        // task of that repository fails on it. The pool's copy goes beside it, or it goes.
        return match beside(index, d.name, Some(got), vouch) {
            Beside::Signature(sig) => {
                put_signature(work_root, arch, &sig_name, &sig)?;
                m.present += 1;
                m.signed += 1;
                Ok(())
            }
            Beside::Nothing | Beside::Unvouched => {
                if remove_merged(work_root, arch, d.name) {
                    m.withdrawn += 1;
                }
                m.unvouched += 1 + with_sig;
                Ok(())
            }
        };
    }
    let path = tmp_dir(work_root).join("merging.part");
    let mut to = part(&path).inspect_err(|_| m.unvouched += with_sig)?;
    let copied = verify(d.src, Some(&mut to), d.sha, d.size);
    if !matches!(copied, Ok(true)) {
        let _ = std::fs::remove_file(&path);
        m.unvouched += with_sig;
        m.mismatched += usize::from(copied.is_ok());
        return copied.map(|_| ());
    }
    let sig = match beside(index, d.name, downloaded, vouch) {
        Beside::Signature(sig) => Some(sig),
        Beside::Nothing => None,
        Beside::Unvouched => {
            let _ = std::fs::remove_file(&path);
            m.unvouched += 1 + with_sig;
            return Ok(());
        }
    };
    let placed = (|| {
        remove_merged(work_root, arch, d.name);
        remove_merged(work_root, arch, &sig_name);
        if let Some(sig) = &sig {
            put_signature(work_root, arch, &sig_name, sig)?;
        }
        commit(&to, &path, &shared.join(d.name), &shared)
    })();
    if let Err(e) = placed {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    // A record that is not written leaves the file to be hashed again at the next pass.
    let _ = write_record(work_root, arch, d.name, d.sha, d.size);
    m.merged += 1;
    m.bytes += d.size;
    // The one downloaded, if any, was these bytes ([`beside`]): it is the one put there.
    m.signed += usize::from(sig.is_some());
    Ok(())
}

/// The pool's copy of a signature put in the shared cache as `name`, its record first.
fn put_signature(work_root: &Path, arch: &str, name: &str, sig: &[u8]) -> std::io::Result<()> {
    let shared = pacman_dir(work_root, arch);
    write_record(
        work_root,
        arch,
        name,
        &hex::encode(Sha256::digest(sig)),
        sig.len() as u64,
    )?;
    let path = tmp_dir(work_root).join("signature-merging.part");
    let placed = part(&path).and_then(|mut to| {
        to.write_all(sig)?;
        commit(&to, &path, &shared.join(name), &shared)
    });
    if placed.is_err() {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(merged_dir(work_root, arch).join(name));
    }
    placed
}

/// What a check of the shared pacman cache against the databases of the day did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Rechecked {
    /// Files whose name the databases now list with other bytes, or twice at odds, or that
    /// are not whole, and signatures beside no package or without their record: removed.
    pub removed: usize,
    pub freed: u64,
    /// Files without a record (a crash before it was written) hashed, found to be the
    /// listed bytes and recorded.
    pub adopted: usize,
}

impl Rechecked {
    fn add(&mut self, o: &Rechecked) {
        self.removed += o.removed;
        self.freed += o.freed;
        self.adopted += o.adopted;
    }
}

/// The shared pacman cache of `arch` checked again against `index`, the databases of the
/// day (#341): a file was merged by the snapshot of its day, and a task resolves by
/// today's. A name they now list with other bytes than its record's — a source that
/// published the same file name since — or list twice at odds would fail every task that
/// resolves it (pacman refuses the bytes and cannot delete them from a read-only cache),
/// so it goes; so does one whose size is not its record's (a crash while it was written).
/// A file without a record is hashed and kept only when it is the listed bytes. A name no
/// database lists any more (an older version) is no task's to resolve: the versions'
/// pruning takes it. A package's signature stays only beside its package, whole and with its
/// record (the pool's copy, recorded before it was put there); one that is not takes its
/// package with it, the package first. Records of files no longer there go too. `index` must not be empty: without the
/// databases nothing is known, and nothing is removed.
pub fn recheck(work_root: &Path, arch: &str, index: &Index) -> Rechecked {
    let mut out = Rechecked::default();
    if index.is_empty() {
        return out;
    }
    let (shared, records) = (pacman_dir(work_root, arch), merged_dir(work_root, arch));
    let mut signatures = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&shared) {
        for e in entries.flatten() {
            let Ok(name) = e.file_name().into_string() else {
                continue;
            };
            let Ok(md) = e.metadata() else { continue };
            if !md.file_type().is_file() {
                continue;
            }
            if name.strip_suffix(".sig").is_some() {
                signatures.push((e.path(), name, md.len()));
                continue;
            }
            let record = read_record(&records.join(&name));
            let keep = match index.listed(&name) {
                Listed::Ambiguous => false,
                Listed::Unknown => record.is_none_or(|(_, n)| n == md.len()),
                Listed::Once(_, size) if md.len() != size => false,
                Listed::Once(sha, size) => match record {
                    Some(r) => r == (sha, size),
                    None => match verify(&e.path(), None, &sha, size) {
                        Ok(true) => {
                            let _ = write_record(work_root, arch, &name, &sha, size);
                            out.adopted += 1;
                            true
                        }
                        Ok(false) => false,
                        // Unread is not other bytes: judged again at the next pass.
                        Err(_) => true,
                    },
                },
            };
            if !keep && std::fs::remove_file(e.path()).is_ok() {
                let _ = std::fs::remove_file(records.join(&name));
                out.removed += 1;
                out.freed += md.len();
            }
        }
    }
    // After the packages: one removed above leaves its signature beside nothing. One not
    // whole, or without its record, takes its package with it, first: a package without the
    // signature it was merged with fails every task of a repository that checks it.
    for (path, name, len) in signatures {
        let package = name.strip_suffix(".sig").unwrap_or(&name);
        let beside = shared
            .join(package)
            .symlink_metadata()
            .is_ok_and(|md| md.is_file());
        if beside && read_record(&records.join(&name)).is_some_and(|(_, n)| n == len) {
            continue;
        }
        if beside {
            let size = std::fs::symlink_metadata(shared.join(package)).map_or(0, |md| md.len());
            if remove_merged(work_root, arch, package) {
                out.removed += 1;
                out.freed += size;
            }
        }
        if std::fs::remove_file(&path).is_ok() {
            let _ = std::fs::remove_file(records.join(&name));
            out.removed += 1;
            out.freed += len;
        }
    }
    if let Ok(entries) = std::fs::read_dir(&records) {
        for e in entries.flatten() {
            if shared.join(e.file_name()).symlink_metadata().is_err() {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    out
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

/// The shared pacman caches of both architectures pruned: the two newest versions of each
/// package kept, then, while they hold more than `cap` bytes, the oldest merged removed
/// first, a package's older version before any newest one; a file's record goes with it, and
/// its signature after it. A signature is no version of its own, and one beside no package
/// goes.
///
/// A task's pacman that found a file here before it was removed, and opens it again to
/// check or install it, fails its transaction (`could not find package in cache`: it does
/// not download what it chose not to): rare — an older version first, a newest one only
/// above the cap — and the pool runs the build again. Holding every removal until no lease
/// that could have chosen the file runs would hold a busy host over its cap for good. A
/// host that sees it often has a `pacman_gb` too small for what its builds need at once.
pub fn prune_pacman(work_root: &Path, cap: u64) -> Pruned {
    struct File {
        path: PathBuf,
        record: PathBuf,
        /// Its signature, with its record and length.
        sig: Option<(PathBuf, PathBuf, u64)>,
        /// Its length and its signature's.
        len: u64,
        at: SystemTime,
        newest: bool,
    }
    // What was removed: how many files, how many bytes. The package first: a task that finds
    // its signature alone downloads the package itself, one that finds the package alone fails.
    let remove = |f: &File| -> (usize, u64) {
        if std::fs::remove_file(&f.path).is_err() {
            return (0, 0);
        }
        let _ = std::fs::remove_file(&f.record);
        let mut gone = (1, f.len);
        if let Some((sig, record, len)) = &f.sig {
            if std::fs::remove_file(sig).is_ok() {
                let _ = std::fs::remove_file(record);
                gone.0 += 1;
            } else {
                gone.1 -= len;
            }
        }
        gone
    };
    let mut out = Pruned::default();
    let mut kept: Vec<File> = Vec::new();
    for arch in ARCHES {
        let Ok(entries) = std::fs::read_dir(pacman_dir(work_root, arch)) else {
            continue;
        };
        let records = merged_dir(work_root, arch);
        let (mut files, mut sigs) = (Vec::new(), HashMap::new());
        for e in entries.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if !md.file_type().is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            match name.strip_suffix(".sig") {
                Some(package) => {
                    sigs.insert(
                        package.to_owned(),
                        (e.path(), records.join(&name), md.len()),
                    );
                }
                None => files.push((name, e.path(), md)),
            }
        }
        let mut by_package: BTreeMap<String, Vec<(String, File)>> = BTreeMap::new();
        for (name, path, md) in files {
            let sig = sigs.remove(&name);
            let f = File {
                path,
                record: records.join(&name),
                len: md.len() + sig.as_ref().map_or(0, |s| s.2),
                sig,
                at: md.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                newest: false,
            };
            // A file whose name says no version is a package of its own.
            let (pkg, ver) = package_of(&name).unwrap_or_else(|| (name.clone(), String::new()));
            by_package.entry(pkg).or_default().push((ver, f));
        }
        // A signature beside no package.
        for (path, record, len) in sigs.into_values() {
            if std::fs::remove_file(&path).is_ok() {
                let _ = std::fs::remove_file(record);
                out.removed += 1;
                out.freed += len;
            }
        }
        for (_, mut versions) in by_package {
            versions.sort_by(|(a, _), (b, _)| pkg_manifest::vercmp(b, a));
            for (i, (_, mut f)) in versions.into_iter().enumerate() {
                if i < KEEP_VERSIONS {
                    f.newest = i == 0;
                    kept.push(f);
                } else {
                    let (n, freed) = remove(&f);
                    out.removed += n;
                    out.freed += freed;
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
        let (n, freed) = remove(f);
        out.removed += n;
        out.freed += freed;
        total -= freed;
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
/// started meanwhile). Under [`BUILD_LOCK`] a cache is only moved out of the tree (a
/// rename), and deleted after it: a ccache of a few hundred thousand files takes long to
/// delete, and a lease's start on the dispatcher's main loop waits on that lock.
pub fn prune_build(
    work_root: &Path,
    cap: u64,
    in_use: &BTreeSet<PathBuf>,
    since: SystemTime,
) -> Pruned {
    struct Pkg {
        dir: PathBuf,
        stamp: PathBuf,
        trash: PathBuf,
        size: u64,
        at: SystemTime,
    }
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let trash = trash_dir(work_root);
    let mut pkgs = Vec::new();
    for trust in [Trust::Community, Trust::Project] {
        for arch in ARCHES {
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
                let n = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                pkgs.push(Pkg {
                    size: usage(&dir),
                    trash: trash.join(format!("{}-{arch}-{name}-{n}", trust.as_str())),
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
        let gone = {
            let _held = BUILD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
            if mtime(&p.stamp).is_some_and(|t| t >= since) {
                continue;
            }
            let moved = std::fs::create_dir_all(&trash)
                .and_then(|()| std::fs::rename(&p.dir, &p.trash))
                .is_ok();
            // A tree on another file system (a link of the owner's) is deleted where it is.
            let gone = moved || std::fs::remove_dir_all(&p.dir).is_ok();
            if gone {
                let _ = std::fs::remove_file(&p.stamp);
            }
            gone
        };
        if gone {
            let _ = std::fs::remove_dir_all(&p.trash);
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
    /// The shared pacman caches checked again against the databases of the day.
    pub rechecked: Rechecked,
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
                "the downloads of {} lease(s): {} merged into the shared pacman cache ({} MB) and {} signature(s) of the pool's beside their package, {} there already, {} discarded ({} not the bytes the pool's signed databases list, {} listed by none, {} listed twice with different bytes, {} for a signature the pool does not keep as the one downloaded, {} no package file)",
                self.leases,
                m.merged,
                m.bytes >> 20,
                m.signed,
                m.present,
                m.discarded(),
                m.mismatched,
                m.unknown,
                m.ambiguous,
                m.unvouched,
                m.refused
            ));
        }
        if m.failed > 0 {
            parts.push(format!(
                "{} listed download(s) could not be copied into the shared pacman cache (the disk, not the bytes; below)",
                m.failed
            ));
        }
        if m.withdrawn > 0 {
            parts.push(format!(
                "{} package(s) taken out of the shared pacman cache: there without the signature a task's pacman downloaded with them, and none of the pool's to put beside them",
                m.withdrawn
            ));
        }
        let c = &self.rechecked;
        if c.removed > 0 {
            parts.push(format!(
                "{} file(s) of the shared pacman cache removed: the pool's signed databases list other bytes under their names now, or they were not whole ({} MB)",
                c.removed,
                c.freed >> 20
            ));
        }
        if c.adopted > 0 {
            parts.push(format!(
                "{} file(s) of the shared pacman cache without a record hashed: the listed bytes, kept",
                c.adopted
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

/// One pass: both caches pruned to their caps first, with no network (a pool that does
/// not answer, which the refresh may wait minutes on, never holds them over their caps);
/// then, for each architecture with downloads set aside or a shared cache that holds
/// anything, the signed databases (fetched again when stale): the shared cache checked
/// again by them and every lease's downloads merged back by them or discarded; then the
/// pacman cache pruned again, with what came in.
pub fn upkeep(u: &Upkeep) -> Report {
    let since = SystemTime::now();
    let mut r = Report::default();
    let w = &u.work_root;
    let tmp = tmp_dir(w);
    let _ = std::fs::remove_dir_all(&tmp);
    // What an earlier pass moved out of the build caches and did not finish deleting.
    let _ = std::fs::remove_dir_all(trash_dir(w));
    r.build = prune_build(w, u.caps.build, &u.in_use, since);
    r.pacman = prune_pacman(w, u.caps.pacman);
    let mut failure = None;
    for arch in ARCHES {
        let leases: Vec<PathBuf> = std::fs::read_dir(incoming_dir(w).join(arch))
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        let holds = std::fs::read_dir(pacman_dir(w, arch)).is_ok_and(|mut d| d.next().is_some());
        if leases.is_empty() && !holds {
            continue;
        }
        let index = match key_file(w, u.key.as_deref()) {
            Ok(key) => {
                r.notes
                    .extend(refresh(&*u.pool, &u.pool_url, w, arch, &key));
                let (index, notes) = load(w, arch, &key);
                r.notes.extend(notes);
                index
            }
            Err(e) => {
                r.notes.push(format!("the pool's key: {e}"));
                Index::default()
            }
        };
        if index.is_empty() {
            if !leases.is_empty() {
                r.notes.push(format!(
                    "no signed database of {arch} could be read: every download of these leases is discarded"
                ));
            }
        } else {
            r.rechecked.add(&recheck(w, arch, &index));
        }
        let mut signatures = Signatures {
            pool: &*u.pool,
            pool_url: &u.pool_url,
            arch,
            tmp: tmp.clone(),
            unanswered: None,
        };
        for lease in leases {
            let (m, err) = merge(w, arch, &lease, &index, &mut |source, file| {
                signatures.of(source, file)
            });
            r.merged.add(&m);
            if failure.is_none() {
                failure = err;
            }
            r.leases += 1;
            let _ = std::fs::remove_dir_all(&lease);
        }
        if let Some(e) = signatures.unanswered {
            r.notes.push(format!(
                "the pool's copies of the packages' signatures ({arch}): {e}; no package new to the shared cache is merged until it answers (asked again at the next pass)"
            ));
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    if let Some(e) = failure {
        r.notes.push(format!("the first copy that failed: {e}"));
    }
    let after = prune_pacman(w, u.caps.pacman);
    r.pacman = Pruned {
        removed: r.pacman.removed + after.removed,
        freed: r.pacman.freed + after.freed,
        left: after.left,
    };
    r
}

#[cfg(test)]
pub(crate) mod tests {
    //! The caches' own tests (#341): the merge-back against the fixture databases
    //! (`tests/fixtures/pool-dbs/`, signed by a key of their own, `write_the_fixtures`),
    //! with matching, mismatching, unknown and ambiguous files, and a file there already
    //! with other bytes replaced; a package's signature merged only as the pool's own copy
    //! and beside its package; the shared cache checked again by a later snapshot of the
    //! databases, a signature beside no package or without its record removed; a database
    //! that does not verify left unread; the pacman cache pruned to two versions and its
    //! cap, a signature with its package; the build caches least recently used first and
    //! never one in use. (`refresh` and [`Signatures`] against a pool are the dispatcher's
    //! tests', with its fake pool.)

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
        place_only(work, arch, &["core", "packages"]);
    }

    /// Only these sources' fixture databases in `<work>/cache/syncdb/<arch>`: a snapshot of the pool's.
    fn place_only(work: &Path, arch: &str, sources: &[&str]) {
        let dir = db_dir(work, arch);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for source in sources {
            for f in [db_name(source), format!("{}.sig", db_name(source))] {
                std::fs::copy(fixture_dir().join(&f), dir.join(&f)).unwrap();
            }
        }
    }

    fn sha(b: &[u8]) -> String {
        hex::encode(Sha256::digest(b))
    }

    /// A pool that keeps no copy of any signature.
    #[allow(clippy::unnecessary_wraps)] // a `Vouch`
    fn none(_: &str, _: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .map(|d| {
                d.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
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
        other.add("core", &planted).unwrap();
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
    #[allow(clippy::too_many_lines)] // each kind of download, then what is already there
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
        let lib = fixture_bytes("libfixture", "libfixture", arch);
        put(&file("libfixture", arch), &lib);
        // Mismatching: listed, other bytes of the same size, and other bytes of another size.
        let evil = fixture_bytes("evil", "evil", arch);
        let mut same_size = evil.clone();
        same_size[0] ^= 1;
        put(&file("evil", arch), &same_size);
        // A signature beside a package that is not merged: discarded, the pool not asked.
        put(&format!("evil-1.0-1-{arch}.pkg.tar.zst.sig"), b"x");
        // Unknown: a recipe's own file, and pacman's half-downloaded one.
        put(&file("stranger", arch), b"planted");
        put(&format!("{}.part", file("libfixture", arch)), &lib);
        // Ambiguous: the bytes core lists, which packages lists otherwise.
        put(&file("twin", arch), &fixture_bytes("twin", "core", arch));
        // A link to a file the dispatcher can read is no download.
        std::os::unix::fs::symlink(
            fixture_dir().join("pool.pub.asc"),
            incoming.join(file("linked", arch)),
        )
        .unwrap();
        let shared = pacman_dir(work, arch);
        let (m, failure) = merge(work, arch, &incoming, &index, &mut none);
        assert_eq!(
            m,
            Merged {
                merged: 1,
                bytes: lib.len() as u64,
                present: 0,
                mismatched: 1,
                unknown: 2,
                ambiguous: 1,
                signed: 0,
                unvouched: 1,
                refused: 2,
                failed: 0,
                withdrawn: 0,
            }
        );
        assert_eq!(failure, None);
        assert_eq!(names_in(&shared), [file("libfixture", arch)]);
        let merged = shared.join(file("libfixture", arch));
        assert_eq!(std::fs::read(&merged).unwrap(), lib);
        assert_eq!(
            std::fs::metadata(&merged).unwrap().permissions().mode() & 0o7777,
            0o644
        );
        // Its record: the bytes it was merged as.
        assert_eq!(
            read_record(&merged_dir(work, arch).join(file("libfixture", arch))),
            Some((sha(&lib), lib.len() as u64))
        );
        // The same file from a second lease is there already; nothing half-made is left behind.
        let (m, _) = merge(work, arch, &incoming, &index, &mut none);
        assert_eq!((m.merged, m.present), (0, 1));
        assert_eq!(std::fs::read_dir(tmp_dir(work)).unwrap().count(), 0);
        // There with other bytes than the listed ones (merged by another listing, or not whole
        // after a crash): replaced by the listed bytes, and recorded as them.
        let mut stale = lib.clone();
        stale[3] ^= 1;
        std::fs::write(&merged, &stale).unwrap();
        write_record(
            work,
            arch,
            &file("libfixture", arch),
            &sha(&stale),
            stale.len() as u64,
        )
        .unwrap();
        let (m, _) = merge(work, arch, &incoming, &index, &mut none);
        assert_eq!((m.merged, m.present), (1, 0));
        assert_eq!(std::fs::read(&merged).unwrap(), lib);
        std::fs::write(&merged, &lib[..10]).unwrap();
        let (m, _) = merge(work, arch, &incoming, &index, &mut none);
        assert_eq!((m.merged, m.present), (1, 0));
        assert_eq!(std::fs::read(&merged).unwrap(), lib);
        // A copy that fails for the disk's sake is no mismatch: counted apart, and said.
        let t3 = tempfile::tempdir().unwrap();
        place_fixtures(t3.path(), arch);
        std::fs::create_dir_all(t3.path().join("cache")).unwrap();
        std::fs::write(tmp_dir(t3.path()), b"not a directory").unwrap();
        let (m, failure) = merge(t3.path(), arch, &incoming, &index, &mut none);
        assert_eq!((m.merged, m.failed, m.mismatched, m.unknown), (0, 2, 0, 2));
        assert!(
            failure
                .as_deref()
                .is_some_and(|f| f.contains(".pkg.tar.zst: ") && f.contains("Not a directory")),
            "{failure:?}"
        );
        // With no database read, everything is discarded.
        let t2 = tempfile::tempdir().unwrap();
        let (m, _) = merge(t2.path(), arch, &incoming, &Index::default(), &mut none);
        assert_eq!((m.merged, m.unknown, m.unvouched), (0, 5, 1));
        assert!(names_in(&pacman_dir(t2.path(), arch)).is_empty());
    }

    /// A package's signature (#341): pacman downloads one beside each package of a repository
    /// whose `SigLevel` checks packages, and fails on a package in a cache without its `.sig`
    /// beside it, or beside a wrong one. A package is merged with the pool's own copy of its
    /// upstream signature beside it — which must be the very bytes its task downloaded, when it
    /// downloaded one — or not at all; one the pool keeps none of goes alone.
    #[test]
    #[allow(clippy::too_many_lines)] // a vouched signature, then every way one is not
    fn a_package_is_merged_with_the_pools_own_copy_of_its_signature_or_not_at_all() {
        let t = tempfile::tempdir().unwrap();
        let work = t.path();
        let arch = "x86_64";
        let key = fixture_dir().join("pool.pub.asc");
        place_fixtures(work, arch);
        let (index, _) = load(work, arch, &key);
        let shared = pacman_dir(work, arch);
        let lib = fixture_bytes("libfixture", "libfixture", arch);
        let libname = file("libfixture", arch);
        let sig_name = format!("{libname}.sig");
        let upstream = b"libfixture's upstream signature".to_vec();
        // The pool's copies, by source and file; and what was asked of it.
        let pool: HashMap<(String, String), Vec<u8>> =
            [(("core".to_owned(), libname.clone()), upstream.clone())].into();
        let asked = std::cell::RefCell::new(Vec::new());
        let mut vouch = |source: &str, file: &str| {
            asked.borrow_mut().push(format!("{source}/{file}"));
            Ok(pool.get(&(source.to_owned(), file.to_owned())).cloned())
        };
        let leases = std::cell::Cell::new(0);
        let lease = |files: &[(&str, &[u8])]| {
            leases.set(leases.get() + 1);
            let dir = work.join(format!("incoming-{}", leases.get()));
            std::fs::create_dir_all(&dir).unwrap();
            for (name, bytes) in files {
                std::fs::write(dir.join(name), bytes).unwrap();
            }
            dir
        };
        let fresh = || {
            let t = tempfile::tempdir().unwrap();
            place_fixtures(t.path(), arch);
            t
        };
        // The package and its signature, the one the pool keeps: both there, the signature
        // asked of core (the source whose database lists the package), recorded.
        let signed = lease(&[(&libname, &lib), (&sig_name, &upstream)]);
        let (m, failure) = merge(work, arch, &signed, &index, &mut vouch);
        assert_eq!((m.merged, m.signed, m.unvouched, failure), (1, 1, 0, None));
        assert_eq!(*asked.borrow(), [format!("core/{libname}")]);
        assert_eq!(std::fs::read(shared.join(&sig_name)).unwrap(), upstream);
        assert_eq!(
            std::fs::metadata(shared.join(&sig_name))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o644
        );
        assert_eq!(
            read_record(&merged_dir(work, arch).join(&sig_name)),
            Some((sha(&upstream), upstream.len() as u64))
        );
        // A second lease's same two files: there already, the pool not asked again; and a
        // signature a recipe forged beside the package there: the pool's stays.
        let (m, _) = merge(work, arch, &signed, &index, &mut vouch);
        assert_eq!((m.present, m.signed), (2, 0));
        let forged = lease(&[(&libname, &lib), (&sig_name, b"forged by a recipe")]);
        let (m, _) = merge(work, arch, &forged, &index, &mut vouch);
        assert_eq!((m.present, m.signed, m.unvouched), (2, 0, 0));
        assert_eq!(asked.borrow().len(), 1);
        assert_eq!(std::fs::read(shared.join(&sig_name)).unwrap(), upstream);
        // Into a shared cache that does not hold it: the forged one keeps the package out,
        // since a task of its repository would fail on either.
        let t2 = fresh();
        let (m, _) = merge(t2.path(), arch, &forged, &index, &mut vouch);
        assert_eq!((m.merged, m.signed, m.unvouched), (0, 0, 2));
        assert!(names_in(&pacman_dir(t2.path(), arch)).is_empty());
        // Downloaded without one (its recipe deleted it, or its repository checks none): the
        // pool's copy goes beside it all the same.
        let alone = lease(&[(&libname, &lib)]);
        let (m, _) = merge(t2.path(), arch, &alone, &index, &mut vouch);
        assert_eq!((m.merged, m.signed), (1, 1));
        assert_eq!(
            std::fs::read(pacman_dir(t2.path(), arch).join(&sig_name)).unwrap(),
            upstream
        );
        // The pool keeps none: alone, unless its task downloaded one (then not at all).
        let mut no_copy = |_: &str, _: &str| Ok(None);
        let t3 = fresh();
        let (m, _) = merge(t3.path(), arch, &signed, &index, &mut no_copy);
        assert_eq!((m.merged, m.unvouched), (0, 2));
        let (m, _) = merge(t3.path(), arch, &alone, &index, &mut no_copy);
        assert_eq!((m.merged, m.signed), (1, 0));
        assert_eq!(names_in(&pacman_dir(t3.path(), arch)), [libname.as_str()]);
        // There alone, then a task's pacman downloads it with a signature (its repository
        // checks them, and failed on it): the pool's copy goes beside it now ...
        let (m, _) = merge(t3.path(), arch, &signed, &index, &mut vouch);
        assert_eq!((m.present, m.signed), (1, 1));
        assert_eq!(
            names_in(&pacman_dir(t3.path(), arch)),
            [libname.as_str(), sig_name.as_str()]
        );
        // ... or, with none of the pool's, it goes: every task of that repository fails on it.
        let t4 = fresh();
        merge(t4.path(), arch, &alone, &index, &mut no_copy);
        let (m, _) = merge(t4.path(), arch, &signed, &index, &mut no_copy);
        assert_eq!((m.withdrawn, m.unvouched, m.present), (1, 2, 0));
        assert!(names_in(&pacman_dir(t4.path(), arch)).is_empty());
        assert!(names_in(&merged_dir(t4.path(), arch)).is_empty());
        // A pool that does not answer: nothing merged, and asked once for the package.
        let calls = std::cell::Cell::new(0);
        let mut deaf = |_: &str, _: &str| {
            calls.set(calls.get() + 1);
            Err("the pool is down".to_owned())
        };
        let t5 = fresh();
        let (m, _) = merge(t5.path(), arch, &alone, &index, &mut deaf);
        assert_eq!((m.merged, m.unvouched, calls.get()), (0, 1, 1));
        assert!(names_in(&pacman_dir(t5.path(), arch)).is_empty());
        // Listed once by two sources whose upstreams signed the bytes each: which one a task's
        // keyring takes is its repository's, so neither goes, nor the package. One copy: it.
        let mut two = Index::default();
        let core_db = std::fs::read(fixture_dir().join(db_name("core"))).unwrap();
        two.add("core", &core_db).unwrap();
        two.add("extra", &core_db).unwrap();
        assert!(matches!(two.listed(&libname), Listed::Once(..)));
        let mut differ = |source: &str, _: &str| Ok(Some(source.as_bytes().to_vec()));
        let t6 = fresh();
        let (m, _) = merge(t6.path(), arch, &alone, &two, &mut differ);
        assert_eq!((m.merged, m.unvouched), (0, 1));
        let mut agree = |_: &str, _: &str| Ok(Some(upstream.clone()));
        let (m, _) = merge(t6.path(), arch, &signed, &two, &mut agree);
        assert_eq!((m.merged, m.signed), (1, 1));
        // Beside a package not merged (other bytes) or with none (one no database lists, one
        // listed twice at odds, none in the lease), or as a link: discarded, the pool not asked.
        let before = asked.borrow().len();
        let mut evil = fixture_bytes("evil", "evil", arch);
        evil[0] ^= 1;
        let odd = lease(&[
            (&file("evil", arch), &evil),
            (&format!("{}.sig", file("evil", arch)), b"sig"),
            (&file("stranger", arch), b"x"),
            (&format!("{}.sig", file("stranger", arch)), b"sig"),
            (&format!("{}.sig", file("twin", arch)), b"sig"),
        ]);
        std::os::unix::fs::symlink(
            shared.join(&sig_name),
            odd.join(format!("{}.sig", file("linked", arch))),
        )
        .unwrap();
        let (m, _) = merge(work, arch, &odd, &index, &mut vouch);
        assert_eq!(
            (m.mismatched, m.unknown, m.unvouched, m.refused, m.signed),
            (1, 1, 3, 1, 0),
            "{m:?}"
        );
        assert_eq!(asked.borrow().len(), before);
        // A signature past 16 KiB is none of the pool's: the package stays out.
        let long = lease(&[(&libname, &lib), (&sig_name, &vec![b'x'; 16 * 1024 + 1])]);
        let t7 = fresh();
        let (m, _) = merge(t7.path(), arch, &long, &index, &mut vouch);
        assert_eq!((m.merged, m.unvouched), (0, 2));
        // A package replaced (there with other bytes than the databases list now): the old
        // package goes, then its signature, and the new bytes come with the pool's copy.
        let mut stale = lib.clone();
        stale[3] ^= 1;
        std::fs::write(shared.join(&libname), &stale).unwrap();
        write_record(work, arch, &libname, &sha(&stale), stale.len() as u64).unwrap();
        std::fs::write(shared.join(&sig_name), b"the old bytes' signature").unwrap();
        let (m, _) = merge(work, arch, &alone, &index, &mut vouch);
        assert_eq!((m.merged, m.signed), (1, 1));
        assert_eq!(std::fs::read(shared.join(&libname)).unwrap(), lib);
        assert_eq!(std::fs::read(shared.join(&sig_name)).unwrap(), upstream);
        assert_eq!(std::fs::read_dir(tmp_dir(work)).unwrap().count(), 0);
    }

    /// The shared cache against the databases of the day (#341): a file merged when one
    /// snapshot listed it goes once another lists its name with other bytes, or twice at
    /// odds, or once it is not whole; a file without a record is kept only as the listed
    /// bytes; one no database lists any more stays for the versions' pruning; a signature
    /// stays only beside its package, whole and recorded, or takes its package with it.
    #[test]
    #[allow(clippy::too_many_lines)] // one shared cache through four snapshots of the databases
    fn every_pass_checks_the_shared_cache_again_by_the_databases_of_the_day() {
        let t = tempfile::tempdir().unwrap();
        let work = t.path();
        let arch = "x86_64";
        let key = fixture_dir().join("pool.pub.asc");
        let shared = pacman_dir(work, arch);
        let records = merged_dir(work, arch);
        let incoming = work.join("incoming");
        std::fs::create_dir_all(&incoming).unwrap();
        let (lib, twin_core, twin_packages) = (
            fixture_bytes("libfixture", "libfixture", arch),
            fixture_bytes("twin", "core", arch),
            fixture_bytes("twin", "packages", arch),
        );
        // The first snapshot: core only, which lists twin once, as its own bytes.
        place_only(work, arch, &["core"]);
        let (core_only, _) = load(work, arch, &key);
        std::fs::write(incoming.join(file("libfixture", arch)), &lib).unwrap();
        std::fs::write(incoming.join(file("twin", arch)), &twin_core).unwrap();
        assert_eq!(
            merge(work, arch, &incoming, &core_only, &mut none).0.merged,
            2
        );
        // A file with no record but the listed bytes (a crash before its record was written),
        // one with no record and other bytes of the listed size, two no database lists, and a
        // record of nothing.
        std::fs::remove_file(records.join(file("twin", arch))).unwrap();
        let mut evil = fixture_bytes("evil", "evil", arch);
        evil[0] ^= 1;
        std::fs::write(shared.join(file("evil", arch)), &evil).unwrap();
        std::fs::write(shared.join("libfixture-0.9-1-x86_64.pkg.tar.zst"), b"old").unwrap();
        std::fs::write(shared.join(file("stranger", arch)), b"by hand").unwrap();
        std::fs::write(records.join("gone-1.0-1-x86_64.pkg.tar.zst"), "x 1\n").unwrap();
        // Signatures: libfixture's as a merge leaves it (with its record), one beside no
        // package (with its record), and twin's without a record (a crash before it was written).
        let lib_sig = b"libfixture's upstream signature".to_vec();
        let sig_of = |name: &str| format!("{name}.sig");
        std::fs::write(shared.join(sig_of(&file("libfixture", arch))), &lib_sig).unwrap();
        write_record(
            work,
            arch,
            &sig_of(&file("libfixture", arch)),
            &sha(&lib_sig),
            lib_sig.len() as u64,
        )
        .unwrap();
        std::fs::write(shared.join(sig_of("gone-1.0-1-x86_64.pkg.tar.zst")), b"sig").unwrap();
        write_record(
            work,
            arch,
            &sig_of("gone-1.0-1-x86_64.pkg.tar.zst"),
            &sha(b"sig"),
            3,
        )
        .unwrap();
        // A signature without its record (none of the dispatcher's: it writes the record
        // first) takes its package with it, the package first.
        std::fs::write(shared.join(file("felix", arch)), b"felix").unwrap();
        std::fs::write(shared.join(sig_of(&file("felix", arch))), b"unrecorded").unwrap();
        let c = recheck(work, arch, &core_only);
        assert_eq!(
            (c.removed, c.freed, c.adopted),
            (4, evil.len() as u64 + 3 + 5 + 10, 1),
            "{c:?}"
        );
        assert!(!shared.join(file("evil", arch)).exists());
        assert!(!shared
            .join(sig_of("gone-1.0-1-x86_64.pkg.tar.zst"))
            .exists());
        assert!(!shared.join(file("felix", arch)).exists());
        assert!(!shared.join(sig_of(&file("felix", arch))).exists());
        assert_eq!(
            names_in(&records),
            [
                file("libfixture", arch),
                sig_of(&file("libfixture", arch)),
                file("twin", arch)
            ]
        );
        // libfixture-0.9 is listed by none: kept, as the stranger. Now cut short, a recorded
        // file goes, and its signature with it.
        std::fs::write(shared.join(file("libfixture", arch)), &lib[..7]).unwrap();
        let c = recheck(work, arch, &core_only);
        assert_eq!((c.removed, c.freed), (2, 7 + lib_sig.len() as u64));
        assert!(!shared.join(sig_of(&file("libfixture", arch))).exists());
        assert_eq!(names_in(&records), [file("twin", arch)]);
        // The next snapshot lists twin twice at odds: no task can trust it, it goes.
        place_only(work, arch, &["core", "packages"]);
        let (both, _) = load(work, arch, &key);
        assert_eq!(recheck(work, arch, &both).removed, 1);
        assert!(!shared.join(file("twin", arch)).exists());
        // Merged again by core's listing, then a snapshot where only packages lists the name, otherwise.
        assert_eq!(
            merge(work, arch, &incoming, &core_only, &mut none).0.merged,
            2
        );
        place_only(work, arch, &["packages"]);
        let (packages_only, _) = load(work, arch, &key);
        assert_eq!(recheck(work, arch, &packages_only).removed, 1);
        assert!(!shared.join(file("twin", arch)).exists());
        std::fs::write(incoming.join(file("twin", arch)), &twin_packages).unwrap();
        let (m, _) = merge(work, arch, &incoming, &packages_only, &mut none);
        assert_eq!(m.merged, 1);
        assert_eq!(
            std::fs::read(shared.join(file("twin", arch))).unwrap(),
            twin_packages
        );
        assert_eq!(
            names_in(&shared),
            [
                "libfixture-0.9-1-x86_64.pkg.tar.zst".to_owned(),
                file("libfixture", arch),
                file("stranger", arch),
                file("twin", arch)
            ]
        );
        // Without the databases nothing is known, and nothing goes.
        assert_eq!(recheck(work, arch, &Index::default()), Rechecked::default());
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
        let work = t.path();
        let (a, x) = (pacman_dir(work, "aarch64"), pacman_dir(work, "x86_64"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&x).unwrap();
        // zlib: four versions, epochs and pkgrels among them; vercmp orders them, not the names.
        for (v, ago) in [
            ("1:1.3.1-1", 400),
            ("1:1.3.2-3", 100),
            ("1:1.3.2-10", 50),
            ("1.3.3-1", 10),
        ] {
            let f = format!("zlib-{v}-aarch64.pkg.tar.zst");
            write_at(&a.join(&f), 1000, ago);
            write_record(work, "aarch64", &f, &"0".repeat(64), 1000).unwrap();
        }
        write_at(&a.join("felix-2.0-1-any.pkg.tar.zst"), 1000, 300);
        write_at(&x.join("zlib-1:1.3.2-3-x86_64.pkg.tar.zst"), 1000, 200);
        // Signatures: no version of their own. The oldest version's goes with it, the newest's
        // stays with it, and one beside no package goes.
        for (f, ago) in [
            ("zlib-1:1.3.1-1-aarch64.pkg.tar.zst.sig", 400),
            ("zlib-1:1.3.2-10-aarch64.pkg.tar.zst.sig", 50),
            ("gone-1.0-1-aarch64.pkg.tar.zst.sig", 10),
        ] {
            write_at(&a.join(f), 100, ago);
            write_record(work, "aarch64", f, &"0".repeat(64), 100).unwrap();
        }
        let p = prune_pacman(work, u64::MAX);
        assert_eq!((p.removed, p.freed, p.left), (4, 2200, 4100));
        assert_eq!(
            names_in(&a),
            [
                "felix-2.0-1-any.pkg.tar.zst",
                "zlib-1:1.3.2-10-aarch64.pkg.tar.zst",
                "zlib-1:1.3.2-10-aarch64.pkg.tar.zst.sig",
                "zlib-1:1.3.2-3-aarch64.pkg.tar.zst"
            ]
        );
        // A file's record goes with it.
        assert_eq!(
            names_in(&merged_dir(work, "aarch64")),
            [
                "zlib-1:1.3.2-10-aarch64.pkg.tar.zst",
                "zlib-1:1.3.2-10-aarch64.pkg.tar.zst.sig",
                "zlib-1:1.3.2-3-aarch64.pkg.tar.zst"
            ]
        );
        // Above the cap: the older version goes before any newest one, then the oldest merged.
        let p = prune_pacman(work, 2500);
        assert_eq!((p.removed, p.left), (2, 2100));
        assert!(!a.join("zlib-1:1.3.2-3-aarch64.pkg.tar.zst").exists());
        assert!(!a.join("felix-2.0-1-any.pkg.tar.zst").exists());
        assert!(a.join("zlib-1:1.3.2-10-aarch64.pkg.tar.zst").exists());
        assert!(x.join("zlib-1:1.3.2-3-x86_64.pkg.tar.zst").exists());
        assert_eq!(prune_pacman(work, 0).left, 0);
        assert!(names_in(&a).is_empty());
        assert!(names_in(&merged_dir(work, "aarch64")).is_empty());
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
        // Moved out of the tree under the lock, deleted after it: nothing is left aside.
        assert!(names_in(&trash_dir(work)).is_empty());
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
        assert!(!collect(&tdir, work, "aarch64", 7, gen).unwrap());
        std::fs::write(tdir.join("pkgcache/x.pkg.tar.zst"), b"x").unwrap();
        assert!(!collect(&tdir, work, "riscv64", 7, gen).unwrap());
        assert!(collect(&tdir, work, "aarch64", 7, gen).unwrap());
        assert!(incoming_dir(work)
            .join("aarch64")
            .join(format!("7-{gen}"))
            .join("x.pkg.tar.zst")
            .is_file());
        assert!(!tdir.join("pkgcache").exists());
        // Downloads that cannot be set aside are an error the dispatcher says, not a quiet nothing.
        let other = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(other.path().join("cache")).unwrap();
        std::fs::write(incoming_dir(other.path()), b"not a directory").unwrap();
        std::fs::create_dir_all(tdir.join("pkgcache")).unwrap();
        std::fs::write(tdir.join("pkgcache/x.pkg.tar.zst"), b"x").unwrap();
        assert!(collect(&tdir, other.path(), "aarch64", 7, gen).is_err());
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
