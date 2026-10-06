//! The host's identity (#321, design v2 §6.1, decision D7): its key, the words it signs,
//! and the files it keeps.
//!
//! - The host key is made by the enrollment, in the agent's state directory — anew each
//!   time the machine has no `host.json` yet, so an enrollment whose answer was lost is
//!   redone with a new command — and never leaves the machine: no container mounts it, no
//!   report carries it. Where the machine has a TPM its user may open (#330, design v2 §14,
//!   P6), the key is made inside it and never leaves it ([`tpm`]: ECDSA P-256, since TPM
//!   2.0 has no Ed25519; `host.tpm.pub` and `host.tpm.priv`, a blob only that TPM opens).
//!   Elsewhere it is `host.ed25519` (Ed25519, PKCS#8, mode 0600): no TPM or no tpm2-tools,
//!   a TPM this user may not open, a Mac — whose Secure Enclave needs the agent signed with
//!   a Developer ID and notarised, the half of #330 still open —, or the owner's
//!   `OMARCHY_HOST_KEY=file`. The enrollment says which, and why not the TPM; the pool keeps
//!   it, and the host's page shows it.
//! - Every call of the host to the pool's `/api/v1/hosts/self/*` carries
//!   `Omarchy-Host: <host>; ts=<unix>; nonce=<32 hex>; sig=<base64url>`, the key's
//!   signature over [`signed_message`]; the pool refuses a replay, a changed body and a
//!   clock more than 120 s off. The pool's side is `worker/src/hosts.ts`: the two must
//!   build the same bytes, which `tests/host-enroll-e2e.sh` proves end to end, and
//!   `tests/host-key-tpm.sh` with a key in a (software) TPM.
//! - The enrollment proves possession with a signature of [`enroll_message`].
//! - `host.json` keeps which pool and which host this machine is; the host worker token
//!   goes to the dispatcher's own file, `run/host/dispatcher/token` (mode 0400, #327),
//!   which the host set mounts read-only, and nowhere else (but `etc/dispatcher.env` while
//!   a release from before that file is on the host).

pub mod tpm;

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The host key's file name in the state directory, when the key is a file.
pub const KEY_FILE: &str = "host.ed25519";
/// Which pool and which host this machine is, beside the key.
pub const IDENTITY_FILE: &str = "host.json";

/// Why a Mac's host key is a file (#330's open half).
pub const MAC_FILE_KEY: &str = "a Mac's host key stays a file until the agent is signed with a Developer ID and notarised for the Secure Enclave (#330)";

/// Where the host key lives, as the enrollment tells the pool (`key_store`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    /// `host.ed25519`, mode 0600 in the agent's state directory.
    File,
    /// Made in the machine's TPM, which never lets it out ([`tpm`]).
    Tpm,
}

impl Store {
    pub fn name(self) -> &'static str {
        match self {
            Store::File => "file",
            Store::Tpm => "tpm",
        }
    }
}

/// What the owner asks of the key the enrollment makes (`OMARCHY_HOST_KEY`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Want {
    /// In the TPM where there is one the agent's user may open, else a file (the default).
    Auto,
    /// In the TPM, or no enrollment.
    Tpm,
    /// A file, whatever the machine has.
    File,
}

/// Where the enrollment makes the host key: what the owner asks (`OMARCHY_HOST_KEY`:
/// `auto`, the default, `tpm` or `file`), the TPM it asks (`OMARCHY_TPM_TCTI`, the kernel's
/// `/dev/tpmrm0` by default) and the tools that reach it.
#[derive(Clone)]
pub struct KeyChoice {
    pub want: Want,
    pub tcti: String,
    pub tools: Arc<dyn tpm::Tools>,
}

impl std::fmt::Debug for KeyChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyChoice")
            .field("want", &self.want)
            .field("tcti", &self.tcti)
            .finish_non_exhaustive()
    }
}

impl KeyChoice {
    /// The owner's words from the environment, as install.sh passes it on.
    pub fn from_env() -> Result<Self, String> {
        Self::parse(
            std::env::var("OMARCHY_HOST_KEY").ok().as_deref(),
            std::env::var("OMARCHY_TPM_TCTI").ok().as_deref(),
        )
    }

    /// `OMARCHY_HOST_KEY` and `OMARCHY_TPM_TCTI` read; an empty one is its default.
    pub fn parse(want: Option<&str>, tcti: Option<&str>) -> Result<Self, String> {
        let want = match want.unwrap_or("") {
            "" | "auto" => Want::Auto,
            "tpm" => Want::Tpm,
            "file" => Want::File,
            other => {
                return Err(format!(
                    "OMARCHY_HOST_KEY={other:?}: auto (the TPM where there is one, the default), tpm or file"
                ))
            }
        };
        let tcti = match tcti.unwrap_or("") {
            "" => tpm::DEFAULT_TCTI.to_owned(),
            t if tpm::tcti_ok(t) => t.to_owned(),
            t => {
                return Err(format!(
                    "OMARCHY_TPM_TCTI={t:?}: a resource manager in front of the TPM, device:/dev/tpmrm<N> or tabrmd[:<options>]"
                ))
            }
        };
        Ok(Self {
            want,
            tcti,
            tools: Arc::new(tpm::Cli::default()),
        })
    }

    /// A file key, whatever the machine has.
    pub fn file() -> Self {
        Self {
            want: Want::File,
            tcti: tpm::DEFAULT_TCTI.to_owned(),
            tools: Arc::new(tpm::Cli::default()),
        }
    }
}

enum Inner {
    File(Ed25519KeyPair),
    Tpm(tpm::Key),
}

/// The host key. Built only from the files this agent wrote, or freshly made: an Ed25519
/// key in a file, or an ECDSA P-256 key in the TPM.
pub struct HostKey {
    inner: Inner,
}

impl HostKey {
    /// Reads the file key at `path`, or makes one there (mode 0600, never over an existing
    /// file or through a symlink) when there is none.
    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        match fs::symlink_metadata(path) {
            Ok(_) => Self::load(path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                    .map_err(|_| "the system could not make a key".to_owned())?;
                write_new(path, doc.as_ref())?;
                Self::load_or_create(path)
            }
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    /// Reads the file key at `path`, which must be there. A link, another mode than the
    /// owner's alone, or anything but an Ed25519 key is refused.
    pub fn load(path: &Path) -> Result<Self, String> {
        let m = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
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
        Ok(Self {
            inner: Inner::File(pair),
        })
    }

    /// The key the enrollment made in the state directory `state`, which must be there: the
    /// run loop signs with that key (#344), never a new one — in the TPM when the
    /// enrollment made it there, else `host.ed25519`.
    pub fn load_in(state: &Path) -> Result<Self, String> {
        Self::load_in_with(state, Arc::new(tpm::Cli::default()))
    }

    /// [`HostKey::load_in`], the TPM reached through `tools`.
    pub fn load_in_with(state: &Path, tools: Arc<dyn tpm::Tools>) -> Result<Self, String> {
        if tpm::present(state) {
            return Ok(Self {
                inner: Inner::Tpm(tpm::Key::load(state, tools)?),
            });
        }
        Self::load(&state.join(KEY_FILE))
    }

    /// The key of a machine that enrolled: the TPM's when the enrollment made it there,
    /// else `host.ed25519`, made when it is missing (as before the TPM, #321).
    pub fn open_in(state: &Path, tools: Arc<dyn tpm::Tools>) -> Result<Self, String> {
        if tpm::present(state) {
            return Self::load_in_with(state, tools);
        }
        Self::load_or_create(&state.join(KEY_FILE))
    }

    /// A new key for an enrollment, replacing the one in `state`: in the TPM as `choice`
    /// asks and the machine allows, else a file. With a file key, why it is not in the TPM
    /// (`None` when nobody asked for one). Only one kind stays in `state`.
    pub fn create_in(state: &Path, choice: &KeyChoice) -> Result<(Self, Option<String>), String> {
        let why = match choice.want {
            Want::File => "the owner asked for a file (OMARCHY_HOST_KEY=file)".to_owned(),
            _ if !cfg!(target_os = "linux") => MAC_FILE_KEY.to_owned(),
            _ => match tpm::Key::create(state, &choice.tcti, Arc::clone(&choice.tools)) {
                Ok(k) => {
                    remove_file_key(&state.join(KEY_FILE))?;
                    return Ok((
                        Self {
                            inner: Inner::Tpm(k),
                        },
                        None,
                    ));
                }
                Err(e) => e,
            },
        };
        if choice.want == Want::Tpm {
            return Err(format!(
                "OMARCHY_HOST_KEY=tpm, but the TPM holds no host key: {why}; nothing was enrolled"
            ));
        }
        // A key an earlier enrollment made in the TPM is no host's once this one enrolls.
        tpm::remove(state)?;
        Ok((Self::create_fresh(&state.join(KEY_FILE))?, Some(why)))
    }

    /// A new file key at `path`, replacing the one there (atomically, mode 0600): a machine
    /// that has no identity yet enrolls with a key no host holds, so an enrollment whose
    /// answer was lost is redone by pasting a new command, nothing to delete by hand.
    pub fn create_fresh(path: &Path) -> Result<Self, String> {
        let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| "the system could not make a key".to_owned())?;
        replace(path, doc.as_ref())?;
        Self::load_or_create(path)
    }

    /// Where the key lives.
    pub fn store(&self) -> Store {
        match self.inner {
            Inner::File(_) => Store::File,
            Inner::Tpm(_) => Store::Tpm,
        }
    }

    /// The key where it lives, in the owner's words.
    pub fn describe(&self) -> String {
        match &self.inner {
            Inner::File(_) => format!("a file (Ed25519, {KEY_FILE}, mode 0600)"),
            Inner::Tpm(k) => format!(
                "in the TPM ({}; ECDSA P-256): made inside it, and it never leaves it",
                k.tcti()
            ),
        }
    }

    /// The raw public key: Ed25519's 32 bytes, or the uncompressed P-256 point (65).
    fn public(&self) -> &[u8] {
        match &self.inner {
            Inner::File(p) => p.public_key().as_ref(),
            Inner::Tpm(k) => k.point(),
        }
    }

    /// The raw public key, base64url without padding, as the pool keeps it.
    pub fn public_b64u(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public())
    }

    /// `SHA256:` and the unpadded base64 of the public key's SHA-256, as OpenSSH writes a
    /// fingerprint: what the agent prints and the owner compares on the site.
    pub fn fingerprint(&self) -> String {
        format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(self.public()))
        )
    }

    /// The key's signature of `message`, base64url without padding: Ed25519's 64 bytes, or
    /// ECDSA P-256's `r` and `s` (64 bytes) from the TPM — which may fail, and says why.
    pub fn sign(&self, message: &str) -> Result<String, String> {
        match &self.inner {
            Inner::File(p) => Ok(URL_SAFE_NO_PAD.encode(p.sign(message.as_bytes()).as_ref())),
            Inner::Tpm(k) => k
                .sign(message.as_bytes())
                .map(|s| URL_SAFE_NO_PAD.encode(s))
                .map_err(|e| format!("the host key in the TPM did not sign: {e}")),
        }
    }

    /// Whether the key signs now, before anything is sent with it: a file key does; a key in
    /// the TPM signs a probe, checked ([`tpm::PROBE`], no message the pool takes). Why not,
    /// otherwise, as [`HostKey::sign`] says it.
    pub fn check(&self) -> Result<(), String> {
        match &self.inner {
            Inner::File(_) => Ok(()),
            Inner::Tpm(k) => k
                .sign(tpm::PROBE)
                .map(drop)
                .map_err(|e| format!("the host key in the TPM did not sign: {e}")),
        }
    }

    /// Whether a key in the TPM is gone from it for good — cleared, or another machine's
    /// ([`tpm::Key::lost`]): what the TPM said. A file key is never lost here.
    pub fn lost(&self) -> Option<String> {
        match &self.inner {
            Inner::File(_) => None,
            Inner::Tpm(k) => k.lost(),
        }
    }

    /// The `Omarchy-Host` header for one request: a fresh nonce, the time now.
    pub fn header(
        &self,
        host: &str,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> Result<String, String> {
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
        ))?;
        Ok(format!("{host}; ts={ts}; nonce={nonce}; sig={sig}"))
    }
}

/// Takes `host.ed25519` out, once the key is the TPM's.
fn remove_file_key(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// What the enrollment's proof of possession signs: bound to the token, so the proof is
/// good for that enrollment only (the pool's `enrollMessage`).
pub fn enroll_message(token: &str, pubkey: &str) -> String {
    format!("omarchy-host-enroll-v1\n{token}\n{pubkey}")
}

/// The header a signed request carries [`HostKey::header`] in (the pool's `signedHost`
/// reads it): install's calls and the run loop's alike.
pub const HEADER: &str = "omarchy-host";

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
        // The run loop's load never makes one (#344): a missing key is an error.
        let missing = d.join("missing.ed25519");
        assert!(HostKey::load(&missing).is_err());
        assert!(!missing.exists());
        fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(HostKey::load(&p).is_ok());
    }

    #[test]
    fn the_header_carries_a_signature_the_public_key_verifies_over_the_pool_s_message() {
        let d = tmp("sig");
        let k = HostKey::load_or_create(&d.join(KEY_FILE)).unwrap();
        let h = k
            .header("h_0123456789", "POST", "/api/v1/hosts/self/report", b"{}")
            .unwrap();
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
    fn the_owner_asks_for_the_tpm_a_file_or_neither_and_a_tcti_must_be_a_resource_manager() {
        let c = KeyChoice::parse(None, None).unwrap();
        assert_eq!(
            (c.want, c.tcti.as_str()),
            (Want::Auto, "device:/dev/tpmrm0")
        );
        assert_eq!(
            KeyChoice::parse(Some(""), Some("")).unwrap().want,
            Want::Auto
        );
        assert_eq!(KeyChoice::parse(Some("tpm"), None).unwrap().want, Want::Tpm);
        assert_eq!(
            KeyChoice::parse(Some("file"), None).unwrap().want,
            Want::File
        );
        assert_eq!(
            KeyChoice::parse(None, Some("tabrmd:bus_type=session"))
                .unwrap()
                .tcti,
            "tabrmd:bus_type=session"
        );
        assert!(KeyChoice::parse(Some("enclave"), None)
            .unwrap_err()
            .contains("OMARCHY_HOST_KEY"));
        // The raw device would leave what a run loads in the TPM; a simulator is no TPM.
        for t in ["device:/dev/tpm0", "swtpm:port=2321"] {
            assert!(KeyChoice::parse(None, Some(t))
                .unwrap_err()
                .contains("OMARCHY_TPM_TCTI"));
        }
    }

    fn choice(want: Want, tpm: &Arc<tpm::fake::Tpm>) -> KeyChoice {
        KeyChoice {
            want,
            tcti: tpm::DEFAULT_TCTI.into(),
            tools: Arc::clone(tpm) as Arc<dyn tpm::Tools>,
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_enrollment_makes_its_key_in_the_tpm_where_it_can_and_one_kind_stays() {
        let d = tmp("tpm");
        let tpm = tpm::fake::Tpm::new();
        // An earlier enrollment's file key: the new one is the TPM's, and the file goes.
        HostKey::load_or_create(&d.join(KEY_FILE)).unwrap();
        let (k, why) = HostKey::create_in(&d, &choice(Want::Auto, &tpm)).unwrap();
        assert_eq!((k.store(), why), (Store::Tpm, None));
        assert!(!d.join(KEY_FILE).exists());
        assert!(k
            .describe()
            .starts_with("in the TPM (device:/dev/tpmrm0; ECDSA P-256)"));
        // The pool keeps the uncompressed point; the fingerprint is its SHA-256.
        let public = URL_SAFE_NO_PAD.decode(k.public_b64u()).unwrap();
        assert_eq!((public.len(), public[0]), (65, 4));
        assert_eq!(k.public_b64u().len(), 87);
        assert_eq!(
            k.fingerprint(),
            format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&public)))
        );
        // The run loop's load finds that key, and signs a request the pool verifies.
        let again = HostKey::load_in_with(&d, Arc::clone(&tpm) as Arc<dyn tpm::Tools>).unwrap();
        assert_eq!(again.public_b64u(), k.public_b64u());
        let h = again
            .header("h_0123456789", "GET", "/api/v1/hosts/self/state", b"")
            .unwrap();
        let parts: Vec<&str> = h.split("; ").collect();
        let sig = URL_SAFE_NO_PAD
            .decode(parts[3].strip_prefix("sig=").unwrap())
            .unwrap();
        assert_eq!(sig.len(), 64);
        let msg = signed_message(
            "h_0123456789",
            "GET",
            "/api/v1/hosts/self/state",
            &hex::encode(Sha256::digest(b"")),
            parts[1].strip_prefix("ts=").unwrap().parse().unwrap(),
            parts[2].strip_prefix("nonce=").unwrap(),
        );
        aws_lc_rs::signature::UnparsedPublicKey::new(
            &aws_lc_rs::signature::ECDSA_P256_SHA256_FIXED,
            &public,
        )
        .verify(msg.as_bytes(), &sig)
        .unwrap();
        // A TPM that no longer holds it (cleared): the signature fails and says why.
        tpm.clear();
        assert!(again
            .header("h_0123456789", "GET", "/api/v1/hosts/self/state", b"")
            .unwrap_err()
            .contains("the host key in the TPM did not sign"));
        // The next enrollment with a file key takes the TPM's files out.
        let (k, why) = HostKey::create_in(&d, &KeyChoice::file()).unwrap();
        assert_eq!(k.store(), Store::File);
        assert!(why.unwrap().contains("OMARCHY_HOST_KEY=file"));
        assert!(!tpm::present(&d) && !d.join(tpm::PUBLIC_FILE).exists());
        assert_eq!(HostKey::load_in(&d).unwrap().store(), Store::File);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn without_a_tpm_the_key_is_a_file_and_says_why_unless_the_owner_asked_for_the_tpm() {
        let d = tmp("no-tpm");
        let tpm = tpm::fake::Tpm::new();
        *tpm.unreachable.lock().unwrap() = Some("no TPM: /dev/tpmrm0 is not there".into());
        let (k, why) = HostKey::create_in(&d, &choice(Want::Auto, &tpm)).unwrap();
        assert_eq!(k.store(), Store::File);
        assert_eq!(why.as_deref(), Some("no TPM: /dev/tpmrm0 is not there"));
        assert_eq!(
            fs::metadata(d.join(KEY_FILE)).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(k.public_b64u().len(), 43);
        // Asked for the TPM: refused, and the file key there is left as it was.
        let before = fs::read(d.join(KEY_FILE)).unwrap();
        let e = HostKey::create_in(&d, &choice(Want::Tpm, &tpm))
            .err()
            .unwrap();
        assert!(
            e.contains("OMARCHY_HOST_KEY=tpm") && e.contains("no TPM"),
            "{e}"
        );
        assert_eq!(fs::read(d.join(KEY_FILE)).unwrap(), before);
        // A TPM that refuses the storage key (an owner password): a file, with its words.
        let tpm = tpm::fake::Tpm::new();
        *tpm.fails.lock().unwrap() = Some(("createprimary".into(), "authorization failure".into()));
        let (k, why) = HostKey::create_in(&d, &choice(Want::Auto, &tpm)).unwrap();
        assert_eq!(k.store(), Store::File);
        assert!(why.unwrap().contains("authorization failure"));
        assert_ne!(fs::read(d.join(KEY_FILE)).unwrap(), before);
        // No TPM files were left behind by any of them.
        assert!(!d.join(tpm::PUBLIC_FILE).exists());
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
