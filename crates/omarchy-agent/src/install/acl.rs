//! The agent keys' POSIX access ACL on a remapped daemon (#405, the maintainer's option (a) of
//! 2026-10-08): `OMARCHY_SECRETS_DIR/agent.env` readable by its owner and by one remapped uid,
//! the one the agent sidecars and the probe run as ([`crate::dispatcher_env::remap`]), and by
//! no group and no other user. The owner may set an ACL on its own file, so the agent needs no
//! root and no capability for it: [`super::files::write_keys`] puts it on the temporary file
//! between its `fchmod` to 0600 and its rename, so the file never exists without it, and a
//! write that the filesystem refuses an ACL leaves the file 0600 and says so.
//!
//! The ACL is the kernel's `system.posix_acl_access` attribute (`include/uapi/linux/
//! posix_acl_xattr.h`): a little-endian `u32` version 2, then one `(u16 tag, u16 perm, u32 id)`
//! entry each, sorted by tag and id. Setting it sets the file's mode from it, so the keys
//! file shows 0640: the group bits are the mask (`r--`), its own group entry is `---`. A
//! `chmod` afterwards sets the mask from the group bits (a `chmod 600` takes the named user's
//! read away), which [`is_keys_acl`] then no longer finds: the host is held (fail closed) until
//! the keys are written again. Linux only: a Mac's keys file is read in its VM as the Mac's
//! own uid (#320), and no Mac engine remaps users.

// The attribute's format is read and written on Linux only; elsewhere its tests use it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::Path;

/// The access ACL's extended attribute.
pub const XATTR: &str = "system.posix_acl_access";
const VERSION: u32 = 2;
const USER_OBJ: u16 = 0x01;
const USER: u16 = 0x02;
const GROUP_OBJ: u16 = 0x04;
const GROUP: u16 = 0x08;
const MASK: u16 = 0x10;
const OTHER: u16 = 0x20;
/// The id of every entry that names nobody (the owner, the owning group, the mask, others).
const UNDEFINED: u32 = u32::MAX;
const READ: u16 = 4;
const WRITE: u16 = 2;
/// The longest ACL read back: the keys file's has five entries (44 bytes); one this long was
/// not written by the agent.
const MAX_BYTES: usize = 4 + 8 * 32;

/// One entry: its tag, its permissions (`rwx` as 4, 2, 1) and, for a named user or group,
/// its id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub tag: u16,
    pub perm: u16,
    pub id: u32,
}

/// The keys file's ACL: its owner reads and writes, `reader` reads through a mask that lets
/// nothing else through, and its group and every other user nothing.
pub fn keys_acl(reader: u32) -> [Entry; 5] {
    let e = |tag, perm, id| Entry { tag, perm, id };
    [
        e(USER_OBJ, READ | WRITE, UNDEFINED),
        e(USER, READ, reader),
        e(GROUP_OBJ, 0, UNDEFINED),
        e(MASK, READ, UNDEFINED),
        e(OTHER, 0, UNDEFINED),
    ]
}

/// The attribute's bytes for `entries`.
pub fn encode(entries: &[Entry]) -> Vec<u8> {
    let mut out = VERSION.to_le_bytes().to_vec();
    for e in entries {
        out.extend(e.tag.to_le_bytes());
        out.extend(e.perm.to_le_bytes());
        out.extend(e.id.to_le_bytes());
    }
    out
}

/// The entries of the attribute's bytes.
pub fn decode(bytes: &[u8]) -> Result<Vec<Entry>, String> {
    let (head, rest) = bytes
        .split_first_chunk::<4>()
        .ok_or("an ACL shorter than its header")?;
    if u32::from_le_bytes(*head) != VERSION || rest.len() % 8 != 0 {
        return Err(format!(
            "an ACL of {} bytes that does not read",
            bytes.len()
        ));
    }
    Ok(rest
        .chunks_exact(8)
        .map(|c| Entry {
            tag: u16::from_le_bytes([c[0], c[1]]),
            perm: u16::from_le_bytes([c[2], c[3]]),
            id: u32::from_le_bytes([c[4], c[5], c[6], c[7]]),
        })
        .collect())
}

/// Whether `entries` let `reader` read the file and nobody but it and the owner: the owner
/// reads, one named user — `reader` — reads and nothing more, the mask lets read alone through,
/// and the owning group, every named group and others have nothing.
pub fn is_keys_acl(entries: &[Entry], reader: u32) -> bool {
    let only = |tag| {
        let mut it = entries.iter().filter(move |e| e.tag == tag);
        match (it.next(), it.next()) {
            (Some(e), None) => Some(*e),
            _ => None,
        }
    };
    let (Some(owner), Some(user), Some(group), Some(mask), Some(other)) = (
        only(USER_OBJ),
        only(USER),
        only(GROUP_OBJ),
        only(MASK),
        only(OTHER),
    ) else {
        return false;
    };
    owner.perm & READ != 0
        && user.id == reader
        && user.perm == READ
        && mask.perm == READ
        && group.perm == 0
        && other.perm == 0
        && !entries.iter().any(|e| e.tag == GROUP)
}

/// `getfacl`'s short form of `entries`: `user::rw-,user:165533:r--,group::---,mask::r--,other::---`.
pub fn show(entries: &[Entry]) -> String {
    let perm = |p: u16| {
        format!(
            "{}{}{}",
            if p & 4 != 0 { 'r' } else { '-' },
            if p & 2 != 0 { 'w' } else { '-' },
            if p & 1 != 0 { 'x' } else { '-' }
        )
    };
    entries
        .iter()
        .map(|e| match e.tag {
            USER_OBJ => format!("user::{}", perm(e.perm)),
            USER => format!("user:{}:{}", e.id, perm(e.perm)),
            GROUP_OBJ => format!("group::{}", perm(e.perm)),
            GROUP => format!("group:{}:{}", e.id, perm(e.perm)),
            MASK => format!("mask::{}", perm(e.perm)),
            OTHER => format!("other::{}", perm(e.perm)),
            t => format!("tag {t:#x}:{}:{}", e.id, perm(e.perm)),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Puts the keys file's ACL for `reader` on the open file `fd`.
#[cfg(target_os = "linux")]
pub fn set(fd: std::os::fd::BorrowedFd<'_>, reader: u32) -> Result<(), String> {
    rustix::fs::fsetxattr(
        fd,
        XATTR,
        &encode(&keys_acl(reader)),
        rustix::fs::XattrFlags::empty(),
    )
    .map_err(said)
}

#[cfg(not(target_os = "linux"))]
pub fn set(_fd: std::os::fd::BorrowedFd<'_>, _reader: u32) -> Result<(), String> {
    Err("POSIX ACLs are set on Linux only".into())
}

/// The access ACL of `path`, never following a link: `Ok(None)` when it has none (its mode
/// alone), an error when the filesystem keeps none or it does not read.
#[cfg(target_os = "linux")]
pub fn read(path: &Path) -> Result<Option<Vec<Entry>>, String> {
    let mut buf = [0u8; MAX_BYTES];
    match rustix::fs::lgetxattr(path, XATTR, &mut buf[..]) {
        Ok(n) => decode(&buf[..n]).map(Some),
        Err(rustix::io::Errno::NODATA) => Ok(None),
        Err(e) => Err(said(e)),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn read(_path: &Path) -> Result<Option<Vec<Entry>>, String> {
    Err("POSIX ACLs are read on Linux only".into())
}

/// Why an ACL could not be set or read, in words.
#[cfg(target_os = "linux")]
fn said(e: rustix::io::Errno) -> String {
    use rustix::io::Errno;
    match e {
        Errno::OPNOTSUPP => "its filesystem keeps no POSIX ACLs (EOPNOTSUPP: mounted without acl, or one that has none)".into(),
        Errno::RANGE => "an ACL longer than the agent writes".into(),
        Errno::PERM | Errno::ACCESS => "the agent may not set an ACL on it (not its owner)".into(),
        Errno::INVAL => "the kernel took no ACL naming that uid (EINVAL: one this user namespace does not map)".into(),
        e => format!("its ACL: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #405: the keys file's ACL as the kernel's attribute — version 2, five sorted entries,
    /// little-endian — and back; what it lets through, and what it does not.
    #[test]
    fn the_keys_acl_lets_its_owner_and_one_remapped_uid_read_and_nobody_else() {
        let acl = keys_acl(165_533);
        let bytes = encode(&acl);
        assert_eq!(bytes.len(), 44);
        assert_eq!(&bytes[..4], &[2, 0, 0, 0]);
        // user:165533:r-- : tag 2, perm 4, id 165533 (0x2869d).
        assert_eq!(&bytes[12..20], &[2, 0, 4, 0, 0x9d, 0x86, 0x02, 0]);
        assert_eq!(decode(&bytes).unwrap(), acl);
        assert_eq!(
            show(&acl),
            "user::rw-,user:165533:r--,group::---,mask::r--,other::---"
        );
        assert!(is_keys_acl(&acl, 165_533));
        // The agent's own, for another uid: not this one's.
        assert!(!is_keys_acl(&acl, 165_532));
        let with = |f: &dyn Fn(&mut Vec<Entry>)| {
            let mut v = acl.to_vec();
            f(&mut v);
            is_keys_acl(&v, 165_533)
        };
        // A chmod 600 after it: the mask is the group bits, nothing gets through to the uid.
        assert!(!with(&|v| v[3].perm = 0));
        // A chmod 640 on a plain 0600 file is no ACL; one that opens the group or others is refused.
        assert!(!with(&|v| v[2].perm = READ));
        assert!(!with(&|v| v[4].perm = READ));
        // The uid may write, or the mask lets writing through: not the agent's.
        assert!(!with(&|v| v[1].perm = READ | WRITE));
        assert!(!with(&|v| v[3].perm = READ | WRITE));
        // A second named user, or a named group: more than one uid reads.
        assert!(!with(&|v| v.insert(
            2,
            Entry {
                tag: USER,
                perm: READ,
                id: 1001
            }
        )));
        assert!(!with(&|v| v.insert(
            3,
            Entry {
                tag: GROUP,
                perm: READ,
                id: 1001
            }
        )));
        // No named user at all: the plain mode bits.
        assert!(!with(&|v| {
            v.remove(1);
        }));
        // An owner that only reads (a chmod 440 later took the mask too): still its owner's.
        assert!(with(&|v| v[0].perm = READ));
        // Bytes that are no ACL.
        assert!(decode(&[2, 0, 0]).is_err());
        assert!(decode(&[1, 0, 0, 0]).is_err());
        assert!(decode(&bytes[..43]).is_err());
        assert_eq!(decode(&[2, 0, 0, 0]).unwrap(), []);
    }
}
