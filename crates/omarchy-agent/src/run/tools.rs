//! The pinned container tools (decision D21): the docker CLI and the compose plugin the
//! verified manifest names for this platform, by URL and SHA-256, installed under the
//! agent's data directory. The compose driver runs these and nothing else: there is no
//! lookup in `PATH`, and a [`Tools`] exists only for files whose hashes held.
//!
//! Layout: `tools/<sha256 of the download>/{docker,docker-compose}` with
//! `binary.sha256` beside each binary, checked again whenever the tools are opened.

use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use sha2::{Digest as _, Sha256};

use crate::manifest::{Manifest, PinnedTool};

use super::state::{write_atomic, ToolPins};

/// The largest download or binary accepted (the static docker CLI is about 40 MiB).
pub(crate) const MAX_TOOL: u64 = 256 << 20;

/// The manifest's name for this machine: `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`.
pub(crate) fn platform() -> Option<&'static str> {
    match (std::env::consts::ARCH, std::env::consts::OS) {
        ("x86_64", "linux") => Some("x86_64-linux"),
        ("aarch64", "linux") => Some("aarch64-linux"),
        ("aarch64", "macos") => Some("aarch64-darwin"),
        _ => None,
    }
}

/// Paths to the pinned binaries, opened and checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Tools {
    pub docker: PathBuf,
    pub compose: PathBuf,
    pub pins: ToolPins,
}

const DOCKER: &str = "docker";
const COMPOSE: &str = "docker-compose";

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hex_of(t: &PinnedTool) -> String {
    hex::encode(t.sha256().as_bytes())
}

/// Opens tools installed earlier, checking each binary against the hash recorded when it
/// was installed.
pub(crate) fn open(dir: &Path, pins: &ToolPins) -> Result<Tools, String> {
    let one = |pin: &str, name: &str| -> Result<PathBuf, String> {
        if pin.len() != 64 || !pin.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("tool pin {pin:?} is not a SHA-256"));
        }
        let bin = dir.join(pin).join(name);
        let want = fs::read_to_string(dir.join(pin).join(format!("{name}.sha256")))
            .map_err(|e| format!("{}: {e}", bin.display()))?;
        let have = file_sha256(&bin)?;
        if have != want.trim() {
            return Err(format!(
                "{} does not match the hash recorded at install",
                bin.display()
            ));
        }
        Ok(bin)
    };
    Ok(Tools {
        docker: one(&pins.docker, DOCKER)?,
        compose: one(&pins.compose, COMPOSE)?,
        pins: pins.clone(),
    })
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut h = Sha256::new();
    std::io::copy(&mut (&mut f).take(MAX_TOOL), &mut h)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(hex::encode(h.finalize()))
}

/// Makes sure the tools `m` pins for `platform` are installed, downloading what is
/// missing through `download` (URL → bytes), and opens them.
pub(crate) fn ensure(
    dir: &Path,
    m: &Manifest,
    platform: &str,
    download: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<Tools, String> {
    let pinned = |name: &str| {
        m.tool(platform, name)
            .ok_or_else(|| format!("the release pins no {name} for {platform}"))
    };
    let (docker, compose) = (pinned(DOCKER)?, pinned(COMPOSE)?);
    let pins = ToolPins {
        docker: hex_of(docker),
        compose: hex_of(compose),
    };
    if let Ok(t) = open(dir, &pins) {
        return Ok(t);
    }
    install(dir, docker, DOCKER, download, |tgz| {
        docker_from_tgz(tgz).map_err(|e| format!("{}: {e}", docker.url()))
    })?;
    install(dir, compose, COMPOSE, download, |raw| Ok(raw.to_vec()))?;
    open(dir, &pins)
}

fn install(
    dir: &Path,
    tool: &PinnedTool,
    name: &str,
    download: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
    extract: impl Fn(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    let pin = hex_of(tool);
    let home = dir.join(&pin);
    let bin = home.join(name);
    if bin.exists() && open_one(&home, name).is_ok() {
        return Ok(());
    }
    let data = download(tool.url())?;
    let got = sha256_hex(&data);
    if got != pin {
        return Err(format!(
            "{}: SHA-256 {got}, not the pinned {pin}",
            tool.url()
        ));
    }
    let binary = extract(&data)?;
    fs::create_dir_all(&home).map_err(|e| format!("{}: {e}", home.display()))?;
    write_atomic(&bin, &binary)?;
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    write_atomic(
        &home.join(format!("{name}.sha256")),
        sha256_hex(&binary).as_bytes(),
    )
}

fn open_one(home: &Path, name: &str) -> Result<(), String> {
    let want =
        fs::read_to_string(home.join(format!("{name}.sha256"))).map_err(|e| e.to_string())?;
    (file_sha256(&home.join(name))? == want.trim())
        .then_some(())
        .ok_or_else(|| "changed".to_owned())
}

/// `docker/docker` out of the static docker release archive.
fn docker_from_tgz(tgz: &[u8]) -> Result<Vec<u8>, String> {
    let mut archive = tar::Archive::new(GzDecoder::new(tgz));
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        if path == Path::new("docker/docker") && entry.header().entry_type().is_file() {
            let mut out = Vec::new();
            (&mut entry)
                .take(MAX_TOOL)
                .read_to_end(&mut out)
                .map_err(|e| e.to_string())?;
            return Ok(out);
        }
    }
    Err("no docker/docker in the archive".into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::run::state::tempdir;

    /// A docker release archive holding `docker/docker` = `bin`.
    pub(crate) fn docker_tgz(bin: &[u8]) -> Vec<u8> {
        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        for (path, data) in [("docker/dockerd", &b"not this"[..]), ("docker/docker", bin)] {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o755);
            h.set_entry_type(tar::EntryType::Regular);
            b.append_data(&mut h, path, data).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn installs_the_pinned_downloads_once_and_refuses_anything_else() {
        let dir = tempdir();
        let tgz = docker_tgz(b"#!/bin/sh\necho docker\n");
        let compose = b"#!/bin/sh\necho compose\n".to_vec();
        let m = crate::verify::tests_support::manifest_with_tools(
            "x86_64-linux",
            &[
                (
                    "docker",
                    "https://example.org/docker.tgz",
                    &sha256_hex(&tgz),
                ),
                (
                    "docker-compose",
                    "https://example.org/compose",
                    &sha256_hex(&compose),
                ),
            ],
        );
        let mut fetched = Vec::new();
        let t = ensure(&dir, &m, "x86_64-linux", &mut |url: &str| {
            fetched.push(url.to_owned());
            Ok(if url == "https://example.org/docker.tgz" {
                tgz.clone()
            } else {
                compose.clone()
            })
        })
        .unwrap();
        assert_eq!(fs::read(&t.docker).unwrap(), b"#!/bin/sh\necho docker\n");
        assert_eq!(fs::read(&t.compose).unwrap(), compose);
        assert_eq!(
            fs::metadata(&t.docker).unwrap().permissions().mode() & 0o777,
            0o755
        );
        // Installed: nothing is fetched again, and open() finds the same files.
        let again = ensure(&dir, &m, "x86_64-linux", &mut |_| Err("offline".into())).unwrap();
        assert_eq!(again, t);
        assert_eq!(open(&dir, &t.pins).unwrap(), t);
        assert_eq!(fetched.len(), 2);

        // A binary changed on disk is not opened.
        fs::write(&t.compose, b"something else").unwrap();
        assert!(open(&dir, &t.pins).unwrap_err().contains("does not match"));

        // A download whose hash differs is refused, and no platform means no tools.
        let other = tempdir();
        let e = ensure(&other, &m, "x86_64-linux", &mut |_| Ok(b"evil".to_vec())).unwrap_err();
        assert!(e.contains("not the pinned"), "{e}");
        assert!(ensure(&other, &m, "aarch64-darwin", &mut |_| Ok(Vec::new())).is_err());
    }
}
