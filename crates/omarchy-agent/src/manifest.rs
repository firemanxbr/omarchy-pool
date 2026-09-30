//! The host bundle's `manifest.json` (design v2 §4.4): a frozen outer layer read leniently,
//! and a strict, versioned `inner`.
//!
//! The outer layer (`schema`, `release`, `created`, `min_agent`, `agent`) is all an agent
//! needs to update itself, so every agent must be able to read it: fields may be added but
//! never renamed or retyped, and unknown ones are ignored. `inner` is parsed with
//! `deny_unknown_fields` everywhere. An `inner.schema` newer than this agent knows, or a
//! `min_agent` above its own version, yields [`Parsed::NeedsNewerAgent`], never a refusal
//! of the outer layer: the bundle that could update the agent stays readable.
//!
//! Nothing here is public to build: [`Manifest`], [`Outer`], [`Capacity`], [`PinnedImage`]
//! and [`PinnedTool`] come only out of [`crate::verify`], after the signature was checked.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::version::{self, Version};

/// The outer layer this agent reads. Frozen: an agent never sees another value.
pub const OUTER_SCHEMA: u64 = 2;
/// The `inner` layout this agent reads.
pub const INNER_SCHEMA: u64 = 3;

/// Why a manifest was refused (after its signature verified).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError(pub String);

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn err<T>(msg: impl Into<String>) -> Result<T, ManifestError> {
    Err(ManifestError(msg.into()))
}

/// The result of reading a verified manifest.
#[derive(Debug)]
pub enum Parsed {
    /// This agent knows the whole manifest.
    Current(Box<Manifest>),
    /// Update the agent first; only the outer layer was read.
    NeedsNewerAgent { outer: Outer, why: String },
}

// ---------------------------------------------------------------------------------------
// Outer layer: lenient.

#[derive(Deserialize)]
struct OuterRaw {
    schema: u64,
    release: String,
    created: String,
    min_agent: String,
    agent: AgentRaw,
}

#[derive(Deserialize)]
struct AgentRaw {
    version: String,
    #[serde(default)]
    urgent: bool,
    #[serde(rename = "x86_64-linux")]
    x86_64_linux: Option<AgentAssetRaw>,
    #[serde(rename = "aarch64-linux")]
    aarch64_linux: Option<AgentAssetRaw>,
    #[serde(rename = "aarch64-darwin")]
    aarch64_darwin: Option<AgentAssetRaw>,
}

#[derive(Deserialize)]
struct AgentAssetRaw {
    sha256: String,
    asset: String,
}

/// The outer layer of a verified manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outer {
    release: Version,
    created: String,
    min_agent: Version,
    agent: AgentRelease,
}

impl Outer {
    pub fn release(&self) -> Version {
        self.release
    }
    /// The signed creation time, as written (RFC 3339, UTC).
    pub fn created(&self) -> &str {
        &self.created
    }
    pub fn min_agent(&self) -> Version {
        self.min_agent
    }
    pub fn agent(&self) -> &AgentRelease {
        &self.agent
    }
}

/// The agent a release ships (for self-update, P1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRelease {
    version: Version,
    urgent: bool,
    assets: BTreeMap<&'static str, AgentAsset>,
}

impl AgentRelease {
    pub fn version(&self) -> Version {
        self.version
    }
    pub fn urgent(&self) -> bool {
        self.urgent
    }
    /// The binary for `platform` (`x86_64-linux`, `aarch64-linux`, `aarch64-darwin`).
    pub fn asset(&self, platform: &str) -> Option<&AgentAsset> {
        self.assets.get(platform)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAsset {
    sha256: Digest,
    asset: String,
}

impl AgentAsset {
    pub fn sha256(&self) -> &Digest {
        &self.sha256
    }
    /// The release asset's file name.
    pub fn name(&self) -> &str {
        &self.asset
    }
}

fn outer(value: &serde_json::Value) -> Result<Outer, ManifestError> {
    let raw = OuterRaw::deserialize(value).or_else(|e| err(format!("outer layer: {e}")))?;
    if raw.schema != OUTER_SCHEMA {
        return err(format!(
            "outer schema {} (the outer layer is frozen at {OUTER_SCHEMA})",
            raw.schema
        ));
    }
    let release = Version::parse_release(&raw.release)
        .ok_or_else(|| ManifestError(format!("release {:?} is not vX.Y.Z", raw.release)))?;
    let min_agent = Version::parse(&raw.min_agent)
        .ok_or_else(|| ManifestError(format!("min_agent {:?} is not X.Y.Z", raw.min_agent)))?;
    let version = Version::parse(&raw.agent.version).ok_or_else(|| {
        ManifestError(format!(
            "agent.version {:?} is not X.Y.Z",
            raw.agent.version
        ))
    })?;
    if !is_timestamp(&raw.created) {
        return err(format!(
            "created {:?} is not an RFC 3339 UTC time",
            raw.created
        ));
    }
    let mut assets = BTreeMap::new();
    for (platform, a) in [
        ("x86_64-linux", raw.agent.x86_64_linux),
        ("aarch64-linux", raw.agent.aarch64_linux),
        ("aarch64-darwin", raw.agent.aarch64_darwin),
    ] {
        if let Some(a) = a {
            if !is_file_name(&a.asset) {
                return err(format!(
                    "agent.{platform}.asset {:?} is not a file name",
                    a.asset
                ));
            }
            let sha256 = Digest::from_hex(&a.sha256).ok_or_else(|| {
                ManifestError(format!("agent.{platform}.sha256 is not 64 hex digits"))
            })?;
            assets.insert(
                platform,
                AgentAsset {
                    sha256,
                    asset: a.asset,
                },
            );
        }
    }
    let agent = AgentRelease {
        version,
        urgent: raw.agent.urgent,
        assets,
    };
    Ok(Outer {
        release,
        created: raw.created,
        min_agent,
        agent,
    })
}

// ---------------------------------------------------------------------------------------
// Inner layer, schema 3: strict.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InnerRaw {
    schema: u64,
    min_release: String,
    revoked: Vec<String>,
    pools: Vec<String>,
    images: ImagesRaw,
    capacity: CapacityConstants,
    tools: BTreeMap<String, BTreeMap<String, ToolRaw>>,
    #[allow(dead_code)] // read only to refuse anything but `{}`
    runtimes: NoRuntimes,
    sets: BTreeMap<String, SetRaw>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImagesRaw {
    worker: WorkerRaw,
    build: ArchPair<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerRaw {
    repo: String,
    index: String,
    platforms: ArchPair<PlatformRaw>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchPair<T> {
    aarch64: T,
    x86_64: T,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlatformRaw {
    manifest: String,
    config: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolRaw {
    url: String,
    sha256: String,
}

/// Schema 3 defines no runtime yet: `runtimes` must be `{}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoRuntimes {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetRaw {
    files: BTreeMap<String, String>,
}

/// The whole manifest of a verified bundle this agent knows.
#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    outer: Outer,
    min_release: Version,
    revoked: Vec<Version>,
    pools: Vec<String>,
    worker: WorkerImage,
    build_aarch64: PinnedImage,
    build_x86_64: PinnedImage,
    capacity: Capacity,
    tools: BTreeMap<String, BTreeMap<String, PinnedTool>>,
    sets: BTreeMap<String, BTreeMap<String, Digest>>,
}

impl Manifest {
    pub fn outer(&self) -> &Outer {
        &self.outer
    }
    pub fn min_release(&self) -> Version {
        self.min_release
    }
    pub fn revoked(&self) -> &[Version] {
        &self.revoked
    }
    /// Pool origins a host may talk to (M1).
    pub fn pools(&self) -> &[String] {
        &self.pools
    }
    pub fn worker_image(&self) -> &WorkerImage {
        &self.worker
    }
    /// The task build image for `arch` (`aarch64` or `x86_64`).
    pub fn build_image(&self, arch: &str) -> Option<&PinnedImage> {
        match arch {
            "aarch64" => Some(&self.build_aarch64),
            "x86_64" => Some(&self.build_x86_64),
            _ => None,
        }
    }
    pub fn capacity(&self) -> &Capacity {
        &self.capacity
    }
    /// A pinned tool (`docker`, `docker-compose`, ...) for a platform (`aarch64-linux`, ...).
    pub fn tool(&self, platform: &str, name: &str) -> Option<&PinnedTool> {
        self.tools.get(platform)?.get(name)
    }
    /// The files of a set, by path inside the set, with their SHA-256.
    pub fn set_files(&self, set: &str) -> Option<&BTreeMap<String, Digest>> {
        self.sets.get(set)
    }
    pub(crate) fn set_files_all(&self) -> &BTreeMap<String, BTreeMap<String, Digest>> {
        &self.sets
    }
}

/// A SHA-256 digest.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Digest([u8; 32]);

impl Digest {
    /// 64 lowercase hex digits.
    fn from_hex(s: &str) -> Option<Self> {
        if s.len() != 64 || !s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return None;
        }
        let mut out = [0u8; 32];
        hex::decode_to_slice(s, &mut out).ok()?;
        Some(Digest(out))
    }
    /// `sha256:` and 64 lowercase hex digits.
    fn from_prefixed(s: &str) -> Option<Self> {
        Self::from_hex(s.strip_prefix("sha256:")?)
    }
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "sha256:{}", hex::encode(self.0))
    }
}

impl fmt::Debug for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

/// An image named by digest only, as a verified manifest lists it (M3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedImage {
    repo: String,
    digest: Digest,
}

impl PinnedImage {
    fn parse(s: &str) -> Option<Self> {
        let (repo, digest) = s.split_once('@')?;
        is_repo(repo).then_some(())?;
        Some(PinnedImage {
            repo: repo.to_owned(),
            digest: Digest::from_prefixed(digest)?,
        })
    }
    pub fn repo(&self) -> &str {
        &self.repo
    }
    pub fn digest(&self) -> &Digest {
        &self.digest
    }
}

impl fmt::Display for PinnedImage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}@{}", self.repo, self.digest)
    }
}

/// The worker image: its multi-platform index, and each platform's manifest and config
/// digest (the agent compares by config digest, the image id on the classic store).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerImage {
    index: PinnedImage,
    aarch64: PlatformImage,
    x86_64: PlatformImage,
}

impl WorkerImage {
    pub fn index(&self) -> &PinnedImage {
        &self.index
    }
    pub fn platform(&self, arch: &str) -> Option<&PlatformImage> {
        match arch {
            "aarch64" => Some(&self.aarch64),
            "x86_64" => Some(&self.x86_64),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformImage {
    manifest: Digest,
    config: Digest,
}

impl PlatformImage {
    pub fn manifest(&self) -> &Digest {
        &self.manifest
    }
    pub fn config(&self) -> &Digest {
        &self.config
    }
}

/// A tool binary to fetch over HTTPS and check by SHA-256 (M2, D21).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedTool {
    url: String,
    sha256: Digest,
}

impl PinnedTool {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn sha256(&self) -> &Digest {
        &self.sha256
    }
}

// ---------------------------------------------------------------------------------------
// Capacity constants (design v2 §4.4, §7.3).

/// The signed capacity block, field for field. Every level refuses a missing or unknown
/// field. Later code takes [`Capacity`], which only a verified manifest yields.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapacityConstants {
    pub min: MinHost,
    pub reserve: Resources,
    pub unit: Resources,
    pub units: Units,
    pub disk: Disk,
    pub sidecars: Sidecars,
    pub emulated: Emulated,
    pub max_size: u32,
    pub community_max_size: u32,
}

/// The minimum a host must have to join (D30).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MinHost {
    pub cpus: u32,
    pub mem_gb: u32,
    pub work_disk_gb: u32,
    pub engine_disk_gb: u32,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Resources {
    pub cpus: u32,
    pub mem_gb: u32,
}

/// Units per task kind.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Units {
    pub build_per_size: u32,
    pub trial: u32,
    pub audit: u32,
    pub job: u32,
    pub job_reserved: u32,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Disk {
    pub build_gb_per_size: u32,
    pub floor_gb: u32,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sidecars {
    pub egress: Sidecar,
    pub agent: Sidecar,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sidecar {
    pub cpus: f64,
    pub mem_mb: u32,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Emulated {
    pub share_when_native_waits: f64,
}

/// Verified capacity constants: they bound every host's parallelism, so they come only
/// from a signed manifest and only once they make sense (no zero-sized unit or task, which
/// would make parallelism unbounded).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Capacity(CapacityConstants);

/// No constant is anywhere near this; it keeps every product far from overflow.
const CAP: u32 = 1 << 16;

impl Capacity {
    fn validate(c: CapacityConstants) -> Result<Self, ManifestError> {
        let whole = [
            ("min.cpus", c.min.cpus, 1),
            ("min.mem_gb", c.min.mem_gb, 1),
            ("min.work_disk_gb", c.min.work_disk_gb, 1),
            ("min.engine_disk_gb", c.min.engine_disk_gb, 1),
            ("reserve.cpus", c.reserve.cpus, 0),
            ("reserve.mem_gb", c.reserve.mem_gb, 0),
            ("unit.cpus", c.unit.cpus, 1),
            ("unit.mem_gb", c.unit.mem_gb, 1),
            ("units.build_per_size", c.units.build_per_size, 1),
            ("units.trial", c.units.trial, 1),
            ("units.audit", c.units.audit, 1),
            ("units.job", c.units.job, 1),
            ("units.job_reserved", c.units.job_reserved, 0),
            ("disk.build_gb_per_size", c.disk.build_gb_per_size, 1),
            ("disk.floor_gb", c.disk.floor_gb, 0),
            ("sidecars.egress.mem_mb", c.sidecars.egress.mem_mb, 1),
            ("sidecars.agent.mem_mb", c.sidecars.agent.mem_mb, 1),
            ("max_size", c.max_size, 1),
            ("community_max_size", c.community_max_size, 1),
        ];
        for (name, v, least) in whole {
            if v < least || v > CAP {
                return err(format!("capacity.{name} = {v} is outside {least}..={CAP}"));
            }
        }
        if c.community_max_size > c.max_size {
            return err("capacity.community_max_size is above max_size");
        }
        for (name, s) in [("egress", &c.sidecars.egress), ("agent", &c.sidecars.agent)] {
            if !(s.cpus.is_finite() && s.cpus > 0.0 && s.cpus < f64::from(c.unit.cpus)) {
                return err(format!(
                    "capacity.sidecars.{name}.cpus must be above 0 and below unit.cpus"
                ));
            }
            if s.mem_mb >= c.unit.mem_gb.saturating_mul(1024) {
                return err(format!(
                    "capacity.sidecars.{name}.mem_mb must be below unit.mem_gb"
                ));
            }
        }
        let share = c.emulated.share_when_native_waits;
        if !(share.is_finite() && (0.0..=1.0).contains(&share)) {
            return err("capacity.emulated.share_when_native_waits must be within 0..=1");
        }
        Ok(Capacity(c))
    }

    pub fn constants(&self) -> &CapacityConstants {
        &self.0
    }
}

fn digest(what: &str, s: &str) -> Result<Digest, ManifestError> {
    Digest::from_prefixed(s).ok_or_else(|| ManifestError(format!("{what} is not sha256:<64 hex>")))
}

fn worker_image(w: WorkerRaw) -> Result<WorkerImage, ManifestError> {
    if !is_repo(&w.repo) {
        return err(format!(
            "inner.images.worker.repo {:?} is not a repository",
            w.repo
        ));
    }
    let platform = |arch: &str, p: &PlatformRaw| -> Result<PlatformImage, ManifestError> {
        let at = format!("inner.images.worker.platforms.{arch}");
        Ok(PlatformImage {
            manifest: digest(&format!("{at}.manifest"), &p.manifest)?,
            config: digest(&format!("{at}.config"), &p.config)?,
        })
    };
    Ok(WorkerImage {
        index: PinnedImage {
            digest: digest("inner.images.worker.index", &w.index)?,
            repo: w.repo,
        },
        aarch64: platform("aarch64", &w.platforms.aarch64)?,
        x86_64: platform("x86_64", &w.platforms.x86_64)?,
    })
}

fn build_image(arch: &str, s: &str) -> Result<PinnedImage, ManifestError> {
    PinnedImage::parse(s).ok_or_else(|| {
        ManifestError(format!(
            "inner.images.build.{arch} {s:?} is not <repo>@sha256:<64 hex>"
        ))
    })
}

type Tools = BTreeMap<String, BTreeMap<String, PinnedTool>>;

fn tools(raw: BTreeMap<String, BTreeMap<String, ToolRaw>>) -> Result<Tools, ManifestError> {
    let mut tools = BTreeMap::new();
    for (platform, named) in raw {
        if !matches!(
            platform.as_str(),
            "x86_64-linux" | "aarch64-linux" | "aarch64-darwin"
        ) {
            return err(format!("inner.tools: unknown platform {platform:?}"));
        }
        let mut out = BTreeMap::new();
        for (name, t) in named {
            let at = format!("inner.tools.{platform}.{name}");
            if !is_ident(&name) {
                return err(format!("{at}: not a tool name"));
            }
            if !is_https_url(&t.url) {
                return err(format!("{at}.url is not an https:// URL"));
            }
            let sha256 = Digest::from_hex(&t.sha256)
                .ok_or_else(|| ManifestError(format!("{at}.sha256 is not 64 hex digits")))?;
            out.insert(name, PinnedTool { url: t.url, sha256 });
        }
        tools.insert(platform, out);
    }
    Ok(tools)
}

type Sets = BTreeMap<String, BTreeMap<String, Digest>>;

fn sets(raw: BTreeMap<String, SetRaw>) -> Result<Sets, ManifestError> {
    let mut sets = BTreeMap::new();
    for (name, set) in raw {
        if !is_ident(&name) {
            return err(format!("inner.sets: {name:?} is not a set name"));
        }
        let mut files = BTreeMap::new();
        for (path, d) in set.files {
            if !is_relative_path(&path) {
                return err(format!(
                    "inner.sets.{name}: {path:?} is not a relative path inside the set"
                ));
            }
            files.insert(path, digest(&format!("inner.sets.{name}.files"), &d)?);
        }
        sets.insert(name, files);
    }
    Ok(sets)
}

fn inner(value: serde_json::Value, outer: Outer) -> Result<Manifest, ManifestError> {
    let raw = InnerRaw::deserialize(value).or_else(|e| err(format!("inner: {e}")))?;
    debug_assert_eq!(raw.schema, INNER_SCHEMA);
    let release = |what: &str, s: &str| {
        Version::parse_release(s)
            .ok_or_else(|| ManifestError(format!("{what} {s:?} is not vX.Y.Z")))
    };
    let min_release = release("inner.min_release", &raw.min_release)?;
    let revoked = raw
        .revoked
        .iter()
        .map(|r| release("inner.revoked", r))
        .collect::<Result<_, _>>()?;
    if raw.pools.is_empty() {
        return err("inner.pools is empty");
    }
    if let Some(p) = raw.pools.iter().find(|p| !is_https_origin(p)) {
        return err(format!("inner.pools: {p:?} is not an https:// origin"));
    }
    Ok(Manifest {
        outer,
        min_release,
        revoked,
        pools: raw.pools,
        worker: worker_image(raw.images.worker)?,
        build_aarch64: build_image("aarch64", &raw.images.build.aarch64)?,
        build_x86_64: build_image("x86_64", &raw.images.build.x86_64)?,
        capacity: Capacity::validate(raw.capacity)?,
        tools: tools(raw.tools)?,
        sets: sets(raw.sets)?,
    })
}

/// Reads a verified manifest: the outer layer first, then — only when this agent knows
/// it — `inner`. Called by [`crate::verify`] only, on signed bytes.
pub(crate) fn parse(bytes: &[u8]) -> Result<Parsed, ManifestError> {
    let mut value: serde_json::Value =
        serde_json::from_slice(bytes).or_else(|e| err(format!("manifest.json: {e}")))?;
    let outer = outer(&value)?;
    let agent = version::agent();
    if outer.min_agent > agent {
        let why = format!(
            "min_agent {} is above this agent's {agent}",
            outer.min_agent
        );
        return Ok(Parsed::NeedsNewerAgent { outer, why });
    }
    let Some(inner_value) = value.get_mut("inner").map(serde_json::Value::take) else {
        return err("manifest.json has no inner");
    };
    let Some(schema) = inner_value
        .get("schema")
        .and_then(serde_json::Value::as_u64)
    else {
        return err("inner.schema is missing or not a number");
    };
    if schema > INNER_SCHEMA {
        let why = format!("inner.schema {schema} is newer than this agent reads ({INNER_SCHEMA})");
        return Ok(Parsed::NeedsNewerAgent { outer, why });
    }
    if schema < INNER_SCHEMA {
        return err(format!(
            "inner.schema {schema} is older than this agent reads ({INNER_SCHEMA})"
        ));
    }
    Ok(Parsed::Current(Box::new(inner(inner_value, outer)?)))
}

// ---------------------------------------------------------------------------------------
// Small validators, shared with the bundle archive.

/// `YYYY-MM-DDTHH:MM:SSZ`, optionally with fractional seconds.
pub(crate) fn is_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|d| d.iter().all(u8::is_ascii_digit));
    let shape = b.len() >= 20
        && digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19);
    if !shape || b[b.len() - 1] != b'Z' {
        return false;
    }
    let rest = &b[19..b.len() - 1];
    rest.is_empty()
        || (rest.len() >= 2 && rest[0] == b'.' && rest[1..].iter().all(u8::is_ascii_digit))
}

fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn is_file_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// A registry repository without tag or digest: `host/path/name`, lowercase.
fn is_repo(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.split('/').all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'_')
                })
        })
}

fn is_https_origin(s: &str) -> bool {
    s.strip_prefix("https://").is_some_and(|host| {
        !host.is_empty()
            && host.len() <= 253
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
    })
}

fn is_https_url(s: &str) -> bool {
    s.len() <= 2048
        && s.strip_prefix("https://").is_some_and(|rest| {
            let host = rest.split('/').next().unwrap_or("");
            is_https_origin(&format!("https://{host}"))
                && rest.bytes().all(|b| b.is_ascii_graphic())
        })
}

/// A relative path of plain components: no `/` at either end, no `.`, `..` or empty part.
pub(crate) fn is_relative_path(s: &str) -> bool {
    !s.is_empty() && s.len() <= 255 && s.split('/').all(is_file_name)
}

#[cfg(test)]
mod tests;
