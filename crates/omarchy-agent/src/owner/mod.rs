//! The owner's control without a visit (#328, design v2 §12, §14, decision D6 b): a
//! widening of the envelope and the agent keys, given from the site and taken on the host
//! only when the owner's own passkey signed them. The pool relays both; its database and
//! its relay can forge neither, nor read a key. (The page the owner signs on is the pool's:
//! worker/src/docs/security-model.md says what compromised code serving it could do.)
//!
//! - **The pin.** Once, at the host, `omarchy-agent envelope pin-passkey <pin>` takes the
//!   owner's passkey: the pin the site made (an assertion of that passkey over a document
//!   naming this host, its relying party and its origin, with the passkey's public key) is
//!   checked here — the signature with that key, user presence and verification, this host,
//!   not expired — and the key is kept in `state/owner.json` (0600). From then on that key,
//!   that RP id and that origin are this host's, whatever the pool says.
//! - **A signed document.** The site shows the owner what it asks the host to do — the
//!   envelope's new values, the agent keys sealed to the host — as a document the pool
//!   writes (worker/src/hosts.ts `ownerDoc`) with a version above the last one this host
//!   took; the owner's passkey signs it (a `WebAuthn` assertion whose challenge is the
//!   document's SHA-256); the pool relays it as a host order. The host takes it only when
//!   [`verify_signed`] says the pinned credential made it — clientDataJSON's type, the
//!   challenge, the pinned origin, the pinned RP id's hash, UP and UV, the signature —, it
//!   is for this host, not expired, and its version is above the last taken. Anything else
//!   is refused and reported: no assertion, another credential, a replayed or a lower
//!   version, another origin or relying party, UP or UV missing. The version is moved
//!   before anything is changed, so a document is good once.
//! - **A widening** ([`Widening`]) replaces the keys it names in `agent.toml`'s
//!   `[envelope]` — `max_units`, `max_cpus`, `max_mem_gb`, `emulate`, `agent_slots`,
//!   `agent_budget`, `diagnostics`, `paths`, and nothing else: never the socket, the
//!   isolation acknowledgements, the task subnets, the soak or a `[set]` path — line by
//!   line, so the owner's comments stay. Units never rise above what the signed capacity
//!   constants and the detected hardware give (`run::settings::recap`).
//! - **Agent keys** ([`seal`]) arrive sealed to the host's X25519 key, each named from
//!   [`AGENT_KEYS`] (the six the dispatcher refuses to hold, `pkg-repo dispatch`); they are
//!   opened here and written to `OMARCHY_SECRETS_DIR/agent.env` alone (0600, the owner's
//!   own lines kept), which only agent sidecars mount, read-only.
//!
//! Narrowing needs no signature: the pool's settings (`set-units`, `set-emulate`) narrow
//! inside the envelope as before (#325).

pub mod keychain;
pub mod seal;
pub mod webauthn;

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use self::seal::Sealed;
use self::webauthn::{challenge_of, Assertion, Expected, Key};

/// Every document the owner signs names this schema.
pub const SCHEMA: &str = "omarchy-agent/owner/1";
/// The owner record in the state directory: the pinned passkey and the last version taken.
pub const RECORD_FILE: &str = "owner.json";
/// A document is read up to this size (the sealed keys are the large part).
pub const DOC_MAX: usize = 32 << 10;
/// A document dated this far in the future is refused (the site's clock against the
/// host's).
const SKEW_S: i64 = 300;
/// No document lives longer than this.
const LIFE_MAX_S: i64 = 2 * 3600;
/// The agent keys a sealed document may set: the ones agent sidecars read, which the
/// dispatcher refuses to hold (design v2 §10.2 invariant 5) — never a URL, a model name or
/// any other variable a sidecar would act on.
pub const AGENT_KEYS: [&str; 6] = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "XAI_API_KEY",
    "GITHUB_TOKEN",
];
/// The `[envelope]` keys a signed widening may set (design v2 §12; the issue's list: a
/// higher unit, CPU or memory cap, an emulated lane, more agent slots or budget, a path —
/// and whether the pool may ask for diagnostics).
pub const WIDENABLE: [&str; 8] = [
    "max_units",
    "max_cpus",
    "max_mem_gb",
    "emulate",
    "agent_slots",
    "agent_budget",
    "diagnostics",
    "paths",
];

/// What the owner signs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    /// The pin's proof: this passkey, for this host.
    PinPasskey,
    WidenEnvelope,
    SetAgentKeys,
}

impl Act {
    pub fn name(self) -> &'static str {
        match self {
            Act::PinPasskey => "pin-passkey",
            Act::WidenEnvelope => "widen-envelope",
            Act::SetAgentKeys => "set-agent-keys",
        }
    }
}

/// The document as the pool wrote it and the owner signed it. Read strictly: a field this
/// agent does not know refuses it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Doc {
    pub schema: String,
    pub act: String,
    pub host: String,
    #[serde(default)]
    pub version: Option<u64>,
    pub issued_at: String,
    pub not_after: String,
    /// The owner's login, as the site signed them in.
    pub by: String,
    #[serde(default)]
    pub rp_id: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub envelope: Option<serde_json::Map<String, Value>>,
    /// The seal key the keys were sealed to (base64url).
    #[serde(default)]
    pub seal_key: Option<String>,
    #[serde(default)]
    pub keys: Option<Vec<Sealed>>,
}

/// The owner's passkey as pinned at this host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pinned {
    pub host: String,
    /// The credential's id, base64url.
    pub credential: String,
    pub alg: i64,
    /// Its COSE public key, base64url, as the authenticator wrote it.
    pub public_key: String,
    pub rp_id: String,
    pub origin: String,
    pub by: String,
    pub pinned_at: String,
    /// The authenticator's signature counter at its last use here (0: it keeps none).
    pub counter: u32,
}

/// `state/owner.json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Record {
    /// The last signed document's version this host took (any act but the pin): one at or
    /// below it is refused. Kept across a new pin and an unpin.
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub passkey: Option<Pinned>,
    /// The last signed document whose change was made, and the order that carried it: that
    /// same order seen again — the agent stopped after the change, before its answer
    /// reached the pool — is answered as taken already, never as a replay. The same
    /// document under any other order is a replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken: Option<Taken>,
}

/// A document taken: its order's id and its SHA-256 (base64url).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Taken {
    pub order: String,
    pub doc: String,
}

impl Record {
    /// Whether `order` carrying `doc` is the last one this host took and made its change
    /// for, byte for byte: what to answer then (nothing is changed again).
    pub fn taken_already(&self, order: &str, doc: &[u8]) -> Option<String> {
        self.taken
            .as_ref()
            .is_some_and(|t| t.order == order && t.doc == challenge_of(doc))
            .then(|| {
                format!(
                    "this signed document (version {}) was taken already: nothing changed again",
                    self.version
                )
            })
    }

    /// Records that `order`'s `doc` made its change (after it did, its version being
    /// recorded before).
    pub fn took(&mut self, order: &str, doc: &[u8]) {
        self.taken = Some(Taken {
            order: order.to_owned(),
            doc: challenge_of(doc),
        });
    }

    /// The record in `state`; an empty one when there is none. One that does not read is
    /// refused: a signed document is then taken by nobody until a person fixes it.
    pub fn load(state: &Path) -> Result<Self, String> {
        let path = state.join(RECORD_FILE);
        match fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn save(&self, state: &Path) -> Result<(), String> {
        crate::host::private_dir(state)?;
        let mut bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        crate::host::replace(&state.join(RECORD_FILE), &bytes)
    }

    /// What the report and `status` say of it: the pin (never its key), and the version.
    pub fn view(&self) -> Value {
        serde_json::json!({
            "version": self.version,
            "passkey": self.passkey.as_ref().map(|p| serde_json::json!({
                "credential": p.credential, "alg": webauthn::alg_name(p.alg), "rp_id": p.rp_id,
                "origin": p.origin, "by": p.by, "pinned_at": p.pinned_at,
            })),
        })
    }
}

fn unix_of(t: &str, what: &str) -> Result<i64, String> {
    crate::run::trust::unix_time(t).ok_or_else(|| format!("its {what} is not a time"))
}

/// The document's checks but the signature: its schema, its act, this host, its times
/// (issued at most [`SKEW_S`] ahead of the host's clock, not past its `not_after`, living
/// at most two hours) and the login that signed it.
fn read_doc(bytes: &[u8], act: Act, host: &str, now: i64) -> Result<Doc, String> {
    if bytes.len() > DOC_MAX {
        return Err(format!("the document is over {DOC_MAX} bytes"));
    }
    let doc: Doc =
        serde_json::from_slice(bytes).map_err(|e| format!("the document does not read: {e}"))?;
    if doc.schema != SCHEMA {
        return Err(format!(
            "the document's schema is {:?}, not {SCHEMA}",
            short(&doc.schema)
        ));
    }
    if doc.act != act.name() {
        return Err(format!(
            "the document signs {:?}, not {}",
            short(&doc.act),
            act.name()
        ));
    }
    if doc.host != host {
        return Err(format!(
            "the document is for host {}, not this one ({host})",
            short(&doc.host)
        ));
    }
    let issued = unix_of(&doc.issued_at, "issued_at")?;
    let not_after = unix_of(&doc.not_after, "not_after")?;
    if issued > now + SKEW_S {
        return Err(format!(
            "the document was issued at {}, ahead of this host's clock",
            doc.issued_at
        ));
    }
    if not_after <= now {
        return Err(format!("the document expired at {}", doc.not_after));
    }
    if not_after - issued > LIFE_MAX_S || not_after < issued {
        return Err("the document lives longer than two hours".into());
    }
    if doc.by.is_empty()
        || doc.by.len() > 39
        || !doc
            .by
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("the document names no GitHub login".into());
    }
    Ok(doc)
}

fn short(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(80).collect()
}

/// A signed document checked against the pinned passkey (design v2 D6 b): the credential
/// that answered is the pinned one; its assertion is for the document's SHA-256, on the
/// pinned origin, for the pinned RP id, with the user present and verified, and signed by
/// the pinned key; the document is for this host and this act, not expired, and its version
/// is above the last this host took. Then the authenticator's counter must have moved, when
/// it keeps one. The document and the counter on success; why not otherwise.
pub fn verify_signed(
    rec: &Record,
    doc: &[u8],
    a: &Assertion,
    act: Act,
    host: &str,
    now: i64,
) -> Result<(Doc, u32), String> {
    let Some(p) = &rec.passkey else {
        return Err(format!(
            "no passkey is pinned at this host: its owner pins one, once, at the host (`omarchy-agent envelope pin-passkey`), before the site can {}",
            match act {
                Act::WidenEnvelope => "widen its envelope",
                _ => "set its agent keys",
            }
        ));
    };
    if p.host != host {
        return Err(format!(
            "the passkey pinned here was pinned for host {}, not this one ({host}): pin it again",
            p.host
        ));
    }
    if a.credential != p.credential {
        return Err(format!(
            "signed with another passkey ({}…), not the one pinned at this host ({}…)",
            short(&a.credential).chars().take(12).collect::<String>(),
            p.credential.chars().take(12).collect::<String>()
        ));
    }
    let key = Key::from_cose(&webauthn::unb64(&p.public_key, "the pinned key", 4096)?)?;
    let challenge = challenge_of(doc);
    let counter = webauthn::verify(
        &key,
        a,
        &Expected {
            challenge: &challenge,
            origin: &p.origin,
            rp_id: &p.rp_id,
        },
    )?;
    let d = read_doc(doc, act, host, now)?;
    let Some(v) = d.version else {
        return Err("the document carries no version".into());
    };
    if v <= rec.version {
        return Err(format!(
            "its version {v} is not above the last this host took ({}): a replay, or an older document",
            rec.version
        ));
    }
    if (counter != 0 || p.counter != 0) && counter <= p.counter {
        return Err(format!(
            "the passkey's counter went from {} to {counter}: a copy of the key may be in use",
            p.counter
        ));
    }
    Ok((d, counter))
}

/// The pin the site makes (`POST /hosts/:id/owner/pin`): base64url of this JSON.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PinText {
    doc: String,
    assertion: Assertion,
    public_key: String,
    alg: i64,
}

/// Whether `rp_id` and `origin` can be the pool's relying party: the RP id is the pool's
/// own host or a domain it is under (the dashboard's name, `omarchy-pool.org`, for the
/// API's `pkgs.omarchy-pool.org`), and the origin is that RP id over https. `localhost`
/// (wrangler dev, the tests) on any port, over http too — only for a pool on this machine
/// (`localhost`, `127.0.0.1`, `[::1]`): a host of any other pool never pins a passkey
/// registered on a page served from localhost.
fn relying_party_ok(pool: &str, rp_id: &str, origin: &str) -> bool {
    let rest = pool
        .strip_prefix("https://")
        .or_else(|| pool.strip_prefix("http://"))
        .unwrap_or(pool);
    let host = match rest.strip_prefix('[') {
        // An IPv6 literal keeps its brackets: `[::1]`.
        Some(v6) => v6.split_once(']').map_or("", |(a, _)| &rest[..a.len() + 2]),
        None => rest.split([':', '/']).next().unwrap_or(""),
    };
    if rp_id == "localhost" {
        return matches!(host, "localhost" | "127.0.0.1" | "[::1]")
            && (origin == "http://localhost"
                || origin == "https://localhost"
                || origin
                    .strip_prefix("http://localhost:")
                    .or_else(|| origin.strip_prefix("https://localhost:"))
                    .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())));
    }
    let name_ok = !rp_id.is_empty()
        && rp_id.len() <= 253
        && rp_id.contains('.')
        && rp_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'));
    name_ok
        && (host == rp_id || host.ends_with(&format!(".{rp_id}")))
        && origin == format!("https://{rp_id}")
}

/// `omarchy-agent envelope pin-passkey <pin>` (#328): the owner's passkey pinned at this
/// host, from the pin the site made — checked here ([`check_pin`]) and kept in
/// `state/owner.json`. `host` and `pool` are agent.toml's. What was pinned, for the
/// terminal.
pub fn pin(state: &Path, host: &str, pool: &str, text: &str, now: i64) -> Result<String, String> {
    let pinned = check_pin(host, pool, text, now)?;
    let mut rec = Record::load(state)?;
    let said = format!(
        "pinned {}'s passkey ({}, credential {}…) for {} on {}: from now on this host takes a widening of its envelope and its agent keys from the site only when this passkey signed them{}",
        pinned.by,
        webauthn::alg_name(pinned.alg),
        pinned.credential.chars().take(12).collect::<String>(),
        pinned.rp_id,
        pinned.origin,
        match &rec.passkey {
            Some(old) if old.credential != pinned.credential => format!(
                " (it replaces {}…; what that one signed is refused from now on)",
                old.credential.chars().take(12).collect::<String>()
            ),
            _ => String::new(),
        }
    );
    rec.passkey = Some(pinned);
    rec.save(state)?;
    Ok(said)
}

/// The pin the site made, checked, with nothing written: the passkey's signature with the
/// key the pin carries, over a document naming this host and a relying party of this
/// host's pool, with the user present and verified, not expired. The passkey to pin.
fn check_pin(host: &str, pool: &str, text: &str, now: i64) -> Result<Pinned, String> {
    let raw = webauthn::unb64(text.trim(), "the pin", 64 << 10).map_err(|_| {
        "the pin is not what the site printed (base64url): copy it again".to_owned()
    })?;
    let p: PinText =
        serde_json::from_slice(&raw).map_err(|e| format!("the pin does not read: {e}"))?;
    let key = Key::from_cose(&webauthn::unb64(&p.public_key, "the pin's key", 4096)?)?;
    if key.alg() != p.alg {
        return Err("the pin's key is not of the algorithm it names".into());
    }
    let doc = read_doc(p.doc.as_bytes(), Act::PinPasskey, host, now)?;
    let (Some(rp_id), Some(origin)) = (doc.rp_id.clone(), doc.origin.clone()) else {
        return Err("the pin names no relying party".into());
    };
    if !relying_party_ok(pool, &rp_id, &origin) {
        return Err(format!(
            "the pin is for the relying party {} on {}, which is not this host's pool ({pool})",
            short(&rp_id),
            short(&origin)
        ));
    }
    let counter = webauthn::verify(
        &key,
        &p.assertion,
        &Expected {
            challenge: &challenge_of(p.doc.as_bytes()),
            origin: &origin,
            rp_id: &rp_id,
        },
    )?;
    Ok(Pinned {
        host: host.to_owned(),
        credential: p.assertion.credential,
        alg: key.alg(),
        public_key: p.public_key,
        rp_id,
        origin,
        by: doc.by,
        pinned_at: crate::capacity::utc(u64::try_from(now).unwrap_or(0)),
        counter,
    })
}

/// `omarchy-agent envelope unpin-passkey`: no passkey is pinned from now on, so the site
/// widens nothing and sets no key until the owner pins one again; the version taken stays,
/// so nothing signed before comes back.
pub fn unpin(state: &Path) -> Result<String, String> {
    let mut rec = Record::load(state)?;
    let Some(old) = rec.passkey.take() else {
        return Ok("no passkey was pinned here".into());
    };
    rec.save(state)?;
    Ok(format!(
        "unpinned {}'s passkey ({}…): the site widens nothing and sets no agent key here until a passkey is pinned again",
        old.by,
        old.credential.chars().take(12).collect::<String>()
    ))
}

// ---------- the widening ----------

/// A widening, read and checked: each key with its new value (`None` takes the key out of
/// `[envelope]`: no cap, detection's lanes, the default budget), as TOML.
#[derive(Debug, Clone, PartialEq)]
pub struct Widening(pub Vec<(String, Option<toml::Value>)>);

fn whole(v: &Value, key: &str, min: u64, max: u64) -> Result<toml::Value, String> {
    v.as_u64()
        .filter(|n| (min..=max).contains(n))
        .map(|n| toml::Value::Integer(i64::try_from(n).unwrap_or(i64::MAX)))
        .ok_or_else(|| format!("{key}: a whole number from {min} to {max}"))
}

impl Widening {
    /// The document's `envelope`, each key one of [`WIDENABLE`] with a value of its type
    /// and range; anything else refuses the whole document.
    pub fn read(env: &serde_json::Map<String, Value>) -> Result<Self, String> {
        if env.is_empty() {
            return Err("the widening names no key of the envelope".into());
        }
        let mut out = Vec::new();
        for (k, v) in env {
            if !WIDENABLE.contains(&k.as_str()) {
                return Err(format!(
                    "{:?} is no key a signed widening sets (it sets {}): the rest of the envelope is its owner's, at the host",
                    short(k),
                    WIDENABLE.join(", ")
                ));
            }
            let nullable = matches!(
                k.as_str(),
                "max_units" | "max_cpus" | "max_mem_gb" | "emulate" | "agent_budget"
            );
            if v.is_null() {
                if !nullable {
                    return Err(format!("{k}: null is not a value of it"));
                }
                out.push((k.clone(), None));
                continue;
            }
            let t = match k.as_str() {
                "max_units" | "max_cpus" => whole(v, k, 1, 4096)?,
                "max_mem_gb" => whole(v, k, 1, 65536)?,
                "agent_slots" => whole(v, k, 0, 64)?,
                "diagnostics" => {
                    toml::Value::Boolean(v.as_bool().ok_or("diagnostics: true or false")?)
                }
                "emulate" => {
                    let a = v.as_array().ok_or("emulate: a list of architectures")?;
                    let mut seen: Vec<String> = Vec::new();
                    for x in a {
                        let s = x.as_str().unwrap_or("");
                        if !crate::run::config::ARCHES.contains(&s) || seen.iter().any(|y| y == s) {
                            return Err(format!(
                                "emulate: a list of distinct architectures ({})",
                                crate::run::config::ARCHES.join(", ")
                            ));
                        }
                        seen.push(s.to_owned());
                    }
                    toml::Value::Array(seen.into_iter().map(toml::Value::String).collect())
                }
                "agent_budget" => {
                    let o = v.as_object().ok_or("agent_budget: a table")?;
                    let mut t = toml::Table::new();
                    for (bk, bv) in o {
                        t.insert(
                            bk.clone(),
                            whole(bv, &format!("agent_budget.{bk}"), 1, 1 << 40)?,
                        );
                    }
                    let t = toml::Value::Table(t);
                    crate::dispatcher_env::Budget::from_envelope(Some(&t))?;
                    t
                }
                _ => {
                    // paths
                    let a = v.as_array().ok_or("paths: a list of absolute paths")?;
                    if a.len() > 16 {
                        return Err("paths: at most 16".into());
                    }
                    let mut seen: Vec<String> = Vec::new();
                    for x in a {
                        let s = x.as_str().unwrap_or("");
                        let p = Path::new(s);
                        if s.len() > 4096
                            || !crate::lint::is_plain_absolute(p)
                            || p == Path::new("/")
                            || seen.iter().any(|y| y == s)
                        {
                            return Err(format!(
                                "paths: {:?} is not a plain absolute path below /, given once",
                                short(s)
                            ));
                        }
                        seen.push(s.to_owned());
                    }
                    toml::Value::Array(seen.into_iter().map(toml::Value::String).collect())
                }
            };
            out.push((k.clone(), Some(t)));
        }
        Ok(Widening(out))
    }

    /// agent.toml's text with the widening's keys set in `[envelope]`, and what changed,
    /// key by key (`max_units 3 → 8`). The new text must read as the loop reads agent.toml
    /// (`run::config::Config`), as capacity reads it (every `[envelope]` key known) and as
    /// the lint reads it (no path a link or relative, the secrets directory apart): a value
    /// that would make the agent refuse its own configuration is refused here instead.
    pub fn apply(&self, text: &str) -> Result<(String, Vec<String>), String> {
        let old: toml::Table = toml::from_str(text).map_err(|e| format!("agent.toml: {e}"))?;
        let was = |k: &str| {
            old.get("envelope")
                .and_then(|e| e.get(k))
                .map_or_else(|| "none".to_owned(), ToString::to_string)
        };
        let mut changes = Vec::new();
        for (k, v) in &self.0 {
            let now = v
                .as_ref()
                .map_or_else(|| "none".to_owned(), ToString::to_string);
            let before = was(k);
            if before != now {
                changes.push(format!("{k} {before} → {now}"));
            }
        }
        let lines: Vec<(&str, Option<String>)> = self
            .0
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_ref().map(ToString::to_string)))
            .collect();
        let mut new = crate::run::config::table_lines(text, "envelope", &lines);
        if !self.holds(&new) {
            // A layout the line edit cannot name the values in (`[envelope.agent_budget]`
            // as a table of its own, a dotted key): written again from its table.
            new = self.reserialized(text)?;
        }
        crate::run::config::Config::parse(&new)?;
        crate::capacity::AgentToml::parse(&new)?;
        crate::lint::Envelope::from_agent_toml(&new)?;
        if !self.holds(&new) {
            return Err("agent.toml could not be written with the widening's values".into());
        }
        Ok((new, changes))
    }

    /// Whether `text` reads with every key of the widening at its value.
    fn holds(&self, text: &str) -> bool {
        let Ok(t) = toml::from_str::<toml::Table>(text) else {
            return false;
        };
        let env = t.get("envelope");
        self.0
            .iter()
            .all(|(k, v)| env.and_then(|e| e.get(k)) == v.as_ref())
    }

    fn reserialized(&self, text: &str) -> Result<String, String> {
        let mut t: toml::Table = toml::from_str(text).map_err(|e| format!("agent.toml: {e}"))?;
        let env = t
            .entry("envelope")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut()
            .ok_or("agent.toml: [envelope] is not a table")?;
        for (k, v) in &self.0 {
            match v {
                Some(v) => {
                    env.insert(k.clone(), v.clone());
                }
                None => {
                    env.remove(k);
                }
            }
        }
        let body = toml::to_string(&t).map_err(|e| format!("agent.toml: {e}"))?;
        let head =
            text.lines()
                .take_while(|l| l.starts_with('#'))
                .fold(String::new(), |mut h, l| {
                    h.push_str(l);
                    h.push('\n');
                    h
                });
        Ok(format!("{head}{body}"))
    }
}

/// The envelope's keys a signed widening may set, as agent.toml says them now: what the
/// site's form starts from (the report's `owner.envelope`).
pub fn envelope_view(agent_toml: &str) -> Value {
    let Ok(t) = toml::from_str::<toml::Table>(agent_toml) else {
        return Value::Null;
    };
    let env = t.get("envelope");
    let mut out = serde_json::Map::new();
    for k in WIDENABLE {
        let v = env
            .and_then(|e| e.get(k))
            .and_then(|v| serde_json::to_value(v).ok())
            .unwrap_or(Value::Null);
        out.insert(k.to_owned(), v);
    }
    Value::Object(out)
}

// ---------- the agent keys ----------

/// The keys a signed document sets, opened, and the ones it takes out: checked whole
/// before anything is written. Every name is one of [`AGENT_KEYS`], once.
pub fn open_keys(
    seal: &seal::SealKey,
    host: &str,
    doc: &Doc,
) -> Result<Vec<(String, Option<String>)>, String> {
    let sealed_to = doc.seal_key.as_deref().unwrap_or("");
    if sealed_to != seal.public_b64u() {
        return Err(format!(
            "the keys were sealed to another seal key ({}), not this host's ({}): its owner confirms this host's on the site, then seals them again",
            short(sealed_to).chars().take(16).collect::<String>(),
            seal.fingerprint()
        ));
    }
    let keys = doc.keys.as_deref().unwrap_or_default();
    if keys.is_empty() || keys.len() > AGENT_KEYS.len() {
        return Err(format!(
            "the document sets {} keys: one to {}",
            keys.len(),
            AGENT_KEYS.len()
        ));
    }
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    for k in keys {
        if !AGENT_KEYS.contains(&k.name.as_str()) {
            return Err(format!(
                "{:?} is no agent key: a signed document sets {}",
                short(&k.name),
                AGENT_KEYS.join(", ")
            ));
        }
        if out.iter().any(|(n, _)| *n == k.name) {
            return Err(format!("{} is named twice", k.name));
        }
        let value = if k.remove {
            if k.epk.is_some() || k.nonce.is_some() || k.ct.is_some() {
                return Err(format!("{}: taken out and sealed at once", k.name));
            }
            None
        } else {
            Some(seal.open(host, k)?)
        };
        out.push((k.name.clone(), value));
    }
    Ok(out)
}

/// `agent.env` with `keys` set (`Some`) or taken out (`None`), every other line — the
/// owner's comments, the keys a document does not name — as it was; a key it sets that the
/// file lacks goes at its end. The file must read as install reads it (`KEY=value` lines),
/// or nothing is written.
pub fn merge_agent_env(text: &str, keys: &[(String, Option<String>)]) -> Result<String, String> {
    crate::install::secrets::parse(text).map_err(|e| {
        format!("agent.env does not read ({e}): fix it at the host, then sign the keys again")
    })?;
    let mut out = String::new();
    let mut seen: Vec<&str> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let name = t
            .split_once('=')
            .map(|(k, _)| k.trim().strip_prefix("export ").unwrap_or(k.trim()).trim());
        match name.and_then(|n| keys.iter().find(|(k, _)| k == n)) {
            Some((k, v)) if !t.starts_with('#') => {
                seen.push(k);
                if let Some(v) = v {
                    let _ = writeln!(out, "{k}={v}");
                }
            }
            _ => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if text.is_empty() {
        out.push_str(
            "# The agent keys (#328: set from the site, sealed to this host): the agent sidecars' only, read-only.\n",
        );
    }
    for (k, v) in keys {
        if let (false, Some(v)) = (seen.contains(&k.as_str()), v) {
            let _ = writeln!(out, "{k}={v}");
        }
    }
    Ok(out)
}

/// The names of the keys `agent.env` holds (never a value): what the site shows.
pub fn agent_key_names(text: &str) -> Vec<String> {
    crate::install::secrets::parse(text)
        .map(|keys| keys.into_iter().map(|(k, _)| k).collect())
        .unwrap_or_default()
}

/// For the fuzz target: everything here that reads bytes from the network or the owner.
#[cfg(feature = "fuzzing")]
pub fn fuzz(data: &[u8]) {
    let _ = Key::from_cose(data);
    let _ = read_doc(data, Act::WidenEnvelope, "h_0123456789", 1_800_000_000);
    if let Ok(text) = std::str::from_utf8(data) {
        // The check alone: the fuzz target writes no file, and keeps no state between inputs.
        let _ = check_pin(
            "h_0123456789",
            "https://pkgs.omarchy-pool.org",
            text,
            1_800_000_000,
        );
        if let Ok(v) = serde_json::from_str::<serde_json::Map<String, Value>>(text) {
            if let Ok(w) = Widening::read(&v) {
                let _ = w.apply("[envelope]\nmax_units = 2\n");
            }
        }
        let _ = merge_agent_env(text, &[("GITHUB_TOKEN".into(), Some("x".into()))]);
    }
    if let Ok(a) = serde_json::from_slice::<Assertion>(data) {
        let key = Key::Ed25519([0; 32]);
        let _ = webauthn::verify(
            &key,
            &a,
            &Expected {
                challenge: "x",
                origin: "https://x",
                rp_id: "x",
            },
        );
    }
}

#[cfg(test)]
pub(crate) mod tests;
