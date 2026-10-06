//! `journal.ndjson` (design v2 §18.4): one JSON object per line for every step, round and
//! poll outcome, rotated at 10 MiB (one previous file kept, `journal.ndjson.1`).
//!
//! Every text that reaches the journal (and the report) is scrubbed of the values of the
//! set's env files first, so an engine error that echoes an interpolated variable never
//! puts a secret on disk.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) const ROTATE_AT: u64 = 10 << 20;
/// The longest text kept of an error (an engine's stderr line, say).
pub(crate) const MAX_TEXT: usize = 1000;

pub(crate) struct Journal {
    path: PathBuf,
    rotate_at: u64,
    secrets: Vec<String>,
}

impl Journal {
    pub fn new(path: &Path) -> Self {
        Journal {
            path: path.to_owned(),
            rotate_at: ROTATE_AT,
            secrets: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn rotating_at(mut self, bytes: u64) -> Self {
        self.rotate_at = bytes;
        self
    }

    /// Values never to be written: those of the set's `etc/*.env` files.
    pub fn set_secrets(&mut self, secrets: Vec<String>) {
        self.secrets = secrets;
    }

    /// `text` with every secret replaced, then cut to [`MAX_TEXT`] characters: cut only
    /// after the scrub, so a secret is never split where it would no longer match.
    pub fn scrub(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for s in &self.secrets {
            out = out.replace(s.as_str(), "[redacted]");
        }
        if out.chars().count() > MAX_TEXT {
            out = out.chars().take(MAX_TEXT).collect();
        }
        out
    }

    /// Appends one event; a journal that cannot be written is said on stderr and skipped
    /// (the journal never stops the agent).
    pub fn write(&self, at: i64, event: &str, fields: serde_json::Value) {
        let mut line = serde_json::json!({ "at": at, "event": event });
        if let (Some(obj), serde_json::Value::Object(extra)) = (line.as_object_mut(), fields) {
            for (k, v) in extra {
                let v = match v {
                    serde_json::Value::String(s) => serde_json::Value::String(self.scrub(&s)),
                    other => other,
                };
                obj.insert(k, v);
            }
        }
        let text = format!("{line}\n");
        eprint!("{text}");
        if let Err(e) = self.append(text.as_bytes()) {
            eprintln!("journal: {}: {e}", self.path.display());
        }
    }

    fn append(&self, bytes: &[u8]) -> std::io::Result<()> {
        if fs::metadata(&self.path).is_ok_and(|m| m.len() + bytes.len() as u64 > self.rotate_at) {
            fs::rename(&self.path, self.path.with_extension("ndjson.1"))?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(bytes)
    }
}

/// Reads `etc/*.env` of the set directory: each `KEY=value` value of 8 or more
/// characters is a secret to scrub (shorter ones would scrub ordinary words), but those of
/// the keys the agent renders into `etc/dispatcher.env` that hold none (#371: the host's
/// addresses, the secrets directory's path, the budget), which an engine's error may name;
/// and the host worker token from its own file (#327).
pub(crate) fn env_secrets(set_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(t) = fs::read_to_string(crate::dispatcher_env::token_path_in(set_dir)) {
        let t = t.trim();
        if t.len() >= 8 {
            out.push(t.to_owned());
        }
    }
    out.extend(env_values(&set_dir.join("etc")));
    out.sort_by_key(|s| std::cmp::Reverse(s.len()));
    out.dedup();
    out
}

/// The values of `dir/*.env`, as [`env_secrets`] reads them: the set's `etc/`, or (#325's
/// `diagnostics`) the secrets directory's `agent.env`, longest first.
pub(crate) fn env_values(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        if e.path().extension().is_some_and(|x| x == "env") {
            if let Ok(text) = fs::read_to_string(e.path()) {
                for line in text.lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        let v = v.trim().trim_matches(['"', '\'']);
                        if v.len() >= 8 && !crate::dispatcher_env::not_secret(k.trim()) {
                            out.push(v.to_owned());
                        }
                    }
                }
            }
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.len()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::state::tempdir;

    #[test]
    fn rotates_at_its_size_and_scrubs_env_file_values() {
        let dir = tempdir();
        fs::create_dir_all(dir.join("etc")).unwrap();
        fs::write(
            dir.join("etc/dispatcher.env"),
            "OMARCHY_WORKER_TOKEN=omw_secret_value_123\nSHORT=abc\n",
        )
        .unwrap();
        let path = dir.join("journal.ndjson");
        let mut j = Journal::new(&path).rotating_at(400);
        j.set_secrets(env_secrets(&dir));
        j.write(
            1,
            "round",
            serde_json::json!({"detail": "compose: token omw_secret_value_123 abc"}),
        );
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("omw_secret_value_123"), "{text}");
        assert!(text.contains("[redacted] abc"), "{text}");
        // A secret straddling the length bound is scrubbed before the cut.
        let long = format!("{}omw_secret_value_123", "x".repeat(MAX_TEXT - 5));
        let cut = j.scrub(&long);
        assert_eq!(cut.chars().count(), MAX_TEXT);
        assert!(cut.ends_with("[reda") && !cut.contains("omw_s"), "{cut}");
        for i in 0..20 {
            j.write(i, "tick", serde_json::json!({"n": i}));
        }
        assert!(fs::metadata(&path).unwrap().len() <= 400);
        assert!(path.with_extension("ndjson.1").exists());
    }
}
