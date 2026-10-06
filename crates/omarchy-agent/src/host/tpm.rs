//! The host key in the machine's TPM (#330, design v2 §14: "P6: Secure Enclave or
//! TPM-bound"), the Linux half of hardware-bound host keys.
//!
//! The key is made inside the TPM and never leaves it: an ECDSA P-256 signing key — TPM 2.0
//! has no Ed25519 — with `fixedtpm` and `fixedparent`, so the TPM refuses to duplicate it,
//! and `sensitivedataorigin`, so the TPM made its private half itself. What the agent keeps
//! in its state directory is the key's public area (`host.tpm.pub`, a `TPM2B_PUBLIC`) and its
//! private blob (`host.tpm.priv`), which the TPM encrypted under its own storage key: a copy
//! of the two files signs nothing on any other machine, and nothing on this one once the
//! TPM is cleared. `host.tpm.json` names the TPM it was made in (the TCTI).
//!
//! The agent links no TPM library (tests/agent-deps.sh): it runs the distribution's
//! tpm2-tools from `/usr/bin`, with an environment of its own, the way it runs `security`
//! on a Mac (`owner::keychain`). Each signature is three runs: the storage key made again
//! from the owner hierarchy's seed with the same arguments — the same key every time, as
//! clevis's tpm2 pin does it — the host key loaded under it, and the SHA-256 of the message
//! signed. The agent reaches the TPM only through a resource manager (the kernel's
//! `/dev/tpmrm0`, or tpm2-abrmd), which flushes what each run loaded when it exits: nothing
//! stays loaded, and no other process's objects are touched. The owner hierarchy's
//! authorization must be empty (as on every machine nobody took ownership of); the key's
//! own is empty and `noda`, so the dictionary-attack lockout never holds it.
//!
//! Every signature is checked against the key's public point before it leaves, so a TPM
//! that answers wrong is said here, not as a refusal from the pool. [`Tools`] is the seam
//! the tests fake; [`Cli`] runs the real tools, and `tests/host-key-tpm.sh` runs them on a
//! software TPM (swtpm behind tpm2-abrmd) against a real pool.

use std::ffi::OsString;
use std::fs;
use std::io::Read as _;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aws_lc_rs::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};
use sha2::{Digest, Sha256};

/// The key's public area (`TPM2B_PUBLIC`, as `tpm2_create -u` writes it).
pub const PUBLIC_FILE: &str = "host.tpm.pub";
/// The key's private blob (`TPM2B_PRIVATE`, `tpm2_create -r`): sealed by the TPM to itself.
pub const PRIVATE_FILE: &str = "host.tpm.priv";
/// Which TPM holds the key (`{"tcti": …}`), written last: the mark that there is one.
pub const META_FILE: &str = "host.tpm.json";
/// The kernel's resource manager in front of the first TPM.
pub const DEFAULT_TCTI: &str = "device:/dev/tpmrm0";
/// Where the distribution installs tpm2-tools.
const BIN: &str = "/usr/bin";
/// No run of a tool takes longer: a TPM is slow, never this slow.
const TIMEOUT: Duration = Duration::from_secs(60);
/// The tools the agent runs, each `tpm2_<name>`.
const TOOLS: [&str; 4] = ["createprimary", "create", "load", "sign"];

/// The storage key the host key is made under, made again from the owner hierarchy's seed
/// for every use: these arguments, never another, or the host key no longer loads.
const PRIMARY: [&str; 9] = [
    "-Q",
    "-C",
    "o",
    "-g",
    "sha256",
    "-G",
    "ecc256:aes128cfb",
    "-a",
    "restricted|decrypt|fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda",
];
/// The host key's attributes: made in the TPM, never duplicated, signs and does nothing else.
const KEY_ATTRIBUTES: &str = "fixedtpm|fixedparent|sensitivedataorigin|userwithauth|noda|sign";
/// What the probe at the key's making signs, and [`super::HostKey::check`]'s: no message the
/// pool takes.
pub(crate) const PROBE: &[u8] = b"omarchy-host-tpm-probe-v1";

// TPM 2.0 constants (TCG TPM 2.0 Library, Part 2).
const ALG_ECC: u16 = 0x0023;
const ALG_SHA256: u16 = 0x000B;
const ALG_NULL: u16 = 0x0010;
const ALG_ECDSA: u16 = 0x0018;
const ECC_NIST_P256: u16 = 0x0003;
const FIXED_TPM: u32 = 1 << 1;
const FIXED_PARENT: u32 = 1 << 4;
const SENSITIVE_DATA_ORIGIN: u32 = 1 << 5;
const RESTRICTED: u32 = 1 << 16;
const DECRYPT: u32 = 1 << 17;
const SIGN: u32 = 1 << 18;

/// The TPM's tools, as the agent runs them.
pub trait Tools: Send + Sync {
    /// Whether the TPM at `tcti` can be reached by the agent: for a device, it is there, and
    /// this user — and its user manager, which runs the agent's service, when one runs — may
    /// open it for reading and writing; the tools are installed. Why not, otherwise: "no TPM"
    /// first when there is no device.
    fn reachable(&self, tcti: &str) -> Result<(), String>;
    /// Runs `tpm2_<tool>` with `args` against the TPM at `tcti`: what it said, on a failure.
    fn run(&self, tool: &str, args: &[OsString], tcti: &str) -> Result<(), String>;
}

/// tpm2-tools from `/usr/bin`.
#[derive(Debug, Clone)]
pub struct Cli {
    pub bin: PathBuf,
    /// Where the processes are read (`/proc`): this one's groups, and its user manager's.
    pub proc: PathBuf,
}

impl Default for Cli {
    fn default() -> Self {
        Self {
            bin: PathBuf::from(BIN),
            proc: PathBuf::from("/proc"),
        }
    }
}

impl Tools for Cli {
    fn reachable(&self, tcti: &str) -> Result<(), String> {
        // No device is no TPM, whatever is installed: a machine without one (a VPS, most
        // often) is told so, not sent to install tools that would not help.
        let dev = tcti.strip_prefix("device:");
        if let Some(dev) = dev {
            if fs::symlink_metadata(dev).is_err() {
                return Err(format!("no TPM: {dev} is not there"));
            }
        }
        for t in TOOLS {
            let tool = self.bin.join(format!("tpm2_{t}"));
            if !tool.is_file() {
                return Err(format!(
                    "tpm2-tools is not installed ({} is not there)",
                    tool.display()
                ));
            }
        }
        if let Some(dev) = dev {
            let uid = rustix::process::getuid().as_raw();
            if rustix::fs::access(
                dev,
                rustix::fs::Access::READ_OK | rustix::fs::Access::WRITE_OK,
            )
            .is_err()
            {
                return Err(format!(
                    "{dev} is there, but this user (uid {uid}) may not open it: the tss group gives it (sudo usermod -aG tss \"$USER\", then reboot, or log in again and restart its user manager: sudo systemctl restart user@{uid}.service)"
                ));
            }
            manager_opens(&self.proc, Path::new(dev), uid)?;
        }
        Ok(())
    }

    fn run(&self, tool: &str, args: &[OsString], tcti: &str) -> Result<(), String> {
        let exe = self.bin.join(format!("tpm2_{tool}"));
        let mut c = Command::new(&exe);
        c.args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("TPM2TOOLS_TCTI", tcti)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        // tpm2-abrmd is reached over D-Bus: its address, and nothing else of the agent's.
        if tcti.starts_with("tabrmd") {
            for k in ["DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS"] {
                if let Some(v) = std::env::var_os(k) {
                    c.env(k, v);
                }
            }
        }
        let mut child = c.spawn().map_err(|e| format!("{}: {e}", exe.display()))?;
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if started.elapsed() < TIMEOUT => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "tpm2_{tool} did not answer within {} s",
                        TIMEOUT.as_secs()
                    ));
                }
                Err(e) => return Err(format!("tpm2_{tool}: {e}")),
            }
        };
        if status.success() {
            return Ok(());
        }
        let mut said = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut said);
        }
        let said: String = said
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("; ")
            .chars()
            .take(300)
            .collect();
        Err(format!(
            "tpm2_{tool}: {} (exit {})",
            if said.is_empty() { "no word" } else { &said },
            status
                .code()
                .map_or_else(|| "by a signal".to_owned(), |c| c.to_string())
        ))
    }
}

/// Whether the user manager that runs the agent's service (`systemd --user`,
/// `user@<uid>.service`) may open the TPM's device too, when one runs. It keeps the groups it
/// started with: a user put in tss after it started — by linger (prep-root.sh), or a login
/// still open — gets the group in a new login's shell, where install runs, but not in the
/// service, whose every signature would then be refused until the manager restarts. Told
/// by the device's mode bits against each one's groups (`/proc/<pid>/status`); where the
/// bits do not explain this process's own access (an ACL), or nothing is read, nothing is
/// said.
fn manager_opens(proc: &Path, dev: &Path, uid: u32) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let Ok(m) = fs::metadata(dev) else {
        return Ok(());
    };
    let opens = |ids: &Ids| mode_opens(m.mode(), m.uid(), m.gid(), ids);
    let Some(me) = read_ids(&proc.join("self/status")) else {
        return Ok(());
    };
    if !opens(&me) {
        return Ok(());
    }
    match user_manager(proc, uid) {
        Some(manager) if !opens(&manager) => Err(format!(
            "{} is there and this login may open it, but the user manager that runs the agent's service (user@{uid}.service) started before this user had its group: restart it (sudo systemctl restart user@{uid}.service) or reboot",
            dev.display()
        )),
        _ => Ok(()),
    }
}

/// A process's real uid and its groups (its gid and the supplementary ones).
#[derive(Debug, PartialEq, Eq)]
struct Ids {
    uid: u32,
    groups: Vec<u32>,
}

/// The ids of `/proc/<pid>/status`: `Uid:`, `Gid:` and `Groups:` (real ids, the first of each).
fn read_ids(status: &Path) -> Option<Ids> {
    parse_ids(&fs::read_to_string(status).ok()?)
}

fn parse_ids(status: &str) -> Option<Ids> {
    let field = |name: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(name))
            .map(str::split_whitespace)
    };
    let uid = field("Uid:")?.next()?.parse().ok()?;
    let mut groups = vec![field("Gid:")?.next()?.parse().ok()?];
    for g in field("Groups:")? {
        groups.push(g.parse().ok()?);
    }
    Some(Ids { uid, groups })
}

/// Whether a process of these ids opens a file of this mode and owner for reading and
/// writing, by the mode bits as the kernel reads them: the owner's, else the group's, else
/// the others'.
fn mode_opens(mode: u32, owner: u32, group: u32, ids: &Ids) -> bool {
    let bits = if ids.uid == owner {
        mode >> 6
    } else if ids.groups.contains(&group) {
        mode >> 3
    } else {
        mode
    };
    bits & 0o6 == 0o6
}

/// The ids of `uid`'s user manager: the `systemd` process of that uid in its
/// `user@<uid>.service`'s `init.scope`. The scope holds `(sd-pam)` too, which systemd forks
/// from the manager and drops to the user's uid and gid with no supplementary groups: it
/// would never show tss, and after a PID wrap it can come first in `/proc`, so only the
/// process named `systemd` is the manager. `None` when none runs (no linger, no login), or
/// it cannot be read.
fn user_manager(proc: &Path, uid: u32) -> Option<Ids> {
    let scope = format!("/user@{uid}.service/init.scope");
    fs::read_dir(proc).ok()?.flatten().find_map(|e| {
        let name = e.file_name();
        if !name.to_str()?.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let cgroup = fs::read_to_string(e.path().join("cgroup")).ok()?;
        if !cgroup.lines().any(|l| l.trim_end().ends_with(&scope)) {
            return None;
        }
        let status = fs::read_to_string(e.path().join("status")).ok()?;
        if status.lines().find_map(|l| l.strip_prefix("Name:"))?.trim() != "systemd" {
            return None;
        }
        parse_ids(&status).filter(|ids| ids.uid == uid)
    })
}

/// A TCTI the agent takes: a resource manager in front of the TPM — the kernel's
/// (`device:/dev/tpmrm<N>`) or tpm2-abrmd (`tabrmd`, with its options) — never the TPM's
/// raw device or a simulator's socket, where what a run loads would stay loaded.
pub fn tcti_ok(t: &str) -> bool {
    if let Some(n) = t.strip_prefix("device:/dev/tpmrm") {
        return !n.is_empty() && n.len() <= 3 && n.bytes().all(|b| b.is_ascii_digit());
    }
    match t.strip_prefix("tabrmd") {
        Some("") => true,
        Some(conf) => conf.strip_prefix(':').is_some_and(|c| {
            !c.is_empty()
                && c.len() <= 200
                && c.bytes().all(|b| {
                    b.is_ascii_alphanumeric()
                        || matches!(b, b'_' | b'.' | b',' | b'=' | b'/' | b'-')
                })
        }),
        None => false,
    }
}

/// Whether what `tpm2_load` said is the TPM refusing the key's blob: `TPM_RC_INTEGRITY`
/// (a format-1 response code of the TPM itself, error `0x01F`, on a parameter — `0x1DF`
/// for the private blob, the load's first), which a TPM answers to a blob sealed under
/// another storage key: its seed changed (`tpm2_clear`), or it is another TPM. tpm2-tools
/// says it as `Esys_Load(0x1DF) - tpm:parameter(1):integrity check failed`: the code, or
/// its words. Nothing else a load says is that refusal.
fn integrity_refused(said: &str) -> bool {
    const RC_FMT1: u32 = 0x080;
    const RC_INTEGRITY: u32 = 0x01F;
    if said.contains("integrity check failed") {
        return true;
    }
    said.split("(0x").skip(1).any(|rest| {
        let hex = rest.split(')').next().unwrap_or_default();
        u32::from_str_radix(hex, 16).is_ok_and(|rc| {
            // The TPM's own layer (the upper 16 bits zero), not the TSS's or a resource
            // manager's.
            rc >> 16 == 0 && rc & RC_FMT1 != 0 && rc & 0x03F == RC_INTEGRITY
        })
    })
}

/// The host key in the TPM: its public point, the TPM that holds it, and the files that
/// load it there.
pub struct Key {
    state: PathBuf,
    tcti: String,
    point: [u8; 65],
    tools: Arc<dyn Tools>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Meta {
    tcti: String,
}

/// Whether the state directory holds a TPM key: its last file written is there.
pub fn present(state: &Path) -> bool {
    fs::symlink_metadata(state.join(META_FILE)).is_ok()
}

/// Takes the TPM key's files out of the state directory: its mark first, so a stop half-way
/// leaves no key that seems whole.
pub fn remove(state: &Path) -> Result<(), String> {
    for f in [META_FILE, PUBLIC_FILE, PRIVATE_FILE] {
        let p = state.join(f);
        match fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", p.display())),
        }
    }
    Ok(())
}

impl Key {
    /// The key the enrollment made, from its files (the TPM is not asked until it signs). A
    /// link, a file another user may read, or a public area that is not the agent's kind of
    /// key — one the TPM would let leave it among them — is refused.
    pub fn load(state: &Path, tools: Arc<dyn Tools>) -> Result<Self, String> {
        let meta: Meta = serde_json::from_slice(&own_file(&state.join(META_FILE))?)
            .map_err(|e| format!("{}: {e}", state.join(META_FILE).display()))?;
        if !tcti_ok(&meta.tcti) {
            return Err(format!(
                "{}: {:?} is not a TPM the agent reaches",
                state.join(META_FILE).display(),
                meta.tcti
            ));
        }
        let point = parse_public(&own_file(&state.join(PUBLIC_FILE))?)
            .map_err(|e| format!("{}: {e}", state.join(PUBLIC_FILE).display()))?;
        own_file(&state.join(PRIVATE_FILE))?;
        Ok(Self {
            state: state.to_path_buf(),
            tcti: meta.tcti,
            point,
            tools,
        })
    }

    /// A new key in the TPM at `tcti`, its files written into `state` (0600): made, read
    /// back, and one probe signed and checked before anything is written.
    pub fn create(state: &Path, tcti: &str, tools: Arc<dyn Tools>) -> Result<Self, String> {
        if !tcti_ok(tcti) {
            return Err(format!(
                "{tcti:?} is not a TPM the agent reaches (device:/dev/tpmrm<N>, or tabrmd)"
            ));
        }
        tools.reachable(tcti)?;
        let work = Work::new(state)?;
        tools.run("createprimary", &primary_args(&work.0), tcti)?;
        let (public, private) = (work.0.join("key.pub"), work.0.join("key.priv"));
        let create: Vec<OsString> = vec![
            "-Q".into(),
            "-C".into(),
            work.0.join("primary.ctx").into(),
            "-g".into(),
            "sha256".into(),
            "-G".into(),
            "ecc256:ecdsa-sha256".into(),
            "-a".into(),
            KEY_ATTRIBUTES.into(),
            "-u".into(),
            public.clone().into(),
            "-r".into(),
            private.clone().into(),
        ];
        tools.run("create", &create, tcti)?;
        let public_bytes = fs::read(&public).map_err(|e| format!("tpm2_create: {e}"))?;
        let private_bytes = fs::read(&private).map_err(|e| format!("tpm2_create: {e}"))?;
        let point = parse_public(&public_bytes).map_err(|e| format!("tpm2_create: {e}"))?;
        let key = Self {
            state: state.to_path_buf(),
            tcti: tcti.to_owned(),
            point,
            tools,
        };
        key.signature(&work, &public, &private, PROBE)
            .map_err(|e| format!("the new key's probe: {e}"))?;
        // An earlier key's files go first, its mark with them: a write stopped half-way
        // leaves no key that seems whole.
        remove(state)?;
        super::replace(&state.join(PRIVATE_FILE), &private_bytes)?;
        super::replace(&state.join(PUBLIC_FILE), &public_bytes)?;
        let meta = serde_json::to_vec(&Meta {
            tcti: tcti.to_owned(),
        })
        .map_err(|e| e.to_string())?;
        super::replace(&state.join(META_FILE), &meta)?;
        Ok(key)
    }

    /// The public key as the pool keeps it: the uncompressed P-256 point (`04`, x, y).
    pub fn point(&self) -> &[u8; 65] {
        &self.point
    }

    /// The TPM that holds the key.
    pub fn tcti(&self) -> &str {
        &self.tcti
    }

    /// The key's ECDSA P-256 signature of `message` (SHA-256), as `r` and `s` (32 bytes
    /// each, the form `WebCrypto` verifies): signed by the TPM, checked here.
    pub fn sign(&self, message: &[u8]) -> Result<[u8; 64], String> {
        let work = Work::new(&self.state)?;
        self.signature(
            &work,
            &self.state.join(PUBLIC_FILE),
            &self.state.join(PRIVATE_FILE),
            message,
        )
    }

    /// Whether the key is gone from the TPM for good, asked once it did not sign: the TPM is
    /// reached and makes the storage key as ever, but refuses the key's blob under it with
    /// its integrity check ([`integrity_refused`]) — it was cleared (its seed is another), or
    /// the files are another machine's. What the TPM said, then. `None` when the key loads,
    /// when the TPM could not be asked at all (a device this user may not open, tpm2-abrmd
    /// not running), and when the load failed any other way (a run that did not answer in
    /// time, a context file not written on a full disk, a TPM out of object memory or asking
    /// for a retry): no answer is not a verdict, since a lost key's identity is set aside.
    pub fn lost(&self) -> Option<String> {
        self.tools.reachable(&self.tcti).ok()?;
        let work = Work::new(&self.state).ok()?;
        self.tools
            .run("createprimary", &primary_args(&work.0), &self.tcti)
            .ok()?;
        self.tools
            .run(
                "load",
                &load_args(
                    &work.0.join("primary.ctx"),
                    &self.state.join(PUBLIC_FILE),
                    &self.state.join(PRIVATE_FILE),
                    &work.0.join("key.ctx"),
                ),
                &self.tcti,
            )
            .err()
            .filter(|said| integrity_refused(said))
    }

    fn signature(
        &self,
        work: &Work,
        public: &Path,
        private: &Path,
        message: &[u8],
    ) -> Result<[u8; 64], String> {
        let (primary, ctx, digest, sig) = (
            work.0.join("primary.ctx"),
            work.0.join("key.ctx"),
            work.0.join("digest"),
            work.0.join("sig"),
        );
        self.tools
            .run("createprimary", &primary_args(&work.0), &self.tcti)?;
        self.tools
            .run("load", &load_args(&primary, public, private, &ctx), &self.tcti)
            .map_err(|e| {
                format!("{e} — the TPM does not load the host key: was it cleared, or is this another machine's?")
            })?;
        fs::write(&digest, Sha256::digest(message))
            .map_err(|e| format!("{}: {e}", digest.display()))?;
        let sign: Vec<OsString> = vec![
            "-Q".into(),
            "-c".into(),
            ctx.into(),
            "-g".into(),
            "sha256".into(),
            "-s".into(),
            "ecdsa".into(),
            "-d".into(),
            "-o".into(),
            sig.clone().into(),
            digest.into(),
        ];
        self.tools.run("sign", &sign, &self.tcti)?;
        let raw = parse_signature(&fs::read(&sig).map_err(|e| format!("tpm2_sign: {e}"))?)
            .map_err(|e| format!("tpm2_sign: {e}"))?;
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &self.point[..])
            .verify(message, &raw)
            .map_err(|_| {
                "the TPM's signature is not the host key's: nothing was sent with it".to_owned()
            })?;
        Ok(raw)
    }
}

fn load_args(primary: &Path, public: &Path, private: &Path, ctx: &Path) -> Vec<OsString> {
    vec![
        "-Q".into(),
        "-C".into(),
        primary.into(),
        "-u".into(),
        public.into(),
        "-r".into(),
        private.into(),
        "-c".into(),
        ctx.into(),
    ]
}

fn primary_args(work: &Path) -> Vec<OsString> {
    let mut a: Vec<OsString> = PRIMARY.iter().map(OsString::from).collect();
    a.push("-c".into());
    a.push(work.join("primary.ctx").into());
    a
}

/// A directory of the agent's own (0700) beside the key, for one making or one signature:
/// the contexts, the digest and the signature the tools write, gone when it is dropped.
struct Work(PathBuf);

impl Work {
    fn new(state: &Path) -> Result<Self, String> {
        let dir = state.join(format!(".tpm-{}", super::nonce()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Self(dir))
    }
}

impl Drop for Work {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A file of the key's: a regular file, not a link, that only its owner may read.
fn own_file(path: &Path) -> Result<Vec<u8>, String> {
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
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// A reader of TPM's big-endian structures, refusing what runs past the end.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.0.len() < n {
            return Err("cut short".into());
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }
    fn u16(&mut self) -> Result<u16, String> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    /// A TPM2B: its size, then that many bytes.
    fn sized(&mut self) -> Result<&'a [u8], String> {
        let n = self.u16()?;
        self.take(usize::from(n))
    }
    /// An ECC parameter of a P-256 key: at most 32 bytes, left-padded to 32.
    fn coordinate(&mut self) -> Result<[u8; 32], String> {
        let b = self.sized()?;
        if b.is_empty() || b.len() > 32 {
            return Err(format!("a P-256 value of {} bytes", b.len()));
        }
        let mut out = [0u8; 32];
        out[32 - b.len()..].copy_from_slice(b);
        Ok(out)
    }
    fn end(&self) -> Result<(), String> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(format!("{} bytes past its end", self.0.len()))
        }
    }
}

/// The public point of a host key's public area (`TPM2B_PUBLIC`): an ECC NIST P-256 key
/// named by SHA-256, with no policy, that signs with ECDSA and SHA-256 and does nothing
/// else, and that the TPM made and keeps (`fixedtpm`, `fixedparent`,
/// `sensitivedataorigin`). Anything else is refused, by what it is.
pub fn parse_public(b: &[u8]) -> Result<[u8; 65], String> {
    let mut r = Reader(b);
    let size = r.u16()?;
    if usize::from(size) != b.len() - 2 {
        return Err(format!(
            "a public area of {size} bytes in {} bytes",
            b.len() - 2
        ));
    }
    if r.u16()? != ALG_ECC {
        return Err("not an ECC key".into());
    }
    if r.u16()? != ALG_SHA256 {
        return Err("not named by SHA-256".into());
    }
    let attrs = r.u32()?;
    if attrs & (FIXED_TPM | FIXED_PARENT) != FIXED_TPM | FIXED_PARENT {
        return Err(
            "a key the TPM would let leave it (fixedtpm and fixedparent are not both set)".into(),
        );
    }
    if attrs & SENSITIVE_DATA_ORIGIN == 0 {
        return Err("a key the TPM did not make itself (no sensitivedataorigin)".into());
    }
    if attrs & SIGN == 0 || attrs & (RESTRICTED | DECRYPT) != 0 {
        return Err("not a key that only signs (sign, and neither restricted nor decrypt)".into());
    }
    if !r.sized()?.is_empty() {
        return Err("a key with a policy".into());
    }
    if r.u16()? != ALG_NULL {
        return Err("a key with a symmetric algorithm".into());
    }
    if r.u16()? != ALG_ECDSA || r.u16()? != ALG_SHA256 {
        return Err("not an ECDSA key with SHA-256".into());
    }
    if r.u16()? != ECC_NIST_P256 {
        return Err("not on NIST P-256".into());
    }
    if r.u16()? != ALG_NULL {
        return Err("a key with a KDF".into());
    }
    let (x, y) = (r.coordinate()?, r.coordinate()?);
    r.end()?;
    let mut point = [0u8; 65];
    point[0] = 4;
    point[1..33].copy_from_slice(&x);
    point[33..].copy_from_slice(&y);
    Ok(point)
}

/// `r` and `s` of an ECDSA signature with SHA-256 as the TPM writes it (`TPMT_SIGNATURE`),
/// 32 bytes each.
pub fn parse_signature(b: &[u8]) -> Result<[u8; 64], String> {
    let mut r = Reader(b);
    if r.u16()? != ALG_ECDSA || r.u16()? != ALG_SHA256 {
        return Err("not an ECDSA signature with SHA-256".into());
    }
    let (sr, ss) = (r.coordinate()?, r.coordinate()?);
    r.end()?;
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&sr);
    out[32..].copy_from_slice(&ss);
    Ok(out)
}

/// The parsers on arbitrary bytes, for the fuzz targets (`lib.rs` `fuzz::state`).
#[cfg(feature = "fuzzing")]
pub fn fuzz(data: &[u8]) {
    let _ = parse_public(data);
    let _ = parse_signature(data);
}

/// A TPM in memory with the tools' own file formats: what the tests play one with. Its
/// keys are aws-lc-rs ECDSA P-256 keys, each private blob an id it knows them by; every
/// call is recorded, and each tool checks the agent's arguments as the real one reads them.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use aws_lc_rs::rand::{SecureRandom, SystemRandom};
    use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct Tpm {
        /// The keys this TPM made, by their private blob.
        keys: Mutex<HashMap<Vec<u8>, Vec<u8>>>,
        /// Every call: `tpm2_<tool>` and its arguments, one string.
        pub calls: Mutex<Vec<String>>,
        /// Why it cannot be reached (no device, no tools).
        pub unreachable: Mutex<Option<String>>,
        /// The tool that fails, and what it says.
        pub fails: Mutex<Option<(String, String)>>,
        /// The attributes `create` gives a key, instead of the ones asked.
        pub attributes: Mutex<Option<u32>>,
        /// Signs with another key than the one loaded (a TPM that answers wrong).
        pub wrong_key: Mutex<bool>,
    }

    impl Tpm {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }
        /// `tpm2_clear`: every key this TPM made is gone.
        pub fn clear(&self) {
            self.keys.lock().unwrap().clear();
        }
        pub fn calls(&self, tool: &str) -> usize {
            let prefix = format!("tpm2_{tool} ");
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.starts_with(&prefix))
                .count()
        }
    }

    /// The public area `tpm2_create` writes for a P-256 ECDSA key with these attributes.
    pub fn public_area(point: &[u8], attrs: u32) -> Vec<u8> {
        let mut a = Vec::new();
        a.extend_from_slice(&ALG_ECC.to_be_bytes());
        a.extend_from_slice(&ALG_SHA256.to_be_bytes());
        a.extend_from_slice(&attrs.to_be_bytes());
        a.extend_from_slice(&0u16.to_be_bytes());
        for v in [ALG_NULL, ALG_ECDSA, ALG_SHA256, ECC_NIST_P256, ALG_NULL] {
            a.extend_from_slice(&v.to_be_bytes());
        }
        for c in [&point[1..33], &point[33..65]] {
            a.extend_from_slice(&32u16.to_be_bytes());
            a.extend_from_slice(c);
        }
        let mut out = u16::try_from(a.len()).unwrap().to_be_bytes().to_vec();
        out.extend(a);
        out
    }

    /// The attributes [`KEY_ATTRIBUTES`] names.
    pub const AGENT_ATTRIBUTES: u32 =
        FIXED_TPM | FIXED_PARENT | SENSITIVE_DATA_ORIGIN | (1 << 6) | (1 << 10) | SIGN;

    fn arg<'a>(args: &'a [String], flag: &str) -> Result<&'a str, String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
            .ok_or_else(|| format!("no {flag}"))
    }

    fn primary_ok(p: &str) -> bool {
        fs::read(p).is_ok_and(|b| b == b"primary")
    }

    fn written(path: &str, bytes: &[u8]) -> Result<(), String> {
        fs::write(path, bytes).map_err(|e| e.to_string())
    }

    fn read(path: &str) -> Result<Vec<u8>, String> {
        fs::read(path).map_err(|e| e.to_string())
    }

    fn pair(pkcs8: &[u8]) -> EcdsaKeyPair {
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8).unwrap()
    }

    impl Tpm {
        fn createprimary(args: &[String]) -> Result<(), String> {
            assert_eq!(&args[..PRIMARY.len()], &PRIMARY[..]);
            assert_eq!(args.len(), PRIMARY.len() + 2);
            written(arg(args, "-c")?, b"primary")
        }

        fn create(&self, args: &[String]) -> Result<(), String> {
            assert!(primary_ok(arg(args, "-C")?));
            assert_eq!(arg(args, "-G")?, "ecc256:ecdsa-sha256");
            assert_eq!(arg(args, "-a")?, KEY_ATTRIBUTES);
            let rng = SystemRandom::new();
            let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
                .map_err(|_| "keygen".to_owned())?;
            let attrs = self.attributes.lock().unwrap().unwrap_or(AGENT_ATTRIBUTES);
            written(
                arg(args, "-u")?,
                &public_area(pair(pkcs8.as_ref()).public_key().as_ref(), attrs),
            )?;
            let mut id = vec![0u8; 32];
            rng.fill(&mut id).unwrap();
            written(arg(args, "-r")?, &id)?;
            self.keys
                .lock()
                .unwrap()
                .insert(id, pkcs8.as_ref().to_vec());
            Ok(())
        }

        fn load(&self, args: &[String]) -> Result<(), String> {
            assert!(primary_ok(arg(args, "-C")?));
            let id = read(arg(args, "-r")?)?;
            let public = read(arg(args, "-u")?)?;
            let keys = self.keys.lock().unwrap();
            let pkcs8 = keys.get(&id).ok_or(
                "tpm2_load: ERROR: Esys_Load(0x1DF) - tpm:parameter(1):integrity check failed (exit 1)",
            )?;
            if parse_public(&public).map(|p| p.to_vec()).ok().as_deref()
                != Some(pair(pkcs8).public_key().as_ref())
            {
                return Err("tpm2_load: the public area is not the private blob's (exit 1)".into());
            }
            written(arg(args, "-c")?, &id)
        }

        fn sign(&self, args: &[String]) -> Result<(), String> {
            assert!(args.contains(&"-d".to_owned()), "the agent signs a digest");
            assert_eq!((arg(args, "-g")?, arg(args, "-s")?), ("sha256", "ecdsa"));
            let id = read(arg(args, "-c")?)?;
            let digest = read(args.last().unwrap())?;
            let pkcs8 = if *self.wrong_key.lock().unwrap() {
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                    .unwrap()
                    .as_ref()
                    .to_vec()
            } else {
                self.keys
                    .lock()
                    .unwrap()
                    .get(&id)
                    .cloned()
                    .ok_or("no such key loaded")?
            };
            let d =
                aws_lc_rs::digest::Digest::import_less_safe(&digest, &aws_lc_rs::digest::SHA256)
                    .map_err(|_| "a digest of another length".to_owned())?;
            let sig = pair(&pkcs8)
                .sign_digest(&d)
                .map_err(|_| "sign".to_owned())?;
            let (r, s) = sig.as_ref().split_at(32);
            let mut out = Vec::new();
            out.extend_from_slice(&ALG_ECDSA.to_be_bytes());
            out.extend_from_slice(&ALG_SHA256.to_be_bytes());
            for v in [r, s] {
                out.extend_from_slice(&32u16.to_be_bytes());
                out.extend_from_slice(v);
            }
            written(arg(args, "-o")?, &out)
        }
    }

    impl Tools for Tpm {
        fn reachable(&self, _tcti: &str) -> Result<(), String> {
            self.unreachable.lock().unwrap().clone().map_or(Ok(()), Err)
        }

        fn run(&self, tool: &str, args: &[OsString], tcti: &str) -> Result<(), String> {
            assert!(tcti_ok(tcti), "{tcti}");
            let args: Vec<String> = args
                .iter()
                .map(|a| a.to_str().unwrap().to_owned())
                .collect();
            self.calls
                .lock()
                .unwrap()
                .push(format!("tpm2_{tool} {}", args.join(" ")));
            if let Some((t, why)) = self.fails.lock().unwrap().clone() {
                if t == tool {
                    return Err(format!("tpm2_{tool}: {why} (exit 1)"));
                }
            }
            match tool {
                "createprimary" => Self::createprimary(&args),
                "create" => self.create(&args),
                "load" => self.load(&args),
                "sign" => self.sign(&args),
                other => panic!("the agent runs no tpm2_{other}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    fn fixture(name: &str) -> Vec<u8> {
        fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/tpm")
                .join(name),
        )
        .unwrap()
    }

    fn cases() -> serde_json::Value {
        serde_json::from_slice(&fixture("cases.json")).unwrap()
    }

    fn state() -> PathBuf {
        let d = std::env::temp_dir().join(format!("omarchy-agent-tpm-{}", super::super::nonce()));
        fs::create_dir_all(&d).unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).unwrap();
        d
    }

    #[test]
    fn a_real_tpm_s_key_and_signatures_read_and_verify_as_the_pool_verifies_them() {
        // Recorded from swtpm with the agent's own arguments (tests/tpm-fixtures.sh).
        let c = cases();
        let point = parse_public(&fixture("host.tpm.pub")).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(point), c["pubkey"].as_str().unwrap());
        for (sig, m) in [("enroll.sig", "enroll"), ("request.sig", "request")] {
            let raw = parse_signature(&fixture(sig)).unwrap();
            assert_eq!(URL_SAFE_NO_PAD.encode(raw), c[m]["sig"].as_str().unwrap());
            let message = c[m]["message"].as_str().unwrap();
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &point[..])
                .verify(message.as_bytes(), &raw)
                .unwrap();
            // Another message is another signature.
            assert!(UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &point[..])
                .verify(format!("{message}\n").as_bytes(), &raw)
                .is_err());
        }
        // The words the agent signs are the ones the recorded messages were made of.
        assert_eq!(
            super::super::enroll_message(
                c["enroll"]["token"].as_str().unwrap(),
                c["pubkey"].as_str().unwrap()
            ),
            c["enroll"]["message"].as_str().unwrap()
        );
        let r = &c["request"];
        assert_eq!(
            super::super::signed_message(
                r["host"].as_str().unwrap(),
                r["method"].as_str().unwrap(),
                r["path"].as_str().unwrap(),
                &hex::encode(Sha256::digest(r["body"].as_str().unwrap().as_bytes())),
                r["ts"].as_u64().unwrap(),
                r["nonce"].as_str().unwrap()
            ),
            r["message"].as_str().unwrap()
        );
    }

    #[test]
    fn a_key_the_tpm_would_let_go_its_storage_key_and_an_rsa_key_are_refused() {
        assert!(parse_public(&fixture("exportable.pub"))
            .unwrap_err()
            .contains("let leave it"));
        assert!(parse_public(&fixture("storage.pub"))
            .unwrap_err()
            .contains("only signs"));
        assert!(parse_public(&fixture("rsa.pub"))
            .unwrap_err()
            .contains("not an ECC key"));
        // Cut short, one byte more, a size that lies: refused, never a panic.
        let good = fixture("host.tpm.pub");
        for n in 0..good.len() {
            assert!(parse_public(&good[..n]).is_err(), "{n}");
        }
        let mut long = good.clone();
        long.push(0);
        assert!(parse_public(&long).is_err());
        let sig = fixture("request.sig");
        for n in 0..sig.len() {
            assert!(parse_signature(&sig[..n]).is_err(), "{n}");
        }
        let mut long = sig.clone();
        long.push(0);
        assert!(parse_signature(&long).unwrap_err().contains("past its end"));
        // Another hash is another signature scheme.
        let mut sha1 = sig;
        sha1[3] = 0x04;
        assert!(parse_signature(&sha1).is_err());
        // A shorter r is padded on the left, as a TPM may drop a leading zero.
        let mut short = vec![0x00, 0x18, 0x00, 0x0b, 0x00, 0x1f];
        short.extend([7u8; 31]);
        short.extend([0x00, 0x20]);
        short.extend([9u8; 32]);
        let raw = parse_signature(&short).unwrap();
        assert_eq!((raw[0], raw[1], raw[32]), (0, 7, 9));
    }

    #[test]
    fn only_a_resource_manager_is_a_tcti_the_agent_takes() {
        for ok in [
            "device:/dev/tpmrm0",
            "device:/dev/tpmrm12",
            "tabrmd",
            "tabrmd:bus_type=session",
            "tabrmd:bus_name=com.intel.tss2.Tabrmd,bus_type=system",
        ] {
            assert!(tcti_ok(ok), "{ok}");
        }
        for bad in [
            "",
            "device:/dev/tpm0",
            "device:/dev/tpmrm",
            "device:/dev/tpmrm0;x",
            "device:/dev/tpmrm0/../tpm0",
            "swtpm:port=2321",
            "mssim",
            "tabrmd:",
            "tabrmd:bus_type=session\nx",
            "tabrmdx",
            "tabrmd:$(id)",
        ] {
            assert!(!tcti_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_key_made_signs_through_three_runs_and_leaves_nothing_behind() {
        let tpm = fake::Tpm::new();
        let d = state();
        let k = Key::create(&d, "tabrmd:bus_type=session", tpm.clone()).unwrap();
        // Made, its probe signed: createprimary twice, create, load and sign once.
        assert_eq!(
            (
                tpm.calls("createprimary"),
                tpm.calls("create"),
                tpm.calls("load"),
                tpm.calls("sign")
            ),
            (2, 1, 1, 1)
        );
        for f in [PUBLIC_FILE, PRIVATE_FILE, META_FILE] {
            assert_eq!(
                fs::metadata(d.join(f)).unwrap().permissions().mode() & 0o777,
                0o600,
                "{f}"
            );
        }
        assert!(present(&d));
        let again = Key::load(&d, tpm.clone()).unwrap();
        assert_eq!(again.point(), k.point());
        assert_eq!(again.tcti(), "tabrmd:bus_type=session");
        let sig = again.sign(b"hello").unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &k.point()[..])
            .verify(b"hello", &sig)
            .unwrap();
        assert_eq!(tpm.calls("load"), 2);
        // Its work directories are gone: the state holds the three files only.
        let mut names: Vec<String> = fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, [META_FILE, PRIVATE_FILE, PUBLIC_FILE]);
        // The tools never got the agent's environment: the real one's runs are env_clear'd
        // (Cli::run); the arguments name files in the state directory only.
        assert!(tpm.calls.lock().unwrap().iter().all(|c| !c.contains("..")
            && c.split(' ')
                .filter(|a| a.starts_with('/'))
                .all(|a| a.starts_with(d.to_str().unwrap()))));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_cleared_tpm_a_wrong_answer_or_files_another_user_may_read_sign_nothing() {
        let tpm = fake::Tpm::new();
        let d = state();
        let k = Key::create(&d, DEFAULT_TCTI, tpm.clone()).unwrap();
        *tpm.wrong_key.lock().unwrap() = true;
        assert!(k.sign(b"x").unwrap_err().contains("not the host key's"));
        *tpm.wrong_key.lock().unwrap() = false;
        // A key that loads is not lost; one the TPM could not be asked about is not either.
        assert_eq!(k.lost(), None);
        *tpm.unreachable.lock().unwrap() = Some("tabrmd is not running".into());
        assert_eq!(k.lost(), None);
        *tpm.unreachable.lock().unwrap() = None;
        tpm.clear();
        assert!(k.sign(b"x").unwrap_err().contains("was it cleared"));
        // Cleared: the TPM makes its storage key, and refuses the host key's blob under it.
        assert!(k.lost().unwrap().contains("integrity check failed"));
        *tpm.fails.lock().unwrap() = Some(("createprimary".into(), "Permission denied".into()));
        assert_eq!(k.lost(), None);
        // A load that fails any other way is no verdict either: the host is not set aside
        // because its TPM was busy or its disk full.
        for why in [
            "ERROR: Esys_Load(0x902) - tpm:warn(2.0): out of memory for object contexts",
            "ERROR: Esys_Load(0x922) - tpm:warn(2.0): the TPM was not able to start the command",
            "did not answer within 60 s",
            "ERROR: Could not write the context: No space left on device",
        ] {
            *tpm.fails.lock().unwrap() = Some(("load".into(), why.into()));
            assert_eq!(k.lost(), None, "{why}");
        }
        *tpm.fails.lock().unwrap() = None;
        assert!(k.lost().is_some());
        fs::set_permissions(d.join(PRIVATE_FILE), fs::Permissions::from_mode(0o640)).unwrap();
        assert!(Key::load(&d, tpm.clone())
            .err()
            .unwrap()
            .contains("readable by others"));
        fs::set_permissions(d.join(PRIVATE_FILE), fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(d.join(META_FILE), br#"{"tcti":"swtpm:port=2321"}"#).unwrap();
        assert!(Key::load(&d, tpm.clone())
            .err()
            .unwrap()
            .contains("not a TPM the agent reaches"));
        remove(&d).unwrap();
        assert!(!present(&d));
        assert_eq!(fs::read_dir(&d).unwrap().count(), 0);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn only_the_tpm_s_integrity_refusal_of_the_blob_is_a_lost_key() {
        for said in [
            // tpm2-tools 5.6 on swtpm 0.7 after tpm2_clear, its lines as Cli::run joins them.
            "tpm2_load: WARNING:esys:src/tss2-esys/api/Esys_Load.c:324:Esys_Load_Finish() Received TPM Error; ERROR:esys:src/tss2-esys/api/Esys_Load.c:112:Esys_Load() Esys Finish ErrorCode (0x000001df); ERROR: Esys_Load(0x1DF) - tpm:parameter(1):integrity check failed; ERROR: Unable to run /usr/bin/tpm2_load (exit 1)",
            "Esys Finish ErrorCode (0x000001df)",
            "Esys_Load(0x2DF)",
            "tpm:parameter(1):integrity check failed",
        ] {
            assert!(integrity_refused(said), "{said}");
        }
        for said in [
            "tpm2_load did not answer within 60 s",
            "/usr/bin/tpm2_load: No such file or directory (os error 2)",
            "Esys_Load(0x902) - tpm:warn(2.0): out of memory for object contexts",
            "Esys_Load(0x922) - tpm:warn(2.0): the TPM was not able to start the command",
            "Esys_Load(0x9A2) - tpm:session(1):the authorization HMAC check failed and DA counter incremented",
            "Esys_Load(0x1D5) - tpm:parameter(1):structure is the wrong size",
            // Another layer's code (the TSS's, a resource manager's) is not the TPM's refusal.
            "Esys_Load(0xA009F)",
            "ERROR: Could not open file \"key.ctx\": No space left on device",
            "Esys_Load(0x",
            "Esys_Load(0xZZ)",
        ] {
            assert!(!integrity_refused(said), "{said}");
        }
    }

    #[test]
    fn a_key_is_not_written_when_the_tpm_cannot_be_reached_makes_another_kind_or_fails() {
        let d = state();
        let tpm = fake::Tpm::new();
        *tpm.unreachable.lock().unwrap() = Some("no TPM: /dev/tpmrm0 is not there".into());
        assert!(Key::create(&d, DEFAULT_TCTI, tpm.clone())
            .err()
            .unwrap()
            .contains("no TPM"));
        let tpm = fake::Tpm::new();
        *tpm.attributes.lock().unwrap() = Some(fake::AGENT_ATTRIBUTES & !FIXED_PARENT);
        assert!(Key::create(&d, DEFAULT_TCTI, tpm.clone())
            .err()
            .unwrap()
            .contains("let leave it"));
        let tpm = fake::Tpm::new();
        *tpm.fails.lock().unwrap() = Some((
            "createprimary".into(),
            "Esys_CreatePrimary(0x9A2) - tpm:session(1):authorization failure".into(),
        ));
        assert!(Key::create(&d, DEFAULT_TCTI, tpm.clone())
            .err()
            .unwrap()
            .contains("authorization failure"));
        let tpm = fake::Tpm::new();
        *tpm.wrong_key.lock().unwrap() = true;
        assert!(Key::create(&d, DEFAULT_TCTI, tpm.clone())
            .err()
            .unwrap()
            .contains("probe"));
        assert!(Key::create(&d, "swtpm:port=2321", tpm)
            .err()
            .unwrap()
            .contains("not a TPM the agent reaches"));
        // Nothing of any of them was written.
        assert_eq!(fs::read_dir(&d).unwrap().count(), 0);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_machine_without_a_tpm_is_told_so_whatever_is_installed_and_the_tools_are_looked_for_in_usr_bin(
    ) {
        assert_eq!(Cli::default().bin, Path::new("/usr/bin"));
        let none = Cli {
            bin: PathBuf::from("/nonexistent/bin"),
            ..Cli::default()
        };
        // No device and no tools (a VPS, most often): no TPM — a note at preflight — never a
        // package to install that would not help.
        assert_eq!(
            none.reachable("device:/dev/tpmrm97").unwrap_err(),
            "no TPM: /dev/tpmrm97 is not there"
        );
        // tpm2-abrmd and no tools: the tools.
        assert!(none.reachable("tabrmd").unwrap_err().contains(
            "tpm2-tools is not installed (/nonexistent/bin/tpm2_createprimary is not there)"
        ));
        // A device that is not there, with tools that are (stand-ins).
        let d = state();
        for t in TOOLS {
            fs::write(d.join(format!("tpm2_{t}")), b"").unwrap();
        }
        let c = Cli {
            bin: d.clone(),
            ..Cli::default()
        };
        assert_eq!(
            c.reachable("device:/dev/tpmrm97").unwrap_err(),
            "no TPM: /dev/tpmrm97 is not there"
        );
        assert!(c.reachable("tabrmd").is_ok());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_user_manager_that_started_before_its_user_joined_the_device_s_group_is_said() {
        use std::os::unix::fs::MetadataExt;
        let d = state();
        let dev = d.join("tpmrm0");
        fs::write(&dev, b"").unwrap();
        fs::set_permissions(&dev, fs::Permissions::from_mode(0o660)).unwrap();
        let m = fs::metadata(&dev).unwrap();
        // The agent's user: not the device's owner, so its group decides.
        let (uid, tss) = (m.uid() + 1000, m.gid());
        let named = |name: &str, gid: u32, groups: &str| {
            format!("Name:\t{name}\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\nGid:\t{gid}\t{gid}\t{gid}\t{gid}\nGroups:\t{groups}\n")
        };
        let status = |gid: u32, groups: &str| named("systemd", gid, groups);
        let proc = d.join("proc");
        let process = |pid: &str, cgroup: &str, st: &str| {
            fs::create_dir_all(proc.join(pid)).unwrap();
            fs::write(proc.join(pid).join("cgroup"), cgroup).unwrap();
            fs::write(proc.join(pid).join("status"), st).unwrap();
        };
        let other = tss + 1;
        let manager_cgroup =
            format!("0::/user.slice/user-{uid}.slice/user@{uid}.service/init.scope\n");
        // This login has the group; its user manager, started before, does not.
        process("self", "", &status(other, &format!("{other} {tss} ")));
        process(
            "4242",
            &manager_cgroup,
            &status(other, &format!("{other} ")),
        );
        // A process of the user's in an app's scope is not its manager.
        process(
            "4300",
            &format!("0::/user.slice/user-{uid}.slice/user@{uid}.service/app.slice/x.scope\n"),
            &status(other, &format!("{other} {tss}")),
        );
        // Nor is (sd-pam) beside it in init.scope, with no supplementary groups, whatever
        // its PID (a lower one, after a wrap).
        process("4241", &manager_cgroup, &named("(sd-pam)", other, ""));
        let why = manager_opens(&proc, &dev, uid).unwrap_err();
        assert!(
            why.contains(&format!(
                "restart it (sudo systemctl restart user@{uid}.service) or reboot"
            )),
            "{why}"
        );
        // The manager restarted, with the group: nothing to say.
        process(
            "4242",
            &manager_cgroup,
            &status(other, &format!("{other} {tss}")),
        );
        assert_eq!(manager_opens(&proc, &dev, uid), Ok(()));
        // The group is the manager's primary one: it opens it too.
        process("4242", &manager_cgroup, &status(tss, ""));
        assert_eq!(manager_opens(&proc, &dev, uid), Ok(()));
        // No manager runs (no linger, no login): nothing to say, an (sd-pam) left or not.
        fs::remove_dir_all(proc.join("4242")).unwrap();
        assert_eq!(manager_opens(&proc, &dev, uid), Ok(()));
        fs::remove_dir_all(proc.join("4241")).unwrap();
        assert_eq!(manager_opens(&proc, &dev, uid), Ok(()));
        // This login opens it through something else than its groups (an ACL): nothing is told.
        process("4242", &manager_cgroup, &status(other, ""));
        process("self", "", &status(other, ""));
        assert_eq!(manager_opens(&proc, &dev, uid), Ok(()));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn ids_and_mode_bits_are_read_as_the_kernel_reads_them() {
        let ids = parse_ids("Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t998 27 \n").unwrap();
        assert_eq!(
            ids,
            Ids {
                uid: 1000,
                groups: vec![1000, 998, 27]
            }
        );
        assert_eq!(
            parse_ids("Uid:\t7\t7\t7\t7\nGid:\t8\t8\t8\t8\nGroups:\n").unwrap(),
            Ids {
                uid: 7,
                groups: vec![8]
            }
        );
        assert!(parse_ids("Uid:\t7\nGroups:\t1\n").is_none());
        assert!(parse_ids("Uid:\tx\nGid:\t8\nGroups:\n").is_none());
        let user = Ids {
            uid: 1000,
            groups: vec![1000, 998],
        };
        // crw-rw---- tss tss: the group opens it, others do not.
        assert!(mode_opens(0o20660, 59, 998, &user));
        assert!(!mode_opens(0o20660, 59, 59, &user));
        // The owner's bits are the owner's, even when the group's would open it.
        assert!(!mode_opens(0o20060, 1000, 998, &user));
        // Read only is not enough: the agent writes commands to it.
        assert!(!mode_opens(0o20640, 59, 998, &user));
        assert!(mode_opens(0o20666, 59, 59, &user));
    }
}
