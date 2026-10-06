//! The owner's signed orders on the run loop (#328, design v2 §12, §14, D6 b): a widening of
//! the envelope and the agent keys, each taken only when the owner's passkey pinned at this
//! host signed it ([`crate::owner::verify_signed`]); and the host's seal key, which the
//! report carries for the owner's browser to seal the keys to.
//!
//! - `widen-envelope`: the document's keys replace agent.toml's in `[envelope]`, line by
//!   line; the loop takes the new envelope at once — the bounds the pool narrows inside, the
//!   agent budget `etc/dispatcher.env` carries, a Mac's VM size — and counts the host's
//!   capacity again under it ([`super::settings::recap`]): never more units than the signed
//!   constants and the detected hardware give. The changed `run/capacity.json` or
//!   `etc/dispatcher.env` recreates the dispatcher, as any change of an input does.
//! - `set-agent-keys`: each key opened with the seal key and written to
//!   `OMARCHY_SECRETS_DIR/agent.env`, the owner's other lines kept; a `GITHUB_TOKEN` is
//!   asked of GitHub first and refused with any scope. Nothing else learns a value: the
//!   dispatcher never mounts the secrets directory (the lint), and the journal, the report
//!   and the diagnostics scrub every value the file holds.
//!
//! The version a document carries is recorded before anything changes, so a document is
//! taken once; whatever fails after it answers `refused` with why, and the owner signs
//! again.

use std::fmt::Write as _;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use crate::owner::keychain::Security;
use crate::owner::seal::{self, SealKey};
use crate::owner::{self, Act, Record, Widening};

use super::agent::Agent;
use super::brake::Ask;
use super::config::Config;
use super::pool::{Net, Signed};
use super::settings;

/// A seal key that could not be loaded (a locked keychain) is tried again this much later.
const SEAL_RETRY_S: i64 = 600;

impl Agent {
    /// The agent's state directory (the host key's, `host.ed25519`).
    fn state_dir(&self) -> PathBuf {
        self.paths.data.join("state")
    }

    /// The host's seal key, loaded once (made the first time, and said once on the journal):
    /// a 0600 file on Linux, the login keychain on a Mac.
    pub(super) fn seal_key(&mut self, now: i64) -> Result<&SealKey, String> {
        if self.seal.is_none() {
            if let Some((at, e)) = &self.seal_tried {
                if now < at + SEAL_RETRY_S {
                    return Err(e.clone());
                }
            }
            let state = self.state_dir();
            let had = seal::read_public(&state);
            let loaded = if self.mac {
                let account = seal::keychain_account(&self.paths.data);
                match self.keychain.as_deref_mut() {
                    Some(k) => SealKey::load_or_create_in(&state, k, &account),
                    None => Err("no keychain to keep the seal key in".to_owned()),
                }
            } else {
                SealKey::load_or_create(&state)
            };
            match loaded {
                Ok(k) => {
                    if had.as_deref() != Some(k.public_b64u().as_str()) {
                        self.journal.write(
                            now,
                            "seal-key",
                            serde_json::json!({"detail": format!(
                                "this host's seal key is {}: its owner confirms it once on the host's page, then the agent keys sealed to it there reach agent.env",
                                k.fingerprint()
                            )}),
                        );
                    }
                    self.seal_tried = None;
                    self.seal = Some(k);
                }
                Err(e) => {
                    let e = format!("the seal key could not be loaded: {e}");
                    if self.seal_tried.as_ref().is_none_or(|(_, was)| *was != e) {
                        self.journal
                            .write(now, "seal-key", serde_json::json!({"detail": e}));
                    }
                    self.seal_tried = Some((now, e.clone()));
                    return Err(e);
                }
            }
        }
        self.seal
            .as_ref()
            .ok_or_else(|| "the seal key is not loaded".to_owned())
    }

    /// `widen-envelope` (#328): the signed document's keys set in agent.toml's `[envelope]`.
    pub(super) fn widen_envelope(&mut self, s: &Signed, now: i64) -> Result<String, String> {
        let state = self.state_dir();
        let mut rec = Record::load(&state)?;
        let (doc, counter) = owner::verify_signed(
            &rec,
            s.doc.as_bytes(),
            &s.assertion,
            Act::WidenEnvelope,
            &self.cfg.host_id,
            now,
        )?;
        let w = Widening::read(
            doc.envelope
                .as_ref()
                .ok_or("the document names no envelope")?,
        )?;
        let path = self.paths.agent_toml();
        let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mode = fs::metadata(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .permissions()
            .mode()
            & 0o777;
        let (new, changes) = w.apply(&text)?;
        let fresh = Config::parse(&new)?;
        // A document is good once: its version is recorded before anything changes.
        let version = doc.version.unwrap_or(rec.version);
        rec.version = version;
        if let Some(p) = rec.passkey.as_mut() {
            p.counter = counter;
        }
        rec.save(&state)?;
        super::state::write_atomic(&path, new.as_bytes())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(mode))
            .map_err(|e| format!("{}: {e}", path.display()))?;
        // The loop takes the new envelope at once: what the pool may narrow inside, the
        // budget the dispatcher's env carries, the lint's paths and a Mac's VM size.
        self.cfg.policy = fresh.policy;
        self.cfg.agent_budget = fresh.agent_budget;
        self.cfg.envelope = fresh.envelope;
        if let (Some(v), Some(k)) = (&fresh.vm, self.vm.as_mut()) {
            k.resize(crate::vm::Size {
                cpus: v.cpus,
                mem_gb: v.mem_gb,
            });
        }
        self.cfg.vm = fresh.vm;
        if let Some(h) = self.host_env.as_mut() {
            h.next_at = now;
        }
        let counted = self.recap(&new)?;
        if !changes.is_empty() {
            self.state.brake.record(now, &[Ask::Restart]);
        }
        let mut said = if changes.is_empty() {
            format!(
                "{}'s passkey signed version {version}: agent.toml's envelope said so already, nothing changed",
                doc.by
            )
        } else {
            format!(
                "{}'s passkey widened the envelope (version {version}): {}",
                doc.by,
                changes.join(", ")
            )
        };
        if !counted.is_empty() {
            let _ = write!(
                said,
                "; run/capacity.json counted again: {} — the dispatcher is recreated with it and claims by it from its next claim",
                counted.join(", ")
            );
        }
        if w.0.iter().any(|(k, _)| k == "emulate") {
            said.push_str("; an emulated lane its detection never smoke-tested comes on at its next count (`omarchy-agent capacity --write`, or a restart of a Mac's VM)");
        }
        Ok(said)
    }

    /// `run/capacity.json` counted again under the envelope agent.toml now says (`text`), with
    /// the applied release's signed constants: what changed. No release applied (nothing
    /// runs yet) or none cached counts nothing.
    fn recap(&mut self, text: &str) -> Result<Vec<String>, String> {
        let Some(b) = self.state.applied.and_then(|r| self.cached(r)) else {
            return Ok(Vec::new());
        };
        let caps = crate::capacity::AgentToml::parse(text)?.caps;
        let s = self.state.settings.clone().unwrap_or_default();
        settings::recap(
            &self.cfg.set_dir,
            &caps,
            b.manifest().capacity().constants(),
            &s,
            &self.cfg.policy,
        )
    }

    /// `set-agent-keys` (#328): the signed document's sealed keys opened with this host's
    /// seal key and written to `OMARCHY_SECRETS_DIR/agent.env`.
    pub(super) fn set_agent_keys(&mut self, s: &Signed, now: i64) -> Result<String, String> {
        let state = self.state_dir();
        let mut rec = Record::load(&state)?;
        let (doc, counter) = owner::verify_signed(
            &rec,
            s.doc.as_bytes(),
            &s.assertion,
            Act::SetAgentKeys,
            &self.cfg.host_id,
            now,
        )?;
        let host = self.cfg.host_id.clone();
        let keys = owner::open_keys(self.seal_key(now)?, &host, &doc)?;
        // A GITHUB_TOKEN is public read only (design v2 §20 item 7): GitHub is asked for its
        // scopes first, as install asks, and one with any scope is refused.
        if let Some((_, Some(t))) = keys.iter().find(|(k, _)| k == "GITHUB_TOKEN") {
            match self.pool.github_scopes(t) {
                Net::Ok(scopes) => crate::install::checks::github_token(Ok(scopes))?,
                Net::NoAnswer(e) => {
                    return Err(format!(
                        "GITHUB_TOKEN: GitHub did not say what the token may do ({e}): nothing was written; its owner signs it again"
                    ))
                }
                Net::Unauthorized(c) => {
                    return Err(format!(
                        "GITHUB_TOKEN: GitHub refused the token ({c}): nothing was written"
                    ))
                }
            }
        }
        let dir = self.cfg.secrets_dir.clone();
        let path = dir.join("agent.env");
        let (text, mode) = match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(format!(
                    "{}: a symbolic link; refused, not followed",
                    path.display()
                ))
            }
            Ok(m) => (
                fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?,
                // The owner's mode stays (0644 inside a 0700 directory for a rootful
                // engine's sidecars), never wider.
                m.permissions().mode() & 0o644,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), 0o600),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let new = owner::merge_agent_env(&text, &keys)?;
        // A document is good once: its version is recorded before anything changes.
        let version = doc.version.unwrap_or(rec.version);
        rec.version = version;
        if let Some(p) = rec.passkey.as_mut() {
            p.counter = counter;
        }
        rec.save(&state)?;
        crate::install::files::make_dir(&dir)?;
        crate::install::files::write(&dir, "agent.env", new.as_bytes(), mode.max(0o600))?;
        // From now on the journal, the report and the diagnostics scrub these values too.
        self.journal
            .set_secrets(super::agent::secrets_of(&self.cfg.set_dir, &dir));
        let names = |set: bool| {
            keys.iter()
                .filter(|(_, v)| v.is_some() == set)
                .map(|(k, _)| k.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let (set, removed) = (names(true), names(false));
        let mut said = format!("{}'s passkey (version {version}): ", doc.by);
        let parts: Vec<String> = [(set, "set"), (removed, "taken out")]
            .into_iter()
            .filter(|(names, _)| !names.is_empty())
            .map(|(names, what)| format!("{names} {what}"))
            .collect();
        let _ = write!(
            said,
            "{} in {} — the next agent sidecar reads it; a task already running keeps what it started with",
            parts.join(", "),
            path.display()
        );
        Ok(said)
    }

    /// The report's `owner` (#328): the passkey pinned here (never its key) and the last
    /// version taken, the seal key the owner confirms and seals to, the envelope's keys a
    /// widening may set as agent.toml says them, and the names of the keys `agent.env` holds
    /// — never a value.
    pub(super) fn owner_view(&mut self, now: i64) -> serde_json::Value {
        let rec = Record::load(&self.state_dir()).ok();
        let seal = self
            .seal_key(now)
            .ok()
            .map(|k| serde_json::json!({"key": k.public_b64u(), "fingerprint": k.fingerprint()}));
        let toml = fs::read_to_string(self.paths.agent_toml()).unwrap_or_default();
        let keys = fs::read_to_string(self.cfg.secrets_dir.join("agent.env"))
            .map(|t| owner::agent_key_names(&t))
            .unwrap_or_default();
        serde_json::json!({
            "passkey": rec.as_ref().map(|r| r.view()["passkey"].clone()),
            "version": rec.as_ref().map(|r| r.version),
            "seal": seal,
            "envelope": owner::envelope_view(&toml),
            "agent_keys": keys,
        })
    }
}

/// The real keychain of a Mac (#328), or none elsewhere.
pub(super) fn keychain() -> Option<Box<dyn Security>> {
    cfg!(target_os = "macos")
        .then(|| Box::new(crate::owner::keychain::Cli::default()) as Box<dyn Security>)
}

#[cfg(test)]
#[path = "owner_tests.rs"]
mod tests;
