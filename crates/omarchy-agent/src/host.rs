//! The host's identity (#321, design v2 §6.1, decision D7): its Ed25519 key, the words it
//! signs, and the files it keeps.
//!
//! - `host.ed25519` (PKCS#8, mode 0600) is made once, at the first enrollment, in the
//!   agent's state directory, and never leaves it: no container mounts it, no report
//!   carries it.
//! - Every call of the host to the pool's `/api/v1/hosts/self/*` carries
//!   `Omarchy-Host: <host>; ts=<unix>; nonce=<32 hex>; sig=<base64url>`, the key's
//!   signature over [`signed_message`]; the pool refuses a replay, a changed body and a
//!   clock more than 120 s off. The pool's side is `worker/src/hosts.ts`: the two must
//!   build the same bytes, which `tests/host-enroll-e2e.sh` proves end to end.
//! - The enrollment proves possession with a signature of [`enroll_message`].
//! - `host.json` keeps which pool and which host this machine is; the host worker token
//!   goes to the dispatcher's `etc/dispatcher.env` (mode 0600), and nowhere else.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The host key's file name in the state directory.
pub const KEY_FILE: &str = "host.ed25519";
/// Which pool and which host this machine is, beside the key.
pub const IDENTITY_FILE: &str = "host.json";

/// The host key. Built only from the file this agent wrote, or freshly made.
pub struct HostKey {
    pair: Ed25519KeyPair,
}

impl HostKey {
    /// Reads the key at `path`, or makes one there (mode 0600, never over an existing file
    /// or through a symlink) when there is none.
    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        match fs::symlink_metadata(path) {
            Ok(m) => {
                if !m.file_type().is_file() {
                    return Err(format!("{}: not a regular file", path.display()));
                }
                if m.permissions().mode() & 0o077 != 0 {
                    return Err(format!(
                        "{}: readable by others (mode {:o}); the host key is the owner's alone",
                        path.display(),
                        m.permissions().mode() & 0o777
                    ));
                }
                let der = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
                let pair = Ed25519KeyPair::from_pkcs8(&der)
                    .map_err(|_| format!("{}: not an Ed25519 key", path.display()))?;
                Ok(Self { pair })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                    .map_err(|_| "the system could not make a key".to_owned())?;
                write_new(path, doc.as_ref())?;
                Self::load_or_create(path)
            }
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    /// The raw public key, base64url without padding, as the pool keeps it.
    pub fn public_b64u(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.pair.public_key().as_ref())
    }

    /// `SHA256:` and the unpadded base64 of the public key's SHA-256, as OpenSSH writes a
    /// fingerprint: what the agent prints and the owner compares on the site.
    pub fn fingerprint(&self) -> String {
        format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(self.pair.public_key().as_ref()))
        )
    }

    /// The key's signature of `message`, base64url without padding.
    pub fn sign(&self, message: &str) -> String {
        URL_SAFE_NO_PAD.encode(self.pair.sign(message.as_bytes()).as_ref())
    }

    /// The `Omarchy-Host` header for one request: a fresh nonce, the time now.
    pub fn header(&self, host: &str, method: &str, path: &str, body: &[u8]) -> String {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let nonce = nonce();
        let sig = self.sign(&signed_message(
            host,
            method,
            path,
            &hex::encode(Sha256::digest(body)),
            ts,
            &nonce,
        ));
        format!("{host}; ts={ts}; nonce={nonce}; sig={sig}")
    }
}

/// What the enrollment's proof of possession signs: bound to the token, so the proof is
/// good for that enrollment only (the pool's `enrollMessage`).
pub fn enroll_message(token: &str, pubkey: &str) -> String {
    format!("omarchy-host-enroll-v1\n{token}\n{pubkey}")
}

/// What a signed request's signature covers, one field a line (the pool's
/// `signedMessage`).
pub fn signed_message(
    host: &str,
    method: &str,
    path: &str,
    body_sha256: &str,
    ts: u64,
    nonce: &str,
) -> String {
    format!("omarchy-host-v1\n{host}\n{method}\n{path}\n{body_sha256}\n{ts}\n{nonce}")
}

fn nonce() -> String {
    let mut b = [0u8; 16];
    // The system's generator does not fail on a working machine; a zero nonce would only
    // be refused by the pool as a replay, never accepted twice.
    let _ = SystemRandom::new().fill(&mut b);
    hex::encode(b)
}

/// Which pool and which host this machine is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Identity {
    pub pool: String,
    pub host: String,
}

impl Identity {
    pub fn read(dir: &Path) -> Result<Option<Self>, String> {
        let path = dir.join(IDENTITY_FILE);
        match fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b)
                .map(Some)
                .map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn write(&self, dir: &Path) -> Result<(), String> {
        let body = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        replace(&dir.join(IDENTITY_FILE), &body)
    }
}

/// Writes a new file, mode 0600; refuses one that exists, a symlink included.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(bytes)
        .and_then(|()| f.sync_all())
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Replaces `path` with `bytes`, mode 0600, atomically: a new file beside it, then a
/// rename — which replaces a symlink at `path` rather than following it.
pub fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{}: no directory", path.display()))?;
    let tmp: PathBuf = dir.join(format!(
        ".{}.{}",
        path.file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        nonce()
    ));
    write_new(&tmp, bytes)?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

/// Makes `dir` (and its parents) with mode 0700 where it does not exist; refuses one
/// that is group- or world-writable.
pub fn private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let m = fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !m.is_dir() {
        return Err(format!("{}: not a directory", dir.display()));
    }
    if m.permissions().mode() & 0o022 != 0 {
        return Err(format!(
            "{}: writable by others (mode {:o})",
            dir.display(),
            m.permissions().mode() & 0o777
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("omarchy-agent-host-{name}-{}", nonce()));
        fs::create_dir_all(&d).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
        d
    }

    #[test]
    fn a_new_key_is_written_once_with_mode_0600_and_read_back_the_same() {
        let d = tmp("key");
        let p = d.join(KEY_FILE);
        let k = HostKey::load_or_create(&p).unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let again = HostKey::load_or_create(&p).unwrap();
        assert_eq!(k.public_b64u(), again.public_b64u());
        assert_eq!(k.public_b64u().len(), 43);
        assert!(k.fingerprint().starts_with("SHA256:"));
        assert_eq!(k.fingerprint().len(), "SHA256:".len() + 43);
    }

    #[test]
    fn a_key_readable_by_others_or_a_symlink_is_refused() {
        let d = tmp("modes");
        let p = d.join(KEY_FILE);
        HostKey::load_or_create(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(HostKey::load_or_create(&p)
            .err()
            .unwrap()
            .contains("readable by others"));
        let link = d.join("link.ed25519");
        std::os::unix::fs::symlink(&p, &link).unwrap();
        assert!(HostKey::load_or_create(&link)
            .err()
            .unwrap()
            .contains("not a regular file"));
    }

    #[test]
    fn the_header_carries_a_signature_the_public_key_verifies_over_the_pool_s_message() {
        let d = tmp("sig");
        let k = HostKey::load_or_create(&d.join(KEY_FILE)).unwrap();
        let h = k.header("h_0123456789", "POST", "/api/v1/hosts/self/report", b"{}");
        let parts: Vec<&str> = h.split("; ").collect();
        assert_eq!(parts[0], "h_0123456789");
        let ts: u64 = parts[1].strip_prefix("ts=").unwrap().parse().unwrap();
        let nonce = parts[2].strip_prefix("nonce=").unwrap();
        assert_eq!(nonce.len(), 32);
        let sig = URL_SAFE_NO_PAD
            .decode(parts[3].strip_prefix("sig=").unwrap())
            .unwrap();
        assert_eq!(sig.len(), 64);
        let msg = signed_message(
            "h_0123456789",
            "POST",
            "/api/v1/hosts/self/report",
            &hex::encode(Sha256::digest(b"{}")),
            ts,
            nonce,
        );
        let public = URL_SAFE_NO_PAD.decode(k.public_b64u()).unwrap();
        aws_lc_rs::signature::UnparsedPublicKey::new(&aws_lc_rs::signature::ED25519, &public)
            .verify(msg.as_bytes(), &sig)
            .unwrap();
        // Another body is another message.
        let other = msg.replace(
            &hex::encode(Sha256::digest(b"{}")),
            &hex::encode(Sha256::digest(b"{ }")),
        );
        assert!(aws_lc_rs::signature::UnparsedPublicKey::new(
            &aws_lc_rs::signature::ED25519,
            &public
        )
        .verify(other.as_bytes(), &sig)
        .is_err());
    }

    #[test]
    fn the_signed_words_are_the_pool_s() {
        // worker/src/hosts.ts builds the same lines; the E2E proves the two agree on the wire.
        assert_eq!(
            signed_message("h_x", "GET", "/api/v1/hosts/self/state", "e3b0", 7, "ab"),
            "omarchy-host-v1\nh_x\nGET\n/api/v1/hosts/self/state\ne3b0\n7\nab"
        );
        assert_eq!(
            enroll_message("ome_1", "pk"),
            "omarchy-host-enroll-v1\nome_1\npk"
        );
    }

    #[test]
    fn replace_writes_0600_and_replaces_a_symlink_instead_of_following_it() {
        let d = tmp("replace");
        let target = d.join("elsewhere");
        fs::write(&target, b"keep").unwrap();
        let p = d.join("dispatcher.env");
        std::os::unix::fs::symlink(&target, &p).unwrap();
        replace(&p, b"OMARCHY_WORKER_TOKEN=omw_x\n").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert!(fs::symlink_metadata(&p).unwrap().file_type().is_file());
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let id = Identity {
            pool: "https://pkgs.omarchy-pool.org".into(),
            host: "h_0123456789".into(),
        };
        id.write(&d).unwrap();
        assert_eq!(Identity::read(&d).unwrap(), Some(id));
    }
}
