//! Client for the edge index: the public reads, anonymous, and — for the MCP
//! write tools (#252) — the calls that carry an agent's token, which only the
//! caller that holds a credential for this origin makes.

use anyhow::{bail, Context, Result};
use pkg_manifest::PackageManifest;
use serde::Deserialize;

pub struct Api {
    base: String,
    http: reqwest::blocking::Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub id: u64,
    pub seq: u64,
    pub note: Option<String>,
    pub created_at: String,
}

/// A manifest as the index returns it. The index adds provenance fields
/// (`source`, `repo_arch`) that the strict manifest type does not know; they
/// are absorbed here so the manifest itself stays exact.
#[derive(Debug, Clone, Deserialize)]
pub struct IndexedManifest {
    /// The upstream repository that built it (core, extra, packages — the
    /// OPR —, asahi, …): the directory its object is in on the pool.
    #[serde(default)]
    pub source: Option<String>,
    /// Architecture of the upstream repository the package came from.
    #[serde(default)]
    pub repo_arch: Option<String>,
    #[serde(flatten)]
    pub manifest: PackageManifest,
}

/// One build per name. A ring holds every source's build of a name (one
/// row per source), and a machine takes the first in the pool's order —
/// the order of the include's sections, what pacman takes from the first
/// repository that has the name. A source the order does not know comes
/// after the ones it does; ties go by source name, so the choice is stable.
pub fn one_per_name(packages: Vec<IndexedManifest>, order: &[String]) -> Vec<IndexedManifest> {
    let rank = |s: Option<&str>| {
        order
            .iter()
            .position(|o| Some(o.as_str()) == s)
            .unwrap_or(order.len())
    };
    let mut best: std::collections::BTreeMap<String, IndexedManifest> =
        std::collections::BTreeMap::new();
    for p in packages {
        let wins = best.get(&p.manifest.name).is_none_or(|cur| {
            (rank(p.source.as_deref()), p.source.as_deref())
                < (rank(cur.source.as_deref()), cur.source.as_deref())
        });
        if wins {
            best.insert(p.manifest.name.clone(), p);
        }
    }
    best.into_values().collect()
}

#[derive(Debug, Deserialize)]
pub struct ReleaseView {
    pub release: Release,
    pub packages: Vec<IndexedManifest>,
    /// The pool's order between sources (`one_per_name`).
    #[serde(default)]
    pub source_order: Vec<String>,
    /// The page this view came from: `next` names the last row when there
    /// is more (`after=`, keyset paging), null on the last page.
    #[serde(default)]
    pub page: Option<Page>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Page {
    pub next: Option<String>,
}

/// One row of `?fields=summary`: what status / list / search need.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct PackageSummary {
    pub name: String,
    pub version: String,
    pub arch: String,
    pub filename: String,
    pub sha256: String,
    pub size_download: u64,
    pub size_installed: u64,
    pub description: Option<String>,
    #[serde(default)]
    pub repo_arch: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseSummaryView {
    pub release: Release,
    pub package_count: u64,
    pub packages: Vec<PackageSummary>,
}

#[derive(Debug, Deserialize)]
pub struct Graph {
    pub release_id: u64,
    pub packages: Vec<IndexedManifest>,
    #[serde(default)]
    pub source_order: Vec<String>,
    pub missing_targets: Vec<String>,
    pub truncated: bool,
}

/// A call the pool refused, in its own words: the status, the machine-readable
/// code when it gives one (`conflict_of_interest`, `rate_limited`, …) and the
/// sentence. The MCP tools hand it to the agent as it is.
#[derive(Debug, Clone)]
pub struct Refused {
    pub status: u16,
    pub code: Option<String>,
    pub error: String,
    pub retry_after: Option<String>,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HTTP {}", self.status)?;
        if let Some(c) = &self.code {
            write!(f, " ({c})")?;
        }
        write!(f, ": {}", self.error)?;
        if let Some(r) = &self.retry_after {
            write!(f, " — retry after {r} s")?;
        }
        Ok(())
    }
}

impl std::error::Error for Refused {}

/// An agent's token on a call, and the name its MCP client gave (sent as `x-omarchy-client`).
pub struct Auth<'a> {
    pub token: &'a str,
    pub client: Option<&'a str>,
}

impl Api {
    /// The base URL every call goes to (the config's `api`, or `--api`).
    pub fn base(&self) -> &str {
        &self.base
    }

    /// A JSON call to the pool at `path` under its root (`/api/v1/…`, `/auth/…`):
    /// the answer on 2xx, else the pool's refusal ([`Refused`]). The token is
    /// sent only when `auth` is given — the writes and the caller's own reads;
    /// a public read goes anonymous.
    pub fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
        auth: Option<&Auth<'_>>,
    ) -> Result<serde_json::Value> {
        let url = format!("{}{path}", self.base);
        let m = reqwest::Method::from_bytes(method.as_bytes())?;
        let mut req = self.http.request(m, &url);
        if let Some(a) = auth {
            req = req.bearer_auth(a.token);
            if let Some(c) = a.client {
                req = req.header("x-omarchy-client", c);
            }
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().with_context(|| format!("{method} {url}"))?;
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let text = resp.text().unwrap_or_default();
        let value: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            return Err(Refused {
                status: status.as_u16(),
                code: value
                    .get("code")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                error: value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map_or_else(|| text.trim().chars().take(300).collect(), str::to_owned),
                retry_after,
            }
            .into());
        }
        Ok(value)
    }

    /// Public text at `path` (a build's evidence): None when it is not there.
    pub fn text(&self, path: &str) -> Result<Option<String>> {
        let url = format!("{}{path}", self.base);
        let resp = self
            .http
            .get(&url)
            .send()
            .with_context(|| format!("GET {url}"))?;
        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            bail!(
                "{url}: {} {}",
                resp.status(),
                resp.text().unwrap_or_default()
            );
        }
        Ok(Some(resp.text()?))
    }

    pub fn new(base: &str) -> Result<Self> {
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            http: reqwest::blocking::Client::builder()
                .user_agent(concat!("omarchy-cli/", env!("CARGO_PKG_VERSION")))
                .build()?,
        })
    }

    fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = format!("{}/api/v1{path}", self.base);
        let resp = self
            .http
            .get(&url)
            .send()
            .with_context(|| format!("GET {url}"))?;
        if !resp.status().is_success() {
            bail!(
                "{url}: {} {}",
                resp.status(),
                resp.text().unwrap_or_default()
            );
        }
        resp.json().with_context(|| format!("decoding {url}"))
    }

    /// Full manifests (without file lists) — needed for the safety check.
    /// Full manifests of one architecture, paged (500 per request) and pinned
    /// to the release the first page returned.
    pub fn release(&self, ring: &str, arch: &str) -> Result<ReleaseView> {
        let mut view: Option<ReleaseView> = None;
        // Keyset paging: each page names the row the next one starts after
        // (page.next) — a walk of the index, not a sort-and-skip per page.
        let mut after: Option<String> = None;
        loop {
            let pin = view
                .as_ref()
                .map(|v| format!("&release_id={}", v.release.id))
                .unwrap_or_default();
            let cursor = after
                .as_ref()
                .map(|a| format!("&after={}", urlencode(a)))
                .unwrap_or_default();
            let page: ReleaseView = self.get(&format!(
                "/releases/{ring}?arch={arch}&limit=500{cursor}{pin}"
            ))?;
            let next = page.page.as_ref().and_then(|p| p.next.clone());
            match &mut view {
                None => view = Some(page),
                Some(v) => v.packages.extend(page.packages),
            }
            match next {
                Some(n) => after = Some(n),
                None => break,
            }
        }
        view.ok_or_else(|| anyhow::anyhow!("no page returned for {ring}"))
    }

    /// Light listing for status / list / search.
    /// The seal of an object: where it came from and the proof
    /// (`GET /packages/:sha256/provenance`, routes/seal.ts).
    pub fn provenance(&self, sha256: &str) -> Result<serde_json::Value> {
        self.get(&format!("/packages/{sha256}/provenance"))
    }

    pub fn release_summary(&self, ring: &str) -> Result<ReleaseSummaryView> {
        self.get(&format!("/releases/{ring}?fields=summary"))
    }

    /// Packages the ring serves with an open advisory, for one architecture.
    pub fn security(&self, ring: &str, arch: &str) -> Result<SecurityView> {
        self.get(&format!("/security?ring={ring}&arch={arch}"))
    }

    /// The files one package of the ring ships (for the hook preview).
    pub fn files(&self, ring: &str, arch: &str, name: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Files {
            files: Vec<String>,
        }
        Ok(self
            .get::<Files>(&format!("/package/{name}/files?ring={ring}&arch={arch}"))?
            .files)
    }

    pub fn graph(&self, ring: &str, arch: &str, targets: &[String]) -> Result<Graph> {
        self.get(&format!(
            "/graph?ring={ring}&arch={arch}&targets={}",
            targets.join(",")
        ))
    }
}

/// One package with an open advisory (`GET /api/v1/security`).
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct VulnerablePackage {
    pub name: String,
    pub version: String,
    pub worst: String,
    pub kev: bool,
    #[serde(default)]
    pub epss: Option<f64>,
    pub advisories: Vec<AdvisoryRef>,
    #[serde(default)]
    pub fixed_in: Vec<FixedIn>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct AdvisoryRef {
    pub id: String,
    pub tracker: String,
    pub cves: Vec<String>,
    pub severity: String,
    #[serde(rename = "match")]
    pub confidence: String,
    #[serde(default)]
    pub fixed: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct FixedIn {
    pub ring: String,
    pub version: String,
}

#[derive(Debug, Deserialize)]
pub struct SecurityView {
    pub ring: String,
    pub arch: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub vulnerable: Vec<VulnerablePackage>,
}

/// Percent-encodes what a package name or a cursor may carry (`+`, `@`, `/`…).
pub fn urlencode(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn indexed(name: &str, source: Option<&str>) -> IndexedManifest {
        let manifest: PackageManifest = serde_json::from_value(serde_json::json!({
            "schema_version": 1, "name": name, "version": "1-1", "arch": "aarch64",
            "sha256": format!("{:0>64}", source.unwrap_or("none").len()), "filename": format!("{name}-1-1-aarch64.pkg.tar.zst"),
            "size_download": 1, "size_installed": 1, "provides": [name], "requires": [],
            "pkginfo": { "base": name, "builddate": 0 },
        }))
        .unwrap();
        IndexedManifest {
            source: source.map(str::to_owned),
            repo_arch: Some("aarch64".into()),
            manifest,
        }
    }

    #[test]
    fn one_build_per_name_in_the_pools_order() {
        let order: Vec<String> = ["asahi", "asahi-alarm", "packages", "core", "extra"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let served = vec![
            indexed("mesa", Some("extra")),
            indexed("mesa", Some("asahi-alarm")),
            indexed("localsend", Some("packages")),
            indexed("localsend", Some("asahi")),
            indexed("zlib", Some("core")),
            indexed("tool", Some("chaotic")), // not in the order: after every listed source
            indexed("tool", Some("extra")),
            indexed("ghost", None),
        ];
        let picked: Vec<(String, Option<String>)> = one_per_name(served, &order)
            .into_iter()
            .map(|p| (p.manifest.name, p.source))
            .collect();
        assert_eq!(
            picked,
            vec![
                ("ghost".into(), None),
                ("localsend".into(), Some("asahi".into())),
                ("mesa".into(), Some("asahi-alarm".into())),
                ("tool".into(), Some("extra".into())),
                ("zlib".into(), Some("core".into())),
            ]
        );
        // Without an order (an older pool), the choice is still one and stable: by source name.
        let picked: Vec<Option<String>> = one_per_name(
            vec![
                indexed("mesa", Some("extra")),
                indexed("mesa", Some("asahi-alarm")),
            ],
            &[],
        )
        .into_iter()
        .map(|p| p.source)
        .collect();
        assert_eq!(picked, vec![Some("asahi-alarm".into())]);
    }
}
