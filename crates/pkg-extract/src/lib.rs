//! Out-of-band ABI extraction for Arch packages.
//!
//! Packages produced by `makepkg` are **never modified**. This crate reads a
//! `.pkg.tar.zst` and produces a [`PackageManifest`] by merging:
//!
//! 1. the declarative metadata in `.PKGINFO`;
//! 2. the ELF facts (`DT_SONAME`, `DT_NEEDED`, `.gnu.version_r`) of every shared
//!    object and executable in the archive.
//!
//! It is used both by the CI publisher (`pkg-extract` binary) and by the local
//! client when installing a package built from the AUR.

pub mod components;
pub mod elf;
pub mod pkginfo;

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use pkg_manifest::{DependencyRule, PackageManifest, PkgInfoFields, MANIFEST_SCHEMA_VERSION};
use sha2::{Digest, Sha256};
use tar::EntryType;

use crate::elf::ElfFacts;
use crate::pkginfo::PkgInfo;

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("archive does not contain .PKGINFO")]
    MissingPkgInfo,
    #[error("invalid .PKGINFO: {0}")]
    PkgInfo(#[from] pkginfo::PkgInfoError),
}

/// Entries larger than this are listed but not inspected: buffering a multi-GB
/// shared object (CUDA, some games) is not worth the memory, and such objects
/// are never the ones whose sonames decide an upgrade.
const MAX_INSPECT_BYTES: u64 = 512 * 1024 * 1024;

/// A `.PKGINFO` above this is refused, whatever its tar header claims: a real one is a
/// few KiB, and a compressed run of one byte would otherwise expand into memory.
pub const MAX_PKGINFO_BYTES: u64 = 1 << 20;

/// Metadata entries makepkg stores at the archive root; never part of `files`.
const METADATA_ENTRIES: [&str; 5] = [".PKGINFO", ".BUILDINFO", ".MTREE", ".INSTALL", ".CHANGELOG"];

/// Everything learned from one pass over the archive, before merging.
#[derive(Debug, Default)]
struct ArchiveScan {
    pkginfo: Option<PkgInfo>,
    files: BTreeSet<String>,
    elf: Vec<(String, ElfFacts)>,
    /// Go modules and crates.io crates the binaries embed (statically linked).
    components: Vec<pkg_manifest::Component>,
}

/// Reads a package archive and produces its manifest.
pub fn extract_manifest(archive: &Path) -> Result<PackageManifest, ExtractError> {
    let (sha256, size_download) = hash_file(archive)?;
    let scan = scan_archive(archive)?;
    let pkginfo = scan.pkginfo.as_ref().ok_or(ExtractError::MissingPkgInfo)?;
    let filename = archive
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(merge(pkginfo, &scan, sha256, size_download, filename)?)
}

/// First pass: SHA-256 and byte length of the archive as stored.
fn hash_file(path: &Path) -> Result<(String, u64), ExtractError> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

/// Opens a package archive for streaming, whatever makepkg compressed it with
/// (`.pkg.tar.zst` on Arch, `.pkg.tar.xz` on Arch Linux ARM, plain tar).
pub fn open_archive(path: &Path) -> std::io::Result<Box<dyn Read>> {
    let mut file = BufReader::new(File::open(path)?);
    let mut magic = [0u8; 6];
    let n = read_prefix(&mut file, &mut magic)?;
    let file = {
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(0))?;
        file
    };
    Ok(match &magic[..n] {
        [0x28, 0xb5, 0x2f, 0xfd, ..] => Box::new(zstd::Decoder::new(file)?),
        [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] => Box::new(xz2::read::XzDecoder::new(file)),
        _ => Box::new(file),
    })
}

/// A GNU long name, long link or pax extension member above this is refused by
/// [`check_archive`]: a real one is a path or a few attributes.
pub const MAX_EXTENSION_BYTES: u64 = 64 << 10;

/// Walks a package someone else built without reading its members' data, and
/// refuses one the tar reader would buffer whole before handing back an entry:
/// a GNU long name, long link or pax extension above [`MAX_EXTENSION_BYTES`]
/// (a compressed run of zeros expands into memory there, whatever the
/// package's size). A pax `size` (a member above 8 GiB) and a GNU sparse member
/// are refused too: they are what would make this walk and the reader's
/// disagree on where a member starts. Call it before [`extract_manifest`] on an
/// archive an untrusted build wrote.
pub fn check_archive(path: &Path) -> Result<(), ExtractError> {
    let refused = |why: String| -> ExtractError {
        std::io::Error::new(std::io::ErrorKind::InvalidData, why).into()
    };
    let mut archive = tar::Archive::new(open_archive(path)?);
    for entry in archive.entries()?.raw(true) {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if kind.is_gnu_sparse() {
            return Err(refused("a GNU sparse member".into()));
        }
        let pax = kind.is_pax_local_extensions() || kind.is_pax_global_extensions();
        if !(pax || kind.is_gnu_longname() || kind.is_gnu_longlink()) {
            continue;
        }
        let size = entry.header().entry_size()?;
        if size > MAX_EXTENSION_BYTES {
            return Err(refused(format!(
                "an extension member of {size} bytes, above {MAX_EXTENSION_BYTES}"
            )));
        }
        if pax {
            let mut b = Vec::new();
            entry.read_to_end(&mut b)?;
            for ext in tar::PaxExtensions::new(&b) {
                if ext?.key_bytes() == b"size" {
                    return Err(refused("a pax size (a member above 8 GiB)".into()));
                }
            }
        }
    }
    Ok(())
}

/// Second pass: stream the archive → tar, collecting `.PKGINFO`, the file list
/// and the ELF facts of every regular file that starts with the ELF magic.
fn scan_archive(path: &Path) -> Result<ArchiveScan, ExtractError> {
    let decoder = open_archive(path)?;
    let mut archive = tar::Archive::new(decoder);
    let mut scan = ArchiveScan::default();

    for entry in archive.entries()? {
        let mut entry = entry?;
        let raw_path = entry.path()?.to_string_lossy().into_owned();
        let name = raw_path.trim_start_matches("./").to_owned();

        if name == ".PKGINFO" {
            let mut text = String::new();
            entry
                .by_ref()
                .take(MAX_PKGINFO_BYTES + 1)
                .read_to_string(&mut text)?;
            if text.len() as u64 > MAX_PKGINFO_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(".PKGINFO is larger than {MAX_PKGINFO_BYTES} bytes"),
                )
                .into());
            }
            scan.pkginfo = Some(PkgInfo::parse(&text)?);
            continue;
        }
        if METADATA_ENTRIES.contains(&name.as_str()) || name.is_empty() {
            continue;
        }

        let kind = entry.header().entry_type();
        let path = match kind {
            EntryType::Directory => format!("/{}/", name.trim_end_matches('/')),
            _ => format!("/{name}"),
        };
        scan.files.insert(path.clone());

        if kind != EntryType::Regular || entry.header().size().unwrap_or(0) > MAX_INSPECT_BYTES {
            continue;
        }

        // Peek the magic so scripts and data files are never buffered in full.
        let mut prefix = [0u8; 4];
        let read = read_prefix(&mut entry, &mut prefix)?;
        if !elf::is_elf(&prefix[..read]) {
            continue;
        }
        let mut bytes = prefix[..read].to_vec();
        entry.read_to_end(&mut bytes)?;
        scan.components.extend(components::embedded(&bytes));
        match elf::inspect(&bytes) {
            Ok(Some(facts)) => scan.elf.push((path, facts)),
            Ok(None) => {}
            // ELF magic but not a loadable object (payload templates, test
            // fixtures, truncated stubs): nothing can link against it, so it
            // contributes no facts. Not an error for the package.
            Err(error) => tracing::warn!(path, %error, "unparseable ELF entry skipped"),
        }
    }
    Ok(scan)
}

/// Reads up to `buf.len()` bytes, returning how many were actually read (short
/// files are legal).
fn read_prefix(reader: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// Merges `.PKGINFO` and ELF facts into the final manifest.
fn merge(
    info: &PkgInfo,
    scan: &ArchiveScan,
    sha256: String,
    size_download: u64,
    filename: String,
) -> Result<PackageManifest, pkginfo::PkgInfoError> {
    let name = info.required("pkgname")?.to_owned();
    let version = info.required("pkgver")?.to_owned();
    let arch = info.required("arch")?.to_owned();
    let pkginfo = PkgInfoFields {
        base: info.first("pkgbase").unwrap_or(&name).to_owned(),
        builddate: info
            .first("builddate")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        packager: info.first("packager").unwrap_or_default().to_owned(),
        groups: info.all("group").to_vec(),
        depends: info.all("depend").to_vec(),
        makedepends: info.all("makedepend").to_vec(),
        checkdepends: info.all("checkdepend").to_vec(),
        optdepends: info.all("optdepend").to_vec(),
        provides: info.all("provides").to_vec(),
        conflicts: info.all("conflict").to_vec(),
        replaces: info.all("replaces").to_vec(),
    };

    let mut provides = RuleSet::default();
    provides.push(DependencyRule::with_constraint(
        name.clone(),
        pkg_manifest::VersionOp::Eq,
        version.clone(),
    ));
    provides.extend_parsed(info.all("provides"));

    // Sonames shipped by this package: both the raw soname (what DT_NEEDED asks
    // for) and Arch's `libfoo.so=N-64` form (what PKGBUILDs declare).
    let mut own_sonames = BTreeSet::new();
    for (_, facts) in &scan.elf {
        if let Some(soname) = &facts.soname {
            own_sonames.insert(soname.clone());
            provides.push(DependencyRule::unversioned(soname.clone()));
            if let Some(rule) = elf::arch_soname_provide(soname, facts.is_64) {
                provides.push(rule);
            }
        }
    }

    let mut requires = RuleSet::default();
    requires.extend_parsed(info.all("depend"));
    let mut version_needs = Vec::new();
    for (_, facts) in &scan.elf {
        for needed in &facts.needed {
            if !own_sonames.contains(needed) {
                requires.push(DependencyRule::unversioned(needed.clone()));
            }
        }
        version_needs.extend(
            facts
                .version_needs
                .iter()
                .filter(|need| !own_sonames.contains(&need.name))
                .cloned(),
        );
    }
    for need in collapse_version_needs(version_needs) {
        requires.push(need);
    }

    let mut optional = RuleSet::default();
    // `optdepend = name: why it is useful` — keep only the rule.
    optional.extend_parsed(
        info.all("optdepend")
            .iter()
            .map(|s| {
                s.split_once(':')
                    .map_or(s.as_str(), |(n, _)| n)
                    .trim()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .as_slice(),
    );
    let mut conflicts = RuleSet::default();
    conflicts.extend_parsed(info.all("conflict"));
    let mut replaces = RuleSet::default();
    replaces.extend_parsed(info.all("replaces"));

    Ok(PackageManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        name,
        version,
        arch,
        description: info.first("pkgdesc").map(str::to_owned),
        url: info.first("url").map(str::to_owned),
        licenses: info.all("license").to_vec(),
        size_installed: info.first("size").and_then(|s| s.parse().ok()).unwrap_or(0),
        size_download,
        sha256,
        filename,
        pkginfo,
        provides: provides.into_vec(),
        requires: requires.into_vec(),
        optional: optional.into_vec(),
        conflicts: conflicts.into_vec(),
        replaces: replaces.into_vec(),
        files: scan.files.iter().cloned().collect(),
        backup: info.all("backup").iter().map(|p| format!("/{p}")).collect(),
        components: {
            let mut c = scan.components.clone();
            c.sort();
            c.dedup();
            c
        },
    })
}

/// Keeps only the highest symbol version per `(soname, namespace)`.
///
/// Symbol version namespaces are monotonic: an object exporting `GLIBC_2.34` also
/// exports every earlier `GLIBC_2.x`, so `libc.so.6(GLIBC_2.34)` subsumes
/// `libc.so.6(GLIBC_2.14)`. Namespaces without a numeric part
/// (`GLIBC_ABI_DT_RELR`) are kept verbatim.
fn collapse_version_needs(needs: Vec<DependencyRule>) -> Vec<DependencyRule> {
    use std::collections::BTreeMap;

    let mut best: BTreeMap<(String, String), DependencyRule> = BTreeMap::new();
    for need in needs {
        let Some(sym) = need.symbol_version.as_deref() else {
            continue;
        };
        let (namespace, version) = split_symbol_version(sym);
        let key = (need.name.clone(), namespace.to_owned());
        match best.get(&key) {
            Some(current) if version.is_some() => {
                let cur_ver = current
                    .symbol_version
                    .as_deref()
                    .and_then(|s| split_symbol_version(s).1)
                    .unwrap_or("");
                if pkg_manifest::vercmp(version.unwrap_or(""), cur_ver).is_gt() {
                    best.insert(key, need);
                }
            }
            Some(_) => {}
            None => {
                best.insert(key, need);
            }
        }
    }
    best.into_values().collect()
}

/// `GLIBC_2.34` → `("GLIBC", Some("2.34"))`; `GLIBC_ABI_DT_RELR` → `(.., None)`.
fn split_symbol_version(sym: &str) -> (&str, Option<&str>) {
    match sym.rsplit_once('_') {
        Some((ns, ver)) if ver.bytes().next().is_some_and(|b| b.is_ascii_digit()) => {
            (ns, Some(ver))
        }
        _ => (sym, None),
    }
}

/// Insertion-ordered, de-duplicated list of rules.
#[derive(Default)]
struct RuleSet {
    seen: BTreeSet<String>,
    rules: Vec<DependencyRule>,
}

impl RuleSet {
    fn push(&mut self, rule: DependencyRule) {
        if self.seen.insert(rule.to_string()) {
            self.rules.push(rule);
        }
    }

    /// Parses each string as a rule; entries makepkg wrote that we cannot parse are
    /// skipped with a warning rather than failing the whole package.
    fn extend_parsed(&mut self, raw: &[String]) {
        for s in raw {
            match s.parse::<DependencyRule>() {
                Ok(rule) => self.push(rule),
                Err(e) => {
                    tracing::warn!(rule = %s, error = %e, "skipping unparsable dependency rule");
                }
            }
        }
    }

    fn into_vec(self) -> Vec<DependencyRule> {
        self.rules
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(s: &str) -> DependencyRule {
        s.parse().unwrap()
    }

    #[test]
    fn collapses_to_highest_symbol_version_per_namespace() {
        let out = collapse_version_needs(vec![
            rule("libc.so.6(GLIBC_2.14)"),
            rule("libc.so.6(GLIBC_2.34)"),
            rule("libc.so.6(GLIBC_2.2.5)"),
            rule("libc.so.6(GLIBC_ABI_DT_RELR)"),
            rule("libstdc++.so.6(GLIBCXX_3.4.32)"),
            rule("libstdc++.so.6(GLIBCXX_3.4.9)"),
            rule("libstdc++.so.6(CXXABI_1.3)"),
        ]);
        let mut out: Vec<String> = out.iter().map(ToString::to_string).collect();
        out.sort();
        assert_eq!(
            out,
            [
                "libc.so.6(GLIBC_2.34)",
                "libc.so.6(GLIBC_ABI_DT_RELR)",
                "libstdc++.so.6(CXXABI_1.3)",
                "libstdc++.so.6(GLIBCXX_3.4.32)",
            ]
        );
    }

    #[test]
    fn a_pkginfo_above_its_bound_is_refused_not_read_into_memory() {
        let info = format!(
            "pkgname = x\npkgver = 1-1\narch = any\n{}",
            "#".repeat(2 << 20)
        );
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        h.set_size(info.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, ".PKGINFO", info.as_bytes()).unwrap();
        let tar = b.into_inner().unwrap();
        let dir = std::env::temp_dir().join(format!("pkg-extract-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x-1-1-any.pkg.tar.zst");
        std::fs::write(&path, zstd::encode_all(&tar[..], 3).unwrap()).unwrap();
        let err = extract_manifest(&path).unwrap_err();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(err.to_string().contains("larger than"), "{err}");
    }

    #[test]
    fn an_extension_member_above_its_bound_is_refused_before_the_reader_buffers_it() {
        let info = "pkgname = x\npkgver = 1-1\narch = any\n";
        let regular = |b: &mut tar::Builder<Vec<u8>>, path: &str, data: &[u8]| {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            b.append_data(&mut h, path, data).unwrap();
        };
        let raw = |b: &mut tar::Builder<Vec<u8>>, kind: EntryType, data: &[u8]| {
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(kind);
            h.as_gnu_mut().unwrap().name[..13].copy_from_slice(b"././@LongLink");
            h.set_size(data.len() as u64);
            h.set_cksum();
            b.append(&h, data).unwrap();
        };
        let dir = std::env::temp_dir().join(format!("pkg-extract-ext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, b: tar::Builder<Vec<u8>>| {
            let path = dir.join(name);
            let tar = b.into_inner().unwrap();
            std::fs::write(&path, zstd::encode_all(&tar[..], 3).unwrap()).unwrap();
            path
        };

        // A real package: a long path (a small GNU long name) passes and still reads.
        let mut b = tar::Builder::new(Vec::new());
        regular(&mut b, ".PKGINFO", info.as_bytes());
        regular(&mut b, &format!("usr/share/{}/x", "d".repeat(120)), b"x");
        let ok = write("ok-1-1-any.pkg.tar.zst", b);
        check_archive(&ok).unwrap();
        assert_eq!(extract_manifest(&ok).unwrap().name, "x");

        // A long name of 1 MiB of zeros: refused by its header, never read.
        let mut b = tar::Builder::new(Vec::new());
        regular(&mut b, ".PKGINFO", info.as_bytes());
        raw(&mut b, EntryType::GNULongName, &vec![0; 1 << 20]);
        regular(&mut b, "usr/x", b"x");
        let err = check_archive(&write("bomb-1-1-any.pkg.tar.zst", b)).unwrap_err();
        assert!(err.to_string().contains("extension member"), "{err}");

        // A pax size: the reader and this walk would part ways there.
        let mut b = tar::Builder::new(Vec::new());
        regular(&mut b, ".PKGINFO", info.as_bytes());
        raw(&mut b, EntryType::XHeader, b"12 size=999\n");
        regular(&mut b, "usr/x", b"x");
        let err = check_archive(&write("pax-1-1-any.pkg.tar.zst", b)).unwrap_err();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(err.to_string().contains("pax size"), "{err}");
    }

    #[test]
    fn splits_symbol_versions() {
        assert_eq!(split_symbol_version("GLIBC_2.34"), ("GLIBC", Some("2.34")));
        assert_eq!(
            split_symbol_version("GLIBCXX_3.4.32"),
            ("GLIBCXX", Some("3.4.32"))
        );
        assert_eq!(
            split_symbol_version("GLIBC_ABI_DT_RELR"),
            ("GLIBC_ABI_DT_RELR", None)
        );
        assert_eq!(split_symbol_version("NOUNDERSCORE"), ("NOUNDERSCORE", None));
    }
}
