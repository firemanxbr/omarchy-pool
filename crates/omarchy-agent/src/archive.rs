//! The host bundle archive: `omarchy-host-vX.Y.Z.tar.gz`, read into memory only after its
//! signature verified. It holds `manifest.json` at the top and each set under
//! `sets/<name>/` (the layout `release.yml`'s `host-bundle` job writes, #311).
//!
//! Only plain files and directories with plain relative paths are accepted; links,
//! devices, duplicates and anything beyond the size caps are refused, so later code that
//! writes these files out (P1) never meets a path that leaves its directory.

use std::collections::BTreeMap;
use std::io::Read;

use flate2::read::GzDecoder;

use crate::manifest::is_relative_path;

const MAX_UNPACKED: u64 = 64 << 20;
const MAX_ENTRIES: usize = 4096;

pub(crate) fn read(gz: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut tar = Vec::new();
    GzDecoder::new(gz)
        .take(MAX_UNPACKED + 1)
        .read_to_end(&mut tar)
        .map_err(|e| format!("bundle is not a gzip archive: {e}"))?;
    if tar.len() as u64 > MAX_UNPACKED {
        return Err(format!(
            "bundle unpacks to more than {} MiB",
            MAX_UNPACKED >> 20
        ));
    }
    let mut files = BTreeMap::new();
    let mut archive = tar::Archive::new(tar.as_slice());
    let entries = archive
        .entries()
        .map_err(|e| format!("bundle is not a tar archive: {e}"))?;
    for (n, entry) in entries.enumerate() {
        if n >= MAX_ENTRIES {
            return Err(format!("bundle has more than {MAX_ENTRIES} entries"));
        }
        let mut entry = entry.map_err(|e| format!("bundle is not a tar archive: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("bundle entry path: {e}"))?;
        let path = path
            .to_str()
            .ok_or("bundle entry path is not UTF-8")?
            .to_owned();
        let path = path.strip_prefix("./").unwrap_or(&path).to_owned();
        match entry.header().entry_type() {
            tar::EntryType::Directory => {
                let dir = path.trim_end_matches('/');
                if !dir.is_empty() && !is_relative_path(dir) {
                    return Err(format!(
                        "bundle entry {path:?} is not a plain relative path"
                    ));
                }
            }
            tar::EntryType::Regular => {
                if !is_relative_path(&path) {
                    return Err(format!(
                        "bundle entry {path:?} is not a plain relative path"
                    ));
                }
                let mut data = Vec::new();
                entry
                    .read_to_end(&mut data)
                    .map_err(|e| format!("bundle entry {path:?}: {e}"))?;
                if files.insert(path.clone(), data).is_some() {
                    return Err(format!("bundle holds {path:?} twice"));
                }
            }
            other => {
                return Err(format!(
                    "bundle entry {path:?} is a {other:?}, not a file or directory"
                ))
            }
        }
    }
    Ok(files)
}

#[cfg(test)]
pub(crate) mod tests {
    use flate2::write::GzEncoder;

    /// A `.tar.gz` holding `files`, as the tests' bundles.
    pub(crate) fn pack(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut b = tar::Builder::new(GzEncoder::new(Vec::new(), flate2::Compression::default()));
        for (path, data) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            b.append_data(&mut h, path, *data).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn reads_plain_files_and_refuses_links_and_escapes() {
        let files = super::read(&pack(&[
            ("manifest.json", b"{}"),
            ("./sets/host/compose.yml", b"x"),
        ]))
        .unwrap();
        assert_eq!(
            files.keys().collect::<Vec<_>>(),
            ["manifest.json", "sets/host/compose.yml"]
        );
        assert!(super::read(b"not gzip").is_err());

        let mut b = tar::Builder::new(GzEncoder::new(Vec::new(), flate2::Compression::default()));
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        b.append_link(&mut h, "sets/host/compose.yml", "/etc/passwd")
            .unwrap();
        let link = b.into_inner().unwrap().finish().unwrap();
        assert!(super::read(&link).unwrap_err().contains("Symlink"));

        let dup = pack(&[("manifest.json", b"{}"), ("./manifest.json", b"{}")]);
        assert!(super::read(&dup).unwrap_err().contains("twice"));
    }

    #[test]
    fn refuses_a_path_that_leaves_the_bundle() {
        // tar::Builder refuses to write `..`, so write the header by hand.
        let mut h = tar::Header::new_old();
        h.as_old_mut().name[..16].copy_from_slice(b"../../etc/passwd");
        h.set_size(0);
        h.set_entry_type(tar::EntryType::Regular);
        h.set_cksum();
        let mut raw = h.as_bytes().to_vec();
        raw.extend_from_slice(&[0u8; 1024]);
        let mut gz = GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gz, &raw).unwrap();
        let e = super::read(&gz.finish().unwrap()).unwrap_err();
        assert!(e.contains("plain relative path"), "{e}");
    }
}
